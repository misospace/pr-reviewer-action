"""Unit tests for ``scripts/confidence_dogfood_dataset.py`` (#1479).

The dataset collector keeps EVERY published verifier attempt per pull
request -- not only the newest one -- so a reader can see the whole history
of what the verifier published instead of its last word. These tests pin the
properties that history depends on:

- two distinct publications on one pull request are TWO records, and a
  third, later one does not disturb the two that came before;
- the collection is incremental and idempotent: a repeated run over
  unchanged input adds nothing, grows the observation counter and keeps
  every earlier attempt, scored and unscored alike;
- a body that was edited IN PLACE stays ONE record (an edit is not a new
  attempt), while a body republished on a NEW head is a second attempt (the
  run pins are part of the key);
- the ordering of the records is deterministic, a body with no provable
  timestamp sorts oldest, and a native review is timed by its
  ``submitted_at`` and never by a comment's timestamps;
- the collected values are bounded and redacted by construction: the bearer
  token never reaches the dataset, a URL with userinfo is masked, and no
  published body is ever copied into it;
- an OLD published body and a NEW one are both read as what they are: the
  old one published no verifier telemetry at all, the new one published the
  whole set;
- the historical baseline imports into the same shape, the import
  reconciles against the baseline's own declared counts, and a baseline run
  without a usable pull request number is counted rather than dropped;
- the bounds are real: the per-pull-request, per-collection and page bounds
  are respected, and a dataset that would exceed the record bound fails
  closed instead of dropping evidence;
- a dataset file of another schema is refused, never reinterpreted;
- the forge is reached only through the configured forge capability, and the
  bearer token rides only the ``Authorization`` header.

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
SCRIPT_PATH = ROOT / "scripts" / "confidence_dogfood_dataset.py"
SECRET = "token-that-must-never-leak"

HEAD_SHA = "a" * 40
BASE_SHA = "b" * 40
DIFF_FINGERPRINT = "d" * 64
CONFIG_FINGERPRINT = "c" * 64

# A sentence that belongs to the published review body and to nothing the
# collector extracts: it must never reach the dataset.
FOREIGN_SENTENCE = "SUMMARY the whole review body text that must not be copied"


def _load_collector():
    """Import ``scripts/confidence_dogfood_dataset.py`` as a module."""
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "confidence_dogfood_dataset_under_test", SCRIPT_PATH
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
    """The dataset document the collector printed."""
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
    """The section exactly as ``renderIndependentConfidenceBlock`` writes it."""
    lines = ["## Independent Confidence", "", f"> {head_line}"]
    if reason is not None:
        lines.append(">")
        lines.append(f"> {reason}")
    for concern in concerns:
        lines.append(">")
        lines.append(f"> {concern}")
    lines.append(">")
    lines.append(
        "_Advisory only: this independent merge-safety verifier audits the "
        "completed review against the pull-request diff._"
    )
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
    marker: str | None = None,
    fingerprint: str | None = None,
    head_sha: str = HEAD_SHA,
) -> str:
    return _body(
        marker if marker is not None else _marker(head_sha=head_sha),
        _section(
            f"**Independent confidence: {score}/5, risk: low** (model: verifier-model)",
            reason=reason,
        ),
        fingerprint if fingerprint is not None else _fingerprint(),
    )


def _unscored_body(
    marker: str | None = None,
    fingerprint: str | None = None,
    head_sha: str = HEAD_SHA,
) -> str:
    return _body(
        marker if marker is not None else _marker(head_sha=head_sha),
        _section(
            "**Independent confidence: unscored — the verifier did not produce "
            "a usable result** (model: verifier-model)"
        ),
        fingerprint if fingerprint is not None else _fingerprint(),
    )


def _telemetry_body(**telemetry) -> str:
    """A body whose marker publishes the verifier telemetry (#1455)."""
    extra = {"confidence_status": "unscored"}
    extra.update(telemetry)
    return _body(
        _marker(extra=extra),
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
_PULLS_RE = re.compile(r"^/repos/[^/]+/[^/]+/pulls$")


class _DatasetForge:
    """A forge stub for the three list endpoints the collector reads.

    It answers a pull request's issue comments, its reviews and the
    repository's pull request list, can fail either per-pull-request
    endpoint, and records every request it saw (method, path, query,
    headers). The list endpoints page, so a caller can be observed walking
    from one page to the next.
    """

    def __init__(self) -> None:
        self.comments: dict[str, list[dict]] = {}
        self.reviews: dict[str, list[dict]] = {}
        self.pulls: list[dict] = []
        self.fail_comments: set[str] = set()
        self.fail_reviews: set[str] = set()
        self.requests: list[dict] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> "_DatasetForge":
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

            def _page(self, items: list) -> list:
                query = urllib.parse.parse_qs(parsed.query)
                per_page = int(query.get("per_page", ["100"])[0])
                page = int(query.get("page", ["1"])[0])
                start = (page - 1) * per_page
                return items[start : start + per_page]

            def do_GET(self) -> None:  # noqa: N802
                global parsed
                parsed = urllib.parse.urlsplit(self.path)
                forge.requests.append(
                    {
                        "method": "GET",
                        "path": parsed.path,
                        "query": parsed.query,
                        "headers": {k.lower(): v for k, v in self.headers.items()},
                    }
                )
                comments = _COMMENTS_RE.match(parsed.path)
                if comments is not None:
                    number = comments.group("number")
                    if number in forge.fail_comments:
                        self._send(500, {"message": "stub failure"})
                        return
                    self._send(200, self._page(forge.comments.get(number, [])))
                    return
                reviews = _REVIEWS_RE.match(parsed.path)
                if reviews is not None:
                    number = reviews.group("number")
                    if number in forge.fail_reviews:
                        self._send(500, {"message": "stub failure"})
                        return
                    self._send(200, self._page(forge.reviews.get(number, [])))
                    return
                pulls = _PULLS_RE.match(parsed.path)
                if pulls is not None:
                    self._send(200, self._page(forge.pulls))
                    return
                self._send(404, {"message": "Not Found"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.02},
            daemon=True,
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
    server = _DatasetForge().start()
    monkeypatch.setenv("GITHUB_API_URL", server.base_url)
    monkeypatch.setenv("GITHUB_TOKEN", SECRET)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    try:
        yield server
    finally:
        server.stop()


def _publish(
    forge: _DatasetForge,
    number: int,
    body: str,
    *,
    as_review: bool = False,
    item_id: int = 1,
    created_at: str | None = None,
    updated_at: str | None = None,
    submitted_at: str | None = None,
    state: str | None = None,
) -> None:
    """Publish one reviewer body for a pull request.

    A native review is timed by ``submitted_at`` (the only timestamp a real
    review object carries); a comment carries ``created_at`` and
    ``updated_at``.
    """
    entry: dict = {"id": item_id, "body": body, "user": {"login": "its-saffron[bot]"}}
    if created_at is not None:
        entry["created_at"] = created_at
    if updated_at is not None:
        entry["updated_at"] = updated_at
    if submitted_at is not None:
        entry["submitted_at"] = submitted_at
    if state is not None:
        entry["state"] = state
    target = forge.reviews if as_review else forge.comments
    target.setdefault(str(number), []).append(entry)


# ---------------------------------------------------------------------------
# Every published attempt is retained
# ---------------------------------------------------------------------------


class TestEveryAttemptIsRetained:
    def test_two_native_reviews_on_one_pull_request_are_two_records(
        self, collector, forge
    ):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        records = document(out)["records"]
        assert len(records) == 2
        assert {record["attempt"]["id"] for record in records} == {11, 12}
        assert {record["verifier"]["score"] for record in records} == {2, 4}

    def test_a_third_later_review_keeps_the_two_earlier_ones(
        self, collector, forge, tmp_path
    ):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        first = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(first["records"]) == 2

        _publish(
            forge,
            7,
            _scored_body(score=5),
            as_review=True,
            item_id=13,
            submitted_at="2026-03-01T00:00:00Z",
        )
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        second = json.loads(dataset.read_text(encoding="utf-8"))
        records = second["records"]
        assert len(records) == 3
        earlier = [
            record for record in records if record["attempt"]["id"] in (11, 12)
        ]
        assert {record["verifier"]["score"] for record in earlier} == {2, 4}
        assert {record["attempt"]["body_digest"] for record in earlier} == {
            record["attempt"]["body_digest"]
            for record in first["records"]
            if record["attempt"]["id"] in (11, 12)
        }, "the two earlier attempts are retained unchanged"

    def test_a_comment_and_a_review_are_two_attempts(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=1,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=2,
            submitted_at="2026-02-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        records = document(out)["records"]
        assert len(records) == 2
        assert {record["attempt"]["kind"] for record in records} == {"comment", "review"}

    def test_a_body_without_the_marker_is_not_an_attempt(self, collector, forge):
        _publish(forge, 7, "a human left a comment without the reviewer marker")
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert document(out)["records"] == []


# ---------------------------------------------------------------------------
# The collection is incremental and idempotent
# ---------------------------------------------------------------------------


class TestIncrementalAndIdempotent:
    def _publish_pair(self, forge: _DatasetForge) -> None:
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _unscored_body(),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )

    def test_a_repeated_run_adds_nothing(self, collector, forge, tmp_path):
        self._publish_pair(forge)
        dataset = tmp_path / "dataset.json"
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        first = json.loads(dataset.read_text(encoding="utf-8"))

        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        second = json.loads(dataset.read_text(encoding="utf-8"))

        assert len(second["records"]) == 2
        identities = [record["identity"] for record in second["records"]]
        assert len(set(identities)) == 2
        collection = second["collections"][-1]
        assert collection["records_added"] == 0
        assert collection["records_updated"] == 2
        assert collection["records_seen"] == 2
        assert first["records"][0]["identity"] == second["records"][0]["identity"]

    def test_a_repeated_run_grows_the_observation_counter(
        self, collector, forge, tmp_path
    ):
        self._publish_pair(forge)
        dataset = tmp_path / "dataset.json"
        for _ in range(3):
            code, _out, err = run(
                collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
            )
            assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert all(
            record["attempt"]["observations"] == 3 for record in payload["records"]
        )

    def test_a_repeated_run_keeps_the_scored_and_the_unscored_attempt(
        self, collector, forge, tmp_path
    ):
        self._publish_pair(forge)
        dataset = tmp_path / "dataset.json"
        for _ in range(2):
            run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        statuses = sorted(record["verifier"]["status"] for record in payload["records"])
        assert statuses == ["scored", "unscored"]

    def test_an_attempt_that_is_no_longer_observed_is_kept_and_marked_absent(
        self, collector, forge, tmp_path
    ):
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        forge.reviews["7"] = []
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["records"]) == 1
        assert payload["records"][0]["attempt"]["absent_in_latest_collection"] is True
        assert payload["collections"][-1]["records_absent"] == 1

    def test_a_pull_request_the_collection_did_not_read_is_never_marked_absent(
        self, collector, forge, tmp_path
    ):
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            8,
            _scored_body(score=3),
            as_review=True,
            item_id=12,
            submitted_at="2026-01-02T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--pr",
            "8",
            "--dataset",
            str(dataset),
        )
        # The second collection reads pull request 7 only. Pull request 8's
        # attempt was not looked for, so the run says nothing about it.
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["records"]) == 2
        by_pr = {record["pr_number"]: record for record in payload["records"]}
        assert by_pr[8]["attempt"]["absent_in_latest_collection"] is False
        assert payload["collections"][-1]["records_absent"] == 0

    def test_an_unreadable_pull_request_never_marks_its_attempts_absent(
        self, collector, forge, tmp_path
    ):
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        forge.fail_reviews.add("7")
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 1, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["records"]) == 1
        assert payload["records"][0]["attempt"]["absent_in_latest_collection"] is False
        assert payload["collections"][-1]["records_absent"] == 0

    def test_the_collection_log_grows_and_is_capped(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        for _ in range(55):
            run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["collections"]) == 50
        assert payload["collections"][-1]["mode"] == "forge-read"


# ---------------------------------------------------------------------------
# An edited body is not a fresh attempt
# ---------------------------------------------------------------------------


class TestEditedBodies:
    def test_a_comment_edited_in_place_stays_one_record(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=7,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        forge.comments["7"] = [
            {
                "id": 7,
                "body": _scored_body(score=5),
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-02-01T00:00:00Z",
            }
        ]
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        records = payload["records"]
        assert len(records) == 1
        assert records[0]["attempt"]["edited"] is True
        assert records[0]["attempt"]["observations"] == 2
        assert records[0]["verifier"]["score"] == 5

    def test_a_comment_rewritten_on_a_new_head_is_a_second_attempt(
        self, collector, forge, tmp_path
    ):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=7,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        forge.comments["7"] = [
            {
                "id": 7,
                "body": _scored_body(score=5, head_sha="e" * 40),
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-02-01T00:00:00Z",
            }
        ]
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["records"]) == 2

    def test_an_unchanged_comment_is_known_unchanged(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=7,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert payload["records"][0]["attempt"]["edited"] is False


# ---------------------------------------------------------------------------
# Ordering
# ---------------------------------------------------------------------------


class TestOrdering:
    def test_the_records_are_written_in_a_deterministic_order(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=11,
            submitted_at="2026-03-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=3),
            item_id=12,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=13,
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        records = document(out)["records"]
        assert [record["verifier"]["score"] for record in records] == [4, 3, 2]

    def test_a_body_without_a_usable_timestamp_sorts_oldest(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=11,
            submitted_at="2026-03-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=3),
            as_review=True,
            item_id=12,
            submitted_at="not-a-timestamp",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        records = document(out)["records"]
        assert [record["verifier"]["score"] for record in records] == [3, 2]
        assert records[0]["attempt"]["published_at"] is None

    def test_a_review_is_timed_by_its_submitted_at_only(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
            updated_at="2026-09-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["attempt"]["published_at"] == "2026-01-01T00:00:00Z"

    def test_a_comment_is_timed_by_its_created_at_only(self, collector, forge):
        _publish(
            forge,
            7,
            _scored_body(score=2),
            item_id=11,
            created_at="2026-01-01T00:00:00Z",
            updated_at="2026-09-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["attempt"]["published_at"] == "2026-01-01T00:00:00Z"

    def test_the_pull_requests_are_ordered_before_the_instant(self, collector, forge):
        _publish(
            forge,
            9,
            _scored_body(score=2),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=3),
            as_review=True,
            item_id=12,
            submitted_at="2026-05-01T00:00:00Z",
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "9", "--pr", "7")
        assert code == 0, err
        records = document(out)["records"]
        assert [record["pr_number"] for record in records] == [7, 9]


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


class TestPagination:
    def _fill(self, forge: _DatasetForge, count: int, offset: int = 0) -> None:
        for index in range(count):
            # Every comment carries its own publication instant: two
            # publications inside one second are still two attempts, but two
            # comments that share an instant AND a head are ONE attempt.
            minute = offset + index
            _publish(
                forge,
                7,
                _scored_body(score=1),
                item_id=1000 + offset + index,
                created_at=f"2026-01-01T00:{minute // 60:02d}:{minute % 60:02d}Z",
                updated_at=f"2026-01-01T00:{minute // 60:02d}:{minute % 60:02d}Z",
            )

    def test_both_pages_are_read_and_the_second_page_is_retained(
        self, collector, forge
    ):
        self._fill(forge, 100)
        self._fill(forge, 2, offset=100)
        code, out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--max-attempts-per-pr",
            "200",
        )
        assert code == 0, err
        records = document(out)["records"]
        assert len(records) == 102
        pages = [
            urllib.parse.parse_qs(request["query"]).get("page", ["1"])[0]
            for request in forge.requests
        ]
        assert pages[0] == "1"
        assert "2" in pages

    def test_the_page_bound_is_respected(self, collector, forge):
        self._fill(forge, 100)
        self._fill(forge, 2, offset=100)
        code, out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--max-attempts-per-pr",
            "200",
            "--max-pages",
            "1",
        )
        assert code == 0, err
        assert len(document(out)["records"]) == 100
        pages = [
            urllib.parse.parse_qs(request["query"]).get("page", ["1"])[0]
            for request in forge.requests
        ]
        assert set(pages) == {"1"}


# ---------------------------------------------------------------------------
# The forge seam
# ---------------------------------------------------------------------------


class TestForgeSeam:
    def test_only_the_documented_endpoints_are_read(self, collector, forge):
        _publish(forge, 7, _scored_body())
        run(collector, "--repo", "o/r", "--pr", "7")
        assert [
            (request["method"], request["path"]) for request in forge.requests
        ] == [
            ("GET", "/repos/o/r/issues/7/comments"),
            ("GET", "/repos/o/r/pulls/7/reviews"),
        ]

    def test_the_pull_request_list_is_read_with_the_forge_ordering(
        self, collector, forge
    ):
        forge.pulls = [{"number": 9}, {"number": 8}]
        code, out, err = run(collector, "--repo", "o/r", "--all-prs")
        assert code == 0, err
        request = forge.requests[0]
        assert request["path"] == "/repos/o/r/pulls"
        query = urllib.parse.parse_qs(request["query"])
        assert query["sort"] == ["updated"]
        assert query["direction"] == ["desc"]
        assert query["state"] == ["all"]

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


# ---------------------------------------------------------------------------
# Bounded and redacted by construction
# ---------------------------------------------------------------------------


class TestBoundedAndRedacted:
    def test_the_bearer_token_never_reaches_the_dataset(self, collector, forge):
        body = _scored_body(reason=f"the model echoed {SECRET} in its answer")
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert SECRET not in out
        assert document(out)["records"][0]["verifier"]["reason"] == "[REDACTED]"

    def test_a_url_with_userinfo_is_masked(self, collector, forge):
        body = _scored_body(
            reason="the diff shows https://user:pass@forge.invalid/x in the body"
        )
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        reason = document(out)["records"][0]["verifier"]["reason"]
        assert "pass" not in reason
        assert "***@forge.invalid" in reason

    def test_no_whole_body_is_copied_into_the_dataset(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        assert FOREIGN_SENTENCE not in out
        assert "## Automated Review" not in out
        assert "ai-pr-reviewer:" not in out

    def test_the_body_is_recorded_as_a_digest(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        digest = document(out)["records"][0]["attempt"]["body_digest"]
        assert re.match(r"^sha256:[0-9a-f]{64}$", digest)


# ---------------------------------------------------------------------------
# The published telemetry
# ---------------------------------------------------------------------------


class TestPublishedTelemetry:
    def test_an_old_body_publishes_no_verifier_telemetry(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["status"] == "scored"
        assert record["verifier"]["latency_ms"] is None
        assert record["verifier"]["token_usage"] is None
        assert record["verifier"]["cause"] is None

    def test_an_old_marker_body_reports_the_disabled_verifier(self, collector, forge):
        body = _body(_marker(), None, _fingerprint())
        _publish(forge, 7, body)
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        record = document(out)["records"][0]
        assert record["verifier"]["status"] == "disabled"
        assert "published_verifier_section" in record["unavailable"]

    def test_a_new_body_publishes_the_whole_telemetry(self, collector, forge):
        _publish(
            forge,
            7,
            _telemetry_body(
                confidence_cause="timeout",
                confidence_latency_ms=8123,
                confidence_prompt_tokens=1200,
                confidence_completion_tokens=340,
                confidence_total_tokens=1540,
            ),
        )
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
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

    def test_the_pins_and_the_missing_field_reasons_survive(
        self, collector, forge
    ):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        payload = document(out)
        record = payload["records"][0]
        assert record["head_sha"] == HEAD_SHA
        assert record["base_sha"] == BASE_SHA
        assert record["review_result"] == "clean"
        assert record["required_checks"] == "complete"
        assert record["diff_fingerprint"] == DIFF_FINGERPRINT
        assert record["config_fingerprint"] == CONFIG_FINGERPRINT
        assert record["verifier"]["model"] == "verifier-model"
        for reason in payload["unavailable_reasons"].values():
            assert reason.strip()
        for key in record["unavailable"]:
            assert key in payload["unavailable_reasons"]


# ---------------------------------------------------------------------------
# The bounds
# ---------------------------------------------------------------------------


class TestBounds:
    def test_the_pull_request_bound_is_respected(self, collector, forge):
        forge.pulls = [{"number": 9}, {"number": 8}, {"number": 7}]
        code, out, err = run(collector, "--repo", "o/r", "--all-prs", "--max-prs", "2")
        assert code == 0, err
        assert document(out)["collections"][-1]["prs_requested"] == 2

    def test_the_named_pull_request_bound_is_respected(self, collector, forge):
        code, out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--pr",
            "8",
            "--pr",
            "9",
            "--max-prs",
            "2",
        )
        assert code == 0, err
        assert document(out)["collections"][-1]["prs_requested"] == 2
        notes = document(out)["collections"][-1]["notes"]
        assert any("--max-prs" in note for note in notes)

    def test_the_attempt_bound_keeps_the_newest_and_names_the_skipped(
        self, collector, forge
    ):
        _publish(
            forge,
            7,
            _scored_body(score=1),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=3),
            as_review=True,
            item_id=13,
            submitted_at="2026-03-01T00:00:00Z",
        )
        code, out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--max-attempts-per-pr", "2"
        )
        assert code == 0, err
        payload = document(out)
        assert len(payload["records"]) == 2
        assert [record["verifier"]["score"] for record in payload["records"]] == [2, 3]
        notes = payload["collections"][-1]["notes"]
        assert any("not" in note and "retained" in note for note in notes)

    def test_the_attempt_bound_never_drops_an_earlier_retained_attempt(
        self, collector, forge, tmp_path
    ):
        _publish(
            forge,
            7,
            _scored_body(score=1),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )
        run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--dataset",
            str(dataset),
            "--max-attempts-per-pr",
            "1",
        )
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["records"]) == 2

    def test_the_record_bound_fails_closed(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _scored_body(score=1),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--dataset",
            str(dataset),
            "--max-records",
            "0",
        )
        assert code == 2
        assert "max-records" in err
        assert not dataset.exists()

    def test_the_record_bound_names_the_count(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _scored_body(score=1),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=2),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )
        dataset = tmp_path / "dataset.json"
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--dataset",
            str(dataset),
            "--max-records",
            "1",
        )
        assert code == 2
        assert "2 records" in err


# ---------------------------------------------------------------------------
# The legacy import
# ---------------------------------------------------------------------------


def _legacy_run(
    pr: int | None,
    *,
    kind: str = "native_review",
    submitted_at: str = "2026-10-20T15:29:40Z",
    native_state: str = "CHANGES_REQUESTED",
    status: str = "unscored",
    score: int | None = None,
    risk: str | None = None,
    model: str | None = "glm-5.3-flash",
    latency_ms: int | None = None,
    cause: str | None = None,
    concern_count: int = 0,
) -> dict:
    run: dict = {
        "published_body": {
            "kind": kind,
            "submitted_at": submitted_at,
            "native_state": native_state,
        },
        "pins": {
            "head_sha": HEAD_SHA,
            "base_sha": BASE_SHA,
            "diff_fingerprint": DIFF_FINGERPRINT,
            "config_fingerprint": CONFIG_FINGERPRINT,
            "action_version": "v3.6.0-dev+10c7f2b",
        },
        "primary": {
            "review_result": "issues",
            "required_checks": None,
            "incomplete_reason": None,
            "tool_stop_reason": "request-error",
            "review_route": "primary",
        },
        "verifier": {
            "status": status,
            "cause": cause,
            "latency_ms": latency_ms,
            "score": score,
            "risk": risk,
            "model": model,
            "concern_count": concern_count,
        },
        "unavailable": {
            "rubric_version": "not published in the marker; run-directory only",
            "token_usage": "published only on heads >= ab603409",
            "parser_notes": "run-directory only",
            "cause": "run-directory only before #1457",
        },
    }
    if pr is not None:
        run["pr"] = pr
    return run


def _legacy_file(tmp_path: Path, runs: list[dict], **window) -> Path:
    payload = {
        "schema": "confidence-dogfood-evidence/v1",
        "source_issue": "misospace/pr-reviewer-action#1452",
        "window": {
            "enabled_runs": len(runs),
            "distinct_prs": len({run.get("pr") for run in runs if "pr" in run}),
            **window,
        },
        "runs": runs,
    }
    path = tmp_path / "legacy.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class TestLegacyImport:
    def test_a_baseline_imports_into_the_same_number_of_records(
        self, collector, tmp_path
    ):
        runs = [
            _legacy_run(1175),
            _legacy_run(1176),
            _legacy_run(1177, submitted_at="2026-10-21T15:29:40Z"),
        ]
        path = _legacy_file(tmp_path, runs)
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        payload = document(out)
        assert len(payload["records"]) == 3
        assert {record["pr_number"] for record in payload["records"]} == {
            1175,
            1176,
            1177,
        }

    def test_the_reconciliation_reports_the_declared_and_the_imported_counts(
        self, collector, tmp_path
    ):
        runs = [_legacy_run(1175), _legacy_run(1176)]
        path = _legacy_file(tmp_path, runs)
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        reconciliation = document(out)["collections"][-1]
        assert reconciliation["mode"] == "legacy-import"
        summary_path = tmp_path / "summary.json"
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--import-legacy",
            str(path),
            "--summary",
            str(summary_path),
        )
        assert code == 0, err
        reconciliation = json.loads(summary_path.read_text(encoding="utf-8"))[
            "legacy_reconciliation"
        ]
        assert reconciliation["source_schema"] == "confidence-dogfood-evidence/v1"
        assert reconciliation["declared_enabled_runs"] == 2
        assert reconciliation["declared_distinct_prs"] == 2
        assert reconciliation["runs_read"] == 2
        assert reconciliation["records_imported"] == 2
        assert reconciliation["records_skipped"] == 0
        assert reconciliation["distinct_prs_imported"] == 2
        assert reconciliation["notes"]

    def test_a_run_without_a_usable_pull_request_number_is_counted(
        self, collector, tmp_path
    ):
        runs = [_legacy_run(1175), _legacy_run(None)]
        path = _legacy_file(tmp_path, runs)
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        payload = document(out)
        assert len(payload["records"]) == 1
        reconciliation = payload["collections"][-1]
        assert reconciliation["records_seen"] == 1

    def test_the_skipped_run_is_counted_under_the_reconciliation(
        self, collector, tmp_path
    ):
        runs = [_legacy_run(1175), _legacy_run(None)]
        path = _legacy_file(tmp_path, runs)
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--import-legacy",
            str(path),
            "--summary",
            str(tmp_path / "summary.json"),
        )
        assert code == 0, err
        reconciliation = json.loads(
            (tmp_path / "summary.json").read_text(encoding="utf-8")
        )["legacy_reconciliation"]
        assert reconciliation["records_skipped"] == 1
        assert reconciliation["skip_reasons"]
        assert sum(reconciliation["skip_reasons"].values()) == 1

    def test_the_imported_records_carry_the_legacy_vocabulary(
        self, collector, tmp_path
    ):
        path = _legacy_file(tmp_path, [_legacy_run(1175)])
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        payload = document(out)
        record = payload["records"][0]
        assert record["source"] == "legacy-import"
        assert "legacy_published_record_id" in record["unavailable"]
        assert "legacy_verifier_reason" in record["unavailable"]
        assert "legacy_rubric_version" in record["unavailable"]
        assert "legacy_parser_notes" in record["unavailable"]
        assert "legacy_token_usage" in record["unavailable"]
        for key in record["unavailable"]:
            assert key in payload["unavailable_reasons"]
            assert payload["unavailable_reasons"][key].strip()

    def test_the_legacy_block_carries_the_baseline_provenance(
        self, collector, tmp_path
    ):
        path = _legacy_file(tmp_path, [_legacy_run(1175)])
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        legacy = document(out)["records"][0]["legacy"]
        assert legacy["action_version"] == "v3.6.0-dev+10c7f2b"
        assert legacy["native_state"] == "CHANGES_REQUESTED"
        assert legacy["tool_stop_reason"] == "request-error"
        assert legacy["review_route"] == "primary"
        assert legacy["incomplete_reason"] is None
        assert legacy["concern_count"] == 0
        assert legacy["source_issue"] == "misospace/pr-reviewer-action#1452"

    def test_a_malformed_verifier_status_degrades_to_unknown(self, collector, tmp_path):
        baseline_run = _legacy_run(1175, status="bogus", score=99, risk="purple")
        path = _legacy_file(tmp_path, [baseline_run])
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        verifier = document(out)["records"][0]["verifier"]
        assert verifier["status"] == "unknown"
        assert verifier["score"] is None
        assert verifier["risk"] == "unknown"

    def test_a_cause_is_recorded_only_for_an_unscored_run(self, collector, tmp_path):
        runs = [
            _legacy_run(1175, status="unscored", cause="http_403"),
            _legacy_run(1176, status="scored", score=3, risk="low", cause="timeout"),
        ]
        path = _legacy_file(tmp_path, runs)
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        records = document(out)["records"]
        causes = {record["pr_number"]: record["verifier"]["cause"] for record in records}
        assert causes == {1175: "http_403", 1176: None}

    def test_a_baseline_of_another_schema_is_refused(self, collector, tmp_path):
        path = tmp_path / "foreign.json"
        path.write_text(json.dumps({"schema": "something-else", "runs": []}), "utf-8")
        code, out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 2
        assert "something-else" in err
        assert out == ""

    def test_a_malformed_baseline_is_refused(self, collector, tmp_path):
        path = tmp_path / "broken.json"
        path.write_text("{not json", encoding="utf-8")
        code, _out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 2
        assert "JSON" in err

    def test_the_import_is_idempotent(self, collector, tmp_path):
        path = _legacy_file(tmp_path, [_legacy_run(1175), _legacy_run(1176)])
        dataset = tmp_path / "dataset.json"
        for _ in range(2):
            code, _out, err = run(
                collector,
                "--repo",
                "o/r",
                "--import-legacy",
                str(path),
                "--dataset",
                str(dataset),
            )
            assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(payload["records"]) == 2
        assert payload["collections"][-1]["records_added"] == 0
        assert payload["collections"][-1]["records_updated"] == 2

    def test_the_import_reads_no_forge(self, collector, tmp_path, forge):
        path = _legacy_file(tmp_path, [_legacy_run(1175)])
        code, _out, err = run(
            collector, "--repo", "o/r", "--import-legacy", str(path)
        )
        assert code == 0, err
        assert forge.requests == []

    def test_the_reconciliation_survives_a_later_live_collection(
        self, collector, tmp_path, forge
    ):
        path = _legacy_file(tmp_path, [_legacy_run(1175), _legacy_run(1176)])
        dataset = tmp_path / "dataset.json"
        summary = tmp_path / "summary.json"
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--import-legacy",
            str(path),
            "--dataset",
            str(dataset),
            "--summary",
            str(summary),
        )
        assert code == 0, err
        _publish(
            forge,
            9,
            _scored_body(score=4),
            as_review=True,
            item_id=31,
            submitted_at="2026-03-01T00:00:00Z",
        )
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "9",
            "--dataset",
            str(dataset),
            "--summary",
            str(summary),
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        reconciliation = payload["legacy_reconciliation"]
        assert reconciliation["records_imported"] == 2
        assert reconciliation["distinct_prs_imported"] == 2
        reported = json.loads(summary.read_text(encoding="utf-8"))
        assert reported["legacy_reconciliation"] == reconciliation


class TestBaselineAndLiveReadAgree:
    """A baseline import and a later live read are ONE record.

    The identity is anchored on the publication instant and the run pins,
    not on the forge's id -- so an imported baseline run and the live
    published review it describes resolve to the same attempt instead of two.
    """

    def test_an_imported_baseline_and_a_live_read_are_one_record(
        self, collector, forge, tmp_path
    ):
        submitted_at = "2026-10-20T15:29:40Z"
        _publish(
            forge,
            1175,
            _scored_body(score=3),
            as_review=True,
            item_id=4242,
            submitted_at=submitted_at,
            state="APPROVED",
        )
        baseline_run = _legacy_run(1175, submitted_at=submitted_at, status="scored",
                                   score=3, risk="low")
        path = _legacy_file(tmp_path, [baseline_run])
        dataset = tmp_path / "dataset.json"
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--import-legacy",
            str(path),
            "--dataset",
            str(dataset),
        )
        assert code == 0, err
        imported = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(imported["records"]) == 1

        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "1175", "--dataset", str(dataset)
        )
        assert code == 0, err
        merged = json.loads(dataset.read_text(encoding="utf-8"))
        assert len(merged["records"]) == 1
        record = merged["records"][0]
        assert record["attempt"]["observations"] == 2
        assert record["attempt"]["id"] == 4242
        assert record["source"] == "forge-read"
        assert record["legacy"] is not None, (
            "the baseline provenance survives the live read"
        )


# ---------------------------------------------------------------------------
# The dataset file
# ---------------------------------------------------------------------------


class TestDatasetFile:
    def test_a_foreign_schema_is_refused(self, collector, tmp_path):
        dataset = tmp_path / "dataset.json"
        dataset.write_text(json.dumps({"schema": "verifier-dogfood-evidence/v1"}), "utf-8")
        code, out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 2
        assert "verifier-dogfood-evidence/v1" in err
        assert out == ""

    def test_a_malformed_dataset_is_refused(self, collector, tmp_path):
        dataset = tmp_path / "dataset.json"
        dataset.write_text("{not json", encoding="utf-8")
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 2
        assert "JSON" in err

    def test_a_missing_dataset_starts_an_empty_one(self, collector, forge, tmp_path):
        _publish(forge, 7, _scored_body())
        dataset = tmp_path / "dataset.json"
        code, _out, err = run(
            collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset)
        )
        assert code == 0, err
        payload = json.loads(dataset.read_text(encoding="utf-8"))
        assert payload["schema"] == "verifier-dogfood-dataset/v1"
        assert len(payload["records"]) == 1

    def test_the_dataset_only_mode_writes_the_document_back_unchanged(
        self, collector, forge, tmp_path
    ):
        _publish(forge, 7, _scored_body())
        dataset = tmp_path / "dataset.json"
        run(collector, "--repo", "o/r", "--pr", "7", "--dataset", str(dataset))
        before = dataset.read_text(encoding="utf-8")
        code, _out, err = run(collector, "--repo", "o/r", "--dataset", str(dataset))
        assert code == 0, err
        assert dataset.read_text(encoding="utf-8") == before

    def test_the_dataset_only_mode_reads_no_forge(self, collector, forge, tmp_path):
        code, _out, err = run(
            collector,
            "--repo",
            "o/r",
            "--dataset",
            str(tmp_path / "dataset.json"),
        )
        assert code == 0, err
        assert forge.requests == []

    def test_the_document_carries_the_published_shape(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 0, err
        payload = document(out)
        assert payload["schema"] == "verifier-dogfood-dataset/v1"
        assert payload["repository"] == "o/r"
        assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", payload["generated_at"])
        record = payload["records"][0]
        assert set(record) == {
            "identity",
            "repository",
            "pr_number",
            "source",
            "attempt",
            "head_sha",
            "base_sha",
            "review_result",
            "required_checks",
            "diff_fingerprint",
            "config_fingerprint",
            "verifier",
            "unavailable",
            "legacy",
            "read_error",
        }
        assert set(record["attempt"]) == {
            "kind",
            "id",
            "state",
            "submitted_at",
            "created_at",
            "updated_at",
            "published_at",
            "edited",
            "body_digest",
            "observations",
            "first_seen_at",
            "last_seen_at",
            "absent_in_latest_collection",
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


# ---------------------------------------------------------------------------
# The summary
# ---------------------------------------------------------------------------


class TestSummary:
    def _summary(self, collector, tmp_path, *args: str) -> dict:
        path = tmp_path / "summary.json"
        code, _out, err = run(collector, *args, "--summary", str(path))
        assert code == 0, err
        return json.loads(path.read_text(encoding="utf-8"))

    def test_the_summary_reproduces_the_counts_it_claims(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _scored_body(score=4),
            as_review=True,
            item_id=11,
            submitted_at="2026-01-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _scored_body(score=5),
            as_review=True,
            item_id=12,
            submitted_at="2026-02-01T00:00:00Z",
        )
        _publish(
            forge,
            7,
            _unscored_body(),
            as_review=True,
            item_id=13,
            submitted_at="2026-03-01T00:00:00Z",
        )
        summary = self._summary(collector, tmp_path, "--repo", "o/r", "--pr", "7")
        assert summary["schema"] == "verifier-dogfood-summary/v1"
        assert summary["verifier_status"] == {
            "scored": 2,
            "unscored": 1,
            "disabled": 0,
            "unknown": 0,
        }
        assert summary["window"]["records"] == 3
        assert summary["window"]["prs"] == 1
        assert summary["attempts"] == {
            "max_per_pr": 3,
            "prs_with_multiple_attempts": 1,
            "mean_per_pr": 3.0,
        }
        assert summary["sources"] == {"forge-read": 3, "legacy-import": 0}

    def test_the_summary_counts_the_telemetry_coverage(self, collector, forge, tmp_path):
        _publish(
            forge,
            7,
            _telemetry_body(
                confidence_cause="timeout",
                confidence_latency_ms=10,
                confidence_total_tokens=20,
            ),
        )
        summary = self._summary(collector, tmp_path, "--repo", "o/r", "--pr", "7")
        assert summary["coverage"]["latency_published"] == 1
        assert summary["coverage"]["latency_missing"] == 0
        assert summary["coverage"]["token_usage_published"] == 1
        assert summary["coverage"]["cause_published"] == 1
        assert summary["causes"] == {"timeout": 1}

    def test_the_summary_carries_no_judgment(self, collector, forge, tmp_path):
        _publish(forge, 7, _scored_body(score=4))
        summary = self._summary(collector, tmp_path, "--repo", "o/r", "--pr", "7")
        forbidden = ("verdict", "pass", "fail", "gate", "threshold", "recommend")

        def walk(node: object) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    assert not any(word in str(key).lower() for word in forbidden)
                    walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)

        walk(summary)
        assert any(
            "no pass/fail judgment" in note for note in summary["notes"]
        ), "the summary must say where the judgment lives"

    def test_the_summary_repeats_the_vocabulary(self, collector, forge, tmp_path):
        _publish(forge, 7, _scored_body(score=4))
        summary = self._summary(collector, tmp_path, "--repo", "o/r", "--pr", "7")
        assert summary["unavailable_reasons"]
        for reason in summary["unavailable_reasons"].values():
            assert reason.strip()


# ---------------------------------------------------------------------------
# Input validation and the exit codes
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
            ("--repo", "o/r", "--pr", "7", "--all-prs"),
            ("--repo", "o/r", "--pr", "7", "--import-legacy", "x.json"),
            ("--repo", "o/r", "--all-prs", "--import-legacy", "x.json"),
            ("--repo", "o/r", "--pr", "7", "--now", "not-a-timestamp"),
            ("--repo", "o/r", "--pr", "7", "--max-records", "0"),
            ("--repo", "o/r", "--pr", "7", "--max-pages", "0"),
        ],
    )
    def test_malformed_input_is_rejected_without_a_request(self, collector, forge, args):
        code, out, err = run(collector, *args)
        assert code == 2
        assert forge.requests == [], "no request may go out for a rejected input"
        assert SECRET not in err
        assert SECRET not in out

    def test_a_rejected_input_is_never_echoed(self, collector, forge):
        code, out, err = run(collector, "--repo", "o/r", "--pr", SECRET)
        assert code == 2
        assert SECRET not in out
        assert SECRET not in err

    def test_an_unreadable_pull_request_is_a_partial_run(self, collector, forge):
        _publish(forge, 7, _scored_body())
        forge.fail_comments.add("7")
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7")
        assert code == 1
        payload = document(out)
        assert payload["records"] == []
        assert payload["collections"][-1]["records_seen"] == 0

    def test_one_unreadable_pull_request_does_not_abort_the_run(self, collector, forge):
        _publish(forge, 7, _scored_body())
        forge.fail_comments.add("8")
        code, out, err = run(collector, "--repo", "o/r", "--pr", "7", "--pr", "8")
        assert code == 1
        payload = document(out)
        assert len(payload["records"]) == 1
        assert payload["records"][0]["pr_number"] == 7
        notes = payload["collections"][-1]["notes"]
        assert any("pull request 8" in note for note in notes)

    def test_the_now_timestamp_is_used_for_the_run(self, collector, forge):
        _publish(forge, 7, _scored_body())
        code, out, err = run(
            collector,
            "--repo",
            "o/r",
            "--pr",
            "7",
            "--now",
            "2026-11-04T00:00:00Z",
        )
        assert code == 0, err
        payload = document(out)
        assert payload["generated_at"] == "2026-11-04T00:00:00Z"
        record = payload["records"][0]
        assert record["attempt"]["first_seen_at"] == "2026-11-04T00:00:00Z"
        assert record["attempt"]["last_seen_at"] == "2026-11-04T00:00:00Z"
        assert payload["collections"][-1]["collected_at"] == "2026-11-04T00:00:00Z"
