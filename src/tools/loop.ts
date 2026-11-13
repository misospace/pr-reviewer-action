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
  DEFAULT_PROTECTED_NEWEST_RESULTS,
  pyDumps,
  pyDumpsCompactSortedAscii,
  pyDumpsSorted,
  type ToolCallRecord,
} from "../model/conversation.js";
import type { EvidenceProvenance } from "../context/evidence-provenance.js";
import { SKILL_RESULT_MAX_BYTES } from "../context/repository-skills.js";
import { normalizeUsageTelemetry, type UsageTelemetry } from "../model/telemetry.js";
import { type TransportTiming } from "../transport/timing.js";
// #1628: type-only import — `stream-attempt.ts` imports this module's
// `extractToolCalls` as a value, so the back edge must stay erased at runtime.
import type { StreamedAttemptFailureRecord } from "./stream-attempt.js";
import { MAX_GROUP_NAME_CHARS, MAX_GROUPS_PER_RULE } from "../enforcement/requirement-trace.js";
// #1659: the canonical settlement record — the loop is the single settlement
// authority for the rows it tracks, and finalization consumes these receipts.
import { executedCallId } from "../enforcement/executed-calls.js";
import {
  type LoopEvidenceSettlement,
  type SettlementObligationSource,
} from "../enforcement/settlement.js";
import {
  traceSeamSlotForTarget,
  traceTargetIsTestRead,
  type TraceProofShape,
  type TraceSeamHint,
} from "../requirements/trace-plan.js";

// Stop reasons (LoopOutcome.stopReason)
export const STOP_MODEL_DONE = "model-stopped";
export const STOP_NO_TOOL_CALLS = "no-tool-calls";
export const STOP_MAX_ROUNDS = "max-rounds";
export const STOP_BUDGET = "tool-call-budget-exhausted";
export const STOP_WALL_CLOCK = "wall-clock-exceeded";
export const STOP_WALL_CLOCK_RESERVE = "wall-clock-verdict-reserve";
export const STOP_REQUEST_ERROR = "request-error";
/**
 * #1627: the deterministic early stop. When the run carried an obligation
 * surface that was ACTIVE at some point and every tracked row has since
 * settled (discharged by an admitted call, or cap-released as unprovable),
 * further rounds can only be optional exploration — the loop stops here and
 * the caller proceeds to the verdict from the warm conversation. A normal,
 * verdict-producing stop by design: never a harness error, never a fallback
 * trigger, and deliberately NOT a budget stop (no rounds were exhausted —
 * the mandatory work is done). */
export const STOP_OBLIGATIONS_SETTLED = "obligations-settled";

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

/**
 * #1506: the FIRST-request priority note when the outstanding rows are
 * requirement-trace rows. The rows live in the Requirement Trace Plan
 * section of the planning context, NOT in the Required Review Evidence
 * section, and the note must say so: a model told to work on the wrong
 * section spends the reserved tail on calls the reservation refuses.
 *
 * The note names the section and the outstanding requirement IDs. It never
 * quotes the requirement TEXT: the text is untrusted content, and a turn
 * note is trusted driver text. The model already holds the text — the
 * section is in its planning context.
 */
export const TRACE_EVIDENCE_PRIORITY_TURN_NOTE =
  "[loop budget] In-scope requirement evidence comes first: for every code-verifiable requirement in the " +
  "Requirement Trace Plan section, attempt the evidence its row marker names — a runtime row needs BOTH " +
  "the enforcement location AND a matching regression test, a structural-state row the repository state " +
  "it names (a regression test only when its own text demands one), a distributed row every seam — with " +
  "repository reads and searches BEFORE spending calls on optional exploration (claim falsification, " +
  "history greps, redundant local reads).";

// #1506: the window note for the requirement-trace rows: it names the
// outstanding requirement ids and the tools that can discharge them, so the
// reserved tail is spent on the merge-gating evidence and not on the calls
// the reservation refuses.
const TRACE_RESERVE_WINDOW_TURN_NOTE =
  "[loop budget] Only {requestsLeft} tool request(s) remain and they are reserved for the in-scope " +
  "requirement evidence still outstanding: {outstanding}. Those requirements are listed in the " +
  "Requirement Trace Plan section — spend the reserved requests on repository reads and searches " +
  "(read_file, find_files, list_tree, git_grep, git_log, git_blame) that name their files or terms. " +
  "Optional calls are now refused, not executed. If the evidence cannot be located, report what is " +
  "missing rather than approximating it.";

const TRACE_RESERVE_WINDOW_ROUNDS_TURN_NOTE =
  "[loop budget] Only {roundsLeft} loop turn(s) remain and they are reserved for the in-scope " +
  "requirement evidence still outstanding: {outstanding}. Those requirements are listed in the " +
  "Requirement Trace Plan section — spend the reserved turns on repository reads and searches " +
  "(read_file, find_files, list_tree, git_grep, git_log, git_blame) that name their files or terms. " +
  "Optional calls are now refused, not executed. If the evidence cannot be located, report what is " +
  "missing rather than approximating it.";

// #1506: the refusal a call that named no outstanding requirement row gets
// inside the reserved window.
const TRACE_RESERVE_REFUSAL_NOTE =
  "Reserved requirement-evidence budget: this call was not executed and spent none of the remaining " +
  "requests. The reserved tail still owes {outstanding} — those requirements are listed in the " +
  "Requirement Trace Plan section. Make a repository read or search that names their files or terms, " +
  "or finish now and report the missing evidence as unknown / needs verification.";

// #1506: a run can hold BOTH the requirement-trace rows and the review-owned
// prose rows: the note then says which other rows the reservation also
// covers, so the model is never told the requirement rows are the only way
// out of the window.
const TRACE_WINDOW_CLAUSE =
  " The reservation also covers the unresolved in-scope requirements from the Requirement Trace Plan section — a repository read or search that names one of those executes as well.";
const PROSE_WINDOW_CLAUSE =
  " The reservation also covers the unresolved rows of the Required Review Evidence section — a call that targets one of those executes as well.";

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
 *   spent the whole reserve on evidence attempts INSIDE the enforced window
 *   (the no-lockout cap counts gated attempts only; evidence calls spent
 *   before the window opened drain the run-wide telemetry counter, never
 *   the cap), any other tool call
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

/** #1595: the priority note names exactly the obligations the classification
 * still tracks. When that set is the FULL canonical trio the emitted text is
 * the existing static note byte-for-byte (tests pin it); a STRICT SUBSET —
 * the #1595 lockfile-only advisory reservation — gets a note naming only
 * what is owed: steering that run at the full provenance → release-delta →
 * advisories trio would burn the reserved tail on obligations the scoped
 * must_check scoped away, leaving the one tracked obligation ungathered and
 * the review partial (#1579's symptom). Trusted driver text, deterministic
 * from the tracked set, never model-chosen. */
export function dependencyEvidencePriorityTurnNote(tracked: readonly DependencyEvidenceObligation[]): string {
  const distinct = DEPENDENCY_EVIDENCE_OBLIGATIONS.filter((obligation) => tracked.includes(obligation));
  // Full trio → the pinned static note. An EMPTY tracked set is unreachable
  // at the call site (the note only fires when a shape row is active, so at
  // least one obligation is outstanding) and conservatively keeps the
  // full-set note — the stronger steering, never a weaker one.
  if (distinct.length === 0) return DEPENDENCY_EVIDENCE_PRIORITY_TURN_NOTE;
  if (distinct.length === DEPENDENCY_EVIDENCE_OBLIGATIONS.length) return DEPENDENCY_EVIDENCE_PRIORITY_TURN_NOTE;
  return (
    "[loop budget] Required dependency evidence comes first: check " +
    formatOutstandingObligations(distinct) +
    " (or record the check as not performed) BEFORE spending tool calls on " +
    "optional archaeology, claim falsification, history greps, or redundant " +
    "local-diff confirmation."
  );
}
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
 * #1595 (review): the lead-claim variants of the two reserve notes above.
 * When the dependency-evidence plan is SCOPED (tracked obligations a strict
 * subset of the canonical trio), the obligation window is enforced from the
 * loop's FIRST request — not only the reserved tail — so the mandatory
 * evidence gets its bounded first claim on the existing budget ahead of
 * optional archaeology. These variants speak mid-budget (the tail is not yet
 * scarce), so the tail-worded "Only N requests remain" / "reserved tail"
 * texts would be false: the turn note names what is still owed, and the
 * refusal says the budget's first claim owes it. The mixed-window clause is
 * appended by the selection pass exactly as for the tail-scarce notes. */
const RESERVE_LEAD_CLAIM_TURN_NOTE =
  "[loop budget] Required dependency evidence comes first: {outstanding} is still owed, " +
  "reached through web_fetch (plus web_search when that tool is offered to you). " +
  "Until it is claimed, optional and local-diff calls are refused, not executed.";

const RESERVE_LEAD_CLAIM_REFUSAL_NOTE =
  "Reserved dependency-evidence budget: this call was not executed and spent " +
  "none of the remaining requests. The budget's first claim still owes " +
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

// Source hosts: only the host's canonical repository URL counts as a
// provenance lookup — owner/repo on github.com/gitlab.com/bitbucket.org,
// org/project/_git/repo on dev.azure.com. A shallower path identifies no
// repository (a profile/user page, a bare host, an Azure organization or
// project), and a deeper path is doing something else (release pages,
// advisories, files) — review blocker 5738958165: a profile URL must not
// credit provenance and release the obligation window without an
// owner/repository lookup ever having been attempted.
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
 * evidence call executed inside the enforced window still counts toward the
 * no-lockout attempts cap, just credits nothing; pre-window it counts only
 * toward the run-wide attempts telemetry).
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
      const segments = path.split("/").filter((segment) => segment !== "");
      if (host === "dev.azure.com") {
        // Azure DevOps' canonical repository URL is org/project/_git/repo;
        // org or org/project name an organization/project, not a repository.
        if (segments.length === 4 && segments[2] === "_git") matched.add("provenance");
      } else if (segments.length === 2) {
        matched.add("provenance");
      }
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
  /** #1506: the closed set of tools that may discharge this row. Absent
   * means any tool may — the #1381 prose rows behave exactly as before. */
  tools?: readonly string[];
  /** #1506: the row is a merge-gating requirement-trace row, not a
   * review-owned prose row. */
  trace?: boolean;
  /** #1659: for a prose row, the obligation source from the candidates
   * artifact — the settlement record's materiality derives from it
   * (must_check/derived/risk are material, trusted_base_guidance is
   * advisory). Absent on dependency shape rows and trace rows. */
  source?: SettlementObligationSource;
  /** #1519: for a requirement-trace row, the distinct admitted repository
   * reads the row needs before it is discharged and its reserved share
   * releases: a runtime row needs BOTH the enforcement location and the
   * matching regression test attempted, a structural-state row one checkout
   * read (two when its text demands a test), a distributed row an
   * enforcement read and a test read per seam. Absent means one admitted
   * call discharges — the behavior every non-trace row keeps. */
  requiredAttempts?: number;
  /** #1519 (review): the row's evidence shape (trace rows only). The
   * discharge is SLOT-aware: a runtime row (and a structural row whose text
   * demands a test) owes one ENFORCEMENT read and one TEST read — evidence
   * CATEGORIES, not any two reads; a distributed row owes both per declared
   * seam, attributed with the same per-seam matching the deterministic
   * validator applies. Absent for non-trace rows, which keep exactly the
   * pre-#1519 behavior. */
  proofShape?: TraceProofShape;
  /** #1519 (review): the row's full seam hints (trace rows only), with the
   * trusted owner/test glob patterns per-seam evidence is matched against. */
  seams?: readonly TraceSeamHint[];
}

/** #1396: whether one call admits (counts toward discharging) one pending row. */
function rowAdmittedByCall(
  row: RequiredEvidenceRow,
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (row.obligation !== undefined) {
    return dependencyEvidenceObligationsForCall(name, args).includes(row.obligation);
  }
  // #1506: a row with a tool allow-list is discharged ONLY by a call through
  // one of those tools — the requirement evidence is repository reads, so a
  // call through any other tool never satisfies the row.
  if (row.tools !== undefined && !row.tools.includes(name)) return false;
  const target = argumentTargetText(args);
  return row.tokens.some((token) => targetMentions(target, token));
}

/**
 * #1519 (review): ONE evidence slot a trace row must see credited before it
 * discharges — an enforcement read, a regression-test read, or (single-slot
 * rows) any admitted repository read. The KEY encodes the seam index for
 * distributed rows (`"<index>:enforcement"` / `"<index>:test"`) so credit is
 * attributed per seam exactly the way the deterministic validator matches
 * citations to groups.
 */
interface TraceEvidenceSlot {
  key: string;
  kind: "enforcement" | "test" | "any";
}

/**
 * #1519 (review): the FULL slot demand of a trace row. A runtime row and a
 * structural row whose own text demands a regression test
 * (`required_attempts === 2`) owe one enforcement read and one test read; a
 * distributed row owes both per declared seam (capped at the validator's
 * group bound, consistent with its `required_attempts` derivation); every
 * other shape stays a single any-category slot (the pre-#1519 behavior).
 * Non-trace rows owe no slots — their one-call discharge is unchanged.
 */
function traceRowSlots(row: RequiredEvidenceRow): TraceEvidenceSlot[] {
  if (row.trace !== true) return [];
  if (row.proofShape === "distributed" && Array.isArray(row.seams) && row.seams.length > 0) {
    const slots: TraceEvidenceSlot[] = [];
    const count = Math.min(row.seams.length, MAX_GROUPS_PER_RULE);
    for (let index = 0; index < count; index += 1) {
      slots.push({ key: `${index}:enforcement`, kind: "enforcement" });
      slots.push({ key: `${index}:test`, kind: "test" });
    }
    return slots;
  }
  if (row.requiredAttempts === 2) {
    return [
      { key: "enforcement", kind: "enforcement" },
      { key: "test", kind: "test" },
    ];
  }
  return [{ key: "any", kind: "any" }];
}

/** The slots of a trace row no credited call has covered yet. */
function traceUnmetSlots(row: RequiredEvidenceRow, credited: ReadonlySet<string> | undefined): TraceEvidenceSlot[] {
  return traceRowSlots(row).filter((slot) => !credited?.has(slot.key));
}

/**
 * #1519 (review): which UNMET slot of one trace row a call can advance —
 * the slot-eligibility rule that replaces plain vocabulary admission for
 * trace rows. A call is admitted to (and credits) a row only when it can
 * advance an unmet slot of that row, which keeps the reserve honest: a call
 * matching only already-met slots cannot advance outstanding demand and is
 * refused inside the window.
 *
 * A repository read credits at most ONE slot per row: per-seam attribution
 * walks the seams in deterministic order (enforcement before test within a
 * seam), and only then falls back to the row vocabulary — a vocabulary-
 * mentioning non-test read may credit the first UNMET enforcement slot, since
 * a requirement's text often names its enforcement file but can never name
 * its regression test. TEST slots never demand vocabulary: the validator's
 * test gate is `isTestPath`-based. Non-trace rows never reach this helper.
 */
function traceSlotCreditForCall(
  row: RequiredEvidenceRow,
  name: string,
  args: Record<string, unknown>,
  unmet: readonly TraceEvidenceSlot[],
): string | null {
  if (row.tools !== undefined && !row.tools.includes(name)) return null;
  const target = argumentTargetText(args);
  const targetIsTest = traceTargetIsTestRead(target);
  const vocabulary = row.tokens.some((token) => targetMentions(target, token));
  if (row.proofShape === "distributed" && Array.isArray(row.seams) && row.seams.length > 0) {
    const seams = row.seams.slice(0, MAX_GROUPS_PER_RULE);
    for (let index = 0; index < seams.length; index += 1) {
      const slot = traceSeamSlotForTarget(seams[index]!, target, targetIsTest);
      if (slot === null) continue;
      const key = `${index}:${slot}`;
      if (unmet.some((candidate) => candidate.key === key)) return key;
    }
    if (!targetIsTest && vocabulary) {
      const fallback = unmet.find((slot) => slot.kind === "enforcement");
      if (fallback !== undefined) return fallback.key;
    }
    // #1519 (review, round 2): the symmetric last-resort fallback for TEST
    // slots. A seam whose trusted test globs match no real file (config
    // drift, a renamed test tree) must never pin the reserve: a test read
    // that names the requirement's own vocabulary credits the first unmet
    // test slot, so a model genuinely hunting for the requirement's
    // regression test can always advance the row. The validator keeps its
    // own stricter per-seam matching — this fallback releases reserve, it
    // never certifies evidence.
    if (targetIsTest && vocabulary) {
      const fallback = unmet.find((slot) => slot.kind === "test");
      if (fallback !== undefined) return fallback.key;
    }
    return null;
  }
  if (row.requiredAttempts === 2) {
    if (targetIsTest) return unmet.some((slot) => slot.kind === "test") ? "test" : null;
    return vocabulary && unmet.some((slot) => slot.kind === "enforcement") ? "enforcement" : null;
  }
  return vocabulary && unmet.some((slot) => slot.kind === "any") ? "any" : null;
}

/** The sanitized form of a trusted seam name in driver notes. */
function traceSeamLabel(name: string): string {
  return name.replace(/[\x00-\x1f\x7f`]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME_CHARS);
}

/**
 * #1519 (review): the bounded outstanding-demand text of one trace row —
 * which slots it still owes, so a redirected model spends the reserved tail
 * on the MISSING evidence category (a runtime row whose enforcement read is
 * done needs a TEST read, not another enforcement file). Distributed rows
 * name the seam. Returns "" when nothing is unmet.
 */
function traceOutstandingDetail(row: RequiredEvidenceRow, credited: ReadonlySet<string> | undefined): string {
  const unmet = traceUnmetSlots(row, credited);
  if (unmet.length === 0) return "";
  if (row.proofShape === "distributed" && Array.isArray(row.seams) && row.seams.length > 0) {
    const seams = row.seams.slice(0, MAX_GROUPS_PER_RULE);
    const parts: string[] = [];
    for (let index = 0; index < seams.length; index += 1) {
      const enforcement = unmet.some((slot) => slot.key === `${index}:enforcement`);
      const test = unmet.some((slot) => slot.key === `${index}:test`);
      if (!enforcement && !test) continue;
      const label = `seam ${traceSeamLabel(seams[index]!.name)}`;
      parts.push(
        enforcement && test ? `${label}: enforcement + test reads owed`
        : enforcement ? `${label}: enforcement read owed`
        : `${label}: test read owed`,
      );
    }
    if (parts.length > 0) return parts.join("; ");
  }
  const counts = (kind: TraceEvidenceSlot["kind"]): number => unmet.filter((slot) => slot.kind === kind).length;
  const enforcement = counts("enforcement");
  const test = counts("test");
  const any = counts("any");
  const parts: string[] = [];
  if (enforcement > 0) parts.push(`${enforcement} enforcement read${enforcement === 1 ? "" : "s"}`);
  if (test > 0) parts.push(`${test} test read${test === 1 ? "" : "s"}`);
  if (any > 0) parts.push(`${any} evidence read${any === 1 ? "" : "s"}`);
  return parts.length === 0 ? "" : `${parts.join(" + ")} owed`;
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
   * compacted before the next request. #1635: the watermark is derived from
   * the tier's declared context window (~75% of it, reserves held) by the
   * harness; the constant here is only the undeclared-window fallback. */
  maxConversationTokens: number;
  truncatedResultBytes: number;
  /** Results kept verbatim when compacting — the digest's keep-newest count
   * and, since #1635, the same count protected from blunt truncation. */
  summarizeKeepNewest: number;
}

/** #1635: second-pass floor. When the first truncation pass (at
 * `truncatedResultBytes`) leaves the conversation over the watermark, old
 * results are compacted once more to this byte cap before the driver gives
 * up and records the protected overflow. Deterministic and idempotent:
 * results already at or below the cap are never touched again. */
export const TRUNCATED_RESULT_MIN_BYTES = 256;

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
    // #1638 review: ONE constant with the Conversation compaction default, so
    // the driver's protected count and the class's cannot drift apart.
    summarizeKeepNewest: DEFAULT_PROTECTED_NEWEST_RESULTS,
  };
}

export interface ExecutedCall {
  tool: string;
  args: Record<string, unknown>;
  /** Executor shape: {"tool", "status", "result"}. */
  result: Record<string, unknown>;
}

/**
 * #1466: the transport measurements of ONE accepted model attempt — the
 * fields that separate "the provider was slow" from "the provider answered
 * fast and the Action was slow afterwards", and that make a
 * streamed→non-streamed fallback separately attributable.
 *
 * A TYPE ALIAS deliberately (like `NativeLoopVerdictTelemetry` in the
 * harness): an object-literal type is assignable to `Record<string, unknown>`
 * while an interface with the same members is NOT, and the verdict record
 * reuses this shape.
 *
 * Every field is a number, a nullable number, or a bounded enum token. No
 * prompt text, response text, tool arguments, credentials, or provider error
 * bodies ever ride here — the finish reason is reduced to an enum token
 * before it is published.
 */
export type AcceptedAttemptTiming = {
  /**
   * #1466: seconds from the ACCEPTED attempt's dispatch to its first
   * CONTENT-bearing stream event — the provider's time-to-first-token.
   *
   * Null when the accepted attempt was not streamed (a non-streamed answer
   * carries no content event on the wire) or when the transport reported no
   * timing at all. Never a zero standing in for an unmeasured value: a
   * fabricated zero reads as "the provider answered instantly".
   */
  ttft_sec: number | null;
  /**
   * #1466: seconds from the ACCEPTED attempt's dispatch to its first response
   * byte — the provider's queue/prefill time, measured separately from the
   * decode that follows. Null when the transport reported no timing.
   */
  first_event_sec: number | null;
  /**
   * #1466: the cache-WRITE tokens the provider reported for this attempt
   * (Anthropic's `cache_creation_input_tokens`). Null when the provider
   * reported none — never a zero standing in for "not reported".
   */
  cache_write_tokens: number | null;
  /**
   * #1466: the UNCACHED input tokens the provider reported for this attempt
   * — the part of the prompt that was NOT served from the provider's cache.
   * Null when the provider reported nothing usable; never estimated from
   * elapsed time (an estimate would be indistinguishable from a measurement).
   */
  uncached_prompt_tokens: number | null;
  /**
   * #1466: the decode rate of the accepted attempt — its completion tokens
   * over the window between its first content event and its end.
   *
   * Null unless the attempt streamed AND reported completion tokens AND the
   * window is positive: without a content event there is no decode window
   * to divide by, and a rate built from anything else would be a guess.
   */
  decode_tokens_per_sec: number | null;
  /**
   * #1466: how many transport calls the attempt's turn made — one, or two
   * when the streamed attempt was unusable and the non-streamed fallback ran.
   * The fallback is separately attributable because the two attempts are
   * counted, not because a boolean says "something was retried".
   */
  attempts: number;
  /**
   * #1466: how many ACTUAL HTTP attempts the turn made in total — the
   * transport's own 429/5xx/clamp/strip retries included. A turn that needed
   * three wire calls to get one answer is a different story from a turn that
   * needed one, and only the count tells them apart.
   */
  wire_calls: number;
  /**
   * #1466: the provider's stop reason for the ACCEPTED attempt, reduced to a
   * bounded enum token.
   *
   * It is provider-controlled free text, so it is NEVER echoed raw: a value
   * that is not a bare `[A-Za-z0-9_.:-]` token is dropped WHOLE (not filtered
   * into something that could still read as content — a hostile value must
   * not be able to forge a heading here), and the kept value is capped at 40
   * characters. Empty means "not reported".
   */
  finish_reason: string;
};

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
export interface NativeLoopRoundTelemetry extends AcceptedAttemptTiming {
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
  /**
   * #1628: the turn's DISCARDED streamed attempt, with its own reason,
   * status, elapsed time, and wire-observation — the record that makes two
   * fallback rounds explain themselves ("one was a 524 after 133s, the other
   * a provider error object after 4s") instead of collapsing into two
   * `streamed_fallback: true` booleans and one round total. Null whenever no
   * streamed attempt was discarded, so a fallback turn and a clean turn stay
   * distinguishable at a glance. Content-free by construction (see
   * `StreamedAttemptFailureRecord` in stream-attempt.ts).
   */
  stream_failure: StreamedAttemptFailureRecord | null;
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
  /**
   * #1466: report the transport probe of ONE transport call this turn made.
   *
   * The seam calls it once per call it made, in call order, so the loop can
   * tell three things apart that the old `streamed_fallback` boolean could
   * not: WHEN the provider answered (the probe's own instants), HOW MANY
   * calls the turn made (the report count), and HOW MANY actual HTTP attempts
   * those calls needed (the probes' wire-call counts).
   *
   * A call that produced NO body reports `null`: it was still a transport
   * call (it cost a wire attempt), and it has no timing to report. The
   * distinction matters because the LAST report is the ACCEPTED attempt's —
   * the seam makes the accepted call last — so a report of `null` for the
   * accepted call means "this answer carried no measurement", never "the
   * previous attempt's measurement still applies".
   */
  reportTiming?(timing: TransportTiming | null): void;
  /**
   * #1628: report the turn's DISCARDED streamed attempt once, with its own
   * bounded reason and times, AFTER the seam's single non-streamed recovery
   * attempt has completed (success or failure alike) — the seam is the only
   * site that knows both attempts' elapsed times. Reported instead of thrown:
   * a retry that fails still has to say why its streamed predecessor was
   * discarded before the loop stops on the request error. A cancellation is
   * reported too (with a null `retry_elapsed_sec`: no recovery was fired), so
   * "the run was cancelled mid-turn" is visible without being a fallback.
   */
  reportStreamFailure?(failure: StreamedAttemptFailureRecord): void;
}

/**
 * #1466: fold a turn's transport reports into the counts the records carry.
 *
 * The reports arrive in call order, one per transport call, and the LAST one
 * is the ACCEPTED attempt's: the seam makes the accepted call last (a
 * streamed attempt that turned out unusable is followed by the non-streamed
 * fallback that produced the response the turn returned). A `null` report
 * (a call that produced no body) is the accepted attempt's answer "no
 * measurement" — never the previous attempt's measurement.
 *
 * `attempts` is the turn's transport-call count: the report count, floored
 * by `minimumAttempts` (a seam that reported selectively still made the
 * calls it knows about). `wire_calls` is the sum of the probes' own wire-call
 * counts, floored by the same call count — a transport call that reported no
 * count made at least one HTTP attempt, and a count must never understate
 * the calls that were made.
 */
export function summarizeTransportProbes(
  probes: readonly (TransportTiming | null)[],
  minimumAttempts = 1,
): { accepted: TransportTiming | null; attempts: number; wire_calls: number } {
  const attempts = Math.max(minimumAttempts, probes.length);
  const reported = probes.reduce((sum, probe) => sum + (probe === null ? 0 : (probe.wireCalls ?? 1)), 0);
  return {
    accepted: probes.length > 0 ? probes[probes.length - 1]! : null,
    attempts,
    wire_calls: Math.max(attempts, reported),
  };
}

/**
 * #1466: the decode rate of one attempt — its completion tokens over the
 * window between its first content event and its end.
 *
 * Null unless the attempt streamed AND reported completion tokens AND the
 * window is positive. There is no substitute measurement: without a content
 * event there is no decode window, and a rate derived from the total time
 * would fold the provider's prefill into the decode.
 */
export function decodeTokensPerSec(
  completionTokens: number | null,
  timing: TransportTiming | null,
): number | null {
  if (completionTokens === null || completionTokens <= 0) return null;
  if (timing === null || timing.firstContentSec === null) return null;
  const windowSec = timing.totalSec - timing.firstContentSec;
  if (!(windowSec > 0)) return null;
  return Math.round((completionTokens / windowSec) * 10) / 10;
}

/**
 * #1466: the provider's stop reason, reduced to a bounded enum token.
 *
 * The value is provider-controlled free text, so it is never echoed raw. A
 * value that is not a bare `[A-Za-z0-9_.:-]` token is dropped WHOLE: a
 * filter would keep the words of a hostile value and only remove the
 * punctuation, and a value that can forge a heading in the artifact must not
 * survive in pieces either. A kept value is capped at 40 characters.
 *
 * Both provider shapes are read: the OpenAI chat projection's
 * `choices[0].finish_reason` and the Anthropic body's `stop_reason`.
 */
export function sanitizedFinishReason(response: unknown): string {
  if (response === null || typeof response !== "object") return "";
  const body = response as Record<string, unknown>;
  const choices = body.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (first !== null && typeof first === "object") {
      const reason = (first as Record<string, unknown>).finish_reason;
      if (typeof reason === "string") return sanitizeFinishReasonToken(reason);
    }
  }
  if (typeof body.stop_reason === "string") return sanitizeFinishReasonToken(body.stop_reason);
  return "";
}

/**
 * #1466: reduce ONE provider-supplied stop reason to a bounded enum token.
 *
 * The value is provider-controlled free text, so it is never echoed raw: a
 * value that is not a bare `[A-Za-z0-9_.:-]` token is dropped WHOLE (a
 * filter would keep the words of a hostile value and only remove the
 * punctuation, and a value that can forge a heading must not survive in
 * pieces either). A kept value is capped at 40 characters. Anything that is
 * not a string is "not reported" — an empty token.
 */
export function sanitizeFinishReasonToken(value: unknown): string {
  if (typeof value !== "string") return "";
  if (!/^[A-Za-z0-9_.:-]+$/.test(value)) return "";
  return value.slice(0, 40);
}

export interface LoopOutcome {
  executed: ExecutedCall[];
  rounds: number;
  /** Everything the model asked for, incl. refused calls. */
  toolCallsIssued: number;
  /** #1597: calls refused WITHOUT executing (invalid arguments, over-budget,
   * reserve-window refusal) — the tri-partition invariant is
   * `toolCallsIssued === executed.length + toolCallsRefused + toolCallsDeduplicated`
   * (per-round: `requested === executed + refused + deduplicated`, #1199). */
  toolCallsRefused: number;
  /** #1597: calls deduplicated (same request key already seen) without
   * executing. The successful count (executed calls whose executor status is
   * "ok") is derived by the caller over `executed`, never stored on the
   * outcome, so a success-only count can never be confused for the executed
   * count here (#1597). */
  toolCallsDeduplicated: number;
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
  /** #1635: one bounded, content-free record per compaction pass — sizes and
   * counts only, never tool content. `cacheable_prefix_changed` is true only
   * when the pass actually mutated history: rewriting an older block
   * invalidates every provider prompt-cache built on the prior prefix, while
   * a sustained-overflow pass that shortened nothing changed nothing.
   * A truncation round reports ONE event folding both passes (first cap and
   * 256-byte floor); `round` is the count of model turns already completed,
   * so the pre-first-request pass reports 0. Bounded by the loop's own round
   * ceiling; older records are kept. */
  compactionEvents: Array<{
    round: number;
    kind: "summarize" | "truncate";
    before_approx_tokens: number;
    after_approx_tokens: number;
    results_shortened: number;
    /** UTF-8 bytes freed; only the truncation pass measures them exactly. */
    bytes_freed?: number;
    cacheable_prefix_changed: boolean;
  }>;
  /** #1635: true when the conversation stayed over the watermark even after
   * every OLD result had been compacted to the hard floor — the protected
   * newest results plus system/framing alone do not fit. Nothing is silently
   * dropped in that case: the request proceeds and the provider error, if
   * any, stays attributable, unlike destroyed evidence. */
  compactionOverflowProtected: boolean;
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
   * reports the prior loop's attempts too. TELEMETRY ONLY: the no-lockout
   * cap below is driven by `requiredEvidenceWindowAttempts` instead, so
   * pre-window evidence spending can never deactivate the reserved window
   * before it starts gating (#1396 review blocker).
   * */
  requiredEvidenceAttempts: number;
  /** #1396 (review blocker): executed upstream evidence-channel calls made
   * INSIDE the enforced obligation window (the window check ran and the
   * call was in-window). This is the counter the no-lockout cap drives
   * from: dependency-evidence shape rows release their gating once it
   * reaches the cap (the reserve, or the original threshold threaded
   * across the seam), even if nothing was credited. Pre-window evidence
   * attempts count only toward `requiredEvidenceAttempts` — the window's
   * no-lockout allowance is the reserved tail's patience, not the run's
   * total evidence spend. */
  requiredEvidenceWindowAttempts: number;
  /** #1396 (from #1379 blocker 5728634290): whether the enforced window was
   * released at loop end — reserve 0 (always open), or every tracked row
   * discharged or cap-released. */
  requiredEvidenceReleased: boolean;
  /** #1627: whether the deterministic `obligations-settled` early stop
   * fired — the obligation surface was active at some point this run and
   * every tracked row settled (discharged or cap-released) with budget
   * still unspent. False for a run with no obligation surface, a run whose
   * rows never all settled, and every other stop reason. */
  requiredEvidenceSettledStop: boolean;
  /**
   * #1659: the canonical per-row evidence-settlement record — the ONE
   * settlement vocabulary shared with final publication completeness. One
   * row per tracked question: identity, kind/materiality, the loop-side
   * terminal state (`discharged` is the only state finalization recognizes
   * as a loop settlement; `cap-released` is a budget release, never a
   * semantic settlement; `open` means the loop stopped before the row
   * settled), whether any admitted executed call succeeded, the admitting
   * call ids (objective provenance, the shared `call-<n>` scheme), and the
   * evidence acquisition state. Written on EVERY exit path, next to the
   * run-wide counters above. The harness persists it as
   * `tool_loop_meta.required_evidence_settlements`. */
  requiredEvidenceSettlements: LoopEvidenceSettlement[];
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
  /**
   * #1464: wall-clock seconds reserved for the closing in-conversation verdict.
   * When finite and > 0, the between-rounds check stops starting exploratory
   * rounds once the remaining wall clock falls to or below the reserve;
   * 0/undefined/non-finite keeps legacy behavior byte-identical.
   */
  wallClockReserveSec?: number | null;
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
   * loop's RUN-WIDE count so the continuation's `requiredEvidenceAttempts`
   * telemetry reports the run total (the harness fold is REPLACE, never
   * add). This counter no longer drives the no-lockout cap — see
   * `requiredEvidenceWindowAttemptsPrior`. Unset (every main loop) starts
   * the count at zero.
   */
  requiredEvidenceAttemptsPrior?: number;
  /**
   * #1396 (review blocker): in-window evidence-channel attempts already
   * recorded by an earlier loop over the SAME conversation — the #1145
   * repair seam threads the main loop's WINDOW-scoped count so the
   * no-lockout cap stays RUN-WIDE WITHOUT counting pre-window spending:
   * the continuation's shape rows release gating once prior + own
   * in-window attempts reach the cap, never from a reset zero count, and
   * never because the main loop burned evidence calls before its window
   * opened. Unset (every main loop) starts the count at zero.
   */
  requiredEvidenceWindowAttemptsPrior?: number;
  /**
   * #1396 (review): the attempts-cap threshold, overriding the loop's own
   * (possibly tail-clamped) reserve. The repair seam passes the ORIGINAL
   * unclamped run reserve so the cap cannot shrink across the seam; unset
   * keeps the reserve as the threshold (the main-loop and unit-test shape).
   */
  requiredEvidenceAttemptsCap?: number;
  /**
   * #1595 (review) first claim: when the dependency-evidence plan is SCOPED
   * (the tracked obligations a strict subset of the canonical trio), the
   * obligation window is enforced from the loop's FIRST request — not only
   * the reserved tail — so the mandatory evidence gets its bounded first
   * claim on the existing budget ahead of nice-to-have upstream archaeology.
   * The gating stays bounded by the existing no-lockout attempts cap
   * (reserve = tracked + 1 spare) and the model's ability to end with a
   * text-only verdict. Full-set plans never set it and keep the tail-only
   * behavior byte-for-byte; unset (every non-lead-claim caller) is
   * byte-identical to the pre-#1595-review loop.
   */
  requiredEvidenceLeadClaim?: boolean;
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
  // #1464: reserve for the closing in-conversation verdict; 0 disables the
  // reserve check entirely (legacy behavior).
  const wallClockReserve =
    typeof options.wallClockReserveSec === "number" && Number.isFinite(options.wallClockReserveSec) && options.wallClockReserveSec > 0
      ? options.wallClockReserveSec
      : 0;
  // #1199: per-round latency rides a monotonic telemetry clock, deliberately
  // distinct from the budget `timeFn` so adding latency measurement never
  // shifts the scripted budget-clock sequences the reliability tests pin.
  const nowFn = options.nowFn ?? (() => performance.now() / 1000);
  const roundSec = (n: number): number => Number(Math.max(0, n).toFixed(3));

  const outcome: LoopOutcome = {
    executed: [],
    rounds: 0,
    toolCallsIssued: 0,
    toolCallsRefused: 0,
    toolCallsDeduplicated: 0,
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
    compactionEvents: [],
    compactionOverflowProtected: false,
    requiredEvidenceRequestsHint: Math.max(0, Math.min(budgets.maxToolCalls, Math.floor(options.reserveForRequiredEvidence ?? 0))),
    requiredEvidenceRefusals: 0,
    requiredEvidenceRequired: 0,
    requiredEvidenceCredits: [],
    requiredEvidenceAttempts: 0,
    requiredEvidenceWindowAttempts: 0,
    requiredEvidenceReleased: false,
    requiredEvidenceSettledStop: false,
    requiredEvidenceSettlements: [],
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
  // discharged when admitted executed calls have covered its evidence
  // demand: one admitted call for prose/shape rows (#1519 keeps their
  // behavior), the row's full required-attempts demand for trace rows —
  // attempt-based and executor-status-agnostic (the row still needs a verdict
  // disposition to count as SATISFIED — the window guarantees only the
  // ATTEMPT).
  const pendingRows: RequiredEvidenceRow[] = reserve > 0
    ? [...(options.requiredEvidence ?? [])]
    : [];
  // Rows already discharged by an earlier loop over the SAME conversation
  // (the #1145 repair seam seeds them here) start closed; a seed that names
  // no tracked row is dropped.
  const discharged = new Set<string>();
  // #1519: SLOT credit per trace row — the set of evidence slots admitted
  // calls have covered (keyed per seam for distributed rows). A trace row
  // discharges only when its FULL slot demand is credited — for a runtime
  // row BOTH the enforcement location and a matching regression-test read,
  // for a distributed row both in every seam — so arbitrary matching reads
  // (a second read of the same enforcement file, an unrelated doc) can no
  // longer discharge a row. The categories and per-seam attribution mirror
  // the deterministic validator. Non-trace rows keep the one-call discharge.
  const traceCredited = new Map<string, Set<string>>();
  if (Array.isArray(options.requiredEvidenceCredits)) {
    for (const id of options.requiredEvidenceCredits) {
      if (typeof id !== "string") continue;
      if (pendingRows.some((row) => row.id === id)) discharged.add(id);
    }
  }
  // #1627 (M1): snapshot AFTER the seed — rows the repair seam closed before
  // this loop ever ran are "otherwise discharged" for the settled-stop
  // suppression below (their settlement is the prior loop's doing, not this
  // run's bookkeeping).
  const seededDischarged = new Set(discharged);
  // Attempted upstream evidence-channel calls over the WHOLE RUN, pre-window
  // included. An executor error still counts as an attempt — see
  // DEPENDENCY_EVIDENCE_TOOLS. #1396 (review): the count is run-wide across
  // the #1145 repair seam — a continuation starts from the prior loop's
  // attempts instead of a reset zero. TELEMETRY ONLY: this counter no longer
  // drives the no-lockout cap (that is `windowEvidenceAttempts` below), so
  // evidence calls the model spent BEFORE the reserved window — possibly on
  // obligations it already discharged, possibly on none — can never
  // deactivate the window before the tail is even scarce.
  let evidenceAttempts = Math.max(0, Math.floor(options.requiredEvidenceAttemptsPrior ?? 0));
  // The no-lockout counter: evidence-channel attempts made INSIDE the
  // enforced window only (see the window block below). The cap exists to
  // bound the reserved tail's patience — after `attemptsCap` gated evidence
  // attempts without a discharge, shape rows release so the window can never
  // lock the model out of its own tail. Attempts outside the window spent
  // freely-chosen budget and are irrelevant to that patience.
  let windowEvidenceAttempts = Math.max(0, Math.floor(options.requiredEvidenceWindowAttemptsPrior ?? 0));
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
    && !(row.obligation !== undefined && windowEvidenceAttempts >= attemptsCap);
  const hasActiveRow = (): boolean => pendingRows.some((row) => rowActive(row));
  const anyActiveShapeRow = (): boolean =>
    pendingRows.some((row) => row.obligation !== undefined && rowActive(row));
  // #1506: a requirement-trace row is not a review-owned prose row: it is
  // discharged by repository evidence, not by the Required Review Evidence
  // section, so the two kinds never share a note.
  const anyActiveProseRow = (): boolean =>
    pendingRows.some((row) => row.obligation === undefined && row.trace !== true && rowActive(row));
  const anyActiveTraceRow = (): boolean =>
    pendingRows.some((row) => row.trace === true && rowActive(row));
  const outstandingTraceIds = (): string[] =>
    pendingRows
      .filter((row) => row.trace === true && rowActive(row))
      .map((row) => {
        const id = row.id.replace(/^trace:/, "");
        // #1519 (review): the note names the UNMET SLOTS — which evidence
        // category (enforcement vs regression test) and which distributed
        // seam the row still owes — so the reserved tail is spent on the
        // missing evidence instead of a redundant read of an already-covered
        // category (a call that cannot advance an unmet slot is refused
        // inside the window anyway).
        const detail = traceOutstandingDetail(row, traceCredited.get(row.id));
        return detail === "" ? id : `${id} (${detail})`;
      });
  const outstandingShapeObligations = (): DependencyEvidenceObligation[] =>
    pendingRows
      .filter((row) => row.obligation !== undefined && rowActive(row))
      .map((row) => row.obligation as DependencyEvidenceObligation);
  const started = timeFn();
  const telemetryStart = nowFn();
  let callsExecuted = 0;
  // #1627: whether the obligation surface was ever ACTIVE this run — at
  // least one tracked row still owed its evidence at the top of some round.
  // Only a run with such a surface may stop early on settlement: a
  // continuation whose every row was seeded discharged (#1145) never had an
  // active obligation to settle, and a run with no reservation never had
  // rows at all.
  let obligationsSeenActive = false;
  // #1627 (M1): settlement-success bookkeeping. A row settled (discharged by
  // an admitted call, or cap-released by the attempts cap) whose attempts
  // never saw a SUCCESSFUL execution cannot back a citable verdict
  // disposition — the fold's citation gate (required-checks /
  // review-obligations) requires a cited SUCCESSFUL call, and a single
  // transient fetch failure would otherwise strand the model: early stop →
  // no retry opportunity → `uncited-satisfaction` → partial. Per row, track
  // whether any admitted executed call returned ok; for the cap-release path
  // (a row released by the window's attempt cap rather than a discharge),
  // track whether ANY in-window evidence execution succeeded. When a would-be
  // settled stop finds any settled row lacking that success, it does NOT
  // fire: the loop continues under the pre-existing budget/round/no-calls
  // stops (pre-#1627 exploration freedom in exactly the stranding case).
  const rowSuccessfulAttempt = new Set<string>();
  // #1659: the per-row admitting executed-call ids (the shared `call-<n>`
  // scheme) — the objective provenance receipts the settlement record
  // carries, so finalization can defer to a loop-settled row without
  // re-deriving the admission from a different citation allocator. The
  // successful subset is tracked separately: a FAILED call never backs a
  // satisfied row, so the deferral receipt cites only calls that succeeded.
  const rowAdmittingCalls = new Map<string, string[]>();
  const rowSuccessfulCalls = new Map<string, string[]>();
  let anySuccessfulWindowEvidence = false;
  const seenKeys = new Set<string>();

  // #1199: emit one bounded telemetry record per model turn. Called from both
  // turn-ending paths (the no-tool-call stop and after tool execution) and
  // from the transport-error catch, so the records cover every model turn:
  // the successful call sites pass `outcome.rounds` (the turn just incremented
  // it — records 1..rounds in order), while the errored turn does not increment
  // `outcome.rounds` and emits round `outcome.rounds + 1` with null usage as
  // the loop's final stop. Reads only live loop state — never tool/model
  // content.
  //
  // #1466: the record grew past nine positional arguments, so the emitter
  // takes ONE options object — the positional form made it impossible to see
  // which of the many numbers was which, and a wrong one was silent.
  const emitRound = (record: {
    roundIndex: number;
    requested: number;
    executed: number;
    refused: number;
    deduplicated: number;
    toolElapsedSec: number;
    modelElapsedSec: number;
    usage: UsageTelemetry;
    fellBack: boolean;
    /** #1466: the turn's transport reports (one per transport call, in call
     * order; null when that call produced no body). The accepted attempt's
     * is the last. */
    probes: readonly (TransportTiming | null)[];
    /** #1466: the provider's stop reason for the accepted attempt, already
     * reduced to a bounded enum token. */
    finishReason: string;
    /** #1628: the turn's discarded streamed attempt (null when none). */
    streamFailure: StreamedAttemptFailureRecord | null;
  }): void => {
    if (options.onRound === undefined) return;
    // #1466: the accepted attempt's probe and the turn's call counts. The
    // fallback flag raises the call-count floor: a streamed attempt that
    // produced no body still WAS a transport call.
    const probe = summarizeTransportProbes(record.probes, record.fellBack ? 2 : 1);
    const accepted = probe.accepted;
    options.onRound({
      round: record.roundIndex,
      model_sec: roundSec(record.modelElapsedSec),
      prompt_tokens: record.usage.promptTokens,
      completion_tokens: record.usage.completionTokens,
      cached_tokens: record.usage.cachedTokens,
      tools_requested: record.requested,
      tools_executed: record.executed,
      tools_refused: record.refused,
      tools_deduplicated: record.deduplicated,
      tool_elapsed_sec: roundSec(record.toolElapsedSec),
      requests_remaining: Math.max(0, budgets.maxToolCalls - callsExecuted),
      rounds_remaining: Math.max(0, budgets.maxRounds - outcome.rounds),
      wall_clock_remaining_sec: roundSec(Math.max(0, budgets.wallClockSec - (nowFn() - telemetryStart))),
      streamed_fallback: record.fellBack,
      // #1628: the discarded streamed attempt's OWN record (reason, status,
      // elapsed, observation) when this turn made a fallback. Null otherwise
      // — never a zero-filled stand-in.
      stream_failure: record.streamFailure,
      // #1466: the transport measurements of the accepted attempt. Null
      // timings mean "not measured" — never a zero standing in for a
      // measurement the transport never made.
      ttft_sec: accepted === null || accepted.firstContentSec === null ? null : roundSec(accepted.firstContentSec),
      first_event_sec: accepted === null || accepted.firstEventSec === null ? null : roundSec(accepted.firstEventSec),
      cache_write_tokens: record.usage.cacheWriteTokens ?? null,
      uncached_prompt_tokens: record.usage.uncachedPromptTokens ?? null,
      decode_tokens_per_sec: decodeTokensPerSec(record.usage.completionTokens, accepted),
      attempts: probe.attempts,
      wire_calls: probe.wire_calls,
      finish_reason: record.finishReason,
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

    // #1464: stop starting exploratory rounds once the remaining wall clock
    // has fallen to (or below) the reserve held for the closing in-conversation
    // verdict. Fires AFTER the exceeded check above, so a deadline already
    // reached still reports `wall-clock-exceeded`. The reserve is off by
    // default (0): when enabled it adds ONE timeFn read per round on top of
    // the exceeded check's own read — scripted test clocks must account for
    // both. #1464 note: this gate is time-based and independent of the
    // #1379/#1396 required-evidence window (reserved in rounds/requests); a
    // reserve stop can end a run while that window is still open, and the
    // downstream machinery records that honestly (open window →
    // `deriveUnresolvedCause` "budget-exhausted", partial coverage via
    // `isIncompleteInvestigationStopReason`, #1338 gap preservation).
    if (wallClockReserve > 0) {
      const remaining = wallClockDeadline !== null ? wallClockDeadline - timeFn() : started + budgets.wallClockSec - timeFn();
      if (remaining <= wallClockReserve) {
        outcome.stopReason = STOP_WALL_CLOCK_RESERVE;
        broke = true;
        break;
      }
    }

    // #1627: remember that the obligation surface was ACTIVE this run. Read
    // BEFORE this round's dispositions can settle rows, so a row discharged
    // later in this very round still counts as having been active.
    if (!obligationsSeenActive && hasActiveRow()) obligationsSeenActive = true;

    // Keep the next request within the advisory context budget by compacting
    // the oldest tool results. #1635: the newest `summarizeKeepNewest` results
    // are protected on BOTH paths — blunt truncation used to rewrite every
    // oversized result including the ones the model is acting on, destroying
    // fresh evidence far below the model's real window. When a summarizer is
    // wired, fold the older results into a model-generated digest that
    // preserves salient facts; otherwise (or if it frees nothing / fails)
    // fall back to blunt truncation, which is the guaranteed backstop. If the
    // first truncation pass leaves the conversation over the watermark, a
    // second deterministic pass compacts the same OLD-only results to a hard
    // floor; results already at or below the cap are untouched, so repeated
    // rounds are stable. #1638 review: the digest is capped at write time at
    // `truncatedResultBytes`, and both truncation passes leave folded results
    // alone — after a fold they ARE the preserved evidence, and cutting them
    // (especially to the floor) would silently discard what the digest saved.
    // If even that leaves the conversation over the
    // watermark, the protected tail itself does not fit: nothing more is
    // dropped, the overflow is recorded, and the request proceeds — an
    // attributable provider error beats silently discarded evidence.
    outcome.peakConversationTokens = Math.max(outcome.peakConversationTokens, conversation.approxTokens());
    if (conversation.approxTokens() > budgets.maxConversationTokens) {
      const recordCompaction = (
        kind: "summarize" | "truncate",
        beforeTokens: number,
        resultsShortened: number,
        bytesFreed: number | undefined,
      ): void => {
        outcome.compactionEvents.push({
          round: outcome.rounds,
          kind,
          before_approx_tokens: beforeTokens,
          after_approx_tokens: conversation.approxTokens(),
          results_shortened: resultsShortened,
          ...(bytesFreed !== undefined ? { bytes_freed: bytesFreed } : {}),
          // A pass that shortened nothing mutated no history and therefore
          // invalidated no provider prompt cache (#1635 review).
          cacheable_prefix_changed: resultsShortened > 0,
        });
      };
      let summarized = 0;
      const beforeSummarize = conversation.approxTokens();
      if (summarizeFn !== null) {
        try {
          summarized = await conversation.summarizeOldestToolResults(
            async (block) => await summarizeFn!(block),
            {
              keepNewest: budgets.summarizeKeepNewest,
              // #1638 review: cap the digest at the truncation cap at write
              // time, so neither truncation pass has a reason to rewrite it —
              // blunt cuts would silently discard the preserved evidence.
              digestMaxBytes: budgets.truncatedResultBytes,
            },
          );
        } catch {
          summarized = 0; // summarization is best-effort
        }
      }
      if (summarized > 0) {
        outcome.compactionSummarize++;
        recordCompaction("summarize", beforeSummarize, summarized, undefined);
      }
      if (summarized === 0 || conversation.approxTokens() > budgets.maxConversationTokens) {
        outcome.compactionTruncate++;
        const beforeTruncate = conversation.approxTokens();
        const first = conversation.truncateOldestToolResults(budgets.truncatedResultBytes, {
          keepNewest: budgets.summarizeKeepNewest,
        });
        let second = { shortened: 0, bytesFreed: 0 };
        if (conversation.approxTokens() > budgets.maxConversationTokens) {
          second = conversation.truncateOldestToolResults(TRUNCATED_RESULT_MIN_BYTES, {
            keepNewest: budgets.summarizeKeepNewest,
          });
        }
        recordCompaction(
          "truncate",
          beforeTruncate,
          first.shortened + second.shortened,
          first.bytesFreed + second.bytesFreed,
        );
      }
      if (conversation.approxTokens() > budgets.maxConversationTokens) {
        outcome.compactionOverflowProtected = true;
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
      // #1595 (review): lead-claim gating — a SCOPED dependency-evidence plan
      // (flag set by the harness) keeps the window open from the FIRST
      // request until the rows discharge or the attempts cap releases them.
      const leadClaimGating = reserve > 0 && options.requiredEvidenceLeadClaim === true && hasActiveRow();
      const inObligationWindow =
        reserve > 0
        && hasActiveRow()
        && (options.requiredEvidenceLeadClaim === true || requestsLeft <= reserve || roundsLeft <= reserve);
      if (outcome.rounds === 0) {
        if (reserve > 0 && hasActiveRow()) {
          // #1506: the priority note names the section the outstanding rows
          // actually live in. A requirement-trace row is discharged by
          // repository evidence carried in the Requirement Trace Plan section,
          // not by the Required Review Evidence section, so the note must
          // point at the right one.
          const priorityNote = anyActiveShapeRow()
            ? // #1595: names exactly the tracked obligations (byte-for-byte
              // the static note when that set is the full trio).
              dependencyEvidencePriorityTurnNote(outstandingShapeObligations())
            : anyActiveTraceRow()
              ? TRACE_EVIDENCE_PRIORITY_TURN_NOTE
              : REQUIRED_EVIDENCE_PRIORITY_TURN_NOTE;
          const otherClause = anyActiveShapeRow()
            ? (anyActiveTraceRow() ? TRACE_WINDOW_CLAUSE : anyActiveProseRow() ? MIXED_WINDOW_CLAUSE : "")
            : anyActiveTraceRow() && anyActiveProseRow()
              ? PROSE_WINDOW_CLAUSE
              : "";
          conversation.addTurnNote(priorityNote + otherClause);
        }
      } else {
        // #1396: one pass, one note. With a shape row active the redirect
        // names the outstanding dependency evidence — on the side that is
        // actually scarce (requests, else rounds) — and grows the mixed-run
        // clause when prose rows gate the same window.
        const shapeNoteActive = anyActiveShapeRow();
        const traceNoteActive = anyActiveTraceRow();
        const mixedClause = shapeNoteActive
          ? (traceNoteActive ? TRACE_WINDOW_CLAUSE : anyActiveProseRow() ? MIXED_WINDOW_CLAUSE : "")
          : traceNoteActive && anyActiveProseRow()
            ? PROSE_WINDOW_CLAUSE
            : "";
        const note = inObligationWindow
          ? shapeNoteActive
            ? // #1595 (review): with the lead claim active but the tail NOT
              // yet scarce, the "Only {requestsLeft} tool request(s) remain"
              // wording would be false mid-budget — emit the lead-claim note
              // instead; the tail-scarce selection stays byte-identical.
              (leadClaimGating && requestsLeft > reserve && roundsLeft > reserve
                ? formatNote(RESERVE_LEAD_CLAIM_TURN_NOTE, {
                    outstanding: formatOutstandingObligations(outstandingShapeObligations()),
                  })
                : formatNote(requestsLeft <= reserve ? RESERVE_WINDOW_TURN_NOTE : RESERVE_WINDOW_ROUNDS_TURN_NOTE, {
                    requestsLeft,
                    roundsLeft,
                    outstanding: formatOutstandingObligations(outstandingShapeObligations()),
                  })) + mixedClause
            : traceNoteActive
              ? formatNote(requestsLeft <= reserve ? TRACE_RESERVE_WINDOW_TURN_NOTE : TRACE_RESERVE_WINDOW_ROUNDS_TURN_NOTE, {
                  requestsLeft,
                  roundsLeft,
                  outstanding: outstandingTraceIds().join(", "),
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
    // #1466: the transport probes of THIS turn's calls, in call order — one
    // entry per transport call (null when that call produced no body). The
    // last entry is the accepted attempt's. The list is per turn, so a turn
    // never inherits the previous turn's measurements.
    const turnProbes: Array<TransportTiming | null> = [];
    // #1628: the discarded streamed attempt this turn's seam reported (set by
    // `reportStreamFailure` after the recovery attempt). Per turn, so a turn
    // never inherits the previous turn's failure.
    let turnStreamFailure: StreamedAttemptFailureRecord | null = null;
    const turnSignal: ToolTurnSignal = {
      reportFallback: () => { roundFellBack = true; },
      reportTiming: (timing) => { turnProbes.push(timing); },
      reportStreamFailure: (failure) => { turnStreamFailure = failure; },
    };
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
      emitRound({
        roundIndex: outcome.rounds + 1,
        requested: 0,
        executed: 0,
        refused: 0,
        deduplicated: 0,
        toolElapsedSec: 0,
        modelElapsedSec: Math.max(0, nowFn() - modelStart),
        usage: normalizeUsageTelemetry(null, options.apiFormat),
        fellBack: roundFellBack,
      streamFailure: turnStreamFailure,
        probes: turnProbes,
        finishReason: "",
      });
      broke = true;
      break;
    }
    const modelElapsedSec = Math.max(0, nowFn() - modelStart);
    const usageObj = response !== null && typeof response === "object"
      ? (response as Record<string, unknown>).usage ?? null
      : null;
    const turnUsage = normalizeUsageTelemetry(usageObj, options.apiFormat);
    // #1466: the accepted attempt's stop reason, reduced to a bounded enum
    // token before it can reach the record or a log line.
    const finishReason = sanitizedFinishReason(response);

    outcome.rounds++;
    const { calls, text } = extractToolCalls(response, options.apiFormat);

    if (calls.length === 0) {
      outcome.finalText = text;
      outcome.stopReason = outcome.toolCallsIssued > 0 ? STOP_MODEL_DONE : STOP_NO_TOOL_CALLS;
      emitRound({
        roundIndex: outcome.rounds,
        requested: 0,
        executed: 0,
        refused: 0,
        deduplicated: 0,
        toolElapsedSec: 0,
        modelElapsedSec,
        usage: turnUsage,
        fellBack: roundFellBack,
      streamFailure: turnStreamFailure,
        probes: turnProbes,
        finishReason,
      });
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
    // #1627 (M1): per EXECUTED call this round — the rows its admission
    // targeted (discharged or partially credited; an attempt is an attempt),
    // and whether it counts as an in-window evidence attempt (the cap's
    // attempt pool). Filled in the disposition pass, consumed once this
    // round's results settle, for the settled-success bookkeeping.
    const execRowTargets = new Map<number, { rows: string[]; windowEvidence: boolean }>();
    // #1199: per-round disposition counts (a tri-partition of `calls.length`:
    // executed + refused + deduplicated === requested). Refusals cover the
    // invalid-argument error, the over-budget note, and the #1379
    // reserve-window refusal.
    let roundExecuted = 0;
    let roundRefused = 0;
    let roundDedup = 0;
    // #1396: rows this round's admitted calls discharged — the discharge
    // half of the progress that can earn a round-ceiling extension below
    // (an evidence fetch that executes but credits nothing must not buy
    // extension rounds). #1519: a traced ATTEMPT on a multi-attempt row is
    // the other half — it moves the row toward its discharge without closing
    // it, and the extension below must not stall a benign tail mid-demand.
    let rowsDischargedThisRound = 0;
    let traceAttemptsThisRound = 0;
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
      // every row kind. A call that targets a pending row has ATTEMPTED it
      // whether or not the window is open yet — the recommended path gathers
      // that evidence EARLY, and the window must never re-demand (or hold
      // shut for) evidence already gathered; for a trace row the call
      // credits one UNMET evidence slot of the row's required-attempts
      // demand, and covering every slot is what discharges it (#1519).
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
      let countsTowardAttemptsCap = false;
      if (reserve > 0 && hasActiveRow()) {
        // #1519 (review): a trace row is admitted to a call ONLY when the
        // call can advance one of its UNMET evidence slots — admission and
        // credit stay the same predicate, so a call whose every match is an
        // already-covered category (the enforcement read done, the test read
        // still owed) cannot advance outstanding demand and is refused
        // inside the window. Non-trace rows keep the vocabulary admission.
        const targets: Array<{ row: RequiredEvidenceRow; slot: string | null }> = [];
        for (const row of pendingRows) {
          if (discharged.has(row.id)) continue;
          if (row.trace === true) {
            const slot = traceSlotCreditForCall(row, call.name, args as Record<string, unknown>, traceUnmetSlots(row, traceCredited.get(row.id)));
            if (slot !== null) targets.push({ row, slot });
          } else if (rowAdmittedByCall(row, call.name, args as Record<string, unknown>)) {
            targets.push({ row, slot: null });
          }
        }
        // #1595 (review): the lead claim opens the window from the loop's
        // FIRST request for SCOPED dependency-evidence plans — mandatory
        // evidence is claimed before optional calls can spend the budget.
        // `countsTowardAttemptsCap` semantics then count every executed
        // evidence call of a lead-claim run (intended: the cap — reserve =
        // tracked + 1 spare — still bounds the gating's patience and
        // releases it, and the model can always end with a text-only
        // verdict).
        const inWindow = options.requiredEvidenceLeadClaim === true
          || budgets.maxToolCalls - callsExecuted <= reserve
          || budgets.maxRounds - (outcome.rounds - 1) <= reserve;
        // #1595 (review): lead-claim gating while the tail is NOT yet scarce
        // — the refusal must not speak of "the reserved tail" it has not
        // reached; compute once for the note selection below.
        const leadClaimTailNotScarce = options.requiredEvidenceLeadClaim === true
          && budgets.maxToolCalls - callsExecuted > reserve
          && budgets.maxRounds - (outcome.rounds - 1) > reserve;
        // #1396 (review blocker): an evidence call ADMITTED while the window
        // is actually gating (in-window) is what spends the reserved tail's
        // no-lockout patience; a call executed before the window opened
        // spent freely-chosen budget and must not count toward the cap.
        if (inWindow) countsTowardAttemptsCap = true;
        if (inWindow && targets.length === 0 && !(DEPENDENCY_EVIDENCE_TOOLS.has(call.name) && anyActiveShapeRow())) {
          plan.push({
            callId,
            kind: "reserve",
            data: {
              // #1506: the refusal names the section the outstanding rows
              // live in: the requirement-trace rows are in the Requirement
              // Trace Plan section, the review-owned prose rows in the
              // Required Review Evidence section.
              error: anyActiveShapeRow()
                ? // #1595 (review): mid-budget lead-claim refusals name the
                  // budget's first claim, never the reserved tail.
                  formatNote(leadClaimTailNotScarce ? RESERVE_LEAD_CLAIM_REFUSAL_NOTE : RESERVE_REFUSAL_NOTE, {
                    outstanding: formatOutstandingObligations(outstandingShapeObligations()),
                  }) + (anyActiveTraceRow() ? TRACE_WINDOW_CLAUSE : anyActiveProseRow() ? MIXED_WINDOW_CLAUSE : "")
                : anyActiveTraceRow()
                  ? formatNote(TRACE_RESERVE_REFUSAL_NOTE, {
                      outstanding: outstandingTraceIds().join(", "),
                    }) + (anyActiveProseRow() ? PROSE_WINDOW_CLAUSE : "")
                  : REQUIRED_EVIDENCE_REFUSAL_NOTE,
            },
          });
          roundRefused++;
          outcome.requiredEvidenceRefusals++;
          continue;
        }
        for (const { row, slot } of targets) {
          // #1519 (review): an admitted call credits ONE evidence slot of a
          // trace row — the row closes only when its FULL slot demand (every
          // category, and for a distributed row every seam) is credited. A
          // row that still owes a slot stays active, so its reserved share
          // keeps gating the window.
          if (row.trace === true && slot !== null) {
            const credited = traceCredited.get(row.id) ?? new Set<string>();
            traceCredited.set(row.id, credited);
            credited.add(slot);
            traceAttemptsThisRound++;
            if (!traceRowSlots(row).every((candidate) => credited.has(candidate.key))) continue;
          }
          discharged.add(row.id);
          rowsDischargedThisRound++;
        }
        // #1627 (M1): remember which rows this call targeted (discharged or
        // partially credited — an attempt is an attempt) and whether it is an
        // in-window evidence attempt, so the settled-success bookkeeping can
        // consume the call's executor status once results settle below.
        execRowTargets.set(idx, {
          rows: targets.map((target) => target.row.id),
          windowEvidence: countsTowardAttemptsCap && DEPENDENCY_EVIDENCE_TOOLS.has(call.name),
        });
      }
      seenKeys.add(key);
      callsExecuted++;
      if (DEPENDENCY_EVIDENCE_TOOLS.has(call.name)) {
        // Attempts count for ANY executed-planned evidence-channel call —
        // window, target, and executor status irrelevant (a refused host or
        // failed fetch still counts). Discharge rides `targets` above, so a
        // redundant call whose every match is already credited opens
        // nothing. The no-lockout cap counter counts only the IN-WINDOW
        // subset (see `windowEvidenceAttempts` above).
        evidenceAttempts++;
        if (countsTowardAttemptsCap) windowEvidenceAttempts++;
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
      for (const [idx, result] of settled) {
        resultsByIdx.set(idx, result);
        // #1627 (M1): the settlement-success bookkeeping. A SUCCESSFUL
        // execution credits every row the call targeted, and (for in-window
        // evidence attempts) the cap-release path's success pool. A failed or
        // errored execution credits nothing — a row settled only by such
        // calls stays stranded for the settled-stop suppression below.
        const targets = execRowTargets.get(idx);
        if (targets !== undefined && result.status === "ok") {
          for (const rowId of targets.rows) rowSuccessfulAttempt.add(rowId);
          if (targets.windowEvidence) anySuccessfulWindowEvidence = true;
        }
      }
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
      // #1659: the call's positional id is fixed HERE — by its order in
      // `outcome.executed`, the exact scheme the proof index renders
      // (`executedCallId(index + 1)`) and the enforcement-side evidence index
      // parses back — so the settlement record's receipts always name ids the
      // folds can verify against the artifact's own trace.
      const executedCallReceipt = executedCallId(outcome.executed.length + 1);
      outcome.executed.push({ tool: exec.name, args: exec.args, result });
      // #1659: record the admitting call id for every row this call targeted
      // (discharged or partially credited — an attempt is provenance too);
      // the successful subset fills only when the execution finished ok.
      const admittedRows = execRowTargets.get(disposition.data);
      if (admittedRows !== undefined) {
        for (const rowId of admittedRows.rows) {
          const admitted = rowAdmittingCalls.get(rowId);
          if (admitted === undefined) rowAdmittingCalls.set(rowId, [executedCallReceipt]);
          else admitted.push(executedCallReceipt);
          if (result.status === "ok") {
            const succeeded = rowSuccessfulCalls.get(rowId);
            if (succeeded === undefined) rowSuccessfulCalls.set(rowId, [executedCallReceipt]);
            else succeeded.push(executedCallReceipt);
          }
        }
      }
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
    // #1597: the run-wide disposition counters are aggregated here from the
    // same per-round tri-partition the record carries, so the harness
    // artifact's issued/executed/refused/deduplicated fields come from this
    // one settled snapshot.
    outcome.toolCallsRefused += roundRefused;
    outcome.toolCallsDeduplicated += roundDedup;
    emitRound({
      roundIndex: outcome.rounds,
      requested: calls.length,
      executed: roundExecuted,
      refused: roundRefused,
      deduplicated: roundDedup,
      toolElapsedSec,
      modelElapsedSec,
      usage: turnUsage,
      fellBack: roundFellBack,
      streamFailure: turnStreamFailure,
      probes: turnProbes,
      finishReason,
    });

    // #1388; #1396: round-ceiling extension for the reserved window.
    // Extension is earned ONLY at the (current) ceiling and only on
    // progress: a row DISCHARGE, or (#1519) a round that pushed a
    // multi-attempt trace row further along its demand — the discharge is
    // still what removes a row, but a runtime or distributed tail now spends
    // several admitted reads before it closes, and a benign tail must not
    // stop at `maxRounds` mid-demand. The progress is self-limiting: the
    // traced attempts are bounded by the rows' total demand, and a hostile
    // model emitting only refused calls executes nothing, accumulates no
    // attempts, and gets ZERO extra rounds (it stops at `maxRounds` with the
    // reserved requests intact); an evidence fetch that executes but credits
    // nothing cannot buy extension rounds either.
    if (
      reserve > 0
      && extensionRounds < reserve
      && outcome.rounds >= roundCeiling
      && hasActiveRow()
      && callsExecuted < budgets.maxToolCalls
      && (rowsDischargedThisRound > 0 || traceAttemptsThisRound > 0)
    ) {
      roundCeiling++;
      extensionRounds++;
    }

    if (callsExecuted >= budgets.maxToolCalls) {
      outcome.stopReason = STOP_BUDGET;
      broke = true;
      break loop;
    }

    // #1627: the deterministic early stop. Once the obligation surface was
    // active this run and NO active row remains — every row discharged by an
    // admitted call or cap-released as unprovable (the loop's own discharge
    // bookkeeping; unprovable rows are settled too) — continuing to the
    // round ceiling would only spend budget on optional exploration. Stop
    // here and let the caller proceed to the verdict from the warm
    // conversation. Guards: the check sits at the loop body's end, so it can
    // never fire before the first round or while this round's
    // admission/refusal decisions are pending; the surface flag only sets
    // when a row was actually active, so surface-less and fully-seeded
    // continuations never fire it. A budget exhausted in the SAME round that
    // settled the rows keeps the pre-existing `STOP_BUDGET` classification
    // above — the settled stop only ever preempts rounds that would be
    // spent on optional work.
    //
    // #1627 (M1): the stranding guard. A row settled by attempts that never
    // saw a SUCCESSFUL execution cannot back the fold's citation gate (which
    // requires a cited successful call), so stopping here would hand the
    // verdict an `uncited-satisfaction` it cannot avoid — a single transient
    // fetch failure must not strand the model. In that shape the early stop
    // does NOT fire: the loop continues under the pre-existing budget/round/
    // no-calls stops, restoring exactly the pre-#1627 exploration freedom.
    // The stop still fires when every settled row had a successful attempt
    // among its admitting calls, was seeded discharged by the repair seam
    // (the prior loop's settlement), or was cap-released with a successful
    // in-window evidence execution on record.
    if (obligationsSeenActive && !hasActiveRow()) {
      const strandedSettlement = pendingRows.some((row) => {
        if (discharged.has(row.id)) {
          return !seededDischarged.has(row.id) && !rowSuccessfulAttempt.has(row.id);
        }
        // Cap-released (not discharged): the attempts that released it are
        // the in-window evidence executions.
        return !anySuccessfulWindowEvidence;
      });
      if (!strandedSettlement) {
        outcome.stopReason = STOP_OBLIGATIONS_SETTLED;
        outcome.requiredEvidenceSettledStop = true;
        broke = true;
        break loop;
      }
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
  outcome.requiredEvidenceWindowAttempts = windowEvidenceAttempts;
  outcome.requiredEvidenceReleased = reserve <= 0 || !hasActiveRow();
  // #1659: the canonical per-row settlement record — written on every exit
  // path next to the run-wide counters, so finalization consumes the loop's
  // own terminal state instead of re-deriving it. `discharged` is the only
  // state finalization recognizes as a loop settlement; a shape row's
  // cap-release is recorded as `cap-released` (a budget release, NEVER a
  // semantic settlement — #1659's acceptance makes a cap-released material
  // question a material unknown downstream); a row the loop stopped before
  // settling is `open`. The acquisition state distinguishes evidence the run
  // actually got (`available`) from attempts that all failed (`failed`) and
  // evidence the run never got to attempt (`unavailable` — refused or
  // unattempted), so a provider failure before meaningful evidence is never
  // misread as a completed review.
  outcome.requiredEvidenceSettlements = pendingRows.map((row) => {
    const admittedBy = rowAdmittingCalls.get(row.id) ?? [];
    const successfulBy = rowSuccessfulCalls.get(row.id) ?? [];
    const successfulAttempt = rowSuccessfulAttempt.has(row.id);
    const settledVia = discharged.has(row.id)
      ? "discharged"
      : row.obligation !== undefined && windowEvidenceAttempts >= attemptsCap
      ? "cap-released"
      : "open";
    const acquisition = successfulAttempt
      ? "available"
      : admittedBy.length > 0
      ? "failed"
      : "unavailable";
    return {
      id: row.id,
      kind: row.obligation !== undefined ? "dependency" : row.trace === true ? "trace" : "prose",
      materiality: row.trace === true
        ? "material"
        : row.obligation !== undefined
        ? "material"
        : row.source === "trusted_base_guidance"
        ? "advisory"
        : "material",
      ...(row.source !== undefined ? { source: row.source } : {}),
      settledVia,
      successfulAttempt,
      admittedBy,
      successfulBy,
      acquisition,
    };
  });
  // #702: close out the telemetry on every exit path.
  outcome.requestsRemaining = Math.max(0, budgets.maxToolCalls - callsExecuted);
  outcome.elapsedSec = timeFn() - started;
  return outcome;
}
