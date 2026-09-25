/** Deterministic PR classification — v3 port of `pr_reviewer/classifier.py`
 * (#675).
 *
 * Rule-based only: no model calls, no network. Analyzes changed files, diff
 * content, canonical linked issues, and linked-metadata completeness to
 * produce the structured classification consumed by routing, must-check
 * generation, and the specialist role selector.
 *
 * The pattern sets, rule tables, and their precedence are copied verbatim
 * from the Python module. The internal result is camelCase (#669 naming
 * contract); `classificationToArtifact` is the explicit serializer to the
 * persisted v2-identical snake_case `classification.json` schema. */

import type { ChangedFile, IssueLabel, LinkedIssue } from "../context/types.js";

/** The authoritative pr_kind enumeration (order = documentation order). */
export const PR_KINDS: readonly string[] = [
  "renovate_digest_only",
  "dependency_upgrade",
  "app_code",
  "k8s_manifest",
  "auth_changes",
  "public_route_changes",
  "file_serving_changes",
  "path_handling_changes",
  "secret_handling_changes",
  "db_or_migration_changes",
];

/** The authoritative risk-flag enumeration. */
export const RISK_FLAGS: readonly string[] = [
  "linked_security_issue",
  "linked_audit_issue",
  "linked_priority_p0",
  "linked_priority_p1",
  "file_serving_changes",
  "path_handling_changes",
  "auth_changes",
  "secret_handling_changes",
];

// ---------------------------------------------------------------------------
// Pattern sets (verbatim from pr_reviewer/classifier.py)
// ---------------------------------------------------------------------------

/** Renovate digest-only: lockfile files that contain only hash/digest changes
 * (no version bumps). */
const RENOVATE_DIGEST_FILE_PATTERNS: readonly RegExp[] = [
  /package-lock\.json/,
  /npm-shrinkwrap\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/,
];

/** Dependency-related files (lockfiles, manifests). */
const DEPENDENCY_PATTERNS: readonly RegExp[] = [
  /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|requirements\.txt|Gemfile\.lock|Cargo\.lock|go\.mod|go\.sum|composer\.lock|mix\.lock|build\.gradle|pom\.xml|setup\.py|setup\.cfg|pyproject\.toml|pubspec\.yaml|\.npmrc|\.yarnrc)/,
];

/** Kubernetes manifest patterns. */
const K8S_PATTERNS: readonly RegExp[] = [
  /(helmrelease|deployment|statefulset|daemonset|kustomization)\.ya?ml$/i,
  /configmap\.ya?ml$/,
  /secret\.ya?ml$/,
  /service\.ya?ml$/,
  /ingress\.ya?ml$/,
  /\.k8s\.ya?ml$/,
  /k8s\//,
  /helm\//,
];

/** Common source-file extensions across ecosystems. */
const SRC_EXT = "(py|js|jsx|ts|tsx|go|rb|java|kt|cs|php|rs|scala|swift)";

/** Auth-related changes. */
const AUTH_PATTERNS: readonly RegExp[] = [
  new RegExp(`(auth|login|oauth|oidc|saml|jwt|token|mfa|2fa|session)[_.-]?\\w*\\.${SRC_EXT}$`, "i"),
  /middleware[_.-]?auth/i,
  /permissions?\.ya?ml$/,
  /rbac\.ya?ml$/,
  /role[-_].*binding/i,
  /\.env(\.example)?$/i,
  /(auth|authn|authz)[-_]?(controller|service|guard|middleware|handler)/i,
];

/** Public route changes. NB: `routes` (plural) only — a bare `route.<ext>` is
 * the mandated name of every Next.js App Router API handler and must not
 * match (#531). */
const PUBLIC_ROUTE_PATTERNS: readonly RegExp[] = [
  new RegExp(`(routes|urls?|api|endpoints?|controller)\\.${SRC_EXT}$`, "i"),
  /router[_.-]?py$/,
  /urlpatterns/,
  /app\.route\(/,
  /@\w+\.route\(/,
  /(registerEndpoint|@(Get|Post|Put|Delete|Patch|RequestMapping))/i,
];

/** File serving changes — directory names or file patterns. */
const FILE_SERVING_PATTERNS: readonly RegExp[] = [
  /^(static|public|assets|uploads|media|files)[/_.-]/i,
  /(static|public|assets|uploads|media|files)\//i,
  /send_file/,
  /send_from_directory/,
  /FileServer/,
  /serveStatic/,
  /staticfiles?\//,
];

/** Path handling changes (#749 signal model) — classification requires a real
 * untrusted-path surface. The former model scanned raw diff content for broad
 * path-API mentions (`pathlib`, `os.path`, ...), so ordinary trusted path
 * scaffolding classified as path_handling_changes and injected traversal /
 * edge-case-path must_check items into benign PRs (the PR #748 false
 * positive: `ROOT = Path(__file__).resolve().parent.parent` in a test
 * helper). The model below distinguishes:
 *
 *   trusted path bookkeeping (never fires alone)
 *     - repository-root discovery: `Path(__file__).resolve().parent...`,
 *       `os.path.dirname(os.path.abspath(__file__))`, `__dirname` joins;
 *     - module resolution specifiers (`from "../x.js"` — kept from #720);
 *     - path-library usage with no untrusted input flow
 *       (`Path("/etc/myapp/config.yaml")`, `path_join(base, "static")`);
 *     - signals found only in test/fixture files (static fixture paths).
 *
 *   material path-handling changes (fire the kind, flag, and must_check)
 *     - traversal literals outside specifiers and trusted-anchor calls;
 *     - path normalization/sanitization/containment logic;
 *     - untrusted (request/user/...) values reaching path construction;
 *     - archive extraction and symlink-sensitive operations;
 *     - identifier-shaped path vocabulary in changed filenames.
 *
 * Every signal is recorded in the `path_handling_provenance` artifact field
 * (bounded, class-categorized — never raw unbounded PR text) so a future
 * false positive is debuggable without reading classifier internals. */

/** Filename-backed signal vocabulary: identifier-shaped path terms in changed
 * FILENAMES (e.g. `filepath.ts`, `path_join.py`, `sanitize_path.go`). A
 * filename hit means the PR modifies dedicated path-handling code. */
const PATH_HANDLING_FILENAME_PATTERNS: readonly RegExp[] = [
  /filepath|pathname/i,
  // Identifier-shaped joins only (sanitize_path, cleanPath, resolvePath):
  // a prose line like "sanitizes ... paths" in documentation must not read
  // as a code signal.
  /sanitize[\w]*path|path[\w]*sanitize|clean[\w]*path/i,
  /path_join|joinpath|resolve[\w]*path|path[\w]*resolve/i,
];

/** Path traversal literals: "../" or "..\". Scanned ONLY over neutralized
 * diff text (see neutralizePathFalsePositives): module specifiers and
 * trusted-anchor calls are removed first, so neither an ESM import like
 * `from "../runtime/subprocess.js"` (#679 false positive) nor trusted
 * repository-root joins like `path.resolve(__dirname, "../templates")`
 * count as traversal. */
const PATH_TRAVERSAL_PATTERN = /\.\.\/|\.\.\\/i;

/** A module specifier is the quoted path inside an ESM/CJS import construct —
 * `from "../x.js"`, `require("../x")`, `import("../x")`, a side-effect
 * `import "../x.css"`. Specifier literals are module resolution, not
 * filesystem path handling. Only the quoted literal is neutralized: other
 * content on the same source line (a real `../` traversal next to a require
 * call) must still count as traversal. */
const SPECIFIER_QUOTED =
  /\bfrom\s*(['"])[^'"]*\1|\brequire\s*\(\s*(['"])[^'"]*\2|\bimport\s*\(\s*(['"])[^'"]*\3|\bimport\s+(['"])[^'"]*\4/gi;

/** Trusted path anchors: tokens whose value is the location of the source
 * file itself. Expressions built from them are repository-root discovery,
 * never attacker-controlled path surfaces. (Replacement-only: carries /g.) */
const TRUSTED_ANCHOR_TOKEN =
  /\b(?:__file__|__dirname|__filename)\b|\bimport\.meta\.(?:url|dirname|filename)\b/g;

/** A `Path(__file__)...` chain: the anchor plus bounded pure-chaining calls
 * (.resolve(), .parent, .parents[N], .joinpath("..."), ...). One level of
 * call arguments is consumed; deeper nesting fails to match and stays in the
 * scanned text (conservative). joinpath arguments go through the same
 * untrusted-refusal check as anchor calls (see
 * refuseUntrustedAnchorNeutralization). (Replacement-only: carries /g.) */
const PATHLIB_ANCHOR_CHAIN =
  /\bPath\s*\(\s*(?:__file__|__filename)\s*\)(?:\s*\.\s*(?:resolve|absolute|parent|parents\[\d+\]|joinpath|name|stem|as_posix|as_uri|is_dir|is_file|exists|stat)\b\s*(?:\(\s*[^()]*\))?)*/g;
/** Anchor-anchored path calls: a path construction/resolution call whose FIRST
 * argument is a trusted anchor — `path.resolve(__dirname, "../templates")`,
 * `os.path.join(os.path.dirname(__file__), "data.json")`, `resolve(__file__)`.
 * The whole call is trusted bookkeeping ONLY when the remaining arguments are
 * demonstrably static (string literals or plain identifiers from the bounded
 * trusted vocabulary): an untrusted operand anywhere in the call REFUSES
 * neutralization so the untrusted-join signal can fire on it
 * (`path.resolve(__dirname, request.args["path"])` is a real surface).
 * Only one argument level is consumed (no nested parens in the tail);
 * unmatched forms stay in the scanned text (conservative).
 * (Replacement-only: carries /g.) */
const ANCHOR_PATH_CALL =
  /(?:[.]|\b)(?:join|resolve|normalize|realpath|abspath|normpath|dirname|basename|joinpath)\s*\(\s*(?:__file__|__dirname|__filename|import\.meta\.(?:url|dirname|filename)|(?:os\.path\.)?(?:dirname|basename|abspath|realpath)\s*\(\s*(?:__file__|__dirname|__filename)\s*\)|Path\s*\(\s*(?:__file__|__filename)\s*\)(?:\.(?:resolve|parent|parents\[\d+\]|absolute)\b)*)\s*(?:,\s*[^()]*)?\)/g;

/** A quoted string literal with NO interpolation marker (`{`, `$`, `%`): its
 * content is static data. Interpolation-shaped literals are deliberately NOT
 * stripped, so `f"{user}"` / `` `${x}` `` keep their inner text visible to the
 * untrusted-token check (fail toward detection). */
/** Static string-literal lexer: replaces STATIC literal contents with an
 * empty literal while preserving interpolation-shaped ones (`f"{x}"`,
 * `` `${y}` ``, `%`-forms), whose inner text stays visible to the
 * untrusted-token check (fail toward detection). A paired-quote char walk
 * (escape-aware) replaces the former regex approximation, which could
 * consume code between two ADJACENT quotes — `f'{x}', request.args['p']`
 * lost its `request` operand to the span between the quotes. */
function stripStaticStringLiterals(line: string): string {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i] ?? "";
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      let content = "";
      let closed = false;
      while (j < n) {
        const c = line[j] ?? "";
        if (c === "\\" && j + 1 < n) {
          content += line.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          break;
        }
        content += c;
        j += 1;
      }
      if (closed) {
        if (content.includes("{") || content.includes("$") || content.includes("%")) {
          out.push(ch + content + ch);
        } else {
          out.push(ch + ch);
        }
        i = j + 1;
      } else {
        out.push(ch + content);
        i = n;
      }
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

/** Simple assignment target: a leading identifier bound with `=` or `:=`
 * (const/let/var-style prefixes tolerated; the unified-diff `+`/`-`/space
 * marker is skipped). Deliberately NOT a general lvalue grammar — tuples,
 * subscripts, and attribute targets yield no one-hop edge. */
/** Simple assignment target: a leading identifier bound with `=` or `:=`
 * (const/let/var-style prefixes tolerated; the unified-diff `+`/`-`/space
 * marker is skipped). A BOUNDED type annotation is allowed between the
 * target and the `=` (`name: str = ...`, `const n: string = ...`) — typed
 * assignments are idiomatic modern Python/TS, not exotic lvalues. Tuples,
 * subscripts, and attribute targets still yield no one-hop edge. `==`
 * comparisons never match. */
const UNTRUSTED_ASSIGNMENT = /^[+\-]?\s*(?:const|let|var|final|val|my|our|local)?\s*([A-Za-z_]\w*)\s*(?::\s*[^=()]{0,60})?=(?!=)/;

/** Assignment-target identifier of a line whose QUOTE-STRIPPED RHS reaches an
 * untrusted source (a one-hop def/use candidate). Null when the line is not a
 * simple assignment or its RHS carries no untrusted token — static quoted
 * words like `label = "request"` are data, not flow, and never create an
 * edge. */
function untrustedAssignmentTarget(line: string): string | null {
  const m = UNTRUSTED_ASSIGNMENT.exec(line);
  if (!m || !m[1]) return null;
  const rhs = stripStaticStringLiterals(line.slice(m.index + m[0].length));
  if (matchesAny(rhs, UNTRUSTED_SOURCE_PATTERNS)) return m[1];
  return null;
}

/** Assignment-target identifiers carried by adjacent untrusted-source lines:
 * the one-hop def/use candidates for the line being neutralized or scanned.
 * Bounded by construction (at most two neighbors). */
function oneHopUntrustedTargets(prevLine: string, nextLine: string): string[] {
  const targets: string[] = [];
  for (const line of [prevLine, nextLine]) {
    const ident = untrustedAssignmentTarget(line);
    if (ident && !targets.includes(ident)) targets.push(ident);
  }
  return targets;
}

/** Escape-free word-boundary membership: `ident` is `[A-Za-z_]\w*` by
 * construction, so the pattern has no metacharacters. */
function mentionsIdentifier(text: string, ident: string): boolean {
  return new RegExp(`\\b${ident}\\b`).test(text);
}

function neutralizePathFalsePositives(
  line: string,
  prevLine = "",
  nextLine = "",
): string {
  /** One diff line with trusted path scaffolding neutralized (replaced by
   * an empty literal). Line structure is preserved: neutralization is
   * literal-scoped, so material signals elsewhere on the same line still
   * match. The adjacent RAW lines feed the one-hop def/use check: an anchor
   * call is NOT neutralized when one of its operands is a variable that an
   * adjacent untrusted-source line assigns — otherwise
   * `name = request.args["path"]` / `path.resolve(__dirname, name)` would
   * lose its construction call before the untrusted-join scan sees it. */
  const oneHop = oneHopUntrustedTargets(prevLine, nextLine);
  const refuse = (match: string): string => {
    const staticText = stripStaticStringLiterals(match);
    if (matchesAny(staticText, UNTRUSTED_SOURCE_PATTERNS)) return match;
    if (oneHop.some((ident) => mentionsIdentifier(staticText, ident))) return match;
    return '""';
  };
  // Chain refusal: beyond the usual operand checks, the `Path(__file__)...`
  // chain is also NOT neutralized when it continues into a `/` division
  // whose tail reaches an untrusted source or a one-hop target —
  // `Path(__file__).parent / request.args['p']` is a real untrusted-path
  // surface, and neutralizing the chain would delete the `Path(` head the
  // operand scanner needs.
  const refuseChain = (match: string, offset: number): string => {
    const refused = refuse(match);
    if (refused !== '""') return refused;
    const staticTail = stripStaticStringLiterals(line.slice(offset + match.length));
    if (pathlibDivisionTail(staticTail) === null) return refused;
    if (matchesAny(staticTail, UNTRUSTED_SOURCE_PATTERNS)) return match;
    if (oneHop.some((ident) => mentionsIdentifier(staticTail, ident))) return match;
    return '""';
  };
  return line
    .replace(SPECIFIER_QUOTED, '""')
    .replace(ANCHOR_PATH_CALL, refuse)
    .replace(PATHLIB_ANCHOR_CHAIN, refuseChain)
    .replace(TRUSTED_ANCHOR_TOKEN, '""');
}

function neutralizeChunkLines(lines: string[]): string[] {
  /** Neutralize a diff chunk line by line, feeding each line its adjacent
   * RAW neighbors for the one-hop untrusted-flow refusal. */
  return lines.map((line, index) =>
    neutralizePathFalsePositives(
      line,
      index > 0 ? lines[index - 1] ?? "" : "",
      index + 1 < lines.length ? lines[index + 1] ?? "" : "",
    ),
  );
}

/** Material content signal classes: each entry is (signal class, patterns).
 * These are usage-shaped signals — a bare path-library import or API mention
 * matches none of them. Scanned per diff chunk over neutralized text. */
const PATH_HANDLING_CONTENT_CLASSES: readonly (readonly [string, readonly RegExp[]])[] = [
  // Explicit traversal literals (outside specifiers/anchor calls).
  ["traversal_literal", [PATH_TRAVERSAL_PATTERN]],
  // Path normalization / sanitization / containment logic: identifier-shaped
  // sanitize/validate/check vocabulary (kept from #720) plus the containment
  // and normalization APIs (`commonpath`, `is_relative_to`, `realpath`,
  // `abspath`, `normpath`, safe-join variants) that appear almost exclusively
  // in real boundary checks. Trusted anchor calls are neutralized before this
  // scans, so `os.path.realpath(__file__)` bookkeeping does not fire.
  ["path_containment_or_sanitization", [
    /sanitize[\w]*path|path[\w]*sanitize|clean[\w]*path|safe[\w]*path|path[\w]*safe/i,
    /validate[\w]*path|path[\w]*valid|check[\w]*path|path[\w]*check/i,
    /commonpath|is_relative_to/i,
    /realpath|abspath|normpath/i,
    /safe[_\w]*join|safejoin/i,
  ]],
  // Archive extraction: zip-slip surfaces. Member names are attacker-
  // influenceable even when the archive path itself is constant.
  ["archive_extraction", [
    /extractall|unpack_archive|safe_extract/i,
    /\b(?:zipfile|tarfile)\b/i,
    /\b(?:ZipFile|TarFile)\b/i,
    /\bunzip\s*\(/i,
  ]],
  // Symlink-sensitive filesystem operations.
  ["symlink_sensitive", [
    /symlink|readlink|lstat|follow_symlinks|O_NOFOLLOW/i,
  ]],
  // Identifier-shaped path references (`filepath`, `pathname`) — variables
  // and identifiers named after the path they denote. More specific than the
  // removed `pathlib`/`os.path` mention patterns and kept deliberately.
  ["path_reference_identifier", [/filepath|pathname/i]],
];

/** Path construction heads: a callee that opens a filesystem-path
 * construction call. The untrusted-source scan reads ONLY the call's
 * argument list — extracted with the balanced-paren scanner at ANY nesting
 * depth — never the assignment LHS, trailing comments, or sibling
 * statements, so incidental lexical words outside the construction cannot
 * donate a token. Heads are (pattern, flags, isPathlib) triples; the pathlib
 * constructor stays case-sensitive (case-insensitive `path(` would match
 * method names) and is the only head whose operands continue through `/`
 * division chaining (pathlib's path-join operator). */
const PATH_CONSTRUCTION_HEADS: readonly (readonly [string, string, boolean])[] = [
  ["os\\.path\\.(?:join|normpath|realpath|abspath|relpath|commonpath)", "i", false],
  ["\\bpath\\.(?:join|resolve|normalize|dirname|basename)", "i", false],
  ["\\bjoinpath", "i", false],
  ["\\bfilepath\\.\\w+", "i", false],
  ["\\b(?:open|fopen)", "i", false],
  ["\\b(?:readFile|writeFile|readFileSync|writeFileSync|appendFile|createReadStream|createWriteStream|openSync)", "i", false],
  ["\\b(?:send_file|send_from_directory|sendFile|FileResponse|serveStatic|FileServer|StaticFiles)", "i", false],
  ["\\bshutil\\.(?:copy|copy2|copyfile|copytree|move|rmtree|unpack_archive)", "i", false],
  ["\\bos\\.(?:mkdir|makedirs|unlink|rename|remove)", "i", false],
  ["\\bPath", "", true],
];

const PATH_CONSTRUCTION_HEAD_PATTERNS: readonly { pattern: RegExp; isPathlib: boolean }[] =
  PATH_CONSTRUCTION_HEADS.map(([head, flags, isPathlib]) => ({
    pattern: new RegExp(`${head}\\s*\\(`, `${flags}g`),
    isPathlib,
  }));

/** Cap on continuation lines accumulated for one open construction call.
 * Continuation lines are operand-list text by construction (the call is
 * still open), so this is a boundedness horizon, not a precision filter. */
export const MAX_CONSTRUCTION_CONTINUATION_LINES = 8;

/** Values an attacker plausibly controls when they reach a filesystem path:
 * HTTP request data, user/model input, CLI arguments, and file-object names —
 * `.filename` ATTRIBUTE ACCESS (`file.filename`, `f.filename`) is the classic
 * unsafe-upload operand; a BARE `filename` identifier is deliberately NOT a
 * source (a trusted constant named filename flowing into a path is
 * bookkeeping, and the identifier reference alone is not proof of attacker
 * influence). Deliberately EXCLUDED: environment variables and process cwd —
 * env/config paths are operator-owned infrastructure (the PR #748 lesson: CI
 * scripts join env-provided output paths constantly and are not attacker
 * surfaces) — and `upload` directory vocabulary: `UPLOAD_DIR`/`uploads/`
 * names are ubiquitous in TRUSTED paths; the upload risk lives in the
 * filename operand, which has its own shape. */
const UNTRUSTED_SOURCE_PATTERNS: readonly RegExp[] = [
  /\brequest\b/i,
  /\breq\b/i,
  /\buser\b|\buser_/i,
  /\binput/i,
  /\bquery\b/i,
  /\bparams\b/i,
  /\bform\b|formdata/i,
  /\bpayload\b/i,
  /\bheaders?\b/i,
  /\bcookies?\b/i,
  /\bstdin\b/i,
  /\bargv\b/i,
  /\.\s*filename\b/i,
  /\boriginalname\b/i,
  /\buntrusted|\bunsanitized|\battacker/i,
];

/** Test/fixture file conventions, cross-language. Signals found only in test
 * files are fixture construction ("static paths under test directories"),
 * not a shippable untrusted-path surface; they are discounted (recorded in
 * provenance as `diff_test_file`, never fire). */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)(?:tests?|testing|spec|specs|__tests__|fixtures?|testdata)\//i,
  /(?:^|\/)(?:conftest\.py|test_[^/]*\.py|[^/]*_test\.(?:py|go|rs|rb|java|kt|cs)|[^/]*\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts))$/i,
];

function isTestPath(path: string): boolean {
  /** True when a file path follows test/fixture conventions. */
  return matchesAny(path, TEST_FILE_PATTERNS);
}

/** Bounded unified-diff chunk header: `diff --git a/<path> b/<path>`. Used to
 * attribute diff content to the file it belongs to so test-file signals can
 * be discounted. Diffs without git headers (raw synthetic text) form a single
 * chunk with an unknown file, which is treated conservatively as non-test. */
const DIFF_GIT_HEADER = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

function splitDiffChunks(diffText: string): [string | null, string[]][] {
  /** Split a unified diff into (filePathOrNull, lines) chunks on
   * `diff --git` headers. Best-effort: a header line whose paths cannot be
   * parsed is kept as content (conservative mis-attribution only ever keeps
   * scrutiny, never drops it). */
  const chunks: [string | null, string[]][] = [];
  let currentFile: string | null = null;
  let current: string[] = [];
  for (const line of diffText.split("\n")) {
    const m = DIFF_GIT_HEADER.exec(line);
    if (m) {
      if (current.length > 0) chunks.push([currentFile, current]);
      currentFile = m[2] ?? null;
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push([currentFile, current]);
  return chunks;
}

/** Provenance bounds: attacker-controlled diff text is never emitted raw or
 * unbounded. Samples are control-character-free bounded line excerpts; counts
 * are capped so a pathological diff cannot flood the artifact. */
export const MAX_PATH_SIGNALS = 8;
export const MAX_PATH_FILES = 8;
export const MAX_PATH_SAMPLES = 3;
export const MAX_PATH_SAMPLE_CHARS = 160;

function pathSample(line: string): string {
  /** Bounded, control-character-free excerpt of a matched line. */
  let cleaned = "";
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return cleaned.trim().slice(0, MAX_PATH_SAMPLE_CHARS);
}

/** Truncate a quote-stripped line at its first comment marker (`#` or `//`).
 * String literals are already stripped, so a residual marker is a real
 * comment; interpolation-shaped literals may retain one (conservative
 * truncation of contrived content only). */
function stripLineComment(line: string): string {
  let cut = line.length;
  for (const marker of ["#", "//"]) {
    const pos = line.indexOf(marker);
    if (pos !== -1 && pos < cut) cut = pos;
  }
  return line.slice(0, cut);
}

/** Index of the `)` that closes a construction call opened `depth` paren
 * levels up, or null when the text ends with the call still open. Nested
 * parens are tracked, so a nested call closing inside the line never
 * terminates the scan early — only the paren that returns the depth to
 * zero does. */
function balancedClose(text: string, depth: number, start = 0): number | null {
  for (let pos = start; pos < text.length; pos++) {
    const ch = text[pos];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth <= 0) return pos;
    }
  }
  return null;
}

/** Pathlib division chaining: after a complete `Path(...)` call, an operand
 * may continue through attribute/method chains and one or more `/`
 * path-join divisions (`Path(__file__).parent / request.args['p']`).
 * Hand-scanned rather than a regex: the equivalent pattern is
 * backtrack-prone on adversarial input and the scanned text is
 * attacker-controlled PR diff content (CodeQL py/js redos). Returns the end
 * index (exclusive) of the tail, or null. */
function pathlibDivisionTail(line: string, start = 0): number | null {
  let i = start;
  const n = line.length;
  while (i < n && (line[i] === " " || line[i] === "\t")) i++;
  while (i < n && line[i] === ".") {
    let j = i + 1;
    while (j < n && /[\w\[\]]/.test(line[j] ?? "")) j++;
    if (j === i + 1) return null; // a bare `.` with no name is not a chain link
    i = j;
    if (i < n && line[i] === "(") {
      const k = line.indexOf(")", i + 1);
      if (k === -1) return null;
      i = k + 1;
    }
    while (i < n && (line[i] === " " || line[i] === "\t")) i++;
  }
  if (i < n && line[i] === "/") return i + 1;
  return null;
}

/** The operand text of the path-construction call(s) actually matched on line
 * `index`: complete one-level-nested argument lists, and — for a call left
 * open across the line break — the balanced continuation lines up to and
 * including the closing paren. Only call arguments are included: trailing
 * comments (cut at the first `#`/`//`) and sibling statements after the
 * closer are excluded, and nested parentheses are tracked so an inner `)`
 * never ends the scan while outer operands remain. Static quoted literals
 * are stripped before extraction. Empty string when the line constructs no
 * path. */
function constructionOperandSpans(lines: string[], index: number): string {
  const line = stripLineComment(stripStaticStringLiterals(lines[index] ?? ""));
  const spans: string[] = [];
  for (const { pattern, isPathlib } of PATH_CONSTRUCTION_HEAD_PATTERNS) {
    for (const m of line.matchAll(pattern)) {
      const close = balancedClose(line, 1, m.index + m[0].length);
      if (close === null) {
        // Open call: the continuation lines ARE the operand list. The
        // opening-line remainder's own paren balance seeds the depth
        // (`os.path.join(foo(`), so a nested call's `)` cannot close the
        // scan before later operands.
        const piece = line.slice(m.index + m[0].length);
        let depth = 1 + (piece.match(/\(/g) ?? []).length - (piece.match(/\)/g) ?? []).length;
        let accumulated = piece;
        for (let j = index + 1; j < Math.min(index + 1 + MAX_CONSTRUCTION_CONTINUATION_LINES, lines.length); j++) {
          const continuation = stripLineComment(stripStaticStringLiterals(lines[j] ?? ""));
          const c = balancedClose(continuation, depth);
          if (c === null) {
            accumulated += `\n${continuation}`;
            depth += (continuation.match(/\(/g) ?? []).length - (continuation.match(/\)/g) ?? []).length;
          } else {
            accumulated += `\n${continuation.slice(0, c + 1)}`;
            depth = 0;
            break;
          }
        }
        spans.push(accumulated);
      } else {
        let operand = line.slice(m.index + m[0].length, close + 1);
        if (isPathlib) {
          const tailEnd = pathlibDivisionTail(line, close + 1);
          if (tailEnd !== null) {
            operand += "/" + line.slice(tailEnd);
          }
        }
        spans.push(operand);
      }
    }
  }
  return spans.join("\n");
}

/** One bounded path-handling signal: the matched class/category, its backing
 * (filename vs diff content vs discounted test-file content), attributed
 * files, and bounded line excerpts. */
export interface PathHandlingSignal {
  signal: string;
  source: "filename" | "diff" | "diff_test_file" | "filename_test_file";
  files: string[];
  samples: string[];
}

type SignalBucketKey = string; // `${signal}\u0000${source}`

function recordSignal(
  buckets: Map<SignalBucketKey, PathHandlingSignal>,
  signal: string,
  source: PathHandlingSignal["source"],
  file: string | null,
  sample: string | null,
): void {
  /** Merge one raw hit into a signal bucket (dedup by class + backing,
   * bounded file/sample lists, stable first-seen order). */
  const key: SignalBucketKey = `${signal}\u0000${source}`;
  let entry = buckets.get(key);
  if (entry === undefined) {
    if (buckets.size >= MAX_PATH_SIGNALS) return;
    entry = { signal, source, files: [], samples: [] };
    buckets.set(key, entry);
  }
  if (file && !entry.files.includes(file) && entry.files.length < MAX_PATH_FILES) {
    entry.files.push(file);
  }
  if (sample && !entry.samples.includes(sample) && entry.samples.length < MAX_PATH_SAMPLES) {
    entry.samples.push(sample);
  }
}

/** Bounded provenance for the path-handling signal model — why path handling
 * fired and which test-file signals were deliberately discounted. */
export interface PathHandlingProvenance {
  fired: boolean;
  signals: PathHandlingSignal[];
  discounted: PathHandlingSignal[];
}

export function evaluatePathHandlingSignals(
  filenames: readonly string[],
  diffText: string,
): { fired: PathHandlingSignal[]; discounted: PathHandlingSignal[] } {
  /** Evaluate the #749 path-handling signal model.
   *
   * Returns `{fired, discounted}`: bounded signal lists. `fired` drives the
   * kind/flag/must_check; `discounted` records trusted-scaffolding and
   * test-file signals that were deliberately not allowed to fire, so a
   * future false positive is debuggable from the artifact alone. */
  const firedBuckets = new Map<SignalBucketKey, PathHandlingSignal>();
  const discountedBuckets = new Map<SignalBucketKey, PathHandlingSignal>();

  // 1) Filename-backed signals: identifier-shaped path vocabulary in the
  // changed-file list. Test-file hits are discounted.
  for (const name of filenames) {
    if (!matchesAny(name, PATH_HANDLING_FILENAME_PATTERNS)) continue;
    const isTest = isTestPath(name);
    recordSignal(
      isTest ? discountedBuckets : firedBuckets,
      "path_identifier_filename",
      isTest ? "filename_test_file" : "filename",
      name,
      null,
    );
  }

  // 2) Diff-content signals, attributed per chunk so test-file content can
  // be discounted. All classes scan neutralized text (trusted scaffolding
  // removed); only the untrusted-join class adds the ±1-line window.
  // A chunk without a git-header filename (headerless/synthetic diff) can
  // still be discounted when EVERY changed file is a test file — the whole
  // diff is then test content. Mixed or unknown file sets fire
  // conservatively.
  const allFilesAreTests =
    filenames.length > 0 && filenames.every((name) => isTestPath(name));
  for (const [chunkFile, lines] of splitDiffChunks(diffText)) {
    if (lines.length === 0) continue;
    const neutralized = neutralizeChunkLines(lines);
    const isTest =
      chunkFile !== null ? isTestPath(chunkFile) : allFilesAreTests;
    const buckets = isTest ? discountedBuckets : firedBuckets;
    const source: PathHandlingSignal["source"] = isTest ? "diff_test_file" : "diff";

    for (const [className, patterns] of PATH_HANDLING_CONTENT_CLASSES) {
      for (let index = 0; index < neutralized.length; index++) {
        if (!matchesAny(neutralized[index] ?? "", patterns)) continue;
        recordSignal(buckets, className, source, chunkFile, pathSample(lines[index] ?? ""));
        break; // one bucket entry per class per chunk; samples merge across chunks
      }
    }

    // Untrusted-source join: the scan reads ONLY the operand text of the
    // construction call(s) matched on the line — never the assignment LHS,
    // comments, or sibling statements. Same-line construction with an
    // untrusted operand fires directly; adjacent lines fire only on a
    // one-hop def/use edge (the untrusted line's assignment target is used
    // inside the call's operands). Co-occurrence never fires.
    for (let index = 0; index < lines.length; index++) {
      const rawLine = lines[index] ?? "";
      const flowText = constructionOperandSpans(lines, index);
      if (!flowText) continue;
      if (matchesAny(flowText, UNTRUSTED_SOURCE_PATTERNS)) {
        recordSignal(buckets, "untrusted_source_join", source, chunkFile, pathSample(rawLine));
        continue;
      }
      for (const adjIndex of [index - 1, index + 1]) {
        if (adjIndex < 0 || adjIndex >= lines.length) continue;
        const target = untrustedAssignmentTarget(lines[adjIndex] ?? "");
        if (target && mentionsIdentifier(flowText, target)) {
          recordSignal(buckets, "untrusted_source_join", source, chunkFile, pathSample(rawLine));
          break;
        }
      }
    }
  }

  return { fired: [...firedBuckets.values()], discounted: [...discountedBuckets.values()] };
}

/** Path-handling kind rule: fires only when the signal model found a
 * material (non-discounted) untrusted-path surface. */
function isPathHandling(filenames: readonly string[], diffText: string): boolean {
  return evaluatePathHandlingSignals(filenames, diffText).fired.length > 0;
}

/** Secret handling changes. */
const SECRET_HANDLING_PATTERNS: readonly RegExp[] = [
  new RegExp("(secret|credential|password|api.?key|private.?key|token)[_.-]?\\w*\\.(py|js|ts|go|rb|yaml|yml|json)$", "i"),
  /secrets?\.ya?ml$/,
  /vault|hashicorp|aws.?secrets/i,
  /base64\.(decode|encode)/i,
];

/** DB / migration changes. */
const DB_MIGRATION_PATTERNS: readonly RegExp[] = [
  /(migration|migrate|migrations?)/i,
  /schema\.(py|rb|ts|js|sql|prisma)$/i,
  new RegExp(`models?\\.${SRC_EXT}$`, "i"),
  /(entity|entities|repository)\.(java|kt|cs|ts)$/i,
  /\.sql$/i,
  /alembic|django.*migrat|sequelize|migrate_/i,
  /prisma\/schema\.prisma$/,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** The typed canonical classification (#675). Consumers (routing, role
 * selection, corpus) receive this object — never a re-read of
 * `classification.json` with a subtly different schema. Internal fields are
 * camelCase (#669); the persisted artifact shape is produced only by
 * `classificationToArtifact`. */
export interface PRClassification {
  prKind: string;
  riskFlags: string[];
  riskFlagsWithFiles: Record<string, string[]>;
  /** Subset of (prKind + riskFlags) safe to drive smart-model routing:
   * linked-issue flags and any file-based signal backed by an actual changed
   * filename. Content-only pattern matches are excluded (#159). */
  routeSignals: string[];
  changedFilesSummary: string[];
  linkedIssueLabels: string[];
  mustCheck: string[];
  /** #633: true when a selection-relevant metadata source (GitHub
   * linked-issue labels, configured Linear priority/labels) was EXPECTED but
   * could not be determined — missing signals must not be read as absent
   * signals by the deterministic selector. Known-disabled state is NOT
   * uncertainty; unusable status input degrades to not-uncertain. */
  linkedMetadataUncertain: boolean;
  linkedMetadataUncertainty: string[];
  /** #749: bounded provenance for the path-handling signal model — why path
   * handling fired (class/category, filename vs diff backing, bounded
   * samples) and which test-file/trusted-scaffolding signals were
   * deliberately discounted. Empty lists when path handling did not fire.
   * Never contains unbounded attacker-controlled text. */
  pathHandlingProvenance: PathHandlingProvenance;
}

/** Serialize the internal classification to the persisted v2-identical
 * snake_case artifact (`classification.json`). Key order mirrors the v2
 * dataclass; the parity harness compares `sort_keys` canonical JSON, so the
 * artifact bytes are v2-identical regardless. */
export function classificationToArtifact(classification: PRClassification): Record<string, unknown> {
  return {
    pr_kind: classification.prKind,
    risk_flags: classification.riskFlags,
    risk_flags_with_files: classification.riskFlagsWithFiles,
    route_signals: classification.routeSignals,
    changed_files_summary: classification.changedFilesSummary,
    linked_issue_labels: classification.linkedIssueLabels,
    must_check: classification.mustCheck,
    linked_metadata_uncertain: classification.linkedMetadataUncertain,
    linked_metadata_uncertainty: classification.linkedMetadataUncertainty,
    path_handling_provenance: {
      fired: classification.pathHandlingProvenance.fired,
      signals: classification.pathHandlingProvenance.signals,
      discounted: classification.pathHandlingProvenance.discounted,
    },
  };
}

// ---------------------------------------------------------------------------
// pr_kind rule table
// ---------------------------------------------------------------------------

/** Classification is a declarative table evaluated top-to-bottom; the FIRST
 * matching rule wins, so table order is precedence (most-specific first). */
type KindPredicate = (filenames: string[], diffText: string) => boolean;
const KIND_RULES: readonly { kind: string; matches: KindPredicate }[] = [
  { kind: "renovate_digest_only", matches: isRenovateDigestOnly },
  { kind: "dependency_upgrade", matches: isDependencyUpgrade },
  { kind: "k8s_manifest", matches: filenameMatches(K8S_PATTERNS) },
  // secret handling before auth (more specific)
  { kind: "secret_handling_changes", matches: filenameMatches(SECRET_HANDLING_PATTERNS) },
  { kind: "db_or_migration_changes", matches: filenameMatches(DB_MIGRATION_PATTERNS) },
  { kind: "auth_changes", matches: filenameMatches(AUTH_PATTERNS) },
  { kind: "public_route_changes", matches: filenameMatches(PUBLIC_ROUTE_PATTERNS) },
  { kind: "file_serving_changes", matches: filenameOrDiffMatches(FILE_SERVING_PATTERNS) },
  { kind: "path_handling_changes", matches: isPathHandling },
];

/** Fallback kind when no rule matches. */
export const DEFAULT_PR_KIND = "app_code";

function filenameMatches(patterns: readonly RegExp[]): KindPredicate {
  return (filenames) => filenames.some((name) => matchesAny(name, patterns));
}

function filenameOrDiffMatches(patterns: readonly RegExp[]): KindPredicate {
  return (filenames, diffText) =>
    filenames.some((name) => matchesAny(name, patterns)) || matchesAny(diffText, patterns);
}

/** True only when EVERY changed file is a known lockfile — guards
 * renovate_digest_only against mixed PRs (code + a lockfile). */
function allFilesAreLockfiles(filenames: string[]): boolean {
  if (filenames.length === 0) return false;
  return filenames.every((name) => matchesAny(name, RENOVATE_DIGEST_FILE_PATTERNS));
}

/** True when the diff contains a version bump (JSON or changed YAML form), so
 * a digest-only update with a version change is not mislabeled. */
function hasVersionBump(diffText: string): boolean {
  if (/"version"\s*:\s*"[^"]+"/.test(diffText)) return true;
  if (/^[+-]\s*(?:app)?[Vv]ersion:\s*\S+/m.test(diffText)) return true;
  return false;
}

function isRenovateDigestOnly(filenames: string[], diffText: string): boolean {
  return allFilesAreLockfiles(filenames) && !hasVersionBump(diffText);
}

/** A dependency/manifest file changed, but NOT a k8s manifest (which happens
 * to reference versions and must classify as k8s_manifest instead). */
function isDependencyUpgrade(filenames: string[], _diffText: string): boolean {
  const hasDepFile = filenames.some((name) => matchesAny(name, DEPENDENCY_PATTERNS));
  if (!hasDepFile) return false;
  const hasK8s = filenames.some((name) => matchesAny(name, K8S_PATTERNS));
  return !hasK8s;
}

function classifyPrKind(files: readonly ChangedFile[], diffText: string): string {
  const filenames = files.map((file) => file.filename);
  for (const rule of KIND_RULES) {
    if (rule.matches(filenames, diffText)) return rule.kind;
  }
  return DEFAULT_PR_KIND;
}

// ---------------------------------------------------------------------------
// Risk-flag rule tables
// ---------------------------------------------------------------------------

/** Linked-issue flags: a flag fires when a linked issue carries ANY of the
 * trigger labels (case-insensitive). Order matters — flags append in this
 * order (deduplicated) as issues are scanned. */
const LINKED_ISSUE_RULES: readonly { triggerLabels: readonly string[]; flag: string }[] = [
  { triggerLabels: ["security", "vulnerability"], flag: "linked_security_issue" },
  { triggerLabels: ["audit"], flag: "linked_audit_issue" },
  { triggerLabels: ["priority/p0", "priority_p0"], flag: "linked_priority_p0" },
  { triggerLabels: ["priority/p1", "priority_p1"], flag: "linked_priority_p1" },
];

/** File-based flags: a flag fires when any changed filename OR the diff
 * content matches the pattern set. Order matters. The path_handling entry
 * uses the #749 signal model (evaluatePathHandlingSignals) instead of a plain
 * pattern scan; its pattern list here backs only the filename attribution
 * vocabulary. */
const FILE_RISK_RULES: readonly { patterns: readonly RegExp[]; flag: string }[] = [
  { patterns: FILE_SERVING_PATTERNS, flag: "file_serving_changes" },
  { patterns: PATH_HANDLING_FILENAME_PATTERNS, flag: "path_handling_changes" },
  { patterns: AUTH_PATTERNS, flag: "auth_changes" },
  { patterns: SECRET_HANDLING_PATTERNS, flag: "secret_handling_changes" },
];

function issueLabels(issue: LinkedIssue): Set<string> {
  return new Set(issue.labels.map((label: IssueLabel) => label.name.toLowerCase()));
}

function detectRiskFlags(
  files: readonly ChangedFile[],
  diffText: string,
  linkedIssues: readonly LinkedIssue[],
): { flags: string[]; flagsWithFiles: Record<string, string[]> } {
  const flags: string[] = [];
  const flagsWithFiles: Record<string, string[]> = {};
  const filenames = files.map((file) => file.filename);

  // Linked security/audit/priority issues (table order, deduplicated).
  // Linear's native priority is numeric (1=Urgent, 2=High): convert those to
  // the same synthetic labels recognized for linked issues so teams do not
  // need to duplicate Linear priority as a custom label.
  for (const issue of linkedIssues) {
    const labels = issueLabels(issue);
    if (issue.source.toLowerCase() === "linear") {
      // Python: `type(priority) is int` — booleans and floats excluded.
      if (typeof issue.priority === "number" && Number.isInteger(issue.priority)) {
        if (issue.priority === 1) labels.add("priority/p0");
        else if (issue.priority === 2) labels.add("priority/p1");
      }
    }
    for (const { triggerLabels, flag } of LINKED_ISSUE_RULES) {
      if (triggerLabels.some((label) => labels.has(label)) && !flags.includes(flag)) {
        flags.push(flag);
      }
    }
  }

  // File-based risk flags (derived from classification patterns).
  for (const { patterns, flag } of FILE_RISK_RULES) {
    let triggeringFiles: string[];
    let matchesInDiff: boolean;
    if (flag === "path_handling_changes") {
      // #749: the path-handling flag uses the untrusted-surface signal
      // model. Filename attribution keeps the historical semantics — only
      // filename-backed hits populate the file list (content-only matches
      // attribute to an empty list), so smart-model routing is unchanged
      // (#159).
      const fired = evaluatePathHandlingSignals(filenames, diffText).fired;
      matchesInDiff = fired.some((s) => s.source === "diff");
      triggeringFiles = [];
      for (const signal of fired) {
        if (signal.source !== "filename") continue;
        for (const name of signal.files) {
          if (!triggeringFiles.includes(name)) triggeringFiles.push(name);
        }
      }
    } else {
      triggeringFiles = filenames.filter((name) => matchesAny(name, patterns));
      matchesInDiff = matchesAny(diffText, patterns);
    }
    if (triggeringFiles.length > 0 || matchesInDiff) {
      if (!flags.includes(flag)) flags.push(flag);
      // File attribution (empty list when only diff content matched).
      flagsWithFiles[flag] = triggeringFiles;
    }
  }

  return { flags, flagsWithFiles };
}

// ---------------------------------------------------------------------------
// Checklist derivation
// ---------------------------------------------------------------------------

/** Checklist items per risk class. Keys are pr_kind values AND the file-based
 * risk flags (which share names), so a flag like auth_changes detected on an
 * app_code PR still pulls in the auth checklist (#157). */
const KIND_CHECKS: Readonly<Record<string, readonly string[]>> = {
  renovate_digest_only: ["verify no functional changes beyond lockfile hashes"],
  dependency_upgrade: [
    "check for breaking API changes in updated dependencies",
    "run full test suite after upgrade",
  ],
  k8s_manifest: [
    "validate manifest against target cluster version",
    "check for resource quota / limit changes",
  ],
  auth_changes: ["review auth flow for regression", "verify session token handling is correct"],
  public_route_changes: [
    "verify route access controls are in place",
    "check for unintended public endpoints",
  ],
  file_serving_changes: [
    "verify file path sanitization",
    "check for directory traversal vulnerabilities",
  ],
  path_handling_changes: [
    "review for path traversal vulnerabilities",
    "test with edge-case paths (null bytes, symlinks)",
  ],
  secret_handling_changes: [
    "verify secrets are not logged or exposed in diffs",
    "check secret rotation impact",
  ],
  db_or_migration_changes: [
    "review migration for data loss risk",
    "test migration on a copy of production schema",
  ],
};

/** Checklist items per linked-issue risk flag. */
const FLAG_CHECKS: Readonly<Record<string, readonly string[]>> = {
  linked_security_issue: ["explicitly address the linked security issue"],
  linked_audit_issue: ["verify audit findings are addressed"],
  linked_priority_p0: ["treat as critical — verify all changes thoroughly"],
  linked_priority_p1: ["treat as high priority — verify correctness carefully"],
};

/** Kinds whose classification can come from diff CONTENT (the
 * filenameOrDiffMatches rules). A content-only match of these must not drive
 * smart-model routing — only an actual changed filename should. The
 * path_handling kind fires from the #749 signal model; routing stays
 * filename-gated exactly as before — only a filename vocabulary hit (the same
 * effective subset as the removed mention patterns) may route. */
const CONTENT_CAPABLE_KINDS: Readonly<Record<string, readonly RegExp[]>> = {
  file_serving_changes: FILE_SERVING_PATTERNS,
  path_handling_changes: PATH_HANDLING_FILENAME_PATTERNS,
};

function buildMustCheck(prKind: string, riskFlags: readonly string[]): string[] {
  const checks: string[] = [];
  const seen = new Set<string>();
  for (const key of [prKind, ...riskFlags]) {
    for (const check of [...(KIND_CHECKS[key] ?? []), ...(FLAG_CHECKS[key] ?? [])]) {
      if (!seen.has(check)) {
        seen.add(check);
        checks.push(check);
      }
    }
  }
  return checks;
}

function routeSignals(
  prKind: string,
  filenames: readonly string[],
  riskFlags: readonly string[],
  riskFlagsWithFiles: Record<string, string[]>,
): string[] {
  /** Signals eligible to route a PR straight to the smart model. Excludes
   * content-only matches (which over-route benign PRs). */
  const signals: string[] = [];
  // Linked-issue flags are explicit human signals — always route.
  for (const flag of riskFlags) {
    if (flag.startsWith("linked_") && !signals.includes(flag)) signals.push(flag);
  }
  // File-based risk flags only when an actual changed filename matched;
  // content-only matches carry an empty file list.
  for (const flag of Object.keys(riskFlagsWithFiles)) {
    const files = riskFlagsWithFiles[flag] ?? [];
    if (files.length > 0 && !signals.includes(flag)) signals.push(flag);
  }
  // pr_kind routes unless it is the catch-all default or a content-only
  // file_serving/path_handling kind.
  if (prKind && prKind !== DEFAULT_PR_KIND && !signals.includes(prKind)) {
    const patterns = CONTENT_CAPABLE_KINDS[prKind];
    if (patterns === undefined) {
      signals.push(prKind);
    } else if (filenames.some((name) => matchesAny(name, patterns))) {
      signals.push(prKind);
    }
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Linked-metadata uncertainty (#633)
// ---------------------------------------------------------------------------

/** Bounded, control-character-free string for reason text; empty when
 * unusable. Mirrors the Python `_clean` (strip, reject control chars,
 * cap 200 chars). */
function cleanReason(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text) return "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return "";
  }
  return text.slice(0, 200);
}

/** Parse the context pipeline's linked-metadata completeness artifact into an
 * uncertainty flag + human reasons. A GitHub linked-issue fetch failure or a
 * failed configured Linear lookup means missing signals are not absent
 * signals; known-disabled state and unusable input degrade to
 * not-uncertain. */
function linkedMetadataUncertainty(metadataStatus: unknown): { uncertain: boolean; reasons: string[] } {
  if (metadataStatus === null || typeof metadataStatus !== "object" || Array.isArray(metadataStatus)) {
    return { uncertain: false, reasons: [] };
  }
  const status = metadataStatus as Record<string, unknown>;
  const reasons: string[] = [];
  const githubFailures = status.github_fetch_failures;
  if (Array.isArray(githubFailures)) {
    for (const item of githubFailures) {
      const ref = cleanReason(item);
      if (ref) reasons.push(`github linked issue ${ref} fetch failed`);
    }
  }
  const linearFailures = status.linear_fetch_failures;
  if (Array.isArray(linearFailures)) {
    for (const item of linearFailures) {
      const ref = cleanReason(item);
      if (ref) reasons.push(`linear ${ref} lookup failed`);
    }
  }
  // linear_known_disabled: intentionally no Linear data, not uncertainty.
  return { uncertain: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  prFiles: readonly ChangedFile[];
  diffText?: string | undefined;
  linkedIssues?: readonly LinkedIssue[] | undefined;
  maxSummaryFiles?: number | undefined;
  metadataStatus?: unknown;
}

/** Run deterministic classification on a PR. Pure and synchronous — no model
 * calls, no network, no command execution. */
export function classifyPr(input: ClassifyInput): PRClassification {
  const { prFiles, diffText = "", linkedIssues = [], maxSummaryFiles = 50, metadataStatus = null } = input;

  const uncertainty = linkedMetadataUncertainty(metadataStatus);

  // #749: evaluate the path-handling signal model once and share it across
  // the kind rule, the risk-flag rule, and the provenance artifact.
  const pathEvaluation = evaluatePathHandlingSignals(
    prFiles.map((file) => file.filename),
    diffText,
  );
  const pathHandlingProvenance: PathHandlingProvenance = {
    fired: pathEvaluation.fired.length > 0,
    signals: pathEvaluation.fired,
    discounted: pathEvaluation.discounted,
  };

  const prKind = classifyPrKind(prFiles, diffText);
  const { flags, flagsWithFiles } = detectRiskFlags(prFiles, diffText, linkedIssues);
  const mustCheck = buildMustCheck(prKind, flags);

  // Build changed files summary (just filenames, truncated).
  const fileNames = prFiles.map((file) => file.filename);
  const changedFilesSummary = fileNames.slice(0, maxSummaryFiles);
  const routeSignalsList = routeSignals(prKind, fileNames, flags, flagsWithFiles);

  // Collect linked issue labels (case-sensitive, encounter order).
  const linkedIssueLabels: string[] = [];
  for (const issue of linkedIssues) {
    for (const label of issue.labels) {
      const name = label.name;
      if (name && !linkedIssueLabels.includes(name)) linkedIssueLabels.push(name);
    }
  }

  return {
    prKind,
    riskFlags: flags,
    riskFlagsWithFiles: flagsWithFiles,
    routeSignals: routeSignalsList,
    changedFilesSummary,
    linkedIssueLabels,
    mustCheck,
    linkedMetadataUncertain: uncertainty.uncertain,
    linkedMetadataUncertainty: uncertainty.reasons,
    pathHandlingProvenance,
  };
}
