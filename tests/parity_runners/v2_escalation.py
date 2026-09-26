#!/usr/bin/env python3
"""Run v2 escalation decisions over in-memory fixture records."""
import json, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; sys.path.insert(0,str(ROOT))
from pr_reviewer.escalation import reviewer_requested_escalation, should_escalate, is_low_confidence

def main():
 f=json.loads(Path(sys.argv[1]).read_text())
 with tempfile.TemporaryDirectory() as td:
  p=Path(td); names=("ai-output.json","classification.json","evidence-providers.json","tool-harness.json")
  for name,key in zip(names,("output","classification","evidence","harness")): (p/name).write_text(json.dumps(f.get(key,{})))
  requested,reason=reviewer_requested_escalation(str(p/names[0]))
  flags=f.get("flags",{})
  escalate,reasons=should_escalate(on_incomplete=flags.get("on_incomplete",False),on_request_changes=flags.get("on_request_changes",True),on_low_confidence=flags.get("on_low_confidence",True),on_blockers=flags.get("on_blockers",True),on_planning_failure=flags.get("on_planning_failure",False),output_path=str(p/names[0]),classification_path=str(p/names[1]),evidence_path=str(p/names[2]),tool_harness_path=str(p/names[3]))
  output=f.get("output",{}); low=is_low_confidence(str(output.get("review_markdown") or ""))
 print(json.dumps({"ok":True,"values":{"result":{"requested":requested,"reason":reason,"escalate":escalate,"reasons":reasons,"low_confidence":low}}},ensure_ascii=False))
if __name__=="__main__":main()
