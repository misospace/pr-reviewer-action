/** Repository impact and history (#706 PR 3): byte-exact port of the
 * `repo-impact-history` block of scripts/sections/classification.sh.
 *
 * Term extraction reproduces the v2 pipeline
 *
 *   { jq -r '.title, (.body // "")' pr.json; cat version-hints.truncated.txt; }
 *     | tr '[:upper:]' '[:lower:]' | grep -Eo '[a-z0-9][a-z0-9._/-]{2,}'
 *     | grep -Ev '^(stopwords)$' | sort -u    (then head -n 14)
 *
 * over raw bytes, with the collation production runs under (C.UTF-8 on the
 * GitHub runners, byte order; the terms are ASCII by construction): `tr`
 * lowercases ASCII only, `grep -o` emits the leftmost-longest run per match,
 * and `sort -u` orders and dedupes by byte. Every character outside the
 * term class splits a run, so non-ASCII input only ever acts as a separator.
 *
 * The scan runs the same git commands v2 does, in the workspace: ONE combined
 * `git grep -nEI -e <alt>` (terms joined with `|`, each `.` escaped) plus a
 * `git log --oneline --decorate --grep=<term> -n 10` per term, run
 * concurrently and assembled in term order. Exit statuses are ignored and
 * stdout kept, as `2>/dev/null || true` does. Each combined grep row is then
 * re-attributed to every term whose literal text occurs in the row's content
 * (the row minus the `^[^:]*:[0-9]+:` prefix, the awk `sub`), 60 rows per
 * term. Git output is handled as bytes (latin1 view), never re-encoded. */

import { spawn } from "node:child_process";
import { jqAlt, jqField, jqRaw } from "../platform/jq.js";
import { truncateClean } from "../corpus/truncate.js";

export const MAX_IMPACT_TERMS = 14;
export const MAX_HITS_PER_TERM = 60;
export const REPO_IMPACT_MAX_BYTES = 24000;
export const REPO_HISTORY_MAX_BYTES = 12000;
export const IMPACT_MARKER = "…[impact scan truncated]";
export const HISTORY_MARKER = "…[history truncated]";
export const NO_TERMS_NOTICE = "No candidate dependency terms extracted.\n";

const TERM_RE = /[a-z0-9][a-z0-9._/-]{2,}/g;
const STOPWORDS = new Set([
  "https", "http", "from", "into", "that", "this", "with", "without", "renovate", "pull", "request",
  "release", "notes", "digest", "sha", "main", "chart", "image", "version", "github", "com", "www",
  "docker", "ghcr", "io",
]);
const GREP_PREFIX_RE = /^[^:]*:[0-9]+:/;

const latin1 = (data: Uint8Array): string => Buffer.from(data).toString("latin1");
const fromLatin1 = (text: string): Buffer => Buffer.from(text, "latin1");
const enc = (text: string): Buffer => Buffer.from(text, "utf8");

/** stdout of `jq -r '.title, (.body // "")'` over the pr.json value: each
 * record plus a newline, stopping at the first jq error. */
function titleAndBody(pr: unknown): Buffer {
  let out = "";
  try {
    out += `${jqRaw(jqField(pr, "title"))}\n`;
    out += `${jqRaw(jqAlt(jqField(pr, "body"), ""))}\n`;
  } catch {
    // jq stops at the error; what it printed stays in the pipe.
  }
  return enc(out);
}

/** The deduped, byte-sorted term list (`terms.all.txt` lines). */
export function extractImpactTerms(pr: unknown, versionHintsTruncated: Uint8Array | null): string[] {
  const input = Buffer.concat([titleAndBody(pr), Buffer.from(versionHintsTruncated ?? new Uint8Array(0))]);
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i] as number;
    if (byte >= 0x41 && byte <= 0x5a) input[i] = byte + 0x20;
  }
  const terms = new Set<string>();
  for (const line of latin1(input).split("\n")) {
    for (const match of line.matchAll(TERM_RE)) {
      if (!STOPWORDS.has(match[0])) terms.add(match[0]);
    }
  }
  // ASCII only, so UTF-16 order is byte order.
  return [...terms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Terms are [a-z0-9._/-] only, so this matches v2's `sed 's/\./\\./g'`;
// backslash is escaped too so the grep pattern stays literal regardless.
const escapeTerm = (term: string): string => term.replace(/[\\.]/g, "\\$&");

function runGitStdout(argv: string[], workspace: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", argv, { cwd: workspace, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(Buffer.alloc(0));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(Buffer.concat(chunks)));
    child.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

/** awk re-attribution of the combined grep output to one term. */
export function attributeGrepHits(combined: Uint8Array, term: string, limit = MAX_HITS_PER_TERM): string {
  const text = latin1(combined);
  const rows = text.split("\n");
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  let out = "";
  let matches = 0;
  for (const row of rows) {
    if (!row.replace(GREP_PREFIX_RE, "").includes(term)) continue;
    out += `${row}\n`;
    matches += 1;
    if (matches === limit) break;
  }
  return out;
}

export interface RepoImpactInput {
  /** The parsed `pr.json` value (the projection context.sh writes). */
  pr: unknown;
  /** `version-hints.truncated.txt` bytes; `null` when the file is absent. */
  versionHintsTruncated: Uint8Array | null;
  /** The checked-out repository (v2's working directory). */
  workspace: string;
}

export interface RepoImpactResult {
  artifacts: Map<string, Uint8Array>;
  /** The capped, ordered scan terms (`terms.txt`). */
  terms: string[];
}

export async function buildRepoImpactHistory(input: RepoImpactInput): Promise<RepoImpactResult> {
  const allTerms = extractImpactTerms(input.pr, input.versionHintsTruncated);
  const terms = allTerms.slice(0, MAX_IMPACT_TERMS);
  const artifacts = new Map<string, Uint8Array>();
  const lines = (items: string[]): Uint8Array => enc(items.map((item) => `${item}\n`).join(""));
  artifacts.set("terms.all.txt", lines(allTerms));
  artifacts.set("terms.txt", lines(terms));
  if (terms.length === 0) {
    const notice = enc(NO_TERMS_NOTICE);
    for (const name of ["repo-impact.md", "repo-history.md", "repo-impact.truncated.md", "repo-history.truncated.md"]) {
      artifacts.set(name, new Uint8Array(notice));
    }
    return { artifacts, terms };
  }
  const alt = terms.map(escapeTerm).join("|");
  const [combined, ...histories] = await Promise.all([
    runGitStdout(["grep", "-nEI", "-e", alt, "--", "."], input.workspace),
    ...terms.map((term) => runGitStdout(["log", "--oneline", "--decorate", `--grep=${term}`, "-n", "10"], input.workspace)),
  ]);
  const impact: Buffer[] = [];
  const history: Buffer[] = [];
  terms.forEach((term, index) => {
    impact.push(enc(`## Term: ${term}\n\n### git grep hits\n\`\`\`text\n`), fromLatin1(attributeGrepHits(combined as Buffer, term)), enc("```\n\n"));
    history.push(enc(`## Term: ${term}\n\n### git log context\n\`\`\`text\n`), histories[index] as Buffer, enc("```\n\n"));
  });
  const impactBytes = new Uint8Array(Buffer.concat(impact));
  const historyBytes = new Uint8Array(Buffer.concat(history));
  artifacts.set("repo-impact.md", impactBytes);
  artifacts.set("repo-history.md", historyBytes);
  artifacts.set("repo-impact.truncated.md", truncateClean(impactBytes, REPO_IMPACT_MAX_BYTES, IMPACT_MARKER));
  artifacts.set("repo-history.truncated.md", truncateClean(historyBytes, REPO_HISTORY_MAX_BYTES, HISTORY_MARKER));
  return { artifacts, terms };
}
