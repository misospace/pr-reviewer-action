/**
 * Deterministic outside-diff tagging (v3-only, no v2 counterpart).
 *
 * After findings are parsed, any finding whose file/line cannot be anchored
 * inside the PR's diff is content-flagged `outside_diff`. That is a location
 * fact, not a judgment: a finding in unchanged code can still be caused by the
 * change, so only the model-set `pre_existing` flag demotes a finding.
 *
 * This never changes the verdict, adds model input, or alters existing
 * policy semantics (verdict_source, requirement coverage, enforcement
 * overlays, etc. are untouched) — it only reorders and labels findings for
 * rendering. Reuses the exact diff/hunk walk `../publish/inline-findings.js`
 * uses to anchor inline comments (the #778 port of v2
 * `scripts/build_review_comments.py`) rather than re-parsing the diff here.
 */
import { diffPositions } from "../publish/inline-findings.js";
import type { ArtifactFinding, ReviewArtifact } from "./artifact.js";

const SEVERITY_RANK: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };

/**
 * True when `file`/`line` are both present but the line isn't a commentable
 * new-side diff position (file not touched by the diff at all, or the line
 * falls outside every hunk's new-side range — including a deleted or
 * renamed-away path, which never appears as a `+++` target). Null file or
 * null line means the model gave no anchor at all: those findings are left
 * untagged, matching `buildComments`' own "not anchorable" handling.
 */
export function isOutsideDiff(
  file: string | null | undefined,
  line: number | null | undefined,
  positions: Map<string, Map<number, number>>,
): boolean {
  if (file === null || file === undefined || line === null || line === undefined) return false;
  return !(positions.get(file)?.has(line) ?? false);
}

function isPreExisting(finding: ArtifactFinding): boolean {
  return (finding as unknown as Record<string, unknown>).pre_existing === true;
}

/**
 * Stable reorder, most-decisive-first by severity; model-flagged
 * `pre_existing` findings sort as a block after the rest. `outside_diff` alone
 * does not demote: a caller the change breaks lives in unchanged code.
 */
export function sortPreExistingLast<T extends ArtifactFinding>(findings: readonly T[]): T[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const preExisting = Number(isPreExisting(a.finding)) - Number(isPreExisting(b.finding));
      if (preExisting !== 0) return preExisting;
      const severity = (SEVERITY_RANK[a.finding.severity] ?? 3) - (SEVERITY_RANK[b.finding.severity] ?? 3);
      if (severity !== 0) return severity;
      return a.index - b.index;
    })
    .map(({ finding }) => finding);
}

/**
 * Tag every finding whose file/line falls outside the PR's diff with
 * `outside_diff: true`, then apply the stable reorder above. `diffText` must be
 * the full diff: a file missing from a truncated diff would be tagged. Tags
 * findings in place, replaces `artifact.findings` with the reordered array, and
 * returns the number newly tagged. An empty-string file is tagged (no match).
 *
 * Call this after `reviewArtifactFromParsed` + `applyAllEnforcement` and
 * before the artifact is serialized to outputs/publish input — enforcement
 * overlays only ever append markdown and force the verdict, so ordering
 * relative to them doesn't matter, but it must run before any consumer reads
 * `artifact.findings` for rendering or output serialization.
 */
export function applyOutsideDiffTagging(artifact: ReviewArtifact, diffText: string): number {
  const positions = diffPositions(diffText);
  let tagged = 0;
  for (const finding of artifact.findings) {
    if (isOutsideDiff(finding.file, finding.line, positions)) {
      finding.outside_diff = true;
      tagged += 1;
    }
  }
  artifact.findings = sortPreExistingLast(artifact.findings);
  return tagged;
}
