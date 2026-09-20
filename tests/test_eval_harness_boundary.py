"""Integration boundary tests for run_review_for_pr (deep-review #610).

Materializes a fake run_review.sh orchestrator in tmp_path (no network, no
live models) and verifies end-to-end:
  - the env contract (REPO / PR_NUMBER / DEEP_REVIEW / TOOL_MODE),
  - the stale-artifact reset (a leftover ai-output.json is removed before
    the orchestrator runs),
  - artifact parsing (ai-output.json -> verdict/findings, analysis_engine.txt
    -> model_used, ai-response.primary.json -> tokens, tool-harness.json ->
    tool_calls, specialists.json + specialist-<role>.json -> telemetry),
  - adversarial boundary tokens: symlinked stale artifacts, NUL/control
    bytes in finding content, path-shaped finding files.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from eval_harness import evaluate_specialist_expectations, run_review_for_pr


REPO = "misospace/pr-reviewer-action"
PR_NUMBER = 547
REPO_DIR_NAME = REPO.replace("/", "-")

MODEL_CONFIG = {
    "model": "dummy-model",
    "base_url": "http://localhost:9/v1",
    "api_key": "dummy-key",
    "github_token": "dummy-token",
}

AI_OUTPUT_PAYLOAD = (
    '{"verdict": "request_changes", '
    '"review_markdown": "fake review body", '
    '"verdict_source": "findings_severity_gated", '
    '"findings": [{"severity": "blocker", "category": "security", '
    '"file": "pr_reviewer/forgejo_backend.py", "line": 142, '
    '"message": "Concurrent JWT cache race"}]}'
)

ANALYSIS_ENGINE = "test-model@http://localhost:1/v1 (openai)"

AI_RESPONSE_PAYLOAD = '{"usage": {"prompt_tokens": 111, "completion_tokens": 22}}'

TOOL_HARNESS_PAYLOAD = (
    '{"tool_calls": '
    '[{"tool": "read_file", "args": {"path": "pr_reviewer/forgejo_backend.py"}, '
    '"status": "ok"}, '
    '{"tool": "list_tree", "args": {"path": "pr_reviewer"}, "status": "ok"}]}'
)

SPECIALISTS_PAYLOAD = (
    '{"enabled": true, "aggregate_elapsed_sec": 5.5, "total_leads": 2, '
    '"any_errors": false, "roles": '
    '[{"role": "correctness", "status": "ok", "lead_count": 1, "elapsed_sec": 2.0}, '
    '{"role": "security", "status": "ok", "lead_count": 1, "elapsed_sec": 2.5}, '
    '{"role": "tests", "status": "ok", "lead_count": 0, "elapsed_sec": 1.0}]}'
)

SPECIALIST_SECURITY_PAYLOAD = (
    '{"role": "security", "leads": '
    '[{"severity": "major", "category": "security", '
    '"file": "pr_reviewer/forgejo_backend.py", "line": 142, '
    '"message": "Concurrent JWT cache race"}], '
    '"truncated": false, "errors": []}'
)

# NUL (\\u0000) and ESC (\\u001b) are written to ai-output.json as JSON
# escapes, so the decoded artifact carries a literal NUL in the finding
# message and control chars in the review markdown.
NUL_OUTPUT_PAYLOAD = (
    '{"verdict": "request_changes", '
    '"review_markdown": "lead \\u001b[31m in body", '
    '"verdict_source": "findings_severity_gated", '
    '"findings": [{"severity": "blocker", "category": "security", '
    '"file": "pr_reviewer/forgejo_backend.py", "line": 142, '
    '"message": "JWT\\u0000cache race"}]}'
)

# A finding whose `file` is a path-escape-shaped string: the scoring
# predicates must treat it as plain text, never a filesystem path.
ESCAPING_OUTPUT_PAYLOAD = (
    '{"verdict": "request_changes", '
    '"review_markdown": "body", '
    '"verdict_source": "findings_severity_gated", '
    '"findings": [{"severity": "blocker", "category": "security", '
    '"file": "../../etc/passwd", "line": 1, '
    '"message": "path-shaped file"}]}'
)

MALFORMED_AGGREGATE_PAYLOAD = "{not json"

# The fake orchestrator: bakes its expectations into the script text (the
# caller passes no expectations of its own), snapshots the env contract,
# refuses to run over a stale ai-output.json (exit 43), then writes the
# run artifacts in the run cwd.
FAKE_SCRIPT_TEMPLATE = """#!/usr/bin/env bash
set -u

EXPECT_REPO="__EXPECT_REPO__"
EXPECT_PR="__EXPECT_PR__"

if [ "${REPO:-}" != "$EXPECT_REPO" ] || [ "${PR_NUMBER:-}" != "$EXPECT_PR" ]; then
  echo "unexpected REPO/PR_NUMBER in env" >&2
  exit 44
fi

python3 - <<'PY'
import json, os
snap = {k: os.environ.get(k) for k in ("REPO", "PR_NUMBER", "DEEP_REVIEW", "TOOL_MODE", "GITHUB_WORKSPACE")}
with open("env-snapshot.json", "w", encoding="utf-8") as f:
    json.dump(snap, f)
PY
__BODY__
__HEAD_RECORD__
exit 0
"""

# Optional trailing body line (record_head=True): records the HEAD the
# orchestrator subprocess actually observed in the run cwd, so a test can
# assert the PR head was checked out — not just the in-process value.
HEAD_RECORD = "git rev-parse HEAD > head.txt"

OUTPUT_BODY = """if [ -f ai-output.json ]; then
  echo "stale ai-output.json at entry" >&2
  exit 43
fi
cat > ai-output.json <<'JSON'
__AI_OUTPUT__
JSON
printf '__ANALYSIS_ENGINE__\\n' > analysis_engine.txt
cat > ai-response.primary.json <<'JSON'
__AI_RESPONSE__
JSON
__DEEP_BLOCK__
cat > tool-harness.json <<'JSON'
__TOOL_HARNESS__
JSON
"""

DEEP_BLOCK = """cat > specialists.json <<'JSON'
__SPECIALISTS__
JSON
cat > specialist-security.json <<'JSON'
__SPECIALIST_SECURITY__
JSON
"""

# Like DEEP_BLOCK, but the specialists.json aggregate is a SYMLINK to a
# malformed-JSON file: the load path must degrade to the derived-from-role
# files fallback instead of raising.
MALFORMED_DEEP_BLOCK = """cat > bad-aggregate.json <<'JSON'
__SPECIALISTS__
JSON
ln -sf bad-aggregate.json specialists.json
cat > specialist-security.json <<'JSON'
__SPECIALIST_SECURITY__
JSON
"""

NO_OUTPUT_BODY = 'echo "fallback body from stdout"\n'

# Like OUTPUT_BODY, but mirrors the production helpers' workspace-root
# behavior: every artifact is written under $GITHUB_WORKSPACE (never bare
# cwd), and the script refuses to run (exit 45) when GITHUB_WORKSPACE is
# not the run cwd — so a leaked ambient workspace value would abort it.
WORKSPACE_ROOTED_BODY = """if [ "${GITHUB_WORKSPACE}" != "${PWD}" ]; then
  echo "GITHUB_WORKSPACE is not the run cwd" >&2
  exit 45
fi
cat > "$GITHUB_WORKSPACE/ai-output.json" <<'JSON'
__AI_OUTPUT__
JSON
printf '__ANALYSIS_ENGINE__\\n' > "$GITHUB_WORKSPACE/analysis_engine.txt"
cat > "$GITHUB_WORKSPACE/ai-response.primary.json" <<'JSON'
__AI_RESPONSE__
JSON
__DEEP_BLOCK__
cat > "$GITHUB_WORKSPACE/tool-harness.json" <<'JSON'
__TOOL_HARNESS__
JSON
"""

WORKSPACE_ROOTED_DEEP_BLOCK = """cat > "$GITHUB_WORKSPACE/specialists.json" <<'JSON'
__SPECIALISTS__
JSON
cat > "$GITHUB_WORKSPACE/specialist-security.json" <<'JSON'
__SPECIALIST_SECURITY__
JSON
"""


def _write_fake_script(
    path: Path,
    deep: bool,
    write_output: bool = True,
    ai_output: str = AI_OUTPUT_PAYLOAD,
    specialists_payload: str = SPECIALISTS_PAYLOAD,
    malformed_aggregate: bool = False,
    workspace_rooted: bool = False,
    pr_number: int = PR_NUMBER,
    record_head: bool = False,
) -> Path:
    if write_output:
        if workspace_rooted:
            body_template = WORKSPACE_ROOTED_BODY
            block = WORKSPACE_ROOTED_DEEP_BLOCK
        else:
            body_template = OUTPUT_BODY
            block = MALFORMED_DEEP_BLOCK if malformed_aggregate else DEEP_BLOCK
        deep_block = (
            block.replace("__SPECIALISTS__", specialists_payload)
            .replace("__SPECIALIST_SECURITY__", SPECIALIST_SECURITY_PAYLOAD)
            if deep
            else ""
        )
        body = (
            body_template
            .replace("__AI_OUTPUT__", ai_output)
            .replace("__ANALYSIS_ENGINE__", ANALYSIS_ENGINE)
            .replace("__AI_RESPONSE__", AI_RESPONSE_PAYLOAD)
            .replace("__TOOL_HARNESS__", TOOL_HARNESS_PAYLOAD)
            .replace("__DEEP_BLOCK__", deep_block)
        )
    else:
        body = NO_OUTPUT_BODY
    script = (
        FAKE_SCRIPT_TEMPLATE
        .replace("__EXPECT_REPO__", REPO)
        .replace("__EXPECT_PR__", str(pr_number))
        .replace("__BODY__", body)
        .replace("__HEAD_RECORD__", HEAD_RECORD if record_head else "")
    )
    path.write_text(script, encoding="utf-8")
    path.chmod(0o755)
    return path


def _git(path: Path, *args: str) -> str:
    """Run a git command in `path`; return stripped stdout (checked)."""
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True, capture_output=True, text=True,
    )
    return result.stdout.strip()


def _init_origin_repo(
    tmp_path: Path, prs: tuple[int, ...]
) -> tuple[Path, str, dict[int, str]]:
    """Create a local origin git repo advertising refs/pull/<pr>/head.

    Commits a marker file on main (the returned base_sha), then, for each
    PR number, rewrites the marker (content = str(pr)) and advertises that
    commit as refs/pull/<pr>/head. The marker never collides with a name
    the harness or the fake orchestrator writes (ai-output.json, ...), so
    planted artifacts stay untracked and checkout --force never conflicts.
    A repo-local committer identity keeps the helper independent of any
    global git config.
    """
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-b", "main")
    _git(origin, "config", "user.email", "eval@test")
    _git(origin, "config", "user.name", "eval")
    (origin / "marker.txt").write_text("base\n", encoding="utf-8")
    _git(origin, "add", "marker.txt")
    _git(origin, "commit", "-m", "base")
    base_sha = _git(origin, "rev-parse", "HEAD")
    shas: dict[int, str] = {}
    for pr in prs:
        (origin / "marker.txt").write_text(f"{pr}\n", encoding="utf-8")
        _git(origin, "add", "marker.txt")
        _git(origin, "commit", "-m", f"pr {pr}")
        sha = _git(origin, "rev-parse", "HEAD")
        _git(origin, "update-ref", f"refs/pull/{pr}/head", sha)
        # Keep main parked at the base: the PR commit is reachable ONLY via
        # refs/pull/<pr>/head, so a fresh clone (main) starts at base and a
        # plain fetch cannot serve the PR head.
        _git(origin, "update-ref", "refs/heads/main", base_sha)
        shas[pr] = sha
    return origin, base_sha, shas


def _work_dir_with_repo(
    tmp_path: Path, prs: tuple[int, ...] = (PR_NUMBER,)
) -> Path:
    """Materialize the run's repo dir as a real git clone of a local origin.

    The clone's origin advertises refs/pull/<pr>/head for each of `prs`,
    so the harness can fetch and detach onto the corpus PR's exact head
    with no network access.
    """
    origin, _, _ = _init_origin_repo(tmp_path, prs)
    _git(tmp_path, "clone", str(origin), REPO_DIR_NAME)
    return tmp_path / REPO_DIR_NAME


def _read_snapshot(repo_path: Path) -> dict:
    return json.loads((repo_path / "env-snapshot.json").read_text(encoding="utf-8"))


PR_ENTRY = {"number": PR_NUMBER, "repo_full_name": REPO}


class TestRunReviewForPrBoundary:
    def test_deep_run_env_contract_and_artifact_parsing(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        script = _write_fake_script(tmp_path / "fake_run_review.sh", deep=True)

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        snap = _read_snapshot(repo_path)
        assert snap["REPO"] == REPO
        assert snap["PR_NUMBER"] == "547"
        assert snap["DEEP_REVIEW"] == "true"
        assert snap["TOOL_MODE"] == "native_loop"

        assert run.mode == "native_loop+deep"
        assert run.verdict == "request_changes"
        assert run.verdict_source == "findings_severity_gated"

        # Findings normalized to the production five-key shape.
        assert len(run.findings) == 1
        finding = run.findings[0]
        assert set(finding) == {"severity", "category", "file", "line", "message"}
        assert "description" not in finding
        assert finding["severity"] == "blocker"
        assert finding["category"] == "security"
        assert finding["file"] == "pr_reviewer/forgejo_backend.py"
        assert finding["line"] == 142
        assert finding["message"] == "Concurrent JWT cache race"

        assert run.tokens_input == 111
        assert run.tokens_output == 22
        assert "test-model" in run.model_used
        assert len(run.tool_calls) == 2
        assert run.tool_calls[0]["tool"] == "read_file"

        # Deep-review specialist telemetry loaded from the run artifacts.
        assert run.specialists is not None
        assert run.specialists["total_leads"] == 2
        assert run.specialists["any_errors"] is False
        assert len(run.specialists["leads_by_role"]["security"]) == 1
        assert (
            run.specialists["leads_by_role"]["security"][0]["message"]
            == "Concurrent JWT cache race"
        )
        assert run.specialists["leads_by_role"]["correctness"] == []
        assert run.specialists["leads_by_role"]["tests"] == []

    def test_standard_run_has_no_deep_env_and_no_specialists(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        script = _write_fake_script(tmp_path / "fake_run_review.sh", deep=False)

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=False, review_script=script,
        )

        assert run.error is None
        snap = _read_snapshot(repo_path)
        assert snap["REPO"] == REPO
        assert snap["PR_NUMBER"] == "547"
        assert snap["DEEP_REVIEW"] in (None, "")
        assert snap["TOOL_MODE"] == "native_loop"

        assert run.mode == "native_loop"
        assert run.deep_review is False
        # No specialist artifacts were written: telemetry stays None.
        assert run.specialists is None

    def test_stale_ai_output_is_reset_before_the_run(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        # A prior run's verdict must not survive into this run: the fake
        # orchestrator exits 43 if it sees ai-output.json at entry.
        (repo_path / "ai-output.json").write_text(
            '{"verdict": "approve", "review_markdown": "stale"}',
            encoding="utf-8",
        )
        script = _write_fake_script(tmp_path / "fake_run_review.sh", deep=True)

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        assert run.verdict == "request_changes"
        assert run.verdict_source == "findings_severity_gated"

    def test_missing_ai_output_falls_back_to_stdout(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        script = _write_fake_script(
            tmp_path / "fake_run_review.sh", deep=True, write_output=False
        )

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        assert "fallback body from stdout" in run.review_markdown
        assert run.verdict is None
        assert run.findings == []
        # No artifacts at all: no tool trace, no specialist telemetry.
        assert run.tool_calls == []
        assert run.specialists is None

    def test_symlinked_stale_ai_output_is_reset_not_followed(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        # A stale ai-output.json that is a symlink to a live file: the reset
        # must unlink the link itself, never follow it onto the target.
        (repo_path / "evil-target.json").write_text(
            '{"verdict": "approve", "review_markdown": "EVIL"}',
            encoding="utf-8",
        )
        os.symlink("evil-target.json", repo_path / "ai-output.json")
        script = _write_fake_script(tmp_path / "fake_run_review.sh", deep=True)

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        # If the reset had followed/kept the link, the fake orchestrator
        # would have seen ai-output.json at entry and exited 43.
        assert run.error is None
        assert run.verdict == "request_changes"
        assert run.review_markdown == "fake review body"
        # Only the link was removed; the target file is untouched.
        assert (repo_path / "evil-target.json").exists()
        assert not (repo_path / "ai-output.json").is_symlink()

    def test_null_bytes_and_control_chars_in_findings_content_fail_soft(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        script = _write_fake_script(
            tmp_path / "fake_run_review.sh", deep=True,
            ai_output=NUL_OUTPUT_PAYLOAD,
        )

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        assert run.verdict == "request_changes"
        # Control bytes survive normalization verbatim (strip() leaves NUL).
        assert run.review_markdown == "lead \x1b[31m in body"
        assert run.findings[0]["message"] == "JWT\x00cache race"

        expectations = {
            "description": "control-laden jwt lead",
            "effectiveness_checks": [
                {
                    "id": "jwt",
                    "type": "final_findings_count",
                    "min": 1,
                    "message_any_contains": "jwt",
                    "finding_file_any": ["forgejo_backend"],
                }
            ],
        }
        # Pure substring predicates: the NUL/ESC bytes in the message do not
        # perturb scoring — 1 matching finding (>= min 1, file grounded), so
        # the check passes and the result is deterministic.
        scored = evaluate_specialist_expectations(run, expectations)
        assert scored is not None
        assert scored["checks"][0]["passed"] is True
        assert scored["effectiveness_passed"] is True
        assert scored["lead_passed"] is None
        assert scored["passed"] is True
        assert evaluate_specialist_expectations(run, expectations) == scored

    def test_symlinked_specialists_artifact_malformed_target_fail_soft(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        script = _write_fake_script(
            tmp_path / "fake_run_review.sh", deep=True,
            specialists_payload=MALFORMED_AGGREGATE_PAYLOAD,
            malformed_aggregate=True,
        )

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        # The script's symlink to the malformed aggregate is still in place;
        # the loader read through it, got unparseable JSON, and fell back.
        assert (repo_path / "specialists.json").is_symlink()
        spec = run.specialists
        assert spec is not None
        assert spec["derived"] is True
        # Telemetry derived from the per-role files: security's one lead,
        # nothing from the unreadable aggregate, no exception.
        assert spec["total_leads"] == 1
        assert spec["any_errors"] is False
        assert spec["leads_by_role"]["security"][0]["message"] == "Concurrent JWT cache race"
        assert spec["leads_by_role"]["correctness"] == []
        assert spec["leads_by_role"]["tests"] == []
        security = next(r for r in spec["roles"] if r["role"] == "security")
        assert security["status"] == "ok"
        assert security["lead_count"] == 1

    def test_path_like_needles_do_not_escape_workspace(self, tmp_path: Path) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        script = _write_fake_script(
            tmp_path / "fake_run_review.sh", deep=False,
            ai_output=ESCAPING_OUTPUT_PAYLOAD,
        )

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=False, review_script=script,
        )

        assert run.error is None
        assert run.findings[0]["file"] == "../../etc/passwd"

        expectations = {
            "description": "path-shaped finding file is plain text",
            "effectiveness_checks": [
                {
                    "id": "no-match",
                    "type": "final_findings_count",
                    "min": 1,
                    "finding_file_any": ["forgejo_backend"],
                },
                {
                    "id": "substring-match",
                    "type": "final_findings_count",
                    "min": 1,
                    "finding_file_any": ["passwd"],
                },
            ],
        }
        # Pure string matching, never a filesystem: "../../etc/passwd"
        # matches nothing on "forgejo_backend" but matches "passwd" as a
        # bare substring, and neither check touches a path.
        scored = evaluate_specialist_expectations(run, expectations)
        assert scored is not None
        by_id = {c["id"]: c for c in scored["checks"]}
        assert by_id["no-match"]["passed"] is False
        assert by_id["substring-match"]["passed"] is True
        assert scored["effectiveness_passed"] is False

    def test_workspace_env_pinned_to_the_temp_clone(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        # An ambient GITHUB_WORKSPACE, as set by a real Actions runner,
        # points at the workflow checkout — not this run's temp clone.
        ambient = tmp_path / "ambient-actions-checkout"
        ambient.mkdir()
        monkeypatch.setenv("GITHUB_WORKSPACE", str(ambient))
        script = _write_fake_script(tmp_path / "fake_run_review.sh", deep=True)

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        snap = _read_snapshot(repo_path)
        # The orchestrator's workspace is pinned to the temp clone,
        # never the ambient Actions checkout.
        assert snap["GITHUB_WORKSPACE"] == str(repo_path)
        assert snap["GITHUB_WORKSPACE"] != str(ambient)

    def test_workspace_pinned_for_standard_runs(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        ambient = tmp_path / "ambient-actions-checkout"
        ambient.mkdir()
        monkeypatch.setenv("GITHUB_WORKSPACE", str(ambient))
        script = _write_fake_script(tmp_path / "fake_run_review.sh", deep=False)

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=False, review_script=script,
        )

        assert run.error is None
        snap = _read_snapshot(repo_path)
        assert snap["GITHUB_WORKSPACE"] == str(repo_path)
        # The pin is unconditional: standard runs get it too, and
        # DEEP_REVIEW stays absent/empty for them.
        assert snap["DEEP_REVIEW"] in (None, "")

    def test_artifacts_consumed_from_the_temp_clone_not_the_ambient_workspace(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        repo_path = _work_dir_with_repo(tmp_path)
        ambient = tmp_path / "ambient-actions-checkout"
        ambient.mkdir()
        # A stale verdict planted in the ambient checkout: if the
        # orchestrator's workspace leaked to it, this decoy would be read
        # back as this run's verdict.
        decoy = '{"verdict": "approve", "review_markdown": "AMBIENT-DECOY"}'
        (ambient / "ai-output.json").write_text(decoy, encoding="utf-8")
        monkeypatch.setenv("GITHUB_WORKSPACE", str(ambient))
        # Workspace-rooted fake: writes under $GITHUB_WORKSPACE (production
        # behavior) and exits 45 if that is not the run cwd (the pin proof).
        script = _write_fake_script(
            tmp_path / "fake_run_review.sh", deep=True, workspace_rooted=True,
        )

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        # The pin held: the workspace-rooted script completed (exit 0, not
        # the 45 guard) and consumed the temp clone's artifacts.
        assert run.error is None
        assert run.verdict == "request_changes"
        assert "AMBIENT-DECOY" not in run.review_markdown
        # The ambient decoy is untouched on disk.
        assert (ambient / "ai-output.json").read_text(encoding="utf-8") == decoy
        # Deep specialist telemetry loaded from the temp clone's artifacts.
        assert run.specialists is not None
        assert run.specialists["total_leads"] == 2
        assert (repo_path / "specialists.json").is_file()
        assert (repo_path / "specialist-security.json").is_file()


class TestRevisionFidelity:
    """The run must review the corpus PR's exact head revision.

    The repo dir is a real clone of a local origin advertising
    refs/pull/<pr>/head (offline), and with record_head the fake
    orchestrator records the HEAD it actually observed in the run cwd — so
    these tests prove the subprocess itself ran on the PR head, not just
    that an in-process value was set.
    """

    def _clone_origin(
        self, tmp_path: Path, prs: tuple[int, ...]
    ) -> tuple[Path, str, dict[int, str]]:
        origin, base_sha, shas = _init_origin_repo(tmp_path, prs)
        _git(tmp_path, "clone", str(origin), REPO_DIR_NAME)
        return tmp_path / REPO_DIR_NAME, base_sha, shas

    def test_checks_out_the_requested_pr_head_per_fixture(
        self, tmp_path: Path
    ) -> None:
        repo_path, base_sha, shas = self._clone_origin(tmp_path, (547, 551))
        # The fixtures are distinct revisions, and neither is the default
        # branch tip.
        assert shas[547] != shas[551]
        assert shas[547] != base_sha
        assert shas[551] != base_sha

        script_547 = _write_fake_script(
            tmp_path / "fake_547.sh", deep=True, pr_number=547,
            record_head=True,
        )
        script_551 = _write_fake_script(
            tmp_path / "fake_551.sh", deep=True, pr_number=551,
            record_head=True,
        )
        entry_547 = {"number": 547, "repo_full_name": REPO}
        entry_551 = {"number": 551, "repo_full_name": REPO}

        # ONE work dir, three consecutive runs: 547 -> 551 -> 547. A reused
        # repo_path must be re-checked-out onto the requested head each time
        # (reuse is not "already materialized"), and repeated same-PR runs
        # are stable. After each call, the orchestrator's recorded head.txt
        # must show the head that call reviewed.
        for entry, script, expected_sha in (
            (entry_547, script_547, shas[547]),
            (entry_551, script_551, shas[551]),
            (entry_547, script_547, shas[547]),
        ):
            run = run_review_for_pr(
                entry, "native_loop", tmp_path, MODEL_CONFIG,
                deep_review=True, review_script=script,
            )
            assert run.error is None
            assert run.commit_sha == expected_sha
            # The orchestrator subprocess observed the PR head in its cwd.
            assert (
                repo_path / "head.txt"
            ).read_text(encoding="utf-8").strip() == expected_sha

    def test_repeated_runs_use_the_same_exact_head(self, tmp_path: Path) -> None:
        _, _, shas = self._clone_origin(tmp_path, (547,))
        script = _write_fake_script(
            tmp_path / "fake_547.sh", deep=True, pr_number=547,
        )
        entry = {"number": 547, "repo_full_name": REPO}

        first = run_review_for_pr(
            entry, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )
        second = run_review_for_pr(
            entry, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert first.error is None
        assert second.error is None
        assert first.commit_sha == second.commit_sha == shas[547]

    def test_missing_pr_ref_fails_closed_no_default_branch_fallback(
        self, tmp_path: Path
    ) -> None:
        repo_path, base_sha, _ = self._clone_origin(tmp_path, (547,))
        # A fake orchestrator that WOULD succeed if it ran.
        script = _write_fake_script(
            tmp_path / "fake_999.sh", deep=True, pr_number=999,
            record_head=True,
        )
        entry = {"number": 999, "repo_full_name": REPO}

        run = run_review_for_pr(
            entry, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        # Fail-closed: the run errored and recorded no commit.
        assert run.error is not None
        assert "PR head not materialized" in run.error
        assert run.commit_sha is None
        # The orchestrator never ran: no artifacts at all in the run cwd.
        assert not (repo_path / "env-snapshot.json").exists()
        assert not (repo_path / "ai-output.json").exists()
        # No silent fallback: HEAD is still the default branch's base.
        assert _git(repo_path, "rev-parse", "HEAD") == base_sha

    def test_checkout_does_not_disturb_stale_reset_or_symlinks(
        self, tmp_path: Path
    ) -> None:
        repo_path, _, shas = self._clone_origin(tmp_path, (547,))
        # An untracked stale verdict in the git-backed repo dir: the
        # checkout must not trip over it, and the run must still consume
        # fresh artifacts (the fake orchestrator exits 43 if a stale
        # ai-output.json survives the reset).
        (repo_path / "ai-output.json").write_text(
            '{"verdict": "approve", "review_markdown": "stale"}',
            encoding="utf-8",
        )
        script = _write_fake_script(
            tmp_path / "fake_547.sh", deep=True, pr_number=547,
        )

        run = run_review_for_pr(
            PR_ENTRY, "native_loop", tmp_path, MODEL_CONFIG,
            deep_review=True, review_script=script,
        )

        assert run.error is None
        assert run.commit_sha == shas[547]
        assert run.verdict == "request_changes"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
