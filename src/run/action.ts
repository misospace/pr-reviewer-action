import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { validateContract } from "../config/contract.js";
import { loadConfig } from "../config/load-config.js";
import { commentBodyTriggersCommentCommand, eventLabelName, runPrecheck, type PrecheckOutput } from "../precheck/decide.js";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import { repoScopedUrl } from "../platform/repo-ref.js";
import { V3_CONTRACT } from "../../.v3-generated/contract.generated.js";
import { stageEnvFromConfig } from "./env.js";
import { buildAdapter, buildPublishApi, publishInputFromEnv, publishWith, readEvent, type StepEvent } from "./entrypoints.js";
import { rawInputsFromEnv, runReview } from "./review.js";
import { createRunDir } from "./run-dir.js";

export { createRunDir };

/**
 * The JavaScript action entry (`runs.using: node24`, #706): the whole review
 * in one process — precheck, review, publish, re-review label cleanup and
 * the fail-on-request-changes gate — with typed state passed between stages
 * instead of composite step outputs. The runner exports the inputs as
 * `INPUT_<ID>` with contract defaults already applied.
 */

type Env = Record<string, string | undefined>;

export function writeOutputs(env: NodeJS.ProcessEnv, outputs: ReadonlyArray<[string, string | undefined]>): void {
  const file = env.GITHUB_OUTPUT ?? "";
  if (file === "" || file === "/dev/null") return;
  let text = "";
  for (const [key, value] of outputs) {
    if (value === undefined) continue;
    if (!value.includes("\n")) {
      text += `${key}=${value}\n`;
      continue;
    }
    // Random heredoc delimiter, re-drawn if the value contains it, so a
    // multiline value can never forge another assignment.
    let delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
    while (value.includes(delimiter)) delimiter = `ghadelimiter_${randomBytes(16).toString("hex")}`;
    text += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
  }
  if (text !== "") appendFileSync(file, text);
}

/** #903: append one already-rendered line to the job's step summary. Like
 * `writeOutputs`, a no-op outside a runner (no path, or the /dev/null
 * sentinel). */
export function appendStepSummary(env: NodeJS.ProcessEnv, line: string): void {
  const file = env.GITHUB_STEP_SUMMARY ?? "";
  if (file === "" || file === "/dev/null") return;
  appendFileSync(file, `${line}\n`);
}

/** Render untrusted inline text as an inert Markdown code span, following
 * the repo-wide fence-safe strategy (e.g. `src/context/repo-map.ts`
 * `codeSpan`): the delimiter is one backtick longer than the longest run in
 * the content, so embedded backticks, link syntax, or emphasis characters
 * can neither close the span nor render as Markdown. Padding spaces keep a
 * boundary backtick from merging into the delimiter — a leading backtick
 * plus the generated fence would otherwise form a longer opening run,
 * leaving the span unterminated and the payload exposed as live Markdown.
 * Control characters are flattened first: the step summary line must stay
 * one line. */
function inlineCodeValue(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (!flat.includes("`")) return `\`${flat}\``;
  let maxRun = 0;
  for (const run of flat.match(/`+/g) ?? []) maxRun = Math.max(maxRun, run.length);
  const delim = "`".repeat(maxRun + 1);
  return `${delim} ${flat} ${delim}`;
}

/** The label a `labeled` event carries (GitHub sends `{ name }`). Moved to
 * `precheck/decide.ts` (#892) so both `decide.ts`'s label gate and this
 * cleanup path normalize the same way; re-exported here for callers (and
 * tests) that already import it from this module. */
export { eventLabelName };

/** The stage environment every ported stage reads: the typed config
 * projected to its SCREAMING_SNAKE ABI plus the derived runner context the
 * composite used to compute in its env blocks. */
export function actionStageEnv(env: NodeJS.ProcessEnv): Env {
  const contract = validateContract(V3_CONTRACT);
  const config = loadConfig(contract, rawInputsFromEnv(contract, env));
  const stage: Env = { ...env, ...stageEnvFromConfig(config) };
  // stageEnvFromConfig projects `github-token` (secret-revealed) as GITHUB_TOKEN.
  const token = stage.GITHUB_TOKEN || env.GH_TOKEN || "";
  stage.GH_TOKEN = token;
  stage.FORGEJO_TOKEN = stage.FORGEJO_TOKEN || token;
  stage.REPO = stage.REPO || env.GITHUB_REPOSITORY || "";
  stage.PR_NUMBER = stage.PR_NUMBER || readEvent(env).prNumber || "";
  const server = env.GITHUB_SERVER_URL ?? "";
  stage.FORGEJO_API_URL = stage.FORGEJO_API_URL || (server !== "" && server !== "https://github.com" ? server : "");
  stage.ACTION_REF = env.GITHUB_ACTION_REF ?? "";
  stage.LINEAR_API_KEY_CONFIGURED = stage.LINEAR_API_KEY ? "true" : "false";
  return stage;
}

function shouldPublish(stage: Env): boolean {
  const mode = stage.PUBLISH_MODE ?? "";
  return mode === "review_comment" || mode === "review_verdict" || (mode === "comment" && stage.PUBLISH_REVIEW_COMMENT === "true");
}

export async function actionMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const stage = actionStageEnv(env);
  const { event, headSha: eventHeadSha } = readEvent(env);
  stage.EVENT_HEAD_SHA = eventHeadSha ?? "";

  // ── Comment on a plain issue: clean no-op ─────────────────────────────
  // #914: a `created` `issue_comment` on a PLAIN issue (the payload's
  // `issue` has no `pull_request`) is not a re-review request at all.
  // `runPrecheck` REQUIRES a PR number (it throws without one), so this
  // must be a clean green no-op HERE, before precheck, not a crash.
  // `readEvent` only fills PR_NUMBER from `issue.number` when
  // `issue.pull_request` is present, so an empty PR_NUMBER is the honest
  // "this comment is not on a PR" signal. The reason is one of this
  // action's fixed constants; no untrusted text is rendered.
  if (
    event?.name === "issue_comment"
    && event.action === "created"
    && (stage.PR_NUMBER ?? "") === ""
  ) {
    writeOutputs(env, [
      ["should-review", "false"],
      ["skip-reason", "comment-not-on-pr"],
      ["verdict", ""],
      ["verdict-source", ""],
      ["review-result", ""],
    ]);
    process.stderr.write("[v3] Review skipped: comment-not-on-pr\n");
    appendStepSummary(env, "**AI PR Review skipped:** `comment-not-on-pr`");
    return 0;
  }

  // ── Precheck ──────────────────────────────────────────────────────────
  const pre: PrecheckOutput = await runPrecheck({
    env: stage as Record<string, string>,
    adapter: buildAdapter(stage),
    ...(event !== undefined ? { event: event as never } : {}),
    ...(eventHeadSha !== undefined ? { eventHeadSha } : {}),
  });
  writeOutputs(env, [
    ["should-review", pre.should_review],
    ["skip-reason", pre.skip_reason],
    ["diff-fingerprint", pre.diff_fingerprint],
  ]);
  if (pre.should_review !== "true") {
    writeOutputs(env, [["verdict", pre.verdict], ["verdict-source", pre.verdict_source], ["review-result", pre.review_result]]);
    // #903: this branch used to exit silently — outputs written, no log
    // line, no step summary — so a labeler-triggered skip showed the same
    // green check as a run that crashed before doing anything. The event
    // label is untrusted payload and the two surfaces are different fences:
    // the stderr line quotes it as JSON (control characters become
    // escapes, so no forged log lines), while the Markdown summary renders
    // it as a fence-safe code span (JSON escaping does not neutralize
    // backticks or link syntax). The reason is one of this action's fixed
    // constants and is interpolated directly.
    const skipLabel = eventLabelName(event?.label);
    const carryLabel = pre.skip_reason === "unrelated-label" && skipLabel !== "";
    const skipReason = pre.skip_reason || "<none>";
    process.stderr.write(
      `[v3] Review skipped: ${skipReason}${carryLabel ? ` (label: ${JSON.stringify(skipLabel)})` : ""}\n`,
    );
    appendStepSummary(
      env,
      `**AI PR Review skipped:** \`${skipReason}\`${carryLabel ? ` (label: ${inlineCodeValue(skipLabel)})` : ""}`,
    );
    // #914: a matching re-review command on a FORK PR is not reviewable with
    // a repo token (fork PRs belong to the fork workflow — see
    // docs/fork-review.md), so the run replies to the comment pointing the
    // commenter there. The reply body is a fixed constant — no untrusted
    // content ever reaches it — and the reply is additionally gated on the
    // comment-body trigger: `comment-fork-pr` is only reachable with a
    // matched authorized comment, but the gate keeps that invariant honest
    // at this seam. Best-effort: a failed reply never fails the run. No ack
    // reaction on this path (no review started).
    if (pre.skip_reason === "comment-fork-pr" && acceptedViaCommentCommand(stage, event)) {
      process.stderr.write(`[v3] posting re-review fork reply on PR ${JSON.stringify(stage.PR_NUMBER ?? "")}\n`);
      await postForkPrCommentReply(stage).catch(() => undefined);
    }
    await maybeClearRereviewLabel(stage, event);
    return failOnRequestChanges(stage, pre.verdict ?? "");
  }

  // #914: an accepted comment-command re-review gets an immediate 👀 ack
  // reaction on the triggering comment, BEFORE the (slow) review stage, so
  // the commenter knows the run picked the command up. Best-effort: a
  // failed reaction degrades to a log line, never a failed run.
  if (pre.should_review === "true" && acceptedViaCommentCommand(stage, event)) {
    const commentId = event?.comment?.id;
    if (isUsableCommentId(commentId)) {
      process.stderr.write(`[v3] posting re-review ack reaction on comment ${JSON.stringify(commentId)}\n`);
      await postCommentAckReaction(stage, commentId).catch(() => undefined);
    } else {
      process.stderr.write(`[v3] re-review ack skipped: comment id ${JSON.stringify(commentId) ?? "null"}\n`);
    }
  }

  // ── Review ────────────────────────────────────────────────────────────
  stage.PLATFORM = pre.resolved_platform || stage.PLATFORM;
  stage.FORGEJO_API_URL = pre.effective_forgejo_api_url;
  stage.PR_HEAD_SHA = eventHeadSha || pre.head_sha;
  // #885: the trusted base ref the review stage reads both repository config
  // and the standards file from (never the PR head) — the same `pre.base_sha`
  // precheck already resolved and that the publish stage below sends as
  // `BASE_SHA`. Without this, the action path always ran `runReview` with an
  // empty `PR_REVIEWER_BASE_REF`, silently dropping repository config and
  // standards on every real run (only explicit-env callers like the `run`
  // CLI subcommand or tests, which set it themselves, exercised either).
  stage.PR_REVIEWER_BASE_REF = stage.PR_REVIEWER_BASE_REF || pre.base_sha || "";
  stage.IS_FORK_PR = pre.is_fork_pr;
  const temp = env.RUNNER_TEMP || env.TMPDIR || "/tmp";
  stage.CI_CHECKS_FILE = join(temp, "ci-checks-context.md");
  const runDir = createRunDir(temp);
  stage.PR_REVIEWER_RUN_DIR = runDir;
  const review = await runReview({ env: stage as NodeJS.ProcessEnv, runDir, workspace: env.GITHUB_WORKSPACE ?? process.cwd() });

  // ── Publish ───────────────────────────────────────────────────────────
  let publishFailed = false;
  if (shouldPublish(stage)) {
    const publishEnv: Env = {
      ...stage,
      HEAD_SHA: stage.PR_HEAD_SHA,
      BASE_SHA: pre.base_sha,
      BROAD_FINGERPRINT: pre.diff_fingerprint,
      VERDICT: review.outputs.verdict,
      REQUIRED_CHECKS: review.outputs.requiredChecks,
      REVIEW_ROUTE: review.outputs.reviewRoute,
      ESCALATION_REASON: review.outputs.escalationReason,
      REVIEW_MARKDOWN: review.outputs.reviewMarkdown,
      FINDINGS: review.outputs.findings,
      ANALYSIS_ENGINE: review.outputs.analysisEngine,
      CACHE_HIT_RATIO: review.outputs.cacheHitRatio,
      VERDICT_POLICY: review.verdictPolicy,
    };
    const seam = buildPublishApi(publishEnv as NodeJS.ProcessEnv);
    // The event-gated maybeClearRereviewLabel below owns label cleanup here;
    // publish's own rerunLabel strip would fire on every run, not just
    // label-triggered ones.
    const { rerunLabel: _rerunLabel, ...publishInput } = publishInputFromEnv(publishEnv as NodeJS.ProcessEnv, seam.platform);
    const input = {
      ...publishInput,
      // The #810 coverage notice and the #812 CI conclusion reach the
      // published marker and body only through these.
      ...(review.partialCoverage ? { partialCoverage: review.partialCoverage } : {}),
      ...(review.ciState !== undefined ? { ciState: review.ciState } : {}),
      // #847: the #810/#702 tool-budget provenance reaches the published
      // marker only through these, same as partialCoverage/ciState above.
      ...(review.toolBudget !== undefined ? { toolBudget: review.toolBudget } : {}),
      ...(review.toolBudgetSource !== undefined ? { toolBudgetSource: review.toolBudgetSource } : {}),
      ...(review.toolCallsUsed !== undefined ? { toolCalls: review.toolCallsUsed } : {}),
      ...(review.toolRoundsUsed !== undefined ? { toolRounds: review.toolRoundsUsed } : {}),
      ...(review.toolMaxRounds !== undefined ? { maxRounds: review.toolMaxRounds } : {}),
      ...(review.contextBudget !== undefined ? { contextBudget: review.contextBudget } : {}),
      ...(review.contextPeak !== undefined ? { contextPeak: review.contextPeak } : {}),
    };
    publishFailed = (await publishWith(input, seam)) !== 0;
  }

  // ── Re-review label ───────────────────────────────────────────────────
  await maybeClearRereviewLabel(stage, event);

  const gate = failOnRequestChanges(stage, review.outputs.verdict);
  return publishFailed ? Math.max(gate, 1) : gate;
}

function failOnRequestChanges(stage: Env, verdict: string): number {
  if ((stage.FAIL_ON_REQUEST_CHANGES ?? "false").toLowerCase() !== "true") return 0;
  if (verdict === "request_changes") {
    process.stdout.write("::error::Final verdict is request_changes; failing the step (fail-on-request-changes=true).\n");
    return 1;
  }
  process.stdout.write(`Final verdict is '${verdict || "<none>"}'; not blocking (fail-on-request-changes=true).\n`);
  return 0;
}

/** Clears the rerun label whenever this run was actually triggered by it —
 * an event `action === "labeled"` whose label name matches `REREVIEW_LABEL`
 * — regardless of whether the run went on to review or skip (#892: the
 * skip branch used to `return` before this ran at all, stranding the
 * label). Never clears on any other trigger (push, `synchronize`, an
 * unrelated label, etc). */
async function maybeClearRereviewLabel(stage: Env, event: StepEvent | undefined): Promise<void> {
  const label = eventLabelName(event?.label);
  if (event?.action === "labeled" && label !== "" && label === stage.REREVIEW_LABEL) {
    await clearRereviewLabel(stage).catch(() => undefined);
  }
}

async function clearRereviewLabel(stage: Env): Promise<void> {
  const platform = resolvePlatform(stage.PLATFORM, stage.FORGEJO_API_URL ?? "", stage.GITHUB_SERVER_URL ?? "", stage.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
  const label = stage.REREVIEW_LABEL ?? "";
  const pr = stage.PR_NUMBER ?? "";
  if (label === "" || !/^\d+$/.test(pr)) return;
  const base = platform === "forgejo"
    ? `${(stage.FORGEJO_API_URL ?? "").replace(/\/+$/, "")}/api/v1`
    : (stage.GITHUB_API_URL || "https://api.github.com");
  const url = repoScopedUrl(base, stage.REPO ?? "", `/issues/${pr}/labels`, `/${encodeURIComponent(label)}`);
  if (url === null) return;
  const token = platform === "forgejo" ? (stage.FORGEJO_TOKEN ?? "") : (stage.GH_TOKEN ?? "");
  await fetch(url, {
    method: "DELETE",
    headers: { Authorization: platform === "forgejo" ? `token ${token}` : `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
}

/** #914: "this run was accepted via the comment command" — a `created`
 * `issue_comment` whose body starts with the configured command. The command
 * match here is RECOGNITION only: precheck has already authorized the run
 * (permission check, fork gate) or skipped it, and a disabled command can
 * never reach `should_review: "true"` in the first place. */
function acceptedViaCommentCommand(stage: Env, event: StepEvent | undefined): boolean {
  return (
    event?.name === "issue_comment"
    && event.action === "created"
    && typeof event.comment?.body === "string"
    && commentBodyTriggersCommentCommand(event.comment.body, (stage.REREVIEW_COMMAND ?? "").trim())
  );
}

/** #914: a comment id that may safely appear in a URL path: a finite number
 * or an all-digit string (GitHub/Forgejo comment ids). Anything else means
 * no ack — the run is never degraded by an unusable id. */
function isUsableCommentId(id: number | string | undefined): id is number | string {
  if (typeof id === "number") return Number.isFinite(id);
  if (typeof id === "string") return /^\d+$/.test(id);
  return false;
}

/** #914: best-effort 👀 (ack) reaction on the comment that triggered an
 * accepted re-review. Same seam as `clearRereviewLabel` (resolvePlatform +
 * requireImplementedBackend, repoScopedUrl, Bearer/token Authorization,
 * 15 s timeout); the fetch failure is swallowed — the ack must never fail
 * the run. */
async function postCommentAckReaction(stage: Env, commentId: number | string): Promise<void> {
  const platform = resolvePlatform(stage.PLATFORM, stage.FORGEJO_API_URL ?? "", stage.GITHUB_SERVER_URL ?? "", stage.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
  const base = platform === "forgejo"
    ? `${(stage.FORGEJO_API_URL ?? "").replace(/\/+$/, "")}/api/v1`
    : (stage.GITHUB_API_URL || "https://api.github.com");
  const url = repoScopedUrl(base, stage.REPO ?? "", `/issues/comments/${encodeURIComponent(String(commentId))}/reactions`);
  if (url === null) return;
  const token = platform === "forgejo" ? (stage.FORGEJO_TOKEN ?? "") : (stage.GH_TOKEN ?? "");
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: platform === "forgejo" ? `token ${token}` : `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: "eyes" }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined);
}

/** #914: best-effort reply to a re-review command comment on a fork PR,
 * pointing the commenter at the `ai-review-fork` label workflow. Static
 * body — no untrusted interpolation. Same seam as the ack reaction; the
 * fetch failure is swallowed — a failed reply must never fail the run. */
async function postForkPrCommentReply(stage: Env): Promise<void> {
  const platform = resolvePlatform(stage.PLATFORM, stage.FORGEJO_API_URL ?? "", stage.GITHUB_SERVER_URL ?? "", stage.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
  const pr = stage.PR_NUMBER ?? "";
  if (!/^\d+$/.test(pr)) return;
  const base = platform === "forgejo"
    ? `${(stage.FORGEJO_API_URL ?? "").replace(/\/+$/, "")}/api/v1`
    : (stage.GITHUB_API_URL || "https://api.github.com");
  const url = repoScopedUrl(base, stage.REPO ?? "", `/issues/${pr}/comments`);
  if (url === null) return;
  const token = platform === "forgejo" ? (stage.FORGEJO_TOKEN ?? "") : (stage.GH_TOKEN ?? "");
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: platform === "forgejo" ? `token ${token}` : `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      body: "The `/ai-review` command does not run on fork PRs. To review a fork PR, a maintainer adds the `ai-review-fork` label — see docs/fork-review.md.",
    }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => undefined);
}
