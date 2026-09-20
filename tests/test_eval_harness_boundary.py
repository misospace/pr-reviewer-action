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
snap = {k: os.environ.get(k) for k in ("REPO", "PR_NUMBER", "DEEP_REVIEW", "TOOL_MODE")}
with open("env-snapshot.json", "w", encoding="utf-8") as f:
    json.dump(snap, f)
PY
__BODY__
exit 0
"""

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


def _write_fake_script(
    path: Path,
    deep: bool,
    write_output: bool = True,
    ai_output: str = AI_OUTPUT_PAYLOAD,
    specialists_payload: str = SPECIALISTS_PAYLOAD,
    malformed_aggregate: bool = False,
) -> Path:
    if write_output:
        block = MALFORMED_DEEP_BLOCK if malformed_aggregate else DEEP_BLOCK
        deep_block = (
            block.replace("__SPECIALISTS__", specialists_payload)
            .replace("__SPECIALIST_SECURITY__", SPECIALIST_SECURITY_PAYLOAD)
            if deep
            else ""
        )
        body = (
            OUTPUT_BODY
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
        .replace("__EXPECT_PR__", str(PR_NUMBER))
        .replace("__BODY__", body)
    )
    path.write_text(script, encoding="utf-8")
    path.chmod(0o755)
    return path


def _work_dir_with_repo(tmp_path: Path) -> Path:
    repo_path = tmp_path / REPO_DIR_NAME
    repo_path.mkdir(parents=True, exist_ok=True)
    return repo_path


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


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
