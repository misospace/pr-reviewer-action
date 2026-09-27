/** Byte-exact replica of `json.dumps(..., ensure_ascii=False, indent=N)`
 * (default separators `,` / `: `, insertion order preserved) for the v3
 * context artifacts whose persisted documents are compared byte-for-byte by
 * the #675 parity harness (`repo-map.json`, `related-code.json`). The existing
 * `pythonJsonStringify` (sort_keys=True) covers the canonical-artifact VALUES;
 * this variant covers the *rendered documents*, whose v2 renderers emit keys
 * in fixed insertion order. Only the JSON shapes the artifacts contain are
 * supported (objects, arrays, strings, finite numbers, booleans, null). */

import { pyFloatRepr } from "../platform/py.js";

function escapeString(text: string, ensureAscii = false): string {
  let out = "";
  for (const ch of text) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20) {
          out += `\\u${code.toString(16).padStart(4, "0")}`;
        } else if (ensureAscii && code > 0x7e) {
          // Python escapes astral characters as a UTF-16 surrogate pair.
          for (let i = 0; i < ch.length; i++) out += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return out;
}

export interface PyJsonDumpOptions {
  /** Python's default `ensure_ascii`: escape everything above `~`. */
  ensureAscii?: boolean;
  /** Object keys whose numeric values are Python floats (`round(x, 3)`,
   * `float(raw)`): rendered as `repr(float)` — `0.0`, not `0` — because a
   * JavaScript number cannot remember that it was a float. */
  floatKeys?: ReadonlySet<string>;
}

function encode(value: unknown, indent: number, level: number, options: PyJsonDumpOptions = {}, key: string | null = null): string {
  const ensureAscii = options.ensureAscii === true;
  const pad = " ".repeat(indent * (level + 1));
  const closePad = " ".repeat(indent * level);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `"${escapeString(value, ensureAscii)}"`;
  if (typeof value === "number") {
    if (key !== null && options.floatKeys?.has(key) === true) return pyFloatRepr(value);
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${pad}${encode(item, indent, level + 1, options, key)}`);
    return `[\n${items.join(",\n")}\n${closePad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const items = entries.map(([name, item]) => {
      const keyText = ensureAscii ? `"${escapeString(name, true)}"` : JSON.stringify(name);
      return `${pad}${keyText}: ${encode(item, indent, level + 1, options, name)}`;
    });
    return `{\n${items.join(",\n")}\n${closePad}}`;
  }
  throw new TypeError(`pyJsonDump: unsupported value ${typeof value}`);
}

/** `json.dumps(value, ensure_ascii=ensureAscii, indent=indent)` — insertion
 * order. `ensureAscii` (Python's default) escapes everything above `~`;
 * `options.floatKeys` renders the named keys' numbers as Python floats. */
export function pyJsonDump(value: unknown, indent = 2, ensureAscii = false, options: Omit<PyJsonDumpOptions, "ensureAscii"> = {}): string {
  return encode(value, Math.min(Math.max(0, indent), 8), 0, { ...options, ensureAscii });
}

function escapeAscii(text: string): string {
  let out = "";
  for (const unit of escapeString(text)) {
    const code = unit.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out += unit;
    } else if (code > 0xffff) {
      const offset = code - 0x10000;
      out += `\\u${(0xd800 + (offset >> 10)).toString(16)}\\u${(0xdc00 + (offset & 0x3ff)).toString(16)}`;
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return out;
}

/** Single-line `json.dumps(value, ensure_ascii=..., separators=...)` —
 * insertion order. Python's defaults are `ensure_ascii=True` and the
 * `(", ", ": ")` separators. */
export function pyJsonDumpsLine(
  value: unknown,
  options: { ensureAscii?: boolean; separators?: readonly [string, string] } = {},
): string {
  const ensureAscii = options.ensureAscii ?? true;
  const [itemSep, keySep] = options.separators ?? [", ", ": "];
  const str = (text: string): string => `"${ensureAscii ? escapeAscii(text) : escapeString(text)}"`;
  const walk = (item: unknown): string => {
    if (item === null || item === undefined) return "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "string") return str(item);
    if (typeof item === "number") return String(item);
    if (Array.isArray(item)) return `[${item.map(walk).join(itemSep)}]`;
    if (typeof item === "object") {
      return `{${Object.entries(item as Record<string, unknown>).map(([key, entry]) => `${str(key)}${keySep}${walk(entry)}`).join(itemSep)}}`;
    }
    throw new TypeError(`pyJsonDumpsLine: unsupported value ${typeof item}`);
  };
  return walk(value);
}
