import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { isPosix } from "./platform.js";

/**
 * POSIX process-tree termination (#679).
 *
 * A `child_process` handle owns its direct child only. Gates and evidence
 * providers run workloads that spawn descendants (gh/curl, transports,
 * sleeps), so cleanup must terminate the whole tree. Strategy, following the
 * #682 runtime spike evidence and the #634 bash implementation it replaces:
 *
 * 1. spawn the leader with `detached: true` so it leads its own process
 *    group (POSIX);
 * 2. on termination, snapshot the descendant tree breadth-first (`pgrep -P`,
 *    children before grandchildren) BEFORE signaling, so a descendant that
 *    later escapes the group (new session/PGID) or gets orphaned is still
 *    addressable;
 * 3. TERM the negative PGID (every current group member at once), then TERM
 *    the snapshotted descendants (covers PGID escapees, which keep their
 *    parent-child link across `setsid`);
 * 4. wait a bounded grace, polling liveness;
 * 5. KILL the group and any snapshot survivor, then verify. Survivors that
 *    still cannot be confirmed dead are reported — never silently dropped.
 *
 * `pgrep` is a hard preflight (`preflightTreeCleanup`): the forks refuse to
 * launch when it is missing instead of silently weakening cleanup to
 * group-only signaling (#634's exact bug class). Node cannot `wait()` for
 * orphaned grandchildren re-parented to init — the OS reaps them after the
 * KILL lands, which the liveness polls already observed.
 */

/** Hard cap on the descendant walk so a fork bomb cannot hang cleanup. */
export const MAX_TREE_NODES = 512;

const GRACE_POLL_MS = 50;
/** Short settle window after the KILL phase before declaring survivors. */
const KILL_SETTLE_MS = 150;

/**
 * Probe `pgrep` availability. NOT cached across calls: a once-per-process
 * cache would let a later-unavailable pgrep silently degrade the sweep while
 * the cached answer still claimed success — the cleanups report what they
 * actually observed, per termination. The probe is one spawn; gates pay it
 * once per fork, terminations once per cleanup.
 */
export function pgrepAvailable(): Promise<boolean> {
  if (!isPosix()) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const probe = spawn("pgrep", ["-P", "1"], { stdio: "ignore" });
    // ENOENT (and any other launch failure) means descendant discovery is
    // unavailable. A successful exec is proven by the `close` event: there is
    // no shell involved, so "command not found" can only ever arrive here.
    probe.on("error", () => done(false));
    probe.on("close", () => done(true));
  });
}

/**
 * Fail-closed preflight for tree-owning forks. Throws when descendant
 * discovery is unavailable so callers refuse to launch rather than degrade.
 */
export async function preflightTreeCleanup(): Promise<void> {
  if (!isPosix()) {
    throw new Error(
      `process-tree cleanup requires POSIX; '${process.platform}' is outside the supported v3 runner contract`,
    );
  }
  if (!(await pgrepAvailable())) {
    throw new Error(
      "pgrep is required to clean up process trees; install procps (pgrep) on the runner",
    );
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function pgrepChildren(pid: number): Promise<{ pids: number[]; ran: boolean }> {
  return new Promise<{ pids: number[]; ran: boolean }>((resolve) => {
    const probe = spawn("pgrep", ["-P", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    probe.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const finish = (): void => {
      const children: number[] = [];
      for (const line of out.split("\n")) {
        const value = Number.parseInt(line.trim(), 10);
        if (Number.isInteger(value) && value > 1) {
          children.push(value);
        }
      }
      resolve({ pids: children, ran: true });
    };
    probe.on("error", () => resolve({ pids: [], ran: false }));
    probe.on("close", finish);
  });
}

export interface DescendantSnapshot {
  /** Breadth-first descendant PIDs (children before grandchildren). */
  pids: number[];
  /** False when any pgrep invocation failed to launch — the walk is then
   * incomplete and callers must not claim a swept tree. */
  pgrepRan: boolean;
}

/**
 * Breadth-first descendant enumeration of `rootPid` (children before
 * grandchildren, so signaling the snapshot deepest-first keeps every node
 * addressable). Bounded by {@link MAX_TREE_NODES}; the walk order is
 * deterministic for a given tree.
 */
export async function collectDescendants(rootPid: number): Promise<DescendantSnapshot> {
  const ordered: number[] = [];
  let pgrepRan = true;
  let frontier = [rootPid];
  while (frontier.length > 0 && ordered.length < MAX_TREE_NODES) {
    const next: number[] = [];
    for (const pid of frontier) {
      const { pids: children, ran } = await pgrepChildren(pid);
      if (!ran) pgrepRan = false;
      for (const child of children) {
        if (ordered.length >= MAX_TREE_NODES) break;
        ordered.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return { pids: ordered, pgrepRan };
}

export interface TerminationReport {
  /** Whether the pgrep-based snapshot ran (preflight guarantees true). */
  swept: boolean;
  /** Descendant PIDs captured before any signal was sent. */
  snapshot: number[];
  /** Snapshot descendants that needed SIGKILL after the TERM grace. */
  killedAfterGrace: number[];
  /** Snapshot descendants still not confirmed dead after KILL + settle. */
  survived: number[];
  /** Non-fatal cleanup observations (e.g. EPERM on an already-dead pid). */
  issues: string[];
}

function signalGroupOrLeader(pid: number, signal: NodeJS.Signals, issues: string[]): void {
  try {
    // Negative PID targets the process group the detached leader owns.
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    issues.push(`group ${signal} failed (${code ?? "unknown"}); falling back to leader-only ${signal}`);
    try {
      process.kill(pid, signal);
    } catch {
      // Leader already gone — nothing to signal.
    }
  }
}

/**
 * Terminate and reap the tree rooted at `child`'s PID: snapshot, TERM group +
 * descendants, bounded grace, KILL group + survivors, verify. Idempotent per
 * call site — signaling dead PIDs is a no-op (ESRCH ignored).
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: { graceMs: number },
): Promise<TerminationReport> {
  const report: TerminationReport = {
    swept: false,
    snapshot: [],
    killedAfterGrace: [],
    survived: [],
    issues: [],
  };
  const pid = child.pid;
  if (pid === undefined || pid === null) return report;
  if (!isPosix()) {
    report.issues.push("non-POSIX platform: process-tree termination refused by policy");
    return report;
  }

  report.swept = await pgrepAvailable();
  if (report.swept) {
    const snapshot = await collectDescendants(pid);
    report.snapshot = snapshot.pids;
    report.swept = snapshot.pgrepRan;
  }
  if (!report.swept) {
    report.issues.push("pgrep unavailable during termination: cleanup ran group-only, the snapshot is incomplete");
  }

  // TERM phase: the whole current group at once, then the snapshot (catches
  // descendants that changed process group; they keep their parent link).
  signalGroupOrLeader(pid, "SIGTERM", report.issues);
  for (const descendant of report.snapshot) {
    try {
      process.kill(descendant, "SIGTERM");
    } catch {
      // Already gone.
    }
  }

  // Bounded grace on the leader + the captured snapshot.
  const deadline = Date.now() + options.graceMs;
  while (Date.now() < deadline) {
    const targets = [pid, ...report.snapshot];
    if (!targets.some((candidate) => isAlive(candidate))) break;
    await sleep(GRACE_POLL_MS);
  }

  // KILL phase: group first, then any snapshot survivor (PGID escapees).
  signalGroupOrLeader(pid, "SIGKILL", report.issues);
  for (const descendant of report.snapshot) {
    if (!isAlive(descendant)) continue;
    try {
      process.kill(descendant, "SIGKILL");
      report.killedAfterGrace.push(descendant);
    } catch {
      // Lost the race with its own exit.
    }
  }
  if (report.killedAfterGrace.length > 0) {
    await sleep(KILL_SETTLE_MS);
  }

  for (const descendant of report.snapshot) {
    // A brief zombie window is possible while the OS re-parents or the
    // leader's parent reaps; only persistent survivors are reported.
    if (isAlive(descendant)) report.survived.push(descendant);
  }
  return report;
}
