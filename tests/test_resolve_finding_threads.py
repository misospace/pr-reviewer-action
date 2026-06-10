#!/usr/bin/env python3
"""Tests for scripts/resolve_finding_threads.py — fingerprint matching,
fail-closed resolution selection, and gh interaction against a mocked gh
that mimics the real CLI's stdout-on-error behavior (#190)."""

import json
import os
import stat
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _REPO_ROOT / "scripts"
for _p in (str(_SCRIPTS_DIR), str(_REPO_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest

from build_review_comments import finding_fingerprint, finding_marker
from resolve_finding_threads import (
    extract_marker_fingerprint,
    main,
    resolved_fingerprints,
    threads_to_resolve,
)


def _finding(file="app/serve.py", line=12, severity="blocker", message="bad", category="security"):
    return {"severity": severity, "category": category, "file": file, "line": line, "message": message}


def _carried(finding, index=0):
    """The form load_carried_findings returns: positional id + sanitized fields."""
    return {
        "id": f"P{index + 1}",
        "severity": finding["severity"],
        "category": finding["category"],
        "file": finding["file"],
        "line": finding["line"],
        "message": finding["message"][:200],
    }


class TestExtractMarkerFingerprint:
    def test_extracts_from_comment_body(self):
        finding = _finding()
        body = f"**Blocker:** bad\n\n{finding_marker(finding)}"
        assert extract_marker_fingerprint(body) == finding_fingerprint(finding)

    def test_no_marker(self):
        assert extract_marker_fingerprint("a plain comment") is None

    def test_unterminated_marker(self):
        assert extract_marker_fingerprint("<!-- ai-pr-review-finding:abc123") is None

    def test_empty_fingerprint(self):
        assert extract_marker_fingerprint("<!-- ai-pr-review-finding: -->") is None

    def test_non_string(self):
        assert extract_marker_fingerprint(None) is None
        assert extract_marker_fingerprint(42) is None


class TestResolvedFingerprints:
    def test_only_explicit_resolved_counts(self):
        carried = [
            _carried(_finding(message="one"), 0),
            _carried(_finding(message="two"), 1),
            _carried(_finding(message="three"), 2),
        ]
        findings = [
            {"id": "P1", "resolution": "resolved", "message": "one"},
            {"id": "P2", "resolution": "still_open", "message": "two"},
            # P3 unanswered — fail-closed: stays open.
        ]
        fps = resolved_fingerprints(carried, findings)
        assert fps == {finding_fingerprint(carried[0])}

    def test_non_list_findings(self):
        assert resolved_fingerprints([_carried(_finding())], "garbage") == set()
        assert resolved_fingerprints([_carried(_finding())], None) == set()

    def test_empty_when_nothing_resolved(self):
        carried = [_carried(_finding())]
        assert resolved_fingerprints(carried, []) == set()


class TestThreadsToResolve:
    def _thread(self, thread_id, body, is_resolved=False):
        return {
            "id": thread_id,
            "isResolved": is_resolved,
            "comments": {"nodes": [{"body": body}]},
        }

    def test_matches_unresolved_marker_threads(self):
        finding = _finding()
        fp = finding_fingerprint(finding)
        threads = [
            self._thread("T1", f"text\n\n{finding_marker(finding)}"),
            self._thread("T2", f"text\n\n{finding_marker(finding)}", is_resolved=True),
            self._thread("T3", "no marker here"),
            self._thread("T4", "<!-- ai-pr-review-finding:ffffffffffffffff -->"),
        ]
        assert threads_to_resolve(threads, {fp}) == ["T1"]

    def test_only_first_comment_checked(self):
        finding = _finding()
        thread = {
            "id": "T1",
            "isResolved": False,
            "comments": {"nodes": [{"body": "starter, no marker"}, {"body": finding_marker(finding)}]},
        }
        assert threads_to_resolve([thread], {finding_fingerprint(finding)}) == []

    def test_malformed_nodes_skipped(self):
        assert threads_to_resolve(None, {"x"}) == []
        assert threads_to_resolve(["junk", {}, {"id": 7, "comments": {}}], {"x"}) == []


def _install_fake_gh(tmp_path, monkeypatch, threads_response, list_exit=0, mutation_exit=0):
    """Drop a fake gh on PATH that logs calls and replays canned responses.

    On non-zero exit the fake still prints a JSON error body to stdout,
    mimicking the real gh behavior that broke #190.
    """
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "gh-calls.log"
    response_file = tmp_path / "threads-response.json"
    response_file.write_text(json.dumps(threads_response), encoding="utf-8")
    gh = bin_dir / "gh"
    gh.write_text(
        "#!/usr/bin/env bash\n"
        f"echo \"$*\" >> '{log}'\n"
        "if [[ \"$*\" == *resolveReviewThread* ]]; then\n"
        f"  if [ {mutation_exit} -ne 0 ]; then\n"
        "    echo '{\"message\":\"Resource not accessible by integration\"}'\n"
        f"    exit {mutation_exit}\n"
        "  fi\n"
        "  echo '{\"data\":{\"resolveReviewThread\":{\"thread\":{\"isResolved\":true}}}}'\n"
        "  exit 0\n"
        "fi\n"
        f"if [ {list_exit} -ne 0 ]; then\n"
        "  echo '{\"message\":\"API rate limit exceeded\",\"documentation_url\":\"https://docs.github.com\"}'\n"
        f"  exit {list_exit}\n"
        "fi\n"
        f"cat '{response_file}'\n",
        encoding="utf-8",
    )
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    return log


def _threads_payload(nodes):
    return {
        "data": {
            "repository": {"pullRequest": {"reviewThreads": {"nodes": nodes}}}
        }
    }


def _write_inputs(tmp_path, carried_persisted, findings):
    prev = tmp_path / "previous-findings.json"
    prev.write_text(json.dumps(carried_persisted), encoding="utf-8")
    found = tmp_path / "findings.json"
    found.write_text(json.dumps(findings), encoding="utf-8")
    return str(prev), str(found)


class TestMainEndToEnd:
    @pytest.fixture(autouse=True)
    def _env(self, monkeypatch):
        monkeypatch.setenv("REPO", "owner/repo")
        monkeypatch.setenv("PR_NUMBER", "42")

    def test_resolves_matching_thread(self, tmp_path, monkeypatch):
        finding = _finding()
        # Persisted (marker) projection of the finding from the previous run.
        persisted = {k: finding[k] for k in ("severity", "category", "file", "line")}
        persisted["message"] = finding["message"][:200]
        prev, found = _write_inputs(
            tmp_path,
            [persisted],
            [{"id": "P1", "resolution": "resolved", "message": finding["message"]}],
        )
        log = _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload(
                [
                    {
                        "id": "T_match",
                        "isResolved": False,
                        "comments": {"nodes": [{"body": f"x\n\n{finding_marker(finding)}"}]},
                    },
                    {
                        "id": "T_unrelated",
                        "isResolved": False,
                        "comments": {"nodes": [{"body": "human comment"}]},
                    },
                ]
            ),
        )
        assert main(["prog", prev, found]) == 0
        calls = log.read_text()
        assert "T_match" in calls
        assert "T_unrelated" not in calls
        assert calls.count("resolveReviewThread") == 1

    def test_still_open_thread_left_alone(self, tmp_path, monkeypatch):
        finding = _finding()
        persisted = {k: finding[k] for k in ("severity", "category", "file", "line")}
        persisted["message"] = finding["message"][:200]
        prev, found = _write_inputs(
            tmp_path,
            [persisted],
            [{"id": "P1", "resolution": "still_open", "message": finding["message"]}],
        )
        log = _install_fake_gh(tmp_path, monkeypatch, _threads_payload([]))
        assert main(["prog", prev, found]) == 0
        # Nothing resolved → not even the thread list is fetched.
        assert not log.exists()

    def test_gh_list_failure_is_swallowed(self, tmp_path, monkeypatch, capsys):
        """gh exits non-zero and prints a JSON error body to stdout (#190);
        the script must warn, skip resolution, and still exit 0."""
        finding = _finding()
        persisted = {k: finding[k] for k in ("severity", "category", "file", "line")}
        persisted["message"] = finding["message"][:200]
        prev, found = _write_inputs(
            tmp_path,
            [persisted],
            [{"id": "P1", "resolution": "resolved", "message": finding["message"]}],
        )
        log = _install_fake_gh(tmp_path, monkeypatch, _threads_payload([]), list_exit=1)
        assert main(["prog", prev, found]) == 0
        assert "could not list review threads" in capsys.readouterr().err
        assert "resolveReviewThread" not in log.read_text()

    def test_mutation_failure_is_swallowed(self, tmp_path, monkeypatch, capsys):
        finding = _finding()
        persisted = {k: finding[k] for k in ("severity", "category", "file", "line")}
        persisted["message"] = finding["message"][:200]
        prev, found = _write_inputs(
            tmp_path,
            [persisted],
            [{"id": "P1", "resolution": "resolved", "message": finding["message"]}],
        )
        _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload(
                [
                    {
                        "id": "T_match",
                        "isResolved": False,
                        "comments": {"nodes": [{"body": finding_marker(finding)}]},
                    }
                ]
            ),
            mutation_exit=1,
        )
        assert main(["prog", prev, found]) == 0
        assert "could not resolve review thread" in capsys.readouterr().err

    def test_missing_env_skips(self, tmp_path, monkeypatch):
        monkeypatch.delenv("PR_NUMBER")
        prev, found = _write_inputs(tmp_path, [], [])
        assert main(["prog", prev, found]) == 0

    def test_no_carried_findings_is_quiet_noop(self, tmp_path, monkeypatch):
        prev, found = _write_inputs(tmp_path, [], [])
        log = _install_fake_gh(tmp_path, monkeypatch, _threads_payload([]))
        assert main(["prog", prev, found]) == 0
        assert not log.exists()


class TestActionWiring:
    ACTION = (_REPO_ROOT / "action.yml").read_text()
    HELPERS = (_REPO_ROOT / "scripts" / "publish_helpers.sh").read_text()

    def test_both_publish_steps_resolve_threads(self):
        assert self.ACTION.count("resolve_finding_threads") == 2

    def test_helper_gates_on_inline_findings_and_carryover(self):
        assert "resolve_finding_threads()" in self.HELPERS
        assert "previous-findings.json" in self.HELPERS
        assert "INLINE_FINDINGS" in self.HELPERS


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
