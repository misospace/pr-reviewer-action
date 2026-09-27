/** Deterministic, bounded normalizer for specialist review leads (#607, v3
 * port of `pr_reviewer/specialists.py`'s normalize/parse surface).
 *
 * Design invariants (verbatim from v2):
 *
 * - Three fixed roles only; any other role is rejected with a visible error.
 * - Deterministic and bounded: leads are emitted in declared order, exact
 *   duplicates keep the first occurrence, and list/character caps bound the
 *   artifact so one specialist cannot flood the final corpus.
 * - Fail-soft and visible: malformed JSON, an unknown role, a non-object
 *   payload, or a non-array `leads` all produce a result with a populated
 *   `errors` list and empty (or partial) leads — never an exception.
 * - No model/network/execution: pure parsing of in-memory values and local
 *   text.
 */

import {
  ADVERSARIAL_CONTRACT,
  ERRORS_TRUNCATED_MARKER,
  MAX_BOUNDARIES_CHALLENGED,
  MAX_CATEGORY_CHARS,
  MAX_ERRORS,
  MAX_FILE_CHARS,
  MAX_LEADS,
  MAX_MESSAGE_CHARS,
  SEVERITY_ALIASES,
  SPECIALIST_ROLES,
  SPECIALIST_ROLES_ORDER,
  type SpecialistArtifact,
  type SpecialistLead,
} from "./types.js";

const CONTROL_RE = /[\x00-\x1f\x7f]/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip control characters (NUL, newlines, etc.) from `value` so a hostile
 * model-controlled string cannot inject raw newlines/NULs into rendering. */
export function sanitizeString(value: string): string {
  return value.replace(CONTROL_RE, "");
}

export function emptyArtifact(role = ""): SpecialistArtifact {
  return {
    version: 1,
    role,
    leads: [],
    truncated: false,
    truncation: {
      truncated: false,
      reasons: [],
      omitted_leads: 0,
      omitted_message_chars: 0,
      omitted_errors: 0,
    },
    errors: [],
  };
}

function addError(result: SpecialistArtifact, message: string): void {
  const errors = result.errors;
  if (errors.length < MAX_ERRORS) {
    errors.push(message);
    return;
  }
  const truncation = result.truncation;
  result.truncated = true;
  truncation.truncated = true;
  truncation.omitted_errors += 1;
  if (errors[errors.length - 1] !== ERRORS_TRUNCATED_MARKER) {
    errors.push(ERRORS_TRUNCATED_MARKER);
  }
  if (!truncation.reasons.includes("errors_cap")) {
    truncation.reasons.push("errors_cap");
  }
}

function cap(value: unknown, fallback: number, name: string, result: SpecialistArtifact): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    addError(result, `${name} must be a non-negative integer`);
    return fallback;
  }
  return value;
}

type TruncationCounter = "message_chars" | "leads" | "errors";

function boundedText(
  value: string,
  limit: number,
  counter: "message_chars",
  result: SpecialistArtifact,
): string {
  if (value.length <= limit) return value;
  result.truncated = true;
  result.truncation.truncated = true;
  result.truncation.omitted_message_chars += value.length - limit;
  const reason = `${counter}_cap`;
  if (!result.truncation.reasons.includes(reason)) {
    result.truncation.reasons.push(reason);
  }
  return value.slice(0, limit);
}

function normalizeSeverity(raw: unknown): string {
  if (typeof raw !== "string") return "info";
  return SEVERITY_ALIASES[raw.trim().toLowerCase()] ?? "info";
}

function normalizeLead(
  item: unknown,
  index: number,
  maxMessageChars: number,
  result: SpecialistArtifact,
  contract: string,
): SpecialistLead | null {
  if (!isRecord(item)) {
    addError(result, `leads[${index}] is not an object`);
    return null;
  }

  const rawMessage = item.message;
  if (typeof rawMessage !== "string" || rawMessage.trim() === "") {
    addError(result, `leads[${index}] is missing a usable message`);
    return null;
  }
  const message = boundedText(rawMessage.trim(), maxMessageChars, "message_chars", result);

  let category: string;
  const rawCategory = item.category;
  if (typeof rawCategory === "string") {
    category = boundedText(
      sanitizeString(rawCategory.trim()),
      MAX_CATEGORY_CHARS,
      "message_chars",
      result,
    );
  } else {
    category = "";
  }

  let filePath: string | null;
  const rawFile = item.file;
  if (typeof rawFile === "string") {
    let cleaned = sanitizeString(rawFile.trim());
    while (cleaned.startsWith("./")) {
      cleaned = cleaned.slice(2);
    }
    const bounded = boundedText(cleaned, MAX_FILE_CHARS, "message_chars", result);
    filePath = bounded || null;
  } else {
    filePath = null;
  }

  let line: number | null = null;
  const rawLine = item.line;
  if (typeof rawLine === "boolean") {
    line = null;
  } else if (typeof rawLine === "number" && Number.isInteger(rawLine)) {
    line = rawLine > 0 ? rawLine : null;
  } else if (typeof rawLine === "string" && /^\d+$/.test(rawLine.trim())) {
    const parsed = Number.parseInt(rawLine.trim(), 10);
    line = parsed > 0 ? parsed : null;
  }

  const lead: SpecialistLead = {
    severity: normalizeSeverity(item.severity),
    category,
    file: filePath,
    line,
    message,
  };
  return normalizeAdversarialFields(item, index, maxMessageChars, result, lead, contract);
}

/** #758 adversarial-correctness contract: optional `trigger`/`consequence`.
 * Both fields are free-text accounts of the falsifying input (`trigger`) and
 * the wrong observable it produces (`consequence`). Enforcement is scoped to
 * payloads that self-declare `contract: "adversarial"` (the adversarial
 * prompt's JSON contract): a `major` lead produced under that contract that
 * lacks either field is downgraded to `minor` with a visible error. Payloads
 * under the default contract never demote. */
function normalizeAdversarialFields(
  item: Record<string, unknown>,
  index: number,
  maxMessageChars: number,
  result: SpecialistArtifact,
  lead: SpecialistLead,
  contract: string,
): SpecialistLead {
  for (const field of ["trigger", "consequence"] as const) {
    const raw = item[field];
    if (typeof raw === "string" && raw.trim()) {
      lead[field] = boundedText(sanitizeString(raw.trim()), maxMessageChars, "message_chars", result);
    }
  }
  if (contract === ADVERSARIAL_CONTRACT && lead.severity === "major" && (lead.trigger === undefined || lead.consequence === undefined)) {
    lead.severity = "minor";
    // Verbatim v2 wording (`pr_reviewer/specialists.py::_normalize_adversarial_fields`):
    // the primary word is "trigger" whenever trigger is missing (even when
    // consequence is ALSO missing — the message never lists both in that
    // case), else "consequence"; the " and consequence" suffix is appended
    // whenever trigger is present (i.e. only when consequence alone is
    // missing), which reads oddly ("missing consequence and consequence")
    // but is v2's actual behavior and is pinned by the parity fixtures.
    const missingTrigger = lead.trigger === undefined;
    const which = missingTrigger ? "trigger" : "consequence";
    const andConsequence = !missingTrigger ? " and consequence" : "";
    addError(result, `leads[${index}]: major lead missing ${which}${andConsequence}; downgraded to minor`);
  }
  return lead;
}

function leadKey(lead: SpecialistLead): string {
  return JSON.stringify([lead.severity, lead.category, lead.file, lead.line, lead.message]);
}

/** Normalize a decoded specialist payload without I/O, commands, or network.
 * `payload` is the already-decoded JSON value (typically an object). Never
 * throws on malformed input: problems land in the returned artifact's
 * `errors` list and the leads list is empty (or partial). */
export function normalizeSpecialistOutput(
  payload: unknown,
  role: string,
  maxLeads: number = MAX_LEADS,
  maxMessageChars: number = MAX_MESSAGE_CHARS,
): SpecialistArtifact {
  const result = emptyArtifact();

  if (!SPECIALIST_ROLES.has(role)) {
    addError(
      result,
      `unknown specialist role: '${role}'; expected one of [${SPECIALIST_ROLES_ORDER.map((r) => `'${r}'`).join(", ")}]`,
    );
    return result;
  }
  result.role = role;

  const boundedMaxLeads = cap(maxLeads, MAX_LEADS, "max_leads", result);
  const boundedMaxMessageChars = cap(maxMessageChars, MAX_MESSAGE_CHARS, "max_message_chars", result);

  if (!isRecord(payload)) {
    addError(result, "specialist payload must be a JSON object");
    return result;
  }

  const echoed = payload.role;
  if (echoed !== undefined && echoed !== null) {
    if (typeof echoed !== "string" || !SPECIALIST_ROLES.has(echoed.trim().toLowerCase())) {
      addError(result, `payload role '${String(echoed)}' is not a known specialist role`);
    } else if (echoed.trim().toLowerCase() !== role) {
      addError(result, `payload role '${echoed}' does not match requested role '${role}'`);
    }
  }

  let rawLeads: unknown = payload.leads;
  if (rawLeads === null || rawLeads === undefined) rawLeads = [];
  if (!Array.isArray(rawLeads)) {
    addError(result, "payload 'leads' is not an array");
    rawLeads = [];
  }

  // #758: only a payload that self-declares the adversarial contract gets the
  // trigger/consequence demotion enforcement (the adversarial prompt emits
  // "contract": "adversarial").
  const rawContract = payload.contract;
  const contract = typeof rawContract === "string" ? rawContract : "";

  const candidates: SpecialistLead[] = [];
  (rawLeads as unknown[]).forEach((item, index) => {
    const lead = normalizeLead(item, index, boundedMaxMessageChars, result, contract);
    if (lead !== null) candidates.push(lead);
  });

  const seen = new Set<string>();
  const unique: SpecialistLead[] = [];
  for (const lead of candidates) {
    const key = leadKey(lead);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(lead);
  }

  let leads = unique;
  if (unique.length > boundedMaxLeads) {
    result.truncated = true;
    result.truncation.truncated = true;
    result.truncation.omitted_leads = unique.length - boundedMaxLeads;
    if (!result.truncation.reasons.includes("lead_cap")) {
      result.truncation.reasons.push("lead_cap");
    }
    leads = unique.slice(0, boundedMaxLeads);
  }

  result.leads = leads;

  // #758 adversarial-correctness contract: an optional clean-result report of
  // the boundaries attacked and why the attempted counterexamples held. Only
  // meaningful with no leads, validated as sanitized bounded strings, and
  // capped so one specialist cannot flood the artifact.
  const rawBoundaries = payload.boundaries_challenged;
  if (rawBoundaries !== undefined && rawBoundaries !== null) {
    if (!Array.isArray(rawBoundaries)) {
      addError(result, "boundaries_challenged must be a list of strings");
    } else {
      const boundaries: string[] = [];
      for (let index = 0; index < rawBoundaries.length; index++) {
        const entry = rawBoundaries[index];
        if (typeof entry !== "string" || !entry.trim()) {
          addError(result, `boundaries_challenged[${index}] is not a usable string`);
          continue;
        }
        boundaries.push(boundedText(sanitizeString(entry.trim()), boundedMaxMessageChars, "message_chars", result));
        if (boundaries.length >= MAX_BOUNDARIES_CHALLENGED) {
          result.truncated = true;
          result.truncation.truncated = true;
          result.truncation.omitted_boundaries_challenged = rawBoundaries.length - MAX_BOUNDARIES_CHALLENGED;
          if (!result.truncation.reasons.includes("boundary_cap")) {
            result.truncation.reasons.push("boundary_cap");
          }
          break;
        }
      }
      if (boundaries.length > 0 && leads.length > 0) {
        addError(result, "boundaries_challenged is only meaningful with no leads; dropping it because leads exist");
      } else {
        result.boundaries_challenged = boundaries;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tolerant raw-text parsing (JSON in fences / prose)
// ---------------------------------------------------------------------------

function stripMarkdownFence(text: string): string | null {
  const stripped = text.trim();
  if (!(stripped.startsWith("```") && stripped.endsWith("```") && stripped.length >= 6)) {
    return null;
  }
  let body = stripped.slice(3, -3);
  const newlineIdx = body.indexOf("\n");
  if (newlineIdx >= 0) {
    const first = body.slice(0, newlineIdx);
    if (first.trim() !== "" && /^[A-Za-z]+$/.test(first.trim())) {
      body = body.slice(newlineIdx + 1);
    }
  }
  return body;
}

/** Decode one JSON object starting exactly at `start` (the analog of
 * `json.JSONDecoder.raw_decode` restricted to `{`-openers, matching
 * `_scan_first_object`'s use in v2). Returns the value and the number of
 * characters consumed, or null when nothing decodes there. */
function decodeObjectAt(source: string, start: number): { value: unknown; consumed: number } | null {
  if (source[start] !== "{") return null;
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

function scanFirstObject(text: string): unknown {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i++;
      continue;
    }
    const decoded = decodeObjectAt(text, i);
    if (decoded === null) {
      i++;
      continue;
    }
    return decoded.value;
  }
  return null;
}

/** Best-effort extraction of the lead object from raw specialist output.
 * Tries, in order: a direct `JSON.parse`; the body of a single markdown code
 * fence; then the first complete JSON object found anywhere in the text.
 * Returns `null` when nothing decodes. */
export function extractSpecialistJson(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = stripMarkdownFence(trimmed);
  if (fenced !== null) {
    try {
      return JSON.parse(fenced);
    } catch {
      // fall through
    }
  }
  return scanFirstObject(trimmed);
}

/** Parse raw specialist output text and normalize it to a version-1 result.
 * Unlike `normalizeSpecialistOutput` this accepts the model's raw string
 * (which may be fenced or embedded in prose). Malformed JSON yields a result
 * with a `malformed JSON` error and empty leads — never an exception. */
export function parseSpecialistResponse(
  text: string | null | undefined,
  role: string,
  maxLeads: number = MAX_LEADS,
  maxMessageChars: number = MAX_MESSAGE_CHARS,
): SpecialistArtifact {
  const payload = extractSpecialistJson(text);
  if (payload === null) {
    const result = emptyArtifact();
    if (!SPECIALIST_ROLES.has(role)) {
      addError(
        result,
        `unknown specialist role: '${role}'; expected one of [${SPECIALIST_ROLES_ORDER.map((r) => `'${r}'`).join(", ")}]`,
      );
      return result;
    }
    result.role = role;
    addError(result, "malformed JSON: no decodable lead object found");
    return result;
  }
  return normalizeSpecialistOutput(payload, role, maxLeads, maxMessageChars);
}
