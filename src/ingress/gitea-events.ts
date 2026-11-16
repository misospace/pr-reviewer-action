// Gitea forge identity for the ingress edge (#1678).
//
// Upstream Gitea and Forgejo speak the SAME webhook and REST wire protocol.
// Gitea's `services/webhook/deliver.go` sets `X-Gitea-Event` to the GROUPED
// event name (`HookEventType.Event()`) and `X-Gitea-Event-Type` to the specific
// type, and signs the RAW body with HMAC-SHA256 into `X-Gitea-Signature` —
// there is NO timestamp header anywhere in the Gitea webhook scheme. Its payload
// structs (`modules/structs/hook.go`) use the action vocabulary `opened` /
// `closed` / `reopened` / `synchronized` / `label_updated` / `created`, and every
// issue and pull-request delivery carries a top-level `repository`. Forgejo
// forked that protocol, so the verified projection (`forgejo-events.ts`) and the
// FROZEN #728 normalizer are the shared implementation. This module is the Gitea
// NAMED entry point onto them — not a second parser — and the place a Gitea-only
// nuance lives.
//
// The nuance the shared Forgejo projection cannot express is the PR-comment
// shape. Gitea's `IssueCommentPayload` carries the full PR at the TOP level
// (`pull_request`) AND a `PullRequestMeta` at `issue.pull_request` — Gitea sets
// that meta for every PR-linked issue, and it carries `merged` / `merged_at` /
// `draft` / `html_url` but NO `number`. The shared projection leaves a delivery
// whose `issue.pull_request` is already present untouched, which is right for a
// GitHub-shaped delivery but on Gitea lets the normalizer prefer the top-level
// object ("envelope" origin), and the `follow_up` kind requires the "issue"
// origin — so a Gitea PR comment would never schedule a follow-up. Gitea
// therefore REPLACES a `number`-less `issue.pull_request` with the richer
// top-level PR. A `issue.pull_request` that already carries a `number` is
// GitHub-shaped and stays untouched.
//
// The second nuance is the label delivery: Gitea's `IssuePayload` and
// `PullRequestPayload` carry NO top-level `label` field, so the trigger label
// for a `label_updated` delivery is always read out of the PR's own label list.
//
// Security posture is inherited unchanged from `webhook-handler.ts` and
// `forgejo-events.ts`: the HMAC covers the RAW BODY ONLY, so both event headers
// are UNAUTHENTICATED shape-guarded hints that may refine a projection the
// signed body's own `action` already authorizes and can never rewrite one; no
// untrusted string is ever copied into a synthesized field (the only synthesized
// value is the operator's trusted re-review label constant); the projection
// never throws, never mutates its input, and degrades fail-closed to a shape the
// normalizer maps to `unknown`.

import { computeForgejoWebhookSignature, verifyForgejoWebhookSignature } from "./signature.js";
import { normalizeForgejoEvent } from "../events/normalize.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanonicalForgeEvent, ForgeEventKind } from "../events/types.js";
import { isPlainObject } from "../platform/jq.js";
import { projectForgejoWebhookPayload } from "./forgejo-events.js";
import type { OperatorEventRouter } from "./operator-router.js";
import {
  createForgejoWebhookHandler,
  type ForgejoWebhookHandlerOptions,
} from "./webhook-handler.js";

/**
 * Verify a Gitea webhook signature: the lowercase-hex HMAC-SHA256 of the RAW
 * body, delivered as `X-Gitea-Signature`.
 *
 * Recorded deviation from the #1678 brief, which asked for an HMAC over
 * `"{timestamp}.{body}"`. Gitea has no timestamp header at all:
 * `addDefaultHeaders` computes `hmac_sha256(secret, payloadContent)` and puts it
 * in `X-Gitea-Signature` (see the module header). A timestamped verifier would
 * reject every delivery a real Gitea instance sends, so this keeps Gitea's
 * actual scheme and keeps the guarantees the brief asked for: an empty secret
 * accepts nothing, a missing / duplicated-array / non-hex / wrong-length header
 * is refused before any comparison, and the comparison is constant-time.
 */
export function verifyGiteaWebhookSignature(
  secret: string,
  signatureHeader: string | string[] | undefined,
  rawBody: Buffer | string,
): boolean {
  return verifyForgejoWebhookSignature(secret, signatureHeader, rawBody);
}

/** The signature a Gitea instance computes for `rawBody` — the signing twin of
 * {@link verifyGiteaWebhookSignature} for fixtures and replay tests. It is never
 * a verification path. */
export function computeGiteaWebhookSignature(secret: string, rawBody: Buffer | string): string {
  return computeForgejoWebhookSignature(secret, rawBody);
}

/** Move Gitea's top-level PR onto `issue.pull_request` so the #728 normalizer
 * takes the issue-origin path the `follow_up` kind requires.
 *
 * The keep-put condition is the SHARED projection's (`issue.pull_request` is
 * already a plain object) narrowed by one test: it must also carry a PR
 * `number`. Anything else — absent, a `PullRequestMeta`, or a malformed
 * non-object — takes the move, so the two projections can only differ on the
 * `number`-less meta this module exists to handle. */
function projectGiteaCommentEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...payload, name: "issue_comment" };
  const topPr = payload.pull_request;
  if (!isPlainObject(topPr)) return projected;

  const issue = payload.issue;
  const issuePr = isPlainObject(issue) ? issue.pull_request : undefined;
  const usableIssuePr = isPlainObject(issuePr) && typeof issuePr.number === "number";
  if (!usableIssuePr) {
    // DELETE the top-level key (not set it to `undefined`) so `resolvePr`
    // takes the issue-origin path.
    delete projected.pull_request;
    projected.issue = { ...(isPlainObject(issue) ? issue : {}), pull_request: topPr };
  }
  return projected;
}

/** The effective trigger label: the operator-configured value, falling back to
 * the "ai-review" default on an absent or EMPTY option — the same `||`
 * convention the #728 normalizer and the precheck use, so the projection and the
 * normalizer can never disagree on which label triggers a re-review. */
function rereviewLabelOf(options: { rereviewLabel?: string }): string {
  return options.rereviewLabel || "ai-review";
}

/** The `label` the projected `labeled` envelope carries. A usable top-level
 * label is passed through UNCHANGED (the normalizer's byte-exact comparison owns
 * that decision). Otherwise the PR's own label list is scanned for a BYTE-EXACT
 * match on the trusted trigger label, and on a match the label is emitted as the
 * trusted constant — never as a copy of payload text — so a hostile label cannot
 * forge the trigger. On no match the sentinel `""` maps to `unknown` downstream. */
function projectedLabel(payload: Record<string, unknown>, rereview: string): unknown {
  const label = payload.label;
  if (typeof label === "string" || (isPlainObject(label) && typeof label.name === "string")) {
    return label;
  }
  const pr = payload.pull_request;
  const labels = isPlainObject(pr) ? pr.labels : undefined;
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      // Only a plain object with a byte-exact string `name` can match; strings,
      // numbers, arrays and nulls are skipped, and a `"__proto__"` entry is just
      // an array element, never a property access.
      if (isPlainObject(entry) && typeof entry.name === "string" && entry.name === rereview) {
        return { name: rereview };
      }
    }
  }
  return "";
}

/** Project one Gitea label delivery onto the canonical `labeled` shape. Gitea
 * sends no top-level `label`, so the trigger comes from the PR's own list. */
function projectGiteaLabelEvent(
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string },
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...payload,
    name: "pull_request",
    action: "labeled",
  };
  projected.label = projectedLabel(payload, rereviewLabelOf(options));
  return projected;
}

/** Project a raw native Gitea delivery onto the GitHub-shaped envelope the #728
 * normalizer accepts.
 *
 * Gitea's grouped header for a PR sync is already `pull_request` (its
 * `HookEventPullRequestSync.Event()` maps into that group), and
 * `pull_request_label` / `pull_request_comment` appear as both group and type
 * values, so the shared projection covers Gitea's vocabulary. This wrapper
 * re-decides only the two families where Gitea's payload shape differs, and
 * delegates everything else, so the two forges cannot drift.
 *
 * Every hint stays gated on the SIGNED `action`, exactly as in
 * `forgejo-events.ts`: a captured terminal delivery replayed with forged sync,
 * label, or comment headers keeps its own signed action. */
export function projectGiteaWebhookPayload(
  eventHeader: string,
  eventTypeHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string } = {},
): Record<string, unknown> {
  const specific = eventTypeHeader !== "" ? eventTypeHeader : eventHeader;
  const group = eventHeader === "pull_request_sync" ? "pull_request" : eventHeader;
  const action = typeof payload.action === "string" ? payload.action : "";

  // The two Gitea branches below read untrusted fields directly, so they are
  // contained: a hostile accessor on `issue` / `pull_request` / `label` degrades
  // to the SHARED projection (which is itself total) rather than escaping this
  // boundary. Without the guard the module's "never throws" claim would hold
  // only by construction.
  try {
    // PR comments. Gitea's `issue_comment` group with a `pull_request_comment`
    // type, and the PR-review-comment group (whose `Event()` is
    // `pull_request_comment`), both become the GitHub `issue_comment` envelope —
    // but only when the signed action is `created`. A non-`created` action falls
    // through to the shared projection, so a forged comment hint can never
    // re-nest a PR into a `follow_up`-shaped `issue.pull_request`.
    if (
      (group === "issue_comment" ||
        eventHeader === "pull_request_comment" ||
        specific === "pull_request_comment") &&
      action === "created"
    ) {
      return projectGiteaCommentEvent(payload);
    }

    // PR label delivery: grouped `pull_request` with a `label_updated` action, or
    // the `pull_request_label` group header. Both are gated on the same signed
    // action, so a label hint on a non-label body degrades to the shared
    // projection's passthrough (which maps to `unknown`).
    if (action === "label_updated" && (group === "pull_request" || eventHeader === "pull_request_label")) {
      return projectGiteaLabelEvent(payload, options);
    }
  } catch {
    // Fall through to the shared projection. It never synthesizes a name this
    // boundary would not have produced, and it never rethrows.
  }

  return projectForgejoWebhookPayload(eventHeader, eventTypeHeader, payload, options);
}

/** Normalize one Gitea webhook body into the canonical event, or `null` when it
 * cannot be resolved. Gitea `issue`-family deliveries carry their own
 * `repository` object, which the normalizer prefers over the PR's base repo, so
 * a payload with no PR still resolves a target repository. A closed PR yields
 * `pr_closed`, and `pr_merged` only when the signed body says the PR merged;
 * neither kind schedules a review generation. Never throws. */
export function parseGiteaWebhookEvent(
  eventHeader: string,
  payload: Record<string, unknown>,
  options: { rereviewLabel?: string; eventTypeHeader?: string } = {},
): CanonicalForgeEvent | null {
  try {
    const normalizeOptions =
      options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel };
    const projected = projectGiteaWebhookPayload(
      eventHeader,
      options.eventTypeHeader ?? "",
      payload,
      normalizeOptions,
    );
    return normalizeForgejoEvent(projected, "webhook", normalizeOptions);
  } catch {
    return null;
  }
}

/** What dispatching one Gitea webhook delivery decided. Fixed, credential-free
 * values: the payload, the secret, and the signature header are never echoed. */
export type GiteaWebhookDispatchOutcome =
  | { readonly status: "accepted"; readonly kind: ForgeEventKind }
  | { readonly status: "ignored" }
  | { readonly status: "invalid-signature" }
  | { readonly status: "invalid-payload" }
  | { readonly status: "error" };

export interface GiteaWebhookDelivery {
  /** The `X-Gitea-Event` header: the GROUPED event name. Shape-guarded by the
   * HTTP layer, and still only an unauthenticated hint. */
  readonly eventHeader: string;
  /** The `X-Gitea-Event-Type` header, or `""` when absent or shape-invalid. */
  readonly eventTypeHeader?: string | undefined;
  /** The `X-Gitea-Signature` header value(s) as received. */
  readonly signatureHeader: string | string[] | undefined;
  /** The RAW request body — the HMAC input. Never a re-serialization. */
  readonly rawBody: Buffer | string;
}

export interface GiteaWebhookDispatchOptions {
  readonly secret: string;
  readonly rereviewLabel?: string | undefined;
  readonly onEvent: (event: CanonicalForgeEvent) => void | Promise<void>;
  /** When present, a canonical `follow_up` delivery goes here INSTEAD of
   * `onEvent` — the same routing seam `webhook-handler.ts` exposes. */
  readonly router?: OperatorEventRouter | undefined;
}

/** Verify, project, normalize, and route one Gitea webhook delivery: the
 * non-HTTP core of the Gitea intake, so the whole intake is testable without a
 * socket and an HTTP handler layered on it cannot grow behavior of its own.
 *
 * The order is load-bearing and fail-closed: the signature is verified over the
 * RAW body BEFORE any `JSON.parse`, so unauthenticated bytes never reach a
 * parser; a permanently unroutable delivery is `ignored` (ack) rather than
 * retried forever; a throwing sink is reported as `error` and never rethrown. */
export async function dispatchGiteaWebhookEvent(
  delivery: GiteaWebhookDelivery,
  options: GiteaWebhookDispatchOptions,
): Promise<GiteaWebhookDispatchOutcome> {
  try {
    if (!verifyGiteaWebhookSignature(options.secret, delivery.signatureHeader, delivery.rawBody)) {
      return { status: "invalid-signature" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof delivery.rawBody === "string" ? delivery.rawBody : delivery.rawBody.toString("utf8"),
      );
    } catch {
      return { status: "invalid-payload" };
    }
    if (!isPlainObject(parsed)) return { status: "invalid-payload" };

    if (delivery.eventHeader === "ping") return { status: "ignored" };

    const event = parseGiteaWebhookEvent(delivery.eventHeader, parsed, {
      ...(options.rereviewLabel === undefined ? {} : { rereviewLabel: options.rereviewLabel }),
      eventTypeHeader: delivery.eventTypeHeader ?? "",
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

/**
 * Node http request handler for Gitea webhook deliveries (#1678).
 *
 * This is the shared native intake — `createForgejoWebhookHandler` — with the
 * Gitea projection substituted for the Forgejo one. Deliberately NOT a copied
 * handler: the security-relevant pipeline (signature verified over the RAW body
 * before any parse, fixed and short response bodies that never echo the payload,
 * secret or signature, the mid-stream size bound with the inbound stream
 * dropped, the shape guards on the two unauthenticated event headers, and the
 * `follow_up` router seam) exists once. A second copy is where a weaker variant
 * of one of those guarantees hides.
 *
 * Same status contract as the Forgejo intake: 405, 400 (bad event header, bad
 * JSON, non-object payload), 413, 401, 200-ignored (`ping`, unroutable), 202
 * accepted with the canonical kind, 500 on a throwing sink.
 */
export function createGiteaWebhookHandler(
  options: Omit<ForgejoWebhookHandlerOptions, "project">,
): (req: IncomingMessage, res: ServerResponse) => void {
  return createForgejoWebhookHandler({ ...options, project: projectGiteaWebhookPayload });
}
