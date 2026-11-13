/**
 * Review-owned required-evidence obligations (#1381).
 *
 * A review obligation is evidence the review contract requires the reviewer
 * to establish with configured repository/upstream/evidence tools — the
 * counterpart of #977's external/manual verification asks, which stay
 * non-blocking because the reviewer genuinely has no capability to check
 * them. An obligation that stays unresolved must never be collapsed into an
 * ordinary `category=verification` finding and must never be certified by a
 * native APPROVE.
 *
 * Sources (closed, extensible enum):
 * - `must_check` — the deterministic classification checklist (#750). Once
 *   represented as an obligation row its verdict semantics are #1381's: an
 *   unresolved row never certifies a native APPROVE. #750's
 *   REQUIRED_CHECK_VALIDATION_MODE keeps owning its completeness markdown
 *   (the "Unaddressed required checks" section and partial marker);
 *   `VALIDATE_REQUIRED_CHECKS=false` removes must_check rows from the
 *   obligation contract entirely (an explicit operator opt-out of the whole
 *   checklist enforcement, honored by both the harness and the engine).
 * - `trusted_base_guidance` — explicit approval-prerequisite sentences
 *   deterministically extracted from the trusted-base standards content the
 *   tool harness injected into the review context. Prose is NOT blindly
 *   trusted: a sentence qualifies only with a verification verb AND a
 *   reviewer-gatherable scope cue, gated by an explicit approval cue in the
 *   sentence itself OR in the markdown heading of the section it lives under
 *   (the real trusted-base shape is `## Evidence required before approval`
 *   followed by the concrete asks — #1381 review).
 * - `derived` — the cross-path architectural obligations the #1448 pre-pass
 *   derived from the change itself (identity/dedupe keys, converging
 *   producers, persistence/recovery, trust boundaries, ordering,
 *   compatibility). These are the obligations the PR never states, so they
 *   cannot be extracted from trusted prose: the rows are built by
 *   `src/enforcement/derived-obligations.ts` from the pre-pass artifact and
 *   carry the derivation's declared locations as `anchors`. A derived row is
 *   discharged only by evidence that NAMES one of those locations (#1449).
 *   An undischarged derived row is a COVERAGE statement, never a defect
 *   claim (#1447): it withholds the trusted approval at the publish boundary
 *   and marks the review partial, but it never manufactures a blocking
 *   request (see `isForcingObligation`).
 * - `risk` — the risk-specific EVIDENCE obligations the deterministic scan
 *   of `src/risk/classify.ts` raised because the changed code touches file
 *   identity/path mode, bounded state/concurrency, persisted state, or a
 *   credential/security boundary (#1577). Like the derived rows these carry
 *   the flagged paths as `anchors` and are discharged only by a rationale
 *   that names one of them AND states the risk-specific counterexample
 *   considered. #1577 (review fix): the named location must ALSO be backed
 *   by the run's own evidence receipt (`RiskEvidenceReceipt`) — a
 *   successful tool read of it or its complete head diff certified into the
 *   review corpus — so proof-shaped prose with zero inspected lines cannot
 *   discharge the row; an undischarged risk row is coverage (approval
 *   withheld, review partial), never a fabricated blocker, and a real
 *   counterexample belongs in the ordinary findings.
 *
 * The deterministic layer enforces presence and shape only (matching the
 * #750 baseline): a disposition discharges an obligation when its identity
 * matches and it carries the rationale its source contract requires (see
 * `foldObligationDispositions`); whether a rationale is semantically
 * grounded is judged elsewhere (eval corpus / review readers).
 * The hard-force gate fires only for an `unmet` (confirmed-negative)
 * FORCING row (#1505, status-based): the `must_check` and
 * `trusted_base_guidance` sources are review-owned required checks the
 * reviewer was expected and equipped to perform, so those two never carry
 * different approval semantics (#1381 review) — but an `unresolved` row is
 * incomplete coverage, never a defect: it withholds the trusted approve
 * at the publish boundary and marks the review partial instead of forcing
 * a block. The strict mapping's anti-relaxation signal remains as the
 * standalone guard for direct callers.
 */
import type { ReviewArtifact } from "./artifact.js";
import type { RequiredCheckDispositionReceipt } from "../model/types.js";
import { forceRequestChanges } from "./enforce.js";
import { fenceDelimiterFor } from "../context/fence.js";
import { anchorCoveredBy, namesPathLikeToken, rationaleAssertsFailure } from "./derived-obligations.js";
import { corpusDiffCoveredFiles, readPathsFromToolLog } from "../tools/coverage.js";
import {
  REQUIRED_EVIDENCE_ROW_CLASSES,
  evidenceTagFor,
  evidenceTagIndex,
  evaluateRowEvidence,
  receiptRefusalReason,
  rowEvidenceStateToArtifact,
  type CheckEvidenceTagWithText,
  type DependencyEvidenceObligation,
  type EvidenceGateKind,
  type EvidenceLedger,
  type RequiredEvidenceRowClass,
  type RowEvidenceState,
} from "./evidence-receipts.js";

export type ReviewObligationSource = "must_check" | "trusted_base_guidance" | "derived" | "risk";

/**
 * #1627/#1657: content-free per-row rejection reason — WHY a row ended in the
 * status it carries. Kebab-case, mirroring the #750 reason vocabulary in
 * `required-checks.ts`:
 * - `ok` — the row RESOLVED (satisfied/unmet); no rejection happened.
 * - `no-structured-dispositions` — the verdict carried no structured
 *   dispositions at all (null), so nothing could fold.
 * - `no-disposition` — the disposition pool was empty for this row's
 *   identity (the model never answered, or echoed text that matches no
 *   row); deliberately content-free across both cases.
 * - `conflicting-dispositions` — duplicate answers under one alias, or a
 *   status disagreement across aliases.
 * - `malformed-disposition` — the matched answer carried `status: "invalid"`.
 * - `missing-rationale` — the answer's status needed a usable rationale
 *   and had none.
 * - `ungrounded-derived` — a derived row's answer was not evidence that
 *   reaches the derivation's declared location.
 * - `derivation-incomplete` — the synthetic coverage marker: the reason
 *   restates the row's own pre-set cause.
 * - `unresolved-disposition` — the model answered, with the literal status
 *   `unresolved` (a well-formed answer that is not a discharge; #750's
 *   completeness fold records the same shape as reason `ok`).
 * - `receipt-absent` — #1657 (supersedes #1627's `uncited-satisfaction`): the
 *   model answered `satisfied` for an objective must_check row while the run
 *   executed tool calls, but the evidence ledger holds NO receipt carrying
 *   any of the row's required identity/kind — no acquisition the run made
 *   bears on the row, so the satisfaction is unproven.
 * - `receipt-unverified` — #1657: receipts relevant to the row exist but are
 *   unacquired, incomplete (truncated), or outside the requirement's
 *   freshness/trust scope — acquisition attempts are not evidence.
 * - `receipt-mismatch` — #1657 (supersedes #1634's
 *   `unrelated-executed-call`): relevant receipts exist, but none covers the
 *   row's exact identity — a wrong path/version/head/kind never satisfies a
 *   named objective requirement, whatever the model cites.
 * - `trace-refused` — #1657 (carries over #1634's fail-closed rule, renamed):
 *   the harness artifact's executed-call trace is present but this runtime
 *   cannot parse it (or its aligned results), so nothing is verifiable and no
 *   `satisfied` objective answer can discharge.
 * The retired #1627/#1634 citation-gate reasons (`uncited-satisfaction`,
 * `citation-already-used`, `unrelated-executed-call`,
 * `malformed-executed-trace`) are no longer written; the strict artifact
 * reader still accepts them so pre-#1657 run dirs round-trip.
 */
export type ReviewObligationReason =
  | "ok"
  | "no-structured-dispositions"
  | "no-disposition"
  | "conflicting-dispositions"
  | "malformed-disposition"
  | "missing-rationale"
  | "ungrounded-derived"
  | "derivation-incomplete"
  | "unresolved-disposition"
  | "receipt-absent"
  | "receipt-unverified"
  | "receipt-mismatch"
  | "trace-refused";

export interface ReviewObligation {
  id: string;
  source: ReviewObligationSource;
  text: string;
  status: "satisfied" | "unmet" | "unresolved";
  cause: "tool-capability" | "budget-exhausted" | "provider-failure" | "missing-source-evidence" | "derivation-incomplete" | "scan-incomplete" | null;
  /**
   * #1627: the content-free rejection reason above. Always set on a FOLDED
   * row (the fold assigns it on every return path); optional on the type
   * because a pre-fold row and an artifact written before #1627 may not
   * carry one — the strict reader accepts both shapes. Never model text:
   * a closed vocabulary, one word per row.
   */
  reason?: ReviewObligationReason;
  /** #1449: the derivation's declared locations for a `derived` row. A
   * derived obligation may only be discharged by a rationale that names one
   * of them — the evidence must reach the location the derivation flagged.
   * #1577: the `risk` source carries the scan's flagged paths the same way.
   * Absent on the other sources (their rows carry no location). */
  anchors?: string[];
  /** #1594: deterministic CI-evidence provenance for a row the CI gate's
   * head-bound test-execution evidence discharged. Set only by
   * `reconcileObligationsWithCiEvidence`; absent on every other row. */
  resolvedBy?: { kind: "ci-evidence"; check: string; headSha: string };
  /** #1657 (review): the deterministic evidence class of a `must_check`
   * row — TRUSTED PRODUCER METADATA carried from the classification
   * artifact's `must_check_evidence` through the candidates rows, never
   * inferred from the row's wording. Absent on untagged rows (which are
   * `legacy` by default at the fold) and on the other sources. */
  rowClass?: RequiredEvidenceRowClass;
  /** #1657 (review): the explicit gate kind a tagged-objective row carries
   * (which deterministic satisfier validates its satisfaction). Absent on
   * every other class. */
  gate?: EvidenceGateKind | null;
  /** #1657 (review): the dependency-evidence obligation kinds an
   * explicitly-objective `dependency-evidence` row asks to acquire. */
  obligations?: DependencyEvidenceObligation[];
  /** #1657: the reason-coded provenance state of a `must_check` row against
   * the evidence ledger, present only on runs with an active ledger. Never
   * model text; the #1656 disposition surface reads it. */
  evidence?: RowEvidenceState;
}

/** One row of the harness-authored candidates artifact, verbatim. */
export interface ReviewObligationCandidate {
  id: string;
  source: ReviewObligationSource;
  text: string;
}

export const APPROVAL_GATING_CUES = [
  /before approv/i,
  /prerequisite to approval/i,
  /must be (?:verified|confirmed|resolved) before/i,
  /do not approve/i,
  /required before approval/i,
  /blocking prerequisite/i,
] as const;
export const APPROVAL_VERIFICATION_CUE = /\b(?:verify|confirm|check|read|inspect|validate)\b/i;
/** #1381 (review): a human-confirmation attribution makes the sentence a #977
 * external/manual ask even when it carries verification verbs and
 * gatherable-looking nouns ("Confirm with the security team that the
 * release-notes advisory was approved."). Such sentences never become
 * obligations — the reviewer has no configured capability against a person's
 * sign-off, so a heading-gated section must not turn one into a permanent
 * forcing row. The attributing span is bounded so a preposition cannot pair
 * with a distant noun across a sentence; the exclusion errs toward NOT
 * extracting (pre-#1381 behavior), never toward a permanent forcing row.
 * Roles and SIGN-OFF asks are detected deterministically; a named person is
 * detected the same way when the ask's shape makes it unambiguous — a
 * capitalized name (comma lists "Alice, Bob, and Carol" and appositives
 * "Alice Smith, the release manager" included) directly governed by
 * with/from/by and followed by the complementizer that binds the ask to that
 * person ("confirm with Alice that the advisory was published" — #1388
 * review). A lowercase name is not detectable without false-positiving on
 * ordinary nouns ("verify against the changelog that ..."), and a
 * capitalized system name ("confirm from GitHub that ...") is deliberately
 * also excluded — both residues err toward NOT extracting (pre-#1381
 * non-blocking behavior), never toward a permanent forcing row; they cost
 * extraction recall only for prose that already passed every other gate. */
export const EXTERNAL_CONFIRMATION_CUES = [
  /\b(?:with|from|by)\s+(?:the\s+|our\s+|a\s+)?(?:[\w-]+\s+){0,3}(?:team|on-?call(?:er)?|operator|owner|stakeholder|human|manager|lead)\b/i,
  /\bsign[- ]?off\b/i,
  /\b(?:with|from|by)\s+[A-Z][\w'-]*(?:(?:\s+|,\s*)(?:and\s+)?[A-Z][\w'-']*)*(?:\s*,\s*(?:the\s+)?[\w-]+(?:\s+[\w-]+){0,2})*,?\s+(?:that|whether)\b/,
] as const;
/** The obligation must name something the reviewer's configured tools can
 * gather: a repository artifact, an upstream document, or a compatibility
 * surface — not a human/operational confirmation (#977 stays non-blocking). */
export const REVIEWER_GATHERABLE_CUE =
  /\b(?:matrix|compatib|version|schema|file|path|config|document|release notes|changelog|advisory|migration|manifest|lockfile)\b/i;
export const MAX_APPROVAL_PREREQUISITE_LENGTH = 300;
export const MAX_APPROVAL_PREREQUISITES = 5;

/** Split one line into sentences on terminal punctuation followed by
 * whitespace or line end. Periods inside file paths and versions
 * (`machineconfig.yaml.j2`, `v1.37.2`) are NOT sentence boundaries — the
 * real approval-prerequisite prose is full of them. */
function splitSentences(line: string): string[] {
  return line.split(/(?<=[.!?])(?=\s)/).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "");
}

export function extractApprovalPrerequisites(standardsSection: string): string[] {
  try {
    if (typeof standardsSection !== "string" || !standardsSection.trim()) return [];
    const body = standardsSection.replace(/^# Repository Standards and Conventions[^\n]*\n?/i, "");
    const found: string[] = [];
    const seen = new Set<string>();
    const push = (sentence: string): boolean => {
      const key = sentence.replace(/\s+/g, " ").toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(sentence);
      }
      return found.length >= MAX_APPROVAL_PREREQUISITES;
    };
    // #1381 (review): the real trusted-base shape gates a whole SECTION —
    // `## Evidence required before approval` followed by the concrete asks,
    // none of which repeats the approval cue. A markdown heading carrying an
    // approval cue gates every sentence until the next heading; the sentence
    // itself must still carry the verification verb AND the reviewer-
    // gatherable scope cue, so an external/manual ask sitting under the same
    // heading stays #977 non-blocking territory. A gated heading whose own
    // title carries all three cues is also an obligation by itself.
    let approvalSection = false;
    let fence: { char: string; length: number } | null = null;
    for (const line of body.split(/\r?\n/)) {
      // Fenced samples are code, not contract: a `# ... before approval`
      // comment inside an example must not gate the surrounding section, and
      // prose inside the fence is not an obligation (#252 fence discipline).
      // CommonMark closes only on the same fence character run at least as
      // long as the opening one — a ~~~ inside a ``` block is content.
      const fenceRun = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fence !== null) {
        if (fenceRun !== null && fenceRun[1]![0] === fence.char && fenceRun[1]!.length >= fence.length) fence = null;
        continue;
      }
      if (fenceRun !== null) {
        fence = { char: fenceRun[1]![0]!, length: fenceRun[1]!.length };
        continue;
      }
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading !== null) {
        const title = heading[1]!.trim().slice(0, MAX_APPROVAL_PREREQUISITE_LENGTH).trim();
        approvalSection = title !== "" && APPROVAL_GATING_CUES.some((cue) => cue.test(title));
        if (approvalSection
          && APPROVAL_VERIFICATION_CUE.test(title)
          && REVIEWER_GATHERABLE_CUE.test(title)
          && !EXTERNAL_CONFIRMATION_CUES.some((cue) => cue.test(title))) {
          if (push(title)) return found;
        }
        continue;
      }
      for (const raw of splitSentences(line)) {
        const sentence = raw.slice(0, MAX_APPROVAL_PREREQUISITE_LENGTH).trim();
        if (!sentence) continue;
        if (!APPROVAL_VERIFICATION_CUE.test(sentence)) continue;
        if (!REVIEWER_GATHERABLE_CUE.test(sentence)) continue;
        if (EXTERNAL_CONFIRMATION_CUES.some((cue) => cue.test(sentence))) continue;
        if (!approvalSection && !APPROVAL_GATING_CUES.some((cue) => cue.test(sentence))) continue;
        if (push(sentence)) return found;
      }
    }
    return found;
  } catch {
    return [];
  }
}

/** Closed-class words that appear in ordinary prose and in ordinary tool-call
 * targets alike; keeping them out of the vocabulary stops the admission check
 * from admitting every remaining call. */
const ADMISSION_STOP_TOKENS: ReadonlySet<string> = new Set([
  "from", "into", "onto", "over", "under", "before", "after", "above", "below",
  "within", "without", "against", "between", "across", "around", "about",
  "during", "with", "than", "then", "that", "this", "these", "those", "each",
  "every", "both", "same", "such", "only", "also", "used", "using", "makes",
  "make", "made", "will", "must", "should", "could", "their", "them", "they",
  "there", "here", "when", "where", "which", "what",
]);

/** The shared admission vocabulary of a prose row (#1506): the lowercased
 * word tokens (4+ characters) of the row's text minus the closed-class
 * stopword set. One implementation, so the review-obligation rows and the
 * requirement-trace rows cannot drift apart on what a token is. */
export function sharedAdmissionTokens(text: string): string[] | null {
  const tokens = new Set<string>();
  for (const token of text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
    if (!ADMISSION_STOP_TOKENS.has(token)) tokens.add(token);
  }
  return tokens.size > 0 ? [...tokens] : null;
}

/** #1381 (review): the enforceable half of the budget reservation. Inside
 * the reserved request window the tool loop admits a call only when its
 * target word-boundary-overlaps the vocabulary of an obligation that no call
 * has attempted yet. This is one row's deterministic admission vocabulary:
 * lowercased word tokens (4+ chars) of its text minus closed-class
 * stopwords. It is a budget-steering HEURISTIC, not a security boundary —
 * an eager model can name-drop a token — but refusing the plainly unrelated
 * call is exactly what stops the loop spending the held-back requests on
 * history archaeology. `null` when the row names no reviewer-gatherable
 * surface at all — generic checklist prose like "verify correctness
 * carefully" cannot be targeted by any specific call, so it must never gate
 * admission (an unmet row still forces the verdict; an unresolved row is coverage, never a block). */
export function obligationAdmissionTokens(text: string): string[] | null {
  if (!REVIEWER_GATHERABLE_CUE.test(text)) return null;
  return sharedAdmissionTokens(text);
}

/**
 * #1449: the generic path segments that carry no distinctive vocabulary.
 *
 * A derived row's admission vocabulary is built from its anchors, and a
 * generic segment ("src", "lib", "main", "utils", ...) would make ANY call
 * under that segment admissible inside the reserved window — the window
 * would stop steering the loop toward the flagged location and start
 * admitting unrelated reads. The list is closed and small: the segments
 * every repository has.
 */
const GENERIC_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "src", "lib", "libs", "test", "tests", "app", "apps", "pkg", "packages",
  "internal", "main", "index", "util", "utils", "cmd", "api", "core", "dist",
  "build", "docs", "doc", "source", "sources", "common", "shared",
]);

/** A path segment's stem — its name without the file extension. */
function pathSegmentStem(segment: string): string {
  const lower = segment.toLowerCase();
  const lastDot = lower.lastIndexOf(".");
  return lastDot <= 0 ? lower : lower.slice(0, lastDot);
}

/**
 * #1449: the admission vocabulary of a DERIVED row.
 *
 * A derived row is discharged by evidence that names one of the locations
 * the derivation flagged, so the calls that can discharge it are the ones
 * that name those locations: the vocabulary is the lowercased word tokens
 * (4+ characters) of the row's ANCHORS, minus the closed stopword set —
 * the same shape as a prose row's vocabulary, but taken from the location
 * instead of the obligation prose (a call naming the flagged file is what
 * reaches it, whatever words the obligation used).
 *
 * The anchor's PATH contributes only its DISTINCTIVE segments: a generic
 * segment ("src", "main", "utils", ...) names no location in particular, so
 * keeping it would admit every call under that segment. The SYMBOL part
 * always stays — it is the most distinctive part of the anchor.
 *
 * `null` when the row has no usable anchor: a row that names no location
 * has no vocabulary to admit a call by, so it must never gate the reserved
 * window (an unmet row still forces the verdict; an unresolved row is coverage, never a block).
 */
export function anchorAdmissionTokens(anchors: readonly string[]): string[] | null {
  const tokens = new Set<string>();
  for (const anchor of anchors ?? []) {
    if (typeof anchor !== "string") continue;
    const separator = anchor.lastIndexOf(":");
    const path = separator === -1 ? anchor : anchor.slice(0, separator);
    const symbol = separator === -1 ? "" : anchor.slice(separator + 1);
    for (const segment of path.split(/[\\/]/)) {
      if (GENERIC_PATH_SEGMENTS.has(pathSegmentStem(segment))) continue;
      for (const token of segment.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
        if (!ADMISSION_STOP_TOKENS.has(token)) tokens.add(token);
      }
    }
    for (const token of symbol.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
      if (!ADMISSION_STOP_TOKENS.has(token)) tokens.add(token);
    }
  }
  return tokens.size > 0 ? [...tokens] : null;
}

/** The single operator opt-out shared by both obligation layers: an explicit
 * `VALIDATE_REQUIRED_CHECKS=false` takes deterministic must_check items out
 * of the obligation contract (harness presentation and engine enforcement
 * alike), so disabling #750 validation cannot half-enable #1381. */
export function mustCheckObligationsEnabled(validateRequiredChecks: string | undefined): boolean {
  return (validateRequiredChecks ?? "auto").trim().toLowerCase() !== "false";
}

/** Validate one persisted candidates row and use it VERBATIM. The harness
 * wrote exactly what the model was shown; the engine never re-derives the
 * text, so disposition identity cannot drift between the two layers. A row
 * without a usable id, source, or text is skipped, never repaired.
 * #1657 (review): the row's evidence class is its TRUSTED PRODUCER
 * METADATA (`row_class`/`gate`/`obligations`, carried from the
 * classification artifact through the candidates rows) — never inferred
 * from the wording. An ATTENTION-tagged must_check row is skipped here —
 * it is an attention/routing signal, not a proposition with evidence
 * identities: it never enters the obligation contract (no withhold, no
 * force, no required-evidence section). Its disposition is still folded
 * and disclosed on the #750 coverage artifact. An UNRELATED or untagged
 * row is never dropped here: untagged must_check rows are `legacy` and
 * keep pre-#1657 gating semantics. */
function candidateToObligation(row: unknown): ReviewObligation | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const source = record.source === "must_check" || record.source === "trusted_base_guidance" ? record.source : null;
  const text = typeof record.text === "string" ? record.text : null;
  const id = typeof record.id === "string" ? record.id : null;
  if (source === null || text === null || !text.trim() || id === null || !id.trim()) return null;
  // Trusted metadata, validated against the closed vocabularies: an
  // unparseable tag is DROPPED (the row falls back to `legacy`), never
  // half-trusted.
  let metadata: { rowClass: RequiredEvidenceRowClass; gate?: EvidenceGateKind | null; obligations?: DependencyEvidenceObligation[] } | null = null;
  if (source === "must_check"
    && typeof record.row_class === "string"
    && REQUIRED_EVIDENCE_ROW_CLASSES.has(record.row_class)
    && record.row_class !== "legacy") {
    const rowClass = record.row_class as Exclude<RequiredEvidenceRowClass, "legacy">;
    const gate = (record.gate ?? null) as EvidenceGateKind | null;
    const obligations = Array.isArray(record.obligations)
      ? (record.obligations as DependencyEvidenceObligation[])
      : [];
    if (rowClass === "objective" && gate !== null) {
      metadata = { rowClass, gate, obligations };
    } else if (rowClass !== "objective" && gate === null && obligations.length === 0) {
      metadata = { rowClass, gate: null, obligations: [] };
    }
  }
  if (metadata?.rowClass === "attention") return null;
  // #1627: a pre-fold row has no matched disposition yet — the same state
  // the fold's `no-disposition` path describes, and the fold overwrites it.
  return {
    id,
    source,
    text: text.trim(),
    status: "unresolved",
    cause: null,
    reason: "no-disposition",
    ...(metadata !== null ? metadata : {}),
  };
}

/**
 * Build the obligation rows from the harness-authored candidates artifact
 * (verbatim), falling back to must_check-only rows with harness-compatible
 * ids when the artifact is absent (fork/skipped-harness paths). The fallback
 * assignment matches the harness's id order (must_check first), so ids stay
 * aligned across the two layers.
 */
export function candidateRowsToObligations(
  rows: readonly unknown[],
  mustCheck: readonly string[],
  tags?: readonly CheckEvidenceTagWithText[],
): ReviewObligation[] {
  const obligations: ReviewObligation[] = [];
  for (const row of rows) {
    const obligation = candidateToObligation(row);
    if (obligation === null) continue;
    obligations.push(obligation);
  }
  if (obligations.length === 0) {
    // #1657 (review): the fallback applies the producer's trusted tags by
    // exact text; untagged rows are `legacy`. Attention-tagged rows never
    // enter the obligation contract.
    const tagIndex = evidenceTagIndex(tags);
    for (const text of mustCheck) {
      if (typeof text !== "string" || !text.trim()) continue;
      const tag = evidenceTagFor(text, tagIndex);
      if (tag?.rowClass === "attention") continue;
      obligations.push({
        id: `obligation-${obligations.length + 1}`,
        source: "must_check",
        text: text.trim(),
        status: "unresolved",
        cause: null,
        reason: "no-disposition",
        ...(tag !== null ? { rowClass: tag.rowClass, gate: tag.gate, obligations: tag.obligations } : {}),
      });
    }
  }
  return obligations;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * #1577 (review fix): the verified-evidence provenance of a risk discharge.
 *
 * A `risk` row's `satisfied` answer is discharged only when the location it
 * claims to have inspected is backed by the run's OWN evidence receipt —
 * deterministic records, never model output:
 *
 * - the executed-call log the harness persisted (`tool_calls` /
 *   `tool_results`): a successful read of the path (`read_file` /
 *   `git_blame` by exact path, `git_grep` matching it — the same narrow
 *   "read" the #810 coverage rules pin, one shared implementation in
 *   `src/tools/coverage.ts`);
 * - the assembler-certified corpus-diff credit (#921's byte-exact rule):
 *   the path's complete head diff rode the review corpus, so the actual
 *   changed lines were in the reviewer's context.
 *
 * A path-only model assertion with NEITHER record stays unresolved —
 * proof-shaped prose is not provenance (the #1636 problem shape). There is
 * deliberately no call-count quota and no extra model call: the receipt is
 * a pure fold over records the run already wrote.
 */
export interface RiskEvidenceReceipt {
  /** Normalized repository paths the run verified evidence on. */
  readPaths: ReadonlySet<string>;
}

/** Normalize an evidence path exactly the way the receipt's own entries are
 * normalized (`normalizeRelPath` in coverage.ts): trimmed, a leading `./`
 * and trailing slashes dropped. The fold's membership test must compare
 * like with like. */
function normalizeEvidencePath(value: string): string {
  return value.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The locations one risk discharge claims to have inspected: for a row
 * with usable anchors, the anchor paths its rationale actually names (the
 * same `anchorCoveredBy` recognition the grounded rule uses); for a row
 * with no usable anchor, every path-like token the rationale cites. */
export function riskDischargeEvidencePaths(rationale: string, anchors: readonly string[]): string[] {
  const paths = new Set<string>();
  if (anchors.length > 0) {
    for (const anchor of anchors) {
      if (typeof anchor !== "string" || !anchorCoveredBy(rationale, anchor)) continue;
      const separator = anchor.lastIndexOf(":");
      const path = normalizeEvidencePath(separator === -1 ? anchor : anchor.slice(0, separator));
      if (path !== "") paths.add(path);
    }
  } else {
    for (const token of rationale.match(/[A-Za-z0-9_./\\:-]+/g) ?? []) {
      const path = normalizeEvidencePath(token.split(":")[0] ?? "");
      if (path !== "") paths.add(path);
    }
  }
  return [...paths];
}

/** The tool-call log (`tool_calls`, index-aligned `tool_results`) the
 * harness result persists — the run's own record of what the loop executed.
 * Anything else on the artifact is ignored. */
function harnessToolLog(harness: unknown): { calls: unknown[]; results: unknown[] } {
  if (harness === null || typeof harness !== "object" || Array.isArray(harness)) return { calls: [], results: [] };
  const record = harness as Record<string, unknown>;
  return {
    calls: Array.isArray(record.tool_calls) ? record.tool_calls : [],
    results: Array.isArray(record.tool_results) ? record.tool_results : [],
  };
}

/**
 * Build the run's risk evidence receipt (see `RiskEvidenceReceipt`): the
 * executed-call log's successful reads plus, for every candidate path whose
 * complete head diff a certified corpus payload carries byte-exact, the
 * path itself (#921's rule — the changed lines were in the review context).
 * Pure over the run's own records; never throws.
 */
export function riskEvidenceReadPaths(input: {
  harness: unknown;
  rawDiff: string | null;
  certifiedDiffPayloads: readonly string[];
  candidatePaths: readonly string[];
}): Set<string> {
  const log = harnessToolLog(input.harness);
  const paths = readPathsFromToolLog(log.calls, log.results);
  for (const payload of input.certifiedDiffPayloads) {
    for (const path of corpusDiffCoveredFiles(payload, input.rawDiff, input.candidatePaths)) {
      paths.add(path);
    }
  }
  return paths;
}

export function foldObligationDispositions(
  obligations: readonly ReviewObligation[],
  dispositions: ReadonlyArray<{ check: string; status: string; rationale?: string | null }> | null,
  ledger?: EvidenceLedger,
  evidence?: RiskEvidenceReceipt,
): ReviewObligation[] {
  // #1657: the #1627/#1634 citation-gate allocation pass is GONE — one
  // executed call never backed at most one discharge and no rationale
  // citation is proof of anything. A must_check `satisfied` answer on an
  // `objective` row is credited only when the run's own evidence ledger
  // holds validated receipts that support it (see `evaluateRowEvidence`);
  // the SAME evaluation, reasons, and row classes run in the #750
  // completeness fold, so both folds agree on every row. Review-prompt rows
  // are never receipt-gated (the deterministic layer never could judge
  // their groundedness — the reviewer's disposition folds on the
  // presence-and-shape rule), and attention rows never reach this fold at
  // all (dropped at the candidate boundary).
  // The gate is ACTIVE only when a trace was present: `refused` fails every
  // objective satisfaction closed; `unavailable` (no trace) and a missing
  // ledger keep the pre-#1627 semantics byte-for-byte (fresh standard-call
  // and fork paths).
  const ledgerActive = ledger !== undefined && ledger.state !== "unavailable";
  const folded: ReviewObligation[] = obligations.map((obligation) => {
    const idAlias = normalized(obligation.id);
    const textAlias = normalized(obligation.text);
    // Alias-echo rules (#1388): `must_check` rows fold ONLY on the exact
    // check text — the `obligation-<n>` id alias is ignored entirely
    // (neither a duplicate nor an answer) for identity parity with #750's
    // completeness fold, which recognizes only the deterministic check
    // text; an id-echoed must_check disposition must not discharge the
    // obligation while #750 still reports the check unresolved.
    // `trusted_base_guidance` rows keep the id+text alias pair — there is
    // no #750 fold to disagree with. One id entry plus one text entry folds
    // as a single answer when the statuses agree; a second answer for the
    // SAME alias is a duplicate disposition and deterministically
    // invalidates the row (#750's fail-closed `duplicate-dispositions` rule
    // in required-checks.ts): the model cannot satisfy a review-owned
    // prerequisite by echoing it twice, and only a disagreement keeps the
    // row conservatively unresolved.
    // #1449: `derived` rows fold on the id+text alias pair too — the id is
    // the engine-assigned `derived-<n>`, the text the obligation statement
    // the corpus section showed the reviewer.
    const pool = obligation.source === "must_check"
      ? (dispositions ?? []).filter((entry) => normalized(entry.check) === textAlias)
      : (dispositions ?? []).filter((entry) =>
          normalized(entry.check) === textAlias || normalized(entry.check) === idAlias,
        );
    // #1449: a row that already carries its own cause keeps it — the
    // synthetic derived coverage marker is born with `derivation-incomplete`
    // and the fold must not erase it. #1577: same for the risk scan's
    // `scan-incomplete` marker.
    const unresolvedCause = obligation.cause ?? null;
    // #1627: the pre-caused derived coverage marker restates its own cause
    // as its rejection reason on EVERY unresolved path — no disposition can
    // discharge it, so `no-disposition` would misread it as an unanswered
    // question.
    const noDispositionReason: ReviewObligationReason =
      unresolvedCause === "derivation-incomplete" ? "derivation-incomplete" : "no-disposition";
    if (pool.length === 0) {
      // #1627: no structured answer at all is a different state from "this
      // row's identity never matched" — both fail closed, but the receipt
      // says which one happened. The pre-caused coverage marker restates
      // its own cause either way.
      const reason: ReviewObligationReason = dispositions === null
        ? (unresolvedCause === "derivation-incomplete" ? "derivation-incomplete" : "no-structured-dispositions")
        : noDispositionReason;
      return { ...obligation, status: "unresolved", cause: unresolvedCause, reason };
    }
    const idMatches = pool.filter((entry) => normalized(entry.check) === idAlias);
    const textMatches = pool.filter((entry) => normalized(entry.check) === textAlias);
    if (idMatches.length > 1 || textMatches.length > 1) return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "conflicting-dispositions" };
    if (new Set(pool.map((entry) => entry.status)).size > 1) return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "conflicting-dispositions" };
    const status = pool[0]!.status;
    const rationale = pool
      .map((entry) => (typeof entry.rationale === "string" ? entry.rationale!.trim() : ""))
      .sort((a, b) => b.length - a.length)[0] ?? "";
    // #1449: the synthetic derived coverage marker is born with the
    // `derivation-incomplete` cause and is never dischargeable: an
    // unavailable coverage is a state of the world, not something a
    // disposition can argue away. The guard runs BEFORE the `unmet` branch
    // below, so no status can discharge the marker NOR re-label it (an
    // `unmet` answer would otherwise turn the coverage marker into a "the
    // check failed" row and contradict the published prose). #1577: the
    // risk scan's coverage marker behaves identically.
    if (obligation.cause === "derivation-incomplete" || obligation.cause === "scan-incomplete") {
      return obligation.cause === "derivation-incomplete"
        ? { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "derivation-incomplete" }
        : { ...obligation, status: "unresolved", cause: unresolvedCause };
    }
    // A confirmed negative (#1381): `unmet` with a usable rationale resolves
    // the row negatively — the check was performed and the requirement is
    // NOT satisfied — so the row is `unmet`, not clean coverage, and the
    // hard-force gate still fires; without a usable rationale the answer is
    // unusable and the row stays conservatively unresolved.
    if (status === "unmet") {
      return rationale !== ""
        ? { ...obligation, status: "unmet", cause: unresolvedCause, reason: "ok" }
        : { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "missing-rationale" };
    }
    // #1449: a derived row is a VERIFICATION TARGET the reviewer was
    // equipped to discharge, and it may only be discharged by evidence that
    // reaches the location the derivation flagged (see `anchorCoveredBy`):
    // "the daemon passed the identity to the callback" does not close "the
    // reconciliation mint site must place the identity before hashing". The
    // `unmet` case above needs no anchor — a counterexample is reported as
    // an ordinary evidence-backed finding under the normal findings rules,
    // so the negative answer needs no location to be truthful. There is no
    // "not applicable" state for a derived obligation (the derivation named
    // a concrete relationship to check), so anything else stays unresolved.
    // #1577: the `risk` source shares these rules — the scan flagged
    // concrete changed paths, and a satisfied risk row is discharged only by
    // evidence that names one of them. #1577 (review fix): the risk source
    // additionally requires VERIFIED provenance (see `RiskEvidenceReceipt`)
    // — prose shape alone discharged a row the run may never have inspected,
    // an extra phrase-and-path checklist instead of an evidence gate. The
    // receipt check is risk-only: a derived row's semantic grounding is
    // judged by the #1449 contract, not re-decided here.
    if (obligation.source === "derived" || obligation.source === "risk") {
      if (obligation.source === "derived" && status === "invalid") return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "malformed-disposition" };
      if (status !== "satisfied") {
        return obligation.source === "derived"
          ? { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "ungrounded-derived" }
          : { ...obligation, status: "unresolved", cause: unresolvedCause };
      }
      if (rationale === "") {
        return obligation.source === "derived"
          ? { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "ungrounded-derived" }
          : { ...obligation, status: "unresolved", cause: unresolvedCause };
      }
      // #1449: a `satisfied` rationale that ASSERTS a failure ("the mint
      // site fails to place the identity") is a negative answer dressed as a
      // positive one. The deterministic layer cannot judge semantics, so it
      // refuses the row (fail-closed) instead of discharging it.
      if (rationaleAssertsFailure(rationale)) return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "ungrounded-derived" };
      const anchors = obligation.anchors ?? [];
      // A row WITH usable anchors needs one of them named. A row with NO
      // usable anchor (the derivation named nothing checkable — every
      // anchor was dropped as not-a-location) still needs a rationale that
      // names a path-like token: the reviewer must cite a file it checked,
      // but a derivation that named nothing must not brick the review.
      const grounded = anchors.length > 0
        ? anchors.some((anchor) => anchorCoveredBy(rationale, anchor))
        : namesPathLikeToken(rationale);
      // #1577 (review fix): for a RISK row, the named location must be one
      // the run actually established evidence on. A caller that supplies no
      // receipt (the empty set) can never discharge a risk row —
      // fail-closed. The check is risk-only: a derived row's semantic
      // grounding stays the #1449 contract, not re-decided here.
      const readPaths = evidence?.readPaths ?? new Set<string>();
      const verified = obligation.source !== "risk"
        || riskDischargeEvidencePaths(rationale, anchors).some((path) => readPaths.has(path));
      return grounded && verified
        ? { ...obligation, status: "satisfied", cause: null, reason: "ok" }
        : obligation.source === "derived"
          ? { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "ungrounded-derived" }
          : { ...obligation, status: "unresolved", cause: unresolvedCause };
    }
    // Presence-and-shape rule (the #750 baseline): the deterministic layer
    // never judges whether a rationale is semantically grounded. The shape
    // follows each source's model-facing contract: must_check rows fold with
    // #750's own rule (a bare `satisfied` discharges; `not_applicable` needs
    // a rationale), so the obligation fold and the completeness fold can
    // never disagree on the same disposition; trusted_base_guidance rows
    // require a non-empty rationale for any discharge, as their section
    // preamble tells the model.
    // #1657: the objective-evidence gate. When the run EXECUTED tool calls
    // (an active ledger — the native-loop surface), a must_check `satisfied`
    // answer on an OBJECTIVE row is a positive evidence claim and is
    // discharged only when the run's own validated evidence receipts support
    // it (`receipt-backed`): a tool call id or argument overlap is never
    // itself proof, receipts are shareable across conclusions, and an
    // unrelated receipt never satisfies a named objective requirement.
    // `not_applicable` and `unmet` are NOT gated (applicability and
    // confirmed negatives are not positive evidence claims; a negative
    // counterexample surfaces as a finding). Review-prompt rows are never
    // gated; attention rows never reach this fold. With no ledger (fresh
    // standard-call and fork paths) the fold is byte-identical to
    // pre-#1627; a PRESENT-but-malformed trace (`refused`) fails every
    // objective satisfaction closed.
    if (ledgerActive && status === "satisfied" && obligation.source === "must_check"
      && obligation.rowClass === "objective") {
      const tag = obligation.gate === undefined ? null
        : { rowClass: obligation.rowClass, gate: obligation.gate, obligations: obligation.obligations ?? [] };
      const evidenceState = evaluateRowEvidence(tag, obligation.text, ledger);
      if (evidenceState.state !== "receipt-backed") {
        return {
          ...obligation,
          status: "unresolved",
          cause: unresolvedCause,
          reason: receiptRefusalReason(evidenceState),
        };
      }
    }
    const discharges = status === "satisfied"
      ? obligation.source === "must_check" || rationale !== ""
      : status === "not_applicable" && rationale !== "";
    if (discharges) {
      return { ...obligation, status: "satisfied", cause: null, reason: "ok" };
    }
    // #1627: the residual unresolved paths split by WHY the answer failed
    // its source's shape rule — a malformed answer, a literal
    // `unresolved` answer, or a missing rationale.
    if (status === "invalid") return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "malformed-disposition" };
    if (status === "unresolved") return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "unresolved-disposition" };
    return { ...obligation, status: "unresolved", cause: unresolvedCause, reason: "missing-rationale" };
  });
  // #1657: the reason-coded provenance disclosure, attached uniformly AFTER
  // the per-row shape fold. Every `must_check` row carries its deterministic
  // `rowClass` (a pure function of the check text — attention rows are
  // disclosed here too when a caller hands one in, though the candidate
  // boundary normally drops them), and on ledger-active runs every
  // `must_check` row carries its validated `evidence` state. Disclosure
   // only: no policy branch reads these fields to change a status — the
   // #1656 disposition layer consumes them.
  const disclosed = folded.map((obligation) => {
    if (obligation.source !== "must_check") return obligation;
    // Untagged rows are `legacy` (pre-#1657 gating semantics; no prose
    // classification); the tag comes from the producer metadata the row
    // already carries.
    const withClass: ReviewObligation = { ...obligation, rowClass: obligation.rowClass ?? "legacy" };
    if (ledger !== undefined && withClass.evidence === undefined) {
      const tag = withClass.rowClass === "objective"
        ? { rowClass: withClass.rowClass, gate: withClass.gate ?? null, obligations: withClass.obligations ?? [] }
        : null;
      withClass.evidence = evaluateRowEvidence(tag, obligation.text, ledger);
    }
    return withClass;
  });
  return disclosed;
}

export type UnresolvedReviewObligationCause = ReviewObligation["cause"];
export function deriveUnresolvedCause(input: {
  stopReason: string | null;
  harnessError: string | null;
  planningError: string | null;
  degraded: boolean;
}): Exclude<UnresolvedReviewObligationCause, null> {
  if (input.harnessError !== null) return "provider-failure";
  if (input.stopReason === "tool-call-budget-exhausted") return "budget-exhausted";
  if (input.degraded) return "tool-capability";
  // Any budget-shaped stop on a loop that DID execute requests — the round
  // ceiling or the wall clock — means evidence gathering ran out of budget
  // before the obligation was closed (including a loop that spent its rounds
  // on refused optional calls inside the reserved window). A degraded loop
  // that never executed anything stays tool-capability above.
  if (input.stopReason === "max-rounds" || input.stopReason === "wall-clock-exceeded" || input.stopReason === "wall-clock-verdict-reserve") return "budget-exhausted";
  // #1627: the `obligations-settled` early stop is a NORMAL, verdict-producing
  // completion — the loop's own discharge bookkeeping settled every row
  // (discharged by an admitted call, or cap-released as unprovable), so it is
  // neither a budget stop nor a provider failure. A row that still folds
  // unresolved under it was never established as evidence (an attempt is not
  // evidence; the window guarantees only the ATTEMPT) — the missing-source
  // cause with the per-row #1627 reason receipt carrying the specific why.
  if (input.stopReason === "obligations-settled") return "missing-source-evidence";
  // A planning failure (missing corpus, missing model configuration) is not
  // a provider failure: no evidence gathering was even attempted, which is
  // the missing-source-evidence state.
  return "missing-source-evidence";
}

export function unresolvedReviewObligations(obligations: readonly ReviewObligation[]): string[] {
  return obligations.filter((obligation) => obligation.status !== "satisfied").map((obligation) => obligation.id);
}

function reviewObligationAttribution(ids: string[]): string {
  // #1505: the note serves both sections. For the UNMET rows it reads as the
  // confirmed negative it is; for the UNRESOLVED rows the trailing clauses
  // state the coverage semantics (partial review, approval withheld) so the
  // note can never read as a defect claim.
  return `required review evidence unresolved: ${ids.join(", ")} (review-owned required check not discharged; review partial, trusted approval withheld; #1381)`;
}

/** #1449: the derived rows get their own attribution: they are unresolved
 * derived architectural obligations, not required review evidence, and the
 * published note must not read as a defect claim. */
function derivedObligationAttribution(ids: string[]): string {
  return `derived architectural obligation unresolved: ${ids.join(", ")} (derived obligation not discharged; #1449)`;
}

/** #1577: the risk rows get their own attribution: they are unresolved
 * risk-evidence obligations — the risk-specific counterexample evidence the
 * changed code requires was not discharged, so the review is partial and
 * the trusted approval is withheld. Never a defect claim. */
function riskObligationAttribution(ids: string[]): string {
  return `risk evidence obligation unresolved: ${ids.join(", ")} (risk-specific counterexample evidence not discharged; review partial, trusted approval withheld; #1577)`;
}

/**
 * Does an undischarged row FORCE a verdict, or is it only COVERAGE?
 *
 * #1505 contract: forcing is STATUS-based, not merely source-based.
 *
 * - `unmet` — the reviewer performed the check and the requirement did NOT
 *   hold — is a confirmed negative: a real, evidence-backed result, and it
 *   forces `request_changes` for the review-owned required sources
 *   (`must_check`, `trusted_base_guidance`; #1381's gate keeps forcing for
 *   them). A confirmed negative is a defect-class result, exactly like a
 *   blocker/major finding.
 * - `unresolved` — the evidence was never gathered (cause
 *   `budget-exhausted`, `tool-capability`, `provider-failure`,
 *   `missing-source-evidence`) — is an AVAILABILITY failure, never a
 *   defect. It must not manufacture a blocking request out of a review
 *   that could not finish (#1447: "preserve the existing distinction
 *   between found defect and review incomplete / abstain"). It withholds
 *   the trusted approval at the publish boundary and marks the review
 *   partial instead — the same approval semantics the `derived` coverage
 *   rows already carry (#1449), so the #1381 anti-relax guarantee still
 *   holds: an unresolved row can never certify a native APPROVE, it is
 *   simply not enforced as a BLOCK.
 *
 * The `derived` source stays outside forcing entirely: an undischarged
 * derived row is missing COVERAGE, never a defect claim (#1449), and an
 * `unmet` derived row's counterexample belongs in the ordinary findings,
 * where the normal findings rules carry it. The `risk` source does too
 * (#1577): a risk obligation never manufactures a blocking request — an
 * unverified one withholds the trusted approval, and a real counterexample
 * is reported as an ordinary evidence-backed finding.
 */
export function isForcingObligation(obligation: ReviewObligation): boolean {
  // #1657 (review): a review PROMPT (an explicitly-tagged semantic review
  // question) never independently forces a blocking verdict — its `unmet`
  // disposition records the semantic negative for accounting, and a
  // reviewer-determined defect belongs in an ordinary grounded
  // blocker/major finding. Only an explicitly OBJECTIVE mandatory
  // requirement (whose falsity the deterministic gates can mechanically
  // establish) and legacy rows (no trusted metadata: pre-#1657 semantics
  // preserved) may force on `unmet`.
  if (obligation.rowClass === "attention" || obligation.rowClass === "review-prompt") return false;
  return obligation.source !== "derived" && obligation.source !== "risk" && obligation.status === "unmet";
}

/**
 * The hard-force gate (#1381/#1505) is status-based for review-owned
 * `must_check` and `trusted_base_guidance` rows. An `unmet` row is a
 * confirmed negative and forces request_changes. An `unresolved` row is
 * incomplete coverage, not a defect: it is disclosed with its status/cause,
 * marks the review partial, and withholds native APPROVE at the publish
 * boundary (COMMENT, never a manufactured blocking request). There is
 * deliberately no per-source exemption between those two sources: the same
 * status has the same approval semantics for either source. #750's
 *
 * #1521: the obligation rows that BLOCKED this review — the rows a
 * controller must be able to name, not only count.
 *
 * #1505: a row blocks iff it is FORCING (see `isForcingObligation`): a
 * review-owned (`must_check`, `trusted_base_guidance`) row whose check was
 * performed and did NOT hold (`unmet`). An `unresolved` row is an availability
 * failure (coverage, never a defect): it withholds the trusted approval and
 * marks the review partial, but it never manufactures a blocking request, so
 * it never rides as a blocking obligation. A `derived` row is likewise
 * coverage (#1447/#1449), never a block. The deterministic layer owns this
 * decision: the rows are the enforcement pass's own output, and no model may
 * add, drop or re-label one.
 */
export function blockingReviewObligations(obligations: readonly ReviewObligation[]): ReviewObligation[] {
  return obligations.filter((obligation) => isForcingObligation(obligation));
}

/**
 * The hard-force gate (#1381/#1505): an `unmet` row — deterministic
 * `must_check` or extracted `trusted_base_guidance` confirmed negative —
 * forces request_changes and names every such row with its status and cause.
 * An `unresolved` row is coverage: disclosed with the #1449 coverage prose,
 * `applied` stays false, and `required_evidence_state` withholds approval.
 * There is deliberately no per-source exemption between those two sources.
 * REQUIRED_CHECK_VALIDATION_MODE keeps owning the completeness markdown; it
 * no longer owns whether approval may publish.
 *
 * #1449: the `derived` source is the ONE class that does not force (see
 * `isForcingObligation`): an undischarged derived obligation is missing
 * COVERAGE, not a defect, so it is disclosed in its own section and withholds
 * the trusted approval at the publish boundary instead of manufacturing a
 * blocking request.
 *
 * #1505: the non-derived rows split by STATUS. An `unmet` row — the check
 * was performed and the requirement did NOT hold — keeps #1381's force
 * (the section shape, the attribution note and the banner reason are
 * byte-identical for it, with the status name carrying the confirmed
 * negative). An `unresolved` row — the evidence was never gathered — is a
 * coverage state: it is disclosed in the same section shape with the
 * #1449 coverage prose, `applied` stays false so no enforcement banner
 * claims a verdict was forced, and the run's `required_evidence_state`
 * withholds the trusted approval at the publish boundary instead.
 */
export function applyReviewObligationEnforcement(
  artifact: ReviewArtifact,
  obligations: readonly ReviewObligation[],
): { applied: boolean; reason: string } {
  const unresolved = obligations.filter((obligation) => obligation.status !== "satisfied");
  if (unresolved.length === 0) {
    return { applied: false, reason: "" };
  }
  const derived = unresolved.filter((obligation) => obligation.source === "derived");
  // #1577: risk rows are coverage too — they keep their own disclosure
  // section and never join the required-evidence or forcing groups.
  const risk = unresolved.filter((obligation) => obligation.source === "risk");
  // #1505: status-based forcing. Only a confirmed negative (`unmet`) forces
  // a blocking request; an `unresolved` row is disclosed as coverage and
  // withholds the trusted approval at the publish boundary instead.
  const unmet = unresolved.filter((obligation) => isForcingObligation(obligation));
  // #1657: a must_check row the evidence layer classified as a REVIEW
  // PROMPT (generic auth/path/security/scrutiny and absence asks) is not
  // required evidence: its unresolved disposition is disclosed (the
  // coverage artifact and the row's own reason code carry it) but it never
  // renders as unresolved REQUIRED evidence and never withholds on its own
  // — the generic question affects the merge only through a concrete
  // objective gate or the reviewer's material unknown/finding (#1656).
  const ungathered = unresolved.filter((obligation) =>
    obligation.source !== "derived"
    && obligation.source !== "risk"
    && obligation.status === "unresolved"
    && !(obligation.source === "must_check" && obligation.rowClass === "review-prompt"));
  // #1449: the reason is the BLOCKING reason, so it names the FORCING rows
  // only. A derived row or an unresolved required row is a coverage gap, not
  // a block: naming either here would tell the reader the PR was blocked by
  // a row the review never discharged as a defect — the claim this feature
  // must never make. Those rows are disclosed in their own sections instead.
  const reason = unmet.length > 0
    ? `Required review evidence unmet: ${unmet.map((obligation) => obligation.id).join(", ")}`
    : "";
  const sections: string[] = [];
  if (unmet.length > 0) {
    // An `unmet` row was resolved negatively (the check was performed and
    // failed), so it renders the status alone.
    const ids = unmet.map((obligation) => obligation.id);
    const rows = unmet.map((obligation) =>
      `- ${obligation.id} (${obligation.source}, ${obligation.status}): ${obligation.text}`,
    ).join("\n");
    const delimiter = fenceDelimiterFor(rows);
    sections.push(`\n\n## Unmet Required Review Evidence\n${delimiter}text\n${rows}\n${delimiter}\n\n_${reviewObligationAttribution(ids)}._`);
  }
  if (ungathered.length > 0) {
    // #1505: coverage, not defect. Only an `unresolved` row carries an
    // evidence-gathering cause; the section keeps the fenced rows (the
    // #252 hostile-text fence applies identically) and states the #1449
    // coverage semantics: no defect is claimed, the review is partial, and
    // the trusted approval is withheld until the evidence is gathered.
    const ids = ungathered.map((obligation) => obligation.id);
    const rows = ungathered.map((obligation) =>
      `- ${obligation.id} (${obligation.source}, ${obligation.status}, cause: ${obligation.cause ?? "unknown"}): ${obligation.text}`,
    ).join("\n");
    const delimiter = fenceDelimiterFor(rows);
    sections.push(
      `\n\n## Unresolved Required Review Evidence\n`
      + `Required-evidence coverage is incomplete: the review could not gather the required `
      + `evidence above, so no defect is claimed here (an unresolved required check is a `
      + `coverage marker, not a finding). The review is partial and trusted approval is `
      + `withheld until the evidence is gathered.\n${delimiter}text\n${rows}\n${delimiter}\n\n_${reviewObligationAttribution(ids)}._`,
    );
  }
  if (derived.length > 0) {
    const ids = derived.map((obligation) => obligation.id);
    const rows = derived.map((obligation) =>
      `- ${obligation.id} (${obligation.source}, ${obligation.status}${obligation.status === "unresolved" ? `, cause: ${obligation.cause ?? "unknown"}` : ""}): ${obligation.text}`,
    ).join("\n");
    const delimiter = fenceDelimiterFor(rows);
    // #1449: the two classes read APART. An `unresolved` row means the
    // review never established the obligation — the review is incomplete and
    // no defect is claimed. An `unmet` row means the reviewer DID perform
    // the check and the obligation did NOT hold: the counterexample belongs
    // in the ordinary findings, so calling it "no defect is claimed" would
    // be false. The section heading and the general shape stay.
    const unresolved = derived.filter((obligation) => obligation.status === "unresolved");
    const unmet = derived.filter((obligation) => obligation.status === "unmet");
    // #1449: the synthetic coverage marker is cleared by a DERIVATION that
    // completes, never by a disposition — so its release condition must not
    // read like a check the reviewer could discharge, and the undischarged
    // rows' own release condition must not cover it.
    const hasCoverageMarker = derived.some((obligation) => obligation.cause === "derivation-incomplete");
    const prose: string[] = [];
    if (unresolved.length > 0) {
      prose.push(
        "Derived-obligation coverage is incomplete: one or more derived architectural obligations "
        + "were not discharged by this review. No defect is claimed here (an unresolved derived "
        + "obligation is a coverage marker, not a finding). Trusted approval is withheld until the "
        + "obligation is discharged.",
      );
    }
    if (hasCoverageMarker) {
      prose.push(
        "The derived-obligation coverage marker is cleared by a derivation that completes, not by a "
        + "disposition: until then the derived coverage stays unknown.",
      );
    }
    if (unmet.length > 0) {
      prose.push(
        "The reviewer performed the check for one or more derived architectural obligations and the "
        + "obligation did NOT hold. A counterexample belongs in the ordinary findings, where the "
        + "normal findings rules carry it; this row records that the obligation was not discharged. "
        + "Trusted approval is withheld.",
      );
    }
    sections.push(
      `\n\n## Unresolved Derived Architectural Obligations\n`
      + `${prose.join(" ")}\n${delimiter}text\n${rows}\n${delimiter}\n\n_${derivedObligationAttribution(ids)}._`,
    );
  }
  if (risk.length > 0) {
    // #1577: the risk rows disclose with the same coverage semantics: an
    // `unresolved` row is the review not establishing the risk-specific
    // counterexample evidence (no defect claimed, approval withheld, review
    // partial); an `unmet` row means the reviewer FOUND the counterexample,
    // which belongs in the ordinary findings, so the row alone must not
    // read as "no defect is claimed".
    const ids = risk.map((obligation) => obligation.id);
    const rows = risk.map((obligation) =>
      `- ${obligation.id} (${obligation.source}, ${obligation.status}${obligation.status === "unresolved" ? `, cause: ${obligation.cause ?? "unknown"}` : ""}): ${obligation.text}`,
    ).join("\n");
    const delimiter = fenceDelimiterFor(rows);
    const unresolvedRisk = risk.filter((obligation) => obligation.status === "unresolved");
    const unmetRisk = risk.filter((obligation) => obligation.status === "unmet");
    const riskProse: string[] = [];
    if (unresolvedRisk.length > 0) {
      riskProse.push(
        "Risk-evidence coverage is incomplete: one or more risk-specific evidence obligations "
        + "raised by the changed code were not discharged with a counterexample considered against "
        + "source or test evidence. No defect is claimed here (an unresolved risk obligation is a "
        + "coverage marker, not a finding). The review is partial and trusted approval is withheld "
        + "until the evidence is gathered.",
      );
    }
    if (unmetRisk.length > 0) {
      riskProse.push(
        "The reviewer checked one or more risk obligations and the counterexample DID break the "
        + "property. A counterexample belongs in the ordinary findings, where the normal findings "
        + "rules carry it; this row records that the obligation was not discharged. Trusted "
        + "approval is withheld.",
      );
    }
    sections.push(
      `\n\n## Unresolved Risk Evidence Obligations\n`
      + `${riskProse.join(" ")}\n${delimiter}text\n${rows}\n${delimiter}\n\n_${riskObligationAttribution(ids)}._`,
    );
  }
  if (unmet.length === 0) {
    // #1449/#1505: COVERAGE ONLY — no confirmed negative is present, so
    // nothing here may manufacture a blocking request out of a coverage gap
    // (#1447: "preserve the existing distinction between found defect and
    // review incomplete / abstain"). The derived and unresolved-required
    // sections are still disclosed in the review body, and the derived and
    // required-evidence states withhold the trusted approval at the publish
    // boundary; `applied` stays false so no enforcement banner claims a
    // verdict was forced.
    artifact.review_markdown = (artifact.review_markdown || "") + sections.join("");
    return { applied: false, reason: "" };
  }
  return forceRequestChanges(artifact, sections.join(""), reason);
}

export function reviewObligationsToArtifact(
  obligations: readonly ReviewObligation[],
  dispositionReceipt?: RequiredCheckDispositionReceipt | null,
): Record<string, unknown> {
  const artifact: Record<string, unknown> = {
    version: 1,
    // #1449: `anchors` is additive — it rides only on derived rows, so a
    // run without derived rows keeps the artifact byte-identical.
    // #1594: `resolved_by` follows the same additive pattern — it rides only
    // on CI-evidence-discharged rows, so an unreconciled run keeps the
    // artifact byte-identical.
    // #1627: `reason` rides on every row the #1627 fold produced (a
    // pre-#1627 caller may pass rows without one; the field is then
    // omitted, exactly like the pre-#1449 shape). #1657: `row_class` and
    // `evidence` ride on every must_check row the #1657 fold produced —
    // additive, absent on the other sources and on pre-#1657 callers.
    obligations: obligations.map(({ id, source, text, status, cause, reason, anchors, resolvedBy, rowClass, evidence }) => {
      const row: Record<string, unknown> = { id, source, text, status, cause };
      if (reason !== undefined) row.reason = reason;
      if (anchors !== undefined) row.anchors = anchors;
      if (resolvedBy !== undefined) row.resolved_by = { kind: resolvedBy.kind, check: resolvedBy.check, head_sha: resolvedBy.headSha };
      if (rowClass !== undefined) row.row_class = rowClass;
      if (evidence !== undefined) row.evidence = rowEvidenceStateToArtifact(evidence);
      return row;
    }),
  };
  // #1627: the disposition parser's drop receipt rides the fold artifact
  // too — the drops are unattributable by definition (no row can carry
  // them), so the artifact-level field is the only place they can be
  // explained from. Absent when the parser reported nothing.
  if (dispositionReceipt && (dispositionReceipt.dropped.length > 0 || dispositionReceipt.capReached)) {
    artifact.required_check_disposition_receipt = {
      dropped: dispositionReceipt.dropped.map((drop) => ({ reason: drop.reason })),
      cap_reached: dispositionReceipt.capReached,
    };
  }
  return artifact;
}

/** The closed vocabularies `reviewObligationsFromArtifact` validates rows
 * against — the exact value sets the `ReviewObligation` type declares. */
const OBLIGATION_SOURCES: ReadonlySet<string> = new Set(["must_check", "trusted_base_guidance", "derived", "risk"]);
const OBLIGATION_STATUSES: ReadonlySet<string> = new Set(["satisfied", "unmet", "unresolved"]);
const OBLIGATION_CAUSES: ReadonlySet<string> = new Set([
  "tool-capability", "budget-exhausted", "provider-failure", "missing-source-evidence", "derivation-incomplete", "scan-incomplete",
]);
/** #1594: the head-SHA shape `reconcileObligationsWithCiEvidence` writes. */
const CI_EVIDENCE_HEAD_SHA_RE = /^[0-9a-f]{7,64}$/i;
/** #1627: the closed per-row rejection-reason vocabulary (see
 * `ReviewObligationReason`). #1657: the retired #1627/#1634 citation-gate
 * reasons stay READABLE (pre-#1657 run dirs round-trip) but are no longer
 * written. */
const OBLIGATION_REASONS: ReadonlySet<string> = new Set([
  "ok", "no-structured-dispositions", "no-disposition", "conflicting-dispositions",
  "malformed-disposition", "missing-rationale", "ungrounded-derived", "derivation-incomplete",
  "unresolved-disposition",
  // #1657 vocabulary.
  "receipt-absent", "receipt-unverified", "receipt-mismatch", "trace-refused",
  // Retired #1627/#1634 vocabulary — accepted for backward compatibility only.
  "uncited-satisfaction", "citation-already-used", "unrelated-executed-call", "malformed-executed-trace",
]);
/** #1657 (review): the closed must_check evidence-class vocabulary
 * (`legacy` = the producer did not tag the row; pre-#1657 semantics). */
const OBLIGATION_ROW_CLASSES: ReadonlySet<string> = new Set(["attention", "objective", "review-prompt", "legacy"]);
/** #1657: the closed per-row evidence-gate vocabulary. */
const EVIDENCE_GATES: ReadonlySet<string> = new Set(["ci-evidence", "dependency-evidence", "source-identity"]);
/** #1657: the closed per-row evidence-state vocabulary (see
 * `RowEvidenceStateValue` in `evidence-receipts.ts`). */
const EVIDENCE_STATES: ReadonlySet<string> = new Set([
  "not-required", "no-ledger", "trace-refused", "receipt-backed", "receipt-absent", "receipt-mismatch", "receipt-unverified",
]);
/** #1657: read the per-row evidence projection back strictly (the shape
 * `rowEvidenceStateToArtifact` writes). `rowClass` comes from the row's own
 * `row_class` field. Anything else refuses the artifact. */
function rowEvidenceStateFromArtifact(value: unknown, rowClass: RequiredEvidenceRowClass): RowEvidenceState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "gate" && key !== "state" && key !== "receipt_ids") return null;
  }
  if (record.gate !== null && !(typeof record.gate === "string" && EVIDENCE_GATES.has(record.gate))) return null;
  if (typeof record.state !== "string" || !EVIDENCE_STATES.has(record.state)) return null;
  let receipts: string[] = [];
  if (record.receipt_ids !== undefined) {
    if (!Array.isArray(record.receipt_ids) || record.receipt_ids.length > 20
      || !record.receipt_ids.every((id) => typeof id === "string" && id !== "")) return null;
    receipts = record.receipt_ids as string[];
  }
  return {
    rowClass,
    gate: (record.gate === null ? null : record.gate) as RowEvidenceState["gate"],
    state: record.state as RowEvidenceState["state"],
    receipts,
  };
}

/**
 * #1627: read the disposition parser's drop receipt back from a persisted
 * artifact (`ai-output.json` or the fold's own `review-obligations.json`).
 * Disclosure only — no policy branch reads it — so anything shaped wrong is
 * `null` (absent, never a guess), and the bounded list is re-bounded
 * defensively: a run-dir file is a file any earlier tool could have
 * written.
 */
export function dispositionReceiptFromArtifact(value: unknown): RequiredCheckDispositionReceipt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { dropped?: unknown; cap_reached?: unknown };
  if (!Array.isArray(record.dropped) || typeof record.cap_reached !== "boolean") return null;
  const dropped: RequiredCheckDispositionReceipt["dropped"] = [];
  // The parser bounds its receipt list at MAX_REQUIRED_CHECKS (50,
  // src/model/verdict.ts); this defensive re-read applies the same ceiling.
  for (const raw of record.dropped.slice(0, 50)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const reason = (raw as { reason?: unknown }).reason;
    if (reason !== "non-object-entry" && reason !== "unattributable-check") return null;
    dropped.push({ reason });
  }
  return { dropped, capReached: record.cap_reached };
}

/**
 * #1537: read `reviewObligationsToArtifact`'s output back into rows. The
 * standalone `publish` CLI is a separate process from `run` and cannot hold
 * the folded rows in memory, so it reads them from the run directory's own
 * `review-obligations.json` (see `mergeGatingFieldsFromRunDir` in
 * `src/run/entrypoints.ts`) — the fold lives only in that artifact.
 *
 * Strict round-trip, not a normalization: anything this runtime did not
 * write is `null` (unreadable → the caller keeps the state absent, never a
 * guess). A row whose source, status or cause is outside the closed
 * vocabulary refuses the WHOLE artifact — the same rule #1521's handoff
 * parser applies to a published document, so a half-trusted row can never
 * reach the published handoff through this seam. The same rule covers the
 * row's SHAPE: `reviewObligationsToArtifact` writes exactly the keys `id`,
 * `source`, `text`, `status`, `cause` (plus the optional #1449 `anchors`, the
 * optional #1594 `resolved_by`, and the #1627 `reason` — the reason is
 * written on every row the #1627 fold produces, and its absence is accepted
 * for a pre-#1627 artifact),
 * and always records `cause` (a vocabulary string, or `null` for a row with
 * no cause), so a row carrying any other property — or omitting `cause` —
 * is not a row this runtime wrote and refuses the artifact too.
 *
 * `anchors` round-trips when present (the #1449 derived rows), and — since
 * #1627 — so does the per-row rejection `reason`: a row written before
 * #1627 carries none and is accepted without one (backward compatible),
 * while a present reason must be in the closed vocabulary or the whole
 * artifact is refused. The publish
 * layer projects rows through `blockingReviewObligations` before rendering,
 * and that filter drops every `derived` row, so anchors never reach a
 * published document either way.
 */
export function reviewObligationsFromArtifact(value: unknown): ReviewObligation[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { version?: unknown; obligations?: unknown };
  if (record.version !== 1 || !Array.isArray(record.obligations)) return null;
  const rows: ReviewObligation[] = [];
  for (const raw of record.obligations) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (key !== "id" && key !== "source" && key !== "text" && key !== "status" && key !== "cause" && key !== "reason"
        && key !== "anchors" && key !== "resolved_by" && key !== "row_class" && key !== "evidence") return null;
    }
    if (typeof row.id !== "string" || row.id === "") return null;
    if (typeof row.source !== "string" || !OBLIGATION_SOURCES.has(row.source)) return null;
    if (typeof row.text !== "string") return null;
    if (typeof row.status !== "string" || !OBLIGATION_STATUSES.has(row.status)) return null;
    if (!(row.cause === null || (typeof row.cause === "string" && OBLIGATION_CAUSES.has(row.cause)))) return null;
    // #1627: a reason may be ABSENT (an artifact written before #1627) or a
    // closed-vocabulary string — never anything else.
    if (!(row.reason === undefined || (typeof row.reason === "string" && OBLIGATION_REASONS.has(row.reason)))) return null;
    if (row.anchors !== undefined
      && !(Array.isArray(row.anchors) && row.anchors.every((anchor) => typeof anchor === "string"))) return null;
    // #1594: the resolved_by shape is validated strictly (closed kind, usable
    // check name, SHA-shaped head) — a half-trusted provenance record is as
    // unreadable as a half-trusted row, so it refuses the WHOLE artifact.
    let resolvedBy: ReviewObligation["resolvedBy"];
    if (row.resolved_by !== undefined) {
      if (row.resolved_by === null || typeof row.resolved_by !== "object" || Array.isArray(row.resolved_by)) return null;
      const provenance = row.resolved_by as Record<string, unknown>;
      for (const key of Object.keys(provenance)) {
        if (key !== "kind" && key !== "check" && key !== "head_sha") return null;
      }
      if (provenance.kind !== "ci-evidence") return null;
      if (typeof provenance.check !== "string" || provenance.check === "") return null;
      if (typeof provenance.head_sha !== "string" || !CI_EVIDENCE_HEAD_SHA_RE.test(provenance.head_sha)) return null;
      resolvedBy = { kind: "ci-evidence", check: provenance.check, headSha: provenance.head_sha };
    }
    const entry: ReviewObligation = {
      id: row.id,
      source: row.source as ReviewObligationSource,
      text: row.text,
      status: row.status as ReviewObligation["status"],
      cause: (typeof row.cause === "string" ? row.cause : null) as ReviewObligation["cause"],
    };
    if (typeof row.reason === "string") entry.reason = row.reason as ReviewObligationReason;
    if (row.anchors !== undefined) entry.anchors = row.anchors as string[];
    if (resolvedBy !== undefined) entry.resolvedBy = resolvedBy;
    // #1657: the must_check evidence class and its reason-coded provenance
    // state round-trip strictly — a present `row_class` must be in the
    // closed vocabulary, and a present `evidence` must match the projection
    // shape (its rowClass comes from the row's own field). A pre-#1657 row
    // carries neither and is accepted without them.
    let evidence: RowEvidenceState | undefined;
    if (row.row_class !== undefined) {
      if (typeof row.row_class !== "string" || !OBLIGATION_ROW_CLASSES.has(row.row_class)) return null;
      entry.rowClass = row.row_class as RequiredEvidenceRowClass;
    }
    if (row.evidence !== undefined) {
      const state = rowEvidenceStateFromArtifact(row.evidence, entry.rowClass ?? "objective");
      if (state === null) return null;
      evidence = state;
    }
    if (evidence !== undefined) entry.evidence = evidence;
    rows.push(entry);
  }
  return rows;
}
