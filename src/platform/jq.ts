/** Minimal jq semantics for the platform-seam normalizers (#706 PR 1).
 *
 * The v2 seam (`scripts/platform_api.sh`) normalizes raw forge payloads with
 * inline jq programs. The v3 ports below reproduce those programs' observable
 * behavior, including the cases where jq raises (a raise makes the v2 shell
 * function fail, which callers treat as a fetch failure):
 *
 * - `.field` on `null` is `null`; on an object it is the own value or `null`;
 *   on anything else it is a type error;
 * - `.[]` iterates array elements or object values; anything else raises
 *   (`.[]?` swallows that error and yields nothing);
 * - `a // b` falls back to `b` only when `a` is `null` or `false`;
 * - `sort_by` is stable and orders by jq's total order: null < false < true <
 *   numbers < strings < arrays < objects, strings by Unicode code point;
 * - `jq -c` serialization is `JSON.stringify` plus jq's `\u007f` escape;
 * - an error on the left of `a // b` propagates (jq 1.8 behavior).
 *
 * Known representational limit: JavaScript parses JSON numbers into doubles,
 * so number literals jq 1.7+ would echo verbatim (`1.0`, integers beyond
 * 2^53, `1E+2`) cannot round-trip byte-for-byte. Forge payloads carry only
 * safe integers in the fields these programs touch. */

export class JqError extends Error {}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function jqTypeName(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  return typeof value;
}

/** jq truthiness: only `null` and `false` are falsy. */
export function jqTruthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

/** `a // b`. */
export function jqAlt(value: unknown, fallback: unknown): unknown {
  return jqTruthy(value) ? value : fallback;
}

/** `.key`. */
export function jqField(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return null;
  if (isPlainObject(value)) return hasOwn(value, key) ? value[key] : null;
  throw new JqError(`Cannot index ${jqTypeName(value)} with "${key}"`);
}

/** `.a.b.c`. */
export function jqPath(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) current = jqField(current, key);
  return current;
}

/** `.[]`. */
export function jqEach(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return Object.values(value);
  throw new JqError(`Cannot iterate over ${jqTypeName(value)}`);
}

/** `.[]?`. */
export function jqEachOpt(value: unknown): unknown[] {
  try {
    return jqEach(value);
  } catch {
    return [];
  }
}

function typeRank(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (typeof value === "number") return 3;
  if (typeof value === "string") return 4;
  if (Array.isArray(value)) return 5;
  return 6;
}

/** Code-point (== UTF-8 byte) order, which is how both jq and Python order
 * strings — unlike JavaScript's UTF-16 code-unit `<`. */
export function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

/** jq's total order over JSON values. */
export function jqCompare(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      const c = jqCompare(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort(compareCodePoints);
    const kb = Object.keys(b).sort(compareCodePoints);
    const keys = jqCompare(ka, kb);
    if (keys !== 0) return keys;
    for (const key of ka) {
      const c = jqCompare(a[key], b[key]);
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** Stable `sort_by(f)`; a multi-key `sort_by(f; g)` passes `[f, g]`. */
export function jqSortBy<T>(items: readonly T[], key: (item: T) => unknown): T[] {
  return items
    .map((item, index) => ({ item, index, key: key(item) }))
    .sort((x, y) => jqCompare(x.key, y.key) || x.index - y.index)
    .map(({ item }) => item);
}

/** `jq -c` output for one value (no trailing newline). */
export function jqCompact(value: unknown): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}
