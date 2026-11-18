import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { validateContract } from "../config/contract.js";
import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { tangledContextFromEnv } from "../platform/tangled.js";
import { requireTangledHeadReadConfig } from "../platform/tangled-head.js";
import { derivePrStateReading } from "../platform/pr.js";
import type { FetchLike } from "../platform/http.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import type { PublishPlatformApi } from "../platform/publish-api.js";
import { publishStepRuns } from "../publish/publish.js";
import { buildPublishApi, publishEnvFromReview, publishInputFromEnv, publishWithOutcome, reviewDerivedPublishFields } from "./entrypoints.js";
import { actionStageEnv, createRunDir, failOnRequestChanges } from "./action.js";
import type { StageEnv } from "./env.js";
import { buildPlatformReadAdapter } from "./platform.js";
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
 * permits. The read capability is fully wired since #1690: a real run
 * completes precheck → review over the stock `TangledAdapter`'s current-
 * record-model resolution (ticket + newest immutable patch revision from
 * the repository account on the knot, diff derived over the Git read
 * surface) and publishes through the production `buildPublishApi`, which
 * stays fail-closed at the #451 current-head re-check (the #1165 knot
 * patch-record read) whenever the knot cannot prove the current head.
 * A publish-mode run whose context can never satisfy that read (no knot
 * host or repository DID) is refused BEFORE the review engine starts
 * (#1692), naming the missing variable instead of spending a full model
 * review on a doomed publication; a closed or proven-draft skip is
 * unaffected. The check runs before the review engine starts (#1696), so
 * the named diagnostic always comes first, and it fires for every pull that
 * is not a proven skip — including an unreadable one, because the metadata
 * read itself needs the knot, and the very config gap that breaks that read
 * must not bypass the guard. Failures propagate as a non-zero outcome: a
 * review that cannot prove the pull has not advanced is never published.
 */

/** Optional host seams. A Spindle operator wires the real Tangled adapters
 * (built from the resolved context); tests inject fakes so the whole
 * precheck → review → publish sequence runs offline. Leaving a seam unset
 * falls through to the production capability factory, so the injected and
 * real paths share one code path. */
export interface PlatformActionSeams {
  /** The forge READ capability (defaults to `buildPlatformReadAdapter`, which
   * the runner builds for this host — it returns a `TangledAdapter` for a
   * resolved Tangled run). */
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

  // The forge READ capability for this host: the injected seam when one is
  // provided, else the production factory (the Tangled adapter for a
  // Tangled-resolved stage). ONE adapter for the whole run — the
  // publication-config probe below and the engine read through the same
  // configured capability, and the production Tangled adapter serves its
  // cached metadata read to both.
  const readAdapter: PlatformReadAdapter = seams.platformAdapter
    ?? buildPlatformReadAdapter(stage as StageEnv, seams.fetchImpl);

  // #1692 (#1696): a publishing run whose Tangled context can never satisfy
  // the #1165 current-head read is refused BEFORE the review engine starts.
  // The old placement (after admission) let the Tangled diff-read refusal
  // win, so an operator never saw the named diagnostic. The publish mode
  // enables the check; the pull metadata decides whether it applies.
  if (publishStepRuns(stage.PUBLISH_MODE)) {
    // Without the repository DID no pull can be resolved at all, so there is
    // no skip-only case to protect: check the configuration right away.
    if (context.repoDid === undefined || context.repoDid.trim() === "") {
      requireTangledHeadReadConfig(context);
    } else {
      // The pull's own metadata decides. A closed pull and a PROVEN draft
      // pull are proven skips and stay protected. An open pull whose draft
      // bit is UNPROVEN is not a proven skip: the production adapter emits
      // `draft` only when the upstream record carries a boolean, so a
      // normal record leaves it unknown (#1696 review).
      const reading = derivePrStateReading(await readAdapter.getPr().catch(() => null));
      const provenSkip = reading.state === "closed"
        || (reading.state === "open" && reading.draft === "draft");
      // An UNREADABLE pull (unknown state) runs the probe too (#1696
      // review, major): the stock adapter's own review-identity resolution
      // needs the knot host and the repository account, so when THOSE are
      // what is missing, `getPr()` yields null and the guard must not be
      // bypassed by the very config gap that made the read fail — the
      // named diagnostic replaces the generic resolver failure. With the
      // config complete the probe is a no-op, so an unreadable pull still
      // proves nothing and the admission path fails closed unchanged.
      if (!provenSkip) {
        requireTangledHeadReadConfig(context);
      }
    }
  }

  // Precheck + review through the shared engine (manual semantics: no event),
  // reading through the ONE capability built above.
  const review = await runReview({
    env: stage as NodeJS.ProcessEnv,
    inputs,
    runDir,
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    platformAdapter: readAdapter,
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
    // #1656 audit round 2: the authoritative disposition gates the
    // workflow, never the raw verdict.
    review.finalDisposition?.kind,
  );
  return publishFailed ? Math.max(gate, 1) : gate;
}
