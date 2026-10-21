#!/usr/bin/env python3
"""Bounded, offline-first calibration pilot for the confidence scorer (#1074).

The pilot measures how well the production confidence scorer (the
``src/confidence/`` lane) ranks real review outcomes, WITHOUT redesigning
anything in the product: the scorer's prompt, tolerant parser, and
deterministic ceilings are exercised verbatim through a bundled Node bridge
(``scripts/confidence_bridge.mjs`` -> ``scripts/confidence_bridge.ts``), so
the pilot can never drift from the shipped implementation.

Pipeline (each stage is a separate CLI subcommand on this module):

1. ``plan``   -- validate the PREDECLARED sample plan
   (``evals/confidence-calibration/sample-plan.json``): every sample id
   resolvable in the corpora, ceilings present and positive, conditions
   well-formed (live conditions name ENV VARS, never literal credentials; a
   ``key`` field is rejected outright), rubric identity present. Zero
   network.
2. ``review`` -- run the real review pipeline once per sample entry through
   ``scripts/eval_harness.py``'s ``run_review_for_pr`` (the corpus replay
    path). Budget-capped by ``ceilings.max_primary_reviews`` BEFORE any work,
    counting prior spend recorded in the work dir's ``runs.json`` (lifetime
    counter ``lifetime_primary_reviews``; a re-run that would exceed the
    ceiling refuses with exit 3 and zero new harness calls). Requires
    provider credentials in the environment and fails fast without them.
    Per-entry failures are recorded in ``runs.json`` and never retried.
3. ``score``  -- for each entry and selected condition, build the scorer
   prompt from the run's own artifacts via the bridge, obtain a raw answer
   (mock answers file, or EXACTLY ONE live HTTP call per row), and turn it
   into a canonical ConfidenceResult via the bridge's ``apply-score``.
   Budget ceilings are enforced BEFORE each call; an exhausted budget is a
   normal, recorded outcome (``budget_exhausted: true``, exit 0), never an
   error. Every row's prompt text and raw answer are persisted under
   ``<runs-dir>/audit/`` for later adjudication.
4. ``report`` -- render the markdown metrics report from ``results.json``
   (pure functions, importable). It reports, it never judges; exit 0 always.

Trust and security boundaries honored throughout:

- Credentials travel only in HTTP auth headers of the live backend; they
  are never in URLs, request bodies, argv, or any log/diagnostic string.
  Env values are never printed. The driver handles env-var NAMES only.
- NO retries anywhere: a failed live call is recorded ``unscored`` with a
  redacted cause token and never attempted again.
- Untrusted PR/diff/review content is data: the production prompt builder
  envelopes it; this driver only shuttles files.
- The pilot is repository-agnostic: repo identity comes solely from the
  corpus/plan entries, never hardcoded here.

Evidence-state semantics (the honesty spine of the report): rows whose
primary run did not produce parseable review artifacts
(``primary_errored`` / ``primary_artifacts_missing``) are recorded with the
canonical DISABLED scorer result and consume NO scorer call and NO budget —
they are neither scorer failures nor clean controls, and they never enter
any green or clean-pass denominator. The same invariant is enforced in the
report: only ``primary_ok`` rows with ``scorer.status == "scored"`` feed
score denominators.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS_REAL = REPO_ROOT / "evals" / "corpus-real-prs.json"
DEFAULT_CORPUS_HUMAN = REPO_ROOT / "evals" / "corpus-human-findings.json"
BRIDGE_LAUNCHER = REPO_ROOT / "scripts" / "confidence_bridge.mjs"

# The scorer's single bounded completion budget (mirrors
# ``src/confidence/scorer.ts`` CONFIDENCE_MAX_TOKENS).
SCORER_MAX_TOKENS = 1024

ENV_VAR_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
# Condition fields are validated against a per-backend ALLOW-list (see
# ``validate_plan``); anything else is a plan error. That closes the
# deny-list gap: a renamed credential slot (``credential``, ``password``,
# ``sk-…``) cannot masquerade as configuration.
CONDITION_FIELDS_NONE = {"id", "backend", "purpose"}
CONDITION_FIELDS_MOCK = {"id", "backend", "purpose", "answers", "secret_env_names"}
CONDITION_FIELDS_LIVE = {"id", "backend", "purpose", "base_url_env", "model_env", "key_env", "api_format_env", "independence", "secret_env_names"}
# Field names that would carry a literal credential; also any non-path,
# non-caveat string value of >= 20 characters in a live condition is
# rejected as a possible pasted secret.
CREDENTIAL_NAMED_FIELDS = ("key", "api_key", "apikey", "token", "secret", "password", "credential")

REQUIRED_REVIEW_ENV = ("AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "GITHUB_TOKEN")

EXIT_INVALID_PLAN = 2
EXIT_BUDGET_ABORT = 3
EXIT_MISSING_CREDENTIALS = 4

VALID_BACKENDS = ("none", "mock", "live")
LIVE_REQUIRED_ENV_FIELDS = ("base_url_env", "model_env", "key_env", "api_format_env")
API_FORMATS = ("openai", "anthropic")

RISK_BAND_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}
# Expected scorer risk band per the corpus defect's anchor severity
# (#1074): the scorer's own risk assessment is compared against the
# independent defect anchor, and a band strictly LOWER than expected is a
# calibration miss.
EXPECTED_BAND_BY_SEVERITY = {"blocker": "critical", "major": "high", "minor": "medium", "info": "low"}


def _repo_rel(path_text: str) -> str:
    """Render *path_text* relative to the repo root when possible (compact logs)."""
    try:
        return str(Path(path_text).resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path_text)


def _read_json_soft(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ── Corpora ──────────────────────────────────────────────────────────────


def load_corpus_entries(path: Path) -> dict[str, dict[str, Any]]:
    """Load a real-PR corpus file into ``{id: entry}``.

    Both corpora used by the pilot (``evals/corpus-real-prs.json`` and
    ``evals/corpus-human-findings.json``) wrap their entries in a top-level
    ``real_pr_corpus`` object with ``vulnerable``/``clean`` lists; a bare
    ``{vulnerable, clean}`` shape is accepted too so a future corpus file
    does not need reshaping. The kind (vulnerable/clean) is recorded on each
    returned entry under the private ``_pilot_kind`` key.
    """
    data = _read_json_soft(path)
    if not isinstance(data, dict):
        raise ValueError(f"corpus not a JSON object: {_repo_rel(str(path))}")
    corpus = data.get("real_pr_corpus") if isinstance(data.get("real_pr_corpus"), dict) else data
    entries: dict[str, dict[str, Any]] = {}
    for kind in ("vulnerable", "clean"):
        listed = corpus.get(kind)
        if not isinstance(listed, list):
            continue
        for entry in listed:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                record = dict(entry)
                record["_pilot_kind"] = kind
                entries[entry["id"]] = record
    return entries


def collect_sample_entries(plan: dict[str, Any], corpora: dict[str, dict[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Resolve plan sample ids against the corpora, vulnerable first.

    Returns ``[{pr_id, kind, entry}]`` in stable plan order (the order the
    ``review`` stage replays them in). Raises ``ValueError`` when any id is
    unresolvable — plan validation guarantees resolution before this runs.
    """
    sample = plan.get("sample") or {}
    resolved: list[dict[str, Any]] = []
    for kind in ("vulnerable", "clean"):
        for pr_id in sample.get(kind) or []:
            entry = None
            for corpus in corpora.values():
                candidate = corpus.get(pr_id)
                if candidate is not None:
                    entry = candidate
                    break
            if entry is None:
                raise ValueError(f"sample id not resolvable in corpora: {pr_id}")
            resolved.append({"pr_id": pr_id, "kind": entry["_pilot_kind"], "entry": entry})
    return resolved


# ── Plan validation ──────────────────────────────────────────────────────


def validate_plan(plan: dict[str, Any], corpora: dict[str, dict[str, dict[str, Any]]]) -> list[str]:
    """Validate the sample plan; returns a list of human-readable errors.

    Pure function: no filesystem, no network, no environment reads. The
    security-critical rule lives here: live conditions may only NAME env
    vars (uppercase pattern), and any literal-credential slot (a ``key``
    field, or a non-env-shaped value) is a hard plan error — a committed
    credential can never masquerade as configuration.
    """
    errors: list[str] = []
    if plan.get("plan_version") != 1:
        errors.append("plan_version must be 1")
    if plan.get("blinded") is not True:
        errors.append("blinded must be true (scorer inputs exclude corpus defect annotations)")
    rubric = plan.get("rubric")
    if not (isinstance(rubric, dict) and isinstance(rubric.get("id"), str) and rubric["id"].strip()
            and isinstance(rubric.get("source"), str) and rubric["source"].strip()):
        errors.append("rubric identity missing (need non-empty rubric.id and rubric.source)")

    sample = plan.get("sample")
    if not (isinstance(sample, dict) and isinstance(sample.get("vulnerable"), list)
            and isinstance(sample.get("clean"), list)):
        errors.append("sample.vulnerable and sample.clean must be lists")
    else:
        known: set[str] = set()
        for corpus in corpora.values():
            known.update(corpus)
        for kind in ("vulnerable", "clean"):
            for pr_id in sample.get(kind) or []:
                if not isinstance(pr_id, str):
                    errors.append(f"sample.{kind} entry is not a string id")
                elif pr_id not in known:
                    errors.append(f"sample id not resolvable in corpora: {pr_id}")

    ceilings = plan.get("ceilings")
    if not isinstance(ceilings, dict):
        errors.append("ceilings missing")
    else:
        for field in ("max_primary_reviews", "max_scorer_calls", "max_scorer_output_tokens"):
            value = ceilings.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                errors.append(f"ceilings.{field} must be a positive integer")
        wall = ceilings.get("wall_time_budget_sec")
        if not (isinstance(wall, dict) and all(
                isinstance(wall.get(k), (int, float)) and not isinstance(wall.get(k), bool) and wall[k] > 0
                for k in ("review", "score"))):
            errors.append("ceilings.wall_time_budget_sec needs positive review and score values")
        for field in ("request_timeout_sec", "repeats_per_condition"):
            value = ceilings.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
                errors.append(f"ceilings.{field} must be positive")
        if not isinstance(ceilings.get("retries"), str) or "never" not in ceilings["retries"].lower():
            # Documentation-only field, but the pilot's no-retry stance is
            # normative; keep the plan honest about it.
            errors.append('ceilings.retries must state "none" (a failed call is recorded unscored, never retried)')

    conditions = plan.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        errors.append("conditions must be a non-empty list")
        conditions = []
    seen_ids: set[str] = set()
    for condition in conditions:
        if not isinstance(condition, dict):
            errors.append("condition entry is not an object")
            continue
        cid = condition.get("id")
        if not isinstance(cid, str) or not cid.strip():
            errors.append("condition.id missing")
            continue
        if cid in seen_ids:
            errors.append(f"duplicate condition id: {cid}")
        seen_ids.add(cid)
        backend = condition.get("backend")
        if backend not in VALID_BACKENDS:
            errors.append(f"condition {cid}: backend must be one of {VALID_BACKENDS}")
            continue
        # Allow-list per backend: any field outside the shape is an error,
        # and any credential-shaped name or pasted secret is one too.
        allowed = {
            "none": CONDITION_FIELDS_NONE,
            "mock": CONDITION_FIELDS_MOCK,
            "live": CONDITION_FIELDS_LIVE,
        }[backend]
        unknown_fields = set(condition) - allowed
        if unknown_fields:
            errors.append(f"condition {cid}: fields not allowed for backend {backend}: {sorted(unknown_fields)}")
        for field_name in CREDENTIAL_NAMED_FIELDS:
            if field_name in condition:
                errors.append(
                    f"condition {cid}: literal credential/config field '{field_name}' is forbidden; "
                    "live conditions name ENV VARS only"
                )
        for field_name, value in condition.items():
            if field_name in ("purpose", "independence") or not isinstance(value, str):
                continue
            if len(value) >= 20 and field_name not in ("answers",) and not field_name.endswith("_env"):
                errors.append(
                    f"condition {cid}: field '{field_name}' carries a long literal value "
                    "(possible pasted credential); live conditions name ENV VARS only"
                )
        if backend == "live":
            for field in LIVE_REQUIRED_ENV_FIELDS:
                value = condition.get(field)
                if not isinstance(value, str) or not ENV_VAR_NAME_RE.match(value):
                    errors.append(
                        f"condition {cid}: {field} must be an ENV VAR NAME "
                        f"(uppercase pattern), never a literal value"
                    )
            if not isinstance(condition.get("independence"), str) or not condition["independence"].strip():
                errors.append(f"condition {cid}: live conditions must state their independence caveat")
        elif backend == "mock":
            answers = condition.get("answers")
            if not isinstance(answers, str) or not answers.strip():
                errors.append(f"condition {cid}: mock conditions must point at an answers file")
    return errors


def load_and_validate_plan(plan_path: Path, corpora: dict[str, dict[str, dict[str, Any]]]) -> tuple[dict[str, Any], list[str]]:
    data = _read_json_soft(plan_path)
    if not isinstance(data, dict):
        raise ValueError(f"plan not a JSON object: {_repo_rel(str(plan_path))}")
    return data, validate_plan(data, corpora)


def _die_plan_errors(errors: list[str]) -> None:
    for error in errors:
        print(f"plan error: {error}", file=sys.stderr)
    sys.exit(EXIT_INVALID_PLAN)


# ── Bridge invocation ────────────────────────────────────────────────────


def _run_bridge(subcommand: str, request: dict[str, Any], work_dir: Path) -> dict[str, Any]:
    """Run one bridge subcommand; returns the parsed result object.

    The request (including the prompt-bearing inputs) is shuttled through a
    temp file so no untrusted content ever rides argv. The bridge prints a
    single-line JSON result on stdout and a REDACTED failure line on stderr;
    neither ever contains a credential value (secrets are resolved inside
    the bridge process from env names, and the bridge masks them out of the
    prompt before returning it).
    """
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node not found on PATH; the calibration bridge requires Node")
    if not BRIDGE_LAUNCHER.is_file():
        raise RuntimeError(f"bridge launcher missing: {_repo_rel(str(BRIDGE_LAUNCHER))}")
    work_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="bridge-request-", suffix=".json", dir=work_dir)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(request, handle)
        result = subprocess.run(
            [node, str(BRIDGE_LAUNCHER), subcommand, str(tmp_path)],
            capture_output=True, text=True, timeout=120, check=False,
        )
    finally:
        tmp_path.unlink(missing_ok=True)
    if result.returncode != 0:
        # stderr is the bridge's own redacted one-liner; never echo env values.
        raise RuntimeError(f"bridge {subcommand} failed (exit {result.returncode}): {result.stderr.strip()[:200]}")
    try:
        parsed = json.loads(result.stdout)
    except ValueError as exc:
        raise RuntimeError(f"bridge {subcommand} returned unparseable output") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"bridge {subcommand} returned a non-object result")
    return parsed


def build_prompt_via_bridge(request: dict[str, Any], work_dir: Path) -> dict[str, Any]:
    result = _run_bridge("build-prompt", request, work_dir)
    if not (isinstance(result.get("system"), str) and isinstance(result.get("user"), str)):
        raise RuntimeError("bridge build-prompt returned no system/user strings")
    unresolved_pins = result.get("unresolvedPins")
    if not isinstance(unresolved_pins, list) or not all(isinstance(pin, str) for pin in unresolved_pins):
        # The bridge bundles production's ONE pin predicate
        # (`unresolvedConfidencePins`, src/confidence/prompt.ts, emitted as
        # the production camelCase field); a result without it is a
        # bridge-contract violation and fails closed at the call site rather
        # than risking an unanchored scorer call.
        raise RuntimeError("bridge build-prompt returned no unresolvedPins list")
    return {"system": result["system"], "user": result["user"], "unresolved_pins": unresolved_pins}


def apply_score_via_bridge(
    answer: str,
    findings: list[Any],
    coverage: dict[str, Any],
    model: str,
    work_dir: Path,
    secret_env_names: list[str] | None = None,
) -> dict[str, Any]:
    return _run_bridge(
        "apply-score",
        {
            "answer": answer,
            "findings": findings,
            "coverage": coverage,
            "model": model,
            "secret_env_names": secret_env_names or [],
        },
        work_dir,
    )


def review_result_via_bridge(
    verdict: str,
    verdict_policy: str,
    findings: list[Any],
    required_checks: str,
    partial_coverage: bool,
    work_dir: Path,
) -> str:
    """Derive the metadata marker's ``review_result`` through the bridge.

    Mirrors the production ``markerReviewResult`` composition
    (``src/publish/publish.ts:247``) on top of the production
    ``strictReviewResult`` — the deterministic state the scorer prompt
    receives, never the raw verdict.
    """
    result = _run_bridge(
        "review-result",
        {
            "verdict": verdict,
            "verdict_policy": verdict_policy,
            "findings": findings,
            "required_checks": required_checks,
            "partial_coverage": partial_coverage,
            "coverage_unknown": False,
        },
        work_dir,
    )
    value = result.get("review_result")
    if not isinstance(value, str):
        raise RuntimeError("bridge review-result returned no review_result string")
    return value


# ── Disabled scorer result (canonical CONFIDENCE_DISABLED shape) ─────────


def disabled_scorer_result() -> dict[str, Any]:
    """The canonical ``CONFIDENCE_DISABLED`` shape from ``src/confidence/result.ts``.

    Used for the baseline condition and for rows whose primary evidence is
    unusable (the scorer is never invoked on a run that produced no
    reviewable artifacts — those rows are neither scorer failures nor clean
    controls and consume no budget).
    """
    return {
        "status": "disabled",
        "score": None,
        "risk": "",
        "reason": "",
        "concerns": [],
        "model": "",
        "cause": "",
        "caps": [],
    }


# ── Primary-artifact reading ─────────────────────────────────────────────


def read_primary_artifacts(run_dir: Path) -> dict[str, Any]:
    """Read a run's scorer-relevant primary artifacts (fail-soft, never raises).

    Returns ``{verdict, findings, review_summary, required_checks,
    coverage}`` from ``ai-output.json``/``review-coverage.json``. Missing or
    malformed files leave neutral defaults; callers decide evidence_state
    from parseability, never from silent defaults.
    """
    payload = _read_json_soft(run_dir / "ai-output.json")
    coverage = _read_json_soft(run_dir / "review-coverage.json")
    return {
        "verdict": payload.get("verdict") if isinstance(payload, dict) else None,
        "findings": payload.get("findings") if isinstance(payload, dict) else None,
        "review_markdown": payload.get("review_markdown") if isinstance(payload, dict) else None,
        "required_checks": payload.get("required_checks") if isinstance(payload, dict) else None,
        "coverage": coverage if isinstance(coverage, dict) else None,
    }


def primary_evidence_state(run_info: dict[str, Any], run_dir: Path | None) -> str:
    """Classify one entry's primary evidence (pure in its inputs).

    ``primary_ok`` requires a parseable ``ai-output.json`` carrying a
    verdict, a findings list, the required-checks state, AND a parseable
    ``review-coverage.json`` — the scorer's deterministic inputs (the
    ceiling reads coverage) must all be present, or the row would silently
    fail open on the incomplete-coverage ceiling. A partial artifact set is
    not evidence.
    """
    if not run_info.get("ok", False):
        return "primary_errored"
    if run_dir is None or not run_dir.is_dir():
        return "primary_artifacts_missing"
    payload = _read_json_soft(run_dir / "ai-output.json")
    if not (isinstance(payload, dict) and payload.get("verdict") and isinstance(payload.get("findings"), list)):
        return "primary_artifacts_missing"
    if not isinstance(payload.get("required_checks"), str):
        return "primary_artifacts_missing"
    if not isinstance(_read_json_soft(run_dir / "review-coverage.json"), dict):
        return "primary_artifacts_missing"
    return "primary_ok"


def findings_by_severity(findings: list[Any]) -> dict[str, int]:
    counts = {"blocker": 0, "major": 0, "minor": 0, "info": 0}
    for finding in findings:
        if isinstance(finding, dict) and finding.get("severity") in counts:
            counts[finding["severity"]] += 1
    return counts


# ── `plan` subcommand ────────────────────────────────────────────────────


def cmd_plan(args: argparse.Namespace) -> int:
    plan_path = Path(args.plan).resolve()
    corpora: dict[str, dict[str, dict[str, Any]]] = {"real": load_corpus_entries(Path(args.corpus_real).resolve())}
    if args.corpus_human:
        corpora["human"] = load_corpus_entries(Path(args.corpus_human).resolve())
    try:
        plan, errors = load_and_validate_plan(plan_path, corpora)
    except ValueError as exc:
        print(f"plan error: {exc}", file=sys.stderr)
        return EXIT_INVALID_PLAN
    if errors:
        _die_plan_errors(errors)
    sample = plan["sample"]
    print(
        "plan OK: "
        f"vulnerable={len(sample['vulnerable'])} clean={len(sample['clean'])} "
        f"conditions={len(plan['conditions'])} "
        f"max_primary_reviews={plan['ceilings']['max_primary_reviews']} "
        f"max_scorer_calls={plan['ceilings']['max_scorer_calls']} "
        f"repeats={plan['ceilings']['repeats_per_condition']} "
        f"blinded={plan['blinded']} "
        f"digest=sha256:{_sha256_file(plan_path)[:16]}"
    )
    return 0


# ── `review` subcommand ──────────────────────────────────────────────────


def cmd_review(args: argparse.Namespace) -> int:
    plan_path = Path(args.plan).resolve()
    corpora = {"real": load_corpus_entries(Path(args.corpus_real).resolve())}
    if args.corpus_human:
        corpora["human"] = load_corpus_entries(Path(args.corpus_human).resolve())
    try:
        plan, errors = load_and_validate_plan(plan_path, corpora)
        if errors:
            _die_plan_errors(errors)
        samples = collect_sample_entries(plan, corpora)
    except ValueError as exc:
        print(f"review error: {exc}", file=sys.stderr)
        return EXIT_INVALID_PLAN

    ceilings = plan["ceilings"]
    if len(samples) > ceilings["max_primary_reviews"]:
        print(
            f"review aborted: sample count {len(samples)} exceeds "
            f"ceilings.max_primary_reviews={ceilings['max_primary_reviews']}; "
            "no review was started and no budget was spent",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT

    # Fail fast BEFORE any work: the review stage replays real PRs against a
    # real provider, so missing credentials must stop everything up front
    # (and must never be printed).
    missing = [name for name in REQUIRED_REVIEW_ENV if not os.environ.get(name)]
    if missing:
        print(
            "review aborted: required env vars not set: " + ", ".join(missing)
            + " (values are never printed)",
            file=sys.stderr,
        )
        return EXIT_MISSING_CREDENTIALS
    model_config = {
        "model": os.environ["AI_MODEL"],
        "base_url": os.environ["AI_BASE_URL"],
        "api_key": os.environ["AI_API_KEY"],
        "github_token": os.environ["GITHUB_TOKEN"],
    }

    # Lifetime primary-spend carry (same rule as the scorer phase's
    # lifetime_wire_calls): every record in an existing runs.json was one
    # harness attempt against a real provider, so a re-run pointed at a work
    # dir that already holds a prior sweep must refuse BEFORE any provider
    # call once carried spend plus this sweep would exceed
    # max_primary_reviews. The carried count is the larger of the persisted
    # monotone lifetime counter (a rewrite replaces entries; the counter
    # never shrinks) and the count of real attempts in entries, which covers
    # pre-counter files. Only the persisted counter is trusted alone against
    # ``not_run: budget_exhausted`` fillers: those never reached the
    # provider, so counting them would permanently inflate carry via the next
    # persist and refuse runs the ceiling actually allows. Structurally
    # broken entry records still count as spend (fail closed). An unreadable
    # existing runs.json fails closed, never treated as zero.
    work_dir = Path(args.work_dir).resolve()
    runs_path = work_dir / "runs.json"
    carried_primary_reviews = 0
    if runs_path.is_file():
        prior = _read_json_soft(runs_path)
        if not isinstance(prior, dict) or not isinstance(prior.get("entries"), list):
            print(
                f"review aborted: {runs_path} exists but is unreadable or malformed; "
                "prior primary spend cannot be accounted, so no review was "
                "started and no budget was spent",
                file=sys.stderr,
            )
            return EXIT_BUDGET_ABORT
        prior_counter = prior.get("lifetime_primary_reviews") or 0
        if not isinstance(prior_counter, int) or isinstance(prior_counter, bool) or prior_counter < 0:
            print(
                f"review aborted: {runs_path} carries a non-integer lifetime_primary_reviews "
                "value; prior primary spend cannot be trusted, so no review was "
                "started and no budget was spent",
                file=sys.stderr,
            )
            return EXIT_BUDGET_ABORT
        attempted_prior = sum(
            1 for entry in prior["entries"]
            if not isinstance(entry, dict) or not str(entry.get("error") or "").startswith("not_run")
        )
        carried_primary_reviews = max(attempted_prior, prior_counter)
    if carried_primary_reviews + len(samples) > ceilings["max_primary_reviews"]:
        print(
            f"review aborted: {carried_primary_reviews} already-spent primary reviews "
            f"plus {len(samples)} planned exceed "
            f"ceilings.max_primary_reviews={ceilings['max_primary_reviews']}; "
            "no review was started and no budget was spent "
            "(a work dir's lifetime ceiling is shared across invocations)",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT

    # Lazy, path-isolated import: eval_harness is 3.5k lines of replay
    # machinery the plan/report stages never need.
    scripts_dir = Path(__file__).resolve().parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    import eval_harness  # noqa: PLC0415  (lazy by design; see comment above)

    # Only create the work dir once every pre-flight refusal has passed.
    work_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    review_started = time.monotonic()
    wall_budget = float(ceilings["wall_time_budget_sec"]["review"])
    budget_exhausted = False

    def persist() -> None:
        attempted = sum(
            1 for record in records
            if not str(record.get("error") or "").startswith("not_run")
        )
        payload = {
            "mode": args.mode,
            "work_dir": str(work_dir),
            "lifetime_primary_reviews": carried_primary_reviews + attempted,
            "entries": records,
            **({"budget_exhausted": True, "budget_note": budget_note}
               if budget_exhausted else {}),
        }
        runs_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    budget_note = ""
    for sample in samples:
        if time.monotonic() - review_started >= wall_budget:
            # Progressive wall-time trigger, same policy as the score
            # phase: stop starting NEW reviews, record the outcome, never
            # retry. Entries already recorded keep their results.
            budget_exhausted = True
            budget_note = f"wall_time_budget_sec.review={wall_budget:g} elapsed"
            break
        pr_id = sample["pr_id"]
        try:
            _safe_component(pr_id)
        except ValueError as exc:
            print(f"review error: {exc}", file=sys.stderr)
            return EXIT_INVALID_PLAN
        entry_work = work_dir / pr_id
        entry_work.mkdir(parents=True, exist_ok=True)
        record: dict[str, Any] = {
            "pr_id": pr_id,
            "kind": sample["kind"],
            "run_dir": None,
            "ok": False,
            "error": None,
            **({"title": sample["entry"]["title"]} if sample["entry"].get("title") else {}),
        }
        try:
            run = eval_harness.run_review_for_pr(sample["entry"], args.mode, entry_work, model_config)
            record["run_dir"] = str(run.run_dir) if run.run_dir else None
            record["ok"] = run.error is None
            record["error"] = run.error
        except Exception as exc:  # noqa: BLE001 — per-entry failure is data, never a crash
            record["error"] = f"driver exception: {type(exc).__name__}: {exc}"[:500]
        records.append(record)
        persist()
        print(
            f"review {pr_id}: {'ok' if record['ok'] else 'error'} "
            f"({_repo_rel(record['run_dir']) if record['run_dir'] else 'no run dir'})"
        )
    if budget_exhausted:
        for sample in samples[len(records):]:
            records.append({"pr_id": sample["pr_id"], "kind": sample["kind"], "run_dir": None,
                            "ok": False, "error": "not_run: budget_exhausted"})
        persist()
        print(f"review stopped: {budget_note} (remaining entries recorded not_run)", file=sys.stderr)
    ok_count = sum(1 for record in records if record["ok"])
    print(f"review complete: {ok_count}/{len(records)} ok; runs.json at {_repo_rel(str(runs_path))}")
    return 0


# ── Live backend (exactly ONE call per row; no retries, no backoff) ──────


def _no_redirect_opener() -> urllib.request.OpenerDirector:
    """An opener that REFUSES redirects, matching the production transport's
    stance: a 3xx must never silently hand the request — and with it the
    credential — to another host. The default opener follows redirects and
    preserves Authorization/x-api-key across them (CPython only strips
    content headers), which is exactly the leak this closes."""
    class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
            raise urllib.error.HTTPError(req.full_url, code, "redirect refused (pilot never follows redirects)", headers, fp)

    return urllib.request.build_opener(_RefuseRedirect)


def live_request(
    base_url: str, api_format: str, model: str, api_key: str, system: str, user: str, timeout_sec: float
) -> tuple[str | None, dict[str, int] | None, str | None]:
    """One POST to the provider; returns (raw_answer, usage, cause).

    ``cause`` is None on success; otherwise a redacted action-owned token
    (``http_<code>``, ``timeout``, ``transport_error``). NO retries. The key
    travels only in the auth header — never in the URL, body, or any raised
    message this function returns. Endpoint join mirrors the production
    ``resolveEndpoint`` (``src/transport/http.ts``): base with trailing
    slashes trimmed, then ``/messages`` (anthropic — the documented base URL
    already carries ``/v1``) or ``/chat/completions`` (openai). The request
    shape mirrors the production scorer request: no temperature field is
    sent.
    """
    if api_format == "anthropic":
        url = base_url.strip().rstrip("/") + "/messages"
        body = {
            "model": model,
            "system": system,
            "max_tokens": SCORER_MAX_TOKENS,
            "messages": [{"role": "user", "content": user}],
        }
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        }
    else:
        url = base_url.strip().rstrip("/") + "/chat/completions"
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_tokens": SCORER_MAX_TOKENS,
        }
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with _no_redirect_opener().open(request, timeout=timeout_sec) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        # Drain nothing, log nothing provider-side: the status code is the
        # only fact the pilot records from a failure. Redirects land here
        # too (the opener refuses them), so a 3xx is a recorded failure,
        # never a followed hop.
        return None, None, f"http_{exc.code}"
    except (socket.timeout, TimeoutError):
        return None, None, "timeout"
    except urllib.error.URLError as exc:
        if isinstance(getattr(exc, "reason", None), (socket.timeout, TimeoutError)):
            return None, None, "timeout"
        return None, None, "transport_error"
    except OSError:
        return None, None, "transport_error"
    usage = payload.get("usage") if isinstance(payload, dict) else None
    tokens: dict[str, int] | None = None
    if isinstance(usage, dict):
        prompt_tokens = usage.get("prompt_tokens" if api_format == "openai" else "input_tokens")
        completion_tokens = usage.get("completion_tokens" if api_format == "openai" else "output_tokens")
        if isinstance(prompt_tokens, int) and isinstance(completion_tokens, int):
            tokens = {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens}
    return extract_answer_text(payload, api_format), tokens, None


def extract_answer_text(payload: Any, api_format: str) -> str:
    """Pull the model's text out of the provider response shape (fail-soft)."""
    if not isinstance(payload, dict):
        return ""
    if api_format == "anthropic":
        content = payload.get("content")
        if not isinstance(content, list):
            return ""
        return "".join(
            block.get("text", "") for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        return ""
    return message["content"]


# ── `score` subcommand ───────────────────────────────────────────────────


def _safe_component(value: str) -> str:
    """Validate a pr_id/condition_id as a single filesystem path component.

    Operator-authored but still untrusted-by-convention: a ``../`` or
    absolute-looking id must never escape the audit tree or the work dir.
    Returns the value unchanged when safe; raises ValueError otherwise.
    """
    if not value or value in (".", "..") or "/" in value or "\\" in value or Path(value).name != value:
        raise ValueError(f"unsafe path component: {value!r}")
    return value


def _audit_path(audit_dir: Path, pr_id: str, condition_id: str, repeat_index: int) -> Path:
    _safe_component(pr_id)
    _safe_component(condition_id)
    return audit_dir / pr_id / f"{condition_id}-r{repeat_index}.txt"


def _write_audit(path: Path, system: str, user: str, raw_answer: str, note: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    sections = [f"=== system ===\n{system}", f"=== user ===\n{user}"]
    if raw_answer:
        sections.append(f"=== raw answer ===\n{raw_answer}")
    if note:
        sections.append(f"=== note ===\n{note}")
    path.write_text("\n\n".join(sections) + "\n", encoding="utf-8")


def _resolve_condition_path(raw: str, plan_path: Path) -> Path:
    """Resolve a plan-referenced path: absolute as-is, else relative to the
    repo root first (plan files reference repo paths like
    ``evals/confidence-calibration/mock-scorer-answers.json``), then the
    plan's own directory."""
    path = Path(raw)
    if path.is_absolute():
        return path
    if (REPO_ROOT / path).exists():
        return REPO_ROOT / path
    return plan_path.parent / path


def cmd_score(args: argparse.Namespace) -> int:
    plan_path = Path(args.plan).resolve()
    runs_dir = Path(args.runs_dir).resolve()
    corpora = {"real": load_corpus_entries(Path(args.corpus_real).resolve())}
    if args.corpus_human:
        corpora["human"] = load_corpus_entries(Path(args.corpus_human).resolve())
    try:
        plan, errors = load_and_validate_plan(plan_path, corpora)
        if errors:
            _die_plan_errors(errors)
    except ValueError as exc:
        print(f"score error: {exc}", file=sys.stderr)
        return EXIT_INVALID_PLAN
    ceilings = plan["ceilings"]
    all_conditions = {condition["id"]: condition for condition in plan["conditions"]}
    if args.condition:
        selected: list[str] = []
        for cid in args.condition:
            if cid not in all_conditions:
                print(f"score error: unknown condition id: {cid}", file=sys.stderr)
                return EXIT_INVALID_PLAN
            selected.append(cid)
    else:
        selected = [cid for cid, condition in all_conditions.items() if condition["backend"] != "none"]
    if not selected:
        print("score error: no conditions selected", file=sys.stderr)
        return EXIT_INVALID_PLAN
    try:
        for cid in selected:
            _safe_component(cid)
    except ValueError as exc:
        print(f"score error: {exc}", file=sys.stderr)
        return EXIT_INVALID_PLAN

    runs_payload = _read_json_soft(runs_dir / "runs.json")
    if not (isinstance(runs_payload, dict) and isinstance(runs_payload.get("entries"), list)):
        print(f"score error: no readable runs.json under {_repo_rel(str(runs_dir))}", file=sys.stderr)
        return EXIT_INVALID_PLAN
    run_entries = {record["pr_id"]: record for record in runs_payload["entries"] if isinstance(record, dict) and record.get("pr_id")}

    # Path-component validation up front: a hostile or malformed pr_id must
    # be a plan-level rejection, never a mid-loop crash.
    try:
        for pr_id in run_entries:
            _safe_component(pr_id)
    except ValueError as exc:
        print(f"score error: {exc}", file=sys.stderr)
        return EXIT_INVALID_PLAN

    # Pre-flight: every selected live condition needs its four env vars set
    # (NAMES only here; values are read at call time and never printed).
    for cid in selected:
        condition = all_conditions[cid]
        if condition["backend"] != "live":
            continue
        missing = [field for field in LIVE_REQUIRED_ENV_FIELDS if not os.environ.get(condition[field])]
        if missing:
            print(
                f"score aborted: condition {cid} env vars not set: "
                + ", ".join(condition[field] for field in missing)
                + " (values are never printed)",
                file=sys.stderr,
            )
            return EXIT_MISSING_CREDENTIALS
        if os.environ[condition["api_format_env"]] not in API_FORMATS:
            print(
                f"score aborted: condition {cid} api_format env must be one of {API_FORMATS}",
                file=sys.stderr,
            )
            return EXIT_INVALID_PLAN

    repeats = int(args.repeat) if args.repeat is not None else int(ceilings["repeats_per_condition"])
    if repeats < 1:
        print("score error: --repeat must be >= 1", file=sys.stderr)
        return EXIT_INVALID_PLAN

    mock_answers: dict[str, Any] = {}
    for cid in selected:
        condition = all_conditions[cid]
        if condition["backend"] != "mock":
            continue
        answers_path = _resolve_condition_path(condition["answers"], plan_path)
        answers_data = _read_json_soft(answers_path)
        if not isinstance(answers_data, dict):
            print(f"score error: mock answers file unreadable: {_repo_rel(str(answers_path))}", file=sys.stderr)
            return EXIT_INVALID_PLAN
        mock_answers[cid] = answers_data

    rows: list[dict[str, Any]] = []
    audit_dir = runs_dir / "audit"
    phase_start = time.monotonic()

    # Budget projection: every live row is one model call, so the planned
    # call count for this phase is fixed up front. If the phase cannot fit
    # inside the ceilings, the pilot refuses to START rather than stopping
    # mid-plan with partial spend (exit 3, before ANY call). Wall time is
    # the progressive trigger: checked before every call, and exhausting it
    # writes results-so-far with budget_exhausted=true (a normal, recorded
    # outcome, exit 0) while unattempted rows are recorded explicitly as
    # unscored/budget_exhausted — never silently dropped.
    # Cumulative-call accounting: wire attempts already recorded against
    # this output file were real provider calls, so they count against the
    # plan's ceilings on every subsequent --merge invocation. The seed is
    # the larger of the file's row-level wire-attempt sum and the persisted
    # lifetime counter: a merge replaces re-selected conditions' rows
    # wholesale, so the row sum alone would let repeated same-condition
    # re-runs exceed the lifetime ceiling — no call is ever free.
    out_path = Path(args.out).resolve()
    existing_results: dict[str, Any] | None = None
    carried_calls = 0
    if args.merge and out_path.is_file():
        candidate_results = _read_json_soft(out_path)
        if isinstance(candidate_results, dict) and isinstance(candidate_results.get("rows"), list):
            existing_results = candidate_results
            carried_calls = max(
                sum(
                    int(row.get("wire_attempts") or 0)
                    for row in existing_results["rows"]
                    if isinstance(row, dict)
                ),
                int(existing_results.get("lifetime_wire_calls") or 0),
            )

    planned_calls = sum(
        1
        for pr_id in run_entries
        for cid in selected
        for _ in range(repeats)
        if all_conditions[cid]["backend"] == "live"
        and primary_evidence_state(run_entries[pr_id], _resolve_run_dir(runs_dir, run_entries[pr_id])) == "primary_ok"
    )
    calls_made = carried_calls
    if carried_calls + planned_calls > ceilings["max_scorer_calls"]:
        print(
            f"score aborted: {carried_calls} already-spent wire attempts plus {planned_calls} "
            f"planned live calls exceed "
            f"ceilings.max_scorer_calls={ceilings['max_scorer_calls']}; "
            "no call was made and no budget was spent "
            "(reduce --repeat or select fewer conditions with --condition)",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT
    if (carried_calls + planned_calls) * SCORER_MAX_TOKENS > ceilings["max_scorer_output_tokens"]:
        print(
            f"score aborted: {carried_calls} already-spent wire attempts plus {planned_calls} "
            f"planned live calls at {SCORER_MAX_TOKENS} "
            f"completion tokens exceed ceilings.max_scorer_output_tokens="
            f"{ceilings['max_scorer_output_tokens']}; no call was made",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT

    def budget_exhaustion() -> str | None:
        """Progressive triggers checked before each scored call."""
        if calls_made >= ceilings["max_scorer_calls"]:
            return f"max_scorer_calls={ceilings['max_scorer_calls']} reached"
        if calls_made * SCORER_MAX_TOKENS >= ceilings["max_scorer_output_tokens"]:
            return f"max_scorer_output_tokens={ceilings['max_scorer_output_tokens']} reached"
        if time.monotonic() - phase_start >= ceilings["wall_time_budget_sec"]["score"]:
            return f"wall_time_budget_sec.score={ceilings['wall_time_budget_sec']['score']} elapsed"
        return None

    budget_exhausted = False
    abort_note = ""

    ordered_pr_ids = list(run_entries)
    for pr_id in ordered_pr_ids:
        run_info = run_entries[pr_id]
        run_dir = _resolve_run_dir(runs_dir, run_info)
        evidence_state = primary_evidence_state(run_info, run_dir)
        corpus_entry = None
        for corpus in corpora.values():
            if pr_id in corpus:
                corpus_entry = corpus[pr_id]
                break
        if corpus_entry is None and not args.allow_missing_corpus_entry:
            print(
                f"score error: pr_id {pr_id} not resolvable in corpora "
                "(pass --allow-missing-corpus-entry only for synthetic fixture runs)",
                file=sys.stderr,
            )
            return EXIT_INVALID_PLAN
        kind = corpus_entry["_pilot_kind"] if corpus_entry else run_info.get("kind", "unknown")
        defect = corpus_entry.get("defect") if corpus_entry else run_info.get("defect")
        title = (corpus_entry.get("title") if corpus_entry else None) or run_info.get("title") or ""

        for cid in selected:
            condition = all_conditions[cid]
            for repeat_index in range(repeats):
                row: dict[str, Any] = {
                    "pr_id": pr_id,
                    "kind": kind,
                    "repo_full_name": (corpus_entry or run_info).get("repo_full_name", ""),
                    "head_sha": (corpus_entry or run_info).get("head_sha", ""),
                    "condition": cid,
                    "repeat_index": repeat_index,
                    "evidence_state": evidence_state,
                    "primary": {},
                    "scorer": disabled_scorer_result(),
                    "usage": None,
                    "latency_ms": None,
                    "prompt_bytes": None,
                    "wire_attempts": 0,
                    # Report-internal enrichment (not part of the published
                    # row contract): the defect anchor and the primary
                    # findings the report's calibration metrics compare
                    # against, so `report` stays a pure function of
                    # results.json.
                    "_defect": defect or {},
                    "_primary_findings": [],
                }
                # Provenance honesty: rows replayed from the synthetic
                # fixture index are marked as such, so a mock row can never
                # pass for a real corpus entry in the report.
                row["source"] = "fixture" if (runs_payload.get("synthetic") or run_info.get("synthetic")) else "corpus"
                if all_conditions[cid]["backend"] == "none":
                    # The baseline control: no scorer, no env reads, no
                    # budget — it records only the primary's own state.
                    rows.append(row)
                    continue
                if evidence_state != "primary_ok":
                    # No scorer invocation on unusable primary evidence: the
                    # row exists only so the evidence bucket is visible in
                    # the report. It consumes no call, no tokens, no budget.
                    rows.append(row)
                    continue
                primary_artifacts = read_primary_artifacts(run_dir)
                findings = primary_artifacts["findings"] or []
                verdict = primary_artifacts["verdict"] or ""
                coverage = primary_artifacts["coverage"] or {}
                row["_primary_findings"] = findings
                row["primary"] = {
                    "verdict": verdict,
                    "findings_by_severity": findings_by_severity(findings),
                    "required_checks": primary_artifacts["required_checks"] or "none",
                    "verdict_policy": args.verdict_policy,
                }
                # Budget enforcement BEFORE each scored call: an exhausted
                # budget is a normal, recorded outcome — write results-so-far
                # and stop (exit 0), never an error, never a retry. Only live
                # backends spend budget, so zero-cost mock rows are never
                # gated by carried spend.
                if all_conditions[cid]["backend"] == "live":
                    exhaustion = budget_exhaustion()
                    if exhaustion is not None:
                        budget_exhausted = True
                        abort_note = exhaustion
                        break
                try:
                    diff_text = (run_dir / "pr.diff.truncated").read_text(encoding="utf-8", errors="replace")
                except OSError:
                    # Production's own fallback order
                    # (src/run/review.ts): the truncated artifact first,
                    # the full harness diff second.
                    try:
                        diff_text = (run_dir / "pr.diff").read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        diff_text = ""
                try:
                    body_text = (run_dir / "pr-body.txt").read_text(encoding="utf-8", errors="replace")
                except OSError:
                    body_text = ""
                # Masking set: production masks EVERY lane credential for
                # the run (src/run/review.ts ~1578-1584). The pilot's lane
                # set is the primary lane (AI_API_KEY, the credential the
                # primary review used) plus the scorer condition's own
                # key — both resolved as env NAMES here, values inside the
                # bridge. Plan-declared extra names are honored; the mock
                # condition gets at least the primary lane's key, so a
                # credential echoed in PR content never reaches an audit
                # file or (under a live condition) the scorer endpoint
                # unmasked.
                secret_env_names = list(condition.get("secret_env_names") or [])
                if condition["backend"] == "live" and condition["key_env"] not in secret_env_names:
                    secret_env_names.append(condition["key_env"])
                if "AI_API_KEY" not in secret_env_names:
                    secret_env_names.insert(0, "AI_API_KEY")
                # The deterministic review_result state the production
                # marker derives (never the raw verdict). A derivation
                # failure fails the row closed: a degraded prompt input
                # must not look like a scored answer.
                try:
                    partial_coverage = bool(coverage.get("partial_coverage"))
                    derived_review_result = review_result_via_bridge(
                        verdict, args.verdict_policy, findings,
                        primary_artifacts["required_checks"] or "none",
                        partial_coverage, audit_dir,
                    )
                except RuntimeError:
                    row["scorer"] = unscored_row("bridge_review_result_failed", "")
                    rows.append(row)
                    continue
                row["primary"]["review_result"] = derived_review_result
                prompt_request = {
                    "head_sha": row["head_sha"],
                    "base_sha": (corpus_entry or run_info).get("base_sha", ""),
                    "diff": diff_text,
                    "pr_title": title,
                    "pr_body": body_text,
                    "findings": findings,
                    "review_summary": primary_artifacts["review_markdown"] or "",
                    "review_result": derived_review_result,
                    "required_checks": primary_artifacts["required_checks"] or "none",
                    "coverage": coverage,
                    "secret_env_names": secret_env_names,
                }
                started = time.monotonic()
                audit_file = _audit_path(audit_dir, pr_id, cid, repeat_index)
                audit_file.parent.mkdir(parents=True, exist_ok=True)
                try:
                    prompt = build_prompt_via_bridge(prompt_request, audit_file.parent)
                except RuntimeError:
                    row["scorer"] = unscored_row("bridge_build_prompt_failed", "")
                    rows.append(row)
                    continue
                row["prompt_bytes"] = len((prompt["system"] + "\n" + prompt["user"]).encode("utf-8"))
                # Production parity (src/engine/review.ts, #1155): a
                # non-empty unresolved-pins list means the score would grade
                # content this run cannot identify — the run fails to
                # `unscored` WITHOUT calling the model. The predicate is the
                # bridge's own production `unresolvedConfidencePins` output,
                # so gate and rendered `unknown` markers cannot diverge. No
                # wire attempt is recorded: the ceiling bounds real provider
                # calls, and this row made none.
                if prompt["unresolved_pins"]:
                    pins = ", ".join(prompt["unresolved_pins"])
                    row["scorer"] = unscored_row("incomplete_proof_context", "")
                    _write_audit(
                        audit_file,
                        prompt["system"], prompt["user"], "",
                        note=f"unscored cause: incomplete_proof_context (unresolved pins: {pins})",
                    )
                    rows.append(row)
                    continue
                raw_answer = ""
                cause: str | None = None
                model_name = ""
                if condition["backend"] == "mock":
                    answers = mock_answers[cid]
                    key = f"{cid}::{pr_id}::{repeat_index}"
                    if key not in answers:
                        # Fail closed, never silent: a missing canned answer
                        # is an explicit unscored row, not a skip.
                        cause = "mock_missing_answer"
                    else:
                        value = answers[key]
                        if isinstance(value, dict) and "__cause__" in value:
                            cause = str(value["__cause__"])
                        elif isinstance(value, str):
                            raw_answer = value
                        else:
                            cause = "mock_missing_answer"
                else:  # live — exactly ONE wire attempt, no retries, no backoff
                    model_name = os.environ[condition["model_env"]]
                    try:
                        raw_answer, usage, cause = live_request(
                            os.environ[condition["base_url_env"]],
                            os.environ[condition["api_format_env"]],
                            model_name,
                            os.environ[condition["key_env"]],
                            prompt["system"],
                            prompt["user"],
                            float(ceilings["request_timeout_sec"]),
                        )
                    except Exception:  # noqa: BLE001 — any unexpected transport shape degrades to unscored
                        raw_answer, usage, cause = None, None, "transport_error"
                    if usage is not None:
                        row["usage"] = usage
                    # One attempted model call per live row, success or not —
                    # that attempt is what the cost ceilings bound.
                    calls_made += 1
                    row["wire_attempts"] = 1
                latency_ms = int((time.monotonic() - started) * 1000)
                if cause is not None:
                    row["scorer"] = unscored_row(cause, model_name)
                    row["latency_ms"] = latency_ms
                    _write_audit(
                        audit_file,
                        prompt["system"], prompt["user"], "",
                        note=f"unscored cause: {cause}",
                    )
                    rows.append(row)
                    continue
                try:
                    scorer = apply_score_via_bridge(
                        raw_answer, findings, coverage, model_name,
                        audit_file.parent, secret_env_names,
                    )
                except RuntimeError:
                    row["scorer"] = unscored_row("bridge_apply_score_failed", model_name)
                    row["latency_ms"] = latency_ms
                    _write_audit(
                        audit_file,
                        prompt["system"], prompt["user"], raw_answer,
                        note="unscored cause: bridge_apply_score_failed",
                    )
                    rows.append(row)
                    continue
                row["scorer"] = scorer
                row["latency_ms"] = latency_ms
                _write_audit(
                    audit_file,
                    prompt["system"], prompt["user"], raw_answer, "",
                )
                rows.append(row)
            if budget_exhausted:
                break
        if budget_exhausted:
            break

    wall_by_condition: dict[str, float] = {}
    for row in rows:
        if row["latency_ms"] is not None:
            wall_by_condition[row["condition"]] = wall_by_condition.get(row["condition"], 0.0) + row["latency_ms"] / 1000.0
    if budget_exhausted:
        # No silent drops: every (entry, condition, repeat) combination this
        # invocation owned but did not reach gets an explicit unscored row.
        present = {(row["pr_id"], row["condition"], row["repeat_index"]) for row in rows}
        for pr_id in ordered_pr_ids:
            run_info = run_entries[pr_id]
            run_dir = _resolve_run_dir(runs_dir, run_info)
            evidence_state = primary_evidence_state(run_info, run_dir)
            corpus_entry = next(
                (corpus[pr_id] for corpus in corpora.values() if pr_id in corpus), None,
            )
            kind = corpus_entry["_pilot_kind"] if corpus_entry else run_info.get("kind", "unknown")
            for cid in selected:
                for repeat_index in range(repeats):
                    if (pr_id, cid, repeat_index) in present:
                        continue
                    filler: dict[str, Any] = {
                        "pr_id": pr_id, "kind": kind,
                        "repo_full_name": (corpus_entry or run_info).get("repo_full_name", ""),
                        "head_sha": (corpus_entry or run_info).get("head_sha", ""),
                        "condition": cid, "repeat_index": repeat_index,
                        "evidence_state": evidence_state,
                        "primary": {}, "scorer": disabled_scorer_result(),
                        "usage": None, "latency_ms": None, "prompt_bytes": None,
                        "wire_attempts": 0,
                        "_defect": (corpus_entry or {}).get("defect") or run_info.get("defect") or {},
                        "_primary_findings": [],
                        "source": "fixture" if (runs_payload.get("synthetic") or run_info.get("synthetic")) else "corpus",
                    }
                    if evidence_state == "primary_ok" and all_conditions[cid]["backend"] != "none":
                        filler["scorer"] = unscored_row("budget_exhausted", "")
                    rows.append(filler)

    results = {
        "plan": str(plan_path),
        "plan_digest": f"sha256:{_sha256_file(plan_path)[:16]}",
        "conditions": selected,
        "repeats": repeats,
        "repeats_by_condition": {cid: repeats for cid in selected},
        "verdict_policy": args.verdict_policy,
        "rows": rows,
        "budget_exhausted": budget_exhausted,
        "budget_note": abort_note,
        "carried_wire_calls": carried_calls,
        "lifetime_wire_calls": calls_made,
        "wall_time_sec_by_condition": {cid: round(sec, 3) for cid, sec in wall_by_condition.items()},
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if args.merge and existing_results is not None:
        existing = existing_results
        if isinstance(existing.get("rows"), list):
            # Merge scope: rows of conditions re-selected in this invocation
            # are replaced wholesale (a re-run owns its condition); rows of
            # other conditions are kept so two live conditions can share one
            # results file across invocations.
            kept = [row for row in existing["rows"] if isinstance(row, dict) and row.get("condition") not in selected]
            kept_conditions = [
                cid for cid in (existing.get("conditions") or [])
                if isinstance(cid, str) and cid not in selected
            ]
            rows = kept + rows
            results["rows"] = rows
            results["conditions"] = kept_conditions + [cid for cid in selected if cid not in kept_conditions]
            results["budget_exhausted"] = bool(existing.get("budget_exhausted")) or budget_exhausted
            if existing.get("budget_note") and not abort_note:
                results["budget_note"] = existing["budget_note"]
            # Repeats are per-condition after a merge: the top-level scalar
            # would misreport a merged arm's flip-rate denominator.
            repeats_by_condition = dict(existing.get("repeats_by_condition") or {})
            for cid in selected:
                repeats_by_condition[cid] = repeats
            results["repeats_by_condition"] = repeats_by_condition
            wall_by_condition = {}
            for row in rows:
                if row.get("latency_ms") is not None:
                    wall_by_condition[row["condition"]] = (
                        wall_by_condition.get(row["condition"], 0.0) + row["latency_ms"] / 1000.0
                    )
            results["wall_time_sec_by_condition"] = {cid: round(sec, 3) for cid, sec in wall_by_condition.items()}
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(
        f"score complete: {len(rows)} rows -> {_repo_rel(str(out_path))}"
        + (" [budget_exhausted: " + abort_note + "]" if budget_exhausted else "")
    )
    return 0


def _resolve_run_dir(runs_dir: Path, run_info: dict[str, Any]) -> Path | None:
    raw = run_info.get("run_dir")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        candidate = Path(raw)
        path = candidate if candidate.is_absolute() else runs_dir / candidate
        resolved = path.resolve()
    except ValueError:
        return None
    runs_root = runs_dir.resolve()
    if resolved != runs_root and runs_root not in resolved.parents:
        return None
    return path


def unscored_row(cause: str, model: str) -> dict[str, Any]:
    """The canonical ``unscoredConfidenceResult`` shape (mirrors production)."""
    return {
        "status": "unscored",
        "score": None,
        "risk": "unknown",
        "reason": "",
        "concerns": [],
        "model": model,
        "cause": cause,
        "caps": [],
    }


# ── Report metrics (pure functions; importable) ──────────────────────────


def green_eligible(row: dict[str, Any]) -> bool:
    """THE hard invariant, as a predicate: only primary_ok + actually-scored
    rows may ever enter a green or clean-pass denominator."""
    return row.get("evidence_state") == "primary_ok" and row.get("scorer", {}).get("status") == "scored"


def score_distribution(rows: list[dict[str, Any]]) -> dict[str, list[int]]:
    counts = {"vulnerable": [0] * 6, "clean": [0] * 6}
    for row in rows:
        if green_eligible(row) and row.get("kind") in counts:
            counts[row["kind"]][row["scorer"]["score"]] += 1
    return counts


def _denominator(rows: list[dict[str, Any]], kind: str) -> int:
    return sum(1 for row in rows if green_eligible(row) and row.get("kind") == kind)


def false_green(rows: list[dict[str, Any]], threshold: int) -> dict[str, Any]:
    """Defective green-eligible rows scoring >= threshold, overall and
    conditional on the PRIMARY having (wrongly) approved."""
    defective = [row for row in rows if green_eligible(row) and row.get("kind") == "vulnerable"]
    approved = [row for row in defective if row.get("primary", {}).get("verdict") == "approve"]
    return {
        "numerator": sum(1 for row in defective if row["scorer"]["score"] >= threshold),
        "denominator": len(defective),
        "approve_numerator": sum(1 for row in approved if row["scorer"]["score"] >= threshold),
        "approve_denominator": len(approved),
    }


def unnecessary_block(rows: list[dict[str, Any]], threshold: int) -> dict[str, Any]:
    clean = [row for row in rows if green_eligible(row) and row.get("kind") == "clean"]
    return {
        "numerator": sum(1 for row in clean if row["scorer"]["score"] < threshold),
        "denominator": len(clean),
        "high_risk_clean": sum(1 for row in clean if row["scorer"].get("risk") in ("high", "critical")),
    }


def risk_misclassification(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Defective green-eligible rows whose scorer risk band is strictly lower
    than the band the corpus defect's anchor severity implies."""
    evaluated = []
    missed = 0
    unknown_band = 0
    for row in rows:
        if not (green_eligible(row) and row.get("kind") == "vulnerable"):
            continue
        defect = row.get("_defect") or {}
        expected = EXPECTED_BAND_BY_SEVERITY.get(str(defect.get("severity", "")).lower())
        if expected is None:
            continue
        evaluated.append(row)
        actual = row["scorer"].get("risk")
        if actual == "unknown":
            unknown_band += 1
        if RISK_BAND_RANK.get(actual, -1) < RISK_BAND_RANK[expected]:
            missed += 1
    return {"missed": missed, "denominator": len(evaluated), "unknown_band": unknown_band}


def _suffix_matches(candidate: str, target: str) -> bool:
    return bool(candidate) and bool(target) and candidate.lower().endswith(target.lower())


def novel_concern_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Scored rows where the scorer attached a concern on the defect file the
    primary findings never named — flagged for human adjudication, never
    auto-credited (a novel concern is a hypothesis, not a verified finding)."""
    candidates = []
    for row in rows:
        if not (green_eligible(row) and row.get("kind") == "vulnerable"):
            continue
        defect = row.get("_defect") or {}
        defect_file = str(defect.get("file", "")).strip()
        if not defect_file:
            continue
        concerns = row["scorer"].get("concerns") or []
        concern_files = [str(concern.get("file", "")) for concern in concerns if isinstance(concern, dict)]
        if not any(_suffix_matches(name, defect_file) for name in concern_files):
            continue
        primary_findings = row.get("_primary_findings") or []
        primary_files = [str(finding.get("file", "")) for finding in primary_findings if isinstance(finding, dict)]
        if any(_suffix_matches(name, defect_file) for name in primary_files):
            continue
        candidates.append({
            "pr_id": row["pr_id"],
            "condition": row["condition"],
            "repeat_index": row["repeat_index"],
            "defect_file": defect_file,
            "concern_files": concern_files,
        })
    return candidates


def flip_rates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For (pr, condition) groups with >=2 SCORED repeats: differing score
    pairs over total consecutive pairs."""
    groups: dict[tuple[str, str], list[int | None]] = {}
    for row in rows:
        if green_eligible(row):
            groups.setdefault((row["pr_id"], row["condition"]), []).append(row["scorer"]["score"])
    report = []
    for (pr_id, condition), scores in sorted(groups.items()):
        if len(scores) < 2:
            continue
        pairs = differing = 0
        for left, right in zip(scores, scores[1:]):
            pairs += 1
            if left != right:
                differing += 1
        report.append({"pr_id": pr_id, "condition": condition, "differing_pairs": differing, "total_pairs": pairs})
    return report


def unscored_causes(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    causes: dict[str, dict[str, int]] = {}
    for row in rows:
        scorer = row.get("scorer", {})
        if scorer.get("status") != "unscored":
            continue
        per_condition = causes.setdefault(row["condition"], {})
        per_condition[scorer.get("cause") or "unknown"] = per_condition.get(scorer.get("cause") or "unknown", 0) + 1
    return causes


def evidence_state_counts(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    counts: dict[str, dict[str, int]] = {}
    for row in rows:
        per_condition = counts.setdefault(row["condition"], {})
        per_condition[row["evidence_state"]] = per_condition.get(row["evidence_state"], 0) + 1
    return counts


def cost_table(rows: list[dict[str, Any]], wall_by_condition: dict[str, float] | None = None) -> dict[str, dict[str, Any]]:
    """Cost per condition. ``calls`` counts attempted MODEL calls — one per
    live row regardless of outcome (a 429 is an attempt; mock rows are local
    bridge applications and cost nothing, recorded explicitly so a zero is
    never mistaken for missing data). ``completion_tokens`` sums only
    provider-reported usage."""
    table: dict[str, dict[str, Any]] = {}
    for row in rows:
        entry = table.setdefault(row["condition"], {"calls": 0, "completion_tokens": 0, "wall_seconds": 0.0})
        entry["calls"] += int(row.get("wire_attempts") or 0)
        if row.get("usage"):
            entry["completion_tokens"] += row["usage"].get("completion_tokens") or 0
        if row.get("latency_ms") is not None:
            entry["wall_seconds"] += row["latency_ms"] / 1000.0
    for entry in table.values():
        entry["wall_seconds"] = round(entry["wall_seconds"], 3)
    if wall_by_condition:
        for cid, seconds in wall_by_condition.items():
            if cid in table and seconds:
                table[cid]["wall_seconds"] = round(seconds, 3)
    return table


def render_report(results: dict[str, Any]) -> str:
    rows = results.get("rows", [])
    conditions = results.get("conditions", [])
    lines: list[str] = []
    lines.append("# Confidence-scorer calibration pilot report (#1074)")
    lines.append("")
    lines.append(f"- Plan: `{results.get('plan', '?')}` ({results.get('plan_digest', 'no digest')})")
    lines.append(f"- Generated: {results.get('generated_at', '?')}")
    repeats_by_condition = results.get("repeats_by_condition")
    if isinstance(repeats_by_condition, dict) and repeats_by_condition:
        lines.append(
            "- Repeats per condition: "
            + ", ".join(f"`{cid}`={count}" for cid, count in sorted(repeats_by_condition.items()))
        )
    else:
        lines.append(f"- Repeats per condition: {results.get('repeats', '?')}")
    if results.get("budget_exhausted"):
        lines.append(
            f"- **BUDGET EXHAUSTED** during scoring ({results.get('budget_note', '')}); "
            "unattempted rows are recorded as explicit `unscored`/`budget_exhausted` rows below."
        )
    lines.append(
        "- HARD INVARIANT: unscored, disabled, and missing-evidence rows NEVER enter "
        "green or clean-pass denominators; only `primary_ok` rows with "
        "`scorer.status == \"scored\"` are counted."
    )
    lines.append(
        "- LIMIT NOTE: false-green@t is measured on the POST-ceiling score — rows where the "
        "primary itself reported blocker/major findings are bounded by deterministic ceilings, "
        "so the metric is only fully live on rows where the primary found nothing severe."
    )
    sources: dict[str, dict[str, int]] = {}
    for row in rows:
        per_condition = sources.setdefault(row["condition"], {})
        per_condition[row.get("source") or "unknown"] = per_condition.get(row.get("source") or "unknown", 0) + 1
    lines.append(
        "- Row provenance: "
        + "; ".join(
            f"`{cid}` " + ", ".join(f"{source}={count}" for source, count in sorted(sources.get(cid, {}).items()))
            for cid in conditions
        )
    )
    lines.append("")
    lines.append("## Evidence states")
    lines.append("")
    for cid in conditions:
        counts = evidence_state_counts(rows).get(cid, {})
        total = sum(counts.values())
        lines.append(f"- `{cid}` (all rows: {total}): " + ", ".join(f"{state}={count}" for state, count in sorted(counts.items())))
    lines.append("")
    # Quality metrics are PER CONDITION: pooling arms would average away the
    # exact comparison the issue asks for (same-model vs heterogeneous).
    for cid in conditions:
        subset = [row for row in rows if row["condition"] == cid]
        lines.append(f"## Condition `{cid}` — quality metrics (scored rows only)")
        lines.append("")
        distributions = score_distribution(subset)
        for kind in ("vulnerable", "clean"):
            counts = distributions[kind]
            denom = sum(counts)
            lines.append(
                f"- `{kind}` scored rows (denominator: {denom}): "
                + " ".join(f"{s}={n}" for s, n in enumerate(counts))
            )
        for threshold in (4, 5):
            fg = false_green(subset, threshold)
            ub = unnecessary_block(subset, threshold)
            lines.append(
                f"- false_green@{threshold}: {fg['numerator']}/{fg['denominator']} defective scored rows "
                f"(score >= {threshold}); conditional on primary verdict == approve: "
                f"{fg['approve_numerator']}/{fg['approve_denominator']}"
            )
            lines.append(
                f"- unnecessary_block@{threshold}: {ub['numerator']}/{ub['denominator']} clean scored rows "
                f"(score < {threshold}); clean rows with risk high/critical: {ub['high_risk_clean']}"
            )
        misclass = risk_misclassification(subset)
        lines.append(
            f"- risk-band calibration: risk strictly below the defect-anchored expected band "
            f"(blocker->critical, major->high, minor->medium): "
            f"{misclass['missed']}/{misclass['denominator']} "
            f"(unknown-band rows among them: {misclass['unknown_band']})"
        )
        lines.append("- Novel-concern candidates (flagged for adjudication, never auto-credited):")
        candidates = novel_concern_candidates(subset)
        if not candidates:
            lines.append("  - none")
        for candidate in candidates:
            lines.append(
                f"  - {candidate['pr_id']} r{candidate['repeat_index']}: concern on defect file "
                f"`{candidate['defect_file']}`; primary findings do not name it"
            )
        lines.append("- Score flip rate (repeat pairs):")
        flips = [flip for flip in flip_rates(subset) if flip["condition"] == cid]
        if not flips:
            lines.append("  - no groups with >=2 scored repeats")
        for flip in flips:
            lines.append(
                f"  - {flip['pr_id']}: {flip['differing_pairs']}/{flip['total_pairs']} pairs differ"
            )
        lines.append("")
    lines.append("## Unscored causes (per condition)")
    lines.append("")
    causes = unscored_causes(rows)
    if not causes:
        lines.append("- none")
    for cid in conditions:
        if cid in causes:
            lines.append(f"- `{cid}`: " + ", ".join(f"{cause}={count}" for cause, count in sorted(causes[cid].items())))
    lines.append("")
    lines.append("## Cost per condition")
    lines.append("")
    lines.append("| condition | model calls | completion tokens | wall seconds |")
    lines.append("|---|---|---|---|")
    costs = cost_table(rows, results.get("wall_time_sec_by_condition"))
    for cid in conditions:
        entry = costs.get(cid, {"calls": 0, "completion_tokens": 0, "wall_seconds": 0.0})
        lines.append(f"| {cid} | {entry['calls']} | {entry['completion_tokens']} | {entry['wall_seconds']} |")
    lines.append("")
    return "\n".join(lines)


def cmd_report(args: argparse.Namespace) -> int:
    results = _read_json_soft(Path(args.results).resolve())
    if not isinstance(results, dict) or not isinstance(results.get("rows"), list):
        print(f"report error: unreadable results file: {args.results}", file=sys.stderr)
        return EXIT_INVALID_PLAN
    report = render_report(results)
    if args.out:
        out_path = Path(args.out).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(report + "\n", encoding="utf-8")
        print(f"report written: {_repo_rel(str(out_path))}")
    else:
        sys.stdout.write(report)
    return 0


# ── CLI wiring ───────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else "confidence calibration pilot")
    sub = parser.add_subparsers(dest="command", required=True)

    plan_p = sub.add_parser("plan", help="validate the sample plan (zero network)")
    plan_p.add_argument("--plan", required=True)
    plan_p.add_argument("--corpus-real", default=str(DEFAULT_CORPUS_REAL))
    plan_p.add_argument("--corpus-human", default=None)
    plan_p.set_defaults(func=cmd_plan)

    review_p = sub.add_parser("review", help="run the primary review lane once per sample (requires credentials)")
    review_p.add_argument("--plan", required=True)
    review_p.add_argument("--work-dir", required=True)
    review_p.add_argument("--mode", default="tools_off", choices=["tools_off", "native_loop"])
    review_p.add_argument("--corpus-real", default=str(DEFAULT_CORPUS_REAL))
    review_p.add_argument("--corpus-human", default=None)
    review_p.set_defaults(func=cmd_review)

    score_p = sub.add_parser("score", help="produce scorer rows for each entry x condition x repeat")
    score_p.add_argument("--plan", required=True)
    score_p.add_argument("--runs-dir", required=True)
    score_p.add_argument("--out", required=True)
    score_p.add_argument("--condition", action="append", default=None)
    score_p.add_argument("--repeat", type=int, default=None)
    score_p.add_argument("--verdict-policy", default="strict",
                         choices=["strict", "findings_severity_gated", "model"],
                         help="verdict policy used to derive the marker's review_result "
                              "(the v3 runtime default is strict)")
    score_p.add_argument("--merge", action="store_true",
                         help="merge into an existing results file: rows of re-selected conditions "
                              "are replaced, rows of other conditions are kept")
    score_p.add_argument("--allow-missing-corpus-entry", action="store_true",
                         help="accept synthetic fixture entries absent from the corpora (mock-only operation)")
    score_p.add_argument("--corpus-real", default=str(DEFAULT_CORPUS_REAL))
    score_p.add_argument("--corpus-human", default=None)
    score_p.set_defaults(func=cmd_score)

    report_p = sub.add_parser("report", help="render the markdown metrics report (exit 0 always)")
    report_p.add_argument("--results", required=True)
    report_p.add_argument("--out", default=None)
    report_p.set_defaults(func=cmd_report)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
