/** Inline finding anchoring port of `scripts/build_review_comments.py` (#680).
 * The diff walk preserves both final-file lines and patch-relative positions so
 * GitHub and Forgejo publish the same validated findings. */
import { redactText } from "../context/redact.js";
import { sanitizeMarkdown } from "./sanitize.js";

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
/** Exported for the outside-diff summary renderer (v3-only, `../enforcement/outside-diff.js`
 * pairs it with `diffPositions` below) so severity labels never drift between the
 * two finding-rendering call sites. */
export const SEVERITY_LABELS: Record<string, string> = {
  blocker: "🛑 Blocker",
  major: "⚠️ Major",
  minor: "Minor",
  info: "Info",
};

type PositionMap = Map<string, Map<number, number>>;
type Finding = Record<string, unknown>;

/** The per-comment disclaimer every inline finding body carries. Exported so
 * the usefulness-feedback recovery can prove a comment is one of ours before
 * it reads a prescription out of it. */
export const INLINE_DISCLAIMER = "_Automated finding from AI PR review._";

/** #762: the single static usefulness affordance appended to an actionable
 * finding. Static text only — never model-authored, so no finding text can
 * forge or extend it — and advisory by construction: a reaction is telemetry
 * and can never resolve a finding or change this review's verdict. Appended
 * only where a replacement block was actually rendered, exactly once. */
export const FEEDBACK_AFFORDANCE =
  "👍 helpful · 👎 not helpful — advisory only; it never changes this review's verdict.";

/** #762: the correlation key for "this exact prescription at this exact
 * published range". The range — not a single line — is part of the key because
 * a multi-line prescription is published anchored at its END line: keying on
 * one line would let a rejection of a 1-2 range silently drop a different,
 * single-line-at-2 prescription with the same text. NUL-separated, so no
 * path, line, or replacement text can be arranged to collide with another key. */
export function prescriptionKey(path: string, rangeStart: number, rangeEnd: number, replacement: string): string {
  return `${path}\u0000${rangeStart}\u0000${rangeEnd}\u0000${replacement}`;
}

/** Verbatim diff-position walk from `scripts/build_review_comments.py` (#680). */
export function diffPositions(diffText: string): PositionMap {
  const positionsByPath: PositionMap = new Map();
  let currentPath: string | null = null;
  let newLine = 0;
  let diffPosition = 0;
  let inHunk = false;

  const lines = diffText === "" ? [] : diffText.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "" && /(?:\r\n|\n|\r)$/.test(diffText)) lines.pop();
  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      diffPosition = 0;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      currentPath = target === "/dev/null" ? null : target.startsWith("b/") ? target.slice(2) : target;
      continue;
    }
    const match = HUNK_RE.exec(raw);
    if (match) {
      newLine = Number.parseInt(match[1]!, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentPath === null || raw.startsWith("\\")) continue;

    diffPosition += 1;
    let map = positionsByPath.get(currentPath);
    if (raw.startsWith("+")) {
      if (!map) positionsByPath.set(currentPath, (map = new Map()));
      map.set(newLine, diffPosition);
      newLine += 1;
    } else if (!raw.startsWith("-")) {
      if (!map) positionsByPath.set(currentPath, (map = new Map()));
      map.set(newLine, diffPosition);
      newLine += 1;
    }
  }
  return positionsByPath;
}

/** Render one finding using the v2 label, redaction, and markdown boundaries (#561). */
export function findingToBody(finding: Finding, linkMode: string): string {
  const severity = finding.severity || "info";
  const rawSeverity = String(severity);
  const label = Object.hasOwn(SEVERITY_LABELS, rawSeverity) ? SEVERITY_LABELS[rawSeverity]! : rawSeverity;
  const category = finding.category;
  const suffix = category && category !== "other" ? ` (${String(category)})` : "";
  const message = String(finding.message || "").trim();
  const body = `**${label}${suffix}:** ${message}\n\n${INLINE_DISCLAIMER}`;
  const mode = linkMode === "inert" || linkMode === "togithub" ? linkMode : "inert";
  return sanitizeMarkdown(redactText(body), mode);
}

function isRecord(value: unknown): value is Finding {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

type Actionable = { start: number; end: number; replacement: string };

/** #762: longest run of consecutive backticks in *content* (0 when none) —
 * the fence length must outlast it so no inner run can close the block. */
function longestBacktickRun(content: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of content) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** #762: wrap *content* in a backtick fence of `max(3, longestRun + 1)`
 * backticks so any inner backtick run cannot break out of the fence. */
function wrapFence(content: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** #762: the trailing-newline trim a suggestion is rendered with, so a
 * published prescription and the rejection key describing it carry the same
 * text. */
export function normalizedReplacement(suggestion: string): string {
  return suggestion.replace(/[\r\n]+$/, "");
}

/** #762: derive the one-click suggestion action from the finding record, or
 * null when the suggestion is absent/blank, fence-hostile (any line whose
 * trim() begins with 3+ backticks or 3+ tildes), or the [start..end_line]
 * range is not fully presentable in the diff. The anchor line is already
 * validated by the caller's existing anchor check. */
function validateAction(rec: Finding, line: number, pathPositions: Map<number, number>): Actionable | null {
  if (typeof rec.suggestion !== "string") return null;
  const replacement = normalizedReplacement(rec.suggestion);
  if (replacement === "") return null;
  for (const suggestionLine of replacement.split("\n")) {
    if (/^(`{3,}|~{3,})/.test(suggestionLine.trim())) return null;
  }
  let end = line;
  const endLine = rec.end_line;
  if (typeof endLine === "number" && Number.isInteger(endLine) && endLine > 0 && endLine >= line) {
    for (let candidate = line; candidate <= endLine; candidate += 1) {
      if (!pathPositions.has(candidate)) return null;
    }
    end = endLine;
  }
  return { start: line, end, replacement };
}

/** #762: the one-click suggestion region this module writes — a blank line, a
 * ````suggestion` opener, the replacement, and a lone ````` terminator. */
const SUGGESTION_OPENER = "```suggestion";
const FENCE_TERMINATOR = "```";

/** #762: recover the replacement a previously published comment of ours
 * carried, or null when it carries none that can be recovered unambiguously.
 * Only this module's own region is read, and only when the body still carries
 * our disclaimer: `validateAction` refuses any replacement line whose trim
 * starts with three backticks or tildes, so no inner lone fence line can exist
 * and the terminator is unambiguous. Zero or several openers, a missing
 * terminator, and a blank replacement all mean "no prior prescription" — the
 * caller then posts the current one. */
export function recoverPublishedSuggestion(body: string): string | null {
  if (typeof body !== "string" || !body.includes(INLINE_DISCLAIMER)) return null;
  const lines = body.split("\n");
  let opener = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== SUGGESTION_OPENER || index === 0 || lines[index - 1] !== "") continue;
    if (opener !== -1) return null;
    opener = index;
  }
  if (opener === -1) return null;
  let end = -1;
  for (let index = opener + 1; index < lines.length; index += 1) {
    if (lines[index] === FENCE_TERMINATOR) { end = index; break; }
  }
  if (end === -1) return null;
  const replacement = lines.slice(opener + 1, end).join("\n");
  return normalizedReplacement(replacement) === "" ? null : replacement;
}

/** Build anchorable comments; thread-backed findings are deduplicated (#766). */
export function buildComments(
  findings: unknown,
  diffText: string,
  maxComments: number,
  opts: { forgejoPositions: boolean; linkMode?: string; rejectedPrescriptions?: ReadonlySet<string> },
): { comments: unknown[]; skipped: number; suppressed: number } {
  if (!Array.isArray(findings)) return { comments: [], skipped: 0, suppressed: 0 };
  const positions = diffPositions(diffText);
  // #762: same inert/togithub normalization `findingToBody` applies.
  const mode = opts.linkMode === "inert" || opts.linkMode === "togithub" ? opts.linkMode : "inert";
  const comments: unknown[] = [];
  let skipped = 0;
  let suppressed = 0;
  for (const value of findings) {
    if (!isRecord(value)) { skipped += 1; continue; }
    if (value.thread_id) { skipped += 1; continue; }
    const path = value.file;
    const line = value.line;
    if (!safePath(path) || typeof line !== "number" || !Number.isInteger(line) || line <= 0 || !positions.get(path)?.has(line)) {
      skipped += 1;
      continue;
    }
    let body = findingToBody(value, opts.linkMode ?? "inert");
    const comment: Record<string, unknown> = { path, body };
    if (opts.forgejoPositions) comment.new_position = positions.get(path)!.get(line)!;
    else { comment.line = line; comment.side = "RIGHT"; }
    // #762: actionable one-click suggestion (GitHub) / degraded plain block
    // (Forgejo) + opt-in agent-prompt section. Findings without the new keys
    // render byte-identically to before.
    const action = validateAction(value, line, positions.get(path)!);
    if (action) {
      // #762: a rejected prescription (a trusted 👎 on the prior run's
      // identical replacement at this exact published range) removes ONLY the
      // replacement block. The comment still posts with its message, severity,
      // category, and agent prompt; the finding is never skipped, resolved, or
      // deduped, and the verdict is untouched. The key covers the rendered
      // (redacted) text over the whole validated range, so a rejection of a
      // 1-2 range can never drop a different single-line-at-2 prescription.
      const rejected = opts.rejectedPrescriptions?.has(
        prescriptionKey(path, action.start, action.end, redactText(action.replacement)),
      ) === true;
      if (rejected) {
        suppressed += 1;
      } else {
        if (opts.forgejoPositions) {
          body +=
            `\n\nReplacement for lines ${action.start}-${action.end} (this forge cannot apply a one-click suggestion):\n\n\`\`\`\n` +
            redactText(action.replacement) +
            "\n```";
        } else {
          body += `\n\n\`\`\`suggestion\n${redactText(action.replacement)}\n\`\`\``;
          comment.line = action.end;
          if (action.end > action.start) {
            comment.start_line = action.start;
            comment.start_side = "RIGHT";
          }
        }
        body += `\n\n${FEEDBACK_AFFORDANCE}`;
      }
    }
    if (typeof value.agent_prompt === "string" && value.agent_prompt.trim() !== "") {
      const section =
        `\n\n<details><summary>Suggested agent prompt</summary>\n\n` +
        wrapFence(value.agent_prompt) +
        "\n\n</details>";
      body += sanitizeMarkdown(redactText(section), mode);
    }
    comment.body = body;
    comments.push(comment);
    if (comments.length >= maxComments) break;
  }
  return { comments, skipped, suppressed };
}

/** Parse INLINE_FINDINGS_MAX with Python's ValueError fallback and lower
 * bound. Null/undefined and any non-integer value fall back to `fallback`
 * (v2 always falls back to its 20 default because it has no parameter); the
 * result is never below 1. */
export function parseInlineFindingsMax(raw: string | null | undefined, fallback = 20): number {
  if (raw === null || raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(1, parsed);
}
