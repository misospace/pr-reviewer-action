import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib import parse
import subprocess
import sys
from typing import Optional


def time_budget_deadline():
    """Return a monotonic deadline from IMAGE_DIGEST_BUDGET_SEC (0 disables)."""
    raw = os.getenv("IMAGE_DIGEST_BUDGET_SEC", "60").strip()
    try:
        budget = int(raw)
    except ValueError:
        budget = 60
    if budget <= 0:
        return None
    return time.monotonic() + budget


def deadline_exceeded(deadline):
    return deadline is not None and time.monotonic() >= deadline


def http_json(url, headers=None):
    cmd = [
        "curl",
        "-fsSL",
        "--connect-timeout",
        "20",
        "--max-time",
        "40",
        url,
    ]
    if headers:
        for key, value in headers.items():
            cmd.extend(["-H", f"{key}: {value}"])
    try:
        raw = subprocess.check_output(cmd)
        return json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as exc:
        raise RuntimeError(f"HTTP request failed: {exc}")


def registry_targets(repo: str):
    if repo.startswith("docker.io/"):
        repo_path = repo[len("docker.io/") :]
        token_url = (
            "https://auth.docker.io/token?service=registry.docker.io&scope="
            + parse.quote(f"repository:{repo_path}:pull", safe=":")
        )
        base_url = "https://registry-1.docker.io"
        return repo_path, token_url, base_url
    if repo.startswith("ghcr.io/"):
        repo_path = repo[len("ghcr.io/") :]
        token_url = "https://ghcr.io/token?scope=" + parse.quote(
            f"repository:{repo_path}:pull", safe=":"
        )
        base_url = "https://ghcr.io"
        return repo_path, token_url, base_url
    if repo.count("/") == 1 and not repo.startswith(
        ("quay.io/", "gcr.io/", "registry.k8s.io/")
    ):
        repo_path = repo
        token_url = (
            "https://auth.docker.io/token?service=registry.docker.io&scope="
            + parse.quote(f"repository:{repo_path}:pull", safe=":")
        )
        base_url = "https://registry-1.docker.io"
        return repo_path, token_url, base_url
    raise ValueError(f"unsupported registry for repo {repo}")


# Anonymous pull tokens are scoped per repository, so one token serves every
# digest/manifest/blob request for that repository. Cache them per token URL.
_TOKEN_CACHE: dict = {}
_TOKEN_LOCK = threading.Lock()


def get_registry_token(token_url: str):
    with _TOKEN_LOCK:
        if token_url in _TOKEN_CACHE:
            return _TOKEN_CACHE[token_url]
    token = http_json(token_url).get("token")
    with _TOKEN_LOCK:
        _TOKEN_CACHE[token_url] = token
    return token


def fetch_digest_metadata(repo: str, digest: str, deadline=None):
    result = {
        "repository": repo,
        "digest": digest,
        "mediaType": None,
        "configDigest": None,
        "created": None,
        "revision": None,
        "source": None,
        "version": None,
        "refName": None,
        "error": None,
        "indexManifests": None,
    }
    try:
        if deadline_exceeded(deadline):
            raise RuntimeError("image digest time budget exceeded")
        repo_path, token_url, base_url = registry_targets(repo)
        token = get_registry_token(token_url)
        if not token:
            raise RuntimeError("registry token unavailable")

        accept = ", ".join(
            [
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.v2+json",
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
            ]
        )
        manifest = http_json(
            f"{base_url}/v2/{repo_path}/manifests/{digest}",
            headers={"Authorization": f"Bearer {token}", "Accept": accept},
        )
        result["mediaType"] = manifest.get("mediaType")

        manifests = manifest.get("manifests")
        if isinstance(manifests, list):
            result["indexManifests"] = [
                {
                    "digest": manifest_entry.get("digest"),
                    "mediaType": manifest_entry.get("mediaType"),
                    "platform": manifest_entry.get("platform"),
                }
                for manifest_entry in manifests[:6]
            ]

        config_digest = (manifest.get("config") or {}).get("digest")
        result["configDigest"] = config_digest
        if config_digest:
            if deadline_exceeded(deadline):
                raise RuntimeError("image digest time budget exceeded")
            config = http_json(
                f"{base_url}/v2/{repo_path}/blobs/{config_digest}",
                headers={"Authorization": f"Bearer {token}"},
            )
            labels = (
                (config.get("config") or {}).get("Labels")
                or (config.get("container_config") or {}).get("Labels")
                or {}
            )
            result["created"] = config.get("created")
            result["revision"] = labels.get("org.opencontainers.image.revision")
            result["source"] = labels.get("org.opencontainers.image.source")
            result["version"] = labels.get("org.opencontainers.image.version")
            result["refName"] = labels.get("org.opencontainers.image.ref.name")
    except Exception as exc:
        result["error"] = str(exc)
    return result


def github_repo_from_source(source: Optional[str]):
    if not source:
        return None
    src = source.strip()
    match = re.search(
        r"github\.com[:/](?P<owner>[^/\s]+)/(?P<repo>[^/\s?#]+)", src, re.IGNORECASE
    )
    if match:
        owner = match.group("owner")
        repo = match.group("repo")
        if repo.endswith(".git"):
            repo = repo[:-4]
        return f"{owner}/{repo}"
    if re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", src):
        return src
    return None


def guess_repo_from_image(image_repo: str):
    if image_repo.startswith("docker.io/"):
        tail = image_repo[len("docker.io/") :]
    elif image_repo.startswith("ghcr.io/"):
        tail = image_repo[len("ghcr.io/") :]
    else:
        tail = image_repo
    parts = tail.split("/")
    if len(parts) >= 2:
        return f"{parts[0]}/{parts[1]}"
    return None


def fetch_github_compare(
    repo: Optional[str],
    old_rev: Optional[str],
    new_rev: Optional[str],
    deadline=None,
):
    result = {
        "repo": repo,
        "old_revision": old_rev,
        "new_revision": new_rev,
        "status": None,
        "ahead_by": None,
        "behind_by": None,
        "total_commits": None,
        "html_url": None,
        "commits": [],
        "files": [],
        "error": None,
        "repo_source": None,
    }
    if not repo:
        result["error"] = "repo unavailable"
        return result
    if not old_rev or not new_rev:
        result["error"] = "revision labels missing"
        return result
    if deadline_exceeded(deadline):
        result["error"] = "image digest time budget exceeded"
        return result
    try:
        data = http_json(
            f"https://api.github.com/repos/{repo}/compare/{old_rev}...{new_rev}",
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "pr-reviewer-action",
            },
        )
        result["status"] = data.get("status")
        result["ahead_by"] = data.get("ahead_by")
        result["behind_by"] = data.get("behind_by")
        result["total_commits"] = data.get("total_commits")
        result["html_url"] = data.get("html_url")
        result["commits"] = [
            {
                "sha": (commit.get("sha") or "")[:12],
                "message": (
                    (commit.get("commit") or {}).get("message") or ""
                ).splitlines()[0],
            }
            for commit in (data.get("commits") or [])[:15]
        ]
        result["files"] = [
            {
                "filename": changed_file.get("filename"),
                "status": changed_file.get("status"),
                "changes": changed_file.get("changes"),
            }
            for changed_file in (data.get("files") or [])[:20]
        ]
    except Exception as exc:
        result["error"] = str(exc)
    return result


def resolve_compare_repo(old_meta: dict, new_meta: dict, image_repo: str):
    """Pick the GitHub repo to compare revisions against.

    Returns (compare_repo, compare_repo_source, mismatch) where mismatch is
    an (old_repo, new_repo) tuple when the OCI source labels disagree.
    """
    old_repo = github_repo_from_source(old_meta.get("source"))
    new_repo = github_repo_from_source(new_meta.get("source"))
    compare_repo = None
    compare_repo_source = ""
    mismatch = None
    if old_repo and new_repo and old_repo == new_repo:
        compare_repo = old_repo
        compare_repo_source = "oci-source-label"
    elif old_repo and not new_repo:
        compare_repo = old_repo
        compare_repo_source = "oci-source-label-old"
    elif new_repo and not old_repo:
        compare_repo = new_repo
        compare_repo_source = "oci-source-label-new"
    elif old_repo and new_repo and old_repo != new_repo:
        mismatch = (old_repo, new_repo)
    if not compare_repo:
        guessed = guess_repo_from_image(image_repo)
        if guessed:
            compare_repo = guessed
            compare_repo_source = "image-repo-heuristic"
    return compare_repo, compare_repo_source, mismatch


def fetch_all_metadata(changes, deadline=None, max_workers=8):
    """Fetch digest metadata for every unique (repository, digest) in parallel."""
    pairs = sorted(
        {(change["repository"], change["old_digest"]) for change in changes}
        | {(change["repository"], change["new_digest"]) for change in changes}
    )
    if not pairs:
        return {}
    if len(pairs) == 1:
        repo, digest = pairs[0]
        return {pairs[0]: fetch_digest_metadata(repo, digest, deadline)}
    with ThreadPoolExecutor(max_workers=min(max_workers, len(pairs))) as executor:
        metas = list(
            executor.map(
                lambda pair: fetch_digest_metadata(pair[0], pair[1], deadline), pairs
            )
        )
    return dict(zip(pairs, metas))


def short(value):
    if not value:
        return "(unknown)"
    if isinstance(value, str) and len(value) > 120:
        return value[:117] + "..."
    return str(value)


def parse_diff(diff_text: str):
    current_file = ""
    current_repo = ""
    buckets = {}

    for raw in diff_text.splitlines():
        match_file = re.match(r"^diff --git a/(.+?) b/(.+)$", raw)
        if match_file:
            current_file = match_file.group(2)
            current_repo = ""
            continue

        match_repo = re.match(r'^[ +\-]?\s*repository:\s*[\'"]?([^\'"\s,]+)', raw)
        if match_repo:
            current_repo = match_repo.group(1)
            continue

        match_tag = re.match(r'^([+-])\s*tag:\s*[\'"]?([^\'"\s,]+)', raw)
        if match_tag:
            sign = match_tag.group(1)
            tag_val = match_tag.group(2)
            match_digest = re.match(r"([^@\s]+)@sha256:([0-9a-f]{64})", tag_val)
            if match_digest and current_repo:
                tag_base = match_digest.group(1)
                digest = f"sha256:{match_digest.group(2)}"
                key = (current_file, current_repo, tag_base)
                buckets.setdefault(key, {"old": [], "new": []})
                buckets[key]["old" if sign == "-" else "new"].append(digest)
            elif current_repo:
                key = (current_file, current_repo, tag_val)
                buckets.setdefault(key, {"old": [], "new": []})
            continue

        match_digest_only = re.match(
            r'^([+-])\s*digest:\s*[\'"]?(sha256:[0-9a-f]{64})', raw
        )
        if match_digest_only and current_repo:
            sign = match_digest_only.group(1)
            digest = match_digest_only.group(2)
            tag_base = "(digest-only)"
            key = (current_file, current_repo, tag_base)
            buckets.setdefault(key, {"old": [], "new": []})
            buckets[key]["old" if sign == "-" else "new"].append(digest)
            continue

        match_image = re.match(
            r'^([+-])\s*image:\s*[\'"]?([^\'"\s,]+@sha256:[0-9a-f]{64})', raw
        )
        if match_image:
            sign = match_image.group(1)
            image_ref = match_image.group(2)
            repo_and_tag, digest = image_ref.split("@", 1)
            digest = digest if digest.startswith("sha256:") else f"sha256:{digest}"
            repo = repo_and_tag
            tag_base = "(inline-image)"
            if ":" in repo_and_tag.rsplit("/", 1)[-1]:
                repo, tag_base = repo_and_tag.rsplit(":", 1)
            key = (current_file, repo, tag_base)
            buckets.setdefault(key, {"old": [], "new": []})
            buckets[key]["old" if sign == "-" else "new"].append(digest)

    changes = []
    for (file_path, repo, tag_base), values in buckets.items():
        pairs = min(len(values["old"]), len(values["new"]))
        for index in range(pairs):
            old = values["old"][index]
            new = values["new"][index]
            if old != new:
                changes.append(
                    {
                        "file": file_path,
                        "repository": repo,
                        "tag": tag_base,
                        "old_digest": old,
                        "new_digest": new,
                    }
                )
    return changes


def main():
    diff_path = Path("pr.diff.truncated")
    out_path = Path("image-digest-context.md")

    if not diff_path.exists():
        print("Error: pr.diff.truncated not found.")
        sys.exit(1)

    changes = parse_diff(diff_path.read_text(encoding="utf-8", errors="replace"))

    lines = []
    if not changes:
        lines.append("No image digest changes detected in PR diff.")
    else:
        deadline = time_budget_deadline()

        # Wave 1: digest metadata for all unique (repo, digest) pairs in
        # parallel (registry tokens are cached per repo inside).
        metas = fetch_all_metadata(changes, deadline)

        # Wave 2: revision compares in parallel, deduplicated by
        # (repo, old_rev, new_rev).
        prepared = []
        compare_keys = set()
        for change in changes:
            old_meta = metas[(change["repository"], change["old_digest"])]
            new_meta = metas[(change["repository"], change["new_digest"])]
            compare_repo, compare_repo_source, mismatch = resolve_compare_repo(
                old_meta, new_meta, change["repository"]
            )
            key = (compare_repo, old_meta.get("revision"), new_meta.get("revision"))
            compare_keys.add(key)
            prepared.append(
                (change, old_meta, new_meta, compare_repo, compare_repo_source, mismatch, key)
            )

        compare_keys = sorted(compare_keys, key=lambda k: tuple(str(p) for p in k))
        with ThreadPoolExecutor(max_workers=min(8, len(compare_keys))) as executor:
            compares = dict(
                zip(
                    compare_keys,
                    executor.map(
                        lambda key: fetch_github_compare(key[0], key[1], key[2], deadline),
                        compare_keys,
                    ),
                )
            )

        lines.append("# Image Digest Provenance Analysis")
        lines.append("")
        for idx, (
            change,
            old_meta,
            new_meta,
            compare_repo,
            compare_repo_source,
            mismatch,
            compare_key,
        ) in enumerate(prepared, start=1):
            lines.append(f"## Image {idx}: {change['repository']}")
            lines.append(f"- File: `{change['file']}`")
            lines.append(f"- Tag/variant: `{change['tag']}`")
            lines.append(f"- Old digest: `{change['old_digest']}`")
            lines.append(f"- New digest: `{change['new_digest']}`")
            lines.append(f"- Old revision: `{short(old_meta.get('revision'))}`")
            lines.append(f"- New revision: `{short(new_meta.get('revision'))}`")
            lines.append(f"- Old created: `{short(old_meta.get('created'))}`")
            lines.append(f"- New created: `{short(new_meta.get('created'))}`")
            lines.append(f"- Old source: `{short(old_meta.get('source'))}`")
            lines.append(f"- New source: `{short(new_meta.get('source'))}`")

            old_rev = old_meta.get("revision")
            new_rev = new_meta.get("revision")
            if old_rev and new_rev:
                if old_rev != new_rev:
                    lines.append(
                        "- Revision changed: **yes** (new code revision present)"
                    )
                else:
                    lines.append(
                        "- Revision changed: **no** (likely rebuild or republish of same source revision)"
                    )
            else:
                lines.append(
                    "- Revision changed: **unknown** (missing OCI revision labels)"
                )

            if mismatch:
                lines.append(
                    f"- Root repo mismatch between old/new labels: `{mismatch[0]}` vs `{mismatch[1]}`"
                )

            # Compare results are shared between changes with the same key, so
            # copy before stamping the per-change repo source.
            compare = dict(compares[compare_key])
            compare["repo_source"] = compare_repo_source or None

            lines.append(
                f"- Root repo for commit compare: `{short(compare_repo)}` (source: `{short(compare_repo_source or 'none')}`)"
            )
            if compare.get("html_url"):
                lines.append(f"- Commit compare URL: {compare['html_url']}")
            if compare.get("total_commits") is not None:
                lines.append(
                    f"- Compare summary: status={short(compare.get('status'))}, total_commits={short(compare.get('total_commits'))}, ahead_by={short(compare.get('ahead_by'))}, behind_by={short(compare.get('behind_by'))}"
                )
            elif compare.get("error"):
                lines.append(
                    f"- Compare lookup: **unavailable** ({short(compare.get('error'))})"
                )

            commits = compare.get("commits") or []
            if commits:
                lines.append("- Commits between old/new revision:")
                for commit in commits:
                    lines.append(
                        f"  - `{short(commit.get('sha'))}` {short(commit.get('message'))}"
                    )

            files = compare.get("files") or []
            if files:
                lines.append("- Changed files in root repo compare (first 20):")
                for changed_file in files:
                    lines.append(
                        f"  - `{short(changed_file.get('filename'))}` status={short(changed_file.get('status'))} changes={short(changed_file.get('changes'))}"
                    )

            # The bullets above already carry every field the reviewer needs;
            # the full metadata JSON dumps doubled this section's size for no
            # added signal. Keep only fetch errors, which the bullets omit.
            if old_meta.get("error"):
                lines.append(f"- Old digest metadata error: `{short(old_meta['error'])}`")
            if new_meta.get("error"):
                lines.append(f"- New digest metadata error: `{short(new_meta['error'])}`")
            lines.append("")

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
