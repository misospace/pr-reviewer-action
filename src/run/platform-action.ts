import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateContract } from "../config/contract.js";
import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { tangledContextFromEnv } from "../platform/tangled.js";
import type { FetchLike } from "../platform/http.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import type { PublishPlatformApi } from "../platform/publish-api.js";
import { publishStepRuns } from "../publish/publish.js";
import { buildPublishApi, publishEnvFromReview, publishInputFromEnv, publishWithOutcome, reviewDerivedPublishFields } from "./entrypoints.js";
import { actionStageEnv, createRunDir, failOnRequestChanges } from "./action.js";
import { nonEmpty } from "./run-dir.js";
import { rawInputsFromEnv, runReview } from "./review.js";

/**
 * The host-neutral Tangled/Spindle runner (#590).
 *
 * It sequences precheck → review → publish for a Tangled-resolved pull in an
 * ordinary Node process, driving the SAME v3 engine (`runReview`) the GitHub
 * Action drives and publishing through the SAME capability seam
 * (`buildPublishApi` → `TangledPublishApi`), so no reviewer logic is
 * duplicated and the two hosts can never drift on what a review means.
 *
 * Host-neutrality (#590 acceptance): the process requires NO
 * `GITHUB_EVENT_PATH`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`, or
 * `RUNNER_TEMP`. The reviewed event is not a GitHub webhook — a Tangled pull
 * carries no event payload — so the review runs with manual (full-review)
 * semantics and the pull itself is resolved from the `TANGLED_*` context
 * through the typed Tangled modules. There is no gh/Python/shell orchestration
 * and no GitHub/Forgejo fallback: the platform is pinned to `tangled` — in the
 * stage env AND in the contract config input, because the engine rebuilds its
 * stage from that config — and an explicitly configured GitHub/Forgejo
 * platform is refused rather than silently ignored. Every forge read goes
 * through the platform read adapter and every write through the publish API
 * the seam selects.
 *
  * The Tangled MVP deliberately leaves CI-waiting unsupported (no real Tangled
  * pipeline-status seam exists): the CI gate is forced off here rather than
  * spawning a child the platform guard would refuse, exactly as the issue
  * permits. A real Tangled pull cannot be reviewed end-to-end today: the read
  * capability fails closed at the diff read (#586 wires metadata reads only),
  * so the run throws before publication; and even once diff reads land,
  * publication stays fail-closed at the #451 current-head re-check until a
  * trustworthy current-head read ships (#1165). Both are propagated as a
  * non-zero outcome — a review that cannot prove the pull has not advanced is
  * never published.
 */

/** Optional host seams. A Spindle operator wires the real Tangled adapters
 * (built from the resolved context); tests inject fakes so the whole
 * precheck → review → publish sequence runs offline. Leaving a seam unset
 * falls through to the production capability factory, so the injected and
 * real paths share one code path. */
export interface PlatformActionSeams {
  /** The forge READ capability (defaults to `buildPlatformReadAdapter` via the
   * engine — which returns a `TangledAdapter` for a resolved Tangled run). */
  platformAdapter?: PlatformReadAdapter;
  /** The forge WRITE capability (defaults to `buildPublishApi` → the Tangled
   * AT-Proto record client). */
  publishApi?: PublishPlatformApi;
  /** Model/transport override (tests; mirrors `RunReviewOptions.fetchImpl`). */
  fetchImpl?: FetchLike;
  /** Reuse an explicit run directory instead of a fresh private temp one. */
  runDir?: string;
}

/** A host-neutral runner refusal (wrong platform / incomplete Tangled context).
 * Distinct from a review or publication failure, which the engine and publish
 * seams report through their own typed errors / exit codes. */
export class PlatformActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformActionError";
  }
}

/** The host temp root for the private run dir and CI-checks scratch file.
 * `RUNNER_TEMP` is honoured when a runner happens to set it, but is never
 * required: an ordinary Node process falls back to `TMPDIR` then the OS temp
 * dir. The run dir is always a fresh private directory (#838) — never the
 * reviewed checkout. */
function hostTempDir(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.RUNNER_TEMP) ?? nonEmpty(env.TMPDIR) ?? tmpdir();
}

/**
 * Runs one host-neutral review of a Tangled pull: precheck → review → publish.
 *
 * Exit codes preserve the Action's semantics exactly:
 * - a skip / no-review run exits through the fail-on-request-changes gate
 *   (0 normally, 1 when a carried `request_changes` verdict blocks);
 * - a review that reaches publication exits 0 on published/superseded and 1
 *   when publication fails (including Tangled's fail-closed current-head
 *   refusal), combined with the fail-on-request-changes gate via `Math.max`;
 * - a failed review THROWS (`RunReviewError`) so the caller maps its exit code.
 */
export async function platformActionMain(
  env: NodeJS.ProcessEnv = process.env,
  seams: PlatformActionSeams = {},
): Promise<number> {
  // The v3 contract inputs (AI provider, publish mode, token, …) bind exactly
  // as the Action entry binds them — `actionStageEnv` reads `INPUT_*` plus the
  // ambient context and never requires a GitHub event file (it defaults the
  // event to none when `GITHUB_EVENT_PATH` is absent, which is the Tangled
  // case).
  //
  // The inputs are read from the ORIGINAL environment (kebab `INPUT_*` and
  // their v2 fallbacks), BEFORE the Tangled identity is written into the
  // stage. The contract's `pr-number` input is integer-typed; a Tangled pull
  // has no numeric number, so the derived locator must never be re-read as
  // that input. Passing these explicit inputs to `runReview` keeps the engine's
  // `loadConfig` on exactly the values `actionStageEnv` used — while the
  // non-numeric identity reaches precheck only through the ambient PR_NUMBER.
  const inputs = rawInputsFromEnv(validateContract(V3_CONTRACT), env);

  // #590: the runner IS the Tangled host, so the platform config input is
  // PINNED here — and an explicitly configured GitHub/Forgejo platform is
  // REFUSED rather than silently ignored.
  //
  // Pinning the INPUT (not just the stage) is what holds the no-fallback
  // invariant. The engine rebuilds its stage from the contract config
  // (`admissionStageEnv` → `stageEnvFromConfig`), so an operator's
  // `INPUT_PLATFORM=github` would otherwise re-resolve the platform during
  // admission and route this run's forge reads through a GitHub client — the
  // fallback #590 forbids. With the input pinned, EVERY downstream resolution
  // — the admission stage env, the config stage, the repository-config
  // narrowing — reads `tangled`, and a missing DID fails closed
  // (`resolvePlatform("tangled", …)` throws) instead of defaulting to GitHub.
  //
  // The refusal is the honest half of the pin: an explicit `github`/`forgejo`
  // platform on this runner is a contradictory configuration, and silently
  // reviewing a Tangled pull under it would hide the operator's mistake.
  const requestedPlatform = (inputs["platform"] ?? "").trim().toLowerCase();
  if (requestedPlatform !== "" && requestedPlatform !== "auto" && requestedPlatform !== "tangled") {
    throw new PlatformActionError(
      `the tangled runner reviews Tangled pulls only and refuses platform '${requestedPlatform}': it never falls back to GitHub or Forgejo`,
    );
  }
  inputs["platform"] = "tangled";

  const stage = actionStageEnv(env);

  // Pin the platform to the Tangled/Spindle host. This is what guarantees no
  // GitHub/Forgejo fallback on this path: the read adapter and publish API the
  // seams resolve are selected by the platform factory, and a Tangled-resolved
  // environment is never routed through a GitHub or Forgejo client.
  stage.PLATFORM = "tangled";

  // Resolve and validate the typed Tangled runtime context (#583): fails closed
  // with a descriptive error naming the missing variable when the required
  // `TANGLED_REPO_DID` is absent.
  const context = tangledContextFromEnv(stage);

  // A Tangled pull is DID-addressed: it has no `owner/repo` path and no numeric
  // number, and the read adapter ignores both — it resolves the pull from the
  // `TANGLED_*` context. Precheck only requires a NON-EMPTY identity string.
  // The config's `repo` input is a plain string, so the DID/name is an honest
  // value there; the integer-typed `pr-number` input is left at its default and
  // the locator reaches precheck only through the ambient PR_NUMBER (the read
  // capability never uses it — see the inputs note below).
  const repoIdentity = context.repoDid ?? context.repoName ?? context.ownerDid;
  if (nonEmpty(stage.REPO) === undefined) {
    stage.REPO = repoIdentity;
  }
  if (nonEmpty(stage.PR_NUMBER) === undefined) {
    stage.PR_NUMBER = context.sourceBranch ?? context.sourceSha ?? "";
  }

  // #590 MVP: no real Tangled pipeline-status seam exists, so CI-waiting is
  // left unsupported rather than spawning a gate child the platform guard
  // would refuse (the parent treats it as advisory either way, but forcing it
  // off keeps the host-neutral path clean). The engine rebuilds its stage from
  // the contract config, so the input override is what actually reaches the
  // gate decision; the stage write is kept for any ambient reader.
  stage.CI_STATUS_CHECK = "false";

  // The `repo` input is fed the DID identity so it survives the engine's
  // config-driven stage rebuild (which would otherwise reset it to the empty
  // default); a host that set an integer `pr-number` input keeps it.
  if (nonEmpty(inputs["repo"]) === undefined) {
    inputs["repo"] = repoIdentity;
  }
  // The engine rebuilds its stage from these config inputs, so the CI-wait
  // gate must be disabled HERE (the contract default is "true"); the stage
  // write above never reaches the engine's gate decision.
  inputs["ci-status-check"] = "false";

  const temp = hostTempDir(env);
  stage.CI_CHECKS_FILE = join(temp, "ci-checks-context.md");
  const runDir = nonEmpty(seams.runDir) ?? createRunDir(temp);
  stage.PR_REVIEWER_RUN_DIR = runDir;

  // Precheck + review through the shared engine (manual semantics: no event).
  // The read capability is the injected seam when provided, else the engine
  // builds the Tangled adapter from the stage env.
  const review = await runReview({
    env: stage as NodeJS.ProcessEnv,
    inputs,
    runDir,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    ...(seams.platformAdapter !== undefined ? { platformAdapter: seams.platformAdapter } : {}),
    ...(seams.fetchImpl !== undefined ? { fetchImpl: seams.fetchImpl } : {}),
  });

  // ── Skip / no-review ────────────────────────────────────────────────────
  // Host-neutral: no step outputs, no summary file. The skip reason is a
  // fixed constant from precheck; only the fail-on-request-changes gate can
  // turn a skip into a non-zero exit (a carried `request_changes` verdict).
  if (!review.shouldReview) {
    const pre = review.admission;
    process.stderr.write(`[tangled] Review skipped: ${pre.skip_reason || "<none>"}\n`);
    const carriedPointer = pre.verdict === "request_changes"
      ? `The verdict was carried from the review of ${pre.head_sha !== "" ? pre.head_sha : "<unknown>"}.`
      : "";
    return failOnRequestChanges(
      stage,
      pre.verdict ?? "",
      pre.degradedGateBypass === true,
      (stage.FAIL_ON_DEGRADED_REVIEW ?? "false").toLowerCase() === "true",
      "",
      carriedPointer,
    );
  }

  // ── Publish ─────────────────────────────────────────────────────────────
  let publishFailed = false;
  if (publishStepRuns(stage.PUBLISH_MODE)) {
    const publishEnv = publishEnvFromReview(stage, review, undefined);
    const seam: ReturnType<typeof buildPublishApi> = seams.publishApi !== undefined
      // The injected publish capability is the write seam. A Tangled publish
      // never re-reads the diff for positioning (GitHub's inline-diff anchor
      // path), so the diff provider is a no-op here; the production seam
      // (`buildPublishApi`) supplies its own when a real Tangled API is built.
      ? { api: seams.publishApi, platform: "tangled", diffProvider: async (): Promise<string> => "" }
      : buildPublishApi(publishEnv as NodeJS.ProcessEnv, runDir);
    // No event-driven label lifecycle runs on a host process, so publish's own
    // rerunLabel strip is not requested (the Action strips it for the same
    // reason — label cleanup is event-owned). Publication is decided by
    // PUBLISH_MODE alone.
    const { rerunLabel: _rerunLabel, ...publishInput } = publishInputFromEnv(publishEnv as NodeJS.ProcessEnv, seam.platform);
    // #1518: this host generates its own per-run review id (the Action
    // entry already has one), so the published handoff names the review it
    // belongs to on every host.
    const reviewId = randomBytes(8).toString("hex");
    const input = { ...publishInput, ...reviewDerivedPublishFields(review), reviewId };
    const outcome = await publishWithOutcome(input, seam, runDir);
    publishFailed = outcome.exitCode !== 0;
  }

  const gate = failOnRequestChanges(
    stage,
    review.outputs.verdict,
    review.outputs.degradedGateBypass,
    (stage.FAIL_ON_DEGRADED_REVIEW ?? "false").toLowerCase() === "true",
    review.outputs.findings,
    "",
  );
  return publishFailed ? Math.max(gate, 1) : gate;
}
