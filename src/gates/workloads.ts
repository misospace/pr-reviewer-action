import { rmSync } from "node:fs";
import { runCiWait } from "./ci-wait.js";
import { CI_GATE_ENV_KEYS, SPECIALIST_GATE_ENV_KEYS } from "./env.js";
import type { GateBranch } from "./gates.js";
import { runSpecialistsGate } from "./specialists-gate.js";

/**
 * The gate workloads as `dist/index.js` sub-modes (#706 PR 6):
 *
 *   node dist/index.js gate-ci                   (scripts/wait_for_ci.sh)
 *   node dist/index.js gate-specialists [args]   (scripts/run_specialists.py)
 *
 * `ciGateBranch` / `specialistGateBranch` build the `GateBranch` values
 * `runConcurrentGates` launches: the same Node binary re-entering the bundle,
 * with the child environment reduced to the gate's allowlist
 * (`src/gates/env.ts`). Wiring them into the review orchestration is PR 7's
 * job; nothing here runs unless a caller launches it.
 */

export const CI_GATE_SUBMODE = "gate-ci";
export const SPECIALIST_GATE_SUBMODE = "gate-specialists";

export interface WorkloadBranchOptions {
  /** Path to the bundle (`dist/index.js`). */
  entry: string;
  /** Extra CLI args (specialists: `--corpus`, `--adversarial-corpus`, ...). */
  args?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Node binary; defaults to the running one. */
  node?: string;
}

function branch(submode: string, envAllowlist: GateBranch["envAllowlist"], options: WorkloadBranchOptions): GateBranch {
  return {
    file: options.node ?? process.execPath,
    args: [options.entry, submode, ...(options.args ?? [])],
    envAllowlist,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
  };
}

export function ciGateBranch(options: WorkloadBranchOptions): GateBranch {
  return branch(CI_GATE_SUBMODE, CI_GATE_ENV_KEYS, options);
}

export function specialistGateBranch(options: WorkloadBranchOptions): GateBranch {
  return branch(SPECIALIST_GATE_SUBMODE, SPECIALIST_GATE_ENV_KEYS, options);
}

/** `gate-ci`: exit code per wait_for_ci.sh. TERM/INT remove an in-flight
 * evidence temp file and exit 143/130, like the v2 traps; an already
 * published evidence file is never touched. */
export async function ciGateMain(): Promise<number> {
  let tmp: string | null = null;
  const onSignal = (code: number) => (): void => {
    if (tmp !== null) rmSync(tmp, { force: true });
    process.exit(code);
  };
  process.once("SIGTERM", onSignal(143));
  process.once("SIGINT", onSignal(130));
  return runCiWait({
    env: process.env,
    onTmpChange: (path) => {
      tmp = path;
    },
  });
}

/** `gate-specialists`: exit 0 whenever the aggregate was written. */
export async function specialistsGateMain(argv: readonly string[]): Promise<number> {
  return runSpecialistsGate({ env: process.env, argv });
}

/** Flush stdout/stderr, then exit — a sub-mode must not linger on an
 * in-flight request timer after its result is decided. */
export function exitAfterFlush(code: number): void {
  process.stdout.write("", () => {
    process.stderr.write("", () => process.exit(code));
  });
}
