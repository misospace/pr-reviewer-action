/**
 * Verbatim v3 port of scripts/sanitize_review_markdown.py (#561) and
 * scripts/strip_metadata_markers.py. Keep pattern order aligned with v2.
 *
 * Documented divergence (same one as src/enforcement/threads.ts): JS `\w`
 * is ASCII-only while Python's is unicode, so a non-ASCII character before
 * an @mention (e.g. `中文@user`) is neutralized here but not in v2. No
 * pinned fixture exercises that case; ASCII behavior is identical.
 */
export type UpstreamLinkMode = "inert" | "togithub";

const GH_PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const GH_ISSUE_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)/g;
const GH_COMMIT_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/commit\/([0-9a-f]{7,40})/g;
const GH_COMPARE_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/compare\/([^ \"\)]+)/g;
const CROSS_REPO_REF = /(?<!\w)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)(?!\w)/g;
const BARE_REF = /(?<!\w)#(\d+)(?!\w)/g;
const MENTION = /(?<![\w/`@])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9._-]+)?)/g;
const CODE_SEGMENT = /(`[^`\n]+`)/g;

function replaceUrls(text: string, mode: UpstreamLinkMode): string {
  const urlRules: Array<[RegExp, string]> = [
    [GH_PR_URL, "PR"],
    [GH_ISSUE_URL, "issue"],
    [GH_COMMIT_URL, "commit"],
    [GH_COMPARE_URL, "compare"],
  ];
  for (const [pattern, label] of urlRules) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (url, ownerRepo: string, ref: string) =>
      mode === "togithub" ? url.replace("github.com", "togithub.com") : `upstream ${ownerRepo} ${label} ${ref}`,
    );
  }
  return text;
}

function sanitizeProse(source: string, mode: UpstreamLinkMode): string {
  let text = replaceUrls(source, mode);
  text = text.replace(CROSS_REPO_REF, "$1 PR $2");
  text = text.replace(BARE_REF, "PR $1");
  text = text.replace(MENTION, (_match, name: string) => `@\u200b${name}`);
  return text;
}

/** Match v2's inline-code split semantics: captured odd segments pass verbatim;
 * fenced code is deliberately still sanitized. */
export function sanitizeMarkdown(text: string, linkMode: UpstreamLinkMode): string {
  if (linkMode !== "inert" && linkMode !== "togithub") {
    throw new Error(`unknown upstream link mode: '${String(linkMode)}' (expected one of inert, togithub)`);
  }
  const parts = text.split(CODE_SEGMENT);
  return parts.map((part, index) => index % 2 ? part : sanitizeProse(part, linkMode)).join("");
}

/** Reserved v2 internal comment markers live in src/metadata/markers.ts —
 * the metadata boundary owns them; this module re-exports for its pipeline. */
export { RESERVED_MARKER_PATTERNS, stripReservedMarkers } from "../metadata/markers.js";

export interface ConditionalSectionPresence {
  linkedIssue: boolean;
  evidenceProvider: boolean;
  standards: boolean;
  toolHarnessFindings: boolean;
  toolHarnessResults: boolean;
}

const TITLE_TRIM = /[\s:;.,\u2013\u2014#-]+$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const PREFIX_TARGETS = [
  ["linkedIssue", "linked issue"],
  ["evidenceProvider", "evidence provider"],
  ["standards", "standards"],
] as const;
const EXACT_TARGETS = [
  ["toolHarnessFindings", "tool harness findings"],
  ["toolHarnessResults", "tool harness results"],
] as const;

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase().replace(TITLE_TRIM, "").split(/\s+/).filter(Boolean).join(" ");
}

function targetAbsent(title: string, presence: ConditionalSectionPresence): boolean {
  const lower = title.toLowerCase();
  for (const [key, prefix] of PREFIX_TARGETS) {
    if (lower.startsWith(prefix) && !presence[key]) return true;
  }
  const normalized = normalizedTitle(title);
  for (const [key, exact] of EXACT_TARGETS) {
    if (normalized === exact && !presence[key]) return true;
  }
  return false;
}

function fenceLine(line: string, marker: "`" | "~" | null): { isFence: boolean; marker: "`" | "~" | null } {
  const match = FENCE.exec(line);
  if (!match) return { isFence: false, marker };
  const ch = match[1]![0] as "`" | "~";
  if (marker === null) return { isFence: true, marker: ch };
  if (ch === marker) return { isFence: true, marker: null };
  return { isFence: false, marker };
}

/** Port of scripts/strip_empty_conditional_sections.py (#415). */
export function stripEmptyConditionalSections(text: string, presence: ConditionalSectionPresence): string {
  if (!text) return "";
  const lines = text.split("\n");
  const remove = lines.map(() => false);
  let inFence = false;
  let fenceMarker: "`" | "~" | null = null;
  let removedAny = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const state = fenceLine(line, fenceMarker);
    fenceMarker = state.marker;
    if (state.isFence) {
      inFence = fenceMarker !== null;
      i += 1;
      continue;
    }
    if (inFence) { i += 1; continue; }

    const heading = HEADING.exec(line);
    if (heading && targetAbsent(heading[2]!, presence)) {
      removedAny = true;
      remove[i] = true;
      const level = heading[1]!.length;
      let j = i + 1;
      let innerMarker: "`" | "~" | null = null;
      let innerFence = false;
      while (j < lines.length) {
        const next = lines[j]!;
        const innerState = fenceLine(next, innerMarker);
        innerMarker = innerState.marker;
        if (innerState.isFence) {
          innerFence = innerMarker !== null;
          remove[j] = true;
          j += 1;
          continue;
        }
        if (innerFence) { remove[j] = true; j += 1; continue; }
        const nextHeading = HEADING.exec(next);
        if (nextHeading && nextHeading[1]!.length <= level) break;
        remove[j] = true;
        j += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  if (!removedAny) return text;
  return lines.filter((_line, index) => !remove[index]).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}
