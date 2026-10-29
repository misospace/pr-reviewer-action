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
 * The forge write itself is an injected `ForgeWriteCapability` the daemon
 * binds from the platform layer (`src/platform/`, the GitHub App client or
 * the Forgejo client). No forge CLI exists anywhere in this path, and no
 * credential material ever appears in a record, a payload, or a log line —
 * `destination` is an opaque forge-write reference, and the payload is
 * validated secret-free by the control plane's own boundary
 * (`validatePublication` refuses, never normalizes, a payload that is not
 * a fixed point of the producer's verdict-content sanitizer).
 *
 * Terminal semantics: `published` and a refused-as-stale/expired result
 * both return `true` (the queue record settles; a stale result must never
 * be retried forever against a moved head — the durable publication record
 * explains why nothing was written). A forge failure returns `false`: the
 * scheduler retries later, and the retry path reads the payload from the
 * durable record — the worker's artifact file is consulted exactly once.
 */

import { join } from "node:path";
import type { ReviewJob } from "../jobs/types.js";
import { gateJobPublication } from "../ingress/dispatch.js";
import type { JobPublisher } from "../queue/scheduler.js";
import type { JobRecord } from "../queue/types.js";
import { containsSecretShapedContent } from "../context/redact.js";
import type {
  ControlPlaneStore,
  PublicationRecord,
  StateMutation,
  UsageCostProvenance,
  UsageRecord,
  UsageRole,
} from "../state/index.js";
import { proveContained, readBoundedFileNoFollow } from "../executor/paths.js";
import {
  executionResultPath,
  executionRunId,
  executionRunDir,
} from "./execution.js";

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

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

/** Outcome of reading the worker's result artifact for publication. */
type ArtifactOutcome =
  | { readonly kind: "ok"; readonly payload: string; readonly usage: readonly UsageRecord[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Read the worker's structured result file (the `./execution.js` layout)
 * and canonicalize it into the durable payload. Containment is proven, the
 * read is no-follow and byte-capped, the correlation identity is checked
 * against the layout-derived run id, and the raw bytes must already BE the
 * canonical encoding of the object they parse to (a duplicate-key payload
 * that hides content behind a lossy parse is refused, never adopted). A
 * planted or foreign file is never adopted as a publication payload. */
async function readResultPayload(
  runsRoot: string,
  jobId: string,
  attempt: number,
  nowMs: number,
): Promise<ArtifactOutcome> {
  const runDir = executionRunDir(runsRoot, jobId, attempt);
  const resultPath = executionResultPath(runsRoot, jobId, attempt);
  const proof = await proveContained(runDir, resultPath);
  if (!proof.contained) {
    return { kind: "unavailable", reason: "result artifact path is not provably contained" };
  }
  const read = await readBoundedFileNoFollow(resultPath, 1_048_576);
  if (read.kind === "missing") {
    return { kind: "unavailable", reason: "worker result artifact is missing" };
  }
  if (read.kind === "invalid") {
    return { kind: "unavailable", reason: "worker result artifact is unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { kind: "unavailable", reason: "worker result artifact is not JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { kind: "unavailable", reason: "worker result artifact is not a JSON object" };
  }
  const expectedRunId = executionRunId(jobId, attempt);
  if (parsed["runId"] !== expectedRunId || parsed["jobId"] !== jobId) {
    return { kind: "unavailable", reason: "worker result artifact belongs to another run" };
  }
  // Canonical single-line encoding of exactly the object that was parsed:
  // the durable bytes and the replayed bytes are the same thing, and the
  // duplicate-key hiding trick is structurally impossible.
  const canonical = JSON.stringify(parsed);
  if (canonical !== read.text) {
    return { kind: "unavailable", reason: "worker result artifact is not canonical JSON" };
  }
  if (containsSecretShapedContent(canonical)) {
    return { kind: "unavailable", reason: "worker result artifact carries secret-shaped content" };
  }
  const rawUsage = parsed["usage"];
  const usage: UsageRecord[] = [];
  if (rawUsage !== undefined) {
    if (!Array.isArray(rawUsage)) {
      return { kind: "unavailable", reason: "worker result artifact usage is not a list" };
    }
    for (let index = 0; index < rawUsage.length; index += 1) {
      const entry = rawUsage[index];
      const record = isPlainObject(entry)
        ? usageRecordFrom(entry, expectedRunId, index, nowMs)
        : null;
      // Fail closed: an artifact whose usage attestation is malformed is
      // an untrustworthy artifact — no publication rides on it.
      if (record === null) {
        return { kind: "unavailable", reason: "worker result artifact carries an invalid usage entry" };
      }
      usage.push(record);
    }
  }
  return { kind: "ok", payload: canonical, usage };
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
  return {
    async publish(record: JobRecord): Promise<boolean> {
      if (record === null || typeof record !== "object") return false;
      // Only a publishing record holding its durable result can publish.
      if (record.state !== "publishing" || record.resultHeadSha === "") return false;
      const nowMs = deps.now();
      const jobId = record.job.jobId;
      const existing = await deps.store.getPublication(jobId);
      if (existing !== null && existing.publicationState === "published") {
        // Already on the forge: a replayed publish call is a no-op, never
        // a second write.
        return true;
      }
      let payload: string;
      let usage: readonly UsageRecord[];
      if (existing !== null && existing.resultPayload !== "") {
        payload = existing.resultPayload;
        usage = [];
      } else {
        const artifact = await readResultPayload(deps.runsRoot, jobId, record.attempt, nowMs);
        if (artifact.kind === "unavailable") {
          // No durable publication record exists yet (resultPayload is
          // REQUIRED, so a record cannot be written without its payload):
          // the retry path simply tries the artifact read again once the
          // worker's run directory is intact. Nothing is persisted and
          // nothing is published on an unprovable artifact.
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
