/** Canonical pull-request head refspecs for git acquisition (#732).
 *
 * Every platform's fetch uses the forge's canonical per-PR head ref, never a
 * contributor-controlled branch name: the head commit is addressed by the PR
 * number alone, so a fork's branch coordinates never become trust inputs and
 * a forced push to the source branch cannot move an already-pinned review.
 *
 * GitHub and Forgejo/Gitea both expose `refs/pull/<n>/head`, so the ref form
 * is shared; the seam still exists so a platform that names its PR refs
 * differently can be added without touching the acquisition module.
 */

export type AcquisitionPlatform = "github" | "forgejo";

const PR_NUMBER_RE = /^[1-9]\d*$/;

export function pullRequestHeadRef(platform: AcquisitionPlatform, prNumber: number): string | null {
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  if (!PR_NUMBER_RE.test(String(prNumber))) return null;
  if (platform !== "github" && platform !== "forgejo") return null;
  return `refs/pull/${prNumber}/head`;
}

/** The wildcard fetch refspec acquiring every PR head ref for `platform`,
 * with forced update so a re-opened PR's new head overwrites the old. The
 * acquisition mirror composes its fetch refspecs from this seam — the
 * per-platform PR-ref naming lives here, nowhere else. */
export function pullHeadRefspec(platform: AcquisitionPlatform): string | null {
  if (platform !== "github" && platform !== "forgejo") return null;
  return "+refs/pull/*:refs/pull/*";
}
