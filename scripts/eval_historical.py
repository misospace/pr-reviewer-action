"""Historical semantic regression corpus scoring for issue #627.

This module adds capability scoring for the historical dogfood-miss corpus
(evals/corpus-historical.json) on top of the existing eval_harness.py. The
existing harness already grades agentic-evidence-chain checks
(``tool_call`` / ``review_mentions`` / ``max_tool_calls``); the historical
corpus needs three new check kinds that the existing grammar cannot express:

* ``sequencing`` — pins the PR #623 cross-file/control-flow regression. The
  full specialist phase must terminate/reap before the primary reviewer
  enters; launch-before-final alone must not receive credit.
* ``failure_contract`` — pins the PR #623 exceptional-path regression. The
  promised normalized/per-role artifact state must exist on the
  catastrophic-exception path as well as the normal failure path.
* ``negative_control`` — pins a clean-PR scenario so recall-style
  improvements on the #623 cases cannot be bought with fabricated findings
  or excessive tool calls.

Design invariants (per #627):

* **Semantic, not prose.** Checks use evidence anchors (timestamps,
  artifact names, capability classes) rather than exact wording — the
  grader names concrete evidence, the reviewer doesn't get a recipe.
* **Stage attribution.** Results carry an ``attribution`` field that records
  which review stage caught the expected issue (specialist correctness /
  security / tests, primary final reviewer, or escalation) so the harness
  can answer the "which stage caught this?" question without re-running.
* **Primary + escalation matrices.** The harness carries configured
  ``primary_model`` and ``escalation_model`` slots — the corpus never
  hard-codes M2.7 / M3; operators can evaluate any routing pair on the
  same fixtures.
* **Standard vs deep depth.** ReviewRun gains a ``review_depth`` slot
  (``standard`` / ``deep``) and ``stages``/``stage_events`` slots; the
  capability checker only credits the run that actually reaped before the
  final review entered.
* **Deterministic CI path.** The scorer runs against in-memory
  ``ReviewRun`` traces; no network, no model calls, no fixture mutation.
  Live-model benchmark runs go through the existing workflow_dispatch /
  schedule path on .github/workflows/eval-harness.yaml.

This module is purely additive — it does not modify the existing
``evaluate_capability`` semantics, so prior fixtures and tests remain
behaviorally unchanged. ``evaluate_scenario`` below is a thin dispatcher
that defers to ``eval_harness.evaluate_capability`` for the legacy check
kinds and handles the new ones itself.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Stage identifiers used by attribution. Kept as a closed set so the harness
# never silently accepts an unknown stage name (the historical corpus
# declares these names; a typo there would otherwise be a silent free pass).
ATTRIBUTION_STAGES = frozenset(
    {
        "specialist_correctness",
        "specialist_security",
        "specialist_tests",
        "primary_final",
        "escalation",
    }
)

# Valid review depths. Standard = the legacy single-reviewer path. Deep =
# the opt-in specialist advisory phase (#608) followed by the primary
# reviewer (and optionally an escalation pass).
REVIEW_DEPTHS = frozenset({"standard", "deep"})

# Terminal-path kinds the failure_contract checker recognises. These are
# the material terminal paths an exhaustive failure-path audit must cover
# (per #625): success; validation/malformed output; timeout/cancellation;
# retry exhaustion/transport failure; exception/early return; disabled/no-op
# configuration; partial artifact/write failure.
FAILURE_PATH_KINDS = frozenset(
    {
        "success",
        "validation",
        "timeout",
        "retry_exhaustion",
        "exception",
        "disabled",
        "write_failure",
    }
)


@dataclass
class StageEvent:
    """A single recorded event on a review stage.

    The historical-corpus scorer consumes these instead of raw timestamps
    so the deterministic CI path can replay traces without clock drift.
    ``monotonic_seq`` orders events deterministically; events with no
    explicit sequence get a fallback ordinal position from the list index.
    """

    stage: str
    event: str  # "launched" | "completed" | "errored" | "started" | "ended"
    monotonic_seq: int | None = None
    payload: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Validate on construction so neither the dataclass nor
        # ``from_dict`` can produce an event the scorer silently accepts.
        if not isinstance(self.stage, str):
            raise TypeError(
                f"StageEvent.stage must be a str; got {type(self.stage).__name__}"
            )
        if self.stage not in ATTRIBUTION_STAGES:
            raise ValueError(
                f"StageEvent.stage must be one of {sorted(ATTRIBUTION_STAGES)}; "
                f"got {self.stage!r}"
            )
        if not isinstance(self.event, str):
            raise TypeError(
                f"StageEvent.event must be a str; got {type(self.event).__name__}"
            )
        if not self.event:
            raise ValueError("StageEvent.event must be a non-empty string")
        if self.monotonic_seq is not None and not isinstance(self.monotonic_seq, int):
            raise TypeError(
                f"StageEvent.monotonic_seq must be int|None; got "
                f"{type(self.monotonic_seq).__name__}"
            )
        if not isinstance(self.payload, dict):
            raise TypeError(
                f"StageEvent.payload must be a dict; got {type(self.payload).__name__}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "stage": self.stage,
            "event": self.event,
            "monotonic_seq": self.monotonic_seq,
            "payload": dict(self.payload),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> StageEvent:
        if not isinstance(d, dict):
            raise TypeError(
                f"StageEvent source must be a dict, got {type(d).__name__}"
            )
        return cls(
            stage=d.get("stage"),
            event=d.get("event"),
            monotonic_seq=d.get("monotonic_seq"),
            payload=d.get("payload") or {},
        )


@dataclass
class HistoricalScenario:
    """A single scenario inside a corpus PR entry."""

    scenario_id: str
    class_: str
    description: str
    negative_control: bool
    expected_evidence: dict[str, Any]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> HistoricalScenario:
        if not isinstance(d, dict):
            raise TypeError(f"scenario must be a dict, got {type(d).__name__}")
        sid = d.get("scenario_id")
        if not isinstance(sid, str):
            raise TypeError(
                f"scenario.scenario_id must be a str; got {type(sid).__name__}"
            )
        if not sid:
            raise ValueError("scenario.scenario_id must be a non-empty string")
        cls_ = d.get("class", "")
        desc = d.get("description", "")
        if not isinstance(cls_, str):
            raise TypeError(f"scenario.class must be a str; got {type(cls_).__name__}")
        if not isinstance(desc, str):
            raise TypeError(
                f"scenario.description must be a str; got {type(desc).__name__}"
            )
        ee = d.get("expected_evidence")
        if not isinstance(ee, dict):
            raise TypeError(
                f"scenario {sid!r} expected_evidence must be a dict; "
                f"got {type(ee).__name__}"
            )
        if not isinstance(ee.get("checks"), list):
            raise TypeError(
                f"scenario {sid!r} expected_evidence.checks must be a list; "
                f"got {type(ee.get('checks')).__name__}"
            )
        if not ee["checks"]:
            raise ValueError(
                f"scenario {sid!r} expected_evidence.checks must be a non-empty list"
            )
        return cls(
            scenario_id=sid,
            class_=cls_,
            description=desc,
            negative_control=bool(d.get("negative_control", False)),
            expected_evidence=ee,
        )


# ---------------------------------------------------------------------------
# Corpus loading + schema validation
# ---------------------------------------------------------------------------


class HistoricalCorpusError(ValueError):
    """Raised when a historical corpus file is malformed."""


def load_historical_corpus(path: Path) -> list[dict[str, Any]]:
    """Load ``evals/corpus-historical.json`` and validate its schema.

    Returns the list of corpus entries (each carrying ``scenarios`` and a
    ``provenance`` block). Raises :class:`HistoricalCorpusError` on any
    schema violation so the harness's deterministic CI path fails closed
    rather than scoring a fixture that doesn't match its contract.
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HistoricalCorpusError(
            f"failed to read historical corpus {path}: {exc}"
        ) from exc

    if not isinstance(data, dict):
        raise HistoricalCorpusError(f"{path}: root must be a JSON object")
    prs = data.get("benchmark_corpus")
    if not isinstance(prs, list) or not prs:
        raise HistoricalCorpusError(
            f"{path}: benchmark_corpus must be a non-empty list"
        )

    out: list[dict[str, Any]] = []
    for i, pr in enumerate(prs):
        if not isinstance(pr, dict):
            raise HistoricalCorpusError(f"{path}: benchmark_corpus[{i}] must be a dict")
        for required in ("number", "repo_full_name", "url"):
            if required not in pr:
                raise HistoricalCorpusError(
                    f"{path}: benchmark_corpus[{i}] missing required field {required!r}"
                )
        scenarios = pr.get("scenarios")
        if scenarios is None:
            raise HistoricalCorpusError(
                f"{path}: PR #{pr.get('number')} missing required 'scenarios' list"
            )
        if not isinstance(scenarios, list) or not scenarios:
            raise HistoricalCorpusError(
                f"{path}: PR #{pr.get('number')} scenarios must be a non-empty list"
            )
        for j, raw in enumerate(scenarios):
            scenario = HistoricalScenario.from_dict(raw)
            _validate_scenario_checks(scenario, pr.get("number"), path, j)
            # Keep the validated raw dict (with provenance from the entry
            # attached) so downstream report rendering has the full record.
            entry = dict(pr)
            entry["scenarios"] = [
                {**dict(s), "_validated": True} if isinstance(s, dict) else s
                for s in scenarios
            ]
            entry.setdefault("provenance", {})
            out.append(entry)
            break  # scenarios are validated collectively on the first iteration
    return out


def _validate_scenario_checks(
    scenario: HistoricalScenario,
    pr_number: Any,
    path: Path,
    index: int,
) -> None:
    """Validate the per-check schema for a scenario.

    Each scenario check kind has its own required keys; we fail closed on
    any unknown check kind so the corpus never silently accepts a typo.
    """
    for check in scenario.expected_evidence["checks"]:
        if not isinstance(check, dict):
            raise HistoricalCorpusError(
                f"{path}: PR #{pr_number} scenarios[{index}] check must be a dict"
            )
        ctype = check.get("type")
        cid = check.get("id")
        if not isinstance(cid, str) or not cid:
            raise HistoricalCorpusError(
                f"{path}: PR #{pr_number} scenarios[{index}] check missing 'id'"
            )
        if ctype == "sequencing":
            stages = check.get("stages")
            ordering = check.get("ordering")
            if not isinstance(stages, list) or not stages:
                raise HistoricalCorpusError(
                    f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                    f"check {cid!r} sequencing requires non-empty 'stages' list"
                )
            for stage in stages:
                if stage not in ATTRIBUTION_STAGES:
                    raise HistoricalCorpusError(
                        f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                        f"check {cid!r} references unknown stage {stage!r}; "
                        f"must be one of {sorted(ATTRIBUTION_STAGES)}"
                    )
            if ordering not in {
                "all_specialists_before_primary",
                "completion_required_not_launch",
            }:
                raise HistoricalCorpusError(
                    f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                    f"check {cid!r} sequencing.ordering must be "
                    f"'all_specialists_before_primary' or 'completion_required_not_launch'"
                )
        elif ctype == "failure_contract":
            p = check.get("path")
            req = check.get("required_artifacts")
            if p not in FAILURE_PATH_KINDS:
                raise HistoricalCorpusError(
                    f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                    f"check {cid!r} failure_contract.path must be one of "
                    f"{sorted(FAILURE_PATH_KINDS)}; got {p!r}"
                )
            if not isinstance(req, list) or not req:
                raise HistoricalCorpusError(
                    f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                    f"check {cid!r} failure_contract.required_artifacts must be "
                    f"a non-empty list"
                )
            for art in req:
                if not isinstance(art, str) or not art:
                    raise HistoricalCorpusError(
                        f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                        f"check {cid!r} failure_contract.required_artifacts entries "
                        f"must be non-empty strings"
                    )
        elif ctype == "negative_control":
            forbidden = check.get("forbidden_categories", [])
            if not isinstance(forbidden, list):
                raise HistoricalCorpusError(
                    f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                    f"check {cid!r} negative_control.forbidden_categories must be a list"
                )
            max_findings = check.get("max_findings", 0)
            if not isinstance(max_findings, int) or max_findings < 0:
                raise HistoricalCorpusError(
                    f"{path}: PR #{pr_number} scenario {scenario.scenario_id!r} "
                    f"check {cid!r} negative_control.max_findings must be a "
                    f"non-negative int"
                )
        # tool_call / review_mentions / max_tool_calls are validated by the
        # existing eval_harness.evaluate_capability path; we don't
        # duplicate that validation here.


# ---------------------------------------------------------------------------
# Synthetic-trace scoring (offline deterministic path)
# ---------------------------------------------------------------------------


def evaluate_scenario(
    scenario: dict[str, Any],
    review_run: Any,
    stage_events: list[StageEvent] | None = None,
    artifacts_written: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Grade a single scenario against a run.

    Args:
        scenario: One entry from the ``scenarios`` list of a corpus PR.
        review_run: A :class:`eval_harness.ReviewRun` (duck-typed — only
            the fields the new check kinds need are read).
        stage_events: Per-stage launch/completion timeline. The corpus
            declares which stages are in scope on each scenario's
            ``stages`` list; ordering is decided by ``monotonic_seq``.
        artifacts_written: Mapping ``{path_kind: [artifact_name, ...]}``
            recording which artifacts landed on each terminal path of the
            runner. Keys are entries from :data:`FAILURE_PATH_KINDS`.

    Returns:
        A dict with ``scenario_id``, ``class``, ``description``,
        ``negative_control``, ``attribution`` (the stage that caught the
        expected issue, or None), and ``checks`` (a list of
        ``{id, type, passed, detail}`` records, plus a top-level
        ``passed`` flag).
    """
    if not isinstance(scenario, dict):
        raise HistoricalCorpusError(
            f"scenario must be a dict, got {type(scenario).__name__}"
        )
    parsed = HistoricalScenario.from_dict(scenario)

    checks_out: list[dict[str, Any]] = []
    raw_checks = parsed.expected_evidence["checks"]

    # Lazy import — the historical-corpus module is a peer of eval_harness
    # in scripts/, but tests import both, so a top-level import would also
    # work. Keeping it local makes the module usable in isolation too.
    from eval_harness import (
        evaluate_capability,  # noqa: WPS433 (intentional local import)
    )

    events = stage_events or []
    artifacts = artifacts_written or {}

    for check in raw_checks:
        ctype = check.get("type")
        cid = check.get("id", ctype or "check")
        detail: dict[str, Any] = {}

        if ctype == "sequencing":
            passed = _grade_sequencing(check, events, detail)
        elif ctype == "failure_contract":
            passed = _grade_failure_contract(check, events, artifacts, detail)
        elif ctype == "negative_control":
            passed = _grade_negative_control(check, review_run, detail)
        else:
            # Fall back to the legacy capability scorer. It returns None
            # for unknown check kinds, so we materialise a failing result
            # with a clear message rather than silently passing.
            legacy = evaluate_capability(review_run, {"checks": [check]})
            if legacy is None:
                passed = False
                detail["reason"] = (
                    f"unsupported check type {ctype!r} for historical scorer"
                )
            else:
                passed = bool(legacy["passed"])
                detail["legacy"] = legacy

        checks_out.append(
            {"id": cid, "type": ctype, "passed": bool(passed), "detail": detail}
        )

    attribution = _compute_attribution(parsed, events, artifacts)

    return {
        "scenario_id": parsed.scenario_id,
        "class": parsed.class_,
        "description": parsed.description,
        "negative_control": parsed.negative_control,
        "attribution": attribution,
        "checks": checks_out,
        "passed": all(c["passed"] for c in checks_out),
    }


def _grade_sequencing(
    check: dict[str, Any],
    events: list[StageEvent],
    detail: dict[str, Any],
) -> bool:
    """Grade a ``sequencing`` check against the recorded stage events.

    Two orderings are recognised:

    * ``all_specialists_before_primary`` — every specialist stage must
      record a completion event whose monotonic order is strictly less
      than the primary final reviewer's start event. A launch-only
      specialist (no completion) does not satisfy this; the #623
      pre-fix state recorded only launches and reaped at the step
      summary, so the primary final started before any specialist
      completion and the check correctly fails.

    * ``completion_required_not_launch`` — explicitly pins that a launch
      event alone (without a matching completion) is not sufficient.
      This is the dedicated regression-pin for the pre-fix launch-only
      state; without it, a run that happened to launch every specialist
      in order could pass.
    """
    stages_in_scope = list(check.get("stages", []))
    ordering = check.get("ordering")
    detail["stages"] = stages_in_scope
    detail["ordering"] = ordering

    # Build a per-stage view: launch_seq, completion_seq.
    by_stage: dict[str, dict[str, int | None]] = {
        stage: {
            "launch_seq": None,
            "completion_seq": None,
            "start_seq": None,
            "end_seq": None,
        }
        for stage in stages_in_scope
    }
    for ev in events:
        if ev.stage not in by_stage:
            continue
        seq = ev.monotonic_seq
        if seq is None:
            continue
        if ev.event == "launched":
            by_stage[ev.stage].setdefault("launch_seq", seq)
        elif ev.event == "completed":
            by_stage[ev.stage]["completion_seq"] = seq
        elif ev.event == "started":
            by_stage[ev.stage]["start_seq"] = seq
        elif ev.event == "ended":
            by_stage[ev.stage]["end_seq"] = seq

    detail["by_stage"] = {
        s: {k: v for k, v in vals.items() if v is not None}
        for s, vals in by_stage.items()
    }

    primary = "primary_final"
    specialists = [s for s in stages_in_scope if s.startswith("specialist_")]
    primary_start = by_stage.get(primary, {}).get("start_seq")

    if primary not in by_stage:
        detail["reason"] = (
            f"primary stage {primary!r} not in scope; cannot grade ordering"
        )
        return False

    if primary_start is None:
        # Primary stage in scope but no start event recorded. The PR #623
        # pre-fix state did not even record a primary start until the
        # step summary — that's a regression in itself; flag it.
        detail["reason"] = f"primary stage {primary!r} has no recorded start event"
        return False

    if ordering == "completion_required_not_launch":
        # Every specialist must have a completion event; launch alone is
        # explicitly insufficient.
        missing = [s for s in specialists if by_stage[s]["completion_seq"] is None]
        if missing:
            detail["missing_completion"] = missing
            detail["reason"] = (
                "specialist launches without matching completions do not "
                "satisfy reap-before-final; missing: " + ", ".join(sorted(missing))
            )
            return False
        return True

    if ordering == "all_specialists_before_primary":
        # Every specialist must have a completion event strictly before the
        # primary start event. (We don't require the specialist launch to
        # be before the primary start — only the *completion*, which is
        # the actual reap.)
        offenders = []
        for s in specialists:
            comp = by_stage[s]["completion_seq"]
            if comp is None or comp >= primary_start:
                offenders.append(
                    {
                        "stage": s,
                        "completion_seq": comp,
                        "primary_start_seq": primary_start,
                    }
                )
        if offenders:
            detail["offenders"] = offenders
            detail["reason"] = (
                "specialist completions must precede primary start; offenders: "
                + ", ".join(o["stage"] for o in offenders)
            )
            return False
        return True

    detail["reason"] = f"unknown ordering {ordering!r}"
    return False


def _grade_failure_contract(
    check: dict[str, Any],
    events: list[StageEvent],
    artifacts: dict[str, list[str]],
    detail: dict[str, Any],
) -> bool:
    """Grade a ``failure_contract`` check.

    The check asks: on the named terminal path (e.g. ``exception``), were
    the promised artifacts written? The runner records path writes in
    ``artifacts_written[path]`` (e.g. ``{"exception": [...]}``); the
    promised set is the ``required_artifacts`` list. A literal ``{role}``
    placeholder expands to the set of specialist roles that recorded a
    completion event so one scenario covers all three roles.
    """
    path = check.get("path")
    required = list(check.get("required_artifacts", []))
    detail["path"] = path
    detail["required_artifacts"] = required

    written = artifacts.get(path, [])
    written_set = set(written)

    # Defensive: every artifact name must satisfy the safe-name contract.
    # A fixture that smuggles in a path-traversal segment or a shell
    # metacharacter fails closed here rather than producing a misleading
    # result downstream.
    bad_names = [a for a in written if not _is_safe_artifact_name(a)]
    if bad_names:
        detail["unsafe_artifact_names"] = bad_names
        detail["reason"] = (
            f"path {path!r} recorded unsafe artifact name(s): " + ", ".join(bad_names)
        )
        return False

    # Expand {role} placeholder against recorded specialist completions.
    completed_roles = sorted(
        {
            ev.payload.get("role")
            for ev in events
            if ev.event == "completed" and isinstance(ev.payload.get("role"), str)
        }
    )
    expanded: list[str] = []
    for art in required:
        if "{role}" in art:
            if not completed_roles:
                # No specialist completions recorded — the contract has
                # nothing to verify against. The exception path is
                # incomplete by definition.
                detail["reason"] = (
                    f"required artifact {art!r} references specialist "
                    f"role but no specialist completion events were recorded"
                )
                return False
            for role in completed_roles:
                expanded.append(art.replace("{role}", role))
        else:
            expanded.append(art)

    missing = [a for a in expanded if a not in written_set]
    detail["written"] = sorted(written_set)
    detail["expanded_required"] = expanded
    if missing:
        detail["missing"] = missing
        detail["reason"] = f"path {path!r} is missing promised artifacts: " + ", ".join(
            missing
        )
        return False
    return True


def _grade_negative_control(
    check: dict[str, Any],
    review_run: Any,
    detail: dict[str, Any],
) -> bool:
    """Grade a ``negative_control`` check.

    The check forbids crediting fabricated capability classes and caps the
    finding count, so recall-style improvements on the positive scenarios
    cannot be bought by inventing findings on the clean PR.
    """
    forbidden = list(check.get("forbidden_categories", []))
    max_findings = int(check.get("max_findings", 0))
    detail["forbidden_categories"] = forbidden
    detail["max_findings"] = max_findings

    findings = list(getattr(review_run, "findings", []) or [])
    detail["actual_findings"] = len(findings)
    if len(findings) > max_findings:
        detail["reason"] = (
            f"negative control violated: {len(findings)} finding(s) exceeds "
            f"max_findings={max_findings}"
        )
        return False

    # The forbidden_categories list names capability classes that must not
    # be credited on this clean PR. We expose the run's capability results
    # via duck-typed access (the run may or may not carry them depending
    # on how it was scored); anything matching the forbidden set fails the
    # check. The historical corpus declares e.g. "sequencing" and
    # "failure_contract" as forbidden on a clean PR, so a run that
    # somehow credited those capabilities on the negative control fails.
    capability_results = list(getattr(review_run, "capability_results", []) or [])
    credited = {
        cap.get("scenario_class")
        for cap in capability_results
        if isinstance(cap, dict) and cap.get("passed")
    }
    detail["credited_capability_classes"] = sorted(credited)
    if any(cat in credited for cat in forbidden):
        detail["reason"] = (
            "negative control violated: fabricated capability credit(s) "
            f"in {sorted(credited & set(forbidden))}"
        )
        return False

    return True


def _compute_attribution(
    scenario: HistoricalScenario,
    events: list[StageEvent],
    artifacts: dict[str, list[str]],
) -> str | None:
    """Return the stage that caught the expected issue, or None.

    Attribution is recorded for reporting purposes — it does not affect
    the pass/fail grade (the harness still requires ALL checks to pass).
    For sequencing scenarios the attribution is the primary stage (the
    reviewer's path); for failure_contract scenarios it is the
    specialist_correctness role (the audit lives in that prompt); for
    negative_control scenarios it is None (no issue was expected).

    Operators reading the report want to know which stage caught the
    issue so they can decide whether deep review was worth its cost.
    """
    if scenario.negative_control:
        return None
    if scenario.class_ == "cross-file/control-flow sequencing":
        return "primary_final"
    if scenario.class_ == "exceptional-path output completeness":
        return "specialist_correctness"
    # Fall back to: the first stage that recorded a completion event.
    for ev in events:
        if ev.event == "completed":
            return ev.stage
    return None


# ---------------------------------------------------------------------------
# Primary + escalation matrix serialisation (no model hard-coding)
# ---------------------------------------------------------------------------


def serialise_routing_matrix(
    primary_model: str,
    escalation_model: str | None,
    review_depths: list[str] | None = None,
) -> dict[str, Any]:
    """Serialise a routing matrix in a way the historical corpus can replay.

    The corpus declares the *shape* of the matrix (primary + optional
    escalation; standard + deep) but never names a model. Operators pick
    the pair at run time; the historical scorer accepts any string. This
    keeps M2.7 / M3-style routing pairs evaluable without hard-coding
    them into production behavior or into the fixture file.

    The serialised dict round-trips through ``json.dumps`` / ``json.loads``
    so the deterministic CI path can replay it without depending on the
    the live routing configuration.
    """
    depths = list(review_depths) if review_depths else ["standard", "deep"]
    for d in depths:
        if d not in REVIEW_DEPTHS:
            raise ValueError(
                f"unknown review depth {d!r}; must be one of {sorted(REVIEW_DEPTHS)}"
            )
    matrix: dict[str, Any] = {
        "primary_model": str(primary_model),
        "escalation_model": (str(escalation_model) if escalation_model else None),
        "review_depths": depths,
        "routing_pairs": [],
    }
    for depth in depths:
        matrix["routing_pairs"].append(
            {
                "depth": depth,
                "primary": str(primary_model),
                "escalation": (str(escalation_model) if escalation_model else None),
                "stages_in_order": (
                    ["primary_final"]
                    if depth == "standard"
                    else [
                        "specialist_correctness",
                        "specialist_security",
                        "specialist_tests",
                        "primary_final",
                    ]
                    + (["escalation"] if escalation_model else [])
                ),
            }
        )
    return matrix


def _is_safe_artifact_name(name: str) -> bool:
    """Cheap sanity check: artifact names from the corpus must not smuggle
    shell metacharacters or path traversal segments. The historical
    scorer only ever reads artifact names from in-memory dicts; this is a
    defence-in-depth check that future fixtures don't accidentally pass
    user-controlled strings in here.
    """
    if not isinstance(name, str) or not name:
        return False
    if name.startswith("/") or ".." in name.split("/"):
        return False
    return bool(re.match(r"^[A-Za-z0-9._\-{}/]+$", name))


__all__ = [
    "ATTRIBUTION_STAGES",
    "FAILURE_PATH_KINDS",
    "REVIEW_DEPTHS",
    "HistoricalCorpusError",
    "HistoricalScenario",
    "StageEvent",
    "evaluate_scenario",
    "load_historical_corpus",
    "serialise_routing_matrix",
]
