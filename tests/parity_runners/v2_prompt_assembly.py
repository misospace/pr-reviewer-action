#!/usr/bin/env python3
"""v2 side of the prompt-assembly parity boundary (#706 PR 4).

Sources the REAL shell functions — ``resolve_system_prompt``,
``apply_system_prompt_fragments``, ``apply_specialist_leads_fragment``
(scripts/sections/config.sh) and ``build_user_message``,
``handle_model_failure``, ``annotate_analysis_engine``
(scripts/sections/review.sh) — sliced verbatim out of the section files,
together with config.sh's own default assignments for the variables they
read. Each fixture runs in a scratch workspace seeded with its files
(presence signals, classification.json, a custom SYSTEM_PROMPT_FILE) under
``set -euo pipefail`` (run_review.sh's mode) with a clean environment that
carries only the fixture's env, and the exact prompt/message bytes are
captured through files.

Usage: v2_prompt_assembly.py <fixture.json>  → one JSON line {ok, values, stderr}
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"

PROMPT_ENV = (
    "SYSTEM_PROMPT", "SYSTEM_PROMPT_FILE", "SYSTEM_PROMPT_MODE",
    "REVIEW_VERBOSITY", "RELATED_CODE_CONTEXT", "PR_THREAD_CONTEXT",
)
ROUTING_ENV = ("REVIEW_ROUTE", "ROUTE_REASON", "ESCALATION_REASONS")
# config.sh default assignments the sliced functions depend on.
DEFAULTED = PROMPT_ENV + ("SYSTEM_PROMPT_ADDENDUM", "ON_MODEL_FAILURE")


def slice_function(source: str, name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?\n\}}\n", source, re.S | re.M)
    if not match:
        raise SystemExit(f"could not slice {name}()")
    return match.group(0)


def slice_defaults(source: str) -> str:
    lines = []
    for name in DEFAULTED:
        match = re.search(rf"^{name}=.*$", source, re.M)
        if not match:
            raise SystemExit(f"config.sh default for {name} not found")
        lines.append(match.group(0))
    return "\n".join(lines) + "\n"


def build_library() -> str:
    common = (SCRIPTS / "sections" / "common.sh").read_text(encoding="utf-8")
    config = (SCRIPTS / "sections" / "config.sh").read_text(encoding="utf-8")
    review = (SCRIPTS / "sections" / "review.sh").read_text(encoding="utf-8")
    parts = [slice_function(common, "log"), slice_function(common, "error")]
    parts += [slice_function(config, n) for n in ("resolve_system_prompt", "apply_system_prompt_fragments", "apply_specialist_leads_fragment")]
    parts += [slice_function(review, n) for n in ("build_user_message", "handle_model_failure", "annotate_analysis_engine")]
    return "\n".join(parts)


def seed(work: Path, files: dict) -> None:
    for name, content in files.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, dict):
            target.write_bytes(base64.b64decode(content["b64"]))
        else:
            target.write_bytes(content.encode("utf-8"))


def base_env(extra: dict) -> dict:
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "PYTHONUTF8": "1",
    }
    env.update({k: str(v) for k, v in extra.items()})
    return env


def run_bash(script: str, env: dict, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "-c", script], cwd=str(cwd), env=env, capture_output=True, timeout=60)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    env_in = {k: v for k, v in (fixture.get("env") or {}).items() if k in PROMPT_ENV}
    unknown = set(fixture.get("env") or {}) - set(PROMPT_ENV)
    if unknown:
        raise SystemExit(f"unsupported fixture env keys: {sorted(unknown)}")
    with tempfile.TemporaryDirectory(prefix="v2-prompt-assembly-") as td:
        tmp = Path(td)
        lib = tmp / "lib.sh"
        lib.write_text(build_library(), encoding="utf-8")
        config = (SCRIPTS / "sections" / "config.sh").read_text(encoding="utf-8")
        defaults = slice_defaults(config)
        prelude = (
            "set -euo pipefail\n"
            f"SCRIPT_DIR={shlex.quote(str(SCRIPTS))}\n"
            f"source {shlex.quote(str(lib))}\n"
            f"{defaults}"
        )
        work = tmp / "work"
        out = tmp / "out"
        work.mkdir()
        out.mkdir()
        seed(work, fixture.get("files") or {})
        calls = int(fixture.get("specialist_leads_calls", 1))
        o = shlex.quote(str(out))
        script = prelude + (
            "resolve_system_prompt\n"
            f"printf '%s' \"${{SYSTEM_PROMPT_IS_DEFAULT:-0}}\" > {o}/is_default\n"
            f"printf '%s' \"$SYSTEM_PROMPT\" > {o}/resolved\n"
            "apply_system_prompt_fragments\n"
            f"printf '%s' \"$SYSTEM_PROMPT\" > {o}/assembled\n"
            f"for ((_i = 0; _i < {calls}; _i++)); do apply_specialist_leads_fragment; done\n"
            f"printf '%s' \"$SYSTEM_PROMPT\" > {o}/final\n"
            "USER_MESSAGE=\"$(build_user_message classification.json)\"\n"
            f"printf '%s' \"$USER_MESSAGE\" > {o}/user_message\n"
        )
        proc = run_bash(script, base_env(env_in), work)
        if proc.returncode != 0:
            print(json.dumps({"ok": False, "values": {}, "stderr": proc.stderr.decode("utf-8", "replace")}))
            return 0

        def read(name: str) -> str:
            return (out / name).read_bytes().decode("utf-8")

        final = read("final")
        user_message = read("user_message")

        notices = []
        for index, case in enumerate(fixture.get("failures") or []):
            case_dir = tmp / f"failure-{index}"
            case_dir.mkdir()
            env = {"REASON_ARG": case["reason"]}
            if "on_model_failure" in case:
                env["ON_MODEL_FAILURE"] = case["on_model_failure"]
            result = run_bash(
                prelude + 'handle_model_failure "$REASON_ARG"\nprintf \'%s\' "$ANALYSIS_ENGINE" > engine.txt\n',
                base_env(env),
                case_dir,
            )
            if result.returncode == 0:
                notices.append({
                    "reason": case["reason"],
                    "action": "notice",
                    "analysis_engine": (case_dir / "engine.txt").read_bytes().decode("utf-8"),
                    "ai_output": (case_dir / "ai-output.json").read_bytes().decode("utf-8"),
                })
            elif result.returncode == 1 and not (case_dir / "ai-output.json").exists():
                notices.append({"reason": case["reason"], "action": "fail", "analysis_engine": "", "ai_output": None})
            else:
                raise SystemExit(f"handle_model_failure exited {result.returncode}: {result.stderr.decode('utf-8', 'replace')}")

        annotations = []
        for index, case in enumerate(fixture.get("engines") or []):
            case_dir = tmp / f"engine-{index}"
            case_dir.mkdir()
            env = {k: v for k, v in (case.get("env") or {}).items() if k in ROUTING_ENV}
            env.update({"ENGINE_ARG": case["engine"], "ORIGIN_ARG": case["origin"]})
            result = run_bash(
                prelude + 'annotate_analysis_engine "$ENGINE_ARG" "$ORIGIN_ARG" > engine.txt\n',
                base_env(env),
                case_dir,
            )
            if result.returncode != 0:
                raise SystemExit(f"annotate_analysis_engine exited {result.returncode}: {result.stderr.decode('utf-8', 'replace')}")
            annotations.append((case_dir / "engine.txt").read_bytes().decode("utf-8"))

        values = {
            "system_prompt_is_default": read("is_default"),
            "system_prompt_resolved": read("resolved"),
            "system_prompt_assembled": read("assembled"),
            "system_prompt": final,
            "system_prompt_sha256": hashlib.sha256((out / "final").read_bytes()).hexdigest(),
            "user_message": user_message,
            "user_message_sha256": hashlib.sha256((out / "user_message").read_bytes()).hexdigest(),
            "failure_notices": notices,
            "engine_annotations": annotations,
        }
    print(json.dumps({"ok": True, "values": values}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
