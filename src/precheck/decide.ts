import type { PlatformReadAdapter } from "../platform/types.js";
import type { ExternalCheck } from "../platform/normalize.js";
import { deriveIsFork, normalizePrIdentity } from "../platform/pr.js";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import type { PlatformAdapter } from "../platform/types.js";
import {
  buildMarkerFingerprint,
  collectConfigLines,
  computeConfigHash,
  computeDiffFingerprint,
  fingerprintsMatch,
} from "./fingerprint.js";
import { parseMetadata } from "./metadata.js";
import { isIncompleteReason } from "../publish/outputs.js";
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

/** Fold normalized external checks into one verdict-relevant conclusion
 * (#812): `failure` when any check failed, `pending` when none failed but
 * some are incomplete, `success` when every check passed, `none` when no
 * external check ran. The same states `checkRunState`/`statusState` emit. */
export function externalChecksConclusion(checks: readonly ExternalCheck[]): "success" | "failure" | "pending" | "none" {
  let sawPending = false;
  let sawSuccess = false;
  for (const check of checks) {
    const state = String(check.state ?? "").toLowerCase();
    if (state === "failure") return "failure";
    if (state === "pending") sawPending = true;
    if (state === "success") sawSuccess = true;
  }
  if (sawPending) return "pending";
  if (sawSuccess) return "success";
  return checks.length === 0 ? "none" : "pending";
}

/** Map a decision to the action's (should_review, skip_reason). */
export function decisionToOutputs(decision: ReviewDecision): { shouldReview: boolean; skipReason: string } {
  if (decision === "skip_already_reviewed") return { shouldReview: false, skipReason: "diff-unchanged" };
  if (decision === "skip_no_changes") return { shouldReview: false, skipReason: "no-changes" };
  return { shouldReview: true, skipReason: "" };
}

/** A `labeled` event's label as GitHub/Forgejo actually send it: an object
 * with a `name` field. A bare string is also accepted (normalized producers
 * such as `readEvent` already resolve to this), but the type itself must
 * not hide the object shape the way a plain `string` field did (#892). */
export type PrecheckEventLabel = string | { name?: string | null } | null | undefined;

/** The `issue_comment` payload's `comment` object, normalized to the flat
 * shape the #914 re-review command consumes. Each sub-field is nullable
 * because a malformed / hostile comment must degrade to fewer fields, never
 * a throw (mirrors `StepEventComment` in `src/run/entrypoints.ts`). */
export interface PrecheckEventComment {
  id?: number | string | null;
  body?: string | null;
  user?: string | null;
}

export interface PrecheckEvent {
  name?: string;
  action?: string;
  label?: PrecheckEventLabel;
  comment?: PrecheckEventComment | null;
}

/** The label a `labeled` event carries, normalized to its name string
 * (GitHub/Forgejo send `{ name, color, ... }`, never a bare string). */
export function eventLabelName(label: PrecheckEventLabel | unknown): string {
  if (typeof label === "string") return label;
  if (label !== null && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
    return (label as { name: string }).name;
  }
  return "";
}

/** #914 v1 scope: a comment body triggers the re-review command iff, after
 * leading whitespace is stripped, the remaining text is the command followed
 * by NOTHING but whitespace. `/ai-review` and `/ai-review\n` match;
 * `/ai-review now`, `/ai-reviewx`, `please /ai-review`, and `/AI-Review` do
 * not. Trailing whitespace (including a trailing newline) is tolerated —
 * documented policy; any trailing non-whitespace text never triggers,
 * because the argument namespace is intentionally reserved for a future
 * release and is not parsed in v1. The comparison is a literal prefix
 * (never a regex), so a command containing regex-special characters is
 * matched verbatim. An empty command never matches (it would match
 * everything). */
export function commentBodyTriggersCommentCommand(body: string, command: string): boolean {
  if (command === "") return false;
  const trimmed = body.replace(/^\s+/, "");
  if (!trimmed.startsWith(command)) return false;
  const rest = trimmed.slice(command.length);
  return rest.trimEnd() === "";
}

/** #914: the repository permission levels that authorize a comment-command
 * re-review — the `permission` field of the collaborator-permission API at
 * triage-or-higher: `write`/`maintain`/`admin` on GitHub, `write`/`admin`/
 * `owner` on Forgejo. A GitHub `triage` user arrives as `permission:
 * "read"` (the API collapses maintain→write and triage→read in the legacy
 * `permission` field), so the un-collapsed `role_name` is the second signal;
 * anything else (`read`, `none`, or an unrecognized value) fails closed. */
const COMMENT_COMMAND_AUTHORIZED_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
  "owner",
]);

/** #914: `role_name` values that prove triage-or-higher when the collapsed
 * legacy `permission` says `read`. Custom roles are deliberately NOT
 * authorized here — an unrecognizable role cannot prove the bar. */
const COMMENT_COMMAND_AUTHORIZED_ROLE_NAMES: ReadonlySet<string> = new Set([
  "triage",
  "triage_plus",
]);


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
  /** #873: the carried marker's `review_result` state, for the additive
   * `review-result` action output. Undefined when nothing was carried. */
  review_result?: string;
  /** #954: the carried marker's `incomplete_reason`, for the additive
   * `incomplete-reason` action output. Undefined when nothing was carried. */
  incomplete_reason?: string;
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
 * unparseable marker → verdict stays empty. #811's strict-policy marker
 * values (`findings` / `partial`) are non-blocking states and carry an
 * approve, exactly like `clean`. */
export function carriedVerdict(lastCommentBody: string): { verdict: string; verdictSource: string; reviewResult: string; incompleteReason?: string } | null {
  const data = parseMetadata(lastCommentBody);
  if (!data) return null;
  const result = String(data.review_result ?? "").toLowerCase();
  // #954: the marker is untrusted comment content — only a known enum value is
  // ever carried into the `incomplete-reason` output; anything else is dropped.
  const incompleteRaw = String(data.incomplete_reason ?? "");
  const incomplete = isIncompleteReason(incompleteRaw) && incompleteRaw !== "none" ? incompleteRaw : "";
  if (result === "issues") return {
    verdict: "request_changes",
    verdictSource: "carry_forward",
    reviewResult: result,
    ...(incomplete !== "" ? { incompleteReason: incomplete } : {}),
  };
  if (result === "clean" || result === "findings" || result === "partial") {
    // #873: the carried `review-result` output stays honest across a
    // diff-unchanged skip too — a previously-partial review must not
    // silently read as `clean` just because nothing changed.
    return {
      verdict: "approve",
      verdictSource: "carry_forward",
      reviewResult: result,
      ...(incomplete !== "" ? { incompleteReason: incomplete } : {}),
    };
  }
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

  const resolvedPlatform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "", env.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(resolvedPlatform);
  const effectiveForgejoApiUrl = resolvedPlatform === "forgejo" ? env.FORGEJO_API_URL ?? "" : "";

  // ── Label-driven re-review (#231) ─────────────────────────────────────
  const rereviewLabel = env.REREVIEW_LABEL || "ai-review";
  let forceReview = envFlag(env, "FORCE_REVIEW", false);
  const event = spec.event;
  if (event && event.name === "pull_request" && event.action === "labeled") {
    if (eventLabelName(event.label) === rereviewLabel) {
      forceReview = true;
    } else {
      return platformOutputs(
        { should_review: "false", skip_reason: "unrelated-label" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
  }

  // ── Comment-command re-review (#914) ──────────────────────────────────
  // The PR object fetched for the fork gate, threaded to the review path
  // below so an accepted comment does not re-fetch it.
  let commentPrObject: unknown | undefined;
  // A `created` `issue_comment` on a PR carrying the re-review command
  // forces a fresh review. The commenter is authorized through the forge
  // API (triage-or-higher), failing closed on any lookup uncertainty — a
  // comment is NOT self-authorizing the way a label is. Fork PRs are left
  // to the fork workflow (action.ts owns the reply); we stay side-effect-free.
  if (event && event.name === "issue_comment" && event.action === "created") {
    const command = (env.REREVIEW_COMMAND ?? "").trim();
    if (command === "") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-disabled" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    const commentBody = event.comment?.body;
    if (typeof commentBody !== "string" || !commentBodyTriggersCommentCommand(commentBody, command)) {
      return platformOutputs(
        { should_review: "false", skip_reason: "unrelated-comment" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    const commenter = event.comment?.user;
    if (typeof commenter !== "string" || commenter === "") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-permission-unknown" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    // Fail closed: the commenter's permission is verified through the forge
    // API. A lookup error, a missing / non-string permission, or an
    // unrecognized value is never self-authorizing. The action's token must
    // therefore carry repository-collaborators read (GitHub App installation
    // token or GITHUB_TOKEN with `members`/repo read); without it every
    // lookup 403/404s and the command skips fail-closed, never approves.
    const permissionResult = await spec.adapter.ghApi(
      `repos/${repo}/collaborators/${encodeURIComponent(commenter)}/permission`,
    );
    if (permissionResult.error) {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-permission-unknown" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    const permissionData = permissionResult.data;
    const permissionRecord =
      permissionData !== null && typeof permissionData === "object" && !Array.isArray(permissionData)
        ? (permissionData as Record<string, unknown>)
        : undefined;
    const rawPermission = permissionRecord?.permission;
    if (typeof rawPermission !== "string") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-permission-unknown" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    const permission = rawPermission.toLowerCase();
    // Defense in depth for installation-token semantics: if the response
    // names its subject, the subject must be the commenter — a response
    // describing someone else (e.g. an echo of the caller's own permission)
    // can never authorize. A subject-less response (allowed by the schema)
    // passes through: nothing provable is wrong with it.
    const subject = permissionRecord?.user;
    if (subject !== null && subject !== undefined && typeof subject === "object" && !Array.isArray(subject)) {
      const subjectLogin = (subject as Record<string, unknown>).login;
      if (typeof subjectLogin === "string" && subjectLogin.toLowerCase() !== commenter.toLowerCase()) {
        return platformOutputs(
          { should_review: "false", skip_reason: "comment-permission-unknown" },
          resolvedPlatform,
          effectiveForgejoApiUrl,
        );
      }
    }
    const rawRoleName = permissionRecord?.role_name;
    const roleName = typeof rawRoleName === "string" ? rawRoleName.toLowerCase() : "";
    if (COMMENT_COMMAND_AUTHORIZED_PERMISSIONS.has(permission)) {
      // write-or-higher on either forge (and uncollapsed triage/maintain
      // values where a server still returns them).
    } else if (permission === "read" && COMMENT_COMMAND_AUTHORIZED_ROLE_NAMES.has(roleName)) {
      // GitHub's collapsed shape for a triage user: permission "read",
      // role_name "triage". Only the role name can prove the bar.
    } else if (permission === "read" || permission === "none") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-unauthorized" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    } else {
      // Unrecognized permission value → fail closed.
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-permission-unknown" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    // Fork gate: a null PR (lookup failed) fails closed; a fork PR is
    // deferred to the fork workflow's reply.
    const prObject = await spec.adapter.getPr();
    commentPrObject = prObject ?? undefined;
    if (prObject === null) {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-pr-lookup-failed" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    if (deriveIsFork(prObject)) {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-fork-pr" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    // A closed PR is not reviewable: publishing a fresh verdict onto it is
    // meaningless (and the command is spam-able). A payload without a state
    // field is treated as open — the pulls API always supplies one.
    const prState = typeof (prObject as { state?: unknown }).state === "string"
      ? String((prObject as { state: string }).state).toLowerCase()
      : "open";
    if (prState === "closed") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-pr-closed" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    forceReview = true;
    process.stderr.write(
      `[precheck] ${command} comment command accepted from ${JSON.stringify(commenter)}: forcing a fresh review\n`,
    );
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
    if (skipReason === "diff-unchanged") {
      const carried = carriedVerdict(lastCommentBody);
      // ── #812: the stale carried verdict ──────────────────────────────
      // A carried request_changes binds to the external-CI conclusion the
      // review saw (required-check coverage is not recomputed here). When
      // the forge exposes the
      // external-checks read seam, re-read it on the skip: a changed or
      // unknown conclusion forces a fresh review (fail closed), so CI
      // turning green — or a transient API failure — can never leave a
      // stale CHANGES_REQUESTED stuck until the next push. Adapters
      // without the seam (the parity fixture surface, the base
      // PlatformAdapter) keep the exact v2 skip behavior; a carried
      // approve is never re-checked (the CI check itself gates merges).
      if (carried?.verdict === "request_changes") {
        const readAdapter = spec.adapter as Partial<PlatformReadAdapter>;
        if (typeof readAdapter.externalChecks === "function") {
          const marker = parseMetadata(lastCommentBody);
          const storedCiState = typeof marker?.ci_state === "string" ? marker.ci_state : "";
          const headSha = typeof marker?.head_sha === "string" ? marker.head_sha : "";
          // Fail closed: a marker without a usable head binding (or without
          // a stored state) cannot PROVE the verdict-relevant inputs
          // unchanged — "none" is a real recorded conclusion too, and
          // none→success/failure/pending is exactly the transition that
          // must re-open the review.
          if (headSha === "" || storedCiState === "") {
            process.stderr.write(
              "warning: carried request_changes marker lacks " + (headSha === "" ? "head_sha" : "ci_state") + "; forcing a fresh review (fail closed)\n",
            );
            return await reviewPathOutputs(spec, env, resolvedPlatform, effectiveForgejoApiUrl, broadFingerprint, "ci-stale-carried-verdict");
          }
          const checks = await readAdapter.externalChecks(headSha).catch(() => null);
          const live = checks === null ? null : externalChecksConclusion(checks);
          // Transient/unknown read or a changed conclusion: the
          // verdict-relevant input cannot be proven unchanged — review
          // afresh.
          if (live === null || live !== storedCiState) {
            process.stderr.write(
              "warning: carried request_changes is CI-stale (stored: " + storedCiState + ", live: " + (live ?? "unknown") + "); forcing a fresh review\n",
            );
            return await reviewPathOutputs(spec, env, resolvedPlatform, effectiveForgejoApiUrl, broadFingerprint, "ci-stale-carried-verdict");
          }
        }
      }
      const output = platformOutputs(
        { should_review: "false", skip_reason: skipReason, diff_fingerprint: broadFingerprint },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
      if (carried) {
        output.verdict = carried.verdict;
        output.verdict_source = carried.verdictSource;
        output.review_result = carried.reviewResult;
        if (carried.incompleteReason !== undefined) output.incomplete_reason = carried.incompleteReason;
      }
      return output;
    }
    return platformOutputs(
      { should_review: "false", skip_reason: skipReason, diff_fingerprint: broadFingerprint },
      resolvedPlatform,
      effectiveForgejoApiUrl,
    );
  }

  // ── Review path (shared by the fall-through and the #812 stale-skip
  // re-entry): PR object once → SHAs/fork → superseded guard → Forgejo
  // preflight → proceed. `skip_reason` is non-empty only for the re-entry,
  // where it documents WHY the skip was refused (still should_review=true).
  // The authorized comment branch already fetched the PR for its fork gate;
  // reuse it rather than re-fetching (the PR object is identical by then).
  return await reviewPathOutputs(spec, env, resolvedPlatform, effectiveForgejoApiUrl, broadFingerprint, "", commentPrObject);
}

async function reviewPathOutputs(
  spec: PrecheckSpec,
  env: Record<string, string>,
  resolvedPlatform: string,
  effectiveForgejoApiUrl: string,
  broadFingerprint: string,
  staleReason: string,
  preFetchedPr?: unknown,
): Promise<PrecheckOutput> {
  const repo = env.REPO ?? "";
  const prObject = preFetchedPr ?? await spec.adapter.getPr();
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
      skip_reason: staleReason,
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
