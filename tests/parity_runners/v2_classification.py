#!/usr/bin/env python3
"""Parity runner (v2 side, classification boundary, #675): runs the real
pr_reviewer.classifier.classify_from_files plus
pr_reviewer.role_selection.select_specialist_roles against a fixture and
prints the canonical classification + selection artifacts for the harness to
compare with the v3 port.

An optional ``role_selection_input`` key feeds the role selector directly
(bypassing the classifier), driving its conservative fallbacks in parity.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.classifier import classify_from_files  # noqa: E402
from pr_reviewer.role_selection import select_specialist_roles  # noqa: E402


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="parity-classification-") as td:
        workdir = Path(td)
        pr_files = workdir / "pr-files.json"
        pr_files.write_text(json.dumps(fixture.get("pr_files") or []), encoding="utf-8")
        diff = workdir / "pr.diff"
        diff.write_text(str(fixture.get("diff") or ""), encoding="utf-8")
        issues = workdir / "linked-issues.json"
        issues.write_text(json.dumps(fixture.get("linked_issues") or []), encoding="utf-8")
        metadata_status = workdir / "linked-metadata-status.json"
        status_present = "metadata_status" in fixture
        metadata_status.write_text(
            json.dumps(fixture.get("metadata_status")) if status_present else "",
            encoding="utf-8",
        )
        output = workdir / "classification.json"

        classification = classify_from_files(
            pr_files_path=pr_files,
            diff_path=diff,
            issues_path=issues,
            output_path=output,
            metadata_status_path=metadata_status if status_present else "",
        )

        if "role_selection_input" in fixture:
            selection = select_specialist_roles(fixture.get("role_selection_input"))
        else:
            selection = select_specialist_roles(json.loads(output.read_text(encoding="utf-8")))

    print(json.dumps({
        "ok": True,
        "values": {
            "classification": canonical(classification.to_dict()),
            "role_selection": canonical(selection),
        },
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
