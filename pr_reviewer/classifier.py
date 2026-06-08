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
from typing import Any


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
_SHA256_DIGEST = re.compile(r"(?<![a-fA-F0-9])[a-fA-F0-9]{64}(?![a-fA-F0-9])")

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

# Auth-related changes
AUTH_PATTERNS = [
    re.compile(r"(auth|login|oauth|oidc|saml|jwt|token|mfa|2fa|session)"
               r"[_.-]?\w*\.py$", re.IGNORECASE),
    re.compile(r"middleware[_.-]?auth", re.IGNORECASE),
    re.compile(r"permissions?\.ya?ml$"),
    re.compile(r"rbac\.ya?ml$"),
    re.compile(r"role[-_].*binding", re.IGNORECASE),
    re.compile(r"\.env(\.example)?$", re.IGNORECASE),
]

# Public route changes
PUBLIC_ROUTE_PATTERNS = [
    re.compile(r"(routes?|urls?|api|endpoints?)\.py$", re.IGNORECASE),
    re.compile(r"router[_.-]?py$"),
    re.compile(r"urlpatterns"),
    re.compile(r"app\.route\("),
    re.compile(r"@\w+\.route\("),
    re.compile(r"registerEndpoint"),
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
    re.compile(r"schema\.py$"),
    re.compile(r"models?\.(py|go|rb)$"),
    re.compile(r"\.sql$", re.IGNORECASE),
    re.compile(r"alembic|django.*migrat|sequelize|migrate_", re.IGNORECASE),
    re.compile(r"prisma/schema\.prisma$"),
]


# ---------------------------------------------------------------------------
# Classification logic
# ---------------------------------------------------------------------------

@dataclass
class PRClassification:
    pr_kind: str = "app_code"
    risk_flags: list[str] = field(default_factory=list)
    changed_files_summary: list[str] = field(default_factory=list)
    linked_issue_labels: list[str] = field(default_factory=list)
    must_check: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _has_version_bump(diff_text: str) -> bool:
    """Check if the diff contains a version bump (not just a digest)."""
    return bool(re.search(r'"version"\s*:\s*"[^"]+"', diff_text))


def _is_digest_only_hash(diff_text: str) -> bool:
    """Check if the diff contains SHA-256 style digests (Renovate digest updates)."""
    # Look for bare 64-char hex strings typical of SHA-256 digests in lockfiles
    return bool(_SHA256_DIGEST.search(diff_text))


def _classify_pr_kind(
    files: list[dict],
    diff_text: str,
) -> str:
    """Determine the single best pr_kind from file patterns and diff content."""
    filenames = [f.get("filename", "") for f in files]

    # Check Renovate digest-only first (most specific — if it's only lockfile
    # hash updates with no version bumps, it's definitely not a meaningful code change)
    is_renovate_digest = False
    for pat in RENOVATE_DIGEST_FILE_PATTERNS:
        if any(pat.search(f) for f in filenames):
            has_version_bump_val = _has_version_bump(diff_text)
            has_digest = _is_digest_only_hash(diff_text)
            # If there are no version bumps, or only digest hashes, it's digest-only
            if not has_version_bump_val or (has_digest and not has_version_bump_val):
                is_renovate_digest = True
                break

    if is_renovate_digest:
        return "renovate_digest_only"

    # Check dependency upgrade (has version bumps in lockfiles/deps)
    has_dep_file = any(
        any(pat.search(f) for pat in DEPENDENCY_PATTERNS) for f in filenames
    )
    has_version_bump_val = _has_version_bump(diff_text)
    if has_dep_file or has_version_bump_val:
        # But exclude k8s manifests that happen to reference versions
        has_k8s = any(
            any(pat.search(f) for pat in K8S_PATTERNS) for f in filenames
        )
        if not has_k8s:
            return "dependency_upgrade"

    # Check k8s manifest changes
    if any(any(pat.search(f) for pat in K8S_PATTERNS) for f in filenames):
        return "k8s_manifest"

    # Check secret handling (before auth, more specific)
    if any(any(pat.search(f) for pat in SECRET_HANDLING_PATTERNS) for f in filenames):
        return "secret_handling_changes"

    # Check DB / migration changes
    if any(any(pat.search(f) for pat in DB_MIGRATION_PATTERNS) for f in filenames):
        return "db_or_migration_changes"

    # Check auth changes
    if any(any(pat.search(f) for pat in AUTH_PATTERNS) for f in filenames):
        return "auth_changes"

    # Check public route changes
    if any(any(pat.search(f) for pat in PUBLIC_ROUTE_PATTERNS) for f in filenames):
        return "public_route_changes"

    # Check file serving changes (in filenames AND diff content)
    if any(any(pat.search(f) for pat in FILE_SERVING_PATTERNS) for f in filenames):
        return "file_serving_changes"
    if any(pat.search(diff_text) for pat in FILE_SERVING_PATTERNS):
        return "file_serving_changes"

    # Check path handling changes (in filenames AND diff content)
    if any(any(pat.search(f) for pat in PATH_HANDLING_PATTERNS) for f in filenames):
        return "path_handling_changes"
    if any(pat.search(diff_text) for pat in PATH_HANDLING_PATTERNS):
        return "path_handling_changes"

    # Default: app code change
    return "app_code"


def _detect_risk_flags(
    files: list[dict],
    diff_text: str,
    linked_issues: list[dict],
) -> list[str]:
    """Detect risk flags based on file patterns and linked issue metadata."""
    flags: list[str] = []
    filenames = [f.get("filename", "") for f in files]

    # Check for linked security/audit/priority issues
    for issue in linked_issues:
        labels = [lb.get("name", "").lower() for lb in issue.get("labels", [])]
        if "security" in labels or "vulnerability" in labels:
            if "linked_security_issue" not in flags:
                flags.append("linked_security_issue")
        if "audit" in labels:
            if "linked_audit_issue" not in flags:
                flags.append("linked_audit_issue")
        if "priority/p0" in labels or "priority_p0" in labels:
            if "linked_priority_p0" not in flags:
                flags.append("linked_priority_p0")
        if "priority/p1" in labels or "priority_p1" in labels:
            if "linked_priority_p1" not in flags:
                flags.append("linked_priority_p1")

    # File-based risk flags (derived from classification patterns)
    for pat_set, flag in [
        (FILE_SERVING_PATTERNS, "file_serving_changes"),
        (PATH_HANDLING_PATTERNS, "path_handling_changes"),
        (AUTH_PATTERNS, "auth_changes"),
        (SECRET_HANDLING_PATTERNS, "secret_handling_changes"),
    ]:
        # Check both filenames and diff content for risk flags
        matches_in_files = any(
            any(pat.search(f) for pat in pat_set) for f in filenames
        )
        matches_in_diff = any(pat.search(diff_text) for pat in pat_set)
        if matches_in_files or matches_in_diff:
            if flag not in flags:
                flags.append(flag)

    return flags


def _build_must_check(pr_kind: str, risk_flags: list[str]) -> list[str]:
    """Generate explicit must-check items based on classification."""
    checks: list[str] = []

    if pr_kind == "renovate_digest_only":
        checks.append("verify no functional changes beyond lockfile hashes")
    elif pr_kind == "dependency_upgrade":
        checks.append("check for breaking API changes in updated dependencies")
        checks.append("run full test suite after upgrade")
    elif pr_kind == "k8s_manifest":
        checks.append("validate manifest against target cluster version")
        checks.append("check for resource quota / limit changes")
    elif pr_kind == "auth_changes":
        checks.append("review auth flow for regression")
        checks.append("verify session token handling is correct")
    elif pr_kind == "public_route_changes":
        checks.append("verify route access controls are in place")
        checks.append("check for unintended public endpoints")
    elif pr_kind == "file_serving_changes":
        checks.append("verify file path sanitization")
        checks.append("check for directory traversal vulnerabilities")
    elif pr_kind == "path_handling_changes":
        checks.append("review for path traversal vulnerabilities")
        checks.append("test with edge-case paths (null bytes, symlinks)")
    elif pr_kind == "secret_handling_changes":
        checks.append("verify secrets are not logged or exposed in diffs")
        checks.append("check secret rotation impact")
    elif pr_kind == "db_or_migration_changes":
        checks.append("review migration for data loss risk")
        checks.append("test migration on a copy of production schema")

    if "linked_security_issue" in risk_flags:
        checks.append("explicitly address the linked security issue")
    if "linked_audit_issue" in risk_flags:
        checks.append("verify audit findings are addressed")
    if "linked_priority_p0" in risk_flags:
        checks.append("treat as critical — verify all changes thoroughly")
    if "linked_priority_p1" in risk_flags:
        checks.append("treat as high priority — verify correctness carefully")

    return checks


def classify_pr(
    pr_files: list[dict],
    diff_text: str = "",
    pr_body: str = "",
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
    pr_body : str
        PR body text (used for linked issue reference extraction).
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
    risk_flags = _detect_risk_flags(pr_files, diff_text, linked_issues)
    must_check = _build_must_check(pr_kind, risk_flags)

    # Build changed files summary (just filenames, truncated)
    file_names = [f.get("filename", "") for f in pr_files]
    changed_files_summary = file_names[:max_summary_files]

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
        changed_files_summary=changed_files_summary,
        linked_issue_labels=linked_issue_labels,
        must_check=must_check,
    )


def classify_from_files(
    pr_files_path: str | Path,
    diff_path: str | Path = "",
    body_path: str | Path = "",
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

    pr_body = ""
    if body_path:
        pr_body = Path(body_path).read_text(encoding="utf-8", errors="replace")

    linked_issues: list[dict] = []
    if issues_path and Path(issues_path).exists():
        linked_issues = json.loads(
            Path(issues_path).read_text(encoding="utf-8"))

    result = classify_pr(pr_files, diff_text, pr_body, linked_issues)

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
    parser.add_argument("--body", default="",
                        help="Path to pr-body.txt (optional)")
    parser.add_argument("--linked-issues", default="",
                        help="Path to linked-issues.json (optional)")
    parser.add_argument("--output", default="classification.json",
                        help="Output path for classification JSON")

    args = parser.parse_args()
    classify_from_files(
        pr_files_path=args.pr_files,
        diff_path=args.diff,
        body_path=args.body,
        issues_path=args.linked_issues,
        output_path=args.output,
    )


if __name__ == "__main__":
    main()
