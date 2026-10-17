import { authorizesLiteralClaim, verifySourceSpan } from "../context/evidence-provenance.js";
import type { EvidenceProvenance } from "../context/evidence-provenance.js";
import type { ArtifactFinding } from "./artifact.js";

export type GroundingStatus = "grounded" | "refuted" | "unverified" | "unsupported";
export type GroundingKind = "committed_literal" | "requirement_claim";

export const SANITIZER_MARKERS: readonly string[] = ["⟦redacted:credential⟧", "⟦•⟧", "[REDACTED]"];
export const REQUIREMENT_NOT_ENFORCED_RE = /^\s*requirement\s+not\s+enforced\b/i;
export const MAX_VERIFICATION_READS = 20;
/**
 * #1016 (review pass): a `requirement_claim` is grounded only when the cited
 * span is present within ±EVIDENCE_LINE_WINDOW lines of the cited line. A
 * span found only elsewhere in the file is unknown evidence, not
 * confirmation.
 */
export const EVIDENCE_LINE_WINDOW = 2;

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

/**
 * Mention/expectation cues: sentence-level wording that marks a marker as
 * *expected output* of a sanitizer (or an absent mechanism / comparison)
 * rather than as bytes the reviewer claims the committed source contains.
 */
const COMMITTED_MARKER_CUE_RE = /\bshould\b|\bmust be\b|\bexpected\b|instead of|\breplac\w*\b|\bnever\b|\bwithout\b|\bmissing\b|\bfails? to\b/i;

/**
 * Existence-assertion cues: sentence-level wording that positively locates
 * the cited token in the committed source (committed/contained/hardcoded
 * as written). Without one, a quoted marker is ambiguous — e.g. "the
 * masking helper returns `[REDACTED]` but is not wired into this writer"
 * describes the token as another function's return value, not as committed
 * bytes — and ambiguity falls through to untouched (the fail-safe
 * direction: an over-narrow boundary leaves a real finding blocking, it
 * never refutes one it does not understand).
 */
const COMMITTED_MARKER_ASSERTION_RE = /\bcontain\w*\b|\bcommit\w*\b|\bhardcod\w*\b|\bliteral\w*\b|\bas written\b|\binside\b|\bpresent\b|\bequals\b|\bis set to\b/i;

/**
 * Upper bound on the message text the quoted-citation scan inspects. The
 * scan is superlinear on pathological all-backtick input, and an oversized
 * message is by definition not a pinpoint citation: it falls through as
 * ambiguous (untouched), which also caps the boundary's worst-case work.
 */
export const MAX_CLAIM_SCAN_LENGTH = 16_384;

const SENTENCE_DELIMITERS = new Set([".", "!", "?", ";", "\n"]);

/**
 * Character ranges `[start, end)` of quoted spans in `message`: the interior
 * of single-backtick spans (`...`) and triple-backtick fences
 * (```...```), i.e. text a reviewer explicitly cites rather than prose.
 */
function quotedSpans(message: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of message.matchAll(/```(?:[^\n]*\n)?[\s\S]*?```/g)) {
    const chunk = match[0] ?? "";
    const index = match.index ?? 0;
    const contentStart = chunk.includes("\n") ? chunk.indexOf("\n") + 1 : 3;
    const contentEnd = chunk.length - 3;
    if (contentStart < contentEnd) spans.push({ start: index + contentStart, end: index + contentEnd });
  }
  for (const match of message.matchAll(/`([^`]+)`/g)) {
    const index = match.index ?? 0;
    spans.push({ start: index + 1, end: index + 1 + (match[1] ?? "").length });
  }
  return spans;
}

/**
 * The sentence containing a character range: the maximal substring around
 * it delimited by `.`, `!`, `?`, `;`, or a newline.
 */
function sentenceContaining(message: string, from: number, to: number): string {
  let start = from;
  while (start > 0 && !SENTENCE_DELIMITERS.has(message[start - 1] ?? "")) start -= 1;
  let end = to;
  while (end < message.length && !SENTENCE_DELIMITERS.has(message[end] ?? "")) end += 1;
  return message.slice(start, end);
}

/**
 * True when `message` asserts that committed source contains a sanitizer
 * marker: at least one marker occurrence must sit inside a quoted span, and
 * the sentence carrying that cited occurrence must assert existence
 * (COMMITTED_MARKER_ASSERTION_RE) while carrying no mention/expectation cue.
 * Anything else — including oversized messages and phrasings the scan does
 * not recognize — is ambiguous and returns false (untouched).
 */
function assertsCommittedMarker(message: string): boolean {
  if (message.length > MAX_CLAIM_SCAN_LENGTH) return false;
  const spans = quotedSpans(message);
  if (spans.length === 0) return false;
  for (const marker of SANITIZER_MARKERS) {
    let from = 0;
    for (;;) {
      const index = message.indexOf(marker, from);
      if (index === -1) break;
      const end = index + marker.length;
      for (const span of spans) {
        if (span.start <= index && end <= span.end) {
          const sentence = sentenceContaining(message, index, end);
          if (!COMMITTED_MARKER_CUE_RE.test(sentence) && COMMITTED_MARKER_ASSERTION_RE.test(sentence)) {
            return true;
          }
        }
      }
      from = index + 1;
    }
  }
  return false;
}

/**
 * Classify a finding message into the claim kinds the boundary can verify.
 *
 * Invariant (#1016 review pass): `committed_literal` fires only on markers
 * *cited as committed content* — a marker inside a quoted span
 * (single backticks or a triple-backtick fence) whose carrying sentence
 * positively asserts existence in the source and carries no
 * mention/expectation cue. Prose mentions of expected output, absent
 * masking, comparisons, and any ambiguous phrasing (including oversized
 * messages) never classify as committed source claims; they fall through
 * to the requirement regex, then to null, and the finding is left
 * untouched. Accepted recall trade-off: an existence assertion that cites
 * the marker in bare prose (no quotes) also escapes verification — it
 * stays blocking, which is the fail-safe side of this boundary.
 */
function classify(message: string): GroundingKind | null {
  if (assertsCommittedMarker(message)) return "committed_literal";
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
    // claim — a minimum length alone would let a ubiquitous token like
    // `=>` "ground" any claim, so require at least one identifier
    // character.
    if (span.length >= 2 && /[A-Za-z0-9_$]/.test(span)) out.push(span);
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
        // span whose bytes match the exact-head source. The evidence must
        // sit at the cited location (#1016 review pass): the span is
        // grounded only when it occurs within ±EVIDENCE_LINE_WINDOW lines
        // of the cited line. A span found only elsewhere in the file is
        // unknown evidence, not confirmation (unverified); a claim with no
        // cited evidence is unsupported, and one whose spans the source
        // contains nowhere is refuted (source positively disproves the
        // cited pattern). A span without a concrete cited line can never
        // ground, even when it matches elsewhere.
        const spans = extractCodeSpans(finding.message);
        if (spans.length === 0) {
          status = "unsupported";
          reason = "no-cited-evidence";
        } else {
          const line = finding.line;
          const citedLine = typeof line === "number" && Number.isInteger(line) && line >= 1 ? line : null;
          if (citedLine === null) {
            status = "unsupported";
            reason = "no-concrete-location";
          } else {
            const lines = read.text.split(/\r?\n/);
            if (citedLine > lines.length) {
              // A cited line past the end of the file is an unverifiable
              // location, not positive disproof (the model may count a
              // trailing-newline-terminated file one line longer), so it
              // must not refute into the relaxable path.
              status = "unverified";
              reason = "line-beyond-end";
            } else {
              // Compare cited spans to the window modulo carriage returns:
              // model citations carry LF line endings even when the commit
              // uses CRLF, and the line-ending representation must never
              // by itself flip grounded into refuted.
              const strip = (s: string): string => s.replace(/\r/g, "");
              const windowText = strip(lines
                .slice(Math.max(0, citedLine - 1 - EVIDENCE_LINE_WINDOW), citedLine + EVIDENCE_LINE_WINDOW)
                .join("\n"));
              if (spans.some((span) => verifySourceSpan(windowText, strip(span)).present)) {
                status = "grounded";
                reason = "evidence-verified";
              } else if (spans.some((span) => verifySourceSpan(strip(read.text), strip(span)).present)) {
                status = "unverified";
                reason = "evidence-location-mismatch";
              } else {
                status = "refuted";
                reason = "evidence-mismatch";
              }
            }
          }
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
