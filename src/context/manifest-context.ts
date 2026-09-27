/** Changed-manifest context (#706 PR 3): byte-exact port of the
 * `manifest-context` block of scripts/sections/context.sh.
 *
 * v2 selects manifest filenames from `pr-files.raw.json` with
 *   jq -r '.[] | select(.filename | test("(helmrelease|...)\\.ya?ml$"; "i")) | .filename'
 * under `2>/dev/null || true`, then embeds each file that exists in the
 * checked-out tree until the running `wc -l` total would pass 1200 lines.
 * Semantics kept here:
 *
 * - a jq error (`.[]` over a non-iterable, `.filename` on a non-object,
 *   `test` on a non-string) stops the stream but keeps what was already
 *   printed, because `|| true` swallows the status, not the output;
 * - jq's `$` also matches before a final newline, and `"i"` is Unicode
 *   case-insensitive (Oniguruma), hence the `u` flag and `(?=\n?$)`;
 * - `jq -r` prints each name plus a newline, `$(...)` drops NUL bytes and
 *   trailing newlines, and `read -r` splits the rest on newlines, skipping
 *   empty lines — a filename with an embedded newline is two entries;
 * - `[ -f ]` follows symlinks and is relative to the workspace;
 * - the line count is the number of newline bytes (GNU `wc -l`), and the
 *   file is embedded verbatim, so one without a trailing newline runs into
 *   the closing fence exactly as `cat` would. */

import { readFileSync, statSync } from "node:fs";
import { jqEach, jqField } from "../platform/jq.js";

export const MANIFEST_LINE_BUDGET = 1200;
export const MANIFEST_NAME_RE = /(?:helmrelease|deployment|statefulset|daemonset|kustomization)\.ya?ml(?=\n?$)/iu;

const enc = (text: string): Buffer => Buffer.from(text, "utf8");

/** The jq selection over the parsed `pr-files.raw.json`. `undefined` stands
 * for a file jq could not read (empty or invalid JSON): no output. */
export function selectChangedManifests(prFilesRaw: unknown): string[] {
  const names: string[] = [];
  if (prFilesRaw === undefined) return names;
  try {
    for (const entry of jqEach(prFilesRaw)) {
      const filename = jqField(entry, "filename");
      if (typeof filename !== "string") return names;
      if (MANIFEST_NAME_RE.test(filename)) names.push(filename);
    }
  } catch {
    return names;
  }
  return names;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function countNewlines(data: Uint8Array): number {
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return lines;
}

export interface ManifestContextResult {
  artifacts: Map<string, Uint8Array>;
  /** The `read -r` entries, in order (empty lines already skipped). */
  manifests: string[];
}

/** Build `manifest-context.md` from the PR's changed files and the
 * checked-out workspace. */
export function buildManifestContext(prFilesRaw: unknown, workspace: string): ManifestContextResult {
  const printed = selectChangedManifests(prFilesRaw).map((name) => `${name}\n`).join("");
  const captured = printed.replace(/\0/g, "").replace(/\n+$/, "");
  const manifests = captured === "" ? [] : captured.split("\n").filter((line) => line !== "");
  const parts: Buffer[] = [];
  if (captured === "") {
    parts.push(enc("No common manifest files changed in this PR.\n"));
  } else {
    parts.push(enc("# Changed Manifest Context (modified files only)\n\n"));
    let total = 0;
    for (const file of manifests) {
      const path = file.startsWith("/") ? file : `${workspace}/${file}`;
      if (!isRegularFile(path)) {
        parts.push(enc(`## File: ${file}\n(file not present in checked-out tree at this ref)\n\n`));
        continue;
      }
      const content = readFileSync(path);
      const lines = countNewlines(content);
      if (total + lines > MANIFEST_LINE_BUDGET) {
        parts.push(enc("(manifest content truncated - too many total lines)\n"));
        break;
      }
      total += lines;
      parts.push(enc(`## File: ${file} (${lines} lines)\n\`\`\`yaml\n`), content, enc("```\n\n"));
    }
  }
  return { artifacts: new Map([["manifest-context.md", new Uint8Array(Buffer.concat(parts))]]), manifests };
}
