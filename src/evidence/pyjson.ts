/** Python value semantics for the evidence-provider and SARIF ports (#706
 * PR 5a). `scripts/run_evidence_providers.py` and `pr_reviewer/sarif.py`
 * decode untrusted JSON with `json.loads`, branch on `isinstance(x, int)`,
 * stringify with `str()`, and persist with `json.dumps(indent=2,
 * ensure_ascii=False)`. `JSON.parse` cannot reproduce that: it folds `12.0`
 * into `12`, rejects `NaN`/`Infinity`, loses big-integer digits, and throws
 * differently worded errors that v2 renders verbatim into the artifacts.
 *
 * So this module carries a CPython-faithful decoder (the C scanner's
 * acceptance rules, error messages, and code-point positions; iterative, so
 * deep nesting cannot overflow the Node stack), a `PyFloat` box that keeps
 * float-ness through the pipeline (every plain JS `number` a decoded value
 * holds is an int; unsafe ints are `bigint`), and the `str()`, truthiness,
 * `strip()`, `int()` and `json.dumps` helpers the ports need. Pure data
 * transforms: no I/O, no process, no network. */

// ── Values ────────────────────────────────────────────────────────────────

/** A Python `float` decoded from JSON (or produced by the port). */
export class PyFloat {
  constructor(readonly value: number) {}

  toString(): string {
    return pyFloatRepr(this.value);
  }
}

/** A CPython exception the v2 code does NOT catch at that call site: the v2
 * script crashes and the shell seam writes the failure-fallback artifacts.
 * The v3 orchestrator lets it propagate to the same fallback. */
export class PyUncaughtError extends Error {
  constructor(readonly pyType: string, message: string) {
    super(message);
    this.name = "PyUncaughtError";
  }
}

/** `json.JSONDecodeError` (message already carries line/column/char). */
export class PyJsonDecodeError extends Error {
  constructor(readonly msg: string, readonly doc: string, readonly pos: number) {
    super(formatDecodeError(msg, doc, pos));
    this.name = "PyJsonDecodeError";
  }
}

/** `UnicodeDecodeError` from a strict UTF-8 decode. */
export class PyUnicodeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyUnicodeDecodeError";
  }
}

export function isPyDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof PyFloat);
}

/** `isinstance(value, int) and not isinstance(value, bool)`. JS non-integer
 * numbers (hand-built values, not decoder output) count as floats. */
export function pyIsStrictInt(value: unknown): value is number | bigint {
  return typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value));
}

function floatValueOf(value: unknown): number | null {
  if (value instanceof PyFloat) return value.value;
  if (typeof value === "number" && !Number.isInteger(value)) return value;
  return null;
}

// ── repr / str ────────────────────────────────────────────────────────────

/** `float.__repr__`: shortest round-trip digits, scientific outside
 * [1e-4, 1e16), always a `.0` on integral values. */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa, expText] = value.toExponential().split("e") as [string, string];
  const exponent = Number(expText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
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

// `str.isprintable()` is false for these categories (space excepted).
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** `repr(str)`. */
export function pyReprStr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, "0")}`;
      else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`;
      else out += `\\U${code.toString(16).padStart(8, "0")}`;
    } else out += ch;
  }
  return `${quote}${out}${quote}`;
}

function pyRepr(value: unknown): string {
  if (typeof value === "string") return pyReprStr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (isPyDict(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${pyReprStr(key)}: ${pyRepr(item)}`).join(", ")}}`;
  }
  return pyStr(value);
}

/** `str(value)` for a decoded JSON value. */
export function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  const float = floatValueOf(value);
  if (float !== null) return pyFloatRepr(float);
  if (typeof value === "number") return String(value);
  return pyRepr(value);
}

/** Python truthiness of a decoded JSON value. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPyDict(value)) return Object.keys(value).length > 0;
  return true;
}

// `str.isspace()` / `str.strip()` whitespace (differs from JS `trim`: adds
// \x1c-\x1f and \x85, excludes ﻿).
const PY_WS = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** `str.strip()` with no arguments. */
export function pyStrip(text: string): string {
  return text.replace(STRIP_RE, "");
}

const INT_TEXT = new RegExp(`^[${PY_WS}]*([+-]?)([0-9]+(?:_[0-9]+)*)[${PY_WS}]*$`);

/** `int(text)` for a str: ASCII digits with optional sign, between-digit
 * underscores and surrounding whitespace; null where Python raises
 * ValueError. (Non-ASCII decimal digits, which Python also accepts, are
 * treated as invalid.) */
export function pyIntFromText(text: string): number | bigint | null {
  const match = INT_TEXT.exec(text);
  if (!match) return null;
  const digits = (match[2] as string).replaceAll("_", "");
  const literal = `${match[1] === "-" ? "-" : ""}${digits}`;
  const big = BigInt(literal);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

/** `int(value)` for a decoded JSON value, as used inside
 * `try: ... except (TypeError, ValueError)`: null for those two, while the
 * OverflowError of `int(inf)` escapes (v2 crashes). */
export function pyIntOf(value: unknown): number | bigint | null {
  if (value === true) return 1;
  if (value === false) return 0;
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return pyIntFromText(value);
  const float = floatValueOf(value);
  if (float !== null) {
    if (Number.isNaN(float)) return null;
    if (!Number.isFinite(float)) throw new PyUncaughtError("OverflowError", "cannot convert float infinity to integer");
    const truncated = Math.trunc(float);
    return Number.isSafeInteger(truncated) ? truncated : BigInt(truncated);
  }
  if (typeof value === "number") return value;
  return null;
}

/** `pr_reviewer.env.env_int`: `max(int(raw), min_value)`, default on a
 * missing or unparsable value. */
export function pyEnvInt(env: NodeJS.ProcessEnv, name: string, fallback: number, minValue = 1): number {
  const raw = env[name];
  if (raw === undefined) return Math.max(fallback, minValue);
  const parsed = pyIntFromText(raw);
  if (parsed === null) return Math.max(fallback, minValue);
  return clampToNumber(parsed, minValue);
}

/** `max(value, minimum)` as a JS number (bigints saturate). */
export function clampToNumber(value: number | bigint, minimum: number): number {
  if (typeof value === "bigint") {
    if (value < BigInt(minimum)) return minimum;
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value);
  }
  return Math.max(value, minimum);
}

// ── UTF-8 ─────────────────────────────────────────────────────────────────

function decodeErrorMessage(buf: Uint8Array, start: number, end: number, reason: string): string {
  if (end - start === 1) {
    return `'utf-8' codec can't decode byte 0x${(buf[start] as number).toString(16).padStart(2, "0")} in position ${start}: ${reason}`;
  }
  return `'utf-8' codec can't decode bytes in position ${start}-${end - 1}: ${reason}`;
}

/** Strict `bytes.decode("utf-8")` (or `"utf-8-sig"` when *sig*), raising
 * `PyUnicodeDecodeError` with CPython's message and positions. */
export function decodeUtf8Strict(input: Uint8Array, sig = false): string {
  let buf = input;
  if (sig && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const lead = buf[i] as number;
    if (lead < 0x80) {
      i += 1;
      continue;
    }
    let need: number;
    let lo = 0x80;
    let hi = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) {
      need = 2;
      if (lead === 0xe0) lo = 0xa0;
      else if (lead === 0xed) hi = 0x9f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      need = 3;
      if (lead === 0xf0) lo = 0x90;
      else if (lead === 0xf4) hi = 0x8f;
    } else {
      throw new PyUnicodeDecodeError(decodeErrorMessage(buf, i, i + 1, "invalid start byte"));
    }
    for (let k = 1; k <= need; k += 1) {
      if (i + k >= n) throw new PyUnicodeDecodeError(decodeErrorMessage(buf, i, n, "unexpected end of data"));
      const byte = buf[i + k] as number;
      const min = k === 1 ? lo : 0x80;
      const max = k === 1 ? hi : 0xbf;
      if (byte < min || byte > max) throw new PyUnicodeDecodeError(decodeErrorMessage(buf, i, i + k, "invalid continuation byte"));
    }
    i += need + 1;
  }
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("utf8");
}

// ── json.loads ────────────────────────────────────────────────────────────

function formatDecodeError(msg: string, doc: string, pos: number): string {
  const prefix = Array.from(doc.slice(0, pos));
  const cpPos = prefix.length;
  let lineno = 1;
  let lastNewline = -1;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] === "\n") {
      lineno += 1;
      lastNewline = i;
    }
  }
  return `${msg}: line ${lineno} column ${cpPos - lastNewline} (char ${cpPos})`;
}

const INT_MAX_STR_DIGITS = 4300;

function isWs(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty: a `__proto__` key stays data, never a prototype write;
  // a duplicate key keeps its first position and takes the last value,
  // exactly like a Python dict built from pairs.
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

type Frame = { kind: "array"; items: unknown[] } | { kind: "object"; obj: Record<string, unknown>; key: string };

/** `json.loads(text)` with CPython's acceptance rules and error messages. */
export function pyJsonLoads(text: string): unknown {
  const s = text;
  const n = s.length;
  const fail = (msg: string, pos: number): never => {
    throw new PyJsonDecodeError(msg, s, pos);
  };
  if (s.charCodeAt(0) === 0xfeff) fail("Unexpected UTF-8 BOM (decode using utf-8-sig)", 0);

  const skipWs = (from: number): number => {
    let i = from;
    while (i < n && isWs(s.charCodeAt(i))) i += 1;
    return i;
  };

  const scanString = (afterQuote: number): [string, number] => {
    const begin = afterQuote - 1;
    let out = "";
    let i = afterQuote;
    for (;;) {
      let j = i;
      let code = -1;
      while (j < n) {
        code = s.charCodeAt(j);
        if (code === 0x22 || code === 0x5c) break;
        if (code <= 0x1f) fail("Invalid control character at", j);
        j += 1;
      }
      if (j >= n) fail("Unterminated string starting at", begin);
      out += s.slice(i, j);
      if (code === 0x22) return [out, j + 1];
      // Backslash escape.
      let next = j + 1;
      if (next >= n) fail("Unterminated string starting at", begin);
      const esc = s[next] as string;
      if (esc !== "u") {
        const mapped = ({ '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[esc];
        if (mapped === undefined) fail("Invalid \\escape", next - 1);
        out += mapped;
        i = next + 1;
        continue;
      }
      next += 1;
      const end = next + 4;
      if (end >= n) fail("Invalid \\uXXXX escape", next - 1);
      let c = 0;
      for (let k = next; k < end; k += 1) {
        const digit = hexValue(s.charCodeAt(k));
        if (digit < 0) fail("Invalid \\uXXXX escape", end - 5);
        c = (c << 4) | digit;
      }
      if (c >= 0xd800 && c <= 0xdbff && end + 6 < n && s[end] === "\\" && s[end + 1] === "u") {
        const secondEnd = end + 6;
        let c2 = 0;
        for (let k = end + 2; k < secondEnd; k += 1) {
          const digit = hexValue(s.charCodeAt(k));
          if (digit < 0) fail("Invalid \\uXXXX escape", secondEnd - 5);
          c2 = (c2 << 4) | digit;
        }
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          out += String.fromCharCode(c, c2);
          i = secondEnd;
          continue;
        }
      }
      out += String.fromCharCode(c);
      i = end;
    }
  };

  const matchNumber = (start: number): [unknown, number] | null => {
    let i = start;
    if (s.charCodeAt(i) === 0x2d) {
      i += 1;
      if (i >= n) return null;
    }
    const first = s.charCodeAt(i);
    if (first >= 0x31 && first <= 0x39) {
      i += 1;
      while (i < n && isDigit(s.charCodeAt(i))) i += 1;
    } else if (first === 0x30) {
      i += 1;
    } else {
      return null;
    }
    let isFloat = false;
    if (i < n - 1 && s.charCodeAt(i) === 0x2e && isDigit(s.charCodeAt(i + 1))) {
      isFloat = true;
      i += 2;
      while (i < n && isDigit(s.charCodeAt(i))) i += 1;
    }
    if (i < n && (s.charCodeAt(i) === 0x65 || s.charCodeAt(i) === 0x45)) {
      const eStart = i;
      i += 1;
      if (i < n && (s.charCodeAt(i) === 0x2d || s.charCodeAt(i) === 0x2b)) i += 1;
      while (i < n && isDigit(s.charCodeAt(i))) i += 1;
      if (isDigit(s.charCodeAt(i - 1))) isFloat = true;
      else i = eStart;
    }
    const literal = s.slice(start, i);
    if (isFloat) return [new PyFloat(Number(literal)), i];
    const digitCount = literal.startsWith("-") ? literal.length - 1 : literal.length;
    if (digitCount > INT_MAX_STR_DIGITS) {
      throw new PyUncaughtError(
        "ValueError",
        `Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${digitCount} digits; use sys.set_int_max_str_digits() to increase the limit`,
      );
    }
    const big = BigInt(literal);
    return [big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big, i];
  };

  const stack: Frame[] = [];
  let i = skipWs(0);
  let value: unknown;

  outer: for (;;) {
    // Scan one value starting at i.
    if (i >= n) fail("Expecting value", i);
    const ch = s[i] as string;
    if (ch === '"') {
      [value, i] = scanString(i + 1);
    } else if (ch === "{") {
      const j = skipWs(i + 1);
      if (s[j] === "}") {
        value = {};
        i = j + 1;
      } else {
        if (s[j] !== '"') fail("Expecting property name enclosed in double quotes", j);
        const [key, k0] = scanString(j + 1);
        const k = skipWs(k0);
        if (s[k] !== ":") fail("Expecting ':' delimiter", k);
        stack.push({ kind: "object", obj: {}, key });
        i = skipWs(k + 1);
        continue outer;
      }
    } else if (ch === "[") {
      const j = skipWs(i + 1);
      if (s[j] === "]") {
        value = [];
        i = j + 1;
      } else {
        stack.push({ kind: "array", items: [] });
        i = j;
        continue outer;
      }
    } else if (ch === "n" && s.startsWith("null", i)) {
      value = null;
      i += 4;
    } else if (ch === "t" && s.startsWith("true", i)) {
      value = true;
      i += 4;
    } else if (ch === "f" && s.startsWith("false", i)) {
      value = false;
      i += 5;
    } else if (ch === "N" && s.startsWith("NaN", i)) {
      value = new PyFloat(Number.NaN);
      i += 3;
    } else if (ch === "I" && s.startsWith("Infinity", i)) {
      value = new PyFloat(Number.POSITIVE_INFINITY);
      i += 8;
    } else if (ch === "-" && s.startsWith("-Infinity", i)) {
      value = new PyFloat(Number.NEGATIVE_INFINITY);
      i += 9;
    } else {
      const matched = matchNumber(i);
      if (matched === null) fail("Expecting value", i);
      [value, i] = matched as [unknown, number];
    }

    // Attach the finished value to its enclosing containers.
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) break outer;
      i = skipWs(i);
      if (top.kind === "array") {
        top.items.push(value);
        if (s[i] === "]") {
          value = top.items;
          stack.pop();
          i += 1;
          continue;
        }
        if (s[i] !== ",") fail("Expecting ',' delimiter", i);
        const j = skipWs(i + 1);
        if (s[j] === "]") fail("Illegal trailing comma before end of array", i);
        i = j;
        continue outer;
      }
      setKey(top.obj, top.key, value);
      if (s[i] === "}") {
        value = top.obj;
        stack.pop();
        i += 1;
        continue;
      }
      if (s[i] !== ",") fail("Expecting ',' delimiter", i);
      const j = skipWs(i + 1);
      if (s[j] === "}") fail("Illegal trailing comma before end of object", i);
      if (s[j] !== '"') fail("Expecting property name enclosed in double quotes", j);
      const [key, k0] = scanString(j + 1);
      const k = skipWs(k0);
      if (s[k] !== ":") fail("Expecting ':' delimiter", k);
      top.key = key;
      i = skipWs(k + 1);
      continue outer;
    }
  }

  const end = skipWs(i);
  if (end !== n) fail("Extra data", end);
  return value;
}

// ── json.dumps(indent=2, ensure_ascii=False) ──────────────────────────────

function escapeJsonString(text: string): string {
  let out = "";
  for (let idx = 0; idx < text.length; idx += 1) {
    const ch = text[idx] as string;
    const code = text.charCodeAt(idx);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

function dumpFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return pyFloatRepr(value);
}

function encodeValue(value: unknown, level: number): string {
  const pad = "  ".repeat(level + 1);
  const closePad = "  ".repeat(level);
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return `"${escapeJsonString(value)}"`;
  if (typeof value === "bigint") return value.toString();
  const float = floatValueOf(value);
  if (float !== null) return dumpFloat(float);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => `${pad}${encodeValue(item, level + 1)}`).join(",\n")}\n${closePad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{\n${entries.map(([key, item]) => `${pad}"${escapeJsonString(key)}": ${encodeValue(item, level + 1)}`).join(",\n")}\n${closePad}}`;
  }
  throw new TypeError(`pyJsonDumps: unsupported value ${typeof value}`);
}

/** `json.dumps(value, indent=2, ensure_ascii=False)`, insertion order. */
export function pyJsonDumps(value: unknown): string {
  return encodeValue(value, 0);
}

/** Python `round(x, 3)` for the non-negative durations the ports record. */
export function pyRound3(seconds: number): PyFloat {
  return new PyFloat(Number.parseFloat(seconds.toFixed(3)));
}
