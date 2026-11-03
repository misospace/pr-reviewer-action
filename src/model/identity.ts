/**
 * #1465: a provider model identifier is an OPAQUE token.
 *
 * The action carries the configured model string to the provider and to the
 * published telemetry byte-identically. A provider treats a model name as a
 * case-sensitive identifier and rejects a name it does not know, so this
 * module NEVER case-folds, title-cases, or lower-cases a model name.
 * Canonicalization is forbidden here unless a provider contract explicitly
 * defines one.
 */

/**
 * The model identifier as configured, with surrounding whitespace removed
 * and nothing else changed. Trim ONLY: whitespace around a configured value
 * is noise, while letter case is part of the identifier the provider knows.
 */
export function opaqueModelId(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

/**
 * Whether two identifiers differ ONLY in letter case.
 *
 * The comparison never alters either value: the lower-cased forms are
 * throwaway copies used for the comparison alone, so the identifiers the
 * action sends and publishes stay byte-identical to what was configured.
 */
export function differsOnlyByCase(a: string, b: string): boolean {
  if (a === "" || b === "") return false;
  if (a === b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a configured model value carries no name at all: the value is not
 * empty, but it holds nothing but whitespace. Such a value is treated as
 * unset by every lane, so each lane that reads one reports it instead of
 * dropping it silently.
 */
export function isBlankModelValue(raw: string | undefined | null): boolean {
  const text = raw ?? "";
  return text !== "" && text.trim() === "";
}

/**
 * A configured model name as it may be echoed in an operator-facing notice.
 *
 * The name comes from operator configuration, so the notice has to show it
 * for the operator to know which name to fix. The name is free text, so
 * control characters (a newline can forge a log line) are removed and the
 * length is bounded. The value the action sends is never changed by this.
 */
export function modelNameForNotice(raw: string, maxChars = 120): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length <= maxChars ? flat : flat.slice(0, maxChars);
}
