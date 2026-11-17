/**
 * ONE evidence-citation contract for every deterministic provenance check
 * (#1681 round 6). The requirement-trace fold, review-thread `fixed`
 * settlement, and human-change-request `addressed` settlement all consume
 * the SAME citation grammar and the SAME head-resolution predicate shape,
 * so a reviewer can cite evidence in the representation it actually saw —
 * never in a per-channel private syntax that silently fails the validator
 * of a different channel.
 *
 * Canonical citation syntax (the only model-facing contract; the prompt
 * fragments teach exactly this):
 *
 *  - `path`                        — file-level citation (resolves at line 1)
 *  - `path:LINE`
 *  - `path:LINE-END`               — a range cites its FIRST line
 *  - `path:+LINE`                  — diff anchor: the corpus PR-Diff section
 *  - `path:+LINE-END`                renders hunks with new-side numbering,
 *                                    which IS current-head numbering
 *  - `path:+LINE-END:INDEX`        — an anchor carrying the evidence-entry
 *                                    ordinal the model sees when it lists
 *                                    several refs (the index is positional
 *                                    metadata, never a line number)
 *
 * Anything else cites no locatable line: prose, a bare `line N` with no
 * path, URLs, or any token with whitespace or control bytes. The old-side
 * (`-`) anchor is deliberately NOT citable — base-revision line numbers are
 * not head locations and must not resolve. A colon-free token (a bare
 * `Makefile`, or a stray tool-call id) keeps file-level provenance and is
 * rejected by checkout resolution, not by the grammar.
 *
 * Parsing never proves existence. Resolution is the injected
 * {@link EvidenceGrounding.resolveLocation} predicate, always backed by the
 * exact-head checkout (the requirement trace's own
 * `createHeadLocationValidator`, so every channel validates against the one
 * reviewed revision). Parsing accepts; only resolution vouches.
 */

/** One resolved code location: repository-relative file + 1-indexed line. */
export interface CitationLocation {
  file: string;
  line: number;
}

/** Deterministic provenance context supplied by the engine at settlement
 * time. Both fields are objective run state, never model output:
 * - `resolveLocation(file, line)` proves the location exists at the exact
 *   reviewed head (file readable in the checkout, line within the file).
 * - `acquiredPaths` names every path whose current-head content THIS run
 *   actually acquired (successful tool reads plus assembler-certified
 *   corpus-diff payloads). It lets a reviewer's semantic judgment rest on
 *   evidence the run genuinely holds without demanding the same citation
 *   be restated in a second parallel proof channel (#1681 PhAd defect). */
export interface EvidenceGrounding {
  resolveLocation: (file: string, line: number) => boolean;
  acquiredPaths?: ReadonlySet<string>;
}

/** Control bytes never appear in a real path; reject them at the parse door
 * exactly like the requirement trace does (#252 boundary discipline). */
function hasControlBytes(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(text);
}

/** `path:+LINE`, `path:+LINE-END`, or `path:+LINE-END:INDEX` — the diff
 * anchor as the corpus renders it. The file part may not contain
 * whitespace; a reversed range is malformed, not a citation. */
const DIFF_ANCHOR_RE = /^([^\s:][^:]*?):\+(\d+)(?:-(\d+))?(?::(\d+))?$/;

/** `path` / `path:LINE` / `path:LINE-END`, each optionally carrying the
 * evidence-entry ordinal suffix (`path:LINE-END:INDEX`) the model adds when
 * it lists several refs. Such tokens used to parse as one garbage path;
 * reading the first number as the line is the same rule the range form
 * already applies. */
const PLAIN_CITATION_RE = /^([^\s:][^:]*?):(\d+)(?:-(\d+))?(?::(\d+))?$/;

/** Parse one whole-string ref into a head-citable location, or null when it
 * names no location. Order matters: the plain form is tried first so
 * previously-accepted tokens keep byte-identical parse results; the `+`
 * anchor form is what the plain regex cannot consume. */
export function parseCitationLocation(ref: unknown): CitationLocation | null {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (trimmed === "") return null;
  if (hasControlBytes(trimmed)) return null;
  // A URL names no repository location, with or without a port-shaped
  // trailing number.
  if (trimmed.includes("://")) return null;
  const plain = PLAIN_CITATION_RE.exec(trimmed);
  if (plain !== null) {
    const line = Number(plain[2]);
    if (!Number.isSafeInteger(line) || line <= 0) return null;
    if (plain[3] !== undefined) {
      const end = Number(plain[3]);
      if (!Number.isSafeInteger(end) || end < line) return null;
    }
    return { file: plain[1] as string, line };
  }
  const anchor = DIFF_ANCHOR_RE.exec(trimmed);
  if (anchor !== null) {
    const line = Number(anchor[2]);
    if (!Number.isSafeInteger(line) || line <= 0) return null;
    if (anchor[3] !== undefined) {
      const end = Number(anchor[3]);
      if (!Number.isSafeInteger(end) || end < line) return null;
    }
    return { file: anchor[1] as string, line };
  }
  // A bare path (no `:line`) is still a path-shaped ref — file-level
  // provenance; a token with any whitespace is prose, not a path, and a
  // token still carrying a colon was location-shaped but malformed.
  if (/\s/.test(trimmed) || trimmed.includes(":")) return null;
  return { file: trimmed, line: 1 };
}

/** Cap on locations extracted from one free-text evidence string. */
const MAX_EXTRACTED_LOCATIONS = 16;

/** Tokens like `(src/x.ts:12),` appear in prose; strip the edge punctuation
 * that sentence structure adds, without touching path bytes (paths never
 * start or end with these). */
function stripEdgePunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  const EDGE = "([{<>\"'`,.;)]}";
  while (start < end && EDGE.includes(token[start]!)) start += 1;
  while (end > start && EDGE.includes(token[end - 1]!)) end -= 1;
  return token.slice(start, end);
}

/** A citable path must look like a file: a name carrying an extension dot,
 * no URL scheme, no whitespace. This keeps `http://host:8080` and bare
 * prose out of the candidate set while `src/a.b/x.ts` stays in. */
function looksLikeFilePath(path: string): boolean {
  if (path === "" || /\s/.test(path)) return false;
  if (path.includes("://") || path.includes("//")) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z][A-Za-z0-9]*$/.test(base);
}

/** Prose forms scanned over the whole evidence string:
 * - `path:LINE[-END][:INDEX]` and the diff anchor `path:+LINE[-END][:INDEX]`
 * - the historical lexical `path … line N` form (round-5 evidence like
 *   "README.md line 12 shows it") — the path may be bare there because the
 *   "line" keyword disambiguates it from ordinary prose. */
const PROSE_CITATION_RE =
  /(?<path>[\w][\w./+-]*\.[A-Za-z][\w]*)(?::\+?(?<line>\d+)(?:-\d+)?(?::\d+)?|\s+line\s+(?<kwline>\d+))/gi;

/** Extract every citation CANDIDATE from a free-text evidence string —
 * candidates in the one grammar, each of which still has to resolve at
 * head. Bounded, order-preserving, de-duplicated. */
export function extractCitationLocations(text: string | null | undefined): CitationLocation[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  // Self-defense for future callers: the shipped channels cap evidence at
  // ~1k chars, and the prose regex is quadratic on adversarial runs of
  // word characters, so a pathologically long string cites nothing.
  const input = text.length > 8192 ? "" : text;
  const out: CitationLocation[] = [];
  const seen = new Set<string>();
  const push = (file: string, line: number): void => {
    if (out.length >= MAX_EXTRACTED_LOCATIONS) return;
    if (!Number.isSafeInteger(line) || line <= 0) return;
    if (!looksLikeFilePath(file)) return;
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line });
  };
  for (const match of input.matchAll(PROSE_CITATION_RE)) {
    // Skip the path part of a URL: `http://host/x.ts:80` names a host, not a
    // repository file, even though the suffix looks like a line number.
    if (input.slice(Math.max(0, match.index - 3), match.index) === "://") continue;
    const groups = match.groups ?? {};
    const file = groups.path ?? "";
    const line = groups.line !== undefined ? Number(groups.line) : Number(groups.kwline);
    push(file, line);
  }
  // Directory-qualified bare path tokens (no `:line`, no "line N"): a repo
  // path in prose is file-level provenance (`src/x/y.ts`); a bare filename
  // or a sentence fragment like "e.g." names no location.
  for (const raw of input.split(/\s+/)) {
    if (out.length >= MAX_EXTRACTED_LOCATIONS) break;
    const token = stripEdgePunctuation(raw);
    if (token === "" || hasControlBytes(token)) continue;
    if (token.includes(":") || !token.includes("/") || !looksLikeFilePath(token)) continue;
    push(token, 1);
  }
  return out;
}
