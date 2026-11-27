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
 * Model-facing citations are REPOSITORY-RELATIVE (#1681 round 7): an
 * absolute path (`/tmp/x.ts:12`), a drive-shaped path (`C:/x.ts:12`) or a
 * traversal segment (`../x.ts:12`, `src/../../x.ts:1`) is refused at the
 * parse door, so an environment-specific spelling can never be a valid
 * citation on any runner. The exact-head workspace containment and symlink
 * guards stay exactly as they are — strictness here is the contract, the
 * resolver stays the defense-in-depth enforcement.
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

/** Repository-relative only (#1681 round 7): the canonical contract says a
 * model citation is a path RELATIVE to the repository root, so absolute
 * paths (`/tmp/x.ts:12`, `/C:/x.ts:12`), drive-shaped paths (`C:/x.ts`) and
 * traversal segments (`../x.ts`, `src/../../x.ts`) are refused by the
 * grammar itself — an environment-specific or escaping spelling is not a
 * citation anywhere, on any runner. The exact-head resolver's containment
 * and symlink guards remain the defense-in-depth layer; this is the
 * contract, not a replacement for that check. A URL scheme is caught by the
 * `://` probe at the parse door; a bare `//` (protocol-relative or UNC)
 * names no repository file either. */
function isNonRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("//")) return true;
  if (/^[A-Za-z]:/.test(path)) return true;
  return path.split("/").some((segment) => segment === "..");
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
  if (trimmed.includes("://") || trimmed.includes("//")) return null;
  const plain = PLAIN_CITATION_RE.exec(trimmed);
  if (plain !== null) {
    const line = Number(plain[2]);
    if (!Number.isSafeInteger(line) || line <= 0) return null;
    if (plain[3] !== undefined) {
      const end = Number(plain[3]);
      if (!Number.isSafeInteger(end) || end < line) return null;
    }
    if (isNonRelativePath(plain[1] as string)) return null;
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
    if (isNonRelativePath(anchor[1] as string)) return null;
    return { file: anchor[1] as string, line };
  }
  // A bare path (no `:line`) is still a path-shaped ref — file-level
  // provenance; a token with any whitespace is prose, not a path, and a
  // token still carrying a colon was location-shaped but malformed.
  if (/\s/.test(trimmed) || trimmed.includes(":")) return null;
  if (isNonRelativePath(trimmed)) return null;
  return { file: trimmed, line: 1 };
}

/** #1835 round 4: whether a parseable ref names an EXPLICIT line — the
 * canonical bare-path question. `parseCitationLocation` collapses both
 * spellings to a line (a bare path defaults to 1), so the distinction must
 * come from the grammar's own regexes, never from a second ad-hoc probe
 * that can drift (the `path:+LINE-END` anchor's `:` is followed by `+`, not
 * a digit). A bare path is file-level; `path:LINE`, `path:LINE-END`, and
 * both diff-anchor spellings are line-specific (ranges ride the canonical
 * start line). */
export function citationNamesExplicitLine(ref: unknown): boolean {
  if (parseCitationLocation(ref) === null) return false;
  const trimmed = (ref as string).trim();
  return PLAIN_CITATION_RE.test(trimmed) || DIFF_ANCHOR_RE.test(trimmed);
}

/** Cap on locations extracted from one free-text evidence string. */
const MAX_EXTRACTED_LOCATIONS = 16;

/** Tokens like `(src/x.ts:12),` appear in prose; strip the edge punctuation
 * that sentence structure adds, without touching path bytes (paths never
 * start or end with these). The sentence period is deliberately NOT an edge
 * character: repository roots like `.github/…` legitimately start with a
 * dot, and stripping it would rewrite the path — a trailing-period token
 * (`src/a.ts.`) then parses to nothing, which fails closed. */
function stripEdgePunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  const EDGE = "([{<>\"'`,;)]}";
  while (start < end && EDGE.includes(token[start]!)) start += 1;
  while (end > start && EDGE.includes(token[end - 1]!)) end -= 1;
  return token.slice(start, end);
}

/** The extractor-side path-shape HEURISTIC for prose discovery: a citable
 * path carries a file-extension dot in its final segment, is non-empty, and
 * is not absolute/traversal/URL-shaped. It never encodes the line/range
 * grammar (that lives only in the canonical parser); it only keeps ordinary
 * prose words and tool ids out of the candidate set. Shared by the colon
 * and the `line N` discovery forms so the two can never drift. */
function looksLikeFilePath(path: string): boolean {
  if (path === "" || /\s/.test(path) || hasControlBytes(path)) return false;
  if (isNonRelativePath(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z][A-Za-z0-9]*$/.test(base);
}

/** The historical lexical `path … line N` form (round-5 evidence like
 * "README.md line 12 shows it") — a DISCOVERY pattern that binds a
 * path-shaped token to a following `line N`; the produced `path:LINE` ref
 * is then judged by the canonical parser like every other candidate. */
const LINE_KEYWORD_RE = /(?:^|\s)([^\s:]+)[ \t]+[Ll][Ii][Nn][Ee][ \t]+(\d+)/g;

/** Extract every citation CANDIDATE from a free-text evidence string and
 * pass each through the canonical parser (#1681 round 7): the scanner only
 * answers «which substrings might be citations?», `parseCitationLocation`
 * alone answers «is this a valid citation and where?». Structured refs and
 * prose therefore share ONE grammar — anything the parser accepts inside a
 * requirement-evidence field is discoverable in thread/human evidence when
 * embedded in ordinary prose. Bounded, order-preserving, de-duplicated. */
export function extractCitationLocations(text: string | null | undefined): CitationLocation[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  // Self-defense for future callers: the shipped channels cap evidence at
  // ~1k chars, and scanning unbounded prose is quadratic work, so a
  // pathologically long string cites nothing.
  const input = text.length > 8192 ? "" : text;
  const out: CitationLocation[] = [];
  const seen = new Set<string>();
  const push = (candidate: string): void => {
    if (out.length >= MAX_EXTRACTED_LOCATIONS) return;
    if (candidate.length === 0 || candidate.length > 1024) return;
    // One grammar authority: parse, never re-validate here.
    const loc = parseCitationLocation(candidate);
    if (loc === null) return;
    // Prose discovery stays conservative: only path-shaped candidates count,
    // so ordinary words and tool ids never settle anything from prose.
    if (!looksLikeFilePath(loc.file)) return;
    const key = `${loc.file}:${loc.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(loc);
  };
  // Historical `path … line N` lexical form FIRST, and each matched path is
  // RESERVED: the keyword is precisely what disambiguates a bare filename
  // from ordinary prose, so a keyword-bound token must not also emit the
  // file-level line-1 fallback for the same path.
  const reserved = new Set<string>();
  for (const match of input.matchAll(LINE_KEYWORD_RE)) {
    if (out.length >= MAX_EXTRACTED_LOCATIONS) break;
    const path = stripEdgePunctuation(match[1]!);
    if (!looksLikeFilePath(path)) continue;
    reserved.add(path);
    push(`${path}:${match[2]}`);
  }
  // Colon form: whitespace-delimited tokens, cut at every interior colon so
  // a trailing sentence period or a URL fragment never hides a valid ref
  // (`src/a.ts:12.` → `src/a.ts:12` + `.`; `http://h/x.ts:80` → a URL the
  // parser refuses). A colon-free token IS the file-level canonical form
  // (`README.md`) and goes to the parser as-is; the discovery heuristic
  // (extension dot, non-relative) keeps ordinary prose words out.
  for (const raw of input.split(/\s+/)) {
    if (out.length >= MAX_EXTRACTED_LOCATIONS) break;
    const token = stripEdgePunctuation(raw);
    if (token === "" || token.length > 1024 || hasControlBytes(token)) continue;
    const parts = token.split(":");
    let path = parts[0]!;
    for (let i = 1; i < parts.length; i += 1) {
      // Try the full ref first; the path prefix only becomes a file-level
      // candidate when no full ref from this token named a location (so
      // `README.md:12` yields ONE citation, not line 1 AND line 12, while
      // `README.md:12x` still falls back to the file-level form).
      const before = out.length;
      push(`${path}:${parts[i]}`);
      if (out.length > before) {
        path = `${path}:${parts[i]}`;
      } else if (parseCitationLocation(`${path}:${parts[i]}`) === null && parseCitationLocation(path) !== null) {
        push(path);
      }
      if (out.length >= MAX_EXTRACTED_LOCATIONS) break;
    }
    if (parts.length === 1 && !reserved.has(path)) push(path);
  }
  return out;
}
