/** #975: the fail-on-request-changes gate's blocking-finding renderer.
 * Pure functions, no I/O — `src/run/action.ts` writes their output to the
 * runner log (workflow-command annotations + the gate line) and to the step
 * summary. The message discipline mirrors the published body: `redactText`
 * first, then control-character flattening so every rendered string stays
 * one line, then the workflow-command escaping the runner requires
 * (percent FIRST, so an encoded sequence is never re-encoded). A hostile
 * finding can therefore never forge a second command, smuggle a raw newline
 * into the log, or close a fence in the summary. */
import { redactText } from "../context/redact.js";

/** Cap on the `::error` annotations the gate emits for one run. */
export const BLOCKING_ANNOTATION_LIMIT = 10;

/** Escape a workflow-command PROPERTY value (`file=`, `line=`): the runner
 * decodes `%25`/`%0D`/`%0A`/`%3A`/`%2C`; percent first so an already-encoded
 * sequence survives. */
export function escapeWorkflowProperty(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/** Escape a workflow-command MESSAGE: only `%`/CR/LF matter in the data
 * portion (the property delimiters `:` and `,` are part of the command
 * grammar there, not the value); percent first. */
export function escapeWorkflowData(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

/** The `safePath` check mirrored from `src/publish/inline-findings.ts`:
 * non-empty, repository-relative, no `..` segment — a finding's file must
 * be an anchor the forge can place, not an escape from the repository. */
function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface NormalizedFinding {
  severity: string;
  file: string;
  line: number;
  message: string;
}

/** A usable finding record: an object with a `severity`; `file`/`line`/
 * `message` are normalized leniently (never a throw) — a missing or
 * ill-typed field just means "no location"/"no line"/"empty message". */
function normalize(value: unknown): NormalizedFinding | null {
  if (!isRecord(value)) return null;
  const severity = value.severity;
  if (typeof severity !== "string" || (severity !== "blocker" && severity !== "major")) return null;
  const line = value.line;
  return {
    severity,
    file: safePath(value.file) ? value.file : "",
    line: typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 0,
    message: typeof value.message === "string" ? value.message : "",
  };
}

/** The blocking set in gate order: every blocker first, then every major,
 * each rank preserving the input's relative order (stable two-pass
 * filter). */
function blockingFindings(findings: unknown): NormalizedFinding[] {
  if (!Array.isArray(findings)) return [];
  const usable = findings
    .map(normalize)
    .filter((finding): finding is NormalizedFinding => finding !== null);
  return [
    ...usable.filter((finding) => finding.severity === "blocker"),
    ...usable.filter((finding) => finding.severity === "major"),
  ];
}

/** The message pipeline: `redactText` first (same masking as the published
 * body), control-character flattening, whitespace collapse, then a
 * code-point cap with an ellipsis on truncation. */
function flattenMessage(message: string, maxCodePoints: number): string {
  const flat = redactText(message).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length > maxCodePoints ? `${points.slice(0, maxCodePoints).join("")}…` : flat;
}

/** One `::error` annotation per blocking finding with a usable location,
 * blockers before majors, capped at `limit`. Findings without a usable
 * file produce no annotation (they still count in
 * {@link blockingGateSummary}). */
export function renderBlockingAnnotations(findings: unknown, limit: number = BLOCKING_ANNOTATION_LIMIT): string[] {
  const annotations: string[] = [];
  for (const finding of blockingFindings(findings)) {
    if (annotations.length >= limit) break;
    if (finding.file === "") continue;
    const location = `file=${escapeWorkflowProperty(finding.file)}${finding.line > 0 ? `,line=${finding.line}` : ""}`;
    annotations.push(`::error ${location}::${escapeWorkflowData(`[${finding.severity}] ${flattenMessage(finding.message, 300)}`)}`);
  }
  return annotations;
}

/** The one-line summary of the blocking set for the gate error, e.g.
 * `2 blocking finding(s): [blocker] prometheus/x.yml:12 — <message>`.
 * Returns the empty string when nothing blocks, so the caller picks its
 * own wording. */
export function blockingGateSummary(findings: unknown): string {
  const blocking = blockingFindings(findings);
  if (blocking.length === 0) return "";
  const first = blocking[0]!;
  const message = flattenMessage(first.message, 200);
  const location = first.file === "" ? "" : first.file + (first.line > 0 ? `:${first.line}` : "");
  const head = location === "" ? `[${first.severity}]` : `[${first.severity}] ${location}`;
  const entry = message === "" ? head : `${head} — ${message}`;
  return `${blocking.length} blocking finding(s): ${entry}`;
}
