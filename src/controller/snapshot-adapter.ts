/** The daemon's sync-over-async queue persistence adapter (#1348).
 *
 * The #731 `QueueStore` seam (`../queue/store.js`) is SYNCHRONOUS — its
 * shipped backends are in-memory and local-file, where sync I/O is honest.
 * The #736 PostgreSQL queue backend lives behind the ASYNC
 * `QueueSnapshotStore` seam (`../state/queue-snapshot.js`), and
 * `docs/architecture/durable-control-plane-state.md` names the daemon as
 * the place that "wires it to this contract through an adapter". This
 * module is that adapter.
 *
 * The adapter's job is narrow: hold the authoritative snapshot in process
 * memory (the scheduler keeps its own record map anyway — the store is the
 * durable copy), and make every `save()` land on the async backend with
 * the WHOLE-SNAPSHOT, LAST-COMMITTED-WINS semantics both backends already
 * guarantee. Two invariants matter more than convenience:
 *
 * - **Cache == durable truth.** `load()` never returns a snapshot that is
 *   not (or was not) successfully persisted: a failed persist rolls the
 *   in-memory cache back to the last snapshot the backend actually
 *   accepted, so the scheduler's view can never drift ahead of what a
 *   restart would recover.
 * - **Fail closed, recover on success.** A persist failure is LATCHED and
 *   reported through `persistenceError()` / `flush()` — the daemon's
 *   health check must not claim health while persistence is failing — but
 *   it does not wedge the store: a later save still tries to persist, and
 *   the first success clears the latch (a transient database blip must not
 *   require an operator restart, and until one lands the cache simply
 *   stays at the last durable snapshot).
 *
 * Persistence is serialized through an internal promise chain: concurrent
 * `save()` calls persist in call order, preserving the single-controller
 * whole-snapshot replace contract even when a slow backend overlaps fast
 * scheduling ticks. `flush()` awaits the chain — the daemon's shutdown path
 * uses it to prove every committed mutation reached the backend (or to
 * surface the latched failure) before the process exits.
 */

import {
  parseQueueSnapshot,
  type QueueSnapshot,
  type QueueStore,
} from "../queue/store.js";
import type { QueueSnapshotStore } from "../state/queue-snapshot.js";

/** A refused mutation or an unflushable store: persistence is failing and
 * the controller must not pretend otherwise. */
export class SnapshotQueueStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotQueueStoreError";
  }
}

/** The synchronous `QueueStore` the daemon hands to its
 * `ReviewQueueController`, backed by the async #736 snapshot seam. */
export interface SnapshotBackedQueueStore extends QueueStore {
  /** Await the pending persist chain. Rejects with
   * `SnapshotQueueStoreError` when the pending persist (or a latched
   * failure) did not succeed — the daemon's shutdown path proves every
   * committed mutation is durable before exiting. */
  flush(): Promise<void>;
  /** "" when every snapshot handed to `load()` is durable; otherwise the
   * latched persistence-failure message. */
  persistenceError(): string;
  /** True while a persist is still in flight. */
  pending(): boolean;
}

/** Construct the adapter over an async snapshot backend. Fails closed at
 * startup: the initial load is awaited here, so a backend whose state
 * cannot be validated throws BEFORE the daemon builds a controller on it
 * (a missing backing state is the backend's one well-defined fresh start —
 * `emptyQueueSnapshot()`). */
export async function createSnapshotBackedQueueStore(
  backend: QueueSnapshotStore,
): Promise<SnapshotBackedQueueStore> {
  if (backend === null || typeof backend !== "object") {
    throw new TypeError("SnapshotQueueStore: backend must be a QueueSnapshotStore object");
  }
  if (typeof backend.load !== "function" || typeof backend.save !== "function") {
    throw new TypeError("SnapshotQueueStore: backend must provide load() and save()");
  }
  const initial: QueueSnapshot = await backend.load();
  const store = new SnapshotBackedQueueStoreImpl(backend, initial);
  return store;
}

class SnapshotBackedQueueStoreImpl implements SnapshotBackedQueueStore {
  private readonly backend: QueueSnapshotStore;
  /** What `load()` answers: always the last snapshot this store BELIEVES
   * is durable (see the rollback rule in `save`). */
  private cache: QueueSnapshot;
  /** The last snapshot the backend actually accepted. */
  private durable: QueueSnapshot;
  /** Serialized persist chain: every save appends; a rejection latches. */
  private chain: Promise<void> = Promise.resolve();
  /** Saves appended to the chain whose persist has not settled yet. */
  private inFlight = 0;
  private latchedError: string = "";

  constructor(backend: QueueSnapshotStore, initial: QueueSnapshot) {
    this.backend = backend;
    this.cache = initial;
    this.durable = initial;
  }

  load(): QueueSnapshot {
    return this.cache;
  }

  save(snapshot: QueueSnapshot): void {
    // Validate FIRST, before any state mutation: a snapshot the durable
    // layer would refuse must leave the store exactly as it found it.
    const validated = parseQueueSnapshot(snapshot);
    this.cache = validated;
    this.inFlight += 1;
    this.chain = this.chain.then(
      () => this.backend.save(validated),
    ).then(
      () => {
        this.inFlight -= 1;
        this.durable = validated;
        this.latchedError = "";
      },
      (err: unknown) => {
        this.inFlight -= 1;
        const message = err instanceof Error ? err.message : String(err);
        this.latchedError = message;
        // Roll the cache back to what is actually durable: load() must
        // never lie about what a restart would recover.
        this.cache = this.durable;
      },
    );
  }

  async flush(): Promise<void> {
    // The chain never rejects (its own handler latches failures), so a
    // plain await is enough; the latched error is what flush() reports.
    await this.chain;
    if (this.latchedError !== "") {
      throw new SnapshotQueueStoreError(
        `SnapshotQueueStore: persistence failed (${this.latchedError})`,
      );
    }
  }

  persistenceError(): string {
    return this.latchedError;
  }

  pending(): boolean {
    return this.inFlight > 0;
  }
}
