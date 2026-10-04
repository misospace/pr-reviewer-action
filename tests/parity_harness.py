#!/usr/bin/env python3
"""V3 snapshot harness (formerly the v2-to-v3 parity harness #673, retired in #924).

Each boundary runs one fixture through the v3 runtime and compares the result
with ``tests/fixtures/parity/goldens/<boundary>/<fixture>.json``. ``scrub``
normalizes only expected-to-vary nondeterminism; secrets are redacted so raw
secret input values never land in a snapshot. ``--update`` rewrites snapshots,
so a deliberate behavior change is a reviewable diff.

CLI: python3 tests/parity_harness.py [--boundary ID] [--report PATH] [--update].
"""

from __future__ import annotations

import argparse
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
GOLDENS = FIXTURES / "goldens"

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


# ---------------------------------------------------------------------------
# Results and snapshots
# ---------------------------------------------------------------------------


@dataclass
class SideResult:
    ok: bool
    values: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    unresolved: list[str] = field(default_factory=list)


@dataclass
class FixtureOutcome:
    fixture: str
    status: str  # match | drift | missing_snapshot | runner_error | updated
    divergences: list[dict[str, Any]] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)


def _snapshot_file(boundary_id: str, fixture_name: str) -> Path:
    return GOLDENS / boundary_id / f"{fixture_name}.json"


def _restore_placeholders(text: str, workdir: Path) -> str:
    return (
        text.replace("<WORKDIR>", str(workdir))
        .replace("<ROOT>", str(ROOT))
        .replace("<HOME>", str(Path.home()))
    )


def _store_placeholders(text: str, workdir: Path) -> str:
    # Most specific first: ROOT and workdir may sit under HOME, and workdir
    # under ROOT. HOME is included because some runners pass the ambient HOME
    # to the v3 process (`_v3_parity_env`), so a snapshot must not record it.
    return (
        text.replace(str(workdir), "<WORKDIR>")
        .replace(str(ROOT), "<ROOT>")
        .replace(str(Path.home()), "<HOME>")
    )


def read_snapshot(boundary_id: str, fixture_name: str, workdir: Path) -> SideResult | None:
    """The recorded v3 snapshot for a fixture, or None when it has never been
    recorded. `<WORKDIR>`/`<ROOT>` placeholders are restored to this run's
    paths so a snapshot recorded anywhere compares cleanly here."""
    path = _snapshot_file(boundary_id, fixture_name)
    if not path.is_file():
        return None
    data = json.loads(_restore_placeholders(path.read_text(encoding="utf-8"), workdir))
    return SideResult(
        ok=bool(data["ok"]),
        values=data.get("values") or {},
        error=data.get("error"),
        unresolved=data.get("unresolved") or [],
    )


def write_snapshot(boundary_id: str, fixture_name: str, result: SideResult, workdir: Path) -> Path:
    """Record `result` (already normalized) as the fixture's snapshot."""
    path = _snapshot_file(boundary_id, fixture_name)
    payload = {
        "ok": result.ok,
        "values": result.values,
        "error": result.error,
        "unresolved": result.unresolved,
    }
    text = json.dumps(payload, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_store_placeholders(text, workdir), encoding="utf-8")
    return path


@dataclass
class Boundary:
    id: str
    description: str
    fixtures_dir: str
    run: Callable[[dict[str, Any], Path], SideResult]
    canonical_json_keys: set[str] = field(default_factory=set)  # values compared as sorted-key JSON
    secret_keys: set[str] = field(default_factory=set)  # v3 keys whose values are redacted

    def normalize_value(self, key: str, value: Any) -> str:
        if key in self.canonical_json_keys and isinstance(value, (dict, list)):
            text = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        else:
            text = canonical(value)
        if key in self.secret_keys:
            return "[REDACTED]" if text != "" else ""
        return scrub(text)

    def normalize(self, result: SideResult, fixture: dict[str, Any]) -> SideResult:
        """Reduce a result to its comparable, storable form: every value
        canonicalized (+ canonical JSON for declared keys), secrets redacted,
        expected-to-vary nondeterminism scrubbed, error text scrubbed and with
        raw secret fixture values redacted."""
        return SideResult(
            ok=result.ok,
            values={key: self.normalize_value(key, value) for key, value in result.values.items()},
            error=self.redact_secrets(fixture, scrub(result.error)) if result.error else result.error,
            unresolved=list(result.unresolved),
        )

    def redact_secrets(self, fixture: dict[str, Any], text: str) -> str:
        result = text
        for value in secret_raw_values(fixture):
            if value:
                result = result.replace(value, "[REDACTED]")
        return result

    def evaluate(self, fixture: dict[str, Any], workdir: Path, *, update: bool = False) -> FixtureOutcome:
        name = fixture["fixture"]
        try:
            observed = self.normalize(self.run(fixture, workdir), fixture)
        except Exception as error:  # runner infrastructure failure
            return FixtureOutcome(
                name, "runner_error",
                detail={"error": self.redact_secrets(fixture, scrub(str(error)))},
            )
        if update:
            path = write_snapshot(self.id, name, observed, workdir)
            return FixtureOutcome(name, "updated", detail={"snapshot": str(path.relative_to(ROOT))})
        snapshot = read_snapshot(self.id, name, workdir)
        if snapshot is None:
            return FixtureOutcome(
                name, "missing_snapshot",
                detail={"snapshot": str(_snapshot_file(self.id, name).relative_to(ROOT))},
            )
        divergences = compare(snapshot, observed)
        detail: dict[str, Any] = {}
        if observed.error:
            detail["error"] = observed.error[-800:]
        if divergences:
            detail["snapshot"] = str(_snapshot_file(self.id, name).relative_to(ROOT))
        return FixtureOutcome(name, "match" if not divergences else "drift", divergences=divergences, detail=detail)


def compare(snapshot: SideResult, observed: SideResult) -> list[dict[str, Any]]:
    """Exact comparison of a normalized observed result against its snapshot.
    Every difference is reported; there is no approval channel."""
    divergences: list[dict[str, Any]] = []
    if snapshot.ok != observed.ok:
        return [{
            "key": "<outcome>",
            "snapshot": "ok" if snapshot.ok else f"error:{snapshot.error}",
            "observed": "ok" if observed.ok else f"error:{observed.error}",
        }]
    if not snapshot.ok:
        if snapshot.error != observed.error:
            divergences.append({"key": "<error>", "snapshot": snapshot.error, "observed": observed.error})
        return divergences
    for key in sorted(set(snapshot.values) | set(observed.values)):
        left = snapshot.values.get(key)
        right = observed.values.get(key)
        if left != right:
            divergences.append({"key": key, "snapshot": left, "observed": right})
    if sorted(snapshot.unresolved) != sorted(observed.unresolved):
        divergences.append({
            "key": "<unresolved>",
            "snapshot": sorted(snapshot.unresolved),
            "observed": sorted(observed.unresolved),
        })
    return divergences


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
    )


def run_v3_config(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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
        [node, "dist/index.js", "config"],
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


CONFIG_BOUNDARY = Boundary(
    id="config-default-resolution",
    description=(
        "Typed configuration loading and default resolution, including input binding, token fallback, validated enums/numbers/booleans, and secret handling."
    ),
    fixtures_dir="config",
    run=run_v3_config,
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


def run_v3_precheck(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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


PRECHECK_BOUNDARY = Boundary(
    id="precheck-decision",
    description=(
        "Precheck decisions over fixture platform state. Covers unchanged/changed fingerprints, linked-issue label and Linear priority changes, failed metadata lookups, fork-disabled private lookups, forced re-review, unrelated-label no-ops, superseded heads, and GitHub vs Forgejo."
    ),
    fixtures_dir="precheck",
    run=run_v3_precheck,
)


# ---------------------------------------------------------------------------
# Boundary: model request construction (#677)
# ---------------------------------------------------------------------------


def _v3_parity_env() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
        "PR_REVIEWER_V3_MODE": "v3-request-builder",
    }


def run_v3_request(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
    return run_json_runner(
        [node, "dist/index.js", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env=_v3_parity_env(),
    )


MODEL_REQUEST_BOUNDARY = Boundary(
    id="model-request-construction",
    description=(
        "Model request construction for both API formats, covering request shape, temperature omission, token-parameter selection, structured-output modes, and streaming options."
    ),
    fixtures_dir="model-request",
    run=run_v3_request,
)


# ---------------------------------------------------------------------------
# Boundary: verdict parsing (#677)
# ---------------------------------------------------------------------------

def run_v3_verdict(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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
        "Verdict parsing across strict/fenced/prose JSON extraction, findings normalization, and typed failures for empty completions, invalid verdicts, flattened markdown, and endpoint errors."
    ),
    fixtures_dir="verdict-parsing",
    run=run_v3_verdict,
)


# ---------------------------------------------------------------------------
# Boundary: structured required-check coverage (#750)
# ---------------------------------------------------------------------------


def run_v3_required_checks(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/tmp"),
    }
    return run_json_runner(
        [node, "dist/index.js", "required-check-coverage-fixture", str(_fixture_path(fixture))],
        workdir,
        timeout=120,
        env=env,
    )


COVERAGE_BOUNDARY = Boundary(
    id="required-check-coverage",
    description=(
        "Structured required-check coverage, including identity matching against the deterministic must_check list, grounded not_applicable handling, duplicate/unknown/malformed conservatism, and the version-1 coverage artifact."
    ),
    fixtures_dir="required-check-coverage",
    run=run_v3_required_checks,
)


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Boundary: tier-aware tool request budget (#701)
# ---------------------------------------------------------------------------


def run_v3_tool_budget(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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
        "Tier-aware native tool-loop request budgets: primary (24), smart (32), and escalated (40) defaults, explicit overrides, SMART_TOOL_MAX_REQUESTS precedence, the 1..50 hard ceiling, and #702 budget-source provenance. Fixture expectations pin route, budget, and source."
    ),
    fixtures_dir="tool-budget",
    run=run_v3_tool_budget,
)


# ---------------------------------------------------------------------------
# Boundary: classification + role selection (#675)
# ---------------------------------------------------------------------------


def _run_v3_fixture_mode(mode_argv: list[str], fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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
        "Deterministic classification and specialist role selection over fixture inputs. Covers kind precedence (renovate digest-only, dependency upgrades, k8s manifests, security/path kinds), diff-content risk flags and route-signal exclusion, linked-issue label flags, Linear native priority mapping, must-check derivation, linked-metadata uncertainty, trivial zero-selection gates (with summary-cap conservatism), and all-roles fallbacks (unusable input, unknown/no-lane kind, undetermined metadata). Includes #655 GitHub-label and Linear capability cases: enriched canonical labels reach classification and affect risk flags and role selection."
    ),
    fixtures_dir="classification",
    run=run_v3_classification,
)


# ---------------------------------------------------------------------------
# Boundary: requirement ledger (#675)
# ---------------------------------------------------------------------------


def run_v3_requirement_ledger(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["requirement-ledger-fixture"], fixture, workdir)


REQUIREMENT_LEDGER_BOUNDARY = Boundary(
    id="requirement-ledger",
    description=(
        "Deterministic requirement-ledger extraction and fence-safe markdown rendering over standards, linked-issue, and PR-body sources. Covers acceptance/normative/invariant extraction, fenced-block skipping, content-derived ids, cross-source deduplication with merged provenance, truncation caps (entry count, text length, source capacity with reserved docs, markdown byte cap), and hostile content (control characters, backtick runs, heading forgery)."
    ),
    fixtures_dir="requirement-ledger",
    run=run_v3_requirement_ledger,
)


# ---------------------------------------------------------------------------
# Boundary: enrichment normalization (#675)
# ---------------------------------------------------------------------------


def run_v3_enrichment(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["enrichment-fixture"], fixture, workdir)


ENRICHMENT_BOUNDARY = Boundary(
    id="enrichment-normalization",
    description=(
        "Pure enrichment normalization: URL extraction with redirect.github.com normalization, allowlist string parsing, version hints, target-version selection with tail -n1 hint semantics, GHCR image extraction, old-to-new compare-SHA extraction, and release/compare URL classification. DNS resolution and public-IP fetch security are outside this boundary; fetch policy belongs to the platform/tool boundaries."
    ),
    fixtures_dir="enrichment-normalization",
    run=run_v3_enrichment,
)


# ---------------------------------------------------------------------------
# Boundary: repository map (#675)
# ---------------------------------------------------------------------------


from parity_repo_fixture import prepare_repo  # noqa: E402


def run_v3_repo_map(fixture: dict[str, Any], workdir: Path) -> SideResult:
    repo = prepare_repo(workdir / "repo-v3", fixture)
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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
        "Deterministic bounded repository maps using git ls-files seeding, language/important/category classification, bounded depth-major trees, visible truncation, fence-safe JSON/Markdown rendering, and trust framing. Covers mixed-language trees, hostile filenames (backtick runs, newlines, Unicode, fence strings, display caps), every truncation reason, hard markdown byte caps, framed rendering, and clean no-Git failure."
    ),
    fixtures_dir="repo-map",
    run=run_v3_repo_map,
)


# ---------------------------------------------------------------------------
# Boundary: diff priority (class-aware diff truncation)
# ---------------------------------------------------------------------------


def run_v3_diff_priority(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["diff-priority-fixture"], fixture, workdir)


DIFF_PRIORITY_BOUNDARY = Boundary(
    id="diff-priority",
    description=(
        "Class-aware, size-fair diff truncation with per-file chunking, source/bulk/generated ranking, water-filled budgets within a rank, newline-safe clips with per-file notes, omit-below-minimum behavior, bounded omitted-files manifest, and truncate_clean fallback for header-less input and tiny budgets. Outputs are base64 so invalid UTF-8 survives."
    ),
    fixtures_dir="diff-priority",
    run=run_v3_diff_priority,
)


# ---------------------------------------------------------------------------
# Boundary: unresolved review threads (#766)
# ---------------------------------------------------------------------------


def run_v3_review_threads(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["review-threads-fixture"], fixture, workdir)


REVIEW_THREADS_BOUNDARY = Boundary(
    id="review-threads",
    description=(
        "Unresolved review-thread construction with own-finding recognition, unresolved filtering, newest-first ordering, per-body hygiene, whole-thread byte budgets, and the enforcement view."
    ),
    fixtures_dir="review-threads",
    run=run_v3_review_threads,
)


# ---------------------------------------------------------------------------
# Boundary: outstanding human change requests
# ---------------------------------------------------------------------------


def run_v3_human_reviews(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["human-reviews-fixture"], fixture, workdir)


HUMAN_REVIEWS_BOUNDARY = Boundary(
    id="human-reviews",
    description=(
        "Outstanding human change-request construction with managed-review exclusion by marker, latest eligible state per reviewer, COMMENTED/PENDING ignored, newest-first ordering, per-body hygiene, whole-entry byte budgets, head-moved tri-state, and the enforcement view."
    ),
    fixtures_dir="human-reviews",
    run=run_v3_human_reviews,
)


# ---------------------------------------------------------------------------
# Boundary: PR thread context (#675)
# ---------------------------------------------------------------------------


def run_v3_pr_thread(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["pr-thread-fixture"], fixture, workdir)


PR_THREAD_BOUNDARY = Boundary(
    id="pr-thread",
    description=(
        "Bounded PR conversation-comment construction with timestamp/id ordering (unparseable stamps last), managed-comment filtering, marker-line stripping, secret redaction, control-character hygiene, per-comment byte truncation, whole-comment byte budgets with visible omission, and hostile-body handling (backtick fences, forged markers, credential shapes) including custom managed-marker substring mode."
    ),
    fixtures_dir="pr-thread",
    run=run_v3_pr_thread,
)


# ---------------------------------------------------------------------------
# Boundary: related-code context (#675)
# ---------------------------------------------------------------------------


def run_v3_related_code(fixture: dict[str, Any], workdir: Path) -> SideResult:
    repo = prepare_repo(workdir / "repo-v3", fixture)
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
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
        "Deterministic bounded related-code scanning with high-confidence symbol anchors, fixed-string git grep and per-symbol/global caps with extra-hit detection, scored-stem test discovery, nearest-first manifests, changed/deleted path exclusion, secret-redacted snippets, explicit git errors, and a structural JSON byte cap over harness-prepared worktrees."
    ),
    fixtures_dir="related-code",
    run=run_v3_related_code,
)


# ---------------------------------------------------------------------------
# Boundary: change anchors (#706)
# ---------------------------------------------------------------------------


from parity_repo_fixture import prepare_workspace  # noqa: E402


def _resolve_change_anchors_fixture(fixture: dict[str, Any], workdir: Path) -> tuple[dict[str, Any], Path]:
    """Inline a `related_code_fixture` reference (its `source_diff`,
    `repo_files` and expected `anchors`), so the anchors that feed the
    related-code boundary are proven to be what both extractors produce."""
    resolved = {key: value for key, value in fixture.items() if key != "_path"}
    name = fixture.get("related_code_fixture")
    if name:
        source = json.loads((FIXTURES / "related-code" / f"{name}.json").read_text(encoding="utf-8"))
        resolved.setdefault("diff", source["source_diff"])
        resolved.setdefault("repo_files", source["repo_files"])
        resolved["expected_anchors"] = source["anchors"]
    path = workdir / "change-anchors-fixture.json"
    path.write_text(json.dumps(resolved, ensure_ascii=False), encoding="utf-8")
    return resolved, path


def _change_anchors_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
    resolved, fixture_path = _resolve_change_anchors_fixture(fixture, workdir)
    # The frozen v2 side saw this same workspace path, so CLI stderr that
    # echoes it compares without relying on scrubbing.
    workspace = workdir / "change-anchors-ws"
    prepare_workspace(workspace, resolved)
    return run_json_runner(
        [node, "dist/index.js", "change-anchors-fixture", str(fixture_path)],
        workdir,
        timeout=120,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(workdir), "PARITY_REPO_DIR": str(workspace)},
    )


CHANGE_ANCHORS_BOUNDARY = Boundary(
    id="change-anchors",
    description=(
        "Deterministic change-anchor extraction from unified diffs, including C-quoted, renamed, and deleted paths; per-language symbols and imports; head-line verification; #764 enclosing declarations and changed_lines; #791 changed keys, branch keys, and referenced counterparts; caps, low-value filters, and truncation flags; symlink/traversal-safe head reads; persisted JSON and CLI behavior. Fixtures referencing related-code fixtures also verify the produced anchors."
    ),
    fixtures_dir="change-anchors",
    run=_change_anchors_run,
)


# ---------------------------------------------------------------------------
# Boundary: image digest provenance (#675)
# ---------------------------------------------------------------------------


def run_v3_image_provenance(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["image-provenance-fixture"], fixture, workdir)


IMAGE_PROVENANCE_BOUNDARY = Boundary(
    id="image-provenance",
    description=(
        "Image-digest provenance from diff parsing (repository:/tag:/digest:/image: bucketing and old-to-new pairing), registry target routing, manifest/config normalization into OCI label provenance, GitHub compare post-processing, compare-repo resolution (OCI source labels with mismatch detection and image-repo heuristic), and rendered output. Transport fixtures pin injected-fetch request behavior, including cached registry tokens, Bearer/Accept headers, unauthenticated compare, and the request log."
    ),
    fixtures_dir="image-provenance",
    run=run_v3_image_provenance,
)


def run_v3_corpus(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_fixture_mode(["corpus-fixture"], fixture, workdir)


CORPUS_BOUNDARY = Boundary(
    id="corpus-assembly",
    description=(
        "Review-corpus assembly with section order and authority, tier-aware budgets with output-token headroom, raw-source smart rebuild (#658/#668), UTF-8-safe truncation, reserved standards/ledger/specialist sections, tool-harness placeholder and slot semantics, fork gating, and presence signals."
    ),
    fixtures_dir="corpus",
    run=run_v3_corpus,
)

def _run_v3_cli(cli: str, fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
    return run_json_runner([node, "dist/index.js", cli, str(_fixture_path(fixture))], workdir, timeout=120, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(workdir)})


def _conversation_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_cli("conversation-fixture", fixture, workdir)


def _escalation_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_cli("escalation-fixture", fixture, workdir)


def _tool_loop_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_cli("tool-loop-fixture", fixture, workdir)


def _specialist_corpus_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_cli("specialist-corpus-fixture", fixture, workdir)


def _specialist_payload_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_cli("specialist-payload-fixture", fixture, workdir)


def _specialist_normalize_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    return _run_v3_cli("specialist-normalize-fixture", fixture, workdir)

# ---------------------------------------------------------------------------
# Boundaries: enforcement / publishing / metadata (#680)
# ---------------------------------------------------------------------------

ENFORCEMENT_BOUNDARY = Boundary(
    id="enforcement-pipeline",
    description=(
        "Deterministic enforcement: verdict policy (#772/#775 non-blocking category capping with the security-flag exemption and unresolved-check gate), #750 structured required-check completeness with malformed-disposition conservatism, evidence-blocker/tool-harness-failure/min-successful overlays, #770 review-thread settlement (downgrades, re-emitted findings, blocker escalation), #774 human change-request settlement, enforced-banner normalization, and the #624 requirement-coverage fold."
    ),
    fixtures_dir="enforcement-pipeline",
    run=lambda fixture, workdir: _run_v3_cli("enforcement-fixture", fixture, workdir),
)

REQUIREMENT_COVERAGE_BOUNDARY = Boundary(
    id="requirement-coverage",
    description=(
        "Requirement coverage using the tolerant ledger loader and deterministic claim fold: evidence-gated credit, not_applicable downgrades, invariant verification kinds, duplicate and out-of-ledger errors, and visible caps."
    ),
    fixtures_dir="requirement-coverage",
    run=lambda fixture, workdir: _run_v3_cli("requirement-coverage-fixture", fixture, workdir),
)

SANITIZE_BOUNDARY = Boundary(
    id="review-sanitize",
    description=(
        "Publication sanitization: reserved marker stripping, upstream-link neutralization (inert/togithub) with inline-code-span preservation, and fence-aware empty-conditional-section stripping."
    ),
    fixtures_dir="review-sanitize",
    run=lambda fixture, workdir: _run_v3_cli("sanitize-fixture", fixture, workdir),
)

INLINE_FINDINGS_BOUNDARY = Boundary(
    id="inline-findings",
    description=(
        "Inline-finding anchoring with diff-position mapping (GitHub side=RIGHT lines and Forgejo new_position), anchor validation, thread_id deduplication, caps, redaction, and link-mode sanitization of comment bodies."
    ),
    fixtures_dir="inline-findings",
    run=lambda fixture, workdir: _run_v3_cli("inline-findings-fixture", fixture, workdir),
)

METADATA_MARKERS_BOUNDARY = Boundary(
    id="metadata-markers",
    description=(
        "Managed metadata serialization with fixed key order, conditional fields, escalation_reason array, numeric cache_hit_ratio, marker preamble emission, managed-body detection by content prefix, and reserved-marker stripping that prevents model output from forging action-owned markers."
    ),
    fixtures_dir="metadata-markers",
    run=lambda fixture, workdir: _run_v3_cli("metadata-markers-fixture", fixture, workdir),
)


PLATFORM_NORMALIZATION_BOUNDARY = Boundary(
    id="platform-normalization",
    description=(
        "Platform read adapters for GitHub REST/GraphQL and Forgejo /api/v1 responses. Covers PR files, linked issues, conversation comments, review threads, paginated reviews, external checks with self-exclusion and bounded timeouts, linked-source enrichment, and the semantic-fixture adapter; pins normalized values, byte-significant artifacts, and request logs."
    ),
    fixtures_dir="platform-normalization",
    run=lambda fixture, workdir: _run_v3_cli("platform-normalization-fixture", fixture, workdir),
)

PROMPT_ASSEMBLY_BOUNDARY = Boundary(
    id="prompt-assembly",
    description=(
        "Prompt and message assembly from embedded prompt assets: system-prompt resolution and fragments, specialist-leads fragment, user-message construction, model-failure handling, and analysis-engine annotation. Covers fragment gates on/off, verbosity, replace vs append with SYSTEM_PROMPT/SYSTEM_PROMPT_FILE, specialist leads, classification steering, failure notice, engine annotation, and exact system-prompt/user-message bytes plus sha256."
    ),
    fixtures_dir="prompt-assembly",
    run=lambda fixture, workdir: _run_v3_cli("prompt-assembly-fixture", fixture, workdir),
    canonical_json_keys={"failure_notices", "engine_annotations"},
)

LINKED_SOURCES_BOUNDARY = Boundary(
    id="linked-sources",
    description=(
        "Linked-source enrichment with SSRF-safe fetchSource and pinned enrichment clients. Fixture-routed DNS answers, raw HTTP exchanges, GitHub/Forgejo API routes, and a fake budget clock pin linked-sources.md bytes, sorted request logs, and budget-warning counts."
    ),
    fixtures_dir="linked-sources",
    run=lambda fixture, workdir: _run_v3_cli("linked-sources-fixture", fixture, workdir),
)


def _producer_git_env() -> dict[str, str]:
    """Both sides run git against their own prepared worktree; neither may
    see the operator's global/system git config (decoration, quoting, or
    abbreviation settings would change the captured bytes)."""
    return {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "LC_ALL": "C"}


def _context_producers_run(fixture: dict[str, Any], workdir: Path) -> SideResult:
    node = os.environ.get("PARITY_NODE") or shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found (set PARITY_NODE or install Node >= 22)")
    repo_v3 = prepare_repo(workdir / "repo-v3", fixture)
    new = run_json_runner(
        [node, "dist/index.js", "context-producers-fixture", str(_fixture_path(fixture))],
        workdir,
        timeout=180,
        env={
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(workdir),
            "PARITY_REPO_DIR": str(repo_v3),
            **_producer_git_env(),
        },
    )
    # Adversarial containment fixtures (#805) name content that lives outside
    # the worktree behind a symlink: it must never reach the runtime's output.
    for marker in fixture.get("forbidden_output") or []:
        leaked = [key for key, value in new.values.items() if marker in str(value)]
        if leaked or marker in (new.error or ""):
            raise RuntimeError(f"v3 output leaked out-of-checkout content {marker!r} via {leaked or ['<error>']}")
    return new


CONTEXT_PRODUCERS_BOUNDARY = Boundary(
    id="context-producers",
    description=(
        "Deterministic context production over harness-prepared worktrees: changed-manifest generation, repository impact/history scans, linked-issue fetch/render/label merge with Linear metadata, requirement-ledger presence, standards-file resolution, and fence-safe related-code clipping. External seams are stubbed and artifacts are pinned byte-for-byte."
    ),
    fixtures_dir="context-producers",
    run=_context_producers_run,
)

CI_GATE_BOUNDARY = Boundary(
    id="ci-gate",
    description=(
        "CI-gate workload behavior using an injected fetch and virtual clock. Pins exit code, GITHUB_OUTPUT bytes, ci-checks-context.md evidence, leftover temp files, request log, elapsed time, and log lines across green, pending-then-green, failure, timeout with/without skip, mid-wait head change, self-exclusion, and transient-read handling."
    ),
    fixtures_dir="ci-gate",
    run=lambda fixture, workdir: _run_v3_cli("ci-gate-fixture", fixture, workdir),
)

SPECIALISTS_GATE_BOUNDARY = Boundary(
    id="specialists-gate",
    description=(
        "Specialists-gate workload behavior against a local mock model endpoint serving canned per-role responses. Pins per-role request/response/contract JSON, specialists.json/.md, presence file, received request bodies, exit code, and logs; normalizes wall-clock elapsed values and mock port. Covers three_call, auto selection (including zero roles), streamed Anthropic SSE, missing corpus, transport retry, completion-overrun retry, MAX_CORPUS fit check, role reaped at phase deadline, combined_scout success/failure, and raw responses with integer fields sharing names with contract floats."
    ),
    fixtures_dir="specialists-gate",
    run=lambda fixture, workdir: _run_v3_cli("specialists-gate-fixture", fixture, workdir),
)

EVIDENCE_PROVIDERS_BOUNDARY = Boundary(
    id="evidence-providers",
    description=(
        "Evidence-provider orchestration over identical workspaces and real provider processes. Covers config load/validation errors, argv and bash -lc commands, JSON findings parsing, nonzero exits, timeouts, oversize output (mask then truncate), secret redaction, parallel-pool config-order results, fork gating, crash-fallback artifacts, head/tail markdown caps, and byte-exact .md/.json artifacts."
    ),
    fixtures_dir="evidence-providers",
    run=lambda fixture, workdir: _run_v3_cli("evidence-providers-fixture", fixture, workdir),
)

SARIF_BOUNDARY = Boundary(
    id="sarif",
    description=(
        "SARIF ingestion: normalize_sarif level-to-severity mapping, rule lookup by id/index, locations, deduplication, message/title/finding/error caps, plus evidence-provider SARIF handling of workspace-bounded paths, bounded reads, UTF-8/JSON error text, collective finding cap, secret redaction before storage, and rendering."
    ),
    fixtures_dir="sarif",
    run=lambda fixture, workdir: _run_v3_cli("evidence-providers-fixture", fixture, workdir),
)

NEW_BOUNDARIES = (
    Boundary(id="conversation-rendering", description="Conversation wire rendering and corpus deduplication.", fixtures_dir="conversation-rendering", run=_conversation_run, canonical_json_keys={"result"}),
    Boundary(id="escalation-decision", description="Escalation requests and telemetry decisions.", fixtures_dir="escalation-decision", run=_escalation_run, canonical_json_keys={"result"}),
    Boundary(id="tool-loop", description="Native tool-loop deterministic state-machine behavior.", fixtures_dir="tool-loop", run=_tool_loop_run, canonical_json_keys={"result"}),
    Boundary(
        id="specialist-corpus",
        description=(
            "Deep-review specialist corpus construction: the deterministic bounded #632 corpus builder (survival-priority section order, reserved requirement ledger, per-section caps, hard byte cap) and the #758 author-blinded adversarial_correctness variant, compared byte-for-byte with fixture expectations."
        ),
        fixtures_dir="specialist-corpus",
        run=_specialist_corpus_run,
        canonical_json_keys={"result"},
    ),
    Boundary(
        id="specialist-payload",
        description=(
            "Deep-review specialist wire payloads: per-role OpenAI/Anthropic request construction (json_schema-to-json_object downgrade, max_completion_tokens, stream_options) and the one-shot completion-overrun retry payload."
        ),
        fixtures_dir="specialist-payload",
        run=_specialist_payload_run,
        canonical_json_keys={"result"},
    ),
    Boundary(
        id="specialist-normalize",
        description=(
            "Deep-review specialist normalization from raw model output to the normalized version-1 lead artifact (deduplication, caps, severity aliasing), tolerant raw-text parsing, the #758 adversarial-correctness contract (trigger/consequence major-lead demotion, boundaries_challenged), and completion-overrun retry decisions."
        ),
        fixtures_dir="specialist-normalize",
        run=_specialist_normalize_run,
        canonical_json_keys={"result"},
    ),
    ENFORCEMENT_BOUNDARY,
    REQUIREMENT_COVERAGE_BOUNDARY,
    SANITIZE_BOUNDARY,
    INLINE_FINDINGS_BOUNDARY,
    METADATA_MARKERS_BOUNDARY,
    PLATFORM_NORMALIZATION_BOUNDARY,
    PROMPT_ASSEMBLY_BOUNDARY,
    CONTEXT_PRODUCERS_BOUNDARY,
    LINKED_SOURCES_BOUNDARY,
    CI_GATE_BOUNDARY,
    SPECIALISTS_GATE_BOUNDARY,
    EVIDENCE_PROVIDERS_BOUNDARY,
    SARIF_BOUNDARY,
)

BOUNDARIES: tuple[Boundary, ...] = (CONFIG_BOUNDARY, PRECHECK_BOUNDARY, MODEL_REQUEST_BOUNDARY, VERDICT_BOUNDARY, COVERAGE_BOUNDARY, TOOL_BUDGET_BOUNDARY, CLASSIFICATION_BOUNDARY, REQUIREMENT_LEDGER_BOUNDARY, ENRICHMENT_BOUNDARY, REPO_MAP_BOUNDARY, PR_THREAD_BOUNDARY, REVIEW_THREADS_BOUNDARY, HUMAN_REVIEWS_BOUNDARY, DIFF_PRIORITY_BOUNDARY, RELATED_CODE_BOUNDARY, CHANGE_ANCHORS_BOUNDARY, IMAGE_PROVENANCE_BOUNDARY, CORPUS_BOUNDARY, *NEW_BOUNDARIES)

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


def evaluate_boundary(boundary: Boundary, workdir: Path, *, update: bool) -> dict[str, Any]:
    boundary.secret_keys = config_surface().secrets
    outcomes = []
    for fixture in load_fixtures(boundary):
        with tempfile.TemporaryDirectory(prefix="parity-fixture-") as td:
            outcome = boundary.evaluate(fixture, Path(td), update=update)
        outcomes.append({"fixture": outcome.fixture, "status": outcome.status,
                         "divergences": outcome.divergences, "detail": outcome.detail})
    accepted = ("updated",) if update else ("match",)
    return {
        "id": boundary.id,
        "description": boundary.description,
        "fixtures": outcomes,
        "ok": all(o["status"] in accepted for o in outcomes),
    }


def snapshot_gaps() -> dict[str, list[str]]:
    """Fixtures with no snapshot and snapshots with no fixture (orphans), plus
    any fixture or snapshot directory not owned by a registered boundary — a
    retired boundary's leftover snapshots must not sit unpaired and invisible."""
    missing: list[str] = []
    orphans: list[str] = []
    fixture_dirs = {boundary.fixtures_dir for boundary in BOUNDARIES}
    boundary_ids = {boundary.id for boundary in BOUNDARIES}
    for boundary in BOUNDARIES:
        fixtures = {p.stem for p in (FIXTURES / boundary.fixtures_dir).glob("*.json")}
        snapshots = {p.stem for p in (GOLDENS / boundary.id).glob("*.json")} if (GOLDENS / boundary.id).is_dir() else set()
        missing += [f"{boundary.id}/{name}" for name in sorted(fixtures - snapshots)]
        orphans += [f"{boundary.id}/{name}" for name in sorted(snapshots - fixtures)]
    for path in sorted(FIXTURES.iterdir()):
        if path.is_dir() and path.name != GOLDENS.name and path.name not in fixture_dirs:
            orphans += [f"<unregistered-fixtures>/{path.name}"]
    if GOLDENS.is_dir():
        for path in sorted(GOLDENS.iterdir()):
            if path.is_dir() and path.name not in boundary_ids:
                orphans += [f"<unregistered-snapshots>/{path.name}"]
    return {"missing": missing, "orphans": orphans}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundary", action="append", help="restrict to these boundary ids")
    parser.add_argument("--report", help="write the structured snapshot report JSON here")
    parser.add_argument("--update", action="store_true", help="rewrite snapshots from observed v3 results")
    args = parser.parse_args(argv)
    if not (ROOT / "dist" / "index.js").is_file():
        parser.error("dist/index.js is missing; run `npm run build` first")

    selected = tuple(b for b in BOUNDARIES if not args.boundary or b.id in args.boundary)
    if args.boundary and len(selected) != len(args.boundary):
        known = {b.id for b in BOUNDARIES}
        parser.error(f"unknown boundary(s): {sorted(set(args.boundary) - known)}")

    with tempfile.TemporaryDirectory(prefix="snapshot-harness-") as td:
        workdir = Path(td)
        boundaries = [evaluate_boundary(b, workdir, update=args.update) for b in selected]

    first_divergent = next(
        (b["id"] for b in boundaries for f in b["fixtures"] if f["status"] in ("drift", "missing_snapshot", "runner_error")),
        None,
    )
    statuses = [f["status"] for b in boundaries for f in b["fixtures"]]
    report = {
        "schema_version": 2,
        "generator": "tests/parity_harness.py",
        "boundaries": boundaries,
        "first_divergent_boundary": first_divergent,
        "summary": {
            "fixtures": len(statuses),
            "matched": statuses.count("match"),
            "drifted": statuses.count("drift"),
            "missing_snapshots": statuses.count("missing_snapshot"),
            "runner_errors": statuses.count("runner_error"),
            "updated": statuses.count("updated"),
        },
    }
    failures = {"runner_error"} if args.update else {"drift", "missing_snapshot", "runner_error"}
    ok = not any(status in failures for status in statuses)
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    markers = {"match": ".", "drift": "F", "missing_snapshot": "N", "runner_error": "E", "updated": "U"}
    for boundary in boundaries:
        for fixture in boundary["fixtures"]:
            print(f"  [{markers[fixture['status']]}] {boundary['id']}/{fixture['fixture']}: {fixture['status']}")
            for divergence in fixture["divergences"]:
                snapshot = json.dumps(divergence["snapshot"], ensure_ascii=False, sort_keys=True)
                observed = json.dumps(divergence["observed"], ensure_ascii=False, sort_keys=True)
                print(f"      {divergence['key']}: snapshot={snapshot} observed={observed}")
    print(f"snapshots: {'OK' if ok else 'FAILED'} (first divergent boundary: {first_divergent})")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
