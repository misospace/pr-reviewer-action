/** Linked-issue reference extraction (#674) — TS port of
 * `pr_reviewer/github_context.extract_linked_issue_refs`, extended (#872) to
 * also recognize the issue a PR implements when the closing-keyword
 * convention isn't used: a trailing `(#N)` / `(owner/repo#N)` on the PR
 * TITLE (the conventional-commit / squash-merge title convention), and
 * explicit non-closing body references — contract-bearing `Implements`/
 * `Part of`/`Addresses #N`, plus the plain-reference `Refs`/`Ref #N` form,
 * which is context-only (#1749 follow-up). */

export interface LinkedIssueRef {
  ref: string;
  repo: string;
  number: number;
  /** True for GitHub's own auto-close keyword forms: the present/imperative
   * `Closes`/`Fixes`/`Resolves` anywhere, and the past-participle
   * `Closed`/`Fixed`/`Resolved` at a line start (#953). False for the title's
   * `(#N)` convention and for non-closing body references
   * (`Implements`/`Part of`/`Addresses`, and the context-only `Refs`/`Ref`
   * form) — none of them may be treated as "this PR closes that issue". */
  closing: boolean;
  /** #1749 follow-up: the plain-reference relationship. True ONLY when every
   * form the PR used to name this issue was a bare `Refs`/`Ref` body link —
   * valid PR syntax for "related context", and GitHub itself gives it no
   * development-link meaning. Such an issue is still fetched and embedded as
   * review context (and hashed into the selection signature), but its
   * acceptance criteria are NOT this PR's merge contract, so the requirement
   * ledger skips its body entirely. Any stronger form for the same canonical
   * identity — a closing keyword, `Implements`/`Part of`/`Addresses`, or the
   * title's `(#N)` convention — clears the flag in the dedupe merge (the
   * relationship is the STRONGEST claim the PR made, never the first one);
   * absent/false means an ordinary implementation link whose criteria stay
   * contract candidates under the existing (#1749/#1750) umbrella rules. */
  contextOnly?: boolean;
}

export const MAX_LINKED_ISSUES = 8;

/** #1749: the deterministic relationship line `buildLinkedIssueContext`
 * renders into `linked-issues.md` directly under each ACCEPTED issue's
 * heading, recording the reference shape the PR itself used (the
 * {@link LinkedIssueRef.closing} classification). `linked-issues.md` is the
 * requirement ledger's only channel to the linked-issue metadata, and the
 * ledger previously reduced each issue to `{ref, body}` — discarding the
 * one signal that distinguishes an issue the PR claims to close (whose
 * acceptance criteria stay mandatory) from a non-closing parent/umbrella/
 * context link (whose acceptance set is not automatically this PR's merge
 * contract). The lines are exact-match constants: the heading and the
 * metadata line are intake-authored (issue content only ever appears inside
 * the JSON fence), so the ledger parser can trust an exact match outside a
 * fence and nothing else. */
export const LINKED_AS_CLOSING_LINE = "(linked as: closing reference)";
export const LINKED_AS_NON_CLOSING_LINE = "(linked as: non-closing reference)";

/** #1749 follow-up: the third relationship state — a link the PR used ONLY in
 * the plain-reference form (`Refs`/`Ref #N`). It renders instead of
 * {@link LINKED_AS_NON_CLOSING_LINE} so the ledger can tell an implementation
 * link (`Implements`/`Part of`/`Addresses`, or the title `(#N)` — whose
 * acceptance criteria are contract candidates) from a context reference whose
 * referenced issue must stay pure background: fetched, fenced into
 * `linked-issues.md`, hashed into the selection signature, but NEVER a source
 * of requirement-ledger entries. The line is intake-authored and exact-matched
 * outside the fence like the other two; a document without it keeps the
 * legacy contract-carrying reading (fail closed — an unknown relationship is
 * never silently demoted to context). */
export const LINKED_AS_CONTEXT_LINE = "(linked as: context reference)";

// ---------------------------------------------------------------------------
// #1750: trusted criterion→child ownership evidence (the umbrella
// decomposition channel)
//
// The umbrella-parent scope narrowing may treat an acceptance criterion as
// not-this-increment's-merge-contract ONLY when trusted deterministic
// evidence shows the SPECIFIC criterion is owned by separately decomposed
// child work. The trusted channel is the linked umbrella's OWN body: its
// task-list decomposition structure — task-list items referencing child
// issues, inline in the criterion item or on list items nested under it —
// which is forge metadata fetched at intake, never PR-authored prose. Intake
// parses that structure conservatively and renders ONE exact-structure
// metadata line per associated criterion:
//
//     (decomposition: req-<content id> -> o/r#101, o/r#102)
//
// The `<content id>` is the requirement ledger's own content-derived id
// (src/requirements/requirement-id.ts), so issue content never appears
// outside the JSON fence in `linked-issues.md` — the exact-match trust model
// for metadata lines is preserved — and a decomposition line can only ever
// affect the ledger entry whose id it names. Everything here is a pure leaf
// (no imports): the context stage renders the lines, the requirement ledger
// parses them into provenance, and the trace scope consumes the provenance.
// Every bound fails closed: a malformed or over-count association renders no
// line and parses to nothing, and the scope predicate treats a missing
// association as "criterion stays in scope" — never as ownership.
// ---------------------------------------------------------------------------

/** At most 16 association lines per linked issue (the ledger's per-document
 * association budget matches). Over-count criteria render no line — an
 * association that cannot be carried is never approximated. */
export const MAX_DECOMPOSITION_LINES_PER_ISSUE = 16;

/** At most 4 owning child refs per criterion. An item naming more children
 * than this renders no line at all: a truncated owner list could silently
 * drop the very child the PR references, which is the unsafe direction. */
export const MAX_DECOMPOSITION_REFS_PER_CRITERION = 4;

/** A canonical child identity: bare same-repo `#N` refs are resolved against
 * the linked issue's own repo at intake, so everything crossing the seam is
 * an explicit, casefolded `repo#N`. */
export const CANONICAL_CHILD_REF_PATTERN = /^(?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#[0-9]+$/;

export function canonicalChildRef(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`;
}

/** Issue references inside one line of text, as canonical `repo#N`
 * identities: explicit `owner/repo#N` keeps its repo (casefolded); a bare
 * `#N` is resolved against `ownerRepo` (the linked issue's own repository —
 * a bare ref inside an issue body refers to that issue's repo, not the
 * reviewed repo). Word- or slash-attached tokens (`xfoor#1`, `a/b/c#12`) are
 * deliberately not matched, and URL tails (`…/issues/1677`) carry no `#` and
 * never match. Deduplicated in order of appearance. */
export function childRefsInText(text: string, ownerRepo: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?<![\w/])((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)(?!\w)/g)) {
    const token = match[1] ?? "";
    const hash = token.indexOf("#");
    const repo = token.includes("/") ? token.slice(0, hash) : ownerRepo;
    const number = token.slice(hash + 1);
    if (!repo || !/^\d+$/.test(number)) continue;
    const canonical = canonicalChildRef(repo, Number.parseInt(number, 10));
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    refs.push(canonical);
  }
  return refs;
}

/** Render the exact-structure metadata line. Intake renders at most one line
 * per associated criterion, in body order. */
export function renderDecompositionLine(requirementId: string, childRefs: readonly string[]): string {
  return `(decomposition: ${requirementId} -> ${childRefs.join(", ")})`;
}

const DECOMPOSITION_LINE_RE = /^\(decomposition: (req-[0-9a-f]{12}) -> (.+)\)$/;

/** Parse one metadata line. Strict: the id must be a well-formed content id,
 * every child ref must already be canonical, and the ref count must be within
 * bounds — anything else parses to `null` and the association does not exist
 * (fail closed). Repeated ids for the same criterion never occur in honest
 * intake output; the ledger keeps only the FIRST line per id, so a repeated
 * line can neither merge nor replace an association. */
export function parseDecompositionLine(line: string): { requirementId: string; childRefs: string[] } | null {
  const match = DECOMPOSITION_LINE_RE.exec(line.trim());
  if (match === null) return null;
  const childRefs: string[] = [];
  const seen = new Set<string>();
  for (const token of (match[2] ?? "").split(", ")) {
    if (!CANONICAL_CHILD_REF_PATTERN.test(token)) return null;
    if (seen.has(token)) continue;
    seen.add(token);
    childRefs.push(token);
  }
  if (childRefs.length === 0 || childRefs.length > MAX_DECOMPOSITION_REFS_PER_CRITERION) return null;
  return { requirementId: match[1] ?? "", childRefs };
}

/** Re-bound a `childRefs` list crossing the deserialization boundary (the
 * persisted ledger artifact is untrusted data). Non-string or non-canonical
 * entries are dropped; an over-count list drops WHOLLY — truncating to the
 * first N would silently lose real owners, and a lost owner can only make the
 * scope predicate miss a PR reference to the owning child (the unsafe
 * direction). `undefined` when nothing trustworthy survives, so the field
 * stays absent rather than empty. */
export function boundedChildRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !CANONICAL_CHILD_REF_PATTERN.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    refs.push(item);
  }
  if (refs.length === 0 || refs.length > MAX_DECOMPOSITION_REFS_PER_CRITERION) return undefined;
  return refs;
}

/** Hard safety bound on the CANDIDATE LIST intake may fetch (#872
 * follow-up): the accepted-issue cap (`MAX_LINKED_ISSUES`) is enforced
 * downstream, over issues that actually get fetched and accepted (see
 * `buildLinkedIssueContext`), not over raw refs — a title `(#N)` that turns
 * out to name a pull request must not evict a real 8th body issue.
 * `extractLinkedIssueRefs` merges the full title+body first and allocates
 * this capacity contract-first (context-only `Refs` links only use what is
 * left), so this bound can never starve or demote a contract-bearing ref. */
export const MAX_LINKED_ISSUE_CANDIDATES = MAX_LINKED_ISSUES * 4;

// ---------------------------------------------------------------------------
// #1750 round 3 (operator follow-up): the child-attestation ownership channel
// (pure leaves — no imports)
//
// cbdb6287's decomposition channel associates a criterion with child work
// only when the criterion's OWN task-list item carries (inline or nested)
// child refs. The organic Dispatch umbrella shape cannot produce that: its
// acceptance criteria carry no refs, and its decomposition is a flat,
// separate list. The next trustworthy seam is the DECOMPOSED CHILD ISSUES
// themselves — forge-backed, fetched with the deployment's own read
// credential at intake. The association fires only when ALL of:
//
//   (a) the umbrella's own body lists the child in a decomposition section;
//   (b) the fetched child's own body names that parent (its `Parent:` line,
//       resolved to the umbrella's canonical `repo#N` identity);
//   (c) the child's own acceptance criterion carries the parent criterion's
//       requirement identity — a shared contiguous run of substantial tokens
//       (`requirementIdentityAttests`, calibrated on the real
//       #740/#1677 bodies).
//
// One attested criterion renders ONE `(decomposition: …)` line — the exact
// seam cbdb6287 built, so the ledger provenance parse and the scope
// predicate consume it unchanged (the fail-closed consumer conjunction
// stays). Round 4 (operator follow-up 7025382962): MULTIPLE children
// independently passing every gate for the same parent criterion is JOINT
// OWNERSHIP, not ambiguity — the line carries the full bounded owner set
// (`(decomposition: req-… -> repo#1677, repo#1678)`), which fits the
// existing `childRefs` contract ({@link MAX_DECOMPOSITION_REFS_PER_CRITERION}
// refs per line) and the consumer's own union semantics (a parent criterion
// stays mandatory when the PR references ANY owning child). The genuinely
// ambiguous shapes stay fail closed: a child criterion attesting several
// parent criteria (a cross-matched identity attests nothing), an owner set
// over the bound (dropped whole — never truncated), an unreadable child
// (fetch failure, pull-request payload, over-size body, refused cross-repo
// read on a fork voids the umbrella's attestation WHOLE, because a partial
// child set could hide a second attesting child), one-sided
// parentage/decomposition, and malformed evidence. Everything here is
// deterministic: no model prose and no PR prose participates in ownership,
// and every bound that cannot be carried whole drops the association, never
// approximates it.
// ---------------------------------------------------------------------------

/** At most 8 decomposition children are fetched per umbrella issue (the same
 * budget class as {@link MAX_LINKED_ISSUES}). A decomposition section listing
 * more distinct children than this cannot be carried whole — the umbrella's
 * attestation drops entirely rather than sampling a prefix that could hide
 * the one child that matters. */
export const MAX_DECOMPOSITION_CHILDREN_PER_ISSUE = 8;

/** A fetched child's projected (credential-redacted) body is admitted to
 * attestation only when it fits this many UTF-8 bytes. This is a
 * hostile-input bound, NOT the v2 embed cut (12000): the real decomposed
 * children must be admissible — measured real bodies are #1677 at 5808 and
 * #1678 at 12314 bytes — so the organic #740/#1677/#1678 shape can attest in
 * the wild. An over-size body is still a FAILURE, not a truncation: reading
 * only a prefix could miss a second attesting criterion and turn a jointly-
 * owned criterion into a false smaller owner set. */
export const MAX_ATTESTED_CHILD_BODY_BYTES = 65536;

/** At most 32 acceptance-criterion texts are extracted per body for
 * attestation (real umbrellas and children carry a handful; the ledger's
 * own rendered-line budget is 16). More criteria than this cannot be mapped
 * whole → the attestation drops. */
export const MAX_ATTESTATION_CRITERIA_PER_BODY = 32;

/** The requirement-identity bar: a child criterion attests a parent criterion
 * only when the child's token sequence contains a contiguous run of at least
 * this many of the parent's tokens. Calibrated on the real bodies: the only
 * run long enough in the organic #740/#1677 pair is the requirement-bearing
 * phrase `same scheduler engine` ("…enter the same scheduler/engine as…");
 * everything shorter — a domain word (`engine`), a bigram (`capability
 * differences`) — is shared vocabulary, not requirement identity, and stays
 * below the bar (those criteria remain in scope, fail closed). */
export const MIN_REQUIREMENT_IDENTITY_RUN = 3;

/** A token is substantial (identity-bearing) only at this many characters:
 * a crude closed-class filter that drops articles and short function words
 * (`the`, `and`, `in`, `no`) so generic stopword runs (`in the review
 * engine`) can never satisfy the identity bar. Calibrated: with stopword
 * runs allowed, the real #740 `Requirements` bullet "no forge-specific
 * behavior in the review engine" would ride the 4-token stopword phrase
 * `in the review engine` onto the children's boilerplate criterion; with
 * this filter the same pair tops out at a 2-token run and stays unassociated. */
export const MIN_REQUIREMENT_IDENTITY_TOKEN_CHARS = 4;

/** RFC-2119-style normative modals are boilerplate, never requirement
 * identity: they appear in nearly every acceptance criterion, so two
 * unrelated criteria that happen to start `The review engine MUST …` would
 * otherwise share the run `review engine must` and falsely attest ownership
 * (the subject phrase, not the modal, is the identity). Excluding the modals
 * rather than the whole phrase keeps the surrounding content words eligible:
 * the real #740/#1677 `same scheduler engine` run is untouched. `not` is
 * already below the character bar, so `MUST NOT` contributes nothing once
 * the modals are dropped. Substantive adjectives such as `required`
 * (`required checks`) are deliberately NOT here. */
const NORMATIVE_BOILERPLATE_TOKENS: ReadonlySet<string> = new Set([
  "must",
  "shall",
  "should",
  "may",
  "might",
  "will",
  "would",
  "can",
  "could",
  "cannot",
]);

/** Casefolded substantial tokens of one requirement text: alphanumeric runs
 * of at least {@link MIN_REQUIREMENT_IDENTITY_TOKEN_CHARS} characters, minus
 * the normative boilerplate in {@link NORMATIVE_BOILERPLATE_TOKENS}. */
export function requirementIdentityTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length >= MIN_REQUIREMENT_IDENTITY_TOKEN_CHARS && !NORMATIVE_BOILERPLATE_TOKENS.has(token));
}

/** The longest contiguous token run the two sequences share, by dynamic
 * programming (O(P×C) cells; both inputs are normalized+truncated criterion
 * texts upstream, so the quadratic surface is bounded). */
export function requirementIdentityRun(parentTokens: readonly string[], childTokens: readonly string[]): number {
  let best = 0;
  let previous = new Uint32Array(childTokens.length + 1);
  for (let i = 1; i <= parentTokens.length; i += 1) {
    const current = new Uint32Array(childTokens.length + 1);
    const parentToken = parentTokens[i - 1];
    for (let j = 1; j <= childTokens.length; j += 1) {
      if (parentToken !== undefined && parentToken === childTokens[j - 1]) {
        const extended = (previous[j - 1] ?? 0) + 1;
        current[j] = extended;
        if (extended > best) best = extended;
      }
    }
    previous = current;
  }
  return best;
}

/** The deterministic requirement-identity test of attestation gate (c):
 * does the child criterion carry the parent criterion's requirement — a
 * shared contiguous run of ≥ {@link MIN_REQUIREMENT_IDENTITY_RUN}
 * substantial tokens? Normative boilerplate (`MUST`/`SHALL`/`MUST NOT` and
 * the rest of {@link NORMATIVE_BOILERPLATE_TOKENS}) never counts, so two
 * unrelated criteria sharing a subject and a modal (`The review engine MUST
 * …`) do not attest. Verbatim-equal criteria (the ledger content-id recipe
 * case) trivially fire; the real #1677/#740 texts differ and fire on the
 * `same scheduler engine` phrase; unrelated criteria sharing only scattered
 * domain vocabulary stay below the bar. */
export function requirementIdentityAttests(parentText: string, childText: string): boolean {
  const parentTokens = requirementIdentityTokens(parentText);
  if (parentTokens.length < MIN_REQUIREMENT_IDENTITY_RUN) return false;
  const childTokens = requirementIdentityTokens(childText);
  if (childTokens.length < MIN_REQUIREMENT_IDENTITY_RUN) return false;
  return requirementIdentityRun(parentTokens, childTokens) >= MIN_REQUIREMENT_IDENTITY_RUN;
}

/** Closing-keyword body references. The present/imperative forms
 * (`close`/`closes`, `fix`/`fixes`, `resolve`/`resolves`) match anywhere, as
 * GitHub's parser does. The past participles (`closed`/`fixed`/`resolved`)
 * are ambiguous — they double as adjectives in ordinary prose ("the removed
 * URLs covered by closed #479") — so they only count as closing when they
 * start a line, after optional indentation and a markdown list/blockquote
 * marker ("Fixed #42", "- Fixed #42", "* Resolved owner/repo#42"). #953. */
const GITHUB_ISSUE_REF_PATTERN = /(?:\b(?:close|closes|fix|fixes|resolve|resolves)|(?:^|\n)[ \t]*(?:[-*+>]|\d+[.)])?[ \t]*(?:closed|fixed|resolved))\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

/** Non-closing body references: the contract-bearing
 * `Implements`/`Part of`/`Addresses #N` forms plus the plain-reference
 * `Refs`/`Ref #N` form. Deliberately excludes incidental mentions
 * ("depends on #583", bare "#12" in prose) and "Related to #N" (ambiguous
 * between an implementation reference and an incidental mention; left
 * unlinked). The keyword itself is captured (group 1) so a bare `Refs`/`Ref`
 * link can be classified as the plain-reference relationship
 * ({@link CONTEXT_REF_KEYWORD_RE}) WITHOUT changing the single-pass match
 * order the candidate list depends on. */
const IMPLEMENTATION_ISSUE_REF_PATTERN = /\b(implements|part of|refs?|addresses)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

/** The keyword vocabulary of the plain-reference relationship (#1749
 * follow-up): `Refs #N`/`Ref #N` names related context, never an
 * implementation claim — the referenced issue's acceptance criteria are not
 * this PR's merge contract. `Implements`/`Part of`/`Addresses` remain
 * implementation links. */
const CONTEXT_REF_KEYWORD_RE = /^refs?$/i;

/** A trailing `(#N)` / `(owner/repo#N)` at the very end of the PR title —
 * the conventional-commit / squash-merge title convention. Not anchored
 * mid-title, so `fix bug (#123) more text` does not match. */
const TITLE_TRAILING_ISSUE_REF_PATTERN = /\(((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)\)[ \t]*$/;

/** Extract linked-issue references from a PR title and body, deduplicated
 * by CANONICAL IDENTITY in order of appearance (hard bound
 * `MAX_LINKED_ISSUE_CANDIDATES`; see its docstring for why this isn't the
 * accepted-issue cap): first the title's trailing `(#N)` convention, then
 * closing-keyword body references, then non-closing body references
 * (contract-bearing `Implements`/`Part of`/`Addresses`, then context-only
 * `Refs`/`Ref`). A bare `#N` resolves against the default repo, so a bare
 * `#584` and an explicit `owner/repo#584` naming the same repo (compared
 * case-insensitively) are the SAME identity, not two entries.
 * Dedupe is a merge, not a first-write-wins: if an identity first appears in
 * a non-closing form and a later occurrence is a closing-keyword form, the
 * existing entry is upgraded to `closing: true` in place — an entry keeps the
 * position and spelling of its first occurrence, and an already-closing entry
 * is never downgraded.
 * #1749 follow-up: the same merge rule governs `contextOnly` — a `Refs`/
 * `Ref`-only identity is context, but ANY stronger occurrence (closing
 * keyword, `Implements`/`Part of`/`Addresses`, title `(#N)`) clears it, and
 * a later `Refs` occurrence never demotes a stronger relationship.
 *
 * The scan is EXHAUSTIVE over the platform-supplied title+body before any
 * capacity decision: `MAX_LINKED_ISSUE_CANDIDATES` bounds the returned
 * candidate list (fetch capacity), never the merge, so a stronger occurrence
 * appearing after any number of `Refs` links still upgrades its identity
 * (position must not decide relationship strength). The returned list then
 * ALLOCATES that capacity contract-first: every contract-bearing ref keeps
 * its first-occurrence slot before any context-only ref is admitted, so no
 * volume of `Refs` context can starve a contract issue out of intake. Both
 * consumers (`buildLinkedIssueContext` and `buildSelectionSignature`) read
 * this one ordered list through the shared `acceptedLinkedIssues` generator,
 * so the two stages cannot disagree about which issues were accepted. */
export function extractLinkedIssueRefs(body: string, defaultRepo?: string, title?: string): LinkedIssueRef[] {
  const repo = defaultRepo ?? "";
  const byKey = new Map<string, LinkedIssueRef>();
  const items: LinkedIssueRef[] = [];

  const add = (ref: string, closing: boolean, contextOnly: boolean): void => {
    let repoName: string;
    let issueNumber: string;
    if (ref.includes("/")) {
      const hashIndex = ref.indexOf("#");
      repoName = ref.slice(0, hashIndex);
      issueNumber = ref.slice(hashIndex + 1);
    } else {
      repoName = repo;
      issueNumber = ref.slice(1);
    }
    const number = Number.parseInt(issueNumber, 10);
    if (Number.isNaN(number)) return;
    const canonicalKey = `${repoName.toLowerCase()}#${number}`;
    const existing = byKey.get(canonicalKey);
    if (existing) {
      if (closing) existing.closing = true;
      if (!contextOnly) existing.contextOnly = false;
      return;
    }
    const item: LinkedIssueRef = { ref, repo: repoName, number, closing, ...(contextOnly ? { contextOnly: true } : {}) };
    byKey.set(canonicalKey, item);
    items.push(item);
  };

  const titleMatch = TITLE_TRAILING_ISSUE_REF_PATTERN.exec((title ?? "").trim());
  if (titleMatch) add(titleMatch[1] ?? "", false, false);

  for (const match of (body ?? "").matchAll(GITHUB_ISSUE_REF_PATTERN)) {
    add(match[1] ?? "", true, false);
  }
  for (const match of (body ?? "").matchAll(IMPLEMENTATION_ISSUE_REF_PATTERN)) {
    add(match[2] ?? "", false, CONTEXT_REF_KEYWORD_RE.test(match[1] ?? ""));
  }

  // Capacity allocation happens AFTER the full merge (see the doc comment):
  // contract-bearing refs first in first-occurrence order, then context-only
  // refs in first-occurrence order, bounded by the candidate cap. Only this
  // slice is bounded; the scan above is not, so a late `Implements`/`Closes`
  // occurrence always wins over earlier context links.
  const contract = items.filter((item) => item.contextOnly !== true);
  const context = items.filter((item) => item.contextOnly === true);
  return [...contract, ...context].slice(0, MAX_LINKED_ISSUE_CANDIDATES);
}

// ---------------------------------------------------------------------------
// #1750 (operator correction, PR #1750 review): the PR's CONTRACT issue
// references feeding the umbrella-parent owning-child veto (pure leaf — no
// imports).
//
// The veto voids trusted child-ownership evidence when the PR itself
// implements an owning child, so the reference set carries ONLY the
// recognized deterministic relationship forms — the SAME grammar
// `extractLinkedIssueRefs` implements: closing keywords, the
// `Implements`/`Part of`/`Addresses` implementation links, and the title
// `(#N)` convention. The plain `Refs`/`Ref` link is EXCLUDED through the
// #1749-follow-up `contextOnly` classification: it names related context,
// never an implementation claim. Incidental bare `#N` prose mentions and
// forge issue URLs are excluded too — merely DISCUSSING an owning child
// must not force the parent's criterion back into scope; the round-5
// reference-form-agnostic union (`prIssueReferenceIdentities`,
// `issueUrlRefsInText`, `ISSUE_URL_REF_RE`, `MAX_TRACE_PR_ISSUE_REFS`) did
// exactly that and is removed by this correction. No model or PR prose
// participates, and the grammar never over-matches: an unlinked mention is
// not a relationship claim.
//
// PR review follow-up: the veto must NOT inherit intake's
// `MAX_LINKED_ISSUE_CANDIDATES` fetch budget. That cap bounds how many
// issues intake will FETCH, and plain `Refs` context links occupy its
// candidate slots even though this set filters them out again. The veto
// fetches nothing, so inheriting the cap was fail-open: 32 distinct
// `Refs` links filled the candidate list and a following
// `Implements <owning child>` was cut off before it was ever seen,
// silently hiding the very veto that must fire. The scan below is
// therefore its own, bounded only by the platform-supplied title+body
// input, over the same recognized grammar; intake's fetch cap is
// untouched.
// ---------------------------------------------------------------------------

/** Recognized CONTRACT implementation-link grammar: the
 * {@link IMPLEMENTATION_ISSUE_REF_PATTERN} token and separator shape
 * restricted to the implementation keywords, with plain `Refs`/`Ref`
 * excluded at the pattern level rather than by post-filtering — a context
 * link must never occupy budget a contract claim needs. */
const CONTRACT_IMPLEMENTATION_ISSUE_REF_PATTERN = /\b(?:implements|part of|addresses)\s*:?[ \t]+((?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+)/gi;

/** Canonical casefolded `repo#N` identity of one extracted reference
 * token — bare `#N` resolved against `defaultRepo`, exactly like
 * {@link extractLinkedIssueRefs}'s dedupe key — or `undefined` when the
 * token carries no parseable issue number. */
function canonicalContractRefIdentity(token: string, defaultRepo: string): string | undefined {
  let repoName: string;
  let issueNumber: string;
  if (token.includes("/")) {
    const hashIndex = token.indexOf("#");
    repoName = token.slice(0, hashIndex);
    issueNumber = token.slice(hashIndex + 1);
  } else {
    repoName = defaultRepo;
    issueNumber = token.slice(1);
  }
  const number = Number.parseInt(issueNumber, 10);
  if (Number.isNaN(number)) return undefined;
  return canonicalChildRef(repoName, number);
}

/** The issues whose acceptance criteria this PR contracted to implement —
 * canonical casefolded `repo#N` identities in first-appearance order: the
 * title `(#N)` convention, closing keywords, then the `Implements`/
 * `Part of`/`Addresses` implementation links. Plain `Refs`/`Ref` context
 * links match no contract grammar here at all — in either order, so a
 * mixed `Refs` + `Implements` PR counts the stronger claim exactly once —
 * and the scan is exhaustive over the input: no volume of context links
 * can evict a contract claim (see the header note above for why intake's
 * `MAX_LINKED_ISSUE_CANDIDATES` fetch budget must not apply). Consumed by
 * the #1750 umbrella-parent veto in `requirementTraceScope`
 * (`prLinkedRefs`). */
export function prContractIssueRefIdentities(title: string, body: string, repo: string): string[] {
  const identities: string[] = [];
  const seen = new Set<string>();
  const add = (token: string): void => {
    const identity = canonicalContractRefIdentity(token, repo);
    if (identity === undefined || seen.has(identity)) return;
    seen.add(identity);
    identities.push(identity);
  };

  const titleMatch = TITLE_TRAILING_ISSUE_REF_PATTERN.exec((title ?? "").trim());
  if (titleMatch) add(titleMatch[1] ?? "");

  const text = body ?? "";
  for (const match of text.matchAll(GITHUB_ISSUE_REF_PATTERN)) add(match[1] ?? "");
  for (const match of text.matchAll(CONTRACT_IMPLEMENTATION_ISSUE_REF_PATTERN)) add(match[1] ?? "");
  return identities;
}

/** #1617: the fork trust boundary for linked-issue FETCHES, applied BEFORE
 * any privileged fetch. On a fork PR the body and title are fully
 * attacker-authored, while the fetch runs with the operator's forge
 * credential: an explicit `owner/repo#N` reference could point that
 * privileged read at any repository the operator can see and the
 * contributor cannot (a private planning repository whose contents the
 * review would then carry). Cross-repository refs are therefore refused by
 * rule, deterministically and model-free, no matter what credential the
 * deployment runs on — the boundary must not depend on the credential
 * happening to be scoped.
 *
 * Same-repository refs are untouched: a bare `#N` (resolved against the
 * reviewed repository) or an explicit spelling of it — compared
 * case-insensitively, the same identity the dedupe above uses — keeps
 * working, because that repository is the one under review. Fail-closed by
 * construction: callers pass fork state from `deriveIsFork` / the precheck
 * fork flag, whose own convention is that uncertainty counts as fork.
 *
 * BOTH linked-issue fetch sites (`buildLinkedIssueContext` and
 * `buildSelectionSignature`) MUST apply this identical filter, exactly as
 * they share `acceptedLinkedIssues` (#872): a ref fetched in one stage and
 * not the other re-opens the fingerprint-divergence class that fix closed. */
export function linkedIssueFetchAllowed(ref: LinkedIssueRef, defaultRepo: string, isForkPr: boolean): boolean {
  if (!isForkPr) return true;
  return ref.repo.toLowerCase() === defaultRepo.toLowerCase();
}

/** True when a fetched GitHub/Forgejo "issue" payload is actually a pull
 * request (#872): both platforms' issue-fetch APIs return PRs through the
 * same endpoint, distinguished only by a `pull_request` object on the raw
 * payload (GitHub natively; Forgejo's normalized shape passes it through —
 * see `normalizeForgejoIssue`). A trailing `(#N)` on a squash-merge or
 * automation-authored title very often names the PR that produced it, not
 * an issue, and that PR's own content must never masquerade as issue
 * guidance — in `linked-issues.md` / the requirement ledger, or in the
 * #633 selection fingerprint. */
export function isPullRequestPayload(data: unknown): boolean {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    && (data as Record<string, unknown>).pull_request != null;
}

export type LinkedIssueFetchResult = { ok: true; data: unknown } | { ok: false; error: string };

export type LinkedIssueOutcome =
  | { kind: "accepted"; ref: LinkedIssueRef; data: unknown }
  | { kind: "pull_request_skip"; ref: LinkedIssueRef }
  | { kind: "fetch_failed"; ref: LinkedIssueRef; error: string };

/** Shared accepted-issue iteration (#872 cross-stage fix): `buildLinkedIssueContext`
 * (src/context/linked-issue-context.ts) and `buildSelectionSignature`
 * (src/precheck/selection.ts) MUST apply identical accepted-issue semantics
 * over the same candidate list, or their two views of "the linked issues"
 * can diverge — a title ref that resolves to a pull request must not
 * consume one of the `cap` slots in either place, or a body issue evicted
 * from one stage but not the other lets a label change perturb one signal
 * (classification) without perturbing the other (the stale-review
 * fingerprint), or vice versa, silently letting precheck skip a review that
 * should have re-run.
 *
 * Iterates `refItems` (the candidate list from `extractLinkedIssueRefs`,
 * bounded by `MAX_LINKED_ISSUE_CANDIDATES`) in the ORDER extraction returned
 * it — contract-bearing refs first, context-only refs after (see
 * `extractLinkedIssueRefs`): the shared ordering is what keeps a `Refs`
 * context link from consuming a slot a contract issue needs, and because
 * both stages iterate the same list, they cannot disagree about which
 * issues were accepted. `fetchIssue` is called for each ref until `cap`
 * issues have been ACCEPTED — successfully fetched and, for a non-closing
 * ref, not a pull-request payload. A pull-request payload on a non-closing ref is a
 * skip: it consumes a fetch (so its content is known), never a slot.
 * Closing-keyword refs are never rejected as pull requests (parity with
 * pre-#872 fetch behavior). This generator makes no fail-open/fail-closed
 * decision on a fetch failure — that is the caller's call: one stage may
 * continue past a failure (recording it) while another aborts entirely on
 * the first one. Because refs beyond `cap` accepted issues are never
 * reached, stopping consumption of the generator early (e.g. via `return`
 * from a `for await` loop) never triggers any further fetches. */
export async function* acceptedLinkedIssues(
  refItems: readonly LinkedIssueRef[],
  fetchIssue: (repo: string, number: number) => Promise<LinkedIssueFetchResult>,
  cap: number = MAX_LINKED_ISSUES,
): AsyncGenerator<LinkedIssueOutcome, void, void> {
  let accepted = 0;
  for (const ref of refItems) {
    if (accepted >= cap) return;
    const fetched = await fetchIssue(ref.repo, ref.number);
    if (fetched.ok && !ref.closing && isPullRequestPayload(fetched.data)) {
      yield { kind: "pull_request_skip", ref };
    } else if (fetched.ok) {
      accepted += 1;
      yield { kind: "accepted", ref, data: fetched.data };
    } else {
      yield { kind: "fetch_failed", ref, error: fetched.error };
    }
  }
}

/** Label names from an issue object (GitHub REST shape); empty when
 * unusable. */
export function labelsOf(issue: unknown): string[] {
  if (typeof issue !== "object" || issue === null) return [];
  const labels = (issue as Record<string, unknown>).labels;
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    const name = typeof label === "object" && label !== null
      ? (label as Record<string, unknown>).name
      : label;
    if (typeof name === "string" && name.trim()) names.push(name.trim());
  }
  return names;
}
