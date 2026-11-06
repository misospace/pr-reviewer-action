"""Unit tests for ``scripts/confidence_dogfood_evidence.py`` (#1452).

The collector assembles the merge-safety verifier's PUBLISHED record -- the
metadata marker, the sibling fingerprint marker and the ``## Independent
Confidence`` section -- into one bounded, redacted evidence file, so a human
can adjudicate whether the verifier earns merge-gate authority. These tests
pin the properties that adjudication depends on:

- the published pins, the fingerprint, the primary verdict and the
  verifier's own fields are read from the published body, and the marker is
  parsed with the repository's own parser, never by hand;
- the fixtures are the shape the renderer ACTUALLY publishes: bare ``>``
  separator lines, the `` at {location}`` concern form, and an UNQUOTED
  closing advisory note;
- the evidence comes from the NEWEST published body (native reviews
  accumulate, and a review is timed by the ``submitted_at`` its real
  payload carries), and the record names the body it read;
- the verifier telemetry the marker publishes (#1455 -- the unscored
  cause, the latency and the token usage) is recorded when it is
  published, and the corresponding unavailable reasons are removed only
  then; older bodies keep the old unavailable behavior;
- a scored run reports its score, risk, reason, model and every published
  advisory concern, and says whether it materially challenges the primary
  review;
- an unscored run, a run that published nothing and a pull request that
  cannot be read are each recorded as what they are -- never as a pass;
- the "unavailable" reasons are TRUE: each one names a home that really
  holds the value;
- one unreadable pull request never aborts the run;
- the evidence file is bounded and redacted by construction: the bearer
  token never reaches it, long fields are capped, and no whole comment body
  is copied into it;
- the forge is reached only through the configured forge capability.

No real network: the reads go to an in-process stub server.
"""

from __future__ import annotations

import ast
import contextlib
import io
import json
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / "scripts" / "confidence_dogfood_evidence.py"
SECRET = "token-that-must-never-leak"

HEAD_SHA = "a" * 40
BASE_SHA = "b" * 40
DIFF_FINGERPRINT = "d" * 64
CONFIG_FINGERPRINT = "c" * 64

# The advisory note the renderer closes every published section with. It is
# published UNQUOTED: it is not part of the section's quoted block.
ADVISORY_NOTE = (
    "_Advisory only: this independent merge-safety verifier audits the "
    "completed review against the pull-request diff — it is telemetry from a "
    "second model call; it does not change the review's verdict, findings, or "
    "approval, and its concerns are not findings._"
)

# A sentence that belongs to the published review body and to nothing the
# collector extracts: it must never reach the evidence file.
FOREIGN_SENTENCE = "SUMMARY the whole review body text that must not be copied"


def _load_collector():
    """Import ``scripts/confidence_dogfood_evidence.py`` as a module."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "confidence_dogfood_evidence_under_test", SCRIPT_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def collector():
    return _load_collector()


def run(collector, *args: str) -> tuple[int, str, str]:
    """Run the collector in-process; return (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = collector.main(list(args))
    return code, out.getvalue(), err.getvalue()


def document(stdout: str) -> dict:
    """The evidence document the collector printed."""
    return json.loads(stdout)


# ---------------------------------------------------------------------------
# The published body fixtures (the exact shapes the renderer produces)
# ---------------------------------------------------------------------------


def _marker(
    head_sha: str = HEAD_SHA,
    base_sha: str = BASE_SHA,
    review_result: str = "clean",
    required_checks: str | None = "complete",
    extra: dict | None = None,
) -> str:
    payload: dict = {
        "version": 1,
        "head_sha": head_sha,
        "base_sha": base_sha,
        "review_result": review_result,
    }
    if required_checks is not None:
        payload["required_checks"] = required_checks
    if extra:
        payload.update(extra)
    return f"<!-- ai-pr-reviewer:{json.dumps(payload, separators=(',', ':'))} -->"


def _fingerprint(
    diff_fp: str = DIFF_FINGERPRINT, config_hash: str = CONFIG_FINGERPRINT
) -> str:
    """The sibling fingerprint marker the published body carries."""
    return f"<!-- ai-pr-review-fingerprint:{diff_fp}|cfg:{config_hash} -->"


def _section(head_line: str, reason: str | None = None, concerns=()) -> str:
    """The section exactly as ``renderIndependentConfidenceBlock`` writes it.

    The renderer pushes a BARE ``>`` separator line before every quoted line
    that follows the head (the reason and each concern bullet), and closes
    the section with a bare separator plus the UNQUOTED advisory note.
    """
    lines = ["## Independent Confidence", "", f"> {head_line}"]
    if reason is not None:
        lines.append(">")
        lines.append(f"> {reason}")
    for concern in concerns:
        lines.append(">")
        lines.append(f"> {concern}")
    lines.append(">")
    lines.append(ADVISORY_NOTE)
    return "\n".join(lines)


def _body(marker: str, section: str | None, fingerprint: str | None = None) -> str:
    parts = ["## Automated Review", "", marker, ""]
    if fingerprint is not None:
        parts.append(fingerprint)
        parts.append("")
    if section is not None:
        parts.append(section)
    parts.append(FOREIGN_SENTENCE)
    return "\n".join(parts)


def _scored_body(
    score: int = 4,
    reason: str = "the diff is small and the review covers the new branch",
    concerns=(
        "- Advisory concern (missed_issue, major) at src/a.ts:12 — the guard is never applied",
        "- Advisory concern (unsupported_finding, blocker) at src/b.ts:7 — the finding is not in the diff",
    ),
    marker: str | None = None,
    fingerprint: str | None = None,
) -> str:
    return _body(
        marker if marker is not None else _marker(),
        _section(
            f"**Independent confidence: {score}/5, risk: low** (model: verifier-model)",
            reason=reason,
            concerns=concerns,
        ),
        fingerprint if fingerprint is not None else _fingerprint(),
    )


def _scored_without_concerns_body() -> str:
    return _body(
        _marker(),
        _section(
            "**Independent confidence: 5/5, risk: low** (model: verifier-model)",
            reason="the review covers every changed line",
        ),
        _fingerprint(),
    )


def _unscored_body() -> str:
    return _body(
        _marker(extra={"confidence_status": "unscored"}),
        _section(
            "**Independent confidence: unscored — the verifier did not produce "
            "a usable result** (model: verifier-model)"
        ),
        _fingerprint(),
    )


# ---------------------------------------------------------------------------
# The in-process forge stub
# ---------------------------------------------------------------------------

_COMMENTS_RE = re.compile(
    r"^/repos/[^/]+/[^/]+/issues/(?P<number>[0-9]+)/comments$"
)
_REVIEWS_RE = re.compile(r"^/repos/[^/]+/[^/]+/pulls/(?P<number>[0-9]+)/reviews$")


class _DogfoodForge:
    """A forge stub for the two list endpoints the collector reads.

    Mirrors the style of the ``_PullRequestForge`` stub in
    ``tests/test_forge_cli.py``: it answers the pull request's issue
    comments and reviews with configurable payloads, can fail either
    endpoint per pull request, and records every request it saw (method,
    path, query, headers).

    It paginates like a real forge: a request for ``page`` answers that
    slice of the stored payload and pages past the end answer EMPTY, so a
    caller walking the list stops on the stub's own empty answer.
    ``page_cap`` models a forge that caps the page size below the
    requested ``per_page`` (Forgejo's ``MAX_RESPONSE_ITEMS``): every
    answer carries at most that many items however large the request
    asked (#1487).
    """

    def __init__(self) -> None:
        self.comments: dict[str, list[dict]] = {}
        self.reviews: dict[str, list[dict]] = {}
        self.fail_comments: set[str] = set()
        self.fail_reviews: set[str] = set()
        self.page_cap: int | None = None
        self.requests: list[dict] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "_DogfoodForge":
        forge = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:  # noqa: ANN001
                """Keep the stub quiet."""

            def _send(self, status: int, payload: object) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _page(self, items: list[dict], query: str) -> None:
                """Answer one page of ``items`` like a paginating forge."""
                params = dict(urllib.parse.parse_qsl(query))
                per_page = int(params.get("per_page") or "100")
                page = int(params.get("page") or "1")
                if forge.page_cap is not None:
                    per_page = min(per_page, forge.page_cap)
                start = (page - 1) * per_page
                self._send(200, items[start : start + per_page])

            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlsplit(self.path)
                forge.requests.append({
                    "method": "GET",
                    "path": parsed.path,
                    "query": parsed.query,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                })
                comments = _COMMENTS_RE.match(parsed.path)
                if comments is not None:
                    number = comments.group("number")
                    if number in forge.fail_comments:
                        self._send(500, {"message": "stub failure"})
                        return
                    self._page(forge.comments.get(number, []), parsed.query)
                    return
                reviews = _REVIEWS_RE.match(parsed.path)
                if reviews is not None:
                    number = reviews.group("number")
                    if number in forge.fail_reviews:
                        self._send(500, {"message": "stub failure"})
                        return
                    self._page(forge.reviews.get(number, []), parsed.query)
                    return
                self._send(404, {"message": "Not Found"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self._thread.start()
        return self

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("the stub server is not running")
        return f"http://127.0.0.1:{self._server.server_port}"

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


@pytest.fixture()
def forge(monkeypatch):
    server = _DogfoodForge().start()
    monkeypatch.setenv("GITHUB_API_URL", server.base_url)
    monkeypatch.setenv("GITHUB_TOKEN", SECRET)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    try:
        yield server
    finally:
        server.stop()


def _publish(
    forge: _DogfoodForge,
    number: int,
    body: str,
    *,
    as_review: bool = False,
    item_id: int = 1,
    created_at: str | None = None,
    updated_at: str | None = None,
    submitted_at: str | None = None,
) -> None:
    """Publish one reviewer body for a pull request.

    A native review is timed by ``submitted_at`` (the only timestamp a
    GitHub review object carries); a comment carries ``created_at`` and
    ``updated_at``.
    """
    entry: dict = {"id": item_id, "body": body, "user": {"login": "its-saffron[bot]"}}
    if created_at is not None:
        entry["created_at"] = created_at
    if updated_at is not None:
        entry["updated_at"] = updated_at
    if submitted_at is not None:
        entry["submitted_at"] = submitted_at
    target = forge.reviews if as_review else forge.comments
    target.setdefault(str(number), []).append(entry)


# ---------------------------------------------------------------------------
# The fixtures are the shape the renderer publishes
# ---------------------------------------------------------------------------


class TestPublishedShape:
    def test_the_section_fixture_carries_the_bare_separators(self, collector):
        section = _section("**Independent confidence: 4/5, risk: low**", reason="r")
        lines = section.split("\n")
        assert lines[2] == "> **Independent confidence: 4/5, risk: low**"
        assert lines[3] == ">"
        assert lines[4] == "> r"

    def test_the_closing_advisory_note_is_published_unquoted(self, collector):
        lines = _section("**Independent confidence: 4/5, risk: low**").split("\n")
        assert lines[-1] == ADVISORY_NOTE
        assert not lines[-1].startswith(">")

    def test_the_unscored_label_is_the_renderers_whole_sentence(self, collector):
        assert collector._UNSCORED_LABEL == (
            "unscored — the verifier did not produce a usable result"
        )
        assert collector._SCORED_LABEL == "scored"

    def test_the_evidence_separator_is_the_renderers_em_dash(self, collector):
        assert collector._EVIDENCE_SEPARATOR == " — "


# ---------------------------------------------------------------------------
# A scored run
# ---------------------------------------------------------------------------


class TestScoredRun:
    def test_records_the_published_pins_and_the_primary_verdict(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["pr_number"] == 7
        assert record["head_sha"] == HEAD_SHA
        assert record["base_sha"] == BASE_SHA
        assert record["review_result"] == "clean"
        assert record["required_checks"] == "complete"
        assert record["read_error"] is None

    def test_records_the_verifier_fields(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["status"] == "scored"
        assert verifier["score"] == 4
        assert verifier["risk"] == "low"
        assert verifier["reason"] == "the diff is small and the review covers the new branch"
        assert verifier["model"] == "verifier-model"

    def test_records_both_published_concerns(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        concerns = document(out)["records"][0]["verifier"]["concerns"]
        assert concerns == [
            {
                "type": "missed_issue",
                "severity": "major",
                "file": "src/a.ts",
                "line": 12,
                "evidence": "the guard is never applied",
            },
            {
                "type": "unsupported_finding",
                "severity": "blocker",
                "file": "src/b.ts",
                "line": 7,
                "evidence": "the finding is not in the diff",
            },
        ]

    def test_a_published_concern_materially_challenges_the_primary_review(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["materially_challenges_primary"] is True

    def test_a_scored_run_without_concerns_does_not_challenge_the_primary_review(self, collector, forge):
        _publish(forge, 7, _scored_without_concerns_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["status"] == "scored"
        assert verifier["score"] == 5
        assert verifier["concerns"] == []
        assert verifier["materially_challenges_primary"] is False

    def test_a_native_review_body_is_read_too(self, collector, forge):
        _publish(forge, 9, _scored_body(), as_review=True)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "9")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["status"] == "scored"
        assert record["head_sha"] == HEAD_SHA
        assert record["published_body"]["kind"] == "review"


class TestRealRenderedBody:
    """The published shape, read end to end.

    A collector that only passes against a fixture the action never
    publishes is not a collector: these tests use the exact rendering
    ``renderIndependentConfidenceBlock`` writes.
    """

    def test_the_published_reason_is_recorded(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert document(out)["records"][0]["verifier"]["reason"] == (
            "the diff is small and the review covers the new branch"
        )

    def test_the_published_concerns_are_recorded(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        concerns = document(out)["records"][0]["verifier"]["concerns"]
        assert [concern["file"] for concern in concerns] == ["src/a.ts", "src/b.ts"]
        assert [concern["line"] for concern in concerns] == [12, 7]
        assert [concern["type"] for concern in concerns] == [
            "missed_issue",
            "unsupported_finding",
        ]

    def test_the_closing_advisory_note_is_never_recorded(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert "Advisory only" not in json.dumps(record)
        assert "Advisory only" not in json.dumps(record["verifier"])

    def test_a_separator_never_becomes_the_reason(self, collector, forge):
        quoted = collector.extract_confidence_section(_scored_body())
        assert quoted[0].startswith("**Independent confidence:")
        assert quoted[1] == "the diff is small and the review covers the new branch"
        assert "" not in quoted

    def test_the_unscored_head_publishes_no_score_and_no_risk(self, collector, forge):
        _publish(forge, 11, _unscored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["status"] == "unscored"
        assert verifier["score"] is None
        assert verifier["risk"] == "unknown"

    def test_the_models_own_markdown_is_never_read_as_the_section(self, collector, forge):
        """The model markdown is published AFTER the action's sections."""
        body = "\n".join([
            "## Automated Review", "",
            _marker(), "",
            "## Independent Confidence", "",
            "> **Independent confidence: 4/5, risk: low** (model: verifier-model)",
            ">",
            "> the published reason",
            ">",
            "> - Advisory concern (missed_issue, major) at src/a.ts:12 — evidence",
            ">",
            ADVISORY_NOTE, "",
            "> a quoted line of the model's own review",
            "## Summary", "",
            "the model text",
        ])
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["reason"] == "the published reason"
        assert len(verifier["concerns"]) == 1


# ---------------------------------------------------------------------------
# The newest published body
# ---------------------------------------------------------------------------


class TestNewestPublishedBody:
    def test_the_newest_of_two_comments_wins(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=1,
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            item_id=2,
            updated_at="2026-02-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["score"] == 4
        assert record["published_body"]["id"] == 2

    def test_a_review_newer_than_a_comment_wins(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=1,
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=2,
            submitted_at="2026-03-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["score"] == 4
        assert record["published_body"]["kind"] == "review"
        assert record["published_body"]["id"] == 2

    def test_identical_timestamps_break_the_tie_on_the_higher_id(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=7,
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            item_id=9,
            updated_at="2026-01-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["score"] == 4
        assert record["published_body"]["id"] == 9

    def test_ids_are_never_compared_across_the_two_id_spaces(self, collector, forge):
        """A comment id and a review id are different sequences.

        On an exact timestamp tie the kind decides, before any id
        comparison: the native review is the per-run publication.
        """
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=900,
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=3,
            submitted_at="2026-01-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["published_body"]["kind"] == "review"
        assert record["verifier"]["score"] == 4

    def test_the_record_names_the_body_it_read(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(),
            item_id=42,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-02T03:04:05Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        published = document(out)["records"][0]["published_body"]
        assert published == {
            "kind": "comment",
            "id": 42,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T03:04:05Z",
            "submitted_at": None,
        }

    def test_a_review_is_timed_by_the_real_review_payload(self, collector, forge):
        """The review fixture is the exact shape GitHub's review list returns.

        A real review object carries ``submitted_at`` and NO ``updated_at``
        and NO ``created_at``; the collector must select the review on that
        timestamp alone and report it in the descriptor.
        """
        review = {
            "id": 3171,
            "node_id": "MDE3OlB1bGxSZXF1ZXN0UmV2aWV3MzE3MQ==",
            "user": {"login": "its-saffron[bot]", "id": 1, "type": "Bot"},
            "body": _scored_body(score=5),
            "commit_id": HEAD_SHA,
            "state": "CHANGES_REQUESTED",
            "html_url": "https://example.invalid/o/r/pull/7#pullrequestreview-3171",
            "pull_request_url": "https://example.invalid/repos/o/r/pulls/7",
            "author_association": "CONTRIBUTOR",
            "_links": {
                "html": {
                    "href": "https://example.invalid/o/r/pull/7#pullrequestreview-3171"
                },
                "pull_request": {"href": "https://example.invalid/repos/o/r/pulls/7"},
            },
            "submitted_at": "2026-03-04T05:06:07Z",
        }
        forge.reviews.setdefault("7", []).append(review)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert "updated_at" not in review and "created_at" not in review
        assert record["published_body"] == {
            "kind": "review",
            "id": 3171,
            "created_at": None,
            "updated_at": None,
            "submitted_at": "2026-03-04T05:06:07Z",
        }
        assert record["verifier"]["score"] == 5

    def test_a_comment_timestamp_never_times_a_review(self, collector, forge):
        """The old fixture shape -- ``updated_at`` on a review -- times nothing.

        GitHub review objects carry no ``updated_at``, so a review without
        ``submitted_at`` has no provable time and must never outrank a
        comment that has one, no matter what id it carries.
        """
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=1,
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=5),
            as_review=True,
            item_id=900,
            updated_at="2026-06-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["published_body"]["kind"] == "comment"
        assert record["verifier"]["score"] == 2

    def test_the_oldest_body_is_never_the_one_read(self, collector, forge):
        """Native reviews accumulate, so the first one is the oldest run."""
        _publish(
            forge,
            7,
            _scored_body(score=1),
            as_review=True,
            item_id=1,
            submitted_at="2025-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=5),
            as_review=True,
            item_id=2,
            submitted_at="2026-05-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert document(out)["records"][0]["verifier"]["score"] == 5


# ---------------------------------------------------------------------------
# The published fingerprint
# ---------------------------------------------------------------------------


class TestPublishedFingerprint:
    def test_the_diff_and_config_fingerprints_are_collected(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["diff_fingerprint"] == DIFF_FINGERPRINT
        assert record["config_fingerprint"] == CONFIG_FINGERPRINT

    def test_the_fingerprint_is_never_listed_as_unavailable(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        unavailable = document(out)["records"][0]["unavailable"]
        assert "config_fingerprint" not in unavailable
        assert "diff_fingerprint" not in unavailable
        assert "published_fingerprint" not in unavailable

    def test_a_body_without_the_marker_publishes_no_fingerprint(self, collector, forge):
        _publish(forge, 7, _body(_marker(), None, fingerprint=None))
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["diff_fingerprint"] is None
        assert record["config_fingerprint"] is None
        assert record["unavailable"]["published_fingerprint"]

    def test_an_empty_diff_publishes_the_placeholder_fingerprint(self, collector, forge):
        body = _scored_body(fingerprint=_fingerprint(diff_fp="empty-diff"))
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["diff_fingerprint"] == "empty-diff"
        assert record["config_fingerprint"] == CONFIG_FINGERPRINT

    def test_only_the_first_fingerprint_marker_is_read(self, collector, forge):
        body = _body(
            _marker(),
            None,
            fingerprint=f"{_fingerprint()}\n{_fingerprint(diff_fp='e' * 64)}",
        )
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert document(out)["records"][0]["diff_fingerprint"] == DIFF_FINGERPRINT


# ---------------------------------------------------------------------------
# The escaping the publisher applies
# ---------------------------------------------------------------------------


class TestPublishedEscaping:
    def test_the_reason_is_recorded_unescaped(self, collector, forge):
        _publish(forge, 7, _scored_body(reason="the guard at a\\|b uses x &lt; y"))
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert document(out)["records"][0]["verifier"]["reason"] == (
            "the guard at a|b uses x < y"
        )

    def test_a_literal_entity_is_not_decoded_twice(self, collector):
        """The renderer encodes ``&`` first of the entity group.

        A model value that literally reads ``&lt;`` is published as
        ``&amp;lt;`` and must be recovered as ``&lt;`` -- not as ``<``.
        """
        assert collector.unescape_table_cell("a &amp;lt; b") == "a &lt; b"
        assert collector.unescape_table_cell("a &amp;amp; b") == "a &amp; b"
        assert collector.unescape_table_cell("a &lt; b") == "a < b"

    def test_the_published_reason_keeps_a_literal_entity(self, collector, forge):
        _publish(forge, 7, _scored_body(reason="a &amp;lt; b"))
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert document(out)["records"][0]["verifier"]["reason"] == "a &lt; b"

    def test_the_concern_fields_are_recorded_unescaped(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(
                concerns=(
                    "- Advisory concern (missed_issue, major) at src/a\\|b.ts:12 "
                    "— the guard \\`is\\` never applied",
                )
            ),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        concern = document(out)["records"][0]["verifier"]["concerns"][0]
        assert concern["file"] == "src/a|b.ts"
        assert concern["evidence"] == "the guard `is` never applied"


# ---------------------------------------------------------------------------
# An unscored run
# ---------------------------------------------------------------------------


class TestUnscoredRun:
    def test_records_the_unscored_status_and_no_challenge(self, collector, forge):
        _publish(forge, 11, _unscored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["status"] == "unscored"
        assert verifier["score"] is None
        assert verifier["concerns"] == []
        assert verifier["materially_challenges_primary"] is None

    def test_the_unavailable_block_names_every_missing_evidence(self, collector, forge):
        _publish(forge, 11, _unscored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        unavailable = document(out)["records"][0]["unavailable"]
        for field in (
            "unscored_cause",
            "latency_ms",
            "token_usage",
            "rubric_version",
            "deterministic_caps",
            "parser_notes",
            "later_review_linkage",
        ):
            assert unavailable[field].strip(), f"{field} must name where it lives"


class TestPublishedTelemetry:
    """The verifier telemetry the marker publishes (#1455).

    The publisher appends ``confidence_cause``, ``confidence_latency_ms``
    and the three ``confidence_*_tokens`` keys to the marker when the run
    measured them; the collector records each valid published value and
    removes the corresponding unavailable reason only then, so a body
    published by an older action keeps the old unavailable behavior and a
    published value is never called unavailable.
    """

    def _unscored_telemetry_body(self, **telemetry) -> str:
        extra = {"confidence_status": "unscored"}
        extra.update(telemetry)
        return _body(
            _marker(extra=extra),
            _section(
                "**Independent confidence: unscored — the verifier did not "
                "produce a usable result** (model: verifier-model)"
            ),
            _fingerprint(),
        )

    def test_the_full_telemetry_set_is_recorded(self, collector, forge):
        _publish(
            forge,
            11,
            self._unscored_telemetry_body(
                confidence_cause="timeout",
                confidence_latency_ms=8123,
                confidence_prompt_tokens=1200,
                confidence_completion_tokens=340,
                confidence_total_tokens=1540,
            ),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        verifier = record["verifier"]
        assert verifier["status"] == "unscored"
        assert verifier["cause"] == "timeout"
        assert verifier["latency_ms"] == 8123
        assert verifier["token_usage"] == {
            "prompt_tokens": 1200,
            "completion_tokens": 340,
            "total_tokens": 1540,
        }
        for field in ("unscored_cause", "latency_ms", "token_usage"):
            assert field not in record["unavailable"]

    def test_an_older_body_keeps_the_old_unavailable_behavior(self, collector, forge):
        _publish(forge, 11, _unscored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["cause"] is None
        assert record["verifier"]["latency_ms"] is None
        assert record["verifier"]["token_usage"] is None
        for field in ("unscored_cause", "latency_ms", "token_usage"):
            assert record["unavailable"][field].strip()

    def test_a_scored_run_is_never_read_as_carrying_a_cause(self, collector, forge):
        body = _scored_body(
            marker=_marker(
                extra={
                    "confidence_status": "scored",
                    "confidence_score": 4,
                    "confidence_cause": "timeout",
                }
            )
        )
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["status"] == "scored"
        assert record["verifier"]["cause"] is None
        assert "unscored_cause" in record["unavailable"]

    def test_a_cause_outside_the_token_vocabulary_is_never_recorded(self, collector, forge):
        _publish(
            forge,
            11,
            self._unscored_telemetry_body(confidence_cause="gateway said 429"),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["cause"] is None
        assert "unscored_cause" in record["unavailable"]

    @pytest.mark.parametrize("latency", ["soon", -5, True])
    def test_a_latency_that_is_not_a_non_negative_integer_is_never_recorded(
        self, collector, forge, latency
    ):
        _publish(
            forge,
            11,
            self._unscored_telemetry_body(confidence_latency_ms=latency),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["latency_ms"] is None
        assert "latency_ms" in record["unavailable"]

    def test_partial_token_usage_records_only_the_published_counts(self, collector, forge):
        _publish(
            forge,
            11,
            self._unscored_telemetry_body(
                confidence_prompt_tokens=1200,
                confidence_completion_tokens="many",
                confidence_total_tokens=1540,
            ),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["token_usage"] == {
            "prompt_tokens": 1200,
            "total_tokens": 1540,
        }
        assert "token_usage" not in record["unavailable"]

    def test_a_negative_token_count_is_never_recorded(self, collector, forge):
        _publish(
            forge,
            11,
            self._unscored_telemetry_body(confidence_prompt_tokens=-1),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["token_usage"] is None
        assert "token_usage" in record["unavailable"]

    def test_the_telemetry_is_also_read_from_a_marker_only_body(self, collector, forge):
        """A body with no confidence section still publishes the telemetry."""
        body = _body(
            _marker(
                extra={
                    "confidence_status": "unscored",
                    "confidence_cause": "http_403",
                    "confidence_latency_ms": 99,
                }
            ),
            None,
            _fingerprint(),
        )
        _publish(forge, 11, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["status"] == "unscored"
        assert record["verifier"]["cause"] == "http_403"
        assert record["verifier"]["latency_ms"] == 99
        assert "unscored_cause" not in record["unavailable"]
        assert "latency_ms" not in record["unavailable"]


class TestUnavailableReasonsAreTrue:
    """Every reason must name a home that really holds the value.

    An adjudication artifact whose explanations are wrong is worse than
    none, so each claim is pinned to the code that backs it.
    """

    def _reasons(self, collector, forge) -> dict:
        _publish(forge, 11, _unscored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "11")
        assert code == 0, err
        return document(out)["records"][0]["unavailable"]

    def test_the_unscored_cause_names_the_run_directory_artifact(self, collector, forge):
        reason = self._reasons(collector, forge)["unscored_cause"]
        assert "confidence-score.json" in reason
        assert "marker" in reason

    def test_the_latency_reason_admits_no_latency_is_measured(self, collector, forge):
        reason = self._reasons(collector, forge)["latency_ms"].lower()
        assert "no verifier latency is measured" in reason
        assert "confidence-request.json" not in reason
        assert "confidence-response.json" not in reason

    def test_the_token_usage_reason_names_the_transport_and_the_scorer(self, collector, forge):
        reason = self._reasons(collector, forge)["token_usage"]
        assert "transport" in reason
        assert "scorer" in reason
        assert "confidence-response.json" in reason

    def test_the_rubric_version_names_the_run_directory_artifact(self, collector, forge):
        reason = self._reasons(collector, forge)["rubric_version"]
        assert "confidence-score.json" in reason
        assert "never published" not in reason.split(";")[0]

    def test_the_later_review_linkage_names_the_finding_outcome_ledger(self, collector, forge):
        reason = self._reasons(collector, forge)["later_review_linkage"]
        assert "finding-outcomes.json" in reason

    def test_no_reason_names_a_home_that_does_not_exist(self, collector, forge):
        """Every artifact a reason names is a real run-directory artifact."""
        real = (
            "confidence-score.json",
            "confidence-request.json",
            "confidence-response.json",
            "finding-outcomes.json",
        )
        for name, reason in self._reasons(collector, forge).items():
            for mentioned in re.findall(r"[A-Za-z0-9._-]+\.json", reason):
                assert mentioned in real, f"{name} names {mentioned}, which is not real"


# ---------------------------------------------------------------------------
# Nothing published, and nothing readable
# ---------------------------------------------------------------------------


class TestMissingEvidence:
    def test_a_pull_request_without_a_published_body_records_no_published_evidence(self, collector, forge):
        _publish(forge, 3, "a human left a comment without the reviewer marker")
        code, out, err = run(collector, "--repo", "o/r", "--pr", "3")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["head_sha"] is None
        assert record["review_result"] is None
        assert record["verifier"]["status"] == "unknown"
        assert record["verifier"]["materially_challenges_primary"] is None
        assert record["read_error"] is None
        assert record["published_body"] is None
        assert "published_record" in record["unavailable"]

    def test_a_published_body_without_the_section_records_no_verifier_evidence(self, collector, forge):
        _publish(forge, 4, _body(_marker(), None))
        code, out, err = run(collector, "--repo", "o/r", "--pr", "4")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["head_sha"] == HEAD_SHA
        assert record["verifier"]["status"] == "disabled"
        assert "published_verifier_section" in record["unavailable"]

    def test_an_unreadable_pull_request_records_the_read_error(self, collector, forge):
        _publish(forge, 5, _scored_body())
        forge.fail_comments.add("5")
        code, out, err = run(collector, "--repo", "o/r", "--pr", "5")
        assert code == 1
        record = document(out)["records"][0]
        assert record["read_error"]
        assert SECRET not in record["read_error"]
        assert record["verifier"]["status"] == "unknown"

    def test_an_unreadable_pull_request_does_not_abort_the_run(self, collector, forge):
        _publish(forge, 5, _scored_body())
        _publish(forge, 6, _scored_body())
        forge.fail_comments.add("5")
        code, out, err = run(collector, "--repo", "o/r", "--pr", "5", "--pr", "6")
        assert code == 1
        records = document(out)["records"]
        assert [record["pr_number"] for record in records] == [5, 6]
        assert records[0]["read_error"]
        assert records[1]["read_error"] is None
        assert records[1]["verifier"]["status"] == "scored"


# ---------------------------------------------------------------------------
# Bounded and redacted by construction
# ---------------------------------------------------------------------------


class TestBoundedAndRedacted:
    def test_the_bearer_token_never_reaches_the_evidence_file(self, collector, forge):
        body = _scored_body(
            reason=f"the model echoed {SECRET} in its answer",
            concerns=(
                "- Advisory concern (missed_issue, major) at src/a.ts:12 — "
                f"the diff shows https://user:{SECRET}@forge.invalid/x",
            ),
        )
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert SECRET not in out
        record = document(out)["records"][0]
        assert SECRET not in json.dumps(record)
        assert record["verifier"]["reason"] == "[REDACTED]"
        assert SECRET not in record["verifier"]["concerns"][0]["evidence"]
        assert "***@forge.invalid" in record["verifier"]["concerns"][0]["evidence"]

    def test_the_bearer_token_never_reaches_the_evidence_file_on_disk(self, collector, forge, tmp_path):
        body = _scored_body(reason=f"the model echoed {SECRET} in its answer")
        _publish(forge, 7, body)
        out_file = tmp_path / "evidence.json"
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--out", str(out_file)
        )
        assert code == 0, err
        assert SECRET not in out_file.read_text(encoding="utf-8")

    def test_long_fields_are_capped(self, collector, forge):
        body = _scored_body(
            reason="r" * 500,
            concerns=(
                f"- Advisory concern (missed_issue, major) at {'f' * 400}:12 — {'e' * 500}",
            ),
        )
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert len(verifier["reason"]) == 300
        concern = verifier["concerns"][0]
        assert len(concern["file"]) == 200
        assert len(concern["evidence"]) == 300

    def test_a_long_model_name_is_capped(self, collector, forge):
        body = _body(
            _marker(),
            _section(
                "**Independent confidence: 4/5, risk: low** "
                f"(model: {'m' * 400})"
            ),
            _fingerprint(),
        )
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert len(document(out)["records"][0]["verifier"]["model"]) == 120

    def test_the_evidence_file_carries_no_whole_comment_body(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert FOREIGN_SENTENCE not in out
        assert "## Automated Review" not in out
        assert "ai-pr-reviewer:" not in out

    def test_the_document_is_deterministic_except_for_the_generated_at(self, collector, forge):
        _publish(forge, 7, _scored_body())
        first = document(run(collector, "--repo", "o/r", "--pr", "7")[1])
        second = document(run(collector, "--repo", "o/r", "--pr", "7")[1])
        assert first["generated_at"] and second["generated_at"]
        first.pop("generated_at")
        second.pop("generated_at")
        assert first == second

    def test_the_document_carries_the_published_shape(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        payload = document(out)
        assert payload["schema"] == "verifier-dogfood-evidence/v1"
        assert payload["repository"] == "o/r"
        assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", payload["generated_at"])
        record = payload["records"][0]
        assert set(record) == {
            "pr_number",
            "head_sha",
            "base_sha",
            "review_result",
            "required_checks",
            "diff_fingerprint",
            "config_fingerprint",
            "verifier",
            "published_body",
            "unavailable",
            "read_error",
        }
        assert set(record["verifier"]) == {
            "status",
            "score",
            "risk",
            "reason",
            "model",
            "concerns",
            "materially_challenges_primary",
            "cause",
            "latency_ms",
            "token_usage",
        }
        assert set(record["published_body"]) == {
            "kind",
            "id",
            "created_at",
            "updated_at",
            "submitted_at",
        }


# ---------------------------------------------------------------------------
# Input validation and the forge seam
# ---------------------------------------------------------------------------


class TestInputValidation:
    @pytest.mark.parametrize(
        "args",
        [
            ("--repo", "o/r/extra", "--pr", "7"),
            ("--repo", "no-slash", "--pr", "7"),
            ("--repo", "./r", "--pr", "7"),
            ("--repo", "../r", "--pr", "7"),
            ("--repo", "o/.", "--pr", "7"),
            ("--repo", "o/..", "--pr", "7"),
            ("--repo", "o/r", "--pr", "0"),
            ("--repo", "o/r", "--pr", "-1"),
            ("--repo", "o/r", "--pr", "abc"),
            ("--repo", "o/r", "--pr", "7\n"),
            ("--repo", "o/r", "--pr", "9" * 21),
            ("--repo", "o/r"),
        ],
    )
    def test_malformed_input_is_rejected_without_a_request(self, collector, forge, args):
        code, out, err = run(collector, *args)
        assert code == 2
        assert forge.requests == [], "no request may go out for a rejected input"
        assert SECRET not in err
        assert SECRET not in out

    def test_the_token_is_never_echoed_by_a_rejected_input(self, collector, forge):
        code, out, err = run(collector, "--repo", "o/r", "--pr", SECRET)
        assert code == 2
        assert SECRET not in out
        assert SECRET not in err


class TestForgeSeam:
    def test_the_collector_reads_only_the_two_documented_endpoints(self, collector, forge):
        _publish(forge, 7, _scored_body())
        run(collector, "--repo", "o/r", "--pr", "7")
        # A list walk re-reads the same path for later pages and asks one
        # page past the end, which the forge answers empty (#1487): the
        # invariant is that NO endpoint other than the two documented
        # list endpoints is ever touched.
        assert {
            (request["method"], request["path"]) for request in forge.requests
        } == {
            ("GET", "/repos/o/r/issues/7/comments"),
            ("GET", "/repos/o/r/pulls/7/reviews"),
        }

    def test_the_token_rides_only_the_authorization_header(self, collector, forge):
        _publish(forge, 7, _scored_body())
        run(collector, "--repo", "o/r", "--pr", "7")
        for request in forge.requests:
            assert request["headers"].get("authorization") == f"Bearer {SECRET}"
            assert SECRET not in request["path"]
            assert SECRET not in request["query"]

    def test_the_module_uses_no_subprocess_and_no_raw_http_client(self):
        source = SCRIPT_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name.split(".")[0])
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imported.add(node.module.split(".")[0])
        assert "subprocess" not in imported
        assert "urllib" not in imported, (
            "the collector must not hand-roll an HTTP request; the configured "
            "forge capability is the only transport"
        )
        assert "pr_reviewer.forge" in source

    def test_a_page_size_cap_does_not_hide_the_newest_publication(
        self, collector, forge
    ):
        """The #1487 collector case: a forge that caps every answer below
        the requested ``per_page`` must not leave the collector naming an
        older published body as the newest one."""
        forge.page_cap = 1
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=1,
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            item_id=2,
            updated_at="2026-02-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        # The capped first page alone would have shown only the older
        # body; the walk keeps reading until the stub's empty page.
        assert record["verifier"]["score"] == 4
        assert record["published_body"]["id"] == 2
