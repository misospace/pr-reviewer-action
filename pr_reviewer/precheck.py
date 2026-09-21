"""Pre-check logic extracted from scripts/check_review_needed.sh.

Core functions for diff fingerprinting, config hash computation, and
review metadata transport.

These replace the shell implementations with testable Python code.

CLI contract (``python3 -m pr_reviewer.precheck``)
---------------------------------------------------

The module entry point (``main``) reads its inputs from the environment
and writes a single JSON object to stdout with the keys ``should_review``,
``skip_reason``, ``diff_fingerprint``, ``broad_fingerprint`` and
``config_hash``. It is the decision half of the action precheck; the shell
wrapper performs platform I/O (diff/PR/comment fetches) and forwards the
result to ``$GITHUB_OUTPUT``. In v3 every non-skipped review is a full
review of the current PR, so the payload carries no scope fields.

Environment inputs:

- ``PRECHECK_DIFF_PATH`` / ``DIFF_PATH``: path to the PR diff file
  (``PRECHECK_DIFF_PATH`` wins; ``DIFF_CONTENT`` is the fallback when
  neither file is set).
- ``PREV_FINGERPRINTS``: comma-separated fingerprints stored in previous
  managed reviews (``PREV_FP_PATH`` file with ``diff-fp:`` lines is also
  honoured).
- ``FORCE_REVIEW``: ``true`` bypasses the diff-unchanged guard.
- ``SKIP_IF_DIFF_UNCHANGED``: ``true`` (default) enables the guard.

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
from dataclasses import dataclass
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


class ReviewDecision(str, Enum):
    """Possible outcomes of the review-needed decision."""

    REVIEW_NEEDED = "review_needed"
    SKIP_NO_CHANGES = "skip_no_changes"
    SKIP_ALREADY_REVIEWED = "skip_already_reviewed"


@dataclass
class PrecheckResult:
    """Structured result of the pre-check evaluation."""

    decision: ReviewDecision
    diff_fingerprint: str = ""
    config_hash: str = ""
    broad_fingerprint: str = ""
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
    "ESCALATE_ON_RISK_FLAGS",
    "SYSTEM_PROMPT",
    "STANDARDS_FILE_CANDIDATES",
    "LINEAR_API_KEY_CONFIGURED",
    "LINEAR_ISSUE_PREFIXES",
    "LINEAR_ISSUE_TIMEOUT_SEC",
    "LINEAR_ENABLE_FOR_FORKS",
    "EVIDENCE_PROVIDER_TIMEOUT_SEC",
    "EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES",
    "SARIF_FILES",
    "SARIF_MAX_FINDINGS",
    "EVIDENCE_BLOCKER_ENFORCEMENT",
    "EVIDENCE_ENABLE_FOR_FORKS",
    "TOOL_MODE",
    "TOOL_MAX_REQUESTS",
    "TOOL_MAX_ROUNDS",
    # #540: renamed from TOOL_PLANNING_* (the plan_execute planner they were
    # named for was removed in #304). The legacy names stay in the allowlist
    # for one release so a workflow still passing them keeps a stable
    # fingerprint (removed in v3.0.0).
    "TOOL_TURN_TIMEOUT_SEC",
    "TOOL_CORPUS_MAX_BYTES",
    "TOOL_MAX_TOKENS_PER_TURN",
    "TOOL_PLANNING_TIMEOUT_SEC",
    "TOOL_PLANNING_MAX_CONTEXT_BYTES",
    "TOOL_PLANNING_MAX_TOKENS",
    "TOOL_MAX_RESPONSE_BYTES",
    "TOOL_ALLOWED_GH_API_REPOS",
    "TOOL_REQUEST_TIMEOUT_SEC",
    "TOOL_FAILURE_ENFORCEMENT",
    "TOOL_MIN_SUCCESSFUL_REQUESTS",
    "TOOL_ENABLE_FOR_FORKS",
    "RELATED_CODE_CONTEXT",
    "RELATED_CODE_MAX_BYTES",
    "REPO_MAP_CONTEXT",
    "REPO_MAP_MAX_BYTES",
    "PR_THREAD_CONTEXT",
    "PR_THREAD_MAX_BYTES",
    # #608: deep-review toggle. Enabling it changes what runs over the corpus,
    # so a toggle must invalidate a stale comment. The phase deadline is
    # fingerprinted too: a shorter deadline can turn advisory leads into
    # recorded timeouts, which changes the run.
    "DEEP_REVIEW",
    "DEEP_REVIEW_TIMEOUT_SEC",
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

    # Step 5: Default — review needed
    return PrecheckResult(
        decision=ReviewDecision.REVIEW_NEEDED,
        diff_fingerprint=diff_fp,
        config_hash=config_hash,
        broad_fingerprint=broad_fp,
        reason="New changes detected",
    )


# ---------------------------------------------------------------------------
# Action precheck contract (decision mapping, payload)
# ---------------------------------------------------------------------------


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
    scope here: in v3 every non-skipped review is a full review of the
    current PR.

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
    """Map a ReviewDecision to the action's (should_review, skip_reason)."""
    if decision is ReviewDecision.SKIP_ALREADY_REVIEWED:
        return False, "diff-unchanged"
    if decision is ReviewDecision.SKIP_NO_CHANGES:
        return False, "no-changes"
    return True, ""


def build_precheck_payload(result: PrecheckResult) -> dict:
    """Assemble the JSON payload the CLI writes to stdout.

    In v3 the payload carries no scope fields: every non-skipped review
    is a full review of the current PR.
    """
    should_review, skip_reason = _decision_to_outputs(result.decision)
    return {
        "should_review": should_review,
        "skip_reason": skip_reason,
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
    with the keys ``should_review``, ``skip_reason``, ``diff_fingerprint``,
    ``broad_fingerprint`` and ``config_hash``.
    Designed to be called from a thin shell wrapper; library callers use
    :func:`evaluate_precheck` directly.
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

    print(json.dumps(build_precheck_payload(result), indent=2))


if __name__ == "__main__":
    main()
