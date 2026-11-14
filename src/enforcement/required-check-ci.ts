/**
 * #1594: reconcile deterministic CI evidence with required-check completion.
 *
 * A review-owned required check that asks for a TEST RUN may be discharged
 * by EXISTING trusted, head-bound, check-specific CI evidence — the final
 * check list the CI gate (`src/gates/ci-wait.ts`) already read for the exact
 * reviewed head and recorded in its gate-output file. Success of an
 * arbitrary check is insufficient: the check name must genuinely denote a
 * test execution, and the evidence must be bound to the exact head.
 *
 * Authority model (this is deterministic policy, not a model verdict):
 * - the evidence artifact is code-generated from platform reads by the CI
 *   gate, never model output and never an extra forge call;
 * - discharge is deterministic-policy-owned: a validated head-bound green
 *   test-execution check closes the ask WITHOUT a model re-invocation; but
 *   the check must prove the ask's test SCOPE too — `Unit Tests` cannot
 *   discharge `run integration tests`, and a full-suite ask needs an
 *   explicit exhaustive identity (`test suite`, `full test suite`,
 *   `all tests`), not a vague generic `test`/`test (24)` name (an
 *   ambiguous green says nothing provable about the requested tests);
 * - precedence is failure-first — a matching test-named check that went red
 *   on the exact head refutes discharge even when a sibling matrix leg is
 *   green (one red leg means the suite did not pass);
 * - a validated NEGATIVE head-bound test-execution check contradicts a
 *   reviewer disposition that claimed `satisfied`: the row becomes
 *   `unresolved` with a mismatch reason, so the published review carries ONE
 *   disposition, not both claims (#1381: contradiction only strengthens the
 *   approval fence);
 * - every non-discharge carries a bounded reason code; capability /
 *   missing-source / transport / budget / timeout shaped failures keep the
 *   row `unresolved`, never satisfied;
 * - missing evidence (null) means this module changes NOTHING — the
 *   pre-#1594 behavior byte-for-byte.
 *
 * The matchers are bounded heuristics: deterministic, explainable, and
 * erring toward NOT discharging (a missed discharge costs a revision cycle;
 * a false discharge would certify an untested claim).
 */
import type { RequiredCheckRow } from "./required-checks.js";
import type { ReviewObligation } from "./review-obligations.js";
import type { RowEvidenceState } from "./evidence-receipts.js";

export interface CiEvidenceCheck {
  name: string;
  state: string;
  conclusion: string | null;
}

export interface HeadBoundCiEvidence {
  /** Exact head the CI gate pinned for the whole wait. */
  headSha: string;
  /** The gate's own final fold: "success" | "failure" | "none". */
  finalState: string;
  checks: CiEvidenceCheck[];
}

const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/i;
/** Producer/consumer limits. The CI gate imports these so it can never emit
 * an artifact this parser refuses (#1594 review). Lengths are UTF-16 code
 * units, which is what `String#length` and this parser measure. */
export const MAX_EVIDENCE_CHECKS = 50;
export const MAX_EVIDENCE_FIELD_LENGTH = 200;
export const MAX_EVIDENCE_RAW_JSON_CHARS = 16384;
const EVIDENCE_STATES: ReadonlySet<string> = new Set(["pending", "success", "failure"]);
const EVIDENCE_FINAL_STATES: ReadonlySet<string> = new Set(["success", "failure", "none"]);

function validatedEvidenceRow(row: unknown): CiEvidenceCheck | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const entry = row as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (key !== "name" && key !== "state" && key !== "conclusion") return null;
  }
  if (typeof entry.name !== "string" || entry.name === "" || entry.name.length > MAX_EVIDENCE_FIELD_LENGTH) return null;
  if (typeof entry.state !== "string" || !EVIDENCE_STATES.has(entry.state)) return null;
  if (entry.conclusion !== undefined
    && !(entry.conclusion === null || (typeof entry.conclusion === "string" && entry.conclusion.length <= MAX_EVIDENCE_FIELD_LENGTH))) {
    return null;
  }
  return {
    name: entry.name,
    state: entry.state,
    conclusion: entry.conclusion === undefined ? null : entry.conclusion as string | null,
  };
}

/**
 * Strict parser for the gate's head-bound evidence artifact VALUE. Anything
 * this runtime did not write — an unknown key, a bad SHA or state shape, an
 * oversized row list — yields `null` (fail closed): an unusable artifact
 * behaves exactly like no artifact.
 */
export function parseHeadBoundCiEvidenceValue(value: unknown): HeadBoundCiEvidence | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "head_sha" && key !== "final_state" && key !== "checks") return null;
  }
  if (record.version !== 1) return null;
  if (typeof record.head_sha !== "string" || !HEAD_SHA_RE.test(record.head_sha)) return null;
  if (typeof record.final_state !== "string" || !EVIDENCE_FINAL_STATES.has(record.final_state)) return null;
  if (!Array.isArray(record.checks) || record.checks.length > MAX_EVIDENCE_CHECKS) return null;
  const checks: CiEvidenceCheck[] = [];
  for (const row of record.checks) {
    const validated = validatedEvidenceRow(row);
    if (validated === null) return null;
    checks.push(validated);
  }
  return { headSha: record.head_sha, finalState: record.final_state, checks };
}

/** Parse the gate-output line (compact JSON) with an input byte cap applied
 * BEFORE `JSON.parse` — an oversized line is refused, not parsed. */
export function parseHeadBoundCiEvidence(rawJson: string | null | undefined): HeadBoundCiEvidence | null {
  if (typeof rawJson !== "string" || rawJson === "" || rawJson.length > MAX_EVIDENCE_RAW_JSON_CHARS) return null;
  try {
    return parseHeadBoundCiEvidenceValue(JSON.parse(rawJson) as unknown);
  } catch {
    return null;
  }
}

/** The obligation asks for a test RUN: the word `test`/`tests` AND an
 * execution verb. "run full test suite after upgrade" qualifies;
 * "document the test suite" does not (no execution verb — prose ABOUT a
 * suite is not a run of one). */
const TEST_WORD_RE = /\btests?\b/;
const TEST_EXECUTION_VERB_RE = /\b(?:run|ran|running|execute|executed|executing|pass|passes|passed|passing|green)\b/;

export function isTestExecutionObligation(text: string): boolean {
  const lower = text.toLowerCase();
  return TEST_WORD_RE.test(lower) && TEST_EXECUTION_VERB_RE.test(lower);
}

/** A delimited `test`/`tests` word: bounded by start/end or one of the
 * name-separator characters CI check names actually use. Word-delimited (not
 * substring) so `latest` never reads as a test run. */
const TEST_NAME_WORD_RE = /(?:^|[\s/\\()\[\]{},;:._|-])tests?(?:$|[\s/\\()\[\]{},;:._|-])/;
/** Substring tokens that disqualify a name from denoting a test EXECUTION:
 * coverage/reporting/upload/publish/deploy/image/scan/analysis/lint/docs/
 * formatting jobs run against (or replace) tests, they do not run them.
 * Substring matching errs toward disqualifying — the conservative direction
 * for a discharge. */
const TEST_NAME_DISQUALIFIERS = [
  "coverage", "codecov", "report", "upload", "publish", "deploy", "docker",
  "image", "scan", "analysis", "codeql", "lint", "docs", "prettier", "fmt",
] as const;

export function isTestExecutionCheckName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!TEST_NAME_WORD_RE.test(lower)) return false;
  return !TEST_NAME_DISQUALIFIERS.some((token) => lower.includes(token));
}

/**
 * Narrow test scopes a name can denote. A check carrying one of these runs
 * PART of the suite: it can prove an ask for that same scope, but it cannot
 * prove a full-suite ask, and a different scope says nothing about the
 * requested tests. Unrecognized scopes stay unresolved by construction
 * (conservative).
 */
const TEST_SCOPE_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["unit", ["unit"]],
  ["integration", ["integration"]],
  ["e2e", ["e2e", "end to end", "end2end"]],
  ["smoke", ["smoke"]],
  ["acceptance", ["acceptance"]],
  ["contract", ["contract"]],
  ["regression", ["regression"]],
  ["performance", ["performance", "perf"]],
  ["load", ["load"]],
  ["browser", ["browser"]],
  ["ui", ["ui"]],
  ["api", ["api"]],
  ["functional", ["functional"]],
  ["mutation", ["mutation"]],
  ["fuzz", ["fuzz"]],
];

/** Lowercase, collapse every non-alphanumeric run to one space, and pad so
 * aliases can be matched as whole words (so `latest`/`download` never read
 * as `test`/`load`). `end-to-end` and `end to end` normalize identically. */
function normalizedTestScopeText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function testScopesIn(text: string): string[] {
  const normalized = normalizedTestScopeText(text);
  return TEST_SCOPE_ALIASES
    .filter(([, aliases]) => aliases.some((alias) => normalized.includes(` ${alias} `)))
    .map(([scope]) => scope);
}

/** `full`/`all`/`entire`/`complete`/`exhaustive`/`suite` marks a whole-suite
 * ask; a narrow leg is not proof of it. `all unit tests` remains a
 * unit-scoped ask because the scope check runs first. */
const FULL_TEST_SUITE_RE = / (?:full|all|entire|complete|exhaustive|suite) /;

function asksForFullTestSuite(text: string): boolean {
  return FULL_TEST_SUITE_RE.test(normalizedTestScopeText(text));
}

type ScopeMatchMode = "discharge" | "contradiction";

/** `discharge` needs PROOF of every requested scope; `contradiction` only
 * needs the red leg to belong to the requested scope (a red unit leg cannot
 * refute an integration-only ask). A full-suite ask needs an EXPLICIT
 * exhaustive identity in the name (`test suite`, `full test suite`,
 * `all tests`, ...) with no narrow scope; a bare generic `test`/`tests`/
 * `test (24)` name does not prove which suite ran, so it stays unresolved.
 * A generic ask accepts any test execution. */
function checkCoversRequestedScope(
  name: string,
  requestedScopes: readonly string[],
  fullSuite: boolean,
  mode: ScopeMatchMode,
): boolean {
  const provided = testScopesIn(name);
  if (requestedScopes.length > 0) {
    return mode === "contradiction"
      ? requestedScopes.some((scope) => provided.includes(scope))
      : requestedScopes.every((scope) => provided.includes(scope));
  }
  if (mode === "contradiction") return true;
  if (!fullSuite) return true;
  return provided.length === 0 && FULL_TEST_SUITE_RE.test(normalizedTestScopeText(name));
}

/**
 * Canonical decision identity of a check NAME: whether it denotes test
 * execution at all, the narrow test scopes it proves, and whether it carries
 * an explicit exhaustive (`suite`/`full`/`all`) identity. The evidence
 * producer compares this before and after field truncation, so a truncated
 * name can never silently lose a test suffix, a scope, or a disqualifier and
 * change what the enforcement pass is allowed to conclude from it.
 */
export function ciCheckIdentity(name: string): string {
  const testExecution = isTestExecutionCheckName(name);
  const scopes = testScopesIn(name);
  const exhaustive = testExecution && asksForFullTestSuite(name);
  return `${testExecution ? "test" : "other"}|${scopes.join(",")}|${exhaustive ? "exhaustive" : "plain"}`;
}

export type CiDischargeReason =
  | "no-ci-evidence"
  | "head-mismatch"
  | "no-matching-test-check"
  | "test-check-not-success"
  | "test-check-succeeded"
  | "test-check-contradicted";

export interface CiDischarge {
  applies: boolean;
  outcome: "satisfied" | "unresolved" | "contradicted" | "none";
  reason: CiDischargeReason | null;
  check: CiEvidenceCheck | null;
}

const NOT_APPLICABLE: CiDischarge = { applies: false, outcome: "none", reason: null, check: null };

/**
 * The single disposition for one check text against head-bound evidence.
 * `applies: false` means the text does not ask for a test run at all — the
 * row is left alone. A succeeded head-bound test-execution check that also
 * covers the requested test scope DISCHARGES; a failed in-scope one
 * CONTRADICTS; everything else keeps the row unresolved with a bounded
 * reason code. GitHub `skipped`/`neutral` conclusions arrive with collapsed
 * state `success`, so discharge requires the explicit
 * `conclusion === "success"` (or a state-only row with no conclusion).
 */
export function ciDischargeForCheckText(
  checkText: string,
  evidence: HeadBoundCiEvidence | null,
  reviewedHeadSha: string,
): CiDischarge {
  if (!isTestExecutionObligation(checkText)) return NOT_APPLICABLE;
  if (evidence === null) return { applies: true, outcome: "unresolved", reason: "no-ci-evidence", check: null };
  if (reviewedHeadSha === "" || evidence.headSha.toLowerCase() !== reviewedHeadSha.toLowerCase()) {
    return { applies: true, outcome: "unresolved", reason: "head-mismatch", check: null };
  }
  const requestedScopes = testScopesIn(checkText);
  const fullSuite = asksForFullTestSuite(checkText);
  const matching = evidence.checks.filter((check) => isTestExecutionCheckName(check.name));
  if (matching.length === 0) return { applies: true, outcome: "unresolved", reason: "no-matching-test-check", check: null };
  // Precedence is failure-first: an in-scope test-named check that went RED
  // on the exact head refutes discharge even when a sibling matrix leg is
  // green — one red leg of a test matrix means the suite did not pass.
  const inScope = matching.filter((check) => checkCoversRequestedScope(check.name, requestedScopes, fullSuite, "contradiction"));
  const failed = inScope.find((check) => check.state === "failure");
  if (failed !== undefined) return { applies: true, outcome: "contradicted", reason: "test-check-contradicted", check: failed };
  // A full-suite ask needs every in-scope test check settled green: a
  // pending leg, or a `skipped`/`neutral` leg collapsed to state success,
  // means the suite did not (fully) run. A narrow ask only waits on its own
  // scope, so an unrelated pending/red leg neither blocks nor refutes it.
  const unsettled = inScope.find((check) => check.state !== "success"
    || (check.conclusion !== null && check.conclusion !== "success"));
  if (unsettled !== undefined) return { applies: true, outcome: "unresolved", reason: "test-check-not-success", check: null };
  const dischargeable = matching.filter((check) => checkCoversRequestedScope(check.name, requestedScopes, fullSuite, "discharge"));
  if (dischargeable.length === 0) return { applies: true, outcome: "unresolved", reason: "no-matching-test-check", check: null };
  const succeeded = dischargeable.find((check) => check.state === "success"
    && (check.conclusion === null || check.conclusion === "success"));
  if (succeeded !== undefined) return { applies: true, outcome: "satisfied", reason: "test-check-succeeded", check: succeeded };
  return { applies: true, outcome: "unresolved", reason: "test-check-not-success", check: null };
}

/**
 * Reconcile the #750 coverage rows against head-bound evidence. Works on
 * shallow copies (the input rows are never mutated):
 * - an `unresolved` test-run row is DISCHARGED by a head-bound green
 *   test-execution check (rationale replaced with the CI provenance);
 * - an `unresolved` row the model never dispositioned gets its reason
 *   refined to `ci-evidence-<code>` (status unchanged — the evidence says
 *   WHY it stayed open, including the negative `test-check-contradicted`
 *   answer); other reasons (malformed/duplicate) untouched;
 * - a model-completed row — `satisfied` or `not_applicable` — that carries
 *   the fold's own `ok` reason and is contradicted by a head-bound FAILED
 *   test-execution check becomes `unresolved` with
 *   `ci-evidence-contradiction` — one published disposition, not two. The
 *   not_applicable arm keeps the coverage fold and the obligation fold
 *   (#1381) in agreement: `foldObligationDispositions` folds a must_check
 *   `not_applicable`+rationale into a `satisfied` obligation row, and the
 *   obligation side contradicts that row — both layers must downgrade
 *   together or the two structured artifacts disagree.
 */
export function reconcileRequiredCheckRows(
  rows: readonly RequiredCheckRow[],
  evidence: HeadBoundCiEvidence | null,
  reviewedHeadSha: string,
): { rows: RequiredCheckRow[]; discharged: number; contradicted: number } {
  // No evidence means NO reconciliation at all: every row keeps its exact
  // pre-#1594 shape (the `no-ci-evidence` discharge reason exists for
  // callers that ask per-row; it never rewrites a coverage artifact).
  if (evidence === null) return { rows: [...rows], discharged: 0, contradicted: 0 };
  let discharged = 0;
  let contradicted = 0;
  const reconciled = rows.map((row) => {
    const discharge = ciDischargeForCheckText(row.check, evidence, reviewedHeadSha);
    if (row.status === "unresolved" && discharge.outcome === "satisfied" && discharge.check !== null) {
      discharged += 1;
      return {
        ...row,
        status: "satisfied" as const,
        rationale: `trusted CI check "${discharge.check.name}" succeeded on head ${evidence.headSha}`,
        reason: "ci-evidence",
      };
    }
    if (row.status === "unresolved" && discharge.applies
      && (discharge.outcome === "unresolved" || discharge.outcome === "contradicted")
      && discharge.reason !== null
      && (row.reason === "no-disposition" || row.reason === "no-structured-dispositions")) {
      return { ...row, reason: `ci-evidence-${discharge.reason}` };
    }
    if ((row.status === "satisfied" || row.status === "not_applicable") && row.reason === "ok" && discharge.outcome === "contradicted") {
      contradicted += 1;
      return { ...row, status: "unresolved" as const, rationale: null, reason: "ci-evidence-contradiction" };
    }
    return row;
  });
  return { rows: reconciled, discharged, contradicted };
}

/**
 * Reconcile the #1381 obligation rows against head-bound evidence. Only the
 * review-owned required sources (`must_check`, `trusted_base_guidance`) are
 * eligible — derived/coverage markers are #1449 territory and CI evidence
 * never reconciles them, and forcing (`unmet`) rows are confirmed negatives
 * evidence cannot argue away.
 * - unresolved + validated green test-execution check → `satisfied` with a
 *   `resolvedBy` provenance record (the discharge is deterministic, not a
 *   model disposition);
 * - model-claimed-satisfied (no cause) + validated FAILED check →
 *   `unresolved` again (the contradiction wins; satisfaction without
 *   validated evidence is not certifiable).
 * Unchanged rows keep their object identity; the array is always new.
 */
export function reconcileObligationsWithCiEvidence(
  obligations: readonly ReviewObligation[],
  evidence: HeadBoundCiEvidence | null,
  reviewedHeadSha: string,
): ReviewObligation[] {
  return obligations.map((obligation) => {
    if (obligation.source !== "must_check" && obligation.source !== "trusted_base_guidance") return obligation;
    const discharge = ciDischargeForCheckText(obligation.text, evidence, reviewedHeadSha);
    if (obligation.status === "unresolved" && discharge.outcome === "satisfied" && discharge.check !== null && evidence !== null) {
      // #1657: the CI discharge is itself receipt-backed provenance — stamp
      // the row's evidence state so the obligation artifact and the ledger's
      // CI receipts tell one story (the id scheme matches the ledger's
      // `ci:<check name>` receipts).
      const ciEvidenceState: RowEvidenceState = {
        rowClass: obligation.rowClass ?? "objective",
        gate: "ci-evidence",
        state: "receipt-backed",
        receipts: [`ci:${discharge.check.name.slice(0, 100)}`],
      };
      return {
        ...obligation,
        status: "satisfied" as const,
        cause: null,
        resolvedBy: { kind: "ci-evidence" as const, check: discharge.check.name, headSha: evidence.headSha },
        ...(obligation.source === "must_check" ? { evidence: ciEvidenceState } : {}),
      };
    }
    if (obligation.status === "satisfied" && obligation.cause === null && discharge.outcome === "contradicted") {
      const { resolvedBy: _resolvedBy, ...rest } = obligation;
      return { ...rest, status: "unresolved" as const };
    }
    return obligation;
  });
}
