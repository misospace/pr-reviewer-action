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
 *   issue content never appears outside the fence.
 * - (#1750 round 3/4) the organic umbrella shape — acceptance criteria with
 *   no child refs plus a flat decomposition list — attests ownership through
 *   the DECOMPOSED CHILD ISSUES themselves: for a non-closing umbrella-class
 *   linked issue, intake fetches the decomposition's children (bounded) and
 *   renders the same `(decomposition: …)` line when the child's own body
 *   names the parent AND carries a criterion sharing the parent criterion's
 *   requirement identity. Round 4 (operator follow-up 7025382962): several
 *   children independently passing every gate for one criterion is JOINT
 *   OWNERSHIP — the line carries the full bounded owner set. Cross-matched,
 *   one-sided, or unreadable shapes render nothing (fail closed); the
 *   ledger and scope predicate seams are unchanged. */

import type { FetchLike } from "../platform/http.js";
import { isPlainObject, jqAlt, jqEach, jqEachOpt, jqField, jqPretty, jqRaw, JqError } from "../platform/jq.js";
import { pyOr, pyStr, pyStrip } from "../platform/py.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import { collectFromPr, linearIssueToV2, parsePrefixes, renderLinearMarkdown, type CollectResult } from "../precheck/linear.js";
import { acceptedLinkedIssues, canonicalChildRef, childRefsInText, extractLinkedIssueRefs, isPullRequestPayload, linkedIssueFetchAllowed, LINKED_AS_CLOSING_LINE, LINKED_AS_NON_CLOSING_LINE, MAX_ATTESTATION_CRITERIA_PER_BODY, MAX_ATTESTED_CHILD_BODY_BYTES, MAX_DECOMPOSITION_CHILDREN_PER_ISSUE, MAX_DECOMPOSITION_LINES_PER_ISSUE, MAX_DECOMPOSITION_REFS_PER_CRITERION, parseDecompositionLine, renderDecompositionLine, requirementIdentityAttests, type LinkedIssueFetchResult, type LinkedIssueRef } from "../precheck/linked-issues.js";
import { pySplitLines } from "../requirements/ledger.js";
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

// ---------------------------------------------------------------------------
// #1750 round 3: the child-attestation ownership channel. cbdb6287's
// {@link bodyDecompositionLines} associates a criterion with child work only
// when the criterion's OWN task-list item carries child refs — the organic
// Dispatch umbrella shape (real #740: acceptance criteria with no refs plus
// a flat, separate decomposition list) yields no evidence and the parent
// criterion stays material. The next trustworthy seam is the DECOMPOSED
// CHILD ISSUES THEMSELVES, fetched at intake with the deployment's own read
// credential — the same trust class as the linked-issue bodies. An
// association fires only when ALL of:
//
//   (a) the umbrella's own body lists the child in a decomposition section
//       (the groomer `dispatch-groomer:decomposition` marker region, or a
//       bare `## Decomposition` heading section);
//   (b) the fetched child's own body names that parent — a `Parent:` line
//       resolving to exactly the umbrella's canonical `repo#N` identity
//       (bare `#N`, `owner/repo#N`, or an issues/pull URL, as the real
//       #1677 body carries);
//   (c) the child's own acceptance criterion carries the parent criterion's
//       requirement identity — a shared contiguous run of ≥ 3 substantial
//       tokens (`requirementIdentityAttests`, calibrated on the real
//       #740/#1677 texts, whose criterion wording differs but shares the
//       requirement-bearing phrase `same scheduler engine`).
//
// A criterion with at least one attesting child renders ONE
// `(decomposition: req-<content id> -> <canonical children>)` line — the
// seam cbdb6287 built — so the ledger provenance parse and the scope
// predicate consume it unchanged. Round 4 (operator follow-up 7025382962):
// MULTIPLE children independently passing every gate for the same parent
// criterion is JOINT OWNERSHIP, not ambiguity — the line carries the FULL
// bounded owner set (at most MAX_DECOMPOSITION_REFS_PER_CRITERION refs, the
// existing childRefs contract the consumer already unions; the criterion
// stays mandatory when the PR references ANY owning child). A child
// criterion matching several parent criteria is a cross-matched identity
// that cannot be disambiguated and attests nothing, and an owner set over
// the per-line bound drops the association whole. Any UNREADABLE child —
// fetch failure, pull-request payload, over-size body, refused cross-repo
// read on a fork — voids this umbrella's attestation WHOLE: a partial child
// set could hide a second attesting child and make a jointly-owned
// criterion look like a smaller owner set (the unsafe direction). A fetched
// child that simply does not attest (wrong or missing parentage, no
// matching criterion) is positive non-attestation evidence and only removes
// itself. No model prose and no PR prose participates: every input here is
// forge-fetched issue content, every output is a content id plus canonical
// refs. The intake pre-gate (fetch children only for a NON-CLOSING linked
// issue carrying an umbrella-class forge label) mirrors the consumer's
// per-ref gate, so the bounded fetches happen only where the evidence could
// be consumed; drift in either direction degrades to fewer or inert
// fetches, never to unsafe ownership.
// ---------------------------------------------------------------------------

/** The umbrella-label vocabulary of the consumer's per-ref gate
 * (`UMBRELLA_ISSUE_LABELS` in src/enforcement/requirement-trace.ts). The
 * pre-gate below only saves bounded fetches on issues the consumer could
 * never consume evidence for; a drift here degrades to inert work or to a
 * criterion staying in scope (fail closed), never to unsafe ownership. */
const INTAKE_UMBRELLA_LABELS: ReadonlySet<string> = new Set(["umbrella", "epic"]);

/** Whether the projected label list carries an umbrella-class forge label
 * (the consumer scans the first 8 bounded labels; this pre-gate scans all of
 * them — a wider pre-gate only ever fetches for evidence the consumer would
 * ignore, never the reverse). */
function hasUmbrellaLabel(labels: unknown): boolean {
  if (!Array.isArray(labels)) return false;
  for (const label of labels) {
    if (typeof label !== "string") continue;
    if (INTAKE_UMBRELLA_LABELS.has(label.slice(0, 256).trim().toLowerCase())) return true;
  }
  return false;
}

/** Acceptance-heading vocabulary the requirement ledger extracts criteria
 * under (ACCEPTANCE_HEADINGS parity — the same set, by exact normalized
 * heading). Criteria the ledger demotes (advisory sections, uppercase-MUST
 * normative lines elsewhere) either detach their rendered id or never
 * extract — both directions fail closed downstream. */
const INTAKE_ACCEPTANCE_HEADINGS: ReadonlySet<string> = new Set([
  "acceptance criteria",
  "requirements",
  "invariants",
  "success criteria",
  "required checks",
]);

// The ledger scanner's line shapes, mirrored so intake derives criterion ids
// from exactly the lines the ledger will extract from the same embedded body.
const INTAKE_LEDGER_LIST_ITEM_RE = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/;
const INTAKE_LEDGER_MARKER_STRIP_RE = /^\s*(?:[-*+]\s+\[[ xX]\]\s*|[-*+]\s+|\d+[.)]\s+)/;
const INTAKE_HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const INTAKE_FENCE_RE = /^(`{3,}|~{3,})/;

const DECOMPOSITION_START_MARKER = "dispatch-groomer:decomposition:start";
const DECOMPOSITION_END_MARKER = "dispatch-groomer:decomposition:end";

const CHILD_PARENT_LINE_RE = /^Parent:[ \t]*(.*)$/;
/** `https://host/owner/repo/issues/N` (or `/pull/N`) — the parentage form the
 * real decomposed children carry (`Parent: https://…/issues/740`). */
const PARENT_URL_REF_RE = /^https?:\/\/[^\s/]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/;

/** The acceptance-criterion texts one forge body yields under the ledger's
 * acceptance headings — the same lines the requirement ledger extracts from
 * this body when embedded (`scanDocument` parity: fences skipped, heading
 * tracked, list items only, marker-stripped, squeezed+truncated via the
 * shared {@link normalizeRequirementText}). Overflow is reported because a
 * body with more criteria than {@link MAX_ATTESTATION_CRITERIA_PER_BODY}
 * cannot be mapped whole. */
function acceptanceCriteriaTexts(body: string): { texts: string[]; overflow: boolean } {
  const texts: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let heading = "";
  for (const raw of pySplitLines(body)) {
    const fence = INTAKE_FENCE_RE.exec(raw.trim());
    if (inFence) {
      if (fence !== null && (fence[1] ?? "").charAt(0) === fenceChar) inFence = false;
      continue;
    }
    if (fence !== null) {
      inFence = true;
      fenceChar = (fence[1] ?? "").charAt(0);
      continue;
    }
    const headingMatch = INTAKE_HEADING_RE.exec(raw);
    if (headingMatch !== null) {
      heading = (headingMatch[1] ?? "").trim().toLowerCase();
      continue;
    }
    if (!INTAKE_ACCEPTANCE_HEADINGS.has(heading)) continue;
    if (!INTAKE_LEDGER_LIST_ITEM_RE.test(raw)) continue;
    const normalized = normalizeRequirementText(raw.replace(INTAKE_LEDGER_MARKER_STRIP_RE, ""));
    if (normalized === null) continue;
    if (texts.length >= MAX_ATTESTATION_CRITERIA_PER_BODY) return { texts, overflow: true };
    texts.push(normalized.text);
  }
  return { texts, overflow: false };
}

/** The child refs one body's DECOMPOSITION sections list — attestation gate
 * (a). The groomer marker regions (`dispatch-groomer:decomposition:start` /
 * `:end`, as the real #740 body carries) are preferred; with no marker
 * region, a bare `## Decomposition` heading section (until the next heading)
 * is trusted. Markers and child refs inside code fences are inert (quoted
 * examples cannot attest). Refs dedupe canonically in order of appearance;
 * an over-count section reports overflow so the caller drops the
 * association whole instead of sampling a prefix. */
function decompositionSectionChildRefs(body: string, ownerRepo: string): { refs: string[]; overflow: boolean } {
  const markerRefs: string[] = [];
  const headingRefs: string[] = [];
  const collect = (line: string, into: string[]): void => {
    for (const ref of childRefsInText(line, ownerRepo)) {
      if (!into.includes(ref)) into.push(ref);
    }
  };
  const overflows = (refs: string[]): boolean => refs.length > MAX_DECOMPOSITION_CHILDREN_PER_ISSUE;
  let inFence = false;
  let fenceChar = "";
  let inMarkerRegion = false;
  let inHeadingSection = false;
  for (const raw of pySplitLines(body)) {
    const fence = INTAKE_FENCE_RE.exec(raw.trim());
    if (inFence) {
      if (fence !== null && (fence[1] ?? "").charAt(0) === fenceChar) inFence = false;
      continue;
    }
    if (fence !== null) {
      inFence = true;
      fenceChar = (fence[1] ?? "").charAt(0);
      continue;
    }
    if (raw.includes(DECOMPOSITION_START_MARKER)) {
      inMarkerRegion = true;
      continue;
    }
    if (inMarkerRegion) {
      if (raw.includes(DECOMPOSITION_END_MARKER)) {
        inMarkerRegion = false;
        continue;
      }
      collect(raw, markerRefs);
      continue;
    }
    const headingMatch = INTAKE_HEADING_RE.exec(raw);
    if (headingMatch !== null) {
      inHeadingSection = (headingMatch[1] ?? "").trim().toLowerCase() === "decomposition";
      continue;
    }
    if (inHeadingSection) collect(raw, headingRefs);
  }
  const refs = markerRefs.length > 0 ? markerRefs : headingRefs;
  return { refs, overflow: overflows(refs) };
}

/** The distinct parents one fetched child body names in its own `Parent:`
 * lines — attestation gate (b). Only exact `Parent:`-prefixed lines outside
 * code fences count (the operator's quoted shape); each value may be a bare
 * `#N` or `owner/repo#N` (resolved against the child's own repository) or an
 * issues/pull URL (the real #1677 form). More than one distinct parent means
 * ambiguous parentage: the caller treats the child as non-attesting. */
function childParentRefs(childBody: string, childRepo: string): string[] {
  const refs: string[] = [];
  let inFence = false;
  let fenceChar = "";
  for (const raw of pySplitLines(childBody)) {
    const fence = INTAKE_FENCE_RE.exec(raw.trim());
    if (inFence) {
      if (fence !== null && (fence[1] ?? "").charAt(0) === fenceChar) inFence = false;
      continue;
    }
    if (fence !== null) {
      inFence = true;
      fenceChar = (fence[1] ?? "").charAt(0);
      continue;
    }
    const match = CHILD_PARENT_LINE_RE.exec(raw.trim());
    if (match === null) continue;
    const value = (match[1] ?? "").trim();
    const lineRefs = childRefsInText(value, childRepo);
    if (lineRefs.length > 0) {
      for (const ref of lineRefs) {
        if (!refs.includes(ref)) refs.push(ref);
      }
      continue;
    }
    const url = PARENT_URL_REF_RE.exec(value);
    if (url !== null) {
      const canonical = canonicalChildRef(`${url[1]}/${url[2]}`, Number.parseInt(url[3] ?? "", 10));
      if (!refs.includes(canonical)) refs.push(canonical);
    }
  }
  return refs;
}

/** One trusted criterion→child association derived from bidirectional
 * attestation. */
interface ChildAttestation {
  requirementId: string;
  /** The full bounded owner set (joint ownership, round 4) — canonical
   * `repo#N` identities in decomposition order, at most
   * MAX_DECOMPOSITION_REFS_PER_CRITERION entries. */
  childRefs: string[];
}

interface CanonicalChild {
  canonical: string;
  repo: string;
  number: number;
}

/** Derive the umbrella's attested criterion→child associations (the
 * orchestrator for gates (a)+(b)+(c)). Returns associations in parent
 * criterion body order; an empty return is the fail-closed reading (no
 * evidence — the criteria stay in scope). */
async function attestedDecompositionAssociations(
  umbrellaBody: string,
  umbrellaRepo: string,
  umbrellaNumber: number,
  fetchIssue: (repo: string, number: string) => Promise<LinkedIssueFetchResult>,
  isForkPr: boolean,
  defaultRepo: string,
): Promise<ChildAttestation[]> {
  // Gate (a): the umbrella's own decomposition section lists the children.
  const section = decompositionSectionChildRefs(umbrellaBody, umbrellaRepo);
  if (section.overflow) return [];
  const children: CanonicalChild[] = [];
  // The umbrella's own canonical identity — what a child's `Parent:` line
  // must resolve to for the attestation to be BIDIRECTIONAL (gate (b)).
  const umbrellaCanonical = canonicalChildRef(umbrellaRepo, umbrellaNumber);
  for (const ref of section.refs) {
    const hash = ref.indexOf("#");
    const repo = ref.slice(0, hash);
    const number = Number.parseInt(ref.slice(hash + 1), 10);
    if (!repo || !Number.isInteger(number)) continue;
    children.push({ canonical: canonicalChildRef(repo, number), repo, number });
  }
  if (children.length === 0) return [];
  // Fork trust boundary (#1617 parity): a refused cross-repo read is an
  // UNREADABLE child — the attestation voids whole rather than proceeding on
  // a partial child set.
  for (const child of children) {
    const ref: LinkedIssueRef = { ref: child.canonical, repo: child.repo, number: child.number, closing: false };
    if (!linkedIssueFetchAllowed(ref, defaultRepo, isForkPr)) return [];
  }
  // The parent criteria the association keys are the ledger's own entries —
  // the same normalized texts (and ids) the ledger will extract from this
  // umbrella's embedded body. An over-count body cannot be mapped whole.
  const parents = acceptanceCriteriaTexts(umbrellaBody);
  if (parents.overflow) return [];
  if (parents.texts.length === 0) return [];
  // Fetch every listed child (bounded); ANY unreadable child voids the
  // umbrella's attestation whole. A readable child that does not attest
  // (missing/wrong parentage, no criteria, no matching criterion) removes
  // only itself.
  interface AttestingChild {
    ref: string;
    criteria: string[];
  }
  const attesting: AttestingChild[] = [];
  for (const child of children) {
    const fetched = await fetchIssue(child.repo, String(child.number));
    if (!fetched.ok) return [];
    if (isPullRequestPayload(fetched.data)) return [];
    let childBody = "";
    try {
      const projected = projectLinkedIssue(fetched.data);
      childBody = typeof projected.body === "string" ? projected.body : "";
    } catch (error) {
      if (error instanceof LinkedIssueProjectionError) return [];
      throw error;
    }
    if (Buffer.byteLength(childBody, "utf8") > MAX_ATTESTED_CHILD_BODY_BYTES) return [];
    const parentRefs = childParentRefs(childBody, child.repo);
    if (parentRefs.length !== 1 || parentRefs[0] !== umbrellaCanonical) continue;
    const childCriteria = acceptanceCriteriaTexts(childBody);
    if (childCriteria.overflow) return [];
    if (childCriteria.texts.length === 0) continue;
    attesting.push({ ref: child.canonical, criteria: childCriteria.texts });
  }
  // Gate (c): the identity edges. Both sides are bounded criterion texts, so
  // the pairwise matcher surface is bounded.
  interface IdentityEdge {
    parent: number;
    child: number;
    criterion: number;
  }
  const edges: IdentityEdge[] = [];
  for (const [parentIndex, parentText] of parents.texts.entries()) {
    for (const [childIndex, child] of attesting.entries()) {
      for (const [criterionIndex, criterionText] of child.criteria.entries()) {
        if (requirementIdentityAttests(parentText, criterionText)) {
          edges.push({ parent: parentIndex, child: childIndex, criterion: criterionIndex });
        }
      }
    }
  }
  if (edges.length === 0) return [];
  // Round 4 (operator follow-up 7025382962): a child criterion that matches
  // SEVERAL parent criteria is a cross-matched identity that cannot be
  // disambiguated deterministically — it attests nothing for either (the
  // fail-closed genuinely-ambiguous shape).
  const parentsPerChildCriterion = new Map<string, Set<number>>();
  for (const edge of edges) {
    const key = `${edge.child}:${edge.criterion}`;
    const seen = parentsPerChildCriterion.get(key);
    if (seen === undefined) parentsPerChildCriterion.set(key, new Set([edge.parent]));
    else seen.add(edge.parent);
  }
  // A parent criterion attested by MULTIPLE children that each independently
  // pass every gate is JOINT OWNERSHIP, not ambiguity: the association
  // carries the full owner set (decomposition order), within the existing
  // 4-ref childRefs contract the consumer already unions. An owner set over
  // the bound drops the association WHOLE — never truncated (a truncated
  // owner list could silently lose the very child the PR references, the
  // unsafe direction).
  const ownersByParent = new Map<number, string[]>();
  for (const edge of edges) {
    if ((parentsPerChildCriterion.get(`${edge.child}:${edge.criterion}`)?.size ?? 0) !== 1) continue;
    const childRef = attesting[edge.child]?.ref ?? "";
    if (childRef === "") continue;
    const owners = ownersByParent.get(edge.parent);
    if (owners === undefined) ownersByParent.set(edge.parent, [childRef]);
    else if (!owners.includes(childRef)) owners.push(childRef);
  }
  const associations: ChildAttestation[] = [];
  for (const [parentIndex, owners] of [...ownersByParent.entries()].sort((a, b) => a[0] - b[0])) {
    if (owners.length === 0 || owners.length > MAX_DECOMPOSITION_REFS_PER_CRITERION) continue;
    const parentText = parents.texts[parentIndex];
    if (parentText === undefined) continue;
    associations.push({ requirementId: requirementIdOfText(parentText), childRefs: [...owners] });
  }
  return associations.filter((association) => association.childRefs.length > 0);
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
      // #1750 round 3: plus the child-attestation channel for the organic
      // umbrella shape (flat decomposition list + a parent-naming child) —
      // see attestedDecompositionAssociations. The inline channel renders
      // first: a criterion both channels associate keeps the DIRECT
      // parent-body evidence (the ledger keeps the first line per id). The
      // combined output never exceeds the ledger's per-document line budget,
      // so nothing rendered goes unparsed.
      const decompositionLines: string[] = [];
      const seenDecompositionIds = new Set<string>();
      const addDecompositionLine = (line: string): void => {
        const parsed = parseDecompositionLine(line);
        if (parsed === null || seenDecompositionIds.has(parsed.requirementId)) return;
        if (decompositionLines.length >= MAX_DECOMPOSITION_LINES_PER_ISSUE) return;
        seenDecompositionIds.add(parsed.requirementId);
        decompositionLines.push(line);
      };
      for (const line of bodyDecompositionLines(typeof filtered.body === "string" ? filtered.body : "", item.repo)) {
        addDecompositionLine(line);
      }
      if (!item.closing && hasUmbrellaLabel(filtered.labels)) {
        const attested = await attestedDecompositionAssociations(
          typeof filtered.body === "string" ? filtered.body : "",
          item.repo,
          item.number,
          (repo, number) => input.adapter.getIssue(repo, String(number)),
          isForkPr,
          input.repo,
        );
        for (const association of attested) {
          addDecompositionLine(renderDecompositionLine(association.requirementId, association.childRefs));
        }
      }
      for (const line of decompositionLines) {
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
