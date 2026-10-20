import type { RawInputs } from "../config/load-config.js";
import type { FetchLike } from "../platform/http.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import type { ciGateBranch } from "../gates/workloads.js";
import type { RunReviewResult } from "./review.js";

/** #726: canonical review intent/state. Forge-agnostic: no GITHUB_* / INPUT_*
 * environment keys — identity arrives as fields, ambient forge context via
 * `ambient` (the keys `buildStageEnv` projects, e.g. GITHUB_SERVER_URL). */
export interface ReviewRequest {
  /** Forge/repository identity, "owner/name" or the forge equivalent. */
  repository: string;
  prNumber: string;
  /** Reviewed head commit-ish ("" = unset; adapter path fills from event). */
  headSha: string;
  /** Trusted base commit-ish for repository config + standards ("" = unset). */
  baseRef: string;
  /** "" | "true" | "false" — the cross-repository PR flag as the stages ABI carries it. */
  isForkPr: string;
  /** Platform hint ("" = auto-resolve downstream). */
  platform: string;
  forgejoApiUrl: string;
  /** Where the CI-wait evidence table was written (v2: $runner.temp). */
  ciChecksFile: string;
  /** Resolved contract inputs (unresolved raw inputs; the ENGINE resolves
   * repository config from `baseRef` — effective config is request state). */
  inputs: RawInputs;
  /** Forge/runner ambient context keys (see AMBIENT_KEYS in src/run/env.ts).
   * Adapters pass their whole environment; engine callers pass only what
   * they need. Never a path to process.env. */
  ambient: Record<string, string | undefined>;
  /** Why this review runs ("push", "label", "comment-command", "manual", ...). */
  triggerReason: string;
  /** Explicit re-review intent (the `ai-review` label semantics). */
  forceRereview: boolean;
  /** Cancellation: when provided and aborted, the engine aborts its internal
   * v3 cancellation scope (src/runtime/signals.ts) and refuses to start when
   * already aborted. An abort at any later point also throws — a cancelled run
   * never resolves with a result. Provenance-only fields: `triggerReason` and
   * `forceRereview` are recorded, never consulted (rerun admission stays with
   * the host — see docs/architecture/engine-boundary.md). */
  signal?: AbortSignal;
}

/** #726: external capabilities injected by the host. Kept OUTSIDE the engine:
 * webhook/event reception, installation auth, durable queue/state, repository
 * clone/cache lifecycle, executor scheduling, and final forge publication. */
export interface ReviewDependencies {
  /** The reviewed checkout (repo map, standards file, related-code context). */
  workspace: string;
  /** Explicit artifact run dir — required; no env/global default (#838). */
  runDir: string;
  /** The platform read API injected by the host. Optional only because the
   * Action adapter path builds the same default adapter the pipeline always
   * built from the RESOLVED stage state (config + this request) — stage ABI,
   * never process env; direct engine callers inject it. */
  adapter?: PlatformReadAdapter;
  /** Step-output sink path (the GITHUB_OUTPUT equivalent; "/dev/null" = discard). */
  outputsSink: string;
  /** Step-summary sink path; "" = none. */
  stepSummaryPath?: string;
  fetchImpl?: FetchLike;
  /** Disk mirror of the artifact bus (default true). */
  persistArtifacts?: boolean;
  now?: () => number;
  sleep?: (seconds: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
  annotate: (line: string) => void;
  quiet?: boolean;
  /** CI-gate override for tests; explicit null disables the gate. */
  ciGate?: ReturnType<typeof ciGateBranch> | null;
  /** Explicit bundle entry the CI subprocess re-enters (adapter computes it
   * from its environment; engine callers without a bundle omit it). */
  ciGateEntry?: string;
}

export type { RunReviewResult as EngineRunResult };
