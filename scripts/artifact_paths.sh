#!/usr/bin/env bash

# Generated files are written in the reviewed checkout. Refuse PR-controlled
# symlinks at those paths before the first redirect can follow one outside the
# workspace (notably on persistent self-hosted runners).
assert_safe_artifact_paths() {
  local path
  local -a artifact_paths=(
    pr.diff pr-object.json pr.json pr-body.txt changed-files.json precheck-result.json
    linked-issues.md urls.all.txt urls.txt
    version-hints.txt version-hints.truncated.txt ghcr-images.txt compare-shas.txt
    linked-sources.md manifest-context.md image-digest-context.md
    repo-impact.md repo-impact.truncated.md repo-history.md repo-history.truncated.md
    evidence-providers.md evidence-providers.json classification.json classification.compact.json
    standards-context.md standards-present.txt tool-harness.md tool-harness.json
    tool-harness.smart.md tool-harness.smart.json
    review-corpus.md review-corpus.truncated.md review-corpus.smart.truncated.md review-corpus.fallback.truncated.md
    pr.diff.smart.truncated pr-files.smart.truncated.json
    ai-request.json ai-response.json ai-output.json ai-output.primary.json ai-output.coverage-primary.json
    ai-request.fallback.json ai-response.fallback.json ai-response.primary.json
    ai-request.smart.json ai-response.smart.json
    verdict.txt analysis_engine.txt review-markdown.raw.md
    review-comment-markdown.raw.md review-comment.md review-comment-body.md
    review-body.md inline-comments.json
    findings.json review-request.json
    review-verdict-body.md inline-findings-body.md
    review-comments.json
    pr-files.json pr-files.raw.json files.json
    linked-issue.raw.json linked-issues.json linked-issues.merged.json
    linked-issue.filtered.json linked-issue-labels.json linked-issues.enriched.json
    linked-metadata-status.json linked-issue-fetch-failures.txt linear-fetch-failures.json
    linear-issues.json linear-issues.md
    repo-map.json repo-map.md repo-map.capped.md
    pr-thread.json pr-thread.md
    specialist-correctness.request.json specialist-security.request.json specialist-tests.request.json
    specialist-correctness.response.json specialist-security.response.json specialist-tests.response.json
    specialist-correctness.json specialist-security.json specialist-tests.json
    specialist-scout.request.json specialist-scout.response.json
    specialists.json
    specialists.phase.log
    ci-status.phase.log
    specialists.md specialist-leads-present.txt
    specialist-corpus.md
    terms.txt terms.all.txt
    change-anchors.json related-code.json related-code.md related-code.truncated.md
    review-corpus.body.md repo-impact.combined.txt
    requirement-ledger.json requirement-ledger.md requirement-ledger.section.md
    requirement-coverage.json requirement-ledger-present.txt
  )

  for path in "${artifact_paths[@]}"; do
    if [[ -L "$path" ]]; then
      echo "Refusing to write review artifact through symlink: $path" >&2
      return 1
    fi
  done
}
