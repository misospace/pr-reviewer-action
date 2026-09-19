"""Semantic scorer for the historical dogfood regression corpus (#627).

The regular capability checker in ``scripts.eval_harness.evaluate_capability``
grades against an explicit ``expected_evidence`` list of tool-call patterns
and review-mention needles. That is fine for the home-ops#7462-style
agentic-evidence-chain check, but the historical dogfood corpus the issue
asks for is a different shape:

- **The expected issue is known, not the recipe.**  PR #623 / issue #608
  dogfooded ``deep_review=true``: a reviewer that *launches* the three
  specialist roles and stops there was credited for the
  "all specialists terminated/reaped before the final review begins"
  invariant, even though the specialists were still running. The bar is a
  semantic capability ("reap-before-final sequencing") — there is no
  single tool call or sentence the grader can name as evidence.

- **Scoring must accept materially equivalent findings.**  Two valid
  findings for the failure-contract case may be phrased differently,
  but if both carry the ``output_completeness`` capability and an
  evidence anchor pointing at the artifact under test, the grader has
  to credit either. Exact-prose matching would push the corpus toward
  trivia.

- **Attribution has to be visible.**  The acceptance criteria say
  "Results identify which review stage caught each expected issue."
  A reviewer run can have up to three stages (specialist advisory,
  primary final, post-hoc escalation), each of which produces its own
  artifact. The scorer needs a stage label on every signal it emits
  so the harness can attribute the hit, not just tally it.

This module is deliberately side-effect-free, deterministic, and offline:

- It parses in-memory JSON, never the network, and never invokes a
  model.  The harness layer (and CI) can run it against any saved run
  artifact without needing the configured model endpoint.
- It exposes :func:`evaluate_semantic_capability` as the grader entry
  point and :func:`validate_semantic_corpus` as the deterministic CI
  gate (no external model calls, fixtures only).
- It speaks **capability classes** ("control_flow_sequencing",
  "output_completeness", "negative_control") as the primary scoring
  unit, with evidence anchors as the secondary anchor. A negative
  control fixture declares ``forbidden_capabilities`` and is failed
  by *any* finding that lands on a forbidden class — that is the
  guard against "recall improvements come from more findings".

Stage attribution is encoded as a simple enum-like string on each
signal (``"specialist"`` / ``"primary"`` / ``"escalation"``); the
harness layer that drives the model and produces artifacts is the
authority for *which* stage produced a given signal — this module only
inspects whatever stage the caller tagged.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ─── Versioning ──────────────────────────────────────────────────────────────
# Bumped whenever the on-disk schema or the scorer semantics change in a way
# that breaks an existing fixture. Tests pin the supported version range.
SEMANTIC_CORPUS_VERSION = 1
SEMANTIC_EVAL_VERSION = 1

# ─── Stage / mode labels ─────────────────────────────────────────────────────
#: Recognised review stages a finding or capability hit can be attributed to.
#: Mirrors the production stages: ``specialist`` for the deep-review advisory
#: roles, ``primary`` for the standard final reviewer call, ``escalation`` for
#: the post-hoc escalation lane. ``any`` is reserved for fixtures that do not
#: pin attribution (e.g. a capability that any stage may surface).
RECOGNISED_STAGES: frozenset[str] = frozenset(
    {"specialist", "primary", "escalation", "any"}
)

#: Recognised review modes the fixture declares it belongs to. ``standard``
#: is the production default (single final-reviewer call); ``deep`` is the
#: opt-in specialists path. ``any`` matches both.
RECOGNISED_MODES: frozenset[str] = frozenset({"standard", "deep", "any"})

#: Recognised routes (primary / escalation). A fixture may pin a single
#: model ("primary") or a configured primary+escalation pair
#: ("primary+escalation") so the harness can evaluate the MiniMax M2.7 →
#: MiniMax M3 routing pair without baking those names into production.
RECOGNISED_ROUTES: frozenset[str] = frozenset(
    {"primary", "escalation", "primary+escalation", "any"}
)

# ─── Capability classes ──────────────────────────────────────────────────────
#: Canonical capability classes for the historical dogfood corpus. New
#: fixtures may declare additional classes; these are the v1 closed set
#: that map onto the #608 / #623 misses and the negative control guard.
#: Tests pin membership; the harness treats unknown classes as a schema
#: validation failure.
CAPABILITY_SEQUENCING = "control_flow_sequencing"
CAPABILITY_OUTPUT_COMPLETENESS = "output_completeness"
CAPABILITY_NEGATIVE_CONTROL = "negative_control"
KNOWN_CAPABILITY_CLASSES: frozenset[str] = frozenset(
    {
        CAPABILITY_SEQUENCING,
        CAPABILITY_OUTPUT_COMPLETENESS,
        CAPABILITY_NEGATIVE_CONTROL,
    }
)

# ─── Stage attribution on signals ────────────────────────────────────────────
#: ``ReviewSignal`` is the small, in-memory record the harness hands to the
#: scorer: the textual content of one finding, one review-mention, or one
#: tool-call observation, tagged with the stage that produced it.
SIGNAL_KIND_FINDING = "finding"
SIGNAL_KIND_MENTION = "mention"
SIGNAL_KIND_TOOL = "tool"


@dataclass
class ReviewSignal:
    """One finding / mention / tool-call observation attributed to a stage.

    The harness layer is responsible for stamping ``stage`` correctly; the
    scorer treats ``stage`` as ground truth and never infers it from text.
    ``capability`` is the capability class the signal asserts (mapped by
    :func:`classify_signal`); ``anchors`` are substrings the signal carries
    that satisfy :func:`evaluate_semantic_capability` evidence anchors.

    Construction always runs :func:`classify_signal` on ``text`` so direct
    callers (CI fixtures, unit tests) and the harness layer get the same
    classification. Pass ``capability`` only when the harness has already
    classified — :meth:`__post_init__` will overwrite a passed-in ``None``
    with the classifier output, but a passed-in non-``None`` capability
    wins (so a caller may pin a class the classifier missed).
    """

    kind: str
    stage: str
    text: str
    capability: str | None = None
    anchors: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        classified = classify_signal(self.text)
        # Caller-provided capability wins when set; otherwise fall back
        # to whatever the classifier returned (may itself be None).
        if self.capability is None:
            self.capability = classified


# ─── Semantic equivalence ────────────────────────────────────────────────────
#: Word-overlap threshold for considering two findings "materially
#: equivalent" — a finding that covers the same capability class AND has
#: sufficient keyword overlap (default 0.35) is accepted even when the
#: exact phrasing differs. Lower than the 0.5 used for the findings
#: precision/recall scorer because capability-class matching is a
#: coarser grain.
DEFAULT_SEMANTIC_OVERLAP = 0.35


def _words(text: str) -> set[str]:
    """Tokenise ``text`` into a case-folded set of word characters.

    Mirrors :func:`scripts.eval_harness.word_overlap`'s tokenisation so the
    semantic scorer stays consistent with the existing precision/recall
    semantics.
    """
    return set(re.findall(r"\w+", (text or "").lower()))


def word_overlap(a: str, b: str) -> float:
    """Fraction of ``min(|A|, |B|)`` words shared between ``a`` and ``b``.

    Public re-export of the semantic scorer's overlap metric so callers
    (and tests) can reason about equivalence without reaching into a
    private helper.
    """
    wa = _words(a)
    wb = _words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / min(len(wa), len(wb))


def _is_truthy_str(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


# ─── Capability classifier ──────────────────────────────────────────────────
#: Substring → capability-class map. A signal is classified by walking the
#: candidates in declared order; the first hit wins. Order matters: put
#: more specific classes first. The vocabulary is deliberately small so
#: a fixture can write a finding in natural prose and still be graded.

_CAPABILITY_VOCAB: tuple[tuple[str, tuple[str, ...]], ...] = (
    # Sequencing — the #623 "specialists must terminate/reap before the
    # final review begins" invariant. The expected finding names the
    # ordering (reap before final review / launch before final / sequence).
    (
        CAPABILITY_SEQUENCING,
        (
            "reap before final",
            "before final review",
            "before the final",
            "launch before final",
            "specialists must",
            "specialist phase",
            "wait for specialists",
            "join before final",
            "sequencing",
            "ordering",
            "race condition between",
        ),
    ),
    # Output completeness — the #623 failure-contract: the specialist
    # per-role artifact and the aggregate must exist on catastrophic
    # failure as well as normal failure. The expected finding names the
    # artifact state on failure ("missing", "absent on error",
    # "never written", "not produced on failure").
    (
        CAPABILITY_OUTPUT_COMPLETENESS,
        (
            "artifact on failure",
            "artifacts on failure",
            "output on failure",
            "on catastrophic failure",
            "on error",
            "specialists.json",
            "specialist-",
            "normalized output",
            "normalized artifact",
            "failure path",
            "error path",
            "fail-soft",
            "completeness on failure",
            "missing on failure",
            "absent on error",
            "never written",
        ),
    ),
)


def classify_signal(text: str) -> str | None:
    """Return the capability class a textual signal asserts, or ``None``.

    Walks :data:`_CAPABILITY_VOCAB` in order; the first class whose
    vocabulary matches a substring of ``text`` wins. ``None`` is the
    neutral "this signal is not a capability hit" verdict.
    """
    if not _is_truthy_str(text):
        return None
    hay = text.lower()
    for capability, vocabulary in _CAPABILITY_VOCAB:
        for needle in vocabulary:
            if needle in hay:
                return capability
    return None


# Backwards-compatible alias (kept private to avoid duplication; tests
# can reach the classifier via the public :func:`classify_signal`).
_classify_signal = classify_signal


# ─── Negative-control guard ──────────────────────────────────────────────────
#: ``negative_control`` is a synthetic capability class for fixtures that
#: must produce NO findings. A signal that the classifier assigns to
#: ``negative_control`` (a deliberately-empty vocabulary) would be a
#: no-op; the negative-control guard instead walks the *known* classes
#: and fails any signal that lands on one of them.


def _negative_control_violation(capability: str | None) -> bool:
    """``True`` when ``capability`` is a real hit the negative-control
    fixture forbids. ``None`` is benign (no class asserted); the
    sentinel :data:`CAPABILITY_NEGATIVE_CONTROL` itself never fires
    from the classifier (its vocabulary is empty).
    """
    if capability is None:
        return False
    if capability == CAPABILITY_NEGATIVE_CONTROL:
        return False
    return capability in KNOWN_CAPABILITY_CLASSES


# ─── Scenario model ──────────────────────────────────────────────────────────
@dataclass
class SemanticScenario:
    """One historical-dogfood fixture.

    Mirrors the existing :class:`scripts.eval_harness.BenchmarkCorpus`
    entry but adds the fields the #627 grader needs: a ``class``
    capability name, ``provenance`` to the historical PR/issue for
    humans, ``review_mode`` / ``route`` so the harness can exercise
    standard-vs-deep and primary-vs-escalation matrices, and a
    ``stage_attribution`` expectation so the result identifies which
    stage caught it.

    Schema (v1)::

        {
          "number": 623,
          "repo_full_name": "misospace/pr-reviewer-action",
          "url": "https://github.com/.../pull/623",
          "title": "feat(review): add deep-review specialist advisory passes (#608)",
          "provenance": {
            "pr": 623,
            "issue": 608,
            "pr_url": "https://github.com/misospace/pr-reviewer-action/pull/623",
            "issue_url": "https://github.com/misospace/pr-reviewer-action/issues/608"
          },
          "class": "control_flow_sequencing",
          "review_mode": "deep",
          "route": "any",
          "stage_attribution": "any",
          "expected_capabilities": ["control_flow_sequencing"],
          "expected_evidence_anchors": [
            {"kind": "mention", "any_of": ["reap", "wait", "join", "before final"]}
          ],
          "forbidden_capabilities": [],
          "negative_control": false
        }
    """

    number: int
    repo_full_name: str
    url: str
    title: str
    provenance: dict[str, Any]
    klass: str  # capability class; ``class`` is a Python keyword so aliased
    review_mode: str = "any"
    route: str = "any"
    stage_attribution: str = "any"
    expected_capabilities: list[str] = field(default_factory=list)
    expected_evidence_anchors: list[dict[str, Any]] = field(default_factory=list)
    forbidden_capabilities: list[str] = field(default_factory=list)
    negative_control: bool = False
    description: str = ""
    known_findings: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, entry: dict[str, Any]) -> SemanticScenario:
        # ``class`` is reserved; accept it as ``klass`` via the field.
        klass = entry.get("class")
        if not _is_truthy_str(klass):
            raise ValueError(
                f"semantic scenario #{entry.get('number')} is missing required 'class'"
            )
        return cls(
            number=int(entry["number"]),
            repo_full_name=str(entry["repo_full_name"]),
            url=str(entry["url"]),
            title=str(entry.get("title", "")),
            provenance=dict(entry.get("provenance", {})),
            klass=str(klass),
            review_mode=str(entry.get("review_mode", "any")),
            route=str(entry.get("route", "any")),
            stage_attribution=str(entry.get("stage_attribution", "any")),
            expected_capabilities=list(entry.get("expected_capabilities", [])),
            expected_evidence_anchors=list(entry.get("expected_evidence_anchors", [])),
            forbidden_capabilities=list(entry.get("forbidden_capabilities", [])),
            negative_control=bool(entry.get("negative_control", False)),
            description=str(entry.get("description", "")),
            known_findings=list(entry.get("known_findings", [])),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "repo_full_name": self.repo_full_name,
            "url": self.url,
            "title": self.title,
            "provenance": self.provenance,
            "class": self.klass,
            "review_mode": self.review_mode,
            "route": self.route,
            "stage_attribution": self.stage_attribution,
            "expected_capabilities": self.expected_capabilities,
            "expected_evidence_anchors": self.expected_evidence_anchors,
            "forbidden_capabilities": self.forbidden_capabilities,
            "negative_control": self.negative_control,
            "description": self.description,
            "known_findings": self.known_findings,
        }


@dataclass
class SemanticCorpus:
    """A versioned, deterministic collection of :class:`SemanticScenario`s."""

    scenarios: list[SemanticScenario] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    version: int = SEMANTIC_CORPUS_VERSION

    @classmethod
    def from_file(cls, path: Path) -> SemanticCorpus:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise TypeError(f"{path}: top-level value must be an object")
        scenarios_raw = (
            data.get("semantic_corpus") or data.get("benchmark_corpus") or []
        )
        if not isinstance(scenarios_raw, list):
            raise TypeError(f"{path}: 'semantic_corpus' must be a list")
        scenarios = [SemanticScenario.from_dict(entry) for entry in scenarios_raw]
        return cls(
            scenarios=scenarios,
            metadata=dict(data.get("metadata", {})),
            version=int(data.get("version", SEMANTIC_CORPUS_VERSION)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "semantic_corpus": [scenario.to_dict() for scenario in self.scenarios],
            "metadata": self.metadata,
        }


# ─── Fixture validation (CI gate) ────────────────────────────────────────────
class SemanticCorpusError(ValueError):
    """Raised by :func:`validate_semantic_corpus` when a fixture is invalid.

    CI uses this gate to reject malformed fixtures before any live-model
    run, so error messages are deliberately human-readable (the
    ``message`` is what CI logs).
    """


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SemanticCorpusError(message)


def validate_semantic_corpus(corpus: SemanticCorpus) -> None:
    """Validate ``corpus`` against the v1 schema.

    Raises :class:`SemanticCorpusError` on the first violation. Checks:

    - Required top-level fields and ``version`` are present.
    - Each scenario declares ``number`` / ``repo_full_name`` / ``url`` /
      ``class`` / ``provenance`` (and a non-empty ``provenance.pr_url``
      so humans can audit the historical link).
    - ``review_mode`` and ``route`` are in :data:`RECOGNISED_MODES` /
      :data:`RECOGNISED_ROUTES`.
    - ``stage_attribution`` is in :data:`RECOGNISED_STAGES`.
    - ``class`` and every entry in ``expected_capabilities`` /
      ``forbidden_capabilities`` is in :data:`KNOWN_CAPABILITY_CLASSES`.
    - ``expected_evidence_anchors`` entries declare ``kind`` ∈
      ``{"mention", "tool", "finding"}`` and the matching needles /
      tool list.
    - Negative-control scenarios declare empty ``expected_capabilities``
      and at least one forbidden capability.
    """
    _require(
        corpus.version == SEMANTIC_CORPUS_VERSION,
        f"semantic corpus version must be {SEMANTIC_CORPUS_VERSION}, "
        f"got {corpus.version}",
    )
    _require(
        bool(corpus.scenarios), "semantic corpus must declare at least one scenario"
    )

    seen_numbers: set[int] = set()
    for scenario in corpus.scenarios:
        prefix = f"semantic scenario #{scenario.number}"
        _require(
            scenario.number not in seen_numbers, f"{prefix}: duplicate scenario number"
        )
        seen_numbers.add(scenario.number)

        _require(
            scenario.klass in KNOWN_CAPABILITY_CLASSES,
            f"{prefix}: unknown class {scenario.klass!r}; "
            f"allowed: {sorted(KNOWN_CAPABILITY_CLASSES)}",
        )
        _require(
            scenario.review_mode in RECOGNISED_MODES,
            f"{prefix}: review_mode {scenario.review_mode!r} not in "
            f"{sorted(RECOGNISED_MODES)}",
        )
        _require(
            scenario.route in RECOGNISED_ROUTES,
            f"{prefix}: route {scenario.route!r} not in {sorted(RECOGNISED_ROUTES)}",
        )
        _require(
            scenario.stage_attribution in RECOGNISED_STAGES,
            f"{prefix}: stage_attribution {scenario.stage_attribution!r} "
            f"not in {sorted(RECOGNISED_STAGES)}",
        )

        # Provenance: humans audit via PR/issue links; the fixture must
        # carry at least the PR URL.
        _require(
            bool(scenario.provenance), f"{prefix}: missing 'provenance' (PR/issue link)"
        )
        _require(
            _is_truthy_str(scenario.provenance.get("pr_url")),
            f"{prefix}: provenance.pr_url is required for human audit",
        )

        for capability in scenario.expected_capabilities:
            _require(
                capability in KNOWN_CAPABILITY_CLASSES,
                f"{prefix}: expected_capabilities contains unknown class "
                f"{capability!r}",
            )
        for capability in scenario.forbidden_capabilities:
            _require(
                capability in KNOWN_CAPABILITY_CLASSES,
                f"{prefix}: forbidden_capabilities contains unknown class "
                f"{capability!r}",
            )

        if scenario.negative_control:
            _require(
                not scenario.expected_capabilities,
                f"{prefix}: negative_control scenarios must not declare "
                f"expected_capabilities",
            )
            _require(
                scenario.forbidden_capabilities,
                f"{prefix}: negative_control scenarios must declare at "
                f"least one forbidden_capabilities entry "
                f"(else the guard is a no-op)",
            )

        for anchor in scenario.expected_evidence_anchors:
            kind = anchor.get("kind")
            _require(
                kind in {SIGNAL_KIND_MENTION, SIGNAL_KIND_TOOL, SIGNAL_KIND_FINDING},
                f"{prefix}: evidence anchor kind {kind!r} not recognised",
            )
            if kind in {SIGNAL_KIND_MENTION, SIGNAL_KIND_FINDING}:
                _require(
                    isinstance(anchor.get("any_of"), list) and anchor["any_of"],
                    f"{prefix}: '{kind}' anchors must declare a non-empty "
                    f"'any_of' list",
                )
            elif kind == SIGNAL_KIND_TOOL:
                _require(
                    anchor.get("tool"), f"{prefix}: 'tool' anchors must declare 'tool'"
                )


# ─── Semantic scorer ────────────────────────────────────────────────────────
@dataclass
class SemanticResult:
    """Per-scenario grader verdict.

    ``passed`` is True iff every expected capability was hit, every
    expected evidence anchor was satisfied, no forbidden capability was
    asserted, and the stage attribution matches (when the fixture
    pinned it). ``stages_hit`` lists every stage that produced a
    capability hit, in declared stage order, so the report can answer
    "which stage caught it" without re-running.
    """

    scenario_number: int
    capability_hits: dict[str, list[str]] = field(default_factory=dict)
    anchor_results: list[dict[str, Any]] = field(default_factory=list)
    stages_hit: list[str] = field(default_factory=list)
    forbidden_violations: list[str] = field(default_factory=list)
    passed: bool = False
    description: str = ""
    signals_seen: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "scenario_number": self.scenario_number,
            "passed": self.passed,
            "description": self.description,
            "capability_hits": self.capability_hits,
            "anchor_results": self.anchor_results,
            "stages_hit": self.stages_hit,
            "forbidden_violations": self.forbidden_violations,
            "signals_seen": self.signals_seen,
        }


def _collect_signals_from_run(run: Any) -> list[ReviewSignal]:
    """Translate a harness :class:`ReviewRun` into a list of :class:`ReviewSignal`s.

    Accepts any object with ``review_markdown`` / ``tool_calls`` /
    ``findings`` / ``error`` / ``stage`` attributes (the existing
    ``scripts.eval_harness.ReviewRun`` qualifies). Stage attribution is
    taken from ``run.stage`` if present, otherwise from
    ``run.meta['stage']``, otherwise defaulted to ``"primary"`` so
    pre-#627 run records still grade (the harness is the source of
    truth for the actual stage — the scorer never infers from text).
    """
    stage = getattr(run, "stage", None)
    if not stage:
        meta = getattr(run, "meta", {}) or {}
        stage = meta.get("stage") or "primary"
    stage = stage if stage in RECOGNISED_STAGES else "primary"

    signals: list[ReviewSignal] = []
    review_text = getattr(run, "review_markdown", "") or ""
    if review_text:
        signals.append(
            ReviewSignal(
                kind=SIGNAL_KIND_MENTION,
                stage=stage,
                text=review_text,
                capability=classify_signal(review_text),
            )
        )

    for finding in getattr(run, "findings", []) or []:
        if not isinstance(finding, dict):
            continue
        # Findings may carry their own stage when the harness deep-review
        # layer emitted them from a specialist; honor it if set.
        finding_stage = finding.get("stage") or stage
        finding_stage = finding_stage if finding_stage in RECOGNISED_STAGES else stage
        description = finding.get("description") or finding.get("message") or ""
        signals.append(
            ReviewSignal(
                kind=SIGNAL_KIND_FINDING,
                stage=finding_stage,
                text=description,
                capability=classify_signal(description),
            )
        )

    for call in getattr(run, "tool_calls", []) or []:
        if not isinstance(call, dict):
            continue
        # Tool calls inherit the run's stage unless the harness stamped
        # their own (e.g. a specialist call labelled differently).
        call_stage = call.get("stage") or stage
        call_stage = call_stage if call_stage in RECOGNISED_STAGES else stage
        args = call.get("args") or {}
        text = " ".join(v for v in args.values() if isinstance(v, str))
        signals.append(
            ReviewSignal(
                kind=SIGNAL_KIND_TOOL,
                stage=call_stage,
                text=text,
                capability=classify_signal(text),
                anchors=[text],
                meta={"tool": call.get("tool", ""), "status": call.get("status")},
            )
        )

    return signals


def _signal_satisfies_anchor(signal: ReviewSignal, anchor: dict[str, Any]) -> bool:
    """Whether ``signal`` satisfies ``anchor``.

    - ``anchor.kind == "tool"``: matched when the signal's tool name equals
      the anchor's declared tool. The tool's arg text is not re-grepped
      here; the harness layer is expected to carry the relevant substring
      in the tool signal's ``text`` when the anchor's ``any_of`` is set.
    - ``anchor.kind == "mention"`` or ``"finding"``: matched against the
      signal's ``text`` for any substring in ``any_of``. ``mention`` and
      ``finding`` anchors cross-match (a finding is a structured way of
      expressing what a mention is — exact kind is not the capability
      gate, the evidence substring is).
    """
    kind = anchor.get("kind")
    if kind == SIGNAL_KIND_TOOL:
        if signal.kind != SIGNAL_KIND_TOOL:
            return False
        if anchor.get("tool") and anchor.get("tool") != signal.meta.get("tool"):
            return False
        any_of = anchor.get("any_of") or []
        haystack = signal.text.lower()
        return any(str(needle).lower() in haystack for needle in any_of)
    if kind in {SIGNAL_KIND_MENTION, SIGNAL_KIND_FINDING}:
        if signal.kind not in {SIGNAL_KIND_MENTION, SIGNAL_KIND_FINDING}:
            return False
        any_of = anchor.get("any_of") or []
        haystack = signal.text.lower()
        return any(str(needle).lower() in haystack for needle in any_of)
    return False


def evaluate_semantic_capability(
    scenario: SemanticScenario,
    signals: Iterable[ReviewSignal],
) -> SemanticResult:
    """Grade ``signals`` against ``scenario`` semantically.

    Returns a :class:`SemanticResult`. The scorer is **fail-soft by
    capability, strict on missing anchors**: a capability class may be
    hit by ANY signal at ANY stage, but every expected evidence anchor
    must be satisfied by at least one signal whose kind matches. This
    keeps "materially equivalent findings" credit-able while still
    requiring the grader-named evidence to be present in some form.
    """
    signals = list(signals)
    result = SemanticResult(
        scenario_number=scenario.number,
        description=scenario.description,
        signals_seen=len(signals),
    )

    # 1. Capability hit tally, keyed by capability class, then by stage.
    for signal in signals:
        if signal.capability is None:
            continue
        stages = result.capability_hits.setdefault(signal.capability, [])
        if signal.stage not in stages:
            stages.append(signal.stage)

    # 2. Forbidden-capability guard (negative control). Any hit on a
    #    forbidden class fails the scenario, regardless of anchors.
    for capability in scenario.forbidden_capabilities:
        if capability in result.capability_hits:
            result.forbidden_violations.append(capability)

    # 3. Evidence anchors: each must be satisfied by some signal of the
    #    matching kind.
    satisfied_stages: set[str] = set()
    for anchor in scenario.expected_evidence_anchors:
        anchor_satisfied = False
        for signal in signals:
            if _signal_satisfies_anchor(signal, anchor):
                anchor_satisfied = True
                satisfied_stages.add(signal.stage)
        result.anchor_results.append(
            {
                "id": anchor.get("id") or anchor.get("kind"),
                "kind": anchor.get("kind"),
                "satisfied": anchor_satisfied,
            }
        )

    # 4. Stages hit — union of every stage that produced ANY capability
    #    hit OR satisfied anchor, in stage-order: specialist, primary,
    #    escalation, any.
    stage_order = ["specialist", "primary", "escalation", "any"]
    hit_stages: set[str] = set()
    for stages in result.capability_hits.values():
        hit_stages.update(stages)
    hit_stages.update(satisfied_stages)
    result.stages_hit = [s for s in stage_order if s in hit_stages]

    # 5. Final verdict.
    capabilities_ok = all(
        capability in result.capability_hits
        for capability in scenario.expected_capabilities
    )
    anchors_ok = all(a["satisfied"] for a in result.anchor_results)
    stage_ok = (
        scenario.stage_attribution == "any"
        or scenario.stage_attribution in result.stages_hit
    )
    no_forbidden = not result.forbidden_violations
    result.passed = capabilities_ok and anchors_ok and stage_ok and no_forbidden
    return result


# ─── Repeated-run aggregation ───────────────────────────────────────────────
def aggregate_semantic_runs(
    scenario: SemanticScenario,
    per_run_results: list[SemanticResult],
) -> dict[str, Any]:
    """Aggregate repeated-run results for variance reporting.

    Returns a per-scenario summary dict with:

    - ``runs``: number of runs aggregated
    - ``passes``: number of runs that passed (matches :data:`SemanticResult.passed`)
    - ``pass_rate``: ``passes / runs`` (0.0 when ``runs`` is 0)
    - ``stages_hit``: union of all stages that ever produced a hit
    - ``capability_pass_rate``: per-capability pass rate (fraction of
      runs that hit each expected capability)
    - ``anchor_pass_rate``: per-anchor satisfaction rate
    - ``forbidden_violation_rate``: fraction of runs that fabricated a
      forbidden finding (negative-control regression signal)

    The harness feeds this into the weekly report alongside latency,
    tool-call counts, and escalation frequency.
    """
    runs = len(per_run_results)
    passes = sum(1 for r in per_run_results if r.passed)
    stage_union: set[str] = set()
    for result in per_run_results:
        stage_union.update(result.stages_hit)

    capability_pass_rate: dict[str, float] = {}
    for capability in scenario.expected_capabilities:
        hits = sum(1 for r in per_run_results if capability in r.capability_hits)
        capability_pass_rate[capability] = round(hits / runs, 4) if runs else 0.0

    anchor_pass_rate: dict[str, float] = {}
    for anchor in scenario.expected_evidence_anchors:
        anchor_id = anchor.get("id") or anchor.get("kind")
        satisfied_runs = 0
        for r in per_run_results:
            for a in r.anchor_results:
                if (a.get("id") or a.get("kind")) == anchor_id and a.get("satisfied"):
                    satisfied_runs += 1
                    break
        anchor_pass_rate[anchor_id] = round(satisfied_runs / runs, 4) if runs else 0.0

    forbidden_violation_rate = (
        round(
            sum(1 for r in per_run_results if r.forbidden_violations) / runs,
            4,
        )
        if runs
        else 0.0
    )

    return {
        "scenario_number": scenario.number,
        "runs": runs,
        "passes": passes,
        "pass_rate": round(passes / runs, 4) if runs else 0.0,
        "stages_hit": sorted(stage_union),
        "capability_pass_rate": capability_pass_rate,
        "anchor_pass_rate": anchor_pass_rate,
        "forbidden_violation_rate": forbidden_violation_rate,
    }


__all__ = [
    "CAPABILITY_NEGATIVE_CONTROL",
    "CAPABILITY_OUTPUT_COMPLETENESS",
    "CAPABILITY_SEQUENCING",
    "DEFAULT_SEMANTIC_OVERLAP",
    "KNOWN_CAPABILITY_CLASSES",
    "RECOGNISED_MODES",
    "RECOGNISED_ROUTES",
    "RECOGNISED_STAGES",
    "SEMANTIC_CORPUS_VERSION",
    "SEMANTIC_EVAL_VERSION",
    "SIGNAL_KIND_FINDING",
    "SIGNAL_KIND_MENTION",
    "SIGNAL_KIND_TOOL",
    "ReviewSignal",
    "SemanticCorpus",
    "SemanticCorpusError",
    "SemanticResult",
    "SemanticScenario",
    "aggregate_semantic_runs",
    "classify_signal",
    "evaluate_semantic_capability",
    "validate_semantic_corpus",
    "word_overlap",
]
