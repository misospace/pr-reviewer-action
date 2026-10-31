/** Store-backed reference adapter for the operator MCP seam (#1349).
 *
 * Composes the #736 durable control-plane store and the #731 queue snapshot
 * store into `ControllerMcpDeps`: the queue snapshot supplies the forge
 * identity join (platform, repository, PR number) the run records do not
 * carry, the control plane supplies runs, publications, and adoption
 * records, and the publication payload is projected through the bounded
 * #1349 projection.
 *
 * This is a reference composition, not the only one: the daemon may supply
 * its own deps (a PostgreSQL backend should push the joins into SQL rather
 * than scanning). Authorization FAILS CLOSED everywhere: a thrown store
 * read or a thrown authorize seam is a refusal, never a permission, and a
 * run whose repository cannot be PROVEN from the queue snapshot is unread —
 * the identifier itself never grants permission.
 */
import { parsePayloadProjection } from "./projection.js";
import type { ControllerMcpDeps, McpAuthorizeInput, McpFindingView, McpPlatform, McpPolicyView, McpReviewView } from "./types.js";
import { MAX_MCP_LIST_JOBS_SCANNED, validateMcpCursor } from "./types.js";
import type { JobRecord } from "../queue/types.js";
import type { QueueSnapshot } from "../queue/store.js";
import type { ControlPlaneStore, StateExport } from "../state/store.js";

export interface StoreBackedMcpInput {
  readonly controlPlane: ControlPlaneStore;
  readonly queue: { readonly load: () => QueueSnapshot };
  /** Default authorization: the repository must appear as an adopted,
   * enabled record for the platform in the control plane. A custom seam
   * overrides it; a thrown custom seam is a denial. */
  authorize?(input: McpAuthorizeInput): Promise<void> | void;
}

/** Load the queue snapshot defensively: a throwing queue read contributes
 * NO joins (identity-bearing fields degrade to null) instead of failing the
 * whole call — and a call that cannot prove a repository refuses. */
function loadQueueRecords(queue: StoreBackedMcpInput["queue"]): readonly JobRecord[] {
  try {
    return queue.load().records;
  } catch {
    return [];
  }
}

interface FindingCursor {
  readonly jobId: string;
  readonly offset: number;
}

/** The pagination cursor is an opaque, validated, base64url-encoded
 * keyset-plus-offset record: the job the page ended in and how many of its
 * findings were already emitted. A cursor that does not decode, names an
 * unknown job, or carries a negative offset yields an EMPTY page — a
 * pagination boundary can never widen into an unfiltered read. */
function decodeCursor(cursor: string | undefined): FindingCursor | null {
  if (cursor === undefined) return { jobId: "", offset: 0 };
  if (validateMcpCursor(cursor) === null) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record["j"] !== "string" || record["j"].length === 0 || record["j"].length > 256) return null;
    const offset = record["o"];
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return null;
    return { jobId: record["j"], offset };
  } catch {
    return null;
  }
}

function encodeCursor(jobId: string, offset: number): string {
  return Buffer.from(JSON.stringify({ j: jobId, o: offset }), "utf8").toString("base64url");
}

/** Default authorization: the repository must appear as an ADOPTED record
 * for the platform in the control plane. `enabled` gates SCHEDULING, not
 * read access — the adoption record is the operator's past decision, and
 * its own metadata (including enabled=false) is exactly what a read-only
 * policy surface may report. */
async function defaultAuthorize(controlPlane: ControlPlaneStore, input: McpAuthorizeInput): Promise<void> {
  const exported = await controlPlane.exportState();
  const adopted = exported.adoptedRepositories.some(
    (record) => record.platform === input.platform && record.repoFullName === input.repository,
  );
  if (!adopted) throw new Error("repository not adopted");
}

export function buildStoreBackedMcpDeps(input: StoreBackedMcpInput): ControllerMcpDeps {
  const authorize = async (authorizeInput: McpAuthorizeInput): Promise<void> => {
    if (input.authorize !== undefined) {
      await input.authorize(authorizeInput);
      return;
    }
    await defaultAuthorize(input.controlPlane, authorizeInput);
  };

  const queueJoinForJob = (jobId: string): JobRecord | null => {
    for (const record of loadQueueRecords(input.queue)) {
      if (record.job.jobId === jobId) return record;
    }
    return null;
  };

  /** The queue record carries the run id a job dispatched as; when no queue
   * record exists the run id cannot be proven and the review is unread. */
  const findJobIdForRun = (runId: string): string => {
    for (const record of loadQueueRecords(input.queue)) {
      if (record.job.runId === runId) return record.job.jobId;
    }
    return "";
  };

  const prView = (record: JobRecord | null): McpReviewView["pr"] => {
    if (record === null) return null;
    return { platform: record.job.platform as McpPlatform, repository: record.job.repoFullName, prNumber: record.job.prNumber };
  };

  const getPublication = async (jobId: string) => {
    try {
      return await input.controlPlane.getPublication(jobId);
    } catch {
      return null;
    }
  };

  const getReview = async (query: { runId?: string; jobId?: string }): Promise<McpReviewView | null> => {
    // Identity-addressed read: the repository must be PROVEN from the queue
    // snapshot before anything is read or authorized — the identifier never
    // grants permission, so an unprovable run is unread (fail closed).
    const jobId = query.jobId ?? findJobIdForRun(query.runId ?? "");
    if (jobId === "") return null;
    const join = queueJoinForJob(jobId);
    if (join === null) return null;
    try {
      await authorize({ platform: join.job.platform as McpPlatform, repository: join.job.repoFullName });
    } catch {
      return null;
    }
    const runId = query.runId ?? join.job.runId;
    let run = null;
    try {
      run = await input.controlPlane.getRun(runId);
    } catch {
      run = null;
    }
    if (run === null) return null;
    const publication = await getPublication(join.job.jobId);
    const projection = parsePayloadProjection(publication === null ? "" : publication.resultPayload);
    return {
      runId: run.runId,
      jobId: run.jobId,
      kind: run.kind,
      state: run.state,
      executorIdentity: run.executorIdentity,
      attempt: run.attempt,
      headSha: run.resultHeadSha !== "" ? run.resultHeadSha : run.headSha,
      configFingerprint: run.configFingerprint,
      createdAtMs: run.createdAtMs,
      updatedAtMs: run.updatedAtMs,
      startedAtMs: run.startedAtMs,
      finishedAtMs: run.finishedAtMs,
      pr: prView(join),
      verdict: projection.verdict,
      reviewResult: projection.reviewResult,
      requiredChecks: projection.requiredChecks,
      findings: projection.findings.map((finding) => ({ path: finding.path, line: finding.line, severity: finding.severity, category: finding.category, message: finding.message })),
      findingCount: projection.findings.length,
      publication:
        publication === null
          ? null
          : {
              state: publication.publicationState,
              destination: publication.destination,
              publicationId: publication.publicationId,
              attempt: publication.attempt,
              lastError: publication.lastError,
            },
    };
  };

  /** The queue record carries the run id a job dispatched as; when no queue
   * record exists the run id cannot be proven and the review is unread. */
  const listFindings: ControllerMcpDeps["listFindings"] = async (query) => {
    await authorize({ platform: query.platform, repository: query.repository });
    const cursor = decodeCursor(query.cursor);
    if (cursor === null) return { findings: [] };
    const severity = query.severity?.toLowerCase();
    const category = query.category?.toLowerCase();
    const pathFilter = query.path?.toLowerCase();
    const findings: McpFindingView[] = [];
    let nextCursor: string | undefined;
    let scanned = 0;
    let passed = cursor.jobId === "";
    for (const record of loadQueueRecords(input.queue)) {
      const job = record.job;
      if (job.platform !== query.platform || job.repoFullName !== query.repository) continue;
      if (!passed) {
        // Keyset cursor: resume at the cursor's job, past its emitted offset.
        if (job.jobId !== cursor.jobId) continue;
        passed = true;
      }
      if (scanned >= MAX_MCP_LIST_JOBS_SCANNED) break;
      scanned += 1;
      const publication = await getPublication(job.jobId);
      if (publication === null) continue;
      const projection = parsePayloadProjection(publication.resultPayload);
      const startIndex = job.jobId === cursor.jobId ? cursor.offset : 0;
      for (let index = startIndex; index < projection.findings.length; index++) {
        const finding = projection.findings[index]!;
        if (severity !== undefined && finding.severity.toLowerCase() !== severity) continue;
        if (category !== undefined && finding.category.toLowerCase() !== category) continue;
        if (pathFilter !== undefined && !finding.path.toLowerCase().includes(pathFilter)) continue;
        if (findings.length >= query.limit) {
          nextCursor = encodeCursor(job.jobId, index);
          break;
        }
        findings.push({
          runId: job.runId,
          jobId: job.jobId,
          platform: job.platform as McpPlatform,
          repository: job.repoFullName,
          prNumber: job.prNumber,
          headSha: publication.resultHeadSha,
          path: finding.path,
          line: finding.line,
          severity: finding.severity,
          category: finding.category,
          message: finding.message,
          status: "open",
        });
      }
      if (nextCursor !== undefined) break;
    }
    return { findings, ...(nextCursor === undefined ? {} : { nextCursor }) };
  };

  const getReviewPolicy: ControllerMcpDeps["getReviewPolicy"] = async (query) => {
    let platform: McpPlatform | undefined = query.platform;
    let repository: string | undefined = query.repository;
    if (query.runId !== undefined) {
      let run = null;
      try {
        run = await input.controlPlane.getRun(query.runId);
      } catch {
        run = null;
      }
      if (run === null) return null;
      const join = queueJoinForJob(run.jobId);
      if (join === null) return null;
      platform = join.job.platform as McpPlatform;
      repository = join.job.repoFullName;
      // Identity-addressed read: the seam decides, and a thrown authorize
      // is a refusal (null), never a permission.
      try {
        await authorize({ platform, repository });
      } catch {
        return null;
      }
    }
    if (platform === undefined || repository === undefined) return null;
    let adopted: StateExport["adoptedRepositories"][number] | null;
    try {
      const exported = await input.controlPlane.exportState();
      adopted = exported.adoptedRepositories.find((record) => record.platform === platform && record.repoFullName === repository) ?? null;
    } catch {
      return null;
    }
    if (adopted === null) return null;
    const view: McpPolicyView = {
      platform,
      repository,
      configFingerprint: adopted.configFingerprint,
      adoptionEpoch: adopted.adoptionEpoch,
      enabled: adopted.enabled,
      adoptedAtMs: adopted.adoptedAtMs,
      updatedAtMs: adopted.updatedAtMs,
      // The adopted record carries fingerprints, not config material; the
      // trusted-source REFERENCE lives in the operator's installation
      // config (#727), which this adapter does not join — it stays honestly
      // empty rather than inventing a reference.
      configRef: "",
      provenance: "control-plane adoption record",
    };
    return view;
  };

  return { authorize, getReview, listFindings, getReviewPolicy };
}
