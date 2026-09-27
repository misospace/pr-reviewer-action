/** SARIF 2.1.0 ingestion (#706 PR 5a): a verbatim port of
 * `pr_reviewer/sarif.py` (`normalize_sarif`) and the SARIF glue in
 * `scripts/run_evidence_providers.py` (`_workspace_path`, `_sarif_provider`,
 * `_sarif_finding_message`, `_sarif_finding_source`).
 *
 * Security properties carried over unchanged:
 * - paths are workspace-relative only: absolute paths, `..` segments, NULs
 *   and symlinks resolving outside the workspace are refused;
 * - the file read is bounded (`MAX_INPUT_BYTES + 1` bytes, then rejected), so
 *   an oversize file is never slurped before the size check;
 * - every string that reaches the evidence entry (message, source, tool,
 *   rule, title, file, help URI, errors) goes through `redact_text` BEFORE it
 *   is stored, so `evidence-providers.json` and the markdown never carry a
 *   credential the SARIF producer echoed;
 * - SARIF content is data: no network, no commands, nothing executed.
 *
 * Character caps count code points (Python `len`), not UTF-16 units. */

import { closeSync, lstatSync, openSync, readSync, readlinkSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { redactText } from "../context/redact.js";
import type { ProviderSeverity } from "./providers.js";
import {
  PyFloat,
  PyJsonDecodeError,
  PyUncaughtError,
  PyUnicodeDecodeError,
  decodeUtf8Strict,
  isPyDict,
  pyIsStrictInt,
  pyJsonLoads,
  pyReprStr,
  pyStrip,
  pyTruthy,
} from "./pyjson.js";

export const ARTIFACT_VERSION = 1;
export const SARIF_VERSION = "2.1.0";
export const SOURCE_FORMAT = "sarif-2.1.0";
export const MAX_FINDINGS = 200;
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_TITLE_CHARS = 200;
export const MAX_ERRORS = 100;
export const MAX_INPUT_BYTES = 10_000_000;
export const ERRORS_TRUNCATED_MARKER = "errors_truncated";

export type SarifSeverity = "major" | "minor" | "info";

export interface SarifFinding {
  tool_name: string;
  tool_version: string;
  rule_id: string;
  title: string;
  message: string;
  severity: SarifSeverity;
  file: string;
  line: number | bigint | null;
  help_uri: string;
}

export interface SarifTruncation {
  truncated: boolean;
  reasons: string[];
  omitted_findings: number;
  omitted_message_chars: number;
  omitted_title_chars: number;
  omitted_errors: number;
}

/** The version-1 normalized artifact (snake_case, v2 key order). */
export interface SarifArtifact {
  version: number;
  source_format: string;
  findings: SarifFinding[];
  truncated: boolean;
  truncation: SarifTruncation;
  errors: string[];
}

function emptyArtifact(): SarifArtifact {
  return {
    version: ARTIFACT_VERSION,
    source_format: SOURCE_FORMAT,
    findings: [],
    truncated: false,
    truncation: {
      truncated: false,
      reasons: [],
      omitted_findings: 0,
      omitted_message_chars: 0,
      omitted_title_chars: 0,
      omitted_errors: 0,
    },
    errors: [],
  };
}

function addError(result: SarifArtifact, message: string): void {
  const errors = result.errors;
  if (errors.length < MAX_ERRORS) {
    errors.push(message);
    return;
  }
  result.truncated = true;
  result.truncation.truncated = true;
  result.truncation.omitted_errors += 1;
  if (errors[errors.length - 1] !== ERRORS_TRUNCATED_MARKER) errors.push(ERRORS_TRUNCATED_MARKER);
  if (!result.truncation.reasons.includes("errors_cap")) result.truncation.reasons.push("errors_cap");
}

function cap(value: unknown, fallback: number, name: string, result: SarifArtifact): number {
  if (!pyIsStrictInt(value) || value < 0) {
    addError(result, `${name} must be a non-negative integer`);
    return fallback;
  }
  return typeof value === "bigint" ? Number.MAX_SAFE_INTEGER : value;
}

function boundedText(value: string, limit: number, counter: "message_chars" | "title_chars", result: SarifArtifact): string {
  if (value.length <= limit) return value;
  const points = Array.from(value);
  if (points.length <= limit) return value;
  result.truncated = true;
  result.truncation.truncated = true;
  if (counter === "message_chars") result.truncation.omitted_message_chars += points.length - limit;
  else result.truncation.omitted_title_chars += points.length - limit;
  const reason = `${counter}_cap`;
  if (!result.truncation.reasons.includes(reason)) result.truncation.reasons.push(reason);
  return points.slice(0, limit).join("");
}

function get(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonBlank(text: string | null): text is string {
  return text !== null && text.length > 0 && pyStrip(text).length > 0;
}

function ruleTitle(rule: Record<string, unknown> | null, ruleId: string): string {
  if (rule !== null && pyTruthy(rule)) {
    const shortDescription = get(rule, "shortDescription");
    if (isPyDict(shortDescription)) {
      const text = str(get(shortDescription, "text"));
      if (nonBlank(text)) return text;
    }
    for (const key of ["name", "id"]) {
      const text = str(get(rule, key));
      if (nonBlank(text)) return text;
    }
  }
  return ruleId;
}

function helpUri(rule: Record<string, unknown> | null, informationUri: string): string {
  if (rule !== null && pyTruthy(rule)) {
    const value = str(get(rule, "helpUri"));
    if (nonBlank(value)) return value;
  }
  return informationUri;
}

function location(resultData: Record<string, unknown>, path: string, result: SarifArtifact): [string, number | bigint | null] {
  const locations = get(resultData, "locations");
  if (locations === null || locations === undefined) return ["", null];
  if (!Array.isArray(locations)) {
    addError(result, `${path}.locations is not an array`);
    return ["", null];
  }
  for (let index = 0; index < locations.length; index += 1) {
    const loc: unknown = locations[index];
    if (!isPyDict(loc)) {
      addError(result, `${path}.locations[${index}] is not an object`);
      continue;
    }
    const physical = get(loc, "physicalLocation");
    if (physical === null || physical === undefined) continue;
    if (!isPyDict(physical)) {
      addError(result, `${path}.locations[${index}].physicalLocation is not an object`);
      continue;
    }
    const artifact = get(physical, "artifactLocation");
    let uri = "";
    if (artifact !== null && artifact !== undefined) {
      if (isPyDict(artifact)) {
        const candidate = str(get(artifact, "uri"));
        if (nonBlank(candidate)) uri = candidate;
      } else {
        addError(result, `${path}.locations[${index}].physicalLocation.artifactLocation is not an object`);
      }
    }
    const region = get(physical, "region");
    let line: number | bigint | null = null;
    if (region !== null && region !== undefined) {
      if (isPyDict(region)) {
        const candidate = get(region, "startLine");
        if (pyIsStrictInt(candidate)) line = candidate;
      } else {
        addError(result, `${path}.locations[${index}].physicalLocation.region is not an object`);
      }
    }
    if (uri || line !== null) return [uri, line];
  }
  return ["", null];
}

function topLevelError(payload: unknown): string | null {
  if (!isPyDict(payload)) return "SARIF payload must be a JSON object";
  if (get(payload, "version") !== SARIF_VERSION) return "SARIF version must be exactly '2.1.0'";
  if (!Array.isArray(get(payload, "runs"))) return "SARIF payload must contain a runs array";
  return null;
}

const LEVEL_SEVERITY: Record<string, SarifSeverity> = { error: "major", warning: "minor", note: "info", none: "info" };

export interface NormalizeSarifOptions {
  maxFindings?: unknown;
  maxMessageChars?: unknown;
  maxTitleChars?: unknown;
}

/** `normalize_sarif`: decoded payload → version-1 artifact. No I/O. */
export function normalizeSarif(payload: unknown, options: NormalizeSarifOptions = {}): SarifArtifact {
  const output = emptyArtifact();
  const maxFindings = cap(options.maxFindings ?? MAX_FINDINGS, MAX_FINDINGS, "max_findings", output);
  const maxMessageChars = cap(options.maxMessageChars ?? MAX_MESSAGE_CHARS, MAX_MESSAGE_CHARS, "max_message_chars", output);
  const maxTitleChars = cap(options.maxTitleChars ?? MAX_TITLE_CHARS, MAX_TITLE_CHARS, "max_title_chars", output);

  const topError = topLevelError(payload);
  if (topError !== null) {
    addError(output, topError);
    return output;
  }
  const runs = get(payload as Record<string, unknown>, "runs") as unknown[];

  const candidates: SarifFinding[] = [];
  for (let runIndex = 0; runIndex < runs.length; runIndex += 1) {
    const run: unknown = runs[runIndex];
    const runPath = `runs[${runIndex}]`;
    if (!isPyDict(run)) {
      addError(output, `${runPath} is not an object`);
      continue;
    }

    let toolName = "";
    let toolVersion = "";
    let informationUri = "";
    const rules: Array<Record<string, unknown> | null> = [];
    const rulesById = new Map<string, Record<string, unknown>>();
    const tool = get(run, "tool");
    if (tool !== null && tool !== undefined) {
      if (!isPyDict(tool)) {
        addError(output, `${runPath}.tool is not an object`);
      } else {
        const driver = get(tool, "driver");
        if (driver !== null && driver !== undefined) {
          if (!isPyDict(driver)) {
            addError(output, `${runPath}.tool.driver is not an object`);
          } else {
            toolName = str(get(driver, "name")) || "";
            toolVersion = str(get(driver, "version")) || "";
            informationUri = str(get(driver, "informationUri")) || "";
            const rawRules = get(driver, "rules");
            if (rawRules !== null && rawRules !== undefined) {
              if (!Array.isArray(rawRules)) {
                addError(output, `${runPath}.tool.driver.rules is not an array`);
              } else {
                for (let ruleIndex = 0; ruleIndex < rawRules.length; ruleIndex += 1) {
                  const rule: unknown = rawRules[ruleIndex];
                  if (!isPyDict(rule)) {
                    addError(output, `${runPath}.tool.driver.rules[${ruleIndex}] is not an object`);
                    rules.push(null);
                    continue;
                  }
                  rules.push(rule);
                  const ruleId = str(get(rule, "id"));
                  if (ruleId && !rulesById.has(ruleId)) rulesById.set(ruleId, rule);
                }
              }
            }
          }
        }
      }
    }

    const rawResults = Object.prototype.hasOwnProperty.call(run, "results") ? run.results : [];
    if (!Array.isArray(rawResults)) {
      addError(output, `${runPath}.results is not an array`);
      continue;
    }
    for (let resultIndex = 0; resultIndex < rawResults.length; resultIndex += 1) {
      const resultData: unknown = rawResults[resultIndex];
      const resultPath = `${runPath}.results[${resultIndex}]`;
      if (!isPyDict(resultData)) {
        addError(output, `${resultPath} is not an object`);
        continue;
      }
      const messageData = get(resultData, "message");
      const message = isPyDict(messageData) ? get(messageData, "text") : null;
      if (typeof message !== "string" || pyStrip(message).length === 0) {
        addError(output, `${resultPath} is missing a usable message`);
        continue;
      }

      let ruleId = str(get(resultData, "ruleId")) || "";
      let rule: Record<string, unknown> | null = rulesById.get(ruleId) ?? null;
      if (!ruleId) {
        const ruleIndex = get(resultData, "ruleIndex");
        if (typeof ruleIndex === "number" && Number.isInteger(ruleIndex) && ruleIndex >= 0 && ruleIndex < rules.length) {
          rule = rules[ruleIndex] ?? null;
          if (rule !== null) ruleId = str(get(rule, "id")) || "";
        }
      }
      const level = Object.prototype.hasOwnProperty.call(resultData, "level") ? str(get(resultData, "level")) : "warning";
      const severity = LEVEL_SEVERITY[pyStrip(level || "").toLowerCase()] ?? "info";
      const [fileUri, line] = location(resultData, resultPath, output);
      const title = ruleTitle(rule, ruleId);
      candidates.push({
        tool_name: toolName,
        tool_version: toolVersion,
        rule_id: ruleId,
        title: boundedText(title, maxTitleChars, "title_chars", output),
        message: boundedText(message, maxMessageChars, "message_chars", output),
        severity,
        file: fileUri,
        line,
        help_uri: helpUri(rule, informationUri),
      });
    }
  }

  const seen = new Set<string>();
  let unique: SarifFinding[] = [];
  for (const finding of candidates) {
    const key = JSON.stringify([
      finding.tool_name,
      finding.tool_version,
      finding.rule_id,
      finding.title,
      finding.message,
      finding.severity,
      finding.file,
      finding.line === null ? null : finding.line.toString(),
      finding.help_uri,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }

  if (unique.length > maxFindings) {
    output.truncated = true;
    output.truncation.truncated = true;
    output.truncation.omitted_findings = unique.length - maxFindings;
    output.truncation.reasons.push("finding_cap");
    unique = unique.slice(0, maxFindings);
  }
  output.findings = unique;
  return output;
}

// ── Glue: workspace-bounded file ingestion into an evidence entry ─────────

/** One SARIF file as an evidence-provider entry (v2 key order). */
export interface SarifEvidenceEntry {
  id: string;
  kind: "sarif";
  status: "ok" | "error";
  command: string;
  duration_sec: PyFloat;
  exit_code: null;
  provider_severity: ProviderSeverity;
  findings: Array<{
    severity: SarifSeverity;
    message: string;
    source: string;
    tool_name: string;
    tool_version: string;
    rule_id: string;
    title: string;
    file: string;
    line: number | bigint | null;
    help_uri: string;
  }>;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  source: string;
  output_format: string;
}

const PY_STRERROR: Record<string, string> = {
  EACCES: "Permission denied",
  EISDIR: "Is a directory",
  ENOENT: "No such file or directory",
  ENOTDIR: "Not a directory",
  ELOOP: "Too many levels of symbolic links",
  EPERM: "Operation not permitted",
  EIO: "Input/output error",
  EMFILE: "Too many open files",
  ENAMETOOLONG: "File name too long",
};

/** `str(OSError)` for a Node fs error: `[Errno N] strerror: 'filename'`. */
export function pyOsErrorMessage(error: unknown, filename: string): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const errno = (osConstants.errno as Record<string, number | undefined>)[code];
  const text = PY_STRERROR[code];
  if (errno === undefined || text === undefined) return error instanceof Error ? error.message : String(error);
  return `[Errno ${errno}] ${text}: ${pyReprStr(filename)}`;
}

/** `os.path.realpath(path, strict=False)` for an absolute, dot-free path:
 * symlinks are followed where components exist, missing tails appended. */
function realpathLoose(absolute: string, depth = 0): string {
  if (depth > 40) throw Object.assign(new Error("symlink loop"), { code: "ELOOP" });
  const parts = absolute.split(sep).filter((part) => part.length > 0);
  let current: string = sep;
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = join(current, parts[i] as string);
    let isLink = false;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch {
      return join(candidate, ...parts.slice(i + 1));
    }
    if (isLink) {
      const target = readlinkSync(candidate);
      const resolvedTarget = realpathLoose(resolvePath(dirname(candidate), target), depth + 1);
      current = resolvedTarget;
    } else {
      current = candidate;
    }
  }
  return current;
}

function isRelativeTo(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/** `_workspace_path`: the resolved file path, or null when the text is not a
 * workspace-relative path that stays inside the workspace. */
export function workspacePath(pathText: string, workspaceRoot: string): string | null {
  if (!pathText || pathText.includes("\u0000")) return null;
  if (isAbsolute(pathText) || pathText.split("/").includes("..")) return null;
  try {
    const root = realpathLoose(resolvePath(workspaceRoot));
    const resolved = realpathLoose(resolvePath(root, pathText));
    return isRelativeTo(resolved, root) ? resolved : null;
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Read at most `limit` bytes (the #574 bounded-read contract). */
function readBounded(path: string, limit: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const chunk = Buffer.allocUnsafe(Math.min(1 << 20, limit - total));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function sarifFindingMessage(finding: SarifFinding): string {
  let loc = "";
  if (finding.file) {
    loc = ` (${finding.file}`;
    if (finding.line !== null) loc += `:${finding.line.toString()}`;
    loc += ")";
  }
  const ruleId = finding.rule_id || "";
  const rule = ruleId ? ` [${ruleId}]` : "";
  // normalize_sarif falls back title to the ruleId when a rule carries no
  // metadata; prefixing that alongside the "[ruleId]" suffix would duplicate it.
  const title = finding.title || "";
  const titlePrefix = title && title !== ruleId ? `${title}: ` : "";
  return `${titlePrefix}${finding.message}${rule}${loc}`;
}

function sarifFindingSource(finding: SarifFinding, pathText: string): string {
  return `${pathText} (${finding.tool_name || "SARIF"})`;
}

const RANK: Record<string, number> = { blocker: 3, major: 2, warning: 2 };

/** `_sarif_provider`: ingest one workspace-relative SARIF file. */
export function sarifProviderEntry(index: number, pathText: string, workspaceRoot: string, maxFindings: number): SarifEvidenceEntry {
  const entry: SarifEvidenceEntry = {
    id: `sarif-${index}`,
    kind: "sarif",
    status: "error",
    command: "",
    duration_sec: new PyFloat(0),
    exit_code: null,
    provider_severity: "info",
    findings: [],
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    source: redactText(pathText),
    output_format: SOURCE_FORMAT,
  };
  const path = workspacePath(pathText, workspaceRoot);
  if (path === null) {
    entry.provider_severity = "major";
    entry.stderr = "SARIF path must be a workspace-relative path that stays inside the workspace";
    return entry;
  }
  if (!isRegularFile(path)) {
    entry.provider_severity = "major";
    entry.stderr = redactText(`SARIF file not found or not a regular file: ${pathText}`);
    return entry;
  }

  let payload: unknown;
  try {
    let raw: Buffer;
    try {
      raw = readBounded(path, MAX_INPUT_BYTES + 1);
    } catch (error) {
      throw new Error(pyOsErrorMessage(error, path));
    }
    if (raw.length > MAX_INPUT_BYTES) throw new Error(`SARIF input exceeds ${MAX_INPUT_BYTES} byte limit`);
    payload = pyJsonLoads(decodeUtf8Strict(raw, true));
  } catch (error) {
    const known =
      error instanceof PyJsonDecodeError ||
      error instanceof PyUnicodeDecodeError ||
      (error instanceof PyUncaughtError && error.pyType === "ValueError") ||
      (error instanceof Error && !(error instanceof PyUncaughtError));
    if (!known) throw error;
    entry.provider_severity = "major";
    entry.stderr = redactText(`Unable to parse SARIF file ${pathText}: ${(error as Error).message}`);
    return entry;
  }

  const normalized = normalizeSarif(payload, { maxFindings });
  entry.findings = normalized.findings.map((item) => ({
    severity: item.severity,
    message: redactText(sarifFindingMessage(item)),
    source: redactText(sarifFindingSource(item, pathText)),
    tool_name: redactText(item.tool_name),
    tool_version: redactText(item.tool_version),
    rule_id: redactText(item.rule_id),
    title: redactText(item.title),
    file: redactText(item.file),
    line: item.line,
    help_uri: redactText(item.help_uri),
  }));
  if (normalized.errors.length > 0) entry.stderr = redactText(normalized.errors.join("; "));
  if (normalized.truncated) {
    // Covers both a per-file finding cap and an exhausted collective cap
    // (max_findings=0), so an empty-looking entry is distinguishable from a
    // genuinely clean SARIF file.
    const note = `SARIF findings capped: ${entry.findings.length} included, ${normalized.truncation.omitted_findings} omitted`;
    entry.stderr = entry.stderr ? `${entry.stderr}; ${note}` : note;
  }
  entry.status = normalized.errors.length > 0 ? "error" : "ok";
  let highest: ProviderSeverity = entry.provider_severity;
  let first = true;
  for (const finding of entry.findings) {
    if (first || (RANK[finding.severity] ?? 1) > (RANK[highest] ?? 1)) highest = finding.severity;
    first = false;
  }
  entry.provider_severity = highest;
  return entry;
}

/** `_split_sarif_paths`: comma/newline separated, stripped, blanks dropped. */
export function splitSarifPaths(raw: string): string[] {
  return raw.split(/[,\n]/).map((part) => pyStrip(part)).filter((part) => part.length > 0);
}
