"""Tests for the maintainer dismissal directive (#534).

The precheck is expected to have already gated on the API permission check
("the permission check, not the text, is what makes this safe"), so the
loader-side contract here is that any dismissal entry lacking a non-empty
``dismissed_by`` actor is silently dropped rather than surfaced as an
unattributed dismiss.
"""

import json
import sys
from pathlib import Path

import pytest

# Ensure the pr_reviewer package is importable when running pytest directly
# from the repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer import carry_forward  # noqa: E402


# ---------------------------------------------------------------------------
# parse_dismiss_directive
# ---------------------------------------------------------------------------


def test_parse_dismiss_directive_dedups_and_drops_garbage():
    body = (
        "@ai-reviewer dismiss P1: stale\n"
        "another line\n"
        "@ai-reviewer dismiss P1: stale\n"
        "garbage line\n"
        "@ai-reviewer dismiss P3 - real reason here\n"
        "@ai-reviewer dismiss Q9: nope\n"
        "@ai-reviewer dismiss P2 — em dash reason\n"
    )
    out = carry_forward.parse_dismiss_directive(body)
    assert out == [
        {"id": "P1", "reason": "stale"},
        {"id": "P3", "reason": "real reason here"},
        {"id": "P2", "reason": "em dash reason"},
    ]


def test_parse_dismiss_directive_drops_whitespace_only_reason():
    """Adversarial fixture: a hyphen-separator with whitespace-only reason
    must be dropped, mirroring the colon-separator branch's behavior
    (PR 252 hostile-delimiter standard)."""
    body = (
        "@ai-reviewer dismiss P5 -\n"
        "@ai-reviewer dismiss P6 -   \n"
        "@ai-reviewer dismiss P7 -   \t  \n"
        "@ai-reviewer dismiss P8 - real\n"
    )
    out = carry_forward.parse_dismiss_directive(body)
    assert out == [{"id": "P8", "reason": "real"}]


def test_parse_dismiss_directive_strips_blockquote_prefix():
    """A directive wrapped in a single Markdown blockquote prefix is
    recognized; two+ levels of quoting remain unsupported and are dropped."""
    body = (
        "> @ai-reviewer dismiss P9: quoted reason\n"
        ">> @ai-reviewer dismiss P10: nested\n"
        "@ai-reviewer dismiss P11: bare\n"
    )
    out = carry_forward.parse_dismiss_directive(body)
    assert out == [
        {"id": "P9", "reason": "quoted reason"},
        {"id": "P11", "reason": "bare"},
    ]


# ---------------------------------------------------------------------------
# load_dismissed_findings
# ---------------------------------------------------------------------------


def _write_dismissals(tmp_path, payload):
    path = tmp_path / "previous-dismissals.json"
    path.write_text(json.dumps(payload))
    return path


def _write_carried(tmp_path, payload):
    path = tmp_path / "previous-findings.json"
    path.write_text(json.dumps(payload))
    return path


def test_load_dismissed_findings_drops_missing_actor(tmp_path):
    """The security premise of #534: a row without a recorded actor must
    not be honored, even if id/category/file match a carried finding."""
    _write_carried(
        tmp_path,
        [
            {
                "id": "P1",
                "severity": "minor",
                "category": "bug",
                "file": "src/x.py",
                "message": "msg1",
            },
            {
                "id": "P2",
                "severity": "minor",
                "category": "bug",
                "file": "src/x.py",
                "message": "msg2",
            },
        ],
    )
    path = _write_dismissals(
        tmp_path,
        [
            {
                "id": "P1",
                "reason": "no actor",
                "category": "bug",
                "file": "src/x.py",
                "dismissed_by": "",
            },
            {
                "id": "P2",
                "reason": "no actor key",
                "category": "bug",
                "file": "src/x.py",
            },
        ],
    )
    out = carry_forward.load_dismissed_findings(
        str(path),
        str(_write_carried(tmp_path, [])),
        workspace_root=tmp_path,
    )
    assert out == []


def test_load_dismissed_findings_anchored_to_carried(tmp_path):
    """A dismissal is honored only when its category and file match the
    carried finding, and the surfaced row preserves the full shape."""
    _write_carried(
        tmp_path,
        [
            {
                "severity": "minor",
                "category": "bug",
                "file": "src/x.py",
                "message": "msg",
            },
        ],
    )
    path = _write_dismissals(
        tmp_path,
        [
            {
                "id": "P1",
                "reason": "misread",
                "category": "bug",
                "file": "src/x.py",
                "dismissed_by": "maintainer",
            },
            {
                "id": "P2",
                "reason": "wrong file",
                "category": "bug",
                "file": "src/y.py",
                "dismissed_by": "maintainer",
            },
        ],
    )
    out = carry_forward.load_dismissed_findings(
        str(path),
        str(tmp_path / "previous-findings.json"),
        workspace_root=tmp_path,
    )
    assert out == [
        {
            "id": "P1",
            "reason": "misread",
            "dismissed_by": "maintainer",
            "severity": "minor",
            "category": "bug",
            "file": "src/x.py",
        }
    ]


def test_load_dismissed_findings_expires_on_category_change(tmp_path):
    _write_carried(
        tmp_path,
        [
            {
                "severity": "minor",
                "category": "style",
                "file": "src/x.py",
                "message": "msg",
            },
        ],
    )
    path = _write_dismissals(
        tmp_path,
        [
            {
                "id": "P1",
                "reason": "old category",
                "category": "bug",
                "file": "src/x.py",
                "dismissed_by": "maintainer",
            },
        ],
    )
    out = carry_forward.load_dismissed_findings(
        str(path),
        str(tmp_path / "previous-findings.json"),
        workspace_root=tmp_path,
    )
    assert out == []


def test_load_dismissed_findings_rejects_path_escape(tmp_path):
    """Mirror assert_safe_artifact_paths / _resolve_workspace_path: a
    dismissals_path that escapes the workspace root is rejected."""
    outside = tmp_path / "outside-dismissals.json"
    outside.write_text("[]")
    out = carry_forward.load_dismissed_findings(
        str(outside),
        str(tmp_path / "previous-findings.json"),
        workspace_root=tmp_path,
    )
    assert out == []


def test_load_dismissed_findings_rejects_symlink_escape(tmp_path):
    """Symlink under workspace_root whose target lies outside it must be
    rejected. Path.resolve() collapses the symlink so is_relative_to drops
    it. Without this fixture, a sibling-file-only test would pass even if
    the resolver ignored symlinks (PR 499 / PR 252 adversarial standard)."""
    outside_dir = tmp_path.parent / "outside-symlink-dir"
    outside_dir.mkdir()
    target = outside_dir / "real-dismissals.json"
    target.write_text("[]")
    link = tmp_path / "previous-dismissals.json"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):  # pragma: no cover — fs-only
        target.unlink(missing_ok=True)
        outside_dir.rmdir()
        pytest.skip("symlinks unsupported on this filesystem")
    try:
        out = carry_forward.load_dismissed_findings(
            "previous-dismissals.json",
            "previous-findings.json",
            workspace_root=tmp_path,
        )
        assert out == []
    finally:
        link.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        outside_dir.rmdir()


def test_load_dismissed_findings_rejects_embedded_null_byte(tmp_path):
    """Embedded null byte in the dismissals_path string must drop the
    file (PR 499 / PR 252 boundary-token fixture for the loader's null-
    byte check)."""
    dismissals = tmp_path / "previous-dismissals.json"
    dismissals.write_text("[]")
    carried = tmp_path / "previous-findings.json"
    carried.write_text("[]")
    out = carry_forward.load_dismissed_findings(
        "previous-dismissals\x00.json",
        "previous-findings.json",
        workspace_root=tmp_path,
    )
    assert out == []


# ---------------------------------------------------------------------------
# apply_carry_forward (integration via file paths)
# ---------------------------------------------------------------------------


def test_apply_carry_forward_treats_dismissed_as_closed(tmp_path):
    carried = [
        {
            "id": "P1",
            "severity": "blocker",
            "category": "bug",
            "file": "src/x.py",
            "message": "leak",
        },
    ]
    _write_carried(tmp_path, carried)
    _write_dismissals(
        tmp_path,
        [
            {
                "id": "P1",
                "reason": "misread",
                "category": "bug",
                "file": "src/x.py",
                "dismissed_by": "maintainer",
            },
        ],
    )
    output = tmp_path / "ai-output.json"
    output.write_text(
        json.dumps(
            {
                "review_markdown": "",
                "verdict": "approve",
                "findings": [],
            }
        )
    )

    summary = carry_forward.apply_carry_forward(
        carried_path=str(tmp_path / "previous-findings.json"),
        output_path=str(output),
        dismissals_path=str(tmp_path / "previous-dismissals.json"),
        workspace_root=tmp_path,
    )
    assert summary["dismissed"] == 1
    assert summary["open"] == 0
    assert summary["resolved"] == 0
    assert summary["forced_request_changes"] is False

    written = json.loads(output.read_text())
    assert "Dismissed by a maintainer" in written["review_markdown"]
    assert "P1" in written["review_markdown"]
    assert written["verdict"] == "approve"


def test_apply_carry_forward_mixed_resolution_dismiss_open(tmp_path):
    """Lock in body ordering and verdict policy when one carried finding is
    resolved, one is dismissed, and one remains open."""
    _write_carried(
        tmp_path,
        [
            {"severity": "minor", "category": "style", "file": "a.py", "message": "m1"},
            {"severity": "minor", "category": "bug", "file": "src/m.py", "message": "m2"},
            {"severity": "minor", "category": "bug", "file": "src/n.py", "message": "m3"},
        ],
    )
    _write_dismissals(
        tmp_path,
        [
            {
                "id": "P2",
                "reason": "false positive",
                "category": "bug",
                "file": "src/m.py",
                "dismissed_by": "maintainer",
            },
        ],
    )
    output = tmp_path / "ai-output.json"
    output.write_text(
        json.dumps(
            {
                "review_markdown": "",
                "verdict": "approve",
                "findings": [{"id": "P1", "resolution": "resolved"}],
            }
        )
    )

    carry_forward.apply_carry_forward(
        carried_path=str(tmp_path / "previous-findings.json"),
        output_path=str(output),
        dismissals_path=str(tmp_path / "previous-dismissals.json"),
        workspace_root=tmp_path,
    )
    written = json.loads(output.read_text())
    body = written["review_markdown"]
    # Ordering: resolved section, dismissed section, then still-open section.
    assert body.index("Resolved by this push") < body.index("Dismissed by a maintainer")
    assert body.index("Dismissed by a maintainer") < body.index("Still open (carried forward)")
    # Dismissed finding must NOT appear under "Still open".
    assert "P2" not in body[body.index("Still open (carried forward)"):]
    # Verdict stays approve (no blocker among open_items).
    assert written["verdict"] == "approve"
