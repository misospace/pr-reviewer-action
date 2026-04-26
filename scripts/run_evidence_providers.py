#!/usr/bin/env python3
import json
import os
import shlex
import subprocess
import time
from pathlib import Path


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(1, value)


def truncate_text(raw: bytes, limit: int) -> tuple[str, bool]:
    if len(raw) <= limit:
        return raw.decode("utf-8", errors="replace"), False
    clipped = raw[:limit].decode("utf-8", errors="replace")
    return clipped + "\n[truncated]", True


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

    for index, provider in enumerate(providers[:25], start=1):
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
            summary["providers"].append(entry)
            continue

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
            entry["stdout"], entry["stdout_truncated"] = truncate_text(
                completed.stdout, max_output
            )
            entry["stderr"], entry["stderr_truncated"] = truncate_text(
                completed.stderr, max_output
            )
        except subprocess.TimeoutExpired as exc:
            entry["duration_sec"] = round(time.monotonic() - start, 3)
            entry["status"] = "timeout"
            entry["exit_code"] = None
            stdout_raw = exc.stdout if isinstance(exc.stdout, bytes) else b""
            stderr_raw = exc.stderr if isinstance(exc.stderr, bytes) else b""
            entry["stdout"], entry["stdout_truncated"] = truncate_text(
                stdout_raw, max_output
            )
            entry["stderr"], entry["stderr_truncated"] = truncate_text(
                stderr_raw, max_output
            )

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

        if entry["provider_severity"] == "blocker":
            summary["has_blocker"] = True

        summary["providers"].append(entry)

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
                md_lines.append("- stdout:")
                md_lines.append("```text")
                md_lines.append(stdout_text)
                md_lines.append("```")

            stderr_text = provider.get("stderr", "").strip()
            if stderr_text:
                md_lines.append("- stderr:")
                md_lines.append("```text")
                md_lines.append(stderr_text)
                md_lines.append("```")

            md_lines.append("")

    write_outputs(summary, "\n".join(md_lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
