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
- Numeric-class config values compare by numeric equality (v2 preserves the
  raw string form, v3 resolves a typed number with canonical formatting);
  everything else compares as an exact canonical string.
- A divergence is only acceptable when it is pinned, with a reason, in
  ``tests/fixtures/parity/approved-divergences.json`` — intentional v3
  contract changes are versioned and visible, never hidden.
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
    if isinstance(value, (int, float)):
        return str(value)
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
    status: str  # match | approved_divergence | drift | runner_error
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
                "detail": f"old ok={left.ok} new ok={right.ok}",
            })
        elif not left.ok:
            left_category = categorize(left.error or "", self.error_categories)
            right_category = categorize(right.error or "", self.error_categories)
            if left_category != right_category:
                divergences.append({
                    "key": "<error-category>",
                    "detail": f"old={left_category} new={right_category}",
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
                    divergences.append({"key": key, "detail": "missing on old side"})
                    continue
                left_text = self.normalize_key(key, left.values[v2_key])
                right_text = self.normalize_key(key, right_value)
                if left_text == right_text or numeric_equal(left_text, right_text):
                    continue
                divergences.append({"key": key, "detail": f"old={left_text!r} new={right_text!r}"})
            if compared == 0:
                divergences.append({"key": "<scope>", "detail": "no keys left in scope; boundary scope collapsed", "approved": False})
        entries = [e for e in load_approved() if e["boundary"] == self.id]
        approved_keys = {e["key"] for e in entries if e.get("fixture") in (None, "*", fixture["fixture"])}
        # Outcome-level drift (one side rejects, the other continues) is
        # approvable when the fixture itself is pinned by named entries: the
        # entries name the inputs whose handling changed and state the reason.
        fixture_pinned = any(e.get("fixture") == fixture["fixture"] for e in entries)
        status = "match"
        if divergences:
            for divergence in divergences:
                if divergence["key"] == "<outcome>":
                    divergence["approved"] = fixture_pinned
                else:
                    divergence["approved"] = divergence["key"] in approved_keys
            status = "approved_divergence" if all(d["approved"] for d in divergences) else "drift"
        expected = fixture.get("expected")
        if expected == "drift":
            if status == "drift":
                # The vulnerable variant diverged exactly as the counterexample
                # requires: the harness detected the broken wiring.
                status = "expected_drift"
                divergences = [{**d, "approved": True} for d in divergences]
            elif status in ("match", "approved_divergence"):
                status = "drift"
                divergences = [{"key": "<counterexample>", "detail": "vulnerable fixture no longer diverges from production; the counterexample stopped reproducing", "approved": False}]
        detail: dict[str, Any] = {}
        if not left.ok and left.error:
            detail["old_error"] = scrub(left.error)[-800:]
        if not right.ok and right.error:
            detail["new_error"] = scrub(right.error)[-800:]
        if left.unresolved or right.unresolved:
            detail["unresolved_bindings"] = sorted(set(left.unresolved) | set(right.unresolved))
        if excluded:
            detail["excluded_keys"] = excluded
        return FixtureOutcome(fixture["fixture"], status, divergences=divergences, detail=detail)

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

    def normalize_key(self, key: str, value: Any) -> str:
        text = canonical(value)
        if key in self.secret_keys:
            return "[REDACTED]" if text != "" else ""
        return scrub(text)


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
        for field_name in ("boundary", "key", "reason"):
            if not entry.get(field_name):
                raise RuntimeError(f"approved-divergences entry missing '{field_name}': {entry}")
    return entries


# ---------------------------------------------------------------------------
# Boundary: config/default resolution
# ---------------------------------------------------------------------------


def load_contract() -> dict[str, Any]:
    return yaml.safe_load(CONTRACT_PATH.read_text())


def config_key_mapping() -> tuple[dict[str, str], set[str]]:
    """Map v3 camelCase config keys to v2 env var names; collect secret keys."""
    schema = (ROOT / "src" / "config" / "schema.ts").read_text()
    match = re.search(r"SECRET_INPUTS = new Set\(\[(.*?)\]\)", schema, re.S)
    if not match:
        raise RuntimeError("SECRET_INPUTS not found in src/config/schema.ts")
    secret_ids = set(re.findall(r'"([^"]+)"', match.group(1)))
    mapping: dict[str, str] = {}
    secrets: set[str] = set()
    for item in load_contract()["inputs"]:
        camel = re.sub(r"-([a-z0-9])", lambda m: m.group(1).upper(), item["id"])
        # The v2 pipeline binds the token input to GH_TOKEN (with the ambient
        # GITHUB_TOKEN as config.sh's fallback), never to GITHUB_TOKEN itself.
        mapping[camel] = "GH_TOKEN" if item["id"] == "github-token" else item["v2_id"].upper()
        if item["id"] in secret_ids:
            secrets.add(camel)
    return mapping, secrets


def run_json_runner(command: list[str], workdir: Path, timeout: int) -> SideResult:
    proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout, cwd=str(ROOT))
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
        "fixture must fail parity (drift is observable, never normalized "
        "away); the fixed variant must pass."
    ),
    fixtures_dir="dataflow-662",
    run=lambda fixture, workdir: (
        make_truncation_runner("old")(fixture, workdir),
        make_truncation_runner("new")(fixture, workdir),
    ),
)

BOUNDARIES: tuple[Boundary, ...] = (CONFIG_BOUNDARY, TRUNCATION_BOUNDARY)


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
    mapping, secrets = config_key_mapping()
    boundary.key_mapping = mapping
    boundary.secret_keys = secrets
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
