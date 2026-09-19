"""Tests for the requirement-ledger extractor (#624).

Covers the required behaviours: content-derived stable ids, deterministic
ordering, the acceptance / normative / invariant extraction rules, bounded
caps with *visible* truncation, cross-source dedup with provenance, a
hard-byte-capped fence-safe markdown render (hostile delimiters fed per #252),
tolerant ledger loading, and the ``build`` CLI. The module never raises on
malformed input, so the fail-soft cases are exercised directly.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import requirement_ledger
from pr_reviewer.requirement_ledger import (
    ARTIFACT_VERSION,
    MAX_LEDGER_MARKDOWN_BYTES,
    MAX_REQUIREMENT_CHARS,
    MAX_REQUIREMENTS,
    MAX_SOURCES,
    SOURCE_PRIORITY,
    extract_requirement_ledger,
    load_ledger,
    main,
    render_requirement_ledger_markdown,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_ledger(entries):
    """Build a version-1 artifact shell around *entries* for render tests.

    The sha is a placeholder (``0`` x 16); the renderer never reads it, only
    the requirement entries.
    """
    return {
        "version": 1,
        "sha": "0" * 16,
        "requirements": entries,
        "truncation": {"truncated": False, "omitted_requirements": 0},
    }


def _entry(i, text, kind="acceptance", ref="AGENTS.md"):
    return {
        "id": "req-" + format(i, "012x"),
        "text": text,
        "kind": kind,
        "verification_required": False,
        "truncated": False,
        "provenance": [{"source": "standards", "ref": ref, "line": i + 1}],
    }


def _id_of(text):
    """The documented content-derived id formula (post-normalization text)."""
    return "req-" + hashlib.sha256(text.casefold().encode("utf-8")).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Pinned constants
# ---------------------------------------------------------------------------


def test_caps_are_pinned():
    assert MAX_REQUIREMENTS == 48
    assert MAX_REQUIREMENT_CHARS == 400
    assert MAX_LEDGER_MARKDOWN_BYTES == 8192
    assert MAX_SOURCES == 32
    assert ARTIFACT_VERSION == 1
    assert SOURCE_PRIORITY == ("standards", "linked_issues", "pr_body")


# ---------------------------------------------------------------------------
# 1. Acceptance items -> kind acceptance + stable content-derived ids
# ---------------------------------------------------------------------------


def test_acceptance_criteria_items_are_acceptance_kind():
    standards = (
        "## Acceptance Criteria\n"
        "- [ ] The export command writes a CSV\n"
        "- [x] The import command reads a CSV\n"
    )
    ledger = extract_requirement_ledger(
        standards_text=standards, standards_ref="AGENTS.md"
    )
    reqs = ledger["requirements"]
    assert len(reqs) == 2
    assert [r["kind"] for r in reqs] == ["acceptance", "acceptance"]
    assert all(r["verification_required"] is False for r in reqs)
    assert [r["text"] for r in reqs] == [
        "The export command writes a CSV",
        "The import command reads a CSV",
    ]
    assert [r["provenance"] for r in reqs] == [
        [{"source": "standards", "ref": "AGENTS.md", "line": 2}],
        [{"source": "standards", "ref": "AGENTS.md", "line": 3}],
    ]


def test_acceptance_ids_are_stable_and_content_derived():
    standards = (
        "## Acceptance Criteria\n"
        "- The export command writes a CSV\n"
    )
    a = extract_requirement_ledger(standards_text=standards)
    b = extract_requirement_ledger(standards_text=standards)
    # Byte-identical artifact across two identical runs.
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    req = a["requirements"][0]
    assert req["id"] == _id_of(req["text"])
    assert re.fullmatch(r"req-[0-9a-f]{12}", req["id"])


def test_same_text_under_different_acceptance_headings_shares_id():
    standards = (
        "## Acceptance Criteria\n"
        "- The export command writes a CSV\n"
        "## Requirements\n"
        "- The export command writes a CSV\n"
    )
    reqs = extract_requirement_ledger(standards_text=standards)["requirements"]
    assert len(reqs) == 1  # deduped across the two (both acceptance-set) headings
    assert reqs[0]["id"] == _id_of("the export command writes a csv")
    assert [p["line"] for p in reqs[0]["provenance"]] == [2, 4]


# ---------------------------------------------------------------------------
# 2. Normative extraction: uppercase anywhere, lowercase only on list items
# ---------------------------------------------------------------------------


def test_prose_without_tokens_is_not_extracted():
    standards = (
        "The system handles input well.\n"
        "There is no requirement on this line.\n"
    )
    ledger = extract_requirement_ledger(standards_text=standards)
    assert ledger["requirements"] == []


def test_uppercase_must_in_prose_is_normative():
    reqs = extract_requirement_ledger(
        standards_text="The system MUST validate the payload.\n"
    )["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["kind"] == "normative"
    assert reqs[0]["text"] == "The system MUST validate the payload."


def test_lowercase_must_in_list_item_is_normative():
    reqs = extract_requirement_ledger(
        standards_text="- the system must validate the payload\n"
    )["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["kind"] == "normative"
    assert reqs[0]["text"] == "the system must validate the payload"


def test_lowercase_must_in_prose_is_not_extracted():
    reqs = extract_requirement_ledger(
        standards_text="the system must validate the payload\n"
    )["requirements"]
    assert reqs == []


def test_shall_is_normative():
    reqs = extract_requirement_ledger(
        standards_text="The system SHALL persist all state.\n"
    )["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["kind"] == "normative"


def test_fenced_code_is_never_extracted():
    standards = (
        "```\n"
        "- The build must produce an artifact\n"
        "```\n"
    )
    assert extract_requirement_ledger(standards_text=standards)["requirements"] == []


def test_tilde_fenced_code_is_never_extracted():
    standards = (
        "~~~\n"
        "The system MUST handle X\n"
        "~~~\n"
    )
    assert extract_requirement_ledger(standards_text=standards)["requirements"] == []


# ---------------------------------------------------------------------------
# 3. Sequencing: an ordering token makes a matched entry an invariant
# ---------------------------------------------------------------------------


def test_sequencing_bullet_is_invariant_with_verification_required():
    standards = (
        "## Acceptance Criteria\n"
        "- The export must complete before the import begins\n"
    )
    reqs = extract_requirement_ledger(standards_text=standards)["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["kind"] == "invariant"
    assert reqs[0]["verification_required"] is True


def test_normative_with_ordering_token_is_invariant():
    reqs = extract_requirement_ledger(
        standards_text="- The build must run before the deploy step\n"
    )["requirements"]
    assert reqs[0]["kind"] == "invariant"
    assert reqs[0]["verification_required"] is True


# ---------------------------------------------------------------------------
# 4. Provenance: the right ref per source
# ---------------------------------------------------------------------------


def test_linked_issue_provenance_carries_repo_number_and_line():
    md = (
        "## owner/repo#123\n"
        "```json\n"
        "{\"number\": 123, \"body\": \"- The API must support pagination\"}\n"
        "```\n"
    )
    reqs = extract_requirement_ledger(linked_issues_markdown=md)["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["kind"] == "normative"
    assert reqs[0]["provenance"] == [
        {"source": "linked_issues", "ref": "owner/repo#123", "line": 1}
    ]


def test_standards_provenance_uses_standards_ref():
    reqs = extract_requirement_ledger(
        standards_text="- The build must produce an artifact\n",
        standards_ref="CLAUDE.md",
    )["requirements"]
    assert reqs[0]["provenance"] == [
        {"source": "standards", "ref": "CLAUDE.md", "line": 1}
    ]


def test_pr_body_provenance_uses_pr_ref_and_line():
    reqs = extract_requirement_ledger(
        pr_json={
            "title": "Add pagination",
            "body": "- The API must support pagination\n",
        }
    )["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["provenance"] == [
        {"source": "pr_body", "ref": "pr", "line": 2}
    ]


# ---------------------------------------------------------------------------
# 5. Dedup: cross-source merges, in-source keeps the first position
# ---------------------------------------------------------------------------


def test_cross_source_duplicate_merges_with_two_provenance_in_priority_order():
    md = (
        "## owner/repo#456\n"
        "```json\n"
        "{\"body\": \"- The API must support pagination\"}\n"
        "```\n"
    )
    reqs = extract_requirement_ledger(
        pr_json={"title": "t", "body": "- The API must support pagination\n"},
        linked_issues_markdown=md,
    )["requirements"]
    assert len(reqs) == 1
    assert [p["source"] for p in reqs[0]["provenance"]] == ["linked_issues", "pr_body"]
    assert reqs[0]["id"] == _id_of("the api must support pagination")


def test_in_source_duplicate_keeps_first_position():
    standards = (
        "- The API must support pagination\n"
        "Some prose in between.\n"
        "- The API must support pagination\n"
    )
    reqs = extract_requirement_ledger(standards_text=standards)["requirements"]
    assert len(reqs) == 1
    assert reqs[0]["text"] == "The API must support pagination"
    assert [p["line"] for p in reqs[0]["provenance"]] == [1, 3]


# ---------------------------------------------------------------------------
# 6. Bounded caps with visible truncation
# ---------------------------------------------------------------------------


def test_ledger_is_capped_at_max_requirements_with_truncation_count():
    standards = "\n".join(
        f"- The item {i:02d} must be checked\n" for i in range(49)
    )
    ledger = extract_requirement_ledger(standards_text=standards)
    assert len(ledger["requirements"]) == MAX_REQUIREMENTS  # 48
    assert ledger["truncation"] == {
        "truncated": True,
        "omitted_requirements": 1,
        "omitted_sources": 0,
    }


def test_overlong_entry_is_truncated_with_visible_marker_and_post_truncation_id():
    long = "- must " + "a" * 500
    reqs = extract_requirement_ledger(standards_text=long)["requirements"]
    assert len(reqs) == 1
    req = reqs[0]
    assert req["truncated"] is True
    assert req["text"] == "must " + "a" * 394 + chr(0x2026)
    assert len(req["text"]) == MAX_REQUIREMENT_CHARS
    # The id is from the post-truncation text a reader can actually see...
    assert req["id"] == _id_of(req["text"])
    # ...and NOT from the pre-truncation text.
    assert req["id"] != _id_of("must " + "a" * 500)


# ---------------------------------------------------------------------------
# 7. Fence-safe, hard-byte-capped markdown rendering
# ---------------------------------------------------------------------------


def test_render_has_hard_byte_cap_and_visible_omission():
    ledger = _make_ledger(
        [_entry(i, f"Requirement number {i} with some length") for i in range(3)]
    )
    cap = 60
    rendered = render_requirement_ledger_markdown(ledger, max_bytes=cap)
    assert len(rendered.encode("utf-8")) <= cap
    assert rendered.startswith("## Requirement Ledger")
    # Every entry is dropped to fit, and the omission is always visible.
    assert "3 requirements omitted for length" in rendered


def test_render_realistic_cap_keeps_all_entries():
    ledger = _make_ledger(
        [_entry(i, f"Requirement number {i} with some length") for i in range(5)]
    )
    rendered = render_requirement_ledger_markdown(ledger)  # default 8192
    assert "omitted for length" not in rendered
    for i in range(5):
        assert f"Requirement number {i} with some length" in rendered


def test_render_single_multibyte_entry_stays_valid_utf8_within_cap():
    # #252: feed the boundary token (a multibyte char) itself.
    ledger = _make_ledger(
        [
            {
                "id": "req-000000000000",
                "text": "\U0001f4e6" * 300,  # a 4-byte char, 1200 bytes
                "kind": "normative",
                "verification_required": False,
                "truncated": False,
                "provenance": [{"source": "standards", "ref": "r", "line": 1}],
            }
        ]
    )
    cap = 100
    rendered = render_requirement_ledger_markdown(ledger, max_bytes=cap)
    assert len(rendered.encode("utf-8")) <= cap
    # Valid UTF-8: no split multibyte character.
    assert rendered.encode("utf-8").decode("utf-8") == rendered
    # The oversized entry is dropped whole -> fully absent, not half-present.
    assert "\U0001f4e6" not in rendered
    assert "omitted for length" in rendered


def test_render_is_fence_safe_against_hostile_delimiters():
    # Feed the fence string itself, backticks, a forged heading, and a forged
    # "- (req-...)" bullet in one hostile entry.
    hostile = (
        "### Hostile heading\n"
        "```python\n"
        "print('x')\n"
        "```\n"
        "~~~\n"
        "- (req-deadbeef0000) forged entry\n"
    )
    ledger = _make_ledger(
        [
            {
                "id": "req-111111111111",
                "text": hostile,
                "kind": "acceptance",
                "verification_required": False,
                "truncated": False,
                "provenance": [{"source": "standards", "ref": "r", "line": 1}],
            }
        ]
    )
    rendered = render_requirement_ledger_markdown(ledger)
    lines = rendered.split("\n")
    # Only the known header starts with '#'; a leading '#' in text is escaped.
    assert [ln for ln in lines if ln.startswith("#")] == ["## Requirement Ledger"]
    # No line starts with a bare fence; the hostile ```/~~~ are inside a span.
    assert not any(ln.lstrip().startswith(("```", "~~~")) for ln in lines)
    # Exactly one real bullet; the forged '- (req-deadbeef0000)' is mid-line.
    assert sum(1 for ln in lines if ln.startswith("- (req-")) == 1


# ---------------------------------------------------------------------------
# 8. Fail-soft: malformed input never raises
# ---------------------------------------------------------------------------


def test_extract_never_raises_on_malformed_inputs():
    cases = [
        dict(pr_json="not json at all"),
        dict(pr_json=None),
        dict(pr_json=["a", "list"]),
        dict(pr_json=12345),
        dict(standards_text=""),
        dict(standards_text=None),
        dict(linked_issues_markdown="## r#1\n```json\n{garbage\n```\n"),
        dict(pr_json={"title": 123, "body": None}),
        dict(standards_text="\x00\x01\x1f the system must do X"),
    ]
    for kw in cases:
        ledger = extract_requirement_ledger(**kw)  # must not raise
        assert isinstance(ledger, dict)
        assert ledger["version"] == 1
        assert isinstance(ledger["requirements"], list)
        assert "truncation" in ledger


def test_load_ledger_never_raises_on_malformed_file(tmp_path):
    # Missing file.
    assert load_ledger(str(tmp_path / "nope.json"))["requirements"] == []
    # Not JSON.
    p = tmp_path / "garbage.json"
    p.write_text("this is not json", encoding="utf-8")
    assert load_ledger(str(p))["requirements"] == []
    # JSON, but not a dict.
    p2 = tmp_path / "list.json"
    p2.write_text("[1, 2, 3]", encoding="utf-8")
    assert load_ledger(str(p2))["requirements"] == []
    # requirements is not a list.
    p3 = tmp_path / "badreq.json"
    p3.write_text('{"requirements": "nope"}', encoding="utf-8")
    assert load_ledger(str(p3))["requirements"] == []


def test_render_never_raises_on_malformed_ledger():
    for ledger in [
        None,
        [1, 2],
        {"requirements": "nope"},
        {"requirements": ["not-a-dict", 5, {"text": "ok"}]},
    ]:
        out = render_requirement_ledger_markdown(ledger)  # must not raise
        assert isinstance(out, str)


# ---------------------------------------------------------------------------
# 9. Tolerant loading: sha recomputed, forged ids/kinds repaired
# ---------------------------------------------------------------------------


def test_load_ledger_recomputes_sha_and_repairs_forgeries(tmp_path):
    valid = extract_requirement_ledger(
        standards_text="- The build must produce an artifact\n",
        standards_ref="AGENTS.md",
    )
    p = tmp_path / "ledger.json"
    p.write_text(json.dumps(valid), encoding="utf-8")
    loaded = load_ledger(str(p))
    assert loaded["requirements"] == valid["requirements"]
    assert loaded["sha"] == valid["sha"]  # recomputed, matches

    # Tamper: drop every requirement but keep the old sha.
    tampered = json.loads(json.dumps(valid))
    tampered["requirements"] = []
    p2 = tmp_path / "tampered.json"
    p2.write_text(json.dumps(tampered), encoding="utf-8")
    loaded2 = load_ledger(str(p2))
    assert loaded2["requirements"] == []
    assert loaded2["sha"] != valid["sha"]
    assert loaded2["sha"] == requirement_ledger._compute_sha([])


def test_load_ledger_repairs_forced_ids_and_bad_kinds(tmp_path):
    data = {
        "version": 1,
        "sha": "deadbeef",
        "requirements": [
            {
                "id": "forged",
                "text": "The build must produce an artifact",
                "kind": "weird",
                "verification_required": False,
                "truncated": False,
                "provenance": "nope",
            },
            {"text": "The deploy must run the checks"},
        ],
        "truncation": {"truncated": True, "omitted_requirements": 2},
    }
    p = tmp_path / "forged.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    loaded = load_ledger(str(p))
    reqs = loaded["requirements"]
    assert len(reqs) == 2
    # A forged / missing id is replaced by the content-derived one.
    assert reqs[0]["id"] == _id_of("the build must produce an artifact")
    # An unknown kind defaults to normative.
    assert reqs[0]["kind"] == "normative"
    # The id-less second entry is repaired too.
    assert reqs[1]["id"] == _id_of("the deploy must run the checks")
    # The sha is always recomputed from the surviving entries.
    assert loaded["sha"] == requirement_ledger._compute_sha(reqs)
    assert loaded["truncation"] == {
        "truncated": True,
        "omitted_requirements": 2,
        "omitted_sources": 0,
    }


# ---------------------------------------------------------------------------
# 10. The build CLI
# ---------------------------------------------------------------------------


def test_cli_build_writes_artifact_and_markdown(tmp_path):
    std = tmp_path / "AGENTS.md"
    std.write_text("- The build must produce an artifact\n", encoding="utf-8")
    out = tmp_path / "ledger.json"
    md = tmp_path / "ledger.md"
    rc = main(
        ["build", "--standards", str(std), "--output", str(out), "--markdown", str(md)]
    )
    assert rc == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert len(data["requirements"]) == 1
    # No --standards-ref given: the provenance ref is the standards basename.
    assert data["requirements"][0]["provenance"][0]["ref"] == "AGENTS.md"
    assert md.read_text(encoding="utf-8").startswith("## Requirement Ledger")


def test_cli_build_with_empty_inputs_writes_empty_artifact_and_zero_byte_markdown(tmp_path):
    out = tmp_path / "ledger.json"
    md = tmp_path / "ledger.md"
    rc = main(["build", "--output", str(out), "--markdown", str(md)])
    assert rc == 0
    assert json.loads(out.read_text(encoding="utf-8"))["requirements"] == []
    # An empty extraction renders as a 0-byte file so `[ -s ]` gates work.
    assert md.read_text(encoding="utf-8") == ""
    assert md.stat().st_size == 0


# ---------------------------------------------------------------------------
# 11. Determinism: identical inputs -> identical bytes
# ---------------------------------------------------------------------------


def test_extraction_is_deterministic_identical_bytes():
    md = (
        "## owner/repo#789\n"
        "```json\n"
        "{\"body\": \"- The API must support pagination\"}\n"
        "```\n"
    )
    kwargs = dict(
        pr_json={"title": "t", "body": "- The API must support pagination\n"},
        linked_issues_markdown=md,
        standards_text="- The build must produce an artifact\n",
        standards_ref="AGENTS.md",
    )
    a = extract_requirement_ledger(**kwargs)
    b = extract_requirement_ledger(**kwargs)
    assert a == b
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert a["sha"] == b["sha"]
    assert render_requirement_ledger_markdown(a) == render_requirement_ledger_markdown(b)


def test_sha_is_content_derived():
    a = extract_requirement_ledger(
        standards_text="- The build must produce an artifact\n"
    )
    b = extract_requirement_ledger(
        standards_text="- The build must produce a different artifact\n"
    )
    assert a["sha"] != b["sha"]


# ---------------------------------------------------------------------------
# 11. Source capacity: reserved docs survive, linked issues are bounded
# ---------------------------------------------------------------------------


def _linked_doc(ref: str, text: str) -> str:
    return f"## {ref}\n```json\n{json.dumps({'body': text})}\n```\n"


def _linked_docs(count: int) -> str:
    return "".join(
        _linked_doc(f"owner/repo#{i}", f"- Requirement {i} must hold")
        for i in range(1, count + 1)
    )


def _sources(req):
    return {p["source"] for p in req["provenance"]}


def test_source_capacity_reserves_standards_and_pr_body():
    # MAX_SOURCES + 3 linked-issue docs: the reserved docs (standards, pr body)
    # must survive, and the linked-issue set is bounded to the remaining
    # capacity — the leading docs in document order, with the drop count visible.
    ledger = extract_requirement_ledger(
        pr_json={"title": "t", "body": "- The PR body must be represented\n"},
        linked_issues_markdown=_linked_docs(MAX_SOURCES + 3),
        standards_text="- The standards file must be represented\n",
        standards_ref="AGENTS.md",
    )
    reqs = ledger["requirements"]
    sources = set().union(*(_sources(r) for r in reqs))
    assert {"standards", "pr_body"} <= sources
    linked_refs = {
        p["ref"] for r in reqs for p in r["provenance"] if p["source"] == "linked_issues"
    }
    kept = MAX_SOURCES - 2
    assert len(linked_refs) == kept
    # Document order: the leading docs survive, the trailing ones are dropped.
    assert f"owner/repo#{kept}" in linked_refs
    assert f"owner/repo#{kept + 1}" not in linked_refs
    assert f"owner/repo#{MAX_SOURCES + 3}" not in linked_refs
    assert ledger["truncation"]["omitted_sources"] == 5
    assert ledger["truncation"]["truncated"] is True


def test_source_capacity_exact_reserved_fit_is_not_truncated():
    ledger = extract_requirement_ledger(
        pr_json={"title": "t", "body": "- The PR body must be represented\n"},
        linked_issues_markdown=_linked_docs(MAX_SOURCES - 2),
        standards_text="- The standards file must be represented\n",
        standards_ref="AGENTS.md",
    )
    assert ledger["truncation"]["omitted_sources"] == 0
    assert ledger["truncation"]["truncated"] is False
    sources = set().union(*(_sources(r) for r in ledger["requirements"]))
    assert sources == {"standards", "pr_body", "linked_issues"}


def test_source_capacity_unreserved_budget_goes_to_linked_issues():
    # No reserved docs present: linked issues get the full MAX_SOURCES budget.
    ledger = extract_requirement_ledger(
        linked_issues_markdown=_linked_docs(MAX_SOURCES + 3)
    )
    linked_refs = {
        p["ref"]
        for r in ledger["requirements"]
        for p in r["provenance"]
        if p["source"] == "linked_issues"
    }
    assert len(linked_refs) == MAX_SOURCES
    assert ledger["truncation"]["omitted_sources"] == 3
    assert ledger["truncation"]["truncated"] is True


def test_source_capacity_no_sources_is_clean():
    ledger = extract_requirement_ledger()
    assert ledger["truncation"] == {
        "truncated": False,
        "omitted_requirements": 0,
        "omitted_sources": 0,
    }


def test_oversized_source_set_is_deterministic():
    kwargs = dict(
        pr_json={"title": "t", "body": "- The PR body must be represented\n"},
        linked_issues_markdown=_linked_docs(MAX_SOURCES + 5),
        standards_text="- The standards file must be represented\n",
        standards_ref="AGENTS.md",
    )
    a = extract_requirement_ledger(**kwargs)
    b = extract_requirement_ledger(**kwargs)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def test_load_ledger_round_trips_omitted_sources(tmp_path):
    ledger = extract_requirement_ledger(
        linked_issues_markdown=_linked_docs(MAX_SOURCES + 2)
    )
    path = tmp_path / "requirement-ledger.json"
    path.write_text(json.dumps(ledger), encoding="utf-8")
    loaded = load_ledger(str(path))
    assert loaded["truncation"]["omitted_sources"] == 2


def test_load_ledger_defaults_missing_omitted_sources(tmp_path):
    ledger = extract_requirement_ledger(
        standards_text="- The build must produce an artifact\n"
    )
    del ledger["truncation"]["omitted_sources"]
    path = tmp_path / "requirement-ledger.json"
    path.write_text(json.dumps(ledger), encoding="utf-8")
    loaded = load_ledger(str(path))
    assert loaded["truncation"]["omitted_sources"] == 0
