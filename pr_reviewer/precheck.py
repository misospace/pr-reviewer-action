"""Pre-check logic extracted from scripts/check_review_needed.sh.

Provides pure-Python implementations of diff fingerprinting, incremental scope
detection, config hash computation, review skip evaluation, and metadata
transport — all previously implemented in 554 lines of bash.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class IncrementalScope:
    """Result of incremental scope detection."""

    scope: str = "full"  # "full", "incremental", or "none"
    changed_files: list[str] = field(default_factory=list)
    total_files: int = 0
    cached_fingerprint: str = ""
    current_fingerprint: str = ""


@dataclass
class ReviewMetadata:
    """Review metadata written to the output JSON file."""

    review_needed: bool = True
    skip_reason: str = ""
    diff_fingerprint: str = ""
    config_hash: str = ""
    incremental_scope: str = "full"
    changed_files_count: int = 0
    total_files_count: int = 0
    base_sha: str = ""
    head_sha: str = ""
    pr_number: int = 0
    diff_stats: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Config hash
# ---------------------------------------------------------------------------

def compute_config_hash(config_files: list[str]) -> str:
    """Compute SHA-256 hash of config file contents.

    Args:
        config_files: List of file paths to include in the hash.

    Returns:
        Hex digest string, or empty string if no files exist.
    """
    existing = sorted(p for p in config_files if Path(p).is_file())
    if not existing:
        logger.debug("No config files found; returning empty hash")
        return ""

    h = hashlib.sha256()
    for filepath in existing:
        try:
            content = Path(filepath).read_bytes()
            h.update(content)
        except OSError as exc:
            logger.warning("Could not read config file %s: %s", filepath, exc)

    return h.hexdigest()


# ---------------------------------------------------------------------------
# Diff fingerprint
# ---------------------------------------------------------------------------

def compute_diff_fingerprint(diff_content: str) -> str:
    """Compute SHA-256 hash of the diff content.

    Args:
        diff_content: The raw diff text.

    Returns:
        Hex digest string, or empty string for empty input.
    """
    if not diff_content or not diff_content.strip():
        return ""
    return hashlib.sha256(diff_content.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Incremental scope detection
# ---------------------------------------------------------------------------

def get_incremental_scope(
    current_fingerprint: str,
    cache_dir: str,
) -> IncrementalScope:
    """Determine review scope from cached fingerprint.

    Compares the current diff fingerprint against a previously cached one.
    If they match, only files that changed since the last review are in scope.

    Args:
        current_fingerprint: SHA-256 of the current diff.
        cache_dir: Directory containing cached review data.

    Returns:
        IncrementalScope describing what needs to be reviewed.
    """
    if not current_fingerprint:
        return IncrementalScope(scope="none")

    cache_path = Path(cache_dir)
    fingerprint_file = cache_path / "fingerprint"
    files_file = cache_path / "files.json"

    # No cache exists — full review needed
    if not fingerprint_file.is_file():
        logger.debug("No cached fingerprint found; full scope")
        return IncrementalScope(
            scope="full",
            current_fingerprint=current_fingerprint,
        )

    try:
        cached_fp = fingerprint_file.read_text().strip()
    except OSError as exc:
        logger.warning("Could not read cached fingerprint: %s", exc)
        return IncrementalScope(
            scope="full",
            current_fingerprint=current_fingerprint,
        )

    # Fingerprints match — incremental review possible
    if cached_fp == current_fingerprint:
        changed_files = []
        total_files = 0
        if files_file.is_file():
            try:
                data = json.loads(files_file.read_text())
                changed_files = data.get("changed_files", [])
                total_files = data.get("total_files", 0)
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("Could not read cached files: %s", exc)

        return IncrementalScope(
            scope="incremental",
            changed_files=changed_files,
            total_files=total_files,
            cached_fingerprint=cached_fp,
            current_fingerprint=current_fingerprint,
        )

    # Fingerprints differ — full review needed
    logger.debug("Fingerprint changed; full scope")
    return IncrementalScope(
        scope="full",
        cached_fingerprint=cached_fp,
        current_fingerprint=current_fingerprint,
    )


# ---------------------------------------------------------------------------
# Skip evaluation
# ---------------------------------------------------------------------------

def should_skip_review(
    diff_content: str,
    skip_labels: list[str],
    pr_labels: list[str],
    skip_paths: list[str],
    auto_merge_label: str = "auto-merge",
) -> tuple[bool, str]:
    """Evaluate whether the review should be skipped.

    Args:
        diff_content: The raw diff text (empty means no changes).
        skip_labels: Labels that trigger a skip when present on the PR.
        pr_labels: Labels currently applied to the PR.
        skip_paths: File paths that, if they are the only changes, trigger skip.
        auto_merge_label: Label name indicating auto-merge (triggers skip).

    Returns:
        Tuple of (should_skip, reason).
    """
    # Empty diff — nothing to review
    if not diff_content or not diff_content.strip():
        return True, "empty_diff"

    # Check for skip labels
    pr_labels_lower = [l.lower() for l in pr_labels]
    for label in skip_labels:
        if label.lower() in pr_labels_lower:
            return True, f"skip_label:{label}"

    # Check for auto-merge label
    if auto_merge_label.lower() in pr_labels_lower:
        return True, "auto_merge"

    # Check skip paths — only skip if ALL changed files are in skip_paths
    changed_files = _extract_changed_files(diff_content)
    if changed_files and skip_paths:
        all_skippable = all(
            _matches_skip_path(f, skip_paths)
            for f in changed_files
        )
        if all_skippable:
            return True, "skip_paths"

    return False, ""


def _extract_changed_files(diff_content: str) -> list[str]:
    """Extract changed file paths from a unified diff.

    Parses lines starting with 'a/' or 'b/' in the diff header.
    """
    files = set()
    for line in diff_content.splitlines():
        if line.startswith("diff --git"):
            # Extract file paths from "diff --git a/path b/path"
            parts = line.split()
            for part in parts:
                if (part.startswith("a/") and not part.startswith("a/dev/")) or \
                   (part.startswith("b/") and not part.startswith("b/dev/")):
                    files.add(part[2:])
        elif line.startswith(("--- a/", "+++ b/")):
            filepath = line.split("/", 1)[1] if "/" in line else ""
            if filepath:
                files.add(filepath)
    return sorted(files)


def _matches_skip_path(filepath: str, skip_patterns: list[str]) -> bool:
    """Check if a file path matches any skip pattern.

    Patterns can be exact paths or directory prefixes (ending with /).
    """
    for pattern in skip_patterns:
        if pattern.endswith("/"):
            if filepath.startswith(pattern):
                return True
        else:
            if filepath == pattern:
                return True
    return False


# ---------------------------------------------------------------------------
# Diff stats
# ---------------------------------------------------------------------------

def compute_diff_stats(diff_content: str) -> dict:
    """Compute basic statistics from diff content.

    Returns a dict with keys: files_changed, insertions, deletions.
    """
    if not diff_content or not diff_content.strip():
        return {"files_changed": 0, "insertions": 0, "deletions": 0}

    files_changed = 0
    insertions = 0
    deletions = 0

    for line in diff_content.splitlines():
        if line.startswith("diff --git"):
            files_changed += 1
        elif line.startswith(("---", "+++")):
            continue
        elif line.startswith("@@"):
            # Parse @@ -old_start,old_count +new_start,new_count @@
            parts = line.split()
            for part in parts:
                if part.startswith("-") and "," in part:
                    try:
                        count = int(part.split(",")[1])
                        deletions += count
                    except (ValueError, IndexError):
                        pass
                elif part.startswith("+") and "," in part:
                    try:
                        count = int(part.split(",")[1])
                        insertions += count
                    except (ValueError, IndexError):
                        pass

    return {
        "files_changed": files_changed,
        "insertions": insertions,
        "deletions": deletions,
    }


# ---------------------------------------------------------------------------
# Metadata I/O
# ---------------------------------------------------------------------------

def write_review_metadata(metadata: ReviewMetadata, output_path: str) -> None:
    """Write review metadata to a JSON file.

    Args:
        metadata: The metadata to serialize.
        output_path: Path to the output JSON file.
    """
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    data = asdict(metadata)
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    logger.info("Wrote review metadata to %s", output_path)


def read_review_metadata(input_path: str) -> ReviewMetadata | None:
    """Read review metadata from a JSON file.

    Args:
        input_path: Path to the metadata JSON file.

    Returns:
        ReviewMetadata instance, or None if file doesn't exist.
    """
    path = Path(input_path)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return ReviewMetadata(**data)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning("Could not read metadata from %s: %s", input_path, exc)
        return None


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------

def save_cache(
    fingerprint: str,
    changed_files: list[str],
    total_files: int,
    cache_dir: str,
) -> None:
    """Save review cache for incremental scope detection.

    Args:
        fingerprint: Current diff fingerprint.
        changed_files: List of changed file paths.
        total_files: Total number of files in the repo.
        cache_dir: Directory to store cache files.
    """
    cache_path = Path(cache_dir)
    cache_path.mkdir(parents=True, exist_ok=True)

    (cache_path / "fingerprint").write_text(fingerprint + "\n", encoding="utf-8")
    (cache_path / "files.json").write_text(
        json.dumps({"changed_files": changed_files, "total_files": total_files}, indent=2) + "\n",
        encoding="utf-8",
    )
    logger.info("Saved cache to %s", cache_dir)


def clear_cache(cache_dir: str) -> None:
    """Remove all files in the cache directory.

    Args:
        cache_dir: Directory containing cache files.
    """
    cache_path = Path(cache_dir)
    if cache_path.is_dir():
        for child in cache_path.iterdir():
            child.unlink(missing_ok=True)
        logger.info("Cleared cache at %s", cache_dir)


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------

def run_precheck(
    diff_content: str,
    config_files: list[str],
    cache_dir: str,
    skip_labels: list[str],
    pr_labels: list[str],
    skip_paths: list[str],
    output_path: str,
    base_sha: str = "",
    head_sha: str = "",
    pr_number: int = 0,
) -> ReviewMetadata:
    """Run the full pre-check pipeline.

    This is the main entry point that replaces the bash ``main()`` function
    in check_review_needed.sh.

    Args:
        diff_content: Raw unified diff text.
        config_files: List of config file paths to hash.
        cache_dir: Directory for incremental review cache.
        skip_labels: Labels that trigger a skip.
        pr_labels: Labels on the current PR.
        skip_paths: Paths that trigger a skip when they are the only changes.
        output_path: Where to write the metadata JSON.
        base_sha: Base commit SHA.
        head_sha: Head commit SHA.
        pr_number: Pull request number.

    Returns:
        ReviewMetadata with all computed values.
    """
    # Step 1: Compute fingerprints and hashes
    diff_fp = compute_diff_fingerprint(diff_content)
    config_hash = compute_config_hash(config_files)

    # Step 2: Check skip conditions
    skip, reason = should_skip_review(
        diff_content, skip_labels, pr_labels, skip_paths
    )

    if skip:
        metadata = ReviewMetadata(
            review_needed=False,
            skip_reason=reason,
            diff_fingerprint=diff_fp,
            config_hash=config_hash,
            base_sha=base_sha,
            head_sha=head_sha,
            pr_number=pr_number,
        )
        write_review_metadata(metadata, output_path)
        return metadata

    # Step 3: Determine scope
    scope_result = get_incremental_scope(diff_fp, cache_dir)

    # Step 4: Compute diff stats
    stats = compute_diff_stats(diff_content)

    # Step 5: Build metadata
    changed_files = _extract_changed_files(diff_content)
    metadata = ReviewMetadata(
        review_needed=True,
        diff_fingerprint=diff_fp,
        config_hash=config_hash,
        incremental_scope=scope_result.scope,
        changed_files_count=len(changed_files),
        total_files_count=scope_result.total_files or len(changed_files),
        base_sha=base_sha,
        head_sha=head_sha,
        pr_number=pr_number,
        diff_stats=stats,
    )

    # Step 6: Save cache for future incremental reviews
    if scope_result.scope == "full":
        save_cache(diff_fp, changed_files, len(changed_files), cache_dir)

    write_review_metadata(metadata, output_path)
    return metadata


# ---------------------------------------------------------------------------
# CLI entry point (for shell wrapper)
# ---------------------------------------------------------------------------

def main() -> int:
    """CLI entry point called by the shell wrapper.

    Reads configuration from environment variables and runs the precheck.

    Returns:
        Exit code (0 = review needed, 1 = skip, 2 = error).
    """
    diff_content = os.environ.get("DIFF_CONTENT", "")
    config_files_str = os.environ.get("CONFIG_FILES", "")
    cache_dir = os.environ.get("CACHE_DIR", ".pr_reviewer_cache")
    skip_labels_str = os.environ.get("SKIP_LABELS", "skip-review,automerge")
    pr_labels_str = os.environ.get("PR_LABELS", "")
    skip_paths_str = os.environ.get("SKIP_PATHS", "")
    output_path = os.environ.get("METADATA_OUTPUT", ".pr_reviewer_metadata.json")
    base_sha = os.environ.get("BASE_SHA", "")
    head_sha = os.environ.get("HEAD_SHA", "")
    pr_number = int(os.environ.get("PR_NUMBER", "0"))

    config_files = [f for f in config_files_str.split(",") if f]
    skip_labels = [l for l in skip_labels_str.split(",") if l]
    pr_labels = [l for l in pr_labels_str.split(",") if l]
    skip_paths = [p for p in skip_paths_str.split(",") if p]

    try:
        metadata = run_precheck(
            diff_content=diff_content,
            config_files=config_files,
            cache_dir=cache_dir,
            skip_labels=skip_labels,
            pr_labels=pr_labels,
            skip_paths=skip_paths,
            output_path=output_path,
            base_sha=base_sha,
            head_sha=head_sha,
            pr_number=pr_number,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("Precheck failed: %s", exc)
        return 2

    # Export metadata as environment variables for the shell wrapper
    os.environ["REVIEW_NEEDED"] = str(metadata.review_needed).lower()
    os.environ["SKIP_REASON"] = metadata.skip_reason
    os.environ["DIFF_FINGERPRINT"] = metadata.diff_fingerprint
    os.environ["CONFIG_HASH"] = metadata.config_hash
    os.environ["INCREMENTAL_SCOPE"] = metadata.incremental_scope
    os.environ["CHANGED_FILES_COUNT"] = str(metadata.changed_files_count)
    os.environ["TOTAL_FILES_COUNT"] = str(metadata.total_files_count)

    if not metadata.review_needed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
