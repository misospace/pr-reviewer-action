"""Tests for pr_reviewer.response_parser."""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path
from unittest import TestCase, main as unittest_main

# Ensure the repo root is on sys.path so ``pr_reviewer`` is importable.
_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.response_parser import (  # noqa: E402
    _extract_content,
    _strip_markdown_code_block,
    _try_decode_json,
    parse_response,
    parse_response_file,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_openai(verdict: str = "approve", markdown: str = "# LGTM") -> dict:
    return {
        "choices": [
            {
                "message": {"role": "assistant", "content": json.dumps(
                    {"verdict": verdict, "review_markdown": markdown}
                )},
                "finish_reason": "stop",
            }
        ],
    }


def _make_anthropic(verdict: str = "approve", markdown: str = "# LGTM") -> dict:
    return {
        "content": [
            {"type": "text", "text": json.dumps(
                {"verdict": verdict, "review_markdown": markdown}
            )},
        ],
    }


# ---------------------------------------------------------------------------
# _extract_content
# ---------------------------------------------------------------------------

class TestExtractContent(TestCase):
    def test_openai_string(self):
        resp = {"choices": [{"message": {"content": "hello"}}]}
        self.assertEqual(_extract_content(resp), "hello")

    def test_openai_list_of_strings(self):
        resp = {"choices": [{"message": {"content": ["a", "b"]}}]}
        self.assertEqual(_extract_content(resp), ["a", "b"])

    def test_openai_list_of_dicts_text(self):
        resp = {"choices": [{"message": {"content": [
            {"type": "text", "text": "hi"},
            {"type": "tool_use", "name": "foo"},
        ]}}]}
        self.assertEqual(_extract_content(resp), ["hi"])

    def test_openai_list_of_dicts_none_type(self):
        """Items with no 'type' key should be treated as text if they have 'text'."""
        resp = {"choices": [{"message": {"content": [
            {"text": "plain"},
        ]}}]}
        self.assertEqual(_extract_content(resp), ["plain"])

    def test_anthropic_text_blocks(self):
        resp = {"content": [
            {"type": "text", "text": "part1"},
            {"type": "thinking", "text": "hidden"},
            {"type": "text", "text": "part2"},
        ]}
        self.assertEqual(_extract_content(resp), ["part1", "part2"])

    def test_anthropic_non_text_only(self):
        resp = {"content": [
            {"type": "thinking", "text": "hidden"},
        ]}
        self.assertIsNone(_extract_content(resp))

    def test_plain_string(self):
        resp = {"content": "just a string"}
        self.assertEqual(_extract_content(resp), "just a string")

    def test_empty_choices(self):
        self.assertIsNone(_extract_content({"choices": []}))

    def test_no_matching_keys(self):
        self.assertIsNone(_extract_content({}))


# ---------------------------------------------------------------------------
# _strip_markdown_code_block
# ---------------------------------------------------------------------------

class TestStripMarkdownCodeBlock(TestCase):
    def test_no_fence(self):
        self.assertEqual(_strip_markdown_code_block("hello"), "hello")

    def test_triple_backticks(self):
        text = "```\nhello\n```"
        self.assertEqual(_strip_markdown_code_block(text), "hello")

    def test_with_language_tag(self):
        text = "```json\n{\"a\": 1}\n```"
        self.assertEqual(_strip_markdown_code_block(text), '{"a": 1}')

    def test_nested_backticks_not_stripped(self):
        """Single backtick should not be treated as a fence."""
        self.assertEqual(_strip_markdown_code_block("`hello`"), "`hello`")


# ---------------------------------------------------------------------------
# _try_decode_json
# ---------------------------------------------------------------------------

class TestTryDecodeJson(TestCase):
    def test_clean_json(self):
        self.assertEqual(_try_decode_json('{"a": 1}'), {"a": 1})

    def test_list_json(self):
        self.assertEqual(_try_decode_json('[1, 2, 3]'), [1, 2, 3])

    def test_prose_before_json(self):
        result = _try_decode_json("Here is the answer: {\"key\": \"value\"}")
        self.assertEqual(result, {"key": "value"})

    def test_no_json(self):
        self.assertIsNone(_try_decode_json("just text"))

    def test_empty_string(self):
        self.assertIsNone(_try_decode_json(""))


# ---------------------------------------------------------------------------
# parse_response  (integration)
# ---------------------------------------------------------------------------

class TestParseResponse(TestCase):
    def test_openai_format(self):
        resp = _make_openai()
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "approve")
        self.assertIn("# LGTM", result["review_markdown"])

    def test_anthropic_format(self):
        resp = _make_anthropic()
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "approve")

    def test_openai_list_content(self):
        """OpenAI choices with content as a list of strings."""
        resp = {
            "choices": [{
                "message": {"content": [
                    "Here's the review:",
                    json.dumps({"verdict": "request_changes", "review_markdown": "Fix this"}),
                ]},
            }],
        }
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "request_changes")

    def test_markdown_fence_stripped(self):
        inner = json.dumps({"verdict": "approve", "review_markdown": "# OK"})
        resp = {"choices": [{"message": {"content": f"```\n{inner}\n```"}}]}
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "approve")

    def test_single_item_list_wrapped(self):
        """[{"verdict": ...}] should be unwrapped to {...}."""
        inner = json.dumps([{"verdict": "approve", "review_markdown": "# OK"}])
        resp = {"choices": [{"message": {"content": inner}}]}
        result = parse_response(resp)
        self.assertIsInstance(result, dict)
        self.assertEqual(result["verdict"], "approve")

    def test_json_with_prose(self):
        """JSON embedded in prose should be recovered."""
        inner = json.dumps({"verdict": "approve", "review_markdown": "# Fine"})
        resp = {"choices": [{"message": {"content": f"Sure thing:\n{inner}\n\nThanks!"}}]}
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "approve")

    # --- Error cases ---

    def test_no_json_in_content(self):
        resp = {"choices": [{"message": {"content": "just text, no json"}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        self.assertIn("Expected JSON object", str(ctx.exception))

    def test_list_instead_of_dict(self):
        inner = json.dumps([1, 2, 3])
        resp = {"choices": [{"message": {"content": inner}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        self.assertIn("Expected JSON object", str(ctx.exception))

    def test_missing_verdict(self):
        inner = json.dumps({"review_markdown": "# OK"})
        resp = {"choices": [{"message": {"content": inner}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        self.assertIn("missing required key 'verdict'", str(ctx.exception))

    def test_missing_review_markdown(self):
        inner = json.dumps({"verdict": "approve"})
        resp = {"choices": [{"message": {"content": inner}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        self.assertIn("missing required key 'review_markdown'", str(ctx.exception))

    def test_invalid_verdict(self):
        inner = json.dumps({"verdict": "ignore", "review_markdown": "# OK"})
        resp = {"choices": [{"message": {"content": inner}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        self.assertIn("Expected verdict", str(ctx.exception))

    def test_empty_review_markdown(self):
        inner = json.dumps({"verdict": "approve", "review_markdown": ""})
        resp = {"choices": [{"message": {"content": inner}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        self.assertIn("empty or missing", str(ctx.exception))

    def test_flattened_review_markdown_multiple_headings_no_newlines(self):
        # Issue #447: grammar-constrained decoding under
        # ai_response_format: json_schema (e.g. Fireworks) can strip the
        # "\\n" escapes that markdown requires, yielding a wall of bolded
        # headings on a single line. Such a payload is not publishable.
        inner = json.dumps({
            "verdict": "request_changes",
            "review_markdown": (
                "## Summary This PR looks great overall ## Strengths "
                "Clean code and good tests ## Concerns Possible "
                "race condition in worker startup"
            ),
        })
        resp = {"choices": [{"message": {"content": inner}}]}
        with self.assertRaises(SystemExit) as ctx:
            parse_response(resp)
        msg = str(ctx.exception)
        self.assertIn("flattened", msg)
        self.assertIn("## ", msg)
        self.assertIn("json_object", msg)

    def test_single_heading_no_newlines_still_accepted(self):
        # Only one heading marker -> not flattened; pass through as-is.
        inner = json.dumps({
            "verdict": "approve",
            "review_markdown": "## Summary Looks good to me",
        })
        resp = {"choices": [{"message": {"content": inner}}]}
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "approve")
        self.assertEqual(result["review_markdown"], "## Summary Looks good to me")

    def test_multiple_headings_with_newlines_accepted(self):
        # Well-formed review with proper newlines -> no false positive.
        inner = json.dumps({
            "verdict": "approve",
            "review_markdown": (
                "## Summary\n\nLooks good.\n\n## Details\n\nNo issues found."
            ),
        })
        resp = {"choices": [{"message": {"content": inner}}]}
        result = parse_response(resp)
        self.assertEqual(result["verdict"], "approve")
        self.assertIn("\n", result["review_markdown"])


# ---------------------------------------------------------------------------
# parse_response_file
# ---------------------------------------------------------------------------

class TestParseResponseFile:
    def test_round_trip(self, tmp_path):
        """Write a response file, then read and parse it."""
        data = {
            "choices": [{
                "message": {"content": json.dumps({
                    "verdict": "request_changes",
                    "review_markdown": "Please fix the typo.",
                })},
            }],
        }
        path = tmp_path / "response.json"
        path.write_text(json.dumps(data))
        result = parse_response_file(str(path))
        assert result["verdict"] == "request_changes"
        assert "typo" in result["review_markdown"]


# ---------------------------------------------------------------------------
# Verdict normalisation, truncation, and stream-error handling
# ---------------------------------------------------------------------------

def _exit_msg(resp: dict) -> str:
    """Call parse_response expecting SystemExit; return the message."""
    try:
        parse_response(resp)
    except SystemExit as exc:
        return str(exc)
    raise AssertionError("expected SystemExit but parse_response returned")


class TestVerdictNormalization:
    @staticmethod
    def _resp(verdict: str, finish_reason: str = "stop") -> dict:
        return {
            "choices": [{
                "message": {"content": json.dumps(
                    {"verdict": verdict, "review_markdown": "# ok"}
                )},
                "finish_reason": finish_reason,
            }],
        }

    def test_capitalized_approve(self):
        assert parse_response(self._resp("Approve"))["verdict"] == "approve"

    def test_approved_synonym(self):
        assert parse_response(self._resp("APPROVED"))["verdict"] == "approve"

    def test_spaced_request_changes(self):
        assert parse_response(self._resp("Request Changes"))["verdict"] == "request_changes"

    def test_changes_requested_synonym(self):
        assert parse_response(self._resp("changes_requested"))["verdict"] == "request_changes"

    def test_unknown_verdict_still_rejected(self):
        assert "Expected verdict" in _exit_msg(self._resp("maybe"))


class TestTruncationAndStreamError:
    def test_truncation_hint_openai_length(self):
        # Unparseable (truncated) content with finish_reason=length.
        resp = {"choices": [{"message": {"content": '{"verdict": "approve"'},
                             "finish_reason": "length"}]}
        assert "truncated" in _exit_msg(resp)

    def test_truncation_hint_anthropic_max_tokens(self):
        resp = {"content": [{"type": "text", "text": '{"verdict":'}],
                "stop_reason": "max_tokens"}
        assert "truncated" in _exit_msg(resp)

    def test_no_truncation_hint_when_finished_normally(self):
        resp = {"choices": [{"message": {"content": "no json here"},
                             "finish_reason": "stop"}]}
        assert "truncated" not in _exit_msg(resp)

    def test_stream_error_surfaced(self):
        resp = {"error": {"message": "context length exceeded"},
                "choices": [{"message": {"content": ""}}]}
        msg = _exit_msg(resp)
        assert "context length exceeded" in msg


def _openai_with(payload: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(payload)}}]}


class TestFindingsNormalization:
    BASE = {"verdict": "approve", "review_markdown": "ok"}

    def _parse_findings(self, findings):
        payload = dict(self.BASE)
        if findings is not None:
            payload["findings"] = findings
        return parse_response(_openai_with(payload))["findings"]

    def test_absent_findings_become_empty_list(self):
        assert self._parse_findings(None) == []

    def test_null_findings_become_empty_list(self):
        payload = dict(self.BASE, findings=None)
        assert parse_response(_openai_with(payload))["findings"] == []

    def test_non_list_findings_become_empty_list(self):
        assert self._parse_findings("not a list") == []

    def test_valid_finding_normalized(self):
        out = self._parse_findings([
            {"severity": "blocker", "category": "security", "file": "./a/b.py",
             "line": "42", "message": "  path traversal  "}
        ])
        assert out == [{
            "severity": "blocker", "category": "security", "file": "a/b.py",
            "line": 42, "message": "path traversal",
        }]

    def test_severity_aliases_mapped(self):
        out = self._parse_findings([
            {"severity": "Critical", "message": "a"},
            {"severity": "HIGH", "message": "b"},
            {"severity": "warning", "message": "c"},
            {"severity": "nit", "message": "d"},
            {"severity": "made-up", "message": "e"},
        ])
        assert [f["severity"] for f in out] == [
            "blocker", "major", "minor", "info", "info",
        ]

    def test_unknown_category_becomes_other(self):
        out = self._parse_findings([{"message": "x", "category": "vibes"}])
        assert out[0]["category"] == "other"

    def test_items_without_message_dropped(self):
        out = self._parse_findings([
            {"severity": "blocker"},
            "just a string",
            42,
            {"message": "   "},
            {"message": "kept"},
        ])
        assert len(out) == 1
        assert out[0]["message"] == "kept"

    def test_message_fallbacks_summary_and_title(self):
        out = self._parse_findings([
            {"summary": "from summary"},
            {"title": "from title"},
        ])
        assert [f["message"] for f in out] == ["from summary", "from title"]

    def test_invalid_lines_become_null(self):
        out = self._parse_findings([
            {"message": "a", "line": 0},
            {"message": "b", "line": -3},
            {"message": "c", "line": "abc"},
            {"message": "d", "line": True},
            {"message": "e", "line": 7.0},
        ])
        assert [f["line"] for f in out] == [None, None, None, None, 7]

    def test_parent_traversal_path_not_silently_rewritten(self):
        out = self._parse_findings([{"message": "x", "file": "../etc/passwd"}])
        assert out[0]["file"] == "../etc/passwd"

    def test_findings_capped_at_50(self):
        out = self._parse_findings([{"message": f"f{i}"} for i in range(80)])
        assert len(out) == 50

    def test_id_and_resolution_preserved(self):
        out = self._parse_findings([
            {"message": "carried", "id": "P1", "resolution": "resolved"},
            {"message": "alias", "id": "P2", "resolution": "FIXED"},
            {"message": "open", "id": "P3", "resolution": "still_open"},
            {"message": "unknown", "id": "P4", "resolution": "not_verifiable"},
        ])
        assert [(f["id"], f["resolution"]) for f in out] == [
            ("P1", "resolved"), ("P2", "resolved"), ("P3", "still_open"),
            ("P4", "not_verifiable_from_delta"),
        ]

    def test_invalid_id_and_resolution_dropped(self):
        out = self._parse_findings([
            {"message": "a", "id": "../;rm -rf", "resolution": "maybe?"},
            {"message": "b", "id": 7, "resolution": ["resolved"]},
            {"message": "c"},
        ])
        assert out[0]["id"] == "rm-rf"
        assert "resolution" not in out[0]
        assert "id" not in out[1] and "resolution" not in out[1]
        assert "id" not in out[2]

    def test_weak_model_without_findings_unchanged(self):
        result = parse_response(_openai_with(self.BASE))
        assert result["verdict"] == "approve"
        assert result["review_markdown"] == "ok"
        assert result["findings"] == []


if __name__ == "__main__":
    unittest_main()
