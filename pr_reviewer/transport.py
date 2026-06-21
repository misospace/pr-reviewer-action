#!/usr/bin/env python3
"""HTTP/subprocess transport for the tool harness (#304 split).

Owns the low-level model-call transport (curl-based chat requests + the simple
one-shot completion) and the shared subprocess runner. Split out of
scripts/run_tool_harness.py with no behaviour change.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# mask_secrets lives in scripts/redact.py; ensure scripts/ is importable when
# this package module is loaded on its own.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_secrets  # noqa: E402


def safe_run(args, timeout_sec):
    """Run a command and capture stdout/stderr with a timeout."""
    try:
        return subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "timeout": True,
            "stdout": (exc.stdout or "") if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "") if isinstance(exc.stderr, str) else "",
        }

def run_chat_request(base_url, api_format, payload, api_key, timeout_sec):
    """POST a wire-ready chat payload via curl and return the parsed JSON.

    Transport for the native tool-calling loop (#203): the payload is built
    by ``pr_reviewer.conversation.Conversation.to_request_payload``, so this
    function owns only the endpoint choice, auth, and JSON decode.
    """
    if api_format == "anthropic":
        endpoint = base_url.rstrip("/") + "/messages"
    else:
        endpoint = base_url.rstrip("/") + "/chat/completions"

    curl_args = [
        "curl",
        "-q",
        "-fsSL",
        "--max-time",
        str(timeout_sec),
        endpoint,
        "-H",
        "Content-Type: application/json",
    ]
    if api_format == "anthropic":
        curl_args.extend(["-H", f"anthropic-version: {os.getenv('ANTHROPIC_VERSION', '2023-06-01')}"])

    # Streaming keeps bytes flowing so proxies with a short idle/read timeout
    # (Cloudflare's 100s edge timer etc.) don't 524 a long thinking-model turn.
    # --no-buffer flushes each SSE chunk; the body is reassembled below.
    streaming = bool(payload.get("stream"))
    if streaming:
        curl_args.append("--no-buffer")
        if api_format == "anthropic":
            curl_args.extend(["-H", "Accept: text/event-stream"])

    # The API key goes through a 0600 curl --config file rather than argv, so
    # it never appears in /proc/<pid>/cmdline or `ps` output on shared runners.
    auth_config_path = None
    if api_key:
        if api_format == "anthropic":
            auth_header = f"x-api-key: {api_key}"
        else:
            auth_header = f"Authorization: Bearer {api_key}"
        escaped = auth_header.replace("\\", "\\\\").replace('"', '\\"')
        fd, auth_config_path = tempfile.mkstemp()
        with os.fdopen(fd, "w", encoding="utf-8") as auth_file:
            auth_file.write(f'header = "{escaped}"\n')
        os.chmod(auth_config_path, 0o600)
        curl_args.extend(["--config", auth_config_path])

    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as payload_file:
        json.dump(payload, payload_file)
        payload_path = payload_file.name

    try:
        completed = safe_run(curl_args + ["--data", f"@{payload_path}"], timeout_sec + 5)
    finally:
        for cleanup_path in (payload_path, auth_config_path):
            if cleanup_path is None:
                continue
            try:
                os.unlink(cleanup_path)
            except OSError:
                pass

    if isinstance(completed, dict) and completed.get("timeout"):
        raise RuntimeError("planner model request timed out")
    if completed.returncode != 0:
        stderr = mask_secrets((completed.stderr or "").strip())
        if len(stderr) > 500:
            stderr = stderr[:500] + "...[truncated]"
        raise RuntimeError(
            f"planner model request failed with exit code {completed.returncode}"
            + (f": {stderr}" if stderr else "")
        )

    if streaming:
        # SSE deltas → the non-streaming response shape the loop parses. The
        # reassembler also surfaces a JSON error body returned mid-"stream"
        # (some servers reply 200 + an error object instead of events).
        from pr_reviewer.sse_reassembler import reassemble_sse  # noqa: PLC0415

        return reassemble_sse(completed.stdout, api_format)
    return json.loads(completed.stdout)
