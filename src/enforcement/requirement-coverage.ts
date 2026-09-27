/**
 * Deterministic, bounded requirement-coverage normalizer (#680 port of
 * `pr_reviewer/requirement_coverage.py`, #624/#721).
 *
 * Pairs the version-1 requirement ledger with the final reviewer's claims —
 * the `requirement_coverage` key of the parsed model JSON — and decides
 * whether each claim is credited. This is a SIGNAL, not a verdict: unknown
 * or incomplete coverage never alters a verdict, and since #721 it must not
 * independently spend a smart call; the reviewer may request the second pass
 * itself via `smart_review_requested`.
 *
 * Invariants ported verbatim: evidence-gated credit (a satisfied/violated
 * claim with no concrete evidence downgrades to unknown); `not_applicable`
 * is never self-authenticating; a `verification_required` invariant needs
 * test/tool/ci evidence, not a file/diff glance; unknown is never upgraded;
 * duplicate claims keep the first; out-of-ledger claims become visible
 * errors; caps are visible truncation; everything fails soft.
 */
import type { RequirementLedger } from "../requirements/ledger.js";

export const ARTIFACT_VERSION = 1;
export const MAX_COVERAGE_ITEMS = 64;
export const MAX_EVIDENCE_ITEMS = 8;
export const MAX_EVIDENCE_CHARS = 500;
export const TRUNCATION_MARKER = "…";

const STATUS_VALUES: ReadonlySet<string> = new Set(["satisfied", "violated", "not_applicable", "unknown"]);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(["file", "test", "tool", "ci", "diff"]);
const VERIFICATION_KINDS: ReadonlySet<string> = new Set(["test", "tool", "ci"]);

export const DEFAULT_COVERAGE_KEY = "requirement_coverage";

export interface CoverageEvidence {
  kind: string;
  ref: string;
  detail: string;
}

export interface CoverageRow {
  requirement_id: string;
  status: string;
  credited: boolean;
  evidence: CoverageEvidence[];
  notes: string[];
}

export interface RequirementCoverageArtifact {
  version: number;
  ledger_sha: string;
  coverage: CoverageRow[];
  summary: Record<string, number>;
  errors: string[];
}

interface LedgerEntryLike {
  id?: unknown;
  verification_required?: unknown;
}

function capText(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length > MAX_EVIDENCE_CHARS) {
    return value.slice(0, MAX_EVIDENCE_CHARS - 1) + TRUNCATION_MARKER;
  }
  return value;
}

function isConcreteField(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function ledgerRequirements(ledger: unknown): LedgerEntryLike[] {
  const raw = (ledger as { requirements?: unknown } | null | undefined)?.requirements;
  return Array.isArray(raw) ? (raw as LedgerEntryLike[]) : [];
}

function ledgerSha(ledger: unknown): string {
  const sha = (ledger as { sha?: unknown } | null | undefined)?.sha;
  return typeof sha === "string" ? sha : "";
}

function normalizeEvidence(rawEvidence: unknown): {
  evidence: CoverageEvidence[];
  notes: string[];
  concreteFlags: boolean[];
} {
  const items = Array.isArray(rawEvidence) ? rawEvidence : [];
  const evidence: CoverageEvidence[] = [];
  const notes: string[] = [];
  const concreteFlags: boolean[] = [];
  for (const item of items) {
    const record = item as Record<string, unknown> | null;
    const kind = record ? record.kind : null;
    const kindNorm = typeof kind === "string" ? kind.toLowerCase() : null;
    if (kindNorm === null || !EVIDENCE_KINDS.has(kindNorm)) {
      notes.push("dropped-evidence-invalid-kind");
      continue;
    }
    const concrete = isConcreteField(record?.ref) || isConcreteField(record?.detail);
    evidence.push({
      kind: kindNorm,
      ref: capText(record?.ref),
      detail: capText(record?.detail),
    });
    concreteFlags.push(concrete);
  }
  if (evidence.length > MAX_EVIDENCE_ITEMS) {
    evidence.length = MAX_EVIDENCE_ITEMS;
    concreteFlags.length = MAX_EVIDENCE_ITEMS;
    notes.push("evidence-truncated");
  }
  return { evidence, notes, concreteFlags };
}

function normalizeClaim(claim: Record<string, unknown>, ledgerEntry: LedgerEntryLike): CoverageRow {
  const notes: string[] = [];

  const rawStatus = claim.status;
  const statusNorm = typeof rawStatus === "string" ? rawStatus.toLowerCase() : null;
  let status: string;
  if (statusNorm !== null && STATUS_VALUES.has(statusNorm)) {
    status = statusNorm;
  } else {
    status = "unknown";
    notes.push("status-invalid");
  }

  const { evidence, notes: evNotes, concreteFlags } = normalizeEvidence(claim.evidence);
  notes.push(...evNotes);

  const numConcrete = concreteFlags.filter(Boolean).length;
  const verificationRequired = Boolean(ledgerEntry.verification_required);
  if ((status === "satisfied" || status === "violated") && numConcrete === 0) {
    status = "unknown";
    notes.push("downgraded-no-concrete-evidence");
  } else if (status === "satisfied" && verificationRequired) {
    const hasVerification = evidence.some(
      (item, index) => concreteFlags[index] && VERIFICATION_KINDS.has(item.kind),
    );
    if (!hasVerification) {
      status = "unknown";
      notes.push("downgraded-invariant-unverified");
    }
  } else if (status === "not_applicable") {
    status = "unknown";
    notes.push("downgraded-na-without-deterministic-scope-proof");
  }

  return {
    requirement_id: claim.requirement_id as string,
    status,
    credited: status === "satisfied",
    evidence,
    notes,
  };
}

/**
 * Normalize the reviewer's untrusted coverage claims against the ledger.
 * Never throws on malformed input; every degradation is visible in `errors`
 * or `notes`.
 */
export function normalizeRequirementCoverage(
  coveragePayload: unknown,
  ledger: unknown,
): RequirementCoverageArtifact {
  const requirements = ledgerRequirements(ledger);
  const errors: string[] = [];
  if (requirements.length === 0) {
    errors.push("ledger-unavailable");
  }

  const entryById = new Map<string, LedgerEntryLike>();
  for (const req of requirements) {
    if (!req || typeof req !== "object") continue;
    const rid = (req as LedgerEntryLike).id;
    if (typeof rid === "string" && !entryById.has(rid)) {
      entryById.set(rid, req);
    }
  }

  const claimsById = new Map<string, CoverageRow>();
  const seenIds = new Set<string>();
  if (Array.isArray(coveragePayload)) {
    for (const claim of coveragePayload) {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) continue;
      const record = claim as Record<string, unknown>;
      const rid = record.requirement_id;
      if (typeof rid !== "string" || !entryById.has(rid)) {
        // Python's `str(rid)`: null/undefined render as "None".
        const idForError = rid === null || rid === undefined ? "None" : String(rid);
        errors.push(`dropped-coverage-${idForError}`);
        continue;
      }
      if (seenIds.has(rid)) {
        errors.push(`duplicate-coverage-${rid}`);
        continue;
      }
      seenIds.add(rid);
      claimsById.set(rid, normalizeClaim(record, entryById.get(rid) as LedgerEntryLike));
    }
  }

  const rows: CoverageRow[] = [];
  for (const req of requirements) {
    const rid = req && typeof req === "object" ? (req as LedgerEntryLike).id : null;
    if (typeof rid === "string" && claimsById.has(rid)) {
      rows.push(claimsById.get(rid) as CoverageRow);
    } else {
      rows.push({
        requirement_id: typeof rid === "string" ? rid : "",
        status: "unknown",
        credited: false,
        evidence: [],
        notes: ["not-covered-by-reviewer"],
      });
    }
  }

  if (rows.length > MAX_COVERAGE_ITEMS) {
    const omitted = rows.length - MAX_COVERAGE_ITEMS;
    rows.length = MAX_COVERAGE_ITEMS;
    errors.push(`coverage-truncated-${omitted}`);
  }

  const summary = {
    total: rows.length,
    satisfied: rows.filter((r) => r.status === "satisfied").length,
    violated: rows.filter((r) => r.status === "violated").length,
    not_applicable: rows.filter((r) => r.status === "not_applicable").length,
    unknown: rows.filter((r) => r.status === "unknown").length,
    credited: rows.filter((r) => r.credited).length,
  };

  return {
    version: ARTIFACT_VERSION,
    ledger_sha: ledgerSha(ledger),
    coverage: rows,
    summary,
    errors,
  };
}

/**
 * Extract the claims payload the way the CLI does: an object yields its
 * `coverage_key` value, a bare array is used as-is, anything else is ignored.
 */
export function extractCoveragePayload(
  payload: unknown,
  coverageKey: string = DEFAULT_COVERAGE_KEY,
): unknown {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return (payload as Record<string, unknown>)[coverageKey];
  }
  return payload;
}

/** Re-exported for the fixture mode's ledger loading seam. */
export type { RequirementLedger };
