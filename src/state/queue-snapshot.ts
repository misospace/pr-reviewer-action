/** The async queue-snapshot persistence seam (#736).
 *
 * The #731 `QueueStore` seam (`../queue/store.js`) is SYNCHRONOUS —
 * its shipped backends are in-memory and local-file, where sync I/O is
 * honest. A network database cannot be synchronous, so the durable
 * PostgreSQL backend lives behind THIS async seam instead: the same
 * whole-snapshot `load`/`save` contract, with `Promise`s. The
 * fail-closed rules are identical (they are `parseQueueSnapshot`'s):
 * missing backing state is the only load that may return the empty
 * snapshot; corrupt, wrong-version, or malformed state throws.
 *
 * The future controller daemon wires its #731 `ReviewQueueController`
 * to a PostgreSQL snapshot through an adapter that awaits this seam;
 * the sync interface stays untouched for the file/in-memory backends.
 */

import type { QueueSnapshot } from "../queue/store.js";

/** Durable async snapshot backend. Implementations must fail closed:
 * missing backing state is the ONLY load that may return the empty
 * snapshot. */
export interface QueueSnapshotStore {
  /** Missing backing state => `emptyQueueSnapshot()`. Corrupt /
   * unparseable / wrong-version / not-a-snapshot => throw. */
  load(): Promise<QueueSnapshot>;
  /** Atomic durable commit. Concurrent savers are serialized by the
   * backend (the single-controller deployment still holds the
   * whole-snapshot replace semantics #731 relies on). */
  save(snapshot: QueueSnapshot): Promise<void>;
}
