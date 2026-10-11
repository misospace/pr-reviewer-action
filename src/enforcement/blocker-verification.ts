import { authorizesLiteralClaim, verifySourceSpan } from "../context/evidence-provenance.js";
import type { EvidenceProvenance } from "../context/evidence-provenance.js";
import type { ArtifactFinding } from "./artifact.js";

export type GroundingStatus = "grounded" | "refuted" | "unverified" | "unsupported";
export type GroundingKind = "committed_literal" | "requirement_claim";

export const SANITIZER_MARKERS: readonly string[] = ["⟦redacted:credential⟧", "⟦•⟧", "[REDACTED]"];
export const REQUIREMENT_NOT_ENFORCED_RE = /^\s*requirement\s+not\s+enforced\b/i;
export const MAX_VERIFICATION_READS = 20;

export interface SourceReadOk { status: "ok"; text: string; provenance: EvidenceProvenance; }
export interface SourceReadUnavailable { status: "unavailable"; reason: string; }
export type SourceReadResult = SourceReadOk | SourceReadUnavailable;
export type SourceReader = (file: string) => Promise<SourceReadResult>;

export interface BlockerVerificationOptions {
  readSource: SourceReader;
  expectedRevision: string | null;
}

export interface FindingGrounding {
  index: number;
  status: GroundingStatus;
  kind: GroundingKind | null;
  reason: string;
}

export interface BlockerVerificationResult {
  findings: FindingGrounding[];
  demoted: number;
}

export function safeFile(file: unknown): file is string {
  return typeof file === "string"
    && file.length > 0
    && !file.startsWith("/")
    // A leading `-` is never a valid repo-relative path a reviewer should
    // verify and keeps a git argv option shape out of the reader entirely.
    && !file.startsWith("-")
    && !file.split(/[\\/]/).includes("..")
    && !file.includes("\0");
}

function classify(message: string): GroundingKind | null {
  if (SANITIZER_MARKERS.some((marker) => message.includes(marker))) return "committed_literal";
  if (REQUIREMENT_NOT_ENFORCED_RE.test(message)) return "requirement_claim";
  return null;
}

/**
 * Extract backtick-delimited code spans from a finding message. Used by the
 * `requirement_claim` branch: a generic "requirement not enforced" assertion
 * carries no machine-checkable evidence of a specific violation unless it
 * cites specific code. Bare line numbers and bare file references cannot
 * establish that the cited code matches what the source actually contains;
 * only quoted code does.
 */
function extractCodeSpans(message: string): string[] {
  const out: string[] = [];
  for (const match of message.matchAll(/`([^`]+)`/g)) {
    const span = (match[1] ?? "").trim();
    // Single characters and pure punctuation do not constitute a citable
    // claim — pin a minimum length so a stray backtick pair cannot ground.
    if (span.length >= 2) out.push(span);
  }
  return out;
}

export async function applyBlockerVerification(
  findings: ArtifactFinding[],
  options: BlockerVerificationOptions,
): Promise<BlockerVerificationResult> {
  const entries: FindingGrounding[] = [];
  let reads = 0;
  let demoted = 0;

  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]!;
    if ((finding.severity !== "blocker" && finding.severity !== "major") || finding.category === "verification") continue;
    const kind = classify(finding.message);
    if (kind === null) continue;

    let status: GroundingStatus;
    let reason: string;
    if (!safeFile(finding.file)) {
      status = kind === "committed_literal" ? "unverified" : "unsupported";
      reason = kind === "committed_literal" ? "no-location" : "no-concrete-location";
    } else if (reads >= MAX_VERIFICATION_READS) {
      status = "unverified";
      reason = "read-budget-exhausted";
    } else {
      reads += 1;
      const read = await options.readSource(finding.file);
      if (read.status === "unavailable") {
        if (read.reason === "not-found") {
          status = "refuted";
          reason = kind === "committed_literal" ? "marker-absent" : "location-missing";
        } else {
          status = "unverified";
          reason = read.reason;
        }
      } else if (!authorizesLiteralClaim(read.provenance, options.expectedRevision)) {
        // Defense-in-depth: the reader binds provenance to the same exact
        // revision, so this is normally just "committed_source and
        // unsynthesized". A reader that reads a different revision (or a
        // stale one) still fails closed here rather than grounding the claim.
        status = "unverified";
        reason = "non-authoritative-source";
      } else if (kind === "committed_literal") {
        const present = SANITIZER_MARKERS.some((marker) => verifySourceSpan(read.text, marker).present);
        status = present ? "grounded" : "refuted";
        reason = present ? "marker-present" : "marker-absent";
      } else {
        // requirement_claim: a generic standard assertion cannot promote
        // CHANGES_REQUESTED on file/line existence alone — line 3 of
        // `const x = 1; const y = 2; const z = 3;` does not establish that
        // a violated standard lives there. Independent, machine-checkable
        // evidence of a specific violation is required: a backticked code
        // span whose bytes match the exact-head source. A claim without
        // such a span is unsupported (no cited evidence). A claim with
        // spans that none of the source files contain is refuted (source
        // positively disproves the cited pattern).
        const spans = extractCodeSpans(finding.message);
        if (spans.length === 0) {
          status = "unsupported";
          reason = "no-cited-evidence";
        } else if (spans.some((span) => read.text.includes(span))) {
          status = "grounded";
          reason = "evidence-verified";
        } else {
          status = "refuted";
          reason = "evidence-mismatch";
        }
      }
    }

    if (status !== "grounded") {
      if (finding.capped_from === undefined) finding.capped_from = finding.severity;
      finding.severity = "minor";
      finding.grounding_status = status;
      demoted += 1;
    }
    entries.push({ index, status, kind, reason });
  }

  return { findings: entries, demoted };
}
