/** Repository acquisition for self-hosted reviews (#732): the persistent
 * bare mirror cache and isolated per-review exact-head workspaces a future
 * executor/worker (#733) prepares before running the review engine.
 *
 * Operator-mode library — NOT wired into the Action runtime. Design and
 * acceptance mapping: docs/architecture/repo-acquisition-workspaces.md.
 */

export { AcquisitionError, type AcquisitionFailureCode, type FetchCredentials, type MirrorInfo, type WorkspaceHandle, type WorkspaceInfo } from "./types.js";
export { gitCredentialEnv, gitEnv, gitInvocationEnv, safeCloneUrl, toFetchCredentials } from "./git-env.js";
export { mirrorDirName, MirrorCache, withMirrorLock, type MirrorOptions } from "./mirror.js";
export { createReviewWorkspace, sweepStaleWorkspaces, type SweepResult, type WorkspaceRequest } from "./workspace.js";
