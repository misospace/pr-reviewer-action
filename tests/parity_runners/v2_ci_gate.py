#!/usr/bin/env python3
"""Parity runner (v2 side, ci-gate boundary, #706 PR 6).

Runs the REAL ``scripts/wait_for_ci.sh`` (and through it the real
``platform_api.sh`` seam, ``_gh_api_bounded`` and, on Forgejo,
``forgejo_backend.py``) against the fixture's per-route response sequences.
The edges are stub executables on PATH:

- ``gh`` / ``curl`` serve one sequence entry per request (the last repeats)
  and log every request;
- ``date`` / ``sleep`` share a virtual clock file with them. Only a ``sleep``
  whose parent is the wait_for_ci.sh shell itself (the deadline-aware poll
  sleep) advances the clock; the ``_gh_api_bounded`` watchdog's ``sleep``
  runs the real binary, so the bounded-attempt machinery still works;
- a response entry with ``advance: N`` moves the clock N seconds (a slow
  API); ``transport: true`` is a request that never got a response.

Prints ``{ok, values}`` in the shape the v3 fixture CLI
(``ci-gate-fixture``, src/gates/ci-wait-fixture.ts) produces.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GITHUB_API = "https://api.github.com"
FORGEJO_URL = "https://forgejo.example"
TOKEN = "fixture-token"

COMMON = r'''
import json, os, sys

def clock_read():
    with open(os.environ["PARITY_CLOCK"], encoding="utf-8") as fh:
        return int(fh.read().strip())

def clock_add(seconds):
    now = clock_read() + int(seconds)
    with open(os.environ["PARITY_CLOCK"], "w", encoding="utf-8") as fh:
        fh.write(str(now))

def log_request(line):
    with open(os.environ["PARITY_LOG"], "a", encoding="utf-8") as fh:
        fh.write(json.dumps(line) + "\n")

def next_entry(match):
    routes = json.load(open(os.environ["PARITY_ROUTES"], encoding="utf-8"))
    route = next((r for r in routes if r["match"] == match), None)
    if route is None or not route.get("responses"):
        return None
    state_path = os.environ["PARITY_STATE"]
    try:
        state = json.load(open(state_path, encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    index = state.get(match, 0)
    state[match] = index + 1
    with open(state_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    entry = route["responses"][min(index, len(route["responses"]) - 1)]
    clock_add(entry.get("advance", 0))
    return entry

def text_of(entry):
    return entry["raw"] if "raw" in entry else json.dumps(entry.get("body"))
'''

FAKE_GH = COMMON + r'''
args = sys.argv[1:]
if not args or args[0] != "api":
    sys.exit(2)
path = args[1]
rest = args[2:]
log_request(f"GET https://api.github.com/{path} auth=1")
entry = next_entry(path)
if entry is None:
    sys.stdout.write(json.dumps({"message": "Not Found"}))
    sys.exit(1)
if entry.get("transport"):
    sys.stderr.write("error connecting to api.github.com\n")
    sys.exit(1)
text = text_of(entry)
if "--jq" in rest:
    expr = rest[rest.index("--jq") + 1]
    assert expr == ".head.sha", expr
    value = (json.loads(text).get("head") or {}).get("sha")
    text = "" if value is None else str(value) + "\n"
if entry.get("status", 200) >= 400:
    sys.stdout.write(text)
    sys.exit(1)
sys.stdout.write(text)
'''

FAKE_CURL = COMMON + r'''
args = sys.argv[1:]
method = "GET"
auth = 0
url = None
i = 0
while i < len(args):
    arg = args[i]
    if arg in ("-X", "-H", "-o", "-w", "--data-binary"):
        if arg == "-X":
            method = args[i + 1]
        i += 2
        continue
    if arg == "--config":
        try:
            auth = 1 if "Authorization" in open(args[i + 1], encoding="utf-8").read() else 0
        except OSError:
            auth = 0
        i += 2
        continue
    if arg.startswith("-"):
        i += 1
        continue
    url = arg
    i += 1
log_request(f"{method} {url} auth={auth}")
entry = next_entry(url.partition("://")[2].partition("/")[2])
if entry is None:
    sys.stdout.write(json.dumps({"message": "Not Found"}) + "\n404")
    sys.exit(0)
if entry.get("transport"):
    sys.stdout.write("\n000")
    sys.exit(7)
sys.stdout.write(text_of(entry) + "\n" + str(entry.get("status", 200)))
'''

FAKE_DATE = COMMON + r'''
import time
fmt = sys.argv[1] if len(sys.argv) > 1 else "+%a %b %d %H:%M:%S UTC %Y"
now = clock_read()
if fmt == "+%s":
    print(now)
else:
    print(time.strftime(fmt[1:], time.gmtime(now)))
'''

FAKE_SLEEP = COMMON + r'''
if os.getppid() == int(os.environ["PARITY_MAIN_PID"]):
    clock_add(int(float(sys.argv[1])))
    sys.exit(0)
real = os.environ["PARITY_REAL_SLEEP"]
os.execv(real, [real, *sys.argv[1:]])
'''


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if shutil.which("jq") is None:
        raise RuntimeError("jq is required")
    real_sleep = shutil.which("sleep")
    if real_sleep is None:
        raise RuntimeError("sleep is required")
    start = int(fixture.get("start_epoch", 1767225600))
    platform = fixture.get("platform", "github")
    with tempfile.TemporaryDirectory(prefix="v2-ci-gate-") as td:
        work = Path(td)
        bin_dir = work / "bin"
        bin_dir.mkdir()
        for name, source in (("gh", FAKE_GH), ("curl", FAKE_CURL), ("date", FAKE_DATE), ("sleep", FAKE_SLEEP)):
            path = bin_dir / name
            path.write_text(f"#!{sys.executable}\n{source}", encoding="utf-8")
            path.chmod(0o755)
        (work / "routes.json").write_text(json.dumps(fixture.get("routes", [])), encoding="utf-8")
        (work / "clock").write_text(str(start), encoding="utf-8")
        (work / "requests.log").write_text("", encoding="utf-8")
        out_dir = work / "out"
        out_dir.mkdir()
        output_file = out_dir / "github-output"
        output_file.write_text("", encoding="utf-8")
        checks_file = out_dir / "ci-checks-context.md"
        env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(work),
            "TMPDIR": str(work),
            "PYTHONIOENCODING": "utf-8",
            "PARITY_ROUTES": str(work / "routes.json"),
            "PARITY_STATE": str(work / "state.json"),
            "PARITY_LOG": str(work / "requests.log"),
            "PARITY_CLOCK": str(work / "clock"),
            "PARITY_REAL_SLEEP": real_sleep,
            "GH_TOKEN": TOKEN,
            "REPO": fixture.get("repo", "o/r"),
            "PR_NUMBER": str(fixture.get("pr_number", "1")),
            "GITHUB_OUTPUT": str(output_file),
            "PLATFORM": platform,
        }
        if platform == "forgejo":
            env["FORGEJO_API_URL"] = FORGEJO_URL
            env["FORGEJO_TOKEN"] = TOKEN
        if fixture.get("checks_file", True) is not False:
            env["CI_CHECKS_FILE"] = str(checks_file)
        env.update(fixture.get("env", {}))
        proc = subprocess.run(
            ["bash", "-c", 'export PARITY_MAIN_PID=$$; exec bash "$0"', str(ROOT / "scripts" / "wait_for_ci.sh")],
            capture_output=True,
            env=env,
            cwd=str(work),
            timeout=300,
        )
        requests = [json.loads(line) for line in (work / "requests.log").read_text(encoding="utf-8").splitlines() if line.strip()]
        leftovers = sorted(name for name in os.listdir(out_dir) if ".tmp." in name)
        values = {
            "exit_code": str(proc.returncode),
            "outputs": output_file.read_text(encoding="utf-8"),
            "checks_file": checks_file.read_text(encoding="utf-8") if checks_file.exists() else "<absent>",
            "leftovers": json.dumps(leftovers, separators=(",", ":")),
            "requests": json.dumps(requests, separators=(",", ":"), ensure_ascii=False),
            "elapsed": str(int((work / "clock").read_text(encoding="utf-8").strip()) - start),
            "stdout": proc.stdout.decode("utf-8").rstrip("\n"),
            "stderr": proc.stderr.decode("utf-8").rstrip("\n"),
        }
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
