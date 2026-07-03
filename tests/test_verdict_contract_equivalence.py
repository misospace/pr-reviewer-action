"""Verdict-turn contract equivalence tests (#362).

The review verdict is built on two code paths that live in different
languages and must stay in lockstep on the shared invariants:

  Path A — ``build_model_request`` in ``scripts/model_call.sh`` (the bash
           corpus-only / single-shot review call).
  Path B — ``Conversation.to_request_payload(verdict_turn=True)`` in
           ``pr_reviewer/conversation.py`` (the native_loop in-conversation
           verdict, driven by ``scripts/run_tool_harness.py``).

The authoritative divergence map is the "VERDICT-TURN CONTRACT" block in
``pr_reviewer/conversation.py``'s module docstring. These tests FAIL if one
path's shared contract drifts from the other's — e.g. someone edits the
strict-JSON ``pr_review`` schema in bash without mirroring it in Python.

The bash side is pinned by reading the source text directly (no shell
execution), so the guard runs in the pure-Python pytest suite that CI runs.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.conversation import (  # noqa: E402
    Conversation,
    _OPENAI_VERDICT_JSON_SCHEMA,
)

_MODEL_CALL_SH = (_REPO_ROOT / "scripts" / "model_call.sh").read_text(encoding="utf-8")
_HARNESS_PY = (_REPO_ROOT / "scripts" / "run_tool_harness.py").read_text(encoding="utf-8")


def _bash_rf_literal(mode: str) -> dict:
    """Extract a ``rf_json='...'`` response_format literal for a case arm.

    Mirrors the ``case "${AI_RESPONSE_FORMAT:-off}"`` block in
    ``build_model_request``; returns the parsed JSON object.
    """
    # Each arm is:   <mode>)\n  <comment lines>\n  rf_json='<json>' ;;
    m = re.search(
        rf"\b{re.escape(mode)}\)\s*(?:#[^\n]*\n\s*)*rf_json='(.*?)'\s*;;",
        _MODEL_CALL_SH,
        re.S,
    )
    assert m, f"could not find rf_json literal for AI_RESPONSE_FORMAT={mode}"
    return json.loads(m.group(1))


class TestSharedResponseFormat:
    """response_format shapes must be identical on both paths."""

    def test_json_schema_literal_is_byte_identical(self):
        # The single highest-risk duplicate: the strict pr_review schema is
        # embedded once in bash (model_call.sh) and once in Python
        # (_OPENAI_VERDICT_JSON_SCHEMA). Parse the bash literal and require
        # deep equality with the Python constant.
        bash_schema = _bash_rf_literal("json_schema")
        assert bash_schema == _OPENAI_VERDICT_JSON_SCHEMA

    def test_python_verdict_payload_uses_that_schema(self):
        # And the Python verdict payload actually emits the constant, so the
        # equivalence above is meaningful for the wire request (not just for
        # a dead constant).
        c = Conversation(system="reviewer")
        c.add_user("review me")
        payload = c.to_request_payload(
            "openai", "m", verdict_turn=True, response_format="json_schema"
        )
        assert payload["response_format"] == _bash_rf_literal("json_schema")

    def test_json_object_shape_matches(self):
        bash_obj = _bash_rf_literal("json_object")
        assert bash_obj == {"type": "json_object"}
        c = Conversation(system="reviewer")
        c.add_user("review me")
        payload = c.to_request_payload(
            "openai", "m", verdict_turn=True, response_format="json_object"
        )
        assert payload["response_format"] == bash_obj

    def test_off_omits_response_format_on_both_paths(self):
        # Bash: no json_object/json_schema arm fires → rf_json stays "null" →
        # the field is dropped. Python: response_format=None → dropped.
        assert re.search(r'rf_json="null"', _MODEL_CALL_SH)
        c = Conversation(system="reviewer")
        c.add_user("review me")
        payload = c.to_request_payload(
            "openai", "m", verdict_turn=True, response_format=None
        )
        assert "response_format" not in payload


class TestSharedNoTools:
    """The verdict/review request never advertises tools on either path."""

    def test_python_verdict_turn_drops_tools(self):
        c = Conversation(system="reviewer")
        c.add_user("review me")
        c.add_assistant_tool_calls([{"id": "a", "name": "read_file", "arguments": "{}"}])
        c.add_tool_result("a", "ok")
        for fmt in ("openai", "anthropic"):
            payload = c.to_request_payload(fmt, "m", verdict_turn=True)
            assert "tools" not in payload, fmt

    def test_bash_review_request_never_adds_tools(self):
        # build_model_request builds a system+user (or user-only) request and
        # has no "tools" field in either the openai or anthropic jq template.
        assert '"tools"' not in _MODEL_CALL_SH
        assert "tools:" not in _MODEL_CALL_SH


class TestSharedTokenAndSamplingKnobs:
    """Token field, default cap, temperature, and stream_options must agree."""

    def test_default_max_tokens_is_8192_on_both_paths(self):
        # Path A default.
        assert 'AI_MAX_TOKENS:-8192' in _MODEL_CALL_SH
        # Path B default (env_int_bounded fallback in run_tool_harness.py).
        assert re.search(r'env_int_bounded\(\s*"AI_MAX_TOKENS",\s*8192', _HARNESS_PY)

    def test_tokens_param_field_name_matches(self):
        # Bash honours max_completion_tokens; Python mirrors it.
        assert "max_completion_tokens" in _MODEL_CALL_SH
        for tp, expected in (
            ("max_completion_tokens", "max_completion_tokens"),
            ("max_tokens", "max_tokens"),
        ):
            c = Conversation(system="s")
            c.add_user("go")
            payload = c.to_request_payload(
                "openai", "m", verdict_turn=True, tokens_param=tp
            )
            assert expected in payload
            other = "max_tokens" if expected == "max_completion_tokens" else "max_completion_tokens"
            assert other not in payload

    def test_temperature_omitted_when_none(self):
        # Bash omits temperature when AI_TEMPERATURE is empty; Python omits it
        # when temperature is None.
        assert 'if $temp == null then {} else {temperature:$temp} end' in _MODEL_CALL_SH
        c = Conversation(system="s")
        c.add_user("go")
        assert "temperature" not in c.to_request_payload(
            "openai", "m", verdict_turn=True, temperature=None
        )
        assert c.to_request_payload(
            "openai", "m", verdict_turn=True, temperature=0.1
        )["temperature"] == 0.1

    def test_stream_options_include_usage_when_streaming(self):
        # Bash sets stream_options.include_usage on streamed openai requests;
        # Python's verdict payload does the same.
        assert "stream_options:{include_usage:true}" in _MODEL_CALL_SH
        c = Conversation(system="s")
        c.add_user("go")
        streamed = c.to_request_payload("openai", "m", verdict_turn=True, stream=True)
        assert streamed["stream_options"] == {"include_usage": True}
        plain = c.to_request_payload("openai", "m", verdict_turn=True, stream=False)
        assert "stream_options" not in plain


class TestSharedSystemAndCorpus:
    """System prompt present; the verdict request carries a system message."""

    def test_openai_verdict_has_system_and_user(self):
        c = Conversation(system="reviewer prompt")
        c.add_user("review me")
        payload = c.to_request_payload(
            "openai", "m", verdict_turn=True, response_format="json_object"
        )
        roles = [msg["role"] for msg in payload["messages"]]
        assert roles[0] == "system"
        assert payload["messages"][0]["content"].startswith("reviewer prompt")
        assert "user" in roles

    def test_anthropic_verdict_has_top_level_system_and_no_response_format(self):
        # Anthropic carries system at the top level and never gets a
        # response_format on either path.
        c = Conversation(system="reviewer prompt")
        c.add_user("review me")
        payload = c.to_request_payload(
            "anthropic", "m", verdict_turn=True, response_format="json_schema"
        )
        assert payload["system"]  # present
        assert "response_format" not in payload
        assert "tools" not in payload


class TestNativeLoopNoSwapInvariant:
    """#263: the loop system and the verdict-turn system are ONE string, so the
    cached prefix is never invalidated by a mid-conversation system swap. The
    native path keeps full history on the verdict turn, so to_request_payload
    must leave the (already-appended) system untouched."""

    def test_verdict_system_equals_loop_system_with_full_history(self):
        loop_system = "REVIEWER PROMPT\n\n## Gathering evidence with tools\n..."
        c = Conversation(system=loop_system)
        c.add_user("gather evidence for corpus")
        c.add_assistant_tool_calls([{"id": "a", "name": "read_file", "arguments": "{}"}])
        c.add_tool_result("a", "ok")
        c.add_user("produce the final verdict now ...")  # _VERDICT_CLOSING_INSTRUCTION + corpus
        payload = c.to_request_payload(
            "openai",
            "m",
            verdict_turn=True,
            keep_full_history_on_verdict=True,
            response_format="json_schema",
        )
        # System is byte-identical to the loop system (no transcript-note
        # collapse, no swap) — the #263 cached-prefix guarantee.
        assert payload["messages"][0] == {"role": "system", "content": loop_system}
        # Full tool history is preserved (keep_full_history_on_verdict=True).
        assert any(m["role"] == "tool" for m in payload["messages"])
        assert "tools" not in payload

    def test_harness_builds_one_stable_system(self):
        # run_tool_harness.py must build loop_system = review_system +
        # TOOL_USE_PREAMBLE and reuse it for the verdict turn (no swap). Pin
        # the source so a refactor that reintroduces a swap trips here.
        assert "review_system + TOOL_USE_PREAMBLE" in _HARNESS_PY
        assert "keep_full_history_on_verdict=True" in _HARNESS_PY


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
