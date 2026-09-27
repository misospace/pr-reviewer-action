#!/usr/bin/env python3
"""v2 side of the metadata-markers parity boundary (#680).

Runs the REAL production marker boundary for one fixture by sourcing
`scripts/publish_helpers.sh` in a bash subshell with the fixture's env and
calling `build_metadata_marker` / `emit_review_markers`, plus the managed
body filter and reserved-marker stripping from the production modules.

Emits one JSON object: {"ok": true, "values": {case: "marker=...|preamble=...|managed=...|stripped=..."}}
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent.parent / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from strip_metadata_markers import strip_reserved_markers  # noqa: E402


def bash_marker(marker_env: dict[str, str]) -> str | None:
    """Call the production build_metadata_marker via publish_helpers.sh."""
    env = {k: str(v) for k, v in marker_env.items()}
    proc = subprocess.run(
        [
            "bash", "-c",
            f'source "{SCRIPTS_DIR / "publish_helpers.sh"}" && build_metadata_marker "$BASE_SHA"',
        ],
        capture_output=True,
        text=True,
        env={**os.environ, **env},
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"build_metadata_marker failed: {proc.stderr.strip()[-300:]}")
    return proc.stdout.strip()


def bash_preamble(env: dict[str, str]) -> str | None:
    env = {k: str(v) for k, v in env.items()}
    proc = subprocess.run(
        [
            "bash", "-c",
            f'source "{SCRIPTS_DIR / "publish_helpers.sh"}" && emit_review_markers',
        ],
        capture_output=True,
        text=True,
        env={**os.environ, **env},
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"emit_review_markers failed: {proc.stderr.strip()[-300:]}")
    return proc.stdout


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if fixture.get("contract") != "metadata-markers/v1":
        raise RuntimeError("fixture is not metadata-markers/v1")

    values: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="parity-markers-") as td:
        for case in fixture.get("cases") or []:
            parts: list[str] = []
            marker_env = case.get("marker")
            if marker_env:
                env = {
                    "HEAD_SHA": marker_env.get("head_sha", ""),
                    "REVIEW_RESULT": marker_env.get("review_result", ""),
                    "REQUIRED_CHECKS": marker_env.get("required_checks", ""),
                    "REVIEW_ROUTE": marker_env.get("review_route", ""),
                    "ESCALATION_REASON": marker_env.get("escalation_reason", ""),
                    "CACHE_HIT_RATIO": marker_env.get("cache_hit_ratio", ""),
                    "BASE_SHA": marker_env.get("base_sha", ""),
                }
                marker = bash_marker(env)
                parts.append(f"marker={marker}")
                expected = case.get("expected")
                if expected is not None and marker != expected:
                    print(
                        json.dumps({"ok": False, "stderr": f"{case['name']}: marker mismatch"}),
                        file=sys.stdout,
                    )
                    return 0
            preamble_env = case.get("preamble")
            if preamble_env:
                env = {"COMMENT_MARKER": preamble_env.get("comment_marker", "")}
                if preamble_env.get("metadata_marker") is not None:
                    env["METADATA_MARKER"] = preamble_env["metadata_marker"]
                if preamble_env.get("head_sha") is not None:
                    env["HEAD_SHA"] = preamble_env["head_sha"]
                if preamble_env.get("broad_fingerprint") is not None:
                    env["BROAD_FINGERPRINT"] = preamble_env["broad_fingerprint"]
                preamble = bash_preamble(env)
                parts.append(f"preamble={json.dumps(preamble)}")
            managed = case.get("managed_bodies")
            if managed is not None:
                # v2 selection: bodies STARTING with the configured marker or
                # the legacy prefix (the jq startswith filter in cleanup).
                marker = managed[0].get("marker") or "<!-- ai-pr-reviewer -->"
                decisions = []
                for entry in managed:
                    body = entry.get("body") or ""
                    is_managed = body.startswith(marker) or body.startswith("<!-- ai-pr-reviewer")
                    decisions.append("managed" if is_managed else "foreign")
                parts.append(f"managed={','.join(decisions)}")
            strip = case.get("strip")
            if strip is not None:
                parts.append(f"stripped={json.dumps(strip_reserved_markers(strip))}")
            values[case["name"]] = "|".join(parts)

    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001 — runner infrastructure failure
        print(f"v2 metadata-markers runner error: {error}", file=sys.stderr)
        raise SystemExit(1)
