"""#701: tier-aware, exhaustion-aware native tool-loop budgets.

Covers:
  - the remaining-budget turn notes the loop driver injects on every turn
    after the first (counts, the low-budget pivot directive, verdict-turn
    drop, and the OpenAI/Anthropic wire shapes);
  - the harness markdown/verdict-body exhaustion notes and the
    ``budget_exhausted`` telemetry flag;
  - the main()-level budget-tier telemetry keys.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_SCRIPTS_DIR = _ROOT / "scripts"
for _path in (str(_SCRIPTS_DIR), str(_ROOT)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import run_tool_harness as rth  # noqa: E402
from pr_reviewer.conversation import Conversation  # noqa: E402
from pr_reviewer.tool_loop import (  # noqa: E402
    LOW_TOOL_REQUESTS_REMAINING,
    STOP_BUDGET,
    LoopBudgets,
    drive_tool_loop,
)


def _openai_call(call_id, name, args):
    return {
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": args},
                        }
                    ],
                },
            }
        ]
    }


def _openai_text(text):
    return {"choices": [{"finish_reason": "stop", "message": {"content": text}}]}


def _loop(budget, responses):
    """Drive the loop with a payload-capturing transport; return (conv, outcome, payloads)."""
    payloads = []
    queue = list(responses)

    def post(payload):
        payloads.append(json.loads(json.dumps(payload)))
        assert queue, "model called more times than scripted"
        return queue.pop(0)

    conv = Conversation(system="gather evidence")
    conv.add_user("review this PR")

    def execute(name, args):
        return {"tool": name, "status": "ok", "result": {"content": "evidence"}}

    outcome = drive_tool_loop(
        conv,
        post,
        execute,
        api_format="openai",
        model="m",
        budgets=LoopBudgets(
            max_tool_calls=budget["requests"],
            max_rounds=budget["rounds"],
        ),
    )
    return conv, outcome, payloads


def _user_notes(payload):
    return [
        m["content"]
        for m in payload["messages"]
        if m["role"] == "user" and "[loop budget]" in (m.get("content") or "")
    ]


# ---------------------------------------------------------------------------
# Remaining-budget turn notes
# ---------------------------------------------------------------------------


def test_no_turn_note_on_first_request():
    conv, outcome, payloads = _loop(
        {"requests": 8, "rounds": 6},
        [_openai_text("done")],
    )
    assert outcome.stop_reason == "no-tool-calls"
    assert _user_notes(payloads[0]) == []
    assert not any(e["kind"] == "turn_note" for e in conv.events)


def test_turn_note_states_remaining_budget_on_later_turns():
    conv, outcome, payloads = _loop(
        {"requests": 8, "rounds": 6},
        [
            _openai_call("c1", "read_file", '{"path": "a"}'),
            _openai_call("c2", "read_file", '{"path": "b"}'),
            _openai_text("done"),
        ],
    )
    assert outcome.stop_reason == "model-stopped"
    # Turn 2: 7 of 8 requests, 5 of 6 rounds remain — still above the pivot.
    notes = _user_notes(payloads[1])
    assert notes == ["[loop budget] 7 of 8 tool request(s) and 5 of 6 turn(s) remain."]
    # Turn 3: 6 of 8 requests remain — still the plain status note.
    assert _user_notes(payloads[2]) == [
        "[loop budget] 6 of 8 tool request(s) and 4 of 6 turn(s) remain."
    ]


def test_low_budget_note_pivots_to_blockers():
    assert LOW_TOOL_REQUESTS_REMAINING == 2
    _, outcome, payloads = _loop(
        {"requests": 4, "rounds": 6},
        [
            _openai_call("c1", "read_file", '{"path": "a"}'),
            _openai_call("c2", "read_file", '{"path": "b"}'),
            _openai_call("c3", "read_file", '{"path": "c"}'),
            _openai_text("done"),
        ],
    )
    assert outcome.stop_reason == "model-stopped"
    # After 2 executed, 2 remain → the low-budget directive appears.
    notes = _user_notes(payloads[2])
    assert len(notes) == 1
    assert "Only 2 tool request(s) and 4 turn(s) remain" in notes[0]
    assert "blocker" in notes[0]
    assert "Stop broad exploration" in notes[0]
    # Turn 2 was still the plain status note (3 of 4 remain).
    assert _user_notes(payloads[1]) == [
        "[loop budget] 3 of 4 tool request(s) and 5 of 6 turn(s) remain."
    ]


def test_budget_exhaustion_stop_reason_and_refusals_unchanged():
    # One round issues 3 calls against a budget of 2: two execute, one is
    # refused with the budget note, and the loop stops on the budget — not on
    # rounds, wall clock, or a model stop.
    multi = {
        "choices": [
            {
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": cid,
                            "type": "function",
                            "function": {"name": "read_file", "arguments": args},
                        }
                        for cid, args in (
                            ("c1", '{"path": "a"}'),
                            ("c2", '{"path": "b"}'),
                            ("c3", '{"path": "c"}'),
                        )
                    ],
                },
            }
        ]
    }
    conv, outcome, payloads = _loop({"requests": 2, "rounds": 6}, [multi])
    assert outcome.stop_reason == STOP_BUDGET
    assert outcome.tool_calls_issued == 3
    assert len(outcome.executed) == 2
    assert len(payloads) == 1
    assert conv.open_tool_call_ids() == set()


# ---------------------------------------------------------------------------
# Wire shapes
# ---------------------------------------------------------------------------


def test_verdict_turn_drops_turn_notes():
    conv = Conversation(system="s")
    conv.add_user("u")
    conv.add_assistant_tool_calls(
        [{"id": "c1", "name": "read_file", "arguments": "{}"}]
    )
    conv.add_tool_result("c1", {"ok": True})
    conv.add_turn_note("[loop budget] 3 of 4 tool request(s) and 2 of 6 turn(s) remain.")

    payload = conv.to_request_payload(
        "openai", "m", verdict_turn=True, keep_full_history_on_verdict=True
    )
    rendered = json.dumps(payload)
    assert "[loop budget]" not in rendered
    # The history itself is intact — only the note is dropped.
    assert any(m["role"] == "tool" for m in payload["messages"])

    # Normal loop turns keep the note.
    loop_payload = conv.to_request_payload("openai", "m")
    assert any(
        m["role"] == "user" and "[loop budget]" in (m.get("content") or "")
        for m in loop_payload["messages"]
    )


def test_openai_turn_note_is_a_user_message_after_tool_results():
    conv = Conversation(system="s")
    conv.add_user("u")
    conv.add_assistant_tool_calls(
        [{"id": "c1", "name": "read_file", "arguments": "{}"}]
    )
    conv.add_tool_result("c1", {"ok": True})
    conv.add_turn_note("[loop budget] note")

    messages = conv._render_openai_messages()
    assert messages[-1] == {"role": "user", "content": "[loop budget] note"}
    assert messages[-2]["role"] == "tool"


def test_anthropic_turn_note_rides_the_tool_result_user_turn():
    conv = Conversation(system="s")
    conv.add_user("u")
    conv.add_assistant_tool_calls(
        [{"id": "c1", "name": "read_file", "arguments": "{}"}]
    )
    conv.add_tool_result("c1", {"ok": True})
    conv.add_turn_note("[loop budget] note")

    messages = conv._render_anthropic_messages()
    # No adjacent user messages: the note is a text block inside the same
    # user turn, after the tool_result block (the documented Anthropic shape).
    user_turns = [m for m in messages if m["role"] == "user"]
    assert len(user_turns) == 2  # the opening user message + the result turn
    blocks = user_turns[-1]["content"]
    assert [b["type"] for b in blocks] == ["tool_result", "text"]
    assert blocks[1]["text"] == "[loop budget] note"


def test_anthropic_turn_note_without_pending_results_is_standalone():
    conv = Conversation(system="s")
    conv.add_user("u")
    conv.add_turn_note("[loop budget] note")
    messages = conv._render_anthropic_messages()
    assert [m["role"] for m in messages] == ["user", "user"]
    assert messages[-1]["content"] == "[loop budget] note"


# ---------------------------------------------------------------------------
# Exhaustion telemetry (harness level)
# ---------------------------------------------------------------------------


class _Executed:
    def __init__(self, tool, status):
        self.tool = tool
        self.args = {"path": "a"}
        self.result = {"status": status}


class _Outcome:
    executed = [_Executed("read_file", "ok")]
    rounds = 2
    tool_calls_issued = 3
    stop_reason = STOP_BUDGET
    final_text = ""
    error = ""


def test_budget_exhaustion_marked_in_harness_markdown_and_json():
    result = {
        "mode": "plan_execute_once",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
    }
    md = rth._summarize_loop_outcome(result, _Outcome())
    assert result["stop_reason"] == STOP_BUDGET
    assert result["budget_exhausted"] is True
    assert "**Tool budget exhausted:**" in md
    assert "not proof that a path is safe" in md


def test_budget_exhaustion_sentence_in_verdict_harness_body():
    body = rth.verdict_harness_findings_body(_Outcome())
    assert "tool budget was exhausted" in body
    assert "never as safe" in body

    class _CleanOutcome(_Outcome):
        stop_reason = "model-stopped"

    clean = rth.verdict_harness_findings_body(_CleanOutcome())
    assert "tool budget was exhausted" not in clean


# ---------------------------------------------------------------------------
# main()-level budget telemetry (missing-corpus path writes the result dict)
# ---------------------------------------------------------------------------


def _main_telemetry(monkeypatch, tmp_path, env):
    for key in (
        "TOOL_MAX_REQUESTS",
        "SMART_TOOL_MAX_REQUESTS",
        "TOOL_ESCALATION",
        "REVIEW_CONTEXT_PROFILE",
        "TOOL_HARNESS_TIER",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("AI_STREAM", "false")
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.chdir(tmp_path)
    assert rth.main() == 0
    stem = (
        "tool-harness.smart"
        if os.environ.get("TOOL_HARNESS_TIER") == "smart"
        else "tool-harness"
    )
    return json.loads((tmp_path / f"{stem}.json").read_text())


def test_primary_tier_telemetry(monkeypatch, tmp_path):
    harness = _main_telemetry(monkeypatch, tmp_path, {})
    assert harness["tool_budget_tier"] == "primary"
    assert harness["tool_request_budget"] == 8


def test_routed_smart_tier_telemetry(monkeypatch, tmp_path):
    harness = _main_telemetry(monkeypatch, tmp_path, {"REVIEW_CONTEXT_PROFILE": "smart"})
    assert harness["tool_budget_tier"] == "smart"
    assert harness["tool_request_budget"] == 16


def test_escalated_tier_telemetry(monkeypatch, tmp_path):
    harness = _main_telemetry(
        monkeypatch,
        tmp_path,
        {"TOOL_HARNESS_TIER": "smart", "TOOL_ESCALATION": "true"},
    )
    assert harness["tool_budget_tier"] == "escalated"
    assert harness["tool_request_budget"] == 20


def test_explicit_override_telemetry(monkeypatch, tmp_path):
    harness = _main_telemetry(monkeypatch, tmp_path, {"TOOL_MAX_REQUESTS": "5"})
    assert harness["tool_request_budget"] == 5