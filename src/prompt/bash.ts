/** Bash and jq semantics the v2 prompt layer depends on (#706 PR 4).
 *
 * The v2 prompt assembly is shell code (`scripts/sections/config.sh`,
 * `review.sh`); its observable bytes come from a handful of shell idioms,
 * reproduced here exactly:
 *
 * - `$(...)` / `$(<file)` drop NUL bytes and strip ALL trailing newlines;
 * - `printf '%s' "$x" | tr '[:upper:]' '[:lower:]'` inside `$(...)` is an
 *   ASCII lowercase followed by the same trailing-newline strip;
 * - `${var/pattern/repl}` with a brace-escaped literal pattern replaces the
 *   FIRST occurrence only. The replacement is inserted literally here; bash
 *   >= 5.2 (`patsub_replacement`) would expand an unquoted `&` in it to the
 *   matched text, so the bundled fragments must never contain `&` or `\`
 *   (pinned by tests-v3/prompt-assembly.test.ts);
 * - `[[ -f p ]]` is "exists and is a regular file" and `[[ -s p ]]` is
 *   "exists and has size > 0" (any file type), both following symlinks. */

import { statSync, readFileSync } from "node:fs";
import path from "node:path";

/** `$(...)` capture: NULs dropped, trailing newlines stripped. */
export function bashCapture(text: string): string {
  return text.replace(/\0/g, "").replace(/\n+$/, "");
}

/** `$(printf '%s' "$x" | tr '[:upper:]' '[:lower:]')`. */
export function bashLowerCapture(text: string): string {
  return bashCapture(text.replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

/** `${haystack/<literal>/replacement}` — first occurrence, literal insert. */
export function bashReplaceFirst(haystack: string, literal: string, replacement: string): string {
  const at = haystack.indexOf(literal);
  if (at < 0) return haystack;
  return haystack.slice(0, at) + replacement + haystack.slice(at + literal.length);
}

/** The filesystem view the v2 prompt layer reads: the review workspace
 * (presence files, `classification.json`, a relative `SYSTEM_PROMPT_FILE`). */
export interface PromptWorkspace {
  /** `[[ -f p ]]`. */
  isFile(p: string): boolean;
  /** `[[ -s p ]]`. */
  isNonEmpty(p: string): boolean;
  /** Raw bytes, or null when unreadable. */
  readBytes(p: string): Buffer | null;
}

/** A `PromptWorkspace` rooted at `cwd` (relative paths resolve against it,
 * exactly as the v2 shell resolves them against its working directory). */
export function workspaceAt(cwd: string): PromptWorkspace {
  const resolve = (p: string) => path.resolve(cwd, p);
  return {
    isFile(p) {
      try {
        return statSync(resolve(p)).isFile();
      } catch {
        return false;
      }
    },
    isNonEmpty(p) {
      try {
        return statSync(resolve(p)).size > 0;
      } catch {
        return false;
      }
    },
    readBytes(p) {
      try {
        return readFileSync(resolve(p));
      } catch {
        return null;
      }
    },
  };
}

/** Bytes as bash sees them after `$(<file)`: NULs dropped, trailing
 * newlines stripped. Invalid UTF-8 decodes to U+FFFD (bash passes the raw
 * bytes through; the v3 runtime carries prompts as strings). */
export function bashReadCapture(bytes: Buffer): string {
  return bashCapture(bytes.toString("utf8"));
}

/** Split a jq input stream into its top-level JSON texts. Stops at the first
 * text jq could not parse (`error` = true); texts before it are returned. */
function jqInputs(text: string): { values: unknown[]; error: boolean } {
  const values: unknown[] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // jq strips a leading BOM
  const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < text.length) {
    while (i < text.length && isWs(text[i]!)) i += 1;
    if (i >= text.length) break;
    const start = i;
    const first = text[i]!;
    if (first === "{" || first === "[") {
      let depth = 0;
      let inString = false;
      for (; i < text.length; i += 1) {
        const c = text[i]!;
        if (inString) {
          if (c === "\\") i += 1;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === "{" || c === "[") depth += 1;
        else if (c === "}" || c === "]") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
    } else if (first === '"') {
      for (i += 1; i < text.length; i += 1) {
        const c = text[i]!;
        if (c === "\\") i += 1;
        else if (c === '"') {
          i += 1;
          break;
        }
      }
    } else {
      while (i < text.length && !isWs(text[i]!) && !'{}[]",:'.includes(text[i]!)) i += 1;
      if (i === start) return { values, error: true };
    }
    try {
      values.push(JSON.parse(text.slice(start, i)));
    } catch {
      return { values, error: true };
    }
  }
  return { values, error: false };
}

/** `kind="$(jq -r '.pr_kind // ""' classification.json 2>/dev/null || echo "")"`.
 *
 * Per input: an object or `null` yields `.pr_kind // ""` (a string raw, any
 * other value as JSON — it can never equal a kind literal); a non-object
 * raises, which jq 1.8 reports without output before moving to the next
 * input; a parse error ends the stream. The `|| echo ""` newline is always
 * trailing and so always stripped by the capture. */
export function jqRawPrKind(text: string): string {
  const { values } = jqInputs(text);
  let out = "";
  for (const value of values) {
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) continue;
    const field = value === null ? null : Object.prototype.hasOwnProperty.call(value, "pr_kind") ? (value as Record<string, unknown>).pr_kind : null;
    const alt = field === null || field === false || field === undefined ? "" : field;
    out += `${typeof alt === "string" ? alt : JSON.stringify(alt)}\n`;
  }
  return bashCapture(out);
}
