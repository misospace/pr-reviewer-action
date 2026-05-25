# Security Model

This action reviews pull requests with an LLM and optional auxiliary tooling. The workflow may execute against untrusted pull request content, so all enrichment features are treated as high-risk by default.

## Threat Model

- Prompt injection inside PR content, linked issues, linked sources, or fetched metadata
- Tool request abuse (requesting sensitive files, broad API access, or untrusted hosts)
- Token and secret exposure in tool outputs
- Token and secret exposure in evidence-provider stdout/stderr
- Cross-repository pull requests attempting to run repo-defined scripts

## Controls

- Tool harness defaults to `off` (`tool_mode=off`)
- Tool harness treats corpus text as untrusted and does not follow corpus instructions
- Tool harness uses a strict read-only allowlist (`gh_api`, `read_file`, `web_fetch`, `git_grep`, and named-only `run_command`)
- `gh_api` is constrained to a same-repo path prefix and endpoint allowlist
- `gh_api` can optionally include specific upstream repos via explicit allowlist (`tool_allowed_gh_api_repos`) or all repos via `*` while preserving endpoint/path denylist checks
- Anthropic responses are parsed from `text` blocks only; non-text blocks such as `thinking` are not added to review output
- `read_file` is constrained to workspace-relative paths and blocks sensitive path patterns
- `web_fetch` is constrained to `allowed_source_hosts`
- `run_command` rejects raw shell text and permits only named read-only argv definitions (`git_status_short`, `git_diff_stat`, `git_diff_name_only`)
- Tool outputs are size-limited and pass through shared secret redaction before corpus inclusion
- Evidence provider stdout and stderr are passed through the same secret-redaction pipeline before being written to JSON summaries or markdown output
- Tool and evidence-provider enrichment are skipped on cross-repository PRs by default (`tool_enable_for_forks=false`, `evidence_enable_for_forks=false`)
- Evidence provider blocker findings can be deterministically enforced (`evidence_blocker_enforcement=true`)
- Tool harness failures can be made fail-closed with `tool_failure_enforcement=true` (planning failure or all tool requests failing)
- Tool harness can require minimum evidence breadth via `tool_min_successful_requests`

## Reserved Metadata Markers

The managed PR comment uses HTML comment markers to embed internal metadata for diff-skip and staleness detection:

- `<!-- ai-pr-review-fingerprint:<value> -->` — stable patch + config fingerprint used by the precheck to skip unchanged diffs.
- `<!-- ai-pr-review-sha:<sha> -->` — PR head SHA used to detect out-of-date reviews.

### Threat

A malicious PR could attempt prompt injection by embedding fake metadata markers in model-generated review markdown. If later parsing scans the entire managed comment body, such injected markers could interfere with precheck skip/precheck behavior (e.g., a fake fingerprint that matches an unrelated diff).

### Mitigation

The action uses a defense-in-depth approach:

1. **Publish-time stripping** — Before publishing a managed PR comment, `scripts/strip_metadata_markers.py` is invoked on the model-generated markdown to remove any matching reserved marker patterns. The trusted markers (sha + fingerprint) are then appended *after* stripping, so only genuine ones survive.
2. **Precheck reads first occurrence only** — The precheck parser uses `sed -n` with `head -n 1` to extract only the first occurrence of each marker from the comment body, providing a second layer of defense against any residual injection.

### Reserved patterns

The following patterns are treated as reserved and will be stripped from model output (case-insensitive matching, whitespace-tolerant):

```
<!-- ai-pr-review-fingerprint:<any-value> -->
<!-- ai-pr-review-sha:<any-sha> -->
```

Non-reserved HTML comments (e.g., `<!-- TODO: fix this -->`) are preserved.

See `scripts/strip_metadata_markers.py` for the implementation and `tests/test_strip_metadata_markers.py` for regression tests covering fake marker injection scenarios.

## Operational Guidance

- Keep GitHub token permissions minimal (`contents: read`, `pull-requests: write`)
- Use self-hosted runners only when required, and isolate them from sensitive networks
- Prefer `tool_mode=off` for public repositories unless you need tool planning
- Keep `allowed_source_hosts` narrow
- Treat evidence provider scripts as trusted code and review changes carefully
- Treat additions to the named tool command catalog as security-sensitive changes; keep them read-only and avoid shells, package managers, network clients, or repo mutation

## Known Limitations

- Secret redaction is heuristic and not guaranteed to catch all credential formats; it covers common patterns (GitHub tokens, AWS keys, bearer tokens, key=value secrets) but may miss novel or encoded credentials
- LLM planning can still make low-quality tool choices; controls restrict blast radius but do not guarantee relevance
- If you enable fork execution for tools/providers, you accept significantly higher risk
