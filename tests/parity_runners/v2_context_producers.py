#!/usr/bin/env python3
"""Parity runner (v2 side, context-producers boundary, #706 PR 3).

Runs one deterministic context producer from the production shell sections,
sliced verbatim (never copied) so the runner cannot drift from production:

- ``manifest``      scripts/sections/context.sh changed-manifest block
- ``repo-impact``   scripts/sections/classification.sh repo impact/history
                    block (+ config.sh ``truncate_clean``)
- ``linked-issues`` scripts/sections/context.sh ``pr-body.txt`` line and the
                    linked-issue / Linear / metadata-status block
                    (+ common.sh ``gate_feature_for_forks``)
- ``ledger-signal`` scripts/sections/context.sh ``build_requirement_ledger``
- ``standards``     scripts/sections/config.sh ``resolve_standards_file``
                    (+ common.sh ``workspace_regular_file``, also used by
                    the manifest block)
- ``related-clip``  scripts/sections/corpus.sh ``build_related_code_context``

Each slice runs under ``set -euo pipefail`` (run_review.sh's mode) with the
harness-prepared worktree (argv[2]) as its working directory, exactly where
production runs it. Only the external seams are stubbed, at their call
sites: ``platform_issue_get`` serves the fixture's issue payloads, the Linear
adapter is the real ``linear_context.py`` with ``urlopen`` served from the
fixture, and the ledger / change-anchor / related-context builders copy
fixture outputs into place (the clip itself is the real module).

Two environment pins model the production runners (ubuntu, C.UTF-8, GNU
coreutils): ``LC_ALL=C`` gives the byte collation C.UTF-8 has for these
ASCII terms and paths, and ``wc`` output is stripped of the leading padding
BSD ``wc`` adds on macOS (GNU prints the bare count for stdin).

Prints one JSON line ``{ok, values}`` (or ``{ok: false, stderr}``); every
artifact is ``file:<name>`` as strict UTF-8 text or ``!b64:<base64>``.
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
STUB = Path(__file__).resolve().parent / "v2_context_producers_stub.py"

ARTIFACTS = {
    "manifest": ["manifest-context.md"],
    "repo-impact": [
        # The untruncated repo-impact.md / repo-history.md are v2
        # intermediates nothing reads; v3 materializes only the capped ones.
        "terms.all.txt", "terms.txt", "repo-impact.truncated.md", "repo-history.truncated.md",
    ],
    "linked-issues": [
        "linked-issues.json", "linked-issues.md", "linear-issues.json", "linear-issues.md",
        "linked-metadata-status.json",
    ],
    "ledger-signal": [
        "requirement-ledger.json", "requirement-ledger.md", "requirement-ledger-present.txt",
        "requirement-ledger.section.md",
    ],
    "related-clip": ["related-code.md", "related-code.truncated.md"],
}


def slice_between(text: str, start: str, end: str, label: str) -> str:
    begin = text.index(start)
    stop = text.index(end, begin + len(start))
    body = text[begin:stop]
    if not body.strip():
        raise SystemExit(f"empty slice: {label}")
    return body


def section(name: str) -> str:
    return (ROOT / "scripts" / "sections" / name).read_text(encoding="utf-8")


def slices(producer: str) -> str:
    context = section("context.sh")
    common = section("common.sh")
    guard = common[common.index("workspace_regular_file() {"):]
    if producer == "manifest":
        return guard + "\n" + slice_between(context, "CHANGED_MANIFESTS=$(jq", "\nsection_timer_end", "manifest")
    if producer == "repo-impact":
        config = section("config.sh")
        classification = section("classification.sh")
        return "\n".join([
            slice_between(config, "truncate_clean() {", '\nif [[ -z "$REPO"', "truncate"),
            slice_between(classification, 'log "Gathering repository impact and history..."', "\nsection_timer_end", "repo-impact"),
        ])
    if producer == "linked-issues":
        return "\n".join([
            common[common.index("gate_feature_for_forks() {"):],
            slice_between(context, "jq -r '.body // \"\"' pr.json > pr-body.txt", "\n", "pr-body"),
            slice_between(context, 'log "Gathering linked issue context..."', "\nsection_timer_end", "linked-issues"),
        ])
    if producer == "ledger-signal":
        return slice_between(context, "build_requirement_ledger() {", "\nbuild_requirement_ledger\n", "ledger") + "\nbuild_requirement_ledger\n"
    if producer == "standards":
        config = section("config.sh")
        return guard + "\n" + slice_between(config, "resolve_standards_file() {", "resolve_system_prompt() {", "standards") + (
            '\nresolve_standards_file\nprintf "%s" "$STANDARDS_FILE" > "$PARITY_OUT/standards_file"\n'
        )
    if producer == "related-clip":
        corpus = section("corpus.sh")
        return slice_between(corpus, "build_related_code_context() {", "build_pr_thread_context() {", "related") + (
            "\nbuild_related_code_context\n"
        )
    raise SystemExit(f"unknown producer {producer!r}")


PRELUDE = r"""
set -euo pipefail
log() { :; }
error() { printf 'ERROR: %s\n' "$*" >&2; }
section_timer_start() { :; }
section_timer_end() { :; }
wc() { command wc "$@" | sed 's/^ *//'; }
platform_issue_get() { command python3 "$PARITY_STUB" issue "$1" "$2"; }
python3() {
  case "${1:-}" in
    */pr_reviewer/linear_context.py) shift; command python3 "$PARITY_STUB" linear "$@" ;;
    -m)
      case "${2:-}" in
        pr_reviewer.requirement_ledger|pr_reviewer.change_anchors) command python3 "$PARITY_STUB" "$2" "${@:3}" ;;
        pr_reviewer.related_context)
          if [ "${3:-}" = "--clip" ]; then command python3 "$@"; else command python3 "$PARITY_STUB" "$2" "${@:3}"; fi ;;
        *) command python3 "$@" ;;
      esac ;;
    *) command python3 "$@" ;;
  esac
}
"""


def decode_content(content) -> bytes | None:
    if content is None:
        return None
    if isinstance(content, str):
        return content.encode("utf-8")
    return base64.b64decode(content["b64"])


def encode_artifact(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return "!b64:" + base64.b64encode(data).decode("ascii")


def main() -> int:
    fixture_path = Path(sys.argv[1])
    repo = Path(sys.argv[2])
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    producer = fixture["producer"]
    linear = fixture.get("linear") or {}

    if "pr" in fixture:
        (repo / "pr.json").write_text(json.dumps(fixture["pr"], ensure_ascii=False), encoding="utf-8")
    if producer == "manifest":
        raw = fixture.get("pr_files_raw_text")
        if raw is None:
            raw = json.dumps(fixture.get("pr_files_raw"), ensure_ascii=False)
        (repo / "pr-files.raw.json").write_text(raw, encoding="utf-8")
    hints = decode_content(fixture.get("version_hints"))
    if hints is not None:
        (repo / "version-hints.truncated.txt").write_bytes(hints)

    env = {
        **os.environ,
        "LC_ALL": "C",
        "SCRIPT_DIR": str(ROOT / "scripts"),
        "PYTHONPATH": str(ROOT),
        "PYTHONSAFEPATH": "1",
        "PARITY_STUB": str(STUB),
        "PARITY_FIXTURE": str(fixture_path.resolve()),
        "REPO": str(fixture.get("repo", "")),
        "IS_FORK_PR": str(fixture.get("is_fork_pr", "")),
        "LINEAR_API_KEY": str(linear.get("api_key", "")),
        "LINEAR_ISSUE_PREFIXES": str(linear.get("prefixes", "")),
        "LINEAR_ISSUE_TIMEOUT_SEC": str(linear.get("timeout", "20")),
        "LINEAR_ENABLE_FOR_FORKS": str(linear.get("enable_for_forks", "false")),
        "MAX_CORPUS": str(fixture.get("max_corpus", "")),
        "STANDARDS_FILE": str(fixture.get("standards_file", "")),
        "STANDARDS_FILE_CANDIDATES": str(fixture.get("candidates", "")),
        "RELATED_CODE_CONTEXT": "true",
        "RELATED_CODE_MAX_BYTES": str(fixture.get("max_bytes", "")),
    }
    if producer == "ledger-signal":
        env["STANDARDS_FILE"] = ""

    with tempfile.TemporaryDirectory() as scratch:
        out = Path(scratch)
        env["PARITY_OUT"] = str(out)
        script = out / "producer.sh"
        script.write_text(PRELUDE + slices(producer), encoding="utf-8")
        proc = subprocess.run(["bash", str(script)], cwd=str(repo), env=env, capture_output=True, timeout=120)
        if proc.returncode != 0:
            print(json.dumps({"ok": False, "stderr": proc.stderr.decode("utf-8", "replace").strip()[-2000:]}, ensure_ascii=False))
            return 0
        values: dict[str, str] = {}
        if producer == "standards":
            values["standards_file"] = (out / "standards_file").read_bytes().decode("utf-8", "surrogateescape")
        for name in ARTIFACTS.get(producer, []):
            target = repo / name
            values[f"file:{name}"] = encode_artifact(target.read_bytes()) if target.exists() else "!absent"
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
