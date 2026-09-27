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
  const body = `**${label}${suffix}:** ${message}\n\n_Automated finding from AI PR review._`;
  const mode = linkMode === "inert" || linkMode === "togithub" ? linkMode : "inert";
  return sanitizeMarkdown(redactText(body), mode);
}

function isRecord(value: unknown): value is Finding {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

/** Build anchorable comments; thread-backed findings are deduplicated (#766). */
export function buildComments(
  findings: unknown,
  diffText: string,
  maxComments: number,
  opts: { forgejoPositions: boolean; linkMode?: string },
): { comments: unknown[]; skipped: number } {
  if (!Array.isArray(findings)) return { comments: [], skipped: 0 };
  const positions = diffPositions(diffText);
  const comments: unknown[] = [];
  let skipped = 0;
  for (const value of findings) {
    if (!isRecord(value)) { skipped += 1; continue; }
    if (value.thread_id) { skipped += 1; continue; }
    const path = value.file;
    const line = value.line;
    if (!safePath(path) || typeof line !== "number" || !Number.isInteger(line) || line <= 0 || !positions.get(path)?.has(line)) {
      skipped += 1;
      continue;
    }
    const comment: Record<string, unknown> = {
      path,
      body: findingToBody(value, opts.linkMode ?? "inert"),
    };
    if (opts.forgejoPositions) comment.new_position = positions.get(path)!.get(line)!;
    else { comment.line = line; comment.side = "RIGHT"; }
    comments.push(comment);
    if (comments.length >= maxComments) break;
  }
  return { comments, skipped };
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
