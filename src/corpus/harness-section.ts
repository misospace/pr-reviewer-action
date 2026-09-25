/** Port of `replace_harness_findings_section` (scripts/run_tool_harness.py):
 * swap the body of the corpus's Tool Harness Findings section.
 *
 * Sections are delimited by level-1 ATX headers — the same rule
 * build_review_corpus emits. The header line itself is preserved. Returns
 * the corpus unchanged when the section is absent. This is the corpus-side
 * contract of the native loop's in-conversation verdict turn (#202/#637): the
 * verdict corpus replaces the placeholder findings with the compact
 * harness index while the full results stay in the conversation's tool
 * messages. The findings-body *renderer* itself belongs to the native-loop
 * migration (#678), not here. */

export function replaceHarnessFindingsSection(corpus: string, body: string): string {
  const lines = corpus.split("\n");
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("# ")) {
      starts.push(index);
    }
  }
  if (starts.length === 0) {
    return corpus;
  }
  const bounds = [...starts, lines.length];
  for (const [idx, start] of starts.entries()) {
    if (lines[start]!.slice(2).trim().startsWith("Tool Harness Findings")) {
      const next = bounds[idx + 1] ?? lines.length;
      return [
        ...lines.slice(0, start + 1),
        ...body.split("\n"),
        ...lines.slice(next),
      ].join("\n");
    }
  }
  return corpus;
}
