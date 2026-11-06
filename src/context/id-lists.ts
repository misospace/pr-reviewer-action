/** Shared bounded id lists (#1518).
 *
 * The merge-gating obligation ids (requirement ids and required-check ids)
 * travel in two machine artifacts: the local `review-bundle/v1` document and
 * the published `review-handoff/v1` document. Both need the SAME bound, so
 * the bound lives here, in a neutral module beside the other context
 * producers — never in the publication layer, which the deterministic policy
 * layer must not depend on.
 *
 * The bound is total: a caller cannot flood a document with ids. Each id is
 * trimmed, redacted, stripped of the reserved marker grammar (those markers
 * are action-owned state, and an id is not the place to mint one), capped at
 * `MAX_ID_LIST_CHARS` codepoints, and dropped when empty. Duplicates are
 * dropped and the first `MAX_ID_LIST_ENTRIES` ids keep their input order.
 */
import { RESERVED_MARKER_PATTERNS } from "../metadata/markers.js";
import { pyCodepointSlice } from "../platform/py.js";
import { redactText } from "./redact.js";

/** At most this many ids ride one list. */
export const MAX_ID_LIST_ENTRIES = 20;

/** At most this many codepoints per id. */
export const MAX_ID_LIST_CHARS = 64;

/** Remove the action-owned marker grammar from an id. The markers are the
 * action's own state, and an id that carried one could forge a marker into
 * a published artifact. Only the marker grammar is removed — the id stays a
 * string and is never dropped for carrying it. */
function stripReservedMarkerGrammar(text: string): string {
  let stripped = text;
  for (const pattern of RESERVED_MARKER_PATTERNS) {
    pattern.lastIndex = 0;
    stripped = stripped.replace(pattern, "");
  }
  return stripped;
}

/** The bounded id list: at most `MAX_ID_LIST_ENTRIES` entries, each capped at
 * `MAX_ID_LIST_CHARS` codepoints, redacted, marker-free, duplicates removed,
 * order preserved. A caller cannot flood a document with ids. */
export function boundedIdList(ids: readonly string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = pyCodepointSlice(redactText(stripReservedMarkerGrammar(raw.trim())), MAX_ID_LIST_CHARS);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
    if (kept.length >= MAX_ID_LIST_ENTRIES) break;
  }
  return kept;
}
