/** The prototype-strict plain-object guard shared by the durable-contract
 * validators: a plain object is `typeof "object"`, not null, and its
 * prototype is `Object.prototype` or `null`. The prototype check alone
 * already excludes arrays (`Array.prototype`), class instances, and host
 * objects (Date, Map, ...), so those shapes fail closed everywhere the
 * guard is applied; `Object.create(null)` stays a plain object.
 *
 * This is deliberately DISTINCT from `isPlainObject` in `./jq.ts`: the jq
 * projection semantics treat any non-array object as a mapping, while the
 * contract validators reject exotic prototypes. One canonical definition
 * per semantic, so the two families cannot drift. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
