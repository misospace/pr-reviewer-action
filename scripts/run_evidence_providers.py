#!/usr/bin/env python3
"""Execute evidence-provider commands and write structured results."""

import json
import os
import shlex
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

# Ensure the scripts directory is on sys.path so we can import shared helpers.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from redact import mask_and_truncate, mask_secrets  # noqa: E402


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(1, value)


def normalize_severity(value: object) -> str:
    if value is None:
        return "info"
    text = str(value).strip().lower()
    if text in {"info", "warning", "blocker"}:
        return text
    return "info"


def severity_rank(value: str) -> int:
    if value == "blocker":
        return 3
    if value == "warning":
        return 2
    return 1


def parse_findings(payload: object) -> tuple[str, list[dict[str, str]]]:
    provider_severity = "info"
    findings: list[dict[str, str]] = []

    if not isinstance(payload, dict):
        return provider_severity, findings

    provider_severity = normalize_severity(payload.get("severity"))
    raw_findings = payload.get("findings")

    if isinstance(raw_findings, list):
        for item in raw_findings:
            if isinstance(item, str):
                findings.append({"severity": "info", "message": item, "source": ""})
                continue

            if not isinstance(item, dict):
                continue

            message = item.get("message") or item.get("summary") or item.get("title")
            if message is None:
                continue

            source = item.get("source")
            if source is None and isinstance(item.get("sources"), list):
                source = ", ".join(
                    str(part) for part in item.get("sources", []) if part
                )

            findings.append(
                {
                    "severity": normalize_severity(item.get("severity")),
                    "message": str(message),
                    "source": "" if source is None else str(source),
                }
            )

    if not findings:
        fallback = payload.get("message") or payload.get("summary")
        if fallback is not None:
            findings.append(
                {"severity": provider_severity, "message": str(fallback), "source": ""}
            )

    highest = provider_severity
    for finding in findings:
        if severity_rank(finding["severity"]) > severity_rank(highest):
            highest = finding["severity"]

    return highest, findings[:40]


def run_provider(
    index: int, provider: object, default_timeout: int, default_max_output: int
) -> dict:
    """Execute a single evidence provider and return its result entry."""
    entry = {
        "id": f"provider-{index}",
        "status": "invalid",
        "command": "",
        "duration_sec": 0.0,
        "exit_code": None,
        "provider_severity": "info",
        "findings": [],
        "stdout": "",
        "stderr": "",
        "stdout_truncated": False,
        "stderr_truncated": False,
    }

    if isinstance(provider, dict) and provider.get("id"):
        entry["id"] = str(provider["id"])

    timeout = default_timeout
    max_output = default_max_output
    command = None

    if isinstance(provider, dict):
        command = provider.get("command")
        if provider.get("timeout_sec") is not None:
            try:
                timeout = max(1, int(provider["timeout_sec"]))
            except (TypeError, ValueError):
                timeout = default_timeout
        if provider.get("max_output_bytes") is not None:
            try:
                max_output = max(256, int(provider["max_output_bytes"]))
            except (TypeError, ValueError):
                max_output = default_max_output

    if not command:
        entry["status"] = "invalid"
        entry["stderr"] = "Missing required field: command"
        return entry

    start = time.monotonic()
    try:
        if isinstance(command, list):
            args = [str(part) for part in command]
            entry["command"] = " ".join(shlex.quote(part) for part in args)
            completed = subprocess.run(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
        else:
            command_text = str(command)
            entry["command"] = command_text
            completed = subprocess.run(
                ["bash", "-lc", command_text],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )

        entry["duration_sec"] = round(time.monotonic() - start, 3)
        entry["exit_code"] = completed.returncode
        entry["status"] = "ok" if completed.returncode == 0 else "error"

        # --- Secret redaction on stdout/stderr before capturing output ---
        stdout_text = completed.stdout.decode("utf-8", errors="replace") if completed.stdout else ""
        stderr_text = completed.stderr.decode("utf-8", errors="replace") if completed.stderr else ""
        entry["stdout"], entry["stdout_truncated"] = mask_and_truncate(
            stdout_text, max_output
        )
        entry["stderr"], entry["stderr_truncated"] = mask_and_truncate(
            stderr_text, max_output
        )
    except subprocess.TimeoutExpired as exc:
        entry["duration_sec"] = round(time.monotonic() - start, 3)
        entry["status"] = "timeout"
        entry["exit_code"] = None
        stdout_raw = exc.stdout if isinstance(exc.stdout, bytes) else b""
        stderr_raw = exc.stderr if isinstance(exc.stderr, bytes) else b""

        # Redact before storing in the summary JSON and markdown.
        entry["stdout"], entry["stdout_truncated"] = mask_and_truncate(
            stdout_raw.decode("utf-8", errors="replace") if stdout_raw else "",
            max_output,
        )
        entry["stderr"], entry["stderr_truncated"] = mask_and_truncate(
            stderr_raw.decode("utf-8", errors="replace") if stderr_raw else "",
            max_output,
        )

    # Also redact the stored stdout before JSON-parse attempt so that
    # any secrets leaking into the parsed output are already gone.
    entry["stdout"] = mask_secrets(entry["stdout"])

    parsed = None
    if entry["stdout"].strip():
        try:
            parsed = json.loads(entry["stdout"])
        except json.JSONDecodeError:
            parsed = None

    if parsed is not None:
        entry["output_format"] = "json"
        severity, findings = parse_findings(parsed)
        entry["provider_severity"] = severity
        entry["findings"] = findings
    else:
        entry["output_format"] = "text"

    return entry


def head_tail_cap(text: str, max_bytes: int) -> str:
    """Cap text at max_bytes keeping the head and the tail.

    Command failures usually print the interesting part (the error) at the
    end of the output, which a plain head-cap discarded.
    """
    raw = text.encode("utf-8", errors="replace")
    if len(raw) <= max_bytes:
        return text
    head_bytes = max_bytes * 6 // 10
    tail_bytes = max_bytes - head_bytes
    head = raw[:head_bytes].decode("utf-8", errors="ignore")
    tail = raw[len(raw) - tail_bytes :].decode("utf-8", errors="ignore")
    return head + "\n…[middle truncated]…\n" + tail


def write_outputs(summary: dict, markdown: str) -> None:
    Path("evidence-providers.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    Path("evidence-providers.md").write_text(markdown.rstrip() + "\n", encoding="utf-8")


def main() -> int:
    config_path_raw = os.getenv("EVIDENCE_PROVIDERS_FILE", "").strip()
    default_timeout = env_int("EVIDENCE_PROVIDER_TIMEOUT_SEC", 30)
    default_max_output = env_int("EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES", 20000)

    summary = {
        "configured": False,
        "config_path": config_path_raw,
        "has_blocker": False,
        "providers": [],
    }

    if not config_path_raw:
        write_outputs(summary, "No evidence providers configured.")
        return 0

    config_path = Path(config_path_raw)
    if not config_path.exists():
        summary["error"] = f"Config file not found: {config_path_raw}"
        write_outputs(
            summary, f"Evidence providers config was not found: `{config_path_raw}`"
        )
        return 0

    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        summary["error"] = f"Invalid JSON config: {exc}"
        write_outputs(
            summary, f"Evidence providers config could not be parsed: `{exc}`"
        )
        return 0

    if isinstance(payload, dict):
        providers = payload.get("providers", [])
    elif isinstance(payload, list):
        providers = payload
    else:
        providers = []

    if not isinstance(providers, list):
        providers = []

    summary["configured"] = True
    summary["provider_count"] = len(providers)

    md_lines = ["Evidence providers executed before final review synthesis.", ""]

    # Providers are independent commands, so run them concurrently. Results
    # keep config order regardless of completion order. Set
    # EVIDENCE_PROVIDER_PARALLELISM=1 for providers that must run serially
    # (e.g. they contend on the same working-tree files).
    parallelism = env_int("EVIDENCE_PROVIDER_PARALLELISM", 4)
    indexed = list(enumerate(providers[:25], start=1))

    def _run(item: tuple) -> dict:
        index, provider = item
        return run_provider(index, provider, default_timeout, default_max_output)

    if len(indexed) <= 1 or parallelism <= 1:
        entries = [_run(item) for item in indexed]
    else:
        with ThreadPoolExecutor(max_workers=min(parallelism, len(indexed))) as executor:
            entries = list(executor.map(_run, indexed))

    for entry in entries:
        if entry["provider_severity"] == "blocker":
            summary["has_blocker"] = True
        summary["providers"].append(entry)

    # Markdown embeds are head+tail capped, per stream and in aggregate, so
    # one chatty provider cannot crowd everything else out of the corpus.
    # evidence-providers.json keeps the full (per-provider capped) output.
    md_stdout_cap = env_int("EVIDENCE_MARKDOWN_STDOUT_BYTES", 4000)
    md_stderr_cap = env_int("EVIDENCE_MARKDOWN_STDERR_BYTES", 2000)
    md_budget = env_int("EVIDENCE_MARKDOWN_AGGREGATE_BYTES", 24000)

    def emit_stream(label: str, text: str, per_cap: int) -> None:
        nonlocal md_budget
        if md_budget < 256:
            md_lines.append(
                f"- {label}: (omitted — aggregate evidence output cap reached; "
                "full output in evidence-providers.json)"
            )
            return
        block = head_tail_cap(text, min(per_cap, md_budget))
        md_budget -= len(block.encode("utf-8", errors="replace"))
        md_lines.append(f"- {label}:")
        md_lines.append("```text")
        md_lines.append(block)
        md_lines.append("```")

    if not summary["providers"]:
        md_lines.append("No providers were configured in the config file.")
    else:
        for provider in summary["providers"]:
            md_lines.append(f"## {provider['id']}")
            md_lines.append(
                f"- status: {provider['status']}; severity: {provider['provider_severity']}; exit_code: {provider['exit_code']}; duration_sec: {provider['duration_sec']}"
            )
            md_lines.append(f"- command: `{provider['command']}`")

            findings = provider.get("findings", [])
            if findings:
                md_lines.append("- findings:")
                for finding in findings[:15]:
                    source = f" ({finding['source']})" if finding.get("source") else ""
                    md_lines.append(
                        f"  - [{finding['severity']}] {finding['message']}{source}"
                    )

            stdout_text = provider.get("stdout", "").strip()
            if stdout_text and not findings:
                emit_stream("stdout", stdout_text, md_stdout_cap)

            stderr_text = provider.get("stderr", "").strip()
            if stderr_text:
                emit_stream("stderr", stderr_text, md_stderr_cap)

            md_lines.append("")

    # Join md_lines into the markdown string, then redact it.
    markdown = "\n".join(md_lines)
    markdown = mask_secrets(markdown)

    write_outputs(summary, markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
