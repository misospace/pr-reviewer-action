# Security Model

This action reviews pull requests with an LLM and optional auxiliary tooling. The workflow may execute against untrusted pull request content, so all enrichment features are treated as high-risk by default.

## Threat Model

- Prompt injection inside PR content, linked issues, linked sources, or fetched metadata
- Tool request abuse (requesting sensitive files, broad API access, or untrusted hosts)
- Token and secret exposure in tool outputs
- Cross-repository pull requests attempting to run repo-defined scripts

## Controls

- Tool harness defaults to `off` (`tool_mode=off`)
- Tool harness treats corpus text as untrusted and does not follow corpus instructions
- Tool harness uses a strict read-only allowlist (`gh_api`, `read_file`, `web_fetch`, `git_grep`)
- `gh_api` is constrained to a same-repo path prefix and endpoint allowlist
- `gh_api` can optionally include specific upstream repos via explicit allowlist (`tool_allowed_gh_api_repos`)
- `read_file` is constrained to workspace-relative paths and blocks sensitive path patterns
- `web_fetch` is constrained to `allowed_source_hosts`
- Tool outputs are size-limited and pass through basic secret redaction before corpus inclusion
- Tool and evidence-provider enrichment are skipped on cross-repository PRs by default (`tool_enable_for_forks=false`, `evidence_enable_for_forks=false`)
- Evidence provider blocker findings can be deterministically enforced (`evidence_blocker_enforcement=true`)
- Tool harness failures can be made fail-closed with `tool_failure_enforcement=true` (planning failure or all tool requests failing)
- Tool harness can require minimum evidence breadth via `tool_min_successful_requests`

## Operational Guidance

- Keep GitHub token permissions minimal (`contents: read`, `pull-requests: write`)
- Use self-hosted runners only when required, and isolate them from sensitive networks
- Prefer `tool_mode=off` for public repositories unless you need tool planning
- Keep `allowed_source_hosts` narrow
- Treat evidence provider scripts as trusted code and review changes carefully

## Known Limitations

- Secret redaction is heuristic and not guaranteed to catch all credential formats
- LLM planning can still make low-quality tool choices; controls restrict blast radius but do not guarantee relevance
- If you enable fork execution for tools/providers, you accept significantly higher risk
