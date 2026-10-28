/** Terminal-record compaction (#736).
 *
 * The #731 snapshot accumulates terminal records — the doc promised
 * "terminal records accumulate in the snapshot until compaction lands
 * with #736". This is that compaction: a PURE pass over a validated
 * snapshot that drops aged-out terminal history while never
 * compromising a scheduling invariant.
 *
 * A terminal record is droppable only when its `prKey` has NO
 * non-terminal record: an active generation must still see its
 * superseded siblings (the supersession gate and latest-head-wins
 * resolution read them). Once a PR's queue history is fully terminal,
 * every terminal record of that `prKey` ages out by retention — the
 * durable "last good result" lives in the run/publication layer
 * (#736), not in the queue snapshot. The supersession gate reads only
 * NON-terminal siblings (`findSupersedingSibling` in
 * `./scheduler.js`), so dropping settled terminal history cannot
 * change any publish decision.
 *
 * After retention, a terminal-record cap drops the OLDEST droppable
 * records first. The cap is best-effort over droppable records only: a
 * terminal record protected by its active sibling is never dropped to
 * satisfy the cap.
 *
 * The module is pure and deterministic: no I/O, no timers, no clock —
 * the caller supplies epoch-ms numbers. The input snapshot is never
 * mutated; the result is a NEW frozen snapshot.
 */

import { parseQueueSnapshot, type QueueSnapshot } from "./store.js";
import { isTerminalState, type JobRecord } from "./types.js";

/** Options for `compactQueueSnapshot`. */
export interface CompactionOptions {
  /** Current epoch ms (fail closed on non-finite). */
  nowMs: number;
  /** Retention horizon in ms: terminal records updated at least this
   * long ago are aging out (positive integer). */
  retentionMs: number;
  /** Maximum terminal records to KEEP (non-negative integer; the
   * protected records may exceed the cap — the cap is best-effort over
   * droppable records only). 0 = drop every droppable terminal record. */
  maxTerminalRecords: number;
}

/** Validate compaction options (fail closed, RangeError). */
function checkOptions(options: CompactionOptions): void {
  if (typeof options.nowMs !== "number" || !Number.isFinite(options.nowMs)) {
    throw new RangeError(
      `compaction: nowMs must be a finite number, got ${String(options.nowMs)}`,
    );
  }
  if (
    typeof options.retentionMs !== "number" ||
    !Number.isFinite(options.retentionMs) ||
    !Number.isInteger(options.retentionMs) ||
    options.retentionMs < 1
  ) {
    throw new RangeError(
      `compaction: retentionMs must be a positive integer, got ${String(options.retentionMs)}`,
    );
  }
  if (
    typeof options.maxTerminalRecords !== "number" ||
    !Number.isFinite(options.maxTerminalRecords) ||
    !Number.isInteger(options.maxTerminalRecords) ||
    options.maxTerminalRecords < 0
  ) {
    throw new RangeError(
      `compaction: maxTerminalRecords must be a non-negative integer, got ${String(options.maxTerminalRecords)}`,
    );
  }
}

/** Compact terminal history out of a validated queue snapshot.
 *
 * The snapshot is fully validated first (the same parser the stores
 * use): a snapshot that cannot be validated throws instead of being
 * compacted. Returns `{ snapshot, dropped }` where `snapshot` is a NEW
 * frozen snapshot preserving record order and `dropped` is the sorted
 * list of dropped jobIds. */
export function compactQueueSnapshot(
  snapshot: QueueSnapshot,
  options: CompactionOptions,
): { snapshot: QueueSnapshot; dropped: string[] } {
  checkOptions(options);
  // One definition of a valid snapshot: the store's own parser.
  const validated = parseQueueSnapshot(snapshot);
  const records = validated.records;
  const cutoffMs = options.nowMs - options.retentionMs;

  // Protection pass: a prKey with a non-terminal record protects ALL
  // of its terminal records (the active generation's superseded
  // siblings stay resolvable).
  const activePrKeys = new Set<string>();
  for (const record of records) {
    if (!isTerminalState(record.state)) {
      activePrKeys.add(record.prKey);
    }
  }

  const droppable: JobRecord[] = [];
  for (const record of records) {
    if (!isTerminalState(record.state)) continue;
    if (activePrKeys.has(record.prKey)) continue;
    droppable.push(record);
  }

  // Aging-out pass: droppable records older than the horizon drop.
  const droppedIds = new Set<string>();
  let terminalCount = records.filter((r) => isTerminalState(r.state)).length;
  for (const record of droppable) {
    if (record.updatedAtMs < cutoffMs) {
      droppedIds.add(record.job.jobId);
      terminalCount -= 1;
    }
  }

  // Cap pass: still over the cap drops the OLDEST droppable records
  // first (protected records are never touched — the cap is
  // best-effort over droppable history).
  const remaining = droppable
    .filter((r) => !droppedIds.has(r.job.jobId))
    .sort(
      (a, b) =>
        a.updatedAtMs - b.updatedAtMs || (a.job.jobId < b.job.jobId ? -1 : 1),
    );
  for (const record of remaining) {
    if (terminalCount <= options.maxTerminalRecords) break;
    droppedIds.add(record.job.jobId);
    terminalCount -= 1;
  }

  if (droppedIds.size === 0) {
    return { snapshot: validated, dropped: [] };
  }
  const kept = records.filter((r) => !droppedIds.has(r.job.jobId));
  const out: QueueSnapshot = {
    version: 1,
    records: Object.freeze(kept),
  };
  const dropped = [...droppedIds].sort();
  return { snapshot: Object.freeze(out), dropped };
}
