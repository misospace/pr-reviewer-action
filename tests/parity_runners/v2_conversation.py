#!/usr/bin/env python3
"""Replay a declarative conversation fixture against the v2 builder."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pr_reviewer.conversation import Conversation, dedupe_verdict_corpus  # noqa: E402


def main():
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    convo = Conversation(system=fixture.get("system", ""))
    for op in fixture.get("ops", []):
        kind = op["op"]
        if kind == "add_user": convo.add_user(op["content"])
        elif kind == "add_assistant_text": convo.add_assistant_text(op["content"])
        elif kind == "add_assistant_tool_calls": convo.add_assistant_tool_calls(op["calls"])
        elif kind == "add_tool_result": convo.add_tool_result(op["call_id"], op["result"], is_error=op.get("is_error", False), **({"max_bytes": op["max_bytes"]} if "max_bytes" in op else {}))
        elif kind == "add_system_note": convo.add_system_note(op["content"])
        elif kind == "add_turn_note": convo.add_turn_note(op["content"])
        elif kind == "truncate_oldest_tool_results": convo.truncate_oldest_tool_results(op["max_bytes"])
        elif kind == "summarize_oldest_tool_results": convo.summarize_oldest_tool_results(lambda _: op.get("digest", "fixture digest"), keep_newest=op.get("keep_newest", 2))
        else: raise ValueError(f"unknown operation: {kind}")
    option_names = {"maxTokens": "max_tokens", "verdictTurn": "verdict_turn", "keepFullHistoryOnVerdict": "keep_full_history_on_verdict", "responseFormat": "response_format", "tokensParam": "tokens_param", "cachePrefix": "cache_prefix"}
    result = {"payloads": [convo.to_request_payload(item.get("apiFormat", "openai"), item.get("model", "fixture-model"), **{option_names.get(k, k): v for k, v in item.get("options", {}).items()}) for item in fixture.get("emit", [])]}
    introspect = fixture.get("introspect", {})
    if introspect.get("turns"): result["turns"] = convo.turns()
    if introspect.get("open_tool_call_ids"): result["open_tool_call_ids"] = sorted(convo.open_tool_call_ids())
    if introspect.get("approx_tokens"): result["approx_tokens"] = convo.approx_tokens()
    dedup = fixture.get("dedup")
    if dedup: result["dedup"] = {"corpus": dedup["corpus"], "planning": dedup["planning"], "result": dedupe_verdict_corpus(dedup["corpus"], dedup["planning"])}
    print(json.dumps({"ok": True, "values": {"result": result}}, ensure_ascii=False))

if __name__ == "__main__": main()
