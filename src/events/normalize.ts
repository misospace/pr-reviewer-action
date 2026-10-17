/** Provider-neutral forge event normalization (#728).
 *
 * `normalizeGitHubEvent` / `normalizeForgejoEvent` project a raw webhook (or
 * API) payload onto the canonical `CanonicalForgeEvent` contract so
 * downstream jobs can dedupe and route without forge-specific logic.
 *
 * Accepted payload shapes (both platforms — Forgejo PR payloads are
 * GitHub-compatible in shape, see `prToGithubShape` in
 * `src/platform/forgejo.ts`):
 *
 * - a webhook envelope: `{ name|event, action, pull_request?, issue?,
 *   pull_requests?, repository?/repositories?, installation?, sender?,
 *   label? }`
 * - a bare PR object: `{ number, id?, draft?, head: { sha, repo: {
 *   full_name } }, base: { sha, repo: { full_name } }, user? }`
 * - a flat check-reference list: some `check_run`/`check_suite` payloads
 *   carry `pull_requests[]` entries as FLAT objects `{ id, number,
 *   head_sha, base_sha }` — no nested `head`/`base` objects and no repo
 *   names. When a nested `head`/`base` yields no SHA, the entry's flat
 *   `head_sha`/`base_sha` is the fallback (still through `normalizeSha`).
 * - a follow-up comment payload: `{ name|event: "issue_comment"|"comment",
 *   action: "created", issue: { number?, pull_request }, comment: { id,
 *   user: { login } } }` — in the REAL GitHub `issue_comment` shape
 *   `issue.pull_request` is `{ url: ... }` only (no number). The PR number
 *   then comes from `issue.number`. Presence of `issue.pull_request` is
 *   still required for `follow_up`. Its headSha/baseSha are "" (the
 *   `url`-only object carries none; the platform adapter hydrates them
 *   later).
 * - the `check_update` family is SHAPE-ANCHORED: the name alone is NOT enough
 *   (#1102) — the body must carry the matching check/status shape (`carries-
 *   CheckUpdateShape`: a top-level `check_run`/`check_suite` object, or the
 *   top-level `sha`/`state`/`context` triple), or the kind degrades to
 *   `unknown`. The HMAC covers the raw body only, so a name is never
 *   authority on its own.
 *
 * Follow-up reference capture: comment-shaped envelopes
 * (`issue_comment`/`comment`) additionally project `comment.id` onto
 * `eventReference` — the provider-neutral follow-up event reference the
 * job layer fail-closes on when empty. Canonical form: a digits-only
 * string matching /^[1-9]\d{0,18}$/ after `String()` + trim — a number
 * must be a SAFE integer first (an unsafe int is rejected outright,
 * never stringified); a digit string is accepted. 0, negatives,
 * non-digits, leading zeros, oversized (>19 digits), and floats become
 * the sentinel "". Every non-comment event shape carries "". The
 * installation-id canonical form (`INSTALLATION_ID_PATTERN`) is the
 * parallel ONE definition: a digits-only string, 1–32 digits, no
 * leading zero, after `String()` + trim (0, non-digits, a leading
 * zero, or >32 digits ⇒ the sentinel ""), imported by the job builder.
 *
 * The PR is resolved in this order: `pull_request` → `issue.pull_request`
 * → first object of `pull_requests` → the payload itself (bare PR). For
 * `issue`-origin PRs the number is the PR object's `number` when present,
 * else the issue's `number`.
 *
 * Conservative failure: the normalizers return `null` (and never throw)
 * when the raw value is not an object, the repo full name cannot be
 * determined, or a PR-scoped kind (pr_* / rereview_label / follow_up) has
 * no PR number. A throwing accessor on a captured field (e.g. a hostile
 * `comment.id` getter) drops the WHOLE event (`null`) — fail closed,
 * never a degraded field.
 *
 * SHA validation at the normalize boundary: headSha/baseSha are trimmed,
 * lowercased, and must match /^[0-9a-f]{7,64}$/ — anything else becomes
 * the sentinel "". Downstream staleness checks fail closed on "".
 *
 * Reconciliation polls: `reconciliationPollEvent` is the single entry point
 * for poll observations. It runs the same bare-PR extraction and overrides
 * `kind` to `reconciliation_poll` and `source` to "poll", so a poll
 * observation of a PR is identical to the corresponding webhook event in
 * every identity field and differs only in those two. Its optional
 * `options.installationId` is validated at the adapter boundary by the SAME
 * `normalizeInstallationId` guard as the webhook's `installation.id`
 * (trim + 1–32 digits, no leading zero; a number must be a SAFE integer
 * first; anything else is the sentinel "") — the boundary never trusts
 * its caller — and
 * is used for the event's `installationId` field (default ""), which
 * lets a poller converge with the webhook that carried `installation.id`.
 */

import type {
  CanonicalForgeEvent,
  ForgeEventKind,
  ForgeEventSource,
  NormalizeEventOptions,
} from "./types.js";

const DEFAULT_REREVIEW_LABEL = "ai-review";

/** A git commit SHA: 7–64 hex chars (GitHub/Forgejo send 40). */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** Trim, lowercase, and require a well-formed SHA; "" otherwise. */
function normalizeSha(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return SHA_PATTERN.test(normalized) ? normalized : "";
}

/** A display string (actor, labelName): trimmed; "" when empty after
 * trim, longer than 128 chars, or containing a control character. */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
function sanitizeDisplay(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 128 || CONTROL_CHAR_PATTERN.test(trimmed)) {
    return "";
  }
  return trimmed;
}

/** Kinds that describe a specific PR and therefore require a PR number. */
const PR_SCOPED_KINDS: ReadonlySet<ForgeEventKind> = new Set<ForgeEventKind>([
  "pr_opened",
  "pr_reopened",
  "synchronize",
  "ready_for_review",
  "rereview_label",
  "pr_closed",
  "pr_merged",
  "follow_up",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An OWN property of the untrusted body, else `undefined`. A JSON-parsed
 * payload carries its keys as own properties, so an inherited value is not this
 * delivery's data — the same hostile-`__proto__` rule the corpus projections
 * apply (`src/corpus/projections.ts`). Used by the check/status shape gate. */
function ownField(raw: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined;
}

function isPrNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** A PR/installation id: a positive safe integer, else the sentinel 0. */
function asId(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Trim, lowercase, and require exactly one "/" with both halves non-empty.
 * Exported because the reconciliation poll adapter (`src/ingress/reconcile.ts`)
 * must reject entries whose normalized target repository disagrees with
 * the configured repository it polled using the SAME definition the
 * normalizer applies — raw or ad-hoc string comparisons would let
 * malformed envelopes slip past the boundary (#1025). */
export function normalizeRepoFullName(fullName: string): string {
  const trimmed = fullName.trim().toLowerCase();
  if (trimmed === "") return "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf("/", slash + 1) !== -1) {
    return "";
  }
  return trimmed;
}

type PrOrigin = "envelope" | "issue" | "check_list" | "bare";

interface PrExtract {
  origin: PrOrigin;
  prNumber: number;
  prId: number;
  headSha: string;
  baseSha: string;
  draft: boolean;
  fork: boolean;
  merged: boolean;
  baseRepoRaw: string;
  userLogin: string;
}

/** Locate the PR object in one of the accepted payload shapes and extract
 * its identity fields. Missing fields normalize to their sentinels. */
function resolvePr(raw: Record<string, unknown>): PrExtract | null {
  let pr: Record<string, unknown> | null = null;
  let origin: PrOrigin = "envelope";
  // The issue's own number, remembered for issue-origin PRs whose
  // `pull_request` object carries no `number` (the real GitHub
  // `issue_comment` shape: `{ url }` only).
  let issueNumber = 0;
  if (isPlainObject(raw.pull_request)) {
    pr = raw.pull_request;
  } else {
    const issue = raw.issue;
    if (isPlainObject(issue) && isPlainObject(issue.pull_request)) {
      pr = issue.pull_request;
      origin = "issue";
      issueNumber = isPrNumber(issue.number) ? issue.number : 0;
    } else if (Array.isArray(raw.pull_requests)) {
      for (const entry of raw.pull_requests) {
        if (isPlainObject(entry)) {
          pr = entry;
          origin = "check_list";
          break;
        }
      }
    } else if (isPrNumber(raw.number)) {
      pr = raw;
      origin = "bare";
    }
  }
  if (pr === null) return null;
  const head = asObject(pr.head);
  const base = asObject(pr.base);
  const headRepo = asString(asObject(head.repo).full_name);
  const baseRepo = asString(asObject(base.repo).full_name);
  // Flat check-reference entries (check_run/check_suite `pull_requests[]`)
  // can carry `head_sha`/`base_sha` without a nested `head`/`base`
  // object; fall back to them when the nested form yields no SHA (still
  // through `normalizeSha`). Such entries carry no repo names, so the
  // fork derivation below keeps its conservative "missing head repo ⇒
  // fork" rule for them.
  const headSha =
    normalizeSha(asString(head.sha)) || normalizeSha(asString(pr.head_sha));
  const baseSha =
    normalizeSha(asString(base.sha)) || normalizeSha(asString(pr.base_sha));
  return {
    origin,
    prNumber: isPrNumber(pr.number) ? pr.number : issueNumber,
    prId: asId(pr.id),
    headSha,
    baseSha,
    draft: Boolean(pr.draft),
    // The ONE fork derivation (#370 lineage, mirrors `deriveIsFork`): a
    // missing/empty head repo is a fork; a present head against a
    // different base is a fork.
    fork: headRepo === "" || headRepo !== baseRepo,
    // GitHub sends `merged: boolean`; Forgejo's GitHub-shaped payload
    // carries `merged_at` ("" when not merged) — accept either.
    merged: pr.merged === true || asString(pr.merged_at) !== "",
    baseRepoRaw: baseRepo,
    userLogin: asString(asObject(pr.user).login),
  };
}

/** The label a `labeled` event carries, normalized to its name string
 * (GitHub/Forgejo send `{ name, color, ... }`; a bare string is accepted). */
function labelNameOf(label: unknown): string {
  if (typeof label === "string") return label;
  if (isPlainObject(label) && typeof label.name === "string") return label.name;
  return "";
}

/** The canonical installation-id form: a digits-only string
 * (1–32 digits, no leading zero). This is the ONE definition of the
 * form — it is part of the event↔job contract: the event normalizers
 * produce `installationId` in this shape and the job builder
 * (`src/jobs/generation.ts`) fail-closes on anything else, so the two
 * layers can never drift apart. */
export const INSTALLATION_ID_PATTERN = /^[1-9]\d{0,31}$/;

/** Digits-only installation identity (1–32 digits, NO leading zero) at
 * the adapter boundary: `String()` + trim, then the digit pattern; "" on
 * any other input (unknown, non-string/number, empty, non-digit, leading
 * zero). A numeric value must be a SAFE integer first — `String(n)` on an
 * unsafe int silently alters the value while still matching the digit
 * pattern, which would accept a canonical id for a value the payload did
 * not actually carry (mirrors the `asId` convention). No leading zero:
 * "007" and 7 are the SAME installation and must never split into two
 * canonical values, and "0" is not an installation id at all. The
 * boundary never trusts its caller — webhook `installation.id` and poll
 * `options.installationId` are both funneled through this. */
function normalizeInstallationId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  if (typeof value !== "number" && typeof value !== "string") return "";
  const normalized = String(value).trim();
  return INSTALLATION_ID_PATTERN.test(normalized) ? normalized : "";
}

/** `installation.id` as a digits-only string ("42" from 42); "" when
 * absent, or not 1–32 digits without a leading zero after `String()` +
 * trim. The payload is parsed JSON (own properties only); a
 * prototype-injected `id` is not expected from the forge envelope layer. */
function installationIdOf(raw: Record<string, unknown>): string {
  return normalizeInstallationId(asObject(raw.installation).id);
}

/** The canonical follow-up comment id form: a digits-only string
 * (1–19 digits, no leading zero). This is the ONE definition of the
 * form — it is part of the event↔job contract: the event normalizers
 * produce `eventReference` in this shape and the job builder
 * (`src/jobs/generation.ts`) fail-closes on anything else, so the two
 * layers can never drift apart. */
export const COMMENT_ID_PATTERN = /^[1-9]\d{0,18}$/;

/** A follow-up comment id as `eventReference`: `String()` + trim, then
 * `COMMENT_ID_PATTERN`; "" when absent, or 0, negative, non-digit,
 * oversized (>19 digits), or float. A numeric value must be a SAFE
 * integer first — `String(n)` on an unsafe int silently alters the value
 * while still matching the digit patterns, collapsing two distinct
 * comment ids (or a webhook-number vs API-string observation of the same
 * comment); an unsafe int is the sentinel "". Never throws. */
function normalizeCommentId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  if (typeof value !== "number" && typeof value !== "string") return "";
  const normalized = String(value).trim();
  return COMMENT_ID_PATTERN.test(normalized) ? normalized : "";
}

/** `comment.id` (from `raw.comment`) as `eventReference`; "" when the
 * payload has no comment or no canonical id. The payload is parsed JSON
 * (own properties only); a prototype-injected `id` is not expected from
 * the forge envelope layer. */
function commentIdOf(raw: Record<string, unknown>): string {
  return normalizeCommentId(asObject(raw.comment).id);
}

/** Repo-scoped fallback: the first well-formed entry of a `repositories`
 * array (e.g. `installation_repositories` events, which have no singular
 * `repository` and no PR). */
function repoFromList(raw: Record<string, unknown>): string {
  const list = raw.repositories;
  if (!Array.isArray(list)) return "";
  for (const entry of list) {
    if (isPlainObject(entry)) {
      const normalized = normalizeRepoFullName(asString(entry.full_name));
      if (normalized !== "") return normalized;
    }
  }
  return "";
}

/** The `check_update` family is SHAPE-ANCHORED, not name-anchored (#1102): the
 * `check_run`/`check_suite`/`status` NAMES alone never mint the scheduleable
 * kind — the SIGNED body must carry the matching payload shape or the kind
 * degrades fail-closed to `unknown`. This closes the header-driven
 * reclassification residual: the HMAC covers the RAW BODY ONLY, so a captured
 * delivery replays byte-for-byte with a changed event header, and a forge
 * ingress projects the (unauthenticated) group header into the envelope name.
 *
 * Shape rationale — the gate is deliberately the NARROWEST shape each real
 * delivery already carries, and nothing GitHub-only:
 * - GitHub's `check_run`/`check_suite` webhooks carry the `check_run`/
 *   `check_suite` object at top level. Gitea/Forgejo emits NO `check_run`/
 *   `check_suite` webhook event type at all (and Forgejo check runs are a
 *   declared capability degradation, `src/ingress/capabilities.ts`
 *   `checkRuns: false`), so requiring the object drops no real Forgejo
 *   delivery.
 * - Gitea/Forgejo DOES emit commit-status webhooks natively, and its payload
 *   carries the SAME top-level `sha`/`state`/`context` triple as GitHub's
 *   `status` webhook — so the `status` gate is that triple and NOT
 *   `pull_requests`/`check_run`/`installation`/`id`/a hex-length SHA (any of
 *   which would silently drop a real Forgejo status delivery).
 *
 * Shape fields are read as OWN properties (`ownField`): the JSON-parsed body
 * carries them as own keys, so an inherited one is not this delivery's shape.
 *
 * Does NOT swallow a hostile accessor: a throwing `sha`/`check_run` getter
 * propagates exactly like every other captured-field read, so the normalizer's
 * documented fail-closed contract still holds (the whole event drops to `null`,
 * never a degraded field). A caller that must not throw — the forge ingress
 * projection — contains it at its own boundary. */
export function carriesCheckUpdateShape(name: string, raw: unknown): boolean {
  if (!isPlainObject(raw)) return false;
  if (name === "check_run") return isPlainObject(ownField(raw, "check_run"));
  if (name === "check_suite") return isPlainObject(ownField(raw, "check_suite"));
  if (name === "status") {
    return (
      asString(ownField(raw, "sha")).trim() !== "" &&
      asString(ownField(raw, "state")).trim() !== "" &&
      asString(ownField(raw, "context")).trim() !== ""
    );
  }
  return false;
}

function mapKind(
  name: string,
  action: string,
  pr: PrExtract | null,
  rawLabelName: string,
  rereviewLabel: string,
  raw: Record<string, unknown>,
): ForgeEventKind {
  if (name === "pull_request") {
    switch (action) {
      case "opened":
        return "pr_opened";
      case "reopen":
        return "pr_reopened";
      case "synchronize":
        return "synchronize";
      case "ready_for_review":
        return "ready_for_review";
      case "closed":
        return pr !== null && pr.merged ? "pr_merged" : "pr_closed";
      case "labeled":
        // EXACT byte-for-byte, case-SENSITIVE comparison, matching the
        // shipped precheck pipeline (`src/precheck/decide.ts`:
        // `eventLabelName(event.label) === rereviewLabel`) — NO trim.
        // The comparison uses the RAW label name (not the sanitized
        // display value), so a padded " ai-review" maps to `unknown`
        // here exactly as the precheck skips it as an unrelated label.
        // (`rereviewLabel` is never "" — the caller falls back to the
        // default on an empty option, mirroring the precheck's `||`.)
        return rawLabelName === rereviewLabel ? "rereview_label" : "unknown";
      default:
        return "unknown";
    }
  }
  switch (name) {
    case "check_run":
    case "check_suite":
    case "status":
      // Name alone is not enough (#1102): the signed body must carry the
      // matching check/status shape, or the kind degrades to `unknown`.
      return carriesCheckUpdateShape(name, raw) ? "check_update" : "unknown";
    case "installation":
    case "installation_repositories":
      return "installation_change";
    case "public":
      return "visibility_change";
    case "issue_comment":
    case "comment":
      return pr !== null && pr.origin === "issue" && pr.prNumber > 0 && action === "created"
        ? "follow_up"
        : "unknown";
    default:
      return "unknown";
  }
}

interface EventFields {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  prId: number;
  headSha: string;
  baseSha: string;
  draft: boolean;
  fork: boolean;
  labelName: string;
  actor: string;
  eventReference: string;
}

function buildEvent(
  platform: "github" | "forgejo",
  source: ForgeEventSource,
  kind: ForgeEventKind,
  fields: EventFields,
): CanonicalForgeEvent {
  return Object.freeze({ platform, source, kind, ...fields });
}

/** Shared normalizer core; both platform entries and `normalizeForgeEvent`
 * funnel here so GitHub and Forgejo payloads can never drift. */
function normalizeEvent(
  platform: "github" | "forgejo",
  raw: unknown,
  source: ForgeEventSource,
  options: NormalizeEventOptions,
): CanonicalForgeEvent | null {
  try {
    if (!isPlainObject(raw)) return null;
    // `||` (not `??`): an empty-string option falls back to the default,
    // mirroring the precheck's `env.REREVIEW_LABEL || "ai-review"` so the
    // two boundaries can never disagree on the trigger label.
    const rereviewLabel = options.rereviewLabel || DEFAULT_REREVIEW_LABEL;
    const name = asString(raw.name) || asString(raw.event);
    const action = asString(raw.action);
    const pr = resolvePr(raw);
    const labelName = sanitizeDisplay(labelNameOf(raw.label));
    // The RAW label name is the comparison input for the trigger label
    // (byte-for-byte parity with the precheck); the sanitized value above
    // is only the `labelName` display field.
    const rawLabelName = labelNameOf(raw.label);

    const envelopeRepo = normalizeRepoFullName(asString(asObject(raw.repository).full_name));
    const repoFullName =
      envelopeRepo !== ""
        ? envelopeRepo
        : pr !== null
          ? normalizeRepoFullName(pr.baseRepoRaw)
          : repoFromList(raw);
    if (repoFullName === "") return null;

    const kind = mapKind(name, action, pr, rawLabelName, rereviewLabel, raw);
    if (PR_SCOPED_KINDS.has(kind) && (pr === null || pr.prNumber === 0)) return null;

    // The triggering user: a comment's author for follow-ups, else the
    // envelope sender, else the PR author. Each candidate is SANITIZED in
    // priority order and the first NON-EMPTY one wins, so a hostile
    // author login (control char / >128 chars) falls through to the next
    // candidate instead of zeroing the actor.
    const commentActor = sanitizeDisplay(asString(asObject(asObject(raw.comment).user).login));
    const senderActor = sanitizeDisplay(asString(asObject(raw.sender).login));
    const prActor = sanitizeDisplay(pr !== null ? pr.userLogin : "");
    const isCommentEvent = name === "issue_comment" || name === "comment";
    const actor = isCommentEvent
      ? (commentActor !== "" ? commentActor : senderActor)
      : (senderActor !== "" ? senderActor : prActor);
    // The follow-up's provider-neutral reference: the comment id for
    // comment-shaped envelopes; "" for every non-comment event shape.
    const eventReference = isCommentEvent ? commentIdOf(raw) : "";

    return buildEvent(platform, source, kind, {
      installationId: installationIdOf(raw),
      repoFullName,
      prNumber: pr !== null ? pr.prNumber : 0,
      prId: pr !== null ? pr.prId : 0,
      headSha: pr !== null ? pr.headSha : "",
      baseSha: pr !== null ? pr.baseSha : "",
      draft: pr !== null ? pr.draft : false,
      // No PR in the payload ⇒ missing head repo ⇒ fork per the derivation
      // rule above (irrelevant for repo-scoped kinds, conservative for the
      // rest).
      fork: pr === null ? true : pr.fork,
      labelName,
      // Already sanitized: each candidate went through `sanitizeDisplay`
      // during the priority-order resolution above.
      actor,
      eventReference,
    });
  } catch {
    return null;
  }
}

/** Normalize a raw GitHub payload (webhook envelope, bare PR object, or
 * follow-up comment payload) into the canonical event, or `null` when it
 * cannot be resolved. Never throws. */
export function normalizeGitHubEvent(
  raw: unknown,
  source: ForgeEventSource = "webhook",
  options: NormalizeEventOptions = {},
): CanonicalForgeEvent | null {
  return normalizeEvent("github", raw, source, options);
}

/** Normalize a raw Forgejo payload (GitHub-compatible PR shape) into the
 * canonical event, or `null` when it cannot be resolved. Never throws. */
export function normalizeForgejoEvent(
  raw: unknown,
  source: ForgeEventSource = "webhook",
  options: NormalizeEventOptions = {},
): CanonicalForgeEvent | null {
  return normalizeEvent("forgejo", raw, source, options);
}

/** Platform-dispatching entry point. */
export function normalizeForgeEvent(
  platform: "github" | "forgejo",
  raw: unknown,
  source: ForgeEventSource = "webhook",
  options: NormalizeEventOptions = {},
): CanonicalForgeEvent | null {
  return normalizeEvent(platform, raw, source, options);
}

/** A reconciliation-poll observation of a PR (bare PR object). Runs the
 * bare-PR path and overrides `kind` to `reconciliation_poll` and `source`
 * to "poll" — the result is identical to the webhook event for the same PR
 * in every identity field, which is what makes webhook/poll dedupe work.
 *
 * `options.installationId` is validated at the boundary by the same
 * `normalizeInstallationId` guard as the webhook's `installation.id`
 * (trim + 1–32 digits, no leading zero; anything else is the sentinel "")
 * and used for the event's `installationId` field (default ""), which
 * lets a poller converge with the webhook that carried `installation.id`.
 * Polls are never comment-shaped, so `eventReference` is always "". */
export function reconciliationPollEvent(
  platform: "github" | "forgejo",
  prPayloadRaw: unknown,
  options?: { installationId?: string },
): CanonicalForgeEvent | null {
  try {
    if (!isPlainObject(prPayloadRaw)) return null;
    const pr = resolvePr(prPayloadRaw);
    if (pr === null || pr.prNumber === 0) return null;
    const envelopeRepo = normalizeRepoFullName(asString(asObject(prPayloadRaw.repository).full_name));
    const repoFullName = envelopeRepo !== "" ? envelopeRepo : normalizeRepoFullName(pr.baseRepoRaw);
    if (repoFullName === "") return null;
    // Sanitize each candidate in priority order (user → sender) and take
    // the first non-empty, so a hostile `user.login` falls through to
    // `sender` instead of zeroing the actor.
    const actor =
      sanitizeDisplay(asString(asObject(prPayloadRaw.user).login)) ||
      sanitizeDisplay(asString(asObject(prPayloadRaw.sender).login));
    return buildEvent(platform, "poll", "reconciliation_poll", {
      // Boundary guard: the poll path validates the caller's
      // installationId exactly like the webhook path — no pass-through of
      // uncertain identity state.
      installationId: normalizeInstallationId(options?.installationId),
      repoFullName,
      prNumber: pr.prNumber,
      prId: pr.prId,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      draft: pr.draft,
      fork: pr.fork,
      labelName: "",
      actor,
      eventReference: "",
    });
  } catch {
    return null;
  }
}
