/**
 * #1455: the merge-safety verifier's own telemetry — the unscored cause, the
 * measured latency and the token usage — in the shapes the published marker
 * and the run-directory artifact carry.
 *
 * This module is a LEAF on purpose: it imports nothing but the token
 * normalizer. The publication-side marker builder
 * (`src/metadata/markers.ts`) needs the cause grammar and the usage
 * vocabulary, and it must not drag the verifier's whole module graph (and the
 * redaction helpers behind it) into every importer of the marker.
 */
import { normalizeUsageTelemetry } from "../model/telemetry.js";

/** #1455: the conservative machine-token grammar the verifier's unscored
 * cause must match before it may be published. The cause is action-owned
 * (never provider text), so the grammar only has to reject anything that is
 * not a plain lowercase token; a cause that does not match is DROPPED, never
 * published. */
export const CONFIDENCE_CAUSE_TOKEN_PATTERN = /^[a-z0-9_]{1,64}$/;

/** #1455: the artifact `version` this module reads. Version 2 is the
 * merge-readiness verifier artifact (`rubric` present); a version-1 artifact
 * is a pre-#1369 prose-quality confidence grade, and its semantics are not
 * comparable — so its telemetry is never read as verifier telemetry. */
export const CONFIDENCE_ARTIFACT_VERSION = 2;

/** #1455: the token counts the verifier's ONE wire attempt reported. A count
 * is null when the provider reported none — never a spurious 0 — so a
 * consumer can tell "not reported" from "reported as zero".
 *
 * The counts are the repo's canonical accounting
 * (`normalizeUsageTelemetry`), so the prompt total follows the wire format:
 * OpenAI's `prompt_tokens` already includes the cached tokens, while
 * Anthropic's `input_tokens` excludes the cache tokens it reports
 * separately, so the prompt total adds them (#1199). The total is the
 * provider's own `total_tokens` when it reported one. The cached subset
 * itself is NOT published: it is a breakdown of the prompt total, and the
 * totals already account for it. */
export interface ConfidenceUsageTelemetry {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

/** #1455: the usage the provider reported for the verifier's call, read from
 * the raw provider body with the wire format the run used. Null when the
 * provider reported no usage at all.
 *
 * The RAW body is the source on purpose: the transport's own projection
 * (`normalizeNonStreamedResponse`) is shape-only, so it sums a total the
 * provider did not report and it cannot see the Anthropic cache tokens the
 * format-aware accounting counts. */
export function confidenceUsageFromProviderBody(raw: unknown, apiFormat: string): ConfidenceUsageTelemetry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const usage = (raw as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
  const telemetry = normalizeUsageTelemetry(usage, apiFormat);
  if (telemetry.promptTokens === null && telemetry.completionTokens === null && telemetry.totalTokens === null) return null;
  return {
    promptTokens: telemetry.promptTokens,
    completionTokens: telemetry.completionTokens,
    totalTokens: telemetry.totalTokens,
  };
}

/** #1455: the usage in the persisted/wire shape the `confidence-score.json`
 * artifact carries. A count the provider did not report is absent from the
 * object, never written as 0. */
export function confidenceUsageWireShape(usage: ConfidenceUsageTelemetry): Record<string, number> {
  const out: Record<string, number> = {};
  if (usage.promptTokens !== null) out.prompt_tokens = usage.promptTokens;
  if (usage.completionTokens !== null) out.completion_tokens = usage.completionTokens;
  if (usage.totalTokens !== null) out.total_tokens = usage.totalTokens;
  return out;
}

/** #1455: the ONE validation every published surface applies to the usage.
 * A count that is not a finite non-negative integer is not a token count, so
 * the whole usage is rejected rather than published half-validated: the
 * marker and the artifact must never disagree about the same measurement.
 * Returns the accepted usage, or null when it is absent or invalid. */
export function validConfidenceUsageTelemetry(usage: ConfidenceUsageTelemetry | null | undefined): ConfidenceUsageTelemetry | null {
  if (usage === null || usage === undefined) return null;
  const counts = [usage.promptTokens, usage.completionTokens, usage.totalTokens];
  for (const count of counts) {
    if (count === null) continue;
    if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) return null;
  }
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

/** #1455: the usage in the artifact's wire shape, read back into the
 * internal shape. A count the provider did not report is absent from the
 * artifact and stays null here — never a spurious 0. A count that IS present
 * but is not a finite non-negative integer rejects the WHOLE usage, exactly
 * as `validConfidenceUsageTelemetry` does on the way out: the artifact and
 * the marker must never disagree about the same measurement, and a
 * half-validated usage is not a measurement. */
export function confidenceUsageFromWireShape(value: unknown): ConfidenceUsageTelemetry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const counts: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
  };
  let invalid = false;
  for (const name of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const raw = record[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
      // A present-but-invalid count is not an absent count: it rejects the
      // whole usage rather than silently dropping the one bad field.
      invalid = true;
      break;
    }
    if (name === "prompt_tokens") counts.promptTokens = raw;
    else if (name === "completion_tokens") counts.completionTokens = raw;
    else counts.totalTokens = raw;
  }
  if (invalid) return null;
  if (counts.promptTokens === null && counts.completionTokens === null && counts.totalTokens === null) return null;
  return validConfidenceUsageTelemetry(counts);
}

/** #1455: the verifier's telemetry as the published marker and the
 * `confidence-score.json` artifact carry it. */
export interface ConfidenceTelemetry {
  /** The verifier's own status for the run that measured this: `scored`,
   * `unscored`, or "" when the verifier never ran. The telemetry carries the
   * status it was measured under, so a publisher never has to guess it from
   * an ambient env var that may be absent or stale. */
  status: string;
  /** The action-owned machine-token cause of an unscored run; "" when the
   * run scored, when the verifier never ran, or when the cause is not a
   * conservative token. */
  cause: string;
  /** The wall-clock duration of the verifier's provider attempt in
   * milliseconds; null when no attempt was made. */
  latencyMs: number | null;
  /** The token counts the provider reported; null when it reported none. */
  usage: ConfidenceUsageTelemetry | null;
}

/** #1455: the ONE rule that decides what the verifier's telemetry says.
 * Every surface derives its telemetry here — the run artifact, the run
 * stage's shadow marker and the published marker — so the three can never
 * disagree about the same run.
 *
 * The cause is published only for an UNSCORED run and only when it is a
 * conservative machine token: a scored run has no cause to explain, and a
 * cause that is not a plain token is not an action-owned fact. The latency
 * is published only when a provider attempt was actually made. The usage is
 * published only when the provider reported counts, and only when every
 * count is a finite non-negative integer. */
export function confidenceTelemetryOf(input: {
  status: string;
  cause: string;
  latencyMs: number | null;
  usage: ConfidenceUsageTelemetry | null;
}): ConfidenceTelemetry {
  const status = input.status === "scored" || input.status === "unscored" ? input.status : "";
  const cause = status === "unscored" && typeof input.cause === "string" && CONFIDENCE_CAUSE_TOKEN_PATTERN.test(input.cause)
    ? input.cause
    : "";
  const latencyMs = typeof input.latencyMs === "number" && Number.isInteger(input.latencyMs) && input.latencyMs >= 0
    ? input.latencyMs
    : null;
  return { status, cause, latencyMs, usage: validConfidenceUsageTelemetry(input.usage) };
}

/** #1455: the telemetry the `confidence-score.json` artifact records, read
 * back from that artifact. This is the seam the publish step reads, so the
 * composite action and the standalone `publish` CLI publish the SAME values
 * from the SAME record — neither path re-derives them.
 *
 * An artifact that is not the merge-readiness verifier's own version is
 * trusted for nothing: version 1 is a pre-#1369 prose-quality confidence
 * grade, and its semantics are not comparable. */
export function confidenceTelemetryFromArtifact(record: Record<string, unknown>): ConfidenceTelemetry {
  if (record.version !== CONFIDENCE_ARTIFACT_VERSION) return { status: "", cause: "", latencyMs: null, usage: null };
  const latency = record.latency_ms;
  return confidenceTelemetryOf({
    status: typeof record.status === "string" ? record.status : "",
    cause: typeof record.cause === "string" ? record.cause : "",
    latencyMs: typeof latency === "number" ? latency : null,
    usage: confidenceUsageFromWireShape(record.usage),
  });
}
