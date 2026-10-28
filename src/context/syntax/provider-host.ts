/** The parent side of the syntax-provider seam (#764).
 *
 * Every provider call runs in an isolated worker thread, and THIS module
 * is the boundary that makes the call interruptibly bounded:
 *
 *   - The parent bounds every call with a REAL timer (`setTimeout`), not
 *     with the injectable monotonic clock, so the bound holds against a
 *     provider that blocks. This is the ONLY timer of a provider call:
 *     the builder hands the host the ceiling (`timeoutMs`) and never races
 *     a call of its own, so a call has exactly ONE bound and exactly ONE
 *     termination path.
 *   - When the bound expires the worker is TERMINATED. A provider stuck in
 *     an infinite loop — even a synchronous one — therefore cannot hold
 *     the review past the bound: the thread is killed and the call fails.
 *     The termination happens on EVERY timeout, on every path.
 *   - A worker that CRASHES (an "error" event) or EXITS is the same
 *     failure: the host records the reason and every later call fails
 *     instantly instead of waiting for an answer that will never come.
 *
 * The host is created ONCE per build and closed in the builder's `finally`,
 * and `close()` AWAITS the worker's termination, so no worker outlives the
 * build. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { SyntaxDeclaration, SyntaxProviderRegistration, SyntaxUsage } from "./types.js";

/** The worker's entry script.
 *
 * The worker cannot receive a function, so it is handed the module that
 * exports `syntaxProviderWorker` and calls it. The script runs as
 * CommonJS (`eval: true`), which is what makes `require` available. The
 * payload carries the registration and the workspace; the worker's init
 * carries them by name. */
const WORKER_SOURCE = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  'const entry = require(workerData.entryModule);',
  'entry.syntaxProviderWorker({ parentPort, registration: workerData.payload.registration, workspace: workerData.payload.workspace });',
].join("\n");

/** The parent-side view of one provider. */
export interface SyntaxProviderHost {
  /** The declarations of the file at `path` (empty when it cannot be read). */
  declarations(path: string): Promise<readonly SyntaxDeclaration[]>;
  /** The identifiers the line references (empty when the file cannot be read). */
  identifiersOnLine(path: string, line: number): Promise<readonly string[]>;
  /** How the occurrence reads at the site ("unknown" when it cannot be read). */
  classify(path: string, line: number, name: string): Promise<SyntaxUsage>;
  /** Terminate the worker and WAIT for it to be gone. Safe to call twice. */
  close(): Promise<void>;
}

/** The default ceiling of ONE provider call, in milliseconds. It is the
 * fallback for a configured ceiling that is not a usable number: a call
 * without a bound would wait forever, so an unusable bound is clamped to
 * the default rather than ignored. */
export const DEFAULT_PROVIDER_CALL_TIMEOUT_MS = 5_000;

/** A provider call that exceeded its bound. The worker was terminated, so
 * the call cannot be retried: the builder degrades the stage. */
export class SyntaxProviderTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "SyntaxProviderTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export interface ProviderHostOptions {
  registration: SyntaxProviderRegistration;
  /** Workspace root (absolute): the worker reads the files itself. */
  workspace: string;
  /** The ceiling of ONE provider call, in milliseconds. A NUMBER is a fixed
   * ceiling; a FUNCTION is asked for the ceiling BEFORE EACH call, so the
   * effective budget can shrink as the build's own wall-clock budget does. */
  timeoutMs: number | (() => number);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The module the worker loads.
 *
 * The per-file build compiles `provider-main.ts` next to this file, so the
 * worker loads THAT module. The shipped runtime is a single-file bundle
 * (`dist/index.js`), which exports the worker entry itself: requiring it
 * inside a worker does NOT run the action, because the entry is guarded by
 * `require.main === module` and `require.main` is undefined in a worker. */
function workerEntryModule(): string {
  const local = join(__dirname, "provider-main.js");
  if (existsSync(local)) return local;
  return __filename;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class ProviderHost implements SyntaxProviderHost {
  private readonly worker: Worker;
  private readonly timeoutMs: number | (() => number);
  private readonly pending = new Map<number, PendingCall>();
  private nextRequestId = 1;
  /** The failure the host recorded, once it failed. Every later call
   * fails with it, instantly. */
  private failure: Error | null = null;
  private closed = false;
  /** The worker's termination, awaited by `close()`: the worker is gone
   * only once this settles. */
  private termination: Promise<void> = Promise.resolve();

  constructor(registration: SyntaxProviderRegistration, workspace: string, timeoutMs: number | (() => number)) {
    this.timeoutMs = timeoutMs;
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        entryModule: workerEntryModule(),
        payload: { registration, workspace },
      },
    });
    this.worker.on("message", (message: unknown) => {
      this.settle(message);
    });
    this.worker.on("error", (error: unknown) => {
      this.fail(`the syntax provider worker failed: ${messageOf(error)}`);
    });
    this.worker.on("exit", (code: number) => {
      if (!this.closed) this.fail(`the syntax provider worker exited (code ${code})`);
    });
  }

  /** The ceiling of the call that is about to be made: the configured
   * ceiling, asked for afresh when it is a function. */
  private resolveTimeoutMs(): number {
    const raw = typeof this.timeoutMs === "function" ? this.timeoutMs() : this.timeoutMs;
    if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_PROVIDER_CALL_TIMEOUT_MS;
    return Math.max(1, Math.trunc(raw));
  }

  async declarations(path: string): Promise<readonly SyntaxDeclaration[]> {
    const value = await this.request("declarations", { path });
    return Array.isArray(value) ? (value as readonly SyntaxDeclaration[]) : [];
  }

  async identifiersOnLine(path: string, line: number): Promise<readonly string[]> {
    const value = await this.request("identifiersOnLine", { path, line });
    return Array.isArray(value) ? (value as readonly string[]) : [];
  }

  async classify(path: string, line: number, name: string): Promise<SyntaxUsage> {
    const value = await this.request("classify", { path, line, name });
    if (value === "definition" || value === "call" || value === "use" || value === "unknown") return value;
    return "unknown";
  }

  /** Terminate the worker and WAIT for it to be gone. A termination
   * failure is swallowed: it must not break the build. Safe to call
   * twice — the second call awaits the same termination. */
  async close(): Promise<void> {
    if (this.closed) {
      await this.termination;
      return;
    }
    this.closed = true;
    this.settleAll(new Error("the syntax provider host was closed"));
    this.termination = this.worker.terminate().then(() => undefined).catch(() => undefined);
    await this.termination;
  }

  /** One request, bounded by the host's ceiling. */
  private request(method: string, payload: Record<string, unknown>): Promise<unknown> {
    // The host already failed: the call never reaches the worker, so it is
    // NOT a timeout of its own — it is the recorded failure (a timeout that
    // killed the worker, a crash, an exit) the host is carrying.
    if (this.failure !== null) return Promise.reject(new Error(`the syntax provider host failed: ${this.failure.message}`));
    if (this.closed) return Promise.reject(new Error("the syntax provider host is closed"));
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const timeoutMs = this.resolveTimeoutMs();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const reason = `the syntax provider call "${method}" exceeded its ${timeoutMs}ms bound`;
        reject(new SyntaxProviderTimeoutError(reason, timeoutMs));
        // The worker is TERMINATED — ALWAYS, on every timeout, on every
        // path: a provider that blocks cannot be waited out, and every
        // later call fails instantly.
        this.fail(reason, timeoutMs);
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.worker.postMessage({ requestId, method, ...payload });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        const reason = `the syntax provider call "${method}" could not be sent: ${messageOf(error)}`;
        reject(new Error(reason));
        this.fail(reason);
      }
    });
  }

  /** The answer to a pending request. */
  private settle(message: unknown): void {
    if (message === null || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    const requestId = record.requestId;
    if (typeof requestId !== "number") return;
    const call = this.pending.get(requestId);
    if (call === undefined) return;
    this.pending.delete(requestId);
    clearTimeout(call.timer);
    if (record.ok === true) {
      call.resolve(record.value);
      return;
    }
    call.reject(new Error(typeof record.error === "string" ? record.error : "the syntax provider call failed"));
  }

  /** The host failed: record the reason, fail every pending call and
   * terminate the worker. A timeout stays a timeout, so the builder can
   * tell a bound that bit from a provider that merely failed. */
  private fail(reason: string, timeoutMs?: number): void {
    if (this.failure === null) {
      this.failure = timeoutMs === undefined ? new Error(reason) : new SyntaxProviderTimeoutError(reason, timeoutMs);
    }
    this.settleAll(this.failure);
    // The termination is AWAITED by `close()`, so "no worker outlives the
    // build" is a fact and not a request. A termination failure is
    // swallowed: it must not break the build.
    this.termination = this.worker.terminate().then(() => undefined).catch(() => undefined);
  }

  private settleAll(error: Error): void {
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) {
      clearTimeout(call.timer);
      call.reject(error);
    }
  }
}

/** Start the provider's worker thread. The returned host answers every
 * call, and every call is bounded by the host's ceiling — asked for afresh
 * before each call when the ceiling is a function. */
export async function createProviderHost(options: ProviderHostOptions): Promise<SyntaxProviderHost> {
  return new ProviderHost(options.registration, options.workspace, options.timeoutMs);
}
