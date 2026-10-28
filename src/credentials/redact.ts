/** Exact-value secret redaction for #735 logs and artifacts.
 *
 * DISTINCT from `src/context/redact.ts` (which pattern-masks UNTRUSTED
 * content before it reaches a prompt corpus): this scrubber knows the LIVE
 * secret values one run was handed — the `WorkerSecretSet` material — and
 * removes exactly those values from any text the controller might log,
 * persist, or attach. The two are complementary: the pattern layer catches
 * secrets nobody predicted; this layer guarantees the values the broker
 * itself issued can never round-trip into a diagnostic.
 *
 * Contract: replacement is exact and total — every occurrence of every
 * known value becomes `[REDACTED]` (the same marker the pattern layer uses,
 * so downstream tooling sees one vocabulary). Longest values replace first,
 * so a value that is a substring of another is fully covered. Values shorter
 * than 8 characters are REFUSED at construction: a too-short needle cannot
 * be redacted reliably without mangling unrelated text, and fail closed is
 * the only safe posture for a redaction boundary.
 */
const REDACTED = "[REDACTED]";

/** Shortest secret value the redactor accepts (characters). Below this the
 * false-positive risk of exact-match replacement outweighs the protection. */
const MIN_SECRET_VALUE_CHARS = 8;

export interface SecretRedactor {
  /** Scrub every known live secret value out of a text. */
  redact(text: string): string;
  /** Scrub a JSON-serializable artifact (stable 2-space serialization, then
   * the same exact-value pass) — for artifact bodies and structured log
   * lines. Serialization failures become a fixed placeholder, never a
   * thrown leak. */
  redactJson(value: unknown): string;
}

export function createSecretRedactor(values: readonly string[]): SecretRedactor {
  const unique = [...new Set(values)].filter((value) => value !== "");
  for (const value of unique) {
    if (value.length < MIN_SECRET_VALUE_CHARS) {
      throw new RangeError(
        `secret redactor values must be at least ${MIN_SECRET_VALUE_CHARS} characters`,
      );
    }
  }
  // Longest first: a shorter value that is a substring of a longer one is
  // then always consumed as part of the longer replacement.
  const sorted = [...unique].sort((a, b) => b.length - a.length);
  return {
    redact(text: string): string {
      let out = text;
      for (const value of sorted) {
        out = out.split(value).join(REDACTED);
      }
      return out;
    },
    redactJson(value: unknown): string {
      let serialized: string;
      try {
        serialized = JSON.stringify(value, null, 2) ?? "undefined";
      } catch {
        serialized = "[unserializable]";
      }
      return this.redact(serialized);
    },
  };
}
