"""Pre-check logic extracted from check_review_needed.sh.

Provides fingerprinting, incremental scope detection, config hash computation,
and review metadata transport as pure Python functions suitable for unit
testing with coverage metrics.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class DiffStats:
    """Statistics extracted from a git diff."""
    changed_files: list[str] = field(default_factory=list)
    total_insertions: int = 0
    total_deletions: int = 0
    has_code_changes: bool = False

    @property
    def total_lines(self) -> int:
        """Total number of changed lines (insertions + deletions)."""
        return self.total_insertions + self.total_deletions


@dataclass
class ReviewScope:
    """Computed review scope for the current PR."""
    scope: str = "full"  # "full", "incremental", "none"
    incremental_files: list[str] = field(default_factory=list)
    incremental_line_ranges: dict[str, list[tuple[int, int]]] = field(default_factory=dict)
    reason: str = ""


@dataclass
class SkipResult:
    """Result of should_skip_review evaluation."""
    should_skip: bool = False
    reason: str = ""


@dataclass
class ReviewMetadata:
    """Review metadata for transport via GitHub API."""
    config_hash: str = ""
    diff_fingerprint: str = ""
    review_scope: str = "full"
    skip_reason: str = ""
    incremental_files: list[str] = field(default_factory=list)
    changed_files: list[str] = field(default_factory=list)
    total_insertions: int = 0
    total_deletions: int = 0
    total_lines: int = 0


# ---------------------------------------------------------------------------
# Config hash computation
# ---------------------------------------------------------------------------

def compute_config_hash(
    model: str = "",
    temperature: float = 0.7,
    max_tokens: int = 4096,
    system_prompt: str = "",
    review_mode: str = "default",
    additional_config: Optional[dict] = None,
) -> str:
    """Compute SHA256 hash of configuration values.

    This replaces the bash ``compute_config_hash`` function which concatenated
    config values and piped them to ``sha256sum``.

    Args:
        model: LLM model identifier.
        temperature: Sampling temperature.
        max_tokens: Maximum token limit.
        system_prompt: System prompt text.
        review_mode: Review mode (default, thorough, quick).
        additional_config: Extra key-value pairs to include in the hash.

    Returns:
        Hex-encoded SHA256 digest string.
    """
    hasher = hashlib.sha256()
    # Use a deterministic separator to avoid collisions
    parts = [
        f"model={model}",
        f"temperature={temperature}",
        f"max_tokens={max_tokens}",
        f"system_prompt={system_prompt}",
        f"review_mode={review_mode}",
    ]
    if additional_config:
        for key in sorted(additional_config.keys()):
            parts.append(f"{key}={additional_config[key]}")
    hasher.update("|".join(parts).encode("utf-8"))
    return hasher.hexdigest()


# ---------------------------------------------------------------------------
# Diff fingerprinting
# ---------------------------------------------------------------------------

def compute_diff_fingerprint(diff_content: str) -> tuple[str, DiffStats]:
    """Compute SHA256 fingerprint and statistics from diff content.

    Replaces the bash ``compute_diff_fingerprint`` function which used
    ``git diff``, ``grep``, and ``awk`` to extract file lists and line counts.

    Args:
        diff_content: Raw unified diff text (as produced by ``git diff --unified=0``).

    Returns:
        A tuple of (hex fingerprint, DiffStats).
    """
    hasher = hashlib.sha256()
    hasher.update(diff_content.encode("utf-8"))
    fingerprint = hasher.hexdigest()

    stats = _parse_diff_stats(diff_content)
    return fingerprint, stats


def _parse_diff_stats(diff_content: str) -> DiffStats:
    """Parse unified diff text into DiffStats.

    Mirrors the bash logic that used ``grep '^diff --git'``,
    ``grep '^[+-]'``, and ``awk`` to count insertions/deletions.
    """
    changed_files = []
    total_insertions = 0
    total_deletions = 0
    has_code_changes = False

    # File extensions considered "code" (matching the bash CODE_EXTENSIONS)
    code_extensions = {
        ".py", ".js", ".ts", ".jsx", ".tsx", ".java", ".go", ".rs",
        ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".sh", ".bash",
        ".zsh", ".fish", ".pl", ".pm", ".lua", ".r", ".scala", ".kt",
        ".swift", ".dart", ".cs", ".vb", ".f90", ".f95", ".for",
        ".asm", ".s", ".v", ".sv", ".vhdl", ".tcl", ".vim",
        ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg",
        ".xml", ".html", ".htm", ".css", ".scss", ".sass", ".less",
        ".sql", ".graphql", ".proto", ".thrift", ".avsc",
        ".dockerfile", ".makefile", ".cmake",
    }

    # Track files we've already seen to avoid duplicates
    seen_files = set()

    for line in diff_content.split("\n"):
        # Extract changed file paths from "diff --git a/... b/..." lines
        if line.startswith("diff --git "):
            parts = line.split()
            if len(parts) >= 4:
                # Take the "b/" path (destination)
                b_path = parts[3]
                if b_path.startswith("b/"):
                    b_path = b_path[2:]
                if b_path and b_path not in seen_files:
                    seen_files.add(b_path)
                    changed_files.append(b_path)

        # Count insertions and deletions (skip the --- / +++ header lines)
        if line.startswith("+") and not line.startswith("+++"):
            total_insertions += 1
            has_code_changes = True
        elif line.startswith("-") and not line.startswith("---"):
            total_deletions += 1
            has_code_changes = True

    # Determine if any changed file is a code file
    for f in changed_files:
        _, ext = os.path.splitext(f)
        if ext.lower() in code_extensions:
            has_code_changes = True
            break

    return DiffStats(
        changed_files=changed_files,
        total_insertions=total_insertions,
        total_deletions=total_deletions,
        has_code_changes=has_code_changes,
    )


# ---------------------------------------------------------------------------
# Skip review evaluation
# ---------------------------------------------------------------------------

def should_skip_review(
    pr_title: str = "",
    pr_body: str = "",
    labels: Optional[list[str]] = None,
    author: str = "",
    diff_stats: Optional[DiffStats] = None,
    cached_status: Optional[dict] = None,
    skip_labels: Optional[list[str]] = None,
    skip_patterns: Optional[list[str]] = None,
    bot_usernames: Optional[list[str]] = None,
    config_hash: str = "",
) -> SkipResult:
    """Determine if the review should be skipped.

    Replaces the bash ``should_skip_review`` function which checked:
    - Skip labels on the PR
    - Skip patterns in title/body
    - Bot author
    - No code changes
    - Cache hit with matching config hash

    Args:
        pr_title: Pull request title.
        pr_body: Pull request body/description.
        labels: List of label names on the PR.
        author: PR author username.
        diff_stats: Parsed diff statistics.
        cached_status: Cached review status from previous run.
        skip_labels: Labels that trigger a skip (default: ["skip-review", "no-review"]).
        skip_patterns: Regex patterns in title/body that trigger a skip.
        bot_usernames: Usernames considered bots.
        config_hash: Current config hash to compare against cache.

    Returns:
        SkipResult with should_skip flag and reason.
    """
    if labels is None:
        labels = []
    if diff_stats is None:
        diff_stats = DiffStats()
    if skip_labels is None:
        skip_labels = ["skip-review", "no-review"]
    if skip_patterns is None:
        skip_patterns = [r"\[skip review\]", r"\[no review\]"]
    if bot_usernames is None:
        bot_usernames = ["dependabot[bot]", "renovate[bot]", "github-actions[bot]"]

    # Check skip labels
    for label in labels:
        if label.lower() in [sl.lower() for sl in skip_labels]:
            return SkipResult(should_skip=True, reason=f"skip label: {label}")

    # Check skip patterns in title and body
    text_to_check = f"{pr_title}\n{pr_body}"
    for pattern in skip_patterns:
        if re.search(pattern, text_to_check, re.IGNORECASE):
            return SkipResult(should_skip=True, reason=f"skip pattern matched: {pattern}")

    # Check bot author
    for bot in bot_usernames:
        if author.lower() == bot.lower():
            return SkipResult(should_skip=True, reason=f"bot author: {author}")

    # Check no code changes
    if not diff_stats.has_code_changes and not diff_stats.changed_files:
        return SkipResult(should_skip=True, reason="no code changes detected")

    # Check cache hit with matching config hash
    if cached_status is not None:
        cached_head = cached_status.get("head_sha", "")
        current_head = os.environ.get("GITHUB_SHA", "")
        cached_config = cached_status.get("config_hash", "")
        if cached_head == current_head and cached_config == config_hash:
            return SkipResult(should_skip=True, reason="cache hit with matching config")

    return SkipResult(should_skip=False, reason="")


# ---------------------------------------------------------------------------
# Review scope computation
# ---------------------------------------------------------------------------

def compute_review_scope(
    diff_stats: Optional[DiffStats] = None,
    cached_status: Optional[dict] = None,
    max_lines_full_review: int = 5000,
) -> ReviewScope:
    """Compute the review scope (full, incremental, or none).

    Replaces the bash ``compute_review_scope`` function which compared
    diff size against a threshold and checked for incremental changes.

    Args:
        diff_stats: Parsed diff statistics.
        cached_status: Cached review status from previous run.
        max_lines_full_review: Threshold for switching to incremental mode.

    Returns:
        ReviewScope with scope type and details.
    """
    if diff_stats is None:
        diff_stats = DiffStats()

    # If no changes, scope is "none"
    if not diff_stats.changed_files:
        return ReviewScope(scope="none", reason="no changes detected")

    # Check if we have a previous review to do incremental
    if cached_status is not None:
        previous_head = cached_status.get("previous_head_sha", "")
        current_head = os.environ.get("GITHUB_SHA", "")
        if previous_head and previous_head != current_head:
            # There are new changes since last review
            if diff_stats.total_lines > max_lines_full_review:
                return ReviewScope(
                    scope="incremental",
                    incremental_files=diff_stats.changed_files,
                    reason=f"incremental: {diff_stats.total_lines} lines exceeds threshold {max_lines_full_review}",
                )

    # Default to full review
    if diff_stats.total_lines > max_lines_full_review:
        return ReviewScope(
            scope="incremental",
            incremental_files=diff_stats.changed_files,
            reason=f"large diff: {diff_stats.total_lines} lines exceeds threshold {max_lines_full_review}",
        )

    return ReviewScope(scope="full", reason="within size threshold")


# ---------------------------------------------------------------------------
# Incremental scope detection
# ---------------------------------------------------------------------------

def get_incremental_scope(
    current_diff: str,
    previous_diff: str = "",
) -> tuple[list[str], dict[str, list[tuple[int, int]]]]:
    """Detect files and line ranges that changed since the previous review.

    Replaces the bash ``get_incremental_scope`` function which compared
    two diff outputs to find new changes.

    Args:
        current_diff: Current unified diff text.
        previous_diff: Previous unified diff text (empty if first review).

    Returns:
        Tuple of (incremental_files, line_ranges_by_file).
    """
    current_stats = _parse_diff_stats(current_diff)
    current_files = set(current_stats.changed_files)

    if not previous_diff.strip():
        # First review — all files are incremental
        return list(current_files), {}

    previous_stats = _parse_diff_stats(previous_diff)
    previous_files = set(previous_stats.changed_files)

    # Files that are new or changed
    incremental_files = list(current_files - previous_files)

    # For files in both diffs, we'd need line-level comparison
    # For now, include all current files as potentially incremental
    if not incremental_files:
        incremental_files = list(current_files)

    return incremental_files, {}


# ---------------------------------------------------------------------------
# Review metadata transport
# ---------------------------------------------------------------------------

def build_review_metadata(
    config_hash: str,
    diff_fingerprint: str,
    review_scope: str,
    skip_reason: str = "",
    diff_stats: Optional[DiffStats] = None,
) -> ReviewMetadata:
    """Build review metadata object for transport.

    Replaces the bash ``set_review_metadata`` function which exported
    variables and wrote to a temp file for the calling script.

    Args:
        config_hash: SHA256 hash of current configuration.
        diff_fingerprint: SHA256 fingerprint of the diff.
        review_scope: Computed review scope string.
        skip_reason: Reason for skipping (if applicable).
        diff_stats: Parsed diff statistics.

    Returns:
        ReviewMetadata object.
    """
    if diff_stats is None:
        diff_stats = DiffStats()

    return ReviewMetadata(
        config_hash=config_hash,
        diff_fingerprint=diff_fingerprint,
        review_scope=review_scope,
        skip_reason=skip_reason,
        incremental_files=[],
        changed_files=diff_stats.changed_files,
        total_insertions=diff_stats.total_insertions,
        total_deletions=diff_stats.total_deletions,
        total_lines=diff_stats.total_lines,
    )


def metadata_to_json(metadata: ReviewMetadata) -> str:
    """Serialize ReviewMetadata to compact JSON for API transport.

    Returns:
        Compact JSON string (no whitespace).
    """
    return json.dumps({
        "config_hash": metadata.config_hash,
        "diff_fingerprint": metadata.diff_fingerprint,
        "review_scope": metadata.review_scope,
        "skip_reason": metadata.skip_reason,
        "incremental_files": metadata.incremental_files,
        "changed_files": metadata.changed_files,
        "total_insertions": metadata.total_insertions,
        "total_deletions": metadata.total_deletions,
        "total_lines": metadata.total_lines,
    }, separators=(",", ":"))


def metadata_from_json(json_str: str) -> ReviewMetadata:
    """Deserialize JSON string to ReviewMetadata.

    Args:
        json_str: JSON string from API response or file.

    Returns:
        ReviewMetadata object.
    """
    data = json.loads(json_str)
    return ReviewMetadata(
        config_hash=data.get("config_hash", ""),
        diff_fingerprint=data.get("diff_fingerprint", ""),
        review_scope=data.get("review_scope", "full"),
        skip_reason=data.get("skip_reason", ""),
        incremental_files=data.get("incremental_files", []),
        changed_files=data.get("changed_files", []),
        total_insertions=data.get("total_insertions", 0),
        total_deletions=data.get("total_deletions", 0),
        total_lines=data.get("total_lines", 0),
    )


# ---------------------------------------------------------------------------
# CLI entry point (for shell wrapper)
# ---------------------------------------------------------------------------

def run_precheck(
    diff_file: str = "",
    pr_title: str = "",
    pr_body: str = "",
    labels: str = "",
    author: str = "",
    model: str = "",
    temperature: float = 0.7,
    max_tokens: int = 4096,
    system_prompt: str = "",
    review_mode: str = "default",
    skip_labels_str: str = "",
    skip_patterns_str: str = "",
    bot_usernames_str: str = "",
    cached_status_file: str = "",
    max_lines_full_review: int = 5000,
) -> dict:
    """Run the full precheck pipeline.

    This is the main entry point called by the shell wrapper. It reads
    environment variables and files to perform all precheck steps.

    Returns:
        Dictionary with precheck results (JSON-serializable).
    """
    # Read diff content
    diff_content = ""
    if diff_file and os.path.isfile(diff_file):
        with open(diff_file, "r", encoding="utf-8", errors="replace") as f:
            diff_content = f.read()

    # Parse labels from comma-separated string
    labels_list = [l.strip() for l in labels.split(",") if l.strip()] if labels else []

    # Parse skip labels
    skip_labels_list = [l.strip() for l in skip_labels_str.split(",") if l.strip()] if skip_labels_str else None

    # Parse skip patterns
    skip_patterns_list = [p.strip() for p in skip_patterns_str.split(",") if p.strip()] if skip_patterns_str else None

    # Parse bot usernames
    bot_usernames_list = [b.strip() for b in bot_usernames_str.split(",") if b.strip()] if bot_usernames_str else None

    # Read cached status if available
    cached_status = None
    if cached_status_file and os.path.isfile(cached_status_file):
        with open(cached_status_file, "r", encoding="utf-8") as f:
            try:
                cached_status = json.loads(f.read())
            except (json.JSONDecodeError, ValueError):
                cached_status = None

    # Step 1: Compute config hash
    config_hash = compute_config_hash(
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
        review_mode=review_mode,
    )

    # Step 2: Compute diff fingerprint and stats
    fingerprint, diff_stats = compute_diff_fingerprint(diff_content)

    # Step 3: Check if review should be skipped
    skip_result = should_skip_review(
        pr_title=pr_title,
        pr_body=pr_body,
        labels=labels_list,
        author=author,
        diff_stats=diff_stats,
        cached_status=cached_status,
        skip_labels=skip_labels_list,
        skip_patterns=skip_patterns_list,
        bot_usernames=bot_usernames_list,
        config_hash=config_hash,
    )

    # Step 4: Compute review scope
    review_scope = compute_review_scope(
        diff_stats=diff_stats,
        cached_status=cached_status,
        max_lines_full_review=max_lines_full_review,
    )

    # Step 5: Build metadata
    metadata = build_review_metadata(
        config_hash=config_hash,
        diff_fingerprint=fingerprint,
        review_scope=review_scope.scope,
        skip_reason=skip_result.reason,
        diff_stats=diff_stats,
    )

    return {
        "config_hash": config_hash,
        "diff_fingerprint": fingerprint,
        "should_skip": skip_result.should_skip,
        "skip_reason": skip_result.reason,
        "review_scope": review_scope.scope,
        "incremental_files": review_scope.incremental_files,
        "changed_files": diff_stats.changed_files,
        "total_insertions": diff_stats.total_insertions,
        "total_deletions": diff_stats.total_deletions,
        "total_lines": diff_stats.total_lines,
        "has_code_changes": diff_stats.has_code_changes,
    }


def main() -> int:
    """CLI entry point. Reads env vars and outputs JSON result."""
    # Read from environment variables (set by shell wrapper)
    diff_file = os.environ.get("PRECHECK_DIFF_FILE", "")
    pr_title = os.environ.get("PRECHECK_PR_TITLE", "")
    pr_body = os.environ.get("PRECHECK_PR_BODY", "")
    labels = os.environ.get("PRECHECK_LABELS", "")
    author = os.environ.get("PRECHECK_AUTHOR", "")
    model = os.environ.get("MODEL", os.environ.get("OPENAI_MODEL_NAME", "gpt-4"))
    temperature = float(os.environ.get("TEMPERATURE", "0.7"))
    max_tokens = int(os.environ.get("MAX_TOKENS", "4096"))
    system_prompt = os.environ.get("SYSTEM_PROMPT", "")
    review_mode = os.environ.get("REVIEW_MODE", "default")
    skip_labels_str = os.environ.get("SKIP_LABELS", "")
    skip_patterns_str = os.environ.get("SKIP_PATTERNS", "")
    bot_usernames_str = os.environ.get("BOT_USERNAMES", "")
    cached_status_file = os.environ.get("PRECHECK_CACHED_STATUS_FILE", "")
    max_lines_full_review = int(os.environ.get("MAX_LINES_FULL_REVIEW", "5000"))

    result = run_precheck(
        diff_file=diff_file,
        pr_title=pr_title,
        pr_body=pr_body,
        labels=labels,
        author=author,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        system_prompt=system_prompt,
        review_mode=review_mode,
        skip_labels_str=skip_labels_str,
        skip_patterns_str=skip_patterns_str,
        bot_usernames_str=bot_usernames_str,
        cached_status_file=cached_status_file,
        max_lines_full_review=max_lines_full_review,
    )

    # Output as JSON
    print(json.dumps(result, indent=2))

    # Set exit code based on skip result
    if result["should_skip"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
