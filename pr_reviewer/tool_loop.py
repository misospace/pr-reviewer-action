"""Native tool-calling loop driver (#203, umbrella #197 §1 item 3/7).

Drives an agentic exchange against a tool-capable model: send the corpus +
tool schemas, execute the tool calls the model returns, append the results,
and repeat until the model stops calling tools or a budget runs out.

Each turn can be streamed (``stream=True``): the injected ``post_fn`` is
responsible for reassembling the SSE deltas (via
``pr_reviewer.sse_reassembler``) back into the non-streaming response shape
this module parses, so the driver itself stays format-agnostic. Streaming
restores the long-request timeout protection (Cloudflare's 100s edge timer
etc.) that a blocking POST through a proxy loses on long thinking-model
turns; the non-streamed request stays available as the per-turn fallback
the transport falls back to when a stream can't be reassembled (#204).

The module is deliberately I/O-free: the HTTP POST and the tool execution
are injected callables, so the whole loop is unit-testable against scripted
conversations without a model server. ``scripts/run_tool_harness.py`` owns
the real wiring (curl transport + the existing read-only executor with its
allowlists, caps, and timeouts — none of which change here).

Reliability posture (issue #203 comment, Gemma-4-26B-A4B at Tau2 ≈68%):
the loop budgets for repair instead of assuming competence. Malformed
arguments come back as error tool-results the model can react to, duplicate
calls are answered from a dedup note without burning budget, every call id
the model issues gets *some* result before the next request (the
``Conversation.open_tool_call_ids`` contract), and hard caps bound rounds,
total calls, and wall clock. A model that never calls tools at all is
reported as ``degraded`` so the caller can fall back to the
plan_execute_loop planner path.
"""

from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .conversation import Conversation

# Stop reasons (LoopOutcome.stop_reason)
STOP_MODEL_DONE = "model-stopped"
STOP_NO_TOOL_CALLS = "no-tool-calls"
STOP_MAX_ROUNDS = "max-rounds"
STOP_BUDGET = "tool-call-budget-exhausted"
STOP_WALL_CLOCK = "wall-clock-exceeded"
STOP_REQUEST_ERROR = "request-error"

# Synthetic result bodies. These are model-facing: they must explain the
# refusal in one sentence so a self-correcting model has something to act on.
_DUPLICATE_NOTE = (
    "Duplicate request: this exact tool call already ran in this conversation. "
    "Reuse the earlier result instead of repeating the call."
)
_BUDGET_NOTE = (
    "Tool-call budget exhausted: this call was not executed. "
    "Finish the analysis with the evidence you already have."
)


@dataclass
class LoopBudgets:
    """Hard stop conditions. The driver owns these; Conversation's token
    helpers are advisory (see pr_reviewer/conversation.py module docs)."""

    max_tool_calls: int = 4  # total executed calls across rounds (TOOL_MAX_REQUESTS)
    max_rounds: int = 3  # model round-trips (TOOL_MAX_ROUNDS)
    wall_clock_sec: float = 120.0  # whole-loop ceiling (TOOL_LOOP_WALL_CLOCK_SEC)
    # When the conversation outgrows this, the oldest tool results are
    # compacted before the next request (newest results stay intact) — by a
    # model-generated digest when a summarizer is wired, else blunt truncation.
    max_conversation_tokens: int = 24000
    truncated_result_bytes: int = 2000
    # Results kept verbatim when summarizing the rest (the model is actively
    # reasoning over the newest evidence).
    summarize_keep_newest: int = 2


def adaptive_loop_budgets(
    max_rounds: int,
    max_tool_calls: int,
    wall_clock_sec: float,
    *,
    review_route: str = "legacy",
    risk_flag_count: int = 0,
) -> "LoopBudgets":
    """Right-size the loop budget to PR risk (#197 §2: spend research where risk is).

    A native round is one model turn, so the default headroom is 2× the
    configured rounds (capped at 8). When auto-routing sent the PR to the FAST
    tier — which only happens for a low-risk PR, since the route keys off
    ``risk_flags`` — a shallow loop is enough; don't burn the full research
    budget thrashing a trivial diff. A risk flag forces full depth even on the
    fast route (guards a mis-route). Smart/legacy (routing off) keep full depth.
    """
    rounds = min(max(max_rounds, 1) * 2, 8)
    calls = max_tool_calls
    if (review_route or "legacy").strip().lower() == "fast" and risk_flag_count == 0:
        rounds = min(rounds, 2)
        calls = min(calls, 3)
    return LoopBudgets(
        max_tool_calls=calls,
        max_rounds=rounds,
        wall_clock_sec=float(wall_clock_sec),
    )


@dataclass
class ExecutedCall:
    tool: str
    args: dict[str, Any]
    result: dict[str, Any]  # executor shape: {"tool", "status", "result"}


@dataclass
class LoopOutcome:
    executed: list[ExecutedCall] = field(default_factory=list)
    rounds: int = 0
    tool_calls_issued: int = 0  # everything the model asked for, incl. refused
    stop_reason: str = STOP_NO_TOOL_CALLS
    final_text: str = ""
    # True when the model never issued a single tool call: the caller should
    # degrade to the plan_execute_loop planner path (issue #203 spec).
    degraded: bool = False
    error: str = ""


def extract_tool_calls(
    response: dict[str, Any], api_format: str
) -> tuple[list[dict[str, Any]], str]:
    """Pull (tool_calls, text) out of a non-streaming chat response.

    Returned calls are in the flat ``{"id", "name", "arguments"}`` shape that
    ``Conversation.add_assistant_tool_calls`` accepts, with ``arguments``
    kept as an opaque JSON string per the #233 contract. Anthropic
    ``tool_use`` inputs are serialised once at this boundary.
    """
    calls: list[dict[str, Any]] = []
    text_parts: list[str] = []

    if api_format == "anthropic":
        content = response.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    text_parts.append(block["text"])
                elif block.get("type") == "tool_use":
                    call_id = block.get("id")
                    name = block.get("name")
                    if not isinstance(call_id, str) or not isinstance(name, str):
                        continue
                    raw_input = block.get("input")
                    try:
                        arguments = json.dumps(
                            raw_input if raw_input is not None else {},
                            ensure_ascii=False,
                            sort_keys=True,
                        )
                    except (TypeError, ValueError):
                        arguments = str(raw_input)
                    calls.append({"id": call_id, "name": name, "arguments": arguments})
        return calls, "".join(text_parts)

    # OpenAI format
    choices = response.get("choices")
    message: dict[str, Any] = {}
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        maybe = choices[0].get("message")
        if isinstance(maybe, dict):
            message = maybe
    if isinstance(message.get("content"), str):
        text_parts.append(message["content"])
    raw_calls = message.get("tool_calls")
    if isinstance(raw_calls, list):
        for raw in raw_calls:
            if not isinstance(raw, dict):
                continue
            fn = raw.get("function") if isinstance(raw.get("function"), dict) else {}
            call_id = raw.get("id")
            name = fn.get("name") or raw.get("name")
            if not isinstance(call_id, str) or not isinstance(name, str):
                continue
            args = fn.get("arguments")
            if args is None:
                args = raw.get("arguments")
            if not isinstance(args, str):
                try:
                    args = json.dumps(
                        args if args is not None else {},
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                except (TypeError, ValueError):
                    args = str(args)
            calls.append({"id": call_id, "name": name, "arguments": args})
    return calls, "".join(text_parts)


def _request_key(name: str, args: dict[str, Any]) -> str:
    # Mirrors scripts/run_tool_harness.py request_key so dedup behaves the
    # same in both harness modes.
    return f"{name}:{json.dumps(args, sort_keys=True, separators=(',', ':'))}"


def drive_tool_loop(
    conversation: Conversation,
    post_fn: Callable[[dict[str, Any]], dict[str, Any]],
    execute_fn: Callable[[str, dict[str, Any]], dict[str, Any]],
    *,
    api_format: str,
    model: str,
    budgets: LoopBudgets | None = None,
    max_tokens: int = 1024,
    temperature: float = 0.0,
    stream: bool = False,
    tokens_param: str = "max_tokens",
    cache_prefix: bool = False,
    summarize_fn: Callable[[str], str] | None = None,
    time_fn: Callable[[], float] = time.monotonic,
) -> LoopOutcome:
    """Run the agentic loop until the model stops or a budget hits.

    ``post_fn`` takes a wire-ready request payload and returns the parsed
    response JSON (raising on transport failure). When ``stream`` is set the
    payload carries ``stream: true`` and ``post_fn`` owns SSE reassembly,
    handing back the same non-streaming response shape. ``execute_fn`` takes
    ``(tool_name, args)`` and returns the executor result dict
    ``{"tool", "status", "result"}`` — in production this is
    ``run_tool_harness.execute_tool_request`` with allowlists/caps bound in.

    The conversation is mutated in place; on return it carries the full
    transcript (every issued call answered) and can be re-emitted for the
    verdict turn by the caller.
    """
    budgets = budgets or LoopBudgets()
    outcome = LoopOutcome()
    started = time_fn()
    calls_executed = 0
    seen_keys: set[str] = set()

    while outcome.rounds < budgets.max_rounds:
        if time_fn() - started > budgets.wall_clock_sec:
            outcome.stop_reason = STOP_WALL_CLOCK
            break

        # Keep the next request within the advisory context budget by
        # compacting the oldest tool results (newest stay intact). When a
        # summarizer is wired, fold them into a model-generated digest that
        # preserves salient facts; otherwise (or if it frees nothing / fails)
        # fall back to blunt truncation, which is the guaranteed backstop.
        if conversation.approx_tokens() > budgets.max_conversation_tokens:
            summarized = 0
            if summarize_fn is not None:
                try:
                    summarized = conversation.summarize_oldest_tool_results(
                        summarize_fn, keep_newest=budgets.summarize_keep_newest
                    )
                except Exception:  # noqa: BLE001 — summarization is best-effort
                    summarized = 0
            if (
                not summarized
                or conversation.approx_tokens() > budgets.max_conversation_tokens
            ):
                conversation.truncate_oldest_tool_results(
                    budgets.truncated_result_bytes
                )

        payload = conversation.to_request_payload(
            api_format,
            model,
            stream=stream,
            max_tokens=max_tokens,
            temperature=temperature,
            tokens_param=tokens_param,
            cache_prefix=cache_prefix,
        )
        try:
            response = post_fn(payload)
        except Exception as exc:  # noqa: BLE001 — transport errors end the loop
            outcome.stop_reason = STOP_REQUEST_ERROR
            outcome.error = str(exc)
            break

        outcome.rounds += 1
        calls, text = extract_tool_calls(response, api_format)

        if not calls:
            outcome.final_text = text
            outcome.stop_reason = (
                STOP_MODEL_DONE if outcome.tool_calls_issued else STOP_NO_TOOL_CALLS
            )
            break

        if text:
            # Interleaved reasoning text rides along inside the same
            # assistant turn on the wire; Conversation stores it as a
            # separate event, which both renderers merge correctly.
            conversation.add_assistant_text(text)
        conversation.add_assistant_tool_calls(calls)
        outcome.tool_calls_issued += len(calls)

        # Decide each call's disposition SEQUENTIALLY — dedup (seen_keys) and
        # the budget counter are stateful and must stay deterministic and
        # call-ordered. Only the to-run executions are then fanned out
        # concurrently: the executor is read-only and a round's calls are
        # independent (the model emitted them together). Results are applied in
        # the original call order to preserve the open-call contract.
        plan: list[tuple[str, str, Any]] = []  # (call_id, kind, data) in order
        to_execute: dict[int, tuple[str, dict[str, Any]]] = {}
        for idx, call in enumerate(calls):
            call_id = call["id"]
            # Arguments arrive as an opaque JSON string (#233 contract); parse
            # here, and on failure answer with a repairable error instead of
            # crashing the loop — weak models misquote JSON.
            try:
                args = json.loads(call["arguments"]) if call["arguments"] else {}
                if not isinstance(args, dict):
                    raise ValueError("arguments must be a JSON object")
            except (json.JSONDecodeError, ValueError) as exc:
                plan.append(
                    (call_id, "error",
                     {"error": f"Invalid tool arguments (not a JSON object): {exc}"})
                )
                continue

            key = _request_key(call["name"], args)
            if key in seen_keys:
                plan.append((call_id, "dup", {"note": _DUPLICATE_NOTE}))
                continue

            if calls_executed >= budgets.max_tool_calls:
                plan.append((call_id, "budget", {"error": _BUDGET_NOTE}))
                continue

            seen_keys.add(key)
            calls_executed += 1
            to_execute[idx] = (call["name"], args)
            plan.append((call_id, "exec", idx))

        # Fan out the executions (read-only, independent within a round).
        results_by_idx: dict[int, dict[str, Any]] = {}
        if len(to_execute) == 1:
            (only_idx, (name, args)), = to_execute.items()
            results_by_idx[only_idx] = execute_fn(name, args)
        elif to_execute:
            with ThreadPoolExecutor(max_workers=min(len(to_execute), 8)) as pool:
                futures = {
                    pool.submit(execute_fn, name, args): i
                    for i, (name, args) in to_execute.items()
                }
                for fut in futures:
                    results_by_idx[futures[fut]] = fut.result()

        # Apply results in call order (synthetic refusals inline).
        for call_id, kind, data in plan:
            if kind != "exec":
                conversation.add_tool_result(call_id, data, is_error=True)
                continue
            name, args = to_execute[data]
            result = results_by_idx[data]
            outcome.executed.append(
                ExecutedCall(tool=name, args=args, result=result)
            )
            conversation.add_tool_result(
                call_id,
                result.get("result", {}),
                is_error=result.get("status") != "ok",
            )

        if calls_executed >= budgets.max_tool_calls:
            outcome.stop_reason = STOP_BUDGET
            break
    else:
        outcome.stop_reason = STOP_MAX_ROUNDS

    outcome.degraded = outcome.tool_calls_issued == 0
    return outcome
