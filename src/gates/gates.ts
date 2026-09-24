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
  /** Allowlist for this child's environment (see `./env.ts`). */
  envAllowlist: EnvAllowlist;
  /** Optional per-branch deadline; expiry terminates the whole tree. */
  timeoutMs?: number;
  /** Per-stream stdout/stderr capture cap. */
  maxOutputBytes?: number;
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

function toOutcome(gate: GateName, result: ProcessResult): GateOutcome {
  const ok = result.status === "exited" && result.exitCode === 0;
  let error: string | null = null;
  if (!ok) {
    switch (result.status) {
      case "exited":
        error = `workload exited ${result.exitCode}`;
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

  // Fail-closed preflight (the typed require_gate_tree_cleanup): refuse to
  // enter background concurrency when descendant cleanup cannot be guaranteed.
  try {
    await preflightTreeCleanup();
  } catch (error) {
    throw new GateLaunchError(
      "preflight",
      error instanceof Error ? error.message : String(error),
    );
  }

  const launch = (gate: GateName, branch: GateBranch): ProcessHandle =>
    runProcess({
      file: branch.file,
      ...(branch.args !== undefined ? { args: branch.args } : {}),
      ...(branch.cwd !== undefined ? { cwd: branch.cwd } : {}),
      env: buildChildEnv(branch.envAllowlist, ambient),
      ...(branch.timeoutMs !== undefined ? { timeoutMs: branch.timeoutMs } : {}),
      ...(branch.maxOutputBytes !== undefined ? { maxOutputBytes: branch.maxOutputBytes } : {}),
      ...(options.scope !== undefined ? { signal: options.scope.signal } : {}),
    });

  // Both forks happen before either join, exactly as corpus.sh arranges them.
  const ciHandle = options.ci ? launch("ci", options.ci) : null;
  const specialistHandle = options.specialists ? launch("specialists", options.specialists) : null;

  // Launch refusals are loud: terminate any sibling that already launched,
  // reap it, then fail. Never enter concurrency with a hole in ownership.
  for (const [gate, handle] of [
    ["ci", ciHandle],
    ["specialists", specialistHandle],
  ] as const) {
    if (handle !== null && handle.launchRefusal !== null) {
      const refusal: string = handle.launchRefusal;
      const siblings = [ciHandle, specialistHandle].filter(
        (candidate): candidate is ProcessHandle =>
          candidate !== null && candidate !== handle,
      );
      for (const sibling of siblings) await sibling.abort();
      await Promise.allSettled(siblings.map((sibling) => sibling.result));
      throw new GateLaunchError(gate, refusal);
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
