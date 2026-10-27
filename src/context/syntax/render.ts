/** Renderers for the syntax-aware context (#764, phase 1).
 *
 * The Markdown is a CORPUS surface: hostile repository content reaches it.
 * Two rules therefore hold everywhere below:
 *   - a snippet is rendered inside a code fence whose delimiter is LONGER
 *     than any backtick run in that snippet (`fenceDelimiterFor`), so no
 *     content can close its own fence;
 *   - a snippet's PROVENANCE is stamped on the harness-authored header line
 *     that precedes the fence, never on the fenced body, so repository text
 *     can never forge the annotation channel.
 *
 * Pointer labels (paths, names) are sanitized instead: they are labels, not
 * content, and a mangled hostile label is acceptable where a broken
 * document is not. */

import { fenceDelimiterFor } from "../fence.js";
import { clipMarkdown, fenceSafeLength } from "../related-context.js";
import { provenanceAttributes, type EvidenceProvenance } from "../evidence-provenance.js";
import { pyJsonDump } from "../py-json.js";

/** The Markdown byte cap of the rendered section. */
export const MAX_SYNTAX_MARKDOWN_BYTES = 100_000;

/** The marker the clip step appends when it cuts the rendered Markdown. */
export const SYNTAX_CLIP_MARKER = "[syntax context truncated]\n";

const CONTROL_RE = /[\x00-\x1f\x7f]/g;

function utf8Len(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Escape control characters and bound the length of a label. */
function display(value: unknown, limit = 200): string {
  let text = String(value ?? "").replace(CONTROL_RE, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  if (text.length > limit) text = `${text.slice(0, limit - 3)}...`;
  return text;
}

/** A pointer label as a code span. Backticks and line breaks are removed:
 * a label is a label, and a broken code span would let the rest of the line
 * render as markdown. */
function codeSpan(value: unknown): string {
  const safe = display(value).replace(/[`\r\n]/g, "");
  return `\`${safe}\``;
}

/** `path:line` as one code span. */
function location(path: unknown, line: unknown): string {
  const rendered = codeSpan(path);
  const number = typeof line === "number" && Number.isInteger(line) && line > 0 ? line : 0;
  return number > 0 ? `${rendered}:${number}` : rendered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The provenance attributes of a persisted record, re-validated on the way
 * back in: an artifact may have round-tripped through JSON, and a record
 * that cannot be read renders NO attributes (the conservative direction —
 * the text is still shown, never claimed to be committed source). */
function provenanceAttributesOf(value: unknown): string {
  if (!isRecord(value)) return "";
  const representation = value.representation;
  if (representation !== "committed_source" && representation !== "sanitized_source") return "";
  const count = value.redaction_count;
  if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) return "";
  if (representation === "committed_source" && count > 0) return "";
  if (representation === "sanitized_source" && count === 0) return "";
  if (value.file !== undefined && typeof value.file !== "string") return "";
  if (value.revision !== undefined && typeof value.revision !== "string") return "";
  return provenanceAttributes({
    representation,
    synthesized: count > 0,
    redactionCount: count,
    file: typeof value.file === "string" ? value.file : null,
    revision: typeof value.revision === "string" ? value.revision : null,
  });
}

/** A snippet inside an adaptive code fence. The delimiter is longer than
 * any backtick run in the content, so the content cannot close the fence;
 * the body is indented, so a line inside it cannot become a heading. */
function fenced(body: string, indent = "  "): string[] {
  const fence = fenceDelimiterFor(body);
  const lines = body.split("\n");
  return [`${indent}${fence}`, ...lines.map((line) => `${indent}${line}`), `${indent}${fence}`];
}

function renderDeclarationLines(declarations: readonly unknown[]): string[] {
  const lines: string[] = ["## Touched declarations", ""];
  if (declarations.length === 0) {
    lines.push("_(none)_");
    lines.push("");
    return lines;
  }
  for (const entry of declarations) {
    if (!isRecord(entry)) continue;
    const kind = display(entry.kind, 40);
    const head = `- ${location(entry.path, entry.start_line)} — ${codeSpan(entry.name)} (${kind})`;
    lines.push(`${head}${provenanceAttributesOf(entry.provenance)}`);
    const body = typeof entry.body === "string" ? entry.body : "";
    if (body !== "") lines.push(...fenced(body));
    if (entry.body_truncated === true) lines.push("  _(body cut)_");
  }
  lines.push("");
  return lines;
}

function renderDefinitionLines(definitions: readonly unknown[]): string[] {
  const lines: string[] = ["## Definitions of referenced identifiers", ""];
  if (definitions.length === 0) {
    lines.push("_(none)_");
    lines.push("");
    return lines;
  }
  for (const entry of definitions) {
    if (!isRecord(entry)) continue;
    const refs = Array.isArray(entry.referenced_from) ? entry.referenced_from : [];
    const from = refs
      .filter(isRecord)
      .map((ref) => location(ref.path, ref.line))
      .join(", ");
    const kind = display(entry.kind, 40);
    const suffix = from === "" ? "" : `; referenced from ${from}`;
    lines.push(`- ${codeSpan(entry.name)} — ${location(entry.path, entry.line)} (${kind})${suffix}${provenanceAttributesOf(entry.provenance)}`);
  }
  lines.push("");
  return lines;
}

function renderCallerLines(callers: readonly unknown[]): string[] {
  const lines: string[] = ["## Callers of changed declarations", ""];
  if (callers.length === 0) {
    lines.push("_(none)_");
    lines.push("");
    return lines;
  }
  for (const entry of callers) {
    if (!isRecord(entry)) continue;
    const declaration = isRecord(entry.declaration) ? entry.declaration : {};
    const head = `- ${codeSpan(entry.name)} called at ${location(entry.path, entry.line)} → ${location(declaration.path, declaration.line)}`;
    lines.push(`${head}${provenanceAttributesOf(entry.provenance)}`);
    const snippet = typeof entry.snippet === "string" ? entry.snippet : "";
    if (snippet !== "") lines.push(...fenced(snippet));
  }
  lines.push("");
  return lines;
}

/** The rendered Markdown document, cut at a fence-safe boundary when it
 * exceeds `maxBytes`. */
export function renderSyntaxContextMarkdown(
  artifact: Record<string, unknown>,
  maxBytes: number | null = MAX_SYNTAX_MARKDOWN_BYTES,
): string {
  const version = typeof artifact.artifact_version === "string" || typeof artifact.artifact_version === "number"
    ? String(artifact.artifact_version)
    : "1";
  const declarations = Array.isArray(artifact.declarations) ? (artifact.declarations as unknown[]) : [];
  const definitions = Array.isArray(artifact.definitions) ? (artifact.definitions as unknown[]) : [];
  const callers = Array.isArray(artifact.callers) ? (artifact.callers as unknown[]) : [];
  const lines: string[] = [
    `# Syntax Context (v${version})`,
    "",
    "_Whole declarations the change touches, the definitions of the identifiers the changed lines reference, and the callers of the touched declarations. Textual evidence, not proof._",
    "",
    ...renderDeclarationLines(declarations),
    ...renderDefinitionLines(definitions),
    ...renderCallerLines(callers),
  ];
  const errors = Array.isArray(artifact.errors) ? (artifact.errors as unknown[]) : [];
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    for (const error of errors) lines.push(`- ${codeSpan(error)}`);
    lines.push("");
  }
  if (artifact.truncated === true) {
    lines.push("## Bounds");
    lines.push("");
    lines.push("_Output is bounded and incomplete._");
    lines.push("");
  }
  const full = `${lines.join("\n")}\n`;
  if (maxBytes === null) return full;
  const cap = Math.max(1, Math.trunc(maxBytes));
  if (utf8Len(full) <= cap) return full;
  const note = `_Markdown output cut at the ${cap}-byte cap._`;
  const chosen: string[] = [];
  let used = 0;
  const noteBytes = utf8Len(`${note}\n`);
  for (const line of lines) {
    const lineBytes = utf8Len(`${line}\n`);
    if (used + lineBytes + noteBytes > cap) break;
    chosen.push(line);
    used += lineBytes;
  }
  chosen.splice(fenceSafeLength(chosen));
  if (chosen.length === 0) return "\n";
  return `${[...chosen, note].join("\n")}\n`;
}

/** The rendered JSON document: pretty-printed, with a trailing newline. */
export function renderSyntaxContextJson(artifact: Record<string, unknown>, indent = 2): string {
  const width = Math.min(Math.max(0, Math.trunc(indent)), 8);
  try {
    return `${pyJsonDump(artifact, width)}\n`;
  } catch {
    return `${JSON.stringify(artifact, null, width)}\n`;
  }
}

/** Cut the rendered Markdown to `maxBytes` on a whole-line, fence-safe
 * boundary. `null` is the failure exit (a non-positive budget). */
export function clipSyntaxContextMarkdown(markdown: Uint8Array, maxBytes: number): Uint8Array | null {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return null;
  return clipMarkdown(markdown, maxBytes, SYNTAX_CLIP_MARKER);
}

/** The provenance record of an in-memory item, as the renderer reads it. */
export function syntaxProvenanceAttributes(provenance: EvidenceProvenance): string {
  return provenanceAttributes(provenance);
}
