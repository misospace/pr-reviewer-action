/** Deterministic, bounded requirement-ledger extractor — v3 port of
 * `pr_reviewer/requirement_ledger.py` (#624 logic, #675 migration).
 *
 * Builds the explicit, stable list of requirements a review must check —
 * acceptance-criteria items, normative (MUST/SHALL) statements, and
 * sequencing invariants — from already-bounded review inputs, with
 * content-derived ids and full provenance. Pure line-based parsing: no model
 * calls, no network, no command execution; all input is treated as untrusted
 * and malformed sources degrade to a shorter ledger (this module never
 * throws).
 *
 * Design invariants preserved from the Python module:
 * - **Stable ids from content**: `req-` + sha256(casefolded post-truncation
 *   text)[:12] — the id is the id of exactly the text a reader can see.
 * - **Deterministic ordering**: source priority (standards, linked_issues,
 *   pr_body), then document order; casefolded-duplicate text merges into the
 *   first entry, provenance appended.
 * - **Bounded**: MAX_REQUIREMENTS entries, MAX_REQUIREMENT_CHARS text cap
 *   (visible … marker), MAX_SOURCES documents with capacity reserved for the
 *   standards and PR-body docs, hard UTF-8 byte cap on the rendered view.
 * - **Fence-safe rendering**: control characters escaped, code-span
 *   delimiters strictly longer than any backtick run in the text, leading
 *   `#` escaped — hostile input can never forge a heading or break out of a
 *   fence.
 */

import { createHash } from "node:crypto";
import { pythonJsonStringify } from "../precheck/metadata.js";

export const ARTIFACT_VERSION = 1;

/** Hard caps (defaults per #624). */
export const MAX_REQUIREMENTS = 48;
export const MAX_REQUIREMENT_CHARS = 400;
export const MAX_LEDGER_MARKDOWN_BYTES = 8192;
export const MAX_SOURCES = 32;

export const TRUNCATION_MARKER = "…";

/** Source priority order: decides scan order, merged-entry position, and
 * provenance order. */
export const SOURCE_PRIORITY: readonly string[] = ["standards", "linked_issues", "pr_body"];

export const LEDGER_KINDS: readonly string[] = ["acceptance", "normative", "invariant"];

export interface LedgerProvenance {
  source: string;
  ref: string;
  line: number;
}

/** The typed canonical requirement-ledger entry (#675). */
export interface RequirementLedgerEntry {
  id: string;
  text: string;
  kind: "acceptance" | "normative" | "invariant";
  verification_required: boolean;
  truncated: boolean;
  provenance: LedgerProvenance[];
}

export interface RequirementLedger {
  version: number;
  sha: string;
  requirements: RequirementLedgerEntry[];
  truncation: {
    truncated: boolean;
    omitted_requirements: number;
    omitted_sources: number;
  };
}

/** Heading texts (casefolded, stripped) whose list items are acceptance
 * criteria. Exact match: "requirements for v2" is NOT a requirements
 * heading. */
const ACCEPTANCE_HEADINGS: ReadonlySet<string> = new Set([
  "acceptance criteria",
  "requirements",
  "invariants",
  "success criteria",
  "required checks",
]);

// Uppercase normative tokens apply to any line; word boundaries keep
// "MUSTARD" / "SHELL" from matching.
const UPPER_NORMATIVE_RE = /\b(MUST NOT|MUST|SHALL NOT|SHALL)\b/;
// The lowercase form is normative only on list items (documented rule);
// matched against the casefolded line so "Must" in a bullet is also caught.
const LOWER_NORMATIVE_RE = /\b(must not|must|shall|required to)\b/;
const ORDERING_RE = /\b(before|after|prior to|until|then)\b/;

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/;
// The same shapes, used to strip the marker from the normalized text.
const MARKER_STRIP_RE = /^\s*(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/;
const WS_RE = /\s+/g;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const BACKTICK_RUN_RE = /`+/g;
const ID_RE = /^req-[0-9a-f]{12}$/;

const LEDGER_HEADER = "## Requirement Ledger";

/** Python `str.splitlines()` replica: splits on \n, \r, \r\n, \v, \f,
 * \x1c, \x1d, \x1e, \x85, U+2028, U+2029 and drops the terminators — so
 * hostile input cannot smuggle lines past a plain `\n` split. */
export function pySplitLines(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const code = text.charCodeAt(i);
    const isBreak =
      code === 0x0a ||
      code === 0x0d ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0x1c ||
      code === 0x1d ||
      code === 0x1e ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029;
    if (isBreak) {
      lines.push(text.slice(start, i));
      i = code === 0x0d && text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start < n) lines.push(text.slice(start));
  return lines;
}

/** Content-derived entry id (first 12 hex of sha256 of casefolded text). */
function requirementId(text: string): string {
  return "req-" + createHash("sha256").update(Buffer.from(text.toLowerCase(), "utf8")).digest("hex").slice(0, 12);
}

/** First 16 hex of sha256 over the canonical JSON of the entries array. */
function computeSha(entries: RequirementLedgerEntry[]): string {
  const canonical = pythonJsonStringify(entries, ",", ":");
  return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex").slice(0, 16);
}

export function emptyLedger(): RequirementLedger {
  return {
    version: ARTIFACT_VERSION,
    sha: computeSha([]),
    requirements: [],
    truncation: { truncated: false, omitted_requirements: 0, omitted_sources: 0 },
  };
}

/** Normalize one line; `null` when it is empty after normalization. The id is
 * derived from this (post-truncation) text. */
function normalizeLine(raw: string): { text: string; truncated: boolean } | null {
  const text = raw.replace(MARKER_STRIP_RE, "").replace(WS_RE, " ").trim();
  if (!text) return null;
  if (text.length > MAX_REQUIREMENT_CHARS) {
    return { text: text.slice(0, MAX_REQUIREMENT_CHARS - 1) + TRUNCATION_MARKER, truncated: true };
  }
  return { text, truncated: false };
}

interface ScannedLine {
  normalized: string;
  truncated: boolean;
  kind: "acceptance" | "normative" | "invariant";
  line: number;
}

/** Extract entries from one document. Lines inside ``` / ~~~ fences are
 * skipped (requirements are never extracted from code fences). Line numbers
 * are 1-based. */
function scanDocument(text: string): ScannedLine[] {
  const found: ScannedLine[] = [];
  let inFence = false;
  let fenceChar = "";
  let heading = "";
  let lineno = 0;
  for (const raw of pySplitLines(text)) {
    lineno += 1;
    const fence = FENCE_RE.exec(raw.trim());
    if (inFence) {
      if (fence !== null && (fence[1] ?? "").charAt(0) === fenceChar) inFence = false;
      continue;
    }
    if (fence !== null) {
      inFence = true;
      fenceChar = (fence[1] ?? "").charAt(0);
      continue;
    }
    const headingMatch = HEADING_RE.exec(raw);
    if (headingMatch !== null) {
      heading = (headingMatch[1] ?? "").trim();
      continue;
    }
    const isListItem = LIST_ITEM_RE.test(raw);
    let kind: ScannedLine["kind"] | null = null;
    if (isListItem && ACCEPTANCE_HEADINGS.has(heading.toLowerCase())) {
      kind = "acceptance";
    } else if (UPPER_NORMATIVE_RE.test(raw) || (isListItem && LOWER_NORMATIVE_RE.test(raw.toLowerCase()))) {
      kind = "normative";
    }
    if (kind === null) continue;
    const normalized = normalizeLine(raw);
    if (normalized === null) continue;
    if (ORDERING_RE.test(normalized.text.toLowerCase())) kind = "invariant";
    found.push({ normalized: normalized.text, truncated: normalized.truncated, kind, line: lineno });
  }
  return found;
}

/** Parse rendered `linked-issues.md` into (ref, body) documents. Each
 * `## <repo>#<number>` heading (or any heading, as a fallback ref) owns the
 * fenced JSON blocks that follow it; a block decodes to a dict with a string
 * `body` to contribute that body for scanning. Malformed blocks are skipped
 * fail-soft. */
function parseLinkedIssueDocuments(markdown: string): { ref: string; body: string }[] {
  const documents: { ref: string; body: string }[] = [];
  let currentRef = "";
  let inFence = false;
  let fenceChar = "";
  let fenceLines: string[] = [];
  for (const raw of pySplitLines(markdown)) {
    const fence = FENCE_RE.exec(raw.trim());
    if (inFence) {
      if (fence !== null && (fence[1] ?? "").charAt(0) === fenceChar) {
        inFence = false;
        let obj: unknown = null;
        try {
          obj = JSON.parse(fenceLines.join("\n"));
        } catch {
          obj = null;
        }
        if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
          const body = (obj as Record<string, unknown>).body;
          if (typeof body === "string" && body.trim()) {
            documents.push({ ref: currentRef, body });
          }
        }
      } else {
        fenceLines.push(raw);
      }
      continue;
    }
    if (fence !== null) {
      inFence = true;
      fenceChar = (fence[1] ?? "").charAt(0);
      fenceLines = [];
      continue;
    }
    const heading = HEADING_RE.exec(raw);
    if (heading !== null) currentRef = (heading[1] ?? "").trim();
  }
  return documents;
}

/** The PR title + body as one scannable document, or null. */
function prDocumentText(prJson: unknown): string | null {
  if (prJson === null || prJson === undefined) return null;
  let rec: Record<string, unknown> | null = null;
  if (typeof prJson === "string") {
    try {
      const parsed: unknown = JSON.parse(prJson);
      rec = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  } else if (typeof prJson === "object" && !Array.isArray(prJson)) {
    rec = prJson as Record<string, unknown>;
  }
  if (rec === null) return null;
  const title = typeof rec.title === "string" ? rec.title : "";
  const body = typeof rec.body === "string" ? rec.body : "";
  const text = title ? `${title}\n${body}` : body;
  return text || null;
}

export interface LedgerInput {
  /** PR JSON as a decoded object or a raw JSON string (tolerated). */
  prJson?: unknown;
  linkedIssuesMarkdown?: string | null | undefined;
  standardsText?: string | null | undefined;
  standardsRef?: string | null | undefined;
}

/** Build the version-1 requirement ledger from bounded review inputs. Never
 * throws on malformed input; ids are computed from post-truncation
 * normalized text; duplicate text (casefolded) merges into one entry whose
 * provenance is appended in source-priority, document order, and whose
 * position is set by the first occurrence. */
export function extractRequirementLedger(input: LedgerInput = {}): RequirementLedger {
  const { prJson = null, linkedIssuesMarkdown = null, standardsText = null, standardsRef = null } = input;
  let resolvedRef = typeof standardsRef === "string" ? standardsRef : "";
  if (!resolvedRef.trim()) resolvedRef = "standards";

  type SourceDoc = { source: string; ref: string; text: string };
  const documents: SourceDoc[] = [];
  if (typeof standardsText === "string") documents.push({ source: "standards", ref: resolvedRef, text: standardsText });
  if (typeof linkedIssuesMarkdown === "string") {
    for (const doc of parseLinkedIssueDocuments(linkedIssuesMarkdown)) {
      documents.push({ source: "linked_issues", ref: doc.ref, text: doc.body });
    }
  }
  const prText = prDocumentText(prJson);
  if (prText !== null) documents.push({ source: "pr_body", ref: "pr", text: prText });

  // Reserve capacity for the fixed source classes (the standards doc and the
  // PR doc — at most two) before bounding the variable linked-issue set, so
  // one noisy linked-issue source cannot crowd out the others. Kept
  // linked-issue docs are the leading ones in document order; the scan order
  // (standards, linked_issues, pr_body) and the entry ordering/ids/dedup/
  // caps are unchanged.
  const reservedCount = documents.filter((doc) => doc.source !== "linked_issues").length;
  const linkedCount = documents.length - reservedCount;
  const liCapacity = Math.max(0, MAX_SOURCES - reservedCount);
  const keptDocs: SourceDoc[] = [];
  let keptLinked = 0;
  for (const doc of documents) {
    if (doc.source === "linked_issues") {
      if (keptLinked < liCapacity) {
        keptDocs.push(doc);
        keptLinked += 1;
      }
    } else {
      keptDocs.push(doc);
    }
  }
  const omittedSources = linkedCount - keptLinked;

  const entries: RequirementLedgerEntry[] = [];
  const indexByKey = new Map<string, number>();
  for (const doc of keptDocs) {
    for (const found of scanDocument(doc.text)) {
      const key = found.normalized.toLowerCase();
      const index = indexByKey.get(key);
      if (index === undefined) {
        indexByKey.set(key, entries.length);
        entries.push({
          id: requirementId(found.normalized),
          text: found.normalized,
          kind: found.kind,
          verification_required: found.kind === "invariant",
          truncated: found.truncated,
          provenance: [{ source: doc.source, ref: doc.ref, line: found.line }],
        });
      } else {
        // Merged duplicate: the first occurrence owns the entry (position,
        // kind, flags); provenance is appended.
        entries[index]?.provenance.push({ source: doc.source, ref: doc.ref, line: found.line });
      }
    }
  }

  const omitted = Math.max(0, entries.length - MAX_REQUIREMENTS);
  const kept = omitted > 0 ? entries.slice(0, MAX_REQUIREMENTS) : entries;
  return {
    version: ARTIFACT_VERSION,
    sha: computeSha(kept),
    requirements: kept,
    truncation: {
      // Source-capacity drops are truncation too: the omitted linked-issue
      // docs never become entries, and that omission must be visible.
      truncated: omitted > 0 || omittedSources > 0,
      omitted_requirements: omitted,
      omitted_sources: omittedSources,
    },
  };
}

// ---------------------------------------------------------------------------
// Tolerant ledger loading
// ---------------------------------------------------------------------------

function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

/** Rebuild one entry from untrusted data, or null when unusable. */
function tolerantEntry(item: unknown): RequirementLedgerEntry | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const text = rec.text;
  if (typeof text !== "string" || !text.trim()) return null;
  // A forged/malformed id is replaced by the content-derived one.
  const entryId = isValidId(rec.id) ? rec.id : requirementId(text);
  let kind = rec.kind;
  if (typeof kind !== "string" || !LEDGER_KINDS.includes(kind)) kind = "normative";
  const provenance: LedgerProvenance[] = [];
  const rawProvenance = rec.provenance;
  if (Array.isArray(rawProvenance)) {
    for (const prov of rawProvenance) {
      if (prov === null || typeof prov !== "object" || Array.isArray(prov)) continue;
      const prec = prov as Record<string, unknown>;
      const source =
        typeof prec.source === "string" && SOURCE_PRIORITY.includes(prec.source) ? prec.source : "pr_body";
      const ref = typeof prec.ref === "string" ? prec.ref : "";
      const rawLine = prec.line;
      const line = typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine >= 0 ? rawLine : 0;
      provenance.push({ source, ref, line });
    }
  }
  return {
    id: entryId,
    text,
    kind: kind as RequirementLedgerEntry["kind"],
    // Python `bool(item.get(...))` truthiness — any truthy value counts.
    verification_required: Boolean(rec.verification_required),
    truncated: Boolean(rec.truncated),
    provenance,
  };
}

/** Tolerantly rebuild a ledger from untrusted data; unusable input → empty.
 * The sha is always recomputed from the surviving entries so a tampered
 * artifact can never carry a mismatched signature. */
export function loadLedgerFromValue(data: unknown): RequirementLedger {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return emptyLedger();
  const rec = data as Record<string, unknown>;
  const requirements: RequirementLedgerEntry[] = [];
  if (Array.isArray(rec.requirements)) {
    for (const item of rec.requirements) {
      const entry = tolerantEntry(item);
      if (entry !== null) requirements.push(entry);
    }
  }
  let truncated = false;
  let omitted = 0;
  let omittedSources = 0;
  const truncation = rec.truncation;
  if (truncation !== null && typeof truncation === "object" && !Array.isArray(truncation)) {
    const trec = truncation as Record<string, unknown>;
    truncated = Boolean(trec.truncated);
    const rawOmitted = trec.omitted_requirements;
    if (typeof rawOmitted === "number" && Number.isInteger(rawOmitted) && rawOmitted > 0) omitted = rawOmitted;
    const rawOmittedSources = trec.omitted_sources;
    if (typeof rawOmittedSources === "number" && Number.isInteger(rawOmittedSources) && rawOmittedSources > 0) {
      omittedSources = rawOmittedSources;
    }
  }
  return {
    version: ARTIFACT_VERSION,
    sha: computeSha(requirements),
    requirements,
    truncation: { truncated, omitted_requirements: omitted, omitted_sources: omittedSources },
  };
}

// ---------------------------------------------------------------------------
// Fence-safe markdown rendering
// ---------------------------------------------------------------------------

function escapeControlChars(text: string): string {
  return text.replace(CONTROL_RE, (char) => {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) return "\\n";
    if (code === 0x09) return "\\t";
    if (code === 0x0d) return "\\r";
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Wrap text in a code span whose delimiter is strictly longer than any
 * backtick run in it, so hostile text cannot terminate the span. */
function codeSpan(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  let maxRun = 1;
  for (const match of text.matchAll(BACKTICK_RUN_RE)) {
    maxRun = Math.max(maxRun, (match[0] ?? "`").length);
  }
  const delim = "`".repeat(maxRun + 1);
  return `${delim} ${text} ${delim}`;
}

/** Render one entry as a single markdown bullet (control-safe). */
function requirementLine(entry: RequirementLedgerEntry): string {
  let text = escapeControlChars(entry.text);
  // Escape a leading '#' so entry text can never forge a markdown heading.
  if (text.startsWith("#")) text = `\\${text}`;
  const entryId = isValidId(entry.id) ? entry.id : "req-" + "0".repeat(12);
  const kind = LEDGER_KINDS.includes(entry.kind) ? entry.kind : "normative";
  const refs: string[] = [];
  for (const prov of entry.provenance) {
    if (typeof prov !== "object" || prov === null) continue;
    if (typeof prov.ref === "string" && prov.ref) refs.push(prov.ref);
    else if (typeof prov.source === "string" && prov.source) refs.push(prov.source);
    else refs.push("unknown");
  }
  const via = escapeControlChars(refs.length > 0 ? refs.join(", ") : "unknown");
  return `- (${entryId}) ${codeSpan(text)} [${kind}] (via ${codeSpan(via)})`;
}

/** Shrink text char-safely so its UTF-8 length is <= maxBytes (never splits a
 * multibyte character). */
function fitToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let i = text.length;
  while (i > 0 && Buffer.byteLength(text.slice(0, i), "utf8") > maxBytes) i -= 1;
  return text.slice(0, i);
}

/** Render a fence-safe markdown view of a ledger. Requirements render as
 * ``- (id) `text` [kind] (via ref)`` list items. When maxBytes is given a
 * hard UTF-8 byte cap applies: trailing whole entries are dropped (never a
 * character mid-codepoint) until the budget holds, the omission is always
 * visible, and a single oversized entry is shrunk char-safely. */
export function renderRequirementLedgerMarkdown(
  ledger: unknown,
  maxBytes: number | null = MAX_LEDGER_MARKDOWN_BYTES,
): string {
  const entries: RequirementLedgerEntry[] = [];
  const raw =
    ledger !== null && typeof ledger === "object" && !Array.isArray(ledger)
      ? (ledger as Record<string, unknown>).requirements
      : null;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const entry = tolerantEntry(item);
      if (entry !== null) entries.push(entry);
    }
  }

  const build = (kept: RequirementLedgerEntry[], omitted: number): string => {
    const lines: string[] = [LEDGER_HEADER, ""];
    for (const entry of kept) lines.push(requirementLine(entry));
    if (omitted > 0) lines.push(`(+${omitted} requirements omitted for length)`);
    return `${lines.join("\n")}\n`;
  };

  if (maxBytes === null) return build(entries, 0);
  const cap = Math.max(1, Math.trunc(maxBytes));
  let shown = entries.length;
  let doc = build(entries.slice(0, shown), 0);
  while (Buffer.byteLength(doc, "utf8") > cap && shown > 0) {
    shown -= 1;
    doc = build(entries.slice(0, shown), entries.length - shown);
  }
  if (Buffer.byteLength(doc, "utf8") > cap) doc = fitToBytes(doc, cap);
  return doc;
}
