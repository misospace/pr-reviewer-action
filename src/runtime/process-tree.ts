import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
 * Liveness is "can this pid still execute", not "does this pid still answer
 * `kill(pid, 0)`": a killed process its parent has not reaped is a ZOMBIE —
 * it cannot execute another instruction but keeps answering the signal
 * probe. An orphan re-parented to a PID 1 that never `wait()`s (a container
 * init or bare shell) would otherwise be a survivor forever, in exactly the
 * constrained sandboxes where the runner's own reaping is missing. A zombie
 * is reported in `unreaped`, never as a survivor: terminated is the property
 * the cleanup owns, and the report still says nothing silently.
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

type ProcessLiveness = "running" | "zombie" | "gone";

/**
 * `/proc/<pid>/stat` field 3 (`state`), parsed AFTER the last `)`: the
 * `comm` field may contain spaces and parentheses, so splitting the whole
 * line mis-counts every field behind it (same rule as the executor's
 * process-identity reader). Returns null when `/proc` says nothing: no
 * `/proc` platform, a vanished pid, or an unreadable entry.
 */
function procState(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    return stat.slice(close + 1).trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Three-state liveness for the cleanup's verification pass. `running` can
 * still execute; `zombie` cannot execute but is not reaped yet (it still
 * answers `kill(pid, 0)`); `gone` no longer exists. A pid `/proc` cannot
 * describe (macOS, or it vanished between steps) falls back to the signal
 * probe, so an unverifiable process is never called terminated.
 */
function processLiveness(pid: number): ProcessLiveness {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "gone";
  const state = procState(pid);
  if (state !== null) return state === "Z" ? "zombie" : "running";
  try {
    process.kill(pid, 0);
    return "running";
  } catch {
    return "gone";
  }
}

/**
 * Whether `pid` can still execute instructions. A zombie (killed, awaiting
 * reap) CANNOT execute, so it is terminated even while it keeps answering
 * `kill(pid, 0)`; only a pid no liveness source can describe stays counted.
 * This is the predicate the tree sweep polls during the grace, decides the
 * KILL escalation with, and classifies `survived` vs `unreaped` by.
 */
export function processCanExecute(pid: number): boolean {
  return processLiveness(pid) === "running";
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
  /** Snapshot descendants still able to execute after KILL + settle. */
  survived: number[];
  /** Snapshot descendants confirmed terminated (killed) but not yet reaped
   * by their parent at verification time. A zombie cannot execute, so it is
   * NOT a survivor — but it is reported here, never silently dropped. */
  unreaped: number[];
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

/** An empty report: nothing was terminated and nothing was observed. */
function emptyTerminationReport(): TerminationReport {
  return {
    swept: false,
    snapshot: [],
    killedAfterGrace: [],
    survived: [],
    unreaped: [],
    issues: [],
  };
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
  const pid = child.pid;
  if (pid === undefined || pid === null) return emptyTerminationReport();
  return terminateProcessTreeByPid(pid, options);
}

/**
 * Terminate and reap the tree rooted at `pid` — the PID-based entry point a
 * RECOVERED cancellation needs: after a controller restart the in-memory
 * `ChildProcess` handle is gone, but the pid (recorded in the durable
 * recovery record) still identifies the worker.
 *
 * The TERM → grace → KILL → verify discipline lives here exactly once; the
 * handle-based entry point delegates to it, so a recovered cancellation and
 * a live cancellation cannot drift apart.
 *
 * A pid that is not a process id is REFUSED, never signalled: `kill(0, sig)`
 * reaches the caller's own process group and `kill(-pid, sig)` with a
 * negative pid reaches init, so a corrupt (or hostile) pid must never reach
 * a signal. The refusal is reported as an issue — the caller must treat the
 * termination as unconfirmed.
 */
export async function terminateProcessTreeByPid(
  pid: number | null | undefined,
  options: { graceMs: number },
): Promise<TerminationReport> {
  const report: TerminationReport = emptyTerminationReport();
  if (pid === undefined || pid === null) return report;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    report.issues.push(`refusing to terminate pid ${pid}: not a process id`);
    return report;
  }
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
    if (!targets.some((candidate) => processLiveness(candidate) === "running")) break;
    await sleep(GRACE_POLL_MS);
  }

  // KILL phase: group first, then any snapshot survivor (PGID escapees).
  signalGroupOrLeader(pid, "SIGKILL", report.issues);
  for (const descendant of report.snapshot) {
    // A zombie cannot execute, so it is already terminated: signaling it
    // again would only mis-record it as a grace-period kill.
    if (processLiveness(descendant) !== "running") continue;
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
    // A zombie window is expected while the OS re-parents or the leader's
    // parent reaps: the process is terminated (it cannot execute), so it is
    // reported in `unreaped`, not as a survivor. Only a pid that can still
    // execute is a survivor.
    const liveness = processLiveness(descendant);
    if (liveness === "running") report.survived.push(descendant);
    else if (liveness === "zombie") report.unreaped.push(descendant);
  }
  return report;
}
