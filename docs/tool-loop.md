# The native tool loop (`tool-mode: native_loop`)

`native_loop` is the default (and only non-`off`) value of `tool-mode`. The
reviewing model uses its provider's native tool-calling API (OpenAI
`tool_calls` / Anthropic `tool_use`) to gather read-only evidence — file
contents, git history, GitHub metadata, allowlisted web pages — before the
verdict turn.

## How the loop works

1. The action sends the planning corpus plus the tool schemas in the first
   user turn, with the repo name, the `gh_api`/`repo_contents` repo allowlist,
   the `web_fetch` host allowlist, and the current request/round budget.
2. The model holds the conversation: it issues a tool call, sees the result
   appended as a real tool-result turn, and decides the next call from what
   came back. A chain like "read the machineconfig → extract the platform
   version → fetch that version's published compatibility matrix" is
   expressed natively — each hop is conditioned on the previous one's content,
   not guessed up front.
3. The loop stops when the model replies with no further tool calls, a budget
   is exhausted, or the wall clock elapses (see **Stop reasons** below).
4. The verdict turn reuses the same conversation: it swaps in the reviewer
   system prompt, re-injects the full corpus (the loop only saw the compact
   planning context), and asks for the final JSON verdict. Corpus sections
   already sent verbatim in the first planning turn are replaced with a
   one-line placeholder to avoid re-sending duplicate content.

Malformed tool arguments and duplicate calls are answered with a corrective
tool-result the model can react to (duplicates don't cost budget); a
transport error mid-loop keeps whatever evidence was already gathered.

Turns stream by default (`ai-stream`), so a long thinking-model turn doesn't
time out behind a short-idle proxy. A streamed turn that can't be reassembled
(truncated/garbled SSE, or a 200 response carrying an `error` body) is
retried once non-streamed before the loop gives up on that turn.

## Tools

| Tool | Reads | Gated by |
| --- | --- | --- |
| `read_file` | A file in the checked-out workspace, optionally a line window (`offset`/`limit`). Path traversal, symlink escapes, and sensitive files (`.env`, `.pem`, `credentials`, `id_rsa`, `.kube/config`, …) are blocked. Output capped at the per-result limit (12 KB by default; see [Context limits](#context-limits)). | workspace path guard; tracked-files filter (see below) |
| `find_files` | Repository file paths (not contents) matching a glob against the relative path or basename, e.g. `*config*`, `*.toml`, `*/route.ts`. Sorted, capped at `max_results` (default 100, max 300). Never descends into `.git` or follows symlinks. | tracked-files filter |
| `list_tree` | Repository entries (`{path, type}`, no contents) bounded by `depth` (default 2, clamped 1..4) and `max_entries` (default 200, max 500). A file path returns a one-row listing. | tracked-files filter |
| `git_grep` | Matching lines (`path:lineno:content`) via `git grep -E`, optionally scoped to a `path` subtree, capped at `max_results` (1..200, default 60). An invalid regex is retried as a fixed string. | workspace path guard; tracked-files filter |
| `git_log` | Recent commit history (hash, date, author, subject), optionally scoped to a path; no file content. Capped at `max_count` (1..100, default 20). | workspace path guard |
| `git_blame` | Line-level authorship for a tracked file, optionally a `start`/`end` range. | workspace path guard; sensitive-file block |
| `run_command` | stdout/stderr of one named command from a fixed allowlist — `git_status_short`, `git_diff_stat`, `git_diff_name_only`. The model supplies only the name; no shell text is ever accepted. | fixed argv catalog |
| `gh_api` | Structured JSON from a read-only GitHub REST path (`repos/`, `issues/`, `search/`, `releases/`, `git/` prefixes only), for an allowlisted repo. | `tool-allowed-gh-api-repos`; endpoint allowlist; deny-listed paths (`/actions/secrets`, `/dependabot/secrets`, `/environments/`, `/dispatches`) |
| `repo_contents` | Source files or directory listings from an explicitly allowlisted related GitHub repository (file reads go through the blob API; directories return sorted name/type rows capped at `max_entries`, default 200, max 500). Unsupported on Forgejo. | same allowlist as `gh_api` |
| `web_fetch` | A URL on an allowlisted host; output capped at ~10 KB of decoded text. Redirects are followed up to 10 hops, each re-validated against the host allowlist. | `allowed-source-hosts` |
| `web_search` | A ranked `{title, url, snippet}` list from the configured search endpoint — advertised only when `search-url` is set. The model supplies only the query; the host is fixed by the input. | `search-url` |

`tool-allowed-gh-api-repos` is a comma-separated `owner/repo` list (`*` allows
any repo the path allowlist still permits); empty means the current repo
only. Every result — file reads, grep matches, blame, API JSON, web content —
passes secret redaction and a byte cap (`tool-max-response-bytes`) before it
can reach the conversation.

**Tracked-files filter**: inside a git checkout, `read_file`, `find_files`,
`list_tree`, and `git_grep` only see committed files (`git ls-files
--cached`). The review pipeline writes its own scratch artifacts into the
checkout, and a model that lists or reads those spends evidence budget on
text it already has. Outside a git checkout the filter is inert.

### MCP servers

`tool-mcp-servers` is an optional allowlist of read-only MCP servers, as a
newline/comma list of `name=url` (e.g. `konflate=https://konflate.example/mcp`).
Only host-bearing `http(s)` URLs are accepted. A server's tools are advertised
only when the tool name begins with an allowlisted read verb (`list`, `get`,
`read`, `search`, `fetch`, `describe`, `show`, `find`, `lookup`, `query`,
`head`, `stat`, `summary`, `diff`, `status`, `view`) — a write-shaped verb
(`create`/`update`/`delete`/`set`/`run`/`exec`/…) is refused both at
advertise time and again at call time, even if the server lists it.
`tool-mcp-name-prefixes` strips a known workload prefix (e.g. a ToolHive
`{workload}_` prefix) before that verb check. Advertised tools are namespaced
as `mcp__<server>__<tool>` so an MCP name can never shadow a built-in tool.
`tool-mcp-token` is sent as a bearer token to every configured server. A
server that fails to connect is logged and skipped — it never breaks the
loop. Empty `tool-mcp-servers` (the default) disables MCP entirely.

## Budgets

### Tool-call budget (tier defaults, size scaling)

`tool-max-requests` bounds the total tool calls the harness executes. Left
empty (the default), the effective budget is **tier-aware** by review route:

| Route | Tier default |
| --- | --- |
| primary | 24 |
| smart | 32 |
| escalated (smart under post-review escalation) | 40 |

Hard ceiling in all cases: 50. `primary-tool-max-requests` /
`smart-tool-max-requests` override the budget for their own route only;
`tool-max-requests` overrides every route; any explicit value is bounded to
1..50.

When no explicit override wins, the default is further scaled by PR size
(#810): one request per 4 changed files, one per 400 changed lines, and 2
requests per specialist lead (each lead is a hypothesis that needs its own
verification calls) — floored at the route's tier default (a small PR keeps
exactly the pre-#810 budget) and capped at the hard ceiling of 50. Size
signals come from `pr.json`/`pr-files.json` and the per-role specialist lead
artifacts already in the harness workspace; a workspace without size signals
just uses the tier default.

### Round cap

A round is one model turn. `tool-max-rounds` left empty (the default)
resolves to 4, but the **effective** round cap scales with the resolved
call budget (#895): one round per tool call, so a model that reads one file
per turn can still spend the whole size-scaled or tiered call budget. That
scaled cap is bounded at 32 rounds regardless of how large the call budget
grows — the wall clock is the real bound past that point.

Setting `tool-max-rounds` explicitly opts back out of that scaling: the loop
then allows up to `2 × tool-max-rounds`, capped at 12 — the pre-#895
behavior, which leaves room for one-call-per-turn chains and repair turns
without tracking the call budget.

### Wall clock and per-turn timeouts

- `tool-loop-wall-clock-sec` (default 600) bounds the whole exchange — every
  model round-trip plus tool execution.
- `tool-turn-timeout-sec` (default 180) bounds each individual model turn. On
  the smart/escalated tier this is also clamped to whatever remains of the
  wall-clock deadline, so a slow turn can't single-handedly blow past it.
- `tool-request-timeout-sec` (default 20) bounds each individual tool
  execution (file read, grep, API call, fetch).

### Context limits

Three limits bound what the loop holds. Without a declared context window
they are fixed; declare one per tier (`primary-model-context-tokens`,
`smart-model-context-tokens`, or `model-context-tokens` for both) and they
scale with it:

| Limit | No window declared | Window declared | Input override |
| --- | --- | --- | --- |
| Conversation budget (compaction threshold) | 24,000 tokens | ~25% of the window, 24k–250k tokens | — |
| First-turn corpus | 50 KB | ~15% of the window, 50 KB–600 KB | `tool-corpus-max-bytes` |
| Each tool result | 12 KB | ~2% of the window, 12 KB–64 KB | `tool-max-response-bytes` |

For a 1M-token model that is 250k tokens / 450 KB / 60 KB; for 262k it is
65k tokens / 118 KB / 16 KB. Explicit byte inputs always win. The marker's
`context_budget` and `context_peak` show the budget a run used and how much
of it the conversation actually reached (see [Telemetry](telemetry.md)).

### Context compaction

When the conversation outgrows its context budget, the oldest tool
results are compacted before the next turn so the model's view stays within
budget while the newest results stay verbatim:

- Default: blunt truncation of the oldest results.
- `tool-loop-summarize: "true"`: the oldest results are folded into a
  model-generated evidence digest (versions, paths, URLs, findings) instead,
  at the cost of one extra model call per compaction
  (`tool-loop-summarize-max-tokens` bounds that call, default 512). If
  summarization frees nothing or fails, the loop falls back to truncation —
  truncation is always the backstop.

Every turn after the first states the remaining request/round budget
in-conversation. Once two or fewer requests remain, the note switches from
status to direction: stop broad exploration and spend what's left on
unresolved blocker hypotheses and verdict evidence.

## Stop reasons and partial coverage

| Stop reason | Meaning |
| --- | --- |
| `model-stopped` | The model replied with no further tool calls after having issued at least one — a deliberate, voluntary stop. |
| `no-tool-calls` | The model never issued a tool call at all (see **Degrading to corpus-only** below). |
| `max-rounds` | The round cap (above) was reached before the model stopped on its own. |
| `tool-call-budget-exhausted` | The resolved tool-call budget was spent. |
| `wall-clock-exceeded` | `tool-loop-wall-clock-sec` elapsed. |
| `request-error` | A transport error ended the loop mid-exchange. |

`max-rounds`, `tool-call-budget-exhausted`, and `wall-clock-exceeded` are
budget stops — the investigation was cut off, not finished by choice. On any
budget stop, the harness folds its own call log against the changed-file
manifest and the specialist-lead artifacts to compute which changed files
were never read and which specialist leads were never resolved. If that gap
is non-empty, the published review carries a **Partial Coverage Notice**
listing the unread files and unresolved leads (capped at 20 each, with a
count for the rest), closing with "Absence of findings in the unread paths
is not evidence they are safe." The metadata marker's `coverage: "partial"`
and `coverage_stop_reason` fields record the same gap — see
[`docs/telemetry.md`](telemetry.md).

**Partial coverage never approves.** `review-result: partial` means the
review's own coverage is incomplete; gate merges on both the verdict and the
review result, never on the verdict alone.

## Fork behavior

By default, the tool harness is **skipped** on cross-repository (fork) pull
requests — no tool calls are issued, and the harness's own JSON records a
`fork-pr` skip reason. Set `tool-enable-for-forks: "true"` to allow it to
run on fork PRs. This gate also covers MCP servers and `web_search`: nothing
under `tool-mode` runs on a fork PR unless `tool-enable-for-forks` is set.

## Degrading to corpus-only

If the reviewing model never emits a single tool call (unsupported or
misconfigured tool-calling), the stop reason is `no-tool-calls` and the run
is reported as **degraded**: the caller falls back to a corpus-only review
using whatever deterministic context (diff, related-code context, repo map,
CI status, …) was already assembled. The verdict is still produced — just
without model-gathered tool evidence — so it's safe to leave `native_loop`
enabled against a model whose tool-calling support is uncertain.
