/** Deterministic claim extraction (#785): a PR often states its own
 * invariants — "every caller", "byte-identical", "never widens", "only
 * operator-configurable" — either in prose (the PR body) or in a docstring/
 * comment the diff adds or changes. A review that reads the diff line by
 * line can approve a change that breaks one of those promises somewhere the
 * diff never touches. This module finds such claims WITHOUT a model call:
 *
 * - **Docstring/comment claims**: added comment lines in the diff that use
 *   an assertion verb or quantifier ("only", "never", "always", "must",
 *   "validates", "cross-checked", "byte-identical", ...), anchored to the
 *   exact `file:symbol` (or `file:line` when no enclosing symbol is found)
 *   the comment sits above/inside — never a whole file or module.
 * - **PR-body claims**: sentences in the PR description that use the same
 *   quantifier/assertion vocabulary. Each inline `` `identifier` `` the
 *   sentence names is resolved to every added-line occurrence of that
 *   identifier in the diff, so a claim like "cross-checked against
 *   `ctx.repoDid`" comes with the concrete call sites to check — including
 *   sibling code paths the sentence itself never mentions.
 *
 * Bounded and pure: no network, no model call, never throws. `extractClaims`
 * always returns a (possibly empty) artifact; the caller decides whether an
 * empty deterministic result should fall back to the bounded model pass. */

import {
  MAX_CHECK_CHARS,
  MAX_CLAIMS,
  MAX_CLAIM_CHARS,
  MAX_ITEMS_PER_CLAIM,
  MAX_ITEM_CHARS,
  MAX_SCOPE_CHARS,
  type Claim,
  type ClaimsArtifact,
} from "./types.js";

const CLAIM_KEYWORDS_RE =
  /\b(only|never|always|must|validat(?:es?|ion)|cross[- ]check(?:ed|s)?|fails?[- ]closed|bound to|byte[- ]identical|identical|guarantees?|ensures?|invariant|cannot|no longer|at most|exactly|every|each|all consumers|parity|unchanged|backward[- ]compatible)\b/i;

const COMMENT_LINE_RE = /^(\/\/|\/\*\*?|\*(?!\/)|#(?!!)|"""|'''|--(?:\s|$)|<!--)/;

const FUNCTION_SIGNATURE_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?def\s+([A-Za-z_][\w]*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]|class\s+([A-Za-z_$][\w$]*))/;

const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z(`])|\n{2,}/;
const INLINE_CODE_RE = /`([^`\n]{1,200})`/g;

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

interface DiffLine {
  path: string;
  newLine: number;
  text: string;
}

interface HunkLineEntry {
  newLine: number;
  text: string;
  isAdded: boolean;
  /** Symbol this line itself declares (`function foo`, `def foo`, ...), when
   * it is a signature line (context or added); `null` otherwise. */
  declares: string | null;
}

interface HunkGroup {
  path: string;
  /** The enclosing symbol git's own hunk-header heuristic reports after the
   * second `@@` (e.g. `@@ -10,6 +10,7 @@ function existingA() {`), or `null`
   * when git printed no context or none of it looks like a declaration. */
  headerSymbol: string | null;
  /** Context + added lines only, in original order, hunk-local (a removed
   * line carries no new-file position and is never a candidate anchor). */
  lines: HunkLineEntry[];
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@[ \t]?(.*)$/;
const HUNK_HEADER_CALL_RE = /([A-Za-z_$][\w$]*)\s*\(/g;
const HUNK_HEADER_TYPE_RE = /\b(?:class|struct|interface|impl|enum|namespace|module|trait)\s+([A-Za-z_$][\w$]*)/;

/** Best-effort symbol from git's hunk-header context text. Prefers a full
 * signature match (git often prints the exact signature line minus its
 * trailing brace), then a type/class-like declaration, then the last
 * `name(` call-shaped token in the context, so callers get *a* concrete
 * enclosing symbol wherever git's own heuristic found one. */
function hunkHeaderSymbol(context: string): string | null {
  const trimmed = context.trim();
  if (!trimmed) return null;
  const sig = FUNCTION_SIGNATURE_RE.exec(trimmed);
  if (sig) return sig[1] ?? sig[2] ?? sig[3] ?? sig[4] ?? null;
  const typeMatch = HUNK_HEADER_TYPE_RE.exec(trimmed);
  if (typeMatch) return typeMatch[1] ?? null;
  const calls = [...trimmed.matchAll(HUNK_HEADER_CALL_RE)];
  if (calls.length > 0) return calls[calls.length - 1]![1] ?? null;
  return null;
}

/** Walk a unified diff into per-hunk groups, each carrying its own header
 * symbol and its own context/added lines — hunk boundaries are never
 * crossed downstream, so a claim can only be anchored to a declaration git
 * itself associates with that exact hunk (an explicit line inside it, or
 * git's own funcname heuristic), never to an unrelated declaration added in
 * a later hunk of the same file. */
function collectHunks(diffText: string): HunkGroup[] {
  const hunks: HunkGroup[] = [];
  let path = "";
  let newLine = 0;
  let current: HunkGroup | null = null;

  const declaresOf = (text: string): string | null => {
    const sig = FUNCTION_SIGNATURE_RE.exec(text.trimStart());
    return sig ? (sig[1] ?? sig[2] ?? sig[3] ?? sig[4] ?? null) : null;
  };

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(raw);
      path = match ? match[1]! : "";
      current = null;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const candidate = raw.slice(4).replace(/^b\//, "");
      if (candidate !== "/dev/null") path = candidate;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("index ") || raw.startsWith("similarity index")) continue;
    const hunk = HUNK_HEADER_RE.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      current = { path, headerSymbol: hunkHeaderSymbol(hunk[2] ?? ""), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue; // no hunk opened yet for this file
    if (raw.startsWith("+")) {
      const text = raw.slice(1);
      current.lines.push({ newLine, text, isAdded: true, declares: declaresOf(text) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) continue; // removed line: no new-file line number
    if (raw.startsWith(" ")) {
      const text = raw.slice(1);
      current.lines.push({ newLine, text, isAdded: false, declares: declaresOf(text) });
      newLine += 1;
    }
  }
  return hunks;
}

function isBlankOrComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || COMMENT_LINE_RE.test(trimmed) || /^\*\/?/.test(trimmed);
}

/** Resolve one hunk-local line's enclosing symbol, hunk-scoped only:
 *
 * 1. A leading comment/docstring immediately (no non-comment/blank line in
 *    between) followed by a declaration further down THIS hunk binds to
 *    that declaration — the strongest, most local signal (a docstring
 *    always describes the thing directly under it, even inside a class/
 *    namespace the hunk header would otherwise attribute it to).
 * 2. Otherwise, the nearest declaration line (context or added) ABOVE this
 *    line within the same hunk.
 * 3. Otherwise, git's own hunk-header function context — the declaration
 *    isn't visible in the hunk body at all (the signature sits outside the
 *    diff context window), but git's heuristic still names it.
 * 4. Otherwise `null`: the caller falls back to a plain `file:L<n>` anchor.
 *
 * Never looks outside `hunk.lines` — a declaration added in a later hunk of
 * the same file is invisible here. */
function resolveHunkSymbol(hunk: HunkGroup, index: number): string | null {
  const line = hunk.lines[index]!;
  // A declaration line is its own anchor (e.g. a PR-body identifier match on
  // the signature line itself, not just on lines inside its body).
  if (line.declares) return line.declares;
  if (isBlankOrComment(line.text)) {
    for (let k = index + 1; k < hunk.lines.length; k++) {
      const next = hunk.lines[k]!;
      if (next.declares) return next.declares;
      if (!isBlankOrComment(next.text)) break;
    }
  }
  for (let k = index - 1; k >= 0; k--) {
    if (hunk.lines[k]!.declares) return hunk.lines[k]!.declares;
  }
  return hunk.headerSymbol;
}

/** Flatten every hunk's ADDED lines (only) into the shape the claim
 * extractors consume, each resolved to its hunk-scoped enclosing symbol. */
function walkAddedLines(diffText: string): Array<DiffLine & { symbol: string | null }> {
  const out: Array<DiffLine & { symbol: string | null }> = [];
  for (const hunk of collectHunks(diffText)) {
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i]!;
      if (!line.isAdded) continue;
      out.push({ path: hunk.path, newLine: line.newLine, text: line.text, symbol: resolveHunkSymbol(hunk, i) });
    }
  }
  return out;
}

/** Docstring/comment claims: added comment-shaped lines that use an
 * assertion verb or quantifier, anchored at `path:symbol` (or `path:line`
 * with no enclosing symbol). Adjacent matching comment lines in the same
 * file collapse into one claim with one item per anchor (a multi-line
 * docstring commonly repeats the same assertion across lines). */
function extractDiffCommentClaims(diffText: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Map<string, Claim>();
  for (const line of walkAddedLines(diffText)) {
    const trimmed = line.text.trim();
    if (!COMMENT_LINE_RE.test(trimmed)) continue;
    // HTML comment terminators: both `-->` and the `--!>` form some HTML
    // parsers also accept as a valid comment close (CodeQL: incomplete
    // multi-character sanitization).
    const stripped = trimmed.replace(/^(\/\/|\/\*\*?|\*\/?|#|"""|'''|--|<!--)\s?/, "").replace(/\*\/\s*$/, "").replace(/--!?>\s*$/, "").trim();
    if (!stripped || !CLAIM_KEYWORDS_RE.test(stripped)) continue;
    const anchor = `${line.path}:${line.symbol ?? `L${line.newLine}`}`;
    const key = clip(stripped, MAX_CLAIM_CHARS).toLowerCase();
    let claim = seen.get(key);
    if (!claim) {
      claim = {
        claim: clip(stripped, MAX_CLAIM_CHARS),
        source: "diff",
        scope: clip(line.symbol ? `${line.path}:${line.symbol}` : line.path, MAX_SCOPE_CHARS),
        items: [],
        itemsTruncated: false,
        check: clip(`Read ${anchor} and try to construct an input that violates the claim; then check whether sibling code paths enforce the same thing.`, MAX_CHECK_CHARS),
      };
      seen.set(key, claim);
      claims.push(claim);
    }
    if (!claim.items.includes(anchor)) {
      if (claim.items.length >= MAX_ITEMS_PER_CLAIM) claim.itemsTruncated = true;
      else claim.items.push(clip(anchor, MAX_ITEM_CHARS));
    }
  }
  return claims;
}

function splitSentences(body: string): string[] {
  return body
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** PR-body claims: sentences using the assertion/quantifier vocabulary, with
 * items resolved from every added-line diff occurrence of each backtick
 * identifier the sentence names (falls back to no items when the sentence
 * names none, or none appear in the diff — the render step then tells the
 * reviewer to enumerate items themselves). */
function extractPrBodyClaims(body: string, diffText: string): Claim[] {
  if (!body.trim()) return [];
  const addedLines = [...walkAddedLines(diffText)];
  const claims: Claim[] = [];
  for (const sentence of splitSentences(body)) {
    if (!CLAIM_KEYWORDS_RE.test(sentence)) continue;
    const identifiers = [...sentence.matchAll(INLINE_CODE_RE)].map((m) => m[1]!).filter(Boolean);
    const items: string[] = [];
    let itemsTruncated = false;
    for (const identifier of identifiers) {
      for (const line of addedLines) {
        if (!line.text.includes(identifier)) continue;
        const anchor = `${line.path}:${line.symbol ?? `L${line.newLine}`}`;
        if (items.includes(anchor)) continue;
        if (items.length >= MAX_ITEMS_PER_CLAIM) {
          itemsTruncated = true;
          break;
        }
        items.push(clip(anchor, MAX_ITEM_CHARS));
      }
    }
    claims.push({
      claim: clip(sentence, MAX_CLAIM_CHARS),
      source: "pr_body",
      scope: clip(identifiers.join(", ") || "the PR's stated invariant", MAX_SCOPE_CHARS),
      items,
      itemsTruncated,
      check: clip(
        identifiers.length > 0
          ? `Check every listed call site of ${identifiers.join(", ")} for this claim, then look for sibling call sites the list missed.`
          : "Identify the concrete code this sentence describes and check it holds; look for sibling code paths that should hold the same invariant.",
        MAX_CHECK_CHARS,
      ),
    });
  }
  return claims;
}

/** Deterministic claim extraction over the PR body and diff. Comment/
 * docstring claims (each already anchored to a concrete function or line)
 * are ranked first — they carry the strongest evidence of a checkable
 * claim — followed by PR-body claims that resolved at least one concrete
 * item, then PR-body claims with no resolved item. Bounded to
 * `MAX_CLAIMS`/`MAX_ITEMS_PER_CLAIM`; never throws. */
export function extractClaimsDeterministic(input: { prBody: string; diffText: string }): ClaimsArtifact {
  const errors: string[] = [];
  let commentClaims: Claim[] = [];
  let bodyClaims: Claim[] = [];
  try {
    commentClaims = extractDiffCommentClaims(input.diffText ?? "");
  } catch (cause) {
    errors.push(`diff comment scan failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  try {
    bodyClaims = extractPrBodyClaims(input.prBody ?? "", input.diffText ?? "");
  } catch (cause) {
    errors.push(`PR body scan failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const withItems = bodyClaims.filter((c) => c.items.length > 0);
  const withoutItems = bodyClaims.filter((c) => c.items.length === 0);
  const ordered = [...commentClaims, ...withItems, ...withoutItems];

  const truncated = ordered.length > MAX_CLAIMS || ordered.some((c) => c.itemsTruncated);
  return {
    version: 1,
    claims: ordered.slice(0, MAX_CLAIMS),
    truncated,
    errors,
    method: ordered.length > 0 ? "deterministic" : "none",
  };
}
