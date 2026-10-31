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
  "image_digest_only",
  "renovate_image_update",
  "renovate_chart_update",
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
  "dependency_security_sensitive",
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

/** Manifest files that can pin a container image by digest: Kubernetes/Helm/
 * compose YAML and Dockerfiles (#909). */
const IMAGE_DIGEST_FILE_PATTERNS: readonly RegExp[] = [
  /\.ya?ml$/i,
  /(^|\/)Dockerfile(\..+)?$/i,
  /\.dockerfile$/i,
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
 *     - self-location `readlink` (#1034): `os.readlink(__file__)`, shell
 *       `readlink [-f] "$0"` / `"${BASH_SOURCE[0]}"` as a whole statement or
 *       inside `dirname`/`cd`, and the Python and shell symlink-resolution
 *       loops. It holds for ordinary code only: rebinding the anchor, a
 *       template line that is really string content, a second file and
 *       obfuscated spellings can evade it, as `getattr(os, "read" + "link")`
 *       evades the class scan already;
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
/** Declaration keywords must be separate TOKENS (trailing `\s+`) so
 * `variable`/`constant`/`localpath`/`values` are identifiers, never
 * keyword+suffix. */
const UNTRUSTED_ASSIGNMENT =
  /^[+\-]?\s*(?:(?:const|let|var|final|val|my|our|local)\s+)?\s*([A-Za-z_]\w*)\s*(?::\s*[^=()]{0,60})?=(?!=)/;

/** Closing brackets mapped to their openers, for division-operand scanning. */
const DIVISION_OPERAND_CLOSERS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/** The expression belonging to a `/` path-division: scanned from the operand
 * start to the end of THAT expression, at the operand's starting nesting
 * level. Terminates on the first top-level `,` or `;`, or on an unmatched
 * closing bracket (one that closes an enclosing context the operand did not
 * open). Bracket nesting is tracked per type (`()`, `[]`, `{}`) and quoted
 * spans are skipped whole (escape-aware), so delimiters inside a
 * call/subscript/container — or inside a string literal — that belong to the
 * operand never terminate it, while sibling expressions at the operand's own
 * level cannot donate untrusted tokens. Operates on the already quote-lexed
 * representation; surviving quotes are interpolation-shaped literals. */
function divisionOperand(text: string): string {
  const out: string[] = [];
  const depth: Record<string, number> = { "(": 0, "[": 0, "{": 0 };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] ?? "";
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        const c = text[j] ?? "";
        if (c === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (c === ch) break;
        j += 1;
      }
      out.push(text.slice(i, j + 1));
      i = j < n ? j + 1 : n;
      continue;
    }
    if (ch in depth) {
      depth[ch] = (depth[ch] ?? 0) + 1;
    } else if (ch in DIVISION_OPERAND_CLOSERS) {
      const opener = DIVISION_OPERAND_CLOSERS[ch] ?? "";
      if ((depth[opener] ?? 0) === 0) break; // closes an enclosing context
      depth[opener] = (depth[opener] ?? 0) - 1;
    } else if ((ch === "," || ch === ";") && !Object.values(depth).some((d) => d > 0)) {
      break;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

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
    const tailEnd = pathlibDivisionTail(staticTail);
    if (tailEnd === null) return refused;
    const tailOperand = divisionOperand(staticTail.slice(tailEnd));
    if (matchesAny(tailOperand, UNTRUSTED_SOURCE_PATTERNS)) return match;
    if (oneHop.some((ident) => mentionsIdentifier(tailOperand, ident))) return match;
    return '""';
  };
  return line
    .replace(SPECIFIER_QUOTED, '""')
    .replace(ANCHOR_PATH_CALL, refuse)
    .replace(PATHLIB_ANCHOR_CHAIN, refuseChain)
    .replace(TRUSTED_ANCHOR_TOKEN, '""');
}

const DIFF_MARKERS: ReadonlySet<string> = new Set(["+", "-", " "]);

/** The unified-diff line marker, or NUL for a header line that has none. */
function diffMarker(line: string): string {
  const first = line[0] ?? "";
  return DIFF_MARKERS.has(first) ? first : "\u0000";
}

/** #1034: a script reading its OWN symlink (`os.readlink(__file__)`, shell
 * `readlink "$0"`, the portable symlink-resolution loop) is self-location
 * bookkeeping like `realpath(__file__)`, not a symlink-sensitive surface.
 * Recognition is closed and line-whole: a handful of complete statements and
 * two loop templates of consecutive lines, matched by static patterns, so an
 * untrusted operand, an intervening reassignment or a second operation on
 * the line keeps firing. It reads each line as ordinary code: a rebound
 * anchor, a template line that is really string content, or a second file
 * that changes what the anchor means can evade it. */
type SelfLocationFamilies = { python: boolean; shell: boolean };

/** Language gate: `.py`/`.pyw` Python, `.sh`/`.bash` shell, an extensionless
 * file (a `bin/` wrapper) either, anything else (a dotfile included) neither. */
function selfLocationFamilies(path: string | null): SelfLocationFamilies {
  const base = path?.split("/").pop() ?? "";
  if (base === "" || base.startsWith(".")) return { python: false, shell: false };
  if (!base.includes(".")) return { python: true, shell: true };
  const kind = fileKindToken(base);
  return { python: kind === "py" || kind === "pyw", shell: kind === "sh" || kind === "bash" };
}

/** Identifiers are bounded so a pathological name fails to match rather than
 * costing time. */
const SELF_LOCATION_IDENT = String.raw`[A-Za-z_]\w{0,63}`;
const SH_ANCHOR_WORD = String.raw`(?:\$0|\$\{BASH_SOURCE\[0\]\})`;
const SH_ANCHOR = String.raw`"${SH_ANCHOR_WORD}"`;
const SH_READLINK_ANCHOR = String.raw`readlink[ \t]+(?:-f[ \t]+)?${SH_ANCHOR}`;
/** A literal path after the resolved directory (`")/.."`, `")/lib"`): plain
 * path characters only, bounded. */
const SH_PATH_SUFFIX = String.raw`(?:/[\w.-]{0,64}){0,8}`;
const SH_DIRNAME_ANCHOR = String.raw`\$\(dirname[ \t]+"\$\(${SH_READLINK_ANCHOR}\)"\)${SH_PATH_SUFFIX}`;

/** Whole-statement direct forms. Python: `[NAME =] os.readlink(__file__)`.
 * Shell: `readlink [-f] A`, `NAME="$(readlink [-f] A)"`,
 * `NAME="$(dirname "$(readlink [-f] A)")"`, `cd "$(dirname "$(readlink [-f] A)")"`,
 * with A a quoted `$0` or `${BASH_SOURCE[0]}` and an optional `local`. An
 * assignment's right-hand side is not word-split, so its outer quotes are
 * optional, as a matched pair (`("?)...\N`); the shell loop lines take the
 * same rule. */
const PY_DIRECT_STATEMENT = new RegExp(
  String.raw`^[ \t]*(?:${SELF_LOCATION_IDENT}[ \t]*=[ \t]*)?os\.readlink[ \t]*\([ \t]*__file__[ \t]*(?:,[ \t]*)?\)[ \t]*$`,
);
const SH_DIRECT_STATEMENT = new RegExp(
  String.raw`^[ \t]*(?:${SH_READLINK_ANCHOR}|(?:local[ \t]+)?${SELF_LOCATION_IDENT}=("?)\$\(${SH_READLINK_ANCHOR}\)\1|(?:local[ \t]+)?${SELF_LOCATION_IDENT}=("?)${SH_DIRNAME_ANCHOR}\2|cd[ \t]+"${SH_DIRNAME_ANCHOR}")[ \t]*$`,
);

/** Python loop template lines; indentation is captured and compared as text. */
const PY_LOOP_ANCHOR = new RegExp(String.raw`^([ \t]*)(${SELF_LOCATION_IDENT})[ \t]*=[ \t]*__file__[ \t]*$`);
const PY_LOOP_GUARD = new RegExp(
  String.raw`^([ \t]*)while[ \t]+os\.path\.islink[ \t]*\([ \t]*(${SELF_LOCATION_IDENT})[ \t]*\)[ \t]*:[ \t]*$`,
);
const PY_LOOP_UPDATE = new RegExp(
  String.raw`^([ \t]*)(${SELF_LOCATION_IDENT})[ \t]*=[ \t]*os\.readlink[ \t]*\([ \t]*(${SELF_LOCATION_IDENT})[ \t]*\)[ \t]*$`,
);

/** Shell loop template lines. */
const SH_LOOP_ANCHOR = new RegExp(String.raw`^[ \t]*(${SELF_LOCATION_IDENT})=("?)${SH_ANCHOR_WORD}\2[ \t]*$`);
const SH_LOOP_GUARD = new RegExp(
  String.raw`^[ \t]*while[ \t]+(?:\[[ \t]+-[Lh][ \t]+"\$(${SELF_LOCATION_IDENT})"[ \t]+\]|\[\[[ \t]+-[Lh][ \t]+"\$(${SELF_LOCATION_IDENT})"[ \t]+\]\])[ \t]*;[ \t]*do[ \t]*$`,
);
const SH_LOOP_READ = new RegExp(
  String.raw`^[ \t]*(${SELF_LOCATION_IDENT})=("?)\$\(readlink[ \t]+"\$(${SELF_LOCATION_IDENT})"\)\2[ \t]*$`,
);
const SH_LOOP_COPY = new RegExp(
  String.raw`^[ \t]*(${SELF_LOCATION_IDENT})=("?)\$(${SELF_LOCATION_IDENT})\2[ \t]*$`,
);
const SH_LOOP_DONE = /^[ \t]*done[ \t]*$/;

/** Python template at run position k: `T = __file__`, `while os.path.islink(T):`
 * at the same indentation, one body line `T = os.readlink(T)` indented under
 * it, then a dedent to the guard's level (or further) or the end of the run.
 * Returns the body line's position, or null. */
function pythonSelfLocationLoop(codes: readonly string[], k: number): number | null {
  const anchor = PY_LOOP_ANCHOR.exec(codes[k] ?? "");
  const guard = PY_LOOP_GUARD.exec(codes[k + 1] ?? "");
  const update = PY_LOOP_UPDATE.exec(codes[k + 2] ?? "");
  if (!anchor || !guard || !update) return null;
  const [, indent = "", ident = ""] = anchor;
  if (guard[1] !== indent || guard[2] !== ident) return null;
  const bodyIndent = update[1] ?? "";
  if (bodyIndent.length <= indent.length || !bodyIndent.startsWith(indent)) return null;
  if (update[2] !== ident || update[3] !== ident) return null;
  for (let j = k + 3; j < codes.length; j++) {
    const code = codes[j] ?? "";
    if (code.trim() === "") continue;
    const lead = /^[ \t]*/.exec(code)?.[0] ?? "";
    return indent.startsWith(lead) ? k + 2 : null;
  }
  return k + 2;
}

/** Shell template, five consecutive lines: `T="${BASH_SOURCE[0]}"` (or `"$0"`),
 * `while [ -L "$T" ]; do`, `L="$(readlink "$T")"`, `T="$L"`, `done`. Returns
 * the readlink line's position, or null. */
function shellSelfLocationLoop(codes: readonly string[], k: number): number | null {
  const anchor = SH_LOOP_ANCHOR.exec(codes[k] ?? "");
  const guard = SH_LOOP_GUARD.exec(codes[k + 1] ?? "");
  const read = SH_LOOP_READ.exec(codes[k + 2] ?? "");
  const copy = SH_LOOP_COPY.exec(codes[k + 3] ?? "");
  if (!anchor || !guard || !read || !copy || !SH_LOOP_DONE.test(codes[k + 4] ?? "")) return null;
  const ident = anchor[1] ?? "";
  const link = read[1] ?? "";
  if (link === ident || (guard[1] ?? guard[2]) !== ident || read[3] !== ident) return null;
  return copy[1] === ident && copy[3] === link ? k + 2 : null;
}

/** Lines whose `readlink` is a recognised self-location read. A direct
 * statement is line-local. Loops are matched per diff side: the new side reads
 * added and context lines, the old side removed and context lines, and a
 * header line ends both runs; a context line counts only when both sides
 * recognise it. */
function selfLocationReadlinkLines(lines: readonly string[], path: string | null): Set<number> {
  const families = selfLocationFamilies(path);
  const approved = new Set<number>();
  if (!families.python && !families.shell) return approved;
  const codes = lines.map((line) => line.slice(1));
  const inLoop = { "+": new Set<number>(), "-": new Set<number>() };
  for (const side of ["+", "-"] as const) {
    let run: number[] = [];
    const flush = (): void => {
      const runCodes = run.map((index) => codes[index] ?? "");
      for (let k = 0; k < run.length; k++) {
        const hit =
          (families.python ? pythonSelfLocationLoop(runCodes, k) : null) ??
          (families.shell ? shellSelfLocationLoop(runCodes, k) : null);
        if (hit !== null) inLoop[side].add(run[hit] ?? -1);
      }
      run = [];
    };
    lines.forEach((line, index) => {
      const marker = diffMarker(line);
      if (marker === "\u0000") flush();
      else if (marker === side || marker === " ") run.push(index);
    });
    flush();
  }
  lines.forEach((line, index) => {
    const marker = diffMarker(line);
    if (marker === "\u0000") return;
    const code = codes[index] ?? "";
    const direct =
      (families.python && PY_DIRECT_STATEMENT.test(code)) || (families.shell && SH_DIRECT_STATEMENT.test(code));
    const onNew = inLoop["+"].has(index);
    const onOld = inLoop["-"].has(index);
    const loop = marker === "+" ? onNew : marker === "-" ? onOld : onNew && onOld;
    if (direct || loop) approved.add(index);
  });
  return approved;
}

/** A recognised line with `readlink` blanked. The line matched a whole
 * statement, so any other occurrence is inside an identifier
 * (`readlink_result = os.readlink(__file__)`). */
function blankSelfLocationReadlink(line: string): string {
  return line.replaceAll("readlink", '""');
}

/** Characters that end a statement or expression, after which a comment marker
 * cannot be part of a larger token (a URL scheme, a division, a regex). */
const STATEMENT_TERMINATORS: ReadonlySet<string> = new Set([";", ")", "}", "]", ",", "{"]);

/** True when a line-comment marker at index `i` is a comment rather than part
 * of a token that merely contains the same characters. Two shapes qualify:
 * right after a statement terminator (`x=1;// note`, `);// note`), where a URL
 * scheme, an unspaced floor division, or an escaped regex slash is impossible;
 * or at code start / after whitespace (`// note`, `# note`, `x = 1  # note`).
 * `requireTrailingSpace` additionally demands whitespace or end-of-line after
 * the marker: `#` and `--` need it (a CSS hex colour `#fff` and a
 * pre-decrement `--i` both follow whitespace or the line start), while `//`
 * does not (its non-comment uses — `a//b` floor division, `https://`, `/a\//`
 * — are always attached to a non-space character). When the marker is
 * ambiguous the text is scanned as CODE, which can only add signal, never hide
 * it: this rule fails toward detection. */
function commentMarkerAt(
  chars: readonly string[],
  i: number,
  prefix: number,
  length: number,
  requireTrailingSpace: boolean,
): boolean {
  const prev = i > 0 ? chars[i - 1] ?? "" : "";
  if (STATEMENT_TERMINATORS.has(prev)) return true;
  if (i !== prefix && !/\s/.test(prev)) return false;
  if (!requireTrailingSpace) return true;
  const next = chars[i + length] ?? "";
  return next === "" || /\s/.test(next);
}

/** The only `/*` refused outright as a cross-line block opener is one preceded
 * by a backslash — the escaped slash of a regex literal (`/\*foo\//`). In a
 * language that actually has `/*` block comments, every other `/*` outside a
 * string IS a comment (C maximal munch makes `a/*b` a comment opener, and
 * globs are a shell concept shell never reaches here — see
 * `commentMarkersFor`). Whether the candidate really is a comment is then
 * decided by `findBlockClose`: an opener with no closer is left as code rather
 * than blanking what follows. A single-line `/* ... *​/` is blanked inline
 * regardless, since its closer is on the same line and cannot leak. */
function isBlockOpener(chars: readonly string[], i: number): boolean {
  return (i > 0 ? chars[i - 1] ?? "" : "") !== "\\";
}

/** Search bound for a block comment's closer. A real comment is far shorter; a
 * phantom opener simply fails to find one and is discarded. */
const MAX_BLOCK_CARRY_LINES = 200;

/** File-type token used to pick the comment markers: the extension after the
 * last dot (`ts` for `src/app.ts`, `gitignore` for `.gitignore`), or the whole
 * basename when there is no dot (`makefile`). */
function fileKindToken(path: string): string {
  const base = path.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? lower.slice(dot + 1) : lower;
}

/** Comment syntax is a fact about the file's language, not something local
 * syntax can decide: `rm -rf /*foo` and `x = 1 /* note` are
 * character-identical shapes, and only the language tells them apart. A
 * marker that is not a comment in the file's language must NEVER blank text —
 * in shell, `/*` is a glob, `--` an end-of-options terminator
 * (`cp -- ../etc/passwd dest`), and `//` a doubled slash or (in Python) spaced
 * floor division (`x = total // workers; open("../out")`), so blanking there
 * hides real code: a false negative. Unknown file types get no comment
 * blanking at all, which also fails toward detection. `#` is gated too: it is
 * a comment in most scripting and config languages but a preprocessor
 * directive in C (`# define X ../y`) and an ID selector in CSS. */

/** `#` line comments: shell family, Python, Ruby, Perl, and the config
 * languages that borrow the convention. Tcl and Dockerfile are deliberately
 * absent: there `#` is a comment only in command position (start of command /
 * comment line), which the shared standalone-or-terminator placement rule
 * cannot express — blanking a mid-line `#` there would hide real arguments
 * (`set p [file join # ../etc/passwd]`). No blanking fails toward
 * detection. */
const HASH_LINE_COMMENT_KINDS = new Set([
  "sh", "bash", "zsh", "ksh", "csh", "tcsh", "fish", "bashrc", "zshrc",
  "bash_profile", "profile", "py", "pyw", "pyi", "rb", "rake", "gemspec",
  "raku", "pl", "pm", "r", "jl", "ps1", "psm1", "psd1", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "cnf", "env", "properties", "cmake", "mk",
  "make", "makefile", "graphql", "gql", "nim", "nims", "cr",
  "coffee", "hcl", "tf", "tfvars", "nix", "ex", "exs", "gitignore",
  "gitattributes", "gitmodules", "gitconfig", "editorconfig", "crontab",
]);

/** `//` line comments: the C family and languages that borrowed it. Markup
 * formats (HTML, component templates) and mixed-grammar files (jsx/tsx —
 * JSX text between elements — and PHP, which interleaves HTML text between
 * `?>` and `<?php`) are deliberately absent: a `//` there can be literal
 * text, and blanking it would hide real code that follows on the line. If
 * the lightweight lexer cannot prove something is a comment, it is scanned
 * as code; embedded script comments simply fire instead. */
const SLASH_LINE_COMMENT_KINDS = new Set([
  "js", "mjs", "cjs", "ts", "cts", "mts", "c", "h", "cc", "cpp",
  "cxx", "hpp", "hh", "cs", "java", "go", "rs", "swift", "kt", "kts", "scala",
  "sc", "dart", "zig", "jsonc", "json5", "sass", "scss",
  "less", "proto", "fbs", "thrift", "groovy", "gradle", "ino", "glsl", "vert",
  "frag", "comp", "hlsl", "hcl", "tf", "tfvars",
]);

/** `--` line comments: SQL, Lua, Haskell, Ada, Elm. */
const DASH_LINE_COMMENT_KINDS = new Set([
  "sql", "lua", "hs", "lhs", "ada", "adb", "ads", "elm", "vhdl", "vhd",
]);

/** `/* ... *​/` block comments: the C family, CSS, SQL, and schema/HCL
 * languages. Markup and mixed-grammar formats are absent for the same
 * reason as above. */
const BLOCK_COMMENT_KINDS = new Set([
  "js", "mjs", "cjs", "ts", "cts", "mts", "c", "h", "cc", "cpp",
  "cxx", "hpp", "hh", "cs", "java", "go", "rs", "swift", "kt", "kts", "scala",
  "sc", "dart", "css", "scss", "sass", "less", "sql",
  "jsonc", "json5", "proto", "fbs", "thrift", "groovy", "gradle", "ino",
  "glsl", "vert", "frag", "comp", "hlsl", "hcl", "tf", "tfvars", "nix",
]);

/** Which comment markers the file's language actually has. A null path (a
 * headerless or synthetic chunk) yields none: with no language there is no
 * basis for treating any marker as a comment, and scanning everything as code
 * is the conservative direction. */
function commentMarkersFor(path: string | null): {
  hash: boolean;
  slash: boolean;
  dash: boolean;
  block: boolean;
} {
  if (path === null) {
    return { hash: false, slash: false, dash: false, block: false };
  }
  const kind = fileKindToken(path);
  return {
    hash: HASH_LINE_COMMENT_KINDS.has(kind),
    slash: SLASH_LINE_COMMENT_KINDS.has(kind),
    dash: DASH_LINE_COMMENT_KINDS.has(kind),
    block: BLOCK_COMMENT_KINDS.has(kind),
  };
}
/** The closing marker for a block opened at column `startCol` of the stream
 * line at `startK`, or null when none appears within `MAX_BLOCK_CARRY_LINES`
 * lines. The search is quote-agnostic: the first closing marker wins, because
 * quotes have no syntax inside a block comment — a quoted one is still text
 * that closes it (the C/JS/CSS rule). */
function findBlockClose(
  lines: readonly string[],
  indices: readonly number[],
  startK: number,
  startCol: number,
): { k: number; col: number } | null {
  for (let k = startK; k < indices.length && k <= startK + MAX_BLOCK_CARRY_LINES; k++) {
    const text = lines[indices[k] ?? 0] ?? "";
    const col = text.indexOf("*/", k === startK ? startCol : 0);
    if (col !== -1) return { k, col };
  }
  return null;
}

/** Blank one diff stream's lines — the line indices belonging to one side of
 * the diff. A cross-line block comment is blanked only once its closing marker
 * is actually found within the stream, so an opener that never closes (a
 * phantom such as a shell glob or a regex literal) is left as code and can
 * never hide the real traversal that follows it. Returns the replacement text
 * for the lines it touched. */
function blankStream(
  lines: readonly string[],
  indices: readonly number[],
  markers: { hash: boolean; slash: boolean; dash: boolean; block: boolean },
): Map<number, string> {
  const chars = new Map<number, string[]>();
  const charsFor = (index: number): string[] => {
    let arr = chars.get(index);
    if (arr === undefined) {
      arr = (lines[index] ?? "").split("");
      chars.set(index, arr);
    }
    return arr;
  };
  let k = 0;
  let col = 0;
  while (k < indices.length) {
    const index = indices[k] ?? 0;
    const line = lines[index] ?? "";
    const arr = charsFor(index);
    const n = arr.length;
    const prefix = DIFF_MARKERS.has(diffMarker(line)) ? 1 : 0;
    let i = col;
    let jumped = false;
    let quote: string | null = null;
    while (i < n) {
      const ch = arr[i] ?? "";
      if (quote !== null) {
        if (ch === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        quote = ch;
        i += 1;
        continue;
      }
      if (markers.block && ch === "/" && arr[i + 1] === "*") {
        // Quote-agnostic: the first closing marker wins. Quotes have no
        // syntax inside a block comment, so skipping a quoted one to keep
        // scanning would pair quotes across the executable code that follows
        // and blank it — a false negative.
        const close = line.indexOf("*/", i + 2);
        if (close === -1) {
          if (isBlockOpener(arr, i)) {
            const end = findBlockClose(lines, indices, k, i + 2);
            if (end !== null) {
              for (let c = i; c < n; c++) arr[c] = " ";
              for (let m = k + 1; m < end.k; m++) {
                const mid = charsFor(indices[m] ?? 0);
                for (let c = 0; c < mid.length; c++) mid[c] = " ";
              }
              const closer = charsFor(indices[end.k] ?? 0);
              for (let c = 0; c <= end.col + 1 && c < closer.length; c++) closer[c] = " ";
              k = end.k;
              col = end.col + 2;
              jumped = true;
              break;
            }
          }
          i += 1;
          continue;
        }
        for (let c = i; c <= close + 1 && c < n; c++) arr[c] = " ";
        i = close + 2;
        continue;
      }
      if (
        markers.slash &&
        ch === "/" &&
        arr[i + 1] === "/" &&
        commentMarkerAt(arr, i, prefix, 2, false)
      ) {
        for (let c = i; c < n; c++) arr[c] = " ";
        break;
      }
      if (markers.hash && ch === "#" && commentMarkerAt(arr, i, prefix, 1, true)) {
        for (let c = i; c < n; c++) arr[c] = " ";
        break;
      }
      if (
        markers.dash &&
        ch === "-" &&
        arr[i + 1] === "-" &&
        commentMarkerAt(arr, i, prefix, 2, true)
      ) {
        for (let c = i; c < n; c++) arr[c] = " ";
        break;
      }
      i += 1;
    }
    if (!jumped) {
      k += 1;
      col = 0;
    }
  }
  return new Map([...chars].map(([index, arr]) => [index, arr.join("")]));
}

/** Blank every comment span in a diff chunk's lines, replacing it with spaces
 * so line structure and character offsets are preserved. Language-aware: only
 * markers that are comments in the chunk file's language are blanked
 * (`commentMarkersFor`) — a `/*` in a shell file is a glob, not a comment, and
 * blanking it would hide the real code that follows. Quote-aware (a `#`,
 * `//`, or `--` inside a string literal is data, not a marker) and
 * block-aware, so a JSDoc continuation line — which carries no marker of its
 * own — is blanked along with the `/**` that opened it.
 *
 * Every rule here fails toward detection, because a false negative (a real
 * traversal hidden) is worse than a false positive (a prose mention fired):
 *   - a unified diff's `-` lines are the old file and its `+`/context lines are
 *     the new one, and each stream is blanked independently, so a removed
 *     line's `/*` can never blank an added line's code;
 *   - a line-comment marker must be a standalone token or follow a statement
 *     terminator (`commentMarkerAt`), so a CSS hex colour, a URL scheme, an
 *     escaped regex slash, and an unspaced floor division stay code;
 *   - a cross-line block is blanked only when its closer is found
 *     (`findBlockClose`), so a phantom opener cannot blank what follows, and
 *     the closer search takes the FIRST closing marker — quotes have no
 *     syntax inside a comment, so a quoted one still closes it;
 *   - a cross-line opener must look like a comment, not a glob (`build/*`,
 *     `src/*.py`, `rm -rf /*` — see `isBlockOpener`), because with a
 *     quote-agnostic closer a glob could pair with a later closing marker and
 *     blank the code in between;
 *   - only markers that are comments in the chunk file's language are blanked
 *     (`commentMarkersFor`); unknown types blank nothing, and languages whose
 *     marker placement is stricter than the shared rule (Tcl, Dockerfile `#`)
 *     blank nothing rather than guess;
 *   - commentFree is the SOLE comment authority: every downstream scan
 *     (lexical classes, fs evidence, operand extraction) consumes these
 *     comment-free lines and never re-interprets markers itself;
 *   - quote state is per-line, so a marker inside a string that spans lines —
 *     a heredoc body, a triple-quoted docstring — is still treated as a
 *     comment and blanks the rest of its line: a known, accepted limitation;
 *   - an unterminated quote is left as-is, so the rest of the line is still
 *     scanned rather than being swallowed as a comment. */
function blankCommentSpans(lines: string[], path: string | null): string[] {
  const markers = commentMarkersFor(path);
  const out = lines.slice();
  const streams = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const marker = diffMarker(line);
    const key = marker === "-" ? "-" : marker === "\u0000" ? "\u0000" : "+";
    const bucket = streams.get(key);
    if (bucket === undefined) streams.set(key, [index]);
    else bucket.push(index);
  });
  for (const indices of streams.values()) {
    for (const [index, text] of blankStream(lines, indices, markers)) out[index] = text;
  }
  return out;
}

function neutralizeChunkLines(commentFree: string[], path: string | null): string[] {
  /** Neutralize a diff chunk line by line, feeding each line its adjacent
   * comment-free neighbors for the one-hop untrusted-flow refusal. A
   * recognised self-location `readlink` (#1034) is blanked first. */
  const selfLocation = selfLocationReadlinkLines(commentFree, path);
  return commentFree.map((line, index) =>
    neutralizePathFalsePositives(
      selfLocation.has(index) ? blankSelfLocationReadlink(line) : line,
      index > 0 ? commentFree[index - 1] ?? "" : "",
      index + 1 < commentFree.length ? commentFree[index + 1] ?? "" : "",
    ),
  );
}

/** Material content signal classes: each entry is (signal class, patterns).
 * These are usage-shaped signals — a bare path-library import or API mention
 * matches none of them. Scanned per diff chunk over neutralized text. */
/** Lexical code-only material classes: identifier/path vocabulary that only
 * carries signal in EXECUTABLE source. Documentation files and comments
 * mention or describe these words (`# sanitize_path handles configured
 * paths`, `Use sanitize_path before opening files.`) without constructing
 * any path, so these classes are skipped for documentation-only files and
 * scanned over comment-stripped code text. Deliberately NOT a phrase
 * blacklist: the distinction is executable-vs-prose context. The remaining
 * content classes scan the same comment-free text (see blankCommentSpans), so
 * a mention that survives only inside a comment is discounted for every
 * class, not just these two — `diff_comment` in the provenance records it. */
const LEXICAL_CODE_ONLY_CLASSES = new Set<string>([
  "path_containment_or_sanitization",
  "path_reference_identifier",
]);

/** Documentation-only file types: prose, not executable source. */
const DOCUMENTATION_EXTENSIONS = [".md", ".rst", ".rest", ".txt", ".adoc"];

function isDocumentationPath(path: string): boolean {
  const lower = path.toLowerCase();
  return DOCUMENTATION_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Markdown documentation: the only file type whose prose the navigation-link
 * discount reads. The discount's syntax model — inline links, fenced code
 * blocks, inline code spans — is Markdown syntax. Other documentation types
 * (`rst`, `txt`, `adoc`) keep the ordinary scan and fail toward detection: a
 * Markdown-link-shaped string in an `.rst` file is literal text, not rendered
 * navigation (#1354). */
function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** #1354: an ordinary parent-relative Markdown navigation link
 * (`[Guide](../README.md)`) is repo-internal navigation in rendered
 * documentation, not a filesystem traversal surface. In DOCUMENTATION chunks
 * only, the `traversal_literal` scan view blanks the destination of a
 * Markdown inline link whose target is a relative path; everything else on
 * the line — including traversal prose in the link text — keeps its existing
 * semantics, and a suppressed destination is recorded as a discounted
 * `diff_nav_link` signal rather than silently dropped. Executable files keep
 * the unblanked view and fail toward detection: a quoted traversal literal
 * there fires even when it is Markdown-link-shaped. Scheme (`https:`),
 * protocol-relative (`//`), root-absolute (`/`) and fragment (`#`)
 * destinations are left as-is: they are not repo-internal navigation.
 *
 * The discount is a PROSE rule: it applies to rendered documentation text
 * only. A line inside a fenced code block, and a link-shaped match inside an
 * inline code span, are example/quoted code, not prose — they keep the
 * ordinary traversal semantics and fail toward detection (#1354).
 *
 * The discount is also a MARKDOWN rule: the syntax model above exists only in
 * Markdown, so it applies to Markdown documentation only. A link-shaped
 * string in another documentation type (`rst`, `txt`, `adoc`) is literal
 * text, not rendered navigation, and keeps its ordinary scan semantics.
 *
 * The blanked region is a DESTINATION, not the paren group: a group that
 * CommonMark does not read as a destination is not navigation either, and an
 * escaped `\[` is not a link opener at all. The label reads backslash escapes
 * too, so an escaped `\]` cannot close a label and start a link. See
 * `markdownDestinationSpan` and `escapedMarkdownLinkOpener`.
 *
 * Known limit of a diff-local Markdown view, accepted because reading it the
 * other way would cost the feature it exists for: an INDENTED code block and
 * a fence opened ABOVE the shown hunk are invisible here, so their link-shaped
 * content is read as prose. The exposed surface stays bounded to a traversal
 * inside a relative link destination — the exact shape this discount is for. */
const MARKDOWN_INLINE_LINK_PATTERN = /!?\[(?:[^\]\\]|\\.)*\]\([^)]*\)/g;

/** A Markdown fence line: an optional container prefix (a blockquote marker
 * or a list marker), then whitespace, then a run of 3 or more backticks or 3
 * or more tildes. The run's character and length are the fence's identity.
 *
 * The indentation limit is loose on purpose. CommonMark allows up to three
 * spaces of indent RELATIVE to the container, and the container's indent (a
 * list item, a blockquote) is not in the diff, so a fence nested in a list
 * can carry four spaces or more, and a fence can open on the same line as a
 * list bullet. Reading such a line as a fence keeps the block's content code,
 * which fails toward detection: a fence recognized too eagerly turns a
 * discount into a fired signal, never the other way round. */
const MARKDOWN_FENCE_PATTERN = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?\s*(`{3,}|~{3,})/;

/** The open fence of one diff stream. */
type MarkdownFence = { char: string; length: number };

function isRelativeNavigationDestination(destination: string): boolean {
  const unwrapped = destination.startsWith("<") && destination.endsWith(">")
    ? destination.slice(1, -1)
    : destination;
  if (unwrapped === "") return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(unwrapped)) return false;
  if (unwrapped.startsWith("//")) return false;
  if (unwrapped.startsWith("/")) return false;
  if (unwrapped.startsWith("#")) return false;
  return true;
}

/** Markdown's inline whitespace (CommonMark's blank characters, minus the
 * newlines a diff line cannot carry). */
function isMarkdownInlineBlank(char: string): boolean {
  return char === " " || char === "\t" || char === "\f" || char === "\r";
}

/** A C0 control character or DEL. Neither can appear in a destination, and a
 * line that carries one inside a link-shaped group is not rendered
 * navigation: the scan keeps firing (#1354, fail toward detection). */
function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** The destination inside an inline link's paren group, as [start, end)
 * offsets in the group text, or `null` when the group holds no destination.
 *
 * CommonMark: a destination is either the angle form, which carries no
 * unescaped blank or control character and ends at its `>`, or a run that
 * stops at the first blank character. What follows a destination is a title or
 * ordinary text — never a navigation target — so it is NOT blanked: the
 * traversal in `[Guide](guide.md "see ../../etc/passwd")` is a title, and the
 * traversal in `[a](see open("../../etc/passwd")` is code text in a group that
 * was never a destination at all (#1354).
 *
 * A backslash escapes nothing in the plain form: a raw blank ends the run
 * whether or not it is escaped, so `[a](../x\ ../../etc/passwd)` has the
 * destination `../x\` and the traversal after it keeps the scan — a link shape
 * whose destination ends at an escaped blank renders no link that could reach
 * outside the repo (#1354, fail toward detection). */
function markdownDestinationSpan(group: string): [number, number] | null {
  let start = 0;
  while (start < group.length && isMarkdownInlineBlank(group[start] ?? "")) start += 1;
  if (start >= group.length) return null;
  if (group[start] === "<") {
    for (let index = start + 1; index < group.length; index += 1) {
      const char = group[index] ?? "";
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === ">") return [start, index + 1];
      if (isMarkdownInlineBlank(char) || isControlCharacter(char)) return null;
    }
    return null;
  }
  let end = start;
  while (end < group.length) {
    const char = group[end] ?? "";
    if (isMarkdownInlineBlank(char)) break;
    if (isControlCharacter(char)) return null;
    end += 1;
  }
  return end > start ? [start, end] : null;
}

/** A `[` preceded by an odd number of backslashes is an escaped literal
 * bracket, not a link opener (CommonMark), so the link shape it starts is
 * literal text and keeps the ordinary scan (#1354). */
function escapedMarkdownLinkOpener(text: string, bracket: number): boolean {
  let backslashes = 0;
  for (let index = bracket - 1; index >= 0 && text[index] === "\\"; index -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function blankMarkdownNavDestinations(text: string): string {
  const codeSpans = inlineCodeSpans(text);
  return text.replace(MARKDOWN_INLINE_LINK_PATTERN, (...args: unknown[]) => {
    const match = args[0] as string;
    // The match offset is the second-to-last callback argument, because the
    // last one is the whole string. Reading it by position keeps this guard
    // correct if the link pattern ever gains a capture group, which would
    // otherwise shift the arguments and silence the code-span rule.
    const offset = args[args.length - 2] as number;
    // A link-shaped match that starts inside an inline code span is quoted
    // code, not a navigation link: it is left as-is, so the traversal literal
    // inside it keeps its ordinary semantics.
    if (codeSpans.some(([start, end]) => offset >= start && offset < end)) return match;
    // An escaped `\[` (or `\![`) opens no link, so nothing on its right is a
    // destination.
    const bracket = match.startsWith("!") ? offset + 1 : offset;
    if (escapedMarkdownLinkOpener(text, bracket)) return match;
    // The destination group is the paren group after the label's `]`: the
    // label itself may contain parentheses (`[docs (see ../x)](guide.md)`), so
    // the boundary is the `](` pair, not the first `(`.
    const open = match.lastIndexOf("](");
    const group = match.slice(open + 2, match.length - 1);
    const span = markdownDestinationSpan(group);
    if (span === null) return match;
    const destination = group.slice(span[0], span[1]);
    if (!isRelativeNavigationDestination(destination)) return match;
    return (
      match.slice(0, open + 2 + span[0]) +
      " ".repeat(span[1] - span[0]) +
      match.slice(open + 2 + span[1])
    );
  });
}

/** The inline code spans of a line, as [start, end) index ranges. A backtick
 * run opens a span and the NEXT run of EXACTLY the same length closes it; a
 * run with no such partner is literal text. The discount is a prose rule, so
 * a link-shaped match inside a code span is quoted code and keeps its
 * ordinary scan semantics — the code-span reading fails toward detection. */
function inlineCodeSpans(text: string): [number, number][] {
  const runs: { start: number; length: number }[] = [];
  const pattern = /`+/g;
  let match = pattern.exec(text);
  while (match !== null) {
    runs.push({ start: match.index, length: match[0].length });
    match = pattern.exec(text);
  }
  const spans: [number, number][] = [];
  let open: { start: number; length: number } | null = null;
  for (const run of runs) {
    if (open === null) {
      open = run;
      continue;
    }
    // A run of a different length cannot close the span: it is its content.
    if (run.length !== open.length) continue;
    spans.push([open.start, run.start + run.length]);
    open = null;
  }
  return spans;
}

/** One step of the Markdown fence state machine for a single diff stream: is
 * this line code, and what fence (if any) is open afterwards. With no open
 * fence, a fence-shaped line is an opener — but a BACKTICK fence whose info
 * string contains a backtick is not an opener (CommonMark), so it stays
 * ordinary content. With an open fence, a closer repeats the SAME character,
 * is at least as long as the opener's run, and has nothing but whitespace
 * after it; a fence-shaped line with the other character neither closes the
 * open fence nor opens a second one — it is ordinary content inside the open
 * fence, so the block stays open. */
function markdownFenceStep(
  content: string,
  open: MarkdownFence | null,
): { isCode: boolean; open: MarkdownFence | null } {
  const match = MARKDOWN_FENCE_PATTERN.exec(content);
  if (open === null) {
    if (match === null) return { isCode: false, open: null };
    const run = match[1] ?? "";
    const info = content.slice(match[0].length);
    if (run.startsWith("`") && info.includes("`")) return { isCode: false, open: null };
    return { isCode: true, open: { char: run[0] ?? "`", length: run.length } };
  }
  if (match === null) return { isCode: true, open };
  const run = match[1] ?? "";
  if (run[0] !== open.char || run.length < open.length) return { isCode: true, open };
  if (content.slice(match[0].length).trim() !== "") return { isCode: true, open };
  return { isCode: true, open: null };
}

/** Which chunk lines are Markdown PROSE, per line. A `+` line belongs to the
 * NEW file only, a `-` line to the OLD file only, and a context line to BOTH,
 * so one fence state is tracked per stream. A context line is prose only when
 * BOTH streams say prose: disagreement is read as code, the conservative
 * direction (more scrutiny, never fewer). A line with no diff marker (a hunk
 * header, an index line) is not content, and the fence state carries across
 * it, so a fence opened in one hunk still covers the next. The discount is a
 * prose rule: code contexts keep their ordinary scan and fail toward
 * detection. */
function markdownProseLines(lines: readonly string[]): boolean[] {
  // A line with no diff marker is not content, and it keeps the prose view:
  // git prints the section heading after the second `@@`, and that heading is
  // file text, so a navigation link in it is navigation like any other.
  const prose: boolean[] = new Array(lines.length).fill(true);
  let openNew: MarkdownFence | null = null;
  let openOld: MarkdownFence | null = null;
  lines.forEach((line, index) => {
    const marker = diffMarker(line);
    if (marker === "\u0000") return;
    const content = line.slice(1);
    let newCode = false;
    let oldCode = false;
    if (marker === "+" || marker === " ") {
      const step = markdownFenceStep(content, openNew);
      openNew = step.open;
      newCode = step.isCode;
    }
    if (marker === "-" || marker === " ") {
      const step = markdownFenceStep(content, openOld);
      openOld = step.open;
      oldCode = step.isCode;
    }
    prose[index] = !newCode && !oldCode;
  });
  return prose;
}

/** The symlink-operation class name, shared with `symlinkCodeView`, which
 * decides what counts as executable text for it (#1331). */
const SYMLINK_SENSITIVE_CLASS = "symlink_sensitive";

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
  // Symlink-sensitive filesystem operations. A recognised self-location
  // `readlink` (#1034) is blanked before this scan runs. Quoted text is inert
  // data for this class too (#1331), but through `symlinkCodeView`, which
  // recovers the executable command forms that live inside quote-shaped
  // syntax rather than dropping the whole span.
  [SYMLINK_SENSITIVE_CLASS, [
    /symlink|readlink|lstat|follow_symlinks|O_NOFOLLOW/i,
  ]],
  // Identifier-shaped path references (`filepath`) — variables and
  // identifiers named after the path they denote. More specific than the
  // removed `pathlib`/`os.path` mention patterns and kept deliberately.
  // `pathname` is handled separately below (PATHNAME_IDENTIFIER_PATTERN):
  // unlike `filepath`, it has a common non-filesystem meaning (a WHATWG
  // URL's `.pathname`, `location.pathname`) that is syntactically identical
  // to a path variable named `pathname` (#854/#871).
  ["path_reference_identifier", [/filepath/i]],
];

/** #871 follow-up: `pathname` alone (`url.pathname`, `const pathname = ...`)
 * is exactly as likely to be a WHATWG URL component as a filesystem path —
 * #854's false positive was `const pathname = base.pathname.replace(...)` in
 * a network client with no filesystem access at all. #749's own principle
 * ("path handling requires a real untrusted-PATH surface") says a bare
 * mention is not that surface. It only counts as the
 * path_reference_identifier signal when the same file/hunk ALSO shows
 * evidence of a filesystem/path-construction API — the same head vocabulary
 * PATH_CONSTRUCTION_HEADS recognizes (fs.*, path.join/resolve, open/fopen,
 * readFile, os.path.*, Path(...), send_file, shutil.*, ...). A file that
 * only ever touches URLs (#854's shape) never shows that evidence, so
 * `pathname` never fires there; a file that also does real path
 * construction keeps the signal. This is deliberately coarser than the
 * per-call operand scan used elsewhere (file-wide, not call-scoped) — it is
 * a permissive gate that only ever makes `pathname` fire LESS often, so the
 * imprecision only trades in the safe direction. */
const PATHNAME_IDENTIFIER_PATTERN = /\bpathname\b/i;

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

/** #871 follow-up: file-wide (not call-scoped) existence check for "this file
 * touches a filesystem/path-construction API somewhere" — see
 * PATHNAME_IDENTIFIER_PATTERN above. Built from the same head vocabulary as
 * PATH_CONSTRUCTION_HEADS but as a fresh, non-global regex (a `.test()` used
 * for existence-only, never `matchAll`, so no `lastIndex` state to leak
 * across calls, unlike PATH_CONSTRUCTION_HEAD_PATTERNS above). */
const FS_API_EVIDENCE_PATTERN = new RegExp(
  PATH_CONSTRUCTION_HEADS.map(([head]) => `(?:${head})\\s*\\(`).join("|"),
  "i",
);

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
  // #871 follow-up: a WHATWG URL's `.pathname` (or `.pathname =`) is an
  // untrusted URL component exactly like `.filename` is an untrusted upload
  // name — real when it reaches a filesystem/path-construction call
  // (`path.join(root, url.pathname)`), bookkeeping-adjacent noise otherwise.
  // Property-access-only, like `.filename` above: a bare `pathname`
  // identifier is not itself proof of an untrusted URL component.
  /\.\s*pathname\b/i,
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

function symlinkSample(
  raw: string,
  ownLine: string,
  view: string,
  patterns: readonly RegExp[],
): string {
  /** #1335: the symlink view can match a run CARRIED from a following line —
   * an exec call's argument list past the line break, or argv moved one
   * element per line — where the line being scanned alone would record an
   * excerpt that never contains the matched token (the pre-#1331 scan
   * sampled the argv line itself, because that line matched on its own).
   * The excerpt is redirected to the carried run ONLY when the scanned line
   * cannot explain the hit itself: neither its comment-free text nor its
   * stripped view (the first segment of the view, which `symlinkCodeView`
   * joins with newlines) matches. Same-line recovery — a backtick, a
   * command substitution, an argv-position quoted token on the line —
   * therefore keeps sampling the raw line, whose excerpt already shows both
   * the token and the construct that fired; redirecting there would drop
   * the diff marker and leave a bare token that reads like the inert
   * value-position form #1331 just stopped firing. The redirected excerpt
   * obeys the same bounds and sanitization as every other sample. Firing,
   * attribution, and the discount branches are untouched: sample text only. */
  const [own, ...carried] = view.split("\n");
  if (
    carried.length > 0 &&
    !matchesAny(own ?? "", patterns) &&
    !matchesAny(ownLine, patterns)
  ) {
    for (const run of carried) {
      if (matchesAny(run, patterns)) return pathSample(run);
    }
  }
  return pathSample(raw);
}

/** Lexical view of a line for the code-only material classes: every quoted
 * span is removed (quote chars doubled, contents dropped — string contents,
 * interpolation included, are data, not code identifiers). Comments are NOT
 * handled here: the comment-free lines from `blankCommentSpans` are the sole
 * comment authority, so this runs only on text that has already been through
 * them. Keeping the quote characters is what makes removal non-adjacent, so
 * stripping can never spell a token that was not already there; that guarantee
 * is what the #1331 containment argument below relies on, and the span rule is
 * shared with `quotedSpanEnd`. */
function stripQuotedSpans(line: string): string {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i] ?? "";
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = quotedSpanEnd(line, i);
      out.push(ch + ch);
      i = close === null ? n : close + 1;
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/** #1331 exec-call heads: a call that EXECUTES text, so what it executes as
 * command text is recovered from its argument list even where it contains
 * prose-shaped whitespace. Two branches: an unambiguous command verb in ANY
 * position (`exec`, Go `exec.Command`, Java `Runtime.getRuntime().exec`,
 * `system`, `spawn…`, Ruby `Open3.capture*`), and a generic verb (`run`,
 * `call`, `check_output`, `Popen`) only behind a known exec module —
 * recognizing any `run(` would donate arbitrary prose. #1334 review round 4
 * names `popen` and `shell_exec` explicitly so a shell-string executor's
 * command string is recovered wherever it is spelled (the `Popen` branch
 * already covered `os.popen` case-insensitively; the bare spellings of both
 * heads did not match at all). Global: every exec call on a line contributes
 * the command text it executes. */
const EXEC_ARGV_HEAD_PATTERN = new RegExp(
  String.raw`(?:`
    + String.raw`(?:^|[^\w$])(?:exec|execl|execle|execlp|execv|execve|execvp|execvpe|execSync|execFile(?:Sync)?|system|popen|shell_exec|spawn\w*|command(?:Sync)?|capture\w*)`
    + String.raw`|\b(?:subprocess|child_process|execa|os|open3|syscall)\s*\.\s*(?:run|call|check_call|check_output|getoutput|getstatusoutput|Popen|exec\w*|spawn\w*|command(?:Sync)?|capture\w*)`
    + String.raw`)\s*\(`,
  "gi",
);

/** File types for which a backtick opens a STRING rather than a command: the
 * JavaScript family. Everywhere else this classifier reaches a backtick is
 * command substitution (shell, Ruby, Perl), and an unknown or extensionless
 * type recovers too — mistaking a shell substitution for a template literal
 * would hide a real operation, which is the wrong direction to fail in. */
const TEMPLATE_LITERAL_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "json", "json5",
]);

/** File types whose quoted strings NEVER execute shell command substitution
 * while being evaluated: in these languages `$(...)` inside a quoted span is
 * inert data (#1331 review: Python `message = "$(readlink $1)"` must not
 * fire). The languages that DO evaluate `$(...)` at string-evaluation time —
 * the shell family and PowerShell — are not listed; nor are YAML, Makefile
 * and Dockerfile, whose string content is routinely handed to a shell
 * (JSON stays listed, following the backtick precedent already set in
 * `TEMPLATE_LITERAL_EXTENSIONS` — a data format whose strings are inert), and
 * an unknown or extensionless type recovers too — mistaking a shell
 * substitution for inert string data would hide a real operation, which is
 * the wrong direction to fail in. A string that a listed language passes
 * to a shell is still recovered by the exec-argument rule, which is
 * language-agnostic. */
const COMMAND_SUBSTITUTION_INERT_EXTENSIONS = new Set([
  ...TEMPLATE_LITERAL_EXTENSIONS,
  "py", "pyi", "pyw", "rb", "rake", "pl", "pm", "php", "go", "rs",
  "java", "kt", "kts", "scala", "swift", "cs", "c", "h", "cc", "cpp",
  "cxx", "hpp", "hh", "hxx", "m", "mm", "lua", "dart", "ex", "exs",
  "erl", "hrl", "hs", "jl", "r", "sql", "tcl", "vb",
]);

/** Bounds on the #1331 recovery work, because the scanned text is
 * attacker-controlled diff content. A line longer than the first bound scans
 * as the pre-#1331 view (detection kept, recovery not paid for); at most this
 * many characters are recovered per line, shared with an argument list carried
 * across lines; and at most this many exec calls per line contribute. Without
 * them, a single minified or hostile line of repeated unclosed `exec(` turns
 * the per-head walk into O(calls × line length) per line. */
const MAX_SYMLINK_SCAN_LINE_CHARS = 4000;
const MAX_SYMLINK_RECOVERED_CHARS = 4000;
const MAX_EXEC_HEADS_PER_LINE = 8;

/** Index of the quote that closes the span opening at `start`, or null when
 * it never closes. THE shared span rule: `stripQuotedSpans`, the argv-token
 * scan and the quote-aware paren walk must agree on where a string ends. */
function quotedSpanEnd(text: string, start: number): number | null {
  const quote = text[start] ?? "";
  let j = start + 1;
  while (j < text.length) {
    const ch = text[j] ?? "";
    if (ch === "\\" && j + 1 < text.length) {
      j += 2;
      continue;
    }
    if (ch === quote) return j;
    j += 1;
  }
  return null;
}

/** The quoted spans of `text` as RAW slices (escapes left as written, an
 * unterminated quote yields the remainder) with their open index and close
 * index (null when the span never closes), so a caller can judge the
 * position a span occupies. Rawness is what keeps the containment guarantee
 * of `symlinkCodeView` honest: a word that only exists once escapes are
 * unwrapped (`"sym\link"`) is not a signal. */
function quotedSpans(text: string): { text: string; open: number; close: number | null }[] {
  const spans: { text: string; open: number; close: number | null }[] = [];
  for (let i = 0; i < text.length; i++) {
    const quote = text[i];
    if (quote !== "'" && quote !== '"' && quote !== "`") continue;
    const close = quotedSpanEnd(text, i);
    spans.push({ text: text.slice(i + 1, close ?? text.length), open: i, close });
    if (close === null) break;
    i = close;
  }
  return spans;
}

/** Whether the whitespace-free quoted span opening at `open` (closing at
 * `close`, null when unterminated) sits where an argv/path TOKEN lives
 * (#1331 review: whitespace-free alone does not make quoted prose a token —
 * `raise RuntimeError("symlink")` is a diagnostic value). It does when it is
 * in list-element position — preceded by `[` or `,`, or followed by `,`
 * (`["readlink", user_path]` at any nesting or line break,
 * `exec.Command("readlink", p)`). The sole argument of a call, even carried
 * to its own line by the formatter, is a value, not an argv element, and
 * stays inert; an argument that is NOT the sole one (`log("symlink",
 * level)`) keeps the token, the toward-detection direction. #1334 review
 * round 4 retired the earlier path-shaped rule (any span containing `/`): a
 * quoted constant path in non-argv position (`bin_path = "/usr/bin/readlink"`)
 * is trusted constant-path scaffolding — no execution, no untrusted source —
 * and the normative rule requires a real untrusted-path surface, so being
 * path-shaped adds nothing that list-element position does not already cover.
 * Exec calls recover their command text independently, so dropping
 * value-position tokens cannot hide a shell-string executor or an
 * interpreter operand. */
function isArgvPathTokenPosition(line: string, open: number, close: number | null): boolean {
  let j = open - 1;
  while (j >= 0 && (line[j] === " " || line[j] === "\t")) j -= 1;
  const prev = line[j];
  if (prev === "[" || prev === ",") return true;
  let k = (close ?? line.length - 1) + 1;
  while (k < line.length && (line[k] === " " || line[k] === "\t")) k += 1;
  return line[k] === ",";
}

/** Quote-aware paren walk: the index of the `)` that brings `depth` to zero
 * (null when the text ends with the call still open) plus the depth the text
 * leaves behind, so a caller can continue on the next line. A paren inside a
 * quoted span is command text rather than call structure, so
 * `["bash", "-c", "echo )", "readlink -f x"]` never closes the call early. */
function scanCallDepth(text: string, depth: number, start = 0): { close: number | null; depth: number } {
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = quotedSpanEnd(text, i);
      i = close === null ? text.length : close;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth <= 0) return { close: i, depth };
    }
  }
  return { close: null, depth };
}

/** The argument-list text of an exec call whose `(` is still open at the end
 * of `index`: the opening line's remainder plus the following lines up to the
 * balanced closer, within `MAX_CONSTRUCTION_CONTINUATION_LINES` — the same
 * bound `constructionOperandSpans` gives an open construction call — and
 * within `maxChars`, so the walk stays bounded even when the closer never
 * comes. Auto-formatted argv is therefore still read as the call's content. */
function openCallArgumentText(
  lines: string[],
  index: number,
  argsStart: number,
  maxChars: number,
): string {
  let depth = 1;
  let size = 0;
  const parts: string[] = [];
  const limit = Math.min(lines.length, index + 1 + MAX_CONSTRUCTION_CONTINUATION_LINES);
  for (let i = index; i < limit; i++) {
    const text = (lines[i] ?? "").slice(i === index ? argsStart : 0);
    const scanned = scanCallDepth(text, depth);
    depth = scanned.depth;
    parts.push(scanned.close === null ? text : text.slice(0, scanned.close));
    size += text.length;
    if (scanned.close !== null || size >= maxChars) break;
  }
  return parts.join("\n");
}

/** #1334 review: heads whose FIRST argument is a shell command STRING rather
 * than an argv list — `os.system`/`popen`, `subprocess.getoutput`/
 * `getstatusoutput`, `shell_exec`, Ruby `Open3.capture*`, and the Node
 * spellings (`exec`, `execSync`, anything `execa.*`) whose string argument is
 * handed to a shell. The list-form `subprocess` heads (`run`, `call`,
 * `check_*`, `Popen`) count only behind an explicit `shell=True`/`shell:
 * true` marker: without it the first argument is the program name or a
 * staged-command variable, and reading a whitespace-containing string there
 * as command text would re-admit exactly the inert prose this class just
 * stopped firing. `execFile`/`spawn` stay argv: their string arguments are
 * operands, and Node `spawn` never invokes a shell. */
const SHELL_STRING_MARKER_PATTERN = /\bshell\s*[=:]\s*(?:True|true)\b/;

function isShellStringHead(callee: string, args: string): boolean {
  const last = callee.split(".").pop()?.trim() ?? "";
  if (last === "popen") return true;
  if (/^(?:system|getoutput|getstatusoutput|shell_exec|execa|exec|execSync|capture\w*)$/i.test(last)) return true;
  if (/^(?:run|call|check_call|check_output|Popen)$/i.test(last)) {
    return SHELL_STRING_MARKER_PATTERN.test(args);
  }
  return /^execa\./i.test(callee);
}

/** Programs whose argv turns a following flag's argument into executed
 * command text: the shell family plus the Windows interpreters. */
const SHELL_INTERPRETER_TOKENS = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh", "fish", "cmd", "powershell", "pwsh",
]);

function isShellInterpreterToken(token: string): boolean {
  const base = token.replace(/\.exe$/i, "").split("/").pop() ?? "";
  return SHELL_INTERPRETER_TOKENS.has(base.toLowerCase());
}

/** An interpreter command token anywhere in the argument list before the
 * flag — bare or quoted, path-prefixed (`/bin/sh`) — so a wrapper argv
 * (`["timeout", "5", "bash", "-c", …]`, `["sudo", "bash", "-c", …]`) still
 * hands its flag's operand to an interpreter (#1334 review round 3). */
function hasInterpreterToken(args: string): boolean {
  for (const { text } of quotedSpans(args)) {
    if (isShellInterpreterToken(text.trim())) return true;
  }
  return /\b(?:sh|bash|dash|zsh|ksh|csh|tcsh|fish|cmd|powershell|pwsh)\b/i.test(stripQuotedSpans(args));
}

/** The interpreter flags whose argument is a command line (`sh -c`,
 * `cmd /c`, PowerShell `-Command`). The flag may be a quoted argv element
 * (`"-c"`), which is consumed whole so the remainder after it starts outside
 * the string; the bare spelling carries no quote context and can match
 * inside string data — a toward-detection direction, still a raw slice.
 * Matched only inside already-recovered command contexts and
 * behind a recognized interpreter token — at the raw line level `-c` is
 * ambiguous (`grep -c "symlink"` counts matches, it executes nothing), so
 * the line-level scan never elevates on it. */
const INTERPRETER_FLAG_PATTERN =
  /(?:^|(?<=[^\w-]))(?:"(?:-c|\/c|-Command)"|'(?:-c|\/c|-Command)'|-c|\/c|-Command)(?![\w-])/i;

/** Bound on command-text recovery nesting: a line's executed command strings
 * are the first execution level below it, and a command string's own
 * interpreter flags are the second. Deeper nesting keeps only the unwrapped
 * text's quoted-data-stripped view, which can only fire. */
const MAX_COMMAND_RECOVERY_DEPTH = 2;

/** First top-level argument of an argument-list text: up to the first comma
 * no bracket, brace or quoted span shelters, so `["a", "b"]` and
 * `"cmd" + p` stay one argument while `os.popen(cmd, "r")` splits. */
function firstTopLevelArg(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const close = quotedSpanEnd(args, i);
      i = close === null ? args.length : close;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth <= 0) return args.slice(0, i);
      depth -= 1;
    } else if (ch === "," && depth <= 0) return args.slice(0, i);
  }
  return args;
}

/** The code view of text a call executes as a shell command: the host-level
 * quoted spans are the boundary between the host language and the command
 * line, so their CONTENTS are the command text and are unwrapped; inside the
 * command line the same quoted-data rule applies one level down — quoted
 * prose stays inert (`echo 'too many symlink levels'` executes no symlink
 * operation), while command substitution and backticks are evaluated by the
 * shell that receives the text regardless of the host file kind. At the
 * depth cap only the unwrapped text's quoted-data-stripped view is kept —
 * the quote stays the data marker at every level (#1334 review round 3:
 * keeping raw text there let quoted prose fire again one nesting level
 * down). */
function commandTextView(text: string, depth: number, keep: (part: string) => void): void {
  let unwrapped = "";
  let last = 0;
  for (const { text: content, open, close } of quotedSpans(text)) {
    unwrapped += `${text.slice(last, open)}\n${content}\n`;
    last = close === null ? text.length : close + 1;
  }
  unwrapped += text.slice(last);
  keep(depth >= MAX_COMMAND_RECOVERY_DEPTH ? stripQuotedSpans(unwrapped) : symlinkCodeView([unwrapped], 0, true, true, depth));
}

/** #1331 code view for the symlink class: quoted text is inert DATA, so a
 * diagnostic string (`raise SystemExit("too many symlink levels")`,
 * `echo "too many symlink levels" >&2`) stops creating path-handling
 * scrutiny — while the executable shapes that merely LOOK quoted are recovered
 * explicitly, which is what the issue requires instead of a blanket
 * `stripQuotedSpans`:
 *   - a whitespace-free quoted span in ARGV/PATH-TOKEN position is a token,
 *     never prose: in list-element position — preceded by `[`/`,` or
 *     followed by `,` (`["readlink", user_path]` at any nesting or line
 *     break, `exec.Command("readlink", p)`); a whitespace-free span in VALUE
 *     position — the sole argument of a call, `raise
 *     RuntimeError("symlink")` — is diagnostic data and stays inert
 *     (#1331 review); a quoted constant path in non-argv position
 *     (`bin_path = "/usr/bin/readlink"`) is trusted constant-path
 *     scaffolding and stays inert too (#1334 review round 4 retired the
 *     path-shaped rule — an untrusted-path surface is required);
 *   - a command substitution executes its contents, quoted or not, in the
 *     file kinds whose language evaluates it: `target="$(readlink "$1")"`
 *     in shell (and PowerShell), gated by
 *     `COMMAND_SUBSTITUTION_INERT_EXTENSIONS` (#1331 review: a Python string
 *     such as `message = "$(readlink $1)"` is inert data); outside the
 *     JavaScript family the backtick spelling too (shell, Ruby, Perl,
 *     extensionless scripts);
 *   - what a call EXECUTES as command text is recovered, not its whole
 *     argument list (#1334 review: `subprocess.check_output(["echo",
 *     "too many symlink levels"])` passes prose to echo — operand data): the
 *     first argument of a shell-string executor (`os.system`,
 *     `subprocess.getoutput`, Node `exec`, `execa.*`, list-form
 *     `subprocess` heads behind `shell=True`) is unwrapped to the command
 *     line it carries, an interpreter argv (`["bash", "-c", …]`) recovers
 *     its `-c` operand, and a whitespace-free first argument is the command
 *     token (`subprocess.run("readlink")`); within recovered command text
 *     the same quoted-data rule applies one level down, with substitution
 *     and backticks evaluated because the receiving context is a shell;
 * CONTAINMENT: every scanned run is a raw slice of this line or of this
 * call's own argument list, and runs are never concatenated adjacently
 * (`stripQuotedSpans` keeps the quote characters, recovered runs are joined
 * with newlines, unwrapped command contents are carried on their own
 * lines), so the class's match set stays a SUBSET of the pre-#1331 chunk
 * scan — a carried argument list is text of a following line that scan
 * already read unquoted. The precision correction can drop signals but
 * cannot invent one.
 * DECLARED LIMITS, all in the concealment direction: whitespace-containing
 * quoted text behind a call `EXEC_ARGV_HEAD_PATTERN` does not recognize
 * (`runner.run("readlink -f " + p)`, pinned in the tests) — the same rule
 * covers PowerShell `Invoke-Expression "readlink -f $p"`, a whitespace-
 * containing command string behind a list-form exec head with no shell
 * marker (`subprocess.run("readlink -f x")`; the `shell=True` spelling
 * still fires), an argv list staged in a whitespace-containing variable
 * before `subprocess.run(args)` (a whitespace-free staged list is a
 * `[`-position token and still fires), and a shell command staged the same
 * way — bare or whitespace-containing — and invoked later as `$cmd`, since
 * linking those statements is the taint tracking this model refuses to be
 * (`cmd = "readlink"` no longer fires: a value-position token is prose, so
 * a staged command reads like one); a whitespace-free span that is the sole
 * argument of a non-exec call, on the line or carried to its own line by
 * the formatter (`runner.run("readlink")`); and — the concealment family
 * the unrecognized-head rule already declared, widened by the
 * value-position rule — a whitespace-free quoted command word inside a
 * whitespace-separated argv the head pattern does not name
 * (`sudo "readlink" "$1"`, `find . -exec "readlink" {} \;`): list-element
 * position is comma-modeled, so shell-style whitespace argv conceals it —
 * and comma-modeled position also keeps a whitespace-free single-word
 * operand of a non-symlink program (`["echo", "readlink"]`) firing, since
 * argv tokens are position-modeled, not program-modeled; the tail of an
 * open exec call longer than `MAX_CONSTRUCTION_CONTINUATION_LINES` or
 * `MAX_SYMLINK_RECOVERED_CHARS`; the `(MAX_EXEC_HEADS_PER_LINE + 1)`-th exec
 * call of one line, which cannot contribute once its predecessors consumed
 * the head budget — predecessors that, since round 4 names `popen` and
 * `shell_exec` explicitly, include quoted prose that merely mentions a head
 * spelling (eight `log("popen(x)")` calls starve a real exec call later on
 * the line), a widening of this declared family the explicit spellings
 * bought; command text nested deeper than
 * `MAX_COMMAND_RECOVERY_DEPTH`, kept only as their quoted-data-stripped
 * view; a line
 * longer than `MAX_SYMLINK_SCAN_LINE_CHARS`, which keeps the pre-#1331 view
 * without the recovery; and a word that only exists after escapes are
 * unwrapped — which also keeps escaped INNER quotes
 * (`os.system("sh -c 'echo \"too many symlink levels\"'")`) visible one
 * nesting level down, since span pairing is lexical and unescaping escapes
 * to repair it would invent exactly such words. Unquoted words inside an
 * executed command string
 * (`os.system("echo too many symlink levels")`) still fire — unquoted text
 * was always code-level in the pre-#1331 scan, and the quote is the data
 * marker at every execution level. Comments are handled upstream:
 * `blankCommentSpans` is the sole comment authority. */
function symlinkCodeView(
  lines: string[],
  index: number,
  backtickIsCommand: boolean,
  substitutionIsCommand: boolean,
  depth = 0,
): string {
  const line = lines[index] ?? "";
  // A minified, generated or hostile over-long line keeps the pre-#1331 view:
  // scanning it as-is can only fire, and the per-head walks below stay bounded.
  if (line.length > MAX_SYMLINK_SCAN_LINE_CHARS) return line;
  const recovered: string[] = [];
  let budget = MAX_SYMLINK_RECOVERED_CHARS;
  const keep = (text: string): void => {
    if (text === "" || budget <= 0) return;
    recovered.push(text.length <= budget ? text : text.slice(0, budget));
    budget -= Math.min(text.length, budget);
  };
  for (let i = 0; i < line.length && budget > 0; i++) {
    if (substitutionIsCommand && line[i] === "$" && line[i + 1] === "(") {
      const { close } = scanCallDepth(line, 1, i + 2);
      keep(line.slice(i + 2, close ?? line.length));
      if (close === null) break;
      i = close;
      continue;
    }
    if (backtickIsCommand && line[i] === "`") {
      const close = quotedSpanEnd(line, i);
      keep(line.slice(i + 1, close ?? line.length));
      if (close === null) break;
      i = close;
    }
  }
  let heads = 0;
  for (const head of line.matchAll(EXEC_ARGV_HEAD_PATTERN)) {
    if (heads >= MAX_EXEC_HEADS_PER_LINE || budget <= 0) break;
    heads += 1;
    const argsStart = head.index + head[0].length;
    const { close } = scanCallDepth(line, 1, argsStart);
    const args = close === null
      ? openCallArgumentText(lines, index, argsStart, budget)
      : line.slice(argsStart, close);
    // #1334 review: only what the call executes as command text is
    // recovered. A shell-string executor's first argument IS the command
    // line; an argv call contributes its command token and — when an
    // interpreter token precedes the command flag (#1334 review round 3:
    // wrappers such as `["timeout", "5", "bash", "-c", …]` count) — the
    // flag's command operand, never its operand arguments.
    const callee = head[0].replace(/\s*\($/, "").replace(/^[^\w$]+/, "");
    if (isShellStringHead(callee, args)) {
      commandTextView(firstTopLevelArg(args), depth + 1, keep);
      continue;
    }
    const commandSpan = quotedSpans(args)[0];
    if (commandSpan) {
      const token = commandSpan.text.trim();
      if (!/\s/.test(token)) keep(token);
    }
    if (depth < MAX_COMMAND_RECOVERY_DEPTH) {
      const flag = INTERPRETER_FLAG_PATTERN.exec(args);
      if (flag && hasInterpreterToken(args.slice(0, flag.index))) {
        commandTextView(args.slice(flag.index + flag[0].length), depth + 1, keep);
      }
    }
  }
  for (const { text: span, open, close } of quotedSpans(line)) {
    const token = span.trim();
    if (token !== "" && !/\s/.test(token) && isArgvPathTokenPosition(line, open, close)) {
      keep(token);
      continue;
    }
    // Inside an already-recovered command line, a quoted span directly after
    // an interpreter's command flag is that flag's command operand
    // (`os.system("sh -c 'readlink -f x'")`) — executed text, not data. The
    // word before the flag must name the interpreter (#1334 review round 3:
    // `grep -c "…"`, `cut -c "…"` count or cut, they execute nothing). At
    // the raw line level `-c` never elevates: it is ambiguous there.
    if (depth >= 1 && depth < MAX_COMMAND_RECOVERY_DEPTH) {
      const before = line.slice(Math.max(0, open - 16), open).replace(/[ \t]+$/, "");
      if (/(?:^|[^\w.-])(?:-c|\/c|-Command)$/i.test(before)) {
        const word = (before
          .replace(/(?:-c|\/c|-Command)$/i, "")
          .replace(/[ \t]+$/, "")
          .split(/\s+/)
          .pop() ?? "").replace(/^[^\w./]+/, "");
        if (isShellInterpreterToken(word)) {
          commandTextView(span, depth + 1, keep);
        }
      }
    }
  }
  const code = stripQuotedSpans(line);
  return recovered.length === 0 ? code : `${code}\n${recovered.join("\n")}`;
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
 * comments (already blanked in the comment-free lines this consumes —
 * `blankCommentSpans` is the sole comment authority) and sibling statements
 * after the closer are excluded, and nested parentheses are tracked so an
 * inner `)` never ends the scan while outer operands remain. Static quoted
 * literals are stripped before extraction. Empty string when the line
 * constructs no path. */
function constructionOperandSpans(lines: string[], index: number): string {
  const line = stripStaticStringLiterals(lines[index] ?? "");
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
          const continuation = stripStaticStringLiterals(lines[j] ?? "");
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
            operand += "/" + divisionOperand(line.slice(tailEnd));
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
  source: "filename" | "diff" | "diff_test_file" | "filename_test_file" | "diff_comment" | "diff_nav_link";
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
 * fired, and which signals were deliberately discounted: test-file backing
 * (`diff_test_file` / `filename_test_file`), prose mentions that survive
 * only inside a comment (`diff_comment`, #960), and parent-relative Markdown
 * navigation link destinations (`diff_nav_link`, #1354). */
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
    // A headerless chunk has no language of its own; fall back to the single
    // changed file when there is exactly one, and blank nothing otherwise.
    const chunkPath = chunkFile ?? (filenames.length === 1 ? filenames[0] ?? null : null);
    const commentFree = blankCommentSpans(lines, chunkPath);
    const neutralized = neutralizeChunkLines(commentFree, chunkPath);
    const isTest =
      chunkFile !== null ? isTestPath(chunkFile) : allFilesAreTests;
    const buckets = isTest ? discountedBuckets : firedBuckets;
    const source: PathHandlingSignal["source"] = isTest ? "diff_test_file" : "diff";

    // Documentation-only chunks carry no executable context. A headerless
    // chunk is treated like the test discount: docs-skip only when EVERY
    // changed file is documentation; mixed or unknown sets stay
    // conservative (lexical classes still scan).
    const isDocumentation =
      chunkFile !== null
        ? isDocumentationPath(chunkFile)
        : filenames.length > 0 && filenames.every((name) => isDocumentationPath(name));

    // #1354: the navigation-link discount is a PROSE rule and a MARKDOWN
    // rule, so it applies only to Markdown prose lines. Fenced example
    // content is code and keeps the ordinary traversal semantics; other
    // documentation types keep the ordinary scan entirely.
    const navLinkMarkdown =
      chunkFile !== null
        ? isDocumentationPath(chunkFile) && isMarkdownPath(chunkFile)
        : filenames.length > 0 &&
          filenames.every((name) => isDocumentationPath(name) && isMarkdownPath(name));
    const proseLines = navLinkMarkdown ? markdownProseLines(lines) : null;

    // #1331: a backtick opens a command substitution except in the JavaScript
    // family; `$(...)` executes only where the language evaluates it at
    // string-evaluation time (shell family, PowerShell — see
    // COMMAND_SUBSTITUTION_INERT_EXTENSIONS). A chunk with no file type of
    // its own recovers for both, because unknown state must fail toward
    // detection rather than read a substitution as a template literal.
    const backtickIsCommand =
      chunkPath === null || !TEMPLATE_LITERAL_EXTENSIONS.has(fileKindToken(chunkPath));
    const substitutionIsCommand =
      chunkPath === null || !COMMAND_SUBSTITUTION_INERT_EXTENSIONS.has(fileKindToken(chunkPath));

    for (const [className, patterns] of PATH_HANDLING_CONTENT_CLASSES) {
      const codeOnly = LEXICAL_CODE_ONLY_CLASSES.has(className);
      if (codeOnly && isDocumentation) continue;
      // Each class gets its own view of the same comment-free text: the
      // lexical classes drop every quoted span, the symlink class drops them
      // only where they are inert data (#1331), the rest scan as-is.
      const symlinkClass = className === SYMLINK_SENSITIVE_CLASS;
      const traversalClass = className === "traversal_literal";
      const navLinkScope = traversalClass && proseLines !== null;
      let fired = false;
      for (let index = 0; index < neutralized.length; index++) {
        const raw = lines[index] ?? "";
        // commentFree is the sole comment authority; the code views only
        // additionally handle quoted spans.
        const base = neutralized[index] ?? "";
        // #1354: the navigation-link discount applies to Markdown prose
        // lines only. A fenced or inline-code line scans unblanked, exactly
        // like an executable file, and so does a non-Markdown documentation
        // file.
        const prose = proseLines === null ? false : (proseLines[index] ?? false);
        const scanLine = codeOnly
          ? stripQuotedSpans(base)
          : symlinkClass
            ? symlinkCodeView(neutralized, index, backtickIsCommand, substitutionIsCommand)
            : navLinkScope && prose
              ? blankMarkdownNavDestinations(base)
              : base;
        if (matchesAny(scanLine, patterns)) {
          if (!fired) {
            recordSignal(
              buckets,
              className,
              source,
              chunkFile,
              symlinkClass
                ? symlinkSample(raw, commentFree[index] ?? "", scanLine, patterns)
                : pathSample(raw),
            );
            fired = true;
          }
          continue;
        }
        // #1354: a hit that survives outside comments but is suppressed only
        // by the navigation-link view is a Markdown nav destination, not a
        // traversal literal. Record it as discounted (never fired, never
        // silently dropped) so the decision is explainable from the artifact
        // alone. A code line is not prose: it must fire, not be discounted.
        if (
          navLinkScope && prose &&
          matchesAny(commentFree[index] ?? "", patterns) &&
          !matchesAny(blankMarkdownNavDestinations(commentFree[index] ?? ""), patterns)
        ) {
          recordSignal(discountedBuckets, className, "diff_nav_link", chunkFile, pathSample(raw));
          continue;
        }
        // #960: a hit that survives in the raw line but is gone once comments
        // are blanked is a prose mention, not a path surface. Record it as
        // discounted (never fired) so the neutralization is explainable from
        // the artifact alone, and so a future false positive is diagnosable
        // without reading classifier internals.
        if (matchesAny(commentFree[index] ?? "", patterns)) continue;
        if (matchesAny(raw, patterns)) {
          recordSignal(discountedBuckets, className, "diff_comment", chunkFile, pathSample(raw));
        }
      }
    }

    // #871 follow-up: `pathname` alone only counts as the
    // path_reference_identifier signal when this file/hunk also shows
    // filesystem/path-construction API evidence — otherwise it is exactly
    // as likely to be a WHATWG URL component (`url.pathname`,
    // `location.pathname`) as a filesystem path variable (#854/#749).
    if (!isDocumentation) {
      const fsEvidence = lines.some((_line, index) =>
        FS_API_EVIDENCE_PATTERN.test(stripQuotedSpans(commentFree[index] ?? "")),
      );
      if (fsEvidence) {
        for (let index = 0; index < neutralized.length; index++) {
          const scanLine = stripQuotedSpans(neutralized[index] ?? "");
          if (!PATHNAME_IDENTIFIER_PATTERN.test(scanLine)) continue;
          recordSignal(buckets, "path_reference_identifier", source, chunkFile, pathSample(lines[index] ?? ""));
          break;
        }
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
      const flowText = constructionOperandSpans(commentFree, index);
      if (!flowText) continue;
      if (matchesAny(flowText, UNTRUSTED_SOURCE_PATTERNS)) {
        recordSignal(buckets, "untrusted_source_join", source, chunkFile, pathSample(rawLine));
        continue;
      }
      for (const adjIndex of [index - 1, index + 1]) {
        if (adjIndex < 0 || adjIndex >= lines.length) continue;
        const target = untrustedAssignmentTarget(commentFree[adjIndex] ?? "");
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
function isPathHandling(files: readonly ChangedFile[], diffText: string): boolean {
  return evaluatePathHandlingSignals(files.map((file) => file.filename), diffText).fired.length > 0;
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
  /** #871: true when the PR's non-test source footprint is substantial — a
   * new non-test source module, or non-test source lines changed over
   * SUBSTANTIAL_SOURCE_LINE_THRESHOLD. role-selection forces the correctness
   * lane on this regardless of pr_kind, so a content-only file_serving/
   * path_handling match (too weak to route, per routeSignals) cannot also
   * be the sole reason correctness gets skipped on a real, sizable change.
   * Deliberately NOT part of `classificationToArtifact`'s persisted shape:
   * v2 has no equivalent field, and the artifact must remain byte-identical
   * to v2. Tests pin that serialized shape. The production run instead
   * threads this signal to the specialists gate via
   * the `SUBSTANTIAL_CODE_CHANGE` env var (see run/review.ts and
   * gates/specialists-gate.ts), entirely outside classification.json. */
  substantialCodeChange: boolean;
}

/** #871: threshold (in changed lines — additions + deletions) above which a
 * PR's non-test source footprint counts as "substantial" for role selection,
 * independent of pr_kind/risk-flag lane matching. Grounded in the #854
 * evidence: the PR the correctness specialist was wrongly skipped on added
 * one new 409-line non-test source module (src/platform/tangled-bobbin.ts).
 * 200 sits comfortably below that (margin for smaller-but-still-nontrivial
 * PRs) while still excluding a typical small diff (a handful of lines in an
 * existing file). */
export const SUBSTANTIAL_SOURCE_LINE_THRESHOLD = 200;

const SOURCE_FILE_PATTERN = new RegExp(`\\.${SRC_EXT}$`, "i");

function isNonTestSourceFile(filename: string): boolean {
  return SOURCE_FILE_PATTERN.test(filename) && !isTestPath(filename);
}

/** #871: substantial-change detection over the changed-file list — a new
 * non-test source module (added status), or the non-test source lines
 * changed (additions + deletions, summed across matching files) exceeding
 * SUBSTANTIAL_SOURCE_LINE_THRESHOLD. */
function evaluateSubstantialCodeChange(files: readonly ChangedFile[]): boolean {
  let hasNewModule = false;
  let lines = 0;
  for (const file of files) {
    if (!isNonTestSourceFile(file.filename)) continue;
    if (file.status === "added") hasNewModule = true;
    lines += (file.additions ?? 0) + (file.deletions ?? 0);
  }
  return hasNewModule || lines > SUBSTANTIAL_SOURCE_LINE_THRESHOLD;
}

/** Serialize the internal classification to the persisted v2-identical
 * snake_case artifact (`classification.json`). Key order mirrors the v2
 * dataclass; canonical JSON serialization keeps the artifact bytes
 * v2-identical. */
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
type KindPredicate = (
  files: readonly ChangedFile[],
  diffText: string,
  fullDiffText: string,
  authoritativeChangedFiles: number | undefined,
  metadata: PrMetadata,
) => boolean;
const KIND_RULES: readonly { kind: string; matches: KindPredicate }[] = [
  { kind: "renovate_digest_only", matches: isRenovateDigestOnly },
  { kind: "image_digest_only", matches: isImageDigestOnly },
  // #1336: Renovate-authored image tag/digest and Helm chart/appVersion
  // refreshes are dependency updates, not ordinary app-code/manifest edits.
  // They precede k8s_manifest (whose generic lane would swallow a Renovate
  // image bump in a HelmRelease) and depend on forge-reported Renovate
  // authorship metadata — a human tag bump keeps the pre-existing kinds.
  { kind: "renovate_image_update", matches: isRenovateImageUpdate },
  { kind: "renovate_chart_update", matches: isRenovateChartUpdate },
  { kind: "dependency_upgrade", matches: isDependencyUpgrade },
  { kind: "k8s_manifest", matches: filenameMatches(K8S_PATTERNS) },
  // secret handling before auth (more specific)
  { kind: "secret_handling_changes", matches: filenameMatches(SECRET_HANDLING_PATTERNS) },
  { kind: "db_or_migration_changes", matches: filenameMatches(DB_MIGRATION_PATTERNS) },
  { kind: "auth_changes", matches: filenameMatches(AUTH_PATTERNS) },
  { kind: "public_route_changes", matches: filenameMatches(PUBLIC_ROUTE_PATTERNS) },
  // #871: unlike every other content-capable rule in this table,
  // file_serving_changes had no material/mention distinction at all — a bare
  // keyword regex scanned over raw diff text, matching prose or unrelated API
  // surfaces (a network client's URL-parsing text) exactly as readily as an
  // actual static-file handler. `routeSignals` already refuses to route on
  // that class of content-only match (too weak); this rule now requires the
  // same filename backing to set `pr_kind`, so it falls through to
  // path_handling_changes / the default kind instead of mislabeling a PR from
  // prose alone. The risk flag (FILE_RISK_RULES below) still fires from
  // content — a weaker, informational signal that can still select the
  // security lane — but `buildMustCheck` skips its checklist items when
  // content-only (see CONTENT_ONLY_SUPPRESSED_CHECK_FLAGS).
  { kind: "file_serving_changes", matches: filenameMatches(FILE_SERVING_PATTERNS) },
  { kind: "path_handling_changes", matches: isPathHandling },
];

/** Fallback kind when no rule matches. */
export const DEFAULT_PR_KIND = "app_code";

function filenameMatches(patterns: readonly RegExp[]): KindPredicate {
  return (files) => files.some((file) => matchesAny(file.filename, patterns));
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

function isRenovateDigestOnly(files: readonly ChangedFile[], diffText: string): boolean {
  return allFilesAreLockfiles(files.map((file) => file.filename)) && !hasVersionBump(diffText);
}

/** True only when EVERY changed file is a modified YAML/Dockerfile image
 * manifest. A rename, copy, addition, or removal changes the manifest's
 * location/shape and must not take the digest-only path (#909). */
function allFilesAreImageManifests(files: readonly ChangedFile[]): boolean {
  if (files.length === 0) return false;
  return files.every((file) => file.status === "modified" && matchesAny(file.filename, IMAGE_DIGEST_FILE_PATTERNS));
}

/** Git metadata lines that signal a rename, copy, or mode change — a
 * structural change to the manifest, not a digest refresh. */
const STRUCTURAL_DIFF_LINE_RE =
  /^(?:old mode|new mode|rename from|rename to|copy from|copy to|similarity index|dissimilarity index|new file mode|deleted file mode)\b/;

/** `prioritizeDiff` evidence-completeness markers (src/corpus/diff-priority.ts).
 * Their presence means the supplied diff is missing changed lines, so no
 * "only the digest changed" claim is safe. The classifier normally receives the
 * full diff for this rule, but a caller that only has the truncated context
 * diff must fail closed rather than reason over incomplete evidence (#909). */
const DIFF_TRUNCATION_MARKER_RE = /…\[diff truncated|…\[file diff clipped:|Files omitted from this diff \(/;

/** Binary diffs carry no `+`/`-` lines, so a binary (or otherwise unparsed)
 * manifest would contribute nothing to the line reconciliation while hiding a
 * real change. Both git binary forms fail closed (#909). */
const BINARY_DIFF_LINE_RE = /^(?:Binary files .* differ|GIT binary patch)$/;

/** An allowed image-reference line form, optionally behind a YAML
 * `image:`/`tag:` key or a Dockerfile `FROM [--platform=...]` directive (with
 * an optional trailing `AS <stage>`). Captures the `@sha256:` digest; every
 * other byte of the line (key, indentation, platform, stage, ref) must stay
 * identical across a paired removal and addition. */
const IMAGE_DIGEST_LINE_RE =
  /^\s*(?:FROM\s+(?:--platform=\S+\s+)?|(?:image|tag)\s*:\s*)?["']?[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:([0-9a-fA-F]{64})["']?(?:\s+AS\s+\S+)?\s*$/i;

const DIGEST_TOKEN_RE = /sha256:[0-9a-fA-F]{64}/;

/** Parse a changed line (without its diff `+`/`-` prefix) into a normalized
 * form with the digest blanked out, plus the digest itself. Null when the line
 * is not an allowed image-reference form. */
function parseImageDigestLine(content: string): { normalized: string; digest: string } | null {
  const match = IMAGE_DIGEST_LINE_RE.exec(content);
  if (match === null) return null;
  // Exactly one digest token per line. The anchored regex admits a single
  // `@sha256:` (the ref charset excludes `@`), but a second `sha256:<hex>`
  // could sit in the optional `AS <stage>` tail; blanking an ambiguous token
  // would let a non-digest difference normalize away. Fail closed instead.
  if ((content.match(/sha256:[0-9a-fA-F]{64}/g) ?? []).length !== 1) return null;
  return {
    normalized: content.replace(DIGEST_TOKEN_RE, "sha256:<DIGEST>"),
    digest: match[1]!.toLowerCase(),
  };
}

/** Validate one contiguous change block — a run of removed lines immediately
 * followed by added lines, with no context/header line between. Each removed
 * line must pair with an added line at the same position whose only difference
 * is the digest. Returns whether any paired digest differed, or null when the
 * block is not a pure digest refresh. */
function evaluateDigestBlock(
  removed: readonly { normalized: string; digest: string }[],
  added: readonly { normalized: string; digest: string }[],
): boolean | null {
  if (removed.length === 0 || removed.length !== added.length) return null;
  let digestChanged = false;
  for (let index = 0; index < removed.length; index += 1) {
    const before = removed[index]!;
    const after = added[index]!;
    // Everything except the digest — key, indentation, platform, stage, ref —
    // must be byte-identical, which is what proves "only the digest changed".
    if (before.normalized !== after.normalized) return null;
    if (before.digest !== after.digest) digestChanged = true;
  }
  return digestChanged;
}

/** Result of walking a unified diff's contiguous change blocks. */
interface ImageBlockWalk {
  /** False when the diff carries structural metadata, a truncation marker, a
   * binary-diff marker, or (strict mode only) a changed line the parser
   * rejected — evidence too incomplete for an "only X changed" claim. */
  ok: boolean;
  sawBlock: boolean;
  anyTrue: boolean;
  totalAdded: number;
  totalRemoved: number;
  /** Lenient mode only: the `+++ b/` file most recently seen, for
   * attribution callbacks. */
  currentFile: string;
}

/** Shared unified-diff change-block walker for the image-reference rules:
 * pairs each contiguous run of removed lines with the added lines that
 * follow it (delimited by context, hunk headers, or file headers), and
 * delegates line parsing and per-block evaluation to the caller. A block's
 * evaluation returning `null` invalidates it; returning a boolean ORs into
 * `anyTrue`. Strict mode (the kind rules) aborts on the first impurity —
 * the fail-closed shape `isImageDigestOnly` established (#909). Lenient mode
 * (the #1336 risk scan) flushes the current block on an impurity and keeps
 * walking, so cleanly paired blocks elsewhere in the diff still report —
 * only their evaluation result is visible (`anyTrue` counts validated blocks
 * only). `onLine`/`onPair` observe parsed lines and accepted pairs for
 * attribution. */
function walkImageRefBlocks<T>(
  fullDiffText: string,
  parseLine: (content: string) => T | null,
  evaluateBlock: (removed: readonly T[], added: readonly T[]) => boolean | null,
  opts: { lenient: boolean; onLine?: (parsed: T, file: string) => void; onPair?: (removed: readonly T[], added: readonly T[], file: string) => void },
): ImageBlockWalk {
  let removed: T[] = [];
  let added: T[] = [];
  let sawBlock = false;
  let anyTrue = false;
  let totalRemoved = 0;
  let totalAdded = 0;
  let currentFile = "";

  const flush = (): boolean => {
    if (removed.length === 0 && added.length === 0) return true;
    const changed = evaluateBlock(removed, added);
    if (changed === null) {
      if (!opts.lenient) return false;
    } else {
      sawBlock = true;
      anyTrue = anyTrue || changed;
      opts.onPair?.(removed, added, currentFile);
    }
    removed = [];
    added = [];
    return true;
  };

  for (const line of fullDiffText.split("\n")) {
    // Rename/copy/mode metadata is a structural change, never a digest
    // refresh — fail closed even if the file status looks like a plain edit.
    if (STRUCTURAL_DIFF_LINE_RE.test(line)) {
      if (!opts.lenient) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      continue;
    }
    // A truncation marker means changed lines are missing: not complete
    // evidence, so never claim digest-only.
    if (DIFF_TRUNCATION_MARKER_RE.test(line)) {
      if (!opts.lenient) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      continue;
    }
    // A binary diff has no `+`/`-` lines, so it would otherwise vanish from
    // the line reconciliation below.
    if (BINARY_DIFF_LINE_RE.test(line)) {
      if (!opts.lenient) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      continue;
    }
    const isRemoved = line.startsWith("-") && !line.startsWith("---");
    const isAdded = line.startsWith("+") && !line.startsWith("+++");
    if (!isRemoved && !isAdded) {
      // Context line, hunk header (`@@`), file header, or any other line:
      // the current change block is complete. File headers carry the
      // attribution target for lenient-mode callbacks.
      if (line.startsWith("+++ ")) currentFile = line.slice(4).replace(/^b\//, "");
      if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      continue;
    }
    const parsed = parseLine(line.slice(1));
    if (parsed === null) {
      if (!opts.lenient) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
      continue;
    }
    if (isRemoved) {
      // Git emits a block's removals before its additions; a removal after an
      // addition means the block boundary was mis-detected, so fail closed.
      if (added.length > 0) {
        if (!opts.lenient) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
        if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
        continue;
      }
      removed.push(parsed);
      totalRemoved += 1;
    } else {
      added.push(parsed);
      totalAdded += 1;
    }
    opts.onLine?.(parsed, currentFile);
  }
  if (!flush()) return { ok: false, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
  return { ok: true, sawBlock, anyTrue, totalAdded, totalRemoved, currentFile };
}

/** Renovate image-digest-only refresh: every changed line is a single image
 * reference whose repository and tag are unchanged and only the `@sha256:`
 * digest differs (YAML `image:`/`tag:`, compose, Dockerfile `FROM`). A mixed
 * diff — any other changed line, or any other change around the digest — is
 * left to the existing rules (notably k8s_manifest), which would otherwise
 * demand a check a digest-only change cannot answer (#909).
 *
 * Removed and added lines are paired within each contiguous change block
 * (a run of removals immediately followed by additions, delimited by context,
 * hunk headers, or file headers), so an image cannot move between hunks or
 * files and still count as a digest refresh. Comparing refs globally would
 * accept either a digest swap or a relocation.
 *
 * Parsed against `fullDiffText` — the complete PR diff — because `diffText` is
 * the prioritized/truncated context diff and can omit functional changes
 * (#909). A truncation marker in the supplied diff fails closed. */
function isImageDigestOnly(
  files: readonly ChangedFile[],
  _diffText: string,
  fullDiffText: string,
  authoritativeChangedFiles: number | undefined,
): boolean {
  if (!allFilesAreImageManifests(files)) return false;
  const walk = walkImageRefBlocks(fullDiffText, parseImageDigestLine, evaluateDigestBlock, { lenient: false });
  if (!walk.ok || !walk.sawBlock || !walk.anyTrue) return false;
  return evidenceIsComplete(files, authoritativeChangedFiles, walk.totalAdded, walk.totalRemoved);
}

/** Prove the supplied file list and diff are complete before claiming every
 * changed line is digest-only. Both platform reads can be incomplete — GitHub's
 * file listing is a single capped page and the raw diff carries no completeness
 * proof — so reconcile the authoritative changed-file count and the per-file
 * line totals against the diff actually parsed. Missing metadata or any count
 * mismatch fails closed (#909). */
function evidenceIsComplete(
  files: readonly ChangedFile[],
  authoritativeChangedFiles: number | undefined,
  totalAdded: number,
  totalRemoved: number,
): boolean {
  if (!Number.isInteger(authoritativeChangedFiles) || authoritativeChangedFiles !== files.length) {
    return false;
  }
  let expectedAdded = 0;
  let expectedRemoved = 0;
  for (const file of files) {
    const additions = file.additions;
    const deletions = file.deletions;
    if (!Number.isInteger(additions) || !Number.isInteger(deletions)) return false;
    // A zero-line side contributes nothing to the reconciliation and can hide
    // a binary or otherwise unparsed change, so a pure digest refresh must move
    // at least one line on each side of every file.
    if (additions! <= 0 || deletions! <= 0) return false;
    expectedAdded += additions!;
    expectedRemoved += deletions!;
  }
  return totalAdded === expectedAdded && totalRemoved === expectedRemoved;
}

/** A dependency/manifest file changed, but NOT a k8s manifest (which happens
 * to reference versions and must classify as k8s_manifest instead). */
function isDependencyUpgrade(files: readonly ChangedFile[], _diffText: string): boolean {
  const filenames = files.map((file) => file.filename);
  const hasDepFile = filenames.some((name) => matchesAny(name, DEPENDENCY_PATTERNS));
  if (!hasDepFile) return false;
  const hasK8s = filenames.some((name) => matchesAny(name, K8S_PATTERNS));
  return !hasK8s;
}

// ---------------------------------------------------------------------------
// Renovate image/chart updates (#1336)
// ---------------------------------------------------------------------------

/** Forge-reported PR metadata the update rules may rely on. Author and branch
 * are forge identity facts (never PR-body content); the title is forge-reported
 * text. All three are untrusted data: this boundary keeps only the booleans
 * the rules need, so no untrusted string is retained. */
interface PrMetadata {
  renovateAuthored: boolean;
  /** Whether the forge-reported title carries a security-fix/advisory
   * identifier (`CVE-…`, `GHSA-…`, "security"). */
  titleReportsAdvisory: boolean;
}

/** Renovate authorship from forge-reported metadata only: the bot account —
 * a login that STARTS with `renovate` (`renovate[bot]`, `renovate-bot`,
 * custom-configured `renovate-pro[bot]`) — or a `renovate/` head branch.
 * Both are author-chosen strings (a fork PR's head branch is fully
 * attacker-controlled), so the load-bearing guard for these kinds is the
 * pure-diff requirement and the evidence reconciliation, not the name; the
 * residual risk — a human PR from a `renovate/` branch reaching the benign
 * zero-selection gate for a pure tag refresh — is a documented decision
 * (docs/deep-review.md). The title never establishes authorship: it is
 * attacker-influenced text and must not gate a zero-specialist path. */
const RENOVATE_AUTHOR_RE = /^renovate($|\[|-|_)/i;
const RENOVATE_BRANCH_RE = /^renovate\//i;

/** Security-fix/advisory vocabulary in the forge-reported PR title — a known
 * fact from the update metadata (Renovate titles carry the dependency and,
 * for vulnerability-alert branches, the fix context), never a guess about the
 * image contents. */
const SECURITY_TITLE_RE = /\b(?:CVE-\d{4}-\d+|GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}|security)\b/i;

/** Untrusted data, never instructions. The forge-reported metadata is read
 * here and reduced to two booleans: the title against the closed advisory
 * vocabulary, the author login and head branch against the closed
 * Renovate-authorship prefixes. Nothing derived from the untrusted text is
 * retained, rendered, or promoted into a kind — the classifier emits closed
 * values only, so hostile content can neither close a fence nor carry itself
 * into an artifact, a log line, or the prompt through this path.
 *
 * The title is read in FULL against the advisory vocabulary: a bounded
 * projection would let an author pad the title past the bound and suppress
 * the advisory signal, so the signal is never traded away for a smaller
 * working set. The authorship prefixes themselves stay author-chosen strings
 * (the documented #1336 residual risk) — the pure-diff requirement is the
 * load-bearing guard for the kinds they gate. */
function classifyPrMetadata(prAuthor: string, headBranch: string, prTitle: string): PrMetadata {
  const renovateAuthored = RENOVATE_AUTHOR_RE.test(prAuthor) || RENOVATE_BRANCH_RE.test(headBranch); // untrusted identity: closed prefixes only
  const titleReportsAdvisory = SECURITY_TITLE_RE.test(prTitle); // untrusted content: closed advisory vocabulary only
  return { renovateAuthored, titleReportsAdvisory };
}

/** An allowed image-reference line form — the #909 digest-line grammar
 * generalized to an optional `:tag`: optional YAML `image:`/`tag:` key or
 * Dockerfile `FROM [--platform=...]` prefix, optional quotes, the reference
 * (charset excludes `@`), an optional trailing `@sha256:<64hex>`, optional
 * closing quote, and an optional trailing `AS <stage>`. */
const IMAGE_REF_LINE_RE =
  /^(\s*(?:FROM\s+(?:--platform=\S+\s+)?|(?:image|tag)\s*:\s*)?["']?)([A-Za-z0-9][A-Za-z0-9._:/-]*)(@sha256:[0-9a-fA-F]{64})?(["']?)((?:\s+AS\s+\S+)?)\s*$/i;

/** A tag is the last `:`-segment of the reference with no `/` or `@` in it —
 * so a registry port (`localhost:5000/repo`) is never mistaken for a tag. */
const IMAGE_TAG_RE = /^[A-Za-z0-9._-]+$/;

/** At most one digest token per line: the anchored regex admits a single
 * `@sha256:`, but a second `sha256:<hex>` could hide in the `AS <stage>` tail;
 * an ambiguous token would let a non-reference difference normalize away. */
function parseImageRefLine(content: string): { normalized: string; repo: string; tag: string | null; digest: string | null } | null {
  if ((content.match(/sha256:[0-9a-fA-F]{64}/g) ?? []).length > 1) return null;
  const match = IMAGE_REF_LINE_RE.exec(content);
  if (match === null) return null;
  const [, prefix = "", ref = "", digestToken = "", quote = "", tail = ""] = match;
  // A line that is not keyed (`image:`/`tag:`) and not a Dockerfile FROM is
  // not attributable to an image reference — ordinary single-token or quoted
  // value diffs (`- build/` / `+ "prod"` in .gitignore or YAML) must never
  // feed the provenance/sensitivity scan. The opening quote sits inside the
  // prefix capture, so a bare-prefix check would pass it: require the key.
  if (!/^\s*(?:FROM\b|(?:image|tag)\s*:)/i.test(prefix)) return null;
  const digest = digestToken === "" ? null : digestToken.slice(1).toLowerCase();
  // A `tag:` YAML value is a tag, never a repository (`tag: v1.2.3` in a
  // values file, `tag: latest@sha256:…` in a HelmRelease): it carries no
  // provenance to compare. Only a full-reference `tag:` value (a `/` path)
  // names a repository.
  const isTagKey = /^\s*tag\s*:/i.test(prefix);
  let repo = "";
  let tag: string | null = null;
  if (isTagKey && !ref.includes("/")) {
    tag = ref;
  } else {
    repo = ref;
    const colon = ref.lastIndexOf(":");
    if (colon >= 0) {
      const candidate = ref.slice(colon + 1);
      if (candidate.length > 0 && IMAGE_TAG_RE.test(candidate)) {
        tag = candidate;
        repo = ref.slice(0, colon);
      }
    }
  }
  return {
    // The paired-comparison form: key, indentation, repository, platform,
    // stage and quotes preserved; tag and digest blanked.
    normalized:
      `${prefix}${repo !== "" ? repo : ""}${tag !== null ? (repo !== "" ? ":" : "") + "<TAG>" : ""}${digest !== null ? "@sha256:<DIGEST>" : ""}${quote}${tail}`,
    repo,
    tag,
    digest,
  };
}

/** Every paired line keeps its repository (and everything around the
 * reference) and at least one pair changed a tag or digest. A repository
 * change is a provenance change, not a version refresh — the kind rule
 * rejects it (the #1336 risk scan flags it instead). */
function evaluateImageRefBlock(
  removed: readonly { normalized: string; repo: string; tag: string | null; digest: string | null }[],
  added: readonly { normalized: string; repo: string; tag: string | null; digest: string | null }[],
): boolean | null {
  if (removed.length === 0 || removed.length !== added.length) return null;
  let refChanged = false;
  for (let index = 0; index < removed.length; index += 1) {
    const before = removed[index]!;
    const after = added[index]!;
    if (before.normalized !== after.normalized) return null;
    if (before.repo !== after.repo || before.tag !== after.tag || before.digest !== after.digest) refChanged = true;
  }
  return refChanged;
}

function isRenovateImageUpdate(
  files: readonly ChangedFile[],
  _diffText: string,
  fullDiffText: string,
  authoritativeChangedFiles: number | undefined,
  metadata: PrMetadata,
): boolean {
  if (!metadata.renovateAuthored) return false;
  if (!allFilesAreImageManifests(files)) return false;
  const walk = walkImageRefBlocks(fullDiffText, parseImageRefLine, evaluateImageRefBlock, { lenient: false });
  if (!walk.ok || !walk.sawBlock || !walk.anyTrue) return false;
  return evidenceIsComplete(files, authoritativeChangedFiles, walk.totalAdded, walk.totalRemoved);
}

/** Helm chart version vocabulary: HelmRelease `chart:`/`version:`,
 * Chart.yaml `version:`/`appVersion:`. Case-sensitive — these are the exact
 * YAML keys Renovate's helm-release and Chart.yaml managers bump; a
 * case-insensitive match would swallow unrelated version-shaped keys. The
 * anchor excludes prefixed keys like `apiVersion:`.
 *
 * The line shape is captured in groups — indentation, key, separator, quoting
 * — so the comparison can hold every byte around the version value fixed: a
 * pure chart refresh changes the VALUE only (#1336 pure-diff requirement). */
const CHART_VERSION_LINE_RE = /^(\s*)((?:chart|version|appVersion))(\s*:\s*)(["']?)([A-Za-z0-9][A-Za-z0-9._-]*)(["']?)(\s*)$/;

/** One parsed chart-version line: the key, the version value, and the line
 * with the value blanked out (`normalized`) — indentation, key, separator and
 * quoting. A pair may only differ in the value, so the normalized shape must
 * be identical on both sides. */
interface ChartVersionLine {
  key: string;
  value: string;
  normalized: string;
}

function parseChartVersionLine(content: string): ChartVersionLine | null {
  const match = CHART_VERSION_LINE_RE.exec(content);
  if (match === null) return null;
  const [, indent = "", key = "", separator = "", openQuote = "", value = "", closeQuote = "", trailing = ""] = match;
  // A quoted value must be quoted consistently: a mismatched or stray quote
  // is not a well-formed version line, so the line does not parse at all and
  // the block fails closed rather than accepting a half-quoted shape.
  if (openQuote !== closeQuote) return null;
  return { key, value, normalized: `${indent}${key}${separator}${openQuote}${closeQuote}${trailing}` };
}

/** Chart/appVersion refresh: pairs keep the same key and change the value; a
 * changed `chart:` value is a renamed dependency, not an update. Pairing is
 * strictly positional with equal run lengths — an unpaired `chart:` line
 * (a dependency added or removed alongside the bump) invalidates the block,
 * exactly like the image rule (#1336 review): the pairing must be able to SEE
 * every chart-line change. At least one true value change must exist.
 *
 * Only the version VALUE may change: the normalized shape (indentation, key,
 * separator, quoting) must match on both sides, so a re-indent or a quote-style
 * change travelling with the bump disqualifies the kind instead of reaching
 * the zero-specialist gate (#1336 review: "every changed line is a version
 * bump"). */
function evaluateChartVersionBlock(
  removed: readonly ChartVersionLine[],
  added: readonly ChartVersionLine[],
): boolean | null {
  if (removed.length === 0 || removed.length !== added.length) return null;
  let valueChanged = false;
  for (let index = 0; index < removed.length; index += 1) {
    const before = removed[index]!;
    const after = added[index]!;
    if (before.key !== after.key) return null;
    if (before.normalized !== after.normalized) return null;
    if (before.key === "chart" && before.value !== after.value) return null;
    if (before.value !== after.value) valueChanged = true;
  }
  return valueChanged;
}

/** Chart-bearing manifests: a HelmRelease/Chart.yaml filename, or any YAML in
 * a diff that carries a HelmRelease marker (Renovate's helm-release manager
 * bumps `version:` inside `kind: HelmRelease` documents whose filenames are
 * unconstrained). Without this gate a Renovate `version:` bump in arbitrary
 * YAML would drop the correctness lane the k8s_manifest kind used to give. */
const CHART_FILE_RE = /(?:helmrelease|chart)\.ya?ml$/i;
const CHART_PR_MARKER_RE = /^\s*(?:kind\s*:\s*["']?HelmRelease["']?\s*|apiVersion\s*:\s*["']?helm\.toolkit\.fluxcd\.io)/m;

/** The diff region that belongs to each changed file: the text between this
 * file's `+++ b/…` header and the next file header. A diff with no file
 * header at all (a bare hunk) belongs to the single changed file — with more
 * than one changed file the region cannot be attributed, so no file may claim
 * a marker it does not own (fail closed).
 *
 * The marker must be attributed per file: a `kind: HelmRelease` marker in one
 * file's region says nothing about another file, so a chart-shaped file can
 * no longer bless an unrelated YAML `version:` change in a sibling file
 * (#1336 review). */
function diffFileRegions(fullDiffText: string, files: readonly ChangedFile[]): Map<string, string> {
  const regions = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === null) return;
    const existing = regions.get(current);
    regions.set(current, existing === undefined ? buffer.join("\n") : `${existing}\n${buffer.join("\n")}`);
    buffer = [];
  };
  for (const line of fullDiffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // A new file section: close the previous one and drop its pending
      // header lines, so a region never carries another file's header.
      flush();
      current = null;
      buffer = [];
      continue;
    }
    if (line.startsWith("+++ ")) {
      flush();
      current = line.slice(4).replace(/^b\//, "").trim();
      buffer = [line];
      continue;
    }
    if (line.startsWith("--- ")) {
      // The old-path header precedes the new-path header of the same file.
      flush();
      current = line.slice(4).replace(/^a\//, "").trim();
      buffer = [line];
      continue;
    }
    buffer.push(line);
  }
  flush();
  if (regions.size === 0 && files.length === 1) regions.set(files[0]!.filename, fullDiffText);
  return regions;
}

/** Every changed file is a modified YAML manifest (HelmRelease/Chart.yaml
 * shapes); the diff changes only chart/version values. */
function isRenovateChartUpdate(
  files: readonly ChangedFile[],
  _diffText: string,
  fullDiffText: string,
  authoritativeChangedFiles: number | undefined,
  metadata: PrMetadata,
): boolean {
  if (!metadata.renovateAuthored) return false;
  if (files.length === 0) return false;
  if (!files.every((file) => file.status === "modified" && /\.ya?ml$/i.test(file.filename))) return false;
  // Every changed file must be chart-bearing ON ITS OWN: chart-shaped by name,
  // or carrying the HelmRelease marker in its own diff region. A marker in a
  // sibling file's region blesses nothing, so one chart file can no longer
  // carry an unrelated YAML `version:` change into the zero-selection gate
  // (#1336 review).
  const regions = diffFileRegions(fullDiffText, files);
  const chartBearing = files.every((file) => {
    if (CHART_FILE_RE.test(file.filename)) return true;
    const region = regions.get(file.filename) ?? "";
    return CHART_PR_MARKER_RE.test(region);
  });
  if (!chartBearing) return false;
  const walk = walkImageRefBlocks(fullDiffText, parseChartVersionLine, evaluateChartVersionBlock, { lenient: false });
  if (!walk.ok || !walk.sawBlock || !walk.anyTrue) return false;
  return evidenceIsComplete(files, authoritativeChangedFiles, walk.totalAdded, walk.totalRemoved);
}

// ---------------------------------------------------------------------------
// Dependency-update risk signals (#1336)
// ---------------------------------------------------------------------------

/** The update types the bounded #1336 risk triggers may escalate: Renovate's
 * own kinds plus the generic dependency kind. Outside this context a title
 * word like "security" must not invent a dependency risk signal for an
 * ordinary code PR (its own lanes already cover that). */
const DEPENDENCY_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "renovate_digest_only",
  "image_digest_only",
  "renovate_image_update",
  "renovate_chart_update",
  "dependency_upgrade",
]);

/** Bounded component vocabulary for the sensitive-component trigger:
 * proxy/auth/network/secret-handling infrastructure. Exact-token matching —
 * any non-alphanumeric character separates tokens (`oauth2-proxy` → `oauth2`,
 * `proxy`) — so a token that is NOT on this closed list (`author`) never
 * fires; a closed compound-name list covers the well-known components whose
 * token isn't a bare stem (`certs`, `certbot`, `certificate`, `certmanager`,
 * `oauth2proxy` — certificate material is exactly the secret-handling class
 * this trigger exists for). Only ever evaluated inside the
 * dependency-update context. */
const SENSITIVE_COMPONENT_TOKENS: readonly string[] = [
  "auth", "oauth", "oidc", "saml", "sso", "proxy", "gateway", "ingress",
  "traefik", "nginx", "caddy", "haproxy", "envoy", "vpn", "wireguard",
  "tailscale", "cloudflared", "vault", "sops", "cert", "secret", "secrets",
  "keycloak", "authelia", "authentik", "auth0", "oauth2", "vaultwarden",
  // Compound/camelCase spellings whose tokens are not a bare stem:
  "certs", "certbot", "certificate", "certmanager", "oauth2proxy",
];

function mentionsSensitiveComponent(text: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== "");
  return tokens.some((token) => SENSITIVE_COMPONENT_TOKENS.includes(token));
}

/** Lenient image-reference scan of the full diff: pairs what parses cleanly,
 * reports provenance changes (a paired reference whose repository/registry
 * differs — the "unknown upstream provenance" escalation fact) and the files
 * carrying them, and collects sensitive-component repositories from every
 * parsed reference line. Impure content never aborts the scan — cleanly
 * paired blocks elsewhere in the diff still report, so a genuine repository
 * swap is never erased by an unrelated line the parser rejects (the kind
 * rules stay strict; this scan only ever ADDS scrutiny). */
function scanImageRefDiff(fullDiffText: string): { repoChanged: boolean; repoChangeFiles: string[]; sensitiveFiles: string[] } {
  const repoChangeFiles: string[] = [];
  const sensitiveFiles: string[] = [];
  const push = (list: string[], file: string): void => {
    if (file === "" || list.includes(file)) return;
    list.push(file);
  };
  /** Provenance comparison: a repository must be named on BOTH sides — a
   * bare `tag:` value carries none — and differ. */
  const repoSwap = (a: { repo: string }, b: { repo: string }): boolean =>
    a.repo !== "" && b.repo !== "" && a.repo !== b.repo;
  const walk = walkImageRefBlocks(
    fullDiffText,
    parseImageRefLine,
    (removed, added) => {
      if (removed.length !== added.length) return null;
      for (let index = 0; index < removed.length; index += 1) {
        if (repoSwap(removed[index]!, added[index]!)) return true;
      }
      return false;
    },
    {
      lenient: true,
      onLine: (parsed, file) => {
        if (parsed.repo !== "" && mentionsSensitiveComponent(parsed.repo)) push(sensitiveFiles, file);
      },
      onPair: (removed, added, file) => {
        for (let index = 0; index < Math.min(removed.length, added.length); index += 1) {
          if (repoSwap(removed[index]!, added[index]!)) {
            push(repoChangeFiles, file);
            return;
          }
        }
      },
    },
  );
  // A provenance claim needs at least one cleanly paired block that changed
  // the repository — `anyTrue` is exactly that.
  return { repoChanged: walk.anyTrue, repoChangeFiles: walk.anyTrue ? repoChangeFiles : [], sensitiveFiles };
}

function classifyPrKind(
  files: readonly ChangedFile[],
  diffText: string,
  fullDiffText: string,
  authoritativeChangedFiles: number | undefined,
  metadata: PrMetadata,
): string {
  for (const rule of KIND_RULES) {
    if (rule.matches(files, diffText, fullDiffText, authoritativeChangedFiles, metadata)) return rule.kind;
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
  fullDiffText: string,
  linkedIssues: readonly LinkedIssue[],
  prKind: string,
  metadata: PrMetadata,
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

  // #1336: bounded dependency-update risk signals — every trigger is a known
  // fact (a paired reference whose repository changed, a forge-reported title
  // carrying an advisory identifier, a security-infrastructure component in a
  // changed reference or path), never an inference about image contents.
  const imageScan = scanImageRefDiff(fullDiffText);
  const updateContext = metadata.renovateAuthored || DEPENDENCY_UPDATE_KINDS.has(prKind);
  // Attribution merges two known-fact sources: files whose changed image
  // references name a sensitive component (from the scan) and changed
  // filenames whose own path segments do.
  const sensitiveFiles = [...imageScan.sensitiveFiles];
  for (const name of filenames) {
    if (mentionsSensitiveComponent(name) && !sensitiveFiles.includes(name)) sensitiveFiles.push(name);
  }
  if (imageScan.repoChanged || (updateContext && (metadata.titleReportsAdvisory || sensitiveFiles.length > 0))) {
    const attribution = [...imageScan.repoChangeFiles, ...sensitiveFiles].filter(
      (name, index, list) => list.indexOf(name) === index,
    );
    if (!flags.includes("dependency_security_sensitive")) flags.push("dependency_security_sensitive");
    flagsWithFiles["dependency_security_sensitive"] = attribution;
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
  image_digest_only: ["verify only image digests changed; repository and tag unchanged"],
  renovate_image_update: ["verify only image tags/digests changed; repository unchanged"],
  renovate_chart_update: ["verify only chart/version values changed"],
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
  dependency_security_sensitive: [
    "verify the update provenance and any referenced security advisory",
  ],
};

/** Kinds/flags whose RISK FLAG can still fire from diff CONTENT alone (with an
 * empty `riskFlagsWithFiles` file list). A content-only match of these must
 * not drive smart-model routing — only an actual changed filename should. As
 * of #871, `file_serving_changes` can no longer become `pr_kind` from
 * content alone (see the KIND_RULES comment above), but its risk flag still
 * can — kept only as the routing gate below, and as the must_check
 * suppression key in CONTENT_ONLY_SUPPRESSED_CHECK_FLAGS. The
 * path_handling_changes kind still fires `pr_kind` from the #749 signal
 * model regardless of filename backing (kept — a real behavioral signal, not
 * a bare keyword scan); routing stays filename-gated exactly as before —
 * only a filename vocabulary hit (the same effective subset as the removed
 * mention patterns) may route. */
const CONTENT_CAPABLE_KINDS: Readonly<Record<string, readonly RegExp[]>> = {
  file_serving_changes: FILE_SERVING_PATTERNS,
  path_handling_changes: PATH_HANDLING_FILENAME_PATTERNS,
};

/** #871: risk flags whose must_check items must not fire from a content-only
 * match (empty `riskFlagsWithFiles` attribution) — the same threshold
 * `routeSignals` already applies. Deliberately just `file_serving_changes`:
 * unlike path_handling_changes, it has no material-signal model
 * distinguishing real usage from an incidental keyword mention (see the
 * KIND_RULES comment), so a content-only hit is never strong enough to
 * inject "verify file path sanitization" / "check for directory traversal
 * vulnerabilities" into must_check. path_handling_changes keeps firing its
 * must_check from content per the #749 regression suite (a real untrusted-
 * path signal, not a bare mention, can appear with no filename backing at
 * all — e.g. `os.path.join(base, request.args["p"])` in an arbitrarily named
 * file). */
const CONTENT_ONLY_SUPPRESSED_CHECK_FLAGS: ReadonlySet<string> = new Set(["file_serving_changes"]);

function buildMustCheck(
  prKind: string,
  riskFlags: readonly string[],
  riskFlagsWithFiles: Readonly<Record<string, string[]>>,
): string[] {
  const checks: string[] = [];
  const seen = new Set<string>();
  for (const key of [prKind, ...riskFlags]) {
    if (CONTENT_ONLY_SUPPRESSED_CHECK_FLAGS.has(key) && (riskFlagsWithFiles[key] ?? []).length === 0) {
      continue;
    }
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
  /** The complete PR diff, when available. The deterministic image-digest check
   * (#909) must see every changed line; the primary `diffText` is the
   * prioritized/truncated context diff and can omit functional changes. Falls
   * back to `diffText`. */
  fullDiffText?: string | undefined;
  /** The platform PR object's authoritative `changed_files` count. The
   * image-digest check reconciles the supplied file list and diff against it
   * and fails closed when either is short (#909). */
  authoritativeChangedFiles?: number | undefined;
  linkedIssues?: readonly LinkedIssue[] | undefined;
  /** #1336: forge-reported PR metadata for the Renovate-update rules — the
   * author login (never PR-body content), the forge-reported title, and the
   * head branch name. All optional; absent/empty means no metadata signal.
   * Untrusted data: the classifier reduces these to booleans at the metadata
   * boundary and retains no untrusted text (see `classifyPrMetadata`). */
  prAuthor?: string | undefined;
  prTitle?: string | undefined;
  headBranch?: string | undefined;
  maxSummaryFiles?: number | undefined;
  metadataStatus?: unknown;
}

/** Run deterministic classification on a PR. Pure and synchronous — no model
 * calls, no network, no command execution. */
export function classifyPr(input: ClassifyInput): PRClassification {
  const {
    prFiles,
    diffText = "",
    fullDiffText,
    authoritativeChangedFiles,
    linkedIssues = [],
    maxSummaryFiles = 50,
    metadataStatus = null,
    prAuthor = "",
    prTitle = "",
    headBranch = "",
  } = input;

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

  const metadata = classifyPrMetadata(prAuthor, headBranch, prTitle);
  const prKind = classifyPrKind(prFiles, diffText, fullDiffText ?? diffText, authoritativeChangedFiles, metadata);
  const { flags, flagsWithFiles } = detectRiskFlags(prFiles, diffText, fullDiffText ?? diffText, linkedIssues, prKind, metadata);
  const mustCheck = buildMustCheck(prKind, flags, flagsWithFiles);

  // Build changed files summary (just filenames, truncated).
  const fileNames = prFiles.map((file) => file.filename);
  const changedFilesSummary = fileNames.slice(0, maxSummaryFiles);
  const routeSignalsList = routeSignals(prKind, fileNames, flags, flagsWithFiles);
  const substantialCodeChange = evaluateSubstantialCodeChange(prFiles);

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
    substantialCodeChange,
  };
}
