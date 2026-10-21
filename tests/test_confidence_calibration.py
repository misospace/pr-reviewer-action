"""Confidence-scorer calibration pilot tests (#1074).

Covers the bounded, offline-first pilot tooling WITHOUT any external
inference:
- sample-plan validation (ids resolvable, ceilings, credential-shaped fields
  rejected, rubric identity),
- the Node bridge exercised through the module's own
  ``build_prompt_via_bridge``/``apply_score_via_bridge`` (the production
  ``src/confidence/`` prompt builder, parser, and deterministic ceilings:
  envelope discipline, secret masking, truncation notes, fail-closed
  parsing, cap notes),
- a full mock end-to-end pass over the synthetic fixtures (rows, evidence
  buckets, deterministic caps, novel-concern candidate, flip pair, audit
  files, report denominators and the hard invariant),
- the live backend against LOCAL loopback servers only (one call per row,
  no retries, timeout, header discipline: the key rides only the auth
  header, never the URL or driver output),
- budget exhaustion aborting BEFORE any call,
- the ``review`` stage orchestration against a FAKE ``eval_harness`` module
  (recorded calls, success/error/exception records).

The driver is exercised IN-PROCESS (its ``cmd_*`` handlers called directly
with parser-built namespaces) so pytest coverage counts the Python lines;
only three thin CLI-dispatch tests stay at subprocess level. Every
network-facing test binds 127.0.0.1; the mock path touches no socket at all.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = REPO_ROOT / "scripts"
FIXTURES_PRIMARY = REPO_ROOT / "evals" / "confidence-calibration" / "fixtures" / "primary"
SAMPLE_PLAN = REPO_ROOT / "evals" / "confidence-calibration" / "sample-plan.json"
BRIDGE = SCRIPTS_DIR / "confidence_bridge.mjs"

for entry in (str(REPO_ROOT), str(SCRIPTS_DIR)):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import confidence_calibration  # noqa: E402  (import after sys.path setup)

# Bound names imported explicitly so CodeQL-style analysis sees both forms.
load_corpus_entries = confidence_calibration.load_corpus_entries
validate_plan = confidence_calibration.validate_plan
green_eligible = confidence_calibration.green_eligible
render_report = confidence_calibration.render_report
build_prompt_via_bridge = confidence_calibration.build_prompt_via_bridge
apply_score_via_bridge = confidence_calibration.apply_score_via_bridge
review_result_via_bridge = confidence_calibration.review_result_via_bridge
live_request = confidence_calibration.live_request
extract_answer_text = confidence_calibration.extract_answer_text
cost_table = confidence_calibration.cost_table
primary_evidence_state = confidence_calibration.primary_evidence_state
_safe_component = confidence_calibration._safe_component


# ── In-process CLI harness ───────────────────────────────────────────────


def run_cmd(command: str, argv: list[str]) -> int:
    """Invoke one driver subcommand IN-PROCESS: argparse wiring plus the
    ``cmd_*`` handler, so every Python line stays inside pytest coverage."""
    args = confidence_calibration.build_parser().parse_args([command, *argv])
    return int(getattr(confidence_calibration, f"cmd_{command}")(args))


def run_cmd_expecting_exit(command: str, argv: list[str], code: int, capsys: pytest.CaptureFixture) -> None:
    with pytest.raises(SystemExit) as excinfo:
        run_cmd(command, argv)
    assert excinfo.value.code == code
    return capsys.readouterr()


def load_plan() -> dict:
    return json.loads(SAMPLE_PLAN.read_text(encoding="utf-8"))


def write_plan(directory: Path, plan: dict) -> Path:
    path = directory / "plan.json"
    path.write_text(json.dumps(plan), encoding="utf-8")
    return path


def fixture_runs_dir_copy(tmp_path: Path) -> Path:
    """A writable copy of the committed fixture runs dir, so the audit
    artifacts the score stage writes never land in the repository tree."""
    runs_dir = tmp_path / "fixtures-primary"
    shutil.copytree(FIXTURES_PRIMARY, runs_dir)
    return runs_dir


def raw_answer(score: int | str, risk: str = "low", reason: str = "assessment", concerns: list | None = None) -> str:
    payload = {"score": score, "risk": risk, "reason": reason, "concerns": concerns or []}
    return "```json\n" + json.dumps(payload) + "\n```"


# ── Plan validation ──────────────────────────────────────────────────────


def test_plan_valid_committed_plan_passes(capsys: pytest.CaptureFixture) -> None:
    assert run_cmd("plan", ["--plan", str(SAMPLE_PLAN)]) == 0
    output = capsys.readouterr().out
    assert "plan OK" in output
    assert "vulnerable=8" in output and "clean=8" in output
    assert "digest=sha256:" in output


def test_plan_unknown_sample_id_fails(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    plan = load_plan()
    plan["sample"]["vulnerable"][0] = "pr-reviewer-action-999999-nonexistent"
    captured = run_cmd_expecting_exit("plan", ["--plan", str(write_plan(tmp_path, plan))], 2, capsys)
    assert "not resolvable" in captured.err


def test_plan_rejects_literal_credential_field_without_echoing_it(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    plan = load_plan()
    secret_literal = "sk-SUPER-SECRET-literal-value"
    plan["conditions"][2]["key"] = secret_literal
    captured = run_cmd_expecting_exit("plan", ["--plan", str(write_plan(tmp_path, plan))], 2, capsys)
    assert "forbidden" in captured.err
    # The literal value itself must never surface in any output.
    assert secret_literal not in captured.out + captured.err


def test_plan_rejects_non_env_shaped_live_values(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    plan = load_plan()
    plan["conditions"][2]["key_env"] = "sk-not-an-env-name"
    captured = run_cmd_expecting_exit("plan", ["--plan", str(write_plan(tmp_path, plan))], 2, capsys)
    assert "ENV VAR NAME" in captured.err


def test_plan_missing_ceilings_fails(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    plan = load_plan()
    del plan["ceilings"]
    captured = run_cmd_expecting_exit("plan", ["--plan", str(write_plan(tmp_path, plan))], 2, capsys)
    assert "ceilings missing" in captured.err


def test_plan_missing_rubric_identity_fails() -> None:
    plan = load_plan()
    del plan["rubric"]
    assert any("rubric" in error for error in validate_plan(plan, {"real": load_corpus_entries(REPO_ROOT / "evals" / "corpus-real-prs.json")}))


# ── Bridge through the module (production parser + ceilings) ─────────────


def build_prompt_payload() -> dict:
    return {
        "head_sha": "abc123",
        "base_sha": "def456",
        "diff": "diff --git a/x.ts b/x.ts\n+const x = 1;\n",
        "pr_title": "synthetic title",
        "pr_body": "synthetic body",
        "findings": [{"severity": "minor", "file": "x.ts", "message": "note"}],
        "review_summary": "## Review\nsynthetic summary",
        "review_result": "approve",
        "required_checks": "complete",
        "coverage": {"partial_coverage": None},
        "secret_env_names": ["PILOT_TEST_FAKE_SECRET", "PILOT_TEST_UNSET_VAR"],
    }


def test_bridge_build_prompt_wraps_untrusted_envelopes(tmp_path: Path) -> None:
    prompt = build_prompt_via_bridge(build_prompt_payload(), tmp_path)
    assert set(prompt) == {"system", "user"}
    for kind in ("coverage_claim", "pr_title", "pr_body", "diff", "findings", "review_summary"):
        assert f'<untrusted_review_content kind="{kind}"' in prompt["user"], kind


def test_bridge_masks_configured_secret_values(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "pilot-fake-credential-value-9f3a"
    monkeypatch.setenv("PILOT_TEST_FAKE_SECRET", secret)
    payload = build_prompt_payload()
    payload["diff"] = f"diff --git a/x.ts b/x.ts\n+token = '{secret}'\n"
    prompt = build_prompt_via_bridge(payload, tmp_path)
    rendered = prompt["system"] + prompt["user"]
    assert secret not in rendered
    assert "PILOT_TEST_FAKE_SECRET" not in rendered


def test_bridge_emits_truncation_note_for_oversized_diff(tmp_path: Path) -> None:
    payload = build_prompt_payload()
    payload["diff"] = "x" * (200_000 + 4096)
    prompt = build_prompt_via_bridge(payload, tmp_path)
    assert "[TRUNCATED:" in prompt["user"]


def test_bridge_fails_closed_without_echoing_input(tmp_path: Path) -> None:
    # A bad secret_env_names entry makes the bridge exit 1 with its redacted
    # one-liner; the module surfaces it as a RuntimeError, never the input.
    with pytest.raises(RuntimeError) as excinfo:
        confidence_calibration._run_bridge(
            "build-prompt", {"secret_env_names": ["GOOD_NAME", 12345]}, tmp_path,
        )
    assert "bridge build-prompt failed" in str(excinfo.value)
    assert "12345" not in str(excinfo.value)


def test_bridge_binary_rejects_unparseable_input_without_echoing_it(tmp_path: Path) -> None:
    """Raw bridge-binary check (node subprocess — the bridge itself cannot be
    exercised in-process): malformed JSON must fail closed and never echo the
    hostile input back."""
    marker = "NOT-REDACTED-CONTENT-MARKER"
    bad = tmp_path / "bridge-bad.json"
    bad.write_text("{not json " + marker, encoding="utf-8")
    result = subprocess.run(
        ["node", str(BRIDGE), "build-prompt", str(bad)],
        capture_output=True, text=True, timeout=120, check=False,
    )
    assert result.returncode == 1
    assert marker not in result.stdout + result.stderr
    assert result.stderr.strip().count("\n") == 0  # single redacted line
    bad.unlink(missing_ok=True)


def test_bridge_launcher_cache_key_covers_imported_dependencies(tmp_path: Path) -> None:
    """Regression pin: the bundle cache key must cover the full transitive
    import graph, so a change to an IMPORTED module (not just the launcher's
    own source) forces a rebuild. Uses a self-contained fake tree (launcher
    copy + fake bridge + fake dependency) so no production file is touched
    and no real provider code runs."""
    bin_dir = tmp_path / "launcher"
    bin_dir.mkdir()
    shutil.copy(BRIDGE, bin_dir / "confidence_bridge.mjs")
    (bin_dir / "node_modules").symlink_to(REPO_ROOT / "node_modules")
    (bin_dir / "dep.ts").write_text('export const VALUE = "first";\n', encoding="utf-8")
    (bin_dir / "dyn.ts").write_text('export const NAME = "dyn-one";\n', encoding="utf-8")
    (bin_dir / "confidence_bridge.ts").write_text(
        'import { VALUE } from "./dep.js";\n'
        "const payload: Record<string, string> = { value: VALUE };\n"
        'import("./dyn.js").then((dyn) => {\n'
        "    payload.dyn = dyn.NAME;\n"
        "    console.log(JSON.stringify(payload));\n"
        "});\n",
        encoding="utf-8",
    )

    def run() -> dict:
        result = subprocess.run(
            ["node", str(bin_dir / "confidence_bridge.mjs"), "noop", "ignored.json"],
            capture_output=True, text=True, timeout=120, check=False,
        )
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)

    assert run() == {"value": "first", "dyn": "dyn-one"}
    assert run() == {"value": "first", "dyn": "dyn-one"}  # cached bundle reused
    (bin_dir / "dep.ts").write_text('export const VALUE = "second";\n', encoding="utf-8")
    assert run() == {"value": "second", "dyn": "dyn-one"}  # static dep change: no stale bundle
    (bin_dir / "dyn.ts").write_text('export const NAME = "dyn-two";\n', encoding="utf-8")
    assert run() == {"value": "second", "dyn": "dyn-two"}  # dynamic-import dep: same


def apply_score(answer: str, findings: list | None = None, coverage: dict | None = None, model: str = "pilot-model", tmp_path: Path | None = None) -> dict:
    return apply_score_via_bridge(answer, findings or [], coverage or {}, model, tmp_path or Path("/tmp"))


def test_bridge_scored_top_answer_without_findings(tmp_path: Path) -> None:
    result = apply_score(raw_answer(5, "low", "clean bill"), tmp_path=tmp_path)
    assert result["status"] == "scored"
    assert result["score"] == 5
    assert result["risk"] == "low"
    assert result["caps"] == []
    assert result["cause"] == ""
    assert result["model"] == "pilot-model"


def test_bridge_blocker_finding_caps_five_to_two(tmp_path: Path) -> None:
    result = apply_score(
        raw_answer(5, "critical", "looks great"),
        findings=[{"severity": "blocker", "file": "a.ts", "message": "x"}],
        tmp_path=tmp_path,
    )
    assert result["status"] == "scored"
    assert result["score"] == 2
    assert result["caps"] == ["blocker_cap_2"]
    assert result["reason"].endswith(" [deterministic cap: blocker_cap_2]")


def test_bridge_major_finding_caps_five_to_three(tmp_path: Path) -> None:
    result = apply_score(
        raw_answer(5, "high", "fine"),
        findings=[{"severity": "major", "file": "a.ts", "message": "x"}],
        tmp_path=tmp_path,
    )
    assert result["score"] == 3
    assert result["caps"] == ["major_cap_3"]


def test_bridge_partial_coverage_caps_five_to_three(tmp_path: Path) -> None:
    result = apply_score(raw_answer(5, "medium", "fine"), coverage={"partial_coverage": "2 files unread"}, tmp_path=tmp_path)
    assert result["score"] == 3
    assert result["caps"] == ["incomplete_coverage_cap_3"]
    assert "[deterministic cap: incomplete_coverage_cap_3]" in result["reason"]


def test_bridge_incomplete_reason_caps_and_blocker_wins(tmp_path: Path) -> None:
    result = apply_score(
        raw_answer(5, "critical", "fine"),
        findings=[{"severity": "blocker", "file": "a.ts", "message": "x"}, {"severity": "major", "file": "b.ts", "message": "y"}],
        coverage={"partial_coverage": None, "incomplete_reason": "tool_loop_budget_exhausted"},
        tmp_path=tmp_path,
    )
    assert result["score"] == 2
    assert result["caps"] == ["blocker_cap_2"]


def test_bridge_out_of_range_score_fails_closed(tmp_path: Path) -> None:
    result = apply_score(raw_answer(999, "low", "overconfident"), tmp_path=tmp_path)
    assert result["status"] == "unscored"
    assert result["cause"] == "malformed_score"
    assert result["score"] is None
    assert result["model"] == "pilot-model"


@pytest.mark.parametrize("bad_score", [5.5, "4", None, -1])
def test_bridge_non_integer_or_out_of_range_scores_fail_closed(bad_score, tmp_path: Path) -> None:
    result = apply_score(raw_answer(bad_score), tmp_path=tmp_path)
    assert result["status"] == "unscored"
    assert result["cause"] == "malformed_score"


def test_bridge_malformed_risk_becomes_unknown_but_stays_scored(tmp_path: Path) -> None:
    result = apply_score(raw_answer(4, "catastrophic", "fine"), tmp_path=tmp_path)
    assert result["status"] == "scored"
    assert result["score"] == 4
    assert result["risk"] == "unknown"


def test_bridge_concern_fields_are_bounded(tmp_path: Path) -> None:
    concerns = [
        {"file": "f" * 1000, "line": 3, "evidence": "e" * 2000},
        {"file": "g.ts", "line": "not-a-number", "evidence": "ok"},
        {"file": "h.ts", "line": 7, "evidence": "ok"},
    ] * 5
    result = apply_score(raw_answer(3, "medium", "concerns", concerns), tmp_path=tmp_path)
    assert len(result["concerns"]) <= 8
    assert all(len(concern["file"]) <= 300 and len(concern["evidence"]) <= 400 for concern in result["concerns"])
    assert all(concern["line"] is None or isinstance(concern["line"], int) for concern in result["concerns"])


# ── Mock pilot end-to-end (fixtures -> score -> report, in-process) ──────


@pytest.fixture(scope="module")
def mock_pilot(tmp_path_factory: pytest.TempPathFactory) -> dict:
    work = tmp_path_factory.mktemp("mock-pilot")
    runs_dir = fixture_runs_dir_copy(work)
    results_path = work / "results.json"
    assert run_cmd("score", [
        "--plan", str(SAMPLE_PLAN),
        "--runs-dir", str(runs_dir),
        "--out", str(results_path),
        "--condition", "mock",
        "--allow-missing-corpus-entry",
    ]) == 0
    results = json.loads(results_path.read_text(encoding="utf-8"))
    report = render_report(results)
    report_path = work / "report.md"
    assert run_cmd("report", ["--results", str(results_path), "--out", str(report_path)]) == 0
    assert report_path.read_text(encoding="utf-8") == report + "\n"
    return {"results": results, "report": report, "work": work, "results_path": results_path}


def _rows_for(results: dict, pr_id: str) -> list[dict]:
    return [row for row in results["rows"] if row["pr_id"] == pr_id]


def test_mock_pilot_row_and_evidence_buckets(mock_pilot: dict) -> None:
    results = mock_pilot["results"]
    rows = results["rows"]
    # 7 fixture entries x 1 condition x 2 repeats = 14 rows.
    assert len(rows) == 14
    assert all(row["source"] == "fixture" for row in rows)
    states = {pr: {row["evidence_state"] for row in _rows_for(results, pr)} for pr in
              {row["pr_id"] for row in rows}}
    assert states["pilot-synth-errored"] == {"primary_errored"}
    assert states["pilot-synth-missing"] == {"primary_artifacts_missing"}
    for pr in ("pilot-synth-alpha", "pilot-synth-blocker", "pilot-synth-partial-novel",
               "pilot-synth-flip", "pilot-synth-unscored"):
        assert states[pr] == {"primary_ok"}


def test_mock_pilot_deterministic_ceiling_rows(mock_pilot: dict) -> None:
    results = mock_pilot["results"]
    blocker_rows = _rows_for(results, "pilot-synth-blocker")
    assert [row["scorer"]["score"] for row in blocker_rows] == [2, 2]
    assert all(row["scorer"]["caps"] == ["blocker_cap_2"] for row in blocker_rows)
    partial_rows = _rows_for(results, "pilot-synth-partial-novel")
    assert [row["scorer"]["score"] for row in partial_rows] == [3, 3]
    assert all(row["scorer"]["caps"] == ["major_cap_3"] for row in partial_rows)
    assert all("[deterministic cap: major_cap_3]" in row["scorer"]["reason"] for row in partial_rows)


def test_mock_pilot_false_green_and_flip_rows(mock_pilot: dict) -> None:
    results = mock_pilot["results"]
    alpha_rows = _rows_for(results, "pilot-synth-alpha")
    assert [row["scorer"]["score"] for row in alpha_rows] == [5, 5]
    assert all(row["scorer"]["caps"] == [] for row in alpha_rows)
    assert all(row["primary"]["verdict"] == "approve" for row in alpha_rows)
    flip_rows = _rows_for(results, "pilot-synth-flip")
    assert [row["scorer"]["score"] for row in flip_rows] == [4, 3]


def test_mock_pilot_unscored_rows_fail_closed(mock_pilot: dict) -> None:
    results = mock_pilot["results"]
    unscored_rows = _rows_for(results, "pilot-synth-unscored")
    by_repeat = {row["repeat_index"]: row for row in unscored_rows}
    assert by_repeat[0]["scorer"] == {
        "status": "unscored", "score": None, "risk": "unknown", "reason": "",
        "concerns": [], "model": "", "cause": "http_429", "caps": [],
    }
    assert by_repeat[1]["scorer"]["cause"] == "malformed_score"
    assert by_repeat[1]["scorer"]["status"] == "unscored"


def test_mock_pilot_audit_files_written(mock_pilot: dict) -> None:
    audit_dir = mock_pilot["work"] / "fixtures-primary" / "audit"
    written = {path.relative_to(audit_dir).as_posix() for path in audit_dir.rglob("*.txt")}
    for pr in ("pilot-synth-alpha", "pilot-synth-blocker", "pilot-synth-partial-novel",
               "pilot-synth-flip", "pilot-synth-unscored"):
        assert f"{pr}/mock-r0.txt" in written
        assert f"{pr}/mock-r1.txt" in written
    # Errored/missing-evidence entries never invoke the scorer: no audit rows.
    assert not (audit_dir / "pilot-synth-errored").exists()
    assert not (audit_dir / "pilot-synth-missing").exists()
    audit_text = (audit_dir / "pilot-synth-alpha" / "mock-r0.txt").read_text(encoding="utf-8")
    assert "=== system ===" in audit_text and "=== user ===" in audit_text
    assert "=== raw answer ===" in audit_text


def test_mock_pilot_report_buckets_and_denominators(mock_pilot: dict) -> None:
    report = mock_pilot["report"]
    results = mock_pilot["results"]
    # The hard invariant statement is always present.
    assert "NEVER enter" in report and "green or clean-pass denominators" in report
    # Denominators match the row data computed under the invariant.
    scored_vulnerable = [row for row in results["rows"] if green_eligible(row) and row["kind"] == "vulnerable"]
    scored_clean = [row for row in results["rows"] if green_eligible(row) and row["kind"] == "clean"]
    assert f"denominator: {len(scored_vulnerable)}" in report
    assert f"denominator: {len(scored_clean)}" in report
    # False-green: the alpha pair (primary approves a known defect, scorer 5).
    assert "false_green@4: 2/6" in report and "false_green@5: 2/6" in report
    assert "conditional on primary verdict == approve: 2/2" in report
    # Unnecessary block: flip pair scores 4 then 3 on clean rows.
    assert "unnecessary_block@4: 1/2" in report and "unnecessary_block@5: 2/2" in report
    assert "clean rows with risk high/critical: 0" in report
    # Risk-band calibration: alpha says low where a major defect implies high.
    assert "2/6" in report
    # Evidence buckets are separated, unscored causes enumerated.
    assert "primary_errored=2" in report and "primary_artifacts_missing=2" in report
    assert "http_429=1" in report and "malformed_score=1" in report
    # Mock cost table: zero model calls, zero tokens (not missing data).
    assert "| mock | 0 | 0 |" in report
    # Novel-concern candidate flagged for adjudication (per-condition section).
    assert "pilot-synth-partial-novel r0: concern on defect file" in report
    assert "src/widget/qux.ts" in report
    assert "never auto-credited" in report
    # Flip pair detected (per-condition section).
    assert "pilot-synth-flip: 1/1 pairs differ" in report


def test_mock_pilot_unscored_rows_never_enter_denominators(mock_pilot: dict) -> None:
    """The HARD INVARIANT, checked structurally: disabled/unscored/non-primary_ok
    rows are absent from every green/clean denominator."""
    results = mock_pilot["results"]
    for row in results["rows"]:
        if not green_eligible(row):
            # Such rows must carry no usable score at all.
            assert row["scorer"]["status"] != "scored"
            assert row["scorer"]["score"] is None
    eligible_ids = {row["pr_id"] for row in results["rows"] if green_eligible(row)}
    assert "pilot-synth-errored" not in eligible_ids
    assert "pilot-synth-missing" not in eligible_ids
    assert "pilot-synth-unscored" not in eligible_ids


def test_score_requires_corpus_entry_by_default(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    rc = run_cmd("score", [
        "--plan", str(SAMPLE_PLAN),
        "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
        "--out", str(tmp_path / "results.json"),
        "--condition", "mock",
    ])
    assert rc == 2
    assert "allow-missing-corpus-entry" in capsys.readouterr().err


# ── Live backend (loopback servers only, in-process) ─────────────────────


class LoopbackProvider:
    """Minimal local provider double: records every request, returns canned
    responses. Records path + auth headers so the test can assert the key
    never rode the URL."""

    def __init__(self, respond, delay: float = 0.0):
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        self.respond = respond
        self.delay = delay

    def handler(self):  # noqa: ANN001
        pilot = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                with pilot.lock:
                    pilot.requests.append({
                        "path": self.path,
                        "auth": self.headers.get("Authorization"),
                        "api_key_header": self.headers.get("x-api-key"),
                        "anthropic_version": self.headers.get("anthropic-version"),
                        "body": body.decode("utf-8", errors="replace"),
                    })
                if pilot.delay:
                    time.sleep(pilot.delay)
                result = pilot.respond(self)
                status, payload = result[0], result[1]
                extra_headers = result[2] if len(result) > 2 else {}
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for header_name, header_value in (extra_headers or {}).items():
                    self.send_header(header_name, header_value)
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args) -> None:  # noqa: ANN002
                pass

        return Handler


def serve(pilot: LoopbackProvider) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), pilot.handler())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


def live_plan(tmp_path: Path, timeout_sec: int = 120, max_calls: int = 48, max_output_tokens: int = 60000) -> Path:
    """A plan whose live condition points at the loopback TEST env names."""
    plan = load_plan()
    plan["ceilings"]["request_timeout_sec"] = timeout_sec
    plan["ceilings"]["max_scorer_calls"] = max_calls
    plan["ceilings"]["max_scorer_output_tokens"] = max_output_tokens
    same_model = next(condition for condition in plan["conditions"] if condition["id"] == "same-model")
    same_model["base_url_env"] = "CONFIDENCE_PILOT_TEST_BASE_URL"
    same_model["model_env"] = "CONFIDENCE_PILOT_TEST_MODEL"
    same_model["key_env"] = "CONFIDENCE_PILOT_TEST_API_KEY"
    same_model["api_format_env"] = "CONFIDENCE_PILOT_TEST_API_FORMAT"
    return write_plan(tmp_path, plan)


OPENAI_OK = {
    "choices": [{"message": {"content": raw_answer(4, "medium", "loopback assessment")}}],
    "usage": {"prompt_tokens": 100, "completion_tokens": 20},
}


def live_env(base_url: str, secret: str = "loopback-fake-key-77") -> dict[str, str]:
    return {
        "CONFIDENCE_PILOT_TEST_BASE_URL": base_url,
        "CONFIDENCE_PILOT_TEST_MODEL": "loopback-model",
        "CONFIDENCE_PILOT_TEST_API_KEY": secret,
        "CONFIDENCE_PILOT_TEST_API_FORMAT": "openai",
    }


def run_live_score(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **plan_kwargs) -> dict:
    """Run the live score phase; the phase must complete (rc 0) and the
    results file must exist."""
    results_path = tmp_path / "results.json"
    rc = run_cmd("score", [
        "--plan", str(live_plan(tmp_path, **plan_kwargs)),
        "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
        "--out", str(results_path),
        "--condition", "same-model",
        "--repeat", "1",
        "--allow-missing-corpus-entry",
    ])
    assert rc == 0
    return json.loads(results_path.read_text(encoding="utf-8"))


def run_live_score_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **plan_kwargs) -> int:
    """Run the live score phase expecting a PRE-FLIGHT budget refusal
    (exit 3): the plan cannot fit its planned calls inside the ceilings, so
    no call is made and no results file is written."""
    results_path = tmp_path / "results.json"
    rc = run_cmd("score", [
        "--plan", str(live_plan(tmp_path, **plan_kwargs)),
        "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
        "--out", str(results_path),
        "--condition", "same-model",
        "--repeat", "1",
        "--allow-missing-corpus-entry",
    ])
    assert rc == 3, "a plan that cannot fit its ceilings must refuse to start"
    assert not results_path.exists(), "a pre-flight refusal must never write partial results"
    return rc


def test_live_backend_scores_exactly_one_call_per_row(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    secret = "loopback-fake-key-77"
    env = live_env(base_url, secret)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    try:
        results = run_live_score(tmp_path, monkeypatch)
        scored_rows = [row for row in results["rows"] if row["scorer"]["status"] == "scored"]
        assert len(scored_rows) == 5  # the five primary_ok fixture entries
        # Raw 4 everywhere; the deterministic ceilings cap the blocker and
        # major/partial-coverage entries exactly as in production.
        scores = {row["pr_id"]: row["scorer"]["score"] for row in scored_rows}
        assert scores == {
            "pilot-synth-alpha": 4,
            "pilot-synth-blocker": 2,
            "pilot-synth-partial-novel": 3,
            "pilot-synth-flip": 4,
            "pilot-synth-unscored": 4,
        }
        assert all(row["usage"] == {"prompt_tokens": 100, "completion_tokens": 20} for row in scored_rows)
        assert len(pilot.requests) == 5  # EXACTLY one request per row, no retries
        for request in pilot.requests:
            assert request["auth"] == f"Bearer {secret}"
            assert secret not in request["path"]
            # The key must never ride the request body either.
            assert secret not in request["body"]
        # And never in any driver output.
        captured = capsys.readouterr()
        assert secret not in captured.out + captured.err
    finally:
        server.shutdown()


def test_live_backend_429_is_unscored_without_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pilot = LoopbackProvider(lambda _handler: (429, {"error": {"message": "slow down"}}))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results = run_live_score(tmp_path, monkeypatch)
        assert results["budget_exhausted"] is False
        unscored = [row for row in results["rows"] if row["scorer"]["status"] == "unscored"]
        assert len(unscored) == 5
        assert all(row["scorer"]["cause"] == "http_429" for row in unscored)
        # One attempt per row; no retries, no backoff, no fallback.
        assert len(pilot.requests) == 5
    finally:
        server.shutdown()


def test_live_backend_timeout_is_unscored(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK), delay=3.0)
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results = run_live_score(tmp_path, monkeypatch, timeout_sec=1)
        unscored = [row for row in results["rows"] if row["scorer"]["status"] == "unscored"]
        assert len(unscored) == 5
        assert all(row["scorer"]["cause"] == "timeout" for row in unscored)
    finally:
        server.shutdown()


def test_live_backend_missing_env_fails_fast(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    for name in ("CONFIDENCE_PILOT_TEST_BASE_URL", "CONFIDENCE_PILOT_TEST_MODEL",
                 "CONFIDENCE_PILOT_TEST_API_KEY", "CONFIDENCE_PILOT_TEST_API_FORMAT"):
        monkeypatch.setenv(name, "")
    rc = run_cmd("score", [
        "--plan", str(live_plan(tmp_path)),
        "--runs-dir", str(FIXTURES_PRIMARY),
        "--out", str(tmp_path / "results.json"),
        "--condition", "same-model",
        "--allow-missing-corpus-entry",
    ])
    assert rc == 4
    assert "CONFIDENCE_PILOT_TEST_API_KEY" in capsys.readouterr().err


def test_live_request_transport_error_on_refused_connection() -> None:
    raw, usage, cause = live_request("http://127.0.0.1:1", "openai", "m", "k", "s", "u", 5)
    assert raw is None and usage is None and cause == "transport_error"


def test_live_request_anthropic_shape(tmp_path: Path) -> None:
    """The anthropic wire shape: /v1/messages, x-api-key header, text-block
    extraction, input/output token usage."""
    pilot = LoopbackProvider(lambda _handler: (
        200,
        {
            "content": [
                {"type": "text", "text": raw_answer(4, "medium", "anthropic shape")},
            ],
            "usage": {"input_tokens": 5, "output_tokens": 7},
        },
    ))
    server, base_url = serve(pilot)
    try:
        raw, usage, cause = live_request(
            base_url, "anthropic", "claude-loopback", "anthropic-fake-key",
            "system text", "user text", 10,
        )
        assert cause is None
        assert '"score": 4' in raw
        assert usage == {"prompt_tokens": 5, "completion_tokens": 7}
        request = pilot.requests[0]
        # Production endpoint join (src/transport/http.ts resolveEndpoint):
        # the anthropic base URL already carries /v1, so the path is exactly
        # /messages.
        assert request["path"].endswith("/messages")
        assert not request["path"].endswith("/v1/messages")
        assert request["api_key_header"] == "anthropic-fake-key"
        assert request["anthropic_version"] == "2023-06-01"
        assert request["auth"] is None  # no Authorization header on the anthropic shape
        assert '"system"' in request["body"] and '"messages"' in request["body"]
    finally:
        server.shutdown()


def test_extract_answer_text_shapes() -> None:
    openai_payload = {"choices": [{"message": {"content": "hello"}}]}
    assert extract_answer_text(openai_payload, "openai") == "hello"
    anthropic_payload = {"content": [
        {"type": "text", "text": "a"},
        {"type": "tool_use", "text": "ignored"},
        {"type": "text", "text": "b"},
    ]}
    assert extract_answer_text(anthropic_payload, "anthropic") == "ab"
    # Fail-soft on unusable shapes: the bridge parser then fails closed.
    assert extract_answer_text({"nope": 1}, "openai") == ""
    assert extract_answer_text("not a dict", "openai") == ""
    assert extract_answer_text({"choices": []}, "openai") == ""


# ── Budget enforcement ───────────────────────────────────────────────────


def test_budget_exhaustion_aborts_before_any_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Five primary_ok fixture entries x 1 repeat = 5 planned calls; the
    # ceiling of 2 cannot fit them, so the phase must abort BEFORE any
    # call is made (pre-flight refusal, exit 3, no results file).
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        run_live_score_refused(tmp_path, monkeypatch, max_calls=2)
        # No live call ever happened: the projection refuses to start.
        assert len(pilot.requests) == 0
    finally:
        server.shutdown()


def test_budget_token_ceiling_aborts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Five primary_ok entries = 5 planned calls; 1024 completion tokens
    # budget fits ONE call, so the projection refuses to start before any
    # spend (pre-flight refusal, exit 3).
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        run_live_score_refused(tmp_path, monkeypatch, max_output_tokens=1024)
        assert len(pilot.requests) == 0
    finally:
        server.shutdown()


# ── Report invariants ────────────────────────────────────────────────────


def test_report_never_fails_and_notes_budget(tmp_path: Path) -> None:
    results = {
        "plan": "synthetic",
        "plan_digest": "sha256:deadbeef",
        "conditions": ["mock"],
        "repeats": 1,
        "rows": [],
        "budget_exhausted": True,
        "budget_note": "wall time exhausted",
        "generated_at": "2026-10-20T00:00:00Z",
    }
    path = tmp_path / "results.json"
    path.write_text(json.dumps(results), encoding="utf-8")
    out_path = tmp_path / "report.md"
    assert run_cmd("report", ["--results", str(path), "--out", str(out_path)]) == 0
    report = out_path.read_text(encoding="utf-8")
    assert "BUDGET EXHAUSTED" in report
    assert "wall time exhausted" in report
    assert "NEVER enter" in report


def test_main_dispatch_in_process(tmp_path: Path) -> None:
    results = {
        "plan": "synthetic", "plan_digest": "sha256:x", "conditions": [],
        "repeats": 1, "rows": [], "budget_exhausted": False, "budget_note": "",
        "generated_at": "2026-10-20T00:00:00Z",
    }
    path = tmp_path / "results.json"
    path.write_text(json.dumps(results), encoding="utf-8")
    assert confidence_calibration.main(["report", "--results", str(path)]) == 0
    # Unknown subcommand: argparse exits 2 before any handler runs.
    with pytest.raises(SystemExit) as excinfo:
        confidence_calibration.main(["definitely-not-a-subcommand"])
    assert excinfo.value.code == 2


# ── Review stage (in-process, FAKE eval_harness) ─────────────────────────


REVIEW_ENV = {
    "AI_API_KEY": "fake-ai-api-key",
    "AI_BASE_URL": "https://fake.invalid/v1",
    "AI_MODEL": "fake-model",
    "GITHUB_TOKEN": "fake-github-token",
}


class FakeEvalHarness:
    """Fake ``eval_harness`` module: records every call, returns canned
    ReviewRun-like objects (success / recorded error / raised exception)."""

    def __init__(self, fail_pr_id: str | None = None, raise_pr_id: str | None = None):
        self.calls: list[dict] = []
        self.fail_pr_id = fail_pr_id
        self.raise_pr_id = raise_pr_id

    def run_review_for_pr(self, pr_entry, mode, work_dir, model_config, **kwargs):
        self.calls.append({
            "pr_id": pr_entry["id"],
            "mode": mode,
            "model_config": dict(model_config),
            "work_dir": Path(work_dir),
            "head_sha": pr_entry.get("head_sha"),
            "repo_full_name": pr_entry.get("repo_full_name"),
        })
        if pr_entry["id"] == self.raise_pr_id:
            raise RuntimeError("synthetic driver exception")
        run_dir = Path(work_dir) / "artifacts-fake"
        run_dir.mkdir(parents=True, exist_ok=True)
        error = f"synthetic failure for {pr_entry['id']}" if pr_entry["id"] == self.fail_pr_id else None
        return SimpleNamespace(run_dir=run_dir, error=error)


def review_plan(tmp_path: Path, **ceiling_overrides) -> Path:
    plan = load_plan()
    plan["ceilings"].update(ceiling_overrides)
    return write_plan(tmp_path, plan)


def test_review_stage_in_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture) -> None:
    for name, value in REVIEW_ENV.items():
        monkeypatch.setenv(name, value)
    harness = FakeEvalHarness(fail_pr_id="pr-reviewer-action-16-61", raise_pr_id="courier-46-61")
    fake_module = types.ModuleType("eval_harness")
    fake_module.run_review_for_pr = harness.run_review_for_pr
    monkeypatch.setitem(sys.modules, "eval_harness", fake_module)

    work_dir = tmp_path / "w"
    rc = run_cmd("review", ["--plan", str(review_plan(tmp_path)), "--work-dir", str(work_dir)])
    assert rc == 0
    captured = capsys.readouterr()
    # Budget passed and all 16 sample entries were attempted, in plan order
    # (vulnerable first), with the env-built model config exactly as the
    # harness contract expects.
    assert len(harness.calls) == 16
    assert [call["pr_id"] for call in harness.calls] == load_plan()["sample"]["vulnerable"] + load_plan()["sample"]["clean"]
    assert all(call["mode"] == "tools_off" for call in harness.calls)
    assert all(call["model_config"] == {
        "model": "fake-model", "base_url": "https://fake.invalid/v1",
        "api_key": "fake-ai-api-key", "github_token": "fake-github-token",
    } for call in harness.calls)
    assert "review complete: 14/16 ok" in captured.out

    runs_payload = json.loads((work_dir / "runs.json").read_text(encoding="utf-8"))
    entries = {record["pr_id"]: record for record in runs_payload["entries"]}
    assert len(entries) == 16
    assert entries["pr-reviewer-action-16-61"]["ok"] is False
    assert "synthetic failure" in entries["pr-reviewer-action-16-61"]["error"]
    assert entries["courier-46-61"]["ok"] is False
    assert "driver exception" in entries["courier-46-61"]["error"]
    ok_entry = entries["pr-reviewer-action-630-clean"]
    assert ok_entry["ok"] is True and ok_entry["error"] is None
    assert Path(ok_entry["run_dir"]).is_dir()
    assert ok_entry["kind"] == "clean"
    assert entries["pr-reviewer-action-16-61"]["kind"] == "vulnerable"
    # Values are never printed.
    assert "fake-ai-api-key" not in captured.out + captured.err


def test_review_budget_abort_in_process(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in REVIEW_ENV.items():
        monkeypatch.setenv(name, value)
    harness = FakeEvalHarness()
    fake_module = types.ModuleType("eval_harness")
    fake_module.run_review_for_pr = harness.run_review_for_pr
    monkeypatch.setitem(sys.modules, "eval_harness", fake_module)
    # Over-budget sample plan: review must abort BEFORE any work.
    rc = run_cmd("review", ["--plan", str(review_plan(tmp_path, max_primary_reviews=4)), "--work-dir", str(tmp_path / "w")])
    assert rc == 3
    assert len(harness.calls) == 0
    assert not (tmp_path / "w" / "runs.json").exists()


def test_review_bad_plan_fails_before_any_work(tmp_path: Path) -> None:
    plan = load_plan()
    plan["sample"]["vulnerable"][0] = "nope-not-in-corpus"
    with pytest.raises(SystemExit) as excinfo:
        run_cmd("review", ["--plan", str(write_plan(tmp_path, plan)), "--work-dir", str(tmp_path / "w")])
    assert excinfo.value.code == 2


def _install_fake_harness(monkeypatch: pytest.MonkeyPatch) -> FakeEvalHarness:
    for name, value in REVIEW_ENV.items():
        monkeypatch.setenv(name, value)
    harness = FakeEvalHarness()
    fake_module = types.ModuleType("eval_harness")
    fake_module.run_review_for_pr = harness.run_review_for_pr
    monkeypatch.setitem(sys.modules, "eval_harness", fake_module)
    return harness


def test_review_rerun_same_work_dir_refuses_at_lifetime_ceiling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    # Regression pin (#1182 review): the max_primary_reviews ceiling is a
    # LIFETIME bound for the work dir. A second invocation over the same
    # work dir must refuse with zero new harness/model calls.
    harness = _install_fake_harness(monkeypatch)
    work_dir = tmp_path / "w"
    plan = review_plan(tmp_path)
    assert run_cmd("review", ["--plan", str(plan), "--work-dir", str(work_dir)]) == 0
    assert len(harness.calls) == 16
    payload = json.loads((work_dir / "runs.json").read_text(encoding="utf-8"))
    assert payload["lifetime_primary_reviews"] == 16
    before = (work_dir / "runs.json").read_text(encoding="utf-8")

    capsys.readouterr()
    rc = run_cmd("review", ["--plan", str(plan), "--work-dir", str(work_dir)])
    assert rc == 3
    assert len(harness.calls) == 16  # zero new harness/model calls
    captured = capsys.readouterr()
    assert "16 already-spent primary reviews plus 16 planned" in captured.err
    assert "no review was started and no budget was spent" in captured.err
    assert (work_dir / "runs.json").read_text(encoding="utf-8") == before


def test_review_carries_prior_spend_from_runs_json(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A prior sweep's recorded spend counts against every later invocation:
    # refuse when carried + planned exceeds the ceiling, and keep the
    # persisted counter monotone when a re-run fits.
    harness = _install_fake_harness(monkeypatch)
    work_dir = tmp_path / "w"
    work_dir.mkdir()
    prior = {
        "mode": "tools_off",
        "work_dir": str(work_dir),
        "lifetime_primary_reviews": 12,
        "entries": [
            {"pr_id": f"prior-{i}", "kind": "clean", "run_dir": None, "ok": True, "error": None}
            for i in range(3)
        ],
    }
    (work_dir / "runs.json").write_text(json.dumps(prior), encoding="utf-8")
    # carried 12 + planned 16 > 20: refuse before any harness call.
    assert run_cmd("review", [
        "--plan", str(review_plan(tmp_path, max_primary_reviews=20)), "--work-dir", str(work_dir),
    ]) == 3
    assert len(harness.calls) == 0
    # carried 12 + planned 16 <= 28: allowed, and the counter carries forward.
    assert run_cmd("review", [
        "--plan", str(review_plan(tmp_path, max_primary_reviews=28)), "--work-dir", str(work_dir),
    ]) == 0
    assert len(harness.calls) == 16
    payload = json.loads((work_dir / "runs.json").read_text(encoding="utf-8"))
    assert payload["lifetime_primary_reviews"] == 28


def test_review_carry_ignores_not_run_fillers_against_persisted_counter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression pin (#1182 review): a prior sweep that exhausted the
    # wall-time budget records `not_run: budget_exhausted` fillers that never
    # reached the provider. The persisted lifetime counter is the authority;
    # fillers must not inflate carry (max with the entry count would refuse
    # later runs the ceiling allows and permanently inflate the counter).
    harness = _install_fake_harness(monkeypatch)
    work_dir = tmp_path / "w"
    work_dir.mkdir()
    prior = {
        "mode": "tools_off",
        "work_dir": str(work_dir),
        "lifetime_primary_reviews": 5,
        "entries": [
            {"pr_id": f"spent-{i}", "kind": "clean", "run_dir": None, "ok": True, "error": None}
            for i in range(5)
        ] + [
            {"pr_id": f"filler-{i}", "kind": "clean", "run_dir": None, "ok": False,
             "error": "not_run: budget_exhausted"}
            for i in range(11)
        ],
    }
    (work_dir / "runs.json").write_text(json.dumps(prior), encoding="utf-8")
    # carried 5 (not 16 entries) + planned 16 <= 21: allowed despite fillers.
    assert run_cmd("review", [
        "--plan", str(review_plan(tmp_path, max_primary_reviews=21)), "--work-dir", str(work_dir),
    ]) == 0
    assert len(harness.calls) == 16
    payload = json.loads((work_dir / "runs.json").read_text(encoding="utf-8"))
    assert payload["lifetime_primary_reviews"] == 21
    # And the lifetime rule still holds afterwards: 21 + 16 > 36 refuses.
    assert run_cmd("review", [
        "--plan", str(review_plan(tmp_path, max_primary_reviews=36)), "--work-dir", str(work_dir),
    ]) == 3
    assert len(harness.calls) == 16  # zero new harness/model calls


def test_review_prior_runs_json_accounting_edge_cases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Pre-counter runs.json falls back to the entry count; a malformed
    # existing runs.json fails closed and is never overwritten.
    harness = _install_fake_harness(monkeypatch)
    work_dir = tmp_path / "w"
    work_dir.mkdir()
    legacy = {
        "mode": "tools_off",
        "work_dir": str(work_dir),
        "entries": [
            {"pr_id": f"legacy-{i}", "kind": "clean", "run_dir": None, "ok": True, "error": None}
            for i in range(16)
        ],
    }
    (work_dir / "runs.json").write_text(json.dumps(legacy), encoding="utf-8")
    assert run_cmd("review", ["--plan", str(review_plan(tmp_path)), "--work-dir", str(work_dir)]) == 3
    assert len(harness.calls) == 0

    broken = "{not json at all"
    (work_dir / "runs.json").write_text(broken, encoding="utf-8")
    assert run_cmd("review", ["--plan", str(review_plan(tmp_path)), "--work-dir", str(work_dir)]) == 3
    assert len(harness.calls) == 0
    assert (work_dir / "runs.json").read_text(encoding="utf-8") == broken

    # Valid JSON but a structurally broken prior: refuse, never overwrite.
    for unusable in ({"mode": "tools_off", "entries": "not-a-list"}, [],
                     {"entries": [], "lifetime_primary_reviews": "lots"}):
        (work_dir / "runs.json").write_text(json.dumps(unusable), encoding="utf-8")
        assert run_cmd("review", ["--plan", str(review_plan(tmp_path)), "--work-dir", str(work_dir)]) == 3
        assert len(harness.calls) == 0
        assert (work_dir / "runs.json").read_text(encoding="utf-8") == json.dumps(unusable)


# ── Subprocess-level CLI tests (kept minimal: wiring + exit codes) ───────


def run_driver(*args: str, env_extra: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "confidence_calibration.py"), *args],
        capture_output=True, text=True, cwd=str(REPO_ROOT), env=env, timeout=300, check=False,
    )


def test_cli_plan_smoke_subprocess() -> None:
    result = run_driver("plan", "--plan", str(SAMPLE_PLAN))
    assert result.returncode == 0, result.stderr
    assert "plan OK" in result.stdout


def test_cli_report_missing_results_subprocess(tmp_path: Path) -> None:
    result = run_driver("report", "--results", str(tmp_path / "missing.json"))
    assert result.returncode == 2
    assert "unreadable results file" in result.stderr


def test_review_missing_credentials_subprocess(tmp_path: Path) -> None:
    # Missing credentials: fail fast before any work, without printing values.
    env = {name: "" for name in REVIEW_ENV}
    result = run_driver(
        "review", "--plan", str(SAMPLE_PLAN), "--work-dir", str(tmp_path / "w2"),
        env_extra=env,
    )
    assert result.returncode == 4
    assert "AI_API_KEY" in result.stderr

# ── Review findings regression pins ──────────────────────────────────────
# Each test below pins a behavior an independent review found broken or
# unpinned; a regression in any of them must fail loudly.


def test_plan_rejects_renamed_credential_fields(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    # The deny-list era is over: a renamed credential slot must be rejected
    # by the per-backend allow-list, and the literal must never be echoed.
    secret = "sk-SUPER-SECRET-renamed-value"
    for field in ("credential", "password", "token", "secret"):
        plan = load_plan()
        plan["conditions"][2][field] = secret
        captured = run_cmd_expecting_exit("plan", ["--plan", str(write_plan(tmp_path, plan))], 2, capsys)
        assert "forbidden" in captured.err
        assert secret not in captured.out + captured.err


def test_apply_score_masks_lane_secrets_and_keeps_cap_note(monkeypatch: pytest.MonkeyPatch) -> None:
    # The production masking layer (src/run/review.ts ~1636-1660): a
    # credential echoed in the model's reason or concern evidence must never
    # survive into the canonical result, and the deterministic cap note must
    # survive the reason re-bound.
    monkeypatch.setenv("PILOT_TEST_LANE_SECRET", "super-secret-lane-key-9")
    work = Path(tempfile.mkdtemp())
    answer = raw_answer(5, "low", f"review leaks super-secret-lane-key-9 in prose",
                        concerns=[{"file": "leak.txt", "line": 3, "evidence": "token super-secret-lane-key-9 here"}])
    result = apply_score_via_bridge(
        answer,
        [{"severity": "blocker", "category": "bug", "file": "a.ts", "line": 1, "message": "m"}],
        {},
        "model-x",
        work,
        secret_env_names=["PILOT_TEST_LANE_SECRET"],
    )
    serialized = json.dumps(result)
    assert "super-secret-lane-key-9" not in serialized
    assert result["status"] == "scored"
    assert result["score"] == 2  # blocker ceiling still applies after masking
    assert "[deterministic cap: blocker_cap_2]" in result["reason"]


def test_apply_score_masks_over_limit_field_back_under_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # Exact-value masking is not length-preserving: a field the parser
    # bounded exactly to its limit can leave masking OVER the limit, so the
    # canonical result must re-bound AFTER masking.
    monkeypatch.setenv("PILOT_TEST_LANE_SECRET", "s")
    work = Path(tempfile.mkdtemp())
    evidence = "x" * 395 + " s " + "y" * 50  # > MAX_CONFIDENCE_CONCERN_EVIDENCE_CHARS after masking
    answer = raw_answer(3, "medium", "fine", concerns=[{"file": "a.txt", "line": None, "evidence": evidence}])
    result = apply_score_via_bridge(answer, [], {}, "m", work, secret_env_names=["PILOT_TEST_LANE_SECRET"])
    assert len(result["concerns"][0]["evidence"]) <= 400
    assert "super" not in json.dumps(result)


def test_review_result_parity_with_production_marker_semantics() -> None:
    # markerReviewResult (src/publish/publish.ts:247) over the PRODUCTION
    # strictReviewResult — pinned here so the local composition cannot drift.
    work = Path(tempfile.mkdtemp())
    minor = [{"severity": "minor", "file": "a.ts", "line": 1, "message": "m"}]

    def derive(verdict, policy, findings, required_checks, partial=False):
        return review_result_via_bridge(verdict, policy, findings, required_checks, partial, work)

    assert derive("approve", "strict", [], "complete") == "clean"
    assert derive("approve", "strict", minor, "complete") == "findings"
    assert derive("approve", "strict", [], "incomplete") == "partial"
    assert derive("request_changes", "strict", [], "complete") == "issues"
    assert derive("request_changes", "model", [], "complete") == "issues"
    assert derive("approve", "model", [], "complete") == "clean"
    assert derive("approve", "model", minor, "complete") == "clean"
    assert derive("approve", "strict", [], "complete", partial=True) == "partial"
    assert derive("request_changes", "strict", [], "complete", partial=True) == "issues"


def test_baseline_condition_records_disabled_rows_without_env(tmp_path: Path) -> None:
    # The declared baseline control must run with NO env lookups at all
    # (a KeyError here would crash the declared arm).
    results_path = tmp_path / "results.json"
    rc = run_cmd("score", [
        "--plan", str(SAMPLE_PLAN),
        "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
        "--out", str(results_path),
        "--condition", "baseline",
        "--allow-missing-corpus-entry",
    ])
    assert rc == 0
    results = json.loads(results_path.read_text(encoding="utf-8"))
    assert results["rows"]
    assert all(row["scorer"]["status"] == "disabled" for row in results["rows"])
    assert all(row["wire_attempts"] == 0 for row in results["rows"])
    report = render_report(results)
    assert "## Condition `baseline`" in report


def test_score_merge_replaces_selected_condition_and_keeps_others(tmp_path: Path) -> None:
    runs_dir = fixture_runs_dir_copy(tmp_path)
    results_path = tmp_path / "results.json"
    assert run_cmd("score", [
        "--plan", str(SAMPLE_PLAN), "--runs-dir", str(runs_dir),
        "--out", str(results_path), "--condition", "mock",
        "--allow-missing-corpus-entry",
    ]) == 0
    first = json.loads(results_path.read_text(encoding="utf-8"))
    assert any(row["condition"] == "mock" and row["repeat_index"] == 1 for row in first["rows"])
    # Re-run the same condition with fewer repeats: its rows are replaced
    # wholesale (no stale r1 rows), and a second condition merges alongside.
    assert run_cmd("score", [
        "--plan", str(SAMPLE_PLAN), "--runs-dir", str(runs_dir),
        "--out", str(results_path), "--condition", "mock", "--repeat", "1", "--merge",
        "--allow-missing-corpus-entry",
    ]) == 0
    assert run_cmd("score", [
        "--plan", str(SAMPLE_PLAN), "--runs-dir", str(runs_dir),
        "--out", str(results_path), "--condition", "baseline", "--merge",
        "--allow-missing-corpus-entry",
    ]) == 0
    merged = json.loads(results_path.read_text(encoding="utf-8"))
    conditions = merged["conditions"]
    assert "mock" in conditions and "baseline" in conditions
    assert not any(row["condition"] == "mock" and row["repeat_index"] == 1 for row in merged["rows"])
    assert any(row["condition"] == "baseline" for row in merged["rows"])
    # Mock re-run with --repeat 1 owns its condition: 7 rows (5 primary_ok +
    # 2 disabled evidence rows), r1 rows gone.
    assert len([row for row in merged["rows"] if row["condition"] == "mock"]) == 7


def test_report_metrics_are_per_condition_not_pooled() -> None:
    # Two conditions, one defective scored row each: pooled math would print
    # 1/2; per-condition math prints 1/1 and 0/1.
    def row(pr_id: str, condition: str, score: int) -> dict:
        return {
            "pr_id": pr_id, "kind": "vulnerable", "condition": condition,
            "repeat_index": 0, "evidence_state": "primary_ok",
            "primary": {"verdict": "approve", "findings_by_severity": {}, "required_checks": "complete",
                        "verdict_policy": "strict", "review_result": "clean"},
            "scorer": {"status": "scored", "score": score, "risk": "high", "reason": "", "concerns": [],
                       "model": "m", "cause": "", "caps": []},
            "usage": None, "latency_ms": None, "prompt_bytes": None, "wire_attempts": 1,
            "_defect": {"file": "a.ts", "severity": "major"}, "_primary_findings": [],
            "source": "corpus",
        }

    results = {
        "plan": "synthetic", "plan_digest": "sha256:x", "conditions": ["c1", "c2"],
        "repeats": 1, "budget_exhausted": False, "budget_note": "",
        "rows": [row("p1", "c1", 5), row("p2", "c2", 1)],
        "generated_at": "2026-10-21T00:00:00Z",
    }
    report = render_report(results)
    assert "1/1 defective scored rows" in report
    assert "0/1 defective scored rows" in report
    # The pooled 1/2 shape must never appear.
    assert "1/2" not in report


def test_cost_table_counts_attempts_not_successes(mock_pilot: dict) -> None:
    # A 429 is still an attempted model call; a zero call count after live
    # attempts would understate the spend the ceilings bound.
    rows = [
        {"condition": "same-model", "wire_attempts": 1, "usage": None, "latency_ms": 120},
        {"condition": "same-model", "wire_attempts": 1, "usage": {"prompt_tokens": 5, "completion_tokens": 7},
         "latency_ms": 80},
        {"condition": "mock", "wire_attempts": 0, "usage": None, "latency_ms": 4},
    ]
    table = cost_table(rows)
    assert table["same-model"]["calls"] == 2
    assert table["same-model"]["completion_tokens"] == 7
    assert table["mock"]["calls"] == 0


def test_live_backend_429_still_counts_as_attempted_call(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pilot = LoopbackProvider(lambda _handler: (429, {"error": {"message": "slow down"}}))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results = run_live_score(tmp_path, monkeypatch)
        costs = cost_table(results["rows"])
        assert costs["same-model"]["calls"] == 5  # five attempts, zero successes
        assert costs["same-model"]["completion_tokens"] == 0
    finally:
        server.shutdown()


def test_live_backend_redirect_is_refused_and_credential_not_forwarded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Production refuses redirects; the default urllib opener would follow a
    # 30x AND re-send the credential to the redirect target. The pilot must
    # do neither: the redirect is a recorded failure and the target receives
    # nothing.
    target = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    target_server, _target_url = serve(target)
    redirect = LoopbackProvider(lambda handler: (
        302,
        {},
        {"Location": f"http://127.0.0.1:{target_server.server_port}/chat/completions"},
    ))
    redirect_server, base_url = serve(redirect)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results = run_live_score(tmp_path, monkeypatch)
        unscored = [row for row in results["rows"] if row["scorer"]["status"] == "unscored"]
        assert len(unscored) == 5
        assert all(row["scorer"]["cause"] in ("http_302", "http_301", "http_307", "http_308")
                   for row in unscored)
        # The redirect target must have received NOTHING.
        assert len(target.requests) == 0
        assert len(redirect.requests) == 5
    finally:
        redirect_server.shutdown()
        target_server.shutdown()


def test_missing_coverage_artifact_is_not_primary_ok(tmp_path: Path) -> None:
    # The deterministic incomplete-coverage ceiling reads the coverage
    # record; a run dir without review-coverage.json would fail that input
    # open, so the row must not count as usable primary evidence.
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "ai-output.json").write_text(
        json.dumps({"verdict": "approve", "findings": [], "required_checks": "complete"}),
        encoding="utf-8",
    )
    assert primary_evidence_state({"ok": True}, run_dir) == "primary_artifacts_missing"
    (run_dir / "review-coverage.json").write_text("{}", encoding="utf-8")
    assert primary_evidence_state({"ok": True}, run_dir) == "primary_ok"


def test_unsafe_path_components_are_rejected(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    for bad in ("../escape", "a/b", "..", "", "a\\b"):
        with pytest.raises(ValueError):
            _safe_component(bad)
    # And a hostile runs.json pr_id is a plan-level rejection, not a crash.
    runs_dir = tmp_path / "hostile"
    runs_dir.mkdir()
    (runs_dir / "runs.json").write_text(
        json.dumps({"mode": "tools_off", "work_dir": ".", "entries": [
            {"pr_id": "../escape", "kind": "clean", "run_dir": None, "ok": False, "error": None},
        ]}),
        encoding="utf-8",
    )
    rc = run_cmd("score", [
        "--plan", str(SAMPLE_PLAN), "--runs-dir", str(runs_dir),
        "--out", str(tmp_path / "results.json"), "--condition", "mock",
        "--allow-missing-corpus-entry",
    ])
    assert rc == 2
    assert "unsafe path component" in capsys.readouterr().err


def test_budget_ceiling_that_fits_completes_all_calls(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Regression pin for the budget double-count: 5 planned calls against a
    # ceiling of 6 FIT — every call must happen and nothing may abort. The
    # old code counted planned (total) + made and stopped after 3 calls.
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results = run_live_score(tmp_path, monkeypatch, max_calls=6)
        assert results["budget_exhausted"] is False
        assert len(pilot.requests) == 5  # all five planned calls went out
        assert len([row for row in results["rows"] if row["scorer"]["status"] == "scored"]) == 5
    finally:
        server.shutdown()


def test_bridge_review_result_failure_fails_row_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A bridge failure while deriving review_result must not silently
    # degrade the prompt input and still publish a scored row.
    calls = {"n": 0}

    def broken_run_bridge(subcommand, request, work_dir):
        calls["n"] += 1
        if subcommand == "review-result":
            raise RuntimeError("bridge review-result failed (exit 1)")
        return confidence_calibration._run_bridge(subcommand, request, work_dir)

    monkeypatch.setattr(confidence_calibration, "_run_bridge", broken_run_bridge)
    results_path = tmp_path / "results.json"
    rc = run_cmd("score", [
        "--plan", str(SAMPLE_PLAN),
        "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
        "--out", str(results_path),
        "--condition", "mock",
        "--allow-missing-corpus-entry",
    ])
    monkeypatch.undo()
    assert rc == 0
    assert calls["n"] > 0
    results = json.loads(results_path.read_text(encoding="utf-8"))
    failed = [row for row in results["rows"] if row["scorer"].get("cause") == "bridge_review_result_failed"]
    assert failed, "a failed review_result derivation must fail its rows closed"
    assert all(row["scorer"]["status"] == "unscored" for row in failed)


# Run-dir containment (fail closed) ────────────────────────────────────


def test_resolve_run_dir_rejects_escape_paths(tmp_path: Path) -> None:
    # run_dir originates from runs.json (a run artifact, not operator
    # config), so containment is fail-closed: traversal, absolute escape,
    # and symlink escape resolve to None (primary_artifacts_missing), and
    # a null byte is rejected, never raised past the caller.
    runs_dir = tmp_path / "runs"
    (runs_dir / "run-ok").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (runs_dir / "run-link-out").symlink_to(outside, target_is_directory=True)
    (runs_dir / "run-link-in").symlink_to(runs_dir / "run-ok", target_is_directory=True)
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": "run-ok"}) == runs_dir / "run-ok"
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": "run-link-in"}) is not None
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": "../outside"}) is None
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": str(outside)}) is None
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": "run-link-out"}) is None
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": "run-ok\0"}) is None
    assert confidence_calibration._resolve_run_dir(runs_dir, {"run_dir": ""}) is None
    assert confidence_calibration._resolve_run_dir(runs_dir, {}) is None


def test_score_merge_refuses_cumulative_calls_over_ceiling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Wire attempts already recorded in a merged results file were real
    # provider calls: a follow-up --merge must count them against the
    # plan's ceilings and refuse to start (exit 3, zero new requests)
    # when the cumulative total would exceed max_scorer_calls.
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results_path = tmp_path / "results.json"
        argv = [
            "--plan", str(live_plan(tmp_path, max_calls=5)),
            "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
            "--out", str(results_path),
            "--condition", "same-model",
            "--repeat", "1",
            "--allow-missing-corpus-entry",
        ]
        assert run_cmd("score", argv) == 0
        assert len([row for row in json.loads(results_path.read_text(encoding="utf-8"))["rows"]
                    if row["scorer"]["status"] == "scored"]) == 5
        assert len(pilot.requests) == 5
        before = results_path.read_text(encoding="utf-8")
        # 5 spent + 5 planned > max_scorer_calls=5: refuse before any call.
        assert run_cmd("score", [*argv, "--merge"]) == 3
        assert len(pilot.requests) == 5
        assert results_path.read_text(encoding="utf-8") == before
    finally:
        server.shutdown()


def test_score_merge_within_ceiling_records_carried_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A merge that fits the cumulative ceiling succeeds, spends exactly the
    # planned new calls, and records the carried wire-attempt count.
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results_path = tmp_path / "results.json"
        argv = [
            "--plan", str(live_plan(tmp_path, max_calls=10)),
            "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
            "--out", str(results_path),
            "--condition", "same-model",
            "--repeat", "1",
            "--allow-missing-corpus-entry",
        ]
        assert run_cmd("score", argv) == 0
        assert len(pilot.requests) == 5
        assert run_cmd("score", [*argv, "--merge"]) == 0
        merged = json.loads(results_path.read_text(encoding="utf-8"))
        assert merged["carried_wire_calls"] == 5
        assert merged["lifetime_wire_calls"] == 10
        assert len([row for row in merged["rows"] if row["scorer"]["status"] == "scored"]) == 5
        assert len(pilot.requests) == 10
    finally:
        server.shutdown()


def test_score_merge_lifetime_ceiling_refuses_third_re_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Lifetime accounting: a merge replaces its re-selected condition's rows
    # wholesale, so the row-level wire-attempt sum alone would forget earlier
    # spend. The persisted lifetime counter makes a repeated same-condition
    # re-run refuse (exit 3, zero new requests) instead of exceeding the
    # plan's cumulative ceiling.
    pilot = LoopbackProvider(lambda _handler: (200, OPENAI_OK))
    server, base_url = serve(pilot)
    for name, value in live_env(base_url).items():
        monkeypatch.setenv(name, value)
    try:
        results_path = tmp_path / "results.json"
        argv = [
            "--plan", str(live_plan(tmp_path, max_calls=10)),
            "--runs-dir", str(fixture_runs_dir_copy(tmp_path)),
            "--out", str(results_path),
            "--condition", "same-model",
            "--repeat", "1",
            "--allow-missing-corpus-entry",
        ]
        assert run_cmd("score", argv) == 0
        assert run_cmd("score", [*argv, "--merge"]) == 0
        assert len(pilot.requests) == 10
        merged = json.loads(results_path.read_text(encoding="utf-8"))
        assert merged["lifetime_wire_calls"] == 10
        before = results_path.read_text(encoding="utf-8")
        # 10 spent + 5 planned > max_scorer_calls=10: refuse before any call.
        assert run_cmd("score", [*argv, "--merge"]) == 3
        assert len(pilot.requests) == 10
        assert results_path.read_text(encoding="utf-8") == before
    finally:
        server.shutdown()


def test_score_merge_mock_rows_not_gated_by_carried_spend(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    # Zero-cost mock rows must never be marked budget_exhausted by carried
    # live spend: the progressive budget gate applies to live backends only.
    ceiling = load_plan()["ceilings"]["max_scorer_calls"]
    runs_dir = fixture_runs_dir_copy(tmp_path)
    results_path = tmp_path / "results.json"
    assert run_cmd("score", [
        "--plan", str(SAMPLE_PLAN), "--runs-dir", str(runs_dir),
        "--out", str(results_path), "--condition", "mock",
        "--allow-missing-corpus-entry",
    ]) == 0
    seeded = json.loads(results_path.read_text(encoding="utf-8"))
    # Simulate a file whose lifetime live spend has exactly reached the
    # plan's call ceiling (equality is where the closure previously fired).
    seeded["lifetime_wire_calls"] = ceiling
    results_path.write_text(json.dumps(seeded), encoding="utf-8")
    assert run_cmd("score", [
        "--plan", str(SAMPLE_PLAN), "--runs-dir", str(runs_dir),
        "--out", str(results_path), "--condition", "mock",
        "--allow-missing-corpus-entry", "--merge",
    ]) == 0
    merged = json.loads(results_path.read_text(encoding="utf-8"))
    assert merged["budget_exhausted"] is False
    mock_rows = [row for row in merged["rows"]
                 if row["condition"] == "mock" and row["evidence_state"] == "primary_ok"]
    assert mock_rows
    causes = {row["scorer"].get("cause") for row in mock_rows if row["scorer"]["status"] == "unscored"}
    # The fixture's canned answers include deliberate failure causes, but a
    # carried-spend budget exhaustion must never appear on zero-cost rows.
    assert "budget_exhausted" not in causes
    assert any(row["scorer"]["status"] == "scored" for row in mock_rows)
