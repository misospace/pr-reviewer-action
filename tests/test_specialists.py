"""Tests for the specialist leads normalizer (#607).

Specialist roles are pinned to :data:`pr_reviewer.specialists.SPECIALIST_ROLES_ORDER`
in canonical order ``("correctness", "security", "tests")`` — not the unordered
frozenset — because ``#607`` requires a stable role order.

Covers the required behaviours: fixed roles, one shared versioned contract,
deterministic + bounded parsing, fail-soft malformed output, severity that
cannot imply a verdict, and trust-framed / strict-JSON prompt fragments.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import specialists
from pr_reviewer.specialists import (
    ARTIFACT_VERSION,
    MAX_LEADS,
    MAX_SPECIALIST_SEVERITY,
    SPECIALIST_ROLES,
    SPECIALIST_ROLES_ORDER,
    SPECIALIST_SEVERITIES,
    extract_specialist_json,
    load_specialist_prompt,
    main,
    normalize_specialist_output,
    parse_specialist_response,
    prompt_fragment_path,
    render_specialist_markdown,
)

# ---------------------------------------------------------------------------
# Fixed roles and the shared versioned contract
# ---------------------------------------------------------------------------


def test_three_fixed_roles_exist_with_explicit_names():
    assert SPECIALIST_ROLES == frozenset({"correctness", "security", "tests"})


def test_specialist_roles_order_is_pinned():
    # #607 requires stable deterministic role ordering. Asserting the exact
    # tuple is what catches an accidental reorder; sorted(SPECIALIST_ROLES)
    # checks set membership, not order.
    assert SPECIALIST_ROLES_ORDER == ("correctness", "security", "tests")


def test_all_three_fixed_roles_normalize_to_the_shared_contract():
    for role in sorted(SPECIALIST_ROLES):
        result = normalize_specialist_output(
            {
                "leads": [
                    {
                        "message": "lead",
                        "severity": "major",
                        "file": "a.py",
                        "line": 1,
                        "category": "bug",
                    }
                ]
            },
            role=role,
        )
        assert result["role"] == role
        assert len(result["leads"]) == 1
        assert result["errors"] == []


def test_invalid_role_is_rejected_with_a_visible_error():
    result = normalize_specialist_output(
        {"leads": [{"message": "should be dropped"}]}, role="performance"
    )
    assert result["leads"] == []
    assert result["errors"]
    assert "unknown specialist role" in result["errors"][0]
    assert "performance" in result["errors"][0]


@pytest.mark.parametrize("role", ["", "sECURITY", "security ", "Security", "ALL"])
def test_case_and_whitespace_variants_of_roles_are_rejected(role):
    # Role matching is exact and case-sensitive: no fuzzy "close enough" role.
    result = normalize_specialist_output({"leads": [{"message": "x"}]}, role=role)
    assert role not in SPECIALIST_ROLES
    assert result["leads"] == []
    assert result["errors"]


def test_each_result_is_versioned():
    result = normalize_specialist_output({"leads": []}, role="tests")
    assert result["version"] == ARTIFACT_VERSION == 1
    # The identical top-level shape holds for every role: one shared contract.
    for role in sorted(SPECIALIST_ROLES):
        assert set(normalize_specialist_output({"leads": []}, role=role)) == {
            "version",
            "role",
            "leads",
            "truncated",
            "truncation",
            "errors",
        }


def test_lead_schema_is_stable():
    result = normalize_specialist_output(
        {
            "leads": [
                {
                    "message": "m",
                    "severity": "major",
                    "file": "f.py",
                    "line": 3,
                    "category": "c",
                }
            ]
        },
        role="security",
    )
    assert result["leads"][0] == {
        "severity": "major",
        "category": "c",
        "file": "f.py",
        "line": 3,
        "message": "m",
    }


# ---------------------------------------------------------------------------
# Valid shapes: zero-lead and multi-lead
# ---------------------------------------------------------------------------


def test_valid_zero_lead_output():
    result = normalize_specialist_output({"role": "tests", "leads": []}, role="tests")
    assert result["leads"] == []
    assert result["errors"] == []
    assert result["truncated"] is False


def test_omitted_leads_key_is_treated_as_zero_lead():
    result = normalize_specialist_output({"role": "tests"}, role="tests")
    assert result["leads"] == []
    assert result["errors"] == []


def test_valid_multi_lead_output_preserves_declared_order():
    payload = {
        "role": "security",
        "leads": [
            {"message": "first", "severity": "minor", "file": "a.py", "line": 10},
            {"message": "second", "severity": "major", "file": "b.py", "line": 20},
            {"message": "third", "severity": "info"},
        ],
    }
    result = normalize_specialist_output(payload, role="security")
    assert [lead["message"] for lead in result["leads"]] == ["first", "second", "third"]
    assert [lead["severity"] for lead in result["leads"]] == ["minor", "major", "info"]
    assert result["errors"] == []


def test_duplicate_leads_keep_the_first_occurrence():
    lead = {"message": "same", "severity": "major", "file": "a.py", "line": 1}
    result = normalize_specialist_output(
        {"role": "security", "leads": [dict(lead), dict(lead), dict(lead)]},
        role="security",
    )
    assert len(result["leads"]) == 1
    assert result["errors"] == []


# ---------------------------------------------------------------------------
# Missing / invalid fields normalize predictably
# ---------------------------------------------------------------------------


def test_missing_optional_fields_default_predictably():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m"}]}, role="tests"
    )
    assert result["leads"][0] == {
        "severity": "info",
        "category": "",
        "file": None,
        "line": None,
        "message": "m",
    }


def test_non_string_severity_degrades_to_info():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m", "severity": 5}]}, role="tests"
    )
    assert result["leads"][0]["severity"] == "info"


def test_non_string_message_is_dropped_with_a_visible_error():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": 42}, {"message": "kept"}]}, role="tests"
    )
    assert [lead["message"] for lead in result["leads"]] == ["kept"]
    assert any("missing a usable message" in e for e in result["errors"])


def test_blank_message_is_dropped():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "   "}]}, role="tests"
    )
    assert result["leads"] == []
    assert result["errors"]


def test_non_object_lead_entry_is_dropped_with_a_visible_error():
    result = normalize_specialist_output(
        {"role": "tests", "leads": ["not an object", {"message": "kept"}]}, role="tests"
    )
    assert [lead["message"] for lead in result["leads"]] == ["kept"]
    assert any("leads[0] is not an object" in e for e in result["errors"])


def test_missing_file_defaults_to_none():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m", "file": None}]}, role="tests"
    )
    assert result["leads"][0]["file"] is None


def test_non_string_file_defaults_to_none():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m", "file": 123}]}, role="tests"
    )
    assert result["leads"][0]["file"] is None


def test_missing_line_defaults_to_none():
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m"}]}, role="tests"
    )
    assert result["leads"][0]["line"] is None


@pytest.mark.parametrize("raw", [0, -1, 1.5, True, "abc", None, ["4"]])
def test_invalid_line_values_default_to_none(raw):
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m", "line": raw}]}, role="tests"
    )
    assert result["leads"][0]["line"] is None


@pytest.mark.parametrize("raw,expected", [(4, 4), (4.0, 4), ("7", 7)])
def test_valid_line_variants_normalize_to_an_int(raw, expected):
    result = normalize_specialist_output(
        {"role": "tests", "leads": [{"message": "m", "line": raw}]}, role="tests"
    )
    assert result["leads"][0]["line"] == expected


def test_non_array_leads_is_a_visible_error_with_empty_leads():
    result = normalize_specialist_output(
        {"role": "tests", "leads": "not-an-array"}, role="tests"
    )
    assert result["leads"] == []
    assert any("'leads' is not an array" in e for e in result["errors"])


def test_non_object_payload_is_a_visible_error():
    result = normalize_specialist_output(["not", "an", "object"], role="tests")
    assert result["leads"] == []
    assert any("must be a JSON object" in e for e in result["errors"])


def test_mismatched_echoed_role_is_a_visible_error():
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "m"}]}, role="tests"
    )
    assert len(result["leads"]) == 1
    assert result["role"] == "tests"
    assert any("does not match" in e for e in result["errors"])


# ---------------------------------------------------------------------------
# Bounding: lead count and message caps
# ---------------------------------------------------------------------------


def test_lead_count_cap_is_applied_and_visible():
    payload = {
        "role": "security",
        "leads": [{"message": f"lead {i}"} for i in range(10)],
    }
    result = normalize_specialist_output(payload, role="security", max_leads=3)
    assert len(result["leads"]) == 3
    assert [lead["message"] for lead in result["leads"]] == [
        "lead 0",
        "lead 1",
        "lead 2",
    ]
    assert result["truncated"] is True
    assert "lead_cap" in result["truncation"]["reasons"]
    assert result["truncation"]["omitted_leads"] == 7


def test_default_lead_cap_is_bounded():
    payload = {
        "role": "security",
        "leads": [{"message": f"lead {i}"} for i in range(MAX_LEADS + 5)],
    }
    result = normalize_specialist_output(payload, role="security")
    assert len(result["leads"]) == MAX_LEADS
    assert result["truncated"] is True
    assert result["truncation"]["omitted_leads"] == 5


def test_message_char_cap_is_applied_and_visible():
    long_message = "x" * 50
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": long_message}]},
        role="security",
        max_message_chars=10,
    )
    assert result["leads"][0]["message"] == "x" * 10
    assert result["truncated"] is True
    assert "message_chars_cap" in result["truncation"]["reasons"]
    assert result["truncation"]["omitted_message_chars"] == 40


def test_zero_leads_cap_drops_everything():
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "m"}]}, role="security", max_leads=0
    )
    assert result["leads"] == []
    assert result["truncation"]["omitted_leads"] == 1


def test_utf8_byte_cap_holds_exactly_and_drops_trailing_whole_leads():
    # A document of multibyte (3-byte-per-char) messages so the byte cap is a
    # genuine byte test, not a char-count alias.
    payload = {
        "role": "security",
        "leads": [
            {"message": "日本語 lead " + str(i), "severity": "major"} for i in range(6)
        ],
    }
    result = normalize_specialist_output(payload, role="security")
    uncapped = render_specialist_markdown(result)
    # Pick a budget below the uncapped size; the renderer must shrink to it.
    budget = len(uncapped.encode("utf-8")) - 50
    rendered = render_specialist_markdown(result, max_bytes=budget)
    # The hard cap: UTF-8 byte length never exceeds the budget.
    assert len(rendered.encode("utf-8")) <= budget
    # The omission is visible, and the surviving leads are a leading prefix
    # (trailing whole lines dropped, never a message mid-character).
    assert "omitted (byte cap)" in rendered
    # Multibyte characters are never split: the document is valid UTF-8.
    rendered.encode("utf-8").decode("utf-8")


def test_utf8_byte_cap_survives_a_single_oversized_lead():
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "a" * 500, "severity": "major"}]},
        role="security",
    )
    rendered = render_specialist_markdown(result, max_bytes=120)
    assert len(rendered.encode("utf-8")) <= 120
    # Even the single lead is cut char-safely to hold the cap exactly.
    rendered.encode("utf-8").decode("utf-8")


def test_utf8_byte_cap_is_stricter_than_char_cap_for_multibyte():
    # Multibyte CJK (3 bytes/char in UTF-8): a 100-byte budget holds only ~33
    # chars, far less than a 100-char cap would (300 bytes) — proving this is
    # a byte cap, not a char-count alias.
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "あ" * 200, "severity": "major"}]},
        role="security",
    )
    rendered = render_specialist_markdown(result, max_bytes=100)
    assert len(rendered.encode("utf-8")) <= 100
    # The rendered body (minus the fixed header) carries <= 100 bytes of the
    # 800-byte message — a byte cap, not a 100-char alias.
    assert len(rendered) - len(b"## Specialist: security\n") < 100


# ---------------------------------------------------------------------------
# Fail-soft and visible: malformed JSON must not crash the pipeline
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("text", ["{not json", "definitely not json at all", "", "   "])
def test_malformed_json_becomes_an_error_result(text):
    result = parse_specialist_response(text, role="security")
    assert result["role"] == "security"
    assert result["leads"] == []
    assert result["errors"]
    assert "malformed JSON" in result["errors"][0]


def test_malformed_json_with_valid_role_still_reports_role():
    result = parse_specialist_response("garbage", role="tests")
    assert result["role"] == "tests"
    assert result["errors"]
    assert result["leads"] == []


def test_malformed_json_with_invalid_role_reports_role_error():
    result = parse_specialist_response("garbage", role="nope")
    assert "unknown specialist role" in result["errors"][0]


def test_valid_json_embedded_in_prose_is_extracted():
    text = (
        'Here is my analysis: {"role":"security","leads":'
        '[{"message":"found one","severity":"major","file":"a.py","line":1}]}'
        " — end of analysis."
    )
    result = parse_specialist_response(text, role="security")
    assert len(result["leads"]) == 1
    assert result["leads"][0]["message"] == "found one"
    assert result["errors"] == []


def test_valid_json_in_a_markdown_fence_is_extracted():
    text = '```json\n{"role":"tests","leads":[{"message":"m"}]}\n```'
    result = parse_specialist_response(text, role="tests")
    assert len(result["leads"]) == 1
    assert result["errors"] == []


def test_plain_json_is_extracted():
    text = json.dumps({"role": "tests", "leads": [{"message": "m"}]})
    assert extract_specialist_json(text)["leads"][0]["message"] == "m"


def test_none_text_is_malformed_not_a_crash():
    result = parse_specialist_response(None, role="tests")
    assert result["leads"] == []
    assert result["errors"]


# ---------------------------------------------------------------------------
# Severity: advisory only, never a verdict
# ---------------------------------------------------------------------------


def test_blocker_alias_is_downgraded_to_the_major_cap():
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "m", "severity": "blocker"}]},
        role="security",
    )
    assert result["leads"][0]["severity"] == "major"
    assert result["leads"][0]["severity"] == MAX_SPECIALIST_SEVERITY


def test_critical_alias_is_downgraded_to_the_major_cap():
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "m", "severity": "critical"}]},
        role="security",
    )
    assert result["leads"][0]["severity"] == "major"


def test_severities_map_onto_the_bounded_set_only():
    aliases = {
        "blocker": "major",
        "critical": "major",
        "major": "major",
        "high": "major",
        "error": "major",
        "minor": "minor",
        "medium": "minor",
        "low": "minor",
        "warning": "minor",
        "info": "info",
        "note": "info",
        "nit": "info",
        "suggestion": "info",
        "unknown-label": "info",
    }
    for raw, expected in aliases.items():
        result = normalize_specialist_output(
            {"role": "security", "leads": [{"message": "m", "severity": raw}]},
            role="security",
        )
        assert result["leads"][0]["severity"] == expected, raw
        assert result["leads"][0]["severity"] in SPECIALIST_SEVERITIES


def test_specialist_severity_set_excludes_blocker():
    # The contract itself is what prevents a specialist from setting the
    # blocker flag: the main reviewer's enforcement is the only path to a
    # blocker, so the specialist set must not contain one.
    assert "blocker" not in SPECIALIST_SEVERITIES
    assert SPECIALIST_SEVERITIES == ("major", "minor", "info")


def test_severity_does_not_produce_a_verdict_anywhere_in_the_result():
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": "m", "severity": "blocker"}]},
        role="security",
    )
    rendered = json.dumps(result)
    assert "blocker" not in rendered
    assert "request_changes" not in rendered
    assert "approve" not in rendered


# ---------------------------------------------------------------------------
# Deterministic ordering
# ---------------------------------------------------------------------------


def test_identical_input_produces_identical_output():
    payload = {
        "role": "security",
        "leads": [
            {"message": "b", "severity": "major", "file": "b.py", "line": 2},
            {"message": "a", "severity": "minor", "file": "a.py", "line": 1},
            {"message": "dup", "severity": "info"},
            {"message": "dup", "severity": "info"},
        ],
    }
    first = normalize_specialist_output(payload, role="security")
    second = normalize_specialist_output(
        json.loads(json.dumps(payload)), role="security"
    )
    assert first == second
    # Round-trips through JSON without loss.
    assert json.loads(json.dumps(first)) == first


def test_output_order_is_stable_across_calls():
    payload = {
        "role": "tests",
        "leads": [{"message": str(i)} for i in range(10)],
    }
    orders = {
        tuple(
            lead["message"]
            for lead in normalize_specialist_output(payload, role="tests")["leads"]
        )
        for _ in range(5)
    }
    assert len(orders) == 1


# ---------------------------------------------------------------------------
# Adversarial strings / control characters cannot break later rendering
# ---------------------------------------------------------------------------


def test_control_characters_are_escaped_in_rendering():
    result = normalize_specialist_output(
        {
            "role": "security",
            "leads": [
                {
                    "message": "line1\nline2\ttabbed\rreturn\x00nul",
                    "severity": "major",
                    "file": "a.py",
                    "line": 1,
                }
            ],
        },
        role="security",
    )
    rendered = render_specialist_markdown(result)
    # The NUL byte is escaped (it has no \n/\t/\r shorthand) and the whole
    # message appears as its escaped form, so no raw control byte survives.
    assert "\\u0000" in rendered
    assert "line1\\nline2\\ttabbed\\rreturn\\u0000nul" in rendered


def test_hostile_message_cannot_close_the_enclosing_fence():
    # A message carrying a run of backticks long enough to match the fence the
    # renderer emits must be neutralized, so it cannot close the block early.
    hostile = "close the fence: " + "`" * 8
    result = normalize_specialist_output(
        {"role": "security", "leads": [{"message": hostile, "severity": "major"}]},
        role="security",
    )
    rendered = render_specialist_markdown(result)
    # The fence used must be strictly longer than the hostile run (8), i.e.
    # the fence is never matched by hostile content, so it stays closed.
    lines = rendered.splitlines()
    assert any(set(ln.strip()) == {"`"} and len(ln.strip()) == 9 for ln in lines)


def test_hostile_message_cannot_forge_a_markdown_heading():
    result = normalize_specialist_output(
        {
            "role": "security",
            "leads": [{"message": "inject\n\n# Fake heading", "severity": "major"}],
        },
        role="security",
    )
    rendered = render_specialist_markdown(result)
    # The forged heading must appear escaped, not as a real line-leading "#".
    assert "inject\\n\\n# Fake heading" in rendered
    forged_lines = [ln for ln in rendered.splitlines() if ln.startswith("#")]
    assert all("Fake heading" not in ln for ln in forged_lines)


def test_hostile_file_path_cannot_terminate_its_code_span():
    path = "a`b" + "`" * 6 + "c.py"
    result = normalize_specialist_output(
        {
            "role": "security",
            "leads": [{"message": "m", "severity": "major", "file": path}],
        },
        role="security",
    )
    rendered = render_specialist_markdown(result)
    # The span's delimiter is strictly longer than the longest backtick run
    # in the (neutralized) path, so the span stays open until its own close.
    assert " at " in rendered
    # No raw long backtick run from the path survives.
    max_run = max((len(run) for run in _backtick_runs(rendered)), default=0)
    # The fence and span delimiters may be long, but the hostile path's runs
    # are capped below the fence.
    assert max_run <= 10


def test_long_path_is_still_rendered_without_crash():
    result = normalize_specialist_output(
        {
            "role": "security",
            "leads": [{"message": "m", "severity": "major", "file": "x" * 500}],
        },
        role="security",
    )
    rendered = render_specialist_markdown(result)
    assert " at " in rendered


def _backtick_runs(text: str):
    run = 0
    for ch in text:
        if ch == "`":
            run += 1
        elif run:
            yield "`" * run
            run = 0
    if run:
        yield "`" * run


def test_unicode_message_survives_round_trip():
    result = normalize_specialist_output(
        {
            "role": "security",
            "leads": [{"message": "日本語 lead — em dash ✓", "severity": "major"}],
        },
        role="security",
    )
    assert result["leads"][0]["message"] == "日本語 lead — em dash ✓"
    json.dumps(result, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Prompt fragments: trust framing + strict-JSON + advisory-only
# ---------------------------------------------------------------------------


def test_prompt_fragments_exist_on_disk():
    for role in sorted(SPECIALIST_ROLES):
        path = prompt_fragment_path(role)
        assert path.exists(), role
        assert load_specialist_prompt(role).strip(), role


def test_prompt_fragments_are_small_for_cache_friendliness():
    for role in sorted(SPECIALIST_ROLES):
        # Each fragment must stay compact (well under a single screen).
        assert len(load_specialist_prompt(role)) < 2000, role


def test_prompt_fragments_contain_trust_framing():
    for role in sorted(SPECIALIST_ROLES):
        text = load_specialist_prompt(role).lower()
        assert "untrusted data" in text, role
        assert "not instructions" in text, role


def test_prompt_fragments_request_strict_json_only():
    for role in sorted(SPECIALIST_ROLES):
        text = load_specialist_prompt(role).lower()
        assert "strict json" in text, role


def test_prompt_fragments_ask_for_leads_not_a_verdict():
    for role in sorted(SPECIALIST_ROLES):
        text = load_specialist_prompt(role).lower()
        assert "lead" in text, role
        assert "not rendering an approve" in text, role
        assert "final verification" in text, role


def test_prompt_fragments_restrict_the_role_to_its_lane():
    for role, lane in {
        "correctness": "correctness specialist",
        "security": "security specialist",
        "tests": "tests specialist",
    }.items():
        text = load_specialist_prompt(role).lower()
        assert lane in text, role
        # The fragment must instruct the role to report within its lane.
        assert "your lane is narrow" in text, role
        # And discourage generic style commentary.
        assert "style" in text, role


def test_prompt_fragments_specify_their_own_role_and_lead_schema():
    for role in sorted(SPECIALIST_ROLES):
        text = load_specialist_prompt(role)
        assert f'"role" set to "{role}"' in text, role
        assert '"leads"' in text, role
        for field in ("severity", "category", "file", "line", "message"):
            assert f'"{field}"' in text, (role, field)


def test_prompt_fragment_paths_follow_the_naming_convention():
    # The loader must find exactly the files the issue expects.
    expected = {
        "scripts/prompt_fragments/specialist_correctness.txt",
        "scripts/prompt_fragments/specialist_security.txt",
        "scripts/prompt_fragments/specialist_tests.txt",
    }
    for role in sorted(SPECIALIST_ROLES):
        rel = prompt_fragment_path(role).relative_to(_REPO_ROOT).as_posix()
        assert rel in expected, role


# ---------------------------------------------------------------------------
# No model / network / execution surface
# ---------------------------------------------------------------------------


def test_no_network_or_command_execution_surface():
    source = Path(specialists.__file__).read_text()
    for banned in ("subprocess", "urllib", "requests", "socket", "curl", "os.system"):
        assert banned not in source, banned


def test_module_makes_no_model_calls():
    # Importing and running the normalizer must never reach a model endpoint.
    # The only "calls" the module makes are local JSON parsing.
    result = normalize_specialist_output({"leads": []}, role="tests")
    assert result["leads"] == []


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def test_cli_normalizes_valid_input_inside_workspace(tmp_path):
    input_path = tmp_path / "leads.json"
    output_path = tmp_path / "specialist-security.json"
    input_path.write_text(
        json.dumps(
            {"role": "security", "leads": [{"message": "ok", "severity": "major"}]}
        ),
        encoding="utf-8",
    )
    env = dict(os.environ)
    env["PYTHONPATH"] = str(_REPO_ROOT)
    process = subprocess.run(
        [
            sys.executable,
            "-m",
            "pr_reviewer.specialists",
            "--role",
            "security",
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--workspace-root",
            str(tmp_path),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert process.returncode == 0, process.stderr
    data = json.loads(output_path.read_text())
    assert data["role"] == "security"
    assert data["leads"][0]["message"] == "ok"


def test_cli_relative_output_is_workspace_root_relative(tmp_path, monkeypatch):
    # The happy path runs with cwd == workspace-root, which would mask this.
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    input_path = tmp_path / "in.json"
    input_path.write_text(
        json.dumps({"role": "security", "leads": []}), encoding="utf-8"
    )
    rc = main(
        [
            "--role",
            "security",
            "--input",
            str(input_path),
            "--output",
            "nested/out.json",
            "--workspace-root",
            str(tmp_path),
        ]
    )
    assert rc == 0
    expected = tmp_path / "nested" / "out.json"
    assert expected.exists()
    assert not (elsewhere / "nested" / "out.json").exists()
    data = json.loads(expected.read_text())
    assert data["role"] == "security"
    assert data["leads"] == []


def test_cli_rejects_malformed_json_and_still_writes_the_result(tmp_path):
    input_path = tmp_path / "bad.json"
    output_path = tmp_path / "out.json"
    input_path.write_text("{not json")
    rc = main(
        [
            "--role",
            "security",
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--workspace-root",
            str(tmp_path),
        ]
    )
    assert rc == 1
    data = json.loads(output_path.read_text())
    assert data["leads"] == []
    assert data["errors"]
    assert "malformed JSON" in data["errors"][0]


def test_cli_rejects_invalid_role(tmp_path):
    input_path = tmp_path / "in.json"
    output_path = tmp_path / "out.json"
    input_path.write_text(json.dumps({"leads": [{"message": "m"}]}))
    rc = main(
        [
            "--role",
            "nope",
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--workspace-root",
            str(tmp_path),
        ]
    )
    assert rc == 1
    data = json.loads(output_path.read_text())
    assert "unknown specialist role" in data["errors"][0]


def test_cli_rejects_output_outside_workspace(tmp_path):
    input_path = tmp_path / "in.json"
    input_path.write_text(json.dumps({"role": "security", "leads": []}))
    outside = tmp_path.parent / f"{tmp_path.name}-outside.json"
    rc = main(
        [
            "--role",
            "security",
            "--input",
            str(input_path),
            "--output",
            str(outside),
            "--workspace-root",
            str(tmp_path),
        ]
    )
    assert rc == 1
    assert not outside.exists()
