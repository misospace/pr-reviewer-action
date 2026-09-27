#!/usr/bin/env python3
"""Parity runner (v2 side, platform-normalization boundary, #706 PR 1).

Drives the REAL v2 platform seam — ``scripts/platform_api.sh`` (its jq
projections and ``_gh_api_bounded``), ``pr_reviewer/forgejo_backend.py``
through the ``_forgejo_py`` CLI, ``pr_reviewer.http_client.gh_api_call``,
and the ``pr-files.json`` jq projection read out of
``scripts/sections/context.sh`` — against the fixture's raw forge responses.
The network edge is replaced by stub ``gh`` and ``curl`` executables on
PATH that serve the fixture route table, so every normalization runs
exactly as in production.

The one behavior the stub must model rather than exercise is ``gh api
--paginate``: like gh (verified against gh 2.9x), it requests
``per_page=100``, follows ``page=N`` links, and merges the page arrays into
one array.

Prints ``{ok, values}`` in the shape the v3 fixture CLI
(``platform-normalization-fixture``) produces: see src/platform/fixture.ts.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
GITHUB_API = "https://api.github.com"
FORGEJO_URL = "https://forgejo.example"
TOKEN = "fixture-token"

FAKE_GH = r'''
import json, os, sys, time

GITHUB_API = "https://api.github.com"

routes = json.load(open(os.environ["PARITY_ROUTES"], encoding="utf-8"))
log_path = os.environ["PARITY_LOG"]
auth = 1 if (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")) else 0

def log(line):
    with open(log_path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(line) + "\n")

def text_of(route):
    if "raw" in route:
        return route["raw"]
    return json.dumps(route.get("body"))

def fail(text):
    sys.stdout.write(text)
    sys.exit(1)

args = sys.argv[1:]
if not args or args[0] != "api":
    sys.exit(2)
path = args[1]
rest = args[2:]
paginate = "--paginate" in rest

if path == "graphql":
    fields = {}
    variables = {}
    i = 0
    while i < len(rest):
        flag = rest[i]
        if flag in ("-f", "-F") and i + 1 < len(rest):
            key, _, value = rest[i + 1].partition("=")
            if flag == "-F":
                if value.isdigit():
                    value = int(value)
                elif value in ("true", "false"):
                    value = value == "true"
                elif value == "null":
                    value = None
            if key == "query":
                fields["query"] = value
            else:
                variables[key] = value
            i += 2
            continue
        i += 1
    body = {"query": fields.get("query", ""), "variables": variables}
    key = "graphql:reviewThreads" if "reviewThreads" in body["query"] else "graphql:comments"
    log(f"POST {GITHUB_API}/graphql auth={auth} " + json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False))
    route = next((r for r in routes if r["match"] == key), None)
    if route is None:
        fail(json.dumps({"message": "Not Found"}))
    text = text_of(route)
    status = route.get("status", 200)
    data = route.get("body")
    if status >= 400 or (isinstance(data, dict) and isinstance(data.get("errors"), list) and data["errors"]):
        fail(text)
    sys.stdout.write(text)
    sys.exit(0)

url = f"{GITHUB_API}/{path}"
if paginate and "per_page=" not in path:
    url += ("&" if "?" in path else "?") + "per_page=100"
bare = path.split("?", 1)[0]
route = next((r for r in routes if r["match"] == path), None)
if route is None:
    route = next((r for r in routes if "pages" in r and r["match"] == bare), None)
if route is None:
    log(f"GET {url} auth={auth}")
    fail(json.dumps({"message": "Not Found"}))
if "pages" in route:
    pages = route["pages"] if paginate else route["pages"][:1]
    merged = []
    for index, page in enumerate(pages, 1):
        log(f"GET {url if index == 1 else url + '&page=' + str(index)} auth={auth}")
        merged.extend(page)
    sys.stdout.write(json.dumps(merged))
    sys.exit(0)
log(f"GET {url} auth={auth}")
if route.get("hang"):
    time.sleep(60)
text = text_of(route)
if route.get("status", 200) >= 400:
    fail(text)
sys.stdout.write(text)
'''

FAKE_CURL = r'''
import json, os, sys, time

routes = json.load(open(os.environ["PARITY_ROUTES"], encoding="utf-8"))
log_path = os.environ["PARITY_LOG"]

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

with open(log_path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(f"{method} {url} auth={auth}") + "\n")
scheme, _, remainder = url.partition("://")
relative = remainder.partition("/")[2]
route = next((r for r in routes if r["match"] in (url, relative)), None)
if route is None:
    sys.stdout.write(json.dumps({"message": "Not Found"}) + "\n404")
    sys.exit(0)
if route.get("hang"):
    time.sleep(60)
text = route["raw"] if "raw" in route else json.dumps(route.get("body"))
sys.stdout.write(text + "\n" + str(route.get("status", 200)))
'''


def ascii_json(value) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def pr_files_filter() -> str:
    text = (ROOT / "scripts" / "sections" / "context.sh").read_text(encoding="utf-8")
    match = re.search(
        r"jq -c --argjson total \"\$\{TOTAL_CHANGED_FILES:-0\}\" \\\n\s*'(.*?)' \\\n\s*pr-files\.raw\.json > pr-files\.json",
        text,
        re.DOTALL,
    )
    if not match:
        raise RuntimeError("could not locate the pr-files.json jq projection in scripts/sections/context.sh")
    return match.group(1)


class Seam:
    def __init__(self, fixture: dict, workdir: Path) -> None:
        self.fixture = fixture
        self.workdir = workdir
        self.platform = fixture.get("platform", "github")
        bin_dir = workdir / "bin"
        bin_dir.mkdir()
        for name, source in (("gh", FAKE_GH), ("curl", FAKE_CURL)):
            path = bin_dir / name
            path.write_text(f"#!{sys.executable}\n{source}", encoding="utf-8")
            path.chmod(0o755)
        self.routes = workdir / "routes.json"
        self.routes.write_text(json.dumps(fixture.get("routes", [])), encoding="utf-8")
        self.log = workdir / "requests.log"
        self.log.write_text("", encoding="utf-8")
        self.semantic_dir: Path | None = None
        if "semantic_fixture" in fixture:
            self.semantic_dir = workdir / "semantic"
            api = self.semantic_dir / ".semantic-fixture"
            api.mkdir(parents=True)
            semantic = fixture["semantic_fixture"]
            (api / "pr.json").write_text(json.dumps(semantic.get("pr_json", {})), encoding="utf-8")
            (api / "diff").write_text(semantic.get("diff", ""), encoding="utf-8")
            (api / "files.json").write_text(json.dumps(semantic.get("files", [])), encoding="utf-8")
        self.base_env = {
            "PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(workdir),
            "TMPDIR": str(workdir),
            "PYTHONIOENCODING": "utf-8",
            "PARITY_ROUTES": str(self.routes),
            "PARITY_LOG": str(self.log),
        }

    def env(self, *, platform_token: bool = True) -> dict:
        env = dict(self.base_env)
        env["PLATFORM"] = self.platform
        if self.platform == "forgejo":
            env["FORGEJO_API_URL"] = FORGEJO_URL
            if platform_token:
                env["FORGEJO_TOKEN"] = TOKEN
        elif platform_token:
            env["GH_TOKEN"] = TOKEN
        if self.semantic_dir is not None:
            env["SEMANTIC_FIXTURE_MODE"] = "true"
            env["SEMANTIC_FIXTURE_DIR"] = str(self.semantic_dir)
        env.update(self.fixture.get("env", {}))
        return env

    def shell(self, command: str, *args: str) -> tuple[int, bytes]:
        script = f'set -o pipefail\nsource "{ROOT}/scripts/platform_api.sh"\n{command} "$@"\n'
        proc = subprocess.run(
            ["bash", "-c", script, "bash", *args],
            capture_output=True,
            env=self.env(),
            cwd=str(self.workdir),
            timeout=120,
        )
        return proc.returncode, proc.stdout

    def read(self, command: str, *args: str) -> tuple[bool, object]:
        rc, out = self.shell(command, *args)
        if rc != 0:
            return False, None
        return True, json.loads(out.decode("utf-8"))

    def requests(self) -> list[str]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines() if line.strip()]


def encode_read(ok: bool, data: object) -> str:
    return ascii_json({"ok": True, "data": data}) if ok else ascii_json({"ok": False})


def run_call(seam: Seam, call: dict) -> dict[str, str]:
    fixture = seam.fixture
    repo = fixture.get("repo", "o/r")
    pr = str(fixture.get("pr_number", "1"))
    op = call["op"]
    if op == "pr":
        _ok, data = seam.read("platform_pr_get", repo, pr)
        return {"": ascii_json(data)}
    if op == "diff":
        _rc, out = seam.shell("platform_pr_diff", repo, pr)
        return {"text": out.decode("utf-8")}
    if op == "pr-files":
        rc, out = seam.shell("platform_pr_files", repo, pr)
        ok = rc == 0
        values = {"": encode_read(ok, json.loads(out.decode("utf-8")) if ok else None)}
        if ok and isinstance(call.get("total_changed_files"), int):
            raw = seam.workdir / "pr-files.raw.json"
            raw.write_bytes(out)
            proc = subprocess.run(
                ["jq", "-c", "--argjson", "total", str(call["total_changed_files"]), pr_files_filter(), str(raw)],
                capture_output=True,
            )
            values["text"] = proc.stdout.decode("utf-8") if proc.returncode == 0 else "<jq-error>"
        return values
    if op == "issue":
        ok, data = seam.read("platform_issue_get", str(call["repo"]), str(call["number"]))
        return {"": encode_read(ok, data)}
    if op == "conversation-comments":
        return {"": encode_read(*seam.read("platform_pr_review_comments", repo, pr))}
    if op == "review-threads":
        return {"": encode_read(*seam.read("platform_review_threads", repo, pr))}
    if op == "reviews-paginated":
        return {"": encode_read(*seam.read("platform_pr_reviews", repo, pr, "paginate"))}
    if op == "external-checks":
        _rc, out = seam.shell("platform_external_checks", repo, str(call["sha"]))
        return {"text": out.decode("utf-8").rstrip("\n")}
    if op == "github-enrich":
        env = seam.env(platform_token=False)
        env.pop("GH_TOKEN", None)
        code = (
            "import json, sys\n"
            "from pr_reviewer.http_client import gh_api_call\n"
            "token = sys.argv[2] or None\n"
            "print(json.dumps({'data': gh_api_call(sys.argv[1], token)}))\n"
        )
        proc = subprocess.run(
            [sys.executable, "-c", code, str(call["endpoint"]), str(call.get("token", ""))],
            capture_output=True, env={**env, "PYTHONPATH": str(ROOT), "PYTHONSAFEPATH": "1"},
            cwd=str(seam.workdir), timeout=120, check=True,
        )
        return {"": ascii_json(json.loads(proc.stdout))}
    if op in ("forgejo-enrich-release", "forgejo-enrich-compare"):
        command = "forgejo_enrich_release" if op == "forgejo-enrich-release" else "forgejo_enrich_compare"
        last = str(call["tag"] if op == "forgejo-enrich-release" else call["spec"])
        rc, out = seam.shell(command, str(call["host"]), str(call["repo"]), last)
        return {"": ascii_json({"ok": rc == 0, "data": json.loads(out.decode("utf-8"))})}
    raise RuntimeError(f"unknown platform-normalization op: {op}")


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if shutil.which("jq") is None:
        raise RuntimeError("jq is required")
    with tempfile.TemporaryDirectory(prefix="v2-platform-") as td:
        seam = Seam(fixture, Path(td))
        values: dict[str, str] = {}
        for index, call in enumerate(fixture.get("calls", [])):
            prefix = f"c{index:02d}_{call['op']}"
            for suffix, value in run_call(seam, call).items():
                values[prefix if suffix == "" else f"{prefix}_{suffix}"] = value
        values["requests"] = ascii_json(seam.requests())
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
