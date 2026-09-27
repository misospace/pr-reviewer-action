/** Byte-exact port of `scripts/strip_source_text.py` (#706 PR 5b): reduce a
 * fetched linked-source body to corpus-worthy text. HTML pages are stripped
 * to visible text (script/style/noscript/svg/head blocks dropped, tags
 * removed, entities unescaped, whitespace collapsed); non-HTML passes
 * through. The result is capped at `maxBytes` on a clean UTF-8 boundary.
 *
 * Every Python primitive the script leans on is reproduced here rather than
 * approximated: `bytes.decode("utf-8", errors="ignore")` (maximal-subpart
 * dropping, not U+FFFD), `str.isspace` whitespace (which differs from JS
 * `\s`: it includes U+001C–U+001F and U+0085 but not U+FEFF), code-point
 * `len`/slicing, the unicode `\b` after a tag name, and `html.unescape` with
 * CPython's HTML5 entity tables. The two quadratic regexes in the Python
 * source are replaced by linear scans with identical match semantics, so a
 * hostile body cannot pin the event loop. */

import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./html-entities.js";

/** A Python exception the ported code raises where v2 would (the v2 caller
 * propagates it, aborting the linked-sources render). */
export class PyValueError extends Error {
  constructor(message: string) {
    super(`ValueError: ${message}`);
    this.name = "PyValueError";
  }
}

// --- bytes.decode("utf-8", errors="ignore") ---------------------------------

/** CPython's UTF-8 decoder with `errors="ignore"`: every maximal invalid
 * subpart is dropped (surrogates, overlongs and bytes >= 0xF5 are invalid). */
export function pyDecodeUtf8Ignore(bytes: Uint8Array): string {
  const out: number[] = [];
  let text = "";
  const flush = (): void => {
    if (out.length > 0) {
      text += String.fromCodePoint(...out);
      out.length = 0;
    }
  };
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out.push(b0);
      i += 1;
    } else {
      let need: number;
      let lo = 0x80;
      let hi = 0xbf;
      let cp: number;
      if (b0 >= 0xc2 && b0 <= 0xdf) {
        need = 1;
        cp = b0 & 0x1f;
      } else if (b0 >= 0xe0 && b0 <= 0xef) {
        need = 2;
        cp = b0 & 0x0f;
        if (b0 === 0xe0) lo = 0xa0;
        if (b0 === 0xed) hi = 0x9f;
      } else if (b0 >= 0xf0 && b0 <= 0xf4) {
        need = 3;
        cp = b0 & 0x07;
        if (b0 === 0xf0) lo = 0x90;
        if (b0 === 0xf4) hi = 0x8f;
      } else {
        i += 1; // invalid start byte: dropped
        continue;
      }
      let j = i + 1;
      let ok = true;
      for (let k = 0; k < need; k += 1) {
        if (j >= n) {
          ok = false;
          break;
        }
        const b = bytes[j]!;
        const low = k === 0 ? lo : 0x80;
        const high = k === 0 ? hi : 0xbf;
        if (b < low || b > high) {
          ok = false;
          break;
        }
        cp = (cp << 6) | (b & 0x3f);
        j += 1;
      }
      if (ok) out.push(cp);
      // On failure the maximal subpart [i, j) is dropped and decoding resumes
      // at the offending byte.
      i = j;
    }
    if (out.length >= 8192) flush();
  }
  flush();
  return text;
}

// --- Python str helpers ---------------------------------------------------------

/** `str.isspace()` code points (CPython: bidirectional WS/B/S or Zs). */
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_LSTRIP_RE = new RegExp(`^[${PY_SPACE}]+`, "u");
const PY_SPACE_CHAR_RE = new RegExp(`^[${PY_SPACE}]$`, "u");
const BLANK_LINES_RE = new RegExp(`\\n[${PY_SPACE}]*\\n+`, "gu");

/** Number of code points (`len(str)`). */
export function pyLen(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

/** `text[:n]` by code points. */
export function pyPrefix(text: string, n: number): string {
  let count = 0;
  let i = 0;
  while (i < text.length && count < n) {
    const code = text.charCodeAt(i);
    i += code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    count += 1;
  }
  return text.slice(0, i);
}

/** `str.strip()` (linear: a `[ws]+$` regex backtracks quadratically over a
 * long interior whitespace run). All `str.isspace` code points are BMP. */
export function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_SPACE_CHAR_RE.test(text[start]!)) start += 1;
  while (end > start && PY_SPACE_CHAR_RE.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

// --- looks_like_html / strip_html ---------------------------------------------

export function looksLikeHtml(text: string): boolean {
  const head = pyPrefix(text, 512).replace(PY_LSTRIP_RE, "").toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<") || head.includes("<body");
}

/** Python's IGNORECASE equivalents for the tag-name letters (computed from
 * CPython's sre: `i` also matches U+0130/U+0131, `s` also matches U+017F). */
const LETTER_CLASS: Record<string, string> = { i: "[Iiİı]", s: "[Ssſ]" };
const TAG_NAMES = ["script", "style", "noscript", "svg", "head"]
  .map((name) => [...name].map((ch) => LETTER_CLASS[ch] ?? `[${ch.toUpperCase()}${ch}]`).join(""))
  .join("|");
const BLOCK_OPENER_RE = new RegExp(`<(${TAG_NAMES})(?![\\p{L}\\p{N}_])`, "gu");
const BLOCK_CLOSER_RE = new RegExp(`<\\/(${TAG_NAMES})>`, "gu");

/** sre's simple lowercase for the characters a tag name can contain. */
function sreLower(ch: string): string {
  return ch === "İ" ? "i" : ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
}

/** CPython's backreference under IGNORECASE compares sre simple lowercase
 * mappings code point by code point (no special case folding), so a closer
 * matches an opener exactly when their lowered names are equal. */
function backrefKey(name: string): string {
  return [...name].map(sreLower).join("");
}

/** `re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", text)`
 * in linear time: for each opener (leftmost first) the lazy `.*?` ends at the
 * first later closer whose name matches the opener's case-insensitively. */
function dropBlocks(text: string): string {
  const closers = new Map<string, Array<{ index: number; end: number }>>();
  for (const match of text.matchAll(BLOCK_CLOSER_RE)) {
    const key = backrefKey(match[1]!);
    const list = closers.get(key) ?? [];
    list.push({ index: match.index, end: match.index + match[0].length });
    closers.set(key, list);
  }
  if (closers.size === 0) return text;
  const pointers = new Map<string, number>();
  let out = "";
  let cursor = 0;
  for (;;) {
    BLOCK_OPENER_RE.lastIndex = cursor;
    const opener = BLOCK_OPENER_RE.exec(text);
    if (!opener) break;
    const bodyStart = opener.index + opener[0].length;
    const key = backrefKey(opener[1]!);
    const list = closers.get(key) ?? [];
    // Openers are visited in increasing position, so each list's pointer
    // only moves forward.
    let k = pointers.get(key) ?? 0;
    while (k < list.length && list[k]!.index < bodyStart) k += 1;
    pointers.set(key, k);
    const found = list[k];
    if (found === undefined) {
      // No closer for this opener: the regex fails here and retries at the
      // next position (the opener's text stays).
      out += text.slice(cursor, opener.index + 1);
      cursor = opener.index + 1;
      continue;
    }
    out += `${text.slice(cursor, opener.index)} `;
    cursor = found.end;
  }
  return out + text.slice(cursor);
}

/** `re.sub(r"(?s)<[^>]+>", " ", text)` in linear time. */
function dropTags(text: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf("<", cursor);
    if (open === -1) break;
    const close = text.indexOf(">", open + 1);
    if (close === -1) break; // no later '>' can close any '<'
    if (close === open + 1) {
      out += text.slice(cursor, open + 1); // "<>" needs one non-'>' char
      cursor = open + 1;
      continue;
    }
    // `[^>]+` greedily runs to the first '>' — which may include more '<'.
    out += `${text.slice(cursor, open)} `;
    cursor = close + 1;
  }
  return out + text.slice(cursor);
}

// --- html.unescape -------------------------------------------------------------

const CHARREF_RE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;
const PY_INT_MAX_STR_DIGITS = 4300;

function numericCharref(num: number): string {
  const invalid = INVALID_CHARREFS.get(num);
  if (invalid !== undefined) return invalid;
  if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
  if (INVALID_CODEPOINTS.has(num)) return "";
  return String.fromCodePoint(num);
}

function parseDigits(digits: string, radix: 10 | 16): number {
  const trimmed = digits.replace(/^0+/, "");
  // Anything past 7 significant digits is > 0x10FFFF in either radix.
  return trimmed.length > 7 ? Number.POSITIVE_INFINITY : trimmed === "" ? 0 : Number.parseInt(trimmed, radix);
}

function replaceCharref(ref: string): string {
  if (ref.startsWith("#")) {
    if (ref[1] === "x" || ref[1] === "X") return numericCharref(parseDigits(ref.slice(2).replace(/;+$/, ""), 16));
    const digits = ref.slice(1).replace(/;+$/, "");
    if (digits.length > PY_INT_MAX_STR_DIGITS) {
      throw new PyValueError(`Exceeds the limit (${PY_INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${digits.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
    }
    return numericCharref(parseDigits(digits, 10));
  }
  const exact = HTML5_ENTITIES.get(ref);
  if (exact !== undefined) return exact;
  const points = [...ref];
  for (let x = points.length - 1; x > 1; x -= 1) {
    const prefix = points.slice(0, x).join("");
    const hit = HTML5_ENTITIES.get(prefix);
    if (hit !== undefined) return hit + points.slice(x).join("");
  }
  return `&${ref}`;
}

/** `html.unescape(s)`. */
export function pyHtmlUnescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF_RE, (_match, ref: string) => replaceCharref(ref));
}

export function stripHtml(text: string): string {
  let out = dropBlocks(text);
  out = dropTags(out);
  out = pyHtmlUnescape(out);
  out = out.replace(/[ \t]+/g, " ");
  out = out.replace(BLANK_LINES_RE, "\n");
  return pyStrip(out);
}

/** `reduce_source(data, max_bytes)`. */
export function reduceSource(data: Uint8Array, maxBytes: number): string {
  const bytes = Uint8Array.from(data, (b) => (b === 0 ? 0x20 : b));
  let text = pyDecodeUtf8Ignore(bytes);
  if (looksLikeHtml(text)) text = stripHtml(text);
  const encoded = Buffer.from(text, "utf8");
  let clipped = pyDecodeUtf8Ignore(encoded.subarray(0, Math.max(0, maxBytes)));
  if (pyLen(clipped) < pyLen(text)) clipped += "\n…[source truncated]";
  return clipped;
}

/** `linked_sources.strip_source_to_text(raw_bytes, max_bytes=4000)`. */
export function stripSourceToText(raw: Uint8Array, maxBytes = 4000): string {
  return reduceSource(raw, maxBytes);
}
