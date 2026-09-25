#!/usr/bin/env bash
# v2 side of the corpus-assembly parity boundary (#676).
#
# Drives the production corpus.sh pipeline over one fixture: the assembly
# code is sliced verbatim out of scripts/sections/{config,common,corpus}.sh by
# v2_corpus_slicer.py (same technique as truncate_clean.sh), the orchestrator
# seams the slices reference are stubbed, the tool harness is simulated at
# its exact invocation seam, and the resulting workspace artifacts are
# compared byte-for-byte with the v3 TypeScript assembly.
#
# Failure semantics are production-faithful: run_review.sh executes the
# corpus pipeline under `set -euo pipefail`, so a failed pipeline build
# (malformed pr.json / classification.json, jq type error) aborts the review —
# the runner models that with fail-closed subshells and reports the captured
# stderr instead of artifacts. Only the explicit extra calls — which model the
# escalation call site, where a failed smart build gracefully keeps the
# primary review — record a status, including the over-budget guard.
#
# Usage: v2_corpus.sh <fixture.json>   → prints one JSON line {ok, values, stderr}
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="$1"
SLICES="$(mktemp -d)"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$SLICES" "$WORK"' EXIT

python3 "$ROOT/tests/parity_runners/v2_corpus_slicer.py" "$ROOT" "$SLICES"

# ---------------------------------------------------------------------------
# Fixture setup: seed the scratch workspace and export the fixture's env.
# ---------------------------------------------------------------------------
SETUP_RC=0
python3 - "$FIXTURE" "$WORK" > "$WORK/fixture_env.sh" 2> "$WORK/setup_stderr.txt" <<'PY' || SETUP_RC=$?
import base64
import json
import shlex
import sys
from pathlib import Path

fixture_path, work = Path(sys.argv[1]), Path(sys.argv[2])
fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

env = fixture.get("env") or {}
context = fixture.get("context") or {}
simulate = fixture.get("simulate_harness") or {}


def decode_content(content):
    """Plain strings are UTF-8 text; {"b64": ...} carries exact bytes."""
    if isinstance(content, str):
        return content.encode("utf-8")
    if isinstance(content, dict) and isinstance(content.get("b64"), str):
        return base64.b64decode(content["b64"])
    return (content or {}).get("text", "").encode("utf-8")

assignments = {
    "TOOL_MODE": env.get("tool_mode", ""),
    "STANDARDS_FILE": env.get("standards_file", ""),
    "CI_CHECKS_FILE": env.get("ci_checks_file", ""),
    "REVIEW_CONTEXT_PROFILE": context.get("review_context_profile", ""),
    "CI_GATE_ACTIVE": context.get("ci_gate_active", ""),
    "IS_FORK_PR": env.get("is_fork_pr", ""),
    "TOOL_ENABLE_FOR_FORKS": env.get("tool_enable_for_forks", ""),
    "REPO_MAP_MAX_BYTES": env.get("repo_map_max_bytes", ""),
    "MODEL_CONTEXT_TOKENS": context.get("model_context_tokens", ""),
    "PRIMARY_MODEL_CONTEXT_TOKENS": context.get("primary_model_context_tokens", ""),
    "SMART_MODEL_CONTEXT_TOKENS": context.get("smart_model_context_tokens", ""),
    "AI_MAX_TOKENS": context.get("ai_max_tokens", ""),
    "CONTEXT_LIMIT_MODE": context.get("context_limit_mode", ""),
    "SIMULATE_HARNESS_MODE": simulate.get("mode", ""),
    "EXTRA_CALLS": " ".join(
        f"{call.get('tier', 'primary')}/{call.get('slot', 'primary')}"
        for call in (fixture.get("extra_calls") or [])
    ),
    "STOP_AFTER": fixture.get("stop_after", ""),
}
for key, value in assignments.items():
    print(f"{key}={shlex.quote(value)}")

for name, content in (fixture.get("files") or {}).items():
    target = work / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(decode_content(content))

for name, content in (simulate.get("files") or {}).items():
    target = work / ".simulate" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(decode_content(content))

swap = fixture.get("harness_section_swap") or {}
if swap:
    (work / "swap-corpus.input").write_bytes(decode_content(swap["corpus"]))
    (work / "swap-body.input").write_bytes(decode_content(swap["body"]))
PY

if [ "$SETUP_RC" -ne 0 ]; then
  printf '{"ok": false, "stderr": "fixture setup failed"}\n'
  exit 0
fi

set -a
# shellcheck source=/dev/null
source "$WORK/fixture_env.sh"
set +a
# Defaults config.sh would have applied before the sliced ranges.
REPO_MAP_MAX_BYTES="${REPO_MAP_MAX_BYTES:-12000}"

# ---------------------------------------------------------------------------
# Budget resolution: the config.sh slice runs its own `|| exit 1` guards, so
# it resolves in a subshell whose status and stderr are captured. On failure
# the v2 pipeline never reaches corpus assembly.
# ---------------------------------------------------------------------------
# shellcheck source=/dev/null
source "$SLICES/log_error.sh"

budgets_ok=0
BUDGET_OUT="$(cd "$WORK" && SLICES="$SLICES" bash -c '
  AI_MAX_TOKENS="${AI_MAX_TOKENS:-8192}"
  PRIMARY_REQUEST_SHAPE="${PRIMARY_REQUEST_SHAPE:-default}"
  SMART_REQUEST_SHAPE="${SMART_REQUEST_SHAPE:-default}"
  log() { :; }
  error() { printf "[%s] ERROR: %s\n" "$(date +%Y-%m-%dT%H:%M:%S%z)" "$1" >&2; }
  # shellcheck source=/dev/null
  source "$SLICES/budgets.sh"
  printf "%s %s %s %s %s %s" "$PRIMARY_MAX_CORPUS" "$PRIMARY_MAX_DIFF" "$PRIMARY_MAX_FILES" \
    "$SMART_MAX_CORPUS" "$SMART_MAX_DIFF" "$SMART_MAX_FILES"
' 2>"$WORK/budget_stderr.txt")" || budgets_ok=$?

if [ "$budgets_ok" -ne 0 ]; then
  BUDGET_STDERR="$(cat "$WORK/budget_stderr.txt")" python3 - <<'PY'
import json
import os

print(json.dumps({"ok": False, "stderr": os.environ["BUDGET_STDERR"].strip()}, ensure_ascii=False))
PY
  exit 0
fi

read -r PRIMARY_MAX_CORPUS PRIMARY_MAX_DIFF PRIMARY_MAX_FILES \
        SMART_MAX_CORPUS SMART_MAX_DIFF SMART_MAX_FILES <<<"$BUDGET_OUT"

# A failed pipeline build aborts the production review; report the captured
# stderr as the failure artifact instead of any workspace state.
emit_failure() {
  PIPELINE_STDERR="$PIPELINE_STDERR" python3 - <<'PY'
import json
import os
from pathlib import Path

stderr = Path(os.environ["PIPELINE_STDERR"]).read_text(encoding="utf-8", errors="replace").strip()
print(json.dumps({"ok": False, "stderr": stderr[-2000:]}, ensure_ascii=False))
PY
}

# ---------------------------------------------------------------------------
# Emit the values JSON: final workspace state, statuses, budgets, swap.
# ---------------------------------------------------------------------------
emit_values() {
STATUS_INITIAL="$STATUS_INITIAL" STATUS_GATES="$STATUS_GATES" \
EXTRA_STATUS_LABELS="${EXTRA_STATUS_LABELS:-}" SWAP_RC="${SWAP_RC:-0}" \
STOP_AFTER="${STOP_AFTER:-}" BUDGET_OUT="$BUDGET_OUT" python3 - "$WORK" <<'PY'
import base64
import json
import os
import sys
from pathlib import Path

work = Path(sys.argv[1])

ARTIFACT_NAMES = [
    "review-corpus.md",
    "review-corpus.truncated.md",
    "review-corpus.smart.truncated.md",
    "review-corpus.body.md",
    "review-corpus.body.truncated.md",
    "standards-context.md",
    "standards-context.capped.md",
    "standards-present.txt",
    "requirement-ledger.section.md",
    "requirement-ledger-present.txt",
    "specialist-leads-present.txt",
    "tool-harness.md",
    "tool-harness.json",
    "tool-harness.smart.md",
    "pr.diff.smart.truncated",
    "pr-files.smart.truncated.json",
    "repo-map.capped.md",
]

ABSENT = "!absent"
values: dict[str, str] = {}

primary_corpus, primary_diff, primary_files, smart_corpus, smart_diff, smart_files = (
    os.environ["BUDGET_OUT"].split(" ")
)
values["budget_primary_max_corpus"] = primary_corpus
values["budget_primary_max_diff"] = primary_diff
values["budget_primary_max_files"] = primary_files
values["budget_smart_max_corpus"] = smart_corpus
values["budget_smart_max_diff"] = smart_diff
values["budget_smart_max_files"] = smart_files

values["status:initial"] = os.environ["STATUS_INITIAL"]
gates = os.environ["STATUS_GATES"]
values["status:gates"] = "!absent" if gates == "__absent__" else gates
for line in os.environ.get("EXTRA_STATUS_LABELS", "").splitlines():
    if not line:
        continue
    index, call, status = line.split(":", 2)
    values[f"extra_call:{index}"] = call
    values[f"status:extra:{index}"] = status

for name in ARTIFACT_NAMES:
    target = work / name
    if target.exists():
        values[f"file:{name}"] = base64.b64encode(target.read_bytes()).decode("ascii")
    else:
        values[f"file:{name}"] = ABSENT

if not os.environ.get("STOP_AFTER") and (work / "swap-corpus.input").exists() and (work / "swap-body.input").exists():
    corpus = (work / "swap-corpus.input").read_text(encoding="utf-8")
    output = (work / "swap-output.txt").read_text(encoding="utf-8") if (work / "swap-output.txt").exists() else ""
    values["swap_present"] = "false" if output == corpus else "true"
    values["swap_corpus"] = base64.b64encode(output.encode("utf-8")).decode("ascii")

print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
PY
}

# ---------------------------------------------------------------------------
# Corpus assembly: production slices over the scratch workspace.
# ---------------------------------------------------------------------------
cd "$WORK" || exit 1
export SCRIPT_DIR="$ROOT/scripts"
export PRIMARY_MAX_CORPUS PRIMARY_MAX_DIFF PRIMARY_MAX_FILES
export SMART_MAX_CORPUS SMART_MAX_DIFF SMART_MAX_FILES
export MAX_CORPUS="$PRIMARY_MAX_CORPUS" MAX_DIFF="$PRIMARY_MAX_DIFF" MAX_FILES="$PRIMARY_MAX_FILES"

# shellcheck source=/dev/null
source "$SLICES/truncate.sh"
# shellcheck source=/dev/null
source "$SLICES/gate_forks.sh"

# Stand-ins for run_review.sh orchestrator helpers the excluded slice ranges
# would have provided; the corpus assembly itself never calls them.
section_timer_start() { :; }
section_timer_end() { :; }
fork_ci_gate() { :; }
join_ci_gate() { :; }
fork_specialist_gate() { :; }
join_specialist_gate() { :; }
harvest_advisory_phases() { :; }
apply_specialist_leads_fragment() { :; }

# shellcheck source=/dev/null
source "$SLICES/prepare.sh"
# shellcheck source=/dev/null
source "$SLICES/bounded_repo_map.sh"
# shellcheck source=/dev/null
source "$SLICES/build_review_corpus.sh"

run_build() {
  # $1 tier, $2 slot → sets BUILD_STATUS
  if build_review_corpus "$1" "$2"; then
    BUILD_STATUS=0
  else
    BUILD_STATUS=1
  fi
}

PIPELINE_STDOUT="$WORK/pipeline_stdout.txt"
PIPELINE_STDERR="$WORK/pipeline_stderr.txt"
: > "$PIPELINE_STDOUT"
: > "$PIPELINE_STDERR"
PIPELINE_FAILED=0

# Production corpus.sh runs under `set -euo pipefail`: the first failing
# command inside build_review_corpus (jq parse/type error, missing required
# input) aborts the review. Modeled fail-closed: the subshell dies on the
# first failure and its stderr is the failure artifact.
# (The subshell runs as a plain statement, NOT inside an if-condition:
# bash ignores `set -e` inside a tested subshell, which would silently
# re-enable the errexit the contract depends on.)
(
  set -e
  build_review_corpus "${REVIEW_CONTEXT_PROFILE:-primary}" primary
  cp review-corpus.md review-corpus.truncated.md
) >>"$PIPELINE_STDOUT" 2>>"$PIPELINE_STDERR"
BUILD_RC=$?
STATUS_INITIAL=0
if [ "$BUILD_RC" -ne 0 ]; then
  PIPELINE_FAILED=1
fi

if [ "$PIPELINE_FAILED" = "1" ]; then
  emit_failure
  exit 0
fi

STOP_AFTER="${STOP_AFTER:-}"
if [ "$STOP_AFTER" = "initial" ]; then
  STATUS_GATES="__absent__"
  EXTRA_STATUS_LABELS=""
  emit_values
  exit 0
fi

# Rebuild after the review gates resolve (#634) — also fail-closed.
if [ "${CI_GATE_ACTIVE:-false}" == "true" ] || [ -s specialists.md ]; then
  (
    set -e
    build_review_corpus "${REVIEW_CONTEXT_PROFILE:-primary}" primary
    cp review-corpus.md review-corpus.truncated.md
  ) >>"$PIPELINE_STDOUT" 2>>"$PIPELINE_STDERR"
  if [ "$?" -ne 0 ]; then
    PIPELINE_FAILED=1
  fi
  STATUS_GATES=0
else
  STATUS_GATES="__absent__"
fi

if [ "$PIPELINE_FAILED" = "1" ]; then
  emit_failure
  exit 0
fi

if [ "$STOP_AFTER" = "gates" ]; then
  EXTRA_STATUS_LABELS=""
  emit_values
  exit 0
fi

# Tool-harness block: the fork gate and failure artifacts come from the real
# slice; only the harness invocation itself is simulated, at its exact seam.
if [ "$(printf '%s' "${TOOL_MODE:-}" | tr '[:upper:]' '[:lower:]')" = "native_loop" ]; then
  python3() {
    if [ "$1" = "$SCRIPT_DIR/run_tool_harness.py" ]; then
      case "${SIMULATE_HARNESS_MODE:-}" in
        outputs)
          if [ -d .simulate ]; then
            for sim in .simulate/*; do
              cp "$sim" "$(basename "$sim")"
            done
          fi
          return 0
          ;;
        *) return 1 ;;
      esac
    fi
    command python3 "$@"
  }
  # The block (fork gate, simulated harness seam, failure artifacts,
  # post-harness rebuild) is production top-level corpus.sh code: fail-closed.
  (
    set -e
    # shellcheck source=/dev/null
    source "$SLICES/tool_harness_block.sh"
  ) >>"$PIPELINE_STDOUT" 2>>"$PIPELINE_STDERR"
  if [ "$?" -ne 0 ]; then
    PIPELINE_FAILED=1
  fi
  unset -f python3
  if [ "$PIPELINE_FAILED" = "1" ]; then
    emit_failure
    exit 0
  fi
fi

# Extra explicit build calls (escalation/coverage-style slot semantics and
# the over-budget guard); no cp follows, mirroring the callers.
EXTRA_STATUS_LABELS=""
i=0
for call in ${EXTRA_CALLS:-}; do
  i=$((i + 1))
  tier="${call%%/*}"
  slot="${call#*/}"
  run_build "$tier" "$slot"
  EXTRA_STATUS_LABELS="$EXTRA_STATUS_LABELS$(printf '%s:%s:%s\n' "$i" "$call" "$BUILD_STATUS")"
done

# ---------------------------------------------------------------------------
# Harness-findings section swap (scripts/run_tool_harness.py seam).
# ---------------------------------------------------------------------------
SWAP_RC=0
if [ -f swap-corpus.input ] && [ -f swap-body.input ]; then
  PYTHONPATH="$ROOT/scripts" python3 - "$WORK" > "$WORK/swap-output.txt" 2> "$WORK/swap_stderr.txt" <<'PY' || SWAP_RC=$?
import json
import sys
from pathlib import Path

work = Path(sys.argv[1])
from run_tool_harness import replace_harness_findings_section

corpus = (work / "swap-corpus.input").read_text(encoding="utf-8")
body = (work / "swap-body.input").read_text(encoding="utf-8")
sys.stdout.write(replace_harness_findings_section(corpus, body))
PY
fi

emit_values
