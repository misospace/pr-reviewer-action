"""Tests for the aggregate "Specialist Review Leads" corpus section (#609).

Covers the behaviour contract of
:func:`pr_reviewer.specialists.render_specialist_leads_section`:

- fixed role heading order (``correctness`` → ``security`` → ``tests``),
  independent of the input mapping's key order;
- zero usable leads across all roles → ``""`` (not even role-failure notes,
  even when roles carry pass-level errors);
- a missing role (``None``) and a failed role render as a single concise,
  count-only unavailable note (never a raw error string);
- a hard UTF-8 byte cap on the whole document — title + framing + role
  blocks + omission footer all counted — holding exactly at tight caps;
- truncation in **whole leads only** (never a partial line), dropping the
  last lead of the last role that still has leads (reverse fixed order);
- a deterministic omission footer with a correct count at several caps;
- control-character escaping and backtick-fence hygiene: a hostile message
  carrying `````markdown``, a forged ``# heading``, and a raw bell char
  cannot forge a line-leading heading or leave an unbalanced fence;
- secret redaction: a ``ghp_``-shaped token in a message is masked by the
  shared :func:`redact.mask_secrets` helper (original substring absent);
- a cap smaller than the framing paragraph drops the whole section;
- determinism: identical input → byte-identical output, on every call.

Hermetic: no network, no model, no commands — the renderer only parses
in-memory values.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))

from pr_reviewer.specialists import (
    SPECIALIST_LEADS_FRAMING,
    SPECIALIST_LEADS_TITLE,
    SPECIALIST_ROLES_ORDER,
    _lead_line,
    normalize_specialist_output,
    render_specialist_leads_section,
)

LARGE_CAP = 1_000_000


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _ok(role: str, leads: list[dict]) -> dict:
    """A normalized version-1 artifact with the given leads and no errors."""
    return normalize_specialist_output({"role": role, "leads": leads}, role=role)


def _failed(role: str, n_errors: int = 1) -> dict:
    """A role whose pass produced pass-level errors and no usable leads."""
    artifact = _ok(role, [])
    for _ in range(n_errors):
        artifact["errors"].append("malformed JSON: no decodable lead object found")
    return artifact


def _tiny_results() -> dict:
    """Six small leads: 3 correctness, 2 security, 1 tests."""
    return {
        "correctness": _ok(
            "correctness", [{"message": f"lead c{i}"} for i in range(3)]
        ),
        "security": _ok("security", [{"message": f"lead s{i}"} for i in range(2)]),
        "tests": _ok("tests", [{"message": "lead t0"}]),
    }


def _uncapped(results: dict) -> str:
    return render_specialist_leads_section(results, max_bytes=LARGE_CAP)


def _byte_len(text: str) -> int:
    return len(text.encode("utf-8"))


def _lead_lines_of(results: dict) -> set[str]:
    """The complete lead line for every lead, as the renderer emits it."""
    lines: set[str] = set()
    for role in SPECIALIST_ROLES_ORDER:
        artifact = results.get(role)
        if isinstance(artifact, dict) and isinstance(artifact.get("leads"), list):
            for lead in artifact["leads"]:
                lines.add(_lead_line(lead))
    return lines


# ---------------------------------------------------------------------------
# Title, framing, and fixed role heading order
# ---------------------------------------------------------------------------


def test_title_constant_is_the_exact_heading():
    assert SPECIALIST_LEADS_TITLE == "Specialist Review Leads"
    assert "They are not findings" in SPECIALIST_LEADS_FRAMING
    # The framing is the exact advisory paragraph from the contract.
    assert SPECIALIST_LEADS_FRAMING == (
        "These are unverified advisory leads from independent specialist "
        "passes. They are not findings or proof. Verify each relevant claim "
        "against the PR/repository evidence before using it in the final "
        "review."
    )


def test_section_starts_with_title_and_framing():
    out = _uncapped(_tiny_results())
    assert out.startswith(
        f"# {SPECIALIST_LEADS_TITLE}\n\n{SPECIALIST_LEADS_FRAMING}\n\n"
    )


def test_role_headings_appear_in_fixed_order():
    # Input mapping deliberately keyed in REVERSE fixed order.
    base = _tiny_results()
    results = {
        "tests": base["tests"],
        "security": base["security"],
        "correctness": base["correctness"],
    }
    out = _uncapped(results)
    assert (
        out.index("## Correctness")
        < out.index("## Security")
        < out.index("## Tests")
    )
    for heading in ("## Correctness", "## Security", "## Tests"):
        assert out.count(heading) == 1


# ---------------------------------------------------------------------------
# Zero usable leads / missing and failed roles
# ---------------------------------------------------------------------------


def test_zero_usable_leads_returns_empty_even_with_errors():
    results = {
        "correctness": _failed("correctness", 2),
        "security": None,
        "tests": _ok("tests", []),
    }
    assert render_specialist_leads_section(results, max_bytes=10_000) == ""


def test_all_roles_without_leads_returns_empty():
    results = {
        "correctness": _ok("correctness", []),
        "security": _ok("security", []),
        "tests": _ok("tests", []),
    }
    assert render_specialist_leads_section(results, max_bytes=10_000) == ""


def test_missing_role_renders_unavailable_note():
    results = {
        "correctness": _ok("correctness", [{"message": "c1"}]),
        "security": None,
        "tests": _failed("tests", 1),
    }
    out = _uncapped(results)
    # Every fixed role heading appears, including the unavailable role's.
    for heading in ("## Correctness", "## Security", "## Tests"):
        assert heading in out
    # None → no errors → the plain no-leads note.
    assert "- no advisory leads" in out
    # Failed role → the count-only note.
    assert "- advisory pass reported no leads (1 pass-level error(s))" in out
    # Deterministic notes: the raw error string must not appear.
    assert "malformed JSON" not in out


def test_role_with_errors_and_no_leads_reports_the_count():
    results = {
        "correctness": _ok("correctness", [{"message": "c1"}]),
        "security": _failed("security", 3),
        "tests": _ok("tests", []),
    }
    out = _uncapped(results)
    assert "- advisory pass reported no leads (3 pass-level error(s))" in out
    assert "malformed JSON" not in out


# ---------------------------------------------------------------------------
# Hard UTF-8 byte cap
# ---------------------------------------------------------------------------


def test_byte_cap_holds_exactly_across_tight_caps():
    results = _tiny_results()
    size = _byte_len(_uncapped(results))
    for cap in (size - 1, size - 12, size - 25, size - 40, size - 80):
        out = render_specialist_leads_section(results, max_bytes=cap)
        # The hard cap: the whole document's UTF-8 byte length.
        assert _byte_len(out) <= cap, cap
        # The cap is on UTF-8 bytes: the document is valid, unsplit UTF-8.
        out.encode("utf-8").decode("utf-8")


def test_byte_cap_includes_header_framing_and_footer():
    results = _tiny_results()
    size = _byte_len(_uncapped(results))
    seen_footer = False
    for cap in range(size - 1, size - 120, -1):
        out = render_specialist_leads_section(results, max_bytes=cap)
        assert _byte_len(out) <= cap, cap
        if not out:
            break
        # The title + framing are part of the capped document: they survive
        # intact at the front of every non-empty output.
        assert out.startswith(
            f"# {SPECIALIST_LEADS_TITLE}\n\n{SPECIALIST_LEADS_FRAMING}"
        ), cap
        m = re.search(r"… (\d+) lead\(s\) omitted \(byte cap\)", out)
        if m:
            seen_footer = True
            # The footer is inside the cap, at the end of the document.
            assert out.endswith(
                f"\n… {m.group(1)} lead(s) omitted (byte cap)\n"
            ), cap
    assert seen_footer


def test_uncapped_document_has_no_omission_footer():
    out = _uncapped(_tiny_results())
    assert "omitted (byte cap)" not in out
    # All six leads are present.
    assert len([ln for ln in out.splitlines() if ln.startswith("- [")]) == 6


def test_cap_smaller_than_framing_drops_the_section():
    results = _tiny_results()
    tiny = len(SPECIALIST_LEADS_FRAMING.encode("utf-8")) // 2
    assert render_specialist_leads_section(results, max_bytes=tiny) == ""


# ---------------------------------------------------------------------------
# Whole-lead granularity + omission footer count
# ---------------------------------------------------------------------------


def test_only_whole_leads_survive_truncation():
    results = _tiny_results()
    complete_lines = _lead_lines_of(results)
    size = _byte_len(_uncapped(results))
    for cap in (size - 1, size - 15, size - 30, size - 60, size - 100):
        out = render_specialist_leads_section(results, max_bytes=cap)
        for line in out.splitlines():
            if line.startswith("- ["):
                # Every surviving bullet is a COMPLETE lead line, never a
                # mid-message cut.
                assert line in complete_lines, (cap, line)


def test_omission_footer_count_is_consistent_at_several_caps():
    results = _tiny_results()
    total = 6
    size = _byte_len(_uncapped(results))
    for cap in (size - 1, size - 12, size - 30, size - 60, size - 90, size - 120):
        out = render_specialist_leads_section(results, max_bytes=cap)
        # A cap that cannot fit even the framing (or that truncation reduced to
        # a lead-less shell) drops the WHOLE section ("") — nothing to check.
        if not out:
            continue
        bullets = [ln for ln in out.splitlines() if ln.startswith("- [")]
        m = re.search(r"… (\d+) lead\(s\) omitted \(byte cap\)", out)
        if m:
            omitted = int(m.group(1))
            assert omitted > 0, cap
            # Footer count + surviving bullets = the original lead count.
            assert len(bullets) == total - omitted, cap
        else:
            assert len(bullets) == total, cap


# ---------------------------------------------------------------------------
# Fence / control-character hygiene on hostile messages
# ---------------------------------------------------------------------------


def test_hostile_message_cannot_forge_heading_or_unbalance_fence():
    hostile = "```markdown\n# forged heading\x07bell"
    results = {
        "correctness": _ok(
            "correctness", [{"message": hostile, "severity": "major"}]
        ),
        "security": _ok("security", [{"message": "s1"}]),
        "tests": _ok("tests", [{"message": "t1"}]),
    }
    out = _uncapped(results)
    lines = out.splitlines()
    # No line starts with "# " outside the known title line: a forged
    # heading stays escaped inside its bullet, never line-leading.
    assert [ln for ln in lines if ln.startswith("# ")] == [
        f"# {SPECIALIST_LEADS_TITLE}"
    ]
    # The bell control char is escaped; no raw control byte survives.
    assert "\\u0007" in out
    assert "\x07" not in out
    # The raw newline inside the message is escaped, so the bullet is ONE
    # line carrying the escaped form.
    assert "```markdown\\n# forged heading\\u0007bell" in out
    # Fences are balanced: walk the lines, toggling on each all-backtick
    # line; the document must end outside a fence.
    in_fence = False
    for ln in lines:
        stripped = ln.strip()
        if not stripped:
            continue
        # Is this a fence delimiter? A run of 3+ backticks, optionally
        # followed by an info string (no backticks inside it).
        run = 0
        while run < len(stripped) and stripped[run] == "`":
            run += 1
        if run >= 3 and "`" not in stripped[run:]:
            in_fence = not in_fence
    assert not in_fence


# ---------------------------------------------------------------------------
# Secret redaction
# ---------------------------------------------------------------------------


def test_secret_looking_message_is_redacted():
    # ghp_ + 36 alphanumerics: the fake PAT the redaction helper must catch.
    secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz"
    assert len(secret) == 40
    results = {
        "correctness": _ok("correctness", [{"message": f"leak: {secret}"}]),
        "security": _ok("security", [{"message": "s1"}]),
        "tests": _ok("tests", [{"message": "t1"}]),
    }
    out = _uncapped(results)
    # The original secret substring is absent from the rendered document.
    assert secret not in out
    # The shared redaction placeholder is present instead.
    assert "[REDACTED]" in out


def test_secret_looking_file_is_redacted():
    # file is specialist-model-controlled text rendered into the corpus inside
    # _lead_line's path span; a credential-like segment there must not survive
    # verbatim (#609 review follow-up).
    secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz"
    results = {
        "correctness": _ok(
            "correctness",
            [{"message": "c1", "file": f"src/{secret}.py", "line": 5}],
        ),
        "security": _ok("security", [{"message": "s1"}]),
        "tests": _ok("tests", [{"message": "t1"}]),
    }
    out = _uncapped(results)
    assert secret not in out
    assert "[REDACTED]" in out


def test_secret_looking_category_is_redacted():
    # category is likewise model-controlled text rendered as the bullet's
    # trailing "(category)" suffix; redact it the same way.
    secret = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"
    results = {
        "correctness": _ok(
            "correctness", [{"message": "c1", "category": f"leak-{secret}"}]
        ),
        "security": _ok("security", [{"message": "s1"}]),
        "tests": _ok("tests", [{"message": "t1"}]),
    }
    out = _uncapped(results)
    assert secret not in out
    assert "[REDACTED]" in out


def test_secrets_in_message_file_and_category_all_redacted():
    msg_secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvWxYz"
    file_secret = "AKIA" + "ABCDEFGHIJKLMN1234"
    cat_secret = "ghp_" + "QwErTyUiOpAsDfGhJkLzXcVbNmKjHgFeDc"
    results = {
        "correctness": _ok(
            "correctness",
            [
                {
                    "message": f"note {msg_secret}",
                    "file": f"lib/{file_secret}/handler.py",
                    "category": f"security-{cat_secret}",
                    "line": 7,
                }
            ],
        ),
        "security": _ok("security", [{"message": "s1"}]),
        "tests": _ok("tests", [{"message": "t1"}]),
    }
    out = _uncapped(results)
    for secret in (msg_secret, file_secret, cat_secret):
        assert secret not in out, secret
    assert "[REDACTED]" in out


# ---------------------------------------------------------------------------
# Byte-cap truncation must never emit a lead-less "shell" section
# ---------------------------------------------------------------------------


def test_truncation_to_shell_only_returns_empty():
    # Three leads with deliberately long messages so the header + framing +
    # role headings + omission-footer shell is much smaller than the shell
    # plus even ONE lead. A cap sized into that gap can fit the shell but no
    # complete lead: such a document advertises "N lead(s) omitted" while
    # containing no lead, so it must be dropped entirely ("").
    results = {
        "correctness": _ok("correctness", [{"message": "x" * 300}]),
        "security": _ok("security", [{"message": "y" * 300}]),
        "tests": _ok("tests", [{"message": "z" * 300}]),
    }
    shell_floor = _byte_len(SPECIALIST_LEADS_FRAMING)
    # A cap well above the framing but far below shell + one 300-char lead.
    cap = shell_floor + 100
    assert render_specialist_leads_section(results, max_bytes=cap) == ""


def test_no_hollow_section_at_any_cap():
    # The strongest pin: across EVERY cap from 0 to the full uncapped length,
    # the section is emitted ONLY when it actually carries at least one lead
    # bullet. There is never a cap whose non-empty output is a header/framing/
    # headings/footer shell with zero leads.
    results = _tiny_results()
    size = _byte_len(_uncapped(results))
    for cap in range(0, size + 1):
        out = render_specialist_leads_section(results, max_bytes=cap)
        assert out == "" or any(
            ln.startswith("- [") for ln in out.splitlines()
        ), (cap, out)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------


def test_deterministic_byte_identical_output():
    results = _tiny_results()
    first = render_specialist_leads_section(results, max_bytes=600)
    second = render_specialist_leads_section(results, max_bytes=600)
    assert first == second
    # Same cap → same bytes, across repeated calls.
    for _ in range(3):
        assert (
            render_specialist_leads_section(results, max_bytes=600).encode("utf-8")
            == first.encode("utf-8")
        )


def test_output_independent_of_input_mapping_key_order():
    base = _tiny_results()
    shuffled = {key: base[key] for key in reversed(list(base))}
    assert (
        render_specialist_leads_section(shuffled, max_bytes=999)
        == render_specialist_leads_section(base, max_bytes=999)
    )
