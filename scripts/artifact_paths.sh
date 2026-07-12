#!/usr/bin/env bash

# Generated files are written in the reviewed checkout. Refuse PR-controlled
# symlinks at those paths before the first redirect can follow one outside the
# workspace (notably on persistent self-hosted runners).
assert_safe_artifact_paths() {
  local path
  local -a artifact_paths=(
    pr.diff pr-object.json pr.json pr-body.txt changed-files.json
    previous-review-meta.json previous-findings.json previous-evidence.json
    incremental.diff linked-issues.md urls.all.txt urls.txt
    version-hints.txt version-hints.truncated.txt ghcr-images.txt compare-shas.txt
    linked-sources.md manifest-context.md image-digest-context.md
    repo-impact.md repo-impact.truncated.md repo-history.md repo-history.truncated.md
    evidence-providers.md evidence-providers.json classification.json
    standards-context.md tool-harness.md tool-harness.json
    review-corpus.md review-corpus.truncated.md review-corpus.fallback.truncated.md
    ai-request.json ai-response.json ai-output.json ai-output.primary.json
    ai-request.fallback.json ai-response.fallback.json
    verdict.txt analysis_engine.txt review-markdown.raw.md
    review-comment-markdown.raw.md review-comment.md review-comment-body.md
    review-body.md inline-comments.json
  )

  for path in "${artifact_paths[@]}"; do
    if [[ -L "$path" ]]; then
      echo "Refusing to write review artifact through symlink: $path" >&2
      return 1
    fi
  done
}
