#!/usr/bin/env python3
"""Parity runner (v2 side, specialists-gate boundary, #706 PR 6).

Runs the REAL ``scripts/run_specialists.py`` (and through it the real
``pr_reviewer.transport.run_chat_request`` curl transport) in a scratch
workspace against a local mock model endpoint serving the fixture's canned
responses per role — the role is identified from the system prompt it was
sent, so the three concurrent role calls are served deterministically. No
real model is ever called.

Prints ``{ok, values}`` in the shape the v3 fixture CLI
(``specialists-gate-fixture``, src/gates/specialists-gate-fixture.ts)
produces: every specialist artifact byte for byte (``file:<name>``), the
per-role request bodies the endpoint received (canonical JSON; integral
floats written as integers, since the two transports serialize the same
number differently on the wire), exit code, stdout and stderr. Only
wall-clock ``elapsed_sec`` values and the mock endpoint's port are
normalized, identically on both sides.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FRAGMENTS = ROOT / "scripts" / "prompt_fragments"
ROLES = ("correctness", "security", "tests")
SCOUT_PREFIX = "You are performing three specialist review passes"


def normalize(text: str) -> str:
    text = re.sub(r'("(?:aggregate_)?elapsed_sec": )-?[0-9][0-9.e+-]*', r'\1"<ELAPSED>"', text)
    text = re.sub(r"error\(s\), [0-9][0-9.e+-]*s", "error(s), <ELAPSED>s", text)
    text = re.sub(r"roles in [0-9][0-9.e+-]*s", "roles in <ELAPSED>s", text)
    return re.sub(r"127\.0\.0\.1:[0-9]+", "127.0.0.1:<PORT>", text)


def integral_floats(value):
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [integral_floats(item) for item in value]
    if isinstance(value, dict):
        return {key: integral_floats(item) for key, item in value.items()}
    return value


def sorted_json(value) -> str:
    return json.dumps(integral_floats(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main() -> int:
    fixture = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    prompts = {role: (FRAGMENTS / f"specialist_{role}.txt").read_text(encoding="utf-8") for role in ROLES}
    prompts["correctness_adversarial"] = (FRAGMENTS / "specialist_correctness_adversarial.txt").read_text(encoding="utf-8")
    responses = fixture.get("responses", {})
    received: dict[str, list[dict]] = {}
    cursors: dict[str, int] = {}
    lock = threading.Lock()

    def identify(payload: dict) -> str:
        system = payload.get("system")
        if not isinstance(system, str):
            messages = payload.get("messages") or [{}]
            system = messages[0].get("content", "") if isinstance(messages[0], dict) else ""
        if system.startswith(SCOUT_PREFIX):
            return "scout"
        for name, text in prompts.items():
            if system == text:
                return name.removesuffix("_adversarial")
        return "unknown"

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            role = identify(payload)
            with lock:
                received.setdefault(role, []).append({
                    "body": sorted_json(payload),
                    "auth": bool(self.headers.get("Authorization") or self.headers.get("x-api-key")),
                })
                sequence = responses.get(role, [])
                index = cursors.get(role, 0)
                cursors[role] = index + 1
            entry = sequence[min(index, len(sequence) - 1)] if sequence else None
            if entry is None:
                body = json.dumps({"error": {"message": f"no mock response for {role}"}}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if "sse" in entry:
                body = "".join(f"{line}\n\n" for line in entry["sse"]).encode()
                content_type = "text/event-stream"
            else:
                text = entry["raw"] if "raw" in entry else json.dumps(entry.get("body"))
                body = text.encode()
                content_type = "application/json"
            self.send_response(entry.get("status", 200))
            for name, value in entry.get("headers", {}).items():
                self.send_header(name, value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix="v2-specialists-") as td:
            workspace = Path(td)
            if isinstance(fixture.get("corpus"), str):
                (workspace / "specialist-corpus.md").write_text(fixture["corpus"], encoding="utf-8")
            args = list(fixture.get("args", []))
            if isinstance(fixture.get("adversarial_corpus"), str):
                (workspace / "specialist-corpus-adversarial.md").write_text(fixture["adversarial_corpus"], encoding="utf-8")
                args += ["--adversarial-corpus", "specialist-corpus-adversarial.md"]
            if "classification" in fixture:
                (workspace / "classification.json").write_text(json.dumps(fixture["classification"]), encoding="utf-8")
            env = {
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": str(workspace),
                "TMPDIR": str(workspace),
                "PYTHONIOENCODING": "utf-8",
                "AI_BASE_URL": f"http://127.0.0.1:{server.server_address[1]}/v1",
                "AI_API_KEY": "fixture-api-key",
                "AI_MODEL": "fixture-model",
                "GITHUB_WORKSPACE": str(workspace),
            }
            env.update(fixture.get("env", {}))
            proc = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "run_specialists.py"), "--corpus", "specialist-corpus.md", *args],
                capture_output=True,
                env=env,
                cwd=str(workspace),
                timeout=300,
            )
            values = {
                "exit_code": str(proc.returncode),
                "stdout": normalize(proc.stdout.decode("utf-8").rstrip("\n")),
                "stderr": normalize(proc.stderr.decode("utf-8").rstrip("\n")),
                "requests": json.dumps({role: received[role] for role in sorted(received)}, separators=(",", ":"), ensure_ascii=False),
            }
            for name in sorted(os.listdir(workspace)):
                if not name.startswith("specialist") or name in ("specialist-corpus.md", "specialist-corpus-adversarial.md"):
                    continue
                values[f"file:{name}"] = normalize((workspace / name).read_text(encoding="utf-8"))
    finally:
        server.shutdown()
    print(json.dumps({"ok": True, "values": values}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
