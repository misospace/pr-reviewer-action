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
   error. Every row's prompt text and the CREDENTIAL-MASKED copy of its
   answer are persisted under ``<runs-dir>/audit/`` for later adjudication
   (the raw provider answer stays in memory and is never written to disk).
   The scorer's call ceiling is a LIFETIME bound for the runs dir: the
   spent calls are recorded in ``<runs-dir>/scorer-spend.json`` and a
   re-run that would exceed the ceiling refuses with exit 3 and zero
   provider calls.
4. ``report`` -- render the markdown metrics report from ``results.json``
   (pure functions, importable). It reports, it never judges; exit 0 always.

Trust and security boundaries honored throughout:

- The live scorer call runs on the PRODUCTION typed Node transport
  (``src/transport/``) inside the bridge: the credential crosses the seam
  only as the NAME of its env var, is resolved in the bridge process, and
  travels only in the provider's auth header — never in URLs, request
  bodies, argv, or any log/diagnostic string. Env values are never
  printed and never written to disk: the persisted audit answer is the
  credential-masked copy the bridge produces with production's own
  ``redactTextDeep``. The driver handles env-var NAMES only.
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
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CORPUS_REAL = REPO_ROOT / "evals" / "corpus-real-prs.json"
DEFAULT_CORPUS_HUMAN = REPO_ROOT / "evals" / "corpus-human-findings.json"
BRIDGE_LAUNCHER = REPO_ROOT / "scripts" / "confidence_bridge.mjs"

# The scorer's documented DEFAULT completion budget, used as the projection
# fallback when a run declares no ``ai-confidence-max-tokens``. #1387 made
# this default single-sourced in production: ``src/routing/tiers.ts`` resolves
# its profile defaults (and the disabled profile) from
# ``src/confidence/scorer.ts`` CONFIDENCE_MAX_TOKENS — the constant named
# below — so this fallback mirrors what production actually resolves, and
# ``tests/test_confidence_calibration.py::test_scorer_max_tokens_matches_production``
# pins both the value and the resolver's use of that single source.
SCORER_MAX_TOKENS = 4096


def _declared_completion_budget(confidence_env: Any) -> tuple[int, bool]:
    """Resolve ONE condition's projected per-call completion budget the way
    production's resolver treats a declared value (#1387).

    ``positiveIntFrom`` (``src/routing/tiers.ts``) accepts only a
    positive-integer string within JavaScript's safe-integer range and
    otherwise keeps the documented default — so an unusable or absent
    declaration projects at SCORER_MAX_TOKENS, the same fallback the
    resolver resolves. Returns ``(tokens, declared)``.
    """
    raw = str((confidence_env or {}).get("AI_CONFIDENCE_MAX_TOKENS", "")).strip()
    # [0-9], not \\d: JS /^\d+$/ is ASCII-only, and Python's \\d would
    # accept Unicode decimal digits the resolver's regex rejects.
    if re.fullmatch(r"[0-9]+", raw):
        value = int(raw)
        if 1 <= value <= 2**53 - 1:
            return value, True
    return SCORER_MAX_TOKENS, False


def project_spend_budget(conditions: list[dict[str, Any]]) -> dict[str, Any]:
    """The per-call completion budget the spend projection must use, plus a
    record of WHICH budgets it projected against (#1387).

    A run's declared ``ai-confidence-max-tokens`` is what the live request
    actually spends: the bridge resolves declared ``ai-confidence-*`` config
    through production's ``resolveConfidenceProfile``, whose defaults now
    come from the same single source this module's fallback mirrors. The
    projection takes the MAX over conditions — a conservative ceiling:
    production's context-window clamps (#1368) can only LOWER a resolved
    budget, never raise it above the declared/default value.
    """
    per_condition: list[dict[str, Any]] = []
    projected = 0
    any_declared = False
    for condition in conditions:
        tokens, declared = _declared_completion_budget(condition.get("confidence_env"))
        per_condition.append({
            "id": str(condition.get("id", "")),
            "completion_tokens_per_call": tokens,
            "basis": "declared" if declared else "documented-default",
        })
        projected = max(projected, tokens)
        any_declared = any_declared or declared
    if not per_condition:
        projected = SCORER_MAX_TOKENS
    return {
        "completion_tokens_per_call": projected,
        "basis": "declared" if any_declared else "documented-default",
        "per_condition": per_condition,
    }


# The per-pilot lifetime scorer-spend ledger, stored in the RUNS DIR (the
# pilot instance): the scorer's call ceiling is a lifetime bound for that
# instance across invocations, so the carried spend must live next to the
# runs it accounts for — not only inside a results file that a plain
# re-run never reads.
SCORER_SPEND_FILENAME = "scorer-spend.json"

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


def _run_bridge(subcommand: str, request: dict[str, Any], work_dir: Path, timeout_sec: float = 120) -> dict[str, Any]:
    """Run one bridge subcommand; returns the parsed result object.

    The request (including the prompt-bearing inputs) is shuttled through a
    temp file so no untrusted content ever rides argv. The bridge prints a
    single-line JSON result on stdout and a REDACTED failure line on stderr;
    neither ever contains a credential value (secrets are resolved inside
    the bridge process from env names, and the bridge masks them out of the
    prompt before returning it). ``timeout_sec`` bounds the subprocess: the
    default covers the prompt/parse subcommands, and the live path passes
    its own (its transport timeout plus a fixed startup margin).
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
            capture_output=True, text=True, timeout=timeout_sec, check=False,
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
# The live scorer call is executed by the PRODUCTION typed Node transport
# (``src/transport/``) inside the bridge process — the same
# ``buildModelRequest`` + ``runChatRequestOnce`` single-shot path the
# runtime scorer uses: one wire attempt, no retry loop, non-2xx (including
# 3xx) is a typed failure that is never followed, and the credential rides
# only the provider's auth header. The driver below shuttles the
# credential's env NAME only; its value is resolved in the bridge and never
# touches this process's argv, files, or output.


def live_request_via_bridge(
    base_url: str,
    api_format: str,
    model: str,
    key_env: str,
    system: str,
    user: str,
    request_timeout_sec: float,
    secret_env_names: list[str],
    work_dir: Path,
) -> tuple[str | None, dict[str, int] | None, str | None, str, str]:
    """One live scorer call through the production typed Node transport.

    Calls the bridge's ``live-request`` subcommand, which sends the request
    with ``runChatRequestOnce`` (``src/transport/transport.ts``): exactly
    one wire attempt, no retries, no backoff. The credential crosses the
    seam as the NAME of its env var (``key_env``) only; the bridge resolves
    the value and it travels only in the provider's auth header.

    Returns ``(raw_answer, usage, cause, diagnostic, masked_answer)``:
    ``cause`` is None on
    success; otherwise the production scorer's redacted action-owned token
    (``http_<code>``, ``timeout``, ``response_too_large``,
    ``transport_error``) — the same mapping ``src/confidence/scorer.ts``
    applies. ``diagnostic`` is the bridge's secret-masked transport detail
    (empty when the bridge reported none). A malformed bridge result raises
    ``RuntimeError``; the call site degrades to ``transport_error`` and
    records ``unscored``.

    ``masked_answer`` is the credential-masked COPY of the answer (the
    bridge's ``masked_answer``, produced with production's own
    ``redactTextDeep``): the raw answer stays in memory for scoring, and
    only the masked copy is ever persisted.
    """
    result = _run_bridge(
        "live-request",
        {
            "base_url": base_url,
            "api_format": api_format,
            "model": model,
            "key_env": key_env,
            "system": system,
            "user": user,
            "request_timeout_sec": request_timeout_sec,
            "connect_timeout_sec": 10,
            "secret_env_names": list(secret_env_names),
        },
        work_dir,
        # The transport tears the request down at request_timeout_sec; the
        # margin only covers Node startup and the bundled-bridge load.
        timeout_sec=request_timeout_sec + 30,
    )
    answer = result.get("answer")
    cause = result.get("cause")
    usage = result.get("usage")
    diagnostic = result.get("diagnostic")
    if not isinstance(diagnostic, str):
        diagnostic = ""
    masked_answer = result.get("masked_answer")
    if not isinstance(masked_answer, str):
        masked_answer = ""
    if not isinstance(answer, (str, type(None))):
        raise RuntimeError("bridge live-request returned a malformed result (answer)")
    if not isinstance(cause, (str, type(None))):
        raise RuntimeError("bridge live-request returned a malformed result (cause)")
    if usage is not None:
        if not isinstance(usage, dict):
            usage = None
        else:
            prompt_tokens = usage.get("prompt_tokens")
            completion_tokens = usage.get("completion_tokens")
            # JSON providers may state the count as a float (``20.0``);
            # production normalization passes any JSON number through.
            # Degrade an unusable usage object to None (the row still
            # scores, the cost column simply omits it) instead of failing
            # a successful answer closed.
            def _token_count(value: Any) -> int | None:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    return None
                if not float(value).is_integer() or value < 0:
                    return None
                return int(value)

            prompt_count = _token_count(prompt_tokens)
            completion_count = _token_count(completion_tokens)
            if prompt_count is None or completion_count is None:
                usage = None
            else:
                usage = {"prompt_tokens": prompt_count, "completion_tokens": completion_count}
    return answer, usage, cause, diagnostic, masked_answer


# ── `score` subcommand ───────────────────────────────────────────────────


def _safe_component(value: str) -> str:
    """Validate a pr_id/condition_id as a single filesystem path component.

    Operator-authored but still untrusted-by-convention: a ``../`` or
    absolute-looking id must never escape the audit tree or the work dir,
    and a NUL byte must never reach a filesystem call (a NUL-bearing id
    raises deep inside ``mkdir`` instead of being rejected up front, which
    would turn a hostile id into a mid-loop crash instead of a plan-level
    rejection). Returns the value unchanged when safe; raises ValueError
    otherwise.
    """
    if (
        not value
        or value in (".", "..")
        or "/" in value
        or "\\" in value
        or "\x00" in value
        or Path(value).name != value
    ):
        raise ValueError(f"unsafe path component: {value!r}")
    return value


def _audit_path(audit_dir: Path, pr_id: str, condition_id: str, repeat_index: int) -> Path:
    _safe_component(pr_id)
    _safe_component(condition_id)
    return audit_dir / pr_id / f"{condition_id}-r{repeat_index}.txt"


def _write_audit(path: Path, system: str, user: str, answer: str, note: str) -> None:
    """Persist one row's audit trail.

    The answer section holds the CREDENTIAL-MASKED copy of the provider
    answer (the bridge's ``masked_answer``) for live rows — the raw answer
    stays in memory and is never written to disk, so a provider that echoes
    the credential cannot leave it in cleartext in the audit tree. Mock rows
    have no provider and no credential, so their canned answer is written
    as-is.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    sections = [f"=== system ===\n{system}", f"=== user ===\n{user}"]
    if answer:
        sections.append(f"=== answer ===\n{answer}")
    if note:
        sections.append(f"=== note ===\n{note}")
    path.write_text("\n\n".join(sections) + "\n", encoding="utf-8")


def _bounded_diagnostic(text: str, limit: int = 400) -> str:
    """One-line, length-bounded operator diagnostic.

    The bridge's diagnostic is already secret-masked; this only keeps it a
    single line and bounded so a provider-authored detail can never bloat
    (or structure) the audit note.
    """
    flattened = " ".join(str(text or "").split())
    return flattened[:limit]


def _write_scorer_spend(path: Path, lifetime_wire_calls: int) -> None:
    """Persist the per-pilot scorer spend ledger atomically.

    The ledger is written BEFORE the provider call it accounts for, so a
    crash can never leave an unmetered call behind, and it is replaced
    atomically (temp file in the same directory + ``os.replace``) so a
    reader never observes a half-written counter. The persisted value only
    ever grows.
    """
    payload = {"version": 1, "lifetime_wire_calls": int(lifetime_wire_calls)}
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with tmp_path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.write("\n")
        os.replace(tmp_path, path)
    except OSError:
        tmp_path.unlink(missing_ok=True)
        raise


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

    # Per-pilot lifetime scorer-spend ledger (#1182 review): the scorer's
    # call ceiling is a LIFETIME bound for the RUNS DIR (the pilot
    # instance), not a per-invocation one, so the carried spend lives in the
    # runs dir itself — the results file's own counter only accounts for
    # the file it was written to, and a plain re-run never reads it. An
    # unreadable or malformed ledger fails closed: an unaccountable spend
    # record must never be treated as zero spend.
    spend_path = runs_dir / SCORER_SPEND_FILENAME
    ledger_calls = 0
    if spend_path.is_file():
        ledger = _read_json_soft(spend_path)
        counter = ledger.get("lifetime_wire_calls") if isinstance(ledger, dict) else None
        if not isinstance(counter, int) or isinstance(counter, bool) or counter < 0:
            print(
                f"score aborted: {spend_path} exists but is unreadable or malformed; "
                "prior scorer spend cannot be accounted, so no call was made "
                "and no budget was spent",
                file=sys.stderr,
            )
            return EXIT_BUDGET_ABORT
        ledger_calls = counter

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
    # re-runs exceed the lifetime ceiling — no call is ever free. The
    # runs dir's own spend ledger (the lifetime bound for the pilot
    # instance) is the other side of that max: it covers a plain re-run
    # that never reads a results file.
    out_path = Path(args.out).resolve()
    existing_results: dict[str, Any] | None = None
    merge_row_sum = 0
    if args.merge and out_path.is_file():
        candidate_results = _read_json_soft(out_path)
        if isinstance(candidate_results, dict) and isinstance(candidate_results.get("rows"), list):
            existing_results = candidate_results
            merge_row_sum = max(
                sum(
                    int(row.get("wire_attempts") or 0)
                    for row in existing_results["rows"]
                    if isinstance(row, dict)
                ),
                int(existing_results.get("lifetime_wire_calls") or 0),
            )
    carried_calls = max(ledger_calls, merge_row_sum)

    planned_calls = sum(
        1
        for pr_id in run_entries
        for cid in selected
        for _ in range(repeats)
        if all_conditions[cid]["backend"] == "live"
        and primary_evidence_state(run_entries[pr_id], _resolve_run_dir(runs_dir, run_entries[pr_id])) == "primary_ok"
    )
    calls_made = carried_calls
    # The running lifetime total persisted in the runs dir's spend ledger:
    # monotone, never below the carried spend.
    ledger_total = ledger_calls
    # #1387: project against the budgets the run actually resolves. A pilot
    # live condition declares no ai-confidence-* config, so every live arm
    # projects at the single-source documented default the bridge's
    # live-request sends; the record states which budgets were projected.
    projected_budget = project_spend_budget(
        [all_conditions[cid] for cid in selected if all_conditions[cid]["backend"] == "live"]
    )
    projected_tokens = projected_budget["completion_tokens_per_call"]
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
    if (carried_calls + planned_calls) * projected_tokens > ceilings["max_scorer_output_tokens"]:
        print(
            f"score aborted: {carried_calls} already-spent wire attempts plus {planned_calls} "
            f"planned live calls at {projected_tokens} "
            f"completion tokens exceed ceilings.max_scorer_output_tokens="
            f"{ceilings['max_scorer_output_tokens']}; no call was made",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT

    def budget_exhaustion() -> str | None:
        """Progressive triggers checked before each scored call."""
        if calls_made >= ceilings["max_scorer_calls"]:
            return f"max_scorer_calls={ceilings['max_scorer_calls']} reached"
        if calls_made * projected_tokens >= ceilings["max_scorer_output_tokens"]:
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
                diagnostic = ""
                masked_answer = ""
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
                    # The call runs on the production typed transport inside
                    # the bridge: only the credential's env NAME crosses the
                    # seam, the lane masking set travels by name, and the
                    # timeout pair bounds the single wire attempt.
                    model_name = os.environ[condition["model_env"]]
                    # Record the spend BEFORE the call: a call that is never
                    # recorded can never be bounded, so the ledger write
                    # happens first and a failed write stops the sweep
                    # (exit 3) instead of spending unmetered.
                    ledger_total = max(ledger_total, carried_calls) + 1
                    try:
                        _write_scorer_spend(spend_path, ledger_total)
                    except OSError as exc:
                        print(
                            "score aborted: the scorer spend ledger could not be "
                            f"written ({type(exc).__name__}); no call was made and "
                            "no budget was spent",
                            file=sys.stderr,
                        )
                        return EXIT_BUDGET_ABORT
                    try:
                        raw_answer, usage, cause, diagnostic, masked_answer = live_request_via_bridge(
                            os.environ[condition["base_url_env"]],
                            os.environ[condition["api_format_env"]],
                            model_name,
                            condition["key_env"],
                            prompt["system"],
                            prompt["user"],
                            float(ceilings["request_timeout_sec"]),
                            secret_env_names,
                            audit_file.parent,
                        )
                    except Exception:  # noqa: BLE001 — any unexpected transport shape degrades to unscored
                        raw_answer, usage, cause, diagnostic, masked_answer = (
                            None, None, "transport_error", "", "",
                        )
                    if usage is not None:
                        row["usage"] = usage
                    # One attempted model call per live row, success or not —
                    # that attempt is what the cost ceilings bound.
                    calls_made += 1
                    row["wire_attempts"] = 1
                # What the audit file may hold: for a live row only the
                # credential-masked copy of the answer (the raw answer stays
                # in memory for scoring); a mock row has no provider and no
                # credential, so its canned answer is written as-is.
                audit_answer = (
                    masked_answer
                    if condition["backend"] == "live"
                    else raw_answer
                )
                latency_ms = int((time.monotonic() - started) * 1000)
                if cause is not None:
                    row["scorer"] = unscored_row(cause, model_name)
                    row["latency_ms"] = latency_ms
                    note = f"unscored cause: {cause}"
                    if condition["backend"] == "live" and diagnostic:
                        # The masked transport detail stays on disk (the
                        # audit tree), never on stdout.
                        note += f" — diagnostic: {_bounded_diagnostic(diagnostic)}"
                    _write_audit(
                        audit_file,
                        prompt["system"], prompt["user"], "",
                        note=note,
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
                        prompt["system"], prompt["user"], audit_answer,
                        note="unscored cause: bridge_apply_score_failed",
                    )
                    rows.append(row)
                    continue
                row["scorer"] = scorer
                row["latency_ms"] = latency_ms
                _write_audit(
                    audit_file,
                    prompt["system"], prompt["user"], audit_answer, "",
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
        "projected_budget": projected_budget,
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


# ── #1370 production-shape canary ─────────────────────────────────────────
#
# A small, bounded live canary of the REPAIRED post-review merge-safety
# verifier (#1368/#1369) over RETAINED primary-review artifacts, before
# advisory dogfood. Acceptance check, not a calibration study (#1370):
#
# - The persisted primary reviews are REUSED (``--artifacts-dir`` points at
#   a completed pilot work dir, read-only); no primary model is re-run.
# - Every verifier call runs the PRODUCTION verifier path end to end via
#   the bridge's ``live-scorer`` subcommand: ``resolveConfidenceProfile``
#   over the plan-DECLARED ``ai-confidence-*`` config (ambient shell state
#   stripped), the engine's eligibility gates, ``buildConfidencePrompt`` at
#   the resolved budget, ``runConfidenceScorer`` itself, and the engine's
#   credential-masking pass. No bridge-side request-shape override exists:
#   effort, budgets, structured output, timeout, and the tokens-param
#   convention are whatever the declared config resolves to.
# - Labels stay blinded: verifier inputs carry only the run's own
#   artifacts (diff, PR text, findings, summary, coverage, verdict state) —
#   never the corpus defect anchor, which rides only in the offline
#   ``_defect`` row enrichment for adjudication.
# - Exactly one wire attempt per (entry, condition) pair, no retries. A
#   declared FALLBACK condition runs for an entry ONLY when the primary
#   condition's row came back not scored (the #1370 allowance: operational
#   no-result is rerun, observations are not swept) — declared up front,
#   never improvised.
# - The verifier call ceiling is a LIFETIME bound for the canary work dir
#   (the same spend-ledger mechanism as the pilot), and the exact retained
#   artifacts are pinned by digest (runs.json + per-row artifact files) in
#   the results record.

CANARY_CONFIDENCE_ENV_KEYS = {
    "AI_CONFIDENCE_MODEL",
    "AI_CONFIDENCE_BASE_URL",
    "AI_CONFIDENCE_API_FORMAT",
    "AI_CONFIDENCE_REASONING_EFFORT",
    "AI_CONFIDENCE_MAX_TOKENS",
    "AI_CONFIDENCE_PROMPT_TOKENS",
    "AI_CONFIDENCE_MODEL_CONTEXT_TOKENS",
    "AI_CONFIDENCE_ANTHROPIC_EFFORT_SUPPORT",
    "AI_CONFIDENCE_STRUCTURED_OUTPUT_SUPPORT",
    "AI_CONFIDENCE_TIMEOUT_SEC",
    "AI_CONFIDENCE_ENABLE_FOR_FORKS",
}

CANARY_CONDITION_FIELDS = {"id", "backend", "role", "fallback_for", "purpose", "confidence_env", "key_env", "secret_env_names"}
CANARY_MAX_ENTRIES = 6
CANARY_MAX_CONDITIONS = 4
# The resolved publish modes the engine's confidence eligibility gate accepts
# (src/publish/publish.ts publishStepRuns). The plan declares the exact
# resolved mode of each retained production run — no retained artifact
# records it, so plan declaration + validation IS the run-state proof; the
# bridge passes the value verbatim to the same predicate, never a default.
CANARY_PUBLISH_MODES = ("comment", "review_comment", "review_verdict", "review_blockers")


def _validate_canary_plan(plan: Any, corpus: dict[str, dict[str, Any]]) -> list[str]:
    """Validate the canary plan shape; returns a list of plan errors.

    Deliberately narrower than the pilot plan: a canary is a small fixed
    set with declared, observable verifier config — the validation enforces
    exactly that shape and nothing else.
    """
    errors: list[str] = []
    if not isinstance(plan, dict):
        return ["plan must be a JSON object"]
    if plan.get("plan_version") != 1:
        errors.append("plan_version must be 1")
    if plan.get("kind") != "production-shape canary":
        errors.append("kind must be 'production-shape canary'")
    if plan.get("blinded") is not True:
        errors.append("blinded must be true (labels never reach the verifier inputs)")
    rubric = plan.get("rubric")
    if not (isinstance(rubric, dict) and rubric.get("id") == "merge-readiness-verifier-v1"):
        errors.append("rubric.id must pin the production rubric 'merge-readiness-verifier-v1'")
    if not isinstance(plan.get("production_shape"), str) or not plan["production_shape"]:
        errors.append("production_shape must declare the verifier path (bridge live-scorer)")
    if not isinstance(plan.get("corpus_shortfall"), str) or not plan["corpus_shortfall"]:
        errors.append("corpus_shortfall must document the known-defective/clean shortfall")

    entries = plan.get("entries")
    if not (isinstance(entries, list) and 1 <= len(entries) <= CANARY_MAX_ENTRIES):
        errors.append(f"entries must be a list of 1..{CANARY_MAX_ENTRIES} row ids")
    else:
        for entry in entries:
            if not (isinstance(entry, dict) and isinstance(entry.get("pr_id"), str)):
                errors.append("every entry must be an object with pr_id")
                continue
            corpus_entry = corpus.get(entry["pr_id"])
            if corpus_entry is None:
                errors.append(f"entry {entry['pr_id']} is not resolvable in the corpus")
            else:
                # Exact head/base pinning (#1370) starts at the plan: a row
                # whose corpus record cannot prove both SHAs is not evidence
                # about a PR, so it can never be a canary row.
                for pin in ("head_sha", "base_sha"):
                    if not str(corpus_entry.get(pin) or ""):
                        errors.append(f"entry {entry['pr_id']} corpus record has no {pin} pin")
            if not isinstance(entry.get("expectation"), str) or not entry["expectation"]:
                errors.append(f"entry {entry.get('pr_id')} must declare its expectation label")
            # The resolved publish mode of the retained production run: no
            # retained artifact records it, so the plan declares it and this
            # validation is the run-state proof. Unknown values are refused
            # here — the bridge passes the value verbatim to the production
            # predicate, and an unprovable mode must fail the PLAN, not the
            # predicate.
            if entry.get("publish_mode") not in CANARY_PUBLISH_MODES:
                errors.append(
                    f"entry {entry.get('pr_id')} must declare publish_mode as one of {list(CANARY_PUBLISH_MODES)} "
                    "(the exact resolved mode of the retained production run)"
                )

    ceilings = plan.get("ceilings")
    if not isinstance(ceilings, dict):
        errors.append("ceilings must be an object")
        ceilings = {}
    for key in ("max_verifier_calls", "max_output_tokens", "wall_time_budget_sec", "request_timeout_sec"):
        value = ceilings.get(key)
        if not (isinstance(value, int) and not isinstance(value, bool) and value >= 1):
            errors.append(f"ceilings.{key} must be a positive integer")
    if isinstance(ceilings.get("max_verifier_calls"), int) and ceilings["max_verifier_calls"] > 12:
        errors.append("ceilings.max_verifier_calls must stay <= 12 (a canary, not a sweep)")

    conditions = plan.get("conditions")
    condition_ids: list[str] = []
    primary_ids: list[str] = []
    if not (isinstance(conditions, list) and 1 <= len(conditions) <= CANARY_MAX_CONDITIONS):
        errors.append(f"conditions must be a list of 1..{CANARY_MAX_CONDITIONS} declared conditions")
        conditions = []
    for condition in conditions:
        if not isinstance(condition, dict):
            errors.append("every condition must be an object")
            continue
        unknown = set(condition) - CANARY_CONDITION_FIELDS
        if unknown:
            errors.append(f"condition has unknown fields: {sorted(unknown)}")
        cid = condition.get("id")
        if not isinstance(cid, str) or not cid:
            errors.append("every condition needs a string id")
            continue
        try:
            _safe_component(cid)
        except ValueError:
            errors.append(f"condition id is not a safe path component: {cid!r}")
        if cid in condition_ids:
            errors.append(f"duplicate condition id: {cid}")
        condition_ids.append(cid)
        if condition.get("backend") != "live":
            errors.append(f"condition {cid}: canary conditions are live (backend=live)")
        role = condition.get("role", "primary")
        if role not in ("primary", "fallback"):
            errors.append(f"condition {cid}: role must be primary or fallback")
        if role == "fallback":
            target = condition.get("fallback_for")
            if not (isinstance(target, str) and target):
                errors.append(f"condition {cid}: fallback needs fallback_for")
            else:
                primary_ids.append(f"__fallback_for__{target}")
        else:
            primary_ids.append(cid)
        confidence_env = condition.get("confidence_env")
        if not isinstance(confidence_env, dict) or not confidence_env:
            errors.append(f"condition {cid}: confidence_env must be a non-empty object of declared ai-confidence-* values")
            confidence_env = {}
        for key, value in confidence_env.items():
            if key not in CANARY_CONFIDENCE_ENV_KEYS:
                errors.append(f"condition {cid}: confidence_env key is not a declared ai-confidence-* input: {key}")
            elif not isinstance(value, str):
                errors.append(f"condition {cid}: confidence_env value for {key} must be a string")
            elif key == "AI_CONFIDENCE_API_KEY":
                # The allowlist already rejects this name; the explicit check
                # documents WHY: a credential value never travels in a plan.
                errors.append(f"condition {cid}: confidence_env must never carry {key} (use key_env)")
        if not str(confidence_env.get("AI_CONFIDENCE_MODEL", "")):
            errors.append(f"condition {cid}: confidence_env must declare AI_CONFIDENCE_MODEL")
        base_url = str(confidence_env.get("AI_CONFIDENCE_BASE_URL", ""))
        if base_url and not condition.get("key_env"):
            errors.append(
                f"condition {cid}: a declared AI_CONFIDENCE_BASE_URL needs key_env "
                "(a distinct endpoint never inherits the primary credential)"
            )
        timeout_raw = confidence_env.get("AI_CONFIDENCE_TIMEOUT_SEC")
        if timeout_raw is not None:
            try:
                if int(timeout_raw) > int(ceilings.get("request_timeout_sec", 0)):
                    errors.append(
                        f"condition {cid}: declared AI_CONFIDENCE_TIMEOUT_SEC exceeds ceilings.request_timeout_sec"
                    )
            except (TypeError, ValueError):
                errors.append(f"condition {cid}: AI_CONFIDENCE_TIMEOUT_SEC must be an integer")
        key_env = condition.get("key_env")
        if key_env is not None:
            if not (isinstance(key_env, str) and ENV_VAR_NAME_RE.fullmatch(key_env)):
                errors.append(f"condition {cid}: key_env must be an env-var NAME")
        secret_env_names = condition.get("secret_env_names", [])
        if not (isinstance(secret_env_names, list) and all(
            isinstance(name, str) and ENV_VAR_NAME_RE.fullmatch(name) for name in secret_env_names
        )):
            errors.append(f"condition {cid}: secret_env_names must be a list of env-var NAMES")
        # "$NAME" indirection: a confidence_env value that is exactly "$NAME"
        # resolves from the operator environment at run time (endpoint URLs,
        # model ids) so the committed plan carries no infrastructure values.
        for key, value in confidence_env.items():
            if isinstance(value, str) and value.startswith("$") and not ENV_VAR_NAME_RE.fullmatch(value[1:]):
                errors.append(f"condition {cid}: {key} $-reference must name an env var, got {value!r}")
    for marker in primary_ids:
        if marker.startswith("__fallback_for__") and marker[len("__fallback_for__"):] not in primary_ids:
            errors.append(f"fallback_for names an unknown primary condition: {marker[len('__fallback_for__'):]}")
    return errors


def live_scorer_via_bridge(request: dict[str, Any], work_dir: Path, timeout_sec: float) -> dict[str, Any]:
    """One production-shape verifier call through the bridge's ``live-scorer``.

    The bridge resolves the profile from the declared config, applies the
    engine's gates, builds the prompt at the resolved budget, dispatches
    ``runConfidenceScorer`` (exactly one wire attempt), and applies the
    engine's masking pass — all production code. Returns the bridge's result
    object; a malformed shape raises ``RuntimeError`` (the row degrades to
    ``unscored`` with a recorded cause, never a crash).
    """
    result = _run_bridge("live-scorer", request, work_dir, timeout_sec=timeout_sec)
    required = ("enabled", "rubric_version", "warnings", "review_result", "unresolved_pins", "profile", "result")
    if not all(key in result for key in required):
        raise RuntimeError("bridge live-scorer returned a malformed result (missing keys)")
    if not isinstance(result["result"], dict) or "status" not in result["result"]:
        raise RuntimeError("bridge live-scorer returned a malformed result (verifier result)")
    if not isinstance(result["profile"], dict):
        raise RuntimeError("bridge live-scorer returned a malformed result (profile)")
    return result


def _canary_row(
    pr_id: str,
    kind: str,
    expectation: str,
    condition: dict[str, Any],
    evidence_state: str,
    corpus_entry: dict[str, Any] | None,
    run_info: dict[str, Any],
    run_dir: Path | None,
    verdict_policy: str,
    ceilings: dict[str, Any],
    work_dir: Path,
    audit_dir: Path,
    reserve_slot: Any,
    publish_mode: str,
) -> tuple[dict[str, Any], int]:
    """Build and execute one canary row; returns (row, wire_attempts).

    ``wire_attempts`` is 1 when a spend slot was RESERVED and the bridge was
    dispatched — the reservation happens BEFORE the wire (write-first) and
    stays consumed whatever happens after (provider failure, parse failure,
    bridge crash) — and 0 for every no-dispatch path (unusable evidence,
    pin verification failure, unavailable ledger). The caller owns the
    ``reserve_slot`` callback: it durably records one call slot against the
    lifetime ceiling and returns False when the ledger cannot be written.
    ``publish_mode`` is the plan-declared resolved publish mode of the
    retained production run (validated at plan level).
    """
    condition_id = condition["id"]
    row: dict[str, Any] = {
        "pr_id": pr_id,
        "kind": kind,
        "expectation": expectation,
        "source": "corpus",
        "condition": condition_id,
        "role": condition.get("role", "primary"),
        "evidence_state": evidence_state,
        "head_sha": (corpus_entry or {}).get("head_sha", ""),
        "base_sha": (corpus_entry or {}).get("base_sha", ""),
        "retained_pins": None,
        "is_fork_pr": None,
        "publish_mode": publish_mode,
        "primary": {"verdict_policy": verdict_policy},
        "verifier": disabled_scorer_result(),
        "profile": None,
        "rubric_version": None,
        "warnings": [],
        "wire_effort": None,
        "usage": None,
        "latency_ms": None,
        "prompt_bytes": None,
        "diagnostic": "",
        "wire_attempts": 0,
        "artifact_digests": {},
        # Report-internal adjudication enrichment: the corpus defect anchor
        # NEVER enters the verifier inputs (blinding is structural — the
        # bridge request carries only the run's own artifacts).
        "_defect": (corpus_entry or {}).get("defect") or {},
        "_primary_findings": [],
    }
    if evidence_state != "primary_ok":
        return row, 0
    assert run_dir is not None
    primary_artifacts = read_primary_artifacts(run_dir)
    findings = primary_artifacts["findings"] or []
    verdict = primary_artifacts["verdict"] or ""
    coverage = primary_artifacts["coverage"] or {}
    row["_primary_findings"] = findings
    row["primary"].update({
        "verdict": verdict,
        "findings_by_severity": findings_by_severity(findings),
        "required_checks": primary_artifacts["required_checks"] or "none",
    })
    # Exact head+base pinning for REUSED artifacts (#1370): the retained run
    # must be the review OF the corpus-pinned head AGAINST the corpus-pinned
    # base, read from the runtime's OWN request record
    # (`review-request.json`: `head_sha` + `base_ref` — the pins the retained
    # review was actually produced against, not a replayed PR payload). The
    # verifier row then carries the VERIFIED pins into its request. A missing
    # or pinless record, or either mismatch, fails the row closed with ZERO
    # wire calls: reused artifacts that cannot prove both pins are not
    # evidence about that PR, whatever their diffs contain.
    request_record = _read_json_soft(run_dir / "review-request.json")
    retained_head = ""
    retained_base = ""
    if isinstance(request_record, dict):
        retained_head = str(request_record.get("head_sha") or "")
        retained_base = str(request_record.get("base_ref") or "")
    row["retained_pins"] = {"head_sha": retained_head, "base_sha": retained_base}
    if not retained_head or not retained_base:
        row["verifier"] = unscored_row("retained_pins_unreadable", "")
        row["diagnostic"] = "retained review-request.json is missing or pinless; head+base cannot be verified"
        return row, 0
    if retained_head != row["head_sha"]:
        row["verifier"] = unscored_row("retained_head_mismatch", "")
        row["diagnostic"] = f"retained head {retained_head[:12]} != corpus head {row['head_sha'][:12]}"
        return row, 0
    if retained_base != row["base_sha"]:
        row["verifier"] = unscored_row("retained_base_mismatch", "")
        row["diagnostic"] = f"retained base {retained_base[:12]} != corpus base {row['base_sha'][:12]}"
        return row, 0
    # The retained run's RESOLVED fork state — the same request record's
    # `is_fork_pr`. The bridge must never guess: the resolver treats any
    # non-"true" flag as same-repo, so an unknown value would silently send
    # privileged review content to the scorer endpoint on what may be a fork
    # PR. Unreadable state fails the row closed with ZERO wire calls.
    retained_fork = str(request_record.get("is_fork_pr") or "")
    if retained_fork not in ("true", "false"):
        row["verifier"] = unscored_row("retained_fork_state_unknown", "")
        row["diagnostic"] = f"retained is_fork_pr {retained_fork!r} is not exactly 'true'/'false'"
        return row, 0
    row["is_fork_pr"] = retained_fork
    for artifact_name in ("ai-output.json", "review-coverage.json", "review-request.json", "pr.diff.truncated", "pr.json"):
        artifact_path = run_dir / artifact_name
        if artifact_path.is_file():
            row["artifact_digests"][artifact_name] = f"sha256:{_sha256_file(artifact_path)[:16]}"
    diff_text = ""
    for diff_name in ("pr.diff.truncated", "pr.diff"):
        try:
            diff_text = (run_dir / diff_name).read_text(encoding="utf-8", errors="replace")
            break
        except OSError:
            continue
    try:
        body_text = (run_dir / "pr-body.txt").read_text(encoding="utf-8", errors="replace")
    except OSError:
        body_text = ""
    pr_object = _read_json_soft(run_dir / "pr.json")
    title = str(pr_object.get("title") or "") if isinstance(pr_object, dict) else ""
    if not title:
        title = str((corpus_entry or {}).get("title") or run_info.get("title") or "")
    secret_env_names = list(condition.get("secret_env_names") or [])
    if "AI_API_KEY" not in secret_env_names:
        secret_env_names.insert(0, "AI_API_KEY")
    request = {
        "row": {
            # The VERIFIED pins: after the three fail-closed gates above,
            # retained_head/retained_base equal the corpus pins — carry the
            # retained record's own values so the request provably grades
            # the verified revision pair.
            "head_sha": retained_head,
            "base_sha": retained_base,
            "diff": diff_text,
            "pr_title": title,
            "pr_body": body_text,
            "findings": findings,
            "review_summary": primary_artifacts["review_markdown"] or "",
            "required_checks": primary_artifacts["required_checks"] or "none",
            "coverage": coverage,
            "verdict": verdict,
            "verdict_policy": verdict_policy,
            "partial_coverage": bool(coverage.get("partial_coverage")),
            # Retained run-state proof: the verified fork state (recovered
            # from review-request.json, gated above) and the plan-declared
            # resolved publish mode (validated at plan level). The bridge
            # never synthesizes either.
            "is_fork_pr": row["is_fork_pr"],
            "publish_mode": publish_mode,
        },
        "confidence_env": condition["confidence_env"],
        "confidence_key_env": condition.get("key_env") or "",
        "secret_env_names": secret_env_names,
    }
    # Spend ceiling, not a successful-response counter: the slot is durably
    # RESERVED before dispatch and stays consumed when the provider fails,
    # parsing fails, or the bridge dies after dispatch — a crash after the
    # wire must never leave a paid call unrecorded (the pilot's write-first
    # discipline). A failed reservation dispatches NOTHING.
    if not reserve_slot():
        row["verifier"] = unscored_row("ledger_unavailable", "")
        row["diagnostic"] = "spend ledger could not be written; no call was dispatched"
        return row, 0
    row["wire_attempts"] = 1
    try:
        outcome = live_scorer_via_bridge(
            request, work_dir, float(ceilings["request_timeout_sec"]) + 30,
        )
    except Exception:  # noqa: BLE001 — any bridge failure degrades to unscored
        row["verifier"] = unscored_row("bridge_live_scorer_failed", "")
        return row, 1
    row["verifier"] = outcome["result"]
    row["profile"] = outcome["profile"]
    row["rubric_version"] = outcome.get("rubric_version")
    warnings = outcome.get("warnings")
    row["warnings"] = warnings if isinstance(warnings, list) else []
    row["review_result"] = outcome.get("review_result")
    row["primary"]["review_result"] = outcome.get("review_result")
    row["unresolved_pins"] = outcome.get("unresolved_pins")
    row["wire_effort"] = outcome.get("wire_effort")
    usage = outcome.get("usage")
    row["usage"] = usage if isinstance(usage, dict) else None
    latency = outcome.get("latency_ms")
    row["latency_ms"] = latency if isinstance(latency, int) else None
    prompt_bytes = outcome.get("prompt_bytes")
    row["prompt_bytes"] = prompt_bytes if isinstance(prompt_bytes, int) else None
    diagnostic = outcome.get("diagnostic")
    row["diagnostic"] = _bounded_diagnostic(diagnostic) if isinstance(diagnostic, str) else ""
    # Audit tree: the masked request/response copies the bridge produced with
    # production's own redaction (the same artifacts the runtime writes as
    # confidence-request.json / confidence-response.json).
    audit_path = audit_dir / _safe_component(pr_id) / f"{_safe_component(condition_id)}-r0.txt"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    sections = []
    request_masked = outcome.get("request_payload_masked")
    if isinstance(request_masked, str):
        sections.append(f"=== request (masked) ===\n{request_masked}")
    response_masked = outcome.get("raw_response_masked")
    if isinstance(response_masked, str):
        sections.append(f"=== response (masked) ===\n{response_masked}")
    note = ""
    if row["verifier"].get("status") == "unscored":
        note = f"unscored cause: {row['verifier'].get('cause', '')}"
        if row["diagnostic"]:
            note += f" — diagnostic: {row['diagnostic']}"
    if note:
        sections.append(f"=== note ===\n{note}")
    audit_path.write_text("\n\n".join(sections) + "\n", encoding="utf-8")
    return row, 1


def cmd_canary(args: argparse.Namespace) -> int:
    plan_path = Path(args.plan).resolve()
    plan = _read_json_soft(plan_path)
    corpus = load_corpus_entries(Path(args.corpus_real).resolve())
    errors = _validate_canary_plan(plan, corpus)
    if errors:
        _die_plan_errors(errors)
    assert isinstance(plan, dict)
    ceilings = plan["ceilings"]
    conditions = {condition["id"]: condition for condition in plan["conditions"]}
    selected_ids = args.condition or list(conditions)
    for cid in selected_ids:
        try:
            _safe_component(cid)
        except ValueError as exc:
            print(f"canary error: {exc}", file=sys.stderr)
            return EXIT_INVALID_PLAN
        if cid not in conditions:
            print(f"canary error: unknown condition id: {cid}", file=sys.stderr)
            return EXIT_INVALID_PLAN

    artifacts_dir = Path(args.artifacts_dir).resolve()
    runs_payload = _read_json_soft(artifacts_dir / "runs.json")
    if not (isinstance(runs_payload, dict) and isinstance(runs_payload.get("entries"), list)):
        print(
            f"canary error: no readable runs.json under {_repo_rel(str(artifacts_dir))}; "
            "the canary REUSES retained primary artifacts and never re-runs a primary",
            file=sys.stderr,
        )
        return EXIT_INVALID_PLAN
    run_entries = {
        record["pr_id"]: record
        for record in runs_payload["entries"]
        if isinstance(record, dict) and record.get("pr_id")
    }

    # Credential preflight (NAMES only; values are read inside the bridge).
    # The primary lane credential must exist for the inherited-transport
    # shape and the masking set; each declared condition key must exist.
    if not os.environ.get("AI_API_KEY"):
        print(
            "canary aborted: AI_API_KEY is not set (the primary lane credential the "
            "verifier may inherit and the masking set both require it)",
            file=sys.stderr,
        )
        return EXIT_MISSING_CREDENTIALS
    for cid in selected_ids:
        key_env = conditions[cid].get("key_env")
        if key_env and not os.environ.get(key_env):
            print(
                f"canary aborted: condition {cid} key env not set: {key_env} (values are never printed)",
                file=sys.stderr,
            )
            return EXIT_MISSING_CREDENTIALS
        for key, value in conditions[cid]["confidence_env"].items():
            if isinstance(value, str) and value.startswith("$") and not os.environ.get(value[1:]):
                print(
                    f"canary aborted: condition {cid} {key} references unset env var {value[1:]}",
                    file=sys.stderr,
                )
                return EXIT_MISSING_CREDENTIALS

    # Resolve "$NAME" indirection in the declared config: the bridge receives
    # resolved values (it is the production resolver's input), while the
    # plan and the results record keep the DECLARED references.
    conditions = {
        cid: {
            **condition,
            "confidence_env": {
                key: (os.environ[value[1:]] if isinstance(value, str) and value.startswith("$") else value)
                for key, value in condition["confidence_env"].items()
            },
        }
        for cid, condition in conditions.items()
    }

    work_dir = Path(args.work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    audit_dir = work_dir / "audit"
    out_path = Path(args.out).resolve()

    # Lifetime spend ledger for the canary work dir (the pilot's mechanism):
    # unreadable fails closed, and slots are RESERVED write-first — before
    # the wire they account for.
    spend_path = work_dir / SCORER_SPEND_FILENAME
    carried_calls = 0
    if spend_path.is_file():
        ledger = _read_json_soft(spend_path)
        counter = ledger.get("lifetime_wire_calls") if isinstance(ledger, dict) else None
        if not isinstance(counter, int) or isinstance(counter, bool) or counter < 0:
            print(
                f"canary aborted: {spend_path} exists but is unreadable or malformed; "
                "prior spend cannot be accounted, so no call was made",
                file=sys.stderr,
            )
            return EXIT_BUDGET_ABORT
        carried_calls = counter

    verdict_policy = plan.get("verdict_policy", "strict")
    # #1387: project against the budgets the run actually resolves — each
    # condition's declared ai-confidence-max-tokens as production's resolver
    # would take it, the single-source documented default otherwise — and
    # record which budgets the projection used.
    projected_budget = project_spend_budget(list(conditions.values()))
    declared_max_tokens = projected_budget["completion_tokens_per_call"]
    # Conservative projection: every selected condition may fire for every
    # entry (a fallback triggers only on a not-scored primary row, but the
    # ceiling must bound the worst case BEFORE any spend).
    planned_calls = len(plan["entries"]) * len(selected_ids)
    if carried_calls + planned_calls > ceilings["max_verifier_calls"]:
        print(
            f"canary aborted: {carried_calls} spent + {planned_calls} planned calls exceed "
            f"ceilings.max_verifier_calls={ceilings['max_verifier_calls']}; no call was made",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT
    if (carried_calls + planned_calls) * declared_max_tokens > ceilings["max_output_tokens"]:
        print(
            f"canary aborted: {carried_calls} spent + {planned_calls} planned calls at "
            f"{declared_max_tokens} completion tokens exceed "
            f"ceilings.max_output_tokens={ceilings['max_output_tokens']}; no call was made",
            file=sys.stderr,
        )
        return EXIT_BUDGET_ABORT

    rows: list[dict[str, Any]] = []
    calls_made = carried_calls
    phase_start = time.monotonic()

    def budget_exhaustion() -> str | None:
        if calls_made >= ceilings["max_verifier_calls"]:
            return f"max_verifier_calls={ceilings['max_verifier_calls']} reached"
        if calls_made * declared_max_tokens >= ceilings["max_output_tokens"]:
            return f"max_output_tokens={ceilings['max_output_tokens']} reached"
        if time.monotonic() - phase_start >= ceilings["wall_time_budget_sec"]:
            return f"wall_time_budget_sec={ceilings['wall_time_budget_sec']} elapsed"
        return None

    ledger_failure: list[str] = []

    def reserve_slot() -> bool:
        """Durably reserve ONE verifier call slot BEFORE provider dispatch.

        This is a spend ceiling, not a successful-response counter: the slot
        stays consumed when the provider fails, parsing fails, or the bridge
        dies after dispatch, so a crash after the wire can never leave a
        paid call unrecorded and a later invocation can never exceed the
        declared lifetime ceiling. A failed write dispatches nothing: the
        in-memory counter rolls back so the ledger and the results record
        agree, the run aborts, and zero provider calls happen.
        """
        nonlocal calls_made
        calls_made += 1
        try:
            _write_scorer_spend(spend_path, calls_made)
        except OSError as exc:
            calls_made -= 1
            ledger_failure.append(
                f"the spend ledger could not be written ({type(exc).__name__}); "
                "no call was dispatched and the run aborted"
            )
            return False
        return True

    budget_exhausted = False
    abort_note = ""
    for entry in plan["entries"]:
        pr_id = entry["pr_id"]
        expectation = entry.get("expectation", "")
        corpus_entry = corpus.get(pr_id)
        run_info = run_entries.get(pr_id, {})
        run_dir = _resolve_run_dir(artifacts_dir, run_info)
        evidence_state = primary_evidence_state(run_info, run_dir)
        kind = corpus_entry["_pilot_kind"] if corpus_entry else run_info.get("kind", "unknown")
        scored: dict[str, bool] = {}
        for cid in selected_ids:
            condition = conditions[cid]
            role = condition.get("role", "primary")
            if role == "fallback":
                target = condition.get("fallback_for", "")
                if scored.get(target, False):
                    # The primary condition produced a usable result: the
                    # declared fallback does NOT fire (no repeated sweeps).
                    rows.append({
                        "pr_id": pr_id, "kind": kind, "expectation": expectation,
                        "source": "corpus", "condition": cid, "role": role,
                        "evidence_state": evidence_state,
                        "head_sha": (corpus_entry or {}).get("head_sha", ""),
                        "base_sha": (corpus_entry or {}).get("base_sha", ""),
                        "retained_pins": None, "is_fork_pr": None,
                        "publish_mode": entry["publish_mode"],
                        "primary": {}, "verifier": disabled_scorer_result(),
                        "profile": None, "rubric_version": None, "warnings": [],
                        "wire_effort": None, "usage": None, "latency_ms": None,
                        "prompt_bytes": None, "diagnostic": "", "wire_attempts": 0,
                        "artifact_digests": {}, "_defect": (corpus_entry or {}).get("defect") or {},
                        "_primary_findings": [], "not_run": f"fallback_for {target} scored",
                    })
                    continue
            if budget_exhausted:
                break
            exhaustion = budget_exhaustion()
            if exhaustion is not None:
                budget_exhausted = True
                abort_note = exhaustion
                break
            row, attempts = _canary_row(
                pr_id, kind, expectation, condition, evidence_state, corpus_entry,
                run_info, run_dir, verdict_policy, ceilings, work_dir, audit_dir,
                reserve_slot, entry["publish_mode"],
            )
            rows.append(row)
            if row["verifier"].get("cause") == "ledger_unavailable":
                # The slot could not be durably reserved: nothing was
                # dispatched, nothing is counted, the run stops here.
                budget_exhausted = True
                abort_note = ledger_failure[0] if ledger_failure else abort_note
                scored[cid] = False
                break
            scored[cid] = attempts > 0 and row["verifier"].get("status") == "scored"
            status = row["verifier"].get("status", "?")
            detail = (
                f"score={row['verifier'].get('score')} risk={row['verifier'].get('risk')}"
                if status == "scored" else f"cause={row['verifier'].get('cause', '')}"
            )
            print(f"canary row: {pr_id} [{cid}] {status} ({detail})")
        if budget_exhausted:
            break

    if budget_exhausted:
        # No silent drops: every (entry, condition) combination this
        # invocation owned but did not reach gets an explicit row — never
        # silently dropped, never treated as an observation.
        present = {(row["pr_id"], row["condition"]) for row in rows}
        for entry in plan["entries"]:
            for cid in selected_ids:
                if (entry["pr_id"], cid) in present:
                    continue
                corpus_entry = corpus.get(entry["pr_id"])
                run_info = run_entries.get(entry["pr_id"], {})
                evidence_state = primary_evidence_state(
                    run_info, _resolve_run_dir(artifacts_dir, run_info),
                )
                rows.append({
                    "pr_id": entry["pr_id"],
                    "kind": corpus_entry["_pilot_kind"] if corpus_entry else run_info.get("kind", "unknown"),
                    "expectation": entry.get("expectation", ""),
                    "source": "corpus", "condition": cid,
                    "role": conditions[cid].get("role", "primary"),
                    "evidence_state": evidence_state,
                    "head_sha": (corpus_entry or {}).get("head_sha", ""),
                    "base_sha": (corpus_entry or {}).get("base_sha", ""),
                    "retained_pins": None, "is_fork_pr": None,
                    "publish_mode": entry["publish_mode"],
                    "primary": {}, "verifier": unscored_row("budget_exhausted", ""),
                    "profile": None, "rubric_version": None, "warnings": [],
                    "wire_effort": None, "usage": None, "latency_ms": None,
                    "prompt_bytes": None, "diagnostic": "", "wire_attempts": 0,
                    "artifact_digests": {}, "_defect": (corpus_entry or {}).get("defect") or {},
                    "_primary_findings": [],
                })

    results = {
        "plan": str(plan_path),
        "plan_digest": f"sha256:{_sha256_file(plan_path)[:16]}",
        "artifacts_dir": str(artifacts_dir),
        "artifacts_runs_digest": f"sha256:{_sha256_file(artifacts_dir / 'runs.json')[:16]}",
        "production_shape": plan["production_shape"],
        "verdict_policy": verdict_policy,
        "declared_conditions": [
            {
                "id": condition["id"],
                "role": condition.get("role", "primary"),
                "confidence_env": condition["confidence_env"],
                "key_env": condition.get("key_env") or None,
                "secret_env_names": condition.get("secret_env_names") or [],
            }
            for condition in plan["conditions"]
        ],
        "ceilings": ceilings,
        "projected_budget": projected_budget,
        "rows": rows,
        "budget_exhausted": budget_exhausted,
        "budget_note": abort_note,
        "lifetime_wire_calls": calls_made,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    scored_count = sum(1 for row in rows if row["verifier"].get("status") == "scored")
    print(
        f"canary complete: {scored_count}/{len(rows)} rows scored, "
        f"{calls_made} wire calls -> {_repo_rel(str(out_path))}"
        + (" [budget_exhausted: " + abort_note + "]" if budget_exhausted else "")
    )
    if ledger_failure:
        # A failed reservation aborted the run: the results-so-far are
        # written for observability, but the exit is the budget-abort code —
        # spend that cannot be accounted for is never treated as spent room.
        print(f"canary aborted: {ledger_failure[0]}", file=sys.stderr)
        return EXIT_BUDGET_ABORT
    return 0


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

    canary_p = sub.add_parser(
        "canary",
        help="#1370: bounded production-shape verifier canary over RETAINED primary artifacts "
             "(no primary re-runs; one wire attempt per entry x declared condition)",
    )
    canary_p.add_argument("--plan", required=True, help="canary plan JSON (declared verifier config + ceilings)")
    canary_p.add_argument("--artifacts-dir", required=True,
                          help="runs dir holding the RETAINED primary artifacts (runs.json + run dirs); read-only")
    canary_p.add_argument("--out", required=True, help="results JSON path")
    canary_p.add_argument("--work-dir", required=True,
                          help="canary work dir: bridge temp files, audit tree, and the lifetime spend ledger")
    canary_p.add_argument("--condition", action="append", default=None,
                          help="restrict to specific condition ids (default: every declared condition)")
    canary_p.add_argument("--corpus-real", default=str(DEFAULT_CORPUS_REAL))
    canary_p.set_defaults(func=cmd_canary)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
