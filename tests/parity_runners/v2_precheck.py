#!/usr/bin/env python3
"""v2 side of the `precheck-decision` parity boundary (#674).

Runs the real production v2 precheck — ``scripts/check_review_needed.sh``
plus ``pr_reviewer/precheck.py`` and ``build_selection_fingerprint.py`` —
against a fixture's platform state. The platform seam is fed by three
stubbing layers, each intercepting the exact transport the production code
uses (never a second interpretation):

- a ``gh`` stub on PATH for the shell's GitHub CLI calls;
- a scoped ``python3`` shim for Forgejo mode that intercepts only
  ``python3 -m pr_reviewer.forgejo_backend`` and delegates everything else
  to the real interpreter (the forgejo stub routes ``get-pr-metadata``
  through the real ``_forgejo_pr_to_github`` normalizer);
- a ``sitecustomize.py`` that patches ``pr_reviewer.platform.gh_api`` and
  ``pr_reviewer.linear_context.fetch_issue`` for the selection-signature
  builder, whose transports (urllib / GraphQL) would otherwise hit the
  network.

Prints a single JSON line ``{"ok", "values"|"stderr"}`` where ``values``
mirrors the ``$GITHUB_OUTPUT`` key/value surface.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]

GH_STUB = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
fx = json.load(open(os.environ["PARITY_FIXTURE_PATH"]))
env = fx.get("env") or {}
plat = fx.get("platform") or {}
repo = env.get("REPO", "")
number = env.get("PR_NUMBER", "")
def fail():
    sys.stderr.write("gh stub: unhandled invocation: %s\n" % " ".join(args))
    sys.exit(1)
if args[:2] == ["pr", "diff"]:
    if plat.get("diff_error"):
        sys.exit(1)
    sys.stdout.write(plat.get("diff", ""))
    sys.exit(0)
if args and args[0] == "api" and len(args) > 1:
    endpoint = args[1]
    if endpoint == f"repos/{repo}/pulls/{number}":
        if plat.get("pr_error"):
            sys.exit(1)
        sys.stdout.write(json.dumps(plat.get("pr") if plat.get("pr") is not None else {}))
        sys.exit(0)
    if endpoint == f"repos/{repo}/issues/{number}/comments?per_page=100":
        sys.stdout.write(json.dumps(plat.get("comments") or []))
        sys.exit(0)
    if endpoint == f"repos/{repo}/pulls/{number}/reviews?per_page=100":
        sys.stdout.write(json.dumps(plat.get("reviews") or []))
        sys.exit(0)
fail()
'''

FORGEJO_SHIM = r'''#!/usr/bin/env bash
if [[ "${1:-}" == "-m" && "${2:-}" == "pr_reviewer.forgejo_backend" ]]; then
  shift 2
  exec "${REAL_PYTHON3}" "${PARITY_STUB_DIR}/forgejo_stub.py" "$@"
fi
exec "${REAL_PYTHON3}" "$@"
'''

FORGEJO_STUB = r'''#!/usr/bin/env python3
import json, os, sys
sys.path.insert(0, os.environ["PARITY_REPO_ROOT"])
from pr_reviewer.forgejo_backend import _forgejo_pr_to_github

fx = json.load(open(os.environ["PARITY_FIXTURE_PATH"]))
env = fx.get("env") or {}
plat = fx.get("platform") or {}
repo = env.get("REPO", "")
number = env.get("PR_NUMBER", "")
owner, _, name = repo.partition("/")
args = sys.argv[1:]
sub = args[0] if args else ""
if sub == "get-pr-diff":
    if plat.get("diff_error"):
        sys.exit(1)
    sys.stdout.write(plat.get("diff", ""))
    sys.exit(0)
if sub == "get-pr-metadata":
    if plat.get("pr_error"):
        print("null")
        sys.exit(0)
    raw = plat.get("forgejo_pr_raw")
    if raw is not None:
        print(json.dumps(_forgejo_pr_to_github(raw, owner, name, int(number))))
    else:
        print(json.dumps(plat.get("pr") if plat.get("pr") is not None else {}))
    sys.exit(0)
if sub == "list-comments":
    print(json.dumps(plat.get("comments") or []))
    sys.exit(0)
if sub == "list-pr-reviews":
    print(json.dumps(plat.get("reviews") or []))
    sys.exit(0)
if sub == "repo-permission":
    permission = plat.get("permission")
    if plat.get("permission_error") or not permission:
        print("none")
        sys.exit(1)
    print(permission)
    sys.exit(0)
sys.stderr.write("forgejo stub: unhandled subcommand: %s\n" % sub)
sys.exit(1)
'''

SITECUSTOMIZE = r'''import json, os, sys

FIXTURE = os.environ.get("PARITY_FIXTURE_PATH")
if FIXTURE:
    try:
        sys.path.insert(0, os.environ["PARITY_REPO_ROOT"])
        import pr_reviewer.linear_context as _linear
        import pr_reviewer.platform as _platform

        with open(FIXTURE) as fh:
            _fx = json.load(fh)
        _plat = _fx.get("platform") or {}
        _gh_api_map = _plat.get("gh_api") or {}

        def _stub_gh_api(endpoint, allowed_repos=None, current_repo="", request_timeout=25, **kw):
            if endpoint in _gh_api_map:
                value = _gh_api_map[endpoint]
                if isinstance(value, dict) and "error" in value:
                    return {"error": str(value["error"])}
                return {"data": value}
            return {"error": "no fixture response for endpoint: %s" % endpoint}

        _platform.gh_api = _stub_gh_api

        _linear_map = _plat.get("linear") or {}
        _linear_fail = set(_plat.get("linear_fail") or [])
        _PRIORITY_LABELS = {0: "No priority", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low"}

        def _stub_fetch_issue(identifier, api_key, **kw):
            if identifier in _linear_fail:
                raise _linear.LinearContextError("Linear issue %s fetch failed (fixture)" % identifier)
            if identifier in _linear_map:
                issue = _linear_map[identifier]
                priority = issue.get("priority")
                return {
                    "source": "linear",
                    "ref": identifier,
                    "identifier": identifier,
                    "title": str(issue.get("title", "")),
                    "body": str(issue.get("body", "")),
                    "url": str(issue.get("url", "")),
                    "state": str(issue.get("state", "")),
                    "priority": priority,
                    "priority_label": _PRIORITY_LABELS.get(priority, ""),
                    "labels": [{"name": str(name)} for name in issue.get("labels", [])],
                }
            raise _linear.LinearContextError("Linear issue %s was not found" % identifier)

        _linear.fetch_issue = _stub_fetch_issue
    except Exception as exc:  # never break unrelated python invocations
        sys.stderr.write("sitecustomize: stub setup failed: %s\n" % exc)
'''


def is_forgejo(env: dict) -> bool:
    return env.get("PLATFORM", "github").lower() == "forgejo" or bool(env.get("FORGEJO_API_URL"))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: v2_precheck.py <fixture.json>", file=sys.stderr)
        return 2
    fixture_path = os.path.abspath(sys.argv[1])
    with open(fixture_path) as fh:
        fixture = json.load(fh)
    fixture_env = {key: str(value) for key, value in (fixture.get("env") or {}).items()}

    with tempfile.TemporaryDirectory(prefix="parity-v2-precheck-") as td:
        tmp = pathlib.Path(td)
        stub_dir = tmp / "bin"
        stub_dir.mkdir()
        workspace = tmp / "workspace"
        workspace.mkdir()

        (stub_dir / "gh").write_text(GH_STUB)
        (stub_dir / "gh").chmod(0o755)
        if is_forgejo(fixture_env):
            (stub_dir / "python3").write_text(FORGEJO_SHIM)
            (stub_dir / "python3").chmod(0o755)
            (stub_dir / "forgejo_stub.py").write_text(FORGEJO_STUB)
        (stub_dir / "sitecustomize.py").write_text(SITECUSTOMIZE)

        real_python3 = shutil.which("python3") or "/usr/bin/python3"
        env = {
            "PATH": f"{stub_dir}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(tmp),
            "TMPDIR": str(tmp),
            "LANG": "C.UTF-8",
        }
        env.update(fixture_env)
        env.update({
            "PARITY_FIXTURE_PATH": fixture_path,
            "PARITY_REPO_ROOT": str(ROOT),
            "PARITY_STUB_DIR": str(stub_dir),
            "REAL_PYTHON3": real_python3,
            "PYTHONPATH": f"{stub_dir}:{ROOT}",
            "GITHUB_OUTPUT": str(tmp / "github-output.txt"),
        })
        event = fixture.get("event")
        if event:
            event_file = tmp / "event.json"
            event_file.write_text(json.dumps({
                "action": event.get("action", ""),
                "label": {"name": event.get("label", "")},
            }))
            env["GITHUB_EVENT_PATH"] = str(event_file)
            env["GITHUB_EVENT_NAME"] = event.get("name", "pull_request")
        if fixture.get("event_head_sha"):
            env["EVENT_HEAD_SHA"] = str(fixture["event_head_sha"])

        proc = subprocess.run(
            ["bash", str(ROOT / "scripts" / "check_review_needed.sh")],
            cwd=workspace,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )
        values: dict[str, str] = {}
        output_file = tmp / "github-output.txt"
        if output_file.exists():
            for line in output_file.read_text().splitlines():
                key, sep, value = line.partition("=")
                if sep:
                    values[key] = value
        if proc.returncode != 0:
            print(json.dumps({"ok": False, "stderr": (proc.stderr or "").strip()}))
        else:
            print(json.dumps({"ok": True, "values": values}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
