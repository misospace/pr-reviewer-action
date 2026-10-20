/** Acquisition contracts for #732: repository mirror cache and isolated
 * per-review workspaces.
 *
 * Operator-mode library (like `src/ingress/` and `src/queue/`): a future
 * executor/worker (#733) imports it to turn a `ReviewJob` into an isolated
 * exact-head workspace. NOT wired into the Action runtime — `action.yml` and
 * the action pipeline are untouched.
 *
 * Like `ReviewJob`, every contract field is required with an explicit
 * sentinel, never optional, so consumers never branch on `undefined`.
 */

export type AcquisitionFailureCode =
  | "invalid_config"
  | "invalid_head"
  | "head_not_found"
  | "base_not_found"
  | "fetch_timeout"
  | "fetch_failed"
  | "corrupt_mirror"
  | "workspace_refusal";

export class AcquisitionError extends Error {
  readonly code: AcquisitionFailureCode;

  constructor(code: AcquisitionFailureCode, message: string) {
    super(message);
    this.name = "AcquisitionError";
    this.code = code;
  }
}

/** Opaque git credential for the fetch invocation, BOUND to the clone URL
 * it belongs to: the acquisition layer refuses to pair a credential for
 * one host with a clone URL for another (that mixup would send host A's
 * token to host B). Produced from the #730 `CloneCredential` via
 * `toFetchCredentials` (`src/acquisition/git-env.ts`); the token travels
 * only inside the fetch child's environment and is never persisted,
 * logged, or placed in argv/URLs. */
export interface FetchCredentials {
  /** The exact clone URL this credential authorizes. */
  readonly cloneUrl: string;
  /** The HTTP Basic authorization pair (`Authorization` header value). */
  readonly authorization: string;
}

/** Result of a successful mirror ensure: the bare mirror serving the
 * (platform, repository) pair, plus whether this call had to rebuild a
 * corrupted mirror from scratch. */
export interface MirrorInfo {
  readonly mirrorPath: string;
  readonly rebuilt: boolean;
}

/** An isolated exact-head workspace extracted for one review. */
export interface WorkspaceInfo {
  /** The extracted worktree directory (inside the controller-owned
   * `workspaces/` root next to the mirror). */
  readonly rootPath: string;
  /** Pinned head commit SHA (normalized lowercase hex). */
  readonly headSha: string;
  /** Effective merge-base of head against the requested base, matching the
   * Action's base/merge-base diff semantics; "" when no base was requested
   * or the histories share none (unrelated histories are surfaced, never
   * guessed). */
  readonly mergeBaseSha: string;
  readonly platform: "github" | "forgejo";
  readonly repoFullName: string;
  readonly createdAtMs: number;
}

export interface WorkspaceHandle {
  readonly info: WorkspaceInfo;
  /** Idempotent cleanup: removes the worktree registration and the
   * extracted directory. Must be called by the owner (executor) when the
   * review ends — success, failure, or cancellation. */
  close(): Promise<void>;
}
