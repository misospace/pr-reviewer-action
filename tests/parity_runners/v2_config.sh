#!/usr/bin/env bash
# v2 side of the config/default-resolution parity boundary (#673).
#
# Replays the production v2 wiring for one fixture:
#   1. action.yml env-block expressions resolved over the fixture's raw inputs
#      (the producer: unset inputs take the action.yml default, explicit ""
#      stays "", `a || b` chains take the first non-empty term, github.*
#      context terms come from the fixture's ambient map, unrecognized
#      step-output expressions are skipped and reported);
#   2. the resolved environment exported into an `env -i` subshell that sources
#      scripts/sections/common.sh + scripts/sections/config.sh (the consumer);
#   3. the post-config values of every contract input's v2 env var dumped as
#      JSON.
#
# Usage: v2_config.sh <fixture.json>
# Emits exactly one JSON object on stdout:
#   {"ok": true, "values": {...}, "unresolved": [...], "stderr": null}
#   {"ok": false, "values": {}, "unresolved": [...], "stderr": "..."}
# A config.sh failure is a *result* (ok:false), not a runner failure; only
# infrastructure problems exit nonzero.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE="$1"

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# Step 1: resolve the action.yml env blocks over the fixture inputs.
python3 - "$FIXTURE" "$ROOT_DIR" "$WORK" <<'PYEOF'
import json
import re
import sys
from pathlib import Path

import yaml

fixture_path, root, work = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
fixture = json.loads(Path(fixture_path).read_text())
raw = {k: str(v) for k, v in fixture.get("raw", {}).items()}
ambient = {k: str(v) for k, v in fixture.get("ambient", {}).items()}
action = yaml.safe_load((root / "action.yml").read_text())
inputs = action.get("inputs") or {}

def resolve_input(vid: str) -> str:
    if vid in raw:
        return raw[vid]
    default = (inputs.get(vid) or {}).get("default")
    return "" if default is None else str(default)

env: dict[str, str] = {}
unresolved: list[str] = []
wrapper = re.compile(r"^\$\{\{\s*(.+?)\s*\}\}$", re.S)
ternary = re.compile(
    r"^inputs\.([a-z_]+)\s*!=\s*''\s*&&\s*inputs\.\1\s*\|\|\s*(.+)$"
)
for step in action.get("runs", {}).get("steps", []):
    for key, expr in (step.get("env") or {}).items():
        match = wrapper.match(str(expr))
        if not match:
            unresolved.append(key)
            continue
        body = match.group(1)
        ternary_match = ternary.match(body)
        if ternary_match:
            terms = [f"inputs.{ternary_match.group(1)}", ternary_match.group(2)]
        else:
            terms = [t.strip() for t in body.split("||")]
        value = ""
        known = True
        for term in terms:
            input_ref = re.fullmatch(r"inputs\.([a-z_]+)", term)
            context_ref = re.fullmatch(r"github\.[A-Za-z0-9_.]+", term)
            if input_ref:
                candidate = resolve_input(input_ref.group(1))
            elif context_ref:
                candidate = ambient.get(term, "")
            elif re.fullmatch(r"''|\"\"", term):
                candidate = ""
            else:
                # Unmodelable term (steps.*, operators): contributes "" like an
                # unset context value; the key is reported as unresolved.
                candidate = ""
                known = False
            if candidate != "":
                value = candidate
                break
        if not known:
            unresolved.append(key)
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            unresolved.append(key)
            continue
        env[key] = value

with open(work / "env.bin", "wb") as stream:
    for key, value in sorted(env.items()):
        stream.write(f"{key}={value}".encode() + b"\0")
(work / "pre.json").write_text(json.dumps(env, sort_keys=True))
meta = {"unresolved": sorted(set(unresolved))}
(work / "meta.json").write_text(json.dumps(meta))
PYEOF

# Step 2 + 3: replay the environment through config.sh in an isolated subshell
# and dump the resolved contract-input surface. The dump is written to a file,
# not stdout: config.sh logs its own progress to stdout and that noise must
# never mix with the result payload.
UNRESOLVED="$(cat "$WORK/meta.json")"
RESULT="$WORK/result.json"
STDERR="$WORK/stderr.log"
if env -i \
    PATH="$PATH" \
    HOME="$WORK" \
    ROOT_DIR="$ROOT_DIR" \
    PARITY_ENV_BIN="$WORK/env.bin" \
    PARITY_PRECONFIG="$WORK/pre.json" \
    PARITY_RESULT="$WORK/v2-dump.json" \
    PARITY_CONTRACT="$ROOT_DIR/contracts/action-v3.yml" \
    bash -c '
      set -euo pipefail
      while IFS= read -r -d "" record; do
        key=${record%%=*}
        [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || { printf "invalid env key: %s\n" "$key" >&2; exit 2; }
        export "$record"
      done < "$PARITY_ENV_BIN"
      cd "$HOME"
      export SCRIPT_DIR="$ROOT_DIR/scripts"
      source "$ROOT_DIR/scripts/sections/common.sh"
      source "$ROOT_DIR/scripts/sections/config.sh"
      python3 "$ROOT_DIR/tests/parity_runners/dump_v2_config.py" >"$PARITY_RESULT"
    ' >/dev/null 2>"$STDERR"; then
  python3 - "$WORK/v2-dump.json" "$UNRESOLVED" <<'PYEOF' >"$RESULT"
import json
import sys

payload = json.loads(open(sys.argv[1]).read())
payload["unresolved"] = json.loads(sys.argv[2])["unresolved"]
payload["stderr"] = None
json.dump(payload, sys.stdout, sort_keys=True)
sys.stdout.write("\n")
PYEOF
else
  STATUS=$?
  python3 - "$UNRESOLVED" "$STATUS" "$STDERR" <<'PYEOF' >"$RESULT"
import json
import sys

stderr = open(sys.argv[3], errors="replace").read()
json.dump(
    {
        "ok": False,
        "values": {},
        "unresolved": json.loads(sys.argv[1])["unresolved"],
        "stderr": stderr,
        "exit_code": int(sys.argv[2]),
    },
    sys.stdout,
    sort_keys=True,
)
sys.stdout.write("\n")
PYEOF
fi

cat "$RESULT"
