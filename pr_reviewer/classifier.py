"""Deterministic PR classification and risk-flag detection.

Analyzes a PR's file changes, diff content, linked issues, and metadata to
produce structured classification output that is injected into the review
corpus before model invocation.

All logic is rule-based (no model calls). The output is a JSON object with:
  - pr_kind        : one of the enumerated kinds
  - risk_flags     : list of detected risk indicators
  - changed_files_summary : list of changed file paths (truncated)
  - linked_issue_labels : labels from linked issues when available
  - must_check     : explicit checklist items derived from classification

Usage from run_review.sh::
    python3 scripts/classify_pr.py \
        --pr-files pr-files.json \
        --diff pr.diff.truncated \
        --linked-issues linked-issues.json \
        --output classification.json
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Kinds and flags (authoritative enums)
# ---------------------------------------------------------------------------

PR_KINDS = [
    "renovate_digest_only",
    "dependency_upgrade",
    "app_code",
    "k8s_manifest",
    "auth_changes",
    "public_route_changes",
    "file_serving_changes",
    "path_handling_changes",
    "secret_handling_changes",
    "db_or_migration_changes",
]

RISK_FLAGS = [
    "linked_security_issue",
    "linked_audit_issue",
    "linked_priority_p0",
    "linked_priority_p1",
    "file_serving_changes",
    "path_handling_changes",
    "auth_changes",
    "secret_handling_changes",
]


# ---------------------------------------------------------------------------
# Pattern sets
# ---------------------------------------------------------------------------

# Renovate digest-only: lockfile files that contain only hash/digest changes
# (no version bumps). We detect this by looking for 64-char hex digests in
# the diff when the changed file is a known lockfile.
RENOVATE_DIGEST_FILE_PATTERNS = [
    re.compile(r"package-lock\.json"),
    re.compile(r"npm-shrinkwrap\.json"),
    re.compile(r"yarn\.lock"),
    re.compile(r"pnpm-lock\.yaml"),
]

# 64-character hex digest (SHA-256 style) — common in Renovate digest updates

# Dependency-related files (lockfiles, manifests)
DEPENDENCY_PATTERNS = [
    re.compile(r"(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|"
               r"Pipfile\.lock|requirements\.txt|Gemfile\.lock|Cargo\.lock|"
               r"go\.mod|go\.sum|composer\.lock|mix\.lock|build\.gradle|"
               r"pom\.xml|setup\.py|setup\.cfg|pyproject\.toml|pubspec\.yaml|"
               r"\.npmrc|\.yarnrc)"),
]

# Kubernetes manifest patterns
K8S_PATTERNS = [
    re.compile(r"(helmrelease|deployment|statefulset|daemonset|kustomization)"
               r"\.ya?ml$", re.IGNORECASE),
    re.compile(r"configmap\.ya?ml$"),
    re.compile(r"secret\.ya?ml$"),
    re.compile(r"service\.ya?ml$"),
    re.compile(r"ingress\.ya?ml$"),
    re.compile(r"\.k8s\.ya?ml$"),
    re.compile(r"k8s/"),
    re.compile(r"helm/"),
]

# Common source-file extensions across ecosystems (not just Python), so auth /
# route / DB filename heuristics fire for JS/TS/Go/Java/etc. repos too.
_SRC_EXT = r"(py|js|jsx|ts|tsx|go|rb|java|kt|cs|php|rs|scala|swift)"

# Auth-related changes
AUTH_PATTERNS = [
    re.compile(r"(auth|login|oauth|oidc|saml|jwt|token|mfa|2fa|session)"
               r"[_.-]?\w*\." + _SRC_EXT + r"$", re.IGNORECASE),
    re.compile(r"middleware[_.-]?auth", re.IGNORECASE),
    re.compile(r"permissions?\.ya?ml$"),
    re.compile(r"rbac\.ya?ml$"),
    re.compile(r"role[-_].*binding", re.IGNORECASE),
    re.compile(r"\.env(\.example)?$", re.IGNORECASE),
    re.compile(r"(auth|authn|authz)[-_]?(controller|service|guard|middleware|handler)",
               re.IGNORECASE),
]

# Public route changes
PUBLIC_ROUTE_PATTERNS = [
    re.compile(r"(routes?|urls?|api|endpoints?|controller)\." + _SRC_EXT + r"$",
               re.IGNORECASE),
    re.compile(r"router[_.-]?py$"),
    re.compile(r"urlpatterns"),
    re.compile(r"app\.route\("),
    re.compile(r"@\w+\.route\("),
    re.compile(r"(registerEndpoint|@(Get|Post|Put|Delete|Patch|RequestMapping))",
               re.IGNORECASE),
]

# File serving changes — match directory names or file patterns
FILE_SERVING_PATTERNS = [
    re.compile(r"^(static|public|assets|uploads|media|files)[/_.-]", re.IGNORECASE),
    re.compile(r"(static|public|assets|uploads|media|files)/", re.IGNORECASE),
    re.compile(r"send_file"),
    re.compile(r"send_from_directory"),
    re.compile(r"FileServer"),
    re.compile(r"serveStatic"),
    re.compile(r"staticfiles?/"),
]

# Path handling changes — match in filenames AND diff content
PATH_HANDLING_PATTERNS = [
    re.compile(r"pathlib", re.IGNORECASE),
    re.compile(r"os\.path", re.IGNORECASE),
    re.compile(r"filepath|pathname", re.IGNORECASE),
    re.compile(r"\.\./|\.\.\\", re.IGNORECASE),  # path traversal
    re.compile(r"sanitize.*path|clean.*path", re.IGNORECASE),
    re.compile(r"path_join|joinpath|resolve.*path", re.IGNORECASE),
]

# Secret handling changes
SECRET_HANDLING_PATTERNS = [
    re.compile(r"(secret|credential|password|api.?key|private.?key|token)"
               r"[_.-]?\w*\.(py|js|ts|go|rb|yaml|yml|json)$", re.IGNORECASE),
    re.compile(r"secrets?\.ya?ml$"),
    re.compile(r"vault|hashicorp|aws.?secrets", re.IGNORECASE),
    re.compile(r"base64\.(decode|encode)", re.IGNORECASE),
]

# DB / migration changes
DB_MIGRATION_PATTERNS = [
    re.compile(r"(migration|migrate|migrations?)", re.IGNORECASE),
    re.compile(r"schema\.(py|rb|ts|js|sql|prisma)$", re.IGNORECASE),
    re.compile(r"models?\." + _SRC_EXT + r"$", re.IGNORECASE),
    re.compile(r"(entity|entities|repository)\.(java|kt|cs|ts)$", re.IGNORECASE),
    re.compile(r"\.sql$", re.IGNORECASE),
    re.compile(r"alembic|django.*migrat|sequelize|migrate_", re.IGNORECASE),
    re.compile(r"prisma/schema\.prisma$"),
]


# ---------------------------------------------------------------------------
# Classification result
# ---------------------------------------------------------------------------

@dataclass
class PRClassification:
    pr_kind: str = "app_code"
    risk_flags: list[str] = field(default_factory=list)
    risk_flags_with_files: dict[str, list[str]] = field(default_factory=dict)
    # Subset of (pr_kind + risk_flags) safe to drive smart-model routing:
    # linked-issue flags and any file-based signal backed by an actual changed
    # filename. Content-only pattern matches (e.g. a diff that merely mentions
    # os.path or `token`) are excluded — they over-route benign PRs (#159 fix).
    route_signals: list[str] = field(default_factory=list)
    changed_files_summary: list[str] = field(default_factory=list)
    linked_issue_labels: list[str] = field(default_factory=list)
    must_check: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _has_version_bump(diff_text: str) -> bool:
    """Check if the diff contains a version bump (not just a digest).

    Detects both JSON (`"version": "..."`) and YAML (`version:`/`appVersion:`)
    forms. The YAML check only matches changed (+/-) lines so an unchanged
    `version:` context line in a digest-only update is not a false positive.
    """
    if re.search(r'"version"\s*:\s*"[^"]+"', diff_text):
        return True
    if re.search(r'(?m)^[+-]\s*(?:app)?[Vv]ersion:\s*\S+', diff_text):
        return True
    return False


def _all_files_are_lockfiles(filenames: list[str]) -> bool:
    """True only when every changed file is a known lockfile.

    Guards renovate_digest_only against mixed PRs (code + a lockfile), which
    must not be classified as a trivial digest update.
    """
    if not filenames:
        return False
    return all(
        any(pat.search(f) for pat in RENOVATE_DIGEST_FILE_PATTERNS)
        for f in filenames
    )


# ---------------------------------------------------------------------------
# pr_kind rule table
# ---------------------------------------------------------------------------
#
# Classification is a declarative table of rules evaluated top-to-bottom by one
# engine loop (`_classify_pr_kind`). The FIRST matching rule wins, so TABLE
# ORDER *is* precedence — rows are ordered most-specific first. This replaces
# the former hand-written if-chain; the ordering below is identical to it.
#
# Each rule's `matches(filenames, diff_text) -> bool` predicate is built from a
# pattern set by one of the factories below, except the two compound rules
# (renovate_digest_only, dependency_upgrade) whose conditions don't reduce to a
# single pattern scan and are kept as named predicate functions.

# Pattern-based predicate factories -----------------------------------------

def _filename_matches(patterns: list[re.Pattern]) -> Callable[[list[str], str], bool]:
    """Predicate: any changed filename matches any pattern in the set."""
    def _pred(filenames: list[str], diff_text: str) -> bool:
        return any(any(pat.search(f) for pat in patterns) for f in filenames)
    return _pred


def _filename_or_diff_matches(patterns: list[re.Pattern]) -> Callable[[list[str], str], bool]:
    """Predicate: any pattern matches a changed filename OR the diff content.

    Mirrors the original two-step check (filenames first, then diff) — both
    steps yielded the same kind, so folding them into one OR is behavior-
    preserving while keeping the diff fallback in a single rule.
    """
    def _pred(filenames: list[str], diff_text: str) -> bool:
        if any(any(pat.search(f) for pat in patterns) for f in filenames):
            return True
        return any(pat.search(diff_text) for pat in patterns)
    return _pred


# Compound predicates (don't reduce to a single pattern scan) ----------------

def _is_renovate_digest_only(filenames: list[str], diff_text: str) -> bool:
    """Most specific rule: EVERY changed file is a lockfile and the diff has no
    version bump. Guards against a mixed PR (real code + a lockfile) being
    mislabeled as trivial and steering weaker models toward rubber-stamping it.
    """
    return _all_files_are_lockfiles(filenames) and not _has_version_bump(diff_text)


def _is_dependency_upgrade(filenames: list[str], diff_text: str) -> bool:
    """A dependency/manifest file changed, but NOT a k8s manifest (which happens
    to reference versions and must classify as k8s_manifest instead).
    """
    has_dep_file = any(
        any(pat.search(f) for pat in DEPENDENCY_PATTERNS) for f in filenames
    )
    if not has_dep_file:
        return False
    has_k8s = any(any(pat.search(f) for pat in K8S_PATTERNS) for f in filenames)
    return not has_k8s


@dataclass(frozen=True)
class KindRule:
    """One pr_kind classification rule: a name plus a match predicate."""
    kind: str
    matches: Callable[[list[str], str], bool]


# Precedence encoded as order: first matching rule wins.
KIND_RULES: list[KindRule] = [
    KindRule("renovate_digest_only", _is_renovate_digest_only),
    KindRule("dependency_upgrade", _is_dependency_upgrade),
    KindRule("k8s_manifest", _filename_matches(K8S_PATTERNS)),
    # secret handling before auth (more specific)
    KindRule("secret_handling_changes", _filename_matches(SECRET_HANDLING_PATTERNS)),
    KindRule("db_or_migration_changes", _filename_matches(DB_MIGRATION_PATTERNS)),
    KindRule("auth_changes", _filename_matches(AUTH_PATTERNS)),
    KindRule("public_route_changes", _filename_matches(PUBLIC_ROUTE_PATTERNS)),
    KindRule("file_serving_changes", _filename_or_diff_matches(FILE_SERVING_PATTERNS)),
    KindRule("path_handling_changes", _filename_or_diff_matches(PATH_HANDLING_PATTERNS)),
]

# Fallback kind when no rule matches.
DEFAULT_PR_KIND = "app_code"


def _classify_pr_kind(
    files: list[dict],
    diff_text: str,
) -> str:
    """Determine the single best pr_kind from file patterns and diff content.

    Evaluates KIND_RULES in order and returns the first match; falls back to
    DEFAULT_PR_KIND ("app_code") when nothing matches.
    """
    filenames = [f.get("filename", "") for f in files]
    for rule in KIND_RULES:
        if rule.matches(filenames, diff_text):
            return rule.kind
    return DEFAULT_PR_KIND


# ---------------------------------------------------------------------------
# Risk-flag rule tables
# ---------------------------------------------------------------------------

# Linked-issue flags: a flag fires when a linked issue carries ANY of the
# trigger labels (case-insensitive). Order matters — flags are appended in this
# order (deduplicated) as issues are scanned.
LINKED_ISSUE_RULES: list[tuple[frozenset[str], str]] = [
    (frozenset({"security", "vulnerability"}), "linked_security_issue"),
    (frozenset({"audit"}), "linked_audit_issue"),
    (frozenset({"priority/p0", "priority_p0"}), "linked_priority_p0"),
    (frozenset({"priority/p1", "priority_p1"}), "linked_priority_p1"),
]

# File-based flags: a flag fires when any changed filename OR the diff content
# matches the pattern set. Order matters — flags are appended in this order.
FILE_RISK_RULES: list[tuple[list[re.Pattern], str]] = [
    (FILE_SERVING_PATTERNS, "file_serving_changes"),
    (PATH_HANDLING_PATTERNS, "path_handling_changes"),
    (AUTH_PATTERNS, "auth_changes"),
    (SECRET_HANDLING_PATTERNS, "secret_handling_changes"),
]


def _detect_risk_flags(
    files: list[dict],
    diff_text: str,
    linked_issues: list[dict],
) -> tuple[list[str], dict[str, list[str]]]:
    """Detect risk flags based on file patterns and linked issue metadata.

    Driven by two rule tables: LINKED_ISSUE_RULES (scanned first, per issue)
    and FILE_RISK_RULES (scanned second). Flag append order follows table
    order, matching the former hand-written checks.

    Returns
    -------
    flags : list[str]
        Ordered list of detected risk flag names (unchanged semantics).
    flags_with_files : dict[str, list[str]]
        Mapping from each file-based risk flag to the file paths that triggered
        it.  Issue-linked flags (linked_security_issue, etc.) have no file
        attribution and are omitted from this mapping.  When a flag fires only
        from diff content (no filename match), the mapping contains an empty
        list for that flag.
    """
    flags: list[str] = []
    flags_with_files: dict[str, list[str]] = {}
    filenames = [f.get("filename", "") for f in files]

    # Linked security/audit/priority issues (table order, deduplicated).
    for issue in linked_issues:
        labels = {lb.get("name", "").lower() for lb in issue.get("labels", [])}
        for trigger_labels, flag in LINKED_ISSUE_RULES:
            if labels & trigger_labels and flag not in flags:
                flags.append(flag)

    # File-based risk flags (derived from classification patterns).
    for pat_set, flag in FILE_RISK_RULES:
        # Collect the specific files that triggered this flag
        triggering_files = [
            f for f in filenames
            if any(pat.search(f) for pat in pat_set)
        ]
        matches_in_diff = any(pat.search(diff_text) for pat in pat_set)
        if triggering_files or matches_in_diff:
            if flag not in flags:
                flags.append(flag)
            # Record file attribution (empty list when only diff content matched)
            flags_with_files[flag] = triggering_files

    return flags, flags_with_files


# Checklist items per risk class. Keys are pr_kind values AND the file-based
# risk flags (which share names), so a flag like auth_changes detected on an
# app_code PR still pulls in the auth checklist (#157).
KIND_CHECKS: dict[str, list[str]] = {
    "renovate_digest_only": [
        "verify no functional changes beyond lockfile hashes",
    ],
    "dependency_upgrade": [
        "check for breaking API changes in updated dependencies",
        "run full test suite after upgrade",
    ],
    "k8s_manifest": [
        "validate manifest against target cluster version",
        "check for resource quota / limit changes",
    ],
    "auth_changes": [
        "review auth flow for regression",
        "verify session token handling is correct",
    ],
    "public_route_changes": [
        "verify route access controls are in place",
        "check for unintended public endpoints",
    ],
    "file_serving_changes": [
        "verify file path sanitization",
        "check for directory traversal vulnerabilities",
    ],
    "path_handling_changes": [
        "review for path traversal vulnerabilities",
        "test with edge-case paths (null bytes, symlinks)",
    ],
    "secret_handling_changes": [
        "verify secrets are not logged or exposed in diffs",
        "check secret rotation impact",
    ],
    "db_or_migration_changes": [
        "review migration for data loss risk",
        "test migration on a copy of production schema",
    ],
}

# Checklist items per linked-issue risk flag.
FLAG_CHECKS: dict[str, list[str]] = {
    "linked_security_issue": ["explicitly address the linked security issue"],
    "linked_audit_issue": ["verify audit findings are addressed"],
    "linked_priority_p0": ["treat as critical — verify all changes thoroughly"],
    "linked_priority_p1": ["treat as high priority — verify correctness carefully"],
}


# Kinds whose classification can come from diff CONTENT, not just filenames
# (they use _filename_or_diff_matches). A content-only match of these must not
# drive smart-model routing — only an actual changed filename should.
_CONTENT_CAPABLE_KINDS: dict[str, list[re.Pattern]] = {
    "file_serving_changes": FILE_SERVING_PATTERNS,
    "path_handling_changes": PATH_HANDLING_PATTERNS,
}


def _route_signals(
    pr_kind: str,
    filenames: list[str],
    risk_flags: list[str],
    risk_flags_with_files: dict[str, list[str]],
) -> list[str]:
    """Signals eligible to route a PR straight to the smart model.

    Excludes content-only matches (which over-route benign PRs): keeps
    linked-issue flags, file-based flags backed by a real changed filename, and
    the pr_kind unless it is a content-only file_serving/path_handling match.
    """
    signals: list[str] = []
    # Linked-issue flags are explicit human signals — always route.
    for flag in risk_flags:
        if flag.startswith("linked_") and flag not in signals:
            signals.append(flag)
    # File-based risk flags only when an actual changed filename matched;
    # content-only matches carry an empty file list.
    for flag, files in risk_flags_with_files.items():
        if files and flag not in signals:
            signals.append(flag)
    # pr_kind routes unless it is the catch-all default or a content-only
    # file_serving/path_handling kind.
    if pr_kind and pr_kind != DEFAULT_PR_KIND and pr_kind not in signals:
        patterns = _CONTENT_CAPABLE_KINDS.get(pr_kind)
        if patterns is None:
            signals.append(pr_kind)
        elif any(any(p.search(fn) for p in patterns) for fn in filenames):
            signals.append(pr_kind)
    return signals


def _build_must_check(pr_kind: str, risk_flags: list[str]) -> list[str]:
    """Generate explicit must-check items based on classification.

    Checks come from the union of the pr_kind and every detected risk flag
    (deduplicated, pr_kind first) — not the pr_kind alone, so secondary risk
    signals still produce their checklists.
    """
    checks: list[str] = []
    seen: set[str] = set()

    for key in [pr_kind, *risk_flags]:
        for check in KIND_CHECKS.get(key, []) + FLAG_CHECKS.get(key, []):
            if check not in seen:
                seen.add(check)
                checks.append(check)

    return checks


def classify_pr(
    pr_files: list[dict],
    diff_text: str = "",
    linked_issues: list[dict] | None = None,
    max_summary_files: int = 50,
) -> PRClassification:
    """Run deterministic classification on a PR.

    Parameters
    ----------
    pr_files : list[dict]
        PR files array from ``gh api repos/.../pulls/N/files``.
    diff_text : str
        Raw PR diff text (truncated).
    linked_issues : list[dict], optional
        Already-fetched linked issue dicts with ``labels`` keys.
    max_summary_files : int
        Maximum number of files to include in changed_files_summary.

    Returns
    -------
    PRClassification
    """
    if linked_issues is None:
        linked_issues = []

    pr_kind = _classify_pr_kind(pr_files, diff_text)
    risk_flags, risk_flags_with_files = _detect_risk_flags(pr_files, diff_text, linked_issues)
    must_check = _build_must_check(pr_kind, risk_flags)

    # Build changed files summary (just filenames, truncated)
    file_names = [f.get("filename", "") for f in pr_files]
    changed_files_summary = file_names[:max_summary_files]
    route_signals = _route_signals(
        pr_kind, file_names, risk_flags, risk_flags_with_files
    )

    # Collect linked issue labels
    linked_issue_labels: list[str] = []
    for issue in linked_issues:
        for lb in issue.get("labels", []):
            name = lb.get("name", "")
            if name and name not in linked_issue_labels:
                linked_issue_labels.append(name)

    return PRClassification(
        pr_kind=pr_kind,
        risk_flags=risk_flags,
        risk_flags_with_files=risk_flags_with_files,
        route_signals=route_signals,
        changed_files_summary=changed_files_summary,
        linked_issue_labels=linked_issue_labels,
        must_check=must_check,
    )


def classify_from_files(
    pr_files_path: str | Path,
    diff_path: str | Path = "",
    issues_path: str | Path = "",
    output_path: str | Path = "classification.json",
) -> PRClassification:
    """Convenience wrapper that reads from files and writes JSON output.

    Used by run_review.sh to classify a PR during the review pipeline.
    """
    pr_files_path = Path(pr_files_path)
    pr_files = json.loads(pr_files_path.read_text(encoding="utf-8"))

    diff_text = ""
    if diff_path:
        diff_text = Path(diff_path).read_text(encoding="utf-8", errors="replace")

    linked_issues: list[dict] = []
    if issues_path and Path(issues_path).exists():
        linked_issues = json.loads(
            Path(issues_path).read_text(encoding="utf-8"))

    result = classify_pr(pr_files, diff_text, linked_issues)

    output = Path(output_path)
    output.write_text(json.dumps(result.to_dict(), indent=2) + "\n")

    return result


# ---------------------------------------------------------------------------
# CLI entry point (for run_review.sh)
# ---------------------------------------------------------------------------

def main() -> None:
    """CLI: python3 scripts/classify_pr.py --pr-files F --diff D ..."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Deterministic PR classification and risk-flag detection")
    parser.add_argument("--pr-files", required=True,
                        help="Path to pr-files.json")
    parser.add_argument("--diff", default="",
                        help="Path to pr.diff.truncated (optional)")
    parser.add_argument("--linked-issues", default="",
                        help="Path to linked-issues.json (optional)")
    parser.add_argument("--output", default="classification.json",
                        help="Output path for classification JSON")

    args = parser.parse_args()
    classify_from_files(
        pr_files_path=args.pr_files,
        diff_path=args.diff,
        issues_path=args.linked_issues,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
