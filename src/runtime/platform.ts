/**
 * Supported-OS policy for tree-owning child processes (#679).
 *
 * Process-group ownership (spawn with `detached: true`, signal the negative
 * PGID) is POSIX. The v3 runner contract is POSIX-only for workloads that own
 * a process tree: GitHub-hosted `ubuntu-latest` and the Forgejo job image
 * (`node:24-bullseye`, qualified by #683). Windows was never demonstrated —
 * `detached` there means a different thing and negative-PGID signaling does
 * not exist — so instead of silently degrading to leader-only termination
 * (the exact lifecycle bug class this migration repairs), launching a
 * tree-owning child on a non-POSIX platform is a fail-closed refusal.
 *
 * Development on macOS (darwin) is supported: `setsid`/process groups behave
 * the same for spawn/signaling purposes, which is what the lifecycle tests
 * rely on.
 */

export function isPosix(): boolean {
  return process.platform !== "win32";
}

export class PlatformPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformPolicyError";
  }
}

/** Fail-closed refusal for tree-owning children outside the POSIX contract. */
export function assertPosixProcessTree(context: string): void {
  if (isPosix()) return;
  throw new PlatformPolicyError(
    `${context}: process-tree ownership requires POSIX; '${process.platform}' is outside the supported v3 runner contract and leader-only termination is never used as a silent fallback`,
  );
}
