#!/usr/bin/env python3
"""Dump the resolved v2 config surface as JSON for the parity harness.

Runs inside the env-isolated subshell created by v2_config.sh, after
scripts/sections/config.sh has resolved, validated, and possibly degraded the
environment. The dump is the observable post-config value of every contract
input's v2 environment variable — the consumer-visible config surface.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import yaml


def main() -> int:
    contract_path = os.environ["PARITY_CONTRACT"]
    pre = json.loads(Path(os.environ["PARITY_PRECONFIG"]).read_text())
    contract = yaml.safe_load(Path(contract_path).read_text())
    post = {}
    for item in contract["inputs"]:
        name = item["v2_id"].upper()
        # A var the producer never bound and config.sh never set reads as "";
        # the harness scopes such keys out of this boundary (they are consumed
        # downstream of the resolved environment, not by config resolution).
        post[name] = os.environ.get(name, "")
    # The v2 pipeline binds the token input to GH_TOKEN (config.sh falls back
    # to the ambient GITHUB_TOKEN); the harness compares the v3 github-token
    # config key against that binding.
    post["GH_TOKEN"] = os.environ.get("GH_TOKEN", "")
    json.dump({"ok": True, "pre": {**pre, "GH_TOKEN": post["GH_TOKEN"]}, "values": post}, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
