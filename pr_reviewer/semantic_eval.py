from __future__ import annotations

import json
import math
import re
import subprocess
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath
from typing import Any

SEMANTIC_CORPUS_VERSION = 1
SEMANTIC_EVAL_VERSION = 1

RECOGNISED_STAGES = frozenset({"specialist", "primary", "escalation", "any"})
RECOGNISED_SIGNAL_STAGES = RECOGNISED_STAGES | {"unknown"}
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
# Execution-boundary / lifecycle capabilities from the PR #654 failure classes
# (#659): widening authority by moving work across a process boundary, losing
# required ambient capability when narrowing that boundary, leaving forked
# background work with no abnormal-exit owner, repairing only the tracked
# wrapper PID while the payload/descendants survive, and silently degrading a
# tree-aware repair when its new runtime capability (pgrep) is absent.
CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY = "execution_boundary_authority"
CAPABILITY_AMBIENT_CAPABILITY_LOSS = "ambient_capability_loss"
CAPABILITY_BACKGROUND_LIFECYCLE = "background_process_lifecycle"
CAPABILITY_REMEDIATION_TOPOLOGY = "remediation_process_topology"
CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY = "undeclared_capability_dependency"
KNOWN_CAPABILITY_CLASSES = frozenset(
    {
        CAPABILITY_SEQUENCING,
        CAPABILITY_OUTPUT_COMPLETENESS,
        CAPABILITY_FULL_REVIEW_LOOP,
        CAPABILITY_RUNTIME_PROTOCOL,
        CAPABILITY_STALE_REVIEW_STATE,
        CAPABILITY_DIFF_POLARITY,
        CAPABILITY_NEGATIVE_CONTROL,
        CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY,
        CAPABILITY_AMBIENT_CAPABILITY_LOSS,
        CAPABILITY_BACKGROUND_LIFECYCLE,
        CAPABILITY_REMEDIATION_TOPOLOGY,
        CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY,
    }
)

SIGNAL_KIND_FINDING = "finding"
SIGNAL_KIND_MENTION = "mention"
SIGNAL_KIND_TOOL = "tool"
SIGNAL_KINDS = frozenset({SIGNAL_KIND_FINDING, SIGNAL_KIND_MENTION, SIGNAL_KIND_TOOL})
_VOCABULARY: tuple[tuple[str, tuple[str, ...]], ...] = (
    (CAPABILITY_SEQUENCING, (
        "specialists launch before final", "specialists launched before final",
        "final review starts before specialists", "final review begins before specialists",
        "race condition between specialists and final", "specialists are not reaped before final",
        "specialists are not joined before final", "specialist phase is not complete before final",
        "specialists must reap", "specialists must terminate", "specialists must complete",
        "reaped before final review", "waits for every role and is reaped before final review",
    )),
    (CAPABILITY_OUTPUT_COMPLETENESS, (
        "artifact is missing on failure", "artifacts are missing on failure",
        "output is missing on error", "normalized output is not written on failure",
        "normalized artifact is absent on error", "failure path never writes",
        "error path never writes", "catastrophic failure loses the artifact",
        "missing on failure", "absent on error", "never written on failure",
    )),
    (CAPABILITY_FULL_REVIEW_LOOP, (
        "needs_full_review is minted", "needs_full_review is emitted", "needs_full_review is recreated",
        "needs_full_review is re-created", "needs_full_review causes a redundant full review",
        "needs_full_review creates a redundant full review", "redundant full review",
        "full review loops indefinitely", "full review repeats itself", "full review repeats past once",
        "full-review loop is not cleared", "full review flag is not cleared",
        "legacy full review flag is never cleared", "legacy full review flag is left uncleared",
        "legacy flag is left uncleared", "legacy flag repeats past once", "full review runs twice",
    )),
    (CAPABILITY_RUNTIME_PROTOCOL, (
        "prompt still references deleted runtime protocol", "prompt references deleted runtime protocol",
        "stale default prompt remains", "default prompt still names the removed protocol",
        "runtime protocol is gone but prompt", "prompt and runtime disagree",
        "runtime no longer supports the protocol but prompt", "unsupported runtime protocol is used",
        "stale default prompt",
    )),
    (CAPABILITY_STALE_REVIEW_STATE, (
        "stale previous review state remains", "carried findings remain", "carried findings survive",
        "stale review metadata remains", "old review state survives", "dead prior-review state remains",
        "previous review is stale but still used", "docs still describe stale previous review",
        "documentation still describes removed review state", "removed state is still referenced",
        "deleted state is still used", "state no longer exists but code still reads it",
        "stale review state",
    )),
    (CAPABILITY_DIFF_POLARITY, (
        "deleted declaration still exists", "deleted declarations still exist",
        "removed declaration is still present", "deleted code is still present",
        "treats deleted as present", "deleted-only declaration remains", "deleted symbol remains",
        "deletion is treated as an addition", "deleted side of the diff is treated as added",
        "removed side of the diff is treated as present",
    )),
    # The #659 vocabulary is deliberately causal: a generic warning
    # ("check security boundaries", "consider cleanup") matches none of these,
    # so only a finding that names the boundary/lifecycle mechanism counts.
    # Terms are ordered so the more specific capability wins when a phrase
    # could plausibly belong to two classes (the pgrep/fallback dependency is
    # checked before the tracked-PID topology it degrades to).
    (CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY, (
        "inherits reviewer secrets", "inherits reviewer-only secrets",
        "inherit reviewer secrets", "inherit reviewer-only secrets",
        "inherits the review environment", "inherits the privileged review environment",
        "inherit the review environment", "inherit the privileged review environment",
        "inherits model credentials", "inherits model and tool secrets",
        "inherit model credentials", "inherit model and tool secrets",
        "inherits the review process environment", "inherits the review step secrets",
        "inherit the review process environment", "inherit the review step secrets",
        "child of the fully privileged review process", "child of the privileged review process",
        "no longer isolated by the standalone step", "moved into the review process and can inherit",
        "authority widened across the execution boundary", "authority is widened across the execution boundary",
        "widened across the execution boundary", "execution boundary widens authority",
        "gained the review process's inherited authority", "lost its least-privilege boundary",
    )),
    (CAPABILITY_AMBIENT_CAPABILITY_LOSS, (
        "dropped the proxy configuration", "drops the proxy configuration", "drop the proxy configuration",
        "dropped proxy and custom-ca configuration", "lost required ambient configuration",
        "lost the ambient transport configuration", "removed required transport variables",
        "removes required transport variables", "remove required transport variables",
        "env -i strips the proxy", "env -i removes the proxy", "env -i stripped proxy",
        "broke proxy/custom-ca compatibility", "breaks proxy/custom-ca compatibility",
        "custom ca configuration was lost", "custom-ca configuration is lost",
        "lost the gh cli config", "lost required benign transport variables",
    )),
    (CAPABILITY_BACKGROUND_LIFECYCLE, (
        "no abnormal-exit cleanup", "no exit/term cleanup", "no exit or term cleanup",
        "orphaned ci child", "leaves an orphaned ci child", "leave an orphaned ci child",
        "orphan the ci child", "orphaned credential-bearing child",
        "credential-bearing child survives parent exit", "child survives parent exit",
        "only joined on the normal path", "joined only on the normal path",
        "no abnormal-exit owner", "background child has no owner",
        "parent exit between fork and join", "parent dies between fork and join",
        "drops runner_tracking_id", "removed runner_tracking_id", "removes runner_tracking_id",
        "runner_tracking_id is not forwarded", "weakened runner orphan-process cleanup",
        "weakens github runner orphan cleanup", "weakens runner orphan-process cleanup",
        "evades runner orphan tracking",
    )),
    (CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY, (
        "pgrep is not a declared runtime dependency", "undeclared dependency on pgrep",
        "remediation depends on pgrep", "cleanup depends on pgrep", "cleanup depends on `pgrep`",
        "pgrep is unavailable", "when pgrep is unavailable", "missing pgrep", "pgrep is missing",
        "falls back to wrapper-only", "silently falls back to wrapper-only",
        "silently falls back to the vulnerable wrapper-only",
        "degrades to wrapper-only", "pgrep not part of the runtime contract",
        "pgrep is not in the runtime contract",
    )),
    (CAPABILITY_REMEDIATION_TOPOLOGY, (
        "kills only the tracked pid", "kill only the tracked pid", "killing only the tracked pid",
        "killing only the tracked wrapper pid", "kills only the tracked wrapper",
        "tracked wrapper pid is not the workload",
        "payload and descendants survive", "payload/descendants survive",
        "descendants survive the kill", "only the background wrapper is killed",
        "wrapper pid alone does not own the workload", "test collapses the wrapper and payload",
        "exec sleep collapses the process topology", "collapses the wrapper and payload",
        "simplifies away the process topology", "process-topology risk",
    )),
)

def _truthy(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _safe_relative_path(value: object) -> bool:
    if not isinstance(value, str):
        return False
    path = Path(value)
    windows_path = PureWindowsPath(value)
    return not (
        path.is_absolute()
        or windows_path.is_absolute()
        or ".." in path.parts
        or ".." in windows_path.parts
    )


def _sentence_for_match(value: str, position: int) -> tuple[str, int]:
    start = max(value.rfind(mark, 0, position) for mark in ".!?\n") + 1
    end_candidates = [value.find(mark, position) for mark in ".!?\n"]
    ends = [end for end in end_candidates if end >= 0]
    end = min(ends) if ends else len(value)
    return value[start:end], start


def _is_negated_match(value: str, match: re.Match[str], term: str) -> bool:
    start, end = match.span()
    sentence, sentence_start = _sentence_for_match(value, start)
    relative_start = start - sentence_start
    relative_end = end - sentence_start
    prefix = sentence[:relative_start]
    suffix = sentence[relative_end:]
    before = prefix[-48:]
    after = suffix[:48]
    if re.search(
        r"(?:^|\b)(?:no|not|never|doesn['’]?t|isn['’]?t|is not|are not|do not|must not|should not|cannot|can['’]?t)\s+[^,;:]{0,20}$",
        before,
    ):
        return True
    # Safe-narrowing prose ("the allowlist prevents the child from inheriting
    # secrets", "the child runs without reviewer credentials") must not be
    # scored as the vulnerability it reassures against (#659 negative
    # controls). Keep these as bounded clause-local connectors so they cannot
    # suppress a finding elsewhere in the sentence.
    if re.search(
        r"(?:^|\b)(?:prevents?|excludes?|avoids?|blocks?|without|strips?|removes?|eliminates?)\s+[^,;:]{0,20}$",
        before,
    ):
        return True
    if re.match(
        r"^\s*(?:absent|removed|resolved|fixed|cleared|no longer|does not remain|is not present|are not present|was removed|has been removed|has been fixed|is gone|is resolved|is fixed|is cleared|remains absent)\b",
        after,
    ):
        return True
    return bool(re.search(
        r"\b(?:is|are|was|were)\s+not\s*,\s*despite\b[^.!?]{0,80}\b(?:a|an|the)?\s*$",
        before,
    ))


def classify_signal(text: str) -> str | None:
    value = (text or "").casefold()
    for capability, vocabulary in _VOCABULARY:
        for term in vocabulary:
            match = re.search(rf"(?<!\w){re.escape(term)}(?!\w)", value)
            if match is None or _is_negated_match(value, match, term):
                continue
            sentence, sentence_start = _sentence_for_match(value, match.start())
            prefix = sentence[:match.start() - sentence_start]
            if capability == CAPABILITY_DIFF_POLARITY and re.search(
                r"\b(?:assert|claim|treat|say|report|suggest)\b", prefix,
            ):
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
        if self.capability is None and self.kind in {SIGNAL_KIND_FINDING, SIGNAL_KIND_TOOL}:
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
    fixture: dict[str, Any] | None = None
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
            fixture=entry.get("fixture"),
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
            "fixture": self.fixture,
            "offline_runs": self.offline_runs,
        }


@dataclass
class SemanticCorpus:
    scenarios: list[SemanticScenario] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    version: int = SEMANTIC_CORPUS_VERSION
    fixture_root: Path | None = field(default=None, repr=False)

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
            fixture_root=path.parent,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "semantic_corpus": [scenario.to_dict() for scenario in self.scenarios],
            "metadata": self.metadata,
        }


class SemanticCorpusError(ValueError):
    pass


def validate_semantic_fixture_integrity(fixture: dict[str, Any]) -> None:
    files = fixture.get("files")
    diff = fixture.get("diff")
    if not isinstance(files, list):
        raise SemanticCorpusError("semantic fixture files must be a list")
    if not isinstance(diff, str):
        raise SemanticCorpusError("semantic fixture diff must be a string")

    expected: dict[str, bytes] = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise SemanticCorpusError("semantic fixture files must contain objects")
        path = entry.get("path")
        content = entry.get("content")
        if not isinstance(path, str) or not path or not _safe_relative_path(path):
            raise SemanticCorpusError(f"semantic fixture file path is unsafe: {path!r}")
        if path in expected:
            raise SemanticCorpusError(f"semantic fixture contains duplicate file: {path}")
        if not isinstance(content, str):
            raise SemanticCorpusError(f"semantic fixture content must be text: {path}")
        expected[path] = content.encode("utf-8")

    with tempfile.TemporaryDirectory(prefix="semantic-fixture-") as directory:
        repo = Path(directory)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "eval@test"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "semantic-eval"], check=True, capture_output=True)
        for relative_name, content in expected.items():
            destination = repo / relative_name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        subprocess.run(["git", "-C", str(repo), "add", "--all"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "fixture-head"], check=True, capture_output=True)

        result = subprocess.run(
            ["git", "-C", str(repo), "apply", "--check", "--reverse"],
            input=diff.encode("utf-8"), capture_output=True,
        )
        if result.returncode != 0:
            raise SemanticCorpusError(
                "semantic fixture reverse patch does not apply: "
                + result.stderr.decode("utf-8", errors="replace").strip()
            )
        subprocess.run(
            ["git", "-C", str(repo), "apply", "--reverse"],
            input=diff.encode("utf-8"), check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(repo), "apply", "--check"],
            input=diff.encode("utf-8"), check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "-C", str(repo), "apply"],
            input=diff.encode("utf-8"), check=True, capture_output=True,
        )
        actual_paths = {
            path.decode("utf-8")
            for path in subprocess.run(
                ["git", "-C", str(repo), "ls-files", "-z"], check=True, capture_output=True,
            ).stdout.split(b"\0")
            if path
        }
        if actual_paths != set(expected):
            raise SemanticCorpusError(
                "semantic fixture patch changed the tracked file set: "
                f"expected {sorted(expected)}, got {sorted(actual_paths)}"
            )
        for relative_name, content in expected.items():
            if (repo / relative_name).read_bytes() != content:
                raise SemanticCorpusError(
                    f"semantic fixture patch new side does not match files: {relative_name}"
                )


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
        if scenario.fixture is not None:
            _require(isinstance(scenario.fixture, dict), f"{prefix}: fixture must be an object")
            fixture_path = scenario.fixture.get("path")
            fixture_hash = scenario.fixture.get("sha256")
            _require(_truthy(fixture_path), f"{prefix}: fixture.path is required")
            _require(_safe_relative_path(fixture_path), f"{prefix}: fixture.path must be a safe relative path")
            _require(isinstance(fixture_hash, str) and re.fullmatch(r"[0-9a-f]{64}", fixture_hash) is not None, f"{prefix}: fixture.sha256 must be 64 lowercase hexadecimal characters")
            if corpus.fixture_root is not None:
                fixture_file = (corpus.fixture_root / fixture_path).resolve()
                _require(corpus.fixture_root.resolve() in fixture_file.parents, f"{prefix}: fixture path escapes corpus root")
                if fixture_file.exists():
                    try:
                        fixture_data = json.loads(fixture_file.read_text(encoding="utf-8"))
                    except (OSError, ValueError) as exc:
                        raise SemanticCorpusError(f"{prefix}: fixture cannot be loaded") from exc
                    try:
                        validate_semantic_fixture_integrity(fixture_data)
                    except (TypeError, AttributeError, SemanticCorpusError) as exc:
                        raise SemanticCorpusError(f"{prefix}: fixture integrity failed: {exc}") from exc
        _require(_truthy(scenario.repo_full_name), f"{prefix}: repo_full_name is required")
        _require(_truthy(scenario.url), f"{prefix}: url is required")
        _require(_truthy(scenario.provenance.get("pr_url")), f"{prefix}: provenance.pr_url is required")
        _require(scenario.provenance.get("issue") is not None, f"{prefix}: provenance.issue is required")
        _require(isinstance(scenario.negative_control, bool), f"{prefix}: negative_control must be a boolean")
        for capability in scenario.expected_capabilities + scenario.forbidden_capabilities:
            _require(isinstance(capability, str), f"{prefix}: capabilities must be strings")
            _require(capability in KNOWN_CAPABILITY_CLASSES, f"{prefix}: unknown capability {capability!r}")
        _require(scenario.klass in scenario.expected_capabilities or scenario.negative_control, f"{prefix}: class must be expected or negative_control")
        if not scenario.negative_control:
            _require(
                scenario.expected_evidence_anchors
                and all(anchor.get("kind") in {SIGNAL_KIND_FINDING, SIGNAL_KIND_TOOL} for anchor in scenario.expected_evidence_anchors),
                f"{prefix}: positive scenarios need only finding or tool evidence anchors",
            )
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
            findings = fixture.get("findings", [])
            _require(isinstance(findings, list), f"{prefix}: offline run findings must be a list")
            for finding in findings:
                _require(isinstance(finding, dict), f"{prefix}: offline run findings must be objects")
            if any(not finding.get("stage") for finding in findings):
                _require("route" in fixture, f"{prefix}: offline runs with stage-less findings must declare route")
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
    stage = _run_value(run, "stage") or _run_metadata(run).get("stage")
    return str(stage) if stage in RECOGNISED_SIGNAL_STAGES else "unknown"


def _run_finding_stage(run: Any, finding: Any = None) -> str:
    if isinstance(finding, dict):
        explicit_stage = finding.get("stage")
        if explicit_stage in RECOGNISED_SIGNAL_STAGES:
            return str(explicit_stage)
    stage = _run_stage(run)
    return stage if stage in {"primary", "escalation"} else "unknown"


def _signal_stage(value: Any, fallback: str) -> str:
    return str(value) if value in RECOGNISED_SIGNAL_STAGES else fallback


def _route_matches(actual: str | None, expected: str) -> bool:
    if expected == "any":
        return True
    if actual == "any":
        return True
    if expected == actual:
        return True
    primary_routes = {"primary", "fast", "smart", "legacy"}
    escalation_routes = {"escalation", "escalated"}
    if expected == "primary":
        return actual in primary_routes
    if expected == "escalation":
        return actual in escalation_routes
    return expected == "primary+escalation" and actual in primary_routes | escalation_routes


def _collect_signals_from_run(run: Any) -> list[ReviewSignal]:
    stage = _run_stage(run)
    finding_stage = _run_finding_stage(run)
    signals: list[ReviewSignal] = []
    review = _run_value(run, "review_markdown", "") or ""
    if review:
        signals.append(ReviewSignal(SIGNAL_KIND_MENTION, stage, str(review)))
    for finding in _run_value(run, "primary_findings", []) or []:
        if not isinstance(finding, dict):
            continue
        text = finding.get("description") or finding.get("message") or ""
        signals.append(ReviewSignal(SIGNAL_KIND_FINDING, "primary", str(text), meta=finding))
    for finding in _run_value(run, "findings", []) or []:
        if not isinstance(finding, dict):
            continue
        signal_stage = _run_finding_stage(run, finding)
        text = finding.get("description") or finding.get("message") or ""
        signals.append(ReviewSignal(SIGNAL_KIND_FINDING, signal_stage, str(text), meta=finding))
    for artifact in _run_value(run, "artifacts", []) or []:
        if not isinstance(artifact, dict):
            continue
        artifact_stage = _signal_stage(artifact.get("stage"), "unknown")
        text = artifact.get("text") or artifact.get("content") or artifact.get("message") or ""
        if text:
            signals.append(ReviewSignal(SIGNAL_KIND_MENTION, artifact_stage, str(text), meta=artifact))
    leads = _run_value(run, "specialist_leads", None)
    if not isinstance(leads, list) or not leads:
        leads = []
        specialists = _run_value(run, "specialists", {})
        if isinstance(specialists, dict):
            leads_by_role = specialists.get("leads_by_role")
            if isinstance(leads_by_role, dict):
                leads = [
                    lead
                    for role_leads in leads_by_role.values()
                    for lead in role_leads if isinstance(role_leads, list)
                ]
    for lead in leads:
        if not isinstance(lead, dict):
            continue
        text = lead.get("message") or lead.get("description") or ""
        if text:
            signals.append(ReviewSignal(SIGNAL_KIND_FINDING, "specialist", str(text), meta=lead))
    for call in _run_value(run, "tool_calls", []) or []:
        if not isinstance(call, dict):
            continue
        call_stage = _signal_stage(call.get("stage"), stage)
        args = call.get("args") or {}
        text = " ".join(str(value) for value in args.values() if isinstance(value, str))
        signals.append(ReviewSignal(SIGNAL_KIND_TOOL, call_stage, text, meta={"tool": call.get("tool", ""), "status": call.get("status")}))
    return signals


def _anchor_matches(signal: ReviewSignal, anchor: dict[str, Any]) -> bool:
    if signal.stage == "unknown" or signal.kind != anchor.get("kind"):
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
        if signal.kind not in {SIGNAL_KIND_FINDING, SIGNAL_KIND_TOOL}:
            continue
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
    run.route = fixture.get("route")
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
    "CAPABILITY_EXECUTION_BOUNDARY_AUTHORITY", "CAPABILITY_AMBIENT_CAPABILITY_LOSS",
    "CAPABILITY_BACKGROUND_LIFECYCLE", "CAPABILITY_REMEDIATION_TOPOLOGY",
    "CAPABILITY_UNDECLARED_CAPABILITY_DEPENDENCY",
    "RECOGNISED_DIFF_POLARITIES", "RECOGNISED_MODES", "RECOGNISED_ROUTES", "RECOGNISED_SIGNAL_STAGES", "RECOGNISED_STAGES", "SEMANTIC_CORPUS_VERSION",
    "SEMANTIC_EVAL_VERSION", "SIGNAL_KIND_FINDING", "SIGNAL_KIND_MENTION", "SIGNAL_KIND_TOOL",
     "ReviewSignal", "SemanticCorpus", "SemanticCorpusError", "SemanticResult", "SemanticScenario",
     "_collect_signals_from_run", "aggregate_semantic_runs", "classify_signal", "evaluate_semantic_capability",
      "evaluate_semantic_corpus", "validate_semantic_corpus", "validate_semantic_fixture_integrity",



]
