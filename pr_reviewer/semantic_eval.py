from __future__ import annotations

import json
import math
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SEMANTIC_CORPUS_VERSION = 1
SEMANTIC_EVAL_VERSION = 1

RECOGNISED_STAGES = frozenset({"specialist", "primary", "escalation", "any"})
RECOGNISED_MODES = frozenset({"standard", "deep", "any"})
RECOGNISED_ROUTES = frozenset({"primary", "escalation", "primary+escalation", "any"})
RECOGNISED_DIFF_POLARITIES = frozenset({"deletion"})

CAPABILITY_SEQUENCING = "control_flow_sequencing"
CAPABILITY_OUTPUT_COMPLETENESS = "output_completeness"
CAPABILITY_FULL_REVIEW_LOOP = "full_review_loop"
CAPABILITY_RUNTIME_PROTOCOL = "runtime_protocol"
CAPABILITY_STALE_REVIEW_STATE = "stale_review_state"
CAPABILITY_DIFF_POLARITY = "diff_polarity"
CAPABILITY_NEGATIVE_CONTROL = "negative_control"
KNOWN_CAPABILITY_CLASSES = frozenset(
    {
        CAPABILITY_SEQUENCING,
        CAPABILITY_OUTPUT_COMPLETENESS,
        CAPABILITY_FULL_REVIEW_LOOP,
        CAPABILITY_RUNTIME_PROTOCOL,
        CAPABILITY_STALE_REVIEW_STATE,
        CAPABILITY_DIFF_POLARITY,
        CAPABILITY_NEGATIVE_CONTROL,
    }
)

SIGNAL_KIND_FINDING = "finding"
SIGNAL_KIND_MENTION = "mention"
SIGNAL_KIND_TOOL = "tool"
SIGNAL_KINDS = frozenset({SIGNAL_KIND_FINDING, SIGNAL_KIND_MENTION, SIGNAL_KIND_TOOL})
_VOCABULARY: tuple[tuple[str, tuple[str, ...]], ...] = (
    (CAPABILITY_SEQUENCING, (
        "reap before final", "wait for specialists", "join before final",
        "reaped before", "all specialists reaped", "specialist phase completes",
        "race condition between", "launch before final", "launched before final",
        "specialists must terminate",
        "specialists must complete", "specialist phase ordering",
        "specialist phase must", "specialists must reap",
    )),
    (CAPABILITY_OUTPUT_COMPLETENESS, (
        "artifact on failure", "artifacts on failure", "output on failure",
        "on catastrophic failure", "on error", "normalized output",
        "normalized artifact", "failure path", "error path", "fail-soft",
        "completeness on failure", "missing on failure", "absent on error",
        "never written",
    )),
    (CAPABILITY_FULL_REVIEW_LOOP, (
        "needs_full_review", "needs full review", "full-review loop",
        "full review loop", "rerun the full review", "run the full review",
        "full pr review", "full-pr review", "re-enter the full review",
        "full review after", "must trigger a full review",
    )),
    (CAPABILITY_RUNTIME_PROTOCOL, (
        "deleted runtime protocol", "removed runtime protocol", "stale default prompt",
        "prompt references deleted", "prompt still references", "runtime protocol is gone",
        "protocol no longer exists", "deleted tool protocol", "unsupported runtime protocol",
        "prompt and runtime disagree", "runtime no longer supports",
    )),
    (CAPABILITY_STALE_REVIEW_STATE, (
        "stale previous review", "previous review state", "carried findings",
        "carry-forward state", "stale review metadata", "old review state",
        "dead prior-review state", "prior review state is dead", "previous-review",
        "previous review is stale", "stale documentation", "docs still describe",
        "documentation still describes", "docs survive architectural deletion",
        "state no longer exists", "removed state", "deleted state",
    )),
    (CAPABILITY_DIFF_POLARITY, (
        "deleted declaration still exists", "deleted declarations still exist",
        "removed declaration is still present", "deleted code is still present",
        "treats deleted as present", "deleted-only declaration", "deleted symbol remains",
        "asserts deleted", "deletion is treated as an addition", "diff polarity",
        "deleted side of the diff", "removed side of the diff",
    )),
)


def _words(text: str) -> set[str]:
    return set(re.findall(r"\w+", (text or "").casefold()))


def _truthy(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _sentence_for_match(value: str, position: int) -> tuple[str, int]:
    start = max(value.rfind(mark, 0, position) for mark in ".!?\n") + 1
    end_candidates = [value.find(mark, position) for mark in ".!?\n"]
    ends = [end for end in end_candidates if end >= 0]
    end = min(ends) if ends else len(value)
    return value[start:end], start


def classify_signal(text: str) -> str | None:
    value = (text or "").casefold()
    for capability, vocabulary in _VOCABULARY:
        for term in vocabulary:
            match = re.search(rf"(?<!\w){re.escape(term)}(?!\w)", value)
            if match is None:
                continue
            if capability == CAPABILITY_DIFF_POLARITY:
                sentence, sentence_start = _sentence_for_match(value, match.start())
                prefix = sentence[: match.start() - sentence_start]
                if re.search(
                    r"\b(?:not|never|without|absent|no|doesn't|isn't|is not|do not|must not|should not|cannot|can't|avoid)\b",
                    prefix,
                ):
                    continue
                if re.search(r"\b(?:assert|claim|treat|say|report|suggest)\b", prefix):
                    continue
            return capability
    return None


@dataclass
class ReviewSignal:
    kind: str
    stage: str
    text: str
    capability: str | None = None
    anchors: list[str] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.capability is None:
            self.capability = classify_signal(self.text)


@dataclass
class SemanticScenario:
    number: int
    repo_full_name: str
    url: str
    title: str
    provenance: dict[str, Any]
    klass: str
    review_mode: str = "any"
    route: str = "any"
    stage_attribution: str = "any"
    expected_capabilities: list[str] = field(default_factory=list)
    expected_evidence_anchors: list[dict[str, Any]] = field(default_factory=list)
    forbidden_capabilities: list[str] = field(default_factory=list)
    negative_control: bool = False
    description: str = ""
    known_findings: list[dict[str, Any]] = field(default_factory=list)
    expected_metrics: dict[str, Any] = field(default_factory=dict)
    diff_polarity: str | None = None
    offline_runs: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, entry: dict[str, Any]) -> SemanticScenario:
        if not isinstance(entry, dict):
            raise SemanticCorpusError("semantic scenario entries must be objects")
        klass = entry.get("class")
        if not _truthy(klass):
            raise ValueError(f"semantic scenario #{entry.get('number')} is missing required 'class'")
        return cls(
            number=entry.get("number"),
            repo_full_name=entry.get("repo_full_name"),
            url=entry.get("url"),
            title=entry.get("title", ""),
            provenance=entry.get("provenance", {}),
            klass=klass,
            review_mode=entry.get("review_mode", "any"),
            route=entry.get("route", "any"),
            stage_attribution=entry.get("stage_attribution", "any"),
            expected_capabilities=entry.get("expected_capabilities", []),
            expected_evidence_anchors=entry.get("expected_evidence_anchors", []),
            forbidden_capabilities=entry.get("forbidden_capabilities", []),
            negative_control=entry.get("negative_control", False),
            description=entry.get("description", ""),
            known_findings=entry.get("known_findings", []),
            expected_metrics=entry.get("expected_metrics", {}),
            diff_polarity=entry.get("diff_polarity"),
            offline_runs=entry.get("offline_runs", []),
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
            "expected_metrics": self.expected_metrics,
            "diff_polarity": self.diff_polarity,
            "offline_runs": self.offline_runs,
        }


@dataclass
class SemanticCorpus:
    scenarios: list[SemanticScenario] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    version: int = SEMANTIC_CORPUS_VERSION

    @classmethod
    def from_file(cls, path: Path) -> SemanticCorpus:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise TypeError(f"{path}: top-level value must be an object")
        raw = data.get("semantic_corpus") or data.get("benchmark_corpus") or []
        if not isinstance(raw, list):
            raise TypeError(f"{path}: semantic_corpus must be a list")
        return cls(
            scenarios=[SemanticScenario.from_dict(item) for item in raw],
            metadata=dict(data.get("metadata", {})),
            version=int(data.get("version", SEMANTIC_CORPUS_VERSION)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "semantic_corpus": [scenario.to_dict() for scenario in self.scenarios],
            "metadata": self.metadata,
        }


class SemanticCorpusError(ValueError):
    pass


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise SemanticCorpusError(message)


def validate_semantic_corpus(corpus: SemanticCorpus) -> None:
    _require(corpus.version == SEMANTIC_CORPUS_VERSION, f"semantic corpus version must be {SEMANTIC_CORPUS_VERSION}, got {corpus.version}")
    _require(bool(corpus.scenarios), "semantic corpus must declare at least one scenario")
    seen: set[int] = set()
    for scenario in corpus.scenarios:
        prefix = f"semantic scenario #{scenario.number}"
        _require(isinstance(scenario.number, int) and not isinstance(scenario.number, bool), f"{prefix}: number must be an integer")
        _require(scenario.number not in seen, f"{prefix}: duplicate scenario number")
        seen.add(scenario.number)
        _require(isinstance(scenario.provenance, dict), f"{prefix}: provenance must be an object")
        _require(isinstance(scenario.expected_capabilities, list), f"{prefix}: expected_capabilities must be a list")
        _require(isinstance(scenario.forbidden_capabilities, list), f"{prefix}: forbidden_capabilities must be a list")
        _require(isinstance(scenario.expected_evidence_anchors, list), f"{prefix}: expected_evidence_anchors must be a list")
        _require(isinstance(scenario.klass, str), f"{prefix}: class must be a string")
        _require(scenario.klass in KNOWN_CAPABILITY_CLASSES, f"{prefix}: unknown class {scenario.klass!r}")
        _require(isinstance(scenario.review_mode, str) and scenario.review_mode in RECOGNISED_MODES, f"{prefix}: review_mode {scenario.review_mode!r} not recognised")
        _require(isinstance(scenario.route, str) and scenario.route in RECOGNISED_ROUTES, f"{prefix}: route {scenario.route!r} not recognised")
        _require(isinstance(scenario.stage_attribution, str) and scenario.stage_attribution in RECOGNISED_STAGES, f"{prefix}: stage_attribution {scenario.stage_attribution!r} not recognised")
        if scenario.diff_polarity is not None:
            _require(scenario.diff_polarity in RECOGNISED_DIFF_POLARITIES, f"{prefix}: diff_polarity {scenario.diff_polarity!r} not recognised")
        _require(_truthy(scenario.repo_full_name), f"{prefix}: repo_full_name is required")
        _require(_truthy(scenario.url), f"{prefix}: url is required")
        _require(_truthy(scenario.provenance.get("pr_url")), f"{prefix}: provenance.pr_url is required")
        _require(scenario.provenance.get("issue") is not None, f"{prefix}: provenance.issue is required")
        _require(isinstance(scenario.negative_control, bool), f"{prefix}: negative_control must be a boolean")
        for capability in scenario.expected_capabilities + scenario.forbidden_capabilities:
            _require(isinstance(capability, str), f"{prefix}: capabilities must be strings")
            _require(capability in KNOWN_CAPABILITY_CLASSES, f"{prefix}: unknown capability {capability!r}")
        _require(scenario.klass in scenario.expected_capabilities or scenario.negative_control, f"{prefix}: class must be expected or negative_control")
        if scenario.negative_control:
            _require(not scenario.expected_capabilities, f"{prefix}: negative controls cannot expect capabilities")
            _require(bool(scenario.forbidden_capabilities), f"{prefix}: negative controls need forbidden_capabilities")
        _require(isinstance(scenario.expected_metrics, dict), f"{prefix}: expected_metrics must be an object")
        for key, value in scenario.expected_metrics.items():
            _require(key in {"max_tool_calls", "max_duplicates", "max_latency_sec"}, f"{prefix}: expected_metrics key {key!r} is not recognised")
            if key in {"max_tool_calls", "max_duplicates"}:
                _require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, f"{prefix}: expected_metrics.{key} must be a non-negative integer")
            else:
                _require(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0, f"{prefix}: expected_metrics.{key} must be a finite non-negative number")
        _require(isinstance(scenario.offline_runs, list), f"{prefix}: offline_runs must be a list")
        for fixture in scenario.offline_runs:
            _require(isinstance(fixture, dict), f"{prefix}: offline_runs entries must be objects")
            if "mode" in fixture:
                _require(fixture["mode"] in RECOGNISED_MODES - {"any"}, f"{prefix}: offline run mode is not recognised")
            if "route" in fixture:
                _require(fixture["route"] in RECOGNISED_ROUTES, f"{prefix}: offline run route is not recognised")
        anchor_ids: set[str] = set()
        for anchor in scenario.expected_evidence_anchors:
            _require(isinstance(anchor, dict), f"{prefix}: evidence anchors must be objects")
            if "id" in anchor:
                _require(_truthy(anchor["id"]), f"{prefix}: evidence anchor id must be non-empty")
                _require(anchor["id"] not in anchor_ids, f"{prefix}: duplicate evidence anchor id {anchor['id']!r}")
                anchor_ids.add(anchor["id"])
            kind = anchor.get("kind")
            _require(kind in SIGNAL_KINDS, f"{prefix}: evidence anchor kind {kind!r} not recognised")
            if kind == SIGNAL_KIND_TOOL:
                _require(_truthy(anchor.get("tool")), f"{prefix}: 'tool' anchors must declare 'tool'")
            _require(
                isinstance(anchor.get("any_of"), list) and anchor["any_of"],
                f"{prefix}: '{kind}' anchors must declare a non-empty 'any_of' list",
            )


@dataclass
class SemanticResult:
    scenario_number: int
    capability_hits: dict[str, list[str]] = field(default_factory=dict)
    anchor_results: list[dict[str, Any]] = field(default_factory=list)
    stages_hit: list[str] = field(default_factory=list)
    forbidden_violations: list[str] = field(default_factory=list)
    passed: bool = False
    description: str = ""
    signals_seen: int = 0
    tool_call_count: int = 0
    duplicate_count: int = 0
    latency_sec: float = 0.0
    escalated: bool = False
    route: str | None = None
    mode: str | None = None
    applicability_violations: list[str] = field(default_factory=list)
    metric_violations: list[str] = field(default_factory=list)

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
            "tool_call_count": self.tool_call_count,
            "duplicate_count": self.duplicate_count,
            "latency_sec": self.latency_sec,
            "escalated": self.escalated,
            "route": self.route,
            "mode": self.mode,
            "applicability_violations": self.applicability_violations,
            "metric_violations": self.metric_violations,
        }


def _matches_expected(value: str | None, expected: str) -> bool:
    return expected == "any" or value == expected


def _run_value(run: Any, key: str, default: Any = None) -> Any:
    if isinstance(run, dict):
        return run.get(key, default)
    return getattr(run, key, default)


def _run_metadata(run: Any) -> dict[str, Any]:
    metadata = _run_value(run, "meta", {}) or {}
    return metadata if isinstance(metadata, dict) else {}


def _run_route(run: Any) -> str | None:
    route = _run_value(run, "route") or _run_metadata(run).get("route")
    return str(route) if route else None


def _run_mode(run: Any) -> str | None:
    mode = _run_value(run, "mode") or _run_metadata(run).get("mode")
    if not mode:
        return None
    value = str(mode)
    return "deep" if value.endswith("+deep") or value == "deep" else "standard"


def _run_stage(run: Any) -> str:
    return _run_value(run, "stage") or _run_metadata(run).get("stage") or "primary"


def _route_matches(actual: str | None, expected: str) -> bool:
    if expected == "any":
        return True
    if actual == "any":
        return True
    if expected == actual:
        return True
    return expected == "primary+escalation" and actual in {"primary", "escalation"}


def _collect_signals_from_run(run: Any) -> list[ReviewSignal]:
    stage = _run_stage(run)
    if stage not in RECOGNISED_STAGES:
        stage = "primary"
    signals: list[ReviewSignal] = []
    review = _run_value(run, "review_markdown", "") or ""
    if review:
        signals.append(ReviewSignal(SIGNAL_KIND_MENTION, stage, review))
    for finding in _run_value(run, "findings", []) or []:
        if not isinstance(finding, dict):
            continue
        finding_stage = finding.get("stage") or stage
        if finding_stage not in RECOGNISED_STAGES:
            finding_stage = stage
        text = finding.get("description") or finding.get("message") or ""
        signals.append(ReviewSignal(SIGNAL_KIND_FINDING, finding_stage, str(text), meta=finding))
    for call in _run_value(run, "tool_calls", []) or []:
        if not isinstance(call, dict):
            continue
        call_stage = call.get("stage") or stage
        if call_stage not in RECOGNISED_STAGES:
            call_stage = stage
        args = call.get("args") or {}
        text = " ".join(str(value) for value in args.values() if isinstance(value, str))
        signals.append(ReviewSignal(SIGNAL_KIND_TOOL, call_stage, text, meta={"tool": call.get("tool", ""), "status": call.get("status")}))
    return signals


def _anchor_matches(signal: ReviewSignal, anchor: dict[str, Any]) -> bool:
    if signal.kind != anchor.get("kind") and not ({signal.kind, anchor.get("kind")} <= {SIGNAL_KIND_MENTION, SIGNAL_KIND_FINDING}):
        return False
    if anchor.get("kind") == SIGNAL_KIND_TOOL and anchor.get("tool") != signal.meta.get("tool"):
        return False
    haystack = signal.text.casefold()
    return any(str(needle).casefold() in haystack for needle in anchor.get("any_of", []))


def evaluate_semantic_capability(
    scenario: SemanticScenario,
    signals: Iterable[ReviewSignal],
    run_metadata: dict[str, Any] | None = None,
) -> SemanticResult:
    values = list(signals)
    metadata = run_metadata or {}
    signal_tool_calls = sum(signal.kind == SIGNAL_KIND_TOOL for signal in values)
    declared_tool_calls = metadata.get("tool_call_count", metadata.get("tool_calls"))
    if isinstance(declared_tool_calls, (list, tuple)):
        declared_tool_calls = len(declared_tool_calls)
    try:
        tool_call_count = int(declared_tool_calls) if declared_tool_calls is not None else signal_tool_calls
    except (TypeError, ValueError):
        tool_call_count = signal_tool_calls
    result = SemanticResult(
        scenario_number=scenario.number,
        description=scenario.description,
        signals_seen=len(values),
        tool_call_count=tool_call_count,
        duplicate_count=int(metadata.get("duplicate_count", 0)),
        latency_sec=float(metadata.get("latency_sec", 0.0) or 0.0),
        escalated=bool(metadata.get("escalated", False)),
        route=_run_route(metadata),
        mode=_run_mode(metadata),
    )

    if not _matches_expected(result.mode, scenario.review_mode):
        result.applicability_violations.append(f"review_mode={result.mode!r}, expected={scenario.review_mode!r}")
    if not _route_matches(result.route, scenario.route):
        result.applicability_violations.append(f"route={result.route!r}, expected={scenario.route!r}")
    if scenario.expected_metrics.get("max_tool_calls") is not None and result.tool_call_count > scenario.expected_metrics["max_tool_calls"]:
        result.metric_violations.append("max_tool_calls")
    if scenario.expected_metrics.get("max_duplicates") is not None and result.duplicate_count > scenario.expected_metrics["max_duplicates"]:
        result.metric_violations.append("max_duplicates")
    if scenario.expected_metrics.get("max_latency_sec") is not None and result.latency_sec > scenario.expected_metrics["max_latency_sec"]:
        result.metric_violations.append("max_latency_sec")
    for signal in values:
        if signal.capability:
            result.capability_hits.setdefault(signal.capability, [])
            if signal.stage not in result.capability_hits[signal.capability]:
                result.capability_hits[signal.capability].append(signal.stage)
    result.forbidden_violations = [capability for capability in scenario.forbidden_capabilities if capability in result.capability_hits]
    anchor_stages: set[str] = set()
    for index, anchor in enumerate(scenario.expected_evidence_anchors):
        matching = [signal for signal in values if _anchor_matches(signal, anchor)]
        anchor_stages.update(signal.stage for signal in matching)
        result.anchor_results.append({"id": anchor.get("id") or f"anchor-{index}", "kind": anchor.get("kind"), "satisfied": bool(matching), "stages": sorted({signal.stage for signal in matching})})
    hit_stages = set(anchor_stages)
    for stages in result.capability_hits.values():
        hit_stages.update(stages)
    result.stages_hit = [stage for stage in ("specialist", "primary", "escalation", "any") if stage in hit_stages]
    capabilities_ok = all(capability in result.capability_hits for capability in scenario.expected_capabilities)
    anchors_ok = all(item["satisfied"] for item in result.anchor_results)
    stage_ok = scenario.stage_attribution == "any" or scenario.stage_attribution in result.stages_hit
    if scenario.stage_attribution != "any" and scenario.stage_attribution not in result.stages_hit:
        result.applicability_violations.append(f"stage_attribution={result.stages_hit!r}, expected={scenario.stage_attribution!r}")
    result.passed = capabilities_ok and anchors_ok and stage_ok and not result.forbidden_violations and not result.applicability_violations and not result.metric_violations
    return result


def _fixture_signals(fixture: dict[str, Any]) -> list[ReviewSignal]:
    class FixtureRun:
        pass

    run = FixtureRun()
    run.stage = fixture.get("stage", "primary")
    run.review_markdown = fixture.get("review_markdown", "")
    run.findings = fixture.get("findings", [])
    run.tool_calls = fixture.get("tool_calls", [])
    return _collect_signals_from_run(run)


def evaluate_offline_scenario(scenario: SemanticScenario) -> list[SemanticResult]:
    results: list[SemanticResult] = []
    for fixture in scenario.offline_runs:
        if not isinstance(fixture, dict):
            continue
        signals = _fixture_signals(fixture)
        metadata = dict(fixture.get("metadata", {}))
        for key in ("mode", "route", "escalated", "duplicate_count", "latency_sec", "tool_calls", "tool_call_count"):
            if key in fixture:
                metadata[key] = fixture[key]
        result = evaluate_semantic_capability(scenario, signals, metadata)
        results.append(result)
    return results


def evaluate_semantic_corpus(corpus: SemanticCorpus) -> dict[str, Any]:
    validate_semantic_corpus(corpus)
    scenario_reports: list[dict[str, Any]] = []
    for scenario in corpus.scenarios:
        per_run = evaluate_offline_scenario(scenario)
        aggregate = aggregate_semantic_runs(scenario, per_run)
        aggregate["provenance"] = scenario.provenance
        aggregate["class"] = scenario.klass
        aggregate["negative_control"] = scenario.negative_control
        aggregate["diff_polarity"] = scenario.diff_polarity
        aggregate["review_mode"] = scenario.review_mode
        aggregate["route_expected"] = scenario.route
        aggregate["stage_attribution_expected"] = scenario.stage_attribution

        aggregate["attribution_rates"] = {
            stage: round(sum(stage in result.stages_hit for result in per_run) / len(per_run), 4) if per_run else 0.0
            for stage in ("specialist", "primary", "escalation")
        }
        scenario_reports.append(aggregate)
    scored = [item for item in scenario_reports if item["runs"]]
    negative_controls = [item for item in scenario_reports if item["negative_control"]]
    summary = {
        "scenarios": len(scenario_reports),
        "scored_scenarios": len(scored),
        "pass_rate": round(sum(item["pass_rate"] for item in scored) / len(scored), 4) if scored else 0.0,
        "false_positive_rate": round(sum(item["false_positive_rate"] for item in negative_controls) / len(negative_controls), 4) if negative_controls else 0.0,
        "average_tool_calls": round(sum(item["average_tool_calls"] for item in scored) / len(scored), 4) if scored else 0.0,
        "average_duplicate_count": round(sum(item["average_duplicate_count"] for item in scored) / len(scored), 4) if scored else 0.0,
        "average_latency_sec": round(sum(item["average_latency_sec"] for item in scored) / len(scored), 4) if scored else 0.0,
        "escalation_frequency": round(sum(item["escalation_frequency"] for item in scored) / len(scored), 4) if scored else 0.0,
    }
    return {
        "evaluator_version": SEMANTIC_EVAL_VERSION,
        "corpus_version": corpus.version,
        "metadata": corpus.metadata,
        "scenarios": scenario_reports,
        "summary": summary,
        "passed": all(item["pass_rate"] == 1.0 for item in scored) and bool(scored) and all(item["false_positive_rate"] == 0.0 for item in negative_controls),
        "scenarios_evaluated": len(scenario_reports),
        "per_scenario_summary": {str(item["scenario_number"]): item for item in scenario_reports},
        "negative_control_summary": {
            "scenarios": len(negative_controls),
            "false_positive_rate": round(sum(item["false_positive_rate"] for item in negative_controls) / len(negative_controls), 4) if negative_controls else 0.0,
        },
    }


def aggregate_semantic_runs(scenario: SemanticScenario, per_run_results: list[SemanticResult]) -> dict[str, Any]:
    runs = len(per_run_results)
    passes = sum(result.passed for result in per_run_results)
    stage_union = sorted({stage for result in per_run_results for stage in result.stages_hit})
    capability_rates = {
        capability: round(sum(capability in result.capability_hits for result in per_run_results) / runs, 4) if runs else 0.0
        for capability in scenario.expected_capabilities
    }
    anchor_rates: dict[str, float] = {}
    for index, anchor in enumerate(scenario.expected_evidence_anchors):
        anchor_id = anchor.get("id") or f"anchor-{index}"
        anchor_rates[anchor_id] = round(sum(any(item["id"] == anchor_id and item["satisfied"] for item in result.anchor_results) for result in per_run_results) / runs, 4) if runs else 0.0
    forbidden_rate = round(sum(bool(result.forbidden_violations) for result in per_run_results) / runs, 4) if runs else 0.0
    tool_calls = round(sum(result.tool_call_count for result in per_run_results) / runs, 4) if runs else 0.0
    duplicates = round(sum(result.duplicate_count for result in per_run_results) / runs, 4) if runs else 0.0
    latency = round(sum(result.latency_sec for result in per_run_results) / runs, 4) if runs else 0.0
    escalation_frequency = round(sum(result.escalated or "escalation" in result.stages_hit for result in per_run_results) / runs, 4) if runs else 0.0
    return {
        "scenario_number": scenario.number,
        "runs": runs,
        "passes": passes,
        "pass_rate": round(passes / runs, 4) if runs else 0.0,
        "stages_hit": stage_union,
        "capability_pass_rate": capability_rates,
        "anchor_pass_rate": anchor_rates,
        "forbidden_violation_rate": forbidden_rate,
        "false_positive_rate": forbidden_rate if scenario.negative_control else 0.0,
        "duplicate_rate": duplicates,
        "average_duplicate_count": duplicates,
        "average_tool_calls": tool_calls,
        "average_latency_sec": latency,
        "escalation_frequency": escalation_frequency,
        "routes": sorted({result.route for result in per_run_results if result.route}),
        "modes": sorted({result.mode for result in per_run_results if result.mode}),
    }


__all__ = [
    "CAPABILITY_DIFF_POLARITY", "CAPABILITY_FULL_REVIEW_LOOP", "CAPABILITY_NEGATIVE_CONTROL",
    "CAPABILITY_OUTPUT_COMPLETENESS", "CAPABILITY_RUNTIME_PROTOCOL", "CAPABILITY_SEQUENCING",
    "CAPABILITY_STALE_REVIEW_STATE", "KNOWN_CAPABILITY_CLASSES",
    "RECOGNISED_DIFF_POLARITIES", "RECOGNISED_MODES", "RECOGNISED_ROUTES", "RECOGNISED_STAGES", "SEMANTIC_CORPUS_VERSION",
    "SEMANTIC_EVAL_VERSION", "SIGNAL_KIND_FINDING", "SIGNAL_KIND_MENTION", "SIGNAL_KIND_TOOL",
     "ReviewSignal", "SemanticCorpus", "SemanticCorpusError", "SemanticResult", "SemanticScenario",
     "_collect_signals_from_run", "aggregate_semantic_runs", "classify_signal", "evaluate_semantic_capability",
     "evaluate_semantic_corpus", "validate_semantic_corpus",


]
