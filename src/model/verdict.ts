import type { NormalizedFinding, NormalizedRequiredCheckDisposition, NormalizedThreadDisposition, ParsedReviewVerdict, RequiredCheckStatus, VerdictValue } from "./types.js";
import { VerdictParseFailure } from "./types.js";

/**
 * Port of pr_reviewer/response_parser.py: tolerant model-output parsing and
 * strict verdict validation. Error messages match the v2 strings byte for
 * byte — the parity harness `verdict-parsing` boundary compares error
 * categories derived from them.
 */

const APPROVE_VERDICTS = new Set(["approve", "approved", "approval", "lgtm"]);
const REQUEST_CHANGES_VERDICTS = new Set([
  "request_changes", "request_change", "requestchanges",
  "changes_requested", "change_requested", "needs_changes",
  "needs_change", "reject", "rejected",
]);

const SEVERITY_ALIASES: Readonly<Record<string, NormalizedFinding["severity"]>> = {
  blocker: "blocker", critical: "blocker",
  major: "major", high: "major", error: "major",
  minor: "minor", medium: "minor", low: "minor", warning: "minor",
  info: "info", note: "info", nit: "info", suggestion: "info",
};

const FINDING_CATEGORIES = new Set(["bug", "security", "performance", "style", "docs", "tests", "question", "other"]);

const MAX_FINDINGS = 50;
const MAX_FINDING_MESSAGE_CHARS = 2000;

// #721: bounded reviewer-request reason. Control chars (everything at or
// below SPACE plus DEL) collapse to one space so the reason can never break
// single-line consumers; the cap bounds one model answer. Byte-identical to
// pr_reviewer/response_parser.py's _SMART_REVIEW_REASON_CONTROL_RE +
// _MAX_SMART_REVIEW_REASON_CHARS.
const MAX_SMART_REVIEW_REASON_CHARS = 400;
const SMART_REVIEW_REASON_CONTROL = /[\u0000-\u0020\u007f]+/g;

// #750: bounded required-check dispositions. The same control-char collapse
// applies to check identities and rationales; the caps bound one model
// answer. Byte-identical to pr_reviewer/response_parser.py's
// _MAX_REQUIRED_CHECK_CHARS / _MAX_RATIONALE_CHARS and the shared control RE.
const MAX_REQUIRED_CHECKS = 50;
const MAX_REQUIRED_CHECK_CHARS = 400;
const MAX_RATIONALE_CHARS = 500;

const REQUIRED_CHECK_STATUSES = new Set<string>(["satisfied", "not_applicable", "unresolved"]);
const THREAD_DISPOSITION_ALIASES: Readonly<Record<string, NormalizedThreadDisposition["disposition"]>> = Object.freeze({
  fixed: "fixed",
  resolved: "fixed",
  addressed: "fixed",
  open: "open",
  still_open: "open",
  "still-open": "open",
  unresolved: "open",
  disputed: "disputed",
  disagree: "disputed",
  rejected: "disputed",
});
const MAX_THREAD_DISPOSITIONS = 100;
const MAX_THREAD_ID_CHARS = 200;
const MAX_THREAD_EVIDENCE_CHARS = 1000;

/**
 * #750: normalize the model's structured required-check dispositions.
 * Tri-state with key presence: callers distinguish true absence (the legacy
 * coexistence path) from an explicitly emitted null/invalid type
 * (conservatively structured-incomplete, never the fallback).
 *
 * Entries are preserved, never silently collapsed. An entry that cannot be
 * attributed to any check identity (non-object, non-string/empty/oversized
 * check text) is dropped; an attributable but malformed one — unknown
 * status prose alias, `not_applicable` without a usable rationale — is
 * preserved as `{check, status: "invalid", rationale: null}` so the
 * deterministic coverage evaluation invalidates the check (the same
 * fail-conservative precedent as requirement_coverage normalizing unusable
 * claims to `unknown`). Dropping a malformed duplicate must never turn a
 * valid+malformed double answer into a single valid disposition.
 */
function normalizeRequiredCheckDispositions(
  value: unknown,
  present: boolean,
): { present: boolean; dispositions: NormalizedRequiredCheckDisposition[] | null } {
  if (!present) return { present: false, dispositions: null };
  if (!Array.isArray(value)) return { present: true, dispositions: null };
  const dispositions: NormalizedRequiredCheckDisposition[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    const rawCheck = item.check;
    if (typeof rawCheck !== "string") continue;
    const check = rawCheck.replace(SMART_REVIEW_REASON_CONTROL, " ").trim();
    if (check === "" || check.length > MAX_REQUIRED_CHECK_CHARS) continue;

    const rawStatus = typeof item.status === "string" ? item.status.trim().toLowerCase() : "";
    if (!REQUIRED_CHECK_STATUSES.has(rawStatus)) {
      dispositions.push({ check, status: "invalid", rationale: null });
      if (dispositions.length >= MAX_REQUIRED_CHECKS) break;
      continue;
    }

    let rationale: string | null = null;
    if (typeof item.rationale === "string") {
      rationale = item.rationale.replace(SMART_REVIEW_REASON_CONTROL, " ").trim().slice(0, MAX_RATIONALE_CHARS) || null;
    }
    if (rawStatus === "not_applicable" && rationale === null) {
      dispositions.push({ check, status: "invalid", rationale: null });
      if (dispositions.length >= MAX_REQUIRED_CHECKS) break;
      continue;
    }

    dispositions.push({ check, status: rawStatus as RequiredCheckStatus, rationale });
    if (dispositions.length >= MAX_REQUIRED_CHECKS) break;
  }
  return { present: true, dispositions };
}

function codepointLength(text: string): number {
  return Array.from(text).length;
}

function codepointSlice(text: string, n: number): string {
  const points = Array.from(text);
  return points.length <= n ? text : points.slice(0, n).join("");
}

/** #766: port of `_normalize_thread_dispositions` — tri-state by key
 * presence, entries without a usable thread id dropped, unknown
 * disposition words preserved as `invalid`. */
function normalizeThreadDispositions(
  value: unknown,
  present: boolean,
): { present: boolean; dispositions: NormalizedThreadDisposition[] | null } {
  if (!present) return { present: false, dispositions: null };
  if (!Array.isArray(value)) return { present: true, dispositions: null };
  const dispositions: NormalizedThreadDisposition[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const rawId = item.thread_id;
    if (typeof rawId !== "string") continue;
    const threadId = rawId.replace(SMART_REVIEW_REASON_CONTROL, " ").trim();
    if (threadId === "" || codepointLength(threadId) > MAX_THREAD_ID_CHARS) continue;
    const key = typeof item.disposition === "string" ? item.disposition.trim().toLowerCase() : "";
    const disposition = THREAD_DISPOSITION_ALIASES[key] ?? "invalid";
    let evidence: string | null = null;
    if (typeof item.evidence === "string") {
      evidence = codepointSlice(item.evidence.replace(SMART_REVIEW_REASON_CONTROL, " ").trim(), MAX_THREAD_EVIDENCE_CHARS) || null;
    }
    dispositions.push({ threadId, disposition, evidence });
    if (dispositions.length >= MAX_THREAD_DISPOSITIONS) break;
  }
  return { present: true, dispositions };
}

/**
 * #721: normalize the reviewer's structured smart-review request.
 * `smart_review_requested` is true only for the JSON boolean `true`; every
 * other value (absent, false, `"true"`, 1, null) is malformed or absent and
 * is coerced to false — malformed output is never an escalation request.
 * The reason is kept only for a genuine request and only as a bounded,
 * control-char-free single-line string; otherwise null.
 */
function normalizeSmartReviewRequest(parsed: Record<string, unknown>): {
  requested: boolean;
  reason: string | null;
} {
  const requested = parsed.smart_review_requested === true;
  let reason: string | null = null;
  if (requested && typeof parsed.smart_review_reason === "string") {
    reason =
      parsed.smart_review_reason
        .replace(SMART_REVIEW_REASON_CONTROL, " ")
        .trim()
        .slice(0, MAX_SMART_REVIEW_REASON_CHARS) || null;
  }
  return { requested, reason };
}

const TRUNCATION_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);

const TRUNC_SUFFIX = " (model output appears truncated at the token limit; increase ai_max_tokens)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python str() for the values that can reach a message (no repr quotes). */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Python-style repr() for the values that can reach a message. */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return `'${value}'`;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/** Python type() name for a decoded JSON value, for parse-failure messages. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (isRecord(value)) return "dict";
  return "object";
}

export function normalizeVerdict(value: unknown): VerdictValue | null {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().toLowerCase().split(/\s+/).join("_").replaceAll("-", "_");
  if (APPROVE_VERDICTS.has(collapsed)) return "approve";
  if (REQUEST_CHANGES_VERDICTS.has(collapsed)) return "request_changes";
  return null;
}

function extractContent(response: Record<string, unknown>): string | string[] | null {
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    const message = isRecord(first) && isRecord(first.message) ? first.message : {};
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (typeof item === "string") parts.push(item);
        else if (isRecord(item) && (item.type === undefined || item.type === null || item.type === "text")) {
          if (typeof item.text === "string") parts.push(item.text);
        }
      }
      return parts;
    }
    return content === undefined ? null : content as string | string[];
  }

  const content = response.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
    return parts.length > 0 ? parts : null;
  }
  if (typeof content === "string") return content;
  return null;
}

/** Remove surrounding triple-backtick fences if the text starts with one. */
function stripMarkdownCodeBlock(text: string): string {
  const stripped = text.trim();
  if (!stripped.startsWith("```")) return stripped;
  const lines = stripped.split("\n").map((line) => line.replace(/\r$/, ""));
  lines.shift(); // skip opening fence (with optional language tag)
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === "```") lines.pop();
  return lines.join("\n").trim();
}

/** Escape literal newlines inside JSON string values (invalid control chars). */
function escapeRawNewlinesInStrings(text: string): string {
  let result = "";
  let inString = false;
  let escapeNext = false;
  for (const ch of text) {
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && ch === "\n") {
      result += "\\n";
      continue;
    }
    result += ch;
  }
  return result;
}

/**
 * Decode one JSON value starting exactly at `start` (the analog of
 * json.JSONDecoder.raw_decode on source[start:]). Returns the value and the
 * number of characters consumed, or null when no value decodes there.
 */
function decodeAt(source: string, start: number): { value: unknown; consumed: number } | null {
  const open = source[start];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === "\\") escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        const slice = source.slice(start, i + 1);
        try {
          return { value: JSON.parse(slice), consumed: i + 1 - start };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Collect every top-level JSON value in the text (advancing past each
 * decoded value so the interior of an array is never re-scanned), then prefer
 * the most verdict-like candidate: the last complete verdict dict (both
 * required keys), then the last partial draft, then the first dict, then the
 * first list.
 */
function scanJsonValues(text: string): unknown {
  const candidates: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }
    const decoded = decodeAt(text, i);
    if (decoded === null) {
      i++;
      continue;
    }
    candidates.push(decoded.value);
    i += decoded.consumed;
  }
  if (candidates.length === 0) return null;
  const complete: Record<string, unknown>[] = [];
  const partial: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const hasVerdict = "verdict" in candidate;
    const hasMarkdown = "review_markdown" in candidate;
    if (hasVerdict && hasMarkdown) complete.push(candidate);
    else if (hasVerdict || hasMarkdown) partial.push(candidate);
  }
  if (complete.length > 0) return complete[complete.length - 1];
  if (partial.length > 0) return partial[partial.length - 1];
  for (const candidate of candidates) {
    if (isRecord(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

/** Double a backslash that starts no valid JSON escape inside a string
 * (port of `_escape_invalid_backslashes`): a model's `\\_` or `\\*` breaks
 * the outer object and the scanner would harvest nested findings instead. */
function escapeInvalidBackslashes(text: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  const length = text.length;
  const isHex = (s: string): boolean => s.length === 4 && /^[0-9a-fA-F]{4}$/.test(s);
  while (i < length) {
    const ch = text[i]!;
    if (inString && ch === "\\") {
      const nxt = i + 1 < length ? text[i + 1]! : "";
      if (nxt && '"\\/bfnrt'.includes(nxt)) {
        result += ch + nxt;
        i += 2;
        continue;
      }
      if (nxt === "u" && isHex(text.slice(i + 2, i + 6))) {
        result += text.slice(i, i + 6);
        i += 6;
        continue;
      }
      result += "\\\\";
      i += 1;
      continue;
    }
    if (ch === '"') inString = !inString;
    result += ch;
    i += 1;
  }
  return result;
}

function isCompleteVerdict(value: unknown): boolean {
  return isRecord(value) && "verdict" in value && "review_markdown" in value;
}

function tryDecodeJson(text: string): unknown {
  // Each repair pass runs only when the previous one found no complete
  // verdict: a partial or nested candidate must not pre-empt a complete
  // object that a repair would recover.
  const first = scanJsonValues(text);
  if (isCompleteVerdict(first)) return first;
  const unwrapped = escapeRawNewlinesInStrings(text);
  const second = scanJsonValues(unwrapped);
  if (isCompleteVerdict(second)) return second;
  const third = scanJsonValues(escapeInvalidBackslashes(unwrapped));
  if (isCompleteVerdict(third)) return third;
  for (const candidate of [first, second, third]) {
    if (candidate !== null) return candidate;
  }
  return null;
}

function finishReasonOf(response: Record<string, unknown>): string | null {
  const choices = response.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const fr = choices[0].finish_reason;
    if (typeof fr === "string") return fr;
  }
  const sr = response.stop_reason;
  if (typeof sr === "string") return sr;
  return null;
}

function completionTokens(response: Record<string, unknown>): number | null {
  const usage = response.usage;
  if (!isRecord(usage)) return null;
  for (const key of ["completion_tokens", "output_tokens"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return null;
}

function surfaceStreamError(response: Record<string, unknown>): void {
  const err = response.error;
  if (!err) return;
  let msg: string;
  if (isRecord(err)) msg = typeof err.message === "string" && err.message !== "" ? err.message : JSON.stringify(err);
  else if (typeof err === "string") msg = err;
  else msg = JSON.stringify(err) ?? String(err);
  throw new VerdictParseFailure("endpoint_error", `Model endpoint returned an error: ${msg}`);
}

const SEVERITY_RANK: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };

function normalizeFindings(value: unknown): NormalizedFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: NormalizedFinding[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;

    const message = item.message ?? item.summary ?? item.title;
    if (typeof message !== "string" || message.trim() === "") continue;
    const trimmedMessage = message.trim().slice(0, MAX_FINDING_MESSAGE_CHARS);

    let severity: NormalizedFinding["severity"] = "info";
    if (typeof item.severity === "string") {
      severity = SEVERITY_ALIASES[item.severity.trim().toLowerCase()] ?? "info";
    }

    let category = "other";
    if (typeof item.category === "string") {
      const candidate = item.category.trim().toLowerCase();
      if (FINDING_CATEGORIES.has(candidate)) category = candidate;
    }

    const rawFile = item.file ?? item.path;
    let file: string | null = null;
    if (typeof rawFile === "string") {
      let filePath = rawFile.trim();
      while (filePath.startsWith("./")) filePath = filePath.slice(2);
      file = filePath === "" ? null : filePath;
    }

    const rawLine = item.line;
    let line: number | null = null;
    if (typeof rawLine === "boolean") line = null;
    else if (typeof rawLine === "number") line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;
    else if (typeof rawLine === "string" && /^\d+$/.test(rawLine.trim())) {
      const parsedLine = Number.parseInt(rawLine.trim(), 10);
      line = parsedLine > 0 ? parsedLine : null;
    }

    const finding: NormalizedFinding = { severity, category, file, line, message: trimmedMessage };
    if (typeof item.preliminary_finding === "number" && Number.isInteger(item.preliminary_finding)) {
      finding.preliminaryFinding = item.preliminary_finding;
    }

    findings.push(finding);
    if (findings.length >= MAX_FINDINGS) break;
  }
  // Most decisive first (port of the v2 sort); Array.prototype.sort is stable,
  // so the model's own order survives within a severity.
  return findings.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}


export interface ParsedResponse {
  verdict: ParsedReviewVerdict;
  /** Extra model keys passed through untouched (v2 behavior). */
  extra: Record<string, unknown>;
}

/**
 * Parse a raw model response (already deserialized JSON) into a validated
 * review verdict. Throws VerdictParseFailure on any validation failure, with
 * v2-identical messages.
 */
export function parseVerdictResponse(response: unknown): ParsedReviewVerdict {
  if (!isRecord(response)) {
    throw new VerdictParseFailure("not_object", `Expected JSON object but got ${pyTypeName(response)}`);
  }
  surfaceStreamError(response);

  const raw = extractContent(response);
  const text = Array.isArray(raw)
    ? raw.join("").trim()
    : typeof raw === "string" ? raw.trim() : "";

  const stripped = stripMarkdownCodeBlock(text);
  let parsed: unknown = tryDecodeJson(stripped);

  // Wrap single-item lists: [{"verdict": ...}] → {"verdict": ...}
  if (Array.isArray(parsed) && parsed.length === 1 && isRecord(parsed[0])) parsed = parsed[0];

  const finish = finishReasonOf(response);
  const trunc = finish !== null && TRUNCATION_REASONS.has(finish) ? TRUNC_SUFFIX : "";

  // An empty body with zero completion tokens is the upstream accepting the
  // prompt and generating nothing — not a malformed answer. Distinct failure
  // kind so the caller skips retrying (v2 exit code 3).
  if (text === "" && completionTokens(response) === 0) {
    throw new VerdictParseFailure(
      "empty_completion",
      `Model returned an empty completion (0 completion tokens, finish_reason=${pyRepr(finish)}). Nothing to parse.`,
    );
  }

  if (!isRecord(parsed)) {
    throw new VerdictParseFailure("not_object", `Expected JSON object but got ${pyTypeName(parsed)}${trunc}`, { truncated: trunc !== "" });
  }

  if (!("verdict" in parsed)) {
    throw new VerdictParseFailure("missing_verdict_key", `Parsed JSON missing required key 'verdict'${trunc}`, { truncated: trunc !== "" });
  }
  if (!("review_markdown" in parsed)) {
    throw new VerdictParseFailure("missing_review_markdown_key", `Parsed JSON missing required key 'review_markdown'${trunc}`, { truncated: trunc !== "" });
  }

  const verdict = normalizeVerdict(parsed.verdict);
  if (verdict === null) {
    throw new VerdictParseFailure(
      "invalid_verdict",
      `Expected verdict to be 'approve' or 'request_changes', got '${pyStr(parsed.verdict)}'`,
    );
  }

  const markdown = parsed.review_markdown;
  if (typeof markdown !== "string" || markdown.trim() === "") {
    throw new VerdictParseFailure("empty_markdown", `Parsed JSON has empty or missing 'review_markdown'${trunc}`, { truncated: trunc !== "" });
  }

  if (!markdown.includes("\n") && (markdown.match(/## /g)?.length ?? 0) >= 2) {
    throw new VerdictParseFailure(
      "flattened_markdown",
      "Parsed JSON 'review_markdown' appears flattened: contains multiple '## ' heading markers but no newlines. "
        + "This is a known artefact of grammar-constrained decoding under "
        + "ai_response_format: json_schema (e.g., Fireworks). Retry "
        + "with ai_response_format: json_object or increase "
        + `ai_max_tokens.${trunc}`,
    { truncated: trunc !== "" },
    );
  }

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key !== "verdict" && key !== "review_markdown" && key !== "findings"
      && key !== "requirement_coverage"
      && key !== "smart_review_requested" && key !== "smart_review_reason"
      && key !== "required_check_dispositions"
      && key !== "thread_dispositions"
    ) {
      extra[key] = value;
    }
  }
  const smartRequest = normalizeSmartReviewRequest(parsed);
  const dispositions = normalizeRequiredCheckDispositions(
    parsed.required_check_dispositions,
    "required_check_dispositions" in parsed,
  );
  const threadDispositions = normalizeThreadDispositions(
    parsed.thread_dispositions,
    "thread_dispositions" in parsed,
  );
  return {
    verdict,
    reviewMarkdown: markdown,
    findings: normalizeFindings(parsed.findings),
    requirementCoverage: parsed.requirement_coverage,
    requiredCheckDispositions: dispositions.dispositions,
    requiredCheckDispositionsEmitted: dispositions.present,
    threadDispositions: threadDispositions.dispositions,
    threadDispositionsEmitted: threadDispositions.present,
    smartReviewRequested: smartRequest.requested,
    smartReviewReason: smartRequest.reason,
    extra,
  };
}
