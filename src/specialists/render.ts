/** Fence-safe markdown rendering for specialist leads (v3 port of the
 * rendering half of `pr_reviewer/specialists.py`): per-role markdown and the
 * aggregate "Specialist Review Leads" corpus section (#609). Messages are
 * control-character-escaped and each file path is wrapped in a backtick code
 * span whose delimiter is strictly longer than any backtick run in the path,
 * so a hostile message/path cannot close the enclosing fence, forge a
 * heading, or inject instructions into a later prompt. */

import { redactText } from "../context/redact.js";
import { MAX_FENCE, SPECIALIST_ROLES_ORDER, type SpecialistArtifact, type SpecialistLead } from "./types.js";

const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const BACKTICK_RUN_RE = /`+/g;

function escapeControlChars(text: string): string {
  return text.replace(CONTROL_RE, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\t") return "\\t";
    if (ch === "\r") return "\\r";
    return `\\u${ch.codePointAt(0)!.toString(16).padStart(4, "0")}`;
  });
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(BACKTICK_RUN_RE)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return longest;
}

/** Return `[neutralizedContent, fence]` where `fence` is backticks strictly
 * longer than any backtick run in `content`. Hostile runs of `MAX_FENCE` or
 * more backticks are neutralized (a run of 11+ is reduced to 10) so the
 * emitted fence can never be matched by the content. */
function safeFence(content: string): [string, string] {
  let longest = longestBacktickRun(content);
  let body = content;
  if (longest + 1 > MAX_FENCE) {
    body = body.replace(BACKTICK_RUN_RE, (run) => (run.length >= 11 ? "`".repeat(10) : run));
    longest = Math.min(longest, 10);
  }
  const fence = "`".repeat(Math.max(longest + 1, 4));
  return [body, fence];
}

function leadLine(lead: Pick<SpecialistLead, "severity" | "category" | "file" | "line" | "message" | "trigger" | "consequence">): string {
  const message = escapeControlChars(lead.message ?? "");
  const parts = [`- [${lead.severity ?? "info"}] ${message}`];
  const filePath = lead.file;
  if (filePath) {
    const span = filePath.replace(BACKTICK_RUN_RE, (run) => (run.length > 10 ? "`".repeat(10) : run));
    const run = longestBacktickRun(span);
    const delim = "`".repeat(run + 1);
    parts.push(` at ${delim}${span}${delim}`);
  }
  const line = lead.line;
  if (line !== null && line !== undefined) {
    parts.push(`:${line}`);
  }
  const category = lead.category;
  if (category) {
    parts.push(` (${category})`);
  }
  // #758 adversarial-correctness contract: the falsifying input and the
  // wrong observable it produces, when the lead carried them.
  if (lead.trigger) {
    parts.push(` [trigger: ${escapeControlChars(lead.trigger)}]`);
  }
  if (lead.consequence) {
    parts.push(` [consequence: ${escapeControlChars(lead.consequence)}]`);
  }
  return parts.join("");
}

/** Wrap `leadLines` in a fence that a hostile message cannot close. A
 * zero-lead document carries no fence (nothing to close); a lead document
 * wraps the whole block in a markdown fence so a hostile message cannot
 * terminate it early. */
function assembleSpecialistMarkdown(header: string, leadLines: string[], note: string | null): string {
  const lines: string[] = [header, ""];
  for (const ln of leadLines) {
    lines.push(ln);
    lines.push("");
  }
  if (note) {
    lines.push(note);
    lines.push("");
  }
  if (leadLines.length === 0) {
    if (note === null) {
      lines.push("No advisory leads reported.");
      lines.push("");
    }
    return lines.join("\n");
  }
  const body = lines.join("\n");
  const [neutralized, fence] = safeFence(body);
  const splitAt = neutralized.indexOf("\n");
  const head = splitAt === -1 ? neutralized : neutralized.slice(0, splitAt);
  const rest = splitAt === -1 ? "" : neutralized.slice(splitAt + 1);
  return `${head}\n${fence}markdown\n${rest}${fence}\n`;
}

/** Longest code-point prefix within `maxBytes`; never splits a surrogate pair. */
export function fitToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

/** Render a normalized specialist result as fence-safe markdown. When
 * `maxBytes > 0` a hard UTF-8 byte cap applies: trailing whole lead lines are
 * dropped (never a message mid-character) until the budget holds, and the
 * omission is always visible. */
export function renderSpecialistMarkdown(result: SpecialistArtifact, maxBytes = 0): string {
  const role = result.role ?? "";
  const leads = result.leads ?? [];
  const header = `## Specialist: ${role}`;
  const leadLines = leads.map((lead) => leadLine(lead));
  if (leadLines.length === 0) {
    // #758 adversarial-correctness clean-result report.
    const boundaries = result.boundaries_challenged;
    if (Array.isArray(boundaries)) {
      for (const entry of boundaries) {
        if (typeof entry === "string" && entry.trim()) {
          leadLines.push(`- ${escapeControlChars(redactText(entry.trim()))}`);
        }
      }
    }
  }

  let doc = assembleSpecialistMarkdown(header, leadLines, null);
  if (!maxBytes) return doc;

  while (Buffer.byteLength(doc, "utf8") > maxBytes && leadLines.length > 0) {
    leadLines.pop();
    doc = assembleSpecialistMarkdown(header, leadLines, "… more leads omitted (byte cap)");
  }
  if (Buffer.byteLength(doc, "utf8") > maxBytes) {
    doc = fitToBytes(doc, maxBytes);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Aggregate "Specialist Review Leads" corpus section (#609)
// ---------------------------------------------------------------------------

/** Exact title of the aggregate corpus section. */
export const SPECIALIST_LEADS_TITLE = "Specialist Review Leads";

/** Advisory framing paragraph: the leads are unverified signals, never
 * findings — the final reviewer verifies them against PR evidence. */
export const SPECIALIST_LEADS_FRAMING =
  "These are unverified advisory leads from independent specialist passes. " +
  "They are not findings or proof. Verify each relevant claim against the " +
  "PR/repository evidence before using it in the final review.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensively redact and control-escape one lead for section rendering.
 * Re-applies the shared secret-redaction plus control-character escaping so
 * an un-normalized artifact cannot leak a raw secret or a raw control byte
 * into the final corpus. Returns `null` when the lead is unusable. */
function sanitizeLeadForSection(lead: unknown): SpecialistLead | null {
  if (!isRecord(lead)) return null;
  const rawMessage = lead.message;
  if (typeof rawMessage !== "string" || rawMessage.trim() === "") return null;
  const message = escapeControlChars(redactText(rawMessage));
  if (message.trim() === "") return null;
  let filePath = lead.file;
  let category = lead.category;
  if (typeof filePath === "string" && filePath) {
    filePath = redactText(filePath);
  }
  if (typeof category === "string") {
    category = redactText(category);
  }
  const rawLine = lead.line;
  const sanitized: SpecialistLead = {
    severity: typeof lead.severity === "string" && lead.severity ? lead.severity : "info",
    category: typeof category === "string" ? category : "",
    file: typeof filePath === "string" && filePath ? filePath : null,
    line: typeof rawLine === "number" ? rawLine : null,
    message,
  };
  for (const field of ["trigger", "consequence"] as const) {
    const raw = lead[field];
    if (typeof raw === "string" && raw.trim()) {
      sanitized[field] = escapeControlChars(redactText(raw));
    }
  }
  return sanitized;
}

/** Render the aggregate "Specialist Review Leads" corpus section (#609).
 *
 * `roleResults` maps each role name to its normalized version-1 specialist
 * artifact, or `null`/absent for a role whose advisory pass was missing or
 * unparseable. Only the three fixed roles render, in the fixed order of
 * `SPECIALIST_ROLES_ORDER`; any other mapping keys are ignored.
 *
 * `skippedRoles` (#633) names roles that were deterministically skipped by
 * classifier-driven auto selection — they ran no pass, so they render NO
 * block at all (not even the zero-lead note, which would falsely imply the
 * pass ran and found nothing).
 *
 * A hard UTF-8 byte cap applies to the whole returned document. Truncation
 * drops whole leads only (never a partial line), always the LAST lead of the
 * LAST role that still has leads (reverse fixed-role order), appending a
 * deterministic omission footer. If no complete lead survives truncation (or
 * no role has any usable lead to begin with), returns `""` — the caller
 * treats that as "section dropped". Deterministic: identical input produces
 * byte-identical output on every call. */
export function renderSpecialistLeadsSection(
  roleResults: Record<string, unknown>,
  maxBytes: number,
  skippedRoles: readonly string[] = [],
): string {
  const skipped = new Set(skippedRoles);
  const activeRoles = SPECIALIST_ROLES_ORDER.filter((role) => !skipped.has(role));
  const roleLeadLines: string[][] = [];
  const roleNotes: string[] = [];

  for (const role of activeRoles) {
    const artifact = roleResults ? roleResults[role] : undefined;
    const lines: string[] = [];
    if (isRecord(artifact)) {
      const rawLeads = artifact.leads;
      if (Array.isArray(rawLeads)) {
        for (const lead of rawLeads) {
          const sanitized = sanitizeLeadForSection(lead);
          if (sanitized !== null) lines.push(leadLine(sanitized));
        }
      }
    }
    // #758 adversarial-correctness clean-result report: when the pass
    // produced no leads but named the boundaries it attacked, the boundary
    // entries ARE the role's content (droppable lines under the byte cap,
    // like leads). The normalizer drops boundaries when leads exist, so the
    // two never mix here.
    if (lines.length === 0 && isRecord(artifact)) {
      const boundaries = artifact.boundaries_challenged;
      if (Array.isArray(boundaries)) {
        for (const entry of boundaries) {
          if (typeof entry === "string" && entry.trim()) {
            lines.push(`- ${escapeControlChars(redactText(entry.trim()))}`);
          }
        }
      }
    }
    const errors = isRecord(artifact) ? artifact.errors : undefined;
    const nErrors = Array.isArray(errors) ? errors.length : 0;
    let note: string;
    if (lines.length > 0) {
      note = "";
    } else if (nErrors) {
      note = `- advisory pass reported no leads (${nErrors} pass-level error(s))`;
    } else {
      note = "- no advisory leads";
    }
    roleLeadLines.push(lines);
    roleNotes.push(note);
  }

  if (roleLeadLines.reduce((sum, lines) => sum + lines.length, 0) === 0) {
    return "";
  }

  const build = (linesPerRole: string[][], omitted: number): string => {
    const roleSections = activeRoles.map((role, index) =>
      assembleSpecialistMarkdown(
        `## ${role.charAt(0).toUpperCase()}${role.slice(1)}`,
        linesPerRole[index]!,
        linesPerRole[index]!.length === 0 ? roleNotes[index]! : null,
      ),
    );
    let doc = [`# ${SPECIALIST_LEADS_TITLE}`, "", SPECIALIST_LEADS_FRAMING, "", ...roleSections].join("\n");
    if (omitted) {
      doc += `\n… ${omitted} lead(s) omitted (byte cap)\n`;
    }
    return doc;
  };

  let omitted = 0;
  let doc = build(roleLeadLines, 0);
  while (Buffer.byteLength(doc, "utf8") > maxBytes) {
    let target = -1;
    for (let i = activeRoles.length - 1; i >= 0; i--) {
      if (roleLeadLines[i]!.length > 0) {
        target = i;
        break;
      }
    }
    if (target === -1) {
      return "";
    }
    roleLeadLines[target]!.pop();
    omitted += 1;
    doc = build(roleLeadLines, omitted);
  }
  if (!roleLeadLines.some((lines) => lines.length > 0)) {
    return "";
  }
  return doc;
}
