/**
 * Stable finding identity for the #1027 finding-outcome and feedback data
 * contract. A finding's identity is a SHA-256 digest over its redacted,
 * whitespace-collapsed content tuple — path, severity, category, message —
 * never its anchor line, so a re-review that re-anchors the same finding
 * after a force-push (line drift) keeps the identity while a genuinely
 * different finding gets a different one. A rewritten message is honestly a
 * NEW identity: the contract records only what it can prove deterministically
 * and never fuzzy-matches prose.
 *
 * The identity travels between runs inside the published inline finding
 * comment as a hidden, action-owned, single-line HTML marker with the same
 * strict-grammar discipline as the #762 rejection carry marker: a near-miss
 * line is ordinary content, and the marker is reserved against model-authored
 * markdown (`RESERVED_MARKER_PATTERNS`), so a finding identity can only ever
 * originate from this action's own publication path.
 */
import { createHash } from "node:crypto";
import { redactText } from "../context/redact.js";
import { pyCodepointSlice } from "../platform/py.js";
import { safePath } from "../findings/safe-path.js";

/** Longest message text the identity digests — the same bound the review
 * thread extraction applies to finding messages (`MAX_MESSAGE_CHARS`), so an
 * unbounded model message cannot grow the digest input without bound. */
const MAX_IDENTITY_MESSAGE_CODEPOINTS = 500;

function collapseWhitespace(text: string): string {
  return text.split(/\s+/).filter((part) => part !== "").join(" ");
}

export interface FindingIdentityInput {
  path: string;
  severity: string;
  category?: string | null;
  message: string;
}

/** The stable identity digest for one finding. Fields are normalized the
 * same way every time (trim, lowercase severity/category, redact → collapse
 * → bound the message) and serialized as a JSON array, so no field value can
 * arrange a collision with another tuple: the encoding is injective even for
 * fields that themselves contain NUL — a bare NUL join is not, because a
 * model-authored path, severity, category, or message may carry `\u0000`
 * (`\s` does not match it), which would let one tuple's field boundary be
 * forged inside another field. Digests are low-cardinality by construction
 * and carry no secret material: the message is redacted before hashing. */
export function findingIdentity(input: FindingIdentityInput): string {
  const message = pyCodepointSlice(collapseWhitespace(redactText(input.message)), MAX_IDENTITY_MESSAGE_CODEPOINTS);
  const key = JSON.stringify([
    input.path.trim(),
    input.severity.trim().toLowerCase(),
    (input.category ?? "").trim().toLowerCase(),
    message,
  ]);
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** The identity for a raw finding record (the shape `buildComments`
 * validates), or null when the record cannot prove a stable identity — an
 * unanchorable path, a missing message, or a non-record. Findings without an
 * identity contribute no outcome events. */
export function findingIdentityFromRecord(rec: unknown): string | null {
  if (rec === null || typeof rec !== "object" || Array.isArray(rec)) return null;
  const value = rec as Record<string, unknown>;
  if (!safePath(value.file)) return null;
  if (typeof value.message !== "string" || value.message.trim() === "") return null;
  const severity = typeof value.severity === "string" && value.severity.trim() !== "" ? value.severity : "info";
  const category = typeof value.category === "string" ? value.category : "";
  return findingIdentity({ path: value.file, severity, category, message: value.message });
}

/** #1027: the marker grammar. One line — the exact prefix, exactly 64
 * lowercase hex chars, the exact HTML comment close. Nothing else is the
 * grammar: a 63/65-char token, an uppercase one, or any trailing text is
 * ordinary content, not state. A "line" ends at CR, CRLF, or LF — the same
 * normalization premise #1107 encodes for fence openers (`reserveSuggestionOpeners`):
 * a forge may turn a lone CR into a line break, so a CR-terminated marker
 * must be STATE for the parser exactly when it is stripped on publication.
 * `FINDING_ID_LINE_SOURCE` is shared by parse and strip by construction: a
 * stripped line is one the parser honors, and a line the parser would
 * refuse stays in the body as ordinary content. */
const FINDING_ID_LINE_SOURCE = "^<!-- pr-reviewer:finding-id:v1:([0-9a-f]{64}) -->$";
const FINDING_ID_LINE_GLOBAL_RE = new RegExp(FINDING_ID_LINE_SOURCE, "gm");
/** Strip form of the same line grammar: a mid/end-of-body marker line is
 * removed together with its PRECEDING terminator (the join the old
 * split-and-filter implementation produced); a body-leading marker line has
 * no preceding terminator to take, and removing one would eat a surviving
 * line's break, so it is dropped alone. */
const FINDING_ID_STRIP_RE = new RegExp(
  `(?:[\\r\\n]${FINDING_ID_LINE_SOURCE}|^${FINDING_ID_LINE_SOURCE})(?=[\\r\\n]|$)`,
  "gm",
);
const FINDING_ID_DIGEST_RE = /^[0-9a-f]{64}$/;

/** Render the hidden identity marker appended to a published inline finding
 * body, or null when the digest is not a provable identity (never render an
 * unvalidated value into a published body). */
export function renderFindingIdentityMarker(digest: string): string | null {
  if (!FINDING_ID_DIGEST_RE.test(digest)) return null;
  return `\n\n<!-- pr-reviewer:finding-id:v1:${digest} -->`;
}

/** Recover the identity a previously published comment of ours carries, or
 * null when it carries none that can be recovered unambiguously. Only a
 * standalone line matching the exact grammar counts; two DISTINCT digests
 * fail closed (a comment cannot prove two identities), while exact
 * duplicates collapse to the one digest. */
export function parseFindingIdentityMarker(body: string): string | null {
  if (typeof body !== "string" || !body.includes("pr-reviewer:finding-id:v1:")) return null;
  let found: string | null = null;
  for (const match of body.matchAll(FINDING_ID_LINE_GLOBAL_RE)) {
    const digest = match[1];
    if (digest === undefined) continue;
    if (found !== null && found !== digest) return null;
    found = digest;
  }
  return found;
}

/** Remove identity-marker lines from a body — the marker is this action's
 * machine state, never finding content, so message extraction and corpus
 * rendering must not see it (same rule as the disclaimer trailer and the
 * usefulness affordance). Shared grammar with `parseFindingIdentityMarker`
 * by construction: a stripped line is one the parser honors, and a line the
 * parser would refuse stays in the body as ordinary content. */
export function stripFindingIdentityMarkers(body: string): string {
  if (!body.includes("pr-reviewer:finding-id:v1:")) return body;
  return body.replace(FINDING_ID_STRIP_RE, "");
}
