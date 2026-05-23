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


# ---------------------------------------------------------------------------
# parse_response_file
# ---------------------------------------------------------------------------

class TestParseResponseFile(TestCase):
    def test_round_trip(self, tmp_path=None):
        """Write a response file, then read and parse it."""
        import tempfile
        data = {
            "choices": [{
                "message": {"content": json.dumps({
                    "verdict": "request_changes",
                    "review_markdown": "Please fix the typo.",
                })},
            }],
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, dir="/tmp"
        ) as f:
            json.dump(data, f)
            path = f.name
        try:
            result = parse_response_file(path)
            self.assertEqual(result["verdict"], "request_changes")
            self.assertIn("typo", result["review_markdown"])
        finally:
            Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest_main()
