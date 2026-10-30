import type { PlatformReadAdapter } from "../platform/types.js";
import type { ExternalCheck } from "../platform/normalize.js";
import { ownerMatchesIdentity, type IdentityResolution, type TrustedOwnerIdentity } from "../platform/owner-identity.js";
import { deriveDraftState, deriveIsFork, derivePrState, normalizePrIdentity } from "../platform/pr.js";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import type { ManagedComment, ManagedReview, PlatformAdapter } from "../platform/types.js";
import {
  buildMarkerFingerprint,
  collectConfigLines,
  computeConfigHash,
  computeDiffFingerprint,
  fingerprintsMatch,
} from "./fingerprint.js";
import { parseMetadata } from "./metadata.js";
import { decideAuthorityFromPayload } from "./comment-authority.js";
import { isIncompleteReason } from "../publish/outputs.js";
import { isNativeVerdictMode } from "../publish/publish.js";
import { buildSelectionSignature } from "./selection.js";
import { discoverRepositorySkills } from "../context/repository-skills.js";

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

export interface PrecheckSpec {
  env: Record<string, string>;
  adapter: PlatformAdapter;
  event?: PrecheckEvent | undefined;
  /** The event's head SHA (EVENT_HEAD_SHA), for the superseded-run guard. */
  eventHeadSha?: string | undefined;
  /** Injected Linear collector for the selection signature (tests;
   * production uses the real GraphQL adapter). */
  linearCollect?: typeof import("./linear.js").collectFromPr | undefined;
  /** Explicit sink for precheck's legacy stderr diagnostics. Omitted, the
   * lines go to process.stderr exactly as before (the standalone precheck
   * entrypoint); the engine's admission stage injects its error sink so a
   * host-owned output boundary is never bypassed via process streams. */
  diagnostics?: ((line: string) => void) | undefined;
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
  /** #978: carried gate-bypass eligibility, consumed in-process by the gate. */
  degradedGateBypass?: boolean;
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

/** #970: is a forge-reported author login the run's own authenticated
 * identity? Logins are compared case-insensitively, which is safe on both
 * forges: GitHub and Forgejo enforce case-insensitive username uniqueness,
 * so no second account can differ from the trusted identity only by case.
 * An empty/missing author, or an unproven (null/blank) identity, never
 * matches — uncertain ownership fails closed. */
export function authorMatchesTrustedIdentity(author: string | undefined, trustedIdentity: string | null): boolean {
  return authorMatchesTrustedOwner(author, undefined, trustedIdentity === null ? null : { kind: "login", login: trustedIdentity });
}

/** #1093: is a forge-reported author (login and/or user id) the run's own
 * trusted owner identity? The shared `ownerMatchesIdentity` policy decides:
 * login-kind identities match the trimmed, case-insensitive login; user-id
 * identities (Forgejo Authorized Integration) match ONLY the canonical
 * positive-integer id — the id is authoritative and the login is never
 * compared across kinds. An unproven identity or an unusable author never
 * matches (fail closed). */
export function authorMatchesTrustedOwner(
  author: string | undefined,
  authorId: number | string | undefined,
  trusted: TrustedOwnerIdentity | null,
): boolean {
  return ownerMatchesIdentity({ login: author, id: authorId }, trusted);
}

/** Latest managed comment/review body selection by publish mode: the
 * native-verdict modes read PR reviews, everything else reads issue
 * comments. Selection is latest-by-timestamp among bodies that BOTH carry
 * the marker AND were authored by the run's trusted owner identity
 * (#970/#1093): a contributor can forge the marker, fingerprint, and
 * metadata — all body content — but cannot forge the author the forge
 * reports. */
export function lastManagedBody(
  comments: readonly ManagedComment[],
  reviews: readonly ManagedReview[],
  publishMode: string,
  commentMarker: string,
  trusted: TrustedOwnerIdentity | null,
): string {
  const marker = commentMarker || "<!-- ai-pr-reviewer -->";
  const mode = (publishMode ?? "").toLowerCase();
  if (isNativeVerdictMode(mode)) {
    const matching = reviews.filter((review) => (review.body ?? "").includes(marker) && authorMatchesTrustedOwner(review.author, review.authorId, trusted));
    matching.sort((a, b) => (a.submitted_at ?? "") < (b.submitted_at ?? "") ? -1 : (a.submitted_at ?? "") > (b.submitted_at ?? "") ? 1 : 0);
    return matching.length ? matching[matching.length - 1]!.body : "";
  }
  const matching = comments.filter((comment) => (comment.body ?? "").includes(marker) && authorMatchesTrustedOwner(comment.author, comment.authorId, trusted));
  matching.sort((a, b) => {
    const aKey = a.updated_at ?? a.created_at ?? "";
    const bKey = b.updated_at ?? b.created_at ?? "";
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return matching.length ? matching[matching.length - 1]!.body : "";
}

/** #970/#1093: select the last managed body whose author is the run's own
 * trusted owner identity. Only such a body may supply the stored skip
 * fingerprint or a carried verdict. When a marker-bearing body exists but
 * the identity cannot be proven (a failed identity read, a token that posts
 * as nobody, an unusable payload, or — in Forgejo Authorized Integration
 * mode — an audience without a parseable owner id), or when no body was
 * authored by it, the result is empty — the run then re-reviews rather than
 * trusting an unauthenticated marker. The identity is only resolved when a
 * candidate exists, so a fresh PR costs no extra API call. */
async function selectAuthenticatedManagedBody(
  adapter: PlatformAdapter,
  comments: readonly ManagedComment[],
  reviews: readonly ManagedReview[],
  publishMode: string,
  commentMarker: string,
  diagnostics: (line: string) => void,
): Promise<string> {
  const marker = commentMarker || "<!-- ai-pr-reviewer -->";
  const mode = (publishMode ?? "").toLowerCase();
  const candidates: readonly { body?: string | undefined }[] = isNativeVerdictMode(mode) ? reviews : comments;
  if (!candidates.some((entry) => (entry.body ?? "").includes(marker))) return "";
  let resolution: IdentityResolution;
  if (typeof adapter.resolveTrustedOwner === "function") {
    try {
      resolution = await adapter.resolveTrustedOwner();
    } catch {
      resolution = { identity: null, reason: "unavailable" };
    }
  } else {
    let identity: string | null = null;
    try {
      identity = await adapter.authenticatedIdentity();
    } catch {
      identity = null;
    }
    resolution = identity === null || identity.trim() === ""
      ? { identity: null, reason: "unavailable" }
      : { identity: { kind: "login", login: identity }, reason: "user-login" };
  }
  if (resolution.identity === null || (resolution.identity.kind === "login" && resolution.identity.login.trim() === "")) {
    diagnostics(
      `warning: could not authenticate the action's own forge identity on ${adapter.platform} (reason: ${resolution.reason}); refusing to skip or carry a verdict from an unauthenticated managed body (fail closed)\n`,
    );
    return "";
  }
  return lastManagedBody(comments, reviews, publishMode, commentMarker, resolution.identity);
}

/** Carry the previous review's verdict forward on a diff-unchanged skip so
 * a downstream gate cannot flip red→green on re-run: parsed from the last
 * managed comment's metadata marker (no new API call). No marker or an
 * unparseable marker → verdict stays empty. #811's strict-policy marker
 * values (`findings` / `partial`) are non-blocking states and carry an
 * approve, exactly like `clean`. */
export function carriedVerdict(lastCommentBody: string): { verdict: string; verdictSource: string; reviewResult: string; degradedGateBypass: boolean; incompleteReason?: string } | null {
  const data = parseMetadata(lastCommentBody);
  if (!data) return null;
  const result = String(data.review_result ?? "").toLowerCase();
  const degradedGateBypass = data.degraded_gate_bypass === true;
  // #954: the marker is untrusted comment content — only a known enum value is
  // ever carried into the `incomplete-reason` output; anything else is dropped.
  const incompleteRaw = String(data.incomplete_reason ?? "");
  const incomplete = isIncompleteReason(incompleteRaw) && incompleteRaw !== "none" ? incompleteRaw : "";
  if (result === "issues") return {
    verdict: "request_changes",
    verdictSource: "carry_forward",
    reviewResult: result,
    degradedGateBypass,
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
      degradedGateBypass,
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
  const diagnostics = spec.diagnostics ?? ((line: string): void => { process.stderr.write(line); });
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
  // True only on the accepted comment-command fall-through: the review path
  // then keeps the legacy `comment-pr-closed` state read (#1301 review)
  // instead of the shared path's fail-closed one.
  let commentCommandPath = false;
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
    // Parse the collaborator-permission payload and apply the shared
    // triage-or-higher authority rule (#914) through the ONE predicate the
    // conversational follow-up planner (#763) also uses, so the two
    // comment-driven review paths can never drift. A missing/non-string
    // permission, a subject naming someone other than the commenter (e.g. an
    // echo of the caller's own permission), an unusable subject, or an
    // unrecognized permission value all read as `unknown` and fail closed;
    // only a proven read/none reads as `unauthorized`.
    const authority = decideAuthorityFromPayload(permissionResult.data, commenter);
    if (authority === "unauthorized") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-unauthorized" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    if (authority !== "authorized") {
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
    // field is treated as open — the pulls API always supplies one. The
    // #1301 shared-path gate reads the same value through `derivePrState`
    // but fails closed on an unprovable state, unlike this legacy read.
    if (derivePrState(prObject) === "closed") {
      return platformOutputs(
        { should_review: "false", skip_reason: "comment-pr-closed" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    // #961/#1312: a draft PR is never reviewed — the command cannot pull a
    // draft into review any more than it could a closed one. Only an explicit
    // boolean draft value is authoritative. A readable PR whose draft bit is
    // unproven gets its own capability-degradation reason; a failed lookup
    // never reaches this check (comment-pr-lookup-failed above).
    const commentDraftState = deriveDraftState(prObject);
    if (commentDraftState !== "not-draft") {
      return platformOutputs(
        {
          should_review: "false",
          skip_reason: commentDraftState === "draft" ? "comment-pr-draft" : "comment-pr-draft-unknown",
        },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    // #914 review: the workflow's pr-gate pinned the head sha it checked out
    // and built. If the PR head moved since, this run's built code and the
    // head the diff is fetched for disagree — skip fail-closed. The raced
    // push fires its own synchronize review, so nothing is lost; an unset or
    // blank pin (runners without the gate) leaves behavior unchanged. The
    // guard outranks an explicit `force-review`/accepted command on purpose:
    // a forced review of a head this build did not check out is exactly what
    // the pin exists to prevent, and the raced push's own `synchronize`
    // event re-reviews.
    const gateHeadSha = (env.PR_REVIEWER_GATE_HEAD_SHA ?? "").trim();
    const commentHeadSha = (prObject as { head?: { sha?: unknown } }).head?.sha;
    if (
      gateHeadSha !== "" &&
      typeof commentHeadSha === "string" &&
      commentHeadSha !== "" &&
      gateHeadSha.toLowerCase() !== commentHeadSha.toLowerCase()
    ) {
      return platformOutputs(
        { should_review: "false", skip_reason: "superseded-head" },
        resolvedPlatform,
        effectiveForgejoApiUrl,
      );
    }
    forceReview = true;
    commentCommandPath = true;
    diagnostics(
      `[precheck] ${command} comment command accepted from ${JSON.stringify(commenter)}: forcing a fresh review\n`,
    );
  }

  // ── Diff content ──────────────────────────────────────────────────────
  const diffContent = await spec.adapter.getPrDiff();

  // ── Last managed review body lookup ───────────────────────────────────
  // #970: only a body whose author is the run's forge-authenticated identity
  // may supply the stored fingerprint or a carried verdict. A forged marker
  // cannot authorize a skip (see selectAuthenticatedManagedBody).
  const publishMode = env.PUBLISH_MODE || "comment";
  const commentMarker = env.COMMENT_MARKER || "<!-- ai-pr-reviewer -->";
  const [comments, reviews] = await Promise.all([
    spec.adapter.listIssueComments(),
    spec.adapter.listPrReviews(),
  ]);
  const lastCommentBody = await selectAuthenticatedManagedBody(spec.adapter, comments, reviews, publishMode, commentMarker, diagnostics);
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
      diagnostics(
        "warning: deep_review=auto could not determine every selection input; forcing a fresh review (stale-skip disabled for this run)\n",
      );
    }
    if (error) {
      diagnostics(`build_selection_fingerprint: ${error}\n`);
    }
  }

  // ── The should-review decision ────────────────────────────────────────
  if ((configEnv.REPOSITORY_SKILLS ?? "").toLowerCase() === "true" || (configEnv.REPOSITORY_SKILL_PATH ?? "") !== "") {
    const precheckPr = commentPrObject ?? await spec.adapter.getPr();
    const rawBase = precheckPr !== null && typeof precheckPr === "object"
      ? (precheckPr as { base?: unknown }).base
      : null;
    const baseRef = rawBase !== null && typeof rawBase === "object"
      && typeof (rawBase as { sha?: unknown }).sha === "string"
      ? String((rawBase as { sha: string }).sha)
      : "";
    const skills = baseRef !== ""
      ? discoverRepositorySkills(baseRef, env.GITHUB_WORKSPACE ?? process.cwd())
      : { contentFingerprint: "", warnings: ["trusted base revision unavailable; repository skills disabled"] };
    configEnv.REPOSITORY_SKILLS_FINGERPRINT = skills.contentFingerprint || "unavailable";
    if (skills.warnings.length > 0) {
      diagnostics(`[precheck] WARNING: ${skills.warnings.join("; ")}\n`);
    }
  }
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
      // One marker parse for both readers below: the #812 CI-stale
      // re-check and the #975 head acceptance.
      const carriedMarker = parseMetadata(lastCommentBody);
      // ── #812: the stale carried verdict ──────────────────────────────
      // A carried request_changes binds to the external-CI conclusion the
      // review saw (required-check coverage is not recomputed here). When
      // the forge exposes the
      // external-checks read seam, re-read it on the skip: a changed or
      // unknown conclusion forces a fresh review (fail closed), so CI
      // turning green — or a transient API failure — can never leave a
      // stale CHANGES_REQUESTED stuck until the next push. Adapters
      // without the seam (including FixtureAdapter and the base
      // PlatformAdapter) keep the exact v2 skip behavior; a carried
      // approve is never re-checked (the CI check itself gates merges).
      if (carried?.verdict === "request_changes") {
        const readAdapter = spec.adapter as Partial<PlatformReadAdapter>;
        if (typeof readAdapter.externalChecks === "function") {
          const storedCiState = typeof carriedMarker?.ci_state === "string" ? carriedMarker.ci_state : "";
          const headSha = typeof carriedMarker?.head_sha === "string" ? carriedMarker.head_sha : "";
          // Fail closed: a marker without a usable head binding (or without
          // a stored state) cannot PROVE the verdict-relevant inputs
          // unchanged — "none" is a real recorded conclusion too, and
          // none→success/failure/pending is exactly the transition that
          // must re-open the review.
          if (headSha === "" || storedCiState === "") {
            diagnostics(
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
            diagnostics(
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
        output.degradedGateBypass = carried.degradedGateBypass;
        if (carried.incompleteReason !== undefined) output.incomplete_reason = carried.incompleteReason;
        // #975: name the head whose review recorded the carried findings,
        // for the carried-pointer line downstream. The marker's head_sha is
        // untrusted comment content: only a commit-sha-shaped value (7-64
        // hex digits, case-insensitive) is ever accepted; anything else
        // leaves `head_sha` empty and the pointer says `<unknown>`.
        const markerHead = typeof carriedMarker?.head_sha === "string" ? carriedMarker.head_sha : "";
        if (/^[0-9a-f]{7,64}$/i.test(markerHead)) {
          output.head_sha = markerHead;
        }
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
  return await reviewPathOutputs(spec, env, resolvedPlatform, effectiveForgejoApiUrl, broadFingerprint, "", commentPrObject, commentCommandPath);
}

async function reviewPathOutputs(
  spec: PrecheckSpec,
  env: Record<string, string>,
  resolvedPlatform: string,
  effectiveForgejoApiUrl: string,
  broadFingerprint: string,
  staleReason: string,
  preFetchedPr?: unknown,
  commentCommandPath = false,
): Promise<PrecheckOutput> {
  const repo = env.REPO ?? "";
  const prObject = preFetchedPr ?? await spec.adapter.getPr();

  // #1312: absence of a PR object is an operational read failure, not a fact
  // about PR state. The ordinary shared admission path must fail the job
  // rather than converting a forge/API outage into a successful no-review
  // result. The human-triggered comment-command path keeps its earlier
  // fail-soft comment-pr-lookup-failed return before it reaches this seam.
  if (prObject === null || prObject === undefined) {
    // #1341: name the cause class when the adapter recorded one. A cause
    // whose kind is the HTTP-status class reports the failing status; any
    // other kind reports the kind itself — a cause may carry a status
    // that is NOT the failure (an invalid-json/too-large cause over a 200
    // response), so the status is only shown when it IS the cause. Only
    // `status`/`kind` are ever formatted, never the error message, so the
    // admission error cannot carry response-body content or credential
    // material even if an underlying transport message did.
    const cause = spec.adapter.prReadFailure?.() ?? null;
    const causeText = cause === null
      ? ""
      : cause.kind === "http-status" && typeof cause.status === "number"
        ? ` (read failed: HTTP ${cause.status})`
        : ` (read failed: ${cause.kind})`;
    throw new Error(
      `ERROR: Could not read pull request ${env.PR_NUMBER ?? ""} for ${repo}${causeText}; refusing to treat a forge/API lookup failure as a successful review skip.`,
    );
  }
  const identity = normalizePrIdentity(prObject);

  // ── #1301 closed/merged gate (fail closed) ─────────────────────────────
  // A terminal PR (closed or merged) is never reviewed on ANY path, not
  // only by the comment command: a queued self-hosted re-review generation
  // of a long-merged PR must fail closed at job admission (engine admission
  // is this function) instead of reaching the model. And a PR whose state
  // CANNOT BE PROVEN OPEN is not reviewable either: a malformed/partial
  // forge PR read (missing or unrecognized `state`) must refuse
  // deterministically rather than proceed on `draft:false` alone — the same
  // "reviewability must be proven" doctrine the #961 draft gate applies.
  // Only an exact `open` proceeds; `closed` (which covers merged: GitHub
  // and the Forgejo adapter's GitHub-shaped normalization both report a
  // merged PR as `closed`) skips as `pr-closed`, anything else as
  // `pr-state-unknown`. This gate outranks the #961 draft gate, matching
  // the comment-command order (closed outranks draft). State is read
  // through the configured forge capability. #1312: a failed lookup is no
  // longer state uncertainty at all — it throws above and fails the run.
  // The accepted comment-command path keeps the legacy
  // `comment-pr-closed` read where a missing/non-string state reads open;
  // that path already ran its own closed gate and a fail-closed draft check
  // upstream.
  const prState = derivePrState(prObject);
  if (prState !== "open"
    && !(commentCommandPath && prState === "unknown")) {
    return platformOutputs(
      {
        should_review: "false",
        skip_reason: prState === "closed" ? "pr-closed" : "pr-state-unknown",
        diff_fingerprint: broadFingerprint,
        head_sha: identity.headSha,
        base_sha: identity.baseSha,
        is_fork_pr: String(deriveIsFork(prObject ?? {})),
      },
      resolvedPlatform,
      effectiveForgejoApiUrl,
    );
  }

  // ── #961 draft gate ──────────────────────────────────────────────────
  // A draft PR is never reviewed, deterministically: a consumer whose
  // workflow forgot the `if: !github.event.pull_request.draft` guard no
  // longer gets a draft reviewed. Checked with the PR object already in
  // hand (no extra fetch). Only an explicit boolean draft value is
  // authoritative. #1312 separates a proven draft from a readable PR whose
  // draft bit is unproven: both fail closed, but only the former may claim
  // `pr-draft`; the latter reports `pr-draft-unknown`. A failed PR lookup
  // is an operational failure and already threw above. The gate outranks
  // even a forced re-review (the #231 label, an accepted #914 command) on
  // purpose — marking the PR ready for review is what re-opens it, and
  // the ready transition fires its own review.
  const draftState = deriveDraftState(prObject);
  if (draftState !== "not-draft") {
    return platformOutputs(
      {
        should_review: "false",
        skip_reason: draftState === "draft" ? "pr-draft" : "pr-draft-unknown",
        diff_fingerprint: broadFingerprint,
        head_sha: identity.headSha,
        base_sha: identity.baseSha,
        is_fork_pr: String(deriveIsFork(prObject ?? {})),
      },
      resolvedPlatform,
      effectiveForgejoApiUrl,
    );
  }

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
