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
 *   `head -c 12000` — a byte cut that may split a UTF-8 sequence. The
 *   projection's forge-authored strings (`title`, label names, `body`)
 *   carry one deliberate divergence from v2 (#1159): they pass through the
 *   line-preserving credential-shape redaction (`redactPrTextLines`, #1154)
 *   before serialization, so a credential-shaped value in a forge-authored
 *   issue never reaches the persisted artifacts or the model request;
 * - a projection error (a non-object issue, a label that is not an object)
 *   aborts the v2 review under `set -euo pipefail`; here it throws
 *   `LinkedIssueProjectionError`;
 * - a failed fetch renders a notice and records the ref; Linear lookups that
 *   fail per identifier, or an adapter that cannot run at all, are
 *   uncertainty, while the fork gate is known-disabled state.
 * - (#872) a non-closing ref (title `(#N)` convention, or a body
 *   `Implements`/`Part of`/`Refs` reference) whose fetched object is a pull
 *   request is rejected before projection: it renders a skip notice instead
 *   of the issue's content, is recorded in `linked-metadata-status.json` as
 *   a skip (not a failure — it never marks linked-metadata uncertain), and
 *   never reaches the requirement ledger. Closing-keyword refs (`Closes`/
 *   `Fixes`/`Resolves`) are unaffected — parity with the pre-#872 fetch
 *   behavior is preserved for them.
 * - (#1749) every ACCEPTED issue renders one exact-match relationship line
 *   under its heading (`(linked as: closing|non-closing reference)`), so the
 *   reference shape the PR itself used survives into `linked-issues.md` —
 *   the requirement ledger's only channel — instead of being dropped with
 *   the processed-ref representation.
 * - (#1750) an ACCEPTED issue whose own body carries a task-list
 *   decomposition associating criteria with child issues renders one
 *   exact-structure `(decomposition: req-<content id> -> <child refs>)`
 *   line per associated criterion — trusted forge metadata for the
 *   umbrella-parent scope boundary, parsed conservatively (task-list items
 *   only, bounded, fail-closed) and keyed by the ledger's own content id so
 *   issue content never appears outside the fence. */

import type { FetchLike } from "../platform/http.js";
import { isPlainObject, jqAlt, jqEach, jqEachOpt, jqField, jqPretty, jqRaw, JqError } from "../platform/jq.js";
import { pyOr, pyStr, pyStrip } from "../platform/py.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { collectFromPr, linearIssueToV2, parsePrefixes, renderLinearMarkdown, type CollectResult } from "../precheck/linear.js";
import { acceptedLinkedIssues, childRefsInText, extractLinkedIssueRefs, isPullRequestPayload, linkedIssueFetchAllowed, LINKED_AS_CLOSING_LINE, LINKED_AS_NON_CLOSING_LINE, MAX_DECOMPOSITION_LINES_PER_ISSUE, MAX_DECOMPOSITION_REFS_PER_CRITERION, renderDecompositionLine, type LinkedIssueRef } from "../precheck/linked-issues.js";
import { normalizeRequirementText, requirementIdOfText } from "../requirements/requirement-id.js";
import { pyJsonDump, pyJsonDumpsLine } from "./py-json.js";
import { redactPrTextLines } from "./redact.js";

export const LINKED_ISSUE_EMBED_BYTES = 12000;
export const LINEAR_ADAPTER_FAILED = "linear-adapter-failed";

export class LinkedIssueProjectionError extends Error {}

const enc = (text: string): Buffer => Buffer.from(text, "utf8");

// Re-exported for existing consumers (src/context/index.ts); the
// implementation moved to src/precheck/linked-issues.ts (#872 cross-stage
// fix) so buildSelectionSignature can share it without a context->precheck
// import cycle.
export { isPullRequestPayload };

/** #1159: every forge-authored string in the projection goes through the
 * line-preserving credential-shape pass (#1154) before serialization, so a
 * credential in a fetched issue body — same-line (`api_key=…`, `Bearer …`,
 * `sk-…`) or split-line (`password:` + indented value) — never reaches the
 * persisted `linked-issues.md`, the requirement-ledger parse of it, or the
 * corpus/`ai-request.<tier>.json` built from those bytes. Label names share
 * the same forge-authored trust class (they persist into
 * `linked-issues.json` too), and the pass is inert on ordinary names, so the
 * classification trigger-label matching over them is unaffected. Line
 * structure is kept byte-for-byte (the flat `redactText` pass would collapse
 * a split-line credential into one line), and the pass is idempotent, so
 * re-persisting an already-redacted artifact is a no-op. Non-string values
 * (a jq `null` body) pass through untouched to preserve the projection's
 * parity shape. */
function redactForgeProse(value: unknown): unknown {
  return typeof value === "string" ? redactPrTextLines(value) : value;
}

/** `jq '{number,title,state,html_url,labels:[.labels[]?.name],body}'`, with
 * the forge-authored string fields (`title`, label names, `body`)
 * credential-redacted (#1159). */
export function projectLinkedIssue(issue: unknown): Record<string, unknown> {
  try {
    const labels = jqEachOpt(jqField(issue, "labels")).map((label) => redactForgeProse(jqField(label, "name")));
    return {
      number: jqField(issue, "number"),
      title: redactForgeProse(jqField(issue, "title")),
      state: jqField(issue, "state"),
      html_url: jqField(issue, "html_url"),
      labels,
      body: redactForgeProse(jqField(issue, "body")),
    };
  } catch (error) {
    if (error instanceof JqError) throw new LinkedIssueProjectionError(`jq: projection failed: ${error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// #1750: trusted criterion→child ownership evidence from the linked issue's
// own decomposition structure
//
// The umbrella-parent scope narrowing may treat an acceptance criterion as
// not-this-increment's merge contract ONLY when trusted deterministic
// evidence shows the SPECIFIC criterion is owned by separately decomposed
// child work — never on the umbrella label + non-closing ref alone, and
// never from model prose or PR text. The trusted channel is the linked
// issue's OWN body: its task-list decomposition, where a task-list item
// (the criterion) references child issues inline, or is followed by list
// items nested under it that carry child refs. This is forge metadata
// fetched at intake with the deployment's own read credential — the same
// trust class as the body text the requirement ledger already scans — and
// it is parsed conservatively: only task-list items are criteria, only
// issue-reference tokens are children, and every bound (below) drops an
// association it cannot carry whole.
//
// Each association renders as ONE exact-structure metadata line between the
// `(linked as: …)` line and the JSON fence:
//
//     (decomposition: req-<content id> -> o/r#101, o/r#102)
//
// The content id is the requirement ledger's own id recipe
// ({@link requirementIdOfText}, applied over the SAME normalization the
// ledger scanner uses — {@link normalizeRequirementText}) — so issue content
// never appears outside the fence (the exact-match trust model for metadata
// lines holds) and the ledger can attach the association to exactly the
// entry the id names. Normalization/id drift between intake and the ledger
// silently detaches associations, which fails CLOSED downstream (the
// criterion stays in scope), never unsafe. The body parsed here is the
// projected (credential-redacted) body — the exact bytes that land inside
// the fence — so both sides of the seam hash the same text.
// ---------------------------------------------------------------------------

interface BodyListItem {
  indent: number;
  content: string;
  task: boolean;
}

const INTAKE_TASK_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+\[[xX ]\][ \t]*(.*)$/;
const INTAKE_LIST_ITEM_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/;

function indentWidth(spaces: string): number {
  let width = 0;
  for (const ch of spaces) width += ch === "\t" ? 4 : 1;
  return width;
}

/** Parse a linked issue's body into its trusted decomposition associations
 * and render them as metadata lines, in body order. Only task-list items
 * carry criteria; the child refs of a criterion are the issue references in
 * its own text plus those on the list items nested under it (its subtree,
 * until the first item at equal or shallower indent). A task item with no
 * child refs renders nothing; an item naming more children than the bound
 * renders nothing (an association that cannot be carried whole is never
 * approximated — truncation could silently drop the very child the PR
 * references, which is the unsafe direction). At most
 * {@link MAX_DECOMPOSITION_LINES_PER_ISSUE} lines per issue. */
function bodyDecompositionLines(body: string, ownerRepo: string): string[] {
  const items: BodyListItem[] = [];
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const task = INTAKE_TASK_ITEM_RE.exec(raw);
    if (task !== null) {
      items.push({ indent: indentWidth(task[1] ?? ""), content: task[2] ?? "", task: true });
      continue;
    }
    const plain = INTAKE_LIST_ITEM_RE.exec(raw);
    if (plain !== null) items.push({ indent: indentWidth(plain[1] ?? ""), content: plain[2] ?? "", task: false });
  }
  const lines: string[] = [];
  for (let index = 0; index < items.length && lines.length < MAX_DECOMPOSITION_LINES_PER_ISSUE; index += 1) {
    const item = items[index]!;
    if (!item.task) continue;
    const refs = childRefsInText(item.content, ownerRepo);
    let next = index + 1;
    while (next < items.length && items[next]!.indent > item.indent) {
      if (refs.length <= MAX_DECOMPOSITION_REFS_PER_CRITERION) {
        for (const ref of childRefsInText(items[next]!.content, ownerRepo)) {
          if (!refs.includes(ref)) refs.push(ref);
        }
      }
      next += 1;
    }
    if (refs.length === 0 || refs.length > MAX_DECOMPOSITION_REFS_PER_CRITERION) continue;
    const normalized = normalizeRequirementText(item.content);
    if (normalized === null) continue;
    lines.push(renderDecompositionLine(requirementIdOfText(normalized.text), refs));
  }
  return lines;
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
  /** Non-closing refs (#872) whose fetched object was a pull request,
   * rejected before projection — never a failure (the fetch succeeded), so
   * these never feed `linkedMetadataUncertainty`. */
  githubPullRequestSkips: string[];
  /** #1617: cross-repository refs refused by the fork trust boundary BEFORE
   * any fetch: never attempted, never failures, never uncertainty. */
  githubForkSkips: string[];
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
  // Extraction is uncapped up to a generous hard safety bound (candidates
  // may include refs this loop never reaches). The MAX_LINKED_ISSUES cap is
  // enforced by the SHARED `acceptedLinkedIssues` generator (also used by
  // buildSelectionSignature, #872 cross-stage fix), over accepted issues —
  // a fetched-and-projected issue, i.e. successfully fetched and (for
  // non-closing refs) not rejected as a pull request — not over raw refs: a
  // title `(#N)` that resolves to a pull request, or a ref whose fetch
  // fails, must not evict a real issue from the cap, in this stage or the
  // other one. `processedRefs` is exactly the prefix of candidates this
  // loop actually attempted, in order, and is what `linked-issues.json` /
  // the requirement ledger see — refs beyond it are never fetched at all.
  const refItems = extractLinkedIssueRefs(body, input.repo, title);
  // #1617: the fork trust boundary gates WHICH refs may be fetched at all,
  // before any privileged read: on a fork PR, cross-repository refs are
  // refused by rule regardless of how capable the deployment's credential
  // is. Refused refs never enter `acceptedLinkedIssues`, never consume a
  // MAX_LINKED_ISSUES slot, and never appear in `processedRefs` (which is
  // exactly the refs the loop attempted). They render a refusal notice and
  // are recorded in the status artifact, so the review proves the attempt
  // was refused rather than silently dropped.
  const isForkPr = input.isForkPr === "true";
  const fetchableRefs: LinkedIssueRef[] = [];
  const forkSkippedRefs: LinkedIssueRef[] = [];
  for (const item of refItems) {
    (linkedIssueFetchAllowed(item, input.repo, isForkPr) ? fetchableRefs : forkSkippedRefs).push(item);
  }
  const md: Buffer[] = [];
  const githubFailures: string[] = [];
  const pullRequestSkips: string[] = [];
  const forkSkips: string[] = forkSkippedRefs.map((item) => item.ref);
  const processedRefs: { ref: string; repo: string; number: number }[] = [];
  const labelsByRef = new Map<string, unknown[]>();
  let anyLabels = false;

  for await (const outcome of acceptedLinkedIssues(
    fetchableRefs,
    (repo, number) => input.adapter.getIssue(repo, String(number)),
  )) {
    const item = outcome.ref;
    processedRefs.push({ ref: item.ref, repo: item.repo, number: item.number });
    md.push(enc(`## ${item.ref}\n`));
    if (outcome.kind === "pull_request_skip") {
      md.push(enc(`(Skipped issue ${item.ref} from ${item.repo}: linked object is a pull request)\n`));
      pullRequestSkips.push(item.ref);
    } else if (outcome.kind === "accepted") {
      const filtered = projectLinkedIssue(outcome.data);
      labelsByRef.set(item.ref, (filtered.labels as unknown[]).map((name) => ({ name })));
      anyLabels = true;
      // #1749: the reference shape the PR itself used — the one relationship
      // signal the requirement ledger can trust — rendered as an exact-match
      // line between the heading and the embedded issue JSON. The issue's
      // own content stays fenced below it; this line is intake-authored.
      md.push(enc(`${item.closing ? LINKED_AS_CLOSING_LINE : LINKED_AS_NON_CLOSING_LINE}\n`));
      // #1750: the linked issue's own task-list decomposition, rendered as
      // exact-structure ownership lines (see bodyDecompositionLines). The
      // body parsed here is the projected (redacted) body — the exact bytes
      // that land inside the fence below — so the content ids the ledger
      // matches against are derived from the same text the scanner reads.
      for (const line of bodyDecompositionLines(typeof filtered.body === "string" ? filtered.body : "", item.repo)) {
        md.push(enc(`${line}\n`));
      }
      md.push(enc("```json\n"), enc(`${jqPretty(filtered)}\n`).subarray(0, LINKED_ISSUE_EMBED_BYTES), enc("\n```\n"));
    } else {
      md.push(enc(`(Could not fetch issue ${item.ref} from ${item.repo})\n`));
      githubFailures.push(item.ref);
    }
    md.push(enc("\n"));
  }

  // #1617: refusals render in candidate order after the fetched set, each
  // with its own heading so the artifact positively records that the
  // reference existed and was refused — never with the referenced issue's
  // content (there is none: the fetch never happened).
  for (const item of forkSkippedRefs) {
    md.push(enc(`## ${item.ref}\n`));
    md.push(enc(`(Skipped issue ${item.ref} from ${item.repo}: cross-repository linked-issue reference on a fork pull request)\n`));
    md.push(enc("\n"));
  }

  let linkedJson: Buffer = enc(`${pyJsonDumpsLine(processedRefs)}\n`);
  let linked: unknown[] = processedRefs;
  if (anyLabels) {
    linked = processedRefs.map((item) => ({ ...item, labels: labelsByRef.get(item.ref) ?? [] }));
    linkedJson = enc(`${jqPretty(linked)}\n`);
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
    // Additive (#872): only present when non-empty, so a review with no
    // rejected pull-request refs keeps the pre-#872 byte-identical status
    // artifact. A skip is a deliberate rejection, not a failure — it is
    // never folded into `linkedMetadataUncertainty`.
    ...(pullRequestSkips.length > 0 ? { github_pull_request_skips: pullRequestSkips } : {}),
    // Additive (#1617): the same rule for the fork-boundary refusals — a
    // deliberate policy refusal, never uncertainty.
    ...(forkSkips.length > 0 ? { github_fork_skips: forkSkips } : {}),
  })}\n`));
  return {
    artifacts,
    linkedIssues: linked,
    githubFetchFailures: githubFailures,
    githubPullRequestSkips: pullRequestSkips,
    githubForkSkips: forkSkips,
    linearFetchFailures: linearFailures,
    linearKnownDisabled,
  };
}
