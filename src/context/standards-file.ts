/** Standards-file resolution (#706 PR 3): port of `resolve_standards_file`
 * in scripts/sections/config.sh.
 *
 * v2 keeps `$STANDARDS_FILE` when it names a regular file; otherwise it walks
 * the comma-separated `$STANDARDS_FILE_CANDIDATES` (`IFS=',' read -ra`, so
 * only the first line counts and a trailing empty field is dropped), trims
 * each with `printf '%s' "$candidate" | xargs`, word-splits the result, and
 * glob-expands each word with `nullglob` (`matches=( $candidate )`). The
 * first match that is a regular file (`[[ -f ]]`, symlinks followed) wins.
 * When nothing matches, the incoming value is returned unchanged.
 *
 * `xargs` follows GNU findutils (the production runners): blanks and
 * newlines separate arguments, `'`/`"` quote without escapes, `\` escapes
 * the next character, and an unterminated quote runs `echo` with the
 * arguments collected so far before failing. `echo` consumes leading
 * `-n`/`-e`/`-E` option words.
 *
 * Globbing follows bash 5.2+ defaults: `*`, `?` and `[...]` (with `!`/`^`
 * negation, ranges and `[:class:]`), `\` escapes, a leading `.` must be
 * matched literally, `.`/`..` never match (`globskipdots`), and the result
 * list is sorted by code point (C.UTF-8 collation). Paths are relative to
 * the workspace, exactly as v2 resolves them from its working directory. */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { compareCodePoints } from "../platform/jq.js";

export const DEFAULT_STANDARDS_FILE_CANDIDATES =
  "AGENTS.md,agents.md,CLAUDE.md,claude.md,.github/ai-review-rules.md,.github/ai-review-rules.txt";

/** `printf '%s' "$text" | xargs` stdout, with `$(...)`'s trailing-newline
 * strip applied. */
export function xargsEcho(text: string): string {
  const args: string[] = [];
  let arg = "";
  let inArg = false;
  let quote = "";
  let escaped = false;
  const echo = (): string => {
    let index = 0;
    while (index < args.length && /^-[neE]+$/.test(args[index] as string)) index += 1;
    return args.slice(index).join(" ");
  };
  for (const ch of text) {
    if (escaped) {
      arg += ch;
      escaped = false;
      continue;
    }
    if (quote !== "") {
      if (ch === "\n") return echo();
      if (ch === quote) quote = "";
      else arg += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (inArg) args.push(arg);
      arg = "";
      inArg = false;
      continue;
    }
    inArg = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") escaped = true;
    else arg += ch;
  }
  if (quote !== "") return echo();
  if (inArg) args.push(arg);
  return echo();
}

interface Bracket {
  source: string;
  end: number;
}

const CLASSES: Record<string, string> = {
  alnum: "\\p{L}\\p{Nd}",
  alpha: "\\p{L}",
  blank: " \\t",
  cntrl: "\\p{Cc}",
  digit: "0-9",
  lower: "\\p{Ll}",
  punct: "!-\\/:-@\\[-`{-~",
  space: "\\s",
  upper: "\\p{Lu}",
  xdigit: "0-9A-Fa-f",
};

const reEscape = (ch: string): string => ch.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
const classEscape = (ch: string): string => ch.replace(/[\\\]\[^-]/g, "\\$&");

/** Parse a bracket expression starting at `chars[start] === "["`; `null`
 * when it has no closing `]` (the `[` is then literal). */
function parseBracket(chars: string[], start: number): Bracket | null {
  let i = start + 1;
  let negate = false;
  if (chars[i] === "!" || chars[i] === "^") {
    negate = true;
    i += 1;
  }
  const items: string[] = [];
  let first = true;
  while (i < chars.length) {
    const ch = chars[i] as string;
    if (ch === "]" && !first) {
      const body = items.join("");
      if (body === "") return null;
      return { source: negate ? `[^${body}]` : `[${body}]`, end: i };
    }
    first = false;
    if (ch === "[" && chars[i + 1] === ":") {
      const close = chars.indexOf(":", i + 2);
      if (close > 0 && chars[close + 1] === "]") {
        const name = chars.slice(i + 2, close).join("");
        const cls = CLASSES[name];
        if (cls !== undefined) {
          items.push(cls);
          i = close + 2;
          continue;
        }
      }
    }
    let literal = ch;
    if (ch === "\\" && i + 1 < chars.length) {
      i += 1;
      literal = chars[i] as string;
    }
    if (chars[i + 1] === "-" && i + 2 < chars.length && chars[i + 2] !== "]") {
      let upper = chars[i + 2] as string;
      let next = i + 3;
      if (upper === "\\" && i + 3 < chars.length) {
        upper = chars[i + 3] as string;
        next = i + 4;
      }
      if (compareCodePoints(literal, upper) <= 0) items.push(`${classEscape(literal)}-${classEscape(upper)}`);
      i = next;
      continue;
    }
    items.push(classEscape(literal));
    i += 1;
  }
  return null;
}

/** True when bash would treat the word as a glob pattern. */
export function isGlobPattern(word: string): boolean {
  const chars = [...word];
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "?") return true;
    if (ch === "[" && parseBracket(chars, i) !== null) return true;
  }
  return false;
}

function componentRegex(component: string): RegExp {
  const chars = [...component];
  let source = "";
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] as string;
    if (ch === "\\" && i + 1 < chars.length) {
      i += 1;
      source += reEscape(chars[i] as string);
    } else if (ch === "*") {
      source += "[^]*";
    } else if (ch === "?") {
      source += "[^]";
    } else if (ch === "[") {
      const bracket = parseBracket(chars, i);
      if (bracket === null) {
        source += "\\[";
      } else {
        source += bracket.source;
        i = bracket.end;
      }
    } else {
      source += reEscape(ch);
    }
  }
  return new RegExp(`^${source}$`, "u");
}

const unescape = (component: string): string => component.replace(/\\(.)/gu, "$1");

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Bash pathname expansion of one word under `nullglob`. */
export function expandGlob(word: string, workspace: string): string[] {
  if (!isGlobPattern(word)) return [word];
  const absolute = word.startsWith("/");
  const components = word.split("/").filter((part, index) => !(index === 0 && part === "" && absolute));
  if (components.length === 0 || components[components.length - 1] === "") return [];
  const fsPath = (display: string): string => (display.startsWith("/") ? display : display === "" ? workspace : `${workspace}/${display}`);
  const join = (base: string, name: string): string => (base === "" ? name : base.endsWith("/") ? `${base}${name}` : `${base}/${name}`);
  let paths = [absolute ? "/" : ""];
  components.forEach((component, index) => {
    const last = index === components.length - 1;
    const next: string[] = [];
    if (!isGlobPattern(component)) {
      const name = unescape(component);
      for (const base of paths) {
        const candidate = join(base, name);
        if (exists(fsPath(candidate)) && (last || isDirectory(fsPath(candidate)))) next.push(candidate);
      }
    } else {
      const pattern = componentRegex(component);
      const explicitDot = component.startsWith(".") || component.startsWith("\\.");
      for (const base of paths) {
        let entries: string[];
        try {
          entries = readdirSync(fsPath(base));
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name === "." || name === "..") continue;
          if (name.startsWith(".") && !explicitDot) continue;
          if (!pattern.test(name)) continue;
          const candidate = join(base, name);
          if (!last && !isDirectory(fsPath(candidate))) continue;
          next.push(candidate);
        }
      }
    }
    paths = next;
  });
  return paths.sort(compareCodePoints);
}

export interface StandardsFileInput {
  /** `$STANDARDS_FILE` as configured (possibly empty). */
  standardsFile: string;
  /** `$STANDARDS_FILE_CANDIDATES` (config default applied by the caller). */
  candidates: string;
  /** The checked-out repository (v2's working directory). */
  workspace: string;
}

/** The resolved `$STANDARDS_FILE` value. */
export function resolveStandardsFile(input: StandardsFileInput): string {
  const fsPath = (path: string): string => (path.startsWith("/") ? path : `${input.workspace}/${path}`);
  if (input.standardsFile !== "" && isRegularFile(fsPath(input.standardsFile))) return input.standardsFile;
  const firstLine = input.candidates.split("\n")[0] ?? "";
  const fields = firstLine.split(",");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  for (const field of fields) {
    const candidate = xargsEcho(field);
    if (candidate === "") continue;
    for (const word of candidate.split(/[ \t\n]+/).filter((part) => part !== "")) {
      for (const match of expandGlob(word, input.workspace)) {
        if (isRegularFile(fsPath(match))) return match;
      }
    }
  }
  return input.standardsFile;
}
