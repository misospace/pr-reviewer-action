#!/usr/bin/env python3
"""Run the real v2 markdown sanitize pipeline for review-sanitize/v1."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sanitize = load_module("sanitize_review_markdown", "sanitize_review_markdown.py")
conditional = load_module("strip_empty_conditional_sections", "strip_empty_conditional_sections.py")
markers = load_module("strip_metadata_markers", "strip_metadata_markers.py")


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if fixture.get("contract") != "review-sanitize/v1":
        raise RuntimeError("fixture is not review-sanitize/v1")
    values: dict[str, str] = {}
    for case in fixture.get("cases", []):
        content = markers.strip_reserved_markers(case["markdown"])
        content = sanitize.sanitize_markdown(content, case["link_mode"])
        presence = {
            "linked_issue": case["presence"]["linked_issue"],
            "evidence_provider": case["presence"]["evidence_provider"],
            "standards": case["presence"]["standards"],
            "tool_harness_findings": case["presence"]["tool_harness_findings"],
            "tool_harness_results": case["presence"]["tool_harness_results"],
        }
        values[case["name"]] = conditional.strip_empty_conditional_sections(content, presence)
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 — runner infrastructure failure
        print(f"v2 sanitize runner error: {error}", file=sys.stderr)
        raise SystemExit(1)
