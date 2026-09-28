import {
  buildChildEnv,
  preflightTreeCleanup,
  runProcess,
  type CancellationScope,
  type EnvAllowlist,
  type ProcessHandle,
  type ProcessResult,
} from "../runtime/index.js";

/**
 * Concurrent review-gate lifecycle (#679) — the typed owner of the #634
 * fork/join. Two independent, expensive branches must both resolve before the
 * final reviewer may start: the CI gate and the advisory specialist phase.
 * Wall clock composes near max(CI, specialists), not their sum.
 *
 * Semantics preserved from `scripts/sections/gating.sh`:
 * - both branches launch before either is joined;
 * - a nonzero/timeout workload never fails the join (CI gating kept the old
 *   separate step's continue-on-error; specialists are advisory);
 * - both gates disabled is a no-op fast path;
 * - a launch refusal (missing pgrep, non-POSIX) is loud, not silent: the
 *   already-launched sibling is terminated and `GateLaunchError` thrown —
 *   the exact `require_gate_tree_cleanup` fail-closed contract;
 * - when the parent scope aborts (job cancellation, SIGTERM/SIGINT), both
 *   active trees are terminated and the join still resolves, with the
 *   affected outcomes marked `cancelled`.
 */

export type GateName = "ci" | "specialists";

export interface GateOutcome {
  gate: GateName;
  /** False for a disabled gate (no-op fast path). */
  ran: boolean;
  /** True only when the workload exited 0 with no cleanup survivors. */
  ok: boolean;
  status: ProcessResult["status"] | "not_launched";
  exitCode: number | null;
  durationMs: number;
  /** Human-readable failure/cancellation reason; null when ok. */
  error: string | null;
  /** Descendant PIDs not confirmed dead after cleanup (never silently dropped). */
  survivedPids: number[];
}

export interface GateRunResult {
  ci: GateOutcome;
  specialists: GateOutcome;
}

export class GateLaunchError extends Error {
  readonly gate: GateName | "preflight";
  constructor(gate: GateName | "preflight", message: string) {
    super(message);
    this.name = "GateLaunchError";
    this.gate = gate;
  }
}

export interface GateBranch {
  file: string;
  args?: readonly string[];
  cwd?: string;
  /** Allowlist for this child's environment (see `./env.ts`). Ignored for an
   * in-process `workload` branch, which shares the parent's memory and never
   * receives a child environment. */
  envAllowlist: EnvAllowlist;
  /** Optional per-branch deadline; expiry terminates the whole tree. */
  timeoutMs?: number;
  /** Per-stream stdout/stderr capture cap. */
  maxOutputBytes?: number;
  /**
   * In-process workload (#809): when set, the branch runs inside this
   * process instead of launching a subprocess (`file`/`args` unused). The
   * resolved promise value is the exit code (0 = ok); a thrown error is a
   * failed workload, and the branch must honor the parent scope's signal for
   * cancellation — the scope abort is passed to the workload so transports
   * and sleeps can wind down. The fail-soft join semantics are identical to
   * a subprocess branch.
   */
  workload?: (signal: AbortSignal) => Promise<number>;
}

export interface RunConcurrentGatesOptions {
  /** CI gate branch; omitted/undefined = disabled (no-op). */
  ci?: GateBranch;
  /** Specialist gate branch; omitted/undefined = disabled (no-op). */
  specialists?: GateBranch;
  /** Parent cancellation scope; abort terminates both active trees. */
  scope?: CancellationScope;
  /** Ambient environment the allowlists draw from. Defaults to `process.env`. */
  ambientEnv?: NodeJS.ProcessEnv;
  onLog?: (message: string) => void;
}

function notLaunched(gate: GateName): GateOutcome {
  return {
    gate,
    ran: false,
    ok: true,
    status: "not_launched",
    exitCode: null,
    durationMs: 0,
    error: null,
    survivedPids: [],
  };
}

/** Only subprocess branches own process trees; an undefined (disabled) or
 * in-process branch needs no descendant-cleanup preflight. */
function hasSubprocessBranch(branch: GateBranch | undefined): boolean {
  return branch !== undefined && branch.workload === undefined;
}

function toOutcome(gate: GateName, result: ProcessResult): GateOutcome {
  const ok = result.status === "exited" && result.exitCode === 0;
  let error: string | null = null;
  if (!ok) {
    switch (result.status) {
      case "exited":
        // An in-process workload reports its thrown failure via launchError.
        error = result.launchError
          ? `workload failed: ${result.launchError}`
          : `workload exited ${result.exitCode}`;
        break;
      case "timeout":
        error = "workload exceeded its deadline; tree terminated";
        break;
      case "cancelled":
        error = "workload cancelled; tree terminated";
        break;
      case "signalled":
        error = `workload killed by ${result.signal ?? "signal"}`;
        break;
      case "spawn_error":
        error = result.launchError ?? "workload failed to launch";
        break;
    }
    if (result.termination && result.termination.survived.length > 0) {
      error += `; survivors not confirmed dead: ${result.termination.survived.join(",")}`;
    }
  }
  return {
    gate,
    ran: true,
    ok,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    error,
    survivedPids: result.termination ? [...result.termination.survived] : [],
  };
}

/**
 * Fork both gates concurrently, join both fail-soft. Throws only on launch
 * refusal (after terminating any already-launched sibling).
 */
export async function runConcurrentGates(
  options: RunConcurrentGatesOptions,
): Promise<GateRunResult> {
  const ambient = options.ambientEnv ?? process.env;
  const log = options.onLog ?? (() => {});

  // Disabled-gates no-op fast path (v2 parity): no branches, no delay, and
  // no pgrep preflight — a runner without procps must still be able to run
  // with ci_status_check=false and deep_review=false, exactly like v2 where
  // the disabled forks never reached require_gate_tree_cleanup.
  if (options.ci === undefined && options.specialists === undefined) {
    return { ci: notLaunched("ci"), specialists: notLaunched("specialists") };
  }

  // Fail-closed preflight (the typed require_gate_tree_cleanup): refuse to
  // enter background concurrency when descendant cleanup cannot be guaranteed.
  // Only subprocess branches spawn process trees; a run whose branches are all
  // in-process (#809) owns no children here and skips the pgrep preflight,
  // exactly like the disabled-gates fast path.
  if (hasSubprocessBranch(options.ci) || hasSubprocessBranch(options.specialists)) {
    try {
      await preflightTreeCleanup();
    } catch (error) {
      throw new GateLaunchError(
        "preflight",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  interface CommonHandle {
    launched: Promise<void>;
    launchRefusal: string | null;
    result: Promise<ProcessResult>;
    abort: () => Promise<void>;
  }

  const launch = (gate: GateName, branch: GateBranch): CommonHandle => {
    if (branch.workload) return launchWorkload(branch, options.scope);
    return runProcess({
      file: branch.file,
      ...(branch.args !== undefined ? { args: branch.args } : {}),
      ...(branch.cwd !== undefined ? { cwd: branch.cwd } : {}),
      env: buildChildEnv(branch.envAllowlist, ambient),
      ...(branch.timeoutMs !== undefined ? { timeoutMs: branch.timeoutMs } : {}),
      ...(branch.maxOutputBytes !== undefined ? { maxOutputBytes: branch.maxOutputBytes } : {}),
      ...(options.scope !== undefined ? { signal: options.scope.signal } : {}),
    });
  };

  // Both forks happen before either join, exactly as corpus.sh arranges them.
  const ciHandle = options.ci ? launch("ci", options.ci) : null;
  const specialistHandle = options.specialists ? launch("specialists", options.specialists) : null;

  // Launch refusals are loud — including the async pgrep-refusal path: wait
  // for both launch attempts to complete (this is the fork attempt, not the
  // workload join — the branches keep running concurrently), then check. If
  // pgrep vanished between the preflight and a branch's own preflight, the
  // refusal surfaces here and the sibling tree is terminated, instead of the
  // run silently degrading to fail-soft spawn_error outcomes.
  const branches = [
    { gate: "ci" as const, handle: ciHandle },
    { gate: "specialists" as const, handle: specialistHandle },
  ];
  await Promise.all(branches.map((branch) => (branch.handle ? branch.handle.launched : null)));
  for (const branch of branches) {
    if (branch.handle !== null && branch.handle.launchRefusal !== null) {
      const refusal: string = branch.handle.launchRefusal;
      const siblings = branches
        .map((candidate) => candidate.handle)
        .filter((candidate): candidate is ProcessHandle => candidate !== null && candidate !== branch.handle);
      for (const sibling of siblings) await sibling.abort();
      await Promise.allSettled(siblings.map((sibling) => sibling.result));
      throw new GateLaunchError(branch.gate, refusal);
    }
  }

  const [ciResult, specialistResult] = await Promise.all([
    ciHandle ? ciHandle.result : null,
    specialistHandle ? specialistHandle.result : null,
  ]);

  const outcome: GateRunResult = {
    ci: ciResult ? toOutcome("ci", ciResult) : notLaunched("ci"),
    specialists: specialistResult
      ? toOutcome("specialists", specialistResult)
      : notLaunched("specialists"),
  };
  for (const entry of [outcome.ci, outcome.specialists]) {
    if (!entry.ok && entry.error) {
      log(`gate '${entry.gate}': ${entry.error} (fail-soft, continuing)`);
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Asymmetric fork/join (#809)
// ---------------------------------------------------------------------------

/** A single gate branch launched but not yet joined. Owns the fork/join
 * halves of `runConcurrentGates` so the orchestrator can reproduce v2's
 * schedule — the CI gate forks before the deterministic corpus build and
 * joins after the specialist phase, while `runConcurrentGates` (the symmetric
 * #679 shape) remains for callers that fork and join together. */
export interface ForkedGate {
  readonly gate: GateName;
  join(): Promise<GateOutcome>;
  /** Terminate the branch now (abnormal-exit lifecycle). Idempotent. */
  abort(): Promise<void>;
}

/** Fork one gate branch (the typed `fork_ci_gate` / `fork_specialist_gate`).
 * Fails closed on a launch refusal: throws `GateLaunchError` after waiting
 * for the async preflight, exactly like `runConcurrentGates`. */
export async function forkGate(gate: GateName, branch: GateBranch, options: { ambientEnv?: NodeJS.ProcessEnv; scope?: CancellationScope } = {}): Promise<ForkedGate> {
  let settled: GateOutcome | null = null;
  let handle: CommonHandleLike;
  if (branch.workload) {
    handle = launchWorkload(branch, options.scope);
  } else {
    try {
      await preflightTreeCleanup();
    } catch (error) {
      throw new GateLaunchError("preflight", error instanceof Error ? error.message : String(error));
    }
    handle = runProcess({
      file: branch.file,
      ...(branch.args !== undefined ? { args: branch.args } : {}),
      ...(branch.cwd !== undefined ? { cwd: branch.cwd } : {}),
      env: buildChildEnv(branch.envAllowlist, options.ambientEnv ?? process.env),
      ...(branch.timeoutMs !== undefined ? { timeoutMs: branch.timeoutMs } : {}),
      ...(branch.maxOutputBytes !== undefined ? { maxOutputBytes: branch.maxOutputBytes } : {}),
      ...(options.scope !== undefined ? { signal: options.scope.signal } : {}),
    });
    await handle.launched;
    if (handle.launchRefusal !== null) {
      throw new GateLaunchError(gate, handle.launchRefusal);
    }
  }
  return {
    gate,
    join: async (): Promise<GateOutcome> => {
      if (settled === null) settled = toOutcome(gate, await handle.result);
      return settled;
    },
    abort: handle.abort,
  };
}

interface CommonHandleLike {
  launched: Promise<void>;
  launchRefusal: string | null;
  result: Promise<ProcessResult>;
  abort: () => Promise<void>;
}

/** In-process gate workload launcher, shared by `runConcurrentGates` and
 * `forkGate`. See `GateBranch.workload` for the contract. */
export function launchWorkload(branch: GateBranch, scope?: CancellationScope): CommonHandleLike {
  const workload = branch.workload!;
  const started = Date.now();
  const controller = new AbortController();
  const scopeSignal = scope?.signal;
  if (scopeSignal?.aborted) controller.abort();
  scopeSignal?.addEventListener("abort", () => controller.abort(), { once: true });
  const result = (async (): Promise<ProcessResult> => {
    // Soft per-branch deadline: an in-process workload cannot be killed, so
    // expiry only reports the outcome; the specialist phase bounds itself
    // with its own internal phase deadline, which normally fires first.
    const deadline = branch.timeoutMs !== undefined && branch.timeoutMs > 0
      ? new Promise<"deadline">((resolve) => {
        const timer = setTimeout(() => resolve("deadline"), branch.timeoutMs);
        timer.unref?.();
      })
      : null;
    let code: number | "deadline";
    try {
      code = await Promise.race([
        workload(controller.signal),
        ...(deadline ? [deadline] : []),
      ]);
    } catch (error) {
      const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      if (scopeSignal?.aborted) {
        return { status: "cancelled", exitCode: null, signal: null, ...buffers, stdoutTruncated: false, stderrTruncated: false, durationMs: Date.now() - started, termination: null, launchError: error instanceof Error ? error.message : String(error) };
      }
      return { status: "exited", exitCode: 1, signal: null, ...buffers, stdoutTruncated: false, stderrTruncated: false, durationMs: Date.now() - started, termination: null, launchError: error instanceof Error ? error.message : String(error) };
    }
    if (typeof code !== "number") {
      return { status: "timeout", exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false, durationMs: Date.now() - started, termination: null };
    }
    return { status: "exited", exitCode: code, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false, durationMs: Date.now() - started, termination: null };
  })();
  return {
    launched: Promise.resolve(),
    launchRefusal: null,
    result,
    abort: async () => {
      controller.abort();
      await result.catch(() => {});
    },
  };
}
