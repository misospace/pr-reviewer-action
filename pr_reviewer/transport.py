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
import time
from pathlib import Path

# redact_text lives in scripts/redact.py; ensure scripts/ is importable when
# this package module is loaded on its own.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import redact_text  # noqa: E402


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

# Transient upstream statuses worth another try: 429 and 503 are what a
# rate-limited or cooling-down gateway returns, the rest are gateway hiccups.
# Anything else 4xx/5xx is final.
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})
HTTP_RETRY_ATTEMPTS = 3
HTTP_RETRY_MAX_DELAY_SEC = 30.0


def _parse_response_headers(headers_path):
    """(status, retry_after_sec) from curl's dumped headers; the last status
    line wins so a followed redirect reports the terminal response."""
    status = None
    retry_after = None
    try:
        text = Path(headers_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None, None
    for line in text.splitlines():
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                status = int(parts[1])
                retry_after = None
        elif line.lower().startswith("retry-after:"):
            try:
                retry_after = float(line.split(":", 1)[1].strip())
            except ValueError:
                retry_after = None
    return status, retry_after


def run_chat_request(base_url, api_format, payload, api_key, timeout_sec):
    """POST a wire-ready chat payload via curl and return the parsed JSON.

    A retryable HTTP status (RETRYABLE_HTTP_STATUSES) is retried up to
    HTTP_RETRY_ATTEMPTS times, honouring ``Retry-After`` when present and
    otherwise backing off 1s then 2s, capped at HTTP_RETRY_MAX_DELAY_SEC.
    Before this a single rate-limit response abandoned the whole
    evidence-gathering phase.

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
        "-sSL",
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

    headers_fd, headers_path = tempfile.mkstemp()
    os.close(headers_fd)
    try:
        for attempt in range(1, HTTP_RETRY_ATTEMPTS + 1):
            completed = safe_run(
                curl_args + ["-D", headers_path, "--data", f"@{payload_path}"], timeout_sec + 5
            )
            if isinstance(completed, dict) and completed.get("timeout"):
                raise RuntimeError("planner model request timed out")
            if completed.returncode != 0:
                stderr = redact_text((completed.stderr or "").strip())
                if len(stderr) > 500:
                    stderr = stderr[:500] + "...[truncated]"
                raise RuntimeError(
                    f"planner model request failed with exit code {completed.returncode}"
                    + (f": {stderr}" if stderr else "")
                )
            status, retry_after = _parse_response_headers(headers_path)
            if status is None or status < 400:
                break
            if status in RETRYABLE_HTTP_STATUSES and attempt < HTTP_RETRY_ATTEMPTS:
                delay = retry_after if retry_after is not None else float(2 ** (attempt - 1))
                time.sleep(max(0.0, min(delay, HTTP_RETRY_MAX_DELAY_SEC)))
                continue
            body = redact_text((completed.stdout or "").strip())
            if len(body) > 300:
                body = body[:300] + "...[truncated]"
            raise RuntimeError(
                f"planner model request failed with HTTP {status}"
                + (f": {body}" if body else "")
            )
    finally:
        for cleanup_path in (payload_path, auth_config_path, headers_path):
            if cleanup_path is None:
                continue
            try:
                os.unlink(cleanup_path)
            except OSError:
                pass

    if streaming:
        # SSE deltas → the non-streaming response shape the loop parses. The
        # reassembler also surfaces a JSON error body returned mid-"stream"
        # (some servers reply 200 + an error object instead of events).
        from pr_reviewer.sse_reassembler import reassemble_sse  # noqa: PLC0415

        return reassemble_sse(completed.stdout, api_format)
    return json.loads(completed.stdout)
