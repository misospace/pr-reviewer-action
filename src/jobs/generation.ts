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
// The single definitions of the follow-up-reference and installation-id
// forms (event↔job contract): the event normalizers and this builder
// share them, so the two layers can never drift. `events` never
// imports `jobs`, so this runtime import creates no cycle.
import { COMMENT_ID_PATTERN, INSTALLATION_ID_PATTERN } from "../events/normalize.js";
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
  /** Operator adoption/config-generation reference layered on the
   * configFingerprint; "" = pre-adoption/absent epoch. */
  readonly adoptionEpoch: string;
  /** The follow-up comment id the follow_up job answers; "" for review
   * jobs (a review's identity never depends on a comment id). */
  readonly eventReference: string;
}

/** Fixed serialization order of the identity fields. The order is part of
 * the id contract: changing it re-keys every job. Appending
 * `adoptionEpoch`/`eventReference` after `nonce` does exactly that —
 * acceptable while the module has no production callers yet. */
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
  "adoptionEpoch",
  "eventReference",
] as const;

/** Canonical identity serialization: a fixed-order `key=value\n` join over
 * the twelve identity fields, each value stringified with `String()`
 * (total over any field value — including a symbol — where a template
 * literal would throw a TypeError). Unlike `computeConfigHash` — which
 * SORTS its lines — the field order here is fixed by `IDENTITY_FIELDS`
 * and is part of the id contract. The per-line keys make the form
 * unambiguous despite values that may contain `=`. */
function canonicalIdentity(identity: GenerationIdentity): string {
  let out = "";
  for (const field of IDENTITY_FIELDS) {
    const value = String(identity[field]);
    out += `${field}=${value}\n`;
  }
  return out;
}

/** Deterministic generation id: sha256 hex over the canonical identity
 * serialization. Same identity (any source, any producing kind) => same
 * id; any identity-field change (new head, new config, new nonce, new
 * adoption epoch, new follow-up comment id, review vs follow_up) => a new
 * id.
 *
 * Returns `""` (a fail-closed sentinel, not a hash) when ANY of the twelve
 * identity values, stringified, contains a `\n` or `\r`: in the
 * `key=value\n` join, a newline inside one value can make two DISTINCT
 * identities serialize to the same byte string (e.g. headSha
 * `"x\nbaseSha=b"` + baseSha `""` vs headSha `"x"` + baseSha
 * `"b\nbaseSha="`), which would collide their job ids. `buildReviewJob`
 * refuses to build a job when this returns `""`.
 *
 * Each value is stringified with `String()` for BOTH the newline check
 * and the serialization (`String()` is total over any field value,
 * including a symbol — a template literal would throw a TypeError), so
 * this function never throws for any primitive field value (a hand-built
 * object with a throwing `toString` is outside that promise;
 * `buildReviewJob` type-checks the fields it hashes). */
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

/** The accepted-type convention (mirrors `normalizeInstallationId` in
 * `src/events/normalize.js`): the value is a string or a number.
 * Anything else (symbol, object, boolean, bigint) is refused, so no
 * untrusted value is ever coerced with `String(...)`. */
function isStringOrNumber(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number";
}

/** A run id for the durable payload: trimmed; "" when empty after trim,
 * longer than 128 chars, or containing a control character. Mirrors
 * `sanitizeDisplay` (`src/events/normalize.js`) — kept module-local so
 * the jobs layer does not import the event boundary's display sanitizer.
 * A non-string value is "" (never stringified into the payload). */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
function sanitizeRunId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 128 || CONTROL_CHAR_PATTERN.test(trimmed)) {
    return "";
  }
  return trimmed;
}

/** A provided nonce must be exactly this: 1–64 chars of
 * `[A-Za-z0-9._-]`. Anything else (including a too-long run of valid
 * chars) is invalid. */
const NONCE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** A provided adoption epoch (the operator adoption/config-generation
 * reference) must be exactly this: 1–64 chars of `[A-Za-z0-9._-]`.
 * Anything else (including a too-long run of valid chars) is invalid. */
const ADOPTION_EPOCH_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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
 * - the builder never throws: every option/event value is type-checked
 *   before it is tested or stored. `headSha`/`baseSha` must be strings;
 *   a provided `nonce`/`adoptionEpoch`/`configFingerprint` and a
 *   `follow_up` `eventReference` must be a string or a number.
 *   Anything else (symbol, object, boolean, bigint) is refused with
 *   `null` before any `String(...)` coercion, so a hostile value can
 *   never raise.
 * - the scoping identity fields are well-formed (the builder's own
 *   fail-closed guard for hand-built events): `platform` is exactly
 *   "github" or "forgejo"; `installationId` is a string and, when
 *   non-empty, matches `INSTALLATION_ID_PATTERN` (the shared canonical
 *   installation-id form imported from the event boundary);
 *   `repoFullName` is a non-empty string; `prNumber` is a safe integer
 *   > 0; `prId` is a safe integer >= 0; `fork` is a boolean. A
 *   cast-away `undefined` in any of them would otherwise serialize as
 *   the literal text "undefined" in the identity and hash identically
 *   to a real value of that text (the same "two distinct tuples, one
 *   id" class the \n/\r guard prevents), so the build fails.
 * - a provided nonce for a review job must match `NONCE_PATTERN`, else
 *   the build fails (never silently emptied into the identity); an EMPTY
 *   nonce is treated as ABSENT (not validated); a non-string value is
 *   stored as `String(...)` after validation, so a type-cast number can
 *   never land in the string field / persisted payload.
 * - a provided `adoptionEpoch` (any job kind) must match
 *   `ADOPTION_EPOCH_PATTERN`, else the build fails (never silently
 *   emptied into the identity); an EMPTY epoch is treated as ABSENT
 *   (not validated, becomes "").
 * - for a `follow_up` job the identity's `eventReference` is the
 *   event's `eventReference`, which must be non-empty and match
 *   `COMMENT_ID_PATTERN` (the shared canonical form, imported from
 *   `src/events/normalize.js`), else the build fails (an
 *   unidentifiable follow-up cannot be safely deduped); for a `review`
 *   job it is forced "" (a review's identity must not depend on a
 *   comment id, even if a stray event carries one). A non-string
 *   value is stored as `String(...)` after validation, so a type-cast
 *   number can never land in the string field / persisted payload.
 * - a non-empty `configFingerprint` must match
 *   `CONFIG_FINGERPRINT_PATTERN`.
 * - a provided `deadlineAtMs` must be a safe integer >= 0.
 * - the `runId` is sanitized (trim; "" when empty after trim, longer
 *   than 128 chars, or containing a control character — mirroring
 *   `sanitizeDisplay` at the adapter boundary; a non-string value is
 *   "") so the durable payload carries a clean reference.
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
    // Accepted type: a string or a number — anything else is refused
    // before the pattern test, so a hostile value can never raise.
    if (!isStringOrNumber(options.nonce)) return null;
    if (!NONCE_PATTERN.test(options.nonce)) return null;
    // Store the STRING form: a type-cast non-string can never land in
    // the string field / persisted payload.
    nonce = String(options.nonce);
  }

  // Unlike the nonce (ignored for follow_up), the adoption epoch is an
  // identity field of every job kind.
  let adoptionEpoch = "";
  if (options.adoptionEpoch) {
    // An empty epoch is ABSENT: only non-empty values are validated.
    // Accepted type: a string or a number — anything else is refused
    // before the pattern test, so a hostile value can never raise.
    if (!isStringOrNumber(options.adoptionEpoch)) return null;
    if (!ADOPTION_EPOCH_PATTERN.test(options.adoptionEpoch)) return null;
    // Store the STRING form: a type-cast non-string can never land in
    // the string field / persisted payload.
    adoptionEpoch = String(options.adoptionEpoch);
  }

  // A follow_up's identity IS the comment it answers: an unidentifiable
  // one cannot be deduped safely. A review job's identity never depends
  // on a comment id.
  let eventReference = "";
  if (kind === "follow_up") {
    // Accepted type: a string or a number — anything else is refused
    // before the pattern test, so a hostile value can never raise.
    if (!isStringOrNumber(event.eventReference)) return null;
    // A number must be a safe integer BEFORE coercion: the same rule the
    // event boundary (src/events) applies to comment.id. An unsafe integer
    // coerces to a "different" comment id (9007199254740993 ->
    // "9007199254740992"), so it is refused, never stored.
    if (
      typeof event.eventReference === "number" &&
      !Number.isSafeInteger(event.eventReference)
    ) {
      return null;
    }
    if (!COMMENT_ID_PATTERN.test(event.eventReference)) return null;
    // Store the STRING form: a type-cast non-string can never land in
    // the string field / persisted payload.
    eventReference = String(event.eventReference);
  }

  // Fail-closed SHA handling for hand-built (non-normalizer) events.
  // A SHA is a string by contract: a cast-away non-string (undefined,
  // a number, a symbol) would make normalizeSha's .trim() throw, so it
  // is refused before normalization.
  if (typeof event.headSha !== "string" || typeof event.baseSha !== "string") {
    return null;
  }
  const headSha = normalizeSha(event.headSha);
  const baseSha = normalizeSha(event.baseSha);
  if (headSha !== "" && !SHA_PATTERN.test(headSha)) return null;
  if (baseSha !== "" && !SHA_PATTERN.test(baseSha)) return null;
  if (kind === "review" && headSha === "") return null;

  // Fail-closed scoping-identity handling for hand-built (non-normalizer)
  // events: a cast-away `undefined` in any of these would serialize as
  // the literal text "undefined" in the identity and hash identically to
  // a real value of that text (the same "two distinct tuples, one id"
  // class the \n/\r guard prevents), so the build must not hash them.
  if (event.platform !== "github" && event.platform !== "forgejo") return null;
  if (typeof event.installationId !== "string") return null;
  if (event.installationId !== "" && !INSTALLATION_ID_PATTERN.test(event.installationId)) {
    return null;
  }
  if (typeof event.repoFullName !== "string" || event.repoFullName === "") return null;
  if (!Number.isSafeInteger(event.prNumber) || event.prNumber <= 0) return null;
  if (!Number.isSafeInteger(event.prId) || event.prId < 0) return null;
  if (typeof event.fork !== "boolean") return null;

  let configFingerprint = options.configFingerprint ?? "";
  // Accepted type: a string or a number — anything else is refused
  // before the pattern test, so a hostile value can never raise.
  if (!isStringOrNumber(configFingerprint)) return null;
  if (configFingerprint !== "" && !CONFIG_FINGERPRINT_PATTERN.test(configFingerprint)) {
    return null;
  }
  // Store the STRING form: a type-cast number can never land in the
  // string field / persisted payload.
  configFingerprint = String(configFingerprint);

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
    adoptionEpoch,
    eventReference,
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
    adoptionEpoch,
    eventReference,
    fork: event.fork,
    deadlineAtMs,
    runId: sanitizeRunId(options.runId),
  });
}
