#!/usr/bin/env python3
"""Call-site stubs for the context-producers v2 runner (#706 PR 3).

Invoked by the sliced production shell in place of an external seam, reading
the fixture named by ``$PARITY_FIXTURE``:

- ``issue <repo> <number>``: ``platform_issue_get`` — prints the fixture's
  issue payload (``issues["<repo>#<number>"].data``) or exits 1 for a failed
  fetch (``fail: true`` or no entry).
- ``linear <args...>``: the real ``pr_reviewer/linear_context.py`` CLI with
  ``urlopen`` answering from ``linear.responses`` keyed by identifier
  (``json`` payload, raw ``body`` text, or an HTTP error ``status``).
- ``pr_reviewer.requirement_ledger build ...``: copies ``ledger_md`` /
  ``ledger_json`` to ``--markdown`` / ``--output`` (a null leaves the
  pre-truncated file empty, i.e. the build wrote nothing).
- ``pr_reviewer.change_anchors ...``: succeeds (anchors are out of scope).
- ``pr_reviewer.related_context ...``: writes the fixture ``markdown`` to
  ``--markdown`` and an error-free ``--json``; the ``--clip`` step is not
  stubbed.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))


def fixture() -> dict:
    return json.loads(Path(os.environ["PARITY_FIXTURE"]).read_text(encoding="utf-8"))


def content_bytes(content) -> bytes | None:
    if content is None:
        return None
    if isinstance(content, str):
        return content.encode("utf-8")
    return base64.b64decode(content["b64"])


def arg_value(args: list[str], flag: str) -> str:
    return args[args.index(flag) + 1]


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def run_linear(args: list[str]) -> int:
    from pr_reviewer import linear_context

    responses = (fixture().get("linear") or {}).get("responses") or {}

    def fake_urlopen(request, timeout=None):
        identifier = json.loads(request.data)["variables"]["id"]
        spec = responses.get(identifier, {"status": 404})
        status = spec.get("status", 200)
        if not 200 <= status < 300:
            raise HTTPError(request.full_url, status, "fixture error", {}, None)
        payload = spec["body"] if "body" in spec else json.dumps(spec.get("json"))
        return _Response(payload.encode("utf-8"))

    linear_context.urlopen = fake_urlopen
    return linear_context.main(args)


def main() -> int:
    kind, args = sys.argv[1], sys.argv[2:]
    if kind == "issue":
        spec = (fixture().get("issues") or {}).get(f"{args[0]}#{args[1]}")
        if spec is None or spec.get("fail"):
            return 1
        sys.stdout.write(json.dumps(spec.get("data"), ensure_ascii=False) + "\n")
        return 0
    if kind == "linear":
        return run_linear(args)
    if kind == "pr_reviewer.requirement_ledger":
        data = fixture()
        for flag, key in (("--markdown", "ledger_md"), ("--output", "ledger_json")):
            payload = content_bytes(data.get(key))
            if payload is not None:
                Path(arg_value(args, flag)).write_bytes(payload)
        return 0
    if kind == "pr_reviewer.change_anchors":
        Path(arg_value(args, "--output")).write_text("{}\n", encoding="utf-8")
        return 0
    if kind == "pr_reviewer.related_context":
        Path(arg_value(args, "--markdown")).write_bytes(content_bytes(fixture().get("markdown")) or b"")
        Path(arg_value(args, "--json")).write_text('{"errors": []}\n', encoding="utf-8")
        return 0
    print(f"unknown stub kind {kind!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
