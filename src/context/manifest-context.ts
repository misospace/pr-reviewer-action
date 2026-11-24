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
 * - a candidate is embedded only when `workspaceRegularFile` accepts it: no
 *   symlink component and no `..` below the workspace, so a PR-controlled
 *   symlink named like a manifest never pulls a runner file into the corpus
 *   (#805); a refused path that exists gets its own notice;
 * - the line count is the number of newline bytes (GNU `wc -l`), and the
 *   file is embedded verbatim — when it lacks a trailing newline, a
 *   separator newline is emitted before the closing fence so the closer
 *   always begins on its own line (#1261 review; v2 let the two merge,
 *   which left the fence unclosable).
 *
 * #1258 (deliberate divergence from v2): the embedding fence is adaptive —
 * a delimiter longer than any backtick run in the file, floored at three.
 * The embedded bytes come from the checked-out workspace, so a fixed ```yaml
 * wrapper was closable by PR-controlled manifest content; a benign manifest
 * keeps the exact v2 bytes.
 *
 * #1784 (deliberate divergence): with a workspace, selection also recognizes
 * YAML files whose checked-out workspace content has the root-column Flux
 * OCIRepository marker pair. Classification recognizes that pair from the
 * file's own diff region while this selection recognizes it from the checked-out
 * file content, so a Flux manifest whose hunk does not touch the marker lines
 * is embedded here but keeps the pre-fix classification. Without a workspace,
 * the historical name-only selection is unchanged. Discovery reads are
 * bounded (#1815 review): a candidate larger than MAX_HEAD_FILE_BYTES is
 * never read for content and the whole scan reads at most
 * MANIFEST_DISCOVERY_MAX_TOTAL_BYTES — beyond either bound (or when the file
 * is unavailable or unsafe) the candidate keeps the pre-fix recognition
 * miss, and name-pattern selection still never reads. Aggregate accounting
 * charges every byte the discovery descriptor yields, including a read
 * refused because the file grew between fstat and read. */

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { jqEach, jqField } from "../platform/jq.js";
import { MAX_HEAD_FILE_BYTES } from "./change-anchors.js";
import { endsWithNewline, fenceDelimiterFor } from "./fence.js";
import { workspaceFsPath, workspacePathExists, workspaceRegularFile } from "./workspace-path.js";

export const MANIFEST_LINE_BUDGET = 1200;
export const MANIFEST_NAME_RE = /(?:helmrelease|deployment|statefulset|daemonset|kustomization)\.ya?ml(?=\n?$)/iu;

/** #1784/#1815 review: the discovery scan reads at most four candidates'
 * worth of the readHeadLines byte cap in aggregate, whatever the changed
 * YAML batch looks like. */
export const MANIFEST_DISCOVERY_MAX_TOTAL_BYTES = 4 * MAX_HEAD_FILE_BYTES;

/** #1784: raw-file forms of the #1782 Flux markers; both must be at root
 * column, unlike their diff-prefixed trusted-scope counterparts. Keep jq `$`
 * consistency: it also matches before a final newline. */
const FLUX_OCI_KIND_LINE_RE = /^kind\s*:\s*["']?OCIRepository["']?\s*$/m;
const FLUX_SOURCE_API_VERSION_LINE_RE = /^apiVersion\s*:\s*["']?source\.toolkit\.fluxcd\.io\//m;
const FLUX_SURFACE_FILE_RE = /\.ya?ml(?=\n?$)/i;

const enc = (text: string): Buffer => Buffer.from(text, "utf8");

/** #1784: bytes of the discovery scan still allowed to be read. */
interface DiscoveryBudget {
  remaining: number;
}

/** #1784: the checked-out file's bytes, or null. The readHeadLines
 * convention (change-anchors/related-context): O_NOFOLLOW open, fstat size
 * gate against MAX_HEAD_FILE_BYTES and the scan's remaining budget, bounded
 * readSync, and a post-read re-check against a file that grew between fstat
 * and read. Oversized and exhausted scans never read file content. */
function readDiscoveryBytes(workspace: string, filename: string, budget: DiscoveryBudget): Buffer | null {
  let fd: number;
  try {
    fd = openSync(workspaceFsPath(workspace, filename), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_HEAD_FILE_BYTES || info.size > budget.remaining) return null;
    // +1 byte: a file that grew after the fstat fills the extra byte and is
    // refused below instead of being trusted.
    const data = Buffer.alloc(info.size + 1);
    let filled = 0;
    while (filled < data.length) {
      const read = readSync(fd, data, filled, data.length - filled, null);
      if (read === 0) break;
      filled += read;
    }
    if (filled > info.size) {
      // The file grew after the fstat: refuse what was read, but still
      // charge the scan for the bytes the descriptor actually yielded.
      budget.remaining -= filled;
      return null;
    }
    budget.remaining -= filled;
    return data.subarray(0, filled);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** #1784: true when the changed file's checked-out workspace content carries
 * the Flux marker pair at root column. Unavailable, unsafe, oversized or
 * over-budget files retain the pre-fix recognition miss. */
function isFluxOciRepositoryManifest(workspace: string, filename: string, budget: DiscoveryBudget): boolean {
  if (!FLUX_SURFACE_FILE_RE.test(filename)) return false;
  if (!workspaceRegularFile(workspace, filename)) return false;
  const content = readDiscoveryBytes(workspace, filename, budget);
  if (content === null) return false;
  const text = content.toString("utf8");
  return FLUX_OCI_KIND_LINE_RE.test(text) && FLUX_SOURCE_API_VERSION_LINE_RE.test(text);
}

/** The jq selection over the parsed `pr-files.raw.json`. `undefined` stands
 * for a file jq could not read (empty or invalid JSON): no output. */
export function selectChangedManifests(prFilesRaw: unknown, workspace?: string): string[] {
  const names: string[] = [];
  if (prFilesRaw === undefined) return names;
  const budget: DiscoveryBudget = { remaining: MANIFEST_DISCOVERY_MAX_TOTAL_BYTES };
  try {
    for (const entry of jqEach(prFilesRaw)) {
      const filename = jqField(entry, "filename");
      if (typeof filename !== "string") return names;
      if (
        MANIFEST_NAME_RE.test(filename) ||
        (workspace !== undefined && isFluxOciRepositoryManifest(workspace, filename, budget))
      ) {
        names.push(filename);
      }
    }
  } catch {
    return names;
  }
  return names;
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
  const printed = selectChangedManifests(prFilesRaw, workspace).map((name) => `${name}\n`).join("");
  const captured = printed.replace(/\0/g, "").replace(/\n+$/, "");
  const manifests = captured === "" ? [] : captured.split("\n").filter((line) => line !== "");
  const parts: Buffer[] = [];
  if (captured === "") {
    parts.push(enc("No common manifest files changed in this PR.\n"));
  } else {
    parts.push(enc("# Changed Manifest Context (modified files only)\n\n"));
    let total = 0;
    for (const file of manifests) {
      if (!workspaceRegularFile(workspace, file)) {
        const notice = workspacePathExists(workspace, file)
          ? "(not embedded: not a regular file inside the checked-out tree, or reached through a symlink)"
          : "(file not present in checked-out tree at this ref)";
        parts.push(enc(`## File: ${file}\n${notice}\n\n`));
        continue;
      }
      const content = readFileSync(workspaceFsPath(workspace, file));
      const lines = countNewlines(content);
      if (total + lines > MANIFEST_LINE_BUDGET) {
        parts.push(enc("(manifest content truncated - too many total lines)\n"));
        break;
      }
      total += lines;
      const fence = fenceDelimiterFor(content);
      // #1261 review: the closer must begin on its own line — a manifest
      // without a trailing newline must not merge into it (an unclosable
      // fence would swallow every corpus section after it). The payload
      // bytes themselves are never touched.
      const separator = endsWithNewline(content) ? "" : "\n";
      parts.push(
        enc(`## File: ${file} (${lines} lines)\n${fence}yaml\n`),
        content,
        enc(`${separator}${fence}\n\n`),
      );
    }
  }
  return { artifacts: new Map([["manifest-context.md", new Uint8Array(Buffer.concat(parts))]]), manifests };
}
