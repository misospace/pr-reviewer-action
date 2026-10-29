/** Durable control-plane state contracts (#736).
 *
 * The typed records the self-hosted controller persists across restarts:
 * forge installations/profiles (non-secret identity/config references),
 * adopted repositories, runs (the run-level mirror of the #731 job
 * lifecycle), idempotency keys, publication state, and normalized
 * model/tool usage with cost provenance.
 *
 * Like every contract layer before it (#728 events, #731 queue, #733
 * executor), every field is required with an explicit sentinel
 * (`""`/`0`/`false`) — readers never branch on `undefined` — and the
 * module is pure: no I/O, no timers, no clock; callers supply epoch-ms
 * numbers.
 *
 * The validators are the ONE definition of a valid record, shared by
 * every backend (`InMemoryControlPlaneStore` here, the PostgreSQL
 * backend that lands with the daemon) so a persisted record and a
 * freshly built one can never disagree about what a valid identity is.
 * Each validator returns a REBUILT, FROZEN record — unknown extra fields
 * dropped, never the caller's own object — so a loaded snapshot cannot
 * carry a mutable reference to a record whose identity was already
 * validated, and a hostile extra field (e.g. a smuggled `secret` key)
 * cannot ride along into durable state.
 *
 * What is deliberately NOT here (#736 "do not persist"): provider/API
 * secrets, complete prompts/corpora, repository files, model responses
 * beyond the normalized result, and worker filesystem paths that are
 * meaningless after restart. Records carry REFERENCES (config refs,
 * destination ids, credential references) — never material.
 */

import { INSTALLATION_ID_PATTERN } from "../events/normalize.js";
import { containsSecretShapedContent, isCanonicalJsonEncoding } from "../context/redact.js";
import type { JobLifecycleState } from "../queue/types.js";

/** The two platforms the controller knows (mirrors `ReviewJob`). */
export type ControlPlanePlatform = "github" | "forgejo";

/** The run record's review-kind (mirrors `ReviewJobKind`). */
export type RunKind = "review" | "follow_up";

/** Which lane of model/tool work a usage entry accounts for. */
export type UsageRole = "primary" | "specialist" | "tool" | "evidence" | "judge";

/** Where a cost figure came from. `unknown` is the honest default: a
 * self-hosted/local model with no configured price still records tokens
 * and requests, and its cost stays explicitly unknown — never
 * fabricated. */
export type UsageCostProvenance = "provider-reported" | "configured-estimate" | "unknown";

/** Aggregate-only provenance: a row/totals bucket that mixes entries
 * with different provenances cannot claim any single one of them. */
export type AggregatedCostProvenance = UsageCostProvenance | "mixed";

/** A control character (the C0 range plus DEL): never allowed in a
 * persisted identifier or display-ish field. */
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** A git commit SHA: 7–64 lowercase hex chars (the queue store's form). */
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** A non-empty config fingerprint: an 8–64 hex digest (the queue
 * store's form). */
const CONFIG_FINGERPRINT_PATTERN = /^[0-9a-f]{8,64}$/;

/** A nonce / adoption epoch / lease owner: 1–64 chars of
 * `[A-Za-z0-9._-]` (the queue store's form). */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Maximum length of a free-text-but-single-line persisted field. */
const REASON_MAX_CHARS = 256;

/** Maximum length of a publication error / history detail. */
const DETAIL_MAX_CHARS = 2000;

/** Maximum number of history entries a publication record retains;
 * older entries are dropped first. */
export const PUBLICATION_HISTORY_CAP = 32;

/** Maximum length of a publication record's durable result payload.
 * Bounded by the forge write it replays (a GitHub issue comment body is
 * capped at 65536 characters), so a payload the publisher could never
 * send is never persisted. */
export const PUBLICATION_PAYLOAD_MAX_CHARS = 65536;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Every persisted numeric field (epoch ms, counters, attempts) must
 * be a safe integer ≥ 0. Every numeric column is BIGINT and the `pg`
 * driver returns bigint/numeric as strings converted through `Number()`
 * — a value beyond `Number.MAX_SAFE_INTEGER` rounds SILENTLY there, so
 * the validator refuses it (and any non-integer) instead of persisting
 * or adopting a value that cannot round-trip exactly. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlatform(value: unknown): value is ControlPlanePlatform {
  return value === "github" || value === "forgejo";
}

function isRunKind(value: unknown): value is RunKind {
  return value === "review" || value === "follow_up";
}

function isJobLifecycleState(value: unknown): value is JobLifecycleState {
  return (
    value === "queued" ||
    value === "starting" ||
    value === "running" ||
    value === "publishing" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "superseded"
  );
}

function isUsageRole(value: unknown): value is UsageRole {
  return (
    value === "primary" ||
    value === "specialist" ||
    value === "tool" ||
    value === "evidence" ||
    value === "judge"
  );
}

function isCostProvenance(value: unknown): value is UsageCostProvenance {
  return (
    value === "provider-reported" ||
    value === "configured-estimate" ||
    value === "unknown"
  );
}

function isPublicationState(value: unknown): value is "pending" | "published" | "failed" {
  return value === "pending" || value === "published" || value === "failed";
}

/** A persisted identifier: non-empty, bounded, control-char-free, and
 * already trimmed (the queue store's hardening: a whitespace-padded
 * id is refused, never silently normalized). */
function identifier(value: unknown, max: number): string | null {
  if (!isBoundedString(value, max)) return null;
  if (value !== value.trim()) return null;
  if (CONTROL_CHAR_PATTERN.test(value)) return null;
  return value;
}

/** A persisted optional string: `""` (sentinel) or a bounded
 * control-char-free value. */
function optionalIdentifier(value: unknown, max: number): string | null {
  if (value === "") return "";
  return identifier(value, max);
}

// ── shared field validators (the ONE definition, reused by every
// backend's write path so a store can never persist a value its own
// readers would reject) ────────────────────────────────────────────────

/** The `RunRecord.leaseOwner` rule: non-empty, ≤ 64 chars, trimmed,
 * control-char-free. Used by every claim/heartbeat path — an owner the
 * validator rejects must fail the claim, never half-lease the run. */
export function validateLeaseOwner(value: unknown): string | null {
  return identifier(value, 64);
}

/** The claim/heartbeat clock rule: `nowMs` and `ttlMs` must be safe
 * integers (`ttlMs` positive) whose SUM stays a safe integer. A
 * finite-but-unsafe pair would write a lease/expiry the record
 * validator refuses on EVERY later read — a poisoned, permanently
 * unreadable run — so the write boundary refuses it instead. */
export function validateLeaseWindow(
  nowMs: unknown,
  ttlMs: unknown,
): { readonly nowMs: number; readonly leaseExpiresAtMs: number } | null {
  if (!isSafeNonNegativeInteger(nowMs)) return null;
  if (!isSafeNonNegativeInteger(ttlMs) || ttlMs <= 0) return null;
  const leaseExpiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(leaseExpiresAtMs)) return null;
  return { nowMs, leaseExpiresAtMs };
}

/** The patch fields a run transition may carry, rebuilt to ONLY the
 * present keys (a `null`/`undefined` field means "carry over").
 * Returns null when any PRESENT field violates its record rule — the
 * same rule `validateRun` enforces on the stored record, so a patch
 * accepted here can never produce a row the reader rejects. */
export interface RunPatchFields {
  readonly resultHeadSha?: string;
  readonly failureReason?: string;
  readonly supersededByJobId?: string;
}

export function validateRunPatch(patch: RunPatchFields | undefined): RunPatchFields | null {
  if (patch === undefined) return {};
  const rebuilt: { resultHeadSha?: string; failureReason?: string; supersededByJobId?: string } = {};
  if (patch.resultHeadSha !== undefined) {
    const value = shaOrEmpty(patch.resultHeadSha);
    if (value === null) return null;
    rebuilt.resultHeadSha = value;
  }
  if (patch.failureReason !== undefined) {
    const value = optionalIdentifier(patch.failureReason, REASON_MAX_CHARS);
    if (value === null) return null;
    rebuilt.failureReason = value;
  }
  if (patch.supersededByJobId !== undefined) {
    const value = optionalIdentifier(patch.supersededByJobId, 256);
    if (value === null) return null;
    rebuilt.supersededByJobId = value;
  }
  return rebuilt;
}

/** A publication history entry rule check for WRITE paths: returns the
 * rebuilt frozen entry or null when malformed. The writer must bound
 * its own detail BEFORE appending — the reader rejects a record whose
 * history the validator cannot rebuild. */
export function validatePublicationHistoryEntry(value: unknown): PublicationHistoryEntry | null {
  if (!isPlainObject(value)) return null;
  const atMs = value["atMs"];
  if (!isSafeNonNegativeInteger(atMs)) return null;
  const outcome = value["outcome"];
  if (outcome !== "attempt" && outcome !== "published" && outcome !== "failed") {
    return null;
  }
  const detail = optionalIdentifier(value["detail"], DETAIL_MAX_CHARS);
  if (detail === null) return null;
  const entry: PublicationHistoryEntry = Object.freeze({ atMs, outcome, detail });
  return entry;
}

/** A persisted SHA-or-sentinel: `""` or 7–64 lowercase hex. */
function shaOrEmpty(value: unknown): string | null {
  if (value === "") return "";
  if (!isString(value) || !SHA_PATTERN.test(value)) return null;
  return value;
}

/** A persisted config-fingerprint-or-sentinel: `""` or 8–64 hex. */
function fingerprintOrEmpty(value: unknown): string | null {
  if (value === "") return "";
  if (!isString(value) || !CONFIG_FINGERPRINT_PATTERN.test(value)) return null;
  return value;
}

// ── InstallationRecord ──────────────────────────────────────────────────

/** One forge installation/profile binding: the non-secret identity and
 * config REFERENCES the controller needs to act on behalf of an
 * installation. The credential itself never appears here — the #735
 * broker holds secrets behind opaque references, and a record whose
 * identity was validated cannot carry one (extra fields are dropped). */
export interface InstallationRecord {
  readonly installationId: string;
  readonly platform: ControlPlanePlatform;
  /** The operator-approved profile name this installation acts through
   * (executor/model/evidence profile selection is operator config; a
   * repository selects names only). */
  readonly profileName: string;
  /** Display-ish forge account/org login; "" when not yet observed. */
  readonly accountLogin: string;
  /** Opaque reference to the operator-side config describing this
   * installation (never the config material itself, never a secret). */
  readonly configRef: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Validate an unknown value as an `InstallationRecord`; returns a
 * rebuilt, frozen record (extras dropped) or null when malformed. */
export function validateInstallation(value: unknown): InstallationRecord | null {
  if (!isPlainObject(value)) return null;
  const installationId = value["installationId"];
  if (!isString(installationId) || !INSTALLATION_ID_PATTERN.test(installationId)) {
    return null;
  }
  const platform = value["platform"];
  if (!isPlatform(platform)) return null;
  const profileName = identifier(value["profileName"], 128);
  if (profileName === null) return null;
  const accountLogin = optionalIdentifier(value["accountLogin"], 128);
  if (accountLogin === null) return null;
  const configRef = optionalIdentifier(value["configRef"], 256);
  if (configRef === null) return null;
  const createdAtMs = value["createdAtMs"];
  if (!isSafeNonNegativeInteger(createdAtMs)) return null;
  const updatedAtMs = value["updatedAtMs"];
  if (!isSafeNonNegativeInteger(updatedAtMs)) return null;
  const record: InstallationRecord = Object.freeze({
    installationId,
    platform,
    profileName,
    accountLogin,
    configRef,
    createdAtMs,
    updatedAtMs,
  });
  return record;
}

// ── AdoptedRepositoryRecord ─────────────────────────────────────────────

/** One adopted repository: the controller only reviews repositories an
 * operator adopted (#727); the adoption is durable state, not process
 * memory. */
export interface AdoptedRepositoryRecord {
  readonly platform: ControlPlanePlatform;
  readonly installationId: string;
  readonly repoFullName: string;
  /** The adoption epoch active when the repository was adopted/changed
   * (the #727 config fingerprint's adoption component). */
  readonly adoptionEpoch: string;
  /** The effective reviewer-config fingerprint at adoption time. */
  readonly configFingerprint: string;
  /** The last head fingerprint the controller observed for the
   * repository default branch; "" = unknown. */
  readonly headFingerprint: string;
  readonly enabled: boolean;
  readonly adoptedAtMs: number;
  readonly updatedAtMs: number;
}

/** Validate an unknown value as an `AdoptedRepositoryRecord`; returns a
 * rebuilt, frozen record (extras dropped) or null when malformed. */
export function validateAdoptedRepository(value: unknown): AdoptedRepositoryRecord | null {
  if (!isPlainObject(value)) return null;
  const platform = value["platform"];
  if (!isPlatform(platform)) return null;
  const installationId = value["installationId"];
  if (!isString(installationId) || !INSTALLATION_ID_PATTERN.test(installationId)) {
    return null;
  }
  const repoFullName = identifier(value["repoFullName"], 256);
  if (repoFullName === null) return null;
  const adoptionEpoch = value["adoptionEpoch"];
  if (!isString(adoptionEpoch) || !TOKEN_PATTERN.test(adoptionEpoch)) return null;
  const configFingerprint = value["configFingerprint"];
  if (!isString(configFingerprint) || !CONFIG_FINGERPRINT_PATTERN.test(configFingerprint)) {
    return null;
  }
  const headFingerprint = shaOrEmpty(value["headFingerprint"]);
  if (headFingerprint === null) return null;
  const enabled = value["enabled"];
  if (!isBoolean(enabled)) return null;
  const adoptedAtMs = value["adoptedAtMs"];
  if (!isSafeNonNegativeInteger(adoptedAtMs)) return null;
  const updatedAtMs = value["updatedAtMs"];
  if (!isSafeNonNegativeInteger(updatedAtMs)) return null;
  const record: AdoptedRepositoryRecord = Object.freeze({
    platform,
    installationId,
    repoFullName,
    adoptionEpoch,
    configFingerprint,
    headFingerprint,
    enabled,
    adoptedAtMs,
    updatedAtMs,
  });
  return record;
}

// ── RunRecord ───────────────────────────────────────────────────────────

/** One run: the run-level mirror of a #731 job generation. The queue's
 * `JobRecord` remains the scheduling truth for dispatch; the run record
 * is the durable control-plane account of the WORK — executor identity,
 * worker lease/heartbeat, fingerprints, and lifecycle timestamps — that
 * must survive a controller restart and answer "what did this run do".
 *
 * The state mirrors the queue's eight lifecycle states (same table,
 * enforced via `canTransition` from `../queue/types.js` — one
 * definition, no drift). */
export interface RunRecord {
  readonly runId: string;
  readonly jobId: string;
  readonly kind: RunKind;
  readonly state: JobLifecycleState;
  /** The executor backend identity that owns/produced this run
   * (e.g. "local:v1"); a reference, never host paths. */
  readonly executorIdentity: string;
  /** Attempts started so far (>= 0) — mirrors `JobRecord.attempt`. */
  readonly attempt: number;
  /** The head SHA this run reviews; "" for follow-ups without a head. */
  readonly headSha: string;
  /** The effective reviewer-config fingerprint the run used; "" when
   * not yet computed. */
  readonly configFingerprint: string;
  /** Worker lease holder; "" = unleased. */
  readonly leaseOwner: string;
  /** Worker lease expiry epoch ms; 0 = unleased. A restarted
   * controller treats an expired lease as an abandoned worker. */
  readonly leaseExpiresAtMs: number;
  /** Head SHA of the durable structured result; "" until completed. */
  readonly resultHeadSha: string;
  /** Terminal explanation; "" unless terminal. */
  readonly failureReason: string;
  /** jobId of the generation that superseded this run; "" unless
   * superseded (mirrors `JobRecord.supersededByJobId`). */
  readonly supersededByJobId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** First dispatch epoch ms; 0 = never started. */
  readonly startedAtMs: number;
  /** Terminal-transition epoch ms; 0 = not terminal. */
  readonly finishedAtMs: number;
}

/** Validate an unknown value as a `RunRecord`; returns a rebuilt,
 * frozen record (extras dropped) or null when malformed. */
export function validateRun(value: unknown): RunRecord | null {
  if (!isPlainObject(value)) return null;
  const runId = identifier(value["runId"], 128);
  if (runId === null) return null;
  const jobId = identifier(value["jobId"], 256);
  if (jobId === null) return null;
  const kind = value["kind"];
  if (!isRunKind(kind)) return null;
  const state = value["state"];
  if (!isJobLifecycleState(state)) return null;
  const executorIdentity = identifier(value["executorIdentity"], 128);
  if (executorIdentity === null) return null;
  const attempt = value["attempt"];
  if (!isSafeNonNegativeInteger(attempt)) return null;
  const headSha = shaOrEmpty(value["headSha"]);
  if (headSha === null) return null;
  const configFingerprint = fingerprintOrEmpty(value["configFingerprint"]);
  if (configFingerprint === null) return null;
  const leaseOwner = optionalIdentifier(value["leaseOwner"], 64);
  if (leaseOwner === null) return null;
  const leaseExpiresAtMs = value["leaseExpiresAtMs"];
  if (!isSafeNonNegativeInteger(leaseExpiresAtMs)) return null;
  const resultHeadSha = shaOrEmpty(value["resultHeadSha"]);
  if (resultHeadSha === null) return null;
  const failureReason = optionalIdentifier(value["failureReason"], REASON_MAX_CHARS);
  if (failureReason === null) return null;
  const supersededByJobId = optionalIdentifier(value["supersededByJobId"], 256);
  if (supersededByJobId === null) return null;
  const createdAtMs = value["createdAtMs"];
  if (!isSafeNonNegativeInteger(createdAtMs)) return null;
  const updatedAtMs = value["updatedAtMs"];
  if (!isSafeNonNegativeInteger(updatedAtMs)) return null;
  const startedAtMs = value["startedAtMs"];
  if (!isSafeNonNegativeInteger(startedAtMs)) return null;
  const finishedAtMs = value["finishedAtMs"];
  if (!isSafeNonNegativeInteger(finishedAtMs)) return null;
  const record: RunRecord = Object.freeze({
    runId,
    jobId,
    kind,
    state,
    executorIdentity,
    attempt,
    headSha,
    configFingerprint,
    leaseOwner,
    leaseExpiresAtMs,
    resultHeadSha,
    failureReason,
    supersededByJobId,
    createdAtMs,
    updatedAtMs,
    startedAtMs,
    finishedAtMs,
  });
  return record;
}

/** Build a fresh `RunRecord` with sentinels everywhere and `createdAtMs
 * = updatedAtMs = nowMs`. Throws RangeError on a non-finite nowMs
 * (fail closed).
 *
 * `attempt` mirrors the queue's attempt counter for the run (the attempt
 * that is about to start); it defaults to 0 when the caller does not
 * know it yet. */
export function newRunRecord(
  input: {
    readonly runId: string;
    readonly jobId: string;
    readonly kind: RunKind;
    readonly executorIdentity: string;
    readonly headSha: string;
    readonly configFingerprint: string;
    readonly attempt?: number;
  },
  nowMs: number,
): RunRecord {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new RangeError(`nowMs must be a finite number, got ${String(nowMs)}`);
  }
  const attempt = input.attempt ?? 0;
  if (!isSafeNonNegativeInteger(attempt)) {
    throw new RangeError(`attempt must be a safe non-negative integer, got ${String(attempt)}`);
  }
  const seeded = validateRun({
    runId: input.runId,
    jobId: input.jobId,
    kind: input.kind,
    state: "queued",
    executorIdentity: input.executorIdentity,
    attempt,
    headSha: input.headSha,
    configFingerprint: input.configFingerprint,
    leaseOwner: "",
    leaseExpiresAtMs: 0,
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    startedAtMs: 0,
    finishedAtMs: 0,
  });
  if (seeded === null) {
    throw new RangeError("newRunRecord: input failed record validation");
  }
  return seeded;
}

// ── IdempotencyKeyRecord ────────────────────────────────────────────────

/** One idempotency key: the durable "this request already happened"
 * marker. A webhook delivery and a reconciliation poll that observe the
 * same head converge because both claim the same key; a redelivery
 * after a controller crash replays against the stored binding instead
 * of doing the work twice. */
export interface IdempotencyKeyRecord {
  readonly key: string;
  /** The work the key is bound to (e.g. the generation/job id). */
  readonly binding: string;
  readonly createdAtMs: number;
  /** Expiry epoch ms; 0 = never expires. An expired key may be
   * re-claimed by different work. */
  readonly expiresAtMs: number;
}

/** Validate an unknown value as an `IdempotencyKeyRecord`; returns a
 * rebuilt, frozen record (extras dropped) or null when malformed. */
export function validateIdempotencyKey(value: unknown): IdempotencyKeyRecord | null {
  if (!isPlainObject(value)) return null;
  const key = identifier(value["key"], 256);
  if (key === null) return null;
  const binding = identifier(value["binding"], 256);
  if (binding === null) return null;
  const createdAtMs = value["createdAtMs"];
  if (!isSafeNonNegativeInteger(createdAtMs)) return null;
  const expiresAtMs = value["expiresAtMs"];
  if (!isSafeNonNegativeInteger(expiresAtMs)) return null;
  const record: IdempotencyKeyRecord = Object.freeze({
    key,
    binding,
    createdAtMs,
    expiresAtMs,
  });
  return record;
}

// ── PublicationRecord ───────────────────────────────────────────────────

/** One entry of a publication record's retry history. */
export interface PublicationHistoryEntry {
  readonly atMs: number;
  readonly outcome: "attempt" | "published" | "failed";
  /** Single-line detail (error text, destination note); "" = none. */
  readonly detail: string;
}

/** One publication: the durable forge-write state that lets a
 * restarted controller RETRY the forge write without rerunning the
 * model. The record carries the forge destination reference, the
 * DURABLE result content itself (`resultPayload` — the publisher's
 * canonical JSON encoding of the normalized review result; required,
 * because metadata alone cannot be republished), and the publication
 * id once confirmed. */
export interface PublicationRecord {
  readonly jobId: string;
  readonly publicationState: "pending" | "published" | "failed";
  /** Opaque forge write reference (e.g. "github-comment:<id>");
   * identifies WHERE the write goes, never a credential. */
  readonly destination: string;
  /** The forge-confirmed publication id; "" until the write lands. */
  readonly publicationId: string;
  /** Publication attempts so far (0 = never attempted). */
  readonly attempt: number;
  /** Last error text (single-line, bounded); "" when none. */
  readonly lastError: string;
  /** The head the durable result belongs to (staleness anchor). */
  readonly resultHeadSha: string;
  /** The durable content to write — canonical `JSON.stringify` of the
   * normalized review result, so it is single-line and control-char
   * free. Required non-empty: a publication record exists precisely to
   * make the write resumable, and one without its payload could only
   * be retried by rerunning the model. */
  readonly resultPayload: string;
  /** Bounded retry history (oldest dropped first beyond the cap). */
  readonly history: readonly PublicationHistoryEntry[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** Validate an unknown value as a `PublicationRecord`; returns a
 * rebuilt, frozen record (extras dropped, history capped) or null when
 * malformed. */
export function validatePublication(value: unknown): PublicationRecord | null {
  if (!isPlainObject(value)) return null;
  const jobId = identifier(value["jobId"], 256);
  if (jobId === null) return null;
  const publicationState = value["publicationState"];
  if (!isPublicationState(publicationState)) return null;
  const destination = identifier(value["destination"], 256);
  if (destination === null) return null;
  const publicationId = optionalIdentifier(value["publicationId"], 256);
  if (publicationId === null) return null;
  const attempt = value["attempt"];
  if (!isSafeNonNegativeInteger(attempt)) return null;
  const lastError = optionalIdentifier(value["lastError"], DETAIL_MAX_CHARS);
  if (lastError === null) return null;
  const resultHeadSha = shaOrEmpty(value["resultHeadSha"]);
  if (resultHeadSha === null) return null;
  const resultPayload = identifier(value["resultPayload"], PUBLICATION_PAYLOAD_MAX_CHARS);
  if (resultPayload === null) return null;
  // The payload is the CANONICAL JSON encoding of the normalized review
  // result — parseability is part of the contract, not an optimization, and
  // it is what makes the secret-shape check below total: a hostile payload
  // cannot escape it by not being JSON. (It also pins what "arbitrary text
  // is accepted" used to leave open: a payload that is not the encoding the
  // publisher replays is malformed, whatever it contains.)
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(resultPayload);
  } catch {
    return null;
  }
  if (!isPlainObject(parsedPayload)) return null;
  // Canonical-encoding requirement (structural): the durable bytes must be
  // EXACTLY the canonical JSON encoding of the object parsed from them (the
  // one definition shared with the secret-shape detector). The parse is lossy
  // otherwise — duplicate keys keep only the LAST occurrence — so a payload
  // like `{"x":"ghp_…","x":"ok"}` parses to a value with no credential shape
  // while the credential stays in the bytes this record persists and the
  // publisher replays. Refused, never normalized: the payload contract IS the
  // canonical encoding, so bytes that are not canonical are malformed
  // whatever they contain.
  if (!isCanonicalJsonEncoding(resultPayload, parsedPayload)) return null;
  // Secret-free durable boundary: the payload is the content the publisher
  // replays verbatim to the forge, so a credential shape here would be both
  // persisted and re-published. The upstream render pipeline redacts before
  // a payload ever reaches a writer; this check refuses (never normalizes)
  // when that invariant was not upheld. The detector is the producer's own
  // sanitizer re-applied (fixed-point test), so an already-sanitized payload
  // — including redaction markers and reference-shaped values — passes
  // unchanged, and legitimate verdict-content keys (e.g. the
  // `secret_handling_changes` category) are never refused. Documented
  // bounds: JSON nesting deeper than the redactor's depth cap is refused
  // even when benign, and encoded (base64/hex) secret echoes are out of
  // shape-detection scope.
  if (containsSecretShapedContent(resultPayload)) return null;
  const rawHistory = value["history"];
  if (!Array.isArray(rawHistory)) return null;
  const history: PublicationHistoryEntry[] = [];
  for (const element of rawHistory) {
    const entry = validatePublicationHistoryEntry(element);
    if (entry === null) return null;
    history.push(entry);
  }
  const createdAtMs = value["createdAtMs"];
  if (!isSafeNonNegativeInteger(createdAtMs)) return null;
  const updatedAtMs = value["updatedAtMs"];
  if (!isSafeNonNegativeInteger(updatedAtMs)) return null;
  // The cap is enforced by the validator too: a persisted record beyond
  // the cap is malformed (the writer, not the reader, drops oldest).
  if (history.length > PUBLICATION_HISTORY_CAP) return null;
  const record: PublicationRecord = Object.freeze({
    jobId,
    publicationState,
    destination,
    publicationId,
    attempt,
    lastError,
    resultHeadSha,
    resultPayload,
    history: Object.freeze(history),
    createdAtMs,
    updatedAtMs,
  });
  return record;
}

// ── UsageRecord ─────────────────────────────────────────────────────────

/** One normalized usage entry: durable product state for run-level
 * token/request/cost accounting — NOT raw prompt retention. The
 * `usageId` is the caller-supplied idempotency identity (e.g.
 * `<runId>:<seq>`): re-recording an identical entry is a no-op, so a
 * controller restart or publication retry can replay the accounting
 * without double-counting. */
export interface UsageRecord {
  readonly usageId: string;
  readonly runId: string;
  /** The model/tool route the usage belongs to (e.g. a profile name or
   * route id). */
  readonly route: string;
  readonly role: UsageRole;
  /** Model/tool requests issued (>= 1). */
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /** Cost in micros of the provider's currency unit; 0 = none
   * reported/computed. */
  readonly costMicros: number;
  readonly costProvenance: UsageCostProvenance;
  readonly recordedAtMs: number;
}

/** Validate an unknown value as a `UsageRecord`; returns a rebuilt,
 * frozen record (extras dropped) or null when malformed. The cost
 * invariant is enforced here: `unknown` provenance means NO cost basis,
 * so the cost must be exactly 0 — a fabricated cost can never enter
 * durable state dressed as unknown. */
export function validateUsage(value: unknown): UsageRecord | null {
  if (!isPlainObject(value)) return null;
  const usageId = identifier(value["usageId"], 256);
  if (usageId === null) return null;
  const runId = identifier(value["runId"], 128);
  if (runId === null) return null;
  const route = identifier(value["route"], 128);
  if (route === null) return null;
  const role = value["role"];
  if (!isUsageRole(role)) return null;
  const requestCount = value["requestCount"];
  if (!isSafeNonNegativeInteger(requestCount) || requestCount < 1) return null;
  const inputTokens = value["inputTokens"];
  if (!isSafeNonNegativeInteger(inputTokens)) return null;
  const cacheReadTokens = value["cacheReadTokens"];
  if (!isSafeNonNegativeInteger(cacheReadTokens)) return null;
  const cacheWriteTokens = value["cacheWriteTokens"];
  if (!isSafeNonNegativeInteger(cacheWriteTokens)) return null;
  const outputTokens = value["outputTokens"];
  if (!isSafeNonNegativeInteger(outputTokens)) return null;
  const costMicros = value["costMicros"];
  if (!isSafeNonNegativeInteger(costMicros)) return null;
  const costProvenance = value["costProvenance"];
  if (!isCostProvenance(costProvenance)) return null;
  if (costProvenance === "unknown" && costMicros !== 0) return null;
  const recordedAtMs = value["recordedAtMs"];
  if (!isSafeNonNegativeInteger(recordedAtMs)) return null;
  const record: UsageRecord = Object.freeze({
    usageId,
    runId,
    route,
    role,
    requestCount,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    costMicros,
    costProvenance,
    recordedAtMs,
  });
  return record;
}
