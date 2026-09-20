# Agents Guide: pr-reviewer-action

This is a GitHub Action that analyzes pull requests using OpenAI-compatible or Anthropic-compatible models (cloud or self-hosted) and publishes the review as a sticky PR comment or a native GitHub review.

## What it does

The action collects rich PR context (diff, files, linked issues, version hints, image digests, repo impact/history, standards files), runs a deterministic rule-based classification (PR kind, risk flags, required checks), assembles a review corpus, routes the review to a fast or smart model (optional), sends it to an LLM via OpenAI `POST /chat/completions` or Anthropic `POST /messages`, parses the JSON verdict + markdown body + optional structured findings, validates/enforces the result (required checks, findings severity gating, carried-forward findings, evidence/tool enforcement), and publishes via one of three modes (`comment`, `review_comment`, `review_verdict`).

## Key files

### Action definition and orchestration

- **`action.yml`** — Action definition with all inputs/outputs and composite run steps (precheck → CI wait → review → publish). Publishing is a single `Publish review` step with one superset `env:` block; the step body is a one-liner that runs `scripts/publish.sh`, which dispatches on `$PUBLISH_MODE` (comment / review_comment / review_verdict) using helpers from `scripts/publish_helpers.sh`.
- **`scripts/platform_api.sh`** — Platform seam (#221): every host-forge API call goes through `platform_*` functions (github backend = the exact pre-seam `gh` invocations; forgejo backend = `pr_reviewer/forgejo_backend.py`, rolling out across 1.4.x). `github_enrich_*` functions are for linked-source enrichment and always target github.com. `pr_reviewer/platform.py` is the Python mirror for script consumers.
- **`scripts/check_review_needed.sh`** — Precheck: computes `git patch-id --stable` fingerprint, decides full vs. incremental scope, and skips if unchanged since last managed comment (unless `force_review=true`)
- **Re-review trigger** — adding the `rereview_label` (default `ai-review`) to a PR forces a fresh review (`check_review_needed.sh` reads the `labeled` event from `GITHUB_EVENT_PATH`, sets `force_review`, and skips unrelated labels; the label is removed post-publish in `action.yml`). Labels are maintainer-only, so no command-auth gate is needed.
- **`scripts/wait_for_ci.sh`** — Optional CI gating: polls the Checks API until checks reach a terminal state (`ci_status_check=true`), then renders the per-check outcomes to `CI_CHECKS_FILE` for the review corpus
- **`scripts/run_review.sh`** — Main review orchestrator: sources the section modules under `scripts/sections/` in order (collects context, builds corpus, classifies, routes, calls model, validates and enforces verdicts)
- **`scripts/sections/`** — Review-pipeline modules sourced by `run_review.sh` (#307 split): `common.sh` (helpers/timers), `config.sh` (env defaults + validation + prompts), `context.sh`, `enrichment.sh`, `classification.sh`, `corpus.sh`, `review.sh` (model call → escalation → enforcement → outputs). Each is a verbatim in-order slice of the former monolith, so sourcing them reproduces the original top-level execution.
- **`scripts/model_call.sh`** — Shared model-call layer: request building, streaming/SSE handling, retries, error-body preservation for both API formats
- **`scripts/default_system_prompt.txt`** — Bundled system prompt used when no override is provided. Carries `{{...}}` placeholders that `apply_system_prompt_fragments` (`config.sh`) substitutes from `scripts/prompt_fragments/`: the PR-kind guidance fragments are gated on the classification, `{{VERBOSITY_GUIDANCE}}` on the `review_verbosity` input, `{{REQUIREMENT_LEDGER_GUIDANCE}}` (#624) on the presence signal `requirement-ledger-present.txt` written by the ledger build in `context.sh` when the ledger is non-empty. `{{SPECIALIST_LEADS_GUIDANCE}}` (#609) has a two-pass lifecycle: the deep-review phase reaps in `corpus.sh`, long after prompt assembly, so its presence signal does not exist at assembly time — `apply_system_prompt_fragments` therefore neutralizes it to empty (it must never leak), and `apply_specialist_leads_fragment` (`config.sh`, called from `corpus.sh` after the specialist reap and before the tool harness) appends the guidance exactly once, and only for the bundled default prompt, only when `specialist-leads-present.txt` is non-empty. Adding a fragment means a placeholder here, a file there, and a substitution in `apply_system_prompt_fragments` — nothing else enumerates them by name (`run_tool_harness.py` strips leftovers by shape)

### Python package (`pr_reviewer/`)

- **`classifier.py`** — Deterministic PR classification: `pr_kind`, `risk_flags`, `must_check` checklist (no model calls)
- **`completeness.py`** — Required-check completeness validation: keyword-matches `review_markdown` against `must_check` items
- **`enforcement.py`** — Verdict policy (`model` / `findings_severity_gated`), findings normalization, evidence/tool enforcement; records `verdict_source`
- **`escalation.py`** — Post-hoc escalation triggers for fast reviews (request_changes, low confidence, incomplete checks, blockers, dirty baseline)
- **`carry_forward.py`** — Carried-forward open findings for incremental reviews; surviving blockers force `request_changes` (`verdict_source: carry_forward`)
- **`metadata.py`** — Managed metadata marker (fingerprint, scope, open findings) embedded in published comments
- **`github_context.py`** — PR metadata/GitHub and Forgejo linked-issue reference helpers
- **`linear_context.py`** — Optional deterministic Linear adapter: recognizes configured `TEAM-123` identifiers in PR titles, fetches issue/spec context through Linear GraphQL, and normalizes it into linked-issue corpus/classification data
- **`response_parser.py`** — Tolerant model-output parsing (JSON in fences/prose, verdict + findings extraction)
- **`sse_reassembler.py`** — Reassembles streamed SSE responses into complete bodies (including streamed tool-call deltas; `function.arguments` is the accumulated JSON string, OpenAI non-streaming shape, per #233)
- **`conversation.py`** — Multi-turn conversation/request builder for native tool calling (#202, 2/7 of #197 Option B): append-only neutral state, OpenAI/Anthropic wire rendering, per-API tool-schema catalogue, `truncate_oldest_tool_results` budget helper, `verdict_turn` mode that drops `tools` and switches to the strict JSON `response_format`. Its module docstring holds the authoritative **verdict-turn contract / bash↔Python divergence map** (#362): the shared invariants the native-loop verdict (Path B) and the bash `build_model_request` review (Path A) must keep in lockstep, pinned by `tests/test_verdict_contract_equivalence.py`
- **`transport.py`** — Low-level model-call transport split out of `run_tool_harness.py` (#304): `run_chat_request` (curl-based chat POST + SSE handling, with the API key passed via a 0600 `--config` file, never argv) and the shared `safe_run` subprocess helper
- **`tool_executors.py`** — Read-only tool executors split out of `run_tool_harness.py` (#304): `read_file`, `find_files` (bounded filename/path glob discovery, #567), `list_tree` (bounded tree discovery — names only, depth/entry-capped, #566), `git_grep`/`git_log`/`git_blame`, `gh_api`, `web_fetch`, `web_search`, `run_command`, plus `execute_tool_request[s]` and the path/host guards (`_resolve_workspace_path`, allowlists). `scripts/run_tool_harness.py` re-imports these so existing call sites/tests are unchanged; it still owns the planner + `run_native_loop` + `main`
- **`change_anchors.py`** — Deterministic change-anchor extractor (#571): turns the PR diff (`pr.diff` / `pr.diff.truncated`) plus the changed-file list (`pr-files.json` / `pr-files.raw.json`) into a versioned `change-anchors.json` artifact — per-file symbols (Python `def`/`async def`/`class`, JS/TS `function`/`class`/arrow, Go `func`/method/`type`), imports, and file-path anchors, each with kind + confidence + source-file attribution. Anchors come from **added (`+`) lines only** (new-side code); context-only and deleted-only declarations are omitted (documented behavior). Regex/line heuristics only — no tree-sitter, no repo-wide grep, no network/model calls, nothing executed. Output is capped (100 files / 20 symbols / 20 imports / 200 anchors) and deduplicated deterministically (file order, then line, then name). Not yet wired into the corpus; a follow-up consumes the artifact for caller/reference/test lookup. CLI: `python3 -m pr_reviewer.change_anchors --diff pr.diff --files pr-files.json --output change-anchors.json`
- **`sarif.py`** — Standalone pure-Python SARIF 2.1.0 normalizer (#574): converts declared-order runs/results into bounded, deduplicated version-1 findings with deterministic severity, rule metadata, location, and help-URI extraction. It only parses in-memory data or local UTF-8 JSON, makes no network calls, and runs no commands. Consumed by `scripts/run_evidence_providers.py` (`_sarif_provider`), which reads the `SARIF_FILES` workspace-relative path list (comma/newline-delimited, validated inside the workspace, symlink-safe) and the `SARIF_MAX_FINDINGS` collective cap; SARIF severities map only to `major`/`minor`/`info`, so SARIF evidence never sets `has_blocker` on its own. CLI: `python3 -m pr_reviewer.sarif --input results.sarif --output sarif-evidence.json`
- **`specialists.py`** — Deterministic, bounded normalizer for specialist review leads (#607). Defines the three **fixed** specialist roles (`correctness`, `security`, `tests`) — the closed set `SPECIALIST_ROLES`, with no user-defined custom role surface — and one shared **version-1** structured-output contract (`role` / `leads` / `truncated` / `truncation` / `errors`) that every role's result carries. `normalize_specialist_output` parses an already-decoded lead object, `parse_specialist_response`/`extract_specialist_json` tolerate raw model text (strict JSON, fenced JSON, or JSON embedded in prose), and all malformed input (bad JSON, unknown role, non-object payload, non-array `leads`, unusable lead entries) degrades to a result with a populated `errors` list and empty/partial leads — never an exception. Leads keep declared order, exact duplicates keep the first, and list/character caps (`MAX_LEADS`, `MAX_MESSAGE_CHARS`) bound the artifact so one specialist cannot flood the final corpus. **Severity is capped below a blocker**: specialist severities map only onto `SPECIALIST_SEVERITIES` (`major`/`minor`/`info`); the `blocker`/`critical` aliases are downgraded to `major` (the `MAX_SPECIALIST_SEVERITY` cap), so a specialist's severity can never by itself set `has_blocker` or flip the final verdict — enforcement stays the main reviewer's job. `render_specialist_markdown` produces a fence-safe view where messages are control-character-escaped and file paths render in backtick spans whose delimiter is strictly longer than the longest backtick run in the path, so hostile content cannot close the enclosing fence or forge a heading; with a `max_bytes` budget it enforces a **hard UTF-8 byte cap** (`len(rendered.encode("utf-8")) <= max_bytes`) by dropping trailing whole lead lines (the omission is always visible) and, for a single oversized line, shrinking it char-safely — so it can never leave a multibyte character split. `render_specialist_leads_section` (#609) aggregates the per-role version-1 artifacts into the final corpus's `# Specialist Review Leads` section: fixed `correctness`/`security`/`tests` role order, advisory framing (unverified leads — not findings or proof), and one `## Role` block per role reusing the same fence-safe assembly as `render_specialist_markdown` (a role with no leads renders a concise count-only note). A **hard UTF-8 byte cap** applies to the whole document (framing/footer included) and is enforced by dropping **whole leads only** — always the last lead of the last role in reverse fixed order — with a visible `… N lead(s) omitted (byte cap)` footer; if no usable lead survives, or the document cannot fit the cap, it returns `""` (no section). Lead messages are re-passed through the shared `mask_secrets` secret-redaction plus control-character escaping, so an un-normalized artifact cannot leak a raw secret or control byte into the final corpus; identical input produces byte-identical output (deterministic). It only parses in-memory values and local UTF-8 text: no model calls, no network, no commands, no execution of lead content. CLI: `python3 -m pr_reviewer.specialists --role security --input leads.json --output specialist-security.json`; role prompt fragments live at `scripts/prompt_fragments/specialist_{role}.txt` (loaded by `load_specialist_prompt`)
- **`repo_map.py`** — Deterministic bounded repository-map builder (#569): seeds from `git ls-files -z` (argv-only, timeout, NUL-parsed) and classifies **tracked paths only** into a versioned, compact structural summary — language counts, top-level roots, important files (manifests / standards / workflows / entrypoints), category hints (tests / migrations / api / auth) and a bounded tree. Pure path/metadata classification — it opens no file, reads no source, and executes no repository code, so risk judgment stays `classifier.py`'s job. Caps are explicit (`max_depth` default 3, `max_entries` ~500, `max_files_per_category` ~50, optional `max_markdown_bytes` — a **hard** UTF-8 byte cap on the rendered document, `len(rendered.encode("utf-8")) <= cap` even for tiny caps); truncation is always visible (`truncation.truncated` + per-bucket omitted counts: `omitted_entries`, `omitted_category_files`, `omitted_important_files`, `omitted_roots`, plus a Markdown note), never silent, and ordering is stable for repeatability and prompt-cache friendliness. It emits JSON (`build_repo_map` → `render_repo_map_json`, schema `version: 1`) and a Markdown view (`render_repo_map_markdown`); the review corpus and the native-loop planning prompt consume a trust-framed form where the renderer's versioned first line is replaced by a fixed prefix (`reframe_for_corpus` / `TRUST_FRAMING_PREFIX`), and `trust_framing_overhead` is the exact byte delta between the two so callers hand the renderer a body budget net of it. Filenames are untrusted text: every path renders inside a backtick code span whose delimiter is strictly longer than the longest backtick run in the name (a name with one backtick uses ```` ``..`` ````; a four-backtick run uses ```` `````..````` ````; an exact ```` `` ```` run uses ```` ```..``` ```` — so even a path containing the matching delimiter cannot terminate the span), control characters — including newlines — are escaped to `\n`/`\t`/`\uXXXX`, names are capped, and the tree block uses a four-backtick fence a filename cannot forge, so a hostile name can never inject a heading or close the fence into a later prompt. When Git metadata is unavailable it raises `RepoMapError` (fails cleanly — never a misleading partial map) rather than falling back to a filesystem walk. The map is embedded in the review corpus and the native-loop planning context; those consumers re-frame the rendered Markdown rather than byte-slicing it, because a slice can land inside the four-backtick tree fence and leave it open in the prompt (#599), so the render is capped at the final byte budget net of the framing overhead. `tests/test_repo_map.py` exercises it against real temporary Git repos (nested layout, ordering, tracked-vs-untracked, hidden files, newline/space/Unicode names, caps with explicit `omitted_important_files`/`omitted_category_files`/`omitted_roots`/`omitted_entries` accounting, failure modes, hostile names including two-backtick runs and the fence string itself, and the hard byte cap across tiny/realistic/large caps).

- **`requirement_ledger.py`** — Deterministic, bounded requirement-ledger extractor (#624): turns the explicit normative text already in the review inputs — linked-issue bodies (`linked-issues.md` fenced payloads), the PR title/body (`pr.json`), and the resolved standards file — into a version-1 ledger of reviewable requirements with content-derived ids (`req-` + sha256[:12] of the casefolded normalized text, so the same requirement keeps the same id across runs), per-source provenance (source kind + ref + line), and a `kind` of `acceptance` (bullets under acceptance/requirements/invariants headings), `normative` (uppercase `MUST`/`SHALL` prose, lowercase `must` only in list items), or `invariant` (normative + an ordering token; `verification_required: true`). Pure parsing of local UTF-8 text — no model calls, no network, no command execution, all input treated as untrusted — and it never raises: malformed sources degrade to a shorter ledger. Extraction skips fenced code blocks, deduplicates casefolded text across and within sources (merged provenance, first occurrence wins), and caps visibly (`MAX_REQUIREMENTS` 48, `MAX_REQUIREMENT_CHARS` 400 with a trailing `…` and `truncated` flag, `MAX_SOURCES` 32 source documents — with capacity **reserved** for the standards and PR-body docs before the variable linked-issue set is bounded, so many linked issues can never crowd out the PR body, leading linked-issue docs surviving and drops visible as `truncation.omitted_sources` — and `render_requirement_ledger_markdown` a **hard** `MAX_LEDGER_MARKDOWN_BYTES` 8192 UTF-8 byte cap that drops trailing whole entries with a visible omission count). The rendered view is fence-safe the way `specialists.py`/`repo_map.py` renders are (control-character escapes, backtick spans with strictly longer delimiters than any backtick run, leading `#` neutralized), so hostile issue/PR text can neither forge a heading, close the enclosing fence, nor promote itself into a reviewer instruction. The ledger is a completeness signal, not a verdict. CLI: `python3 -m pr_reviewer.requirement_ledger build --pr-json pr.json --linked-issues-md linked-issues.md [--standards FILE --standards-ref NAME] --output requirement-ledger.json --markdown requirement-ledger.md`
- **`requirement_coverage.py`** — Deterministic, bounded validator for the final reviewer's per-requirement coverage claims (#624): folds the `requirement_coverage` array from the parsed verdict against the #624 ledger into a version-1 completeness artifact — a **signal, never a verdict** (it cannot flip or produce approve/request_changes; enforcement stays with `enforcement.py`). Claims normalize case-insensitively onto `satisfied`/`violated`/`unknown`; anything else becomes `unknown` and **unknown is never upgraded**. A claim for an unknown requirement id is dropped (`dropped-coverage-<id>`), duplicate ids keep the first, and claims whose `satisfied`/`violated` status lacks at least one CONCRETE evidence item (kind in `file|test|tool|ci|diff` with a non-empty `ref`/`detail`) are **downgraded to `unknown`** (`downgraded-no-concrete-evidence`). Ledger entries with `verification_required` (the `invariant` kind) additionally need observable evidence of kind `test|tool|ci` for a `satisfied` claim to be `credited`; a source-code glance (`file`/`diff` only) is downgraded (`downgraded-invariant-unverified`) — this encodes the #623 dogfood miss, where "launched before the final reviewer" was claimed as proof of the "all specialists reaped before the final review enters" invariant. Ledger requirements the reviewer never addressed appear as `unknown` rows with `not-covered-by-reviewer`. Caps: `MAX_COVERAGE_ITEMS` 64, `MAX_EVIDENCE_ITEMS` 8 per requirement, `MAX_EVIDENCE_CHARS` 500 per field. Fail-soft end to end (bad/missing payloads degrade to all-`unknown` rows, never an exception; an unavailable ledger is recorded as `ledger-unavailable`). CLI: `python3 -m pr_reviewer.requirement_coverage --coverage ai-output.json --ledger requirement-ledger.json --output requirement-coverage.json`. The review section runs it after enforcement, resetting the artifact first (as `context.sh`'s `build_requirement_ledger` resets every ledger artifact before attempting the build) so a reused workspace can never present a prior run's ledger or coverage as this run's

### Publishing and output hygiene

- **`scripts/publish.sh`** — Publish dispatcher (extracted from the `Publish review` step's inline `run:` block in #541): the `verify_pr_head.sh` publication-boundary pre-guard plus the three `PUBLISH_MODE` case arms (comment / review_comment / review_verdict), parametrized on the env the step exports. Sourced helpers come from `scripts/publish_helpers.sh`; unit-tested by `tests/test_publish_dispatch.sh`
- **`scripts/publish_helpers.sh`** — Shared publish functions: sanitize, metadata marker build, native review cleanup, finding-thread resolution
- **`scripts/sanitize_review_markdown.py`** — Neutralizes upstream GitHub auto-links (PR/issue/commit URLs, `owner/repo#123`, bare `#123`) in review output. `UPSTREAM_LINK_MODE` (`inert` default / `togithub`, #561) controls whether PR/issue/commit/compare URLs become plain text or clickable `https://togithub.com/...` links; shorthand refs stay inert in both modes
- **`scripts/strip_metadata_markers.py`** — Strips reserved `<!-- ai-pr-review-*:... -->` markers from model output before publishing
- **`scripts/strip_empty_conditional_sections.py`** — Deterministic backstop for #415: removes model-confabulated `## Linked Issue Fit` / `## Evidence Provider Findings` / `## Standards Compliance` sections when the corpus provided no such context. Presence mirrors the exact `[ -s linked-issues.md ]` / `[ -s evidence-providers.md ]` / `[ -s standards-present.txt ]` gates `corpus.sh` uses; fence-aware (won't match `#` headings inside code blocks); invoked from `sanitize_review_markdown`. Sections are matched by leading phrase with the trailing noun dropped (`linked issue`, `evidence provider`, `standards`), and an unreported signal defaults to present — never strip a section the caller forgot to report on
- **`scripts/redact.py`** — Shared secret-redaction pipeline applied to tool and evidence-provider output
- **`scripts/build_review_comments.py`** — Builds line-anchored inline review comments from structured findings, validated against the PR diff
- **`scripts/resolve_finding_threads.py`** — Resolves/replies on existing finding threads by content fingerprint on re-review
- **`scripts/strip_source_text.py`** — Strips fetched source text where needed for corpus hygiene

### Enrichment

- **`scripts/run_evidence_providers.py`** — Runs user-defined evidence provider commands from a JSON config, parses severity/findings output, and adapts SARIF evidence: `SARIF_FILES` (comma/newline-delimited workspace-relative paths, containment- and symlink-checked) is normalized through `pr_reviewer.sarif` into provider-shaped entries appended after the command providers, with `SARIF_MAX_FINDINGS` capping combined findings across all files; SARIF severities stay in `major`/`minor`/`info` so they never flip `has_blocker` by themselves
- **`scripts/run_tool_harness.py`** — Tool harness entry point (`tool_mode=native_loop`): drives the native tool-calling loop (`run_native_loop`) over the read-only tools in `tool_executors.py`; on a model that issues no tool calls it degrades to a corpus-only review. (The `plan_execute_*` planner modes were removed in 2.0/#304.)
- **`scripts/run_specialists.py`** — Deep-review specialist runner (#608): when `deep_review` is enabled, runs the three fixed specialist roles (`correctness` / `security` / `tests` — the closed set in `pr_reviewer/specialists.py`) **concurrently** (daemon threads) over the same review corpus, reusing the primary model settings (`AI_BASE_URL` / `AI_API_FORMAT` / `AI_MODEL` / `AI_API_KEY` / `AI_MAX_TOKENS` / `AI_REQUEST_TIMEOUT_SEC` / `ANTHROPIC_VERSION` / `AI_TEMPERATURE` / `AI_RESPONSE_FORMAT` / `AI_TOKENS_PARAM` from env) through the shared transport `pr_reviewer.transport.run_chat_request` — no second HTTP client. Each role gets workspace-root-guarded artifacts (`specialist-<role>.request.json` / `.response.json` / `.json` — the normalized one is the pure #607 contract artifact) plus a deterministic aggregate `specialists.json` (role order + status/error_kind/elapsed/lead counts). Bounded per role by `AI_REQUEST_TIMEOUT_SEC` and in aggregate by `DEEP_REVIEW_TIMEOUT_SEC` (default 600; roles past the deadline are recorded as timeouts and a cancelled worker never races the artifacts). Fail-soft: a role's transport/timeout/malformed outcome is recorded as artifact `errors` — never an exception, never an aborted review (one transport retry on a non-timeout failure). Invoked from `scripts/sections/corpus.sh` (not `review.sh`) behind the `DEEP_REVIEW=true` gate as a background job launched **after the initial corpus build/cp** and fully reaped fail-soft **before the `native_loop` tool harness starts** (the three roles are concurrent with each other, not with the reviewer), so the final reviewer's first tool-planning turn already sees the rendered leads (#609). At the end of the enabled phase it renders and writes `specialists.md` (the bounded `# Specialist Review Leads` section from the per-role version-1 artifacts) and `specialist-leads-present.txt` (the section's byte count when non-empty — the lockstep presence signal): fail-soft, capped by `SPECIALISTS_SECTION_MAX_BYTES` (default 12000), and dropped when it cannot fit `MAX_CORPUS`. Advisory only: the leads feed the reserved corpus section (appended last) and the final-review prompt guidance now, never enforcement, the verdict policy, or escalation — the final reviewer remains the sole verdict authority; specialists never run a native tool loop. `deep_review` / `deep_review_timeout_sec` are fingerprinted config keys.
- **`scripts/image_digest_analysis.py`** — Analyzes image digests from the diff for provenance context
- **`scripts/build_repo_map.py`** — Thin CLI wrapper for the repository-map builder (#569): adds the project root to `sys.path` and forwards argv to `pr_reviewer.repo_map.main`. All core logic (git ls-files seeding, classification, bounded JSON/Markdown rendering, the `RepoMapError` fail-safe) lives in the importable `pr_reviewer/repo_map.py`; the wrapper is only the import shim so shell orchestration can call `python3 scripts/build_repo_map.py --workspace "$GITHUB_WORKSPACE" --json repo-map.json --markdown repo-map.md`
- **`related_context.py`** — Deterministic bounded related-code scanner (#572): consumes version-1 `change-anchors.json`, the checked-out Git worktree, and optional `pr-files.json`; searches only high-confidence symbols with argv-only fixed-string `git grep`, discovers likely tests and nearest-first manifests, skips deleted/changed paths, redacts bounded snippets, and degrades Git failures/timeouts into explicit artifact errors. It emits version-1 `related-code.json` plus fence-safe compact Markdown. `scripts/sections/corpus.sh` generates and bounds these artifacts before corpus construction when `related_code_context` is enabled. CLI wrapper: `python3 scripts/build_related_context.py --workspace "$GITHUB_WORKSPACE" --anchors change-anchors.json --json related-code.json --markdown related-code.md`

### Tests

- **`tests/smoke_test.sh`** — Local smoke test against a real PR with a mock OpenAI/Anthropic server
- **`tests/mock_openai_server.py`** — Mock API server used by the smoke test
- **`tests/test_*.py`** — pytest suite (run in CI via `pytest tests/`)
- **`tests/test_*.sh`** — shell-based behavior tests for action scripts

## Architecture

```
check_review_needed.sh          → should_review + diff_fingerprint + effective scope (full/incremental)
wait_for_ci.sh (optional)       → block until CI checks are terminal + emit per-check results
run_review.sh                   → collects context → classifies → builds corpus → routes → calls model → validates/enforces
  ├─ gh pr view/diff/api        → PR metadata, files, linked issues
  ├─ pr_reviewer.classifier     → pr_kind, risk_flags, must_check (rule-based, no model)
  ├─ pr_reviewer.requirement_ledger → bounded requirement ledger from issue/PR/standards text (#624; fail-soft with pre-build artifact resets; gates the reserved ledger corpus block + prompt fragment in lockstep)
  ├─ URL fetching               → Linked sources from PR body (allowlisted hosts)
  ├─ image_digest_analysis.py   → Image digest provenance
  ├─ run_evidence_providers.py  → User-defined provider commands
  ├─ run_specialists.py         → Deep-review specialist passes (#608) → bounded advisory leads feed the reserved corpus section (#609), reaped before the tool harness
  ├─ run_tool_harness.py        → Tool harness planning + execution (once or loop)
  ├─ model_call.sh              → Fast/smart routing, retries, streaming, fallback
  └─ pr_reviewer.{completeness,enforcement,escalation,carry_forward,conversation,requirement_coverage}
                                 → required-check validation, verdict policy, escalation, carried findings,
                                   per-requirement coverage credit artifact after enforcement (#624)
publish (scripts/publish.sh)    → sanitize markdown → strip markers → build managed body → publish
  ├─ publish_mode=comment        → gh pr comment --edit-last --create-if-none (sticky)
  ├─ publish_mode=review_comment → sticky comment + optional inline-findings COMMENT review
  └─ publish_mode=review_verdict → native approve/request_changes (guardrailed) + inline comments
     ├─ cleanup_native_reviews   → dismiss/stub previous managed reviews
     └─ resolve_finding_threads  → resolve or reply on existing finding threads
```

## Review corpus sections (in order)

1. Changed Manifest Context (Helm/K8s manifests)
2. PR Metadata (JSON from `gh pr view`)
3. PR Classification (deterministic classifier output)
4. Related Code Context (bounded deterministic references, tests, and manifests)
5. Repository Map (bounded deterministic structure of Git-tracked paths)
6. PR Thread Context (bounded recent PR conversation comments; managed comments filtered, redacted, fence-safe)
7. Incremental Review Delta + Carried-Forward Open Findings (incremental scope only)
8. Linked Issue Context (from Fixes/Closes references in PR body and optional configured Linear identifiers in PR titles; Linear context is retained for incremental reviews)
9. PR Files (truncated JSON with patches)
10. Version Hints from Diff
11. PR Diff (truncated)
12. Tool Harness Findings (planned + executed tool results)
13. Evidence Providers (user-defined command output)
14. Image Digest Provenance
15. Linked Sources (fetched URLs, GitHub releases/compare metadata)
16. Repository Impact Scan (git grep hits for extracted terms)
17. Repository History (git log context for extracted terms)
18. Repository Standards and Conventions (from AGENTS.md, CLAUDE.md, etc.)
19. Specialist Review Leads (deep review only: a bounded advisory leads block appended last, after the reserved ledger block; never truncated itself)

Note: `MAX_CORPUS` truncation applies to sections 1–17; the standards section is always preserved in full. The #624 **Explicit Requirement Ledger** is a reserved block appended after the body (never truncated itself): its exact bytes are carved out of the body budget, it is emitted on both full and incremental corpora whenever the ledger is non-empty, and the same fits-the-reservation predicate gates the `requirement-ledger-present.txt` signal — so the system-prompt guidance can never be enabled for a corpus that lacks the section (lockstep). A ledger that cannot fit a sane reservation is dropped from both. The #609 **Specialist Review Leads** is a second reserved block, appended **last** (after the ledger block), so the authority order is standards > ledger > advisory leads and specialist content can never evict higher-authority material: its exact bytes are likewise carved out of the body budget, it is emitted on both corpora only when `deep_review` is enabled and a non-empty section survives, and the same fits-the-reservation predicate gates the `specialist-leads-present.txt` signal (lockstep; a stale signal is cleared by the guard in `corpus.sh` when the section ends up missing). When `deep_review` is disabled — or no usable lead survives — `specialists.md` is empty and no rebuild happens, so the disabled-run corpus stays byte-identical to a pre-#609 build.

The standards section is always *emitted* — it carries an explicit "standards context unavailable" note when nothing resolved — so `[ -s standards-context.md ]` cannot tell the publish step whether a standards file existed. `corpus.sh` writes `standards-present.txt` (the resolved path, or truncated) as that signal, and the publish step turns it into `STANDARDS_PRESENT` for the section stripper.

## Running tests

```bash
# Python unit tests (what CI runs)
pytest tests/ -v --tb=short

# Shell behavior tests are standalone, e.g.
tests/test_check_review_needed.sh

# Smoke test against a specific PR
PR_NUMBER=6757 tests/smoke_test.sh

# Let it pick the most recent open PR in misospace/pr-reviewer-action
tests/smoke_test.sh
```

The smoke test validates: GitHub PR data collection, corpus assembly, OpenAI/Anthropic response parsing, and tool harness request formatting.

## Important conventions

- All model calls use `curl -q` to avoid `.curlrc` timeouts interfering with local models
- Model responses are parsed by extracting JSON from markdown code blocks or scanning for the first valid JSON object (`pr_reviewer/response_parser.py`)
- Verdict must be `"approve"` or `"request_changes"` with a non-empty `review_markdown` string; an optional `findings` array is normalized (severities mapped to `blocker`/`major`/`minor`/`info`, malformed entries dropped)
- Context limit modes: `normal` (140k/70k/220k), `low` (80k/40k/120k), `minimal` (40k/20k/60k) — controls MAX_DIFF, MAX_FILES, MAX_CORPUS byte limits. `model_context_tokens` overrides these by deriving budgets from the real context window
- Evidence providers, tool harness, and Linear issue fetching are disabled by default on cross-repository PRs (`*_enable_for_forks=false`)
- Native approvals are off by default (`allow_approve=false`); fork approvals additionally require `approve_forks=true`
- Standards file resolution: explicit `standards_file` → first found from `standards_file_candidates` list (default: AGENTS.md, agents.md, CLAUDE.md, claude.md, .github/ai-review-rules.md, .github/ai-review-rules.txt). Candidates support glob patterns (e.g. `.agents/*.md`); first match wins.
- System prompt priority: inline `system_prompt` > file `system_prompt_file` > bundled default
- `review_verbosity` (`normal` / `concise`) dials the bundled default's output length via `{{VERBOSITY_GUIDANCE}}`. It only applies to the assembled default, so a `replace`-mode override ignores it; `normal` substitutes nothing and contributes nothing to the config fingerprint, keeping upgrades free of forced re-reviews
- Reserved metadata markers (`<!-- ai-pr-review-fingerprint:... -->`, `<!-- ai-pr-review-sha:... -->`) are stripped from model output before publishing; the precheck reads only the first occurrence of each
- The `run_command` tool never executes model-supplied shell text — only named argv definitions from a fixed read-only catalog (`git_status_short`, `git_diff_stat`, `git_diff_name_only`)
- Adversarial fixtures for security boundaries (#252): any sanitizer or fence (untrusted-data delimiters, secret redaction, exfil guards) must have a test that feeds the boundary token / hostile delimiter *itself*, not just benign input — a mock that omits the attack encodes the same blind spot as the code (the #250 fence was escapable by content containing its own closing delimiter). See `tests/test_native_loop_exfil_redteam.py` and the outbound-UA guard (`tests/test_outbound_user_agent.py`) for the pattern; add one when introducing a new fence.
- Versioning: `vX.Y.Z` semver tags with floating major tags (`v1`, `v2`, …). The patch/minor/major criteria, deprecation policy, and pre-release conventions are documented in the README's "Versioning policy" section — follow it when picking a version. To release after CI is green on `main`, run **Actions → Manual Release** with the target version; it creates the immutable tag, advances the floating major tag (stable releases only), and publishes the release.

## Label taxonomy (`agent/*` and Dispatch workflow labels)

Workflow labels are defined in `.github/labels.yaml`; agent identity labels are created ad hoc (see below). There are two distinct groups that agents interact with:

### Dispatch / operational labels
These are managed by the Dispatch system (dispatch.jory.dev) and are the source of truth for issue workflow state. Agents read and set these to claim and advance work.

| Label | Purpose |
|---|---|
| `status/backlog` | Not yet ready for pickup |
| `status/ready` | Ready for a Dispatch worker to claim |
| `status/in-progress` | Issue is claimed/actively worked |
| `status/in-review` | PR or human review in progress |
| `status/done` | Work complete |
| `needs-escalation` | Routes to the escalated model lane (GPT-5.5 equivalent) |
| `needs-info` | Blocked on information; agent should not pick up |
| `needs-human` | Blocked on human decision; agent should not pick up |
| `blocked` | Externally blocked; agent should not pick up |

### Agent identity labels
`agent/<name>` labels tag which agent or operator holds the claim on an issue (for example `agent/foreman-coder`, `agent/joryirving`, `agent/saffron`). They are created ad hoc at claim time by Dispatch or by the claiming agent, not enumerated in `.github/labels.yaml`. An issue in `status/in-progress` carries exactly one `agent/*` label; reassigning work means swapping it.

### Re-review label
`ai-review` is a repo-internal label: adding it to an open PR triggers a fresh AI review run regardless of fingerprint. It is removed automatically by the action after publishing. This label is **not** a Dispatch workflow label.

## Inputs summary

Required: `github_token`, `ai_base_url`, `ai_model`
Optional but common: `ai_api_key`, `publish_review_comment`, `publish_mode`, `standards_file`, `model_context_tokens`, `ai_response_format`, `review_routing_mode`, `evidence_providers_file`, `tool_mode`, `deep_review`

See `action.yml` (the source of truth) or the README's grouped input tables for the full list.

## Outputs summary

- `verdict`: `"approve"` or `"request_changes"`
- `verdict_source`: `"model"`, `"findings"`, or `"carry_forward"`
- `required_checks`: `"complete"`, `"incomplete"`, or `"none"`
- `review_route` / `escalation_reason`: routing outcome (`legacy`/`fast`/`smart`/`escalated`) and trigger names
- `findings`: normalized structured findings as a JSON array
- `review_markdown`: Full markdown review body
- `analysis_engine`: Model and endpoint string (e.g. `qwen3-32b@http://llama-server.internal:8080/v1`)
- `should_review` / `skip_reason` / `diff_fingerprint`: precheck results
- `ci_status_skipped` / `ci_status_final`: CI gating results
- `effective_review_scope` / `previous_head_sha` / `baseline_clean`: incremental-review state

## Filing issues for the autonomous loop

Issues here are picked up by an autonomous coding loop (dispatch → foreman), and two
parts of the body feed deterministic reviewer rails. Agents filing issues in this repo
must include both.

**1. State the ask in one imperative sentence.** The reviewer quotes it verbatim to
prove it actually read the issue. If it can only paraphrase, its GO is demoted to NO-GO
unless the rail below vouches — costing a revision cycle and an escalation review.

**2. Name the concrete file paths the fix is expected to touch** (backticks are fine).
The scope-overlap rail vouches for a diff that touches a named file, and that vouch is
what survives a paraphrased ask.

Name only paths you are confident about. An issue that names files the diff does *not*
touch is read as scope drift and also gets the change rejected — so when unsure, name
none rather than guessing.

## Eval harness runbook

The evaluation harness (`scripts/eval_harness.py`) and its graded corpora
(`evals/corpus-agentic.json`, `evals/corpus-repo-context.json`, and
`evals/corpus-specialists.json`) are wired
into CI by the `eval-harness` workflow (`.github/workflows/eval-harness.yaml`). Use this runbook for manual
runs or when triaging a failing scheduled regression sweep.

### Prerequisites

| What | Why |
|---|---|
| Python 3.12+ | Runs `scripts/eval_harness.py` |
| `AI_MODEL`, `AI_BASE_URL`, `AI_API_KEY` (env or repo secrets) | Target model endpoint for the review pass |
| `GITHUB_TOKEN` (env or repo secrets) | Lets the harness fetch PR diffs from the corpus |
| A writable directory for `eval-report/eval-report.json` | Holds the JSON report (also uploaded as an Actions artifact) |

### Run locally

```bash
python scripts/eval_harness.py \
    --corpus evals/corpus-agentic.json \
    --modes tools_off native_loop \
    --runs-per-mode 10 \
    --model "$AI_MODEL" \
    --base-url "$AI_BASE_URL" \
    --api-key "$AI_API_KEY" \
    --github-token "$GITHUB_TOKEN" \
    --output eval-report/eval-report.json
```

The `--modes` flag accepts one or more modes (space-separated on the shell
line, repeated `--modes x --modes y` works too). The default is
`tools_off native_loop`.

### Run via CI

The `eval-harness` workflow has two triggers:

- **`workflow_dispatch`** — runs on demand from the Actions tab. Inputs:
  `corpus` (default `evals/corpus-agentic.json`; choose
  `evals/corpus-repo-context.json` for the repository-context fixtures,
  `evals/corpus-specialists.json` for the deep-review specialist fixtures),
  `modes` (default `tools_off native_loop`), `runs-per-mode` (default `10`),
  `max-prs` (blank = corpus default), `deep` (choice `false` / `true` /
  `both`, default `false` — the deep-review specialist A/B; absent inputs,
  i.e. the scheduled run, default to standard-only).
- **`schedule`** — weekly Monday 06:00 UTC sweep against `main`. The
  scheduled run additionally posts a Markdown summary to
  `GITHUB_STEP_SUMMARY` and as a comment on issue #472 so regressions are
  discoverable from the issue tracker.

The JSON report is uploaded as the `eval-report` artifact on every run
(including failed runs) so regressions can be diffed week-over-week.

### Interpreting the report

The harness prints per-mode `pass_rate` (fraction of expected-evidence
checks that fired) and a `regressions` list naming checks that newly
failed vs. the previous baseline. A pass rate below `0.95` or any
non-empty `regressions` list should block the release; inspect the
artifact, reproduce locally with the command above, then fix the prompt or
routing regression in the action before re-running.

### Specialist corpus & deep A/B

`evals/corpus-specialists.json` grades the deep-review specialist phase
(#610): each fixture carries `specialist_expectations` that the harness
checks against the normalized specialist telemetry on the run
(`run.specialists`, loaded from the run's `specialists.json` aggregate and
`specialist-<role>.json` per-role artifacts). Run it with the same
harness:

```bash
python scripts/eval_harness.py \
    --corpus evals/corpus-specialists.json \
    --modes native_loop \
    --deep-review both \
    --runs-per-mode 10 \
    --model "$AI_MODEL" \
    --base-url "$AI_BASE_URL" \
    --api-key "$AI_API_KEY" \
    --github-token "$GITHUB_TOKEN" \
    --output eval-report/eval-report-specialists.json
```

`--deep-review false|true|both` controls the A/B; deep runs are labelled
`<mode>+deep` in the report (e.g. `native_loop+deep`) and get their own
mode summary. Each fixture's `specialist_expectations` splits into two
grading scopes so the A/B stays honest:

- `lead_checks` — deep-only diagnostics, graded **only** on
  `<mode>+deep` runs (a standard run cannot produce leads, so scoring one
  against them would inflate the deep side by definition):
  - `lead_generated` — at least `min` (default 1) leads for `role` (a
    single role or a list) matching the lead predicates `category_any`,
    `file_any`, and `message_any_contains` (loose, case-insensitive
    substrings).
  - `lead_disposition` — the disposition the final reviewer must have
    given a matching lead: `verified`, `rejected`, `unused`,
    `not_adopted`, or `any`. **`verified` requires concrete evidence**:
    the check must carry a non-empty `finding_file_any`, and the adopted
    final finding's `file` must match it — a finding that merely repeats
    the specialist's wording with no file grounding computes `rejected`,
    never `verified`. Finding-side needles override via
    `finding_category_any` / `finding_description_any_contains`, and
    `finding_line: true` additionally requires a line.
- `effectiveness_checks` — the comparable A/B subset, graded on **every**
  run (standard and deep alike) against the run's final findings (the
  production `message`/`file`/`line` shape consumed from `ai-output.json`):
  `final_findings_count` (`min`/`max` on the finding predicate) and
  `dedupe_final_findings` (default `max` 1: overlapping leads must
  collapse into a single final finding). Every fixture must declare at
  least one effectiveness check, so standard-vs-deep always compares the
  same final-review capability.

The report tallies the scopes separately per mode in `mode_summary`:
`specialist_effectiveness_runs` / `_passes` / `_pass_rate` (populated on
both the standard and the `+deep` label — this is the comparable
headline) and `specialist_lead_runs` / `_passes` / `_pass_rate` (deep
labels only; the standard label's lead rate is `None`). Per-PR entries
carry the per-label rate dicts and the per-run `specialist_capability`
detail (each check tagged `scope`), alongside each run's `specialists`
telemetry. The harness drives the real boundary: it passes `REPO` and
`PR_NUMBER` to `run_review.sh`, resets stale per-run artifacts
(`ai-output.json`, `ai-response.*.json`, `specialists.json`, …) per run,
and loads the final review from `ai-output.json` (verdict, markdown,
production-shape findings, `verdict_source`), with model/tokens from
`analysis_engine.txt` and the per-tier `ai-response.*.json` usage. One
fixture is flagged `negative_control`: it asserts a clean run invents no
findings (`final_findings_count` / `dedupe_final_findings` max 0) while a
`max_tool_calls` bound in its `expected_evidence` keeps the tool loop
lean. The weekly scheduled sweep remains standard-only (`deep`
absent → `false`), and none of this changes production defaults:
`deep_review` is still off by default for action users.
