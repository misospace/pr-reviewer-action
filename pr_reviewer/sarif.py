"""Normalize local SARIF 2.1.0 results into stable evidence findings.

The importable :func:`normalize_sarif` function accepts an already-decoded JSON
value and returns a version-1 artifact with a stable finding schema. Findings
are emitted in declared SARIF run/result order, and exact normalized duplicates
are removed while keeping the first occurrence. The normalizer accepts only the
SARIF version string ``2.1.0``; unsupported or malformed top-level input is
reported in ``errors`` rather than being treated as an empty successful scan.

The artifact has this shape::

    {
        "version": 1,
        "source_format": "sarif-2.1.0",
        "findings": [
            {
                "tool_name": "scanner",
                "tool_version": "1.0",
                "rule_id": "RULE-1",
                "title": "Rule title",
                "message": "Finding message",
                "severity": "major",
                "file": "src/app.py",
                "line": 12,
                "help_uri": "https://example.test/rule"
            }
        ],
        "truncated": False,
        "truncation": {
            "truncated": False,
            "reasons": [],
            "omitted_findings": 0,
            "omitted_message_chars": 0,
            "omitted_title_chars": 0,
            "omitted_errors": 0
        },
        "errors": []
    }

Messages and titles are bounded by character caps, the finding list is bounded
by a finding cap, and artifact errors are bounded by ``MAX_ERRORS``. Truncation
records both its reason and omitted counts. This module only parses in-memory data
and local files: it performs no network access, invokes no external commands, and
never executes SARIF content.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

ARTIFACT_VERSION = 1
SARIF_VERSION = "2.1.0"
SOURCE_FORMAT = "sarif-2.1.0"
MAX_FINDINGS = 200
MAX_MESSAGE_CHARS = 1000
MAX_TITLE_CHARS = 200
MAX_ERRORS = 100
MAX_INPUT_BYTES = 10_000_000
ERRORS_TRUNCATED_MARKER = "errors_truncated"


def _empty_artifact() -> dict[str, Any]:
    return {
        "version": ARTIFACT_VERSION,
        "source_format": SOURCE_FORMAT,
        "findings": [],
        "truncated": False,
        "truncation": {
            "truncated": False,
            "reasons": [],
            "omitted_findings": 0,
            "omitted_message_chars": 0,
            "omitted_title_chars": 0,
            "omitted_errors": 0,
        },
        "errors": [],
    }


def _add_error(result: dict[str, Any], message: str) -> None:
    errors = result["errors"]
    if len(errors) < MAX_ERRORS:
        errors.append(message)
        return
    truncation = result["truncation"]
    result["truncated"] = True
    truncation["truncated"] = True
    truncation["omitted_errors"] += 1
    if errors[-1] != ERRORS_TRUNCATED_MARKER:
        errors.append(ERRORS_TRUNCATED_MARKER)
    if "errors_cap" not in truncation["reasons"]:
        truncation["reasons"].append("errors_cap")


def _cap(value: object, default: int, name: str, result: dict[str, Any]) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        _add_error(result, f"{name} must be a non-negative integer")
        return default
    return value


def _bounded_text(
    value: str,
    limit: int,
    counter: str,
    result: dict[str, Any],
) -> str:
    if len(value) <= limit:
        return value
    result["truncated"] = True
    result["truncation"]["truncated"] = True
    result["truncation"]["omitted_" + counter] += len(value) - limit
    reason = counter + "_cap"
    if reason not in result["truncation"]["reasons"]:
        result["truncation"]["reasons"].append(reason)
    return value[:limit]


def _string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _rule_title(rule: dict[str, Any] | None, rule_id: str) -> str:
    if rule:
        short_description = rule.get("shortDescription")
        if isinstance(short_description, dict):
            text = _string(short_description.get("text"))
            if text and text.strip():
                return text
        for key in ("name", "id"):
            text = _string(rule.get(key))
            if text and text.strip():
                return text
    return rule_id


def _help_uri(rule: dict[str, Any] | None, information_uri: str) -> str:
    if rule:
        value = _string(rule.get("helpUri"))
        if value and value.strip():
            return value
    return information_uri


def _location(
    result_data: dict[str, Any],
    path: str,
    result: dict[str, Any],
) -> tuple[str, int | None]:
    locations = result_data.get("locations")
    if locations is None:
        return "", None
    if not isinstance(locations, list):
        _add_error(result, f"{path}.locations is not an array")
        return "", None

    for index, location in enumerate(locations):
        if not isinstance(location, dict):
            _add_error(result, f"{path}.locations[{index}] is not an object")
            continue
        physical = location.get("physicalLocation")
        if physical is None:
            continue
        if not isinstance(physical, dict):
            _add_error(
                result,
                f"{path}.locations[{index}].physicalLocation is not an object",
            )
            continue
        artifact = physical.get("artifactLocation")
        uri = ""
        if artifact is not None:
            if isinstance(artifact, dict):
                candidate = _string(artifact.get("uri"))
                if candidate and candidate.strip():
                    uri = candidate
            else:
                _add_error(
                    result,
                    f"{path}.locations[{index}].physicalLocation.artifactLocation "
                    "is not an object",
                )
        region = physical.get("region")
        line: int | None = None
        if region is not None:
            if isinstance(region, dict):
                candidate = region.get("startLine")
                if isinstance(candidate, int) and not isinstance(candidate, bool):
                    line = candidate
            else:
                _add_error(
                    result,
                    f"{path}.locations[{index}].physicalLocation.region "
                    "is not an object",
                )
        if uri or line is not None:
            return uri, line
    return "", None


def _top_level_error(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return "SARIF payload must be a JSON object"
    if payload.get("version") != SARIF_VERSION:
        return "SARIF version must be exactly '2.1.0'"
    if not isinstance(payload.get("runs"), list):
        return "SARIF payload must contain a runs array"
    return None


def normalize_sarif(
    payload: object,
    *,
    max_findings: int = MAX_FINDINGS,
    max_message_chars: int = MAX_MESSAGE_CHARS,
    max_title_chars: int = MAX_TITLE_CHARS,
) -> dict[str, Any]:
    """Normalize a decoded SARIF payload without I/O, commands, or network calls."""
    output = _empty_artifact()
    max_findings = _cap(max_findings, MAX_FINDINGS, "max_findings", output)
    max_message_chars = _cap(
        max_message_chars, MAX_MESSAGE_CHARS, "max_message_chars", output
    )
    max_title_chars = _cap(max_title_chars, MAX_TITLE_CHARS, "max_title_chars", output)

    top_level_error = _top_level_error(payload)
    if top_level_error is not None:
        _add_error(output, top_level_error)
        return output

    runs = payload["runs"]

    candidates: list[dict[str, Any]] = []
    for run_index, run in enumerate(runs):
        run_path = f"runs[{run_index}]"
        if not isinstance(run, dict):
            _add_error(output, f"{run_path} is not an object")
            continue

        tool_name = ""
        tool_version = ""
        information_uri = ""
        rules: list[dict[str, Any] | None] = []
        rules_by_id: dict[str, dict[str, Any]] = {}
        tool = run.get("tool")
        if tool is not None:
            if not isinstance(tool, dict):
                _add_error(output, f"{run_path}.tool is not an object")
            else:
                driver = tool.get("driver")
                if driver is not None:
                    if not isinstance(driver, dict):
                        _add_error(output, f"{run_path}.tool.driver is not an object")
                    else:
                        tool_name = _string(driver.get("name")) or ""
                        tool_version = _string(driver.get("version")) or ""
                        information_uri = _string(driver.get("informationUri")) or ""
                        raw_rules = driver.get("rules")
                        if raw_rules is not None:
                            if not isinstance(raw_rules, list):
                                _add_error(
                                    output,
                                    f"{run_path}.tool.driver.rules is not an array",
                                )
                            else:
                                for rule_index, rule in enumerate(raw_rules):
                                    if not isinstance(rule, dict):
                                        _add_error(
                                            output,
                                            f"{run_path}.tool.driver.rules[{rule_index}] "
                                            "is not an object",
                                        )
                                        rules.append(None)
                                        continue
                                    rules.append(rule)
                                    rule_id = _string(rule.get("id"))
                                    if rule_id and rule_id not in rules_by_id:
                                        rules_by_id[rule_id] = rule

        raw_results = run.get("results", [])
        if not isinstance(raw_results, list):
            _add_error(output, f"{run_path}.results is not an array")
            continue
        for result_index, result_data in enumerate(raw_results):
            result_path = f"{run_path}.results[{result_index}]"
            if not isinstance(result_data, dict):
                _add_error(output, f"{result_path} is not an object")
                continue
            message_data = result_data.get("message")
            message = (
                message_data.get("text")
                if isinstance(message_data, dict)
                else None
            )
            if not isinstance(message, str) or not message.strip():
                _add_error(output, f"{result_path} is missing a usable message")
                continue

            rule_id = _string(result_data.get("ruleId")) or ""
            rule = rules_by_id.get(rule_id)
            if not rule_id:
                rule_index = result_data.get("ruleIndex")
                if (
                    isinstance(rule_index, int)
                    and not isinstance(rule_index, bool)
                    and 0 <= rule_index < len(rules)
                ):
                    rule = rules[rule_index]
                    if rule is not None:
                        rule_id = _string(rule.get("id")) or ""
            level = "warning" if "level" not in result_data else _string(result_data.get("level"))
            severity = {
                "error": "major",
                "warning": "minor",
                "note": "info",
                "none": "info",
            }.get((level or "").strip().lower(), "info")
            file_uri, line = _location(result_data, result_path, output)
            title = _rule_title(rule, rule_id)
            finding = {
                "tool_name": tool_name,
                "tool_version": tool_version,
                "rule_id": rule_id,
                "title": _bounded_text(title, max_title_chars, "title_chars", output),
                "message": _bounded_text(
                    message, max_message_chars, "message_chars", output
                ),
                "severity": severity,
                "file": file_uri,
                "line": line,
                "help_uri": _help_uri(rule, information_uri),
            }
            candidates.append(finding)

    seen: set[tuple[object, ...]] = set()
    unique: list[dict[str, Any]] = []
    for finding in candidates:
        key = (
            finding["tool_name"],
            finding["tool_version"],
            finding["rule_id"],
            finding["title"],
            finding["message"],
            finding["severity"],
            finding["file"],
            finding["line"],
            finding["help_uri"],
        )
        if key in seen:
            continue
        seen.add(key)
        unique.append(finding)

    if len(unique) > max_findings:
        output["truncated"] = True
        output["truncation"]["truncated"] = True
        output["truncation"]["omitted_findings"] = len(unique) - max_findings
        output["truncation"]["reasons"].append("finding_cap")
        unique = unique[:max_findings]
    output["findings"] = unique
    return output


def _resolve_artifact_path(path_str: str, workspace_root: str | Path) -> Path | None:
    """Return an output path only when it resolves inside ``workspace_root``."""
    if not path_str or "\x00" in path_str:
        return None
    try:
        root = Path(workspace_root).resolve()
        target = Path(path_str).resolve()
    except (OSError, ValueError):
        return None
    if not target.is_relative_to(root):
        return None
    return target


def _read_input(path: str) -> tuple[object | None, str | None]:
    try:
        with Path(path).open("rb") as handle:
            raw = handle.read(MAX_INPUT_BYTES + 1)
    except OSError as exc:
        return None, f"unable to read SARIF input: {exc}"
    if len(raw) > MAX_INPUT_BYTES:
        return None, f"SARIF input exceeds {MAX_INPUT_BYTES} byte limit"
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        return None, f"SARIF input is not valid UTF-8: {exc}"
    try:
        return json.loads(text), None
    except json.JSONDecodeError as exc:
        return None, f"SARIF input is not valid JSON: {exc.msg}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Normalize a SARIF 2.1.0 file.")
    parser.add_argument("--input", required=True, help="Input SARIF JSON file")
    parser.add_argument("--output", required=True, help="Output normalized JSON file")
    parser.add_argument(
        "--workspace-root",
        default="",
        help="Restrict --output to this directory (default: $GITHUB_WORKSPACE or cwd)",
    )
    args = parser.parse_args(argv)

    default_root = os.environ.get("GITHUB_WORKSPACE") or os.getcwd()
    workspace_root = args.workspace_root or default_root
    output_path = _resolve_artifact_path(args.output, workspace_root)
    if output_path is None:
        print(
            f"Refusing to write {args.output!r}: output escapes workspace root "
            f"{workspace_root!r} or is otherwise unsafe.",
            file=sys.stderr,
        )
        return 1

    payload, input_error = _read_input(args.input)
    if input_error:
        print(input_error, file=sys.stderr)
        return 1

    normalized = normalize_sarif(payload)
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"unable to write SARIF output: {exc}", file=sys.stderr)
        return 1

    return 1 if normalized.get("errors") else 0


if __name__ == "__main__":
    sys.exit(main())
