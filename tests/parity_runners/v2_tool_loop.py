#!/usr/bin/env python3
"""Deterministic v2 native tool-loop fixture runner."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from pr_reviewer.conversation import Conversation
from pr_reviewer.tool_loop import LoopBudgets, drive_tool_loop

def main():
    f=json.loads(Path(sys.argv[1]).read_text()); c=Conversation(system="fixture system"); c.add_user("fixture user")
    responses=list(f.get("turns", [])); results=[r for t in responses for r in t.get("exec_results", [])]; summarizes=iter((f.get("summarizer") or {}).get("responses", [])); clock=iter(f.get("clock", [0]*100)); requests=[]
    def post(payload):
        requests.append(payload)
        if not responses: raise RuntimeError("scripted response queue exhausted")
        item=responses.pop(0)["response"]
        if isinstance(item,dict) and "raise" in item: raise RuntimeError(item["raise"])
        return item
    def execute(name,args): return results.pop(0)
    def summarize(_): return next(summarizes)
    o=drive_tool_loop(c,post,execute,api_format=f.get("apiFormat","openai"),model=f.get("model","fixture-model"),budgets=LoopBudgets(**f["budgets"]),max_tokens=f.get("options",{}).get("maxTokens",1024),temperature=f.get("options",{}).get("temperature",0),stream=f.get("options",{}).get("stream",False),tokens_param=f.get("options",{}).get("tokensParam","max_tokens"),cache_prefix=f.get("options",{}).get("cachePrefix",False),summarize_fn=summarize if f.get("summarizer") else None,time_fn=lambda: next(clock,0))
    outcome={"rounds":o.rounds,"tool_calls_issued":o.tool_calls_issued,"stop_reason":o.stop_reason,"final_text":o.final_text,"degraded":o.degraded,"error":o.error,"requests_remaining":o.requests_remaining,"tool_result_bytes":o.tool_result_bytes,"compaction_summarize":o.compaction_summarize,"compaction_truncate":o.compaction_truncate,"executed":[{"tool":x.tool,"args":x.args,"status":x.result.get("status")} for x in o.executed]}
    value={"outcome":outcome,"messages":c._render_openai_messages(),"payload_last":requests[-1] if requests else c.to_request_payload(f.get("apiFormat","openai"),f.get("model","fixture-model"))}
    print(json.dumps({"ok":True,"values":{"result":value}},ensure_ascii=False))
if __name__=="__main__":main()
