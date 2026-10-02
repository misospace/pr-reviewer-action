/** ReviewJob generation (#728): the deterministic id and the fail-closed
 * event→job construction.
 *
 * `deriveGenerationId` hashes ONLY the identity fields of a job. Source/
 * trigger and the producing event kind (reason) are deliberately NOT
 * identity fields: a webhook observation and a reconciliation-poll
 * observation of the same head under the same effective config must
 * dedupe to ONE job, and which event kind happened to produce it is
 * routing metadata, not identity.
 */

import { createHash } from "node:crypto";
import type { CanonicalForgeEvent, ForgeEventKind } from "../events/types.js";
import type { BuildJobOptions, ReviewJob, ReviewJobKind } from "./types.js";

/** The exact fields the generation id is a function of. */
export interface GenerationIdentity {
  readonly platform: "github" | "forgejo";
  readonly installationId: string;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly prId: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly configFingerprint: string;
  readonly kind: ReviewJobKind;
  /** "" except a manual forced rereview; always "" for follow_up jobs. */
  readonly nonce: string;
}

/** Fixed serialization order of the identity fields. The order is part of
 * the id contract: changing it re-keys every job. */
const IDENTITY_FIELDS = [
  "platform",
  "installationId",
  "repoFullName",
  "prNumber",
  "prId",
  "headSha",
  "baseSha",
  "configFingerprint",
  "kind",
  "nonce",
] as const;

/** Canonical identity serialization: a fixed-order `key=value\n` join over
 * the ten identity fields. Unlike `computeConfigHash` — which SORTS its
 * lines — the field order here is fixed by `IDENTITY_FIELDS` and is part
 * of the id contract. The per-line keys make the form unambiguous despite
 * values that may contain `=`. */
function canonicalIdentity(identity: GenerationIdentity): string {
  let out = "";
  for (const field of IDENTITY_FIELDS) {
    out += `${field}=${identity[field]}\n`;
  }
  return out;
}

/** Deterministic generation id: sha256 hex over the canonical identity
 * serialization. Same identity (any source, any producing kind) => same
 * id; any identity-field change (new head, new config, new nonce, review
 * vs follow_up) => a new id.
 *
 * Returns `""` (a fail-closed sentinel, not a hash) when ANY of the ten
 * identity values, stringified, contains a `\n` or `\r`: in the
 * `key=value\n` join, a newline inside one value can make two DISTINCT
 * identities serialize to the same byte string (e.g. headSha
 * `"x\nbaseSha=b"` + baseSha `""` vs headSha `"x"` + baseSha
 * `"b\nbaseSha="`), which would collide their job ids. `buildReviewJob`
 * refuses to build a job when this returns `""`. */
export function deriveGenerationId(identity: GenerationIdentity): string {
  for (const field of IDENTITY_FIELDS) {
    if (/\n|\r/.test(String(identity[field]))) return "";
  }
  return createHash("sha256").update(canonicalIdentity(identity), "utf8").digest("hex");
}

/** Kinds that never produce a job. Scheduling policy lives in
 * `schedule.ts`; this refusal is defense in depth — a job for a terminal
 * or unreviewable kind would be unreviewable by construction, so
 * `buildReviewJob` must not be able to mint one even if a caller bypasses
 * the scheduler. */
const NO_JOB_KINDS: ReadonlySet<ForgeEventKind> = new Set<ForgeEventKind>([
  "pr_closed",
  "pr_merged",
  "installation_change",
  "visibility_change",
  "unknown",
]);

/** A git commit SHA: 7–64 hex chars (GitHub/Forgejo send 40). The
 * normalizers enforce this at the adapter boundary; the builder re-checks
 * it as its own fail-closed guard for hand-built events. */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** A non-empty config fingerprint: an 8–64 hex digest. */
const CONFIG_FINGERPRINT_PATTERN = /^[0-9a-f]{8,64}$/;

/** Trim + lowercase (the builder's own SHA normalization). */
function normalizeSha(sha: string): string {
  return sha.trim().toLowerCase();
}

/** A provided nonce must be exactly this: 1–64 chars of
 * `[A-Za-z0-9._-]`. Anything else (including a too-long run of valid
 * chars) is invalid. */
const NONCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Build the immutable job a canonical event spawns, or `null` when the
 * event produces no job. Returns a frozen object.
 *
 * Rules:
 * - `follow_up` events become `follow_up` jobs; the nonce is IGNORED for
 *   them (a valid nonce is dropped, an invalid one does not fail) so
 *   Q&A can never bump a review generation.
 * - `pr_closed` / `pr_merged` / `installation_change` /
 *   `visibility_change` / `unknown` produce no job (see
 *   `NO_JOB_KINDS`).
 * - headSha/baseSha are normalized (trim + lowercase) and any
 *   non-empty one must match `SHA_PATTERN`; the job carries the
 *   normalized values. review jobs additionally require a non-empty
 *   `headSha` (fail closed). The normalizers already enforce the SHA
 *   form at the adapter boundary; this is the builder's own fail-closed
 *   guard for hand-built events.
 * - a provided nonce for a review job must match `NONCE_PATTERN`, else
 *   the build fails (never silently emptied into the identity); an EMPTY
 *   nonce is treated as ABSENT (not validated).
 * - a non-empty `configFingerprint` must match
 *   `CONFIG_FINGERPRINT_PATTERN`.
 * - a provided `deadlineAtMs` must be a safe integer >= 0.
 * - the build fails when `deriveGenerationId` returns `""` (an identity
 *   value containing a `\n`/`\r`).
 */
export function buildReviewJob(
  event: CanonicalForgeEvent,
  options: BuildJobOptions = {},
): ReviewJob | null {
  const kind: ReviewJobKind = event.kind === "follow_up" ? "follow_up" : "review";

  if (event.kind !== "follow_up" && NO_JOB_KINDS.has(event.kind)) return null;

  let nonce = "";
  if (kind === "review" && options.nonce) {
    // An empty nonce is ABSENT: only non-empty values are validated.
    if (!NONCE_PATTERN.test(options.nonce)) return null;
    nonce = options.nonce;
  }

  // Fail-closed SHA handling for hand-built (non-normalizer) events.
  const headSha = normalizeSha(event.headSha);
  const baseSha = normalizeSha(event.baseSha);
  if (headSha !== "" && !SHA_PATTERN.test(headSha)) return null;
  if (baseSha !== "" && !SHA_PATTERN.test(baseSha)) return null;
  if (kind === "review" && headSha === "") return null;

  const configFingerprint = options.configFingerprint ?? "";
  if (configFingerprint !== "" && !CONFIG_FINGERPRINT_PATTERN.test(configFingerprint)) {
    return null;
  }

  const deadlineAtMs = options.deadlineAtMs ?? 0;
  if (
    options.deadlineAtMs !== undefined &&
    (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0)
  ) {
    return null;
  }

  const jobId = deriveGenerationId({
    platform: event.platform,
    installationId: event.installationId,
    repoFullName: event.repoFullName,
    prNumber: event.prNumber,
    prId: event.prId,
    headSha,
    baseSha,
    configFingerprint,
    kind,
    nonce,
  });
  if (jobId === "") return null;

  return Object.freeze({
    jobId,
    kind,
    trigger: event.source,
    reason: event.kind,
    platform: event.platform,
    installationId: event.installationId,
    repoFullName: event.repoFullName,
    prNumber: event.prNumber,
    prId: event.prId,
    headSha,
    baseSha,
    configFingerprint,
    nonce,
    fork: event.fork,
    deadlineAtMs,
    runId: options.runId ?? "",
  });
}
