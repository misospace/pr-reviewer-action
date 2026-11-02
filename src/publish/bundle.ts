/**
 * The machine-readable review bundle (#1425).
 *
 * The published Markdown comment is the human presentation surface; this is
 * the automation surface: one bounded, versioned JSON document per action
 * run that a coding agent can consume without scraping rendered comments.
 *
 * Contract discipline follows the #1027 `finding-outcomes/v1` ledger:
 * a strict schema string that fails closed on parse, snake_case persisted
 * fields, bounded-and-redacted construction (every text field passes
 * `redactText` and a codepoint cap BEFORE serialization, so no secret and no
 * unbounded model text can reach the output even if a caller forgets), and
 * deterministic serialization (fixed key order, no `undefined` members).
 *
 * Security properties, by construction rather than by validation:
 * - The output is a single-line JSON document produced by `JSON.stringify`,
 *   so finding text — however hostile (quotes, braces, newlines, fake
 *   headings, delimiter tokens) — is confined to its own string value and
 *   can never forge structure.
 * - The aggregate byte bound is enforced on the exact serialized string:
 *   findings are admitted only while the document still fits
 *   `REVIEW_BUNDLE_MAX_BYTES`, and an omission is disclosed by
 *   `findings_total`/`findings_truncated` rather than passed off as the
 *   whole set.
 * - `findings` is PRESENT (possibly empty) only when a review actually
 *   produced a verdict (`complete`/`partial`/`superseded`); a `skipped` or
 *   `failed` bundle carries no `findings` key at all, so "no findings" and
 *   "no review" are distinguishable by field presence alone.
 */
import { redactText } from "../context/redact.js";
import { pyCodepointSlice } from "../platform/py.js";
import { findingIdentityFromRecord } from "../outcomes/identity.js";

/** The schema identifier. A consumer must refuse a document whose `schema`
 * is not byte-identical to this string (the ledger pattern, #1027). */
export const REVIEW_BUNDLE_SCHEMA = "review-bundle/v1";

/** The closed lifecycle vocabulary. Every run that reaches an output
 * boundary lands in exactly one of these:
 * - `complete`: a review finished with full coverage.
 * - `partial`: a review finished but its execution or requirement-trace
 *   coverage was incomplete (or its publication carried partial coverage).
 * - `skipped`: no review ran (precheck skip, plain-issue no-op, follow-up
 *   consumption). A carried verdict may still appear in `disposition`.
 * - `failed`: the run crashed and produced no verdict.
 * - `superseded`: the review completed but publication was withheld at the
 *   publication boundary because a newer push landed; the bundle documents
 *   the EXACT head that was reviewed, which is what a consumer compares
 *   against the current PR head to prove staleness. */
export const REVIEW_BUNDLE_STATES = ["complete", "partial", "skipped", "failed", "superseded"] as const;
export type ReviewBundleState = (typeof REVIEW_BUNDLE_STATES)[number];

export function isReviewBundleState(value: unknown): value is ReviewBundleState {
  return typeof value === "string" && (REVIEW_BUNDLE_STATES as readonly string[]).includes(value);
}

/** Hard ceiling on the whole serialized document (UTF-8 bytes). The bundle
 * rides a step output and a run-directory file; nothing in it is worth more
 * than this, and a consumer can rely on the cap without trusting the
 * producer. */
export const REVIEW_BUNDLE_MAX_BYTES = 65_536;

/** Findings admitted before the `findings_truncated` disclosure fires. */
export const REVIEW_BUNDLE_MAX_FINDINGS = 100;

/** Per-field codepoint caps applied AFTER redaction. */
export const REVIEW_BUNDLE_MAX_MESSAGE_CHARS = 1_000;
export const REVIEW_BUNDLE_MAX_SUGGESTION_CHARS = 500;
export const REVIEW_BUNDLE_MAX_AGENT_PROMPT_CHARS = 1_000;
export const REVIEW_BUNDLE_MAX_FILE_CHARS = 300;
export const REVIEW_BUNDLE_MAX_CATEGORY_CHARS = 64;
export const REVIEW_BUNDLE_MAX_TOKEN_CHARS = 200;
export const REVIEW_BUNDLE_MAX_FAILURE_REASON_CHARS = 200;

const BUNDLE_SEVERITIES = ["blocker", "major", "minor", "info"] as const;

/** Every text field of the bundle goes through this: redaction first (a
 * secret must not survive into a machine artifact), then the caller's cap.
 * Idempotent with the publish/outputs boundary (`redactText` is idempotent). */
function redactBounded(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return pyCodepointSlice(redactText(text), max);
}

export interface ReviewBundleFinding {
  /** Stable cross-run identity (the #1027 finding identity digest) when the
   * record can prove one; null when it cannot (unanchorable path, empty
   * message). Never a positional index — those drift between reruns. */
  id: string | null;
  severity: string;
  category: string;
  /** Closed to `open` today: every finding listed here was still open when
   * the review completed. Cross-run resolution state lives in the
   * finding-outcomes ledger, not in this snapshot. */
  status: "open";
  file: string | null;
  line: number | null;
  end_line?: number;
  message: string;
  suggestion?: string;
  agent_prompt?: string;
}

export interface ReviewBundleInput {
  /** Lifecycle state chosen by the host (the only component that knows the
   * publication outcome). */
  state: ReviewBundleState;
  /** Random per-run identifier, pairs with `head_sha` to name THIS bundle's
   * review of THIS head across reruns. */
  reviewId: string;
  /** ISO-8601 UTC timestamp; injectable so serialization is deterministic
   * under test. */
  generatedAt: string;
  repository: string;
  /** PR number as a number, or null when the run could not prove one. */
  prNumber: number | null;
  /** Exact head SHA this run reviewed (or tried to). "" when unknown. */
  headSha: string;
  /** Base SHA when known. "" when unknown. */
  baseSha: string;
  /** Configuration/model identity of the run. */
  identity: {
    diffFingerprint: string;
    analysisEngine: string;
    actionVersion: string;
  };
  /** Authoritative disposition. Included for review-producing states and
   * for a skipped run's CARRIED verdict (fields then describe the carried
   * decision, and `verdict_source` names its origin, e.g. `carry_forward`);
   * omitted for `failed`. */
  disposition?: {
    verdict: string;
    verdictSource: string;
    requiredChecks: string;
    reviewResult: string;
    incompleteReason: string;
    degraded: boolean;
  };
  /** Publication outcome for this run, only when publication was attempted
   * (mirrors the `publish-status` output). */
  publication?: { status: "published" | "superseded" | "failed" };
  /** Fixed skip constant, `skipped` state only. */
  skipReason?: string;
  /** Bounded, redacted failure shape, `failed` state only. Never a stack
   * trace, a request body, or credential material. */
  failureReason?: string;
  /** Normalized findings (the review artifact's finding records); consulted
   * only for the review-producing states. */
  findings: unknown;
}

interface BundleFindingCandidate {
  record: Record<string, unknown>;
}

function normalizeFinding(value: unknown): BundleFindingCandidate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return { record: value as Record<string, unknown> };
}

/** Project one artifact finding into the bundle's normalized record:
 * bounded, redacted, closed-vocabulary severity (anything the normalizer
 * could not have produced is honestly reported as `info`), and the stable
 * #1027 identity digest where one is provable. */
function bundleFinding(record: Record<string, unknown>): ReviewBundleFinding {
  const rawSeverity = typeof record.severity === "string" ? record.severity : "info";
  const severity = (BUNDLE_SEVERITIES as readonly string[]).includes(rawSeverity) ? rawSeverity : "info";
  const file = typeof record.file === "string" && record.file !== ""
    ? redactBounded(record.file, REVIEW_BUNDLE_MAX_FILE_CHARS)
    : null;
  const line = typeof record.line === "number" && Number.isFinite(record.line) ? Math.trunc(record.line) : null;
  const finding: ReviewBundleFinding = {
    id: findingIdentityFromRecord(record),
    severity,
    category: redactBounded(record.category ?? "", REVIEW_BUNDLE_MAX_CATEGORY_CHARS),
    status: "open",
    file,
    line,
    message: redactBounded(record.message ?? "", REVIEW_BUNDLE_MAX_MESSAGE_CHARS),
  };
  if (typeof record.end_line === "number" && Number.isFinite(record.end_line)) {
    finding.end_line = Math.trunc(record.end_line);
  }
  if (typeof record.suggestion === "string" && record.suggestion !== "") {
    finding.suggestion = redactBounded(record.suggestion, REVIEW_BUNDLE_MAX_SUGGESTION_CHARS);
  }
  if (typeof record.agent_prompt === "string" && record.agent_prompt !== "") {
    finding.agent_prompt = redactBounded(record.agent_prompt, REVIEW_BUNDLE_MAX_AGENT_PROMPT_CHARS);
  }
  return finding;
}

function parseFindingsArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Build the deterministic `review-bundle/v1` document (single-line JSON).
 * The envelope fields are serialized first and the findings array is then
 * admitted one record at a time only while the WHOLE document still fits
 * `REVIEW_BUNDLE_MAX_BYTES` — the worst-case disclosure (both findings
 * counters at their largest reachable values) is reserved up front, so the
 * byte bound holds for the exact string returned. */
export function buildReviewBundle(input: ReviewBundleInput): string {
  const envelope: Record<string, unknown> = {
    schema: REVIEW_BUNDLE_SCHEMA,
    review_id: redactBounded(input.reviewId, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    generated_at: redactBounded(input.generatedAt, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    action_version: redactBounded(input.identity.actionVersion, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    repository: redactBounded(input.repository, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    pr_number: input.prNumber,
    head_sha: redactBounded(input.headSha, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    base_sha: redactBounded(input.baseSha, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    state: input.state,
    identity: {
      diff_fingerprint: redactBounded(input.identity.diffFingerprint, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      analysis_engine: redactBounded(input.identity.analysisEngine, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
    },
  };
  if (input.disposition !== undefined) {
    envelope.disposition = {
      verdict: redactBounded(input.disposition.verdict, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      verdict_source: redactBounded(input.disposition.verdictSource, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      required_checks: redactBounded(input.disposition.requiredChecks, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      review_result: redactBounded(input.disposition.reviewResult, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      incomplete_reason: redactBounded(input.disposition.incompleteReason, REVIEW_BUNDLE_MAX_TOKEN_CHARS),
      degraded: input.disposition.degraded === true,
    };
  }
  if (input.publication !== undefined) {
    envelope.publication = { status: input.publication.status };
  }
  if (input.state === "skipped" && input.skipReason !== undefined && input.skipReason !== "") {
    envelope.skip_reason = redactBounded(input.skipReason, REVIEW_BUNDLE_MAX_TOKEN_CHARS);
  }
  if (input.state === "failed") {
    envelope.failure_reason = redactBounded(input.failureReason ?? "unknown error", REVIEW_BUNDLE_MAX_FAILURE_REASON_CHARS);
  }

  const reviewsProduced = input.state === "complete" || input.state === "partial" || input.state === "superseded";
  const candidates = reviewsProduced
    ? parseFindingsArray(input.findings).flatMap((item) => {
      const candidate = normalizeFinding(item);
      return candidate === null ? [] : [candidate];
    })
    : [];
  // Every review-producing document ends with the disclosure segment
  // `,"findings":[…],"findings_total":N,"findings_truncated":b`. Measure it
  // (empty-array shape, true truncation flag) into the base up front, then
  // charge one comma per included finding, so the byte bound holds for the
  // exact string returned no matter how the counters land.
  const disclosure = JSON.stringify({ findings: [], findings_total: candidates.length, findings_truncated: true }).slice(1, -1);
  let bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8") + (reviewsProduced ? disclosure.length + 1 : 0);
  const included: ReviewBundleFinding[] = [];
  for (const candidate of candidates.slice(0, REVIEW_BUNDLE_MAX_FINDINGS)) {
    const finding = bundleFinding(candidate.record);
    const findingBytes = Buffer.byteLength(JSON.stringify(finding), "utf8") + 1;
    if (bytes + findingBytes > REVIEW_BUNDLE_MAX_BYTES) break;
    bytes += findingBytes;
    included.push(finding);
  }
  if (reviewsProduced) {
    envelope.findings = included;
    envelope.findings_total = candidates.length;
    envelope.findings_truncated = included.length < candidates.length;
  }
  return JSON.stringify(envelope);
}

export interface ReviewBundle {
  schema: typeof REVIEW_BUNDLE_SCHEMA;
  review_id: string;
  generated_at: string;
  action_version: string;
  repository: string;
  pr_number: number | null;
  head_sha: string;
  base_sha: string;
  state: ReviewBundleState;
  identity: { diff_fingerprint: string; analysis_engine: string };
  disposition?: Record<string, unknown>;
  publication?: { status: string };
  skip_reason?: string;
  failure_reason?: string;
  findings?: unknown[];
  findings_total?: number;
  findings_truncated?: boolean;
}

/** Fail-closed parse of a bundle document: exact schema string, closed
 * state vocabulary, and required field types, or null. A consumer of the
 * `review-bundle` output must treat anything this refuses as absent. */
export function parseReviewBundle(text: string): ReviewBundle | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== REVIEW_BUNDLE_SCHEMA) return null;
  if (!isReviewBundleState(record.state)) return null;
  if (typeof record.review_id !== "string" || record.review_id === "") return null;
  if (typeof record.generated_at !== "string") return null;
  if (typeof record.repository !== "string") return null;
  if (!(record.pr_number === null || (typeof record.pr_number === "number" && Number.isInteger(record.pr_number)))) return null;
  if (typeof record.head_sha !== "string" || typeof record.base_sha !== "string") return null;
  const identity = record.identity;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) return null;
  const identityRecord = identity as Record<string, unknown>;
  if (typeof identityRecord.diff_fingerprint !== "string" || typeof identityRecord.analysis_engine !== "string") return null;
  if (record.publication !== undefined) {
    const publication = record.publication;
    if (publication === null || typeof publication !== "object" || Array.isArray(publication)) return null;
    const status = (publication as Record<string, unknown>).status;
    if (status !== "published" && status !== "superseded" && status !== "failed") return null;
  }
  // State-specific key rules, enforced on parse as strictly as on build:
  // the presence/absence of `findings` is the "no review vs no findings"
  // contract, so a foreign document may not smuggle a findings set (or a
  // skip/failure reason) onto a state that contradicts it.
  const reviewProducing = record.state === "complete" || record.state === "partial" || record.state === "superseded";
  if (record.findings !== undefined) {
    if (!reviewProducing) return null;
    if (!Array.isArray(record.findings)) return null;
    if (typeof record.findings_total !== "number" || typeof record.findings_truncated !== "boolean") return null;
  }
  if (record.skip_reason !== undefined && (typeof record.skip_reason !== "string" || record.state !== "skipped")) return null;
  if (record.failure_reason !== undefined && (typeof record.failure_reason !== "string" || record.state !== "failed")) return null;
  const bundle = {
    schema: REVIEW_BUNDLE_SCHEMA,
    review_id: record.review_id,
    generated_at: record.generated_at,
    action_version: typeof record.action_version === "string" ? record.action_version : "",
    repository: record.repository,
    pr_number: record.pr_number,
    head_sha: record.head_sha,
    base_sha: record.base_sha,
    state: record.state,
    identity: { diff_fingerprint: identityRecord.diff_fingerprint, analysis_engine: identityRecord.analysis_engine },
  } as ReviewBundle;
  if (record.disposition !== undefined && typeof record.disposition === "object" && record.disposition !== null && !Array.isArray(record.disposition)) {
    bundle.disposition = record.disposition as Record<string, unknown>;
  }
  if (record.publication !== undefined) bundle.publication = record.publication as { status: string };
  if (typeof record.skip_reason === "string") bundle.skip_reason = record.skip_reason;
  if (typeof record.failure_reason === "string") bundle.failure_reason = record.failure_reason;
  if (record.findings !== undefined) {
    bundle.findings = record.findings;
    bundle.findings_total = record.findings_total as number;
    bundle.findings_truncated = record.findings_truncated as boolean;
  }
  return bundle;
}
