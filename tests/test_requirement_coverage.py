"""Tests for the requirement-coverage normalizer (#624).

Covers the required behaviours: the evidence-gated credit rules (a
satisfied / violated claim with no CONCRETE evidence is downgraded to
unknown), the invariant "needs observable verification" rule (file / diff
evidence alone cannot credit a sequencing invariant; test / tool / ci can),
the "unknown is never upgraded" rule, bounded caps with *visible*
truncation (coverage rows, evidence items, evidence characters), fail-soft
degradation of unmatched / duplicate / malformed claims (visible
``dropped-`` / ``duplicate-`` / ``coverage-truncated-`` errors), the
``not-covered-by-reviewer`` rows for uncovered ledger requirements,
determinism (identical JSON bytes, echoed ``ledger_sha``), the #623
dogfood fixture, and the CLI. The module never raises on malformed input,
so the fail-soft cases are exercised directly.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import requirement_coverage
from pr_reviewer import requirement_ledger
from pr_reviewer.requirement_coverage import (
    ARTIFACT_VERSION,
    MAX_COVERAGE_ITEMS,
    MAX_EVIDENCE_CHARS,
    MAX_EVIDENCE_ITEMS,
    load_coverage,
    main,
    normalize_requirement_coverage,
)
from pr_reviewer.requirement_ledger import extract_requirement_ledger


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ledger(entries, sha="abcd1234ef56abcd"):
    """Build a version-1 ledger artifact shell around *entries*."""
    return {
        "version": 1,
        "sha": sha,
        "requirements": entries,
        "truncation": {"truncated": False, "omitted_requirements": 0},
    }


def _entry(i, text, kind="acceptance", verification_required=False):
    return {
        "id": "req-" + format(i, "012x"),
        "text": text,
        "kind": kind,
        "verification_required": verification_required,
        "truncated": False,
        "provenance": [{"source": "standards", "ref": "AGENTS.md", "line": i + 1}],
    }


def _ev(kind, ref="", detail=""):
    item = {"kind": kind}
    if ref != "":
        item["ref"] = ref
    if detail != "":
        item["detail"] = detail
    return item


def _row(artifact, rid):
    return next(r for r in artifact["coverage"] if r["requirement_id"] == rid)


# ---------------------------------------------------------------------------
# Pinned constants
# ---------------------------------------------------------------------------


def test_caps_are_pinned():
    assert ARTIFACT_VERSION == 1
    assert MAX_COVERAGE_ITEMS == 64
    assert MAX_EVIDENCE_ITEMS == 8
    assert MAX_EVIDENCE_CHARS == 500


# ---------------------------------------------------------------------------
# 1. Happy path
# ---------------------------------------------------------------------------


def test_happy_claim_rows_and_order():
    ledger = _ledger(
        [
            _entry(0, "A one", "acceptance"),
            _entry(1, "A two", "normative"),
            _entry(2, "A three before B", "invariant", True),
        ]
    )
    claims = [
        # satisfied with a test (concrete) -> credited
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("test", "tests/t.py", "passes")]},
        # violated with a tool (concrete) -> not credited
        {"requirement_id": "req-000000000001", "status": "violated",
         "evidence": [_ev("tool", "make check", "fails")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)

    # rows in ledger-entry order (3 rows)
    assert [r["requirement_id"] for r in art["coverage"]] == [
        "req-000000000000",
        "req-000000000001",
        "req-000000000002",
    ]
    r0 = art["coverage"][0]
    assert r0["status"] == "satisfied"
    assert r0["credited"] is True
    # concrete evidence is preserved (capped ref / detail)
    assert r0["evidence"] == [{"kind": "test", "ref": "tests/t.py", "detail": "passes"}]
    r1 = art["coverage"][1]
    assert r1["status"] == "violated"
    assert r1["credited"] is False
    # the third ledger requirement is not covered
    r2 = art["coverage"][2]
    assert r2["status"] == "unknown"
    assert r2["credited"] is False
    assert r2["evidence"] == []
    assert r2["notes"] == ["not-covered-by-reviewer"]
    # summary
    assert art["summary"] == {
        "total": 3, "satisfied": 1, "violated": 1, "unknown": 1, "credited": 1,
    }
    # ledger sha echoed
    assert art["ledger_sha"] == ledger["sha"]
    assert art["errors"] == []


def test_case_insensitive_status():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "Satisfied",
          "evidence": [_ev("test", "r")]}],
        ledger,
    )
    assert art["coverage"][0]["status"] == "satisfied"
    assert art["coverage"][0]["credited"] is True


# ---------------------------------------------------------------------------
# 2. unknown is never upgraded
# ---------------------------------------------------------------------------


def test_unknown_never_upgraded_by_rich_evidence():
    # an invariant (verification_required) with a rich, fully-CONCRETE
    # evidence set: an "unknown" claim stays unknown and uncredited.
    ledger = _ledger([_entry(0, "A before B", "invariant", True)])
    claims = [
        {"requirement_id": "req-000000000000", "status": "unknown",
         "evidence": [
             _ev("test", "tests/t.py", "passes"),
             _ev("tool", "make check", "ok"),
             _ev("ci", "build #1", "green"),
         ]}
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert row["credited"] is False
    assert "status-invalid" not in row["notes"]


def test_invalid_status_downgrades_to_unknown():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "maybe",
          "evidence": [_ev("test", "r")]}],
        ledger,
    )
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert row["credited"] is False
    assert "status-invalid" in row["notes"]


def test_summary_counts_are_exact():
    ledger = _ledger([
        _entry(0, "A"),
        _entry(1, "B"),
        _entry(2, "C"),
        _entry(3, "D"),
    ])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("test", "r")]},
        {"requirement_id": "req-000000000001", "status": "violated",
         "evidence": [_ev("tool", "r")]},
        # req-2 / req-3 not covered -> unknown
    ]
    art = normalize_requirement_coverage(claims, ledger)
    assert art["summary"] == {
        "total": 4, "satisfied": 1, "violated": 1, "unknown": 2, "credited": 1,
    }


# ---------------------------------------------------------------------------
# 3. satisfied / violated with no CONCRETE evidence
# ---------------------------------------------------------------------------


def test_satisfied_empty_evidence_downgraded():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied", "evidence": []}],
        ledger,
    )
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert row["credited"] is False
    assert "downgraded-no-concrete-evidence" in row["notes"]


def test_satisfied_null_evidence_downgraded():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied", "evidence": None}],
        ledger,
    )
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert "downgraded-no-concrete-evidence" in row["notes"]


def test_satisfied_absent_evidence_downgraded():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied"}],
        ledger,
    )
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert "downgraded-no-concrete-evidence" in row["notes"]


def test_violated_empty_evidence_downgraded():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "violated", "evidence": []}],
        ledger,
    )
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert row["credited"] is False
    assert "downgraded-no-concrete-evidence" in row["notes"]


def test_valid_kind_but_empty_ref_detail_is_not_concrete():
    # a recognised kind with no non-empty ref / detail is kept in the
    # output but is NOT CONCRETE, so it downgrades.
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": [{"kind": "file", "ref": "", "detail": ""}]}],
        ledger,
    )
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert "downgraded-no-concrete-evidence" in row["notes"]
    # the item is still present (valid kind), just not concrete
    assert row["evidence"] == [{"kind": "file", "ref": "", "detail": ""}]


# ---------------------------------------------------------------------------
# 4. Invariant "needs observable verification"
# ---------------------------------------------------------------------------


def test_invariant_file_only_downgraded():
    ledger = _ledger([_entry(0, "A before B", "invariant", True)])
    # file + diff are both CONCRETE, but neither is a verification kind
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("file", "src/a.py", "edits"), _ev("diff", "+line")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = art["coverage"][0]
    assert row["status"] == "unknown"
    assert row["credited"] is False
    assert "downgraded-invariant-unverified" in row["notes"]
    assert "downgraded-no-concrete-evidence" not in row["notes"]


def test_invariant_with_tool_is_credited():
    ledger = _ledger([_entry(0, "A before B", "invariant", True)])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("file", "src/a.py"), _ev("tool", "make check", "ok")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = art["coverage"][0]
    assert row["status"] == "satisfied"
    assert row["credited"] is True
    assert "downgraded-invariant-unverified" not in row["notes"]


def test_invariant_test_only_is_credited():
    ledger = _ledger([_entry(0, "A before B", "invariant", True)])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("test", "tests/seq.py", "passes")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    assert art["coverage"][0]["status"] == "satisfied"
    assert art["coverage"][0]["credited"] is True


def test_invariant_ci_only_is_credited():
    ledger = _ledger([_entry(0, "A before B", "invariant", True)])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("ci", "build #9", "green")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    assert art["coverage"][0]["status"] == "satisfied"
    assert art["coverage"][0]["credited"] is True


def test_non_invariant_file_only_is_credited():
    # the verification rule only bites on verification_required entries
    ledger = _ledger([_entry(0, "A one", "acceptance", False)])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("file", "src/a.py", "edits")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    assert art["coverage"][0]["status"] == "satisfied"
    assert art["coverage"][0]["credited"] is True


# ---------------------------------------------------------------------------
# 4b. The #623 dogfood fixture
# ---------------------------------------------------------------------------


def _load_623_fixture():
    path = (
        Path(__file__).resolve().parent
        / "fixtures"
        / "requirement-ledger"
        / "dogfood-623-sequencing.json"
    )
    return json.loads(path.read_text(encoding="utf-8"))


def _build_623():
    fx = _load_623_fixture()
    ledger = extract_requirement_ledger(
        pr_json={"body": fx["pr_body_text"]},
        standards_text=fx["issue_contract_text"],
    )
    reap_id = next(
        r["id"]
        for r in ledger["requirements"]
        if r["kind"] == "invariant" and "reaped" in r["text"]
    )
    return fx, ledger, reap_id


def test_623_launch_order_only_not_credited():
    fx, ledger, reap_id = _build_623()
    claims = [
        dict(c, requirement_id=reap_id) for c in fx["coverage_claims"]["launch_order_only"]
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = _row(art, reap_id)
    assert row["status"] == "unknown"
    assert row["credited"] is False
    assert "downgraded-invariant-unverified" in row["notes"]


def test_623_reap_verified_is_credited():
    fx, ledger, reap_id = _build_623()
    claims = [
        dict(c, requirement_id=reap_id) for c in fx["coverage_claims"]["reap_verified"]
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = _row(art, reap_id)
    assert row["status"] == "satisfied"
    assert row["credited"] is True
    assert "downgraded-invariant-unverified" not in row["notes"]


# ---------------------------------------------------------------------------
# 5. Evidence caps and invalid kinds
# ---------------------------------------------------------------------------


def test_invalid_kind_dropped_with_note():
    ledger = _ledger([_entry(0, "A one")])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("banana", "r1"), _ev("file", "r2")]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = art["coverage"][0]
    assert row["notes"].count("dropped-evidence-invalid-kind") == 1
    assert row["evidence"] == [{"kind": "file", "ref": "r2", "detail": ""}]


def test_non_dict_evidence_item_dropped():
    ledger = _ledger([_entry(0, "A one")])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [42, "x", None]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = art["coverage"][0]
    assert row["notes"].count("dropped-evidence-invalid-kind") == 3
    assert row["evidence"] == []


def test_missing_kind_dropped():
    ledger = _ledger([_entry(0, "A one")])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [{"ref": "r"}]},
    ]
    art = normalize_requirement_coverage(claims, ledger)
    row = art["coverage"][0]
    # dropping the only evidence removes all CONCRETE evidence, so the
    # satisfied claim is additionally downgraded
    assert "dropped-evidence-invalid-kind" in row["notes"]
    assert "downgraded-no-concrete-evidence" in row["notes"]
    assert row["evidence"] == []
    assert row["status"] == "unknown"
    assert row["credited"] is False


def test_evidence_truncated_to_eight():
    ledger = _ledger([_entry(0, "A one")])
    ten = [_ev("test", "r%d" % i) for i in range(10)]
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied", "evidence": ten}],
        ledger,
    )
    row = art["coverage"][0]
    assert len(row["evidence"]) == 8
    assert "evidence-truncated" in row["notes"]
    # the first 8 are kept
    assert row["evidence"][0] == {"kind": "test", "ref": "r0", "detail": ""}
    assert row["evidence"][7] == {"kind": "test", "ref": "r7", "detail": ""}


def test_ref_capped_to_max_chars_with_marker():
    ledger = _ledger([_entry(0, "A one")])
    long = "a" * (MAX_EVIDENCE_CHARS + 100)
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": [_ev("test", long)]}],
        ledger,
    )
    ref = art["coverage"][0]["evidence"][0]["ref"]
    assert len(ref) == MAX_EVIDENCE_CHARS
    assert ref.endswith("…")


def test_detail_capped_to_max_chars_with_marker():
    ledger = _ledger([_entry(0, "A one")])
    long = "b" * (MAX_EVIDENCE_CHARS + 50)
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": [{"kind": "test", "detail": long}]},
        ],
        ledger,
    )
    detail = art["coverage"][0]["evidence"][0]["detail"]
    assert len(detail) == MAX_EVIDENCE_CHARS
    assert detail.endswith("…")


def test_short_ref_not_capped():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": [_ev("test", "short")]},
        ],
        ledger,
    )
    assert art["coverage"][0]["evidence"][0]["ref"] == "short"


# ---------------------------------------------------------------------------
# 6. unmatched / duplicate / row truncation
# ---------------------------------------------------------------------------


def test_unknown_id_dropped_with_error():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-deadbeefdead", "status": "satisfied",
          "evidence": [_ev("test", "r")]},
         {"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": [_ev("test", "r")]},
         ],
        ledger,
    )
    assert "dropped-coverage-req-deadbeefdead" in art["errors"]
    # the matched requirement is covered
    assert _row(art, "req-000000000000")["credited"] is True


def test_duplicate_first_wins_with_error():
    ledger = _ledger([_entry(0, "A one")])
    art = normalize_requirement_coverage(
        [
            {"requirement_id": "req-000000000000", "status": "satisfied",
             "evidence": [_ev("test", "r")]},
            {"requirement_id": "req-000000000000", "status": "violated",
             "evidence": [_ev("tool", "r")]},
        ],
        ledger,
    )
    assert art["errors"] == ["duplicate-coverage-req-000000000000"]
    # the first (satisfied) claim wins
    assert _row(art, "req-000000000000")["status"] == "satisfied"


def test_coverage_rows_truncated_to_sixty_four():
    entries = [
        _entry(i, "t%d" % i) for i in range(MAX_COVERAGE_ITEMS + 6)
    ]
    ledger = _ledger(entries)
    art = normalize_requirement_coverage([], ledger)
    assert len(art["coverage"]) == MAX_COVERAGE_ITEMS
    assert "coverage-truncated-6" in art["errors"]


# ---------------------------------------------------------------------------
# 7. Malformed payloads never raise
# ---------------------------------------------------------------------------


def test_malformed_payloads_never_raise():
    ledger = _ledger([_entry(0, "A one"), _entry(1, "B two")])
    payloads = [
        None,
        "corrupt",
        {"nope": 1},
        5,
        3.14,
        [42],
        ["x"],
        [None],
        [{"requirement_id": 5}],
        [{"requirement_id": None}],
        [{"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": "not-a-list"}],
        [{"requirement_id": "req-000000000000", "status": 9}],
    ]
    for p in payloads:
        art = normalize_requirement_coverage(p, ledger)
        assert isinstance(art, dict)
        assert set(art) == {"version", "ledger_sha", "coverage", "summary", "errors"}
        assert art["ledger_sha"] == ledger["sha"]
        # both ledger requirements still yield a row (not-covered)
        assert len(art["coverage"]) == 2


def test_non_dict_ledger_degrades_to_unavailable():
    art = normalize_requirement_coverage(
        [{"requirement_id": "req-000000000000", "status": "satisfied",
          "evidence": [_ev("test", "r")]},
         ],
        None,
    )
    assert "ledger-unavailable" in art["errors"]
    assert art["coverage"] == []


def test_empty_ledger_degrades_to_unavailable():
    empty = _ledger([], sha="0" * 16)
    art = normalize_requirement_coverage([], empty)
    assert "ledger-unavailable" in art["errors"]
    assert art["coverage"] == []


# ---------------------------------------------------------------------------
# 8. Determinism
# ---------------------------------------------------------------------------


def test_determinism_identical_bytes():
    ledger = _ledger([
        _entry(0, "A one"),
        _entry(1, "A before B", "invariant", True),
    ])
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("test", "r")]},
        {"requirement_id": "req-000000000001", "status": "satisfied",
         "evidence": [_ev("file", "src/a.py")]},
    ]
    art1 = normalize_requirement_coverage(claims, ledger)
    art2 = normalize_requirement_coverage(claims, ledger)
    b1 = json.dumps(art1, sort_keys=True).encode("utf-8")
    b2 = json.dumps(art2, sort_keys=True).encode("utf-8")
    assert b1 == b2
    # ledger sha echoed
    assert art1["ledger_sha"] == ledger["sha"]


# ---------------------------------------------------------------------------
# 9. CLI
# ---------------------------------------------------------------------------


def _write(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    return path


def test_cli_object_coverage_to_output(tmp_path):
    # an ai-output.json-style object with the coverage key
    obj = {
        "verdict": "approve",
        "requirement_coverage": [
            {"requirement_id": "req-000000000000", "status": "satisfied",
             "evidence": [_ev("test", "r")]},
        ],
    }
    cov = _write(tmp_path / "ai-output.json", obj)
    ledger = _ledger([_entry(0, "A one")])
    led = _write(tmp_path / "ledger.json", ledger)
    out = tmp_path / "coverage.json"

    rc = main(["--coverage", str(cov), "--ledger", str(led), "--output", str(out)])
    assert rc == 0
    art = json.loads(out.read_text(encoding="utf-8"))
    # load_ledger always recomputes the sha from the surviving entries
    canonical = requirement_ledger.load_ledger(str(led))
    assert art["ledger_sha"] == canonical["sha"]
    assert art["coverage"][0]["credited"] is True


def test_cli_bare_array_to_output(tmp_path):
    claims = [
        {"requirement_id": "req-000000000000", "status": "violated",
         "evidence": [_ev("tool", "r")]},
    ]
    cov = _write(tmp_path / "claims.json", claims)
    ledger = _ledger([_entry(0, "A one")])
    led = _write(tmp_path / "ledger.json", ledger)
    out = tmp_path / "coverage.json"

    rc = main(["--coverage", str(cov), "--ledger", str(led), "--output", str(out)])
    assert rc == 0
    art = json.loads(out.read_text(encoding="utf-8"))
    assert art["coverage"][0]["status"] == "violated"
    assert art["coverage"][0]["credited"] is False


def test_cli_missing_output_prints_stdout(tmp_path, capsys):
    claims = [
        {"requirement_id": "req-000000000000", "status": "satisfied",
         "evidence": [_ev("test", "r")]},
    ]
    cov = _write(tmp_path / "claims.json", claims)
    ledger = _ledger([_entry(0, "A one")])
    led = _write(tmp_path / "ledger.json", ledger)

    rc = main(["--coverage", str(cov), "--ledger", str(led)])
    assert rc == 0
    captured = capsys.readouterr()
    art = json.loads(captured.out)
    assert art["coverage"][0]["credited"] is True


def test_cli_missing_files_exit_zero_fail_soft(tmp_path, capsys):
    # neither file exists -> fail-soft, exit 0, ledger-unavailable
    rc = main([
        "--coverage", str(tmp_path / "nope.json"),
        "--ledger", str(tmp_path / "nope-ledger.json"),
    ])
    assert rc == 0
    art = json.loads(capsys.readouterr().out)
    assert "ledger-unavailable" in art["errors"]
    assert art["coverage"] == []


def test_cli_bad_json_exit_zero_fail_soft(tmp_path, capsys):
    cov = tmp_path / "bad.json"
    cov.write_text("{not valid json", encoding="utf-8")
    ledger = _ledger([_entry(0, "A one")])
    led = _write(tmp_path / "ledger.json", ledger)

    rc = main(["--coverage", str(cov), "--ledger", str(led)])
    assert rc == 0
    art = json.loads(capsys.readouterr().out)
    # bad coverage payload -> no claims, both ledger rows not-covered
    assert art["coverage"][0]["notes"] == ["not-covered-by-reviewer"]


def test_cli_custom_coverage_key(tmp_path, capsys):
    obj = {
        "claims": [
            {"requirement_id": "req-000000000000", "status": "satisfied",
             "evidence": [_ev("test", "r")]},
        ],
    }
    cov = _write(tmp_path / "obj.json", obj)
    ledger = _ledger([_entry(0, "A one")])
    led = _write(tmp_path / "ledger.json", ledger)

    rc = main(["--coverage", str(cov), "--ledger", str(led), "--coverage-key", "claims"])
    assert rc == 0
    art = json.loads(capsys.readouterr().out)
    assert art["coverage"][0]["credited"] is True


def test_load_coverage_fail_soft(tmp_path):
    assert load_coverage(str(tmp_path / "missing.json")) is None
    bad = tmp_path / "bad.json"
    bad.write_text("{corrupt", encoding="utf-8")
    assert load_coverage(str(bad)) is None
    good = tmp_path / "good.json"
    good.write_text("[1, 2, 3]", encoding="utf-8")
    assert load_coverage(str(good)) == [1, 2, 3]
    obj = tmp_path / "obj.json"
    obj.write_text('{"requirement_coverage": [1]}', encoding="utf-8")
    assert load_coverage(str(obj)) == {"requirement_coverage": [1]}
