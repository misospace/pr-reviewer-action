"""#702: native-loop budget telemetry.

Covers:
  - the LoopOutcome telemetry fields drive_tool_loop fills on every exit
    path (requests remaining, elapsed, effective ceilings, result bytes,
    compaction occurrences);
  - the namespaced ``tool_loop_telemetry`` object build_tool_loop_telemetry
    assembles in its two shapes — ``phase: "loop"`` (meta-stash fold, and
    that the raw stash never reaches the artifact) and ``phase:
    "pre-loop"`` (missing-corpus / missing-config aborts reported
    explicitly with zero loop activity);
  - the flat budget-provenance keys main() writes on every path;
  - the deterministic summarizer aggregates — including the aggregate
    denominator behavior: pre-loop aborts count as runs and in the
    stop-reason distribution, while loop-behavior rates stay scoped to
    ``loop_runs`` — in scripts/summarize_tool_loop_telemetry.py.
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
    STOP_BUDGET,
    STOP_MODEL_DONE,
    STOP_NO_TOOL_CALLS,
    LoopBudgets,
    drive_tool_loop,
)
from summarize_tool_loop_telemetry import (  # noqa: E402
    percentile,
    summarize,
    render_markdown,
)

import pytest  # noqa: E402


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


def _loop(budget, responses, execute_result=None, summarize_fn=None, time_values=None):
    """Drive the loop with a scripted transport; return (conv, outcome)."""
    queue = list(responses)

    def post(payload):
        assert queue, "model called more times than scripted"
        return queue.pop(0)

    conv = Conversation(system="gather evidence")
    conv.add_user("review this PR")

    def execute(name, args):
        return execute_result or {"tool": name, "status": "ok", "result": {"content": "evidence"}}

    times = list(time_values) if time_values is not None else None

    def time_fn():
        if times is None:
            import time

            return time.monotonic()
        return times.pop(0) if times else (times[-1] if times else 0.0)

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
        summarize_fn=summarize_fn,
        time_fn=time_fn,
    )
    return conv, outcome


# ---------------------------------------------------------------------------
# Loop-level telemetry fields
# ---------------------------------------------------------------------------


def test_voluntary_stop_reports_remaining_and_echoes_budget():
    _, outcome = _loop(
        {"requests": 8, "rounds": 6},
        [_openai_call("c1", "read_file", '{"path": "a.txt"}'), _openai_text("done")],
    )
    assert outcome.stop_reason == STOP_MODEL_DONE
    assert outcome.requests_remaining == 7
    assert outcome.max_tool_calls == 8
    assert outcome.max_rounds == 6
    assert outcome.wall_clock_sec == 120.0
    assert outcome.elapsed_sec >= 0.0
    assert outcome.tool_result_bytes > 0
    assert outcome.compaction_summarize == 0
    assert outcome.compaction_truncate == 0


def test_budget_exhaustion_reports_zero_remaining():
    _, outcome = _loop(
        {"requests": 1, "rounds": 6},
        [_openai_call("c1", "read_file", '{"path": "a.txt"}'), _openai_call("c2", "read_file", '{"path": "b.txt"}')],
    )
    assert outcome.stop_reason == STOP_BUDGET
    assert outcome.requests_remaining == 0


def test_no_tool_calls_reports_full_budget():
    _, outcome = _loop(
        {"requests": 8, "rounds": 6},
        [_openai_text("no tools needed")],
    )
    assert outcome.stop_reason == STOP_NO_TOOL_CALLS
    assert outcome.requests_remaining == 8
    assert outcome.tool_result_bytes == 0


def test_compaction_occurrences_are_counted():
    # A tiny conversation budget forces the compaction block every round.
    # With no tool results yet, the summarizer has nothing to fold (returns
    # 0) so the blunt-truncation backstop fires instead.
    _, outcome = _loop(
        {"requests": 8, "rounds": 6},
        [_openai_text("done")],
    )
    conv, summarize_calls = Conversation(system="s"), []

    def summarizer(block):
        summarize_calls.append(block)
        return "digest"

    conv.add_user("x" * 400)
    budgets = LoopBudgets(max_tool_calls=8, max_rounds=6, max_conversation_tokens=1)
    outcome = drive_tool_loop(
        conv,
        lambda payload: _openai_text("done"),
        lambda name, args: {"tool": name, "status": "ok", "result": {}},
        api_format="openai",
        model="m",
        budgets=budgets,
        summarize_fn=summarizer,
    )
    assert outcome.compaction_truncate >= 1
    assert outcome.compaction_summarize == 0


# ---------------------------------------------------------------------------
# build_tool_loop_telemetry
# ---------------------------------------------------------------------------


def _finished_result(**overrides):
    result = {
        "mode": "native_loop",
        "planned_request_count": 4,
        "executed_request_count": 3,
        "tool_results": [{}, {}, {}],
        "tool_calls": [
            {"tool": "read_file", "args": {}, "status": "ok"},
            {"tool": "git_grep", "args": {}, "status": "ok"},
            {"tool": "web_fetch", "args": {}, "status": "error"},
        ],
        "rounds": 3,
        "stop_reason": "model-stopped",
        "tool_budget_tier": "smart",
        "tool_request_budget": 16,
        "tool_budget_source": "tier-default",
        "tool_budget_configured": None,
        "native_loop_verdict_produced": True,
        "native_loop_verdict_status": "accepted",
        "native_loop_verdict_transport": "streamed",
        "tool_loop_meta": {
            "requests_remaining": 12,
            "max_rounds": 6,
            "wall_clock_sec": 120.0,
            "elapsed_sec": 42.123456,
            "tool_result_bytes": 9001,
            "compaction_summarize": 0,
            "compaction_truncate": 1,
        },
    }
    result.update(overrides)
    return result


def test_telemetry_shape_version_1():
    result = _finished_result()
    telemetry = rth.build_tool_loop_telemetry(result)
    assert telemetry["version"] == 1
    assert telemetry["route"] == "smart"
    assert telemetry["budget"] == {
        "source": "tier-default",
        "effective_max_requests": 16,
        "configured_max_requests": None,
        "max_rounds": 6,
        "wall_clock_sec": 120.0,
    }
    assert telemetry["usage"] == {
        "tool_calls_issued": 4,
        "tool_calls_executed": 3,
        "rounds_used": 3,
        "requests_remaining_at_stop": 12,
        "elapsed_sec": 42.123,
        "tool_result_bytes": 9001,
    }
    assert telemetry["compaction"] == {"summarize": 0, "truncate": 1}
    assert telemetry["stop_reason"] == "model-stopped"
    assert telemetry["budget_exhausted"] is False
    assert telemetry["degraded"] is False
    assert telemetry["escalated"] is False
    assert telemetry["verdict"] == {"produced": True, "status": "accepted", "reason": ""}


def test_telemetry_consumes_meta_stash():
    result = _finished_result()
    rth.build_tool_loop_telemetry(result)
    assert "tool_loop_meta" not in result


def test_telemetry_none_without_loop_or_failure():
    # No loop meta AND no pre-loop failure marker: nothing to report.
    assert rth.build_tool_loop_telemetry({"mode": "off"}) is None


def test_pre_loop_telemetry_missing_corpus():
    result = {
        "mode": "off",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
        "tool_budget_tier": "primary",
        "tool_request_budget": 8,
        "tool_budget_source": "tier-default",
        "tool_budget_configured": None,
        "planning_error": "Missing review-corpus.truncated.md",
    }
    telemetry = rth.build_tool_loop_telemetry(result)
    assert telemetry["version"] == 1
    assert telemetry["phase"] == "pre-loop"
    assert telemetry["route"] == "primary"
    assert telemetry["budget"]["source"] == "tier-default"
    assert telemetry["budget"]["effective_max_requests"] == 8
    assert telemetry["budget"]["configured_max_requests"] is None
    assert telemetry["usage"] == {
        "tool_calls_issued": 0,
        "tool_calls_executed": 0,
        "rounds_used": 0,
        "requests_remaining_at_stop": 8,
        "elapsed_sec": 0.0,
        "tool_result_bytes": 0,
    }
    assert telemetry["compaction"] == {"summarize": 0, "truncate": 0}
    assert telemetry["stop_reason"] == "harness-abort"
    assert telemetry["failure"] == "missing-corpus"
    assert telemetry["budget_exhausted"] is False
    assert telemetry["degraded"] is False
    assert telemetry["verdict"] == {"produced": False, "status": "", "reason": ""}


def test_pre_loop_telemetry_missing_config():
    result = {
        "mode": "off",
        "planned_request_count": 0,
        "executed_request_count": 0,
        "tool_results": [],
        "tool_budget_tier": "escalated",
        "tool_request_budget": 5,
        "tool_budget_source": "explicit",
        "tool_budget_configured": 5,
        "error": "Missing REPO, AI_BASE_URL, or AI_MODEL",
        "stop_reason": "request-error",
    }
    telemetry = rth.build_tool_loop_telemetry(result)
    assert telemetry["phase"] == "pre-loop"
    assert telemetry["route"] == "escalated"
    assert telemetry["escalated"] is True
    assert telemetry["failure"] == "missing-config"
    assert telemetry["stop_reason"] == "harness-abort"
    assert telemetry["budget"]["source"] == "explicit"
    assert telemetry["usage"]["requests_remaining_at_stop"] == 5


def test_loop_telemetry_carries_phase():
    telemetry = rth.build_tool_loop_telemetry(_finished_result())
    assert telemetry["phase"] == "loop"
    assert "failure" not in telemetry


def test_telemetry_degraded_run():
    result = _finished_result(
        planned_request_count=0,
        tool_calls=None,
        rounds=1,
        stop_reason="no-tool-calls",
        native_loop_degraded="no-tool-calls",
    )
    result.pop("native_loop_verdict_produced")
    result.pop("native_loop_verdict_status")
    telemetry = rth.build_tool_loop_telemetry(result)
    assert telemetry["degraded"] is True
    assert telemetry["usage"]["tool_calls_executed"] == 0
    assert telemetry["usage"]["tool_calls_issued"] == 0
    assert telemetry["verdict"] == {"produced": False, "status": "", "reason": ""}


def test_telemetry_exhausted_escalated_fallback():
    result = _finished_result(
        stop_reason="tool-call-budget-exhausted",
        budget_exhausted=True,
        tool_budget_tier="escalated",
        native_loop_verdict_status="fallback",
        native_loop_verdict_reason="parse",
    )
    result.pop("native_loop_verdict_produced")
    telemetry = rth.build_tool_loop_telemetry(result)
    assert telemetry["budget_exhausted"] is True
    assert telemetry["escalated"] is True
    assert telemetry["verdict"]["produced"] is False
    assert telemetry["verdict"]["status"] == "fallback"
    assert telemetry["verdict"]["reason"] == "parse"


def test_write_outputs_embeds_telemetry(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TOOL_HARNESS_TIER", raising=False)
    result = _finished_result()
    rth.write_outputs(result, "# Tool Harness Results")
    artifact = json.loads((tmp_path / "tool-harness.json").read_text())
    assert artifact["tool_loop_telemetry"]["version"] == 1
    assert "tool_loop_meta" not in artifact


# ---------------------------------------------------------------------------
# Budget provenance (resolve_tool_budget)
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_budget_env(monkeypatch):
    for key in (
        "TOOL_MAX_REQUESTS",
        "SMART_TOOL_MAX_REQUESTS",
        "TOOL_ESCALATION",
        "REVIEW_CONTEXT_PROFILE",
        "TOOL_HARNESS_TIER",
        "AI_STREAM",
    ):
        monkeypatch.delenv(key, raising=False)


def test_resolve_tool_budget_tier_default(monkeypatch):
    details = rth.resolve_tool_budget("primary")
    assert details == {
        "route": "primary",
        "budget": 8,
        "source": "tier-default",
        "configured": None,
    }


def test_resolve_tool_budget_explicit(monkeypatch):
    monkeypatch.setenv("TOOL_MAX_REQUESTS", "5")
    details = rth.resolve_tool_budget("primary")
    assert details["source"] == "explicit"
    assert details["configured"] == 5
    assert details["budget"] == 5


def test_resolve_tool_budget_smart_override(monkeypatch):
    monkeypatch.setenv("TOOL_HARNESS_TIER", "smart")
    monkeypatch.setenv("SMART_TOOL_MAX_REQUESTS", "10")
    monkeypatch.setenv("TOOL_MAX_REQUESTS", "3")
    details = rth.resolve_tool_budget("smart")
    assert details["route"] == "smart"
    assert details["source"] == "smart-override"
    assert details["configured"] == 10


def test_resolve_tool_budget_invalid_falls_to_tier_default(monkeypatch):
    monkeypatch.setenv("TOOL_MAX_REQUESTS", "abc")
    details = rth.resolve_tool_budget("smart")
    assert details["source"] == "tier-default"
    assert details["configured"] is None
    assert details["budget"] == 16


def test_resolve_tool_max_requests_stays_int(monkeypatch):
    monkeypatch.setenv("TOOL_MAX_REQUESTS", "5")
    assert rth.resolve_tool_max_requests("primary") == 5


def test_main_flat_provenance_keys(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_STREAM", "false")
    monkeypatch.setenv("TOOL_MAX_REQUESTS", "5")
    monkeypatch.chdir(tmp_path)
    assert rth.main() == 0
    artifact = json.loads((tmp_path / "tool-harness.json").read_text())
    assert artifact["tool_budget_tier"] == "primary"
    assert artifact["tool_request_budget"] == 5
    assert artifact["tool_budget_source"] == "explicit"
    assert artifact["tool_budget_configured"] == 5
    # The loop never ran (no corpus): the abort is reported explicitly,
    # never as loop activity.
    telemetry = artifact["tool_loop_telemetry"]
    assert telemetry["phase"] == "pre-loop"
    assert telemetry["failure"] == "missing-corpus"
    assert telemetry["stop_reason"] == "harness-abort"
    assert telemetry["usage"]["tool_calls_executed"] == 0


def test_main_missing_config_telemetry(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_STREAM", "false")
    monkeypatch.chdir(tmp_path)
    # The corpus check runs first; satisfy it so the config check is what aborts.
    (tmp_path / "review-corpus.truncated.md").write_text("# corpus\n")
    assert rth.main() == 0
    artifact = json.loads((tmp_path / "tool-harness.json").read_text())
    telemetry = artifact["tool_loop_telemetry"]
    assert telemetry["phase"] == "pre-loop"
    assert telemetry["failure"] == "missing-config"
    assert telemetry["route"] == "primary"
    assert telemetry["budget"]["effective_max_requests"] == 8
    assert telemetry["verdict"] == {"produced": False, "status": "", "reason": ""}


def test_main_smart_tier_abort_keeps_route(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_STREAM", "false")
    monkeypatch.setenv("TOOL_HARNESS_TIER", "smart")
    monkeypatch.chdir(tmp_path)
    assert rth.main() == 0
    artifact = json.loads((tmp_path / "tool-harness.smart.json").read_text())
    telemetry = artifact["tool_loop_telemetry"]
    assert telemetry["phase"] == "pre-loop"
    assert telemetry["route"] == "smart"
    assert telemetry["budget"]["effective_max_requests"] == 16


# ---------------------------------------------------------------------------
# Summarizer
# ---------------------------------------------------------------------------


def _record(route, executed, remaining, effective, stop, exhausted=False, produced=False, phase="loop", failure=None):
    record = {
        "version": 1,
        "phase": phase,
        "route": route,
        "budget": {"effective_max_requests": effective},
        "usage": {"tool_calls_executed": executed, "requests_remaining_at_stop": remaining},
        "stop_reason": stop,
        "budget_exhausted": exhausted,
        "verdict": {"produced": produced},
    }
    if failure is not None:
        record["failure"] = failure
    return record


def test_summarizer_aggregates_by_route():
    report = summarize(
        [
            _record("primary", 3, 5, 8, "model-stopped", produced=True),
            _record("primary", 8, 0, 8, "tool-call-budget-exhausted", exhausted=True, produced=True),
            _record("smart", 16, 0, 16, "tool-call-budget-exhausted", exhausted=True, produced=False),
            _record("smart", 2, 14, 16, "model-stopped", produced=True),
        ]
    )
    assert report["runs"] == 4
    primary = report["by_route"]["primary"]
    assert primary["runs"] == 2
    assert primary["exhaustion"] == {"count": 1, "rate": 0.5}
    assert primary["tool_calls_executed"]["p50"] == 5.5
    assert primary["exhausted_usable_verdict"] == {"count": 1, "rate": 1.0}
    assert primary["voluntary_headroom"] == {
        "voluntary_stops": 1,
        "with_at_least_25pct_remaining": 1,
        "rate": 1.0,
    }
    smart = report["by_route"]["smart"]
    assert smart["exhaustion"]["rate"] == 0.5
    assert smart["voluntary_headroom"]["rate"] == 1.0  # 14/16 >= 25%
    overall = report["overall"]
    assert overall["runs"] == 4
    assert overall["exhaustion"]["count"] == 2
    assert overall["stop_reasons"] == {
        "model-stopped": 2,
        "tool-call-budget-exhausted": 2,
    }


def test_summarizer_headroom_excludes_never_engaged_runs():
    report = summarize(
        [_record("primary", 0, 8, 8, "no-tool-calls")]
    )
    assert report["by_route"]["primary"]["voluntary_headroom"]["voluntary_stops"] == 0
    assert report["by_route"]["primary"]["stop_reasons"] == {"no-tool-calls": 1}


def test_summarizer_deterministic():
    records = [
        _record("smart", 12, 4, 16, "model-stopped", produced=True),
        _record("primary", 8, 0, 8, "tool-call-budget-exhausted", exhausted=True),
        _record("escalated", 20, 0, 20, "tool-call-budget-exhausted", exhausted=True, produced=True),
    ]
    one = summarize(records)
    two = summarize(list(reversed(records)))
    assert json.dumps(one, sort_keys=True) == json.dumps(two, sort_keys=True)
    assert render_markdown(one, 0) == render_markdown(two, 0)


def test_summarizer_unknown_route_is_visible_not_fatal():
    report = summarize([_record("weird", 1, 7, 8, "model-stopped")])
    assert report["by_route"]["unknown"]["runs"] == 1
    assert report["runs"] == 1


def test_summarizer_counts_pre_loop_aborts_as_runs_not_loop_activity():
    report = summarize(
        [
            _record("primary", 4, 4, 8, "model-stopped", produced=True),
            _record("primary", 0, 8, 8, "harness-abort", phase="pre-loop", failure="missing-corpus"),
            _record("primary", 0, 8, 8, "harness-abort", phase="pre-loop", failure="missing-config"),
        ]
    )
    primary = report["by_route"]["primary"]
    # The aborts are in the run count and the stop-reason distribution...
    assert primary["runs"] == 3
    assert report["overall"]["stop_reasons"] == {
        "harness-abort": 2,
        "model-stopped": 1,
    }
    # ...but are never loop activity: loop-scoped metrics see one run.
    assert primary["loop_runs"] == 1
    assert primary["exhaustion"] == {"count": 0, "rate": 0.0}
    # p50/p90 exclude the fabricated zeros of runs that never started.
    assert primary["tool_calls_executed"] == {"p50": 4.0, "p90": 4.0}


def test_summarizer_exhaustion_rate_denominator_is_loop_runs():
    report = summarize(
        [
            _record("smart", 16, 0, 16, "tool-call-budget-exhausted", exhausted=True),
            _record("smart", 0, 16, 16, "harness-abort", phase="pre-loop", failure="missing-corpus"),
            _record("smart", 0, 16, 16, "harness-abort", phase="pre-loop", failure="missing-config"),
        ]
    )
    smart = report["by_route"]["smart"]
    assert smart["runs"] == 3
    assert smart["loop_runs"] == 1
    assert smart["exhaustion"] == {"count": 1, "rate": 1.0}


def test_summarizer_legacy_records_without_phase_are_loop_runs():
    legacy = _record("primary", 2, 6, 8, "model-stopped")
    del legacy["phase"]
    report = summarize([legacy])
    assert report["by_route"]["primary"]["loop_runs"] == 1
    assert report["by_route"]["primary"]["tool_calls_executed"]["p50"] == 2.0


def test_summarizer_headroom_excludes_pre_loop_runs():
    # A pre-loop record's full remaining budget must not read as a
    # voluntary stop with 100% headroom.
    report = summarize(
        [_record("primary", 0, 8, 8, "harness-abort", phase="pre-loop", failure="missing-config")]
    )
    assert report["by_route"]["primary"]["voluntary_headroom"]["voluntary_stops"] == 0


def test_percentile_basics():
    assert percentile([], 0.5) is None
    assert percentile([5], 0.9) == 5.0
    assert percentile([1, 2, 3, 4], 0.5) == 2.5
    assert percentile([10, 20], 0.0) == 10.0
    assert percentile([10, 20], 1.0) == 20.0


def test_markdown_advisory_fires_above_band():
    hot = summarize([_record("smart", 16, 0, 16, "tool-call-budget-exhausted", exhausted=True)])
    quiet = summarize([_record("smart", 2, 14, 16, "model-stopped")])
    assert "reevaluate the smart default" in render_markdown(hot, 0)
    assert "within the 15% advisory band" in render_markdown(quiet, 0)
