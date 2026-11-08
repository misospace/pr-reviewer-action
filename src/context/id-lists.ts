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
 *
 * #1541: the bound DISCLOSES what it dropped. A run with fifty unmet
 * requirement rows publishes twenty ids, and a consumer that reads the
 * shortened list as the whole set is wrong. The bound therefore also reports
 * how many DISTINCT ids the input carried before it shortened the list, so
 * the publishers can carry that count into the documents they write.
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

/** The bounded id list and the count it was shortened from (#1541). */
export interface BoundedIdList {
  /** The bounded list: at most `MAX_ID_LIST_ENTRIES` entries, each capped at
   * `MAX_ID_LIST_CHARS` codepoints, redacted, marker-free, duplicates
   * removed, order preserved. */
  ids: string[];
  /** The number of DISTINCT ids the input carried BEFORE the entry bound
   * shortened the list. Never smaller than `ids.length`: the bound only
   * drops ids, it never adds one. */
  total: number;
}

/** Normalize one raw id: trimmed, redacted, marker-free, capped. An id that
 * normalizes to nothing is not an id, and the caller drops it. */
function normalizeId(raw: string): string {
  return pyCodepointSlice(redactText(stripReservedMarkerGrammar(raw.trim())), MAX_ID_LIST_CHARS);
}

/**
 * The bounded id list AND the count it was shortened from (#1541).
 *
 * The count is the number of DISTINCT ids the input carried once each id was
 * trimmed, redacted, marker-stripped and capped — the same normalization the
 * list itself applies, so the count can never disagree with the list. An id
 * that normalizes to nothing is not an id and is not counted.
 *
 * This scan reads the WHOLE input, because the count is a statement about
 * the whole input. `boundedIdList` is the cheap variant: it stops at the
 * bound and reports no count.
 */
export function boundedIdListWithTotal(ids: readonly string[] | undefined): BoundedIdList {
  if (!Array.isArray(ids)) return { ids: [], total: 0 };
  const distinct: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = normalizeId(raw);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    distinct.push(id);
  }
  return { ids: distinct.slice(0, MAX_ID_LIST_ENTRIES), total: distinct.length };
}

/** The bounded id list: at most `MAX_ID_LIST_ENTRIES` entries, each capped at
 * `MAX_ID_LIST_CHARS` codepoints, redacted, marker-free, duplicates removed,
 * order preserved. A caller cannot flood a document with ids. The scan stops
 * at the bound: this helper reports no count, so it never reads past the
 * ids it keeps. */
export function boundedIdList(ids: readonly string[] | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = normalizeId(raw);
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
    if (kept.length >= MAX_ID_LIST_ENTRIES) break;
  }
  return kept;
}

/**
 * #1541: the count a document publishes for an id list, or null when
 * nothing can prove one.
 *
 * The producer's count is the authoritative one: it is the number of distinct
 * ids the enforcement pass produced. The publisher adds what it knows on its
 * own: when the list it received was longer than the shared cap allows, the
 * publisher's own cap dropped ids, and the count must say so. Without
 * either, the count stays UNKNOWN — never zero, because an unknown count
 * read as zero would claim that a possibly-shortened list is the whole set.
 *
 * A count below the listed length would contradict the list, so it is raised
 * to the listed length: the cap can only DROP ids, never add one, so the
 * raised count is still the conservative truth and the document stays
 * parseable.
 */
export function sourceIdCount(callerCount: number | undefined, incoming: BoundedIdList): number | null {
  const producer = typeof callerCount === "number" && Number.isInteger(callerCount) && callerCount >= 0
    ? callerCount
    : null;
  // The publisher's own cap: a list that arrived longer than the cap allows
  // was shortened HERE, so the publisher knows the pre-cap count itself.
  const local = incoming.total > MAX_ID_LIST_ENTRIES ? incoming.total : null;
  const count = producer === null ? local : local === null ? producer : Math.max(producer, local);
  if (count === null) return null;
  return Math.max(count, incoming.ids.length);
}
