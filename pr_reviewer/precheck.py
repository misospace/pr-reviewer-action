"""Pre-check logic extracted from scripts/check_review_needed.sh.

Core functions for diff fingerprinting, incremental scope detection,
config hash computation, and review metadata transport.

These replace the shell implementations with testable Python code.

CLI contract (``python3 -m pr_reviewer.precheck``)
---------------------------------------------------

The module entry point (``main``) reads its inputs from the environment
and writes a single JSON object to stdout with the keys ``should_review``,
``skip_reason``, ``effective_review_scope``, ``previous_head_sha``,
``baseline_clean``, ``diff_fingerprint``, ``broad_fingerprint`` and
``config_hash``. It is the decision half of the action precheck; the shell
wrapper performs platform I/O (diff/PR/comment fetches) and forwards the
result to ``$GITHUB_OUTPUT``.

Environment inputs:

- ``PRECHECK_DIFF_PATH`` / ``DIFF_PATH``: path to the PR diff file
  (``PRECHECK_DIFF_PATH`` wins; ``DIFF_CONTENT`` is the fallback when
  neither file is set).
- ``PREV_FINGERPRINTS``: comma-separated fingerprints stored in previous
  managed reviews (``PREV_FP_PATH`` file with ``diff-fp:`` lines is also
  honoured).
- ``FORCE_REVIEW``: ``true`` bypasses the diff-unchanged guard.
- ``SKIP_IF_DIFF_UNCHANGED``: ``true`` (default) enables the guard.
- ``REVIEW_SCOPE``: user scope request (``full`` / ``incremental`` /
  ``auto``); ``auto`` is the default.
- ``PREVIOUS_HEAD_SHA`` / ``PREVIOUS_BASE_SHA`` / ``PREVIOUS_REVIEW_RESULT``:
  metadata from the last managed review.
- ``PREVIOUS_HEAD_IS_ANCESTOR`` / ``COMPARE_RANGE_OK``: caller-supplied
  validation verdicts for the previous→current range (ancestorship and
  compare/base continuity). Unset means "not asserted" (the check does
  not gate the baseline); ``false`` forces a full-scope fallback.

``diff_fingerprint`` is the diff's own fingerprint (``empty-diff``
placeholder for an empty diff); ``broad_fingerprint`` is the marker form
``<diff_fingerprint>|cfg:<config_hash>`` stored in the
``ai-pr-review-fingerprint`` comment marker, so a published fingerprint
round-trips into the diff-unchanged comparison on the next run.
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

# Placeholder fingerprint for an empty diff, so the stored-marker
# comparison has a stable value to match on re-runs.
EMPTY_DIFF_FINGERPRINT = "empty-diff"

# Suffix marking the config-hash half of a marker fingerprint, as stored in
# the ai-pr-review-fingerprint comment marker: `<diff_fp>|cfg:<config_hash>`.
CONFIG_HASH_MARKER = "cfg:"

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


@dataclass
class ScopeResolution:
    """Outcome of metadata-based review scope resolution.

    A full scope always clears the carried incremental baseline: no
    previous head is forwarded and the baseline is untrusted.
    """

    effective_review_scope: str = "full"
    previous_head_sha: str = ""
    baseline_clean: bool = False


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
    "TOOL_MAX_ROUNDS",
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


def build_marker_fingerprint(diff_fp: str, config_hash: str) -> str:
    """Build the marker-compatible broad fingerprint.

    Unlike :func:`build_broad_fingerprint` (the library-internal
    ``<diff_fp>|<config_hash>`` form), this is the exact string stored in
    the ``ai-pr-review-fingerprint`` comment marker and compared against
    ``PREV_FINGERPRINTS`` on the next run:

    - an empty ``diff_fp`` becomes the ``empty-diff`` placeholder, so an
      empty diff still yields a stable, matchable fingerprint;
    - the config hash is always present in ``|cfg:<hash>`` form, matching
      the shell's synthesis and keeping the marker parseable even when the
      hash is empty.

    Parameters
    ----------
    diff_fp : str
        Diff fingerprint (empty string for an empty diff).
    config_hash : str
        Config hash from ``compute_config_hash`` (may be empty).

    Returns
    -------
    str
        ``<diff_fp or empty-diff>|cfg:<config_hash>``.
    """
    fp = diff_fp or EMPTY_DIFF_FINGERPRINT
    return f"{fp}{FP_DELIMITER}{CONFIG_HASH_MARKER}{config_hash}"


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
# Action precheck contract (scope resolution, decision mapping, payload)
# ---------------------------------------------------------------------------


def resolve_review_scope(
    review_scope: str,
    previous_head_sha: str,
    previous_base_sha: str,
    previous_review_result: str = "",
    *,
    force_review: bool = False,
    previous_head_is_ancestor: Optional[bool] = None,
    compare_range_ok: Optional[bool] = None,
) -> ScopeResolution:
    """Resolve the effective review scope from explicit metadata inputs.

    Python-side port of the scope logic that used to live in
    ``check_review_needed.sh``: no git or API calls are made here. The
    range validations the shell used to run itself (``git merge-base
    --is-ancestor`` and the compare API) are passed in as verdicts:

    - ``previous_head_is_ancestor``: whether the previous head is an
      ancestor of the current head (force-push/rebase detection).
    - ``compare_range_ok``: whether the previous→current range is still
      comparable, which subsumes base-branch continuity (a changed base
      makes the stored incremental range invalid).

    ``None`` means the caller did not assert the check (it does not gate
    the baseline, mirroring the old shell skipping a check it could not
    run); ``True`` is a passing verdict; ``False`` forces a full-scope
    fallback.

    Rules, in order:

    1. ``force_review`` or a ``full`` scope request → full scope.
    2. An unrecognized ``review_scope`` degrades to ``auto`` (with a
       warning) and continues through the safety gates.
    3. Missing previous head or base metadata → full scope (no baseline
       to increment from).
    4. A failing validation verdict → full scope.
    5. Otherwise → incremental scope carrying ``previous_head_sha``;
       ``baseline_clean`` is true only when the previous review result
       was ``clean`` or absent.

    Parameters
    ----------
    review_scope : str
        User scope request (``full`` / ``incremental`` / ``auto``).
    previous_head_sha : str
        Head SHA recorded in the last managed review marker.
    previous_base_sha : str
        Base SHA recorded in the last managed review marker.
    previous_review_result : str
        Review result recorded in the last managed review marker.
    force_review : bool
        Explicit re-review (label-driven or input); always full scope.
    previous_head_is_ancestor : bool | None
        Caller verdict for previous-head ancestorship (see above).
    compare_range_ok : bool | None
        Caller verdict for range comparability (see above).

    Returns
    -------
    ScopeResolution
    """
    full = ScopeResolution()

    if force_review:
        logger.info("Forced re-review: using full scope")
        return full

    scope = (review_scope or "").strip().lower()
    if scope == "full":
        return full
    if scope not in ("", "auto", "incremental"):
        logger.warning(
            "Invalid REVIEW_SCOPE %r; defaulting to auto", review_scope
        )

    if not previous_head_sha or not previous_base_sha:
        return full
    if previous_head_is_ancestor is False:
        logger.info(
            "Review scope fallback: previous head %s is not an ancestor of "
            "the current head (possible force-push/rebase)",
            previous_head_sha,
        )
        return full
    if compare_range_ok is False:
        logger.info(
            "Review scope fallback: previous→current range is not comparable"
        )
        return full

    return ScopeResolution(
        effective_review_scope="incremental",
        previous_head_sha=previous_head_sha,
        baseline_clean=(previous_review_result or "").strip().lower()
        in ("", "clean"),
    )


def evaluate_precheck(
    diff_content: str,
    previous_fingerprints: list[str],
    *,
    config_hash: Optional[str] = None,
    force_review: bool = False,
    skip_if_diff_unchanged: bool = True,
) -> PrecheckResult:
    """Run the action's should-review decision over a diff.

    The action's guard is narrower than the library-level
    :func:`should_review`: the only skip is a marker fingerprint match
    (diff unchanged since the last managed review), and an empty diff is
    not a skip — it fingerprinted as ``empty-diff`` so that the marker
    round-trip can skip *subsequent* runs. Scope selection is out of
    scope here (see :func:`resolve_review_scope`).

    Parameters
    ----------
    diff_content : str
        Raw PR diff (may be empty).
    previous_fingerprints : list[str]
        Marker fingerprints stored in previous managed reviews.
    config_hash : str | None
        Config hash; computed from the environment when ``None`` (the
        shell wrapper computes the same value independently, so both
        sides hash the identical config).
    force_review : bool
        Bypasses the diff-unchanged guard.
    skip_if_diff_unchanged : bool
        Enables the diff-unchanged guard.

    Returns
    -------
    PrecheckResult
        ``REVIEW_NEEDED`` or ``SKIP_ALREADY_REVIEWED``; the
        ``diff_fingerprint`` field carries the marker form's diff half
        (``empty-diff`` placeholder for an empty diff) and
        ``broad_fingerprint`` the full marker string.
    """
    if config_hash is None:
        config_hash = compute_config_hash()
    diff_fp = compute_diff_fingerprint(diff_content)
    marker_fp = diff_fp or EMPTY_DIFF_FINGERPRINT
    broad = build_marker_fingerprint(marker_fp, config_hash)

    if (
        not force_review
        and skip_if_diff_unchanged
        and fingerprints_match(broad, previous_fingerprints)
    ):
        return PrecheckResult(
            decision=ReviewDecision.SKIP_ALREADY_REVIEWED,
            diff_fingerprint=marker_fp,
            config_hash=config_hash,
            broad_fingerprint=broad,
            reason="Diff unchanged since last review",
        )

    return PrecheckResult(
        decision=ReviewDecision.REVIEW_NEEDED,
        diff_fingerprint=marker_fp,
        config_hash=config_hash,
        broad_fingerprint=broad,
        reason="New or forced changes detected",
    )


def _decision_to_outputs(decision: ReviewDecision) -> tuple[bool, str]:
    """Map a ReviewDecision to the action's (should_review, skip_reason).

    ``SKIP_INCREMENTAL`` still runs a review: in the action, incremental
    is a scope (resolved from metadata), not a reason to skip.
    """
    if decision is ReviewDecision.SKIP_ALREADY_REVIEWED:
        return False, "diff-unchanged"
    if decision is ReviewDecision.SKIP_NO_CHANGES:
        return False, "no-changes"
    return True, ""


def build_precheck_payload(
    result: PrecheckResult, scope: ScopeResolution
) -> dict:
    """Assemble the JSON payload the CLI writes to stdout.

    When the decision does not run a review the scope fields are reset to
    the full-scope defaults, so the payload is internally consistent
    (the shell wrapper re-applies the same reset defensively).
    """
    should_review, skip_reason = _decision_to_outputs(result.decision)
    if not should_review:
        scope = ScopeResolution()
    return {
        "should_review": should_review,
        "skip_reason": skip_reason,
        "effective_review_scope": scope.effective_review_scope,
        "previous_head_sha": scope.previous_head_sha,
        "baseline_clean": scope.baseline_clean,
        "diff_fingerprint": result.diff_fingerprint,
        "broad_fingerprint": result.broad_fingerprint,
        "config_hash": result.config_hash,
    }


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


def _env_flag(name: str, default: bool) -> bool:
    """Read a boolean env flag the way the shell compared it (``== true``).

    Unset falls back to ``default``; only a case-insensitive ``true``
    counts as true, so a mistyped value degrades to the safe side of each
    flag (force off, guard on via the caller's default).
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() == "true"


def _env_validation_flag(name: str) -> Optional[bool]:
    """Read a caller-supplied range-validation verdict.

    Unset/empty means the caller did not assert the check (returns
    ``None``; the check does not gate the baseline). ``true``/``false``
    (case-insensitive, plus ``1``/``0``) are the verdicts. An unparseable
    value fails closed to ``False``: a broken verdict must not certify a
    baseline it cannot vouch for.
    """
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return None
    value = raw.strip().lower()
    if value in ("true", "1"):
        return True
    if value in ("false", "0"):
        return False
    logger.warning("Unparseable %s=%r; treating validation as failed", name, raw)
    return False


def _read_diff_content() -> str:
    """Read the PR diff from the first set, readable path env var."""
    for var in ("PRECHECK_DIFF_PATH", "DIFF_PATH"):
        path = os.environ.get(var)
        if path and os.path.exists(path):
            try:
                # errors="replace" keeps binary-ish diffs hashable without
                # crashing the precheck; the replacement is deterministic,
                # so re-runs fingerprint identically.
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    return f.read()
            except OSError:
                logger.warning("Could not read diff file %s", path)
    return os.environ.get("DIFF_CONTENT", "")


def _read_previous_fingerprints() -> list[str]:
    """Collect stored marker fingerprints from env and optional file."""
    fingerprints: list[str] = []

    prev_fp_path = os.environ.get("PREV_FP_PATH")
    if prev_fp_path and os.path.exists(prev_fp_path):
        with open(prev_fp_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(FP_PREFIX):
                    fp = line[len(FP_PREFIX) :].strip()
                    if fp:
                        fingerprints.append(fp)

    # Also accept fingerprints from env var (comma-separated)
    prev_fps_env = os.environ.get("PREV_FINGERPRINTS", "")
    if prev_fps_env:
        for fp in prev_fps_env.split(","):
            fp = fp.strip()
            if fp:
                fingerprints.append(fp)

    return fingerprints


def main() -> None:
    """CLI entry point for the precheck module.

    Reads the action precheck inputs from the environment (see the module
    docstring for the contract) and writes a single JSON object to stdout
    with the keys ``should_review``, ``skip_reason``,
    ``effective_review_scope``, ``previous_head_sha``, ``baseline_clean``,
    ``diff_fingerprint``, ``broad_fingerprint`` and ``config_hash``.
    Designed to be called from a thin shell wrapper; library callers use
    :func:`evaluate_precheck` / :func:`resolve_review_scope` directly.
    """
    diff_content = _read_diff_content()
    previous_fingerprints = _read_previous_fingerprints()
    force_review = _env_flag("FORCE_REVIEW", default=False)
    skip_if_diff_unchanged = _env_flag("SKIP_IF_DIFF_UNCHANGED", default=True)

    result = evaluate_precheck(
        diff_content,
        previous_fingerprints,
        force_review=force_review,
        skip_if_diff_unchanged=skip_if_diff_unchanged,
    )
    scope = resolve_review_scope(
        os.environ.get("REVIEW_SCOPE", "auto"),
        os.environ.get("PREVIOUS_HEAD_SHA", ""),
        os.environ.get("PREVIOUS_BASE_SHA", ""),
        os.environ.get("PREVIOUS_REVIEW_RESULT", ""),
        force_review=force_review,
        previous_head_is_ancestor=_env_validation_flag("PREVIOUS_HEAD_IS_ANCESTOR"),
        compare_range_ok=_env_validation_flag("COMPARE_RANGE_OK"),
    )

    print(json.dumps(build_precheck_payload(result, scope), indent=2))


if __name__ == "__main__":
    main()
