#!/usr/bin/env python3
"""Parity runner (v2 side, evidence-providers + sarif boundaries, #706 PR 5a).

Runs the REAL v2 evidence phase exactly as the review pipeline does: the
fork-gate block sliced verbatim out of ``scripts/sections/classification.sh``
(``gate_feature_for_forks`` from ``scripts/sections/common.sh``), then the
real ``harvest_advisory_phases`` with its failure fallback. The only change
to the slice is the interpreter target: ``run_evidence_providers.py`` runs
through a shim that freezes the module's monotonic clock, so
``duration_sec`` is deterministic (0.0) on both sides. Provider commands are
real processes (printf/cat/sleep over fixture files) in a throwaway
workspace.

Fixture keys: ``files`` (relpath -> text), ``files_b64`` (relpath -> base64
bytes), ``config`` (JSON value written to ``providers.json`` with
``json.dumps(indent=2)``), ``generate`` (``[{path, bytes, fill, prefix}]``
for oversize inputs), ``env`` (phase environment), ``fork``
(``{is_fork_pr, enable_for_forks}``), ``normalize`` (SARIF paths whose
``normalize_sarif`` artifacts are also dumped).

Prints ``{ok, values}`` in the shape the v3 fixture CLI
(``evidence-providers-fixture``) produces: see src/evidence/fixture.ts.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pr_reviewer.sarif import normalize_sarif  # noqa: E402

GATE_START = 'if gate_feature_for_forks "$EVIDENCE_ENABLE_FOR_FORKS"'
LAUNCH = 'python3 "$SCRIPT_DIR/run_evidence_providers.py"'

SHIM = r'''
import sys, types
sys.path.insert(0, {scripts!r})
sys.path.insert(0, {root!r})
import run_evidence_providers as rep
rep.time = types.SimpleNamespace(monotonic=lambda: 1000.0)
raise SystemExit(rep.main())
'''


def materialize(fixture: dict, workspace: Path) -> None:
    for rel, text in (fixture.get("files") or {}).items():
        target = workspace / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(text.encode("utf-8"))
    for rel, blob in (fixture.get("files_b64") or {}).items():
        target = workspace / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(blob))
    if "config" in fixture:
        (workspace / "providers.json").write_text(
            json.dumps(fixture["config"], indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    for spec in fixture.get("generate") or []:
        prefix = (spec.get("prefix") or "").encode("utf-8")
        fill = (spec.get("fill") or " ").encode("utf-8")
        size = int(spec["bytes"])
        body = prefix + fill * ((size - len(prefix)) // len(fill) + 1)
        (workspace / spec["path"]).write_bytes(body[:size])


def gate_slice() -> str:
    text = (ROOT / "scripts" / "sections" / "classification.sh").read_text(encoding="utf-8")
    start = text.index(GATE_START)
    launch_pid = text.index("EVIDENCE_PID=$!", start)
    end = text.index("\nfi\n", launch_pid) + len("\nfi\n")
    block = text[start:end]
    if block.count(LAUNCH) != 1:
        raise RuntimeError("classification.sh evidence launch line changed; update the parity slice")
    return block.replace(LAUNCH, 'python3 "$PARITY_SHIM"')


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    fork = fixture.get("fork") or {}
    with tempfile.TemporaryDirectory(prefix="v2-evidence-") as td, tempfile.TemporaryDirectory(prefix="v2-evidence-shim-") as sd:
        workspace = Path(td)
        materialize(fixture, workspace)
        shim = Path(sd) / "shim.py"
        shim.write_text(SHIM.format(scripts=str(ROOT / "scripts"), root=str(ROOT)), encoding="utf-8")
        script = "\n".join([
            "set -euo pipefail",
            f"source {json.dumps(str(ROOT / 'scripts' / 'sections' / 'common.sh'))}",
            f"SCRIPT_DIR={json.dumps(str(ROOT / 'scripts'))}",
            "true & ENRICHMENT_PID=$!",
            "true & IMAGE_DIGEST_PID=$!",
            gate_slice(),
            "harvest_advisory_phases",
        ])
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(workspace),
            "GITHUB_WORKSPACE": str(workspace),
            "PARITY_SHIM": str(shim),
            "IS_FORK_PR": str(fork.get("is_fork_pr", "false")),
            "EVIDENCE_ENABLE_FOR_FORKS": str(fork.get("enable_for_forks", "false")),
        }
        env.update({key: str(value) for key, value in (fixture.get("env") or {}).items()})
        proc = subprocess.run(["bash", "-c", script], cwd=workspace, env=env, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            print(json.dumps({"ok": False, "stderr": (proc.stdout + proc.stderr)[-2000:]}))
            return 0
        values = {
            "json": (workspace / "evidence-providers.json").read_text(encoding="utf-8"),
            "markdown": (workspace / "evidence-providers.md").read_text(encoding="utf-8"),
        }
        if fixture.get("normalize"):
            artifacts = [
                normalize_sarif(json.loads((workspace / rel).read_bytes().decode("utf-8-sig")))
                for rel in fixture["normalize"]
            ]
            values["normalized"] = json.dumps(artifacts, indent=2, ensure_ascii=False)
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
