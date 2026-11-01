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

/** Default #1379 reserve: the budget tail the driver holds for required
 * dependency evidence once the classification says the PR is a
 * dependency-update shape. The harness clamps it to the budget: budgets of
 * two or more keep one unreserved head request, and the minimum budget of
 * one reserves its sole request (see dependencyEvidenceReserveFromClassification). */
export const DEPENDENCY_EVIDENCE_RESERVE = 4;

function formatNote(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => String(values[key] ?? ""));
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
  /** #1379: the dependency-evidence reserve the caller configured (0 when
   * none — non-dependency PRs keep the exact legacy behavior). Echoed for
   * budget provenance; counts nothing about tool content. */
  priorityEvidenceReserve: number;
  /** #1379: true once the loop has executed at least one dependency-evidence
   * tool call (see DEPENDENCY_EVIDENCE_TOOLS), whatever its executor status.
   * Pure telemetry since review blocker 5728634290 — the window rule now keys
   * on priorityEvidenceReleased. Meaningful regardless of reserve
   * configuration (the executor never refuses a call when no reserve is
   * set). */
  priorityEvidenceAttempted: boolean;
  /** #1379: how many tool calls the reserve-window rule refused while the
   * obligations were unmet. These refusals consumed no request budget. */
  priorityEvidenceRefusals: number;
  /** #1379 (blocker 5728634290): the number of obligations the reserve
   * actually commits to — min(DEPENDENCY_EVIDENCE_OBLIGATIONS.length,
   * reserve), the tracked prefix the reserved tail can pay for. 0 when no
   * reserve is configured. */
  priorityEvidenceRequired: number;
  /** #1379 (blocker 5728634290): the tracked obligations covered by executed
   * evidence calls (attributed from each call's own target) plus the ids
   * seeded through priorityEvidenceCredits, in canonical order. */
  priorityEvidenceCredits: string[];
  /** #1379 (blocker 5728634290): executed dependency-evidence calls over the
   * whole run, whatever their target or executor status. The no-lockout cap:
   * the window releases once this reaches the reserve even if nothing was
   * credited. */
  priorityEvidenceAttempts: number;
  /** #1379 (blocker 5728634290): whether the reserved window was released at
   * loop end — reserve 0 (always open), every tracked obligation credited,
   * or the attempts cap reached. */
  priorityEvidenceReleased: boolean;
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
  /**
   * #1379: size of the request-budget tail reserved for required dependency
   * evidence, set by the harness when the PR's classification is a
   * dependency-update kind. 0/absent preserves the legacy behavior exactly.
   * Deterministic driver enforcement: a priority note precedes the FIRST
   * request; once the remaining requests enter the reserve window the budget
   * note is replaced by the dependency-evidence redirect AND any non-evidence
   * tool call is refused (executing nothing and spending no reserved
   * request) until every tracked obligation is credited or the attempts cap
   * releases the window (see dependencyEvidenceObligationsForCall).
   */
  priorityEvidenceReserve?: number;
  /**
   * #1379 (blocker 5728634290): obligation ids already credited by an
   * earlier loop over the SAME conversation — the #1145 trace-gap repair
   * seam carries the main loop's per-obligation state into the continuation
   * so it cannot re-open obligations the main loop already closed. Unknown
   * or non-string ids are ignored, and seeds outside the tracked prefix are
   * dropped.
   */
  priorityEvidenceCredits?: string[];
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
    priorityEvidenceReserve: Math.max(0, options.priorityEvidenceReserve ?? 0),
    priorityEvidenceAttempted: false,
    priorityEvidenceRefusals: 0,
    priorityEvidenceRequired: 0,
    priorityEvidenceCredits: [],
    priorityEvidenceAttempts: 0,
    priorityEvidenceReleased: false,
  };
  // #1379: hoisted reserve size; 0 disables the whole mechanism (notes and
  // enforcement alike) so non-dependency PRs keep the legacy loop behavior.
  const priorityReserve = outcome.priorityEvidenceReserve;
  // #1379 (blocker 5728634290): per-obligation state. The reserve commits
  // only the obligations its tail can actually pay for — the tracked prefix
  // of the canonical list — and the window stays closed to non-evidence
  // calls until every tracked obligation is credited from an executed
  // evidence call's own target or the attempts cap opens it (no lockout).
  const priorityEvidenceRequired =
    priorityReserve > 0 ? Math.min(DEPENDENCY_EVIDENCE_OBLIGATIONS.length, priorityReserve) : 0;
  const trackedObligations = DEPENDENCY_EVIDENCE_OBLIGATIONS.slice(0, priorityEvidenceRequired);
  const priorityCredits = new Set<DependencyEvidenceObligation>();
  if (Array.isArray(options.priorityEvidenceCredits)) {
    for (const id of options.priorityEvidenceCredits) {
      if (
        typeof id === "string" &&
        trackedObligations.includes(id as DependencyEvidenceObligation)
      ) {
        priorityCredits.add(id as DependencyEvidenceObligation);
      }
    }
  }
  // Attempt state: set when any disposition plans to execute a
  // dependency-evidence tool call (an executor error still counts as an
  // attempt and still credits — see DEPENDENCY_EVIDENCE_TOOLS).
  let priorityEvidenceAttempted = false;
  let priorityEvidenceAttempts = 0;
  // released ⇔ nothing reserved, or every tracked obligation is credited,
  // or the loop spent the whole reserve on evidence attempts. The attempts
  // cap guarantees the window always opens within the tail it reserved, and
  // a reserve of 1 keeps exactly the historical one-call release.
  //
  // The cap counts attempts over the WHOLE run, pre-window included (accepted
  // residual from the independent review of this delta): a model that already
  // burned `reserve` real upstream lookups the lexical attribution could not
  // classify has demonstrably prioritized upstream, and refusing it the tail
  // anyway would punish an attribution gap rather than a priority gap.
  // Run-wide counting is also what keeps the historical reserve-1 release
  // byte-identical.
  const evidenceReleased = (): boolean =>
    priorityReserve <= 0 ||
    trackedObligations.every((obligation) => priorityCredits.has(obligation)) ||
    priorityEvidenceAttempts >= priorityReserve;
  const outstandingObligations = (): DependencyEvidenceObligation[] =>
    trackedObligations.filter((obligation) => !priorityCredits.has(obligation));
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

  loop: while (outcome.rounds < budgets.maxRounds) {
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
    // #1379: when a dependency-evidence reserve is configured, the FIRST
    // request carries the priority note (the ordering rule is driver-owned,
    // not prompt-fragment guidance), and inside the reserve window the budget
    // note is replaced by the dependency-evidence redirect (the window's call
    // refusals are enforced in the disposition pass below).
    {
      const requestsLeft = budgets.maxToolCalls - callsExecuted;
      const roundsLeft = budgets.maxRounds - outcome.rounds;
      const inReserveWindow =
        priorityReserve > 0 &&
        requestsLeft <= priorityReserve &&
        outcome.rounds > 0 &&
        !evidenceReleased();
      if (outcome.rounds === 0 && priorityReserve > 0) {
        conversation.addTurnNote(DEPENDENCY_EVIDENCE_PRIORITY_TURN_NOTE);
      } else if (outcome.rounds > 0) {
        const note = inReserveWindow
          ? formatNote(RESERVE_WINDOW_TURN_NOTE, {
              requestsLeft,
              outstanding: formatOutstandingObligations(outstandingObligations()),
            })
          : requestsLeft <= LOW_TOOL_REQUESTS_REMAINING
            ? LOW_BUDGET_TURN_NOTE
            : BUDGET_TURN_NOTE;
        conversation.addTurnNote(
          formatNote(note, {
            requestsLeft,
            requestsTotal: budgets.maxToolCalls,
            roundsLeft,
            roundsTotal: budgets.maxRounds,
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
      // #1379 (blocker 5728634290): the enforceable reserve. Inside the
      // reserve window, while not every tracked obligation is credited and
      // the attempts cap is not reached, a non-evidence call is refused
      // outright: it executes nothing, is NOT added to the dedup set (a
      // retry after the window releases must not be answered from a stale
      // duplicate note), and spends none of the reserved requests. An
      // evidence call is never refused; executing one spends the request,
      // counts toward the attempts cap, and credits the obligations its own
      // target attributes (whatever the executor returned).
      if (
        priorityReserve > 0 &&
        !evidenceReleased() &&
        budgets.maxToolCalls - callsExecuted <= priorityReserve &&
        !DEPENDENCY_EVIDENCE_TOOLS.has(call.name)
      ) {
        plan.push({
          callId,
          kind: "reserve",
          data: {
            error: formatNote(RESERVE_REFUSAL_NOTE, {
              outstanding: formatOutstandingObligations(outstandingObligations()),
            }),
          },
        });
        roundRefused++;
        outcome.priorityEvidenceRefusals++;
        continue;
      }
      seenKeys.add(key);
      callsExecuted++;
      if (DEPENDENCY_EVIDENCE_TOOLS.has(call.name)) {
        priorityEvidenceAttempted = true;
        priorityEvidenceAttempts++;
        for (const obligation of dependencyEvidenceObligationsForCall(
          call.name,
          args as Record<string, unknown>,
        )) {
          // Credits apply to ANY executed evidence call, pre-window included;
          // a redundant call whose every match is already credited adds
          // nothing and must not open the window.
          if (trackedObligations.includes(obligation) && !priorityCredits.has(obligation)) {
            priorityCredits.add(obligation);
          }
        }
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
  // #1379 (blocker 5728634290): the obligation state is written once here so
  // every exit path (transport-error stop, no-tool-call stop, budget, rounds,
  // wall clock) reports exactly what the loop ended with.
  outcome.priorityEvidenceAttempted = priorityEvidenceAttempted;
  outcome.priorityEvidenceAttempts = priorityEvidenceAttempts;
  outcome.priorityEvidenceRequired = priorityEvidenceRequired;
  outcome.priorityEvidenceCredits = trackedObligations.filter((obligation) =>
    priorityCredits.has(obligation),
  );
  outcome.priorityEvidenceReleased = evidenceReleased();
  // #702: close out the telemetry on every exit path.
  outcome.requestsRemaining = Math.max(0, budgets.maxToolCalls - callsExecuted);
  outcome.elapsedSec = timeFn() - started;
  return outcome;
}
