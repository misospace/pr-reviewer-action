/** Spike (#764): minimal unified-diff hunk parser — just enough to recover,
 * per changed file, the added-line numbers (new-file side) and the hunk's
 * line span. Not a general diff library: no rename-similarity, no binary
 * markers beyond skipping them. Matches the unified-diff shape `git diff`
 * / `git show` produce, which is what the rest of this pipeline consumes
 * (see `pr_reviewer/change_anchors.py`, `src/context/related-context.ts`). */

export interface DiffHunk {
  /** 1-based, inclusive, new-file line numbers spanned by this hunk. */
  startLine: number;
  endLine: number;
  /** 1-based, new-file line numbers that are actually `+` (added/changed)
   * lines within this hunk, as opposed to unchanged context lines. */
  addedLines: number[];
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

const GIT_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff into per-file added-line positions. Diff paths are
 * taken from the `+++ b/<path>` header (falls back to the `diff --git`
 * header when `+++` is `/dev/null`, i.e. a deletion — deleted files carry
 * no new-side lines and are simply skipped by callers). */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const lines = diffText.split("\n");
  // A valid diff (like the rest of the text lines) ends with a trailing
  // "\n"; splitting on it always leaves one spurious empty element after
  // the real last line, which must not be mistaken for a blank context
  // line (that would shift `endLine` past the file's actual last line).
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let newLineCursor = 0;

  const flushHunk = (): void => {
    // A hunk that only removes lines has no new-file side at all (the
    // classic case: a deleted file, `+++ /dev/null`, "+0,0" header) — it
    // carries no added lines to seed identifier/declaration lookups from,
    // matching this repo's existing "added (+) lines only" convention
    // (see `pr_reviewer/change_anchors.py`).
    if (current !== null && hunk !== null && hunk.addedLines.length > 0) current.hunks.push(hunk);
    hunk = null;
  };

  for (const line of lines) {
    const gitHeader = GIT_HEADER_RE.exec(line);
    if (gitHeader) {
      flushHunk();
      current = { path: gitHeader[2] as string, hunks: [] };
      files.push(current);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (current !== null && path !== "/dev/null" && path.startsWith("b/")) current.path = path.slice(2);
      continue;
    }
    const hunkHeader = HUNK_HEADER_RE.exec(line);
    if (hunkHeader) {
      flushHunk();
      newLineCursor = Number.parseInt(hunkHeader[1] as string, 10);
      hunk = { startLine: newLineCursor, endLine: newLineCursor, addedLines: [] };
      continue;
    }
    if (hunk === null || current === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      hunk.addedLines.push(newLineCursor);
      hunk.endLine = newLineCursor;
      newLineCursor += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // Deleted line: doesn't exist on the new side, no cursor movement.
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — not a content line.
    } else {
      // Context line (leading space, or blank line copied verbatim).
      hunk.endLine = newLineCursor;
      newLineCursor += 1;
    }
  }
  flushHunk();
  return files.filter((file) => file.hunks.length > 0);
}
