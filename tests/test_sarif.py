"""Tests for the standalone SARIF 2.1.0 normalizer."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.sarif import (  # noqa: E402
    MAX_ERRORS,
    MAX_FINDINGS,
    MAX_INPUT_BYTES,
    MAX_MESSAGE_CHARS,
    MAX_TITLE_CHARS,
    main,
    normalize_sarif,
)


def _sarif(*, runs=None, version="2.1.0"):
    return {"version": version, "runs": [] if runs is None else runs}


def _run(results, *, name="scanner", tool_version="1.0", rules=None, information_uri=None):
    driver = {"name": name, "version": tool_version}
    if rules is not None:
        driver["rules"] = rules
    if information_uri is not None:
        driver["informationUri"] = information_uri
    return {"tool": {"driver": driver}, "results": results}


def _result(message="found", *, rule_id="R1", level="error", locations=None):
    item = {"ruleId": rule_id, "level": level, "message": {"text": message}}
    if locations is not None:
        item["locations"] = locations
    return item


def test_minimal_sarif_and_empty_results():
    result = normalize_sarif(_sarif())
    assert result == {
        "version": 1,
        "source_format": "sarif-2.1.0",
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


def test_multiple_runs_tools_preserve_declared_order():
    payload = _sarif(
        runs=[
            _run([_result("one")], name="first"),
            _run([_result("two")], name="second", tool_version="2"),
        ]
    )
    findings = normalize_sarif(payload)["findings"]
    assert [(item["tool_name"], item["tool_version"], item["message"]) for item in findings] == [
        ("first", "1.0", "one"),
        ("second", "2", "two"),
    ]


def test_severity_mapping_and_unknown_levels():
    results = [_result(level=level, message=level) for level in ["error", "warning", "note", "none", "", "bogus"]]
    findings = normalize_sarif(_sarif(runs=[_run(results)]))["findings"]
    assert [item["severity"] for item in findings] == [
        "major", "minor", "info", "info", "info"
    ]


def test_missing_level_defaults_to_warning_and_null_is_unknown():
    missing = _result("missing")
    missing.pop("level")
    explicit_null = _result("null", level=None)
    findings = normalize_sarif(_sarif(runs=[_run([missing, explicit_null])]))["findings"]
    assert [item["severity"] for item in findings] == ["minor", "info"]


def test_rule_index_resolves_declared_rule_metadata_without_rule_id():
    rules = [
        {"id": "indexed", "shortDescription": {"text": "Indexed title"}, "helpUri": "https://rule"},
    ]
    result = _result("indexed finding")
    result.pop("ruleId")
    result["ruleIndex"] = 0
    finding = normalize_sarif(_sarif(runs=[_run([result], rules=rules)]))["findings"][0]
    assert (finding["rule_id"], finding["title"], finding["help_uri"]) == (
        "indexed", "Indexed title", "https://rule"
    )


def test_rule_metadata_and_tool_information_uri_fallback():
    rules = [
        {"id": "short", "shortDescription": {"text": "Short title"}, "helpUri": "https://rule"},
        {"id": "named", "name": "Named rule"},
        {"id": "identified"},
    ]
    results = [
        _result(rule_id="short", message="a"),
        _result(rule_id="named", message="b"),
        _result(rule_id="identified", message="c"),
        _result(rule_id="missing", message="d"),
    ]
    findings = normalize_sarif(
        _sarif(runs=[_run(results, rules=rules, information_uri="https://tool")])
    )["findings"]
    assert [(item["rule_id"], item["title"], item["help_uri"]) for item in findings] == [
        ("short", "Short title", "https://rule"),
        ("named", "Named rule", "https://tool"),
        ("identified", "identified", "https://tool"),
        ("missing", "missing", "https://tool"),
    ]


def test_locations_keep_unlocated_findings_and_use_first_physical_location():
    results = [
        _result(
            "located",
            locations=[
                {"logicalLocations": [{"name": "not physical"}]},
                {"physicalLocation": {"artifactLocation": {"uri": "src/a.py"}, "region": {"startLine": 12}}},
                {"physicalLocation": {"artifactLocation": {"uri": "src/later.py"}, "region": {"startLine": 99}}},
            ],
        ),
        _result("unlocated"),
    ]
    findings = normalize_sarif(_sarif(runs=[_run(results)]))["findings"]
    assert (findings[0]["file"], findings[0]["line"]) == ("src/a.py", 12)
    assert (findings[1]["file"], findings[1]["line"]) == ("", None)


def test_duplicate_findings_keep_first():
    first = _result("same", rule_id="R", level="warning")
    duplicate = _result("same", rule_id="R", level="warning")
    duplicate["locations"] = []
    payload = _sarif(runs=[_run([first]), _run([duplicate])])
    findings = normalize_sarif(payload)["findings"]
    assert len(findings) == 1
    assert findings[0]["tool_name"] == "scanner"


def test_missing_message_is_skipped_and_reported():
    payload = _sarif(runs=[_run([{"ruleId": "R1"}, _result("kept")])])
    result = normalize_sarif(payload)
    assert [item["message"] for item in result["findings"]] == ["kept"]
    assert any("missing a usable message" in error for error in result["errors"])


def test_caps_record_reasons_and_omitted_counts():
    results = [_result("abcdefghij", rule_id=f"R{i}") for i in range(4)]
    results[0]["message"] = {"text": "abcdefghij"}
    rules = [{"id": "R0", "shortDescription": {"text": "title-long"}}]
    result = normalize_sarif(
        _sarif(runs=[_run(results, rules=rules)]),
        max_findings=2,
        max_message_chars=4,
        max_title_chars=5,
    )
    assert len(result["findings"]) == 2
    assert result["findings"][0]["message"] == "abcd"
    assert result["findings"][0]["title"] == "title"
    assert result["truncated"] is True
    assert result["truncation"] == {
        "truncated": True,
        "reasons": ["title_chars_cap", "message_chars_cap", "finding_cap"],
        "omitted_findings": 2,
        "omitted_message_chars": 24,
        "omitted_title_chars": 5,
        "omitted_errors": 0,
    }


def test_error_cap_retains_first_errors_and_marks_truncation():
    locations = [None] * (MAX_ERRORS + 50)
    result = normalize_sarif(
        _sarif(runs=[_run([_result("message", locations=locations)])])
    )
    assert len(result["errors"]) == MAX_ERRORS + 1
    assert result["errors"][0].endswith("locations[0] is not an object")
    assert result["errors"][-1] == "errors_truncated"
    assert result["truncation"]["omitted_errors"] == 50
    assert result["truncation"]["reasons"] == ["errors_cap"]
    assert result["truncated"] is True


@pytest.mark.parametrize("value", [True, 1.0, -1])
def test_caps_require_non_negative_integers(value):
    result = normalize_sarif(_sarif(), max_findings=value)
    assert result["errors"] == ["max_findings must be a non-negative integer"]


def test_keyword_caps_can_drop_all_findings():
    result = normalize_sarif(
        _sarif(runs=[_run([_result("message")])]), max_findings=0, max_message_chars=0
    )
    assert result["findings"] == []
    assert result["truncation"]["omitted_findings"] == 1
    assert result["truncation"]["omitted_message_chars"] == len("message")


@pytest.mark.parametrize("payload", [None, [], "sarif"])
def test_invalid_payload_fails_cleanly(payload):
    result = normalize_sarif(payload)
    assert result["findings"] == []
    assert result["errors"]


@pytest.mark.parametrize("payload", [{"runs": []}, _sarif(version="2.0.0")])
def test_missing_or_wrong_version_is_rejected(payload):
    result = normalize_sarif(payload)
    assert result["findings"] == []
    assert any("version" in error for error in result["errors"])


def test_deterministic_json_serializable_output():
    payload = _sarif(runs=[_run([_result("b"), _result("a", rule_id="R2")])])
    first = normalize_sarif(payload)
    second = normalize_sarif(json.loads(json.dumps(payload)))
    assert first == second
    json.dumps(first)


def test_no_network_or_command_execution_surface():
    source = Path(__import__("pr_reviewer.sarif", fromlist=["sarif"]).__file__).read_text()
    for banned in ("subprocess", "urllib", "requests", "socket", "curl", "os.system"):
        assert banned not in source


def test_cli_accepts_utf8_bom_and_writes_inside_workspace(tmp_path):
    input_path = tmp_path / "results.sarif"
    output_path = tmp_path / "sarif-evidence.json"
    input_path.write_bytes(b"\xef\xbb\xbf" + json.dumps(_sarif(runs=[_run([_result("ok")])])).encode())
    env = dict(os.environ)
    env["PYTHONPATH"] = str(_REPO_ROOT)
    process = subprocess.run(
        [sys.executable, "-m", "pr_reviewer.sarif", "--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 0, process.stderr
    assert json.loads(output_path.read_text())["findings"][0]["message"] == "ok"


def test_cli_rejects_malformed_json_and_does_not_write(tmp_path):
    input_path = tmp_path / "bad.sarif"
    output_path = tmp_path / "out.json"
    input_path.write_text("{not json")
    assert main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)]) == 1
    assert not output_path.exists()


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"version": "2.1.0"},
        {"version": "2.1.0", "runs": {}},
        {"version": "2.0.0", "runs": []},
    ],
)
def test_cli_rejects_malformed_top_level(tmp_path, payload):
    input_path = tmp_path / "invalid.sarif"
    output_path = tmp_path / "out.json"
    input_path.write_text(json.dumps(payload))
    assert main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)]) == 1
    assert output_path.exists()


def test_cli_rejects_wrong_version(tmp_path):
    input_path = tmp_path / "wrong.sarif"
    output_path = tmp_path / "out.json"
    input_path.write_text(json.dumps(_sarif(version="2.0.0")))
    assert main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)]) == 1
    assert output_path.exists()


def test_cli_rejects_output_outside_workspace_and_symlink(tmp_path):
    input_path = tmp_path / "results.sarif"
    input_path.write_text(json.dumps(_sarif()))
    outside = tmp_path.parent / f"{tmp_path.name}-outside.json"
    assert main(["--input", str(input_path), "--output", str(outside), "--workspace-root", str(tmp_path)]) == 1
    try:
        link = tmp_path / "link.json"
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this filesystem")
    assert main(["--input", str(input_path), "--output", str(link), "--workspace-root", str(tmp_path)]) == 1


def test_cli_rejects_oversized_input(tmp_path):
    input_path = tmp_path / "large.sarif"
    output_path = tmp_path / "out.json"
    input_path.write_bytes(b"x" * (MAX_INPUT_BYTES + 1))
    assert main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)]) == 1
    assert not output_path.exists()


def test_default_caps_are_bounded():
    assert MAX_ERRORS == 100
    assert MAX_FINDINGS == 200
    assert MAX_MESSAGE_CHARS == 1000
    assert MAX_TITLE_CHARS == 200


def test_cli_returns_nonzero_on_runs_none(tmp_path):
    input_path = tmp_path / "runs_none.sarif"
    output_path = tmp_path / "out.json"
    input_path.write_text(json.dumps({"version": "2.1.0", "runs": [None]}))
    rc = main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)])
    assert rc == 1
    assert output_path.exists()
    data = json.loads(output_path.read_text())
    assert any("runs[0] is not an object" in e for e in data["errors"])


def test_cli_returns_nonzero_on_results_not_array(tmp_path):
    input_path = tmp_path / "results_bad.sarif"
    output_path = tmp_path / "out.json"
    payload = {"version": "2.1.0", "runs": [{"tool": {"driver": {"name": "x"}}, "results": "not-an-array"}]}
    input_path.write_text(json.dumps(payload))
    rc = main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)])
    assert rc == 1
    assert output_path.exists()
    data = json.loads(output_path.read_text())
    assert any("runs[0].results is not an array" in e for e in data["errors"])


def test_cli_returns_nonzero_on_invalid_tool_driver_type(tmp_path):
    input_path = tmp_path / "driver_bad.sarif"
    output_path = tmp_path / "out.json"
    payload = {"version": "2.1.0", "runs": [{"tool": {"driver": "string"}, "results": []}]}
    input_path.write_text(json.dumps(payload))
    rc = main(["--input", str(input_path), "--output", str(output_path), "--workspace-root", str(tmp_path)])
    assert rc == 1
    assert output_path.exists()
    data = json.loads(output_path.read_text())
    assert any("runs[0].tool.driver is not an object" in e for e in data["errors"])
