/** Deterministic risk-evidence obligation scan (#1577).
 *
 * Over the COMPLETE unified diff of the pull request, the scan raises one
 * evidence obligation per risk category whose trigger surface the CHANGED
 * code itself touches:
 *
 * - `file_identity_mode`   — file identity/path-mode handling. The first
 *   target case: `git ls-tree` blob proofs cannot distinguish regular-file
 *   mode 100644/100755 from symlink mode 120000, so changes that parse tree
 *   entries or compare/handle file modes must be met with the symlink
 *   counterexample.
 * - `bounded_state`        — bounded counters and concurrent state.
 * - `persisted_state`      — code over data that already exists persisted.
 * - `credential_boundary`  — credential handling / trust boundaries.
 *
 * The #749 discipline applies with bounded string-awareness: only the
 * changed (+/-) lines of files whose extension is in the closed CODE set
 * count (an unknown extension is NOT scanned at all — a deliberate coverage
 * bound, not a blind spot inside a scanned file), whole-line and
 * whitespace-preceded trailing comments are blanked (line comments AND the
 * C-style block comments the `//` languages and SQL carry: a whole-line
 * `/* ... *\/` opener/continuation/closer is comment-only and a closed
 * whitespace-preceded span is removed while the code after it still scans),
 * and a real mode/typechange header (`old mode 100644` → `new mode 120000`)
 * is itself a trigger. Block comments carry state ACROSS the chunk's lines,
 * tracked per file version (a context line advances both): a line inside a
 * still-open multi-line block comment is comment-only even when it carries
 * risk vocabulary, while code before/after delimiters on the same line
 * still scans. The residues are deliberately asymmetric: a quoted comment
 * marker can cut a line early (missing a fire), a multiplication
 * continuation line (`* height`) is blanked like a JSDoc line (missing a
 * fire), and a block still open where the diff window ends can hold the
 * state open across the chunk's remaining lines (missing a fire), because
 * a false obligation costs one disposition while a false silence costs
 * trust — EXCEPT where the comment shape is unambiguous, which is exactly
 * where the scan must not fire (a comment-only diff must never raise a
 * mandatory obligation). The scan is pure, deterministic, and never throws.
 *
 * The mode digits are the one vocabulary where the bare token would be
 * noise: `120000` is also a plausible timeout in milliseconds or a byte
 * budget. A mode literal therefore needs mode vocabulary on the SAME line
 * (see FILE_MODE_CONTEXT), the same context discipline the other categories
 * use for "overflow" and "schema". */

import {
  MAX_PATH_CHARS,
  MAX_RISK_PATHS_PER_OBLIGATION,
  RISK_ARTIFACT_VERSION,
  RISK_CATEGORIES,
  RISK_OBLIGATION_TEXTS,
  type RiskCategory,
  type RiskObligationsArtifact,
  type RiskObligation,
} from "./types.js";

/** File extensions whose changed lines are scanned as code. Closed set;
 * anything else (docs, prose, data, generated lockfiles) is not code for
 * this scan — a documentation change about symlinks must not fire. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "go", "rb",
  "java", "kt", "kts", "cs", "php", "rs", "scala", "swift", "c", "h", "cpp",
  "cc", "hpp", "sh", "bash", "zsh", "sql", "yaml", "yml", "toml", "tf",
]);

/** Paths that are never risk-surface evidence, whatever they contain. */
const EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|go\.sum|uv\.lock|poetry\.lock|composer\.lock|gem\.lock)$/i,
  /(^|\/)(vendor|node_modules|dist|build\/generated)\//i,
  /\.min\.(js|css)$/i,
];

/** Per-language line-comment markers used to blank comment lines. Every
 * extension in CODE_EXTENSIONS has its markers; the empty fallback in
 * `stripLineComment` is defensive only — a file whose extension is not in
 * CODE_EXTENSIONS never reaches it (see the coverage bound in the module
 * header). */
const LINE_COMMENT_MARKERS: Readonly<Record<string, string[]>> = Object.freeze({
  ts: ["//"], tsx: ["//"], mts: ["//"], cts: ["//"], js: ["//"], jsx: ["//"],
  mjs: ["//"], cjs: ["//"], go: ["//"], java: ["//"], kt: ["//"], kts: ["//"],
  cs: ["//"], php: ["//"], rs: ["//"], scala: ["//"], swift: ["//"],
  c: ["//"], h: ["//"], cpp: ["//"], cc: ["//"], hpp: ["//"],
  py: ["#"], sh: ["#"], bash: ["#"], zsh: ["#"], yaml: ["#"], yml: ["#"], toml: ["#"], tf: ["#"],
  sql: ["--"], rb: ["#"],
});

/** The extensions whose changed lines can carry C-style block comments
 * (`/* ... *\/`): the `//`-marker family ships the block marker with the
 * line marker, and SQL carries block comments with `--` line comments.
 * Python/shell/YAML-family comments have no block form here (docstrings are
 * string literals, not comments) and keep the line-marker-only handling. */
const BLOCK_COMMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "java", "kt",
  "kts", "cs", "php", "rs", "scala", "swift", "c", "h", "cpp", "cc", "hpp",
  "sql",
]);

/** The git file-mode literals (symlink 120000, regular file 100644/100755).
 *  The digits on their own are ordinary constants: `120000` is also a
 *  plausible timeout in milliseconds or a byte budget, and such a constant
 *  says nothing about file identity. A literal therefore fires only next to
 *  mode vocabulary on the SAME line, the way the bounded-state and
 *  persisted-state categories require a counter context for "overflow" and a
 *  storage context for "schema".
 *
 *  The context is the word "mode" in any case spelling, with an optional
 *  plural "s" ADJACENT to it: "modes" is a context, while "models" is
 *  "mode"+"l"+"s" and never is. The character after the context must not
 *  be a LOWERCASE letter, so "model", "models" and "remodeling" are not
 *  contexts while "mode", "modes", "Mode", "MODE", "file_mode", "FILE_MODE"
 *  and "modeBits" are. The letters are spelled out in both cases on
 *  purpose: the `i` flag folds `[a-z]` to cover the uppercase letters too,
 *  and then "modeBits" would be rejected. */
const FILE_MODE_LITERAL = /\b(?:120000|100644|100755)\b/;
const FILE_MODE_CONTEXT = /(?:[mM][oO][dD][eE][sS]?)(?![a-z])/;

const FILE_IDENTITY_MODE_PATTERNS: readonly RegExp[] = [
  /\bls-tree\b/i,
  // The literal next to mode vocabulary, in either order.
  new RegExp(`${FILE_MODE_LITERAL.source}[^\\n]{0,40}${FILE_MODE_CONTEXT.source}`),
  new RegExp(`${FILE_MODE_CONTEXT.source}[^\\n]{0,40}${FILE_MODE_LITERAL.source}`),
  /\btypechange\b/i,
  /\bsymlinks?\b/i,
  /\bis[_-]?symlink\b/i,
  /\blstat\b/i,
  /\breadlink\b/i,
  /\bs_iflnk\b/i,
  /\bs_ifmt\b/i,
  /\bfilemode\b/i,
  /\bchmod\b/i,
  /\bchmodsync\b/i,
  /\bumask\b/i,
];

const BOUNDED_STATE_PATTERNS: readonly RegExp[] = [
  /\bmutex\b/i,
  /\brwlock\b/i,
  /\bsemaphore\b/i,
  /\bsynchronized\b/i,
  /\batomic\b/i,
  /\batomic[_-]?(?:add|increment|decrement|compare|swap|load|store)\b/i,
  /\bcompare[_-]and[_-]swap\b/i,
  /\block\(\s*\)/i,
  /\bunlock\(\s*\)/i,
  /\bdeadlock\b/i,
  // "overflow" alone fires on ordinary CSS-in-JS and style strings; the
  // bounded-state category means NUMERIC/counter overflow, so require the
  // state context on the same line.
  /\b(?:integer|int32|int64|counter|index|capacity|heap|stack|arithmetic|numeric|wrap[_-]?around)[\w-]*[^\n]{0,40}\boverflow\b/i,
  /\boverflow\b[^\n]{0,40}\b(?:integer|counter|index|capacity|wrap[_-]?around)\b/i,
  /\bgoroutine\b/i,
];

const PERSISTED_STATE_PATTERNS: readonly RegExp[] = [
  /\bmigrations?\b/i,
  // A bare "schema" is zod/JSON validation, not persisted state: require a
  // persistence context on the same line (table/column/db/migration/version).
  /\b(?:db|database|table|column|sql|sqlite3?|postgres(?:sql)?|mysql|migrat\w+)[^\n]{0,40}\bschema\b/i,
  /\bschema\b[^\n]{0,40}\b(?:db|database|table|column|sql|migration|version)\b/i,
  /\bsqlite3?\b/i,
  /\bleveldb\b/i,
  /\brocksdb\b/i,
  /\bpostgre(?:sql)?\b/i,
  /\bmysql\b/i,
  /\binsert into\b/i,
  /\bupdate\s+\w+\s+set\b/i,
  /\bdelete from\b/i,
  /\bcreate table\b/i,
  /\balter table\b/i,
  /\bdrop table\b/i,
  /\bupsert\b/i,
  /\bfsync\b/i,
  /\bwrite[- ]?ahead\b/i,
];

const CREDENTIAL_BOUNDARY_PATTERNS: readonly RegExp[] = [
  /\bapi[_-]?keys?\b/i,
  /\bx-api-key\b/i,
  /\bauthorization\b/i,
  /\bbearer\b/i,
  /\bpasswords?\b/i,
  /\bcredentials?\b/i,
  /\bsecrets?\b/i,
  /\baccess[_-]?tokens?\b/i,
  /\brefresh[_-]?tokens?\b/i,
  /\bclient[_-]?secrets?\b/i,
  /\bhmac\b/i,
];

const CATEGORY_PATTERNS: Readonly<Record<RiskCategory, readonly RegExp[]>> = Object.freeze({
  file_identity_mode: FILE_IDENTITY_MODE_PATTERNS,
  bounded_state: BOUNDED_STATE_PATTERNS,
  persisted_state: PERSISTED_STATE_PATTERNS,
  credential_boundary: CREDENTIAL_BOUNDARY_PATTERNS,
});

const DIFF_GIT_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_MODE_HEADER = /^old mode (\d{6})$/;
const NEW_MODE_HEADER = /^new mode (\d{6})$/;
const NEW_FILE_MODE_HEADER = /^new file mode (\d{6})$/;
/** Extended headers that are diff metadata, never changed content. */
const EXTENDED_HEADER = /^(?:index|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|deleted file mode|old mode|new mode|new file mode)\b/;

/** The extension of a repository path, lowercased ("" when none). */
function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function isScannableFile(path: string | null): boolean {
  if (path === null) return false;
  if (!CODE_EXTENSIONS.has(extensionOf(path))) return false;
  return !EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** The index of the language's first whitespace-preceded line-comment
 * marker in the line, or -1 (the #960 trailing-comment start). A marker at
 * index 0 has no preceding whitespace and is not a cut; a marker-start
 * line was blanked before this runs. */
function firstLineCommentStart(line: string, markers: readonly string[]): number {
  let cut = -1;
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const index = line.indexOf(marker, from);
      if (index <= 0) break;
      if (/\s/.test(line[index - 1]!)) {
        if (cut === -1 || index < cut) cut = index;
        break;
      }
      from = index + marker.length;
    }
  }
  return cut;
}

/** Remove the C-style block comments one changed line can carry, keeping
 * every byte of actual code (the #1577 review rule: the replacement must
 * not be token-blind — it must not drop code nor mishandle the changed
 * line), and report whether a block comment is still open at the line's
 * end (the cross-line state the #1637 review fix carries across the
 * chunk's lines):
 *
 * - `inBlock` true on entry: the line starts INSIDE a still-open block
 *   comment and is comment-only up to its first `*\/` (line-comment
 *   markers are comment text here, never line-comment starts); a missing
 *   closer keeps the whole line comment and the state open, a closer hands
 *   the code after it to the fresh-state shapes below;
 * - a line whose trimmed form starts with `/*` is comment-opener-shaped: a
 *   closer ON the line removes the closed span and the code after it still
 *   scans (`/* note *\/ const credentials = x;` fires), a missing closer
 *   means the comment continues on later lines and the whole line is
 *   comment (state stays open);
 * - a line whose trimmed form starts with `*\/` is comment-closer-shaped:
 *   the closer is removed and any code after it still scans;
 * - a JSDoc/Doxygen continuation line (`* ` with the star followed by
 *   whitespace, or a bare `*`) is all comment. A pointer dereference keeps
 *   its identifier glued to the star (`*out = 1;`) and is preserved — the
 *   star alone is never a token-blind eraser;
 * - mid-line, a whitespace-preceded opener starts a trailing comment: a
 *   closed span is removed (code on both sides survives) and an unclosed
 *   one comments out the rest of the line (state stays open). An opener
 *   that starts after the line's first whitespace-preceded line-comment
 *   marker sits inside that line comment and is never an opener — the
 *   state it would open is phantom and must not blank later lines.
 *
 * Code before/after delimiters on the same line always scans. */
function stripBlockComments(
  line: string,
  starContinuation: boolean,
  markers: readonly string[],
  inBlock: boolean,
): { code: string; inBlock: boolean } {
  if (inBlock) {
    const close = line.indexOf("*/");
    if (close === -1) return { code: "", inBlock: true };
    return stripBlockComments(line.slice(close + 2), starContinuation, markers, false);
  }
  const trimmed = line.trimStart();
  if (trimmed.startsWith("/*")) {
    const open = line.indexOf("/*");
    const close = line.indexOf("*/", open + 2);
    if (close === -1) return { code: "", inBlock: true };
    return stripBlockComments(line.slice(close + 2), starContinuation, markers, false);
  }
  if (trimmed.startsWith("*/")) {
    const open = line.indexOf("*/");
    return stripBlockComments(line.slice(open + 2), starContinuation, markers, false);
  }
  if (starContinuation && trimmed.startsWith("*") && (trimmed.length === 1 || /\s/.test(trimmed[1]!))) {
    return { code: "", inBlock: false };
  }
  let out = line;
  for (;;) {
    const open = out.search(/\s\/\*/);
    if (open === -1) return { code: out, inBlock: false };
    const bound = firstLineCommentStart(out, markers);
    if (bound !== -1 && open > bound) return { code: out, inBlock: false };
    const close = out.indexOf("*/", open + 3);
    if (close === -1) return { code: out.slice(0, open + 1), inBlock: true };
    out = out.slice(0, open + 1) + out.slice(close + 2);
  }
}

/** Drop the language's comments from a changed line and report the
 * block-comment state at the line's end: a line whose trimmed form STARTS
 * with a line-comment marker is blanked entirely (unless the line already
 * sits INSIDE a still-open block comment — there the markers are comment
 * text and only a `*\/` closer matters); block comments are stripped
 * shape-aware (see stripBlockComments) for the extensions that carry them;
 * and a trailing ` <marker> ...` run is cut (the #960 rule: a mention that
 * survives only inside a recognized comment never fires). Unknown
 * extensions keep their markers unmatched (the line scans whole). */
function stripLineComment(line: string, extension: string, inBlock: boolean): { code: string; inBlock: boolean } {
  const markers = LINE_COMMENT_MARKERS[extension] ?? [];
  const trimmed = line.trimStart();
  // Inside a still-open block comment the line-comment markers are comment
  // text, not line-comment starts: only a `*\/` closer matters there.
  if (!inBlock) {
    for (const marker of markers) {
      if (trimmed.startsWith(marker)) return { code: "", inBlock: false };
    }
  }
  if (!BLOCK_COMMENT_EXTENSIONS.has(extension)) {
    return { code: cutTrailingLineComment(line, markers), inBlock: false };
  }
  const result = stripBlockComments(line, markers.includes("//"), markers, inBlock);
  if (result.code.trim() === "") return { code: "", inBlock: result.inBlock };
  return { code: cutTrailingLineComment(result.code, markers), inBlock: result.inBlock };
}

/** Cut a trailing ` <marker> ...` run: a trailing comment starts at the
 * FIRST marker preceded by whitespace; a marker inside `https://` or
 * `a//b` has no leading space and does not. */
function cutTrailingLineComment(code: string, markers: readonly string[]): string {
  const cut = firstLineCommentStart(code, markers);
  return cut === -1 ? code : code.slice(0, cut);
}

interface DiffChunk {
  path: string | null;
  /** Mode-flip trigger: the chunk's header shows a real mode/typechange. */
  modeFlip: boolean;
  lines: string[];
}

/** Split a unified diff into per-file chunks (the k-th `diff --git` header
 * owns the lines until the next one). A header whose paths cannot be split
 * (quoted/odd names) yields a null path: its lines still scan, but the
 * obligation cannot anchor to it. */
function splitChunks(diff: string): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let current: DiffChunk | null = null;
  let pendingOldMode: string | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const header = DIFF_GIT_HEADER.exec(line);
    if (header !== null) {
      const oldPath = header[1] ?? "/dev/null";
      const newPath = header[2] ?? "/dev/null";
      const chunk: DiffChunk = {
        path: newPath === "/dev/null" ? (oldPath === "/dev/null" ? null : oldPath) : newPath,
        modeFlip: false,
        lines: [],
      };
      current = chunk;
      pendingOldMode = null;
      chunks.push(chunk);
      continue;
    }
    if (current === null) continue;
    const oldMode = OLD_MODE_HEADER.exec(line);
    if (oldMode !== null) {
      pendingOldMode = oldMode[1]!;
      continue;
    }
    const newMode = NEW_MODE_HEADER.exec(line);
    if (newMode !== null) {
      if (pendingOldMode !== null && pendingOldMode !== newMode[1]) current.modeFlip = true;
      if (newMode[1] === "120000") current.modeFlip = true;
      continue;
    }
    const newFileMode = NEW_FILE_MODE_HEADER.exec(line);
    if (newFileMode !== null) {
      if (newFileMode[1] === "120000") current.modeFlip = true;
      continue;
    }
    if (EXTENDED_HEADER.test(line)) continue;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("\\ No newline")) continue;
    current.lines.push(line);
  }
  return chunks;
}

/** A usable anchor: flattened, nonempty, no embedded space (a `diff --git`
 * header with spaced paths cannot be parsed unambiguously, and a spaced
 * anchor could not be cited token-wise by a rationale). A trigger whose
 * only path is unanchorable still RAISES the category: the row then keeps
 * the no-anchor discharge rule (rationale must name a path-like token),
 * which is the conservative fallback, never a silently dropped obligation. */
function boundedPath(path: string): string | null {
  const flat = path.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (flat === "" || flat.includes(" ")) return null;
  return flat.length > MAX_PATH_CHARS ? flat.slice(0, MAX_PATH_CHARS) : flat;
}

/** Scan the diff and build the risk-obligations artifact. Deterministic;
 * never throws. One row per tripped category, in RISK_CATEGORIES order.
 * Input completeness is the CALLER's record (the engine writes
 * `input_complete` from where it read the diff) — the scan cannot know it,
 * so it never claims it. */
export function scanRiskObligations(diff: string): RiskObligationsArtifact {
  const triggered = new Map<RiskCategory, Set<string>>();
  const truncatedPaths = new Set<RiskCategory>();
  const trip = (category: RiskCategory, path: string | null): void => {
    let paths = triggered.get(category);
    if (paths === undefined) {
      paths = new Set();
      triggered.set(category, paths);
    }
    const bounded = path === null ? null : boundedPath(path);
    if (paths.size >= MAX_RISK_PATHS_PER_OBLIGATION) {
      if (bounded === null || !paths.has(bounded)) truncatedPaths.add(category);
      return;
    }
    if (bounded !== null) paths.add(bounded);
  };

  let chunks: DiffChunk[] = [];
  try {
    chunks = splitChunks(diff ?? "");
  } catch {
    return { version: RISK_ARTIFACT_VERSION, obligations: [], truncated: false, errors: ["scan-failed"], method: "none" };
  }

  for (const chunk of chunks) {
    const path = chunk.path;
    if (chunk.modeFlip) {
      // The header alone is the file-identity trigger. The body then scans
      // under the SAME code-extension coverage bound as any other chunk:
      // a typechange to a regular file can carry changed code, and skipping
      // the body outright would silently miss the other categories in the
      // same file — the silent-miss direction the module header calls the
      // costly one. (Extensionless flip targets like hooks/pre-commit stay
      // unscanned bodies by that same documented bound.)
      trip("file_identity_mode", path);
    }
    if (!isScannableFile(path)) continue;
    const extension = extensionOf(path ?? "");
    // Block-comment state carries ACROSS the chunk's lines (#1637 review
    // fix), tracked per file version: the new-file state guards the `+`
    // lines, the old-file state the `-` lines, and a context line (present
    // in both versions) advances both — a comment opened before the visible
    // window or closed inside it is still tracked. Without the carried
    // state, an ordinary continuation line inside a still-open multi-line
    // block comment scans as code and a comment-only diff raises a
    // mandatory obligation.
    let inBlockNew = false;
    let inBlockOld = false;
    const tracksBlocks = BLOCK_COMMENT_EXTENSIONS.has(extension);
    for (const raw of chunk.lines) {
      const marker = raw[0];
      if (marker !== "+" && marker !== "-") {
        if (tracksBlocks) {
          const context = raw.slice(1);
          inBlockNew = stripLineComment(context, extension, inBlockNew).inBlock;
          inBlockOld = stripLineComment(context, extension, inBlockOld).inBlock;
        }
        continue;
      }
      const stateBefore = marker === "+" ? inBlockNew : inBlockOld;
      const stripped = stripLineComment(raw.slice(1), extension, stateBefore);
      if (marker === "+") inBlockNew = stripped.inBlock;
      else inBlockOld = stripped.inBlock;
      const content = stripped.code;
      if (content.trim() === "") continue;
      for (const category of RISK_CATEGORIES) {
        if (CATEGORY_PATTERNS[category].some((pattern) => pattern.test(content))) {
          trip(category, path);
        }
      }
    }
  }

  const obligations: RiskObligation[] = [];
  for (const category of RISK_CATEGORIES) {
    const paths = triggered.get(category);
    if (paths === undefined) continue;
    obligations.push({
      category,
      obligation: RISK_OBLIGATION_TEXTS[category],
      paths: [...paths],
      pathsTruncated: truncatedPaths.has(category),
    });
  }
  return {
    version: RISK_ARTIFACT_VERSION,
    obligations,
    truncated: false,
    errors: [],
    method: obligations.length > 0 ? "scan" : "none",
  };
}
