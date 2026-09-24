import { deriveIsFork, normalizePrIdentity } from "../platform/pr.js";
import { resolvePlatform } from "../platform/resolve.js";
import type { PlatformAdapter } from "../platform/types.js";
import {
  buildMarkerFingerprint,
  collectConfigLines,
  computeConfigHash,
  computeDiffFingerprint,
  fingerprintsMatch,
} from "./fingerprint.js";
import { parseMetadata } from "./metadata.js";
import { buildSelectionSignature } from "./selection.js";

/** The action's precheck decision path (#674) — TS port of the decision
 * layers of `scripts/check_review_needed.sh` + `pr_reviewer/precheck.py`.
 *
 * Flow (mirrors the v2 shell, step for step):
 *   1. platform resolution (once)
 *   2. label-driven re-review / unrelated-label no-op
 *   3. diff fetch (an unfetchable diff is treated as empty, never fatal)
 *   4. last managed review body → stored fingerprint marker
 *   5. deep_review=auto: selection signature, conservatively failed
 *   6. the should-review decision (a skip exits without a PR fetch)
 *   7. review path: PR object once → SHAs/fork → superseded guard →
 *      Forgejo permission preflight → proceed */

export type ReviewDecision = "review_needed" | "skip_no_changes" | "skip_already_reviewed";

export interface PrecheckResult {
  decision: ReviewDecision;
  diff_fingerprint: string;
  config_hash: string;
  broad_fingerprint: string;
  reason: string;
}

/** Read a boolean env flag the way the shell compared it (`== true`):
 * only a case-insensitive "true" counts, so a mistyped value degrades to
 * the safe side of each flag. */
export function envFlag(env: Record<string, string>, name: string, defaultValue: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return defaultValue;
  return raw.trim().toLowerCase() === "true";
}

/** The action's should-review decision over a diff (port of
 * `evaluate_precheck`). The only skip is a marker fingerprint match; an
 * empty diff is NOT a skip — it fingerprints as `empty-diff` so the marker
 * round-trip can skip subsequent runs. In v3 every non-skipped review is a
 * full review of the current PR. */
export function evaluatePrecheck(
  diffContent: string,
  previousFingerprints: readonly string[],
  options: { configHash?: string; forceReview?: boolean; skipIfDiffUnchanged?: boolean } = {},
): PrecheckResult {
  const configHash = options.configHash ?? "";
  const forceReview = options.forceReview ?? false;
  const skipIfDiffUnchanged = options.skipIfDiffUnchanged ?? true;
  const diffFp = computeDiffFingerprint(diffContent);
  const markerFp = diffFp || "empty-diff";
  const broad = buildMarkerFingerprint(markerFp, configHash);
  if (!forceReview && skipIfDiffUnchanged && fingerprintsMatch(broad, previousFingerprints)) {
    return {
      decision: "skip_already_reviewed",
      diff_fingerprint: markerFp,
      config_hash: configHash,
      broad_fingerprint: broad,
      reason: "Diff unchanged since last review",
    };
  }
  return {
    decision: "review_needed",
    diff_fingerprint: markerFp,
    config_hash: configHash,
    broad_fingerprint: broad,
    reason: "New or forced changes detected",
  };
}

/** Map a decision to the action's (should_review, skip_reason). */
export function decisionToOutputs(decision: ReviewDecision): { shouldReview: boolean; skipReason: string } {
  if (decision === "skip_already_reviewed") return { shouldReview: false, skipReason: "diff-unchanged" };
  if (decision === "skip_no_changes") return { shouldReview: false, skipReason: "no-changes" };
  return { shouldReview: true, skipReason: "" };
}

export interface PrecheckEvent {
  name?: string;
  action?: string;
  label?: string;
}

export interface PrecheckSpec {
  env: Record<string, string>;
  adapter: PlatformAdapter;
  event?: PrecheckEvent | undefined;
  /** The event's head SHA (EVENT_HEAD_SHA), for the superseded-run guard. */
  eventHeadSha?: string | undefined;
  /** Injected Linear collector for the selection signature (parity
   * fixtures and tests; production uses the real GraphQL adapter). */
  linearCollect?: typeof import("./linear.js").collectFromPr | undefined;
}

export interface PrecheckOutput {
  should_review: string;
  skip_reason: string;
  diff_fingerprint: string;
  head_sha: string;
  base_sha: string;
  is_fork_pr: string;
  resolved_platform: string;
  effective_forgejo_api_url: string;
  verdict?: string;
  verdict_source?: string;
}

/** Extract the broad fingerprint from the last published comment body —
 * only the FIRST `<!-- ai-pr-review-fingerprint:... -->` marker line
 * counts (the sha marker is retained for publication traceability and is
 * never read back). */
export function extractStoredFingerprint(body: string): string {
  for (const line of body.split("\n")) {
    const match = /^<!-- ai-pr-review-fingerprint:([^>]*) -->$/.exec(line);
    if (match) return match[1] ?? "";
  }
  return "";
}

/** Latest managed comment/review body selection by publish mode: the
 * review_verdict mode reads PR reviews, everything else reads issue
 * comments. Selection is latest-by-timestamp among bodies containing the
 * marker, mirroring the v2 jq. */
export function lastManagedBody(
  comments: { body: string; updated_at?: string | undefined; created_at?: string | undefined }[],
  reviews: { body: string; submitted_at?: string | undefined }[],
  publishMode: string,
  commentMarker: string,
): string {
  const marker = commentMarker || "<!-- ai-pr-reviewer -->";
  const mode = (publishMode ?? "").toLowerCase();
  if (mode === "review_verdict") {
    const matching = reviews.filter((review) => (review.body ?? "").includes(marker));
    matching.sort((a, b) => (a.submitted_at ?? "") < (b.submitted_at ?? "") ? -1 : (a.submitted_at ?? "") > (b.submitted_at ?? "") ? 1 : 0);
    return matching.length ? matching[matching.length - 1]!.body : "";
  }
  const matching = comments.filter((comment) => (comment.body ?? "").includes(marker));
  matching.sort((a, b) => {
    const aKey = a.updated_at ?? a.created_at ?? "";
    const bKey = b.updated_at ?? b.created_at ?? "";
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return matching.length ? matching[matching.length - 1]!.body : "";
}

/** Carry the previous review's verdict forward on a diff-unchanged skip so
 * a downstream gate cannot flip red→green on re-run: parsed from the last
 * managed comment's metadata marker (no new API call). No marker or an
 * unparseable marker → verdict stays empty. */
export function carriedVerdict(lastCommentBody: string): { verdict: string; verdictSource: string } | null {
  const data = parseMetadata(lastCommentBody);
  if (!data) return null;
  const result = String(data.review_result ?? "").toLowerCase();
  if (result === "issues") return { verdict: "request_changes", verdictSource: "carry_forward" };
  if (result === "clean") return { verdict: "approve", verdictSource: "carry_forward" };
  return null;
}

function platformOutputs(base: Partial<PrecheckOutput>, resolvedPlatform: string, forgejoUrl: string): PrecheckOutput {
  return {
    should_review: "",
    skip_reason: "",
    diff_fingerprint: "",
    head_sha: "",
    base_sha: "",
    is_fork_pr: "",
    resolved_platform: resolvedPlatform,
    effective_forgejo_api_url: forgejoUrl,
    ...base,
  } as PrecheckOutput;
}

/** Run the full precheck decision path. Returns the GITHUB_OUTPUT key/value
 * surface, or throws where the v2 shell exits nonzero (missing inputs,
 * unsupported platform, Forgejo permission refusal). */
export async function runPrecheck(spec: PrecheckSpec): Promise<PrecheckOutput> {
  const env = spec.env;
  const repo = env.REPO ?? "";
  const prNumber = env.PR_NUMBER ?? "";
  if (!repo || !prNumber) {
    throw new Error("Missing REPO or PR_NUMBER for review precheck");
  }

  const resolvedPlatform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "");
  const effectiveForgejoApiUrl = resolvedPlatform === "forgejo" ? env.FORGEJO_API_URL ?? "" : "";

  // ── Label-driven re-review (#231) ─────────────────────────────────────
  const rereviewLabel = env.REREVIEW_LABEL || "ai-review";
  let forceReview = envFlag(env, "FORCE_REVIEW", false);
  const event = spec.event;
  if (event && event.name === "pull_request" && event.action === "labeled") {
    if (event.label === rereviewLabel) {
      forceReview = true;
    } else {
      return platformOutputs(
        { should_review: "false", skip_reason: "unrelated-label" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
  }

  // ── Diff content ──────────────────────────────────────────────────────
  const diffContent = await spec.adapter.getPrDiff();

  // ── Last managed review body lookup ───────────────────────────────────
  const publishMode = env.PUBLISH_MODE || "comment";
  const commentMarker = env.COMMENT_MARKER || "<!-- ai-pr-reviewer -->";
  const [comments, reviews] = await Promise.all([
    spec.adapter.listIssueComments(),
    spec.adapter.listPrReviews(),
  ]);
  const lastCommentBody = lastManagedBody(comments, reviews, publishMode, commentMarker);
  const storedFingerprint = extractStoredFingerprint(lastCommentBody);
  const previousFingerprints = storedFingerprint ? [storedFingerprint] : [];

  // ── #633 auto-selection inputs ────────────────────────────────────────
  const deepReview = (env.DEEP_REVIEW ?? "false").toLowerCase();
  const configEnv: Record<string, string> = { ...env };
  if (deepReview === "auto") {
    const { signature, error } = await buildSelectionSignature(repo, prNumber, spec.adapter, {
      linearIssuePrefixes: env.LINEAR_ISSUE_PREFIXES,
      linearApiKey: env.LINEAR_API_KEY,
      linearEnableForForks: env.LINEAR_ENABLE_FOR_FORKS,
      linearTimeoutSec: toInt(env.LINEAR_ISSUE_TIMEOUT_SEC, 20),
      ...(spec.linearCollect ? { linearCollect: spec.linearCollect } : {}),
    });
    if (signature) {
      configEnv.PRECHECK_SELECTION_SIGNATURE = signature;
    } else {
      // Conservative failure: a per-run unique sentinel that can never
      // match a stored marker forces a fresh review.
      configEnv.PRECHECK_SELECTION_SIGNATURE =
        `unavailable-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 32768)}`;
      process.stderr.write(
        "warning: deep_review=auto could not determine every selection input; forcing a fresh review (stale-skip disabled for this run)\n",
      );
    }
    if (error) {
      process.stderr.write(`build_selection_fingerprint: ${error}\n`);
    }
  }

  // ── The should-review decision ────────────────────────────────────────
  const configLines = collectConfigLines(configEnv);
  const configHash = computeConfigHash(configLines);
  const skipIfDiffUnchanged = envFlag(env, "SKIP_IF_DIFF_UNCHANGED", true);
  const result = evaluatePrecheck(diffContent, previousFingerprints, {
    configHash,
    forceReview,
    skipIfDiffUnchanged,
  });
  const { shouldReview, skipReason } = decisionToOutputs(result.decision);
  const broadFingerprint = result.broad_fingerprint;

  if (!shouldReview) {
    const output = platformOutputs(
      { should_review: "false", skip_reason: skipReason, diff_fingerprint: broadFingerprint },
      resolvedPlatform,
      effectiveForgejoApiUrl,
    );
    if (skipReason === "diff-unchanged") {
      const carried = carriedVerdict(lastCommentBody);
      if (carried) {
        output.verdict = carried.verdict;
        output.verdict_source = carried.verdictSource;
      }
    }
    return output;
  }

  // ── Review path: PR object once → SHAs/fork → superseded guard ────────
  const prObject = await spec.adapter.getPr();
  const identity = normalizePrIdentity(prObject ?? {});

  if (spec.eventHeadSha && identity.headSha && spec.eventHeadSha !== identity.headSha) {
    return platformOutputs(
      {
        should_review: "false",
        skip_reason: "superseded-head",
        diff_fingerprint: broadFingerprint,
        head_sha: identity.headSha,
        base_sha: identity.baseSha,
        is_fork_pr: String(deriveIsFork(prObject ?? {})),
      },
      resolvedPlatform,
      effectiveForgejoApiUrl,
    );
  }

  // ── Forgejo permission preflight (#453, #539) ─────────────────────────
  if (resolvedPlatform === "forgejo") {
    const permission = await spec.adapter.repoPermission().catch(() => null);
    if (permission === "write" || permission === "admin") {
      // token can publish, proceed
    } else if (permission === "unknown") {
      if (envFlag(env, "FORGEJO_SKIP_PERMISSION_PREFLIGHT", false)) {
        // explicit operator opt-in
      } else {
        throw new Error(
          `ERROR: Could not determine Forgejo permission for ${repo} (server returned 200 but no recognizable permissions field). To proceed anyway, set the 'forgejo_skip_permission_preflight' action input (or the FORGEJO_SKIP_PERMISSION_PREFLIGHT=true env var) to true after verifying the token can publish reviews. Otherwise the model output would be lost.`,
        );
      }
    } else {
      throw new Error(
        `ERROR: Review token lacks Forgejo write permission for ${repo} (got '${permission ?? "none"}'); refusing to invoke a model whose review could not be published.`,
      );
    }
  }

  return platformOutputs(
    {
      should_review: "true",
      skip_reason: "",
      diff_fingerprint: broadFingerprint,
      head_sha: identity.headSha,
      base_sha: identity.baseSha,
      is_fork_pr: String(deriveIsFork(prObject ?? {})),
    },
    resolvedPlatform,
    effectiveForgejoApiUrl,
  );
}

function toInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}
