/** The daemon's durable publication path (#1348): the `JobPublisher` seam
 * the #731 scheduler calls when a record reaches `publishing`.
 *
 * The issue's contract: "persist the normalized structured result and
 * usage before forge side effects; enforce current-generation/exact-head
 * publication gates; retry publication from durable state without
 * rerunning the model; keep usage accounting idempotent across
 * retries/restarts." This module implements exactly that over the two
 * seams that already exist:
 *
 * - the #736 control plane (`ControlPlaneStore`) holds the
 *   `PublicationRecord` — including the REQUIRED durable `resultPayload`
 *   (canonical JSON of the normalized result) — so a retry after a crash
 *   or a forge hiccup replays the WRITE, never the review;
 * - the #728/#730 exact-head gate (`gateJobPublication`) decides whether a
 *   result may publish at all: an expired or stale-head result is never
 *   written over the current head.
 *
 * WHAT IS PUBLISHED. The published content is the worker's structured
 * REVIEW artifact — the coordinate the executor's own result contract
 * names (`ExecutionResult.resultArtifactPath`: "path of the worker's
 * structured review-result artifact; the publication layer consumes
 * this, not stdout"). The `result.json` envelope beside it is the
 * EXECUTION wrapper (status, correlation identity, artifact path), never
 * the review itself: publishing the wrapper would persist execution
 * metadata where the review belongs. The envelope is therefore READ and
 * VALIDATED (the executor's own `validateExecutionResult`, so a foreign
 * correlation identity, an unknown field, or an artifact path outside the
 * run directory is refused), and the artifact it names is read
 * (bounded, no-follow, proven contained) and canonicalized into the
 * durable payload.
 *
 * The forge write itself is an injected `ForgeWriteCapability` the daemon
 * binds from the platform layer (`src/platform/`, the GitHub App client or
 * the Forgejo client). No forge CLI exists anywhere in this path, and no
 * credential material ever appears in a record, a payload, or a log line —
 * `destination` is an opaque forge-write reference, and the payload is
 * validated secret-free by the control plane's own boundary
 * (`validatePublication` refuses, never normalizes, a payload that is not
 * a fixed point of the producer's verdict-content sanitizer).
 *
 * Terminal semantics: `published`, a refused-as-stale/expired result, and
 * a deterministic size refusal (#1558) all return `true` (the queue record
 * settles; a stale result must never be retried forever against a moved
 * head — the durable publication record explains why nothing was written).
 * So does a persisted publication record that fails the CURRENT record
 * validator (#1561): a pre-fix record whose `resultPayload` passes its
 * write-time validation but fails a rule added since is refused by the
 * boundary on every replay — no attempt can be recorded against it (the
 * mutation revalidates the whole record and throws), the payload must not
 * be replayed, and the record is exempt from the queue's deadline/expiry
 * settlement — so the publisher settles it terminally here, and the run's
 * account carries the durable explanation.
 * A `publishing` record holding its durable result is exempt from the
 * queue's deadline/expiry settlement and publication retries carry no
 * terminal attempt limit, so the size refusals — which no retry can fix,
 * the artifact's bytes are final once the worker completed — are settled
 * HERE; returning `false` for one would strand the record in `publishing`
 * forever. A forge failure returns `false`: the
 * scheduler retries later, and the retry path reads the payload from the
 * durable record — the worker's artifact file is consulted exactly once.
 *
 * ENVELOPE REFUSALS (#1560): a `publishing` record holding its durable
 * result is exempt from the queue's deadline/expiry settlement and
 * publication retries carry no terminal attempt limit, so a retry-later
 * `false` on a refusal that no retry can fix strands the record forever.
 * The envelope read therefore splits its failures: a CONTENT verdict on a
 * fully read envelope (not JSON, contract-invalid, a foreign correlation
 * identity, a non-completed status, or a head that disagrees with the
 * queue record) is provably permanent — the worker wrote the envelope
 * once before it settled, and the queue reached `publishing` only because
 * the executor already read that same envelope successfully, so a retry
  * re-reads identical bytes — and settles TERMINALLY. An I/O-class
  * failure (absent, unreadable, not provably
 * contained) genuinely mixes transient causes (a mount that will return,
 * a momentary filesystem error) with permanent ones (the run directory
 * was garbage-collected), so it stays retry-later but BOUNDED: after
 * `MAX_ENVELOPE_READ_ATTEMPTS` consecutive failed reads of the same run's
 * envelope it settles terminally too. Both terminal classes follow the
 * stale/expired settlement contract above: the queue record settles and
 * the run's durable account closes as failed. The bound counts
 * consecutive failures inside one controller process: a restart resets
 * it, so a stable controller converges on the terminal answer while a
 * crash-loop (a different outage) may re-run the bound once per restart.
 */

import type { ReviewJob } from "../jobs/types.js";
import { gateJobPublication } from "../ingress/dispatch.js";
import { isTerminalState } from "../queue/index.js";
import type { JobPublisher } from "../queue/scheduler.js";
import type { JobRecord } from "../queue/types.js";
import { containsSecretShapedContent } from "../context/redact.js";
import {
  PUBLICATION_PAYLOAD_MAX_CHARS,
  StateRecordValidationError,
  validatePublication,
  type ControlPlaneStore,
  type PublicationRecord,
  type StateMutation,
  type UsageCostProvenance,
  type UsageRecord,
  type UsageRole,
} from "../state/index.js";
import { proveContained, readBoundedFileNoFollow } from "../executor/paths.js";
import { durableResultPayloadFitsCeiling } from "./forge-capability.js";
import {
  MAX_EXECUTION_RESULT_FILE_BYTES,
  validateExecutionResult,
  type ExecutionResult,
} from "../executor/index.js";
import {
  executionResultPath,
  executionRunId,
  executionRunDir,
} from "./execution.js";
import { mirrorRunTransition } from "./run-lifecycle.js";
import { isPlainObject } from "../platform/object.js";

/** The forge write seam the daemon binds from the platform capability.
 * The payload is the durable canonical JSON the record persisted; the
 * capability renders it onto the forge and reports the forge-confirmed
 * publication id. */
export interface ForgeWriteCapability {
  publish(input: { readonly job: ReviewJob; readonly resultPayload: string }): Promise<{
    readonly publicationId: string;
  }>;
}

export interface DurablePublisherDeps {
  readonly store: ControlPlaneStore;
  readonly forge: ForgeWriteCapability;
  /** Current PR head on the forge; `null` = unreadable (the gate fails
   * closed — a result never publishes when freshness cannot be proven). */
  currentHeadSha(job: ReviewJob): Promise<string | null>;
  /** The controller-owned runs root; re-derives the worker's result
   * artifact via the `./execution.js` layout (the same layout the request
   * builder wrote). */
  readonly runsRoot: string;
  now(): number;
}

/** One usage entry the worker's result artifact MAY carry. An artifact
 * without usage records none — usage is never fabricated (#736: cost
 * provenance is never invented). Fields stay unknown-typed here: the
 * validation below is the only thing that makes one a UsageRecord. */
type RawUsageEntry = Record<string, unknown>;

const USAGE_ROLES: readonly string[] = ["primary", "specialist", "tool", "evidence", "judge"];

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Bounded single-line text for durable diagnostics: control characters
 * and newlines collapsed, length capped, so a hostile forge/worker string
 * can neither bloat nor forge structure in durable state. */
function boundedDetail(value: string, cap: number): string {
  const singleLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (singleLine.length <= cap) return singleLine;
  return `${singleLine.slice(0, Math.max(0, cap - 1))}…`;
}

/** Outcome of reading the worker's review artifact for publication.
 * `unavailable` is retry-later (the bytes may not be readable yet; the
 * queue settles the record only through expiry/supersession); `refused`
 * is terminal for content that can NEVER be published (a deterministic
 * size overflow — the worker's bytes are final once it completed, so no
 * retry changes the answer); `ok` carries the durable payload. */
type ArtifactOutcome =
  | { readonly kind: "ok"; readonly payload: string; readonly usage: readonly UsageRecord[] }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/** Outcome of reading the EXECUTION envelope (#1560). `transient` is the
 * I/O class — absent, unreadable, not provably contained — which mixes
 * transient and permanent causes, so it is retried (bounded) rather than
 * judged. `refused` is a CONTENT verdict on a fully read envelope:
 * provably permanent, terminal. */
type EnvelopeOutcome =
  | { readonly kind: "ok"; readonly result: ExecutionResult }
  | { readonly kind: "transient"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

/** Consecutive I/O-class envelope-read failures tolerated for one run
 * before the publication settles terminally (#1560). Generous enough to
 * ride out a remount or a transient filesystem error at any sane publish
 * backoff, bounded enough that a garbage-collected run directory stops
 * spinning identical failing reads. */
export const MAX_ENVELOPE_READ_ATTEMPTS = 10;

/** Hard bound on the number of runs whose consecutive-failure streaks the
 * publisher tracks at once: a publishing record retired between ticks
 * (superseded, cancelled) leaves its streak entry behind, so the map is
 * capped. An entry is NEVER dropped to make room — dropping an ACTIVE
 * streak resets it toward the bound, and once more runs fail concurrently
 * than the cap holds, every streak could be reset before reaching it and
 * the records would spin forever instead of converging. When the map is
 * full, entries whose run is provably retired are reclaimed first (see
 * `pruneRetiredEnvelopeReadFailures`); if nothing can be reclaimed the
 * new failure stays retry-later UNTRACKED. That spin is bounded by
 * construction: tracked streaks are never reset by eviction, so every
 * tracked run reaches `MAX_ENVELOPE_READ_ATTEMPTS` and frees its slot,
 * and the untracked run is admitted (and converges) as soon as one is. */
export const MAX_TRACKED_ENVELOPE_READ_FAILURES = 128;

/** Admission outcome of counting one transient envelope-read failure:
 * either the run's consecutive-failure streak after this read, or a
 * full-map saturation with nothing provably retired to reclaim. */
type EnvelopeReadFailureAdmission =
  | { readonly state: "tracked"; readonly streak: number }
  | { readonly state: "saturated" };

/** Count one transient envelope-read failure for `runId`: an existing
 * streak is incremented; a new run is admitted at 1 when the map has
 * capacity. A full map first reclaims provably-retired entries; still
 * full, the failure is reported `saturated` (retry-later, untracked).
 * Entries for successful or terminal reads are removed by the caller. */
async function noteEnvelopeReadFailure(
  store: ControlPlaneStore,
  failures: Map<string, number>,
  runId: string,
): Promise<EnvelopeReadFailureAdmission> {
  const current = failures.get(runId);
  if (current !== undefined) {
    const streak = current + 1;
    failures.set(runId, streak);
    return { state: "tracked", streak };
  }
  if (failures.size >= MAX_TRACKED_ENVELOPE_READ_FAILURES) {
    await pruneRetiredEnvelopeReadFailures(store, failures);
  }
  if (failures.size >= MAX_TRACKED_ENVELOPE_READ_FAILURES) {
    return { state: "saturated" };
  }
  failures.set(runId, 1);
  return { state: "tracked", streak: 1 };
}

/** Drop streak entries whose run record is TERMINAL — the only
 * PROOF of retirement: the run has no durable account left for the
 * publisher to settle, and the daemon's reconcile pass mirrors every
 * retired queue record's run to a terminal state, so retirement residue
 * becomes reclaimable at the latest by the next full-map sweep.
 *
 * An entry whose run is non-terminal is NEVER dropped: that is the
 * active-streak guarantee the bound converges on. An ABSENT run record
 * is kept too — absence is not proof of retirement (the daemon creates
 * the run record before the worker launches, so on a healthy control
 * plane retired residue is terminal, never absent; an absent record
 * means the durable state itself diverged, e.g. a restore that lost the
 * run rows while the queue still retries publication), and the sweep
 * fires on every admission while saturated — far more often than any
 * one record retries — so dropping absent entries would reset every
 * active streak in rotation and never heal, the exact spin this sweep
 * exists to prevent. A diverged control plane therefore degrades to
 * "no capacity reclaims until the tracked cohort converges" (tracked
 * streaks advance and settle on their own), never to a reset rotator.
 * An unreadable run record is kept for the same reason — uncertain
 * state is never treated as proof of retirement. */
async function pruneRetiredEnvelopeReadFailures(
  store: ControlPlaneStore,
  failures: Map<string, number>,
): Promise<void> {
  const runIds = [...failures.keys()];
  const retired = await Promise.all(
    runIds.map(async (trackedRunId) => {
      try {
        const run = await store.getRun(trackedRunId);
        return run !== null && isTerminalState(run.state);
      } catch {
        return false;
      }
    }),
  );
  for (let index = 0; index < runIds.length; index += 1) {
    if (retired[index]) failures.delete(runIds[index]!);
  }
}

/** Read the EXECUTION envelope the worker wrote (`<runDir>/result.json`)
 * and validate it against the executor's own result contract (#733).
 *
 * The envelope is the correlation record: it names the review artifact
 * (`resultArtifactPath`) the publication consumes. It is validated with
 * the executor's OWN validator — an unknown field, a foreign correlation
 * identity, or an artifact path outside the run directory is refused
 * here, never normalized.
 *
 * The failure taxonomy is #1560's: I/O outcomes are `transient` (retry
 * later, bounded by the caller's attempt counter) because their presence
 * can change between reads; a CONTENT verdict on a fully read envelope is
 * `refused` (terminal) because it cannot. The permanence argument is the
 * queue's own ordering: the record reached `publishing` with a durable
 * result only because the executor read and validated THIS envelope
 * (`status: "completed"`) before settling, so the file was complete at
 * settle time and nothing in the daemon ever rewrites it — a content
 * failure now proves the bytes were changed after completion or the file
 * was swapped, and every retry re-reads the same broken content. */
async function readExecutionEnvelope(
  runsRoot: string,
  jobId: string,
  attempt: number,
): Promise<EnvelopeOutcome> {
  const runDir = executionRunDir(runsRoot, jobId, attempt);
  const envelopePath = executionResultPath(runsRoot, jobId, attempt);
  const proof = await proveContained(runDir, envelopePath);
  if (!proof.contained) {
    // A failed proof is presence-uncertain (it also covers a directory
    // that does not resolve), so it joins the bounded transient class
    // rather than the permanent one.
    return { kind: "transient", reason: "execution result envelope is not provably contained" };
  }
  const read = await readBoundedFileNoFollow(envelopePath, MAX_EXECUTION_RESULT_FILE_BYTES);
  if (read.kind === "missing") {
    return { kind: "transient", reason: "worker execution result envelope is missing" };
  }
  if (read.kind === "too-large") {
    return { kind: "transient", reason: "worker execution result envelope is too large" };
  }
  if (read.kind === "invalid") {
    return { kind: "transient", reason: "worker execution result envelope is unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: "refused", reason: "worker execution result envelope is not JSON" };
  }
  let result: ExecutionResult;
  try {
    result = validateExecutionResult(parsed, { runDir });
  } catch {
    return { kind: "refused", reason: "worker execution result envelope is invalid" };
  }
  if (result.runId !== executionRunId(jobId, attempt) || result.jobId !== jobId) {
    return { kind: "refused", reason: "worker execution result envelope belongs to another run" };
  }
  if (result.status !== "completed") {
    return { kind: "refused", reason: "worker execution result envelope is not a completed result" };
  }
  return { kind: "ok", result };
}

/** Read the worker's structured REVIEW artifact — the coordinate the
 * validated execution result names — and canonicalize it into the
 * durable payload.
 *
 * Containment is proven against the run directory (no symlink, no hard
 * link, canonical directory inside the run dir), the read is no-follow
 * and byte-capped, and the payload is the CANONICAL encoding of exactly
 * the object that was parsed: the durable bytes and the replayed bytes
 * are the same thing, and the duplicate-key hiding trick is structurally
 * impossible (the parse keeps only the LAST occurrence, and the
 * published bytes ARE that parse). The usage attestation rides on the
 * review artifact; a malformed entry refuses the whole publication
 * (an untrustworthy attestation is no attestation). */
async function readReviewArtifact(
  runsRoot: string,
  jobId: string,
  attempt: number,
  artifactPath: string,
  runId: string,
  nowMs: number,
): Promise<ArtifactOutcome> {
  const runDir = executionRunDir(runsRoot, jobId, attempt);
  const proof = await proveContained(runDir, artifactPath);
  if (!proof.contained) {
    return { kind: "unavailable", reason: "review artifact path is not provably contained" };
  }
  const read = await readBoundedFileNoFollow(artifactPath, PUBLICATION_PAYLOAD_MAX_CHARS);
  if (read.kind === "missing") {
    return { kind: "unavailable", reason: "worker review artifact is missing" };
  }
  if (read.kind === "too-large") {
    // The dominant oversized shape: the artifact FILE exceeds the payload
    // byte cap. The read proves it on the same descriptor, and the
    // worker completed before the record reached `publishing`, so this
    // is final — a retry-later `false` here would strand the record in
    // `publishing` forever (the class of bug #1558's review caught).
    return {
      kind: "refused",
      reason: "worker review artifact is too large to publish (file exceeds the publication byte cap)",
    };
  }
  if (read.kind === "invalid") {
    return { kind: "unavailable", reason: "worker review artifact is unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: "unavailable", reason: "worker review artifact is not JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "unavailable", reason: "worker review artifact is not a JSON object" };
  }
  const canonical = JSON.stringify(parsed);
  // The payload contract, pinned directly at the payload (not only at
  // the read). Effectively unreachable after the byte-capped read —
  // EXCEPT through canonical re-encoding growth: JSON can serialize
  // longer than its source for number forms (`1e21` → `1e+21`, `.5` →
  // `0.5`), so a file at the byte cap can canonicalize past the char
  // cap. Terminal for the same reason: the bytes are final.
  if (canonical.length > PUBLICATION_PAYLOAD_MAX_CHARS) {
    return {
      kind: "refused",
      reason: "worker review artifact is too large to publish (canonical form exceeds the payload cap)",
    };
  }
  // #1558: the payload's own ceiling is EXACTLY the forge comment ceiling,
  // so a payload at its bound overflows the comment the publisher renders
  // around it (marker + fences), and the forge refuses the oversized
  // comment — the whole publication lost. Refuse such an artifact here,
  // before a durable record is created for a payload that can never be
  // written: the refusal is a bounded local reason, and no oversized body
  // is ever persisted, rendered, or sent. It is TERMINAL (`refused`, not
  // retry-later): the worker completed, so its bytes are final and no
  // retry can shrink them, while a `publishing`-with-result record is
  // exempt from the queue's expiry settlement and publication retries have
  // no terminal attempt limit — a `false` here would strand the record in
  // `publishing` forever. The publisher settles it: the queue record
  // completes and the run account closes as failed with this reason; no
  // durable publication record is created, because the payload cannot be
  // persisted by contract and there is nothing to replay. A payload
  // already persisted by a pre-fix record is out of reach here; the
  // publisher's replay branch settles that record terminally with the
  // same fit check (`durableResultPayloadFitsCeiling`), and the render
  // guard in `forge-capability.ts` stays the fail-closed backstop.
  if (!durableResultPayloadFitsCeiling(canonical)) {
    return { kind: "refused", reason: "worker review artifact does not fit the comment ceiling it would publish inside" };
  }
  if (containsSecretShapedContent(canonical)) {
    return { kind: "unavailable", reason: "worker review artifact carries secret-shaped content" };
  }
  const usage = usageRecordsFrom(parsed, runId, nowMs);
  if (usage === null) {
    return { kind: "unavailable", reason: "worker review artifact carries an invalid usage entry" };
  }
  return { kind: "ok", payload: canonical, usage };
}

/** The publication artifact of one attempt: the validated execution
 * envelope (which names the review artifact) and the review artifact
 * itself. The envelope's head must agree with the queue record's
 * durable head: two different heads mean the artifact on disk is not
 * the result the queue is publishing — and BOTH sides are durable and
 * immutable once the record holds its result, so the disagreement can
 * never resolve on a retry: it is terminal (#1560).
 *
 * `envelopeReadFailures` counts consecutive I/O-class envelope-read
 * failures per run (keyed by the run id, the exact envelope being read);
 * a successful envelope read clears the streak, and a streak reaching
 * `MAX_ENVELOPE_READ_ATTEMPTS` converts the transient failure into a
 * terminal refusal so a garbage-collected run directory stops spinning
 * identical failing reads against the expiry-exempt record. A full
 * tracking map never resets an active streak (see
 * `MAX_TRACKED_ENVELOPE_READ_FAILURES`): a failure that cannot be
 * admitted stays retry-later untracked. */
async function readPublicationArtifact(
  store: ControlPlaneStore,
  runsRoot: string,
  jobId: string,
  attempt: number,
  resultHeadSha: string,
  nowMs: number,
  envelopeReadFailures: Map<string, number>,
): Promise<ArtifactOutcome> {
  const runId = executionRunId(jobId, attempt);
  const envelope = await readExecutionEnvelope(runsRoot, jobId, attempt);
  if (envelope.kind === "refused") {
    // A permanent content verdict retires any transient streak residue
    // for this run: the publication settles now, and the entry would
    // otherwise linger until a full-map sweep proves the run retired.
    envelopeReadFailures.delete(runId);
    return { kind: "refused", reason: envelope.reason };
  }
  if (envelope.kind === "transient") {
    const admission = await noteEnvelopeReadFailure(store, envelopeReadFailures, runId);
    if (admission.state === "saturated") {
      // Every slot holds an active, unresettable streak: this failure is
      // honestly retry-later, and the wait is bounded because each
      // tracked streak reaches its own terminal bound and frees its slot.
      return {
        kind: "unavailable",
        reason: boundedDetail(
          `worker execution result envelope is unreadable and envelope-failure tracking is at its ${String(MAX_TRACKED_ENVELOPE_READ_FAILURES)}-run capacity (last: ${envelope.reason})`,
          256,
        ),
      };
    }
    if (admission.streak >= MAX_ENVELOPE_READ_ATTEMPTS) {
      envelopeReadFailures.delete(runId);
      return {
        kind: "refused",
        reason: boundedDetail(
          `worker execution result envelope remained unreadable after ${String(MAX_ENVELOPE_READ_ATTEMPTS)} publication attempts (last: ${envelope.reason})`,
          256,
        ),
      };
    }
    return { kind: "unavailable", reason: envelope.reason };
  }
  envelopeReadFailures.delete(runId);
  if (envelope.result.resultHeadSha !== resultHeadSha) {
    return { kind: "refused", reason: "execution result envelope head disagrees with the queue record" };
  }
  return readReviewArtifact(
    runsRoot,
    jobId,
    attempt,
    envelope.result.resultArtifactPath,
    envelope.result.runId,
    nowMs,
  );
}

/** The usage entries the worker's review artifact MAY carry. An artifact
 * without usage records none — usage is never fabricated (#736: cost
 * provenance is never invented). A malformed entry refuses the whole
 * batch: fail closed. */
function usageRecordsFrom(
  parsed: Record<string, unknown>,
  runId: string,
  nowMs: number,
): UsageRecord[] | null {
  const rawUsage = parsed["usage"];
  if (rawUsage === undefined) return [];
  if (!Array.isArray(rawUsage)) return null;
  const usage: UsageRecord[] = [];
  for (let index = 0; index < rawUsage.length; index += 1) {
    const entry = rawUsage[index];
    const record = isPlainObject(entry)
      ? usageRecordFrom(entry, runId, index, nowMs)
      : null;
    if (record === null) return null;
    usage.push(record);
  }
  return usage;
}

function usageRecordFrom(entry: RawUsageEntry, runId: string, index: number, nowMs: number): UsageRecord | null {
  const route = typeof entry.route === "string" && entry.route !== "" ? entry.route : null;
  const role = typeof entry.role === "string" && (USAGE_ROLES as readonly string[]).includes(entry.role)
    ? entry.role as UsageRole
    : null;
  if (route === null || role === null) return null;
  if (
    !isSafeNonNegativeInteger(entry.requestCount) ||
    entry.requestCount < 1 ||
    !isSafeNonNegativeInteger(entry.inputTokens) ||
    !isSafeNonNegativeInteger(entry.cacheReadTokens) ||
    !isSafeNonNegativeInteger(entry.cacheWriteTokens) ||
    !isSafeNonNegativeInteger(entry.outputTokens) ||
    !isSafeNonNegativeInteger(entry.costMicros)
  ) {
    return null;
  }
  const provenance = entry.costProvenance;
  if (
    provenance !== "provider-reported" &&
    provenance !== "configured-estimate" &&
    provenance !== "unknown"
  ) {
    return null;
  }
  // The store's validator enforces the same invariant; refusing here keeps
  // a fabricated figure out of the batch entirely.
  if (provenance === "unknown" && entry.costMicros !== 0) return null;
  const record: UsageRecord = {
    usageId: `${runId}:${index}`,
    runId,
    route,
    role,
    requestCount: entry.requestCount,
    inputTokens: entry.inputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    outputTokens: entry.outputTokens,
    costMicros: entry.costMicros,
    costProvenance: provenance as UsageCostProvenance,
    recordedAtMs: nowMs,
  };
  return record;
}

/** The durable publisher. One instance serves the whole controller. */
export function createDurablePublisher(deps: DurablePublisherDeps): JobPublisher {
  if (deps === null || typeof deps !== "object") {
    throw new TypeError("DurablePublisherDeps must be an object");
  }
  if (
    typeof deps.store !== "object" ||
    deps.store === null ||
    typeof deps.forge !== "object" ||
    deps.forge === null ||
    typeof deps.forge.publish !== "function" ||
    typeof deps.currentHeadSha !== "function" ||
    typeof deps.now !== "function"
  ) {
    throw new TypeError("DurablePublisherDeps: store, forge.publish, currentHeadSha and now are required");
  }
  /** Consecutive I/O-class envelope-read failures per run id (#1560).
   * In-process state with a hard cardinality bound
   * (`MAX_TRACKED_ENVELOPE_READ_FAILURES`): entries are cleared on any
   * successful envelope read and on the terminal settlement, and a
   * full-map sweep drops only provably-retired runs — an active streak
   * is never reset, so every tracked run converges on the bound. */
  const envelopeReadFailures = new Map<string, number>();
  return {
    async publish(record: JobRecord): Promise<boolean> {
      if (record === null || typeof record !== "object") return false;
      // Only a publishing record holding its durable result can publish.
      if (record.state !== "publishing" || record.resultHeadSha === "") return false;
      const nowMs = deps.now();
      const jobId = record.job.jobId;
      let existing: PublicationRecord | null;
      try {
        existing = await deps.store.getPublication(jobId);
      } catch (err) {
        // #1561: a backend that revalidates a persisted record at READ
        // time (the PostgreSQL backend's row mapper) throws the typed
        // error when the stored bytes fail the CURRENT validator — a
        // deterministic refusal (the bytes are final), so the replay can
        // never succeed and the record is exempt from the queue's
        // expiry settlement. Settle it terminally here, exactly like the
        // replay-branch refusal below; any other store failure is a
        // transient retry-later and keeps propagating.
        if (err instanceof StateRecordValidationError) {
          const detail = "persisted publication record fails the current record validator";
          await mirrorRunTransition(
            deps.store,
            executionRunId(jobId, record.attempt),
            "failed",
            { nowMs: deps.now(), patch: { failureReason: detail } },
          );
          return true;
        }
        throw err;
      }
      if (existing !== null && existing.publicationState === "published") {
        // Already on the forge: a replayed publish call is a no-op, never
        // a second write.
        return true;
      }
      let payload: string;
      let usage: readonly UsageRecord[];
      if (existing !== null && existing.resultPayload !== "") {
        // #1561: a pre-fix record may fail the CURRENT record validator —
        // its resultPayload passed the write-time validation of an older
        // binary but fails a rule added since (the canonical-encoding or
        // secret-shape checks). The boundary refuses the payload on every
        // replay, so NO mutation that routes through the validator can
        // ever succeed on this record: `record-publication-attempt` throws
        // "next record failed validation" (the exact throw this branch
        // used to let propagate into an unbounded retry-later — a
        // `publishing`-with-result record is exempt from expiry settlement
        // and publication retries have no attempt cap), and the record
        // cannot be rewritten either, because every persisted form
        // carrying this payload is refused. The size verdict on the
        // durable bytes is deterministic, so the refusal is terminal:
        // the queue record settles and the run's account closes as failed
        // with the bounded reason — the same terminal-refusal contract as
        // the stale/expired outcomes below. No attempt is recorded: the
        // mutation itself would throw, and the stale record stays as the
        // durable evidence the boundary refused it.
        if (validatePublication(existing) === null) {
          const detail =
            "persisted publication record fails the current record validator";
          await mirrorRunTransition(
            deps.store,
            executionRunId(jobId, record.attempt),
            "failed",
            { nowMs: deps.now(), patch: { failureReason: detail } },
          );
          return true;
        }
        // A pre-fix record may hold a payload that can never render inside
        // the comment ceiling (#1558): the renderer would throw, the catch
        // below would record another attempt, and the retry would repeat
        // forever — a `publishing`-with-result record is exempt from
        // expiry settlement and publication retries have no attempt cap.
        // The size verdict on the durable bytes is deterministic (the
        // persisted payload is final), so the refusal is terminal here
        // too: the durable record closes as failed with the bounded
        // reason and the run's account closes with it — the same
        // terminal-refusal contract as the stale/expired outcomes below.
        if (!durableResultPayloadFitsCeiling(existing.resultPayload)) {
          const detail =
            "persisted result payload does not fit the comment ceiling it would publish inside";
          await deps.store.apply([
            {
              kind: "record-publication-attempt",
              jobId,
              atMs: deps.now(),
              outcome: "failed",
              detail,
            },
          ]);
          await mirrorRunTransition(
            deps.store,
            executionRunId(jobId, record.attempt),
            "failed",
            { nowMs: deps.now(), patch: { failureReason: detail } },
          );
          return true;
        }
        payload = existing.resultPayload;
        usage = [];
      } else {
        const artifact = await readPublicationArtifact(
          deps.store,
          deps.runsRoot,
          jobId,
          record.attempt,
          record.resultHeadSha,
          nowMs,
          envelopeReadFailures,
        );
        if (artifact.kind === "refused") {
          // #1558: a deterministic size refusal is terminal — the
          // artifact's bytes are final, and a `publishing`-with-result
          // record is exempt from expiry settlement, so `false` here
          // would retry the identical read forever. Settle the queue
          // record (`true`) and close the run's account as failed with
          // the bounded reason. No durable publication record is
          // created: resultPayload is REQUIRED non-empty and this
          // payload can never be persisted or replayed. The run record
          // is the durable explanation on the daemon path (it always
          // exists — created before the worker launches); a missing or
          // already-terminal run makes the mirror a no-op, and the
          // queue's own terminal record remains.
          await mirrorRunTransition(
            deps.store,
            executionRunId(jobId, record.attempt),
            "failed",
            { nowMs: deps.now(), patch: { failureReason: artifact.reason } },
          );
          return true;
        }
        if (artifact.kind === "unavailable") {
          // No durable publication record exists yet (resultPayload is
          // REQUIRED, so a record cannot be written without its payload):
          // the retry path simply tries the artifact read again once the
          // worker's run directory is intact. Nothing is persisted and
          // nothing is published on an unprovable artifact. Envelope
          // reads in this class are already bounded
          // (`MAX_ENVELOPE_READ_ATTEMPTS`, converted to `refused` above);
          // review-artifact unavailability keeps its unbounded
          // retry-later contract (#1560 scopes the bound to the
          // envelope).
          return false;
        }
        payload = artifact.payload;
        usage = artifact.usage;
      }
      const destination = boundedDetail(
        `${record.job.platform}:${record.job.repoFullName}#${record.job.prNumber}`,
        256,
      );
      const createdAtMs = existing !== null ? existing.createdAtMs : nowMs;
      // The attempt count is owned by `record-publication-attempt` (and by
      // the published put below); the initial record starts at 0.
      const attemptNo = existing !== null ? existing.attempt : 0;
      const recordToPersist: PublicationRecord = {
        jobId,
        publicationState: "pending",
        destination,
        publicationId: existing !== null ? existing.publicationId : "",
        attempt: attemptNo,
        lastError: "",
        resultHeadSha: record.resultHeadSha,
        resultPayload: payload,
        history: existing !== null ? existing.history : [],
        createdAtMs,
        updatedAtMs: nowMs,
      };
      const usageRecords: UsageRecord[] = [...usage];
      // Persist BEFORE the forge side effect: a crash between this batch
      // and the write leaves a resumable record, never a rerun.
      const batch: StateMutation[] = [
        { kind: "put-publication", record: recordToPersist },
      ];
      for (const entry of usageRecords) {
        batch.push({ kind: "record-usage", entry });
      }
      try {
        await deps.store.apply(batch);
      } catch {
        // Durable persistence failed: no forge side effect may follow.
        return false;
      }
      // Freshness next: an UNREADABLE head (a transient forge failure) is
      // a retry-later, not a terminal refusal — the gate's own `stale`
      // outcome is reserved for a PROVEN newer head.
      const currentHead = await deps.currentHeadSha(record.job);
      if (currentHead === null) {
        // "attempt" (not "failed"): the record stays pending — a transient
        // forge read failure is a retry-later, and the history entry is
        // the durable explanation.
        await deps.store.apply([
          {
            kind: "record-publication-attempt",
            jobId,
            atMs: nowMs,
            outcome: "attempt",
            detail: "current head unreadable",
          },
        ]);
        return false;
      }
      try {
        const gate = await gateJobPublication({
          job: record.job,
          resultHeadSha: record.resultHeadSha,
          fetchCurrentHeadSha: async () => currentHead,
          publish: async () => {
            const written = await deps.forge.publish({ job: record.job, resultPayload: payload });
            const publishedRecord: PublicationRecord = {
              ...recordToPersist,
              publicationState: "published",
              publicationId: boundedDetail(written.publicationId, 256),
              attempt: attemptNo + 1,
              updatedAtMs: deps.now(),
            };
            await deps.store.apply([{ kind: "put-publication", record: publishedRecord }]);
          },
          nowMs,
        });
        if (gate.status === "published") {
          // The run's own account closes here: the result is on the forge.
          await mirrorRunTransition(
            deps.store,
            executionRunId(jobId, record.attempt),
            "completed",
            {
              nowMs: deps.now(),
              patch: { resultHeadSha: record.resultHeadSha },
            },
          );
          return true;
        }
        // Stale/expired: terminal refusals. The queue record settles
        // (true); the durable record explains why nothing was written —
        // `record-publication-attempt` with outcome "failed" sets the
        // publication state and `lastError` itself.
        const detail = gate.status === "stale" ? "stale-head" : "expired";
        await deps.store.apply([
          {
            kind: "record-publication-attempt",
            jobId,
            atMs: deps.now(),
            outcome: "failed",
            detail,
          },
        ]);
        // The run's account closes as failed: the work produced a result
        // that was provably refused, and nothing was published.
        await mirrorRunTransition(
          deps.store,
          executionRunId(jobId, record.attempt),
          "failed",
          { nowMs: deps.now(), patch: { failureReason: detail } },
        );
        return true;
      } catch (err) {
        // A forge-write rejection PROPAGATES through the gate by contract
        // ("the caller owns retry"); here the caller IS the publisher: the
        // failure is recorded durably (as an attempt — the record stays
        // pending) and the publish is retried later from the record —
        // never by rerunning the model.
        const message = err instanceof Error ? err.message : String(err);
        await deps.store.apply([
          {
            kind: "record-publication-attempt",
            jobId,
            atMs: deps.now(),
            outcome: "attempt",
            detail: boundedDetail(message, 256),
          },
        ]);
        return false;
      }
    },
  };
}
