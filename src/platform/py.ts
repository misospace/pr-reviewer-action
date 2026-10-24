/** Minimal Python semantics for the ports of `pr_reviewer/forgejo_backend.py`
 * normalizers (#706 PR 1): `dict.get` defaults, truthiness for `x or y`,
 * `str()` of JSON scalars, code-point string ordering, and
 * `urllib.parse.quote(s, safe=""), and bare `str.strip()`. A Python normalizer that would raise
 * (e.g. `.get` on a non-dict) throws `PyError`; the v2 CLI then exits
 * nonzero, which the shell seam reports as a failed fetch. */

import { compareCodePoints, isPlainObject } from "./jq.js";

export class PyError extends Error {}

/** `obj.get(key, default)` — a present key wins even when its value is null. */
export function pyGet(record: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : fallback;
}

/** Require a dict, as a Python `.get` call on the value would. */
export function pyDict(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new PyError(`'${what}' is not a dict`);
  return value;
}

export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** `a or b`. */
export function pyOr(value: unknown, fallback: unknown): unknown {
  return pyTruthy(value) ? value : fallback;
}

/** `isinstance(value, int)` for a JSON value: bool is an int subclass.
 * JSON `3.0` parses to a JS integer, so it cannot be told apart from `3`. */
export function pyIsInt(value: unknown): boolean {
  return typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value));
}

/** `repr(float)`: shortest round-trip digits, Python's fixed/exponent
 * switch points, and `N.0` for integral values. */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const [mantissa, expText] = value.toExponential().split("e");
  const exponent = Number(expText);
  const negative = mantissa!.startsWith("-");
  const digits = mantissa!.replace("-", "").replace(".", "");
  const sign = negative ? "-" : "";
  if (exponent < -4 || exponent >= 16) {
    const frac = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const expSign = exponent < 0 ? "-" : "+";
    return `${sign}${frac}e${expSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  const intPart = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  const fracPart = digits.slice(exponent + 1);
  return `${sign}${intPart}.${fracPart || "0"}`;
}

// ── whitespace strip -------------------------------------------------------

/** Python `str.isspace()`: the code points a bare `str.strip()` removes
 * (JS `trim()` strips U+FEFF, and misses U+001C..U+001F). Every member is
 * BMP, so scanning UTF-16 code units is code-point-faithful. */
export function isPySpaceCode(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    (code >= 0x1c && code <= 0x20) ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Python `str.lstrip()` with no argument. */
export function pyLstrip(text: string): string {
  let i = 0;
  while (i < text.length && isPySpaceCode(text.charCodeAt(i))) i += 1;
  return text.slice(i);
}

/** Python `str.rstrip()` with no argument. */
export function pyRstrip(text: string): string {
  let end = text.length;
  while (end > 0 && isPySpaceCode(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

/** Python `str.strip()` with no argument. */
export function pyStrip(text: string): string {
  return pyRstrip(pyLstrip(text));
}

export function pyReprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") return pyReprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isPlainObject(value)) {
    return `{${Object.entries(value).map(([k, v]) => `${pyReprString(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return pyStr(value);
}

/** `str(value)` for a JSON value. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  return pyRepr(value);
}

/** Python ordering of `(str, str, ...)` tuples. */
export function pyCompareTuples(a: readonly string[], b: readonly string[]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const c = compareCodePoints(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

const QUOTE_SAFE = /[A-Za-z0-9_.~-]/;

/** `urllib.parse.quote(text, safe="")`: every UTF-8 byte outside
 * `[A-Za-z0-9_.~-]` becomes `%XX` (uppercase hex). */
export function pyQuote(text: string): string {
  let out = "";
  for (const ch of text) {
    if (QUOTE_SAFE.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}
