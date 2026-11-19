// GitLab native webhook intake (#740 / #1677).
//
// GitLab webhooks carry TWO configured secrets, and the ONE configured secret
// string this intake is given decides the authentication MODE (the two never
// mix on one delivery):
//
//   - SIGNING mode — the configured secret starts with `whsec_` (GitLab's
//     recommended signing token, GA in 19.1). Deliveries follow the Standard
//     Webhooks spec: `webhook-id`, `webhook-timestamp` (Unix seconds) and
//     `webhook-signature` (one or more SPACE-SEPARATED `v1,<base64>` entries).
//     The HMAC-SHA256 input is the string `{webhook-id}.{webhook-timestamp}.{raw
//     body}` and the key is the token WITHOUT the `whsec_` prefix, base64-
//     decoded. Verification requires a well-formed `webhook-id` (non-empty,
//     ≤128 printable chars), a Unix-seconds `webhook-timestamp` within 300s of
//     now (replay bound; `nowMs` is injectable for tests), and a present
//     `webhook-signature`; the expected `v1,<base64>` is constant-time compared
//     against EVERY space-separated entry. In this mode an `X-Gitlab-Token`
//     header is NOT consulted — a delivery without a valid signature is
//     rejected even when the token header carries the signing token verbatim.
//   - SECRET mode — any other non-empty configured secret (the legacy secret
//     token). The delivery must carry `X-Gitlab-Token` matching the secret
//     VERBATIM (shared secret, constant-time comparison). A `webhook-signature`
//     header alone never authenticates in this mode.
//
// An empty configured secret accepts NOTHING, and duplicate-header arrays and
// non-string values are refused before any comparison, in both modes. The
// superseded `X-Gitlab-Estimated-Payload-Signature` scheme is NOT supported —
// no half-support: the header is simply not read.
//
// Because both modes authenticate over the RAW BODY (Signing mode additionally
// over the id/timestamp), `X-Gitlab-Event` ("Merge
// Request Hook", "Note Hook", "Push Hook", "Ping", ...) is an UNAUTHENTICATED
// shape-guarded HINT, exactly like the Gitea/Forgejo event headers (#1024): it
// may only CORROBORATE a projection the signed payload's own `object_kind`
// already authorizes, and can never re-route one. A header whose family claim
// disagrees with the signed `object_kind` (e.g. "Note Hook" over an
// `object_kind: "merge_request"` payload) degrades fail-closed to the fixed
// unmapped shape, never to the header's family. An unknown header (outside the
// closed map) makes no claim and never fires that guard; the signed payload
// still drives the projection.
//
// The projection maps native GitLab event vocabulary onto the GitHub-shaped
// envelope `normalizeGitLabEvent` (#728, nested-project-path grammar) accepts,
// BEFORE it runs. It is pure: never throws, never mutates its input, and builds
// EVERY mapped envelope FRESH from documented payload reads — untrusted payload
// content (MR titles/descriptions, note bodies, branch names, URLs) is never
// copied into the envelope at all. The only untrusted strings that reach a
// synthesized field are the documented identity reads of this module's brief:
// `project.path_with_namespace` (repository identity, re-validated by the
// normalizer's GitLab grammar) and the `user`/`author` `username` logins (which
// the normalizer sanitizes). The rereview trigger label is re-emitted as the
// TRUSTED CONSTANT on a byte-exact match, never as a payload copy. Every
// rejection degrades to the fixed `{ name: "unknown" }` envelope — deliberately
// repo-less, so the normalizer resolves no identity and returns `null`, which
// the intake acks 200-ignored instead of retrying forever.
//
// Deviations from the settled #1677 brief, each with evidence, recorded here:
// 1. `base.repo.full_name` is ALSO synthesized from `project.path_with_namespace`
//    (the brief's envelope sketch sets only `head.repo`). Without it, the
//    normalizer's ONE fork derivation (`resolvePr`: missing base repo ⇒ fork)
//    reads EVERY GitLab MR as a fork even when `source_project_id ===
//    project.id`, contradicting the brief's own fork rule ("equal → fork
//    false"). The value used is the SAME documented read as `repository.full_name`.
// 2. The `labeled` synthesis requires the re-review label to be ADDED, not just
//    present: GitLab's update payload carries the PR's FULL current label list
//    at top level, which cannot distinguish "label added" from "another label
//    changed", so the added set is computed as `changes.labels.current` minus
//    `changes.labels.previous` (both closed entry forms: a string, or a plain
//    object with the documented label name — `title`, with `name` as the
//    tolerated REST-API alias).
// 3. "well-formed `last_commit`" is pinned to "plain object with a non-empty
//    string `id`" — the shape of a GitLab commit object — so a hostile or empty
//    placeholder cannot masquerade as commit evidence. The commit-push signal
//    on an `update` delivery is `object_attributes.oldrev` (a hex SHA string,
//    present only when code actually changed), per the current webhook docs;
//    the stock payload carries NO `old_last_commit`.
//
// GitLab has no App installation model, so the envelope NEVER carries an
// `installation` key; the canonical `installationId` is the "" sentinel.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeGitLabEvent } from "../events/normalize.js";
import type { CanonicalForgeEvent, ForgeEventKind } from "../events/types.js";
import { isPlainObject } from "../platform/jq.js";
import { DEFAULT_MAX_WEBHOOK_BODY_BYTES } from "./webhook-handler.js";
import type { OperatorEventRouter } from "./operator-router.js";

const SIGNING_TOKEN_PREFIX = "whsec_";
/** A Standard Webhooks `webhook-id`: non-empty, ≤128 printable ASCII chars. */
const WEBHOOK_ID = /^[\x20-\x7e]{1,128}$/;
/** A Unix-seconds timestamp: digits only (no sign, no fraction). */
const UNIX_SECONDS = /^[0-9]{1,19}$/;
/** Replay bound: |now - webhook-timestamp| must stay within this many seconds. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;
/** One `webhook-signature` entry: `v1,<base64>`. */
const SIGNATURE_ENTRY = /^v1,([A-Za-z0-9+/]+={0,3})$/;

/** The auth-relevant headers of one delivery, exactly as received (a
 * duplicate header arrives as an array and is refused before any comparison). */
export interface GitLabWebhookAuthHeaders {
  readonly tokenHeader?: string | string[] | undefined;
  readonly webhookIdHeader?: string | string[] | undefined;
  readonly webhookTimestampHeader?: string | string[] | undefined;
  readonly webhookSignatureHeader?: string | string[] | undefined;
}

export interface GitLabWebhookVerifyOptions {
  /** Injectable clock (ms) for the replay-bound timestamp check; defaults to
   * `Date.now()`. Tests pin it to exercise the tolerance window deterministically. */
  readonly nowMs?: number;
}

/** The signing key: the configured token WITHOUT the `whsec_` prefix, base64-
 * decoded. An empty decoded key (a bare `whsec_` token, or one whose suffix is
 * not base64 at all) authenticates nothing. */
function signingKey(secret: string): Buffer | null {
  const key = Buffer.from(secret.slice(SIGNING_TOKEN_PREFIX.length), "base64");
  return key.length > 0 ? key : null;
}

/** The Standard Webhooks HMAC-SHA256 (base64) over `{id}.{timestamp}.{rawBody}`.
 * The body is concatenated as BYTES, so a string body and its Buffer encoding
 * sign identically. */
function signingDigest(
  key: Buffer,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: Buffer | string,
): string {
  const prefix = Buffer.from(`${webhookId}.${webhookTimestamp}.`, "utf8");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return createHmac("sha256", key).update(Buffer.concat([prefix, body])).digest("base64");
}

/** The signing twin of the Standard Webhooks scheme: the exact
 * `webhook-signature` value (`v1,<base64>`) a GitLab instance computes for
 * `{secret, webhookId, timestampSeconds, rawBody}`. For fixtures and replay
 * tests only — it is never a verification path. */
export function computeGitLabWebhookSignatureHeader(
  secret: string,
  webhookId: string,
  timestampSeconds: number | string,
  rawBody: Buffer | string,
): string {
  const key = signingKey(secret) ?? Buffer.alloc(0);
  return `v1,${signingDigest(key, webhookId, String(timestampSeconds), rawBody)}`;
}

/** SECRET mode: `X-Gitlab-Token` is the configured secret sent verbatim — a
 * constant-time comparison. An empty secret accepts nothing (including an empty
 * header); a duplicate-header array or a non-string is refused before any
 * comparison. */
function verifyTokenHeader(secret: string, tokenHeader: string | string[] | undefined): boolean {
  if (typeof tokenHeader !== "string") return false;
  const provided = Buffer.from(tokenHeader, "utf8");
  const expected = Buffer.from(secret, "utf8");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** The replay-bound Unix-seconds timestamp: digits only, a safe integer, and
 * within ±300s of `nowMs`. */
function timestampWithinBound(timestampHeader: string | string[] | undefined, nowMs: number): boolean {
  if (typeof timestampHeader !== "string" || !UNIX_SECONDS.test(timestampHeader)) return false;
  const seconds = Number(timestampHeader);
  if (!Number.isSafeInteger(seconds)) return false;
  return Math.abs(Math.floor(nowMs / 1000) - seconds) <= TIMESTAMP_TOLERANCE_SECONDS;
}

/** SIGNING mode: verify the Standard Webhooks signature over
 * `{webhook-id}.{webhook-timestamp}.{raw body}`. Every header must be a single
 * well-formed string; the expected `v1,<base64>` digest is constant-time
 * compared against EVERY space-separated entry of `webhook-signature` (GitLab
 * may rotate keys and send several). */
function verifySignedDelivery(
  secret: string,
  headers: GitLabWebhookAuthHeaders,
  rawBody: Buffer | string,
  nowMs: number,
): boolean {
  const key = signingKey(secret);
  if (key === null) return false;
  const { webhookIdHeader, webhookTimestampHeader, webhookSignatureHeader } = headers;
  if (typeof webhookIdHeader !== "string" || !WEBHOOK_ID.test(webhookIdHeader)) return false;
  if (!timestampWithinBound(webhookTimestampHeader, nowMs)) return false;
  if (typeof webhookSignatureHeader !== "string" || webhookSignatureHeader === "") return false;
  const expected = Buffer.from(
    signingDigest(key, webhookIdHeader, webhookTimestampHeader as string, rawBody),
    "base64",
  );
  for (const entry of webhookSignatureHeader.split(" ")) {
    const match = SIGNATURE_ENTRY.exec(entry);
    if (match === null || match[1] === undefined) continue;
    const candidate = Buffer.from(match[1], "base64");
    if (candidate.length === expected.length && candidate.length > 0 && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

/** Authenticate one GitLab webhook delivery. The configured secret decides the
 * MODE: a `whsec_`-prefixed secret is SIGNING mode (only a valid Standard
 * Webhooks signature over `{id}.{timestamp}.{raw body}` authenticates, and the
 * `X-Gitlab-Token` header is NOT consulted); any other non-empty secret is
 * SECRET mode (only a verbatim `X-Gitlab-Token` match authenticates, and a
 * `webhook-signature` header alone never does). An empty secret accepts
 * nothing. The modes are EXCLUSIVE by token shape — there is no either-factor
 * acceptance. Total over untrusted header state: every header is type- and
 * shape-guarded before any comparison. */
export function verifyGitLabWebhookDelivery(
  secret: string,
  headers: GitLabWebhookAuthHeaders,
  rawBody: Buffer | string,
  options: GitLabWebhookVerifyOptions = {},
): boolean {
  if (secret === "") return false;
  if (secret.startsWith(SIGNING_TOKEN_PREFIX)) {
    return verifySignedDelivery(secret, headers, rawBody, options.nowMs ?? Date.now());
  }
  return verifyTokenHeader(secret, headers.tokenHeader);
}

/** The closed `X-Gitlab-Event` shape guard. GitLab's event names are Title
 * Case with a trailing "Hook" and contain spaces ("Merge Request Hook"), so
 * the Gitea-family EVENT_HEADER pattern cannot express them. This is a
 * documented CLOSED check: it is shape validation, NOT authentication — the
 * body-over auth (token verbatim, or the Standard Webhooks signature) is, and
 * this header is only a hint. */
const GITLAB_EVENT_HEADER = /^[\w .-]{1,128}$/;

/** A git commit SHA in `object_attributes.oldrev` (the MR update commit-push
 * signal): 7–64 hex chars, case-insensitive per the current webhook docs. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The closed header-family map: the only header claims this intake recognizes.
 * Any other (shape-valid) value makes NO family claim, so it can neither
 * re-route a delivery nor fire the disagreement guard. */
const EVENT_HEADER_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["Merge Request Hook", "merge_request"],
  ["Note Hook", "note"],
  ["Push Hook", "push"],
  ["Ping", "ping"],
]);

function isPingPayload(payload: Record<string, unknown>): boolean {
  return payload.object_kind === "ping" || payload.event_type === "ping";
}

/** The fixed unmapped shape: every fail-closed degradation and every
 * unrecognized object kind projects here. It carries no repository, so the
 * normalizer returns null and the intake acks ignored. The name is a fixed
 * literal, never derived from untrusted input. */
function unmappedShape(): Record<string, unknown> {
  return { name: "unknown" };
}

/** A positive safe integer (an id usable for an exact comparison), else 0. */
function asPositiveSafeInt(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A documented identity read: `{ username: <string> }` on a plain object,
 * else "". The normalizer sanitizes whatever reaches the canonical actor. */
function usernameOf(source: unknown): string {
  return isPlainObject(source) && typeof source.username === "string" ? source.username : "";
}

/** `project.path_with_namespace` (documented read), else "". Re-validated by
 * the normalizer's nested GitLab grammar; used verbatim (identically on head
 * and base) so the normalizer's raw head/base string comparison for `fork`
 * sees a match regardless of case. */
function projectPathOf(payload: Record<string, unknown>): string {
  const project = payload.project;
  return isPlainObject(project) && typeof project.path_with_namespace === "string"
    ? project.path_with_namespace
    : "";
}

function projectIdOf(payload: Record<string, unknown>): number {
  const project = payload.project;
  return isPlainObject(project) ? asPositiveSafeInt(project.id) : 0;
}

/** A well-formed GitLab commit object: plain object with a non-empty string
 * `id` (deviation 3). Returns "" when absent or malformed. */
function commitIdOf(commit: unknown): string {
  return isPlainObject(commit) && typeof commit.id === "string" && commit.id !== ""
    ? commit.id
    : "";
}

/** One closed label-entry form: a string, or a plain object carrying the
 * documented GitLab label name. Webhook payloads serialize label objects with
 * `title` (every documented `labels` / `changes.labels.previous` /
 * `changes.labels.current` example uses `title`, e.g.
 * `{ id, title: "Platform", color }`), so `title` is the field read here. A
 * string `name` is tolerated only as an alias for payloads built from the
 * REST-API label representation, which spells the same value `name`; `title`
 * wins when both are present. Anything else contributes nothing. */
function labelEntryName(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!isPlainObject(entry)) return null;
  if (typeof entry.title === "string") return entry.title;
  if (typeof entry.name === "string") return entry.name;
  return null;
}

function labelNamesFromList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const names: string[] = [];
  for (const entry of list) {
    const name = labelEntryName(entry);
    if (name !== null) names.push(name);
  }
  return names;
}

/** The labels ADDED by an update delivery (deviation 2): the `labels` entry of
 * the payload's `changes`, read in either GitLab form — an array of entries
 * with a `key`, or an object with a `labels` member carrying
 * `{ previous, current }` — as `current` minus `previous` by extracted name.
 * Returns `null` when the delivery carries no labels change at all. */
function addedLabelsOf(payload: Record<string, unknown>): string[] | null {
  const mut = payload.changes;
  let labelsChange: unknown;
  if (Array.isArray(mut)) {
    labelsChange = undefined;
    for (const entry of mut) {
      if (isPlainObject(entry) && entry.key === "labels") {
        labelsChange = entry;
        break;
      }
    }
  } else if (isPlainObject(mut) && "labels" in mut) {
    labelsChange = mut.labels;
  } else {
    return null;
  }
  if (!isPlainObject(labelsChange)) return null;
  if (!("current" in labelsChange)) return null;
  const previous = new Set(labelNamesFromList(labelsChange.previous));
  const added: string[] = [];
  for (const name of labelNamesFromList(labelsChange.current)) {
    if (!previous.has(name)) added.push(name);
  }
  return added;
}

/** Project a signed `object_kind: "merge_request"` delivery onto the GitHub
 * `pull_request` envelope. Every mapped field is a fresh synthesis from
 * documented reads; title/description/branch/URL fields are never copied. */
function projectMergeRequestEvent(
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string },
): Record<string, unknown> {
  const attrs = isPlainObject(payload.object_attributes) ? payload.object_attributes : {};
  const envelope: Record<string, unknown> = {
    name: "pull_request",
    repository: { full_name: projectPathOf(payload) },
    sender: { login: usernameOf(payload.user) },
  };

  const pr: Record<string, unknown> = {
    number: asPositiveSafeInt(attrs.iid),
    id: asPositiveSafeInt(attrs.id),
    draft: attrs.draft === true || attrs.work_in_progress === true,
    head: { sha: commitIdOf(attrs.last_commit) },
    // Deviation 1: the base repo is the project the delivery is mounted on —
    // the SAME documented read as `repository.full_name` — so the normalizer's
    // one fork derivation can observe a head==base match.
    base: { sha: "", repo: { full_name: projectPathOf(payload) } },
    user: { login: usernameOf(attrs.author ?? payload.user) },
  };

  // The fork rule: head.repo is synthesized ONLY when the signed ids prove the
  // head lives in this project. `source_project_id === project.id` is the
  // authority; the `target_project_id` equality is honored ONLY when the
  // source id is absent (the brief's "or target_project_id when present and
  // equal" — a PRESENT, DISAGREEING source id is the authoritative fork signal
  // and can never be overridden by target equality, per the settled fork
  // test). Any missing id degrades to the omitted-head-repo (fork=true) side.
  const projectId = projectIdOf(payload);
  const sourceId = asPositiveSafeInt(attrs.source_project_id);
  const targetId = asPositiveSafeInt(attrs.target_project_id);
  const sameProject =
    projectId > 0 &&
    (sourceId > 0 ? sourceId === projectId : targetId > 0 && targetId === projectId);
  if (sameProject) {
    const head = pr.head as Record<string, unknown>;
    head.repo = { full_name: projectPathOf(payload) };
  }

  const action = typeof attrs.action === "string" ? attrs.action : "";
  if (action === "open") {
    envelope.action = "opened";
  } else if (action === "reopen") {
    envelope.action = "reopen";
  } else if (action === "close") {
    // merged stays unset: the normalizer's merge signal is `merged === true`
    // or a non-empty `merged_at`, and neither is synthesized for a close.
    envelope.action = "closed";
  } else if (action === "merge") {
    envelope.action = "closed";
    pr.merged = true;
  } else if (action === "update") {
    // The commit-push signal is `object_attributes.oldrev`: a hex commit SHA
    // string, present ONLY on `update` when code actually changed (new push or
    // applied suggestion). A non-hex or wrong-length placeholder is no evidence.
    if (typeof attrs.oldrev === "string" && COMMIT_SHA.test(attrs.oldrev)) {
      envelope.action = "synchronize";
    } else {
      const added = addedLabelsOf(payload);
      // `||` not `??`: an empty option falls back to the same "ai-review"
      // default the #728 normalizer and the precheck use (`options.rereviewLabel
      // || "ai-review"`), so the two boundaries cannot disagree on the trigger.
      const rereview = options.rereviewLabel || "ai-review";
      if (added !== null && added.includes(rereview)) {
        envelope.action = "labeled";
        // Synthesize ONLY the trusted constant — the match above is byte-exact,
        // but a synthesized field must never be derived from untrusted input.
        envelope.label = { name: rereview };
      }
    }
  }
  // "approval"/"approved"/"unapproved"/"unapproval" (never mint a review
  // generation) and every unknown or missing action take the fixed "unknown"
  // action sentinel — the raw untrusted action
  // string is never copied into the envelope; mapKind's closed switch already
  // maps "unknown" to the `unknown` kind.
  envelope.action = envelope.action ?? "unknown";
  envelope.pull_request = pr;
  return envelope;
}

/** Project a signed `object_kind: "note"` delivery onto the GitHub
 * `issue_comment` envelope the `follow_up` gate requires.
 *
 * The GATE is signed-body-only: `object_attributes.noteable_type ===
 * "MergeRequest"` (commit/issue/snippet/wiki notes never schedule) AND
 * `object_attributes.action === "create"` (the current webhook docs list
 * `create` and `update` for comment note events; only `create` projects to
 * `created`). Fail-closed: `update`, an absent, or any other action degrades
 * to unknown.
 *
 * The MR reference: the real GitLab note payload carries a top-level
 * `merge_request` object (with `iid`/`id`) while `object_attributes` carries
 * `noteable_id`, NOT the iid — so the number is `object_attributes.iid` when
 * it is a positive safe integer, else `merge_request.iid`, else the
 * delivery degrades to unknown. `merge_request.id` is deliberately NOT a
 * fallback: it is the instance-GLOBAL identifier, a different id space from
 * the project-scoped iid the whole downstream chain addresses, and guessing
 * across id spaces could answer an unrelated merge request. The note BODY
 * (`object_attributes.note`) is untrusted data and is never copied anywhere. */
function projectNoteEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const attrs = isPlainObject(payload.object_attributes) ? payload.object_attributes : {};
  if (attrs.noteable_type !== "MergeRequest" || attrs.action !== "create") return unmappedShape();

  const mr = isPlainObject(payload.merge_request) ? payload.merge_request : {};
  const iid =
    asPositiveSafeInt(attrs.iid) ||
    asPositiveSafeInt(mr.iid);
  if (iid === 0) return unmappedShape();

  // The `issue.pull_request` MUST carry `number` so resolvePr takes the
  // issue-origin path the `follow_up` kind requires; head/base SHAs are the
  // normalizer's "" sentinels (the platform adapter hydrates them later).
  return {
    name: "issue_comment",
    action: "created",
    issue: { number: iid, pull_request: { number: iid } },
    comment: { id: attrs.id, user: { login: usernameOf(attrs.author) } },
    repository: { full_name: projectPathOf(payload) },
    sender: { login: usernameOf(payload.user) },
  };
}

/** Project a raw native GitLab delivery onto the GitHub-shaped envelope
 * `normalizeGitLabEvent` accepts. Driven PRIMARILY by the signed payload's
 * `object_kind`; `X-GitLab-Event` is a closed-set hint that may only
 * corroborate it — a family disagreement degrades fail-closed, never
 * re-routes. Never throws, never mutates its input. */
export function projectGitLabWebhookPayload(
  eventHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  try {
    const family = EVENT_HEADER_FAMILIES.get(eventHeader);
    if (family !== undefined && family !== payload.object_kind) return unmappedShape();
    if (payload.object_kind === "merge_request") return projectMergeRequestEvent(payload, options);
    if (payload.object_kind === "note") return projectNoteEvent(payload);
    // Push/Tag/Job/Pipeline/Wiki/... and anything unrecognized: a shape the
    // normalizer maps to `unknown`/null (repo-less ⇒ ignored), still parsed
    // safely.
    return unmappedShape();
  } catch {
    // Total, fail-closed — a hostile accessor can escape a field read but not
    // this boundary, and it can never resurrect a mapped family.
    return unmappedShape();
  }
}

/** Normalize one GitLab webhook body into the canonical event, or `null` when
 * it cannot be resolved (including a repo-less unmapped shape). Never throws. */
export function parseGitLabWebhookEvent(
  eventHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): CanonicalForgeEvent | null {
  try {
    const normalizeOptions =
      options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel };
    const projected = projectGitLabWebhookPayload(eventHeader, payload, normalizeOptions);
    return normalizeGitLabEvent(projected, "webhook", normalizeOptions);
  } catch {
    return null;
  }
}

/** What dispatching one GitLab webhook delivery decided. Fixed, credential-free
 * values: the payload, the secret, and any auth header are never echoed.
 * The auth outcome is named `invalid-auth` (not `invalid-signature` like the
 * Gitea union) because GitLab authenticates in two secret-selected modes. */
export type GitLabWebhookDispatchOutcome =
  | { readonly status: "accepted"; readonly kind: ForgeEventKind }
  | { readonly status: "ignored" }
  | { readonly status: "invalid-auth" }
  | { readonly status: "invalid-payload" }
  | { readonly status: "error" };

export interface GitLabWebhookDelivery extends GitLabWebhookAuthHeaders {
  /** The `X-Gitlab-Event` header: shape-guarded by the HTTP layer, and still
   * only an unauthenticated corroborating hint. */
  readonly eventHeader: string;
  /** The RAW request body — the auth input. Never a re-serialization. */
  readonly rawBody: Buffer | string;
}

export interface GitLabWebhookDispatchOptions {
  readonly secret: string;
  readonly rereviewLabel?: string | undefined;
  readonly onEvent: (event: CanonicalForgeEvent) => void | Promise<void>;
  /** When present, a canonical `follow_up` delivery goes here INSTEAD of
   * `onEvent` — the same routing seam `webhook-handler.ts` exposes. */
  readonly router?: OperatorEventRouter | undefined;
  /** Injectable clock (ms) for the signing-mode replay bound, threaded
   * straight to {@link verifyGitLabWebhookDelivery}. */
  readonly nowMs?: number | undefined;
}

/** Verify, project, normalize, and route one GitLab webhook delivery: the
 * non-HTTP core of the GitLab intake, so the whole intake is testable without
 * a socket and the HTTP handler cannot grow behavior of its own.
 *
 * The order is load-bearing and fail-closed: auth is verified over the RAW
 * body BEFORE any `JSON.parse`, so unauthenticated bytes never reach a parser;
 * `ping` is ignored BEFORE projection; a permanently unroutable delivery is
 * `ignored` (ack) rather than retried forever; a throwing sink is reported as
 * `error` and never rethrown. */
export async function dispatchGitLabWebhookEvent(
  delivery: GitLabWebhookDelivery,
  options: GitLabWebhookDispatchOptions,
): Promise<GitLabWebhookDispatchOutcome> {
  try {
    if (
      !verifyGitLabWebhookDelivery(
        options.secret,
        {
          tokenHeader: delivery.tokenHeader,
          webhookIdHeader: delivery.webhookIdHeader,
          webhookTimestampHeader: delivery.webhookTimestampHeader,
          webhookSignatureHeader: delivery.webhookSignatureHeader,
        },
        delivery.rawBody,
        options.nowMs === undefined ? {} : { nowMs: options.nowMs },
      )
    ) {
      return { status: "invalid-auth" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof delivery.rawBody === "string" ? delivery.rawBody : delivery.rawBody.toString("utf8"),
      );
    } catch {
      return { status: "invalid-payload" };
    }
    if (!isPlainObject(parsed) || Array.isArray(parsed)) return { status: "invalid-payload" };

    if (delivery.eventHeader === "Ping" || isPingPayload(parsed)) return { status: "ignored" };

    const event = parseGitLabWebhookEvent(delivery.eventHeader, parsed, {
      ...(options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel }),
    });
    if (event === null) return { status: "ignored" };

    try {
      if (event.kind === "follow_up" && options.router !== undefined) {
        await options.router.handleEvent(event);
      } else {
        await options.onEvent(event);
      }
    } catch {
      return { status: "error" };
    }
    return { status: "accepted", kind: event.kind };
  } catch {
    return { status: "error" };
  }
}

export interface GitLabWebhookHandlerOptions {
  readonly secret: string;
  readonly maxBodyBytes?: number | undefined;
  readonly rereviewLabel?: string | undefined;
  readonly onEvent: (event: CanonicalForgeEvent) => void | Promise<void>;
  /** Operator-mode event router: a canonical `follow_up` delivery is handed to
   * it (never to `onEvent`); everything else is unchanged. Absent → every
   * delivery, `follow_up` included, goes to `onEvent`. A throwing router is
   * handled exactly like a throwing `onEvent`: a fixed 500, no error text. */
  readonly router?: OperatorEventRouter | undefined;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

/**
 * Node http request handler for GitLab webhook deliveries (#740).
 *
 * This is a thin wrapper over `dispatchGitLabWebhookEvent`: the HTTP layer
 * holds ONLY the transport discipline (method, header shape guards, the
 * mid-stream body bound with the inbound stream dropped, and the fixed status
 * mapping of the dispatch outcome), so the whole verify→parse→ping→project→
 * normalize→route order — the load-bearing part — exists once, in the
 * dispatch core, exactly like the Gitea module's dispatch core. It is NOT
 * `createForgejoWebhookHandler` reused with a substituted projection: that
 * shared pipeline cannot express GitLab's auth (a secret-selected mode over
 * either a verbatim shared secret token or a Standard Webhooks signature), its
 * space-bearing event-header vocabulary, or the
 * pre-projection ping gate, and growing those into the shared handler would
 * weaken the Forgejo/Gitea mounts it exists to protect. The pipeline
 * DISCIPLINE is reproduced instead — same status contract, same fixed short
 * response bodies that never echo the payload, secret, signature, or error
 * text, same unauthenticated-hint posture.
 */
export function createGitLabWebhookHandler(
  options: GitLabWebhookHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let settled = false;
    const settle = (status: number, body: string): void => {
      if (settled) return;
      settled = true;
      send(res, status, body);
    };

    void handle().catch(() => settle(500, '{"status":"internal error"}'));

    async function handle(): Promise<void> {
      if (req.method !== "POST") {
        settle(405, '{"status":"method not allowed"}');
        // Drain so the refused body does not desynchronize a keep-alive socket.
        req.resume();
        return;
      }

      const eventHeader = req.headers["x-gitlab-event"];
      if (typeof eventHeader !== "string" || !GITLAB_EVENT_HEADER.test(eventHeader)) {
        settle(400, '{"status":"invalid event header"}');
        req.resume();
        return;
      }

      const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      let tooLarge = false;
      let streamError = false;
      const bodyBuffer = await new Promise<Buffer | null>((resolve) => {
        req.on("data", (chunk: Buffer | string) => {
          if (tooLarge) return;
          const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += piece.length;
          if (receivedBytes > maxBodyBytes) {
            tooLarge = true;
            chunks.length = 0;
            resolve(null);
            return;
          }
          chunks.push(piece);
        });
        // A transport-level stream failure is the client's malformed
        // delivery, not our internal fault: the fixed 400 below, never the
        // generic 500 (and the failure text never reaches the response).
        req.on("error", () => {
          streamError = true;
          chunks.length = 0;
          resolve(null);
        });
        req.on("end", () => {
          if (!tooLarge && !streamError) resolve(Buffer.concat(chunks));
        });
      });
      if (bodyBuffer === null) {
        settle(streamError ? 400 : 413, streamError ? '{"status":"unreadable body"}' : '{"status":"body too large"}');
        // Drop the inbound stream so the client cannot keep pushing bytes into
        // a request we already refused.
        if (!req.destroyed) req.destroy();
        return;
      }

      // ONE verifier for the HTTP lane: the dispatch core authenticates the
      // delivery BEFORE it parses, so unauthenticated bytes still never
      // reach the JSON parser, and the handler cannot fork the auth
      // decision (or its replay clock) from the core's.
      const outcome = await dispatchGitLabWebhookEvent(
        {
          eventHeader,
          tokenHeader: req.headers["x-gitlab-token"],
          webhookIdHeader: req.headers["webhook-id"],
          webhookTimestampHeader: req.headers["webhook-timestamp"],
          webhookSignatureHeader: req.headers["webhook-signature"],
          rawBody: bodyBuffer,
        },
        {
          secret: options.secret,
          ...(options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel }),
          onEvent: options.onEvent,
          router: options.router,
        },
      );
      switch (outcome.status) {
        case "accepted":
          settle(202, `{"status":"accepted","kind":"${outcome.kind}"}`);
          return;
        case "ignored":
          // Ack so the forge stops redelivering a permanently unroutable
          // delivery.
          settle(200, '{"status":"ignored"}');
          return;
        case "invalid-auth":
          settle(401, '{"status":"invalid signature"}');
          return;
        case "invalid-payload":
          settle(400, '{"status":"invalid payload"}');
          return;
        case "error":
          // Keep the error local — no logging of the event, no echo.
          settle(500, '{"status":"internal error"}');
          return;
      }
    }
  };
}
