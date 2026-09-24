/** Byte-exact replica of `json.dumps(..., ensure_ascii=False, indent=N)`
 * (default separators `,` / `: `, insertion order preserved) for the v3
 * context artifacts whose persisted documents are compared byte-for-byte by
 * the #675 parity harness (`repo-map.json`, `related-code.json`). The existing
 * `pythonJsonStringify` (sort_keys=True) covers the canonical-artifact VALUES;
 * this variant covers the *rendered documents*, whose v2 renderers emit keys
 * in fixed insertion order. Only the JSON shapes the artifacts contain are
 * supported (objects, arrays, strings, finite numbers, booleans, null). */

function escapeString(text: string): string {
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
        } else {
          out += ch;
        }
      }
    }
  }
  return out;
}

function encode(value: unknown, indent: number, level: number): string {
  const pad = " ".repeat(indent * (level + 1));
  const closePad = " ".repeat(indent * level);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${pad}${encode(item, indent, level + 1)}`);
    return `[\n${items.join(",\n")}\n${closePad}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const items = entries.map(([key, item]) => `${pad}${JSON.stringify(key)}: ${encode(item, indent, level + 1)}`);
    return `{\n${items.join(",\n")}\n${closePad}}`;
  }
  throw new TypeError(`pyJsonDump: unsupported value ${typeof value}`);
}

/** `json.dumps(value, ensure_ascii=False, indent=indent)` — insertion order. */
export function pyJsonDump(value: unknown, indent = 2): string {
  return encode(value, Math.min(Math.max(0, indent), 8), 0);
}
