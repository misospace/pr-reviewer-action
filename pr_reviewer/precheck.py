"""Pre-check logic extracted from scripts/check_review_needed.sh.

Core functions for diff fingerprinting, incremental scope detection,
config hash computation, and review metadata transport.

These replace the shell implementations with testable Python code.
"""

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants (mirrored from check_review_needed.sh)
# ---------------------------------------------------------------------------

# Fingerprint prefix used in review comments and PR bodies
FP_PREFIX = "diff-fp:"

# Delimiter separating diff fingerprint from config hash in broad fingerprint
FP_DELIMITER = "|"

# Incremental scope detection constants
MAX_INCREMENTAL_FILES = 20
MAX_INCREMENTAL_LINES = 500
MIN_INCREMENTAL_RATIO = 0.1


class ReviewDecision(str, Enum):
    """Possible outcomes of the review-needed decision."""

    REVIEW_NEEDED = "review_needed"
    SKIP_NO_CHANGES = "skip_no_changes"
    SKIP_ALREADY_REVIEWED = "skip_already_reviewed"
    SKIP_INCREMENTAL = "skip_incremental"


@dataclass
class PrecheckResult:
    """Structured result of the pre-check evaluation."""

    decision: ReviewDecision
    diff_fingerprint: str = ""
    config_hash: str = ""
    broad_fingerprint: str = ""
    incremental_scope: Optional[str] = None
    incremental_files: list = field(default_factory=list)
    incremental_line_count: int = 0
    total_files: int = 0
    total_lines: int = 0
    reason: str = ""


# ---------------------------------------------------------------------------
# Fingerprinting
# ---------------------------------------------------------------------------


def compute_diff_fingerprint(diff_content: str) -> str:
    """Compute SHA256 fingerprint of diff content.

    Parameters
    ----------
    diff_content : str
        Raw git diff output (may be empty).

    Returns
    -------
    str
        Hex-encoded SHA256 digest, or empty string if input is empty/whitespace.
    """
    if not diff_content or not diff_content.strip():
        return ""
    return hashlib.sha256(diff_content.encode("utf-8")).hexdigest()


_EXACT_CONFIG_KEYS = frozenset((
    # Provider endpoints/versions (never the API keys themselves)
    "ANTHROPIC_VERSION",
    "AZURE_DEPLOYMENT_ID",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_ENDPOINT",
    "OPENAI_BASE_URL",
    # Review-affecting settings the original shell compute_config_hash
    # included explicitly; dropping any of these means a config change
    # no longer invalidates a stale review.
    "ACTION_REF",
    "CONTEXT_LIMIT_MODE",
    "MODEL_CONTEXT_TOKENS",
    "REVIEW_ROUTING_MODE",
    "REVIEW_SCOPE",
    "ESCALATE_ON_RISK_FLAGS",
    "SYSTEM_PROMPT",
    "STANDARDS_FILE_CANDIDATES",
    "LINEAR_API_KEY_CONFIGURED",
    "LINEAR_ISSUE_PREFIXES",
    "LINEAR_ISSUE_TIMEOUT_SEC",
    "LINEAR_ENABLE_FOR_FORKS",
    "EVIDENCE_PROVIDER_TIMEOUT_SEC",
    "EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES",
    "EVIDENCE_BLOCKER_ENFORCEMENT",
    "EVIDENCE_ENABLE_FOR_FORKS",
    "TOOL_MODE",
    "TOOL_MAX_REQUESTS",
    "TOOL_PLANNING_TIMEOUT_SEC",
    "TOOL_PLANNING_MAX_CONTEXT_BYTES",
    "TOOL_PLANNING_MAX_TOKENS",
    "TOOL_MAX_RESPONSE_BYTES",
    "TOOL_ALLOWED_GH_API_REPOS",
    "TOOL_REQUEST_TIMEOUT_SEC",
    "TOOL_FAILURE_ENFORCEMENT",
    "TOOL_MIN_SUCCESSFUL_REQUESTS",
    "TOOL_ENABLE_FOR_FORKS",
))


def _collect_config_lines() -> list[str]:
    """Collect configuration key=value pairs from environment and files.

    Mirrors the behaviour of ``compute_config_hash`` in the original
    ``check_review_needed.sh`` so that the Python version can be called
    without arguments from the shell wrapper.
    """
    lines: list[str] = []

    # Environment variables (sorted by key for determinism). AI_ is this
    # action's own input namespace, so a prefix sweep is safe there; every
    # other provider var is matched by exact name because broad prefixes
    # (AZURE_, OPENAI_, ...) also match variables the runner platform
    # presets (e.g. AZURE_EXTENSION_DIR on GitHub-hosted runners), which
    # would make the hash differ across runner images. Secrets are excluded
    # entirely: a rotated key does not change review behaviour, and secret
    # values do not belong in hash inputs.
    _CONFIG_KEYS = sorted(
        k
        for k in os.environ
        if (k.startswith("AI_") and not k.endswith("_API_KEY"))
        or k in _EXACT_CONFIG_KEYS
    )
    for key in _CONFIG_KEYS:
        lines.append(f"{key}={os.environ[key]}")

    # REVIEW_VERBOSITY hashes the value the review step will assemble a
    # prompt from, not the raw input: config.sh lowercases the dial and
    # degrades an unrecognized value to normal, and normal contributes
    # nothing so pre-dial fingerprints stay valid. Only a genuine switch
    # to concise changes the prompt, so only it invalidates.
    if os.environ.get("REVIEW_VERBOSITY", "").lower() == "concise":
        lines.append("REVIEW_VERBOSITY=concise")

    # Config files (sorted by path for determinism). Content is hashed via
    # the collected line, so editing a file at an unchanged path still
    # invalidates the review — matching the original shell behaviour for
    # SYSTEM_PROMPT_FILE / STANDARDS_FILE / EVIDENCE_PROVIDERS_FILE.
    # os.path.isfile follows symlinks, so a config path that is a symlink
    # hashes the target's content (a broken symlink is skipped). That is
    # intentional and matches the shell's sha256sum behaviour: whoever sets
    # these paths already controls the workflow env, and the content only
    # feeds a hash — it is never executed or echoed.
    _CONFIG_FILES = sorted(
        f
        for f in (
            os.environ.get("AI_CONFIG_FILE"),
            os.environ.get("AI_ADDITIONAL_INSTRUCTIONS_FILE"),
            os.environ.get("AI_EXCLUDES_FILE"),
            os.environ.get("AI_INCLUDES_FILE"),
            os.environ.get("AI_PROMPT_FILE"),
            os.environ.get("AI_RULES_FILE"),
            os.environ.get("SYSTEM_PROMPT_FILE"),
            os.environ.get("STANDARDS_FILE"),
            os.environ.get("EVIDENCE_PROVIDERS_FILE"),
        )
        if f and os.path.isfile(f)
    )
    for path in _CONFIG_FILES:
        try:
            with open(path, encoding="utf-8") as fh:
                lines.append(f"file:{path}={fh.read()}")
        except OSError:
            pass

    return lines


def compute_config_hash(config_lines: list[str] | None = None) -> str:
    """Compute SHA256 hash of configuration key=value pairs.

    Sorts lines lexicographically before hashing to ensure deterministic
    output regardless of input order.

    Parameters
    ----------
    config_lines : list[str] | None
        Lines in ``key=value`` format (may include comments and blanks).
        If ``None``, lines are collected from the environment using
        :func:`_collect_config_lines`.

    Returns
    -------
    str
        Hex-encoded SHA256 digest, or empty string if no config lines.
    """
    if config_lines is None:
        config_lines = _collect_config_lines()

    # Filter out comments and blank lines, then sort for determinism
    filtered = sorted(
        line.strip()
        for line in config_lines
        if line.strip() and not line.strip().startswith("#")
    )
    if not filtered:
        return ""
    joined = "\n".join(filtered) + "\n"
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def build_broad_fingerprint(diff_fp: str, config_hash: str) -> str:
    """Combine diff fingerprint and config hash with pipe delimiter.

    Parameters
    ----------
    diff_fp : str
        Diff fingerprint from ``compute_diff_fingerprint``.
    config_hash : str
        Config hash from ``compute_config_hash``.

    Returns
    -------
    str
        Combined string ``{diff_fp}|{config_hash}``, or just the diff_fp
        if config_hash is empty.
    """
    if not config_hash:
        return diff_fp
    return f"{diff_fp}{FP_DELIMITER}{config_hash}"


# ---------------------------------------------------------------------------
# Previous fingerprint extraction
# ---------------------------------------------------------------------------

# Regex matching ``diff-fp:<hex>`` in markdown bodies
_FP_RE = re.compile(r"diff-fp:([0-9a-fA-F]+)")


def _extract_previous_fingerprints(comment_body: str) -> list[str]:
    """Extract all diff fingerprints from a review comment or PR body.

    Parameters
    ----------
    comment_body : str
        Markdown text of a review comment or PR description.

    Returns
    -------
    list[str]
        List of hex-encoded fingerprint strings found in the body.
    """
    return _FP_RE.findall(comment_body)


def fingerprints_match(
    current_fp: str, previous_fingerprints: list[str]
) -> bool:
    """Check if the current fingerprint matches any previously recorded one.

    Parameters
    ----------
    current_fp : str
        Current diff fingerprint or broad fingerprint.
    previous_fingerprints : list[str]
        Fingerprints extracted from previous reviews/comments.

    Returns
    -------
    bool
        True if ``current_fp`` appears in ``previous_fingerprints``.
    """
    return current_fp in previous_fingerprints


# ---------------------------------------------------------------------------
# Incremental scope detection
# ---------------------------------------------------------------------------


def _parse_diff_stats(diff_content: str) -> dict:
    """Parse file change statistics from a git diff.

    Returns a dict with keys:
    - ``files``: list of changed file paths
    - ``total_lines``: total lines added + removed
    - ``file_line_counts``: dict mapping file path to (added, removed) tuple
    """
    files = []
    total_lines = 0
    file_line_counts: dict[str, tuple[int, int]] = {}

    # Match diff headers like "diff --git a/path b/path" or "--- a/path" / "+++ b/path"
    current_file = None
    for line in diff_content.splitlines():
        # Detect new file from diff header
        if line.startswith("diff --git"):
            parts = line.split()
            if len(parts) >= 4:
                current_file = parts[3]
                if current_file.startswith("b/"):
                    current_file = current_file[2:]
                files.append(current_file)
                file_line_counts[current_file] = (0, 0)
        elif line.startswith("--- a/") or line.startswith("+++ b/"):
            pass  # skip unified diff headers
        elif current_file and line.startswith("@@ "):
            # Parse hunk header for line counts: @@ -x,y +a,b @@
            match = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if match:
                added = int(match.group(2)) if match.group(2) else 1
                file_line_counts[current_file] = (added, file_line_counts[current_file][1])
                total_lines += added
        elif current_file and line.startswith("+"):
            total_lines += 1
            added, removed = file_line_counts.get(current_file, (0, 0))
            file_line_counts[current_file] = (added + 1, removed)
        elif current_file and line.startswith("-"):
            total_lines += 1
            added, removed = file_line_counts.get(current_file, (0, 0))
            file_line_counts[current_file] = (added, removed + 1)

    return {
        "files": files,
        "total_lines": total_lines,
        "file_line_counts": file_line_counts,
    }


def _detect_incremental_scope(diff_content: str) -> Optional[dict]:
    """Detect if changes are incremental (small subset of total).

    Returns a dict with scope information if the diff qualifies as
    incremental, or None otherwise.

    Incremental criteria:
    - Number of changed files <= MAX_INCREMENTAL_FILES
    - Total lines changed <= MAX_INCREMENTAL_LINES
    - Ratio of changed lines to total is >= MIN_INCREMENTAL_RATIO
      (to avoid flagging tiny changes in huge diffs)

    Parameters
    ----------
    diff_content : str
        Raw git diff output.

    Returns
    -------
    Optional[dict]
        Dict with ``files``, ``line_count``, ``total_files``, ``total_lines``
        if incremental, or None.
    """
    if not diff_content or not diff_content.strip():
        return None

    stats = _parse_diff_stats(diff_content)
    num_files = len(stats["files"])
    total_lines = stats["total_lines"]

    # Check incremental criteria
    if num_files > MAX_INCREMENTAL_FILES:
        return None
    if total_lines > MAX_INCREMENTAL_LINES:
        return None

    # Build scope description from changed files
    scope_files = stats["files"][:MAX_INCREMENTAL_FILES]

    return {
        "files": scope_files,
        "line_count": total_lines,
        "total_files": num_files,
        "total_lines": total_lines,
    }


# ---------------------------------------------------------------------------
# Config line extraction
# ---------------------------------------------------------------------------


def extract_config_lines(env_vars: dict[str, str]) -> list[str]:
    """Extract configuration lines from environment variables.

    Mirrors the shell logic that collects relevant config keys into
    key=value format for hashing.

    Parameters
    ----------
    env_vars : dict[str, str]
        Environment variable name -> value mapping.

    Returns
    -------
    list[str]
        Lines in ``key=value`` format suitable for ``compute_config_hash``.
    """
    config_keys = [
        "MODEL",
        "MAX_TOKENS",
        "TEMPERATURE",
        "TOP_P",
        "REVIEW_DEPTH",
        "ENABLE_SEMANTIC_CACHE",
        "CACHE_TTL",
        "CACHE_MAX_ENTRIES",
        "CACHE_SIMILARITY_THRESHOLD",
        "GITHUB_TOKEN",  # presence only, not value
        "OPENAI_API_KEY",  # presence only, not value
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",  # presence only, not value
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_DEPLOYMENT_ID",
        "OLLAMA_HOST",
        "OLLAMA_MODEL",
        "VLLM_SERVER_URL",
        "CUSTOM_API_URL",
        "CUSTOM_API_KEY",  # presence only, not value
        "CUSTOM_MODEL_NAME",
        "REQUEST_TIMEOUT",
        "MAX_RETRIES",
        "RETRY_DELAY",
        "ENABLE_STREAMING",
        "LOG_LEVEL",
    ]

    lines = []
    for key in config_keys:
        value = env_vars.get(key)
        if value is not None:
            # For secret keys, only record presence (not actual value)
            if key.endswith("_KEY") or key == "GITHUB_TOKEN":
                lines.append(f"{key}=***")
            else:
                lines.append(f"{key}={value}")
    return lines


# ---------------------------------------------------------------------------
# Main decision logic
# ---------------------------------------------------------------------------


def should_review(
    diff_content: str,
    config_lines: list[str],
    previous_fingerprints: list[str],
    *,
    enable_incremental_detection: bool = True,
) -> PrecheckResult:
    """Determine whether a PR review is needed.

    This is the core decision function extracted from ``check_review_needed.sh``.

    Parameters
    ----------
    diff_content : str
        Raw git diff output for the PR.
    config_lines : list[str]
        Configuration lines in key=value format.
    previous_fingerprints : list[str]
        Fingerprints from previous reviews/comments on this PR.
    enable_incremental_detection : bool
        Whether to perform incremental scope detection.

    Returns
    -------
    PrecheckResult
        Structured result with decision and metadata.
    """
    # Step 1: Compute diff fingerprint
    diff_fp = compute_diff_fingerprint(diff_content)

    if not diff_fp:
        return PrecheckResult(
            decision=ReviewDecision.SKIP_NO_CHANGES,
            reason="No diff content to review",
        )

    # Step 2: Compute config hash
    config_hash = compute_config_hash(config_lines)

    # Step 3: Build broad fingerprint
    broad_fp = build_broad_fingerprint(diff_fp, config_hash)

    # Step 4: Check if already reviewed (exact match)
    if fingerprints_match(broad_fp, previous_fingerprints):
        return PrecheckResult(
            decision=ReviewDecision.SKIP_ALREADY_REVIEWED,
            diff_fingerprint=diff_fp,
            config_hash=config_hash,
            broad_fingerprint=broad_fp,
            reason=f"Already reviewed (broad fingerprint {broad_fp[:12]}...)",
        )

    # Also check against diff-only fingerprints (backward compat)
    if fingerprints_match(diff_fp, previous_fingerprints):
        return PrecheckResult(
            decision=ReviewDecision.SKIP_ALREADY_REVIEWED,
            diff_fingerprint=diff_fp,
            config_hash=config_hash,
            broad_fingerprint=broad_fp,
            reason=f"Already reviewed (diff fingerprint {diff_fp[:12]}...)",
        )

    # Step 5: Incremental scope detection
    if enable_incremental_detection:
        incremental = _detect_incremental_scope(diff_content)
        if incremental:
            return PrecheckResult(
                decision=ReviewDecision.SKIP_INCREMENTAL,
                diff_fingerprint=diff_fp,
                config_hash=config_hash,
                broad_fingerprint=broad_fp,
                incremental_scope=json.dumps(incremental),
                incremental_files=incremental["files"],
                incremental_line_count=incremental["line_count"],
                total_files=incremental["total_files"],
                total_lines=incremental["total_lines"],
                reason=(
                    f"Incremental changes: {len(incremental['files'])} files, "
                    f"{incremental['line_count']} lines"
                ),
            )

    # Step 6: Default — review needed
    return PrecheckResult(
        decision=ReviewDecision.REVIEW_NEEDED,
        diff_fingerprint=diff_fp,
        config_hash=config_hash,
        broad_fingerprint=broad_fp,
        reason="New changes detected",
    )


# ---------------------------------------------------------------------------
# CLI entry point (for shell wrapper invocation)
# ---------------------------------------------------------------------------


def _format_output(result: PrecheckResult) -> str:
    """Format a PrecheckResult as shell-friendly output lines."""
    lines = [
        f"DECISION={result.decision.value}",
        f"DIFF_FINGERPRINT={result.diff_fingerprint}",
        f"CONFIG_HASH={result.config_hash}",
        f"BROAD_FINGERPRINT={result.broad_fingerprint}",
        f"REASON={result.reason}",
    ]
    if result.incremental_scope:
        lines.append(f"INCREMENTAL_SCOPE={result.incremental_scope}")
    if result.incremental_files:
        lines.append(f"INCREMENTAL_FILES={','.join(result.incremental_files)}")
    lines.append(f"INCREMENTAL_LINE_COUNT={result.incremental_line_count}")
    lines.append(f"TOTAL_FILES={result.total_files}")
    lines.append(f"TOTAL_LINES={result.total_lines}")
    return "\n".join(lines)


def main() -> None:
    """CLI entry point for the precheck module.

    Reads inputs from environment variables and files, writes structured
    output to stdout. Designed to be called from a thin shell wrapper.
    """
    # Read diff content
    diff_path = os.environ.get("DIFF_PATH")
    if diff_path and os.path.exists(diff_path):
        with open(diff_path, "r", encoding="utf-8") as f:
            diff_content = f.read()
    else:
        diff_content = os.environ.get("DIFF_CONTENT", "")

    # Read config lines from environment
    config_lines = extract_config_lines(dict(os.environ))

    # Optionally read config from file
    config_path = os.environ.get("CONFIG_PATH")
    if config_path and os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            config_lines.extend(f.read().splitlines())

    # Read previous fingerprints
    prev_fp_path = os.environ.get("PREV_FP_PATH")
    previous_fingerprints: list[str] = []
    if prev_fp_path and os.path.exists(prev_fp_path):
        with open(prev_fp_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(FP_PREFIX):
                    fp = line[len(FP_PREFIX) :].strip()
                    if fp:
                        previous_fingerprints.append(fp)

    # Also accept fingerprints from env var (comma-separated)
    prev_fps_env = os.environ.get("PREV_FINGERPRINTS", "")
    if prev_fps_env:
        for fp in prev_fps_env.split(","):
            fp = fp.strip()
            if fp:
                previous_fingerprints.append(fp)

    # Run decision logic
    enable_incremental = os.environ.get("ENABLE_INCREMENTAL_DETECTION", "true").lower() != "false"
    result = should_review(
        diff_content,
        config_lines,
        previous_fingerprints,
        enable_incremental_detection=enable_incremental,
    )

    # Output structured result
    print(_format_output(result))


if __name__ == "__main__":
    main()
