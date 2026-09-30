/** Equivalent-paths detector (#875).
 *
 * The reviewer misses bugs where one implementation path enforces an
 * invariant (identity/repo binding, authz, validation, fail-closed
 * behavior, redaction, limits) and a sibling path producing the same
 * externally visible result does not (#854: the explicit `getPull`
 * resolution checked `value.target.repo === ctx.repoDid`; the list-based
 * resolution returning the same `TangledPullIdentity` did not).
 *
 * This module is a bounded, deterministic (no model) detector: from the
 * change anchors already extracted for a diff, it groups changed
 * functions/methods (or, for `same_constructor`, return *sites* within
 * them — see below) that look like alternate routes to one result:
 *   - `return_type`: two+ same-file declarations sharing a declared
 *     return-type annotation;
 *   - `same_constructor`: two+ same-file return sites constructing an
 *     identical object shape, whether inline or via a shared local
 *     builder call — #854's actual shape, where neither path is a
 *     separately named declaration with its own return type;
 *   - `adapter_family`: a method name shared by sibling
 *     `*Adapter`/`*Provider`/`*Client` classes;
 *   - `privileged_operation`: two+ same-file declarations calling the
 *     same privileged operation.
 * It renders a compact "Equivalent paths to compare" section naming each
 * member's `file:line` plus the shared signature. It never itself claims
 * an asymmetry exists; it only points the specialist at the sibling paths
 * worth checking invariant-by-invariant. Favors precision: a file that
 * cannot be read at the reviewed head, or code it cannot classify, is
 * silently skipped rather than guessed at.
 */
import { declarationEnd, normalizedName, readHeadLines } from "./change-anchors.js";
import type { ChangeAnchorsArtifact, ChangeAnchorFile, ChangeAnchorSymbol } from "./change-anchors.js";

export const ARTIFACT_VERSION = 1;

/** Bounded: a small number of groups, each with a small number of members
 * (the issue's "bounded ... small number of sibling paths" requirement). */
export const MAX_GROUPS = 3;
export const MAX_MEMBERS_PER_GROUP = 4;

/** How far to scan upward from a symbol's line for its enclosing class. */
const MAX_CLASS_SCAN_LINES = 400;

const FUNCTION_KINDS: ReadonlySet<string> = new Set(["function", "method", "enclosing"]);

export type EquivalentPathRule = "return_type" | "same_constructor" | "adapter_family" | "privileged_operation";

export interface EquivalentPathMember {
  path: string;
  name: string;
  line: number;
  end: number;
}

export interface EquivalentPathGroup {
  rule: EquivalentPathRule;
  /** The shared signature/label the group was formed on: the normalized
   * return type, the shared method name, or the privileged call target. */
  shared: string;
  members: EquivalentPathMember[];
}

export interface EquivalentPathsArtifact {
  version: number;
  groups: EquivalentPathGroup[];
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i += 1;
  return i;
}

// ---------------------------------------------------------------------------
// Rule A: shared declared return type (same file).
// ---------------------------------------------------------------------------

/** TypeScript/JavaScript: `): Type {` / `): Type =>` / `): Type;`. Go: a
 * trailing `) Type {` or `) (Type, error) {` after the parameter list.
 * Python: `-> Type:`. Returns a normalized (whitespace-collapsed) type
 * string, or null when the declaration line carries no recognizable
 * return-type annotation — callers must not guess. */
function extractReturnType(declLine: string, language: string): string | null {
  if (language === "typescript" || language === "javascript") {
    const m = /\)\s*:\s*([A-Za-z_][A-Za-z0-9_<>[\].,\s|&]*?)\s*(?:=>|\{|;|$)/.exec(declLine);
    if (!m) return null;
    const raw = (m[1] ?? "").trim();
    if (raw === "" || raw === "void" || raw === "any" || raw === "unknown") return null;
    return raw.replace(/\s+/g, " ");
  }
  if (language === "python") {
    const m = /->\s*([A-Za-z_][A-Za-z0-9_.[\], |]*?)\s*:/.exec(declLine);
    if (!m) return null;
    const raw = (m[1] ?? "").trim();
    if (raw === "" || raw === "None" || raw === "Any") return null;
    return raw.replace(/\s+/g, " ");
  }
  if (language === "go") {
    const m = /\)\s*(\([^()]*\)|[A-Za-z_][A-Za-z0-9_.*[\]]*)\s*\{/.exec(declLine);
    if (!m) return null;
    const raw = (m[1] ?? "").trim();
    if (raw === "" || raw === "error") return null;
    return raw.replace(/\s+/g, " ");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule A2: same local constructor / same named-shape construction.
//
// #854's actual shape: `resolveTangledPull`'s explicit-URI branch inlines
// `return { uri, cid, ..., repoDid: targetRepo, ... }` right after checking
// `targetRepo !== ctx.repoDid`; its list-based branch instead calls the
// same-file `buildIdentity(m)` helper, whose own `return { uri, cid, ...,
// repoDid, ... }` has the identical key set but performs no such check.
// Neither branch is a separately *named* declaration with its own return
// type annotation (both live inside one function, `resolveTangledPull`),
// so rule A (declared return type) cannot see this pair — it looks at
// declarations, not return sites. This rule instead scans, per file:
//   1. Local "builder" declarations (`const NAME = (...) => { ... }` /
//      `function NAME(...) { ... }`) whose first top-level statement is
//      `return { ... }`; the object literal's own top-level keys become
//      the builder's shape signature.
//   2. Every *other* `return` site in the file: either an inline
//      `return { ... }` object literal (its own top-level keys are its
//      shape), or `return NAME(...)` where NAME is a known builder from
//      step 1 (its shape is the builder's). A `return { ... }` inside a
//      builder's own body is never itself a site — it is the builder,
//      already covered by whichever call site(s) reference it.
// Sites sharing an identical (sorted) key set, with at least 3 keys (to
// exclude trivial 1-2-field literals from ever qualifying), form a group.
// ---------------------------------------------------------------------------

const ARROW_BUILDER_RE = /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/;
const FUNCTION_BUILDER_RE = /^\s*(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const RETURN_OBJECT_RE = /^\s*return\s*\{\s*$/;
const RETURN_CALL_RE = /^\s*return\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
// Only function-shaped `const NAME = (` declarations count here — plain
// data locals (`const source = asRecord(...)`) must never mislabel a
// return site as its own enclosing declaration.
const DECL_NAME_RE = /\b(?:function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)|const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(|class\s+([A-Za-z_$][A-Za-z0-9_$]*))/;
const MIN_CONSTRUCTOR_KEYS = 3;
const MAX_OBJECT_LITERAL_WALK = 200;

interface ObjectLiteralExtract {
  keys: string[];
  end: number;
}

/** Brace-counts from the `return {` line at `startLine` (1-based) to its
 * matching close, bounded by `MAX_OBJECT_LITERAL_WALK`; extracts the
 * top-level (shallowest-indented) `key:` names inside. Returns null when
 * the braces never balance within the bound — never guesses a partial
 * shape. Ignores braces inside string literals (a rare false balance is an
 * acceptable risk for this bounded, precision-favoring heuristic). */
function extractObjectLiteralKeys(lines: string[], startLine: number): ObjectLiteralExtract | null {
  let depth = 0;
  let started = false;
  const inner: string[] = [];
  const limit = Math.min(lines.length, startLine + MAX_OBJECT_LITERAL_WALK);
  for (let lineNo = startLine; lineNo <= limit; lineNo += 1) {
    const line = lines[lineNo - 1] ?? "";
    for (const ch of line) {
      if (ch === "{") { depth += 1; started = true; }
      else if (ch === "}") depth -= 1;
    }
    if (lineNo > startLine && depth > 0) inner.push(line);
    if (started && depth <= 0) {
      let minIndent = Infinity;
      for (const l of inner) if (l.trim() !== "") minIndent = Math.min(minIndent, indentOf(l));
      const keys: string[] = [];
      for (const l of inner) {
        if (l.trim() === "" || indentOf(l) !== minIndent) continue;
        const colon = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/.exec(l);
        if (colon) {
          keys.push(colon[1] ?? colon[2] ?? colon[3] ?? "");
          continue;
        }
        // ES2015 shorthand property (`uri,` for `uri: uri`) — the whole
        // line, once trimmed, is just an identifier plus an optional
        // trailing comma; this also naturally excludes a spread (`...x,`,
        // which doesn't start with an identifier character).
        const shorthand = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,?\s*$/.exec(l);
        if (shorthand) keys.push(shorthand[1] ?? "");
      }
      return { keys: [...new Set(keys)].sort(), end: lineNo };
    }
  }
  return null;
}

interface LocalBuilder {
  name: string;
  keys: string[];
  declLine: number;
  declEnd: number;
}

/** Every same-file `const NAME = (...) => { ... }` / `function NAME(...) {
 * ... }` whose first top-level statement is `return { ... }` with at least
 * `MIN_CONSTRUCTOR_KEYS` keys. */
function findLocalBuilders(lines: string[]): Map<string, LocalBuilder> {
  const builders = new Map<string, LocalBuilder>();
  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    const line = lines[lineNo - 1] ?? "";
    const name = (ARROW_BUILDER_RE.exec(line) ?? FUNCTION_BUILDER_RE.exec(line))?.[1];
    if (name === undefined) continue;
    const declEnd = declarationEnd(lines, lineNo);
    // Scan the body's own top-level statements (its shallowest indentation —
    // skips anything nested one level deeper, inside an `if`/`for`/`try`)
    // for a `return { ... }`; a builder may do validation/throws before it.
    let bodyIndent: number | null = null;
    for (let inner = lineNo + 1; inner <= declEnd; inner += 1) {
      const innerLine = lines[inner - 1] ?? "";
      if (innerLine.trim() === "") continue;
      const indent = indentOf(innerLine);
      if (bodyIndent === null) bodyIndent = indent;
      if (indent !== bodyIndent) continue;
      if (RETURN_OBJECT_RE.test(innerLine)) {
        const extracted = extractObjectLiteralKeys(lines, inner);
        if (extracted !== null && extracted.keys.length >= MIN_CONSTRUCTOR_KEYS) {
          builders.set(name, { name, keys: extracted.keys, declLine: lineNo, declEnd });
        }
        break;
      }
    }
  }
  return builders;
}

interface ConstructorSite {
  line: number;
  end: number;
  keys: string[];
  viaBuilder: string | null;
}

/** Every path-level return site: an inline `return { ... }` outside any
 * builder's own body, or `return NAME(...)` calling a known builder. */
function findConstructorSites(lines: string[], builders: ReadonlyMap<string, LocalBuilder>): ConstructorSite[] {
  const inBuilderRange = (lineNo: number): boolean => {
    for (const b of builders.values()) {
      if (lineNo >= b.declLine && lineNo <= b.declEnd) return true;
    }
    return false;
  };
  const sites: ConstructorSite[] = [];
  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    const line = lines[lineNo - 1] ?? "";
    if (RETURN_OBJECT_RE.test(line)) {
      if (inBuilderRange(lineNo)) continue;
      const extracted = extractObjectLiteralKeys(lines, lineNo);
      if (extracted !== null && extracted.keys.length >= MIN_CONSTRUCTOR_KEYS) {
        sites.push({ line: lineNo, end: extracted.end, keys: extracted.keys, viaBuilder: null });
      }
      continue;
    }
    const call = RETURN_CALL_RE.exec(line);
    if (call === null) continue;
    const builder = builders.get(call[1] ?? "");
    if (builder !== undefined) {
      sites.push({ line: lineNo, end: declarationEnd(lines, lineNo), keys: builder.keys, viaBuilder: builder.name });
    }
  }
  return sites;
}

interface NamedDeclRange {
  name: string;
  declLine: number;
  declEnd: number;
}

/** Every function/arrow-const/class declaration in the file with its body
 * range. An indentation climb cannot tell a true lexical ancestor from a
 * same-indent SIBLING declaration that closed before `atLine` (e.g. two
 * local builders back to back in one function) — this instead finds every
 * declaration's actual `[declLine, declEnd]` range and picks the smallest
 * (most deeply nested) one that contains the target line, which a sibling
 * whose own range already ended never does. */
function findAllDeclarations(lines: string[]): NamedDeclRange[] {
  const out: NamedDeclRange[] = [];
  for (let lineNo = 1; lineNo <= lines.length; lineNo += 1) {
    const m = DECL_NAME_RE.exec(lines[lineNo - 1] ?? "");
    const name = m?.[1] ?? m?.[2] ?? m?.[3];
    if (name === undefined) continue;
    out.push({ name, declLine: lineNo, declEnd: declarationEnd(lines, lineNo) });
  }
  return out;
}

function nearestEnclosingDeclarationName(decls: readonly NamedDeclRange[], atLine: number): string | null {
  let best: NamedDeclRange | null = null;
  for (const d of decls) {
    if (d.declLine > atLine || atLine > d.declEnd) continue;
    if (best === null || d.declEnd - d.declLine < best.declEnd - best.declLine) best = d;
  }
  return best?.name ?? null;
}

// ---------------------------------------------------------------------------
// Rule B: adapter-family siblings sharing a method name.
// ---------------------------------------------------------------------------

const ADAPTER_SUFFIX_RE = /^([A-Za-z_][A-Za-z0-9_]*?)(Adapter|Provider|Client|Backend|Strategy)$/;

/** The nearest enclosing `class Name` (or `class Name implements X`) whose
 * indentation is strictly less than `atLine`'s, scanning upward within
 * `MAX_CLASS_SCAN_LINES`. Returns null when none is found — a method with
 * no enclosing class never joins an adapter-family group. */
function enclosingClassName(lines: string[], atLine: number): string | null {
  const baseIndent = indentOf(lines[atLine - 1] ?? "");
  const floor = Math.max(1, atLine - MAX_CLASS_SCAN_LINES);
  for (let lineNo = atLine - 1; lineNo >= floor; lineNo -= 1) {
    const line = lines[lineNo - 1] ?? "";
    if (line.trim() === "") continue;
    if (indentOf(line) >= baseIndent) continue;
    const m = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (m) return m[1] ?? null;
    // Any other less-indented, non-blank line that is not a class means
    // we've walked out of an enclosing block without finding one.
    if (indentOf(line) < baseIndent) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule C: same privileged operation.
// ---------------------------------------------------------------------------

/** Small, deliberately narrow allowlist of privileged-operation call
 * targets (outbound network calls, publish/verdict, auth/secret
 * handling). Matched as a normalized (lowercased, non-alnum-stripped)
 * exact identifier, so `requestJson`, `request_json` and `REQUEST_JSON`
 * all match `requestjson`. */
const PRIVILEGED_CALL_NAMES: ReadonlySet<string> = new Set(
  [
    "fetch", "request", "requestjson", "httprequest",
    "publish", "publishverdict", "publishreview",
    "authorize", "authenticate", "sign", "verify", "verifysignature",
    "exec", "spawn", "execcommand",
    "grant", "escalate", "elevate",
  ].map(normalizedName),
);

const CALL_RE = /\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g;

/** The first privileged call target found in `lines[start..end]` (1-based,
 * inclusive), or null. Only the last dotted segment is matched (so
 * `this.authorize(` and `client.authorize(` both match `authorize`). */
function privilegedCallIn(lines: string[], start: number, end: number): string | null {
  for (let lineNo = start; lineNo <= end && lineNo <= lines.length; lineNo += 1) {
    const line = lines[lineNo - 1] ?? "";
    for (const m of line.matchAll(CALL_RE)) {
      const raw = m[1] ?? "";
      const segment = raw.split(".").pop() ?? raw;
      const norm = normalizedName(segment);
      if (PRIVILEGED_CALL_NAMES.has(norm)) return norm;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface Candidate {
  path: string;
  name: string;
  line: number;
  end: number;
  language: string;
  declLine: string;
  headLines: string[];
}

/** Reads every non-deleted file's head lines once, shared by every rule
 * below (a `readHeadLines` call per file, never per rule). */
function cacheHeadLines(files: readonly ChangeAnchorFile[], sourceRoot: string): Map<string, string[] | null> {
  const cache = new Map<string, string[] | null>();
  for (const file of files) {
    if (file.deleted || cache.has(file.path)) continue;
    cache.set(file.path, readHeadLines(sourceRoot, file.path));
  }
  return cache;
}

function collectCandidates(files: readonly ChangeAnchorFile[], headCache: ReadonlyMap<string, string[] | null>): Candidate[] {
  const out: Candidate[] = [];
  for (const file of files) {
    if (file.deleted) continue;
    const headLines = headCache.get(file.path) ?? null;
    if (headLines === null) continue;
    const symbols: readonly ChangeAnchorSymbol[] = file.symbols ?? [];
    for (const sym of symbols) {
      if (!FUNCTION_KINDS.has(sym.kind)) continue;
      if (sym.line < 1 || sym.line > headLines.length) continue;
      const declLine = headLines[sym.line - 1] ?? "";
      const end = declarationEnd(headLines, sym.line);
      out.push({ path: file.path, name: sym.name, line: sym.line, end, language: file.language, declLine, headLines });
    }
  }
  return out;
}

function toMember(c: Candidate): EquivalentPathMember {
  return { path: c.path, name: c.name, line: c.line, end: c.end };
}

/** Group changed functions/methods into bounded "equivalent implementation
 * path" groups. Every rule requires >=2 distinct members before it forms a
 * group; a candidate already claimed by an earlier (higher-priority) rule
 * is not reused by a later rule, so the same asymmetry is not reported
 * twice under two different labels. Rule priority: return_type, then
 * same_constructor, then adapter_family, then privileged_operation — a
 * shared declared type is the strongest, most specific signal; a shared
 * privileged call target is the weakest (most likely to be incidental) and
 * is capped hardest.
 *
 * Claimed-key granularity (deliberate): the declaration-keyed rules
 * (return_type, adapter_family, privileged_operation) claim and consult a
 * candidate's *declaration* line, while same_constructor claims its
 * *return-site* lines — its members are sites inside one or more enclosing
 * declarations, and claiming those declarations wholesale would suppress a
 * genuinely different declaration-level asymmetry about the same function.
 * A function can therefore legitimately appear in a same_constructor group
 * AND a later declaration-level group when both asymmetries are real; what
 * the contract guarantees is that no single rule re-reports, and no
 * declaration is duplicated by another declaration-keyed rule. */
export function detectEquivalentPathGroups(
  anchors: ChangeAnchorsArtifact | null | undefined,
  sourceRoot: string | null | undefined,
): EquivalentPathsArtifact {
  if (anchors === null || anchors === undefined || sourceRoot === null || sourceRoot === undefined || sourceRoot === "") {
    return { version: ARTIFACT_VERSION, groups: [] };
  }
  const files = anchors.files ?? [];
  const headCache = cacheHeadLines(files, sourceRoot);
  const candidates = collectCandidates(files, headCache);
  const claimed = new Set<string>();
  const key = (c: Candidate): string => `${c.path}\0${c.line}`;

  const groups: EquivalentPathGroup[] = [];

  // Rule A: same file, shared declared return type.
  const byFileReturnType = new Map<string, Map<string, Candidate[]>>();
  for (const c of candidates) {
    const returnType = extractReturnType(c.declLine, c.language);
    if (returnType === null) continue;
    let byType = byFileReturnType.get(c.path);
    if (byType === undefined) {
      byType = new Map();
      byFileReturnType.set(c.path, byType);
    }
    const list = byType.get(returnType) ?? [];
    list.push(c);
    byType.set(returnType, list);
  }
  const returnTypeGroups: EquivalentPathGroup[] = [];
  for (const byType of byFileReturnType.values()) {
    for (const [returnType, list] of byType) {
      const distinct = dedupeCandidates(list);
      if (distinct.length < 2) continue;
      returnTypeGroups.push({
        rule: "return_type",
        shared: returnType,
        members: distinct.slice(0, MAX_MEMBERS_PER_GROUP).map(toMember),
      });
    }
  }
  returnTypeGroups.sort((a, b) => b.members.length - a.members.length || a.shared.localeCompare(b.shared));
  for (const g of returnTypeGroups) {
    if (groups.length >= MAX_GROUPS) break;
    groups.push(g);
    for (const m of g.members) claimed.add(`${m.path}\0${m.line}`);
  }

  // Rule A2: same file, same local constructor / same named-shape
  // construction (#854's actual shape — see the block comment above
  // `findLocalBuilders`).
  if (groups.length < MAX_GROUPS) {
    const byFileKeys = new Map<string, Map<string, ConstructorSite[]>>();
    for (const file of files) {
      if (file.deleted) continue;
      const headLines = headCache.get(file.path) ?? null;
      if (headLines === null) continue;
      const builders = findLocalBuilders(headLines);
      const sites = findConstructorSites(headLines, builders);
      if (sites.length < 2) continue;
      let byKeys = byFileKeys.get(file.path);
      if (byKeys === undefined) {
        byKeys = new Map();
        byFileKeys.set(file.path, byKeys);
      }
      for (const site of sites) {
        const keyStr = site.keys.join(",");
        const list = byKeys.get(keyStr) ?? [];
        list.push(site);
        byKeys.set(keyStr, list);
      }
    }
    const constructorGroups: EquivalentPathGroup[] = [];
    for (const [path, byKeys] of byFileKeys) {
      const headLines = headCache.get(path) ?? [];
      const decls = findAllDeclarations(headLines);
      for (const [keyStr, sites] of byKeys) {
        const seen = new Set<number>();
        const distinct = sites.filter((s) => (seen.has(s.line) ? false : (seen.add(s.line), true)));
        if (distinct.length < 2) continue;
        const members: EquivalentPathMember[] = distinct.slice(0, MAX_MEMBERS_PER_GROUP).map((s) => {
          const enclosing = nearestEnclosingDeclarationName(decls, s.line) ?? "<module scope>";
          const name = s.viaBuilder !== null ? `${enclosing} (via ${s.viaBuilder})` : enclosing;
          return { path, name, line: s.line, end: s.end };
        });
        constructorGroups.push({ rule: "same_constructor", shared: keyStr.split(",").slice(0, 4).join(", "), members });
      }
    }
    constructorGroups.sort((a, b) => b.members.length - a.members.length || a.shared.localeCompare(b.shared));
    for (const g of constructorGroups) {
      if (groups.length >= MAX_GROUPS) break;
      groups.push(g);
      for (const m of g.members) claimed.add(`${m.path}\0${m.line}`);
    }
  }

  // Rule B: sibling *Adapter/*Provider/*Client/*Backend/*Strategy classes
  // sharing a method name (cross-file — that is the whole point of an
  // adapter family).
  if (groups.length < MAX_GROUPS) {
    const byMethod = new Map<string, Candidate[]>();
    for (const c of candidates) {
      if (claimed.has(key(c))) continue;
      const className = enclosingClassName(c.headLines, c.line);
      if (className === null || !ADAPTER_SUFFIX_RE.test(className)) continue;
      const list = byMethod.get(c.name) ?? [];
      list.push(c);
      byMethod.set(c.name, list);
    }
    const adapterGroups: EquivalentPathGroup[] = [];
    for (const [methodName, list] of byMethod) {
      const distinct = dedupeCandidates(list);
      // Require at least two distinct enclosing files (a real "sibling
      // adapter" case), not two methods in one class.
      const distinctPaths = new Set(distinct.map((c) => c.path));
      if (distinct.length < 2 || distinctPaths.size < 2) continue;
      adapterGroups.push({
        rule: "adapter_family",
        shared: methodName,
        members: distinct.slice(0, MAX_MEMBERS_PER_GROUP).map(toMember),
      });
    }
    adapterGroups.sort((a, b) => b.members.length - a.members.length || a.shared.localeCompare(b.shared));
    for (const g of adapterGroups) {
      if (groups.length >= MAX_GROUPS) break;
      groups.push(g);
      for (const m of g.members) claimed.add(`${m.path}\0${m.line}`);
    }
  }

  // Rule C: same file, same privileged call target.
  if (groups.length < MAX_GROUPS) {
    const byFileCall = new Map<string, Map<string, Candidate[]>>();
    for (const c of candidates) {
      if (claimed.has(key(c))) continue;
      const call = privilegedCallIn(c.headLines, c.line, c.end);
      if (call === null) continue;
      let byCall = byFileCall.get(c.path);
      if (byCall === undefined) {
        byCall = new Map();
        byFileCall.set(c.path, byCall);
      }
      const list = byCall.get(call) ?? [];
      list.push(c);
      byCall.set(call, list);
    }
    const callGroups: EquivalentPathGroup[] = [];
    for (const byCall of byFileCall.values()) {
      for (const [call, list] of byCall) {
        const distinct = dedupeCandidates(list);
        if (distinct.length < 2) continue;
        callGroups.push({
          rule: "privileged_operation",
          shared: call,
          members: distinct.slice(0, MAX_MEMBERS_PER_GROUP).map(toMember),
        });
      }
    }
    callGroups.sort((a, b) => b.members.length - a.members.length || a.shared.localeCompare(b.shared));
    for (const g of callGroups) {
      if (groups.length >= MAX_GROUPS) break;
      groups.push(g);
    }
  }

  return { version: ARTIFACT_VERSION, groups };
}

function dedupeCandidates(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of list) {
    const k = `${c.path}\0${c.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const RULE_LABEL: Readonly<Record<EquivalentPathRule, string>> = {
  return_type: "share the declared return type",
  same_constructor: "construct the same shape (same keys, inline or via a shared local builder)",
  adapter_family: "are sibling adapter implementations of one method",
  privileged_operation: "call the same privileged operation",
};

/** Repo-derived values (diff-sourced paths, symbol names, object-literal
 * keys) are data, never markdown: a backtick inside a value would close
 * the surrounding code span early and let the rest of the line render as
 * markdown, and a CR/LF would split the member line in two (#252
 * adversarial boundary). Stripped before interpolation so every span stays
 * well formed — a mangled hostile value is acceptable here, since these
 * are pointer labels, not content. */
function sanitizeCodeSpan(value: string): string {
  return value.replace(/[`\r\n]/g, "");
}

/** Renders the "Equivalent paths to compare" section, or "" when there are
 * no groups (callers should treat "" as "omit the section"). */
export function renderEquivalentPathsMarkdown(artifact: EquivalentPathsArtifact): string {
  if (artifact.groups.length === 0) return "";
  const lines: string[] = [];
  lines.push("# Equivalent Paths to Compare");
  lines.push("");
  lines.push(
    "The groups below are changed functions/methods that look like alternate " +
    "routes to the same externally visible result. For each group: enumerate " +
    "the correctness/security invariants the first-listed member enforces " +
    "(identity/repo binding, authorization/origin checks, input validation " +
    "before use, error handling and fail-closed behavior, secret/redaction " +
    "handling, limits) and check every sibling member for the same. Report " +
    "only asymmetric enforcement — a sibling missing a check the others " +
    "have — as a finding; stylistic differences between the paths are out " +
    "of scope. A difference the code documents as deliberate (a comment or " +
    "docstring at the site explaining why the paths differ) is not a " +
    "missing check — weigh it, but do not report it as asymmetric " +
    "enforcement.",
  );
  lines.push("");
  artifact.groups.forEach((group, index) => {
    lines.push(`## Group ${index + 1}: ${RULE_LABEL[group.rule]} (\`${sanitizeCodeSpan(group.shared)}\`)`);
    for (const member of group.members) {
      lines.push(`- \`${sanitizeCodeSpan(member.path)}:${member.line}\` \`${sanitizeCodeSpan(member.name)}\``);
    }
    lines.push("");
  });
  return lines.join("\n").replace(/\n+$/, "\n");
}

export function renderEquivalentPathsJson(artifact: EquivalentPathsArtifact): string {
  return JSON.stringify(artifact);
}
