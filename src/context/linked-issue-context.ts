/** Linked-issue context (#706 PR 3): byte-exact port of the `linked-issues`
 * block of scripts/sections/context.sh — the per-issue fetch loop, the
 * rendered `linked-issues.md`, the label merge-back into the canonical
 * `linked-issues.json` (#633), the optional Linear adapter with its fork
 * gate, and the `linked-metadata-status.json` completeness record.
 *
 * Every artifact is returned as the exact bytes v2 leaves on disk:
 *
 * - `linked-issues.json` starts as Python's one-line `json.dumps(...)`
 *   (ASCII-escaped, `", "` / `": "`) and becomes jq's pretty form once the
 *   label merge or the Linear merge rewrites it (the Linear merge rewrites it
 *   even when Linear found nothing);
 * - each fetched issue embeds the pretty jq projection
 *   `{number,title,state,html_url,labels:[.labels[]?.name],body}` cut by
 *   `head -c 12000` — a byte cut that may split a UTF-8 sequence;
 * - a projection error (a non-object issue, a label that is not an object)
 *   aborts the v2 review under `set -euo pipefail`; here it throws
 *   `LinkedIssueProjectionError`;
 * - a failed fetch renders a notice and records the ref; Linear lookups that
 *   fail per identifier, or an adapter that cannot run at all, are
 *   uncertainty, while the fork gate is known-disabled state. */

import type { FetchLike } from "../platform/http.js";
import { isPlainObject, jqAlt, jqEach, jqEachOpt, jqField, jqPretty, jqRaw, JqError } from "../platform/jq.js";
import { pyOr, pyStr } from "../platform/py.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { collectFromPr, linearIssueToV2, parsePrefixes, pyStrip, renderLinearMarkdown, type CollectResult } from "../precheck/linear.js";
import { extractLinkedIssueRefs } from "../precheck/linked-issues.js";
import { pyJsonDump, pyJsonDumpsLine } from "./py-json.js";

export const LINKED_ISSUE_EMBED_BYTES = 12000;
export const LINEAR_ADAPTER_FAILED = "linear-adapter-failed";

export class LinkedIssueProjectionError extends Error {}

const enc = (text: string): Buffer => Buffer.from(text, "utf8");

/** `jq '{number,title,state,html_url,labels:[.labels[]?.name],body}'`. */
export function projectLinkedIssue(issue: unknown): Record<string, unknown> {
  try {
    const labels = jqEachOpt(jqField(issue, "labels")).map((label) => jqField(label, "name"));
    return {
      number: jqField(issue, "number"),
      title: jqField(issue, "title"),
      state: jqField(issue, "state"),
      html_url: jqField(issue, "html_url"),
      labels,
      body: jqField(issue, "body"),
    };
  } catch (error) {
    if (error instanceof JqError) throw new LinkedIssueProjectionError(`jq: projection failed: ${error.message}`);
    throw error;
  }
}

/** Decimal value of a Unicode `Nd` digit: Nd characters come in contiguous
 * runs of ten starting at zero, so the value is the offset in its run. */
function ndValue(ch: string): number {
  let cp = ch.codePointAt(0) as number;
  let offset = 0;
  while (/^\p{Nd}$/u.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    offset += 1;
  }
  return offset % 10;
}

/** Python 3.14 `int(text)`: surrounding `str.isspace()` whitespace, an
 * optional sign, and any Unicode decimal digits with single underscores
 * between them. `null` where Python raises `ValueError`. */
export function pyInt(text: string): number | null {
  const stripped = pyStrip(text);
  const match = /^([+-]?)(\p{Nd}(?:_?\p{Nd})*)$/u.exec(stripped);
  if (match === null) return null;
  let value = 0;
  for (const ch of (match[2] as string).replace(/_/g, "")) value = value * 10 + ndValue(ch);
  return match[1] === "-" ? -value : value;
}

/** The value `linear_context.py --timeout <text>` ends up with (CPython 3.14
 * argparse, `type=int`), or `null` when argparse exits 2. A value starting
 * with `-` is only taken as the option's argument when it looks like a
 * negative number (`-\.?\d`, Unicode digits) or contains a space; anything
 * else parses as an unknown option. The action's config already restricts
 * the input to `^[0-9]+$` >= 1, so the fallbacks here are defensive. */
export function pyParseInt(text: string): number | null {
  if (text.length > 1 && text.startsWith("-") && !/^-\.?\p{Nd}/u.test(text) && !text.includes(" ")) return null;
  return pyInt(text);
}

export interface LinearOptions {
  /** `LINEAR_API_KEY` (raw env value). */
  apiKey: string;
  /** `LINEAR_ISSUE_PREFIXES`. */
  prefixes: string;
  /** `LINEAR_ISSUE_TIMEOUT_SEC` (raw; parsed like argparse `type=int`). */
  timeoutSec: string;
  /** `LINEAR_ENABLE_FOR_FORKS`. */
  enableForForks: string;
  apiUrl?: string | undefined;
  fetchImpl?: FetchLike | undefined;
}

export interface LinkedIssueContextInput {
  /** The parsed `pr.json` value. */
  pr: unknown;
  /** `$REPO`, the default repo for bare `#N` refs. */
  repo: string;
  adapter: Pick<PlatformReadAdapter, "getIssue">;
  /** `$IS_FORK_PR` as resolved by the precheck (exactly "true" = fork). */
  isForkPr: string;
  linear: LinearOptions;
}

export interface LinkedIssueContextResult {
  /** `linked-issues.json`, `linked-issues.md`, `linear-issues.json`,
   * `linear-issues.md`, `linked-metadata-status.json`. */
  artifacts: Map<string, Uint8Array>;
  /** The final `linked-issues.json` value (what classification reads). */
  linkedIssues: unknown[];
  githubFetchFailures: string[];
  linearFetchFailures: string[];
  linearKnownDisabled: boolean;
}

type LinearOutcome =
  | { kind: "skipped" }
  | { kind: "fork-disabled" }
  | { kind: "failed" }
  | { kind: "ok"; result: CollectResult };

async function runLinear(input: LinkedIssueContextInput): Promise<LinearOutcome> {
  const { linear } = input;
  if (linear.apiKey === "" || linear.prefixes === "") return { kind: "skipped" };
  if (input.isForkPr === "true" && linear.enableForForks.replace(/[A-Z]/g, (c) => c.toLowerCase()) !== "true") {
    return { kind: "fork-disabled" };
  }
  // linear_context.main: argparse, then prefixes, then the key; any of them
  // failing exits 2, which the section treats as an adapter failure.
  const timeout = pyParseInt(linear.timeoutSec);
  if (timeout === null) return { kind: "failed" };
  let prefixes: string[];
  try {
    prefixes = parsePrefixes(linear.prefixes);
  } catch {
    return { kind: "failed" };
  }
  const apiKey = pyStrip(linear.apiKey);
  if (apiKey === "") return { kind: "failed" };
  const title = pyStr(pyOr(isPlainObject(input.pr) ? input.pr.title : undefined, ""));
  const result = await collectFromPr(title, prefixes, apiKey, {
    timeout: Math.max(1, timeout),
    ...(linear.apiUrl !== undefined ? { apiUrl: linear.apiUrl } : {}),
    ...(linear.fetchImpl !== undefined ? { fetchImpl: linear.fetchImpl } : {}),
  });
  return { kind: "ok", result };
}

export async function buildLinkedIssueContext(input: LinkedIssueContextInput): Promise<LinkedIssueContextResult> {
  const artifacts = new Map<string, Uint8Array>();
  const body = `${jqRaw(jqAlt(jqField(input.pr, "body"), ""))}\n`;
  const title = pyStr(pyOr(isPlainObject(input.pr) ? input.pr.title : undefined, ""));
  const refs = extractLinkedIssueRefs(body, input.repo, title).map((item) => ({ ref: item.ref, repo: item.repo, number: item.number }));
  let linkedJson: Buffer = enc(`${pyJsonDumpsLine(refs)}\n`);
  let linked: unknown[] = refs;
  const md: Buffer[] = [];
  const githubFailures: string[] = [];

  if (refs.length > 0) {
    const labelsByRef = new Map<string, unknown[]>();
    let anyLabels = false;
    for (const item of refs) {
      md.push(enc(`## ${item.ref}\n`));
      const fetched = await input.adapter.getIssue(item.repo, String(item.number));
      if (fetched.ok) {
        const filtered = projectLinkedIssue(fetched.data);
        labelsByRef.set(item.ref, (filtered.labels as unknown[]).map((name) => ({ name })));
        anyLabels = true;
        md.push(enc("```json\n"), enc(`${jqPretty(filtered)}\n`).subarray(0, LINKED_ISSUE_EMBED_BYTES), enc("\n```\n"));
      } else {
        md.push(enc(`(Could not fetch issue ${item.ref} from ${item.repo})\n`));
        githubFailures.push(item.ref);
      }
      md.push(enc("\n"));
    }
    if (anyLabels) {
      linked = refs.map((item) => ({ ...item, labels: labelsByRef.get(item.ref) ?? [] }));
      linkedJson = enc(`${jqPretty(linked)}\n`);
    }
  }

  let linearJson: Buffer = enc("[]\n");
  let linearMd: Buffer = Buffer.alloc(0);
  let linearFailures: string[] = [];
  let linearKnownDisabled = false;
  const outcome = await runLinear(input);
  if (outcome.kind === "fork-disabled") {
    linearKnownDisabled = true;
  } else if (outcome.kind === "failed") {
    linearFailures = [LINEAR_ADAPTER_FAILED];
  } else if (outcome.kind === "ok") {
    const { issues, errors } = outcome.result;
    const records = issues.map(linearIssueToV2);
    linearJson = enc(`${pyJsonDump(records, 2)}\n`);
    linearMd = enc(renderLinearMarkdown(issues, errors));
    linearFailures = errors.map(([identifier]) => identifier);
    md.push(linearMd);
    linked = [...jqEach(linked), ...records];
    linkedJson = enc(`${jqPretty(linked)}\n`);
  }

  artifacts.set("linked-issues.json", new Uint8Array(linkedJson));
  artifacts.set("linked-issues.md", new Uint8Array(Buffer.concat(md)));
  artifacts.set("linear-issues.json", new Uint8Array(linearJson));
  artifacts.set("linear-issues.md", new Uint8Array(linearMd));
  artifacts.set("linked-metadata-status.json", enc(`${jqPretty({
    version: 1,
    github_fetch_failures: githubFailures,
    linear_fetch_failures: linearFailures,
    linear_known_disabled: linearKnownDisabled,
  })}\n`));
  return {
    artifacts,
    linkedIssues: linked,
    githubFetchFailures: githubFailures,
    linearFetchFailures: linearFailures,
    linearKnownDisabled,
  };
}
