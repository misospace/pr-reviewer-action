/** Canonical pull-request head refspecs for git acquisition (#732).
 *
 * Every platform's fetch uses the forge's canonical per-PR head ref, never a
 * contributor-controlled branch name: the head commit is addressed by the PR
 * number alone, so a fork's branch coordinates never become trust inputs and
 * a forced push to the source branch cannot move an already-pinned review.
 *
 * GitHub and Forgejo/Gitea both expose `refs/pull/<n>/head`, so the ref form
 * is shared; GitLab names the same forge-maintained coordinate
 * `refs/merge-requests/<n>/head` (#740) — the branch is spelled the same way,
 * only the ref namespace differs, so the trust argument is unchanged: the head
 * commit is addressed by the MR number alone, never by the contributor's
 * source branch.
 */

import { forgeWireFamily, type ForgeId } from "./resolve.js";

/** The platforms acquisition can fetch from (#732).
 *
 * It is the platform seam's DECLARED forge vocabulary (`ForgeId`), not a
 * second spelling of it: the acquisition module and the forge identity must
 * agree on which products exist, so they share ONE definition. */
export type AcquisitionPlatform = ForgeId;

const PR_NUMBER_RE = /^[1-9]\d*$/;

/** #1678: Gitea inherited `refs/pull/<n>/head` from the same codebase Forgejo
 * did, so the family shares ONE ref form. The membership test comes from the
 * platform seam's own family mapping, so the two cannot drift. */
function isGiteaFamily(platform: AcquisitionPlatform): boolean {
  return forgeWireFamily(platform) === "forgejo";
}

export function pullRequestHeadRef(platform: AcquisitionPlatform, prNumber: number): string | null {
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  if (!PR_NUMBER_RE.test(String(prNumber))) return null;
  // #740: GitLab's forge-maintained MR head ref. The ref name is built from
  // the validated MR number ONLY — no caller string is interpolated.
  if (platform === "gitlab") return `refs/merge-requests/${prNumber}/head`;
  if (platform !== "github" && !isGiteaFamily(platform)) return null;
  return `refs/pull/${prNumber}/head`;
}

/** The wildcard fetch refspec acquiring every PR head ref for `platform`,
 * with forced update so a re-opened PR's new head overwrites the old. The
 * acquisition mirror composes its fetch refspecs from this seam — the
 * per-platform PR-ref naming lives here, nowhere else. */
export function pullHeadRefspec(platform: AcquisitionPlatform): string | null {
  // #740: forced update has the same rationale as below — a re-pushed MR head
  // must overwrite the old one in the mirror.
  if (platform === "gitlab") return "+refs/merge-requests/*:refs/merge-requests/*";
  if (platform !== "github" && !isGiteaFamily(platform)) return null;
  return "+refs/pull/*:refs/pull/*";
}
