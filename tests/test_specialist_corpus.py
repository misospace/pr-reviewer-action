#!/usr/bin/env python3
"""Regression coverage for the #632 independent specialist corpus.

Covers the hard byte cap, deterministic survival priority, UTF-8 safety,
determinism, fail-soft reads, the CLI writer, and the guarantee that the final
review corpus is never consumed by the specialist builder.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
for _p in (str(_REPO_ROOT), str(_REPO_ROOT / "scripts")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402

from pr_reviewer import specialist_corpus  # noqa: E402


def _write(root: Path, name: str, text: str) -> None:
    (root / name).write_text(text, encoding="utf-8")


_FENCE_RE = re.compile(r"^(`{3,})(.*)$")


def _unclosed_fence(text: str) -> str | None:
    """CommonMark-ish fence tracker: return the still-open fence, or None.

    A bare backtick line (no info string) closes the open fence; an
    info-bearing line (``​```json``) can only open one, never close.
    """
    opener: str | None = None
    for line in text.split("\n"):
        match = _FENCE_RE.match(line)
        if not match:
            continue
        ticks, info = match.group(1), match.group(2).strip()
        if opener is None:
            opener = ticks
        elif info == "" and len(ticks) >= len(opener):
            opener = None
    return opener


def _headers_inside_fence(text: str, headers: tuple[str, ...]) -> dict[str, bool]:
    """Whether each header line appears while a code fence is still open."""
    opener: str | None = None
    result = {h: False for h in headers}
    for line in text.split("\n"):
        match = _FENCE_RE.match(line)
        if match:
            ticks, info = match.group(1), match.group(2).strip()
            if opener is None:
                opener = ticks
            elif info == "" and len(ticks) >= len(opener):
                opener = None
            continue
        if line in result and opener is not None:
            result[line] = True
    return result


def _write_minimal(root: Path) -> None:
    _write(
        root,
        "pr.json",
        json.dumps(
            {
                "number": 7,
                "title": "METADATA_MARKER: add thing",
                "author": {"login": "dev"},
                "baseRefName": "main",
                "headRefName": "feat/x",
                "headRefOid": "abc",
                "changedFiles": 2,
                "additions": 5,
                "deletions": 1,
                "url": "u",
                "body": "BODY_MARKER",
            }
        ),
    )
    _write(
        root,
        "classification.json",
        json.dumps(
            {
                "pr_kind": "app_code",
                "risk_flags": ["CLASSIFICATION_MARKER"],
                "risk_flags_with_files": {},
                "changed_files_summary": [],
                "linked_issue_labels": [],
                "must_check": ["MUST_CHECK_MARKER"],
            }
        ),
    )
    _write(
        root,
        "pr-files.truncated.json",
        json.dumps([{"filename": "CHANGED_FILE_MARKER.py", "status": "modified"}]),
    )
    _write(root, "pr.diff.truncated", "DIFF_MARKER line\n")
    _write(root, "standards-context.capped.md", "STANDARDS_MARKER\n")
    _write(root, "requirement-ledger.md", "LEDGER_MARKER\n")
    _write(root, "related-code.truncated.md", "RELATED_MARKER\n")
    _write(root, "evidence-providers.md", "EVIDENCE_MARKER\n")


# ── 1. independent hard byte cap ───────────────────────────────────


@pytest.mark.parametrize("cap", [1, 10, 512, 4096, 48000])
def test_hard_byte_cap_never_exceeded(tmp_path, cap):
    _write_minimal(tmp_path)
    # Inflate every artifact well past the cap.
    _write(tmp_path, "pr.diff.truncated", "x" * 400000)
    _write(tmp_path, "standards-context.capped.md", "s" * 400000)
    _write(tmp_path, "related-code.truncated.md", "r" * 400000)
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=cap)
    assert len(text.encode("utf-8")) <= cap
    assert meta["bytes"] <= cap
    assert meta["max_bytes"] == cap


# ── 2. large artifacts -> materially smaller bounded corpus ────────


def test_large_artifacts_produce_materially_smaller_bounded_corpus(tmp_path):
    _write_minimal(tmp_path)
    _write(tmp_path, "pr.diff.truncated", "d" * 300000)
    _write(tmp_path, "pr-files.truncated.json", "[" + ",".join(
        json.dumps({"filename": f"f{i}.py", "status": "modified"}) for i in range(5000)
    ) + "]")
    _write(tmp_path, "related-code.truncated.md", "r" * 300000)

    text, meta = specialist_corpus.build_specialist_corpus(
        tmp_path, max_bytes=specialist_corpus.DEFAULT_SPECIALIST_CORPUS_MAX_BYTES
    )
    assert len(text.encode("utf-8")) <= specialist_corpus.DEFAULT_SPECIALIST_CORPUS_MAX_BYTES
    # Materially smaller than a normal-mode final review corpus budget.
    assert specialist_corpus.DEFAULT_SPECIALIST_CORPUS_MAX_BYTES < 220000
    assert meta["truncated"] is True


# ── 3. deterministic survival priority ─────────────────────────────


def test_high_signal_survive_and_low_signal_dropped(tmp_path):
    _write_minimal(tmp_path)
    _write(tmp_path, "pr.diff.truncated", "DIFF_MARKER " + "d" * 40000)
    _write(tmp_path, "standards-context.capped.md", "STANDARDS_MARKER " + "s" * 40000)
    _write(tmp_path, "related-code.truncated.md", "RELATED_MARKER " + "r" * 40000)
    _write(tmp_path, "evidence-providers.md", "EVIDENCE_MARKER " + "e" * 40000)

    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=20000)

    # Highest-priority sections are present...
    for marker in ("METADATA_MARKER", "CLASSIFICATION_MARKER", "CHANGED_FILE_MARKER"):
        assert marker in text
    # ...and the lowest-priority sections are omitted entirely under pressure.
    assert "EVIDENCE_MARKER" not in text
    assert "evidence_ci" in meta["omitted_sections"] or meta["truncated"]
    assert len(text.encode("utf-8")) <= 20000


def test_section_order_is_the_documented_priority():
    names = [spec[0] for spec in specialist_corpus._SECTIONS]
    assert names == [
        "pr_metadata",
        "classification",
        "changed_files",
        "pr_diff",
        "standards",
        "requirement_ledger",
        "related_code",
        "evidence_ci",
    ]


def test_all_sections_included_when_budget_is_generous(tmp_path):
    _write_minimal(tmp_path)
    _, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=48000)
    assert meta["included_sections"] == [
        "pr_metadata",
        "classification",
        "changed_files",
        "pr_diff",
        "standards",
        "requirement_ledger",
        "related_code",
        "evidence_ci",
    ]
    assert meta["omitted_sections"] == []


def test_standards_carry_an_explicit_section_cap(tmp_path):
    _write_minimal(tmp_path)
    _write(tmp_path, "standards-context.capped.md", "S" * 40000)
    # First build to discover where standards sits with everything else small.
    _write(tmp_path, "pr-files.truncated.json", "[]")
    _write(tmp_path, "pr.diff.truncated", "")
    _write(tmp_path, "requirement-ledger.md", "")
    _write(tmp_path, "related-code.truncated.md", "")
    _write(tmp_path, "evidence-providers.md", "")
    _, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=48000)
    assert "standards" in meta["included_sections"]
    assert meta["truncated"] is True


# ── 4. trust framing + no final corpus coupling ────────────────────


def test_trust_framing_always_present(tmp_path):
    _write_minimal(tmp_path)
    text, _ = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=48000)
    assert text.startswith(specialist_corpus.SPECIALIST_CORPUS_FRAMING)
    assert "UNTRUSTED" in text


def test_final_review_corpus_is_never_consumed(tmp_path):
    _write_minimal(tmp_path)
    _write(tmp_path, "review-corpus.truncated.md", "FINAL_CORPUS_MARKER\n")
    text, _ = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=48000)
    assert "FINAL_CORPUS_MARKER" not in text


# ── 5. UTF-8 safety + determinism ──────────────────────────────────


def test_utf8_safe_truncation(tmp_path):
    _write_minimal(tmp_path)
    _write(tmp_path, "pr.diff.truncated", "é" * 5000)  # 2 bytes each
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=1000)
    assert len(text.encode("utf-8")) <= 1000
    # Decodes cleanly (no split multibyte replacement at the boundary).
    assert "\ufffd" not in text


def test_deterministic_across_builds(tmp_path):
    _write_minimal(tmp_path)
    _write(tmp_path, "pr.diff.truncated", "d" * 40000)
    first, meta1 = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=9000)
    second, meta2 = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=9000)
    assert first == second
    assert meta1 == meta2


# ── 6. fail-soft reads ─────────────────────────────────────────────


def test_missing_artifacts_fail_soft(tmp_path):
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=4096)
    assert text.startswith(specialist_corpus.SPECIALIST_CORPUS_FRAMING)
    assert meta["included_sections"] == []
    assert meta["omitted_sections"] == []


def test_malformed_json_artifacts_fail_soft(tmp_path):
    _write(tmp_path, "pr.json", "{not json")
    _write(tmp_path, "classification.json", "also not json")
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=4096)
    assert "pr_metadata" not in meta["included_sections"]
    assert "classification" not in meta["included_sections"]


def test_symlinked_artifact_is_ignored(tmp_path):
    outside = tmp_path.parent / "outside-secret.txt"
    outside.write_text("SYMLINK_SECRET_MARKER", encoding="utf-8")
    (tmp_path / "pr.json").symlink_to(outside)
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=4096)
    assert "SYMLINK_SECRET_MARKER" not in text
    assert "pr_metadata" not in meta["included_sections"]


def test_changed_files_truncated_json_kept_as_text(tmp_path):
    _write(tmp_path, "pr-files.truncated.json", "[{\"filename\": \"a.py\"")
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=4096)
    assert "changed_files" in meta["included_sections"]
    assert "a.py" in text


# ── 7. CLI writer ──────────────────────────────────────────────────


def test_cli_writes_file_and_reports(tmp_path, capsys):
    _write_minimal(tmp_path)
    rc = specialist_corpus.main(
        ["--workspace", str(tmp_path), "--output", "specialist-corpus.md", "--max-bytes", "4096"]
    )
    assert rc == 0
    out = (tmp_path / "specialist-corpus.md").read_text(encoding="utf-8")
    assert "METADATA_MARKER" in out
    assert len(out.encode("utf-8")) <= 4096
    assert "specialist corpus:" in capsys.readouterr().out


def test_cli_env_default_cap(tmp_path, monkeypatch):
    _write_minimal(tmp_path)
    monkeypatch.setenv("DEEP_REVIEW_CORPUS_MAX_BYTES", "2048")
    rc = specialist_corpus.main(["--workspace", str(tmp_path), "--output", "out.md"])
    assert rc == 0
    assert len((tmp_path / "out.md").read_bytes()) <= 2048


def test_cli_refuses_symlink_output(tmp_path):
    outside = tmp_path.parent / "outside.md"
    outside.write_text("sentinel", encoding="utf-8")
    (tmp_path / "specialist-corpus.md").symlink_to(outside)
    rc = specialist_corpus.main(["--workspace", str(tmp_path), "--output", "specialist-corpus.md"])
    assert rc == 1
    assert outside.read_text(encoding="utf-8") == "sentinel"


# ── 8. evidence/CI + wrapper module ───────────────────────────────


def test_ci_checks_file_is_included_when_present(tmp_path, monkeypatch):
    _write_minimal(tmp_path)
    ci = tmp_path / "ci-checks-context.md"
    ci.write_text("CI_MARKER all checks passed\n", encoding="utf-8")
    monkeypatch.setenv("CI_CHECKS_FILE", str(ci))
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=48000)
    assert "CI_MARKER" in text
    assert "evidence_ci" in meta["included_sections"]


def test_ci_checks_file_missing_is_fail_soft(tmp_path, monkeypatch):
    _write_minimal(tmp_path)
    monkeypatch.setenv("CI_CHECKS_FILE", str(tmp_path / "nope.md"))
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=48000)
    assert "evidence_ci" in meta["included_sections"]  # evidence-providers.md only


def test_wrapper_module_delegates(tmp_path, monkeypatch, capsys):
    import importlib  # noqa: PLC0415

    wrapper = importlib.import_module("build_specialist_corpus")
    _write_minimal(tmp_path)
    rc = wrapper.main(
        ["--workspace", str(tmp_path), "--output", "wrapper-out.md", "--max-bytes", "4096"]
    )
    assert rc == 0
    assert "METADATA_MARKER" in (tmp_path / "wrapper-out.md").read_text(encoding="utf-8")


# ── 9. degenerate caps ─────────────────────────────────────────────


def test_truncate_utf8_nonpositive():
    assert specialist_corpus._truncate_utf8("abc", 0) == ("", True)


def test_zero_cap_is_framing_only(tmp_path):
    _write_minimal(tmp_path)
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=0)
    assert len(text.encode("utf-8")) <= 1
    assert meta["included_sections"] == []


def test_section_dropped_when_marker_cannot_fit(tmp_path):
    # Framing is 350 bytes; a 380-byte cap leaves 30 for the first section,
    # less than the truncation marker, so the section is dropped whole.
    _write_minimal(tmp_path)
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=380)
    assert "pr_metadata" in meta["omitted_sections"]
    assert "METADATA_MARKER" not in text
    assert len(text.encode("utf-8")) <= 380


# ── 10. #632 review-fix: the requirement ledger is RESERVED ────────


def test_near_max_requirement_ledger_survives_large_bulk(tmp_path):
    """A maximum-size explicit requirement ledger survives intact under the
    default 48 KB cap even beside large changed-files/diff/standards inputs.

    Regression for the review feedback on #652: the ledger used to be filled
    after the bulk sections, so a near-8 KB ledger was clipped to whatever was
    left (~3.6 KB). It is now reserved out of the budget before the general
    fill, mirroring the final review corpus.
    """
    from pr_reviewer.requirement_ledger import MAX_LEDGER_MARKDOWN_BYTES  # noqa: PLC0415

    _write_minimal(tmp_path)
    start = "LEDGER_START_MARKER\n"
    end = "LEDGER_END_MARKER\n"
    filler = "x" * (MAX_LEDGER_MARKDOWN_BYTES - len(start) - len(end))
    ledger = start + filler + end
    assert len(ledger.encode("utf-8")) == MAX_LEDGER_MARKDOWN_BYTES
    _write(tmp_path, "requirement-ledger.md", ledger)

    # Bulk material near the per-section caps, reproducing the review's
    # worst case where the sections before the ledger consume ~42 KB.
    _write(
        tmp_path,
        "pr.json",
        json.dumps(
            {
                "number": 1,
                "title": "t",
                "author": {"login": "dev"},
                "body": "b" * 4000,
            }
        ),
    )
    _write(
        tmp_path,
        "classification.json",
        json.dumps(
            {
                "pr_kind": "app_code",
                "risk_flags": [f"flag-{i}" for i in range(3000)],
                "risk_flags_with_files": {f"flag-{i}": ["a.py"] for i in range(3000)},
                "must_check": [f"check-{i}" for i in range(3000)],
            }
        ),
    )
    _write(
        tmp_path,
        "pr-files.truncated.json",
        "[" + ",".join(
            json.dumps({"filename": f"f{i}.py", "status": "modified"})
            for i in range(8000)
        ) + "]",
    )
    _write(tmp_path, "pr.diff.truncated", "d" * 200000)
    _write(tmp_path, "standards-context.capped.md", "s" * 100000)

    cap = specialist_corpus.DEFAULT_SPECIALIST_CORPUS_MAX_BYTES
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=cap)

    assert "requirement_ledger" in meta["included_sections"]
    # Both ends present, and the exact ledger bytes survive (not just the head).
    assert "LEDGER_START_MARKER" in text
    assert "LEDGER_END_MARKER" in text
    assert ledger in text
    assert meta["truncated"] is True  # bulk sections were truncated/omitted
    assert meta["bytes"] <= cap

    # Structure: the oversized fenced bodies (classification / changed-files /
    # diff) were truncated, so their fences must have been restored; no code
    # block is left open over the standards/ledger that follow.
    for section in ("classification", "changed_files", "pr_diff"):
        assert section in meta["included_sections"]
    assert _unclosed_fence(text) is None
    headers = (
        "# Repository Standards and Conventions",
        "# Explicit Requirement Ledger",
    )
    assert _headers_inside_fence(text, headers) == {h: False for h in headers}


def test_truncated_fenced_bodies_are_structurally_closed(tmp_path):
    """Oversized classification, changed-files, and diff bodies (no ledger):
    every opened fence is closed and the standards header stays outside it."""
    _write_minimal(tmp_path)
    _write(
        tmp_path,
        "classification.json",
        json.dumps(
            {
                "pr_kind": "app_code",
                "risk_flags": [f"flag-{i}" for i in range(3000)],
                "risk_flags_with_files": {f"flag-{i}": ["a.py"] for i in range(3000)},
                "must_check": [f"check-{i}" for i in range(3000)],
            }
        ),
    )
    _write(
        tmp_path,
        "pr-files.truncated.json",
        "[" + ",".join(
            json.dumps({"filename": f"f{i}.py", "status": "modified"})
            for i in range(8000)
        ) + "]",
    )
    _write(tmp_path, "pr.diff.truncated", "d" * 200000)
    _write(tmp_path, "standards-context.capped.md", "s" * 100000)

    cap = specialist_corpus.DEFAULT_SPECIALIST_CORPUS_MAX_BYTES
    text, meta = specialist_corpus.build_specialist_corpus(tmp_path, max_bytes=cap)

    # Each fenced body that was clipped emits a closing fence before its marker.
    assert text.count("```json") >= 3  # metadata + classification + changed
    assert text.count("```diff") >= 1
    assert _unclosed_fence(text) is None
    assert (
        _headers_inside_fence(
            text, ("# Repository Standards and Conventions",)
        )["# Repository Standards and Conventions"]
        is False
    )
    assert meta["bytes"] <= cap


def test_requirement_ledger_reserved_cap_matches_renderer_cap():
    # The wrapper cap must leave room for the renderer's maximum ledger body
    # plus section framing, or a max-size ledger would be clipped by the
    # wrapper even though it is reserved.
    from pr_reviewer.requirement_ledger import MAX_LEDGER_MARKDOWN_BYTES  # noqa: PLC0415

    header = "# Explicit Requirement Ledger\n\n"
    assert (
        specialist_corpus._SECTION_CAP_REQUIREMENT_LEDGER
        >= len(header.encode("utf-8")) + MAX_LEDGER_MARKDOWN_BYTES + 1
    )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
