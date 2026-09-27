/**
 * Deterministic outside-diff tagging (v3-only, no v2 counterpart).
 *
 * An eval showed that with the tool loop on, the reviewer reads code next to
 * the diff and hedges about it — producing speculative false positives on
 * clean PRs. A companion, model-set `pre_existing` flag addresses the part
 * that depends on the model's own judgment; this pass adds the deterministic
 * side that does not: after findings are parsed, any finding whose file/line
 * cannot be anchored inside the PR's diff is content-flagged `outside_diff`.
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

/** Forward-compatible with the not-yet-merged model-set `pre_existing` flag
 * (checked against `main` at write time: absent). Read defensively by key
 * rather than by type so this keeps working the moment that field lands. */
function isDeprioritized(finding: ArtifactFinding): boolean {
  return finding.outside_diff === true || (finding as unknown as Record<string, unknown>).pre_existing === true;
}

/**
 * Stable reorder: findings about the change (in-diff, and any `pre_existing`
 * peer that isn't flagged) sort most-decisive-first by severity exactly as
 * before; outside-diff/pre-existing findings sort the same way among
 * themselves but as a block after every in-diff finding. Ties keep the
 * model's own order (stable sort on the original index).
 */
export function sortOutsideDiffLast<T extends ArtifactFinding>(findings: readonly T[]): T[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const deprioritized = Number(isDeprioritized(a.finding)) - Number(isDeprioritized(b.finding));
      if (deprioritized !== 0) return deprioritized;
      const severity = (SEVERITY_RANK[a.finding.severity] ?? 3) - (SEVERITY_RANK[b.finding.severity] ?? 3);
      if (severity !== 0) return severity;
      return a.index - b.index;
    })
    .map(({ finding }) => finding);
}

/**
 * Tag every finding whose file/line falls outside the PR's diff with
 * `outside_diff: true`, then apply the stable reorder above. Mutates
 * `artifact.findings` in place (matching the enforcement pass convention in
 * `enforce.ts`) and returns the number of findings newly tagged.
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
  artifact.findings = sortOutsideDiffLast(artifact.findings);
  return tagged;
}
