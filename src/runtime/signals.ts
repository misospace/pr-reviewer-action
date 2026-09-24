import { constants } from "node:os";

/**
 * Cancellation scope + parent-signal finalization (#679).
 *
 * The bash layer reproduced cancellation with EXIT/INT/TERM traps that walked
 * `pgrep -P` trees. The typed layer owns cancellation with an
 * `AbortController`-based scope: every tree-owning child registers on the
 * scope's signal, and a parent SIGTERM/SIGINT aborts the scope, runs the
 * finalizers within a bounded deadline, and only then exits with the
 * conventional 128+signal status. SIGKILL/power loss cannot run JS cleanup —
 * that boundary is documented, not hand-waved.
 */

export interface CancellationScope {
  readonly signal: AbortSignal;
  /** Human-readable reason (`SIGTERM`, explicit name, …) or null. */
  readonly reason: string | null;
  abort(reason: string): void;
}

export function createCancellationScope(): CancellationScope {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    get reason(): string | null {
      const reason: unknown = controller.signal.reason;
      if (reason instanceof Error) return reason.message;
      return reason === undefined ? null : String(reason);
    },
    abort(reason: string): void {
      if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
      }
    },
  };
}

export interface ParentSignalHandler {
  /** Abort the scope, run finalizers bounded by the deadline. Idempotent. */
  handleSignal(signal: NodeJS.Signals): Promise<void>;
  /** Register the real process listeners (SIGINT/SIGTERM). */
  attach(): void;
  detach(): void;
}

export interface ParentSignalOptions {
  scope: CancellationScope;
  /** Cleanup/finalization work; must resolve (or be cut) within the deadline. */
  finalize: () => Promise<void>;
  /** Hard bound on finalization before the conventional exit wins. */
  deadlineMs: number;
}

function signalExitCode(signal: NodeJS.Signals): number {
  const number = constants.signals[signal];
  return typeof number === "number" ? 128 + number : 128 + 15;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createParentSignalHandler(options: ParentSignalOptions): ParentSignalHandler {
  let handling: Promise<void> | null = null;
  const listeners = new Map<NodeJS.Signals, () => void>();

  const handler: ParentSignalHandler = {
    handleSignal(signal: NodeJS.Signals): Promise<void> {
      options.scope.abort(signal);
      handling ??= (async () => {
        await Promise.race([options.finalize(), sleep(options.deadlineMs)]);
      })();
      return handling;
    },
    attach(): void {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const listener = (): void => {
          void handler.handleSignal(signal).then(() => {
            process.exit(signalExitCode(signal));
          });
        };
        listeners.set(signal, listener);
        process.on(signal, listener);
      }
    },
    detach(): void {
      for (const [signal, listener] of listeners) {
        process.removeListener(signal, listener);
      }
      listeners.clear();
    },
  };
  return handler;
}
