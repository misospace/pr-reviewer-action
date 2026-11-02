/**
 * Native tool-calling loop driver — the v3 port of `pr_reviewer/tool_loop.py`
 * (#203, #678).
 *
 * Drives an agentic exchange against a tool-capable model: send the corpus +
 * tool schemas, execute the tool calls the model returns, append the results,
 * and repeat until the model stops calling tools or a budget runs out.
 *
 * Each turn can be streamed (`stream=true`): the injected `postFn` owns SSE
 * reassembly and hands back the same non-streaming response shape this module
 * parses, so the driver stays format-agnostic.
 *
 * The module is deliberately I/O-free: the HTTP POST and the tool execution
 * are injected callables, so the whole loop is unit-testable against scripted
 * conversations without a model server. `src/tools/harness.ts` owns the real
 * wiring (transport + the read-only executors with their allowlists, caps, and
 * timeouts — none of which change here).
 *
 * Reliability posture (issue #203): the loop budgets for repair instead of
 * assuming competence. Malformed arguments come back as error tool-results the
 * model can react to, duplicate calls are answered from a dedup note without
 * burning budget, every call id the model issues gets *some* result before the
 * next request (the Conversation openToolCallIds contract), and hard caps bound
 * rounds, total calls, and wall clock. A model that never calls tools at all is
 * reported as `degraded` so the caller can fall back to a corpus-only review.
 */
import {
  Conversation,
  pyDumps,
  pyDumpsCompactSortedAscii,
  pyDumpsSorted,
  type ToolCallRecord,
} from "../model/conversation.js";
import type { EvidenceProvenance } from "../context/evidence-provenance.js";
import { SKILL_RESULT_MAX_BYTES } from "../context/repository-skills.js";
import { normalizeUsageTelemetry, type UsageTelemetry } from "../model/telemetry.js";

// Stop reasons (LoopOutcome.stopReason)
export const STOP_MODEL_DONE = "model-stopped";
export const STOP_NO_TOOL_CALLS = "no-tool-calls";
export const STOP_MAX_ROUNDS = "max-rounds";
export const STOP_BUDGET = "tool-call-budget-exhausted";
export const STOP_WALL_CLOCK = "wall-clock-exceeded";
export const STOP_REQUEST_ERROR = "request-error";

// Synthetic result bodies. These are model-facing: they must explain the
// refusal in one sentence so a self-correcting model has something to act on.
const DUPLICATE_NOTE =
  "Duplicate request: this exact tool call already ran in this conversation. " +
  "Reuse the earlier result instead of repeating the call.";
const BUDGET_NOTE =
  "Tool-call budget exhausted: this call was not executed. " +
  "Finish the analysis with the evidence you already have.";

/** #1379 review blocker 5728634290: human-readable label for one obligation,
 * used by the reserve window/refusal notes to name what is still outstanding. */
const DEPENDENCY_EVIDENCE_OBLIGATION_LABELS: Record<DependencyEvidenceObligation, string> = {
  provenance: "upstream publisher/source provenance",
  release_delta: "the exact old-to-new upstream release delta",
  security_advisory: "upstream security advisories",
};

function formatOutstandingObligations(outstanding: readonly DependencyEvidenceObligation[]): string {
  const labels = outstanding.map((obligation) => DEPENDENCY_EVIDENCE_OBLIGATION_LABELS[obligation]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

// #701 exhaustion awareness: every loop turn after the first carries the
// remaining request/round budget, so the model plans against real headroom
// instead of discovering the ceiling via a refused call. Once few requests
// remain the note switches from status to direction: stop broad exploration,
// spend what is left on unresolved blocker hypotheses and verdict evidence.
export const LOW_TOOL_REQUESTS_REMAINING = 2;

const BUDGET_TURN_NOTE =
  "[loop budget] {requestsLeft} of {requestsTotal} tool request(s) and " +
  "{roundsLeft} of {roundsTotal} turn(s) remain.";
export const REQUIRED_EVIDENCE_TURN_NOTE =
  "[loop budget] {requestsLeft} tool request(s) remain; {reservedCount} request(s) are reserved for the unresolved required-evidence obligations. The reservation is now enforced: calls that target none of those obligations are refused and will not execute. Spend the reserved requests ONLY on evidence for those obligations (read the named files, fetch the named upstream compatibility matrix or document from the Required Review Evidence section) before any optional exploration.";

// #1381 (review): the enforceable half of the reservation. Inside the
// reserved window a call executes only when its argument targets overlap an
// obligation no call has attempted yet; everything else is refused with this
// note WITHOUT consuming the budget, so optional exploration can never spend
// the requests held back for required evidence.
const REQUIRED_EVIDENCE_REFUSAL_NOTE =
  "Reserved required-evidence budget: this call targets none of the unresolved obligations from the Required Review Evidence section, " +
  "and the remaining requests are reserved for them. It was NOT executed and did not consume budget. Spend the next calls on the " +
  "obligation evidence itself — read the files and fetch the upstream documents the obligations name — then optional calls are allowed again.";

/** #1396: the FIRST-request priority note when the outstanding obligations are
 * review-owned prose rows — the generic counterpart of
 * DEPENDENCY_EVIDENCE_PRIORITY_TURN_NOTE, chosen by the same single note
 * selection pass. Trusted driver text; names no untrusted content. */
export const REQUIRED_EVIDENCE_PRIORITY_TURN_NOTE =
  "[loop budget] Required review evidence comes first: resolve every outstanding obligation from the " +
  "Required Review Evidence section with tools BEFORE spending calls on optional exploration " +
  "(local-diff confirmation, history greps, redundant local reads).";

const LOW_BUDGET_TURN_NOTE =
  "[loop budget] Only {requestsLeft} tool request(s) and {roundsLeft} " +
  "turn(s) remain. Stop broad exploration now: prioritize confirming or " +
  "rejecting your unresolved blocker hypotheses and gathering only the " +
  "evidence still needed for the verdict.";

/**
 * #1379: deterministic tool-loop prioritization for dependency-update PRs.
 * When the caller (the harness, keyed on the PR's classification) reserves a
 * tail of the request budget for required dependency evidence, the driver —
 * not the prompt fragment — owns the ordering rule:
 *
 * - the FIRST request is preceded by a turn note stating the dependency-
 *   evidence obligations take priority over optional work;
 * - once the reserve window is entered (and until it is released) the
 *   regular budget note is replaced by one redirecting ALL remaining spend
 *   to the obligations still OUTSTANDING, named in the note itself;
 * - and the window is ENFORCED, not just announced: until every tracked
 *   obligation is covered by an executed dependency-evidence call — each
 *   call attributed to its obligations from its own target via
 *   dependencyEvidenceObligationsForCall (review blocker 5728634290: ONE
 *   release-notes fetch must not unlock local archaeology while provenance
 *   and security advisories are still unchecked) — or until the loop has
 *   spent the whole reserve on evidence attempts, any other tool call
 *   requested inside the window is REFUSED with a synthetic error and
 *   spends none of the reserved requests. Crediting and the attempts cap
 *   are executor-status-agnostic: a refused host or failed fetch still
 *   counts, and the cap guarantees the window always opens within the tail
 *   it reserved, so a model in an evidence-unreachable configuration is
 *   never locked out of finishing.
 *
 * Notes are trusted driver text (a turn_note, never inside the untrusted
 * tool-result envelope), and the whole mechanism is skipped entirely when no
 * reserve is configured, so non-dependency PRs keep the exact #701 note
 * sequences and call dispositions the reliability tests pin.
 */
export const DEPENDENCY_EVIDENCE_PRIORITY_TURN_NOTE =
  "[loop budget] Required dependency evidence comes first: establish upstream " +
  "provenance, inspect the exact old-to-new upstream release delta, and check " +
  "security advisories (or record the check as not performed) BEFORE spending " +
  "tool calls on optional archaeology, claim falsification, history greps, or " +
  "redundant local-diff confirmation.";
// #1379 review blocker 5728634290: the window note names the obligations
// still OUTSTANDING ({outstanding}), not the full fixed trio — a model that
// already covered provenance is redirected at what it still owes.
const RESERVE_WINDOW_TURN_NOTE =
  "[loop budget] Only {requestsLeft} tool request(s) remain and they are " +
  "reserved for the required dependency evidence still outstanding: " +
  "{outstanding}, reached through web_fetch (plus web_search when that tool " +
  "is offered to you). Optional and local-diff calls are now refused, not " +
  "executed. If the evidence cannot be established, report what is missing " +
  "rather than approximating it.";

// #1396: the window can open on the ROUNDS half alone (#1388) — rendering the
// requests-scarce wording then would misstate what is scarce. Same selection
// pass, honest counts.
const RESERVE_WINDOW_ROUNDS_TURN_NOTE =
  "[loop budget] Only {roundsLeft} loop turn(s) remain and they are " +
  "reserved for the required dependency evidence still outstanding: " +
  "{outstanding}, reached through web_fetch (plus web_search when that tool " +
  "is offered to you). Optional and local-diff calls are now refused, not " +
  "executed. If the evidence cannot be established, report what is missing " +
  "rather than approximating it.";

// #1396: when a unified run ALSO has unresolved prose obligation rows gating
// the same window, the dependency-worded note/refusal must not imply the
// dependency debt is the ONLY way out — a call targeting a Required Review
// Evidence row executes too.
const MIXED_WINDOW_CLAUSE = " The reservation also covers the unresolved rows of the Required Review Evidence section — a call that targets one of those executes as well.";

/** #1379: the refusal a non-evidence call gets inside the reserve window
 * while not every tracked obligation is covered (and the attempts cap has
 * not been reached). Model-facing: explains the refusal, names what is
 * still owed, and the two ways forward in one breath. */
const RESERVE_REFUSAL_NOTE =
  "Reserved dependency-evidence budget: this call was not executed and spent " +
  "none of the remaining requests. The reserved tail still owes " +
  "{outstanding}, reached with web_fetch (plus web_search when that tool is " +
  "offered to you). Make one of those calls, or finish now and report the " +
  "missing evidence as unknown / needs verification.";

/**
 * #1379: the tool calls that are the CHANNEL for the required upstream
 * dependency evidence. These are the only tools that can reach an arbitrary
 * upstream (provenance, release delta, advisories): the local read/git tools
 * and run_command can only confirm the diff already in the corpus, and
 * gh_api is allowlisted to the PR's own repos, not the dependency's.
 * `web_search` is advertised only when a search endpoint is configured, so
 * the driver notes name `web_fetch` as the always-available channel and
 * `web_search` conditionally. Since review blocker 5728634290 these tools
 * only identify the CHANNEL — the obligation state is tracked PER OBLIGATION
 * via dependencyEvidenceObligationsForCall, so one executed call no longer
 * releases the whole reserved window.
 */
export const DEPENDENCY_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
]);

/** #1379 review blocker 5728634290: the required upstream evidence
 * obligations the reserve window tracks individually. Canonical order is
 * load-bearing: the tracked set is the prefix the reserve can pay for, and
 * credits/outstanding lists are always projected in this order. */
export type DependencyEvidenceObligation = "provenance" | "release_delta" | "security_advisory";

export const DEPENDENCY_EVIDENCE_OBLIGATIONS: readonly DependencyEvidenceObligation[] = [
  "provenance",
  "release_delta",
  "security_advisory",
];

const SECURITY_ADVISORY_TOKENS: readonly string[] = [
  "advisor",
  "ghsa",
  "cve",
  "osv",
  "vulnerab",
  "security",
  "exploit",
  "bulletin",
];

const RELEASE_DELTA_TOKENS: readonly string[] = [
  "release",
  "changelog",
  "changes",
  "changeset",
  "compare",
  "diff",
  "commits",
  "commit",
  "tag",
  "news",
  "history",
  "migration",
  "upgrade",
  "notes",
];

const PROVENANCE_TOKENS: readonly string[] = [
  "registry",
  "repositor",
  "package",
  "artifact",
  "provenance",
  "sbom",
  "publisher",
  "vendor",
  "maintainer",
  "homepage",
  "readme",
  "chart",
  "helm",
  "mirror",
];

// Exact publisher/registry hosts: fetching one of these IS a provenance
// lookup regardless of path. Dots are kept in the tokenization so hosts
// survive as single tokens.
const PUBLISHER_REGISTRY_HOSTS: ReadonlySet<string> = new Set([
  "hub.docker.com",
  "docker.io",
  "index.docker.io",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "mcr.microsoft.com",
  "registry.k8s.io",
  "k8s.gcr.io",
  "pypi.org",
  "pypi.python.org",
  "www.npmjs.com",
  "npmjs.com",
  "registry.npmjs.org",
  "crates.io",
  "pkg.go.dev",
  "artifacthub.io",
  "hub.helm.sh",
  "operatorhub.io",
  // Ecosystem registries the same review shape reaches for (independent
  // review of this delta: rubygems/Maven/ECR lookups credited nothing while
  // npm/PyPI did, so those PRs burned refusals until the attempts cap).
  "rubygems.org",
  "repo1.maven.org",
  "search.maven.org",
  "mvnrepository.com",
  "maven.google.com",
  "packagist.org",
  "nuget.org",
  "pub.dev",
  "registry.terraform.io",
  "registry.nuget.org",
  "public.ecr.aws",
  "gallery.ecr.aws",
  "us.gcr.io",
  "eu.gcr.io",
  "asia.gcr.io",
]);

// Source hosts: only a bare repository root (at most two non-empty path
// segments, e.g. github.com/owner/repo) counts as a provenance lookup; a
// deeper path is doing something else (release pages, advisories, files).
const SOURCE_CODE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "dev.azure.com",
]);

/**
 * #1379 review blocker 5728634290: deterministic, conservative attribution
 * of one dependency-evidence call to the obligations its own target (the
 * `web_fetch` URL or the `web_search` query) says it is serving. Bounded and
 * lexical — never throws, never touches the network. Only names in
 * DEPENDENCY_EVIDENCE_TOOLS attribute (any other tool → `[]`); an absent or
 * non-string target attributes nothing. A call can cover several
 * obligations; matches are returned deduped in canonical
 * DEPENDENCY_EVIDENCE_OBLIGATIONS order (possibly empty — an unattributed
 * evidence call still counts toward the attempts cap, just credits nothing).
 */
export function dependencyEvidenceObligationsForCall(
  name: string,
  args: Record<string, unknown>,
): DependencyEvidenceObligation[] {
  if (!DEPENDENCY_EVIDENCE_TOOLS.has(name)) return [];
  const target = name === "web_fetch" ? args.url : args.query;
  if (typeof target !== "string" || target === "") return [];
  const lower = target.toLowerCase();
  const tokens = lower.split(/[^a-z0-9.]+/).filter((token) => token !== "");
  const matched = new Set<DependencyEvidenceObligation>();
  for (const token of tokens) {
    if (SECURITY_ADVISORY_TOKENS.some((keyword) => token.includes(keyword))) matched.add("security_advisory");
    if (RELEASE_DELTA_TOKENS.some((keyword) => token.includes(keyword))) matched.add("release_delta");
    if (PROVENANCE_TOKENS.some((keyword) => token.includes(keyword))) matched.add("provenance");
  }
  const hostToken = tokens.find((token) => token.includes("."));
  if (hostToken !== undefined) {
    const host = hostToken.replace(/^www\./, "");
    if (PUBLISHER_REGISTRY_HOSTS.has(host)) {
      matched.add("provenance");
    } else if (SOURCE_CODE_HOSTS.has(host)) {
      const afterHost = lower.slice(lower.indexOf(hostToken) + hostToken.length);
      const path = afterHost.split(/[?#]/, 1)[0] ?? "";
      const segments = path.split("/").filter((segment) => segment !== "").length;
      if (segments <= 2) matched.add("provenance");
    }
  }
  return DEPENDENCY_EVIDENCE_OBLIGATIONS.filter((obligation) => matched.has(obligation));
}

/**
 * #1396: the obligation a deterministic dependency-evidence `must_check`
 * checklist text names (the DEPENDENCY_EVIDENCE_CHECKS family templates), or
 * null for any other check. The harness uses it to map a shown obligation row
 * onto its dependency-evidence SHAPE vocabulary: a real provenance or
 * advisories fetch does not repeat the check's prose words, so gating it on
 * prose tokens would refuse the very call that discharges the obligation
 * (#1396's cross-starvation). Lexical, total, never throws.
 */
export function dependencyObligationForCheckText(text: string): DependencyEvidenceObligation | null {
  const lower = text.toLowerCase();
  if (/establish upstream provenance/.test(lower)) return "provenance";
  if (/release delta/.test(lower)) return "release_delta";
  if (/security advisories/.test(lower)) return "security_advisory";
  return null;
}

/**
 * #1396: ONE obligation row of the unified enforced window, produced once by
 * the harness. Exactly one vocabulary is meaningful per row:
 * - `obligation` set (dependency-evidence shape row): admission is the
 *   call's own URL/query shape crediting that obligation; `tokens` is empty.
 * - `obligation` absent (prose row): admission is word-boundary overlap of
 *   the call's argument VALUES with `tokens` (#1381).
 */
export interface RequiredEvidenceRow {
  id: string;
  tokens: readonly string[];
  obligation?: DependencyEvidenceObligation;
}

/** #1396: whether one call attempts (would discharge) one pending row. */
function rowAdmittedByCall(
  row: RequiredEvidenceRow,
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (row.obligation !== undefined) {
    return dependencyEvidenceObligationsForCall(name, args).includes(row.obligation);
  }
  const target = argumentTargetText(args);
  return row.tokens.some((token) => targetMentions(target, token));
}

/** Default #1379 reserve: the budget tail the driver holds for required
 * dependency evidence once the classification says the PR is a
 * dependency-update shape. The harness clamps it to the budget: budgets of
 * two or more keep one unreserved head request, and the minimum budget of
 * one reserves its sole request (see dependencyEvidenceReserveFromClassification). */
export const DEPENDENCY_EVIDENCE_RESERVE = 4;

function formatNote(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => String(values[key] ?? ""));
}

/** #1381: the lowercased argument VALUES of a tool call — the model-chosen
 * target (paths, endpoints, URLs, queries) without the schema's own argument
 * names, which would overlap any obligation mentioning a generic word like
 * "path" and silently open the reserved window to everything. */
function argumentTargetText(value: unknown): string {
  const parts: string[] = [];
  const walk = (item: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof item === "string") {
      parts.push(item);
    } else if (Array.isArray(item)) {
      for (const child of item) walk(child, depth + 1);
    } else if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return parts.join(" ").toLowerCase();
}

/** #1381: word-boundary token match over the concatenated argument values —
 * a "matrix" obligation must not be satisfied (or an optional call admitted)
 * by "clockmatrix.md". */
function targetMentions(target: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const index = target.indexOf(token, from);
    if (index === -1) return false;
    const before = index === 0 ? "" : target[index - 1]!;
    const afterIndex = index + token.length;
    const after = afterIndex >= target.length ? "" : target[afterIndex]!;
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = index + 1;
  }
}

/** Hard stop conditions. The driver owns these; Conversation's token helpers
 * are advisory (see src/model/conversation.ts). */
export interface LoopBudgets {
  /** Total executed calls across rounds (TOOL_MAX_REQUESTS). */
  maxToolCalls: number;
  /** Model round-trips (derived: configured rounds doubled, capped at 12). */
  maxRounds: number;
  /** Whole-loop ceiling (TOOL_LOOP_WALL_CLOCK_SEC). */
  wallClockSec: number;
  /** When the conversation outgrows this, the oldest tool results are
   * compacted before the next request (newest stay intact). */
  maxConversationTokens: number;
  truncatedResultBytes: number;
  /** Results kept verbatim when summarizing the rest. */
  summarizeKeepNewest: number;
}

/**
 * #895: ceiling for the size-scaled round cap below — high enough that a
 * large tool-call budget isn't strangled by an unscaled round count, low
 * enough to still bound worst-case loop wall-clock.
 */
export const TOOL_LOOP_ROUNDS_CEILING = 32;

/**
 * Right-size the loop budget. A native round is one model turn. #701: the
 * request budget is TIER-AWARE — the caller resolves the effective budget
 * from the route (primary ~24, smart ~32, escalated up to 40 — see
 * resolveToolMaxRequests in src/tools/budget.ts) and passes it in here.
 * #810: without an explicit override that budget is scaled from the PR's
 * changed files/lines and specialist leads, floored at the route's tier
 * default.
 *
 * #895: the round cap didn't scale with that request budget, so reviews
 * were stopping on `max-rounds` with roughly half the call budget unspent.
 * When `roundsExplicit` is true (the caller resolved `maxRounds` from a
 * user-set TOOL_MAX_ROUNDS / SMART_TOOL_MAX_ROUNDS) the cap stays the
 * original doubled-and-capped-at-12 value — an explicit override is a user
 * decision, not something the request budget should override. Otherwise the
 * cap matches the tool-call budget, so a model that reads one file per turn
 * can still spend it, capped at TOOL_LOOP_ROUNDS_CEILING; the wall clock is
 * the real bound.
 */
export function adaptiveLoopBudgets(
  maxRounds: number,
  maxToolCalls: number,
  wallClockSec: number,
  roundsExplicit = true,
): LoopBudgets {
  const doubled = Math.max(maxRounds, 1) * 2;
  const rounds = roundsExplicit
    ? Math.min(doubled, 12)
    : Math.min(Math.max(doubled, maxToolCalls), TOOL_LOOP_ROUNDS_CEILING);
  return {
    maxToolCalls,
    maxRounds: rounds,
    wallClockSec,
    maxConversationTokens: 24000,
    truncatedResultBytes: 2000,
    summarizeKeepNewest: 2,
  };
}

export interface ExecutedCall {
  tool: string;
  args: Record<string, unknown>;
  /** Executor shape: {"tool", "status", "result"}. */
  result: Record<string, unknown>;
}

/**
 * #1199: bounded, content-free per-round telemetry for one native-loop model
 * turn. The loop owns the round timeline and emits exactly one record per
 * model turn (a turn that internally retried a streamed response still
 * produces ONE record, so aggregate totals sum without double counting).
 * Records cover EVERY model turn: `outcome.rounds` is the count of turns that
 * returned a response, and a transport-error turn adds at most ONE additional
 * record (when the loop stops on REQUEST_ERROR) with null provider usage.
 * Summing round usage over a null contributes nothing, so the persisted
 * records never over-count the aggregate usage.
 * Every field is a count, a duration, a nullable provider-reported token total,
 * or a boolean. No prompt text, response text, tool arguments, tool results,
 * credentials, or provider error bodies ever ride here. `prompt_tokens` /
 * `completion_tokens` / `cached_tokens` are the provider's own reported
 * numbers, accounted in the configured wire format's convention by
 * `normalizeUsageTelemetry` — the SAME accounting the loop aggregate folds,
 * so the persisted records sum to it (Anthropic reports its cache tokens
 * outside `input_tokens`, so they belong in the prompt total; OpenAI's
 * `prompt_tokens` already includes them). A provider that reports nothing
 * leaves them `null` — never estimated from elapsed time.
 *
 * Summing the records over the whole run reproduces the aggregate's usage for
 * every turn that carries a record. The aggregate's charges that carry NONE
 * (the context-compaction digest call, and a failed or unaccepted #1145
 * verdict refresh) are persisted in their own `unrecorded_usage` categories,
 * so records + those categories derive the aggregate exactly — never an
 * under-count, never an over-count (#1199 review round 5).
 */
export interface NativeLoopRoundTelemetry {
  /** 1-based model-turn index within this loop run. */
  round: number;
  /** Wall-clock seconds the model request took, incl. any streamed→non-streamed
   * retry the turn performed (the whole time waiting on a usable response). */
  model_sec: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  /** Tool calls the model requested this turn (executed + refused + deduplicated). */
  tools_requested: number;
  tools_executed: number;
  /** Calls not executed because they were over budget or had invalid arguments. */
  tools_refused: number;
  /** Calls answered from the dedup note without re-running. */
  tools_deduplicated: number;
  /** Wall-clock seconds the round's (concurrent) tool execution took. */
  tool_elapsed_sec: number;
  requests_remaining: number;
  rounds_remaining: number;
  /** Wall-clock budget left for this loop run, measured on the telemetry clock
   * (real elapsed time since the loop started) against the run's wall-clock
   * budget. The budget STOP itself is decided on the budget clock; this field
   * only reports how much of that budget is left. */
  wall_clock_remaining_sec: number;
  /** True when this turn's streamed transport fell back to a non-streamed call. */
  streamed_fallback: boolean;
}

/**
 * #1199: the per-turn signal the loop hands to `postFn` so the transport seam
 * can report a streamed→non-streamed fallback into the round's telemetry. The
 * summarizer/digest request does not pass one, so its fallbacks are never
 * attributed to an investigation round; its spend rides the dedicated
 * `unrecorded_usage.context_compaction` category instead (it is not a model
 * turn of the loop timeline).
 */
export interface ToolTurnSignal {
  reportFallback(): void;
}

export interface LoopOutcome {
  executed: ExecutedCall[];
  rounds: number;
  /** Everything the model asked for, incl. refused calls. */
  toolCallsIssued: number;
  stopReason: string;
  finalText: string;
  /** True when the model never issued a single tool call: the caller degrades
   * to a corpus-only review. */
  degraded: boolean;
  error: string;
  /** #702 budget telemetry, filled on every exit path: how much request
   * budget was left when the loop stopped, how long the loop ran, the
   * effective ceilings it was given, and whether/how often context compaction
   * fired. Counts and sizes only — never tool content. */
  requestsRemaining: number;
  elapsedSec: number;
  maxToolCalls: number;
  maxRounds: number;
  wallClockSec: number;
  toolResultBytes: number;
  compactionSummarize: number;
  compactionTruncate: number;
  /** #922: largest approximate conversation size seen before a turn. */
  peakConversationTokens: number;
  /** #1381; #1396: requests reserved at the end of the budget for the ONE
   * enforced obligation window (review-owned obligation rows plus, for a
   * dependency-update PR, the dependency-evidence shape rows). Inside this
   * window the reservation is enforced: calls that target none of the
   * pending rows are refused without consuming budget (see
   * `requiredEvidenceRefusals`). */
  requiredEvidenceRequestsHint: number;
  /** #1381; #1396: calls refused by the one enforced obligation window, over
   * every row kind. There is exactly one refusal counter — no mechanism
   * keeps a second one beside it. */
  requiredEvidenceRefusals: number;
  /** #1396 (from #1379 blocker 5728634290): the number of obligation rows
   * the window tracks (prose rows plus dependency-evidence shape rows).
   * 0 when no reservation is configured. */
  requiredEvidenceRequired: number;
  /** #1396 (from #1379 blocker 5728634290): row ids discharged by an
   * admitted executed call — prose rows by argument-target token overlap,
   * dependency-evidence rows by the call's own URL/query shape — plus the
   * ids seeded through `requiredEvidenceCredits`, in row order. */
  requiredEvidenceCredits: string[];
  /** #1396 (from #1379 blocker 5728634290): executed upstream
   * evidence-channel calls (see DEPENDENCY_EVIDENCE_TOOLS) over the whole
   * run, whatever their target or executor status — run-wide across the
   * #1145 repair seam: a continuation seeded by `requiredEvidenceAttemptsPrior`
   * reports the prior loop's attempts too. The no-lockout cap:
   * dependency-evidence shape rows release their gating once this reaches
   * the cap (the reserve, or the run-wide threshold threaded across the
   * seam), even if nothing was credited. */
  requiredEvidenceAttempts: number;
  /** #1396 (from #1379 blocker 5728634290): whether the enforced window was
   * released at loop end — reserve 0 (always open), or every tracked row
   * discharged or cap-released. */
  requiredEvidenceReleased: boolean;
}

/**
 * Pull (tool_calls, text) out of a non-streaming chat response (port of
 * `extract_tool_calls`). Returned calls are in the flat
 * `{"id", "name", "arguments"}` shape Conversation.addAssistantToolCalls
 * accepts, with `arguments` kept as an opaque JSON string per the #233
 * contract. Anthropic `tool_use` inputs are serialised once at this boundary.
 */
export function extractToolCalls(
  response: unknown,
  apiFormat: string,
): { calls: ToolCallRecord[]; text: string } {
  const calls: ToolCallRecord[] = [];
  const textParts: string[] = [];
  const res = (response ?? {}) as Record<string, unknown>;

  // A streamed Anthropic turn arrives from the SSE reassembler in OpenAI shape
  // (`choices`), so parse by shape, not api format alone — otherwise every
  // streamed Anthropic tool call reads as "no tool calls".
  if (apiFormat === "anthropic" && !Array.isArray(res.choices)) {
    const content = res.content;
    if (Array.isArray(content)) {
      for (const raw of content) {
        if (raw === null || typeof raw !== "object") continue;
        const block = raw as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
                } else if (block.type === "tool_use") {
          const callId = block.id;
          const name = block.name;
          if (typeof callId !== "string" || typeof name !== "string") continue;
          const rawInput = block.input;
          let arguments_: string;
          try {
            arguments_ = pyDumpsSorted(rawInput ?? {});
          } catch {
            arguments_ = String(rawInput);
          }
          calls.push({ id: callId, name, arguments: arguments_ });
        }
      }
    }
    return { calls, text: textParts.join("") };
  }

  // OpenAI format
  const choices = res.choices;
  let message: Record<string, unknown> = {};
  if (Array.isArray(choices) && choices.length > 0 && choices[0] !== null && typeof choices[0] === "object") {
    const maybe = (choices[0] as Record<string, unknown>).message;
    if (maybe !== null && typeof maybe === "object") message = maybe as Record<string, unknown>;
  }
  if (typeof message.content === "string") textParts.push(message.content);
  const rawCalls = message.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      if (raw === null || typeof raw !== "object") continue;
      const call = raw as Record<string, unknown>;
      const fn =
        call.function !== null && typeof call.function === "object"
          ? (call.function as Record<string, unknown>)
          : {};
      const callId = call.id;
      const name = (fn.name ?? call.name) as unknown;
      if (typeof callId !== "string" || typeof name !== "string") continue;
      let args: unknown = fn.arguments;
      if (args === null || args === undefined) args = call.arguments;
      let arguments_: string;
      if (typeof args === "string") {
        arguments_ = args;
      } else {
        try {
          arguments_ = pyDumpsSorted(args ?? {});
        } catch {
          arguments_ = String(args);
        }
      }
      calls.push({ id: callId, name, arguments: arguments_ });
    }
  }
  return { calls, text: textParts.join("") };
}

/** Mirrors the harness request key so dedup behaves the same everywhere. */
function requestKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${pyDumpsCompactSortedAscii(args)}`;
}

export interface DriveToolLoopOptions {
  apiFormat: string;
  model: string;
  budgets?: LoopBudgets;
  maxTokens?: number;
  temperature?: number | null;
  stream?: boolean;
  tokensParam?: string;
  cachePrefix?: boolean;
  /** #998: the tier's resolved reasoning effort ("" = omit the field). */
  reasoningEffort?: string;
  /** #998: the Anthropic endpoint opt-in for `output_config.effort`. */
  anthropicEffortSupported?: boolean;
  /** Best-effort summarizer for context compaction; may be async. */
  summarizeFn?: ((block: string) => string | Promise<string>) | null;
  /** Injectable clock (seconds) for deterministic tests. */
  timeFn?: () => number;
  /**
   * #1198: whole-exchange absolute deadline, in timeFn-epoch seconds. When a
   * finite number, the between-rounds check stops as soon as the clock reaches
   * it; unset/null/non-finite preserves the legacy elapsed-since-loop-start check.
   */
  wallClockDeadline?: number | null;
  /** #1199: injectable telemetry clock (seconds) for per-round latency. It is
   * kept separate from `timeFn` so per-round measurement never perturbs the
   * budget clock's scripted sequences; the harness passes a dedicated monotonic
   * clock so the two never share state. Defaults to `performance.now()/1000`. */
  nowFn?: () => number;
  /** #1199: invoked once per model turn with that turn's bounded telemetry. */
  onRound?: (round: NativeLoopRoundTelemetry) => void;
  reserveForRequiredEvidence?: number;
  /** #1381 (review); #1396: the ONE admission-row set for the enforced
   * reservation — one row per outstanding obligation, produced once by the
   * harness. A row carries one of two admission vocabularies:
   * - `tokens`: #1381's deterministic prose vocabulary — the call's argument
   *   VALUES must word-boundary-overlap one token to execute inside the
   *   window (review-owned `must_check` / `trusted_base_guidance` rows);
   * - `obligation`: #1379's dependency-evidence shape vocabulary — the call
   *   is admitted when it is an upstream evidence-channel call whose own
   *   URL/query shape credits that obligation
   *   (`dependencyEvidenceObligationsForCall`), so a real provenance or
   *   advisories fetch is admissible against its own row instead of having
   *   to repeat the obligation's prose.
   * A row drops out of gating once an admitted call attempted it. */
  requiredEvidence?: ReadonlyArray<RequiredEvidenceRow>;
  /**
   * #1379 (blocker 5728634290); #1396: row ids already discharged by an
   * earlier loop over the SAME conversation — the #1145 trace-gap repair
   * seam carries the main loop's obligation state into the continuation
   * so it cannot re-open obligations the main loop already closed. Unknown
   * or non-string ids are ignored, and seeds that match no tracked row are
   * dropped.
   */
  requiredEvidenceCredits?: ReadonlyArray<string>;
  /**
   * #1396 (review): evidence-channel attempts already recorded by an earlier
   * loop over the SAME conversation — the #1145 repair seam threads the main
   * loop's count so the no-lockout attempts cap stays RUN-WIDE: the
   * continuation's shape rows release gating once prior + own attempts reach
   * the cap, never from a reset zero count. Unset (every main loop) starts
   * the count at zero.
   */
  requiredEvidenceAttemptsPrior?: number;
  /**
   * #1396 (review): the attempts-cap threshold, overriding the loop's own
   * (possibly tail-clamped) reserve. The repair seam passes the ORIGINAL
   * unclamped run reserve so the cap cannot shrink across the seam; unset
   * keeps the reserve as the threshold (the main-loop and unit-test shape).
   */
  requiredEvidenceAttemptsCap?: number;
}

/**
 * Run the agentic loop until the model stops or a budget hits (port of
 * `drive_tool_loop`).
 *
 * `postFn` takes a wire-ready request payload and returns the parsed response
 * JSON (throwing on transport failure). `executeFn` takes (toolName, args) and
 * returns the executor result dict `{"tool", "status", "result"}`.
 *
 * The conversation is mutated in place; on return it carries the full
 * transcript (every issued call answered) and can be re-emitted for the
 * verdict turn by the caller.
 */
export async function driveToolLoop(
  conversation: Conversation,
  postFn: (payload: Record<string, unknown>, turn?: ToolTurnSignal) => Promise<unknown>,
  executeFn: (toolName: string, args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
  options: DriveToolLoopOptions,
): Promise<LoopOutcome> {
  const budgets: LoopBudgets = options.budgets ?? adaptiveLoopBudgets(4, 16, 600);
  const maxTokens = options.maxTokens ?? 1024;
  // #747: null means "omit the field" (planningTemperature for an empty
  // AI_TEMPERATURE); only an absent value takes the 0.0 planning default.
  const temperature = options.temperature === undefined ? 0.0 : options.temperature;
  const stream = options.stream ?? false;
  const tokensParam = options.tokensParam ?? "max_tokens";
  const cachePrefix = options.cachePrefix ?? false;
  const summarizeFn = options.summarizeFn ?? null;
  const timeFn = options.timeFn ?? (() => performance.now() / 1000);
  const wallClockDeadline =
    typeof options.wallClockDeadline === "number" && Number.isFinite(options.wallClockDeadline)
      ? options.wallClockDeadline
      : null;
  // #1199: per-round latency rides a monotonic telemetry clock, deliberately
  // distinct from the budget `timeFn` so adding latency measurement never
  // shifts the scripted budget-clock sequences the reliability tests pin.
  const nowFn = options.nowFn ?? (() => performance.now() / 1000);
  const roundSec = (n: number): number => Number(Math.max(0, n).toFixed(3));

  const outcome: LoopOutcome = {
    executed: [],
    rounds: 0,
    toolCallsIssued: 0,
    stopReason: STOP_NO_TOOL_CALLS,
    finalText: "",
    degraded: false,
    error: "",
    requestsRemaining: 0,
    elapsedSec: 0,
    maxToolCalls: budgets.maxToolCalls,
    maxRounds: budgets.maxRounds,
    wallClockSec: budgets.wallClockSec,
    toolResultBytes: 0,
    compactionSummarize: 0,
    compactionTruncate: 0,
    peakConversationTokens: 0,
    requiredEvidenceRequestsHint: Math.max(0, Math.min(budgets.maxToolCalls, Math.floor(options.reserveForRequiredEvidence ?? 0))),
    requiredEvidenceRefusals: 0,
    requiredEvidenceRequired: 0,
    requiredEvidenceCredits: [],
    requiredEvidenceAttempts: 0,
    requiredEvidenceReleased: false,
  };
  // #1396: hoisted unified reserve; 0 disables the whole mechanism (notes and
  // enforcement alike) so a loop with nothing reserved keeps byte-identical
  // legacy behavior. Clamped to the FULL request budget: a one-request run
  // reserves its sole request (the whole budget is the tail — #1379's
  // supported-floor rule), and a prose reservation sized by the harness
  // never exceeds half the budget anyway.
  const reserve = outcome.requiredEvidenceRequestsHint;
  // #1381; #1396: the ONE tracked row set — produced once by the harness,
  // prose obligation rows and dependency-evidence shape rows alike. A row is
  // discharged when an admitted executed call targets it (prose: argument-
  // target token overlap; shape: the call's own URL/query), attempt-based
  // and executor-status-agnostic (the row still needs a verdict disposition
  // to count as SATISFIED — the window guarantees only the ATTEMPT).
  const pendingRows: RequiredEvidenceRow[] = reserve > 0
    ? [...(options.requiredEvidence ?? [])]
    : [];
  // Rows already discharged by an earlier loop over the SAME conversation
  // (the #1145 repair seam seeds them here) start closed; a seed that names
  // no tracked row is dropped.
  const discharged = new Set<string>();
  if (Array.isArray(options.requiredEvidenceCredits)) {
    for (const id of options.requiredEvidenceCredits) {
      if (typeof id !== "string") continue;
      if (pendingRows.some((row) => row.id === id)) discharged.add(id);
    }
  }
  // Attempted upstream evidence-channel calls over the WHOLE RUN, pre-window
  // included (the accepted #1379 residual: a model that already burned
  // `reserve` real upstream lookups the lexical attribution could not
  // classify has demonstrably prioritized upstream). An executor error still
  // counts as an attempt — see DEPENDENCY_EVIDENCE_TOOLS. #1396 (review):
  // the count is run-wide across the #1145 repair seam — a continuation
  // starts from the prior loop's attempts instead of a reset zero, so the
  // cap below can never re-impose gating the run already outspent.
  let evidenceAttempts = Math.max(0, Math.floor(options.requiredEvidenceAttemptsPrior ?? 0));
  // The cap threshold: the loop's own reserve, unless the caller threads the
  // ORIGINAL run-wide reserve across the repair seam (the clamped reserve a
  // short-tailed continuation holds is a budget share, never a fresh cap).
  const attemptsCap = Math.max(0, Math.floor(options.requiredEvidenceAttemptsCap ?? reserve));
  // A row gates while it is undischargeD AND — for dependency-evidence
  // shape rows — the no-lockout attempts cap has not fired: the cap
  // guarantees the window always opens within the tail it reserved, and a
  // reserve of 1 keeps exactly the historical one-call release. Prose rows
  // never take the cap: their overlap vocabulary IS the obligation text,
  // and a refusal consumes nothing, so prose gating can never starve a run
  // (#1388 semantics kept exact).
  const rowActive = (row: RequiredEvidenceRow): boolean =>
    !discharged.has(row.id)
    && !(row.obligation !== undefined && evidenceAttempts >= attemptsCap);
  const hasActiveRow = (): boolean => pendingRows.some((row) => rowActive(row));
  const anyActiveShapeRow = (): boolean =>
    pendingRows.some((row) => row.obligation !== undefined && rowActive(row));
  const anyActiveProseRow = (): boolean =>
    pendingRows.some((row) => row.obligation === undefined && rowActive(row));
  const outstandingShapeObligations = (): DependencyEvidenceObligation[] =>
    pendingRows
      .filter((row) => row.obligation !== undefined && rowActive(row))
      .map((row) => row.obligation as DependencyEvidenceObligation);
  const started = timeFn();
  const telemetryStart = nowFn();
  let callsExecuted = 0;
  const seenKeys = new Set<string>();

  // #1199: emit one bounded telemetry record per model turn. Called from both
  // turn-ending paths (the no-tool-call stop and after tool execution) and
  // from the transport-error catch, so the records cover every model turn:
  // the successful call sites pass `outcome.rounds` (the turn just incremented
  // it — records 1..rounds in order), while the errored turn does not increment
  // `outcome.rounds` and emits round `outcome.rounds + 1` with null usage as
  // the loop's final stop. Reads only live loop state — never tool/model
  // content.
  const emitRound = (
    roundIndex: number,
    requested: number,
    executed: number,
    refused: number,
    deduplicated: number,
    toolElapsedSec: number,
    modelElapsedSec: number,
    usage: UsageTelemetry,
    fellBack: boolean,
  ): void => {
    if (options.onRound === undefined) return;
    options.onRound({
      round: roundIndex,
      model_sec: roundSec(modelElapsedSec),
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      cached_tokens: usage.cachedTokens,
      tools_requested: requested,
      tools_executed: executed,
      tools_refused: refused,
      tools_deduplicated: deduplicated,
      tool_elapsed_sec: roundSec(toolElapsedSec),
      requests_remaining: Math.max(0, budgets.maxToolCalls - callsExecuted),
      rounds_remaining: Math.max(0, budgets.maxRounds - outcome.rounds),
      wall_clock_remaining_sec: roundSec(Math.max(0, budgets.wallClockSec - (nowFn() - telemetryStart))),
      streamed_fallback: fellBack,
    });
  };

  // Python while-else: the else clause (STOP_MAX_ROUNDS) runs only when the
  // loop condition expires naturally — never after a break.
  let broke = false;

  // #1388: the reservation holds back ROUNDS as well as requests. The
  // ceiling starts at `maxRounds` and grows only through the extension below
  // (at most `hint` extra rounds total, and only on progress), so a
  // complying model inside the reserved window can still spend the held-back
  // requests even when the round budget runs out first.
  let roundCeiling = budgets.maxRounds;
  let extensionRounds = 0;
  loop: while (outcome.rounds < roundCeiling) {
    if (
      wallClockDeadline !== null
        ? timeFn() >= wallClockDeadline
        : timeFn() - started > budgets.wallClockSec
    ) {
      outcome.stopReason = STOP_WALL_CLOCK;
      broke = true;
      break;
    }

    // Keep the next request within the advisory context budget by compacting
    // the oldest tool results (newest stay intact). When a summarizer is
    // wired, fold them into a model-generated digest that preserves salient
    // facts; otherwise (or if it frees nothing / fails) fall back to blunt
    // truncation, which is the guaranteed backstop.
    outcome.peakConversationTokens = Math.max(outcome.peakConversationTokens, conversation.approxTokens());
    if (conversation.approxTokens() > budgets.maxConversationTokens) {
      let summarized = 0;
      if (summarizeFn !== null) {
        try {
          summarized = await conversation.summarizeOldestToolResults(
            async (block) => await summarizeFn!(block),
            { keepNewest: budgets.summarizeKeepNewest },
          );
        } catch {
          summarized = 0; // summarization is best-effort
        }
      }
      if (summarized > 0) outcome.compactionSummarize++;
      if (summarized === 0 || conversation.approxTokens() > budgets.maxConversationTokens) {
        outcome.compactionTruncate++;
        conversation.truncateOldestToolResults(budgets.truncatedResultBytes);
      }
    }

    // #701: keep the model exhaustion-aware. Every turn after the first states
    // the remaining request/round budget; near the ceiling it also redirects
    // the remaining spend to blocker hypotheses. Trusted driver text — a
    // turn_note, never inside the untrusted tool-result envelope.
    // #1379; #1396: ONE budget-note selection pass over the unified
    // obligation window. The FIRST request of a reserved run carries the
    // priority note (the ordering rule is driver-owned, not prompt-fragment
    // guidance), and inside the window the regular budget note is replaced
    // by exactly ONE redirect naming the outstanding obligations — a scarce
    // round never carries two budget notes, which is what two side-by-side
    // reservations produced (#1396). The window's call refusals are enforced
    // in the disposition pass below.
    {
      const requestsLeft = budgets.maxToolCalls - callsExecuted;
      // Clamped at 0: extension rounds run past `maxRounds`, and a negative
      // count must never render in the note.
      const roundsLeft = Math.max(0, budgets.maxRounds - outcome.rounds);
      // Same OR condition as the enforced window below: scarce ROUNDS open
      // the reservation too, so the note fires the moment either half of
      // the reservation is what is left.
      const inObligationWindow =
        reserve > 0
        && hasActiveRow()
        && (requestsLeft <= reserve || roundsLeft <= reserve);
      if (outcome.rounds === 0) {
        if (reserve > 0 && hasActiveRow()) {
          conversation.addTurnNote(anyActiveShapeRow()
            ? DEPENDENCY_EVIDENCE_PRIORITY_TURN_NOTE
            : REQUIRED_EVIDENCE_PRIORITY_TURN_NOTE);
        }
      } else {
        // #1396: one pass, one note. With a shape row active the redirect
        // names the outstanding dependency evidence — on the side that is
        // actually scarce (requests, else rounds) — and grows the mixed-run
        // clause when prose rows gate the same window.
        const shapeNoteActive = anyActiveShapeRow();
        const mixedClause = shapeNoteActive && anyActiveProseRow() ? MIXED_WINDOW_CLAUSE : "";
        const note = inObligationWindow
          ? shapeNoteActive
            ? formatNote(requestsLeft <= reserve ? RESERVE_WINDOW_TURN_NOTE : RESERVE_WINDOW_ROUNDS_TURN_NOTE, {
                requestsLeft,
                roundsLeft,
                outstanding: formatOutstandingObligations(outstandingShapeObligations()),
              }) + mixedClause
            : REQUIRED_EVIDENCE_TURN_NOTE
          : requestsLeft <= LOW_TOOL_REQUESTS_REMAINING
            ? LOW_BUDGET_TURN_NOTE
            : BUDGET_TURN_NOTE;
        conversation.addTurnNote(
          formatNote(note, {
            reservedCount: reserve,
            requestsLeft,
            requestsTotal: budgets.maxToolCalls,
            roundsLeft,
            roundsTotal: roundCeiling,
          }),
        );
      }
    }

    const payload = conversation.toRequestPayload(options.apiFormat, options.model, {
      stream,
      maxTokens,
      temperature,
      tokensParam,
      cachePrefix,
      // #998: the tier's effort rides every loop round (and the summarizer
      // turn the harness builds from the same options), verbatim.
      reasoningEffort: options.reasoningEffort ?? "",
      anthropicEffortSupported: options.anthropicEffortSupported ?? false,
    });
    let response: unknown;
    // #1199: the turn's telemetry. `modelElapsedSec` spans the whole wait for a
    // usable response (including a streamed→non-streamed retry, which `postFn`
    // folds into this one call), and `roundFellBack` is set by `postFn` through
    // the `turnSignal` only when that fallback actually fired this turn.
    let roundFellBack = false;
    const turnSignal: ToolTurnSignal = { reportFallback: () => { roundFellBack = true; } };
    const modelStart = nowFn();
    try {
      response = await postFn(payload, turnSignal);
    } catch (exc) {
      // Transport errors end the loop. #1199: the errored turn is still a
      // model turn — emit its record (round index rounds + 1, null usage,
      // no tool activity) before stopping. `outcome.rounds` is NOT
      // incremented: it stays the count of turns that returned a response
      // (the anchor for `usage.rounds_used`, stop reasons, and budget notes).
      outcome.stopReason = STOP_REQUEST_ERROR;
      outcome.error = exc instanceof Error ? exc.message : String(exc);
      emitRound(
        outcome.rounds + 1,
        0,
        0,
        0,
        0,
        0,
        Math.max(0, nowFn() - modelStart),
        normalizeUsageTelemetry(null, options.apiFormat),
        roundFellBack,
      );
      broke = true;
      break;
    }
    const modelElapsedSec = Math.max(0, nowFn() - modelStart);
    const usageObj = response !== null && typeof response === "object"
      ? (response as Record<string, unknown>).usage ?? null
      : null;
    const turnUsage = normalizeUsageTelemetry(usageObj, options.apiFormat);

    outcome.rounds++;
    const { calls, text } = extractToolCalls(response, options.apiFormat);

    if (calls.length === 0) {
      outcome.finalText = text;
      outcome.stopReason = outcome.toolCallsIssued > 0 ? STOP_MODEL_DONE : STOP_NO_TOOL_CALLS;
      emitRound(outcome.rounds, 0, 0, 0, 0, 0, modelElapsedSec, turnUsage, roundFellBack);
      broke = true;
      break;
    }

    if (text) {
      // Interleaved reasoning text rides along inside the same assistant turn
      // on the wire; Conversation stores it as a separate event, which both
      // renderers merge correctly.
      conversation.addAssistantText(text);
    }
    conversation.addAssistantToolCalls(calls);
    outcome.toolCallsIssued += calls.length;

    // Decide each call's disposition SEQUENTIALLY — dedup (seenKeys) and the
    // budget counter are stateful and must stay deterministic and call-ordered.
    // Only the to-run executions are then fanned out concurrently: the executor
    // is read-only and a round's calls are independent (the model emitted them
    // together). Results are applied in the original call order to preserve
    // the open-call contract.
    type Disposition = { callId: string; kind: "error" | "dup" | "budget" | "reserve"; data: Record<string, unknown> } | { callId: string; kind: "exec"; data: number };
    const plan: Disposition[] = [];
    const toExecute = new Map<number, { name: string; args: Record<string, unknown> }>();
    // #1199: per-round disposition counts (a tri-partition of `calls.length`:
    // executed + refused + deduplicated === requested). Refusals cover the
    // invalid-argument error, the over-budget note, and the #1379
    // reserve-window refusal.
    let roundExecuted = 0;
    let roundRefused = 0;
    let roundDedup = 0;
    // #1396: rows this round's admitted calls discharged — the ONLY progress
    // that can earn a round-ceiling extension below (an evidence fetch that
    // executes but credits nothing must not buy extension rounds).
    let rowsDischargedThisRound = 0;
    for (let idx = 0; idx < calls.length; idx++) {
      const call = calls[idx]!;
      const callId = call.id;
      // Arguments arrive as an opaque JSON string (#233 contract); parse here,
      // and on failure answer with a repairable error instead of crashing the
      // loop — weak models misquote JSON.
      let args: unknown;
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          throw new Error("arguments must be a JSON object");
        }
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        plan.push({
          callId,
          kind: "error",
          data: { error: `Invalid tool arguments (not a JSON object): ${message}` },
        });
        roundRefused++;
        continue;
      }
      const key = requestKey(call.name, args as Record<string, unknown>);
      if (seenKeys.has(key)) {
        plan.push({ callId, kind: "dup", data: { note: DUPLICATE_NOTE } });
        roundDedup++;
        continue;
      }
      if (callsExecuted >= budgets.maxToolCalls) {
        plan.push({ callId, kind: "budget", data: { error: BUDGET_NOTE } });
        roundRefused++;
        continue;
      }
      // #1381 (review); #1388; #1396: the ONE enforced obligation window over
      // every row kind. A call that targets a pending row has ATTEMPTED
      // (discharged) it whether or not the window is open yet — the
      // recommended path gathers that evidence EARLY, and the window must
      // never re-demand (or hold shut for) evidence already gathered.
      // Admission vocabulary is per row: prose rows gate on argument-VALUE
      // overlap (the `run_command` catalog gets no exemption — a catalog
      // command whose name IS the obligation evidence stays admissible);
      // dependency-evidence shape rows gate on the call's own URL/query.
      // Inside the window a call executes ONLY when it targets an active
      // row, or it is an upstream evidence-channel call while a shape row is
      // active — #1379's no-lockout escape hatch: an evidence fetch counts
      // toward the attempts cap even when lexical attribution gives it
      // nothing, so a model genuinely looking upstream is never refused its
      // way down the reserved tail (the cross-starvation #1396 was filed
      // for: each side-by-side reservation blocking the other's hatch).
      // Everything else is refused WITHOUT consuming budget (like the dedup
      // note) and is NOT added to the dedup set (a retry after the window
      // releases runs for real). The window opens when the remaining
      // REQUESTS drop to the reservation OR the remaining ROUNDS do (rounds
      // remaining, counting the current one).
      if (reserve > 0 && hasActiveRow()) {
        const targets = pendingRows.filter(
          (row) => !discharged.has(row.id) && rowAdmittedByCall(row, call.name, args as Record<string, unknown>),
        );
        const inWindow = budgets.maxToolCalls - callsExecuted <= reserve
          || budgets.maxRounds - (outcome.rounds - 1) <= reserve;
        if (inWindow && targets.length === 0 && !(DEPENDENCY_EVIDENCE_TOOLS.has(call.name) && anyActiveShapeRow())) {
          plan.push({
            callId,
            kind: "reserve",
            data: {
              error: anyActiveShapeRow()
                ? formatNote(RESERVE_REFUSAL_NOTE, {
                    outstanding: formatOutstandingObligations(outstandingShapeObligations()),
                  }) + (anyActiveProseRow() ? MIXED_WINDOW_CLAUSE : "")
                : REQUIRED_EVIDENCE_REFUSAL_NOTE,
            },
          });
          roundRefused++;
          outcome.requiredEvidenceRefusals++;
          continue;
        }
        for (const row of targets) {
          discharged.add(row.id);
          rowsDischargedThisRound++;
        }
      }
      seenKeys.add(key);
      callsExecuted++;
      if (DEPENDENCY_EVIDENCE_TOOLS.has(call.name)) {
        // Attempts count for ANY executed-planned evidence-channel call —
        // window, target, and executor status irrelevant (a refused host or
        // failed fetch still counts). Discharge rides `targets` above, so a
        // redundant call whose every match is already credited opens
        // nothing.
        evidenceAttempts++;
      }
      toExecute.set(idx, { name: call.name, args: args as Record<string, unknown> });
      plan.push({ callId, kind: "exec", data: idx });
      roundExecuted++;
    }

    // Fan out the executions (read-only, independent within a round).
    const resultsByIdx = new Map<number, Record<string, unknown>>();
    // #1199: the round's tool execution window (the concurrent fan-out only;
    // the sequential disposition decisions above are not tool time).
    let toolElapsedSec = 0;
    if (toExecute.size > 0) {
      const toolStart = nowFn();
      const entries = [...toExecute.entries()];
      const settled = await Promise.all(
        entries.map(async ([idx, { name, args }]) => {
          try {
            return [idx, await executeFn(name, args)] as const;
          } catch (exc) {
            // A throwing executor must not crash the loop; surface as an
            // executor-shaped error result.
            return [
              idx,
              { tool: name, status: "error", result: { error: exc instanceof Error ? exc.message : String(exc) } },
            ] as const;
          }
        }),
      );
      for (const [idx, result] of settled) resultsByIdx.set(idx, result);
      toolElapsedSec = Math.max(0, nowFn() - toolStart);
    }

    // Apply results in call order (synthetic refusals inline).
    for (const disposition of plan) {
      if (disposition.kind !== "exec") {
        conversation.addToolResult(disposition.callId, disposition.data, { isError: true });
        continue;
      }
      const exec = toExecute.get(disposition.data)!;
      const result = resultsByIdx.get(disposition.data)!;
      outcome.executed.push({ tool: exec.name, args: exec.args, result });
      try {
        outcome.toolResultBytes += Buffer.byteLength(
          pyDumps((result.result ?? {}) as unknown),
          "utf8",
        );
      } catch {
        // never let telemetry break the loop
      }
      conversation.addToolResult(disposition.callId, result.result ?? {}, {
        isError: result.status !== "ok",
        tool: exec.name,
        provenance: (result as { provenance?: EvidenceProvenance }).provenance,
        // #1043 (review): read_skill results carry the complete trusted-base
        // skill body — the executor never truncates one, and the default
        // tool-result budget here must not silently re-truncate it at
        // conversation append. The executor has verified the serialized
        // result fits exactly this budget, so `content_complete: true` holds
        // end to end.
        ...(exec.name === "read_skill" ? { maxBytes: SKILL_RESULT_MAX_BYTES } : {}),
      });
    }

    // #1199: the turn's telemetry, emitted once per model turn. A round that
    // ends on budget exhaustion still records its turn before the stop below.
    emitRound(outcome.rounds, calls.length, roundExecuted, roundRefused, roundDedup, toolElapsedSec, modelElapsedSec, turnUsage, roundFellBack);

    // #1388; #1396: round-ceiling extension for the reserved window.
    // Extension is earned ONLY at the (current) ceiling and only on
    // progress — a row DISCHARGE: the round that just ended is the
    // "immediately previous round" of the extension round it buys, and
    // inside the window every admitted call removes a row, so a progress
    // round is self-limiting (at most the initial tracked-row count across
    // the whole loop). A hostile model emitting only refused calls executes
    // nothing and gets ZERO extra rounds (it stops at `maxRounds` with the
    // reserved requests intact), and since #1396 an evidence fetch that
    // executes but discharges nothing cannot buy extension rounds either.
    if (
      reserve > 0
      && extensionRounds < reserve
      && outcome.rounds >= roundCeiling
      && hasActiveRow()
      && callsExecuted < budgets.maxToolCalls
      && rowsDischargedThisRound > 0
    ) {
      roundCeiling++;
      extensionRounds++;
    }

    if (callsExecuted >= budgets.maxToolCalls) {
      outcome.stopReason = STOP_BUDGET;
      broke = true;
      break loop;
    }
  }
  if (!broke) {
    outcome.stopReason = STOP_MAX_ROUNDS;
  }

  outcome.degraded = outcome.toolCallsIssued === 0;
  // #1379 (blocker 5728634290); #1396: the obligation state is written once
  // here so every exit path (transport-error stop, no-tool-call stop,
  // budget, rounds, wall clock) reports exactly what the loop ended with.
  outcome.requiredEvidenceRequired = pendingRows.length;
  outcome.requiredEvidenceCredits = pendingRows
    .filter((row) => discharged.has(row.id))
    .map((row) => row.id);
  outcome.requiredEvidenceAttempts = evidenceAttempts;
  outcome.requiredEvidenceReleased = reserve <= 0 || !hasActiveRow();
  // #702: close out the telemetry on every exit path.
  outcome.requestsRemaining = Math.max(0, budgets.maxToolCalls - callsExecuted);
  outcome.elapsedSec = timeFn() - started;
  return outcome;
}
