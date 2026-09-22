"""Tests for failure-path contract auditing (#625).

Covers the required behaviours: the correctness prompt asks for
terminal-path enumeration; a complete happy + failure implementation
produces no required lead; a missing failure-path artifact/state produces
a useful lead; timeout and exception paths are considered separately when
their behavior differs; a broad ``BaseException`` / catch-all handler does
not automatically create a finding without a contract mismatch;
disabled/no-op behavior is checked when explicitly part of the contract;
the #623-derived failure-contract fixture is detected semantically; and
specialist output remains bounded and advisory.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

import pytest

from pr_reviewer import specialists
from pr_reviewer.failure_paths import (
    MAX_LEADS,
    TERMINAL_PATH_KINDS,
    analyze_failure_paths,
    load_contract,
)

FIXTURE_DIR = _REPO_ROOT / "tests" / "fixtures" / "failure_paths"
FIXTURE_PY = FIXTURE_DIR / "specialist_deep_review.py"
FIXTURE_CONTRACT = FIXTURE_DIR / "specialist_deep_review.contract.json"
CORRECTNESS_PROMPT = _REPO_ROOT / "scripts" / "prompt_fragments" / "specialist_correctness.txt"


def _contract(paths: dict) -> dict:
    return {"paths": paths}


# ---------------------------------------------------------------------------
# Prompt fragment: terminal-path enumeration is asked for
# ---------------------------------------------------------------------------


def test_correctness_prompt_asks_for_terminal_path_enumeration():
    text = CORRECTNESS_PROMPT.read_text(encoding="utf-8").lower()
    assert "every material terminal path" in text
    for phrase in (
        "success",
        "validation/malformed",
        "timeout/cancellation/deadline",
        "retry exhaustion/transport failure",
        "exception/early return",
        "disabled/no-op configuration",
        "partial artifact/write failure",
    ):
        assert phrase in text, phrase
    # The audit is comparative: promised state per path vs the happy path.
    assert "observable output/state contracts" in text


def test_correctness_prompt_is_grounded_and_does_not_flag_shape_alone():
    text = CORRECTNESS_PROMPT.read_text(encoding="utf-8").lower()
    # Grounding: explicit contracts only, no fabrication.
    assert "requirement ledger" in text
    assert "do not manufacture hypothetical contracts" in text
    # Catch-all / fail-soft shape is an anchor, not an automatic finding.
    assert "catch-all" in text
    assert "not a lead" in text
    # Happy vs exceptional comparison when outputs are promised.
    assert "compare happy and exceptional paths" in text


# ---------------------------------------------------------------------------
# Grounding: no explicit contract, no leads
# ---------------------------------------------------------------------------


def test_no_contract_means_no_leads():
    code = "def f():\n    try:\n        do()\n    except Exception:\n        pass\n"
    assert analyze_failure_paths(code) == []
    assert analyze_failure_paths(code, contract={}) == []


def test_only_kinds_the_contract_names_are_checked():
    code = (
        "def f():\n"
        "    try:\n"
        "        do()\n"
        "    except Exception:\n"
        "        pass  # nothing promised for success\n"
    )
    # The contract names only 'success' and promises 'response.json'; the
    # exception path is never checked (it is not named) even though it
    # clearly emits nothing.
    contract = _contract({"success": ["response.json"]})
    leads = analyze_failure_paths(code, contract=contract)
    assert leads and all("success" in l["message"] for l in leads)

    # Inverting the promise: nothing promised anywhere => no leads at all,
    # because there is no stated contract to violate.
    assert analyze_failure_paths(code, contract=_contract({})) == []


def test_load_contract_rejects_unknown_path_kinds_and_bad_shapes():
    import json
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:

        def dump(payload: dict) -> str:
            path = Path(tmp) / "contract.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            return str(path)

        # A well-typed contract with an unknown kind is a semantic error.
        with pytest.raises(ValueError, match="unknown path kind"):
            load_contract(dump({"paths": {"catastrophic": ["x"]}}))
        # Malformed shapes are type errors — a bad contract is never
        # silently shrunk.
        with pytest.raises(TypeError, match="a 'paths' mapping"):
            load_contract(dump({"paths": "not-a-mapping"}))
        with pytest.raises(TypeError, match="must be an array"):
            load_contract(dump({"paths": {"timeout": "not-a-list"}}))


def test_load_contract_fails_closed_on_malformed_paths(tmp_path):
    import json

    # A NUL byte in the path is rejected by the OS layer (ValueError); a
    # missing path surfaces as FileNotFoundError. Neither is swallowed, so a
    # malformed contract path can never be read as if it were valid.
    with pytest.raises(ValueError):
        load_contract(str(tmp_path / "contract.json") + "\x00")
    with pytest.raises(FileNotFoundError):
        load_contract(str(tmp_path / "does-not-exist.json"))


def test_load_contract_reads_through_a_symlink_and_fails_closed_when_broken(tmp_path):
    import json

    real = tmp_path / "real.json"
    real.write_text(json.dumps({"paths": {"success": ["response.json"]}}), encoding="utf-8")
    link = tmp_path / "link.json"
    link.symlink_to(real)
    assert load_contract(link)["paths"]["success"] == ["response.json"]

    broken = tmp_path / "broken.json"
    broken.symlink_to(tmp_path / "missing.json")
    with pytest.raises(FileNotFoundError):
        load_contract(broken)


def test_all_seven_terminal_path_kinds_are_recognized():
    assert TERMINAL_PATH_KINDS == (
        "success",
        "validation",
        "timeout",
        "transport",
        "exception",
        "disabled",
        "write_failure",
    )


# ---------------------------------------------------------------------------
# Complete happy + failure implementation => no required lead
# ---------------------------------------------------------------------------


def test_complete_implementation_produces_no_required_lead():
    code = (
        "def f():\n"
        "    write('response.json')\n"
        "    try:\n"
        "        do()\n"
        "    except TimeoutError as e:\n"
        "        write('response.json')\n"
        "        return 'timed out'\n"
        "    except Exception as e:\n"
        "        write('response.json')\n"
        "        return 'failed'\n"
    )
    contract = _contract(
        {
            "success": ["response.json"],
            "timeout": ["response.json"],
            "exception": ["response.json"],
        }
    )
    assert analyze_failure_paths(code, contract=contract) == []


# ---------------------------------------------------------------------------
# Missing failure-path artifact/state => a useful lead
# ---------------------------------------------------------------------------


def test_missing_failure_artifact_produces_a_useful_lead():
    code = (
        "def f():\n"
        "    write('response.json')\n"
        "    try:\n"
        "        do()\n"
        "    except Exception as e:\n"
        "        return 'failed'\n"
    )
    contract = _contract({"exception": ["response.json"]})
    leads = analyze_failure_paths(code, contract=contract, file="pipeline.py")
    assert len(leads) == 1
    lead = leads[0]
    assert "terminal path 'exception'" in lead["message"]
    assert "response.json" in lead["message"]
    assert lead["file"] == "pipeline.py"
    assert lead["line"] == 5  # the except line, 1-based
    assert lead["category"] == "failure-contract"
    assert lead["severity"] == "major"


def test_success_path_missing_promised_observable_is_a_lead():
    code = "def f():\n    do_work()\n"
    leads = analyze_failure_paths(code, contract=_contract({"success": ["response.json"]}))
    assert len(leads) == 1
    assert "success" in leads[0]["message"]
    assert "response.json" in leads[0]["message"]


# ---------------------------------------------------------------------------
# Timeout/cancellation and exception are considered separately
# ---------------------------------------------------------------------------


def test_timeout_and_exception_are_considered_separately():
    code = (
        "def f():\n"
        "    try:\n"
        "        do()\n"
        "    except TimeoutError as e:\n"
        "        note('timed out')\n"
        "        return 'timed out'\n"
        "    except Exception as e:\n"
        "        note('failed')\n"
        "        return 'failed'\n"
    )
    contract = _contract({"timeout": ["response.json"], "exception": ["response.json"]})
    leads = analyze_failure_paths(code, contract=contract)
    # Both paths are audited, each anchored at its own line.
    assert len(leads) == 2
    timeout_leads = [l for l in leads if "timeout" in l["message"]]
    exception_leads = [l for l in leads if "terminal path 'exception'" in l["message"]]
    assert len(timeout_leads) == 1 and len(exception_leads) == 1
    assert timeout_leads[0]["line"] != exception_leads[0]["line"]


def test_fixing_one_path_drops_only_that_paths_leads():
    both = (
        "def f():\n"
        "    try:\n"
        "        do()\n"
        "    except TimeoutError as e:\n"
        "        note('timed out')\n"
        "    except Exception as e:\n"
        "        note('failed')\n"
    )
    # The timeout path now writes the promised observable; the exception
    # path does not.
    partial = both.replace(
        "        note('timed out')",
        "        write('response.json')\n        note('timed out')",
    )
    contract = _contract({"timeout": ["response.json"], "exception": ["response.json"]})
    assert len(analyze_failure_paths(both, contract=contract)) == 2
    leads = analyze_failure_paths(partial, contract=contract)
    assert len(leads) == 1
    assert "terminal path 'exception'" in leads[0]["message"]
    assert "timeout" not in leads[0]["message"]


# ---------------------------------------------------------------------------
# Catch-all shape alone is not a finding
# ---------------------------------------------------------------------------


def test_broad_catch_all_does_not_create_a_finding_without_contract_mismatch():
    code = (
        "def f():\n"
        "    try:\n"
        "        do()\n"
        "    except BaseException as e:\n"
        "        write('response.json')\n"
        "        write('artifact.json')\n"
        "        return 'degraded'\n"
    )
    # A BaseException handler whose block preserves every promised
    # observable is the shape the prompt calls an anchor, not a lead.
    contract = _contract({"exception": ["response.json", "artifact.json"]})
    assert analyze_failure_paths(code, contract=contract) == []


def test_broad_catch_all_with_a_real_mismatch_does_produce_a_lead():
    code = (
        "def f():\n"
        "    try:\n"
        "        do()\n"
        "    except BaseException as e:\n"
        "        return 'degraded'\n"
    )
    contract = _contract({"exception": ["response.json"]})
    leads = analyze_failure_paths(code, contract=contract)
    assert len(leads) == 1
    assert "terminal path 'exception'" in leads[0]["message"]


# ---------------------------------------------------------------------------
# Disabled / no-op is checked when explicitly part of the contract
# ---------------------------------------------------------------------------


def test_disabled_noop_is_checked_when_part_of_the_contract():
    # Promise: the enabled (success) path emits 'response.json'; the
    # disabled path must emit none of the contract's promised observables.
    violating = (
        "def f():\n"
        "    if not settings.enabled:\n"
        "        emit('response.json')\n"
        "        return 'noop'\n"
        "    emit('response.json')\n"
        "    do_work()\n"
    )
    compliant = (
        "def f():\n"
        "    if not settings.enabled:\n"
        "        return 'noop'\n"
        "    emit('response.json')\n"
        "    do_work()\n"
    )
    contract = _contract({"success": ["response.json"], "disabled": []})
    leads = analyze_failure_paths(violating, contract=contract)
    assert len(leads) == 1
    assert "disabled/no-op" in leads[0]["message"]
    assert "response.json" in leads[0]["message"]
    # The compliant shape (no-op emits nothing) is clean.
    assert analyze_failure_paths(compliant, contract=contract) == []


def test_disabled_is_not_checked_when_not_part_of_the_contract():
    code = (
        "def f():\n"
        "    if not settings.enabled:\n"
        "        emit('response.json')\n"
        "        return 'noop'\n"
        "    emit('response.json')\n"
    )
    # No 'disabled' entry in the contract: the no-op path is never checked,
    # even though it emits a success-promised observable.
    contract = _contract({"success": ["response.json"]})
    assert analyze_failure_paths(code, contract=contract) == []


# ---------------------------------------------------------------------------
# #623-derived fixture: the historical class is detected semantically
# ---------------------------------------------------------------------------


def _complete_fixture_source(fixture_text: str) -> str:
    """The same runner with the fallback writing the full promised set."""
    marker = '        return {"role": role, "status": "error"}'
    assert marker in fixture_text
    insert = (
        "        _guarded_write(\n"
        '            f"{workspace_root}/specialist-{role}.response.json",\n'
        '            json.dumps({"error": "exception"}),\n'
        "        )\n"
    )
    return fixture_text.replace(marker, insert + marker, 1)


def test_623_derived_fixture_is_detected_semantically():
    text = FIXTURE_PY.read_text(encoding="utf-8")
    contract = load_contract(FIXTURE_CONTRACT)
    leads = analyze_failure_paths(text, contract=contract, file="run_specialists.py")
    assert leads, (
        "the #623-derived gap (exception fallback dropping promised artifacts) must be detected"
    )
    for lead in leads:
        # The mismatch is attributed to the terminal path, not to the
        # catch-all's shape: every lead names the exception path and the
        # specific promised observable it fails to emit.
        assert "terminal path 'exception'" in lead["message"]
        assert "response.json" in lead["message"]
        assert lead["file"] == "run_specialists.py"
        assert lead["line"] is not None


def test_complete_623_fixture_produces_no_required_lead():
    text = _complete_fixture_source(FIXTURE_PY.read_text(encoding="utf-8"))
    contract = load_contract(FIXTURE_CONTRACT)
    assert analyze_failure_paths(text, contract=contract, file="run_specialists.py") == []


def test_fixture_contract_is_grounded_in_623_artifact_set():
    contract = load_contract(FIXTURE_CONTRACT)
    paths = contract["paths"]
    # The #608/#607 artifact contract, as the fixture's happy path honors it:
    # the aggregate plus the per-role response record, on the happy path and
    # the catastrophic-exception path alike.
    assert paths["success"] == ["response.json", "specialists.json"]
    assert paths["exception"] == ["response.json"]
    # Unnamed kinds are not fabricated by the loader.
    for kind in ("validation", "transport"):
        assert kind not in paths


# ---------------------------------------------------------------------------
# Bounded and advisory
# ---------------------------------------------------------------------------


def test_leads_are_bounded_to_the_cap():
    body = "".join(
        f"def f{i}():\n    try:\n        do({i})\n    except Exception as e:\n        note({i})\n"
        for i in range(30)
    )
    contract = _contract({"exception": ["response.json"]})
    leads = analyze_failure_paths(body, contract=contract)
    assert len(leads) == MAX_LEADS


def test_specialist_output_stays_bounded_and_advisory():
    text = FIXTURE_PY.read_text(encoding="utf-8")
    contract = load_contract(FIXTURE_CONTRACT)
    raw = analyze_failure_paths(text, contract=contract, file="run_specialists.py")
    # The raw leads normalize cleanly through the #607 contract as
    # correctness-specialist leads, and the severity stays at the cap —
    # below blocker, never verdict-setting.
    result = specialists.normalize_specialist_output(
        {"role": "correctness", "leads": raw}, role="correctness"
    )
    assert result["errors"] == []
    assert len(result["leads"]) == len(raw)
    for lead in result["leads"]:
        assert lead["severity"] == specialists.MAX_SPECIALIST_SEVERITY == "major"
        assert lead["category"] == "failure-contract"
    assert all(lead["severity"] != "blocker" for lead in result["leads"])
