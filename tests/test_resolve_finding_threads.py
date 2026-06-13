#!/usr/bin/env python3
"""Tests for scripts/resolve_finding_threads.py — fingerprint matching,
fail-closed resolution selection, still-open follow-up replies, suppression
output, and gh interaction against a mocked gh that mimics the real CLI's
stdout-on-error behavior (#190)."""

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
    FOLLOWUP_MARKER_PREFIX,
    extract_marker_fingerprint,
    followup_body,
    main,
    match_threads,
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


def _thread(thread_id, body, is_resolved=False, comment_id=1001, last_body=None):
    return {
        "id": thread_id,
        "isResolved": is_resolved,
        "first": {"nodes": [{"body": body, "databaseId": comment_id}]},
        "last": {"nodes": [{"body": last_body if last_body is not None else body}]},
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


class TestMatchThreads:
    def test_maps_unresolved_marker_threads(self):
        finding = _finding()
        fp = finding_fingerprint(finding)
        threads = [
            _thread("T1", f"text\n\n{finding_marker(finding)}", comment_id=7),
            _thread("T2", f"text\n\n{finding_marker(finding)}", is_resolved=True),
            _thread("T3", "no marker here"),
        ]
        matched = match_threads(threads)
        assert set(matched) == {fp}
        assert matched[fp]["thread_id"] == "T1"
        assert matched[fp]["first_comment_id"] == 7

    def test_threads_to_resolve_filters_by_fingerprint(self):
        finding = _finding()
        fp = finding_fingerprint(finding)
        threads = [
            _thread("T1", f"x\n\n{finding_marker(finding)}"),
            _thread("T4", "<!-- ai-pr-review-finding:ffffffffffffffff -->"),
        ]
        assert threads_to_resolve(threads, {fp}) == ["T1"]

    def test_only_first_comment_checked(self):
        finding = _finding()
        thread = {
            "id": "T1",
            "isResolved": False,
            "first": {"nodes": [{"body": "starter, no marker", "databaseId": 1}]},
            "last": {"nodes": [{"body": finding_marker(finding)}]},
        }
        assert match_threads([thread]) == {}

    def test_malformed_nodes_skipped(self):
        assert match_threads(None) == {}
        assert match_threads(["junk", {}, {"id": 7, "first": {}}]) == {}


class TestFollowupBody:
    def test_still_open_with_sha(self):
        body = followup_body({"resolution": "still_open"}, "a" * 40)
        assert "Still open" in body
        assert f"{FOLLOWUP_MARKER_PREFIX}{'a' * 40} -->" in body

    def test_not_verifiable(self):
        body = followup_body({"resolution": "not_verifiable_from_delta"}, "")
        assert "Not verifiable" in body
        assert FOLLOWUP_MARKER_PREFIX not in body


def _install_fake_gh(tmp_path, monkeypatch, threads_response, list_exit=0, mutation_exit=0, reply_exit=0):
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
        "if [[ \"$*\" == *in_reply_to* ]]; then\n"
        f"  if [ {reply_exit} -ne 0 ]; then\n"
        "    echo '{\"message\":\"Resource not accessible by integration\"}'\n"
        f"    exit {reply_exit}\n"
        "  fi\n"
        "  echo '{\"id\": 4242}'\n"
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


def _persisted(finding):
    """build_metadata_marker's open_findings projection of a finding."""
    persisted = {k: finding[k] for k in ("severity", "category", "file", "line")}
    persisted["message"] = finding["message"][:200]
    return persisted


def _write_inputs(tmp_path, carried_persisted, findings):
    prev = tmp_path / "previous-findings.json"
    prev.write_text(json.dumps(carried_persisted), encoding="utf-8")
    found = tmp_path / "findings.json"
    found.write_text(json.dumps(findings), encoding="utf-8")
    return str(prev), str(found)


class TestMainEndToEnd:
    HEAD_SHA = "c0ffee" * 6 + "abcd"

    @pytest.fixture(autouse=True)
    def _env(self, monkeypatch):
        monkeypatch.setenv("REPO", "owner/repo")
        monkeypatch.setenv("PR_NUMBER", "42")
        monkeypatch.setenv("HEAD_SHA", self.HEAD_SHA)

    def test_resolves_fixed_and_replies_still_open(self, tmp_path, monkeypatch):
        fixed = _finding(message="fixed finding")
        still = _finding(message="still broken", line=33)
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(fixed), _persisted(still)],
            [
                {"id": "P1", "resolution": "resolved", "message": fixed["message"]},
                {"id": "P2", "resolution": "still_open", "message": still["message"]},
            ],
        )
        log = _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload(
                [
                    _thread("T_fixed", f"x\n\n{finding_marker(fixed)}", comment_id=11),
                    _thread("T_still", f"x\n\n{finding_marker(still)}", comment_id=22),
                    _thread("T_unrelated", "human comment", comment_id=33),
                ]
            ),
        )
        out = tmp_path / "finding-threads.json"
        assert main(["prog", prev, found, str(out)]) == 0
        calls = log.read_text()
        assert calls.count("resolveReviewThread") == 1
        assert "T_fixed" in calls
        assert "in_reply_to=22" in calls
        assert "in_reply_to=33" not in calls
        # Suppression file lists only the surviving open thread.
        assert json.loads(out.read_text()) == [finding_fingerprint(still)]

    def test_followup_already_posted_for_head_is_skipped(self, tmp_path, monkeypatch):
        still = _finding(message="still broken")
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(still)],
            [{"id": "P1", "resolution": "still_open", "message": still["message"]}],
        )
        log = _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload(
                [
                    _thread(
                        "T_still",
                        f"x\n\n{finding_marker(still)}",
                        last_body=f"_Still open_\n\n{FOLLOWUP_MARKER_PREFIX}{self.HEAD_SHA} -->",
                    )
                ]
            ),
        )
        out = tmp_path / "finding-threads.json"
        assert main(["prog", prev, found, str(out)]) == 0
        assert "in_reply_to" not in log.read_text()
        # Still suppressed: the thread exists and stays open.
        assert json.loads(out.read_text()) == [finding_fingerprint(still)]

    def test_unanswered_carried_finding_gets_reply(self, tmp_path, monkeypatch):
        """Fail-closed: a carried finding the model never answered is still
        open, so its thread gets a follow-up too."""
        still = _finding(message="ghosted finding")
        prev, found = _write_inputs(tmp_path, [_persisted(still)], [])
        log = _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload([_thread("T_still", f"x\n\n{finding_marker(still)}", comment_id=5)]),
        )
        assert main(["prog", prev, found]) == 0
        assert "in_reply_to=5" in log.read_text()

    def test_no_thread_no_reply_not_suppressed(self, tmp_path, monkeypatch):
        """A still-open carried finding without a surviving thread falls back
        to the fresh-comment path: no reply, absent from suppression."""
        still = _finding(message="never anchored")
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(still)],
            [{"id": "P1", "resolution": "still_open", "message": still["message"]}],
        )
        log = _install_fake_gh(tmp_path, monkeypatch, _threads_payload([]))
        out = tmp_path / "finding-threads.json"
        assert main(["prog", prev, found, str(out)]) == 0
        assert "in_reply_to" not in log.read_text()
        assert json.loads(out.read_text()) == []

    def test_gh_list_failure_is_swallowed(self, tmp_path, monkeypatch, capsys):
        """gh exits non-zero and prints a JSON error body to stdout (#190);
        the script must warn, skip everything, and still exit 0."""
        finding = _finding()
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(finding)],
            [{"id": "P1", "resolution": "resolved", "message": finding["message"]}],
        )
        log = _install_fake_gh(tmp_path, monkeypatch, _threads_payload([]), list_exit=1)
        assert main(["prog", prev, found]) == 0
        assert "could not list review threads" in capsys.readouterr().err
        assert "resolveReviewThread" not in log.read_text()

    def test_mutation_failure_is_swallowed(self, tmp_path, monkeypatch, capsys):
        finding = _finding()
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(finding)],
            [{"id": "P1", "resolution": "resolved", "message": finding["message"]}],
        )
        _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload([_thread("T_match", finding_marker(finding))]),
            mutation_exit=1,
        )
        assert main(["prog", prev, found]) == 0
        assert "could not resolve review thread" in capsys.readouterr().err

    def test_reply_failure_is_swallowed(self, tmp_path, monkeypatch, capsys):
        still = _finding(message="still broken")
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(still)],
            [{"id": "P1", "resolution": "still_open", "message": still["message"]}],
        )
        _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload([_thread("T_still", finding_marker(still))]),
            reply_exit=1,
        )
        assert main(["prog", prev, found]) == 0
        assert "could not reply on review thread" in capsys.readouterr().err

    def test_reply_cap_respected(self, tmp_path, monkeypatch):
        findings = [_finding(message=f"open finding {i}", line=10 + i) for i in range(3)]
        prev, found = _write_inputs(
            tmp_path,
            [_persisted(f) for f in findings],
            [{"id": f"P{i + 1}", "resolution": "still_open", "message": f["message"]} for i, f in enumerate(findings)],
        )
        monkeypatch.setenv("INLINE_FINDINGS_MAX", "1")
        log = _install_fake_gh(
            tmp_path,
            monkeypatch,
            _threads_payload(
                [_thread(f"T{i}", finding_marker(f), comment_id=100 + i) for i, f in enumerate(findings)]
            ),
        )
        assert main(["prog", prev, found]) == 0
        assert log.read_text().count("in_reply_to") == 1

    def test_forgejo_platform_skips_graphql(self, tmp_path, monkeypatch):
        """When platform=forgejo, skip GraphQL thread management and log."""
        monkeypatch.setenv("PLATFORM", "forgejo")
        carried = _persisted(_finding(message="carried finding"))
        prev, found = _write_inputs(tmp_path, [carried], [])
        out_file = tmp_path / "open-threads.json"
        assert main(["prog", prev, found, str(out_file)]) == 0
        # Should have written empty suppression file (no threads matched)
        assert out_file.read_text().strip() == "[]"

    def test_forgejo_auto_detect_skips_graphql(self, tmp_path, monkeypatch):
        """When PLATFORM=auto and FORGEJO_API_URL set, skip GraphQL."""
        monkeypatch.setenv("PLATFORM", "auto")
        monkeypatch.setenv("FORGEJO_API_URL", "https://forgejo.example.com")
        carried = _persisted(_finding(message="carried finding"))
        prev, found = _write_inputs(tmp_path, [carried], [])
        out_file = tmp_path / "open-threads.json"
        assert main(["prog", prev, found, str(out_file)]) == 0
        assert out_file.read_text().strip() == "[]"

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

    def test_resolution_precedes_comment_build(self):
        # The suppression file must exist before comments are built, in both
        # publish steps.
        action = self.ACTION
        first_build = action.find("build_review_comments.py")
        first_resolve = action.find("resolve_finding_threads")
        assert -1 < first_resolve < first_build
        second_build = action.find("build_review_comments.py", first_build + 1)
        second_resolve = action.find("resolve_finding_threads", first_resolve + 1)
        assert -1 < second_resolve < second_build

    def test_builders_receive_suppression_file(self):
        assert self.ACTION.count("SUPPRESS_FINDINGS_FILE=finding-threads.json") == 2

    def test_helper_gates_on_inline_findings_and_carryover(self):
        assert "resolve_finding_threads()" in self.HELPERS
        assert "previous-findings.json" in self.HELPERS
        assert "INLINE_FINDINGS" in self.HELPERS
        # Stale suppression from a previous step must not leak.
        assert "rm -f finding-threads.json" in self.HELPERS


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
