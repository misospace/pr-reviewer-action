#!/usr/bin/env python3
"""Stub of the forge REST API, for the forge CLI's tests.

The stub implements exactly the endpoints ``scripts/forge_cli.py`` calls:

- ``GET    /repos/{o}/{r}/commits/{sha}/pulls``
- ``GET    /repos/{o}/{r}/issues/{n}/labels``
- ``POST   /repos/{o}/{r}/issues/{n}/labels``
- ``DELETE /repos/{o}/{r}/issues/{n}/labels/{name}``
- ``GET    /repos/{o}/{r}/releases/tags/{tag}``
- ``POST   /repos/{o}/{r}/releases``
- ``GET    /repos/{o}/{r}/pulls``
- ``POST   /repos/{o}/{r}/pulls``
- ``GET    /repos/{o}/{r}/git/ref/tags/{tag}``
- ``GET    /repos/{o}/{r}/git/commits/{sha}``

It is usable from two directions, so the shell suites and the pytest suite
share one implementation:

- as a library (``ForgeStubServer``) for pytest: start it on a loopback
  port, point ``GITHUB_API_URL`` at it, and assert on the recorded
  requests;
- as a program (``serve`` / ``dump``) for the shell suites: run it in the
  background, let it write the bound port to a file, and assert on the
  recorded request log.

Behaviour is driven by a small JSON state file, re-read on every request,
so a test can change the stub's answers between calls:

``commit_pulls``    map of commit SHA -> pull request number
``labels``          map of issue number (as a string) -> list of label names
``releases``        list of release tags
``open_prs``        map of branch name -> pull request number
``tag_refs``        map of tag -> object SHA
``commit_parents``  map of commit SHA -> parent SHA (``""`` = no parent)
``fail_paths``      list of path fragments that must answer HTTP 500
``reflect_token``   when true, hostile mode: echo the request's
                    ``Authorization`` header back -- in the error body of a
                    failed request, and in the ``html_url`` of a created
                    release or pull request
``malformed_status_paths``
                    list of path fragments that must answer with a forged
                    status line carrying the request's credential, so the
                    transport sees a malformed HTTP response
``next_pr_number``  number handed out for a created pull request

Every request is recorded (method, path, query, headers, body) so a test
can assert on the exact call the CLI made.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_STATE: dict = {
    "commit_pulls": {},
    "labels": {},
    "releases": [],
    "open_prs": {},
    "tag_refs": {},
    "commit_parents": {},
    "fail_paths": [],
    "reflect_token": False,
    "malformed_status_paths": [],
    "next_pr_number": 900,
}

_REPOS = re.compile(r"^/repos/(?P<owner>[^/]+)/(?P<repo>[^/]+)(?P<rest>/.*)?$")
_COMMIT_PULLS = re.compile(r"^/commits/(?P<sha>[^/]+)/pulls$")
_ISSUE_LABELS = re.compile(r"^/issues/(?P<number>[^/]+)/labels$")
_ISSUE_LABEL = re.compile(r"^/issues/(?P<number>[^/]+)/labels/(?P<name>.+)$")
_RELEASE_TAG = re.compile(r"^/releases/tags/(?P<tag>.+)$")
_RELEASES = re.compile(r"^/releases$")
_PULLS = re.compile(r"^/pulls$")
_GIT_REF = re.compile(r"^/git/ref/tags/(?P<tag>.+)$")
_GIT_COMMIT = re.compile(r"^/git/commits/(?P<sha>[^/]+)$")


def load_state(path: str | os.PathLike[str] | None) -> dict:
    """Read the stub state, filling in the defaults for absent keys."""
    state = dict(DEFAULT_STATE)
    if path is None:
        return state
    file = Path(path)
    if not file.is_file():
        return state
    try:
        payload = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return state
    if isinstance(payload, dict):
        state.update(payload)
    return state


def save_state(path: str | os.PathLike[str] | None, state: dict) -> None:
    """Persist the stub state so a mutation survives the next request."""
    if path is None:
        return
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_suffix(file.suffix + ".tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, file)


class _Handler(BaseHTTPRequestHandler):
    """Answers the forge endpoints the CLI uses."""

    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, *_args) -> None:  # noqa: ANN001
        """Keep the stub quiet."""

    @property
    def stub(self) -> "ForgeStubServer":
        return self.server.stub  # type: ignore[attr-defined]

    def _record(self, body: str) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        entry = {
            "method": self.command,
            "path": parsed.path,
            "query": parsed.query,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        }
        self.stub.record(entry)

    def _read_body(self) -> str:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return ""
        raw = self.rfile.read(length)
        return raw.decode("utf-8", errors="replace")

    def _reflected_url(self, fallback: str) -> str:
        """A URL that carries the credential back at the caller.

        Hostile mode: the forge answers a successful create with a URL that
        contains the token it was given. The adapter must print nothing it
        did not validate itself, so the reflected credential reaches no log.
        """
        if not self.stub.state.get("reflect_token"):
            return fallback
        reflected = self.headers.get("Authorization") or ""
        return f"https://forge.invalid/{urllib.parse.quote(reflected, safe='')}"

    def _send(self, status: int, payload: object) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_raw(self, status: int, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _not_found(self) -> None:
        self._send(404, {"message": "Not Found"})

    # -- routing ----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def _handle(self, method: str) -> None:
        body = self._read_body()
        self._record(body)
        # Re-read the state file so a test can change the stub's answers
        # between two calls.
        self.stub.reload()
        state = self.stub.state
        parsed = urllib.parse.urlsplit(self.path)
        for fragment in state.get("fail_paths") or []:
            if fragment and fragment in parsed.path:
                if state.get("reflect_token"):
                    # Hostile mode: reflect the credential back at the
                    # caller. The CLI must not echo it anywhere.
                    reflected = self.headers.get("Authorization") or ""
                    self._send_raw(500, json.dumps({"message": f"bad token {reflected}"}))
                else:
                    self._send(500, {"message": "stub failure"})
                return
        for fragment in state.get("malformed_status_paths") or []:
            if fragment and fragment in parsed.path:
                # Hostile mode: answer with a malformed status line that
                # carries the credential the stub was given. The transport
                # must refuse the response, and no part of the forged line
                # may reach a log.
                reflected = (self.headers.get("Authorization") or "").removeprefix("Bearer ")
                self.wfile.write(b"HTTP/1.1 " + reflected.encode("utf-8", "replace") + b"\r\n\r\n")
                self.wfile.flush()
                self.close_connection = True
                return
        match = _REPOS.match(parsed.path)
        if not match:
            self._not_found()
            return
        rest = match.group("rest") or ""
        owner = match.group("owner")
        repo = match.group("repo")
        query = dict(urllib.parse.parse_qsl(parsed.query))

        commit_pulls = _COMMIT_PULLS.match(rest)
        if commit_pulls and method == "GET":
            number = (state.get("commit_pulls") or {}).get(commit_pulls.group("sha"))
            self._send(200, [] if number is None else [{"number": number}])
            return

        issue_label = _ISSUE_LABEL.match(rest)
        if issue_label and method == "DELETE":
            number = issue_label.group("number")
            name = urllib.parse.unquote(issue_label.group("name"))
            labels = list((state.get("labels") or {}).get(number) or [])
            if name not in labels:
                self._not_found()
                return
            labels.remove(name)
            state.setdefault("labels", {})[number] = labels
            self.stub.save_state()
            self._send(200, labels)
            return

        issue_labels = _ISSUE_LABELS.match(rest)
        if issue_labels and method == "GET":
            number = issue_labels.group("number")
            labels = list((state.get("labels") or {}).get(number) or [])
            self._send(200, [{"name": name} for name in labels])
            return
        if issue_labels and method == "POST":
            number = issue_labels.group("number")
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                self._send(400, {"message": "invalid JSON"})
                return
            added = payload.get("labels") if isinstance(payload, dict) else None
            if not isinstance(added, list):
                self._send(422, {"message": "labels must be a list"})
                return
            labels = list((state.get("labels") or {}).get(number) or [])
            for name in added:
                if isinstance(name, str) and name not in labels:
                    labels.append(name)
            state.setdefault("labels", {})[number] = labels
            self.stub.save_state()
            self._send(200, [{"name": name} for name in labels])
            return

        release_tag = _RELEASE_TAG.match(rest)
        if release_tag and method == "GET":
            tag = release_tag.group("tag")
            if tag in (state.get("releases") or []):
                self._send(200, {"tag_name": tag, "html_url": self.stub.release_url(owner, repo, tag)})
            else:
                self._not_found()
            return

        releases = _RELEASES.match(rest)
        if releases and method == "POST":
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                self._send(400, {"message": "invalid JSON"})
                return
            tag = payload.get("tag_name") if isinstance(payload, dict) else None
            if not isinstance(tag, str) or not tag:
                self._send(422, {"message": "tag_name is required"})
                return
            releases_list = list(state.get("releases") or [])
            if tag not in releases_list:
                releases_list.append(tag)
            state["releases"] = releases_list
            self.stub.save_state()
            url = self._reflected_url(self.stub.release_url(owner, repo, tag))
            self._send(201, {"tag_name": tag, "html_url": url})
            return

        pulls = _PULLS.match(rest)
        if pulls and method == "GET":
            head = query.get("head") or ""
            branch = head.split(":", 1)[1] if ":" in head else head
            number = (state.get("open_prs") or {}).get(branch)
            self._send(200, [] if number is None else [{"number": number}])
            return
        if pulls and method == "POST":
            try:
                payload = json.loads(body) if body else {}
            except json.JSONDecodeError:
                self._send(400, {"message": "invalid JSON"})
                return
            number = int(state.get("next_pr_number") or 900)
            state["next_pr_number"] = number + 1
            head = payload.get("head") if isinstance(payload, dict) else None
            if isinstance(head, str) and head:
                state.setdefault("open_prs", {})[head] = number
            self.stub.save_state()
            url = self._reflected_url(self.stub.pull_url(owner, repo, number))
            self._send(201, {"number": number, "html_url": url})
            return

        git_ref = _GIT_REF.match(rest)
        if git_ref and method == "GET":
            tag = git_ref.group("tag")
            sha = (state.get("tag_refs") or {}).get(tag)
            if sha is None:
                self._not_found()
            else:
                self._send(200, {"ref": f"refs/tags/{tag}", "object": {"sha": sha, "type": "commit"}})
            return

        git_commit = _GIT_COMMIT.match(rest)
        if git_commit and method == "GET":
            sha = git_commit.group("sha")
            parents = (state.get("commit_parents") or {}).get(sha)
            if parents is None:
                self._not_found()
            elif parents == "":
                self._send(200, {"sha": sha, "parents": []})
            else:
                self._send(200, {"sha": sha, "parents": [{"sha": parents}]})
            return

        self._not_found()


class ForgeStubServer:
    """The stub, usable as a library from pytest."""

    def __init__(
        self,
        state_path: str | os.PathLike[str] | None = None,
        log_path: str | os.PathLike[str] | None = None,
        state: dict | None = None,
    ) -> None:
        self.state_path = str(state_path) if state_path is not None else None
        self.log_path = str(log_path) if log_path is not None else None
        self._state = state if state is not None else load_state(self.state_path)
        self.requests: list[dict] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle --------------------------------------------------------

    def start(self) -> "ForgeStubServer":
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        server.daemon_threads = True
        server.stub = self  # type: ignore[attr-defined]
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def __enter__(self) -> "ForgeStubServer":
        return self.start()

    def __exit__(self, *_exc) -> None:  # noqa: ANN001
        self.stop()

    # -- addressing -------------------------------------------------------

    @property
    def port(self) -> int:
        if self._server is None:
            raise RuntimeError("the stub server is not running")
        return self._server.server_port

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def release_url(self, owner: str, repo: str, tag: str) -> str:
        return f"{self.base_url}/{owner}/{repo}/releases/tag/{tag}"

    def pull_url(self, owner: str, repo: str, number: int) -> str:
        return f"{self.base_url}/{owner}/{repo}/pull/{number}"

    # -- state ------------------------------------------------------------

    @property
    def state(self) -> dict:
        return self._state

    def set_state(self, **updates) -> None:
        self._state.update(updates)
        self.save_state()

    def reload(self) -> None:
        """Re-read the state file, so external changes take effect."""
        if self.state_path is None:
            return
        self._state = load_state(self.state_path)

    def save_state(self) -> None:
        save_state(self.state_path, self._state)

    def record(self, entry: dict) -> None:
        self.requests.append(entry)
        if self.log_path is None:
            return
        with open(self.log_path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")


def _serve(args: argparse.Namespace) -> int:
    stub = ForgeStubServer(state_path=args.state, log_path=args.log)
    stub.start()
    if args.port_file:
        port_file = Path(args.port_file)
        port_file.parent.mkdir(parents=True, exist_ok=True)
        port_file.write_text(str(stub.port), encoding="utf-8")
    sys.stdout.write(f"forge stub listening on {stub.base_url}\n")
    sys.stdout.flush()

    stop = threading.Event()

    def _handle_signal(_signum, _frame) -> None:  # noqa: ANN001
        stop.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    while not stop.is_set():
        stop.wait(0.2)
    stub.stop()
    return 0


def _dump(args: argparse.Namespace) -> int:
    """Print the recorded requests as ``METHOD PATH BODY`` lines."""
    log = Path(args.log)
    if not log.is_file():
        return 0
    for line in log.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        method = entry.get("method", "")
        path = entry.get("path", "")
        if args.method and method != args.method:
            continue
        if args.path_contains and args.path_contains not in path:
            continue
        body = entry.get("body") or ""
        print(f"{method} {path} {body}".rstrip())
    return 0


def _dump_state(args: argparse.Namespace) -> int:
    print(json.dumps(load_state(args.state), indent=2, sort_keys=True))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the stub server")
    serve.add_argument("--state", default="")
    serve.add_argument("--log", default="")
    serve.add_argument("--port-file", default="")
    serve.set_defaults(handler=_serve)

    dump = sub.add_parser("dump", help="print the recorded requests")
    dump.add_argument("--log", required=True)
    dump.add_argument("--method", default="")
    dump.add_argument("--path-contains", default="")
    dump.set_defaults(handler=_dump)

    state = sub.add_parser("dump-state", help="print the stub state")
    state.add_argument("--state", required=True)
    state.set_defaults(handler=_dump_state)

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
