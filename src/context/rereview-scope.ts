/** #1426: re-review scope identity — the explicit split between the two
 * scopes a re-review tracks:
 *
 * 1. the CURRENT PR scope (merge-base→head), which the final verdict and
 *    summary always describe, and
 * 2. the NEW-REVIEW DELTA (previous-reviewed-head→current-head), which only
 *    prioritizes inspection and explains what changed since the prior review.
 *
 * The delta is never allowed to redefine the change being approved or
 * rejected: a force-pushed dependency update that moved A→B and was repushed
 * as A→C is still reviewed as A→C, with B→C named as the newly changed
 * portion. The section this module renders is harness-authored (its header
 * is trusted), but commit subjects and file paths inside it are untrusted
 * repository content and are rendered fence-safe (adaptive delimiter from
 * `fence.ts`, the same #1258/#1261 discipline the corpus diff section uses).
 *
 * The delta is computed from the local checkout when the prior head commit
 * is present there and FAILS SOFT when it is not: a shallow Action checkout
 * may no longer contain a force-pushed-away commit, and the honest answer is
 * "the delta could not be enumerated" with the identities still stated —
 * never a guessed delta and never a failure of the review. */

import { runProcess } from "../runtime/subprocess.js";
import { endsWithNewline, fenceDelimiterFor } from "./fence.js";

const SHA_RE = /^[0-9a-f]{7,64}$/i;
/** Git read bounds: a delta probe is advisory evidence, so every capture is
 * capped and every failure degrades to "not enumerated". */
const MAX_GIT_OUTPUT_BYTES = 65_536;
const GIT_TIMEOUT_MS = 10_000;
const TERMINATE_GRACE_MS = 2_000;
/** Item caps on the delta probe (the probe reads one past the commit cap so
 * an overflow can be reported) and on the rendered section. */
export const MAX_DELTA_FILES = 200;
export const MAX_DELTA_COMMITS = 20;
const MAX_SECTION_BYTES = 4096;

export interface DeltaCommit {
  sha: string;
  subject: string;
}

export interface ReReviewScopeDelta {
  priorHeadSha: string;
  headSha: string;
  /** False when the delta could not be enumerated (prior commit absent from
   * the checkout, git unusable, malformed SHAs). Identities are still
   * stated; the section then defers inspection to the full PR. */
  enumerated: boolean;
  /** True when the enumerated delta is empty: the trees at the prior and
   * current heads are identical (rebase-only or semantically unchanged
   * push). Only meaningful when `enumerated`. */
  treeUnchanged: boolean;
  /** Oldest-last; at most MAX_DELTA_COMMITS entries. */
  commits: readonly DeltaCommit[];
  commitsTruncated: boolean;
  files: readonly string[];
  filesTruncated: boolean;
}

function emptyDelta(priorHeadSha: string, headSha: string): ReReviewScopeDelta {
  return {
    priorHeadSha,
    headSha,
    enumerated: false,
    treeUnchanged: false,
    commits: [],
    commitsTruncated: false,
    files: [],
    filesTruncated: false,
  };
}

interface GitOutcome {
  ok: boolean;
  /** True when the capture hit its byte cap: the output is a prefix, and a
   * consumer must treat the list as incomplete. */
  truncated: boolean;
  stdout: string;
}

/** Read-only git probe in the reviewed checkout, bounded and fail-soft. The
 * restricted environment matches `generatedAttributePaths` (src/run/stages.ts):
 * no tenant-controlled git config, no hooks on a read path. */
async function runGit(workspace: string, args: readonly string[]): Promise<GitOutcome> {
  try {
    const handle = runProcess({
      file: "git",
      args: [...args],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      terminateGraceMs: TERMINATE_GRACE_MS,
    });
    const result = await handle.result;
    if (result.status !== "exited" || result.exitCode !== 0) {
      return { ok: false, truncated: false, stdout: "" };
    }
    return {
      ok: true,
      truncated: result.stdout.length >= MAX_GIT_OUTPUT_BYTES,
      stdout: result.stdout.toString("utf8"),
    };
  } catch {
    return { ok: false, truncated: false, stdout: "" };
  }
}

/** Control characters never render: a filename or commit subject carrying a
 * newline or other control byte is dropped whole (render less, never
 * hostile) rather than being flattened into a line that could forge section
 * structure inside the fence. */
function hasControlChar(text: string): boolean {
  for (const character of text) {
    if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) return true;
  }
  return false;
}

/** Enumerate the prior-head→current-head delta from the reviewed checkout.
 * Never throws and never runs git with an unvalidated SHA. */
export async function computeReReviewDelta(
  workspace: string,
  priorHeadSha: string,
  headSha: string,
): Promise<ReReviewScopeDelta> {
  const prior = priorHeadSha.trim().toLowerCase();
  const head = headSha.trim().toLowerCase();
  if (!SHA_RE.test(prior) || !SHA_RE.test(head) || prior === head) {
    return emptyDelta(prior, head);
  }
  // The prior head must be a real commit in this checkout: a shallow Action
  // checkout may no longer contain a force-pushed-away revision, and an
  // unprovable delta is reported as such, never guessed.
  const present = await runGit(workspace, ["cat-file", "-e", `${prior}^{commit}`]);
  if (!present.ok) return emptyDelta(prior, head);

  const filesOutcome = await runGit(workspace, ["diff", "--name-only", "-z", prior, head]);
  if (!filesOutcome.ok) return emptyDelta(prior, head);
  let rawNames = filesOutcome.stdout.split("\0");
  // A capture capped mid-stream leaves the final chunk a partial name: drop
  // it rather than render a truncated path, and say the list is incomplete.
  if (filesOutcome.truncated && rawNames.length > 0) rawNames = rawNames.slice(0, -1);
  const rawFiles = rawNames.filter((name) => name !== "");
  // Control-character-bearing entries are dropped whole; any drop reason
  // (sanitation, the item cap, or a capped capture) is reported as
  // truncation, never silent.
  const files = rawFiles.filter((name) => !hasControlChar(name)).slice(0, MAX_DELTA_FILES);
  const filesTruncated = filesOutcome.truncated || rawFiles.length > files.length;

  const commitsOutcome = await runGit(workspace, [
    "log",
    "--format=%H%x1f%s%x1e",
    "-n",
    `${MAX_DELTA_COMMITS + 1}`,
    `${prior}..${head}`,
  ]);
  if (!commitsOutcome.ok) return emptyDelta(prior, head);
  const commits: DeltaCommit[] = [];
  let commitsTruncated = false;
  for (const rawRecord of commitsOutcome.stdout.split("\x1e")) {
    const record = rawRecord.replace(/^\n/, "");
    if (record === "") continue;
    const separator = record.indexOf("\x1f");
    if (separator <= 0) continue;
    const sha = record.slice(0, separator).trim().toLowerCase();
    const subject = record.slice(separator + 1);
    if (!SHA_RE.test(sha) || subject === "" || hasControlChar(subject)) continue;
    if (commits.length >= MAX_DELTA_COMMITS) {
      commitsTruncated = true;
      break;
    }
    commits.push({ sha, subject });
  }

  return {
    priorHeadSha: prior,
    headSha: head,
    enumerated: true,
    treeUnchanged: rawFiles.length === 0,
    commits,
    commitsTruncated,
    files,
    filesTruncated,
  };
}

/** Render the harness-authored scope section. "" when there is no prior
 * reviewed head to state (fresh review) or the prior head equals the current
 * one — in both cases the corpus must stay byte-identical to a plain
 * review. */
export function buildReReviewScopeMd(
  delta: ReReviewScopeDelta | null,
  options: { priorHeadSha: string; headSha: string; baseSha: string },
): string {
  const prior = options.priorHeadSha.trim().toLowerCase();
  const head = options.headSha.trim().toLowerCase();
  if (!SHA_RE.test(prior) || !SHA_RE.test(head) || prior === head) return "";
  const base = options.baseSha.trim().toLowerCase();
  const basePart = SHA_RE.test(base) ? `base \`${base}\`` : "the configured base";
  const resolved = delta !== null && delta.enumerated && delta.priorHeadSha === prior && delta.headSha === head
    ? delta
    : null;

  const frame = (listLimit: number): { section: string; fits: boolean } => {
    const lines: string[] = [];
    lines.push("# Re-Review Scope");
    lines.push("");
    lines.push("This is a re-review. Two scopes are tracked separately:");
    lines.push("");
    lines.push(`- **Current PR scope (authoritative):** ${basePart} → head \`${head}\`. The final verdict and summary must describe this full range — the pull request as it would merge at the current head.`);
    lines.push(`- **Prior review:** the previous managed review covered head \`${prior}\`. The delta \`${prior}\` → \`${head}\` identifies the newly changed portion since that review. The delta only prioritizes inspection; it never redefines the change being approved or rejected.`);
    lines.push("");
    lines.push("Delta since the previous reviewed head:");
    lines.push("");
    if (resolved === null) {
      lines.push("- The delta could not be enumerated in this checkout (the prior head commit may no longer be present); treat the full current PR as the scope of inspection.");
    } else if (resolved.treeUnchanged) {
      lines.push("- No file-level changes since the previous reviewed head (rebase-only or semantically unchanged push).");
    } else if (listLimit === 0) {
      lines.push("- (The delta listing is omitted for size; the full current PR remains the authoritative scope.)");
    } else {
      const commits = resolved.commits.slice(0, listLimit);
      const commitsShrunk = commits.length < resolved.commits.length;
      const files = resolved.files.slice(0, listLimit);
      const filesShrunk = files.length < resolved.files.length;
      if (commits.length > 0) {
        lines.push(commitsShrunk || resolved.commitsTruncated
          ? `- Commits (first ${commits.length} of more):`
          : `- Commits (${commits.length}):`);
        lines.push("");
        lines.push(...fencedList(commits.map((commit) => `${commit.sha} ${commit.subject}`)));
      }
      if (files.length > 0) {
        lines.push(filesShrunk || resolved.filesTruncated
          ? `- Changed files (first ${files.length} of more):`
          : `- Changed files (${files.length}):`);
        lines.push("");
        lines.push(...fencedList([...files]));
      }
      if (commitsShrunk || filesShrunk || resolved.commitsTruncated || resolved.filesTruncated) {
        lines.push("- (The delta listing above is truncated; the full current PR remains the authoritative scope.)");
      }
    }
    lines.push("");
    lines.push("Rules for this re-review:");
    lines.push("");
    lines.push("- Version and dependency evidence is anchored to the full current PR range (base→head); the delta only identifies which portion is newly introduced since the previous review.");
    lines.push("- Do not manufacture findings for portions unchanged since the previous reviewed head merely because the branch moved.");
    lines.push("- Prior review findings are retained, resolved, or superseded against current-head evidence — restate a prior finding only when the current head still warrants it.");
    const section = `${lines.join("\n")}\n`;
    return { section, fits: Buffer.byteLength(section, "utf8") <= MAX_SECTION_BYTES };
  };

  // Byte cap WITHOUT slicing: a mid-fence cut could leave the section's
  // fence unclosed and swallow the corpus sections after it. Re-render with
  // a shrinking list limit instead; every rendered variant closes its
  // fences, and the final fallback drops the lists entirely.
  let listLimit = MAX_DELTA_FILES;
  let rendered = frame(listLimit);
  while (!rendered.fits && listLimit > 0) {
    listLimit = Math.floor(listLimit / 2);
    rendered = frame(listLimit);
  }
  return rendered.section;
}

/** An adaptive-fenced block for untrusted one-per-line entries: the
 * delimiter is longer than any backtick run in the payload, and the closer
 * always begins on its own line (#1261). */
function fencedList(entries: readonly string[]): string[] {
  const payload = `${entries.join("\n")}\n`;
  const fence = fenceDelimiterFor(payload);
  const closer = `${endsWithNewline(payload) ? "" : "\n"}${fence}`;
  return [`${fence}\n`, payload, `${closer}\n`];
}
