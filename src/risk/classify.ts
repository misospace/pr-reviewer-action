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
 * The #749 discipline applies: only the changed (+/-) lines of CODE files
 * count; docs, lockfiles, vendor output, and mentions that survive only
 * inside a recognized comment never fire. A real mode/typechange header
 * (`old mode 100644` → `new mode 120000`) is itself a trigger. The scan is
 * pure, deterministic, and never throws. */

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

/** Per-language line-comment markers used to blank comment lines. A chunk's
 * language is the extension; an unknown extension gets no comment markers
 * (everything scans as code — erring toward firing, never silently blind). */
const LINE_COMMENT_MARKERS: Readonly<Record<string, string[]>> = Object.freeze({
  ts: ["//"], tsx: ["//"], mts: ["//"], cts: ["//"], js: ["//"], jsx: ["//"],
  mjs: ["//"], cjs: ["//"], go: ["//"], java: ["//"], kt: ["//"], kts: ["//"],
  cs: ["//"], php: ["//"], rs: ["//"], scala: ["//"], swift: ["//"],
  c: ["//"], h: ["//"], cpp: ["//"], cc: ["//"], hpp: ["//"],
  py: ["#"], sh: ["#"], bash: ["#"], zsh: ["#"], yaml: ["#"], yml: ["#"], toml: ["#"], tf: ["#"],
  sql: ["--"], rb: ["#"],
});

const FILE_IDENTITY_MODE_PATTERNS: readonly RegExp[] = [
  /\bls-tree\b/i,
  /\b120000\b/,
  /\b100644\b/,
  /\b100755\b/,
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
  /\boverflow\b/i,
  /\bgoroutine\b/i,
];

const PERSISTED_STATE_PATTERNS: readonly RegExp[] = [
  /\bmigrations?\b/i,
  /\bschema\b/i,
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

/** Drop the language's line comment from a changed line: a line whose
 * trimmed form STARTS with a comment marker is blanked entirely, and a
 * trailing ` <marker> ...` run is cut (the #960 rule: a mention that
 * survives only inside a recognized comment never fires). Unknown
 * extensions keep their markers unmatched (the line scans whole). */
function stripLineComment(line: string, extension: string): string {
  const markers = LINE_COMMENT_MARKERS[extension] ?? [];
  const trimmed = line.trimStart();
  for (const marker of markers) {
    if (trimmed.startsWith(marker)) return "";
  }
  // A trailing comment starts at the FIRST marker preceded by whitespace; a
  // marker inside `https://` or `a//b` has no leading space and does not.
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
  return cut === -1 ? line : line.slice(0, cut);
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

function boundedPath(path: string): string | null {
  const flat = path.replace(/[\x00-\x1f\x7f]/g, " ").trim();
  if (flat === "" || flat.includes(" ")) return null;
  return flat.length > MAX_PATH_CHARS ? flat.slice(0, MAX_PATH_CHARS) : flat;
}

/** Scan the diff and build the risk-obligations artifact. Deterministic;
 * never throws. One row per tripped category, in RISK_CATEGORIES order.
 * `inputComplete` false means the scan did not see the whole diff, which
 * the enforcement half reads as INCOMPLETE coverage, never clean. */
export function scanRiskObligations(diff: string, inputComplete = true): RiskObligationsArtifact {
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
      trip("file_identity_mode", path);
      // A mode-flip chunk's body is not re-scanned for other categories:
      // there is usually none, and the header alone is the trigger.
      continue;
    }
    if (!isScannableFile(path)) continue;
    const extension = extensionOf(path ?? "");
    for (const raw of chunk.lines) {
      const marker = raw[0];
      if (marker !== "+" && marker !== "-") continue;
      const content = stripLineComment(raw.slice(1), extension);
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
