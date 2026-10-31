/** Defensive projection of the durable review payload (#1349).
 *
 * The publication record's `resultPayload` is the canonical JSON encoding of
 * the worker's normalized review result. Its exact schema is worker-defined
 * (the #733 image contract names the artifact; the publisher validates only
 * that it is canonical, secret-free JSON), so this projection is
 * ALLOWLIST-BASED and degrades gracefully: a field that is not exactly the
 * documented shape is absent, never normalized into something plausible.
 *
 * Every projected string is untrusted model-authored content: bounded BEFORE
 * redaction runs, control/format characters stripped, then passed through
 * the shared redactor. The projection re-checks credential shapes even
 * though the publisher already refused secret-shaped payloads — defense in
 * depth at an external output boundary, and the same pass the admin surface
 * applies (one shared implementation, no drift).
 */
import { redactText } from "../context/redact.js";
import { redactSecretShapes } from "../context/secret-shape.js";
import { MAX_MCP_FINDINGS_PER_REVIEW, MAX_MCP_MESSAGE_CHARS } from "./types.js";

/** One finding exactly as the payload named it, after validation. */
export interface PayloadFinding {
  readonly path: string;
  readonly line: number;
  readonly severity: string;
  readonly category: string;
  readonly message: string;
}

export interface PayloadProjection {
  readonly verdict: string;
  readonly reviewResult: string;
  readonly requiredChecks: readonly string[];
  readonly findings: readonly PayloadFinding[];
}

const VERDICT_SHAPE = /^(approve|request_changes|comment|blocked)$/i;
const REVIEW_RESULT_SHAPE = /^(issues|partial|findings|clean)$/;
const CHECK_NAME_SHAPE = /^[A-Za-z0-9._@/-]{1,256}$/;
/** Control characters (the C0 range plus DEL) — refused outright in
 * identifier-validated finding fields. */
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f]/;
/** Control and format characters — ANSI escapes, bidi overrides, zero-width
 * joiners. Replaced with a space, never rendered. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}]/gu;

/** Bound BEFORE redaction so a hostile string cannot make the redactor work
 * on an unbounded input; strip unsafe characters; collapse whitespace; then
 * both redaction passes (context redactor + credential shapes). */
function projectUntrustedText(value: unknown): string {
  if (typeof value !== "string") return "";
  const boundedInput = value.slice(0, MAX_MCP_MESSAGE_CHARS * 4);
  const cleaned = boundedInput.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  const redacted = redactText(redactSecretShapes(cleaned));
  return redacted.slice(0, MAX_MCP_MESSAGE_CHARS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function projectFinding(raw: unknown): PayloadFinding | null {
  if (!isPlainObject(raw)) return null;
  const path = raw["path"];
  if (typeof path !== "string" || path.length < 1 || path.length > 512 || CONTROL_OR_NEWLINE.test(path)) return null;
  const severity = raw["severity"];
  if (typeof severity !== "string" || severity.length < 1 || severity.length > 64 || CONTROL_OR_NEWLINE.test(severity)) return null;
  const category = raw["category"];
  if (typeof category !== "string" || category.length < 1 || category.length > 64 || CONTROL_OR_NEWLINE.test(category)) return null;
  const lineValue = raw["line"];
  const line = lineValue === undefined ? 0 : isSafeNonNegativeInteger(lineValue) ? lineValue : -1;
  if (line < 0) return null;
  const message = projectUntrustedText(raw["message"]);
  return Object.freeze({ path, line, severity, category, message });
}

/** Project the durable payload into the bounded view the MCP surface may
 * expose. A payload that is not a JSON object, or any field not exactly the
 * documented shape, degrades to the empty sentinel — never an error, never
 * a normalization. */
export function parsePayloadProjection(payload: string): PayloadProjection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { verdict: "", reviewResult: "", requiredChecks: [], findings: [] };
  }
  if (!isPlainObject(parsed)) return { verdict: "", reviewResult: "", requiredChecks: [], findings: [] };

  const verdictRaw = parsed["verdict"];
  const verdict = typeof verdictRaw === "string" && VERDICT_SHAPE.test(verdictRaw) ? verdictRaw.toLowerCase() : "";
  const resultRaw = parsed["review_result"];
  const reviewResult = typeof resultRaw === "string" && REVIEW_RESULT_SHAPE.test(resultRaw) ? resultRaw : "";

  const requiredChecks: string[] = [];
  const checksRaw = parsed["required_checks"];
  if (Array.isArray(checksRaw)) {
    for (const entry of checksRaw) {
      if (typeof entry === "string" && CHECK_NAME_SHAPE.test(entry)) requiredChecks.push(entry);
      if (requiredChecks.length >= 32) break;
    }
  }

  const findings: PayloadFinding[] = [];
  const findingsRaw = parsed["findings"];
  if (Array.isArray(findingsRaw)) {
    for (const entry of findingsRaw) {
      const projected = projectFinding(entry);
      if (projected !== null) findings.push(projected);
      if (findings.length >= MAX_MCP_FINDINGS_PER_REVIEW) break;
    }
  }
  return Object.freeze({ verdict, reviewResult, requiredChecks: Object.freeze(requiredChecks), findings: Object.freeze(findings) });
}
