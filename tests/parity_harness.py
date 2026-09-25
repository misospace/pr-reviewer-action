#!/usr/bin/env python3
"""v2-to-v3 behavioral parity harness (#673).

Runs equivalent v2/v3 runtime stages against the same fixtures and reports
observable behavior drift as a structured, machine-readable report. The
harness never compares source code or unit-test counts: it invokes the two
implementations and compares what consumers actually observe.

Structure:

- Boundaries are declared in ``BOUNDARIES`` below. Each boundary knows how to
  run one fixture through both implementations and returns their raw outputs.
- Fixtures live under ``tests/fixtures/parity/<boundary>/*.json``. Later
  migration tickets add fixtures (JSON only); they never copy harness logic.
- Nondeterministic values (temp paths, timestamps, durations, PIDs, request
  ids) are normalized by ``scrub``; only values the public contract declares
  irrelevant are ever normalized. Verdicts, risk flags, selected roles,
  corpus content, security-gate decisions, routing, and error categories are
  compared as-is.
- Numeric equality is applied ONLY to keys the contract declares numeric
  (INTEGER_INPUTS/FLOAT_INPUTS); every other key — including strings that
  happen to look numeric — compares as an exact canonical string.
- Error categories compare through the boundary's shared vocabulary. Two
  errors that both map to no known category never compare equal: their
  scrubbed texts must match byte-for-byte or the fixture drifts (fail
  closed), forcing the boundary table to name the category.
- A divergence is only acceptable when an entry in
  ``tests/fixtures/parity/approved-divergences.json`` pins the EXACT
  divergence: boundary + fixture + key + the expected old AND new values
  (or outcome/error categories). An approved divergence on one fixture or
  value never approves another; a key drifting to a different wrong value
  fails the run.
- A fixture that exists to prove drift detection (a counterexample) must
  declare its expected divergence signature — every key with its expected
  old/new values, and nothing beyond them. Missing or undeclared drift
  fails the run.
- The #698 production dataflow qualification and the #666/#661 semantic
  qualification run as migration gates before the boundaries; a gate failure
  fails the harness regardless of boundary results.

CLI: python3 tests/parity_harness.py [--boundary ID] [--report PATH]
[--skip-gates]. Exits nonzero on any unapproved drift or failed gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import yaml

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures" / "parity"
CONTRACT_PATH = ROOT / "contracts" / "action-v3.yml"
APPROVED_PATH = FIXTURES / "approved-divergences.json"

# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

# Explicitly normalized nondeterminism. Everything else — verdicts, risk
# flags, roles, corpus content, security decisions, routing, error categories
# — is never normalized away.
SCRUBBERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"/tmp/[A-Za-z0-9._/-]+"), "<TMP>"),
    (re.compile(r"/var/folders/[^\s\"']+"), "<TMP>"),
    (re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<TIMESTAMP>"),
    (re.compile(r"\b\d+\.\d+(?:ms|s)\b"), "<DURATION>"),
    (re.compile(r"\bpid[= ]\d+\b", re.IGNORECASE), "<PID>"),
    (re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"), "<REQUEST-ID>"),
    (re.compile(r"\breq[-_][A-Za-z0-9]{8,}\b"), "<REQUEST-ID>"),
)


def scrub(text: str) -> str:
    """Normalize only expected-to-vary nondeterministic values."""
    result = text
    for pattern, replacement in SCRUBBERS:
        result = pattern.sub(replacement, result)
    return result


def canonical(value: Any) -> str:
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def numeric_equal(left: str, right: str) -> bool:
    try:
        return float(left) == float(right)
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Results and comparison
# ---------------------------------------------------------------------------


@dataclass
class SideResult:
    ok: bool
    values: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    unresolved: list[str] = field(default_factory=list)
    pre: dict[str, str] = field(default_factory=dict)  # producer-resolved v2 env
    raw: bytes | None = None  # for byte-level boundaries (e.g. truncation)


@dataclass
class FixtureOutcome:
    fixture: str
    status: str  # match | approved_divergence | expected_drift | drift | runner_error
    divergences: list[dict[str, Any]] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class Boundary:
    id: str
    description: str
    fixtures_dir: str
    run: Callable[[dict[str, Any], Path], tuple[SideResult, SideResult]]
    error_categories: tuple[tuple[re.Pattern[str], str], ...] = ()
    key_mapping: dict[str, str] = field(default_factory=dict)  # v3 key -> v2 key
    secret_keys: set[str] = field(default_factory=set)  # v3 keys (secrets)
    numeric_keys: set[str] = field(default_factory=set)  # v3 keys declared numeric
    scope_rule: str | None = None  # "config": mechanical v2-transport scope
    static_exclusions: dict[str, str] = field(default_factory=dict)  # v2 key -> reason

    def evaluate(self, fixture: dict[str, Any], workdir: Path) -> FixtureOutcome:
        try:
            left, right = self.run(fixture, workdir)
        except Exception as error:  # runner infrastructure failure
            return FixtureOutcome(fixture["fixture"], "runner_error", detail={"error": str(error)})
        divergences: list[dict[str, Any]] = []
        excluded: dict[str, str] = {}
        if left.ok != right.ok:
            divergences.append({
                "key": "<outcome>",
                "old": "ok" if left.ok else f"error:{categorize(left.error or '', self.error_categories)}",
                "new": "ok" if right.ok else f"error:{categorize(right.error or '', self.error_categories)}",
                "detail": f"old ok={left.ok} new ok={right.ok}",
            })
        elif not left.ok:
            left_category = categorize(left.error or "", self.error_categories)
            right_category = categorize(right.error or "", self.error_categories)
            if left_category != right_category:
                divergences.append({
                    "key": "<error-category>",
                    "old": f"error:{left_category}",
                    "new": f"error:{right_category}",
                    "detail": f"old={left_category} new={right_category}",
                })
            elif left_category == "uncategorized":
                # Fail closed: two errors that map to no known category never
                # compare equal by category. Their scrubbed texts must match
                # exactly, or the fixture drifts and the boundary table must
                # learn the category.
                left_text = self.redact_secrets(fixture, scrub(left.error or ""))
                right_text = self.redact_secrets(fixture, scrub(right.error or ""))
                if left_text != right_text:
                    divergences.append({
                        "key": "<error-text>",
                        "old": left_text,
                        "new": right_text,
                        "detail": "both errors are uncategorized and their scrubbed texts differ",
                    })
        else:
            excluded = self.compute_exclusions(left)
            compared = 0
            for key, right_value in sorted(right.values.items()):
                v2_key = self.key_mapping.get(key, key)
                if v2_key in excluded:
                    continue
                compared += 1
                if v2_key not in left.values:
                    divergences.append({"key": key, "old": "<missing>", "new": self.normalize_key(key, right_value),
                                        "detail": "missing on old side"})
                    continue
                left_text = self.normalize_key(key, left.values[v2_key])
                right_text = self.normalize_key(key, right_value)
                if self.values_equal(key, left_text, right_text):
                    continue
                divergences.append({"key": key, "old": left_text, "new": right_text,
                                    "detail": f"old={left_text!r} new={right_text!r}"})
            if compared == 0:
                divergences.append({"key": "<scope>", "old": "", "new": "",
                                    "detail": "no keys left in scope; boundary scope collapsed", "approved": False})
        status = "match"
        if divergences:
            for divergence in divergences:
                divergence["approved"] = self.approval_for(fixture, divergence) is not None
            status = "approved_divergence" if all(d["approved"] for d in divergences) else "drift"
        status, divergences = self.apply_expected_drift(fixture, status, divergences)
        detail: dict[str, Any] = {}
        if not left.ok and left.error:
            detail["old_error"] = self.redact_secrets(fixture, scrub(left.error))[-800:]
        if not right.ok and right.error:
            detail["new_error"] = self.redact_secrets(fixture, scrub(right.error))[-800:]
        if left.unresolved or right.unresolved:
            detail["unresolved_bindings"] = sorted(set(left.unresolved) | set(right.unresolved))
        if excluded:
            detail["excluded_keys"] = excluded
        return FixtureOutcome(fixture["fixture"], status, divergences=divergences, detail=detail)

    # -- comparison ---------------------------------------------------------

    def values_equal(self, key: str, left: str, right: str) -> bool:
        """Numeric equality ONLY for keys the contract declares numeric;
        everything else — including strings that look numeric — is an exact
        canonical string comparison."""
        if key in self.numeric_keys and numeric_equal(left, right):
            return True
        return left == right

    def normalize_key(self, key: str, value: Any) -> str:
        text = canonical(value)
        if key in self.secret_keys:
            return "[REDACTED]" if text != "" else ""
        return scrub(text)

    def redact_secrets(self, fixture: dict[str, Any], text: str) -> str:
        """Replace raw fixture values of secret inputs before any error text
        is stored in the report. Error paths can echo input values; secret
        values must never survive into report artifacts."""
        result = text
        for value in secret_raw_values(fixture):
            if value:
                result = result.replace(value, "[REDACTED]")
        return result

    # -- scope ---------------------------------------------------------------

    def compute_exclusions(self, left: SideResult) -> dict[str, str]:
        """Keys outside this boundary's comparison scope, with reasons."""
        excluded = dict(self.static_exclusions)
        if self.scope_rule == "config":
            # Mechanical scope: a contract input is inside the config boundary
            # when the v2 producer actually transported it through the resolved
            # environment, or when config.sh itself set/changed it. Inputs the
            # v2 pipeline consumes downstream of the resolved environment
            # (e.g. publish-step reads of the raw input) belong to those
            # later boundaries, not to config/default resolution.
            for v2_key in self.key_mapping.values():
                transported = v2_key in left.pre
                mutated = left.values.get(v2_key, "") != left.pre.get(v2_key, "")
                if not transported and not mutated and v2_key not in excluded:
                    excluded[v2_key] = "not transported through the v2 resolved environment; consumed downstream of config resolution"
        return excluded

    # -- approvals -----------------------------------------------------------

    def approval_for(self, fixture: dict[str, Any], divergence: dict[str, Any]) -> dict[str, Any] | None:
        """An approval must pin the exact divergence: boundary + fixture(s) +
        key + the expected old AND new values (for outcome/error-category
        divergences, the "ok" / "error:<category>" tokens). Approval on one
        fixture, key, or value pair never extends to another."""
        for entry in load_approved():
            if entry["boundary"] != self.id or entry["key"] != divergence["key"]:
                continue
            if not entry_fixtures(entry).issuperset({fixture["fixture"]}):
                continue
            expected = entry.get("expected") or {}
            old_ok = self.values_equal(divergence["key"], str(expected.get("old", "")), divergence["old"])
            new_ok = self.values_equal(divergence["key"], str(expected.get("new", "")), divergence["new"])
            if old_ok and new_ok:
                return entry
        return None

    # -- counterexample signatures -------------------------------------------

    def apply_expected_drift(self, fixture: dict[str, Any], status: str,
                             divergences: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
        expected = fixture.get("expected") or {}
        if not isinstance(expected, dict) or expected.get("outcome") != "drift":
            return status, divergences
        declared = expected.get("divergences")
        if not isinstance(declared, list) or not declared:
            return "drift", [{
                "key": "<counterexample>",
                "old": "", "new": "",
                "detail": 'expected.outcome=drift requires a non-empty "divergences" signature (key + old + new each)',
                "approved": False,
            }]
        problems: list[dict[str, Any]] = []
        declared_keys: set[str] = set()
        for spec in declared:
            key = str(spec.get("key", ""))
            declared_keys.add(key)
            actual = next((d for d in divergences if d["key"] == key
                           and self.values_equal(key, str(spec.get("old", "")), d.get("old", ""))
                           and self.values_equal(key, str(spec.get("new", "")), d.get("new", ""))), None)
            if actual is None:
                observed = next((d for d in divergences if d["key"] == key), None)
                observed_text = f" (observed old={observed.get('old')!r} new={observed.get('new')!r})" if observed else ""
                problems.append({
                    "key": key,
                    "old": str(spec.get("old", "")), "new": str(spec.get("new", "")),
                    "detail": f"declared counterexample divergence not observed{observed_text}",
                    "approved": False,
                })
        undeclared = [d for d in divergences if d["key"] not in declared_keys]
        for d in undeclared:
            problems.append({"key": d["key"], "old": d.get("old", ""), "new": d.get("new", ""),
                             "detail": f"undeclared divergence beyond the counterexample signature: {d.get('detail', '')}",
                             "approved": False})
        if problems or undeclared:
            return "drift", problems
        # The vulnerable variant diverged exactly as the counterexample
        # requires: the harness detected the broken wiring.
        return "expected_drift", [{**d, "approved": True,
                                   "approved_via": "declared counterexample signature"} for d in divergences]


def entry_fixtures(entry: dict[str, Any]) -> set[str]:
    if "fixture" in entry:
        return {str(entry["fixture"])}
    if "fixtures" in entry:
        return {str(f) for f in entry["fixtures"]}
    return set()


def categorize(error: str, categories: tuple[tuple[re.Pattern[str], str], ...]) -> str:
    for pattern, category in categories:
        if pattern.search(error):
            return category
    return "uncategorized"


def load_approved() -> list[dict[str, Any]]:
    if not APPROVED_PATH.exists():
        return []
    data = json.loads(APPROVED_PATH.read_text())
    entries = data.get("entries", [])
    for entry in entries:
        for field_name in ("boundary", "key", "reason", "expected"):
            if not entry.get(field_name):
                raise RuntimeError(f"approved-divergences entry missing '{field_name}': {entry}")
        if not entry_fixtures(entry):
            raise RuntimeError(f"approved-divergences entry must name its fixture(s): {entry}")
        expected = entry["expected"]
        if not isinstance(expected, dict) or "old" not in expected or "new" not in expected:
            raise RuntimeError(f"approved-divergences entry expected must pin old and new: {entry}")
    return entries


# ---------------------------------------------------------------------------
# Boundary: config/default resolution
# ---------------------------------------------------------------------------


def load_contract() -> dict[str, Any]:
    return yaml.safe_load(CONTRACT_PATH.read_text())


@dataclass
class ConfigSurface:
    mapping: dict[str, str]  # v3 camelCase key -> v2 env var name
    secrets: set[str]        # v3 camelCase keys of secret inputs
    numeric: set[str]        # v3 camelCase keys declared numeric (INTEGER/FLOAT)
    secret_v2_ids: set[str]  # v2 ids of secret inputs (for report redaction)


def to_camel_case(input_id: str) -> str:
    return re.sub(r"-([a-z0-9])", lambda m: m.group(1).upper(), input_id)


def config_surface() -> ConfigSurface:
    """Derive the comparison surface from the sources of truth: the v3
    contract (key mapping, secret inputs) and the v3 schema (numeric classes)."""
    schema = (ROOT / "src" / "config" / "schema.ts").read_text()
    secret_ids = _schema_set(schema, "SECRET_INPUTS")
    numeric_ids = _schema_set(schema, "INTEGER_INPUTS") | _schema_set(schema, "FLOAT_INPUTS")
    mapping: dict[str, str] = {}
    secrets: set[str] = set()
    numeric: set[str] = set()
    contract = load_contract()
    for item in contract["inputs"]:
        camel = to_camel_case(item["id"])
        # The v2 pipeline binds the token input to GH_TOKEN (with the ambient
        # GITHUB_TOKEN as config.sh's fallback), never to GITHUB_TOKEN itself.
        mapping[camel] = "GH_TOKEN" if item["id"] == "github-token" else item["v2_id"].upper()
        if item["id"] in secret_ids:
            secrets.add(camel)
        if item["id"] in numeric_ids:
            numeric.add(camel)
    return ConfigSurface(
        mapping=mapping,
        secrets=secrets,
        numeric=numeric,
        secret_v2_ids={item["v2_id"] for item in contract["inputs"] if item["id"] in secret_ids},
    )


def _schema_set(schema: str, name: str) -> set[str]:
    match = re.search(rf"{name} = new Set\(\[(.*?)\]\)", schema, re.S)
    if not match:
        raise RuntimeError(f"{name} not found in src/config/schema.ts")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


def secret_raw_values(fixture: dict[str, Any]) -> list[str]:
    """Raw fixture values of secret inputs, for report redaction."""
    surface = config_surface()
    raw = fixture.get("raw", {})
    return [str(raw[v2_id]) for v2_id in surface.secret_v2_ids if v2_id in raw]


def run_json_runner(command: list[str], workdir: Path, timeout: int, env: dict[str, str] | None = None, stdin_text: str | None = None) -> SideResult:
    proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout, cwd=str(ROOT), env=env, input=stdin_text)
    if proc.returncode != 0:
        raise RuntimeError(f"runner failed ({proc.returncode}): {proc.stderr.strip()[-400:]}")
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    return SideResult(
        ok=payload["ok"],
        values=payload.get("values", {}),
        error=payload.get("stderr"),
        unresolved=payload.get("unresolved", []),
        pre=payload.get("pre", {}),
    )


def run_v2_config(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        ["bash", str(ROOT / "tests" / "parity_runners" / "v2_config.sh"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def run_v3_config(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    contract = load_contract()
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(workdir),
        "PR_REVIEWER_V3_DEBUG": "true",
    }
    raw = fixture.get("raw", {})
    for item in contract["inputs"]:
        if item["v2_id"] in raw:
            env[f"INPUT_{item['v2_id'].upper()}"] = str(raw[item["v2_id"]])
    proc = subprocess.run(
        [node, "dist/index.js"],
        cwd=str(ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return SideResult(ok=False, error=proc.stderr.strip())
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    return SideResult(ok=True, values=payload["config"])


def _fixture_path(fixture: dict[str, Any]) -> str:
    path = fixture.get("_path")
    if not path:
        raise RuntimeError("fixture _path not set")
    return str(path)


CONFIG_CATEGORIES = (
    (re.compile(r"Required input '.*' is missing"), "missing-required"),
    (re.compile(r"Missing required environment variables|is required when"), "missing-required"),
    (re.compile(r"Missing GitHub token"), "missing-required"),
    (re.compile(r"must be one of|expected openai or anthropic|Invalid AI_API_FORMAT|Invalid AI_FALLBACK_API_FORMAT|Invalid AI_PRIMARY_API_FORMAT|Invalid AI_SMART_API_FORMAT"), "invalid-enum"),
    (re.compile(r"must be an integer|must be a finite number|must be between|must be at least"), "invalid-number"),
    (re.compile(r"must be 'true' or 'false'"), "invalid-boolean"),
    (re.compile(r"outside the safe integer range"), "invalid-number"),
)

CONFIG_BOUNDARY = Boundary(
    id="config-default-resolution",
    description=(
        "Equivalent config/default resolution: action.yml env-block expression "
        "resolution plus scripts/sections/config.sh (v2) versus the v3 typed "
        "loader (dist/index.js)."
    ),
    fixtures_dir="config",
    run=lambda fixture, workdir: (run_v2_config(fixture, workdir), run_v3_config(fixture, workdir)),
    error_categories=CONFIG_CATEGORIES,
    scope_rule="config",
    static_exclusions={
        # The assembled system prompt is prompt-assembly output (its own later
        # boundary), not config/default resolution: config.sh resolves the
        # bundled default prompt into SYSTEM_PROMPT, while the v3 config
        # surface carries the raw input default ("").
        "SYSTEM_PROMPT": "prompt assembly output, resolved by resolve_system_prompt; separate migration boundary",
    },
)

# ---------------------------------------------------------------------------
# Boundary: #662 dataflow (corpus truncation counterexample)
# ---------------------------------------------------------------------------


def run_truncation_side(variant: str, content: str, budget: int, marker: str, workdir: Path) -> SideResult:
    src = workdir / "input"
    dst = workdir / f"output-{variant}"
    src.write_text(content)
    runner = ROOT / "tests" / "parity_runners" / "truncate_clean.sh"
    proc = subprocess.run(
        ["bash", str(runner), variant, str(src), str(dst), str(budget), marker],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "PATH": os.environ.get("PATH", "/usr/bin:/bin")},
    )
    if proc.returncode != 0:
        return SideResult(ok=False, error=proc.stderr.strip())
    output = dst.read_bytes()
    digest = hashlib.sha256(output).hexdigest()
    return SideResult(ok=True, raw=output, values={"output_bytes": str(len(output)), "output_sha256": digest})


def make_truncation_runner(side: str) -> Callable[[dict[str, Any], Path], SideResult]:
    def run(fixture: dict[str, Any], workdir: Path) -> SideResult:
        spec = fixture["sides"][side]
        return run_truncation_side(
            spec["variant"],
            fixture["content"],
            int(fixture["budget"]),
            fixture["marker"],
            workdir,
        )

    return run


TRUNCATION_BOUNDARY = Boundary(
    id="dataflow-662-corpus-truncation",
    description=(
        "#662 corpus-truncation dataflow counterexample: the production "
        "truncate_clean versus the reconstructed pre-fix broken-arrow variant, "
        "run against the same oversized-marker fixture. The vulnerable "
        "fixture must fail parity with exactly its declared divergence "
        "signature (drift is observable, never normalized away); the fixed "
        "variant must pass."
    ),
    fixtures_dir="dataflow-662",
    run=lambda fixture, workdir: (
        make_truncation_runner("old")(fixture, workdir),
        make_truncation_runner("new")(fixture, workdir),
    ),
)

# ---------------------------------------------------------------------------
# Boundary: precheck decision (#674)
# ---------------------------------------------------------------------------


def _normalize_selection_unavailable(fixture: dict[str, Any], result: SideResult) -> SideResult:
    """When the fixture declares a conservative selection-signature failure,
    the broad fingerprint carries a per-run unique ``unavailable-…`` sentinel
    inside its config hash — nondeterministic by design (it must never match
    a stored marker). The observable contract is that the hash differs from
    the stored one, so both sides' hash halves are normalized to a shared
    placeholder. Any other value (the diff half, or a deterministic
    signature) is compared as-is."""
    if fixture.get("selection") != "unavailable" or not result.ok:
        return result
    values = dict(result.values)
    fingerprint = str(values.get("diff_fingerprint", ""))
    match = re.match(r"^(.*\|cfg:).*$", fingerprint, re.S)
    if match:
        values["diff_fingerprint"] = f"{match.group(1)}unavailable"
    result.values = values
    return result


def run_v2_precheck(fixture: dict[str, Any], workdir: Path) -> SideResult:
    result = run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_precheck.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )
    return _normalize_selection_unavailable(fixture, result)


def run_v3_precheck(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    proc = subprocess.run(
        [node, "dist/index.js", "precheck-fixture", str(_fixture_path(fixture))],
        cwd=str(ROOT),
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(workdir)},
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        return SideResult(ok=False, error=proc.stderr.strip())
    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    result = SideResult(ok=payload["ok"], values=payload.get("values", {}), error=payload.get("stderr"))
    return _normalize_selection_unavailable(fixture, result)


PRECHECK_CATEGORIES = (
    (re.compile(r"Missing REPO or PR_NUMBER"), "missing-input"),
    (re.compile(r"unsupported PLATFORM", re.IGNORECASE), "invalid-platform"),
    (re.compile(r"Could not determine Forgejo permission"), "forgejo-permission-unknown"),
    (re.compile(r"lacks Forgejo write permission"), "forgejo-permission-denied"),
)

PRECHECK_BOUNDARY = Boundary(
    id="precheck-decision",
    description=(
        "Equivalent precheck decisions (#674): the v2 production path "
        "(scripts/check_review_needed.sh + pr_reviewer.precheck + "
        "build_selection_fingerprint, platform I/O via the real platform "
        "seam) versus the v3 TypeScript platform adapters and precheck "
        "decision modules, driven over the same fixture platform state. "
        "Covers unchanged/changed fingerprints, linked-issue label and "
        "Linear priority changes, failed metadata lookups, fork-disabled "
        "private lookups, forced re-review, unrelated-label no-ops, "
        "superseded heads, and GitHub vs Forgejo."
    ),
    fixtures_dir="precheck",
    run=lambda fixture, workdir: (run_v2_precheck(fixture, workdir), run_v3_precheck(fixture, workdir)),
    error_categories=PRECHECK_CATEGORIES,
)


# ---------------------------------------------------------------------------
# Boundary: model request construction (#677)
# ---------------------------------------------------------------------------


def run_v2_request(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        ["bash", str(ROOT / "tests" / "parity_runners" / "v2_request.sh"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def _v3_parity_env() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "PR_REVIEWER_V3_MODE": "v3-request-builder",
    }


def run_v3_request(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    return run_json_runner(
        [node, "dist/index.js", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env=_v3_parity_env(),
    )


MODEL_REQUEST_BOUNDARY = Boundary(
    id="model-request-construction",
    description=(
        "#677 request construction parity: the v2 build_model_request jq "
        "assembly versus the v3 typed builder, for both api formats across "
        "shape, temperature omission, token-param selection, structured "
        "output modes, and streaming options."
    ),
    fixtures_dir="model-request",
    run=lambda fixture, workdir: (run_v2_request(fixture, workdir), run_v3_request(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: verdict parsing (#677)
# ---------------------------------------------------------------------------

VERDICT_CATEGORIES = (
    (re.compile(r"Model returned an empty completion"), "empty-completion"),
    (re.compile(r"Model endpoint returned an error"), "endpoint-error"),
    (re.compile(r"Expected verdict to be"), "invalid-verdict"),
    (re.compile(r"missing required key"), "missing-key"),
    (re.compile(r"Expected JSON object"), "not-object"),
    (re.compile(r"empty or missing 'review_markdown'"), "empty-markdown"),
    (re.compile(r"appears flattened"), "flattened"),
)


def run_v2_verdict(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_verdict.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def run_v3_verdict(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "PR_REVIEWER_V3_MODE": "v3-verdict-parser",
    }
    return run_json_runner(
        [node, "dist/index.js", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env=env,
    )


VERDICT_BOUNDARY = Boundary(
    id="verdict-parsing",
    description=(
        "#677 verdict parsing parity: the v2 tolerant response parser versus "
        "the v3 port, over strict/fenced/prose JSON extraction, findings "
        "normalization, and the typed failure vocabulary (empty completion, "
        "invalid verdict, flattened markdown, endpoint errors)."
    ),
    fixtures_dir="verdict-parsing",
    run=lambda fixture, workdir: (run_v2_verdict(fixture, workdir), run_v3_verdict(fixture, workdir)),
    error_categories=VERDICT_CATEGORIES,
)


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Boundary: tier-aware tool request budget (#701)
# ---------------------------------------------------------------------------


def run_v2_tool_budget(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_tool_budget.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=300,
    )


def run_v3_tool_budget(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    return run_json_runner(
        [node, "dist/index.js", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/tmp"),
            "PR_REVIEWER_V3_MODE": "tool-budget",
        },
    )


TOOL_BUDGET_BOUNDARY = Boundary(
    id="tool-request-budget",
    description=(
        "#701 tier-aware native tool-loop request budget: the v2 production "
        "harness resolver (run through the real run_tool_harness.py "
        "missing-corpus path) versus the v3 port, over tier defaults "
        "(primary 8, smart 16, escalated 20), explicit overrides, "
        "SMART_TOOL_MAX_REQUESTS precedence, the 1..20 hard ceiling, and the "
        "#702 budget provenance (source). Both sides enforce the fixture's "
        "expected (route, budget, source), so the absolute values are "
        "pinned, not just cross-side agreement — the #678 migration cannot "
        "regress to a single undifferentiated ceiling."
    ),
    fixtures_dir="tool-budget",
    run=lambda fixture, workdir: (run_v2_tool_budget(fixture, workdir), run_v3_tool_budget(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: classification + role selection (#675)
# ---------------------------------------------------------------------------


def run_v2_classification(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_classification.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def _run_v3_fixture_mode(mode_argv: list[str], fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    return run_json_runner(
        [node, "dist/index.js", *mode_argv, str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(workdir)},
    )


def run_v3_classification(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["classification-fixture"], fixture, workdir)


CLASSIFICATION_BOUNDARY = Boundary(
    id="classification-role-selection",
    description=(
        "#675 classification parity: the v2 deterministic classifier and the "
        "specialist role selector versus the v3 TypeScript port, driven over "
        "the same fixture inputs. Covers kind precedence (renovate digest-only, "
        "dependency upgrades, k8s manifests, security/path kinds), diff-content "
        "risk flags and route-signal exclusion, linked-issue label flags, "
        "Linear native priority mapping, must-check derivation, linked-metadata "
        "uncertainty, the trivial zero-selection gates (with the summary-cap "
        "conservatism), and every conservative all-roles fallback (unusable "
        "input, unknown kind, no-lane kind, undetermined metadata). Includes "
        "the reconstructed #655 GitHub-label and Linear capability cases from "
        "#662: enriched canonical labels must reach classification and flip "
        "risk flags and role selection."
    ),
    fixtures_dir="classification",
    run=lambda fixture, workdir: (run_v2_classification(fixture, workdir), run_v3_classification(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: requirement ledger (#675)
# ---------------------------------------------------------------------------


def run_v2_requirement_ledger(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_requirement_ledger.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def run_v3_requirement_ledger(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["requirement-ledger-fixture"], fixture, workdir)


REQUIREMENT_LEDGER_BOUNDARY = Boundary(
    id="requirement-ledger",
    description=(
        "#675 requirement-ledger parity: the v2 deterministic ledger extractor "
        "and fence-safe markdown renderer versus the v3 TypeScript port, over "
        "standards/linked-issue/PR-body sources. Covers acceptance/normative/"
        "invariant extraction rules, fenced-block skipping, content-derived ids, "
        "cross-source dedup with merged provenance, truncation caps (entry "
        "count, text length, source capacity with reserved docs, markdown byte "
        "cap), and hostile-content handling (control characters, backtick runs, "
        "heading forgery)."
    ),
    fixtures_dir="requirement-ledger",
    run=lambda fixture, workdir: (
        run_v2_requirement_ledger(fixture, workdir),
        run_v3_requirement_ledger(fixture, workdir),
    ),
)


# ---------------------------------------------------------------------------
# Boundary: enrichment normalization (#675)
# ---------------------------------------------------------------------------


def run_v2_enrichment(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_enrichment.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def run_v3_enrichment(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["enrichment-fixture"], fixture, workdir)


ENRICHMENT_BOUNDARY = Boundary(
    id="enrichment-normalization",
    description=(
        "#675 enrichment-normalization parity: the v2 pure extraction and "
        "normalization functions (URL extraction with redirect.github.com "
        "normalization, allowlist string parsing, version hints, target-"
        "version selection with tail -n1 hint semantics, GHCR image "
        "extraction, old→new compare-SHA extraction, release/compare URL "
        "classification) versus the v3 TypeScript port. The DNS resolution / "
        "public-IP fetch-security functions are out of scope: that is fetch "
        "policy owned by the platform/tool boundaries and stays in v2."
    ),
    fixtures_dir="enrichment-normalization",
    run=lambda fixture, workdir: (run_v2_enrichment(fixture, workdir), run_v3_enrichment(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: repository map (#675)
# ---------------------------------------------------------------------------


sys.path.insert(0, str(ROOT / "tests" / "parity_runners"))
from repo_fixture import prepare_repo  # noqa: E402


def run_v2_repo_map(fixture: dict[str, Any], workdir: Path) -> SideResult:
    repo = prepare_repo(workdir / "repo-v2", fixture)
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_repo_map.py"), str(_fixture_path(fixture)), str(repo)],
        workdir,
        timeout=120,
    )


def run_v3_repo_map(fixture: dict[str, Any], workdir: Path) -> SideResult:
    repo = prepare_repo(workdir / "repo-v3", fixture)
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    return run_json_runner(
        [node, "dist/index.js", "repo-map-fixture", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(workdir),
            "PARITY_REPO_DIR": str(repo),
        },
    )


REPO_MAP_BOUNDARY = Boundary(
    id="repo-map",
    description=(
        "#675 repository-map parity: the v2 deterministic bounded repo-map "
        "builder (git ls-files seeding, language/important/category "
        "classification, bounded depth-major tree, visible truncation) and "
        "its fence-safe JSON/Markdown renderers plus trust framing versus the "
        "v3 TypeScript port. Covers mixed-language trees, hostile filenames "
        "(backtick runs, newlines, Unicode, fence strings, display caps), "
        "every truncation reason, hard markdown byte caps, framed rendering, "
        "and the clean no-Git failure."
    ),
    fixtures_dir="repo-map",
    run=lambda fixture, workdir: (run_v2_repo_map(fixture, workdir), run_v3_repo_map(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: PR thread context (#675)
# ---------------------------------------------------------------------------


def run_v2_pr_thread(fixture: dict[str, Any], workdir: Path) -> SideResult:
    # Fixture via stdin: these runners' fixtures carry credential-shaped
    # inert dummies, and the v2 secret-detector treats a read of such a file
    # as a clear-text-logging source (see the runner docstrings).
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_pr_thread.py")],
        workdir,
        timeout=120,
        stdin_text=json.dumps(fixture),
    )


def run_v3_pr_thread(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["pr-thread-fixture"], fixture, workdir)


PR_THREAD_BOUNDARY = Boundary(
    id="pr-thread",
    description=(
        "#675 PR-thread parity: the v2 bounded conversation-comment builder "
        "(timestamp/id ordering with unparseable stamps last, managed-comment "
        "filtering, marker-line stripping, secret redaction, control-char "
        "hygiene, per-comment byte truncation, whole-comment byte budget with "
        "visible omission) versus the v3 TypeScript port. Covers hostile "
        "bodies (backtick fences, forged markers, credential shapes) and the "
        "custom managed-marker substring mode."
    ),
    fixtures_dir="pr-thread",
    run=lambda fixture, workdir: (run_v2_pr_thread(fixture, workdir), run_v3_pr_thread(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: related-code context (#675)
# ---------------------------------------------------------------------------


def run_v2_related_code(fixture: dict[str, Any], workdir: Path) -> SideResult:
    repo = prepare_repo(workdir / "repo-v2", fixture)
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_related_code.py"), str(repo)],
        workdir,
        timeout=120,
        stdin_text=json.dumps(fixture),
    )


def run_v3_related_code(fixture: dict[str, Any], workdir: Path) -> SideResult:
    repo = prepare_repo(workdir / "repo-v3", fixture)
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 24)")
    return run_json_runner(
        [node, "dist/index.js", "related-code-fixture", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(workdir),
            "PARITY_REPO_DIR": str(repo),
        },
    )


RELATED_CODE_BOUNDARY = Boundary(
    id="related-code",
    description=(
        "#675 related-code parity: the v2 deterministic bounded related-code "
        "scanner (high-confidence symbol anchors, fixed-string git grep with "
        "per-symbol/global caps and extra-hit detection, test discovery with "
        "scored stems, nearest-first manifests, changed/deleted path "
        "exclusion, secret-redacted snippets, explicit git errors, and the "
        "structural JSON byte cap) versus the v3 TypeScript port, over "
        "identical harness-prepared worktrees."
    ),
    fixtures_dir="related-code",
    run=lambda fixture, workdir: (run_v2_related_code(fixture, workdir), run_v3_related_code(fixture, workdir)),
)


# ---------------------------------------------------------------------------
# Boundary: image digest provenance (#675)
# ---------------------------------------------------------------------------


def run_v2_image_provenance(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        [sys.executable, str(ROOT / "tests" / "parity_runners" / "v2_image_provenance.py"), str(_fixture_path(fixture))],
        workdir,
        timeout=120,
    )


def run_v3_image_provenance(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["image-provenance-fixture"], fixture, workdir)


IMAGE_PROVENANCE_BOUNDARY = Boundary(
    id="image-provenance",
    description=(
        "#675 image-digest provenance parity: the v2 diff parser (repository:/"
        "tag:/digest:/image: bucketing and old→new pairing), registry target "
        "routing, manifest/config normalization into OCI label provenance, "
        "GitHub compare post-processing, compare-repo resolution (OCI source "
        "labels with mismatch detection and the image-repo heuristic), and "
        "the rendered document versus the v3 TypeScript port with the same "
        "fixture-routed transport. The HTTP transport itself (curl, tokens, "
        "budgets) is fetch policy that stays in v2."
    ),
    fixtures_dir="image-provenance",
    run=lambda fixture, workdir: (run_v2_image_provenance(fixture, workdir), run_v3_image_provenance(fixture, workdir)),
)


def run_v2_corpus(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return run_json_runner(
        ["bash", str(ROOT / "tests" / "parity_runners" / "v2_corpus.sh"), str(_fixture_path(fixture))],
        workdir,
        timeout=180,
    )


def run_v3_corpus(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["corpus-fixture"], fixture, workdir)


# Error vocabulary for the corpus boundary's failure contracts. The v2
# messages arrive prefixed by the common.sh log stamp (scrubbed) and the
# "ERROR: " marker; both sides map onto the same shared categories.
CORPUS_CATEGORIES = (
    (re.compile(r"expected a positive integer"), "invalid-number"),
    (re.compile(r"cannot fit AI_MAX_TOKENS"), "budget-too-small"),
    # Projection failures abort the production review (set -euo pipefail):
    # v2's stderr is jq's own message, the v3 port throws a typed error.
    (re.compile(r"jq: error|jq: parse error|jq: projection failed"), "projection-failed"),
    (re.compile(r"exceeds its [0-9]+-byte context budget"), "corpus-over-budget"),
)

CORPUS_BOUNDARY = Boundary(
    id="corpus-assembly",
    description=(
        "Equivalent review-corpus assembly: the production corpus.sh pipeline "
        "(sliced verbatim; #676) versus the v3 TypeScript assembly — section "
        "order and authority, tier-aware budgets with output-token headroom, "
        "raw-source smart rebuild (#658/#668), UTF-8-safe truncation, reserved "
        "standards/ledger/specialist sections, tool-harness placeholder and "
        "slot semantics, fork gating, and presence signals."
    ),
    fixtures_dir="corpus",
    run=lambda fixture, workdir: (run_v2_corpus(fixture, workdir), run_v3_corpus(fixture, workdir)),
    error_categories=CORPUS_CATEGORIES,
)

BOUNDARIES: tuple[Boundary, ...] = (CONFIG_BOUNDARY, TRUNCATION_BOUNDARY, PRECHECK_BOUNDARY, MODEL_REQUEST_BOUNDARY, VERDICT_BOUNDARY, TOOL_BUDGET_BOUNDARY, CLASSIFICATION_BOUNDARY, REQUIREMENT_LEDGER_BOUNDARY, ENRICHMENT_BOUNDARY, REPO_MAP_BOUNDARY, PR_THREAD_BOUNDARY, RELATED_CODE_BOUNDARY, IMAGE_PROVENANCE_BOUNDARY, CORPUS_BOUNDARY)

# ---------------------------------------------------------------------------
# Migration gates (#698 dataflow qualification, #666/#661 semantic qualification)
# ---------------------------------------------------------------------------


def run_gate(name: str, command: list[str], workdir: Path, timeout: int = 900) -> dict[str, Any]:
    proc = subprocess.run(command, cwd=str(ROOT), capture_output=True, text=True, timeout=timeout)
    tail = "\n".join((proc.stdout + proc.stderr).strip().splitlines()[-15:])
    return {
        "id": name,
        "ok": proc.returncode == 0,
        "exit_code": proc.returncode,
        "output_tail": scrub(tail),
    }


def run_migration_gates(workdir: Path) -> list[dict[str, Any]]:
    gates = [
        (
            "dataflow-qualification-698",
            [sys.executable, "-m", "pytest", "tests/test_issue_662_dataflow.py", "-q", "--tb=short"],
        ),
        (
            "semantic-qualification-666",
            [
                sys.executable,
                "scripts/run_semantic_eval_ci.py",
                "--corpus",
                "evals/corpus-historical-dogfood.json",
                "--output",
                str(workdir / "semantic-eval-report.json"),
            ],
        ),
    ]
    return [run_gate(name, command, workdir) for name, command in gates]


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def load_fixtures(boundary: Boundary) -> list[dict[str, Any]]:
    directory = FIXTURES / boundary.fixtures_dir
    fixtures = []
    for path in sorted(directory.glob("*.json")):
        fixture = json.loads(path.read_text())
        fixture["_path"] = str(path)
        if "fixture" not in fixture:
            fixture["fixture"] = path.stem
        fixtures.append(fixture)
    if not fixtures:
        raise RuntimeError(f"boundary {boundary.id} has no fixtures in {directory}")
    return fixtures


def evaluate_boundary(boundary: Boundary, workdir: Path) -> dict[str, Any]:
    surface = config_surface()
    boundary.key_mapping = surface.mapping
    boundary.secret_keys = surface.secrets
    boundary.numeric_keys = surface.numeric
    outcomes = []
    for fixture in load_fixtures(boundary):
        with tempfile.TemporaryDirectory(prefix="parity-fixture-") as td:
            outcome = boundary.evaluate(fixture, Path(td))
        outcomes.append({"fixture": outcome.fixture, "status": outcome.status,
                         "divergences": outcome.divergences, "detail": outcome.detail})
    return {
        "id": boundary.id,
        "description": boundary.description,
        "fixtures": outcomes,
        "ok": all(o["status"] in ("match", "approved_divergence", "expected_drift") for o in outcomes),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundary", action="append", help="restrict to these boundary ids")
    parser.add_argument("--report", help="write the structured parity report JSON here")
    parser.add_argument("--skip-gates", action="store_true", help="skip the migration gates")
    args = parser.parse_args(argv)

    selected = tuple(b for b in BOUNDARIES if not args.boundary or b.id in args.boundary)
    if args.boundary and len(selected) != len(args.boundary):
        known = {b.id for b in BOUNDARIES}
        parser.error(f"unknown boundary(s): {sorted(set(args.boundary) - known)}")

    with tempfile.TemporaryDirectory(prefix="parity-harness-") as td:
        workdir = Path(td)
        gates = [] if args.skip_gates else run_migration_gates(workdir)
        boundaries = [evaluate_boundary(b, workdir) for b in selected]

    first_divergent = next(
        (b["id"] for b in boundaries for f in b["fixtures"] if f["status"] == "drift"),
        None,
    )
    report = {
        "schema_version": 1,
        "generator": "tests/parity_harness.py",
        "gates": gates,
        "boundaries": boundaries,
        "first_divergent_boundary": first_divergent,
        "summary": {
            "fixtures": sum(len(b["fixtures"]) for b in boundaries),
            "matched": sum(1 for b in boundaries for f in b["fixtures"] if f["status"] == "match"),
            "approved_divergences": sum(1 for b in boundaries for f in b["fixtures"] if f["status"] == "approved_divergence"),
            "expected_drift": sum(1 for b in boundaries for f in b["fixtures"] if f["status"] == "expected_drift"),
            "drifted": sum(1 for b in boundaries for f in b["fixtures"] if f["status"] == "drift"),
            "runner_errors": sum(1 for b in boundaries for f in b["fixtures"] if f["status"] == "runner_error"),
        },
    }
    gates_ok = all(g["ok"] for g in gates)
    ok = gates_ok and first_divergent is None and not any(
        f["status"] == "runner_error" for b in boundaries for f in b["fixtures"]
    )
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")

    for gate in gates:
        print(f"gate {gate['id']}: {'OK' if gate['ok'] else 'FAILED'}")
    for boundary in boundaries:
        for fixture in boundary["fixtures"]:
            marker = {"match": ".", "approved_divergence": "A", "expected_drift": "D",
                      "drift": "F", "runner_error": "E"}[fixture["status"]]
            print(f"  [{marker}] {boundary['id']}/{fixture['fixture']}: {fixture['status']}")
            for divergence in fixture["divergences"]:
                print(f"      {divergence['key']}: {divergence['detail']}"
                      f"{' (approved)' if divergence.get('approved') else ''}")
    print(f"parity: {'OK' if ok else 'FAILED'} (first divergent boundary: {first_divergent})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
