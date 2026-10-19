# AI PR Review Rules: pr-reviewer-action

Repository-specific review guidance now lives in the trusted-base skill
[.agents/skills/action-runtime-review/SKILL.md](../.agents/skills/action-runtime-review/SKILL.md).

The native reviewer catalogs .agents/skills/*/SKILL.md when
repository-skills: "true" is enabled. Read the skill when a change touches
the action's public contract, transport, model parsing, publishing, URL fetching,
tool harness, evidence providers, credentials, or backward compatibility.
AGENTS.md remains the higher-level product and security contract.
