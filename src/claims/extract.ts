/** Deterministic claim extraction (#785, sentence units per #898): a PR often
 * states its own invariants — "every caller", "byte-identical", "never
 * widens", "only operator-configurable" — either in prose (the PR body) or in
 * a docstring/comment the diff adds or changes. A review that reads the diff
 * line by line can approve a change that breaks one of those promises
 * somewhere the diff never touches. This module finds such claims WITHOUT a
 * model call:
 *
 * - **Docstring/comment claims**: a run of added comment lines (one block) is
 *   joined, stripped of its comment markers, and split into sentences; each
 *   sentence using an assertion verb or quantifier ("only", "never",
 *   "always", "must", "validates", "cross-checked", "byte-identical", ...)
 *   becomes one whole-sentence claim, anchored to the exact `file:symbol`
 *   (or `file:line` when no enclosing symbol is found) the comment sits
 *   above/inside — never a whole file or module. Whole sentences, not lines:
 *   per-line extraction cut docstring prose mid-sentence into fragment
 *   "claims" (#898).
 * - **PR-body claims**: sentences in the PR description that use the same
 *   quantifier/assertion vocabulary, with bot-authored template text
 *   (Renovate/Dependabot footers) skipped. Body claims always outrank
 *   diff-comment claims — they are the PR's headline invariants, and the
 *   pre-#898 ranking let a docs-heavy diff crowd them out of `MAX_CLAIMS`
 *   entirely.
 *
 * Both sources resolve **items** — the concrete units a claim quantifies
 * over — from the diff: every inline `` `identifier` `` the sentence names,
 * plus flag-like tokens (kebab/snake/camel compounds such as
 * `repo-configurable`) from the sentence and, for a comment claim, from the
 * declaration line the comment documents. Each match's added-line anchor is
 * enumerated, capped at `MAX_ITEMS_PER_CLAIM` with a visible truncation flag:
 * a claim quantifying over "every input carrying the flag" ships the list of
 * flagged inputs, which is where a counterexample lives (#898).
 *
 * Bounded and pure: no network, no model call, never throws. `extractClaims`
 * always returns a (possibly empty) artifact; the caller runs the bounded
 * model pass as an augment on top of it — the scan is never treated as proof
 * that the body was fully captured (#898 review). */

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
  /\b(only|never|always|must|validat(?:es?|ion)|cross[- ]check(?:ed|s)?|fails?[- ]closed|bound to|byte[- ]identical|identical|guarantees?|ensures?|invariant|cannot|no longer|at most|exactly|every|each|all (?:consumers|callers|call sites)|parity|unchanged|backward[- ]compatible)\b/i;

const COMMENT_LINE_RE = /^(\/\/|\/\*\*?|\*(?!\/)|#(?!!)|"""|'''|--(?:\s|$)|<!--)/;

/** Bot-authored PR-body boilerplate (Renovate/Dependabot footers and
 * checklists): workflow notices, not the PR's own invariants. Matched per
 * sentence, before the keyword filter. Kept tight on purpose — the match
 * must be a bot signature (bot name, the rebase/retry checkbox), never a
 * subject a human legitimately writes policy about: an automerge rule like
 * "Automerge must never run for major-version updates" is a real claim and
 * survives (#898 review). The bot footers' own automerge lines carry no
 * keyword vocabulary, so they were never claims to begin with. */
const BOT_TEMPLATE_RE =
  /\b(?:renovate|dependabot|greenkeeper)\b|rebase[/-]retry|rebase-check/i;

/** HTML comments carry bot anchors (`<!-- rebase-check -->`,
 * `<!--renovate-debug:...-->`) and are never claim prose. The second pattern
 * drops an unterminated `<!--` and everything after it: a hostile body cannot
 * be trusted to close a fence it opened, and failing toward fewer claims is
 * safe. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HTML_COMMENT_UNTERMINATED_RE = /<!--[\s\S]*$/;

// The method alternative (5th capture) recognizes ordinary TS class-body
// methods/accessors (`render(): string {`, `private static async
// load(): Promise<string> {`) conservatively: the line must end with the
// opening brace, params may nest parens once but contain no string quotes
// (so `it("...", () => {` is never a declaration), and the name is never a
// control keyword (so `if (cond) {` is not one either). Java/C#-style
// `public String render()` (type before name) and Allman braces are
// deliberately not recognized.
const FUNCTION_SIGNATURE_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?def\s+([A-Za-z_][\w]*)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]|class\s+([A-Za-z_$][\w$]*)|(?:(?:public|private|protected|static|override|readonly|async|get|set)\s+)*(?:\*)?\s*(?!(?:if|for|while|switch|catch|do|else|try|return|await|yield|new|delete|typeof|case|throw|function|class|const|let|var|export|import|default|extends|implements|interface|type|enum|namespace)\b)([A-Za-z_$][\w$]*)\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\s*\((?:[^()"'`]|\([^()]*\))*\)\s*(?::\s*[^={}]+)?\{\s*$)/;

/** Markdown bullet starts are claim-unit boundaries in PR bodies: a bullet
 * whose prose has no terminal punctuation otherwise swallows the next bullet
 * into one run-on "sentence". A bullet start splits regardless of the
 * preceding punctuation; a sentence-internal `* ` or `- ` (wrapped prose,
 * multiplication) never splits because the preceding character is not a
 * terminator. */
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z(`]|[-*+]\s)|\n{2,}|\n[ \t]*(?=[-*+][ \t])/;
const INLINE_CODE_RE = /`([^`\n]{1,200})`/g;

/** Kebab/snake flag-like tokens (`repo-configurable`,
 * `allow_repo_policy_overrides`) and camelCase compounds (`repoConfigurable`,
 * `SpecialistCorpusWorkspace`): the shapes flags, inputs, and identifiers
 * take in diffs. Each becomes a case/separator-insensitive search over added
 * lines, so a claim quantifying over "every input carrying the flag"
 * enumerates the flagged lines. */
const FLAG_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g;
const CAMEL_TOKEN_RE = /\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A token's variant pattern: word parts (split on `-`/`_`/camel humps)
 * joined by an optional single `-` or `_`, case-insensitive — so
 * `repo-configurable`, `repo_configurable`, and `repoConfigurable` all match
 * one another's lines. `null` when the token does not split into at least
 * two parts (plain words are not flags). */
function tokenVariantRe(token: string): RegExp | null {
  const parts = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_\s]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
  if (parts.length < 2) return null;
  return new RegExp(`\\b${parts.map(escapeRegExp).join("[-_]?")}`, "i");
}

/** Flag-like tokens in free text: kebab/snake compounds and camelCase
 * compounds, deduplicated. Paths (containing `/`) never qualify — they are
 * handled as inline-code identifiers. */
function extractFlagTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(FLAG_TOKEN_RE)) tokens.push(match[0]);
  for (const match of text.matchAll(CAMEL_TOKEN_RE)) tokens.push(match[0]);
  return [...new Set(tokens)];
}

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

/** A call-shaped line: an ordinary TS method-modifier prefix (`public
 * render(`, `private static load(`) or a bare name followed by `(`, name not
 * a control keyword. This is the first construct directly following a
 * leading comment: a recognized declaration wins first, and this shape only
 * decides the unrecognized fallback — modifier-prefixed multi-line
 * signatures must fall back to the line anchor too, or the backward scan
 * credits the enclosing class for exactly the syntax the single-line
 * recognizer deliberately does not parse. */
const CALL_SHAPED_LINE_RE =
  /^(?:(?:public|private|protected|static|override|readonly|async|get|set)\s+)*(?!(?:if|for|while|switch|catch|do|else|try|return|await|yield|new|delete|typeof|case|throw|function|class|const|let|var|export|import|default)\b)[A-Za-z_$][\w$]*\s*\(/;

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
  if (sig) return sig[1] ?? sig[2] ?? sig[3] ?? sig[4] ?? sig[5] ?? null;
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
    return sig ? (sig[1] ?? sig[2] ?? sig[3] ?? sig[4] ?? sig[5] ?? null) : null;
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
 *    diff context window), but git's heuristic still names it. `fromHeader`
 *    marks this case: the attribution is git's guess, good enough for a
 *    claim's own anchor but never for enumerating sibling items (#898 —
 *    a class header must not steal an item anchor from the method the
 *    sibling line actually belongs to).
 * 4. Otherwise `null`: the caller falls back to a plain `file:L<n>` anchor.
 *
 * Never looks outside `hunk.lines` — a declaration added in a later hunk of
 * the same file is invisible here. */
function resolveHunkSymbol(hunk: HunkGroup, index: number): { symbol: string | null; fromHeader: boolean } {
  const line = hunk.lines[index]!;
  // A declaration line is its own anchor (e.g. a PR-body identifier match on
  // the signature line itself, not just on lines inside its body).
  if (line.declares) return { symbol: line.declares, fromHeader: false };
  if (isBlankOrComment(line.text)) {
    for (let k = index + 1; k < hunk.lines.length; k++) {
      const next = hunk.lines[k]!;
      if (next.declares) return { symbol: next.declares, fromHeader: false };
      if (!isBlankOrComment(next.text)) {
        // The comment's directly-following construct is call-shaped but not
        // a recognized declaration (e.g. a multi-line signature the
        // conservative recognizer deliberately does not know): the comment
        // describes THAT construct, so fall back to the line anchor rather
        // than confidently crediting an enclosing class found further up
        // the hunk.
        if (CALL_SHAPED_LINE_RE.test(next.text.trimStart())) return { symbol: null, fromHeader: false };
        break;
      }
    }
  }
  for (let k = index - 1; k >= 0; k--) {
    if (hunk.lines[k]!.declares) return { symbol: hunk.lines[k]!.declares, fromHeader: false };
  }
  return { symbol: hunk.headerSymbol, fromHeader: true };
}

/** Flatten every hunk's ADDED lines (only) into the shape the claim
 * extractors consume, each resolved to its hunk-scoped enclosing symbol. */
function walkAddedLines(diffText: string): Array<DiffLine & { symbol: string | null; symbolFromHeader: boolean }> {
  const out: Array<DiffLine & { symbol: string | null; symbolFromHeader: boolean }> = [];
  for (const hunk of collectHunks(diffText)) {
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i]!;
      if (!line.isAdded) continue;
      const resolved = resolveHunkSymbol(hunk, i);
      out.push({ path: hunk.path, newLine: line.newLine, text: line.text, symbol: resolved.symbol, symbolFromHeader: resolved.fromHeader });
    }
  }
  return out;
}

/** Strip one comment line's markers (`//`, `/**`/` * `/` * /`, `#`, docstring
 * quotes, HTML comments incl. the `--!>` close some parsers accept), leaving
 * the prose for sentence splitting. */
function stripCommentMarkers(trimmed: string): string {
  return trimmed
    .replace(/^(\/\/|\/\*\*?|\*\/?|#|"""|'''|--|<!--)\s?/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/"{3}\s*$/, "")
    .replace(/'{3}\s*$/, "")
    .replace(/--!?>\s*$/, "")
    .trim();
}

/** A maximal run of ADDED comment-shaped (or blank) lines inside one hunk:
 * one docstring or comment block. A context line, a removed line, or any
 * non-comment added line ends the block — a claim unit never reaches across
 * a hunk boundary or into surrounding code. */
interface CommentBlock {
  path: string;
  /** Hunk-local index of the block's first line, for `resolveHunkSymbol`. */
  startIndex: number;
  /** New-file line range of the block (contiguous: only added lines, no
   * context in between), used to keep a claim's own comment lines out of its
   * sibling-item enumeration. */
  firstNewLine: number;
  lastNewLine: number;
  /** Comment-marker-stripped prose of every line in the block, joined. */
  text: string;
}

function collectCommentBlocks(hunk: HunkGroup): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let current: CommentBlock | null = null;
  let prose: string[] = [];
  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i]!;
    const trimmed = line.text.trim();
    const isComment = trimmed !== "" && COMMENT_LINE_RE.test(trimmed);
    if (!line.isAdded || (!isComment && trimmed !== "")) {
      current = null;
      prose = [];
      continue;
    }
    if (isComment) {
      if (!current) {
        current = { path: hunk.path, startIndex: i, firstNewLine: line.newLine, lastNewLine: line.newLine, text: "" };
        blocks.push(current);
        prose = [];
      }
    } else if (!current) {
      // A blank added line before any comment starts nothing.
      continue;
    }
    current.lastNewLine = line.newLine;
    const stripped = trimmed === "" ? "" : stripCommentMarkers(trimmed);
    if (stripped) prose.push(stripped);
    current.text = prose.join(" ");
  }
  return blocks.filter((block) => block.text.trim() !== "");
}

/** The first non-comment, non-blank line at or after `fromIndex` within the
 * hunk: the construct a comment block documents. Its flag-like tokens
 * (`readonly "repo-configurable"?: boolean;` → `repo-configurable`) are what
 * a quantified claim over "every input carrying the flag" resolves against. */
function documentedLineText(hunk: HunkGroup, fromIndex: number): string {
  for (let k = fromIndex; k < hunk.lines.length; k++) {
    const line = hunk.lines[k]!;
    const trimmed = line.text.trim();
    if (trimmed === "" || isBlankOrComment(trimmed)) continue;
    return line.text;
  }
  return "";
}

/** Items shared by both extractors: anchors of every added line matching a
 * backtick identifier (substring, the pre-#898 semantics) or a flag-like
 * token (case/separator-insensitive variant). A line whose only symbol is
 * git's hunk-header guess still yields its occurrence — the guess is
 * distrusted (the anchor degrades to a plain `file:L<n>`) but the match is
 * never thrown away, or a normal existing-function diff (signature in the
 * hunk header, changed line in the body) would lose exactly the item a body
 * claim is about (#898 review). Capped at `MAX_ITEMS_PER_CLAIM` with
 * `itemsTruncated` — a visibly capped list is the honest shape for a claim
 * quantifying over more units than fit. */
function resolveItems(
  identifiers: string[],
  tokens: string[],
  addedLines: Array<DiffLine & { symbol: string | null; symbolFromHeader: boolean }>,
): { items: string[]; itemsTruncated: boolean } {
  const items: string[] = [];
  let itemsTruncated = false;
  const pushAnchor = (line: DiffLine & { symbol: string | null }): void => {
    const anchor = `${line.path}:${line.symbol ?? `L${line.newLine}`}`;
    if (items.includes(anchor)) return;
    if (items.length >= MAX_ITEMS_PER_CLAIM) {
      itemsTruncated = true;
      return;
    }
    items.push(clip(anchor, MAX_ITEM_CHARS));
  };
  const variantRes = tokens
    .map((token) => tokenVariantRe(token))
    .filter((re): re is RegExp => re !== null);
  for (const line of addedLines) {
    const matches =
      identifiers.some((identifier) => line.text.includes(identifier)) ||
      variantRes.some((re) => re.test(line.text));
    if (!matches) continue;
    pushAnchor(line.symbolFromHeader ? { ...line, symbol: null } : line);
  }
  return { items, itemsTruncated };
}

/** Docstring/comment claims: each maximal added comment block is split into
 * sentences; every sentence using an assertion verb or quantifier becomes a
 * whole-sentence claim anchored at `path:symbol` (or `path:line` with no
 * enclosing symbol). The same sentence in two blocks (copy-pasted docstrings)
 * merges into one claim listing both anchors. */
function extractDiffCommentClaims(diffText: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Map<string, Claim>();
  const addedLines = walkAddedLines(diffText);
  for (const hunk of collectHunks(diffText)) {
    for (const block of collectCommentBlocks(hunk)) {
      const resolved = resolveHunkSymbol(hunk, block.startIndex);
      const symbol = resolved.symbol;
      const anchor = `${block.path}:${symbol ?? `L${block.firstNewLine}`}`;
      const tokens = extractFlagTokens(`${block.text} ${documentedLineText(hunk, block.startIndex)}`);
      // The claim's own comment lines are the claim, not items it quantifies
      // over — the block anchor already covers them; only other lines are
      // enumerated as siblings.
      const siblings = addedLines.filter(
        (line) => !(line.path === block.path && line.newLine >= block.firstNewLine && line.newLine <= block.lastNewLine),
      );
      for (const sentence of splitSentences(block.text)) {
        if (!CLAIM_KEYWORDS_RE.test(sentence)) continue;
        const text = clip(sentence, MAX_CLAIM_CHARS);
        const key = text.toLowerCase();
        const { items, itemsTruncated: resolvedTruncated } = resolveItems([], tokens, siblings);
        let itemsTruncated = resolvedTruncated;
        if (!items.includes(anchor)) {
          if (items.length >= MAX_ITEMS_PER_CLAIM) itemsTruncated = true;
          else items.unshift(anchor);
        }
        let claim = seen.get(key);
        if (!claim) {
          claim = {
            claim: text,
            source: "diff",
            scope: clip(symbol ? `${block.path}:${symbol}` : block.path, MAX_SCOPE_CHARS),
            items,
            itemsTruncated,
            check: clip(`Read ${anchor} and try to construct an input that violates the claim; then check whether sibling code paths enforce the same thing.`, MAX_CHECK_CHARS),
          };
          seen.set(key, claim);
          claims.push(claim);
        } else {
          for (const item of items) {
            if (claim.items.includes(item)) continue;
            if (claim.items.length >= MAX_ITEMS_PER_CLAIM) {
              claim.itemsTruncated = true;
              break;
            }
            claim.items.push(item);
          }
          claim.itemsTruncated = claim.itemsTruncated || itemsTruncated;
        }
      }
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
 * bot-authored template text (Renovate/Dependabot footers) removed first.
 * Items resolve from every added-line diff occurrence of each backtick
 * identifier or flag-like token the sentence names (falls back to no items
 * when none appear in the diff — the render step then tells the reviewer to
 * enumerate items themselves). */
function extractPrBodyClaims(body: string, diffText: string): Claim[] {
  const strippedBody = body
    .replace(HTML_COMMENT_RE, " ")
    .replace(HTML_COMMENT_UNTERMINATED_RE, " ");
  if (!strippedBody.trim()) return [];
  const addedLines = [...walkAddedLines(diffText)];
  const claims: Claim[] = [];
  for (const sentence of splitSentences(strippedBody)) {
    if (BOT_TEMPLATE_RE.test(sentence)) continue;
    if (!CLAIM_KEYWORDS_RE.test(sentence)) continue;
    const identifiers = [...sentence.matchAll(INLINE_CODE_RE)].map((m) => m[1]!).filter(Boolean);
    const tokens = extractFlagTokens(sentence);
    const { items, itemsTruncated } = resolveItems(identifiers, tokens, addedLines);
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

/** Deterministic claim extraction over the PR body and diff. PR-body claims
 * rank first — they are the PR's headline invariants, and a docs-heavy diff
 * must never crowd them out of `MAX_CLAIMS` (#898) — body claims that
 * resolved at least one concrete item before body claims with none, then the
 * diff-comment claims. Bounded to `MAX_CLAIMS`/`MAX_ITEMS_PER_CLAIM`; never
 * throws. */
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
  const ordered = [...withItems, ...withoutItems, ...commentClaims];

  const truncated = ordered.length > MAX_CLAIMS || ordered.some((c) => c.itemsTruncated);
  return {
    version: 1,
    claims: ordered.slice(0, MAX_CLAIMS),
    truncated,
    errors,
    method: ordered.length > 0 ? "deterministic" : "none",
  };
}
