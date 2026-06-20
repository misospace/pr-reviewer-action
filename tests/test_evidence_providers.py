#!/usr/bin/env python3
"""Tests for scripts/run_evidence_providers.py — core functions and wrapper integration."""

import json
import os
import subprocess
import sys
from pathlib import Path
from unittest import mock

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import pytest

from run_evidence_providers import (  # noqa: E402
    normalize_severity,
    parse_findings,
    severity_rank,
    env_int,
    run_provider,
)

EVIDENCE_SCRIPT = _SCRIPTS_DIR / "run_evidence_providers.py"

HELPER_JSON_FINDINGS = """\
#!/usr/bin/env python3
import json, sys
data = {"severity": "warning", "findings": [{"message": "test finding", "severity": "warning"}]}
json.dump(data, sys.stdout)
"""

HELPER_BLOCKER = """\
#!/usr/bin/env python3
import json, sys
data = {"severity": "blocker", "findings": [{"message": "critical issue", "severity": "blocker"}]}
json.dump(data, sys.stdout)
"""

HELPER_MIXED = """\
#!/usr/bin/env python3
import json, sys
data = {"severity": "warning", "findings": [
    {"message": "low", "severity": "info"},
    {"message": "high", "severity": "blocker"}
]}
json.dump(data, sys.stdout)
"""

HELPER_SECRET_STDOUT = """\
#!/usr/bin/env python3
print("api_key=sk-secret_value_1234567890")
"""

HELPER_SECRET_STDERR = """\
#!/usr/bin/env python3
import sys
sys.stderr.write("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\\n")
"""


def _run_with_config(
    config_data, tmp_path: Path, extra_env=None
) -> subprocess.CompletedProcess:
    config_file = tmp_path / "providers.json"
    config_file.write_text(json.dumps(config_data, indent=2), encoding="utf-8")
    env = os.environ.copy()
    env["EVIDENCE_PROVIDERS_FILE"] = str(config_file)
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(
        [sys.executable, str(EVIDENCE_SCRIPT)],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result


def _load_json_output(tmp_path: Path) -> dict:
    out = (tmp_path / "evidence-providers.json").read_text(encoding="utf-8")
    return json.loads(out)


# ── Core function tests: normalize_severity ─────────────────────────

def test_normalize_severity_info():
    assert normalize_severity("info") == "info"


def test_normalize_severity_warning():
    assert normalize_severity("warning") == "warning"


def test_normalize_severity_blocker():
    assert normalize_severity("blocker") == "blocker"


def test_normalize_severity_uppercase():
    assert normalize_severity("BLOCKER") == "blocker"


def test_normalize_severity_title_case():
    assert normalize_severity("Info") == "info"
    assert normalize_severity("Warning") == "warning"
    assert normalize_severity("Blocker") == "blocker"


def test_normalize_severity_none():
    assert normalize_severity(None) == "info"


def test_normalize_severity_invalid():
    assert normalize_severity("critical") == "info"
    assert normalize_severity("error") == "info"
    assert normalize_severity("") == "info"


def test_normalize_severity_whitespace():
    assert normalize_severity("  blocker  ") == "blocker"


# ── Core function tests: severity_rank ──────────────────────────────

def test_severity_rank_blocker():
    assert severity_rank("blocker") == 3


def test_severity_rank_warning():
    assert severity_rank("warning") == 2


def test_severity_rank_info():
    assert severity_rank("info") == 1


# ── Core function tests: parse_findings ─────────────────────────────

def test_parse_findings_empty_dict():
    severity, findings = parse_findings({})
    assert severity == "info"
    assert findings == []


def test_parse_findings_non_dict():
    severity, findings = parse_findings("not a dict")
    assert severity == "info"
    assert findings == []


def test_parse_findings_list_of_strings():
    payload = {"severity": "warning", "findings": ["issue one", "issue two"]}
    severity, findings = parse_findings(payload)
    assert severity == "warning"
    assert len(findings) == 2
    assert findings[0]["message"] == "issue one"
    assert findings[0]["severity"] == "info"


def test_parse_findings_list_of_dicts_with_message():
    payload = {
        "severity": "blocker",
        "findings": [{"message": "critical bug", "severity": "blocker"}],
    }
    severity, findings = parse_findings(payload)
    assert severity == "blocker"
    assert len(findings) == 1
    assert findings[0]["message"] == "critical bug"
    assert findings[0]["severity"] == "blocker"


def test_parse_findings_list_of_dicts_with_summary():
    payload = {"findings": [{"summary": "fallback summary"}]}
    severity, findings = parse_findings(payload)
    assert len(findings) == 1
    assert findings[0]["message"] == "fallback summary"


def test_parse_findings_list_of_dicts_with_title():
    payload = {"findings": [{"title": "title field"}]}
    severity, findings = parse_findings(payload)
    assert len(findings) == 1
    assert findings[0]["message"] == "title field"


def test_parse_findings_skips_items_without_message():
    payload = {"findings": [{"severity": "blocker"}, {"summary": "has summary"}]}
    severity, findings = parse_findings(payload)
    assert len(findings) == 1
    assert findings[0]["message"] == "has summary"


def test_parse_findings_strings_become_findings():
    payload = {"findings": ["item one", {"message": "item two"}]}
    severity, findings = parse_findings(payload)
    assert len(findings) == 2
    assert findings[0]["message"] == "item one"
    assert findings[1]["message"] == "item two"


def test_parse_findings_highest_severity_from_findings():
    payload = {
        "severity": "info",
        "findings": [
            {"message": "low", "severity": "info"},
            {"message": "high", "severity": "blocker"},
        ],
    }
    severity, findings = parse_findings(payload)
    assert severity == "blocker"


def test_parse_findings_fallback_message():
    payload = {"message": "no findings array, use message field"}
    severity, findings = parse_findings(payload)
    assert len(findings) == 1
    assert findings[0]["message"] == "no findings array, use message field"


def test_parse_findings_fallback_summary():
    payload = {"summary": "fallback summary text"}
    severity, findings = parse_findings(payload)
    assert len(findings) == 1
    assert findings[0]["message"] == "fallback summary text"


def test_parse_findings_truncates_to_40():
    findings_list = [{"message": f"item {i}"} for i in range(50)]
    payload = {"findings": findings_list}
    severity, findings = parse_findings(payload)
    assert len(findings) == 40


def test_parse_findings_source_from_field():
    payload = {"findings": [{"message": "x", "source": "file.py"}]}
    severity, findings = parse_findings(payload)
    assert findings[0]["source"] == "file.py"


def test_parse_findings_source_from_sources_list():
    payload = {"findings": [{"message": "x", "sources": ["a.py", "b.py"]}]}
    severity, findings = parse_findings(payload)
    assert findings[0]["source"] == "a.py, b.py"


def test_parse_findings_empty_sources_becomes_empty_string():
    payload = {"findings": [{"message": "x", "sources": []}]}
    severity, findings = parse_findings(payload)
    assert findings[0]["source"] == ""


# ── Core function tests: env_int ────────────────────────────────────

def test_env_int_valid():
    with mock.patch.dict(os.environ, {"TEST_ENV_INT": "42"}):
        assert env_int("TEST_ENV_INT", 10) == 42


def test_env_int_default():
    with mock.patch.dict(os.environ, {}, clear=False):
        key = f"TEST_ENV_INT_{os.getpid()}"
        assert env_int(key, 7) == 7


def test_env_int_non_numeric_returns_default():
    with mock.patch.dict(os.environ, {"TEST_ENV_INT": "abc"}):
        assert env_int("TEST_ENV_INT", 5) == 5


def test_env_int_negative_clamped_to_1():
    with mock.patch.dict(os.environ, {"TEST_ENV_INT": "-10"}):
        assert env_int("TEST_ENV_INT", 5) == 1


def test_env_int_zero_clamped_to_1():
    with mock.patch.dict(os.environ, {"TEST_ENV_INT": "0"}):
        assert env_int("TEST_ENV_INT", 5) == 1


# ── Integration tests: no providers configured ─────────────────────

class TestNoConfig:
    def test_empty_env(self, tmp_path: Path):
        result = _run_with_config({}, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        assert data["configured"] is True
        assert data["provider_count"] == 0

    def test_missing_config_file(self, tmp_path: Path):
        env = os.environ.copy()
        env["EVIDENCE_PROVIDERS_FILE"] = str(tmp_path / "nonexistent.json")
        result = subprocess.run(
            [sys.executable, str(EVIDENCE_SCRIPT)],
            cwd=str(tmp_path),
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        assert "error" in data
        assert "not found" in data["error"]


# ── Integration tests: stdout capture ──────────────────────────────

class TestStdoutCapture:
    def test_json_stdout_with_findings(self, tmp_path: Path):
        helper = tmp_path / "json_provider.py"
        helper.write_text(HELPER_JSON_FINDINGS)
        config = {"providers": [{"id": "test-json", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = _load_json_output(tmp_path)
        assert data["configured"] is True
        assert len(data["providers"]) == 1
        p = data["providers"][0]
        assert p["status"] == "ok"
        assert p["output_format"] == "json"
        assert len(p["findings"]) == 1
        assert p["findings"][0]["message"] == "test finding"

    def test_text_stdout_no_findings(self, tmp_path: Path):
        config = {"providers": [{"id": "test-text", "command": "echo 'just some text output'"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "ok"
        assert p["output_format"] == "text"
        assert "just some text output" in p["stdout"]


# ── Integration tests: stderr capture ───────────────────────────────

class TestStderrCapture:
    def test_stderr_is_captured(self, tmp_path: Path):
        helper = tmp_path / "stderr_provider.py"
        helper.write_text(HELPER_SECRET_STDERR)
        config = {"providers": [{"id": "test-stderr", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "ok"
        assert "[REDACTED]" in p["stderr"]

    def test_stderr_only_provider(self, tmp_path: Path):
        config = {"providers": [{"id": "test-stderr-only", "command": 'echo "no stdout, only stderr" >&2; exit 0'}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["stderr"].strip() == "no stdout, only stderr"


# ── Integration tests: silent provider (no output) ─────────────────

class TestSilentProvider:
    def test_silent_provider_no_crash(self, tmp_path: Path):
        config = {"providers": [{"id": "test-silent", "command": "true"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "ok"
        assert p["stdout"].strip() == ""
        assert p["stderr"].strip() == ""

    def test_silent_providers_list(self, tmp_path: Path):
        config = {"providers": [{"id": "s1", "command": "true"}, {"id": "s2", "command": "echo -n ''"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        assert len(data["providers"]) == 2
        for p in data["providers"]:
            assert p["status"] == "ok"


# ── Integration tests: nonzero exit code ───────────────────────────

class TestNonzeroExit:
    def test_nonzero_exit_status(self, tmp_path: Path):
        config = {"providers": [{"id": "test-fail", "command": "exit 42"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "error"
        assert p["exit_code"] == 42

    def test_command_that_exits_nonzero(self, tmp_path: Path):
        config = {"providers": [{"id": "test-fail-echo", "command": 'echo "failed"; exit 1'}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "error"
        assert p["exit_code"] == 1


# ── Integration tests: blocker severity ────────────────────────────

class TestBlockerProvider:
    def test_blocker_severity_sets_flag(self, tmp_path: Path):
        helper = tmp_path / "blocker_provider.py"
        helper.write_text(HELPER_BLOCKER)
        config = {"providers": [{"id": "test-blocker", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        assert data["has_blocker"] is True
        p = data["providers"][0]
        assert p["provider_severity"] == "blocker"

    def test_mixed_severities_uses_highest(self, tmp_path: Path):
        helper = tmp_path / "mixed_provider.py"
        helper.write_text(HELPER_MIXED)
        config = {"providers": [{"id": "test-mixed", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["provider_severity"] == "blocker"


# ── Integration tests: secret redaction ─────────────────────────────

class TestSecretRedaction:
    def test_stdout_secrets_redacted(self, tmp_path: Path):
        helper = tmp_path / "secret_stdout.py"
        helper.write_text(HELPER_SECRET_STDOUT)
        config = {"providers": [{"id": "test-redact", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert "sk-secret_value_1234567890" not in p["stdout"]
        assert "[REDACTED]" in p["stdout"]

    def test_stderr_secrets_redacted(self, tmp_path: Path):
        helper = tmp_path / "secret_stderr.py"
        helper.write_text(HELPER_SECRET_STDERR)
        config = {"providers": [{"id": "test-stderr-redact", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert "ghp_" not in p["stderr"]
        assert "[REDACTED]" in p["stderr"]


# ── Integration tests: markdown output ─────────────────────────────

class TestMarkdownOutput:
    def test_markdown_file_created(self, tmp_path: Path):
        config = {"providers": [{"id": "test-md", "command": "echo 'hello'"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        md_file = tmp_path / "evidence-providers.md"
        assert md_file.exists()
        content = md_file.read_text(encoding="utf-8")
        assert "test-md" in content

    def test_markdown_redacted(self, tmp_path: Path):
        helper = tmp_path / "secret_md.py"
        helper.write_text(HELPER_SECRET_STDOUT)
        config = {"providers": [{"id": "test-md-redact", "command": f"{sys.executable} {helper}"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        md_file = tmp_path / "evidence-providers.md"
        content = md_file.read_text(encoding="utf-8")
        assert "super_secret_value_xyz123" not in content
        assert "[REDACTED]" in content


# ── Integration tests: command format (argv vs shell string) ───────

class TestCommandFormat:
    def test_argv_command_executes_directly(self, tmp_path: Path):
        """Argv array commands run via subprocess with no shell interpretation."""
        helper = tmp_path / "argv_provider.py"
        helper.write_text(HELPER_JSON_FINDINGS)
        config = {"providers": [{"id": "test-argv", "command": [sys.executable, str(helper)]}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "ok"
        assert p["output_format"] == "json"
        assert len(p["findings"]) == 1

    def test_shell_string_command_executes_via_bash(self, tmp_path: Path):
        """Shell string commands run via bash -lc."""
        config = {"providers": [{"id": "test-shell", "command": "echo 'shell output'"}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["status"] == "ok"
        assert "shell output" in p["stdout"]

    def test_argv_command_stored_quoted(self, tmp_path: Path):
        """Argv commands are stored with shlex-quoted arguments."""
        config = {"providers": [{"id": "test-quote", "command": ["echo", "hello world"]}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        # The command should be stored as shlex-quoted: echo 'hello world'
        assert "echo" in p["command"]

    def test_shell_string_stored_as_is(self, tmp_path: Path):
        """Shell string commands are stored verbatim."""
        config = {"providers": [{"id": "test-verbatim", "command": 'echo "verbatim"'}]}
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0
        data = _load_json_output(tmp_path)
        p = data["providers"][0]
        assert p["command"] == 'echo "verbatim"'


# ── Unit tests: shell-string trust-boundary WARN log ───────────────

class TestShellStringWarnLog:
    """Verify that run_provider emits a WARNING for shell-string commands.

    The warning is the sole observability hook for the string→bash trust
    boundary documented in SECURITY.md ("Prefer argv arrays … over shell
    strings … to avoid shell injection risks from `bash -lc` execution").
    Execution behaviour is unchanged by this test.
    """

    def test_warn_fires_for_shell_string_command(self):
        """A string command triggers a WARNING containing 'bash -lc'."""
        provider = {"id": "shell-warn-probe", "command": "true"}
        with mock.patch("run_evidence_providers.logger") as mock_logger:
            run_provider(1, provider, default_timeout=5, default_max_output=4096)
        # Exactly one warning call, mentioning the bash trust boundary.
        assert mock_logger.warning.call_count == 1
        warn_msg = mock_logger.warning.call_args[0][0]
        assert "bash -lc" in warn_msg

    def test_no_warn_for_argv_list_command(self):
        """An argv-list command must NOT trigger the shell-string WARNING."""
        provider = {"id": "argv-no-warn-probe", "command": ["true"]}
        with mock.patch("run_evidence_providers.logger") as mock_logger:
            run_provider(1, provider, default_timeout=5, default_max_output=4096)
        assert mock_logger.warning.call_count == 0


# ── Integration tests: fork enablement skip behavior ────────────────

class TestForkEnablement:
    """Tests for evidence_enable_for_forks skip logic.

    The skip logic lives in run_review.sh, not the Python script. These tests
    verify the flag normalization used by the shell condition:
      IS_FORK_PR == "true" && EVIDENCE_ENABLE_FOR_FORKS != "true" (case-insensitive)
    """
    def _should_skip(self, is_fork_pr: str, enable_for_forks: str | None = None) -> bool:
        value = (enable_for_forks or "false").strip().lower()
        return is_fork_pr == "true" and value != "true"

    def test_fork_with_default_skips(self):
        assert self._should_skip("true", "false") is True

    def test_fork_with_true_runs(self):
        assert self._should_skip("true", "true") is False

    def test_fork_with_uppercase_true_runs(self):
        assert self._should_skip("true", "TRUE") is False

    def test_fork_with_mixed_case_runs(self):
        assert self._should_skip("true", "True") is False

    def test_fork_with_empty_skips(self):
        assert self._should_skip("true", "") is True

    def test_fork_with_unset_skips(self):
        assert self._should_skip("true", None) is True

    def test_same_repo_always_runs(self):
        assert self._should_skip("false", "false") is False
        assert self._should_skip("false", "true") is False
        assert self._should_skip("false", "") is False


# ── Parallel execution ─────────────────────────────────────────────

_TIMESTAMP_HELPER = """\
import sys, time
start = time.time()
time.sleep(0.8)
end = time.time()
open(sys.argv[1], "w").write(f"{start} {end}")
print("done")
"""


def _interval(tmp_path: Path, name: str):
    start, end = (tmp_path / name).read_text().split()
    return float(start), float(end)


class TestParallelExecution:
    def test_results_keep_config_order(self, tmp_path: Path):
        config = {
            "providers": [
                {"id": "slow", "command": "sleep 0.5; echo slow-out"},
                {"id": "fast", "command": "echo fast-out"},
            ]
        }
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = _load_json_output(tmp_path)
        assert [p["id"] for p in data["providers"]] == ["slow", "fast"]
        assert data["providers"][0]["stdout"].strip() == "slow-out"
        assert data["providers"][1]["stdout"].strip() == "fast-out"

    def test_providers_run_concurrently_by_default(self, tmp_path: Path):
        helper = tmp_path / "stamp.py"
        helper.write_text(_TIMESTAMP_HELPER)
        config = {
            "providers": [
                {"id": "a", "command": f"{sys.executable} {helper} {tmp_path}/a.ts"},
                {"id": "b", "command": f"{sys.executable} {helper} {tmp_path}/b.ts"},
            ]
        }
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        a_start, a_end = _interval(tmp_path, "a.ts")
        b_start, b_end = _interval(tmp_path, "b.ts")
        # Execution windows must overlap when run in parallel.
        assert a_start < b_end and b_start < a_end

    def test_parallelism_one_forces_serial(self, tmp_path: Path):
        helper = tmp_path / "stamp.py"
        helper.write_text(_TIMESTAMP_HELPER)
        config = {
            "providers": [
                {"id": "a", "command": f"{sys.executable} {helper} {tmp_path}/a.ts"},
                {"id": "b", "command": f"{sys.executable} {helper} {tmp_path}/b.ts"},
            ]
        }
        result = _run_with_config(
            config, tmp_path, extra_env={"EVIDENCE_PROVIDER_PARALLELISM": "1"}
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        a_start, a_end = _interval(tmp_path, "a.ts")
        b_start, b_end = _interval(tmp_path, "b.ts")
        # Serial execution: one window fully precedes the other.
        assert a_end <= b_start or b_end <= a_start

    def test_model_api_keys_scrubbed_from_provider_env(self, tmp_path: Path):
        config = {
            "providers": [
                {"id": "env-probe", "command": "echo \"key=[${AI_API_KEY:-}] fb=[${AI_FALLBACK_API_KEY:-}] gh=[${GH_TOKEN:-}]\""}
            ]
        }
        result = _run_caps(
            config,
            tmp_path,
            {
                "AI_API_KEY": "sk-should-never-leak",
                "AI_FALLBACK_API_KEY": "sk-fallback-never-leak",
                "GH_TOKEN": "gh-token-ok",
            },
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = _load_json_output(tmp_path)
        stdout = data["providers"][0]["stdout"]
        # Model keys are scrubbed before the provider runs (not just redacted
        # after); GH_TOKEN stays available for gh-based providers.
        assert "key=[]" in stdout
        assert "fb=[]" in stdout
        assert "gh-token-ok" not in stdout or "gh=[" in stdout

    def test_blocker_flag_still_aggregates(self, tmp_path: Path):
        helper = tmp_path / "blocker.py"
        helper.write_text(HELPER_BLOCKER)
        config = {
            "providers": [
                {"id": "clean", "command": "echo ok"},
                {"id": "blocker", "command": f"{sys.executable} {helper}"},
            ]
        }
        result = _run_with_config(config, tmp_path)
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = _load_json_output(tmp_path)
        assert data["has_blocker"] is True


# ── Markdown output caps (head+tail per stream, aggregate across providers) ──

from run_evidence_providers import head_tail_cap  # noqa: E402


class TestHeadTailCap:
    def test_under_cap_unchanged(self):
        assert head_tail_cap("short", 100) == "short"

    def test_over_cap_keeps_head_and_tail(self):
        text = "HEAD-" + ("x" * 5000) + "-TAIL"
        out = head_tail_cap(text, 400)
        assert out.startswith("HEAD-")
        assert out.endswith("-TAIL")
        assert "…[middle truncated]…" in out
        assert len(out.encode("utf-8")) < 500

    def test_multibyte_boundaries_survive(self):
        text = "é" * 4000
        out = head_tail_cap(text, 300)
        out.encode("utf-8").decode("utf-8")  # must be valid UTF-8


def _run_caps(config_data, tmp_path: Path, env_overrides: dict):
    config_file = tmp_path / "providers.json"
    config_file.write_text(json.dumps(config_data, indent=2), encoding="utf-8")
    env = os.environ.copy()
    env["EVIDENCE_PROVIDERS_FILE"] = str(config_file)
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, str(EVIDENCE_SCRIPT)],
        cwd=str(tmp_path),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )


class TestMarkdownCaps:
    def test_stdout_is_head_tail_capped_in_markdown(self, tmp_path: Path):
        config = {
            "providers": [
                {"id": "chatty", "command": "python3 -c \"print('START'); print('x' * 9000); print('THE-ERROR-AT-END')\""}
            ]
        }
        result = _run_caps(config, tmp_path, {"EVIDENCE_MARKDOWN_STDOUT_BYTES": "1000"})
        assert result.returncode == 0, f"stderr: {result.stderr}"
        md = (tmp_path / "evidence-providers.md").read_text()
        assert "START" in md
        assert "THE-ERROR-AT-END" in md          # tail survives
        assert "…[middle truncated]…" in md
        # JSON summary keeps the full (per-provider capped) stdout.
        data = _load_json_output(tmp_path)
        assert len(data["providers"][0]["stdout"]) > 9000

    def test_aggregate_cap_stops_further_embeds(self, tmp_path: Path):
        providers = [
            {"id": f"p{i}", "command": "python3 -c \"print('y' * 3000)\""}
            for i in range(4)
        ]
        result = _run_caps(
            {"providers": providers},
            tmp_path,
            {
                "EVIDENCE_MARKDOWN_STDOUT_BYTES": "3000",
                "EVIDENCE_MARKDOWN_AGGREGATE_BYTES": "5000",
            },
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        md = (tmp_path / "evidence-providers.md").read_text()
        assert "aggregate evidence output cap reached" in md
        # Every provider still has its header even when its output is omitted.
        for i in range(4):
            assert f"## p{i}" in md

    def test_small_outputs_unaffected(self, tmp_path: Path):
        config = {"providers": [{"id": "tiny", "command": "echo hello"}]}
        result = _run_caps(config, tmp_path, {})
        assert result.returncode == 0
        md = (tmp_path / "evidence-providers.md").read_text()
        assert "hello" in md
        assert "truncated" not in md
        assert "cap reached" not in md


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
