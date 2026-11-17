/**
 * Review-thread enforcement (#680 port of
 * `pr_reviewer/enforcement.py::apply_review_thread_enforcement`, carrying
 * #766 and the #770 context/enforcement contract).
 *
 * Every unresolved review thread the corpus listed is settled against the
 * model's dispositions. #1663 splits two questions that were previously one:
 * the forge proves whether a thread is live (the #1645 reconciliation), and
 * the current-head review must still establish whether its finding is valid.
 *
 * Authorship comes from forge metadata, never from comment bodies
 * (`ThreadAuthorship` in `src/context/review-threads.ts`): `action` (the
 * forge reports an AUTOMATION author whose login is this run's identity),
 * `other_bot` (a forge-reported automation author under a different login —
 * a rotated publisher stays a bot finding), `human` (a forge-reported
 * `User` account carrying no action publication metadata), and `unproven`
 * (everything else). Account identity is not comment provenance: a matching
 * login under a shared PAT never grants dismissal authority over a human's
 * comment, and a historical finding the action published under a human
 * account's PAT never silently becomes a human minor — a marker on a
 * human-typed (or untyped) account is AMBIGUOUS provenance, settled as the
 * material unknown, never as a confident classification in either direction.
 *
 * A live historical bot finding (`action` or `other_bot`) re-emits at its
 * original severity only on a SUPPORTED re-affirmation: `open` plus what the
 * review checked that still shows the defect. A code-citing `fixed` or a
 * reasoned `disputed` (the old finding was originally invalid) settles it
 * without re-emission. An omitted disposition, an evidence-free `open`, or an
 * unsupported claim withholds the old severity and records a MATERIAL
 * `unverified_blocking_claim` through `thread_reconciliation.unreassessed`
 * (INCOMPLETE/COMMENT) — so a ghost blocker cannot block and an unevaluated
 * concern cannot certify a clean approval. An `unproven` root is conservative
 * in both directions: no bot disposition closes it, and its severity is never
 * re-emitted. A `human` thread is closed on GitHub only by the forge's
 * resolved state (#1663) — the action never mutates a human's conversation —
 * but that physical state is not semantic authority (#1681): a `fixed`
 * whose citation RESOLVES at the exact reviewed head settles the thread's
 * FINDING as addressed (disclosed with its open physical state, not
 * re-emitted, never blocking), while any weaker claim — including a
 * code-citing string whose cited location does not exist at head (#1681
 * r6) — keeps the fail-closed open reading at the human-side non-blocking
 * severity. A bot `fixed` additionally settles on this run's head-bound
 * acquisition of the thread's file when the evidence names no citation
 * candidate (PhAd convergence: one evidence representation across the
 * review's parallel proof channels).
 *
 * Re-emitted findings carry `thread_id` (the publish step skips those inline
 * — the thread already exists) plus `thread_ids` provenance. Duplicate
 * historical threads and a concern a fresh current-head finding already
 * reports are counted once by the existing stable finding identity; distinct
 * defects (different message/category/severity) stay distinct. Under
 * `findings_severity_gated` a re-emitted blocker escalates the verdict like
 * any other blocker; under `strict` (#811) the settlement never forces a
 * verdict — the strict mapping alone derives one from the final still-open
 * findings set.
 *
 * #812: the re-emitted finding carries the thread's ORIGINAL severity —
 * the severity the context stage parsed from the managed finding comment
 * the bot posted (`**Minor (tests):** …` / `**⚠️ Major:** …` /
 * `**🛑 Blocker …**`). A severity that cannot be determined (missing or
 * outside the finding vocabulary) defaults to minor, and re-emission never
 * escalates: Minor/Info-only re-emissions must leave an approve standing.
 */
import { markRelaxationNotesSuperseded, type ArtifactFinding, type ReviewArtifact } from "./artifact.js";
import { isAlwaysNonBlockingCategory, isBlockingSeverity } from "./verdict-policy.js";
import { findingIdentity, findingIdentityFromRecord } from "../outcomes/identity.js";
import { extractCitationLocations, type EvidenceGrounding } from "./citations.js";
import type { ThreadAuthorship } from "../context/review-threads.js";

export const THREAD_DISPOSITIONS: readonly string[] = ["fixed", "open", "disputed", "withdrawn"];

/** #977: the thread kinds a `withdrawn` disposition may close. A reply on a
 * real code defect cannot withdraw it — only a verification request or an
 * open question, whose subject the reviewer cannot check in the code. A
 * `verification` finding is non-blocking by construction and always
 * withdrawable; a `question` is withdrawable only when it was not blocking. */
const WITHDRAWABLE_CATEGORIES: ReadonlySet<string> = new Set(["verification", "question"]);

/** The finding severities re-emission may carry; anything else is
 * undeterminable and defaults to minor (#812). */
const FINDING_SEVERITIES: ReadonlySet<string> = new Set(["blocker", "major", "minor", "info"]);

function reemittedSeverity(raw: unknown): ArtifactFinding["severity"] {
  return typeof raw === "string" && FINDING_SEVERITIES.has(raw)
    ? (raw as ArtifactFinding["severity"])
    : "minor";
}

/**
 * Evidence that cites code: a path-shaped token with an extension (optionally
 * `:line` or "line N"), or a bare "line N" reference. Port of
 * `_evidence_cites_code`; the regex is contractual. Note the ASCII `\w`
 * divergence from Python's unicode word class — documented, and outside
 * every pinned fixture.
 */
const EVIDENCE_LOCATION_RE =
  /(?:^|[\s`(])[\w./-]+\.\w+(?::\d+|\s+line\s+\d+)|\bline\s+\d+/i;

export function evidenceCitesCode(evidence: string | null | undefined, path: string | null | undefined): boolean {
  const text = (evidence || "").trim();
  if (!text) return false;
  if (path && text.includes(path)) return true;
  return EVIDENCE_LOCATION_RE.test(text);
}

/** Citation candidates for one settlement: the canonical citations extracted
 * from the evidence text. When grounding is ABSENT (legacy lexical reading)
 * the historical rule also fires — the thread's own path merely mentioned in
 * the evidence is no longer a resolvable candidate here, so callers fall
 * back to `evidenceCitesCode` before ever consulting this list. */
function citationCandidates(evidence: string | null | undefined): Array<{ file: string; line: number }> {
  return extractCitationLocations(evidence);
}

/** #1681 r6: a `fixed` disposition is grounded when at least one cited
 * location RESOLVES at the exact reviewed head — a plausible but fake
 * `src/does-not-exist.ts:999999` proves nothing. Without engine grounding
 * (legacy unit callers, replay) the settlement keeps the historical lexical
 * reading; the production pipeline always supplies the resolver. */
function fixedCitationResolves(
  evidence: string | null | undefined,
  path: string | null | undefined,
  grounding: EvidenceGrounding | null | undefined,
): boolean {
  if (grounding === null || grounding === undefined) return evidenceCitesCode(evidence, path);
  return citationCandidates(evidence).some((loc) => grounding.resolveLocation(loc.file, loc.line));
}

/** #1681 r6 (PhAd convergence): a historical BOT finding's `fixed` settles
 * on a resolving citation, OR — when the evidence names no citation
 * candidate at all — on this run's own head-bound acquisition of the
 * thread's file (tool read or certified corpus diff). The reviewer's
 * semantic judgment may rest on current-head content the run genuinely
 * holds; it is not made to restate the same evidence in a second parallel
 * proof channel. A citation that was ATTEMPTED but resolves nowhere is a
 * broken claim, never rescued by acquisition; without grounding the
 * historical lexical reading stands. */
function botFixedSettled(
  evidence: string | null | undefined,
  path: string | null | undefined,
  grounding: EvidenceGrounding | null | undefined,
): boolean {
  if (grounding === null || grounding === undefined) return evidenceCitesCode(evidence, path);
  const candidates = citationCandidates(evidence);
  if (candidates.length === 0) {
    return (evidence ?? "").trim() !== ""
      && grounding.acquiredPaths !== undefined
      && path !== null && path !== undefined && path !== ""
      && grounding.acquiredPaths.has(path);
  }
  return candidates.some((loc) => grounding.resolveLocation(loc.file, loc.line));
}

/** One thread from the enforcement view (`review-threads.json`). */
export interface EnforcementThread {
  thread_id: string;
  path: string | null;
  line: number | null;
  severity: string;
  message: string;
  /** #1663: the root body carries the managed finding marker — a CLAIM that
   * this is the action's finding, never proof of authorship. */
  own_finding: boolean;
  /** #1663: what the forge metadata proves about the root author. Absent for
   * legacy callers, which keep the historical body-marker reading. */
  authorship?: ThreadAuthorship;
  /** #1681 round 7: the forge-proven review submission owning this thread,
   * when the read carries one (GitHub). Absent means unassociated. */
  parent_review_id?: string;
  replies: number;
  category?: string | null;
}

export interface ThreadEnforcementResult {
  applied: boolean;
  reason: string;
}

/** #1645: settlement-time reconciliation states for a listed thread against
 * the authoritative live thread listing. Only a thread proven live and
 * unresolved may re-enter the finding set; a thread the listing no longer
 * reports (absent) or reports resolved must never block, and when the live
 * state cannot be established at all the carried threads fail open —
 * disclosed, never promoted into blockers. */
export type ThreadReconciliationState = "live_unresolved" | "resolved" | "absent" | "unknown";

/** The authoritative live listing, re-read at settlement time. `available`
 * is false when the read failed or the platform cannot serve it — every
 * listed thread is then `unknown`. `complete` is false when the read
 * succeeded but the listing is known to be partial (a capped thread window
 * or a skipped failed sub-read). ONLY a proven-complete listing may yield a
 * proven state (#1645, maintainer review 5885372900): an incomplete
 * enumeration reconciles EVERY carried thread to `unknown`, because a
 * partial listing can prove neither presence nor absence — it cannot show a
 * thread live-unresolved, resolved, or gone, so no historical state may
 * block on it. `unparsedIds` carries the ids a listing still positively
 * reports but whose live state could not be parsed into a thread (a row
 * without parseable comments); they reconcile `unknown` too — a listing
 * cannot prove a thread absent while it still contains it. When no input is
 * provided at all (unit callers without a listing), each listed thread is
 * treated as `live_unresolved`, preserving the historical contract that the
 * enforcement view IS the live listing. */
export interface ThreadReconciliationInput {
  available: boolean;
  unresolvedIds: ReadonlySet<string>;
  resolvedIds: ReadonlySet<string>;
  unparsedIds?: ReadonlySet<string>;
  headSha: string;
  complete?: boolean;
}

function reconcileThreadState(threadId: string, reconciliation: ThreadReconciliationInput | null | undefined): ThreadReconciliationState {
  if (reconciliation === null || reconciliation === undefined) return "live_unresolved";
  if (!reconciliation.available) return "unknown";
  // #1645 (maintainer review 5885372900): only a PROVEN-COMPLETE listing may
  // yield a proven state. An incomplete enumeration (a capped window, a
  // failed sub-read, a skipped page) reconciles every carried thread to
  // `unknown` — it can prove neither that a thread is live-unresolved nor
  // that it is resolved or gone, so historical state must never block on a
  // listing that does not enumerate the whole set.
  if (reconciliation.complete === false) return "unknown";
  if (reconciliation.unresolvedIds.has(threadId)) return "live_unresolved";
  if (reconciliation.resolvedIds.has(threadId)) return "resolved";
  if (reconciliation.unparsedIds?.has(threadId)) return "unknown";
  return "absent";
}

/**
 * Settle every listed thread against the model's dispositions, in place.
 * The first disposition for a thread_id wins. #1663: for a carried bot
 * finding, a SUPPORTED `open` re-affirms it (re-emitted at its original
 * severity, default minor, never escalating, #812); `fixed` needs evidence
 * citing current code and `disputed` needs a reasoned explanation — neither
 * re-emits. An omitted disposition, an evidence-free `open`, or an
 * unsupported answer is recorded as unverified and its old blocking severity
 * is withheld (never re-emitted). A human-authored unresolved thread is never
 * closed by a bot disposition (#1663), but a code-citing `fixed` settles it
 * SEMANTICALLY at this head (#1681 round 5): physically open on the forge,
 * not carried as a current finding. The settled records replace
 * `thread_dispositions` in the artifact.
 *
 * #1645: before a listed thread can settle into the finding set it must
 * reconcile against the authoritative live thread listing. Only a
 * `live_unresolved` thread is re-emitted; a `resolved`/`absent` thread is
 * dropped, recorded with its reconciliation state and the terminal
 * `withdrawn` disposition (its own disposition is moot — the thread no
 * longer exists as an open review thread); such a record never supplies a
 * disposition to a later settlement, so a thread that reappears live settles
 * from the model's fresh answer alone. An `unknown` thread (live state
 * unreadable, or the listing is not provably complete) settles bookkeeping
 * but is never re-emitted, so unverifiable historical state cannot force
 * REQUEST_CHANGES — the incompleteness is disclosed instead. Only a
 * proven-complete listing yields a proven state at all: an incomplete
 * enumeration reconciles EVERY carried thread to `unknown`, so a thread the
 * partial listing positively reports is not treated as proven-live either
 * (maintainer review 5885372900). Bounded per-run provenance is persisted on
 * the artifact whenever reconciliation ran.
 */
export function applyReviewThreadEnforcement(
  artifact: ReviewArtifact,
  threads: readonly EnforcementThread[] | null,
  verdictPolicy: string,
  reconciliation?: ThreadReconciliationInput | null,
  grounding?: EvidenceGrounding | null,
): ThreadEnforcementResult {
  if (!Array.isArray(threads) || threads.length === 0) {
    return { applied: false, reason: "" };
  }
  const counts: Record<ThreadReconciliationState, number> = {
    live_unresolved: 0,
    resolved: 0,
    absent: 0,
    unknown: 0,
  };
  const given = new Map<string, Record<string, unknown>>();
  for (const entry of (artifact.thread_dispositions ?? []) as Array<Record<string, unknown>>) {
    if (!entry || typeof entry.thread_id !== "string") continue;
    // #1645: a record for a thread the live listing dropped is bookkeeping,
    // not a disposition — it must never supply one to a later settlement.
    // A thread that reappears live settles from the model's fresh answer
    // alone (no disposition given ⇒ open ⇒ re-emitted), never silently
    // withdrawn by its own stale record.
    if (entry.reconciliation === "resolved" || entry.reconciliation === "absent") continue;
    if (!given.has(entry.thread_id)) {
      given.set(entry.thread_id, entry);
    }
  }
  const findings: ArtifactFinding[] = Array.isArray(artifact.findings) ? artifact.findings : [];
  const knownThreadIds = new Set(
    findings.map((f) => f.thread_id).filter((id): id is string => typeof id === "string"),
  );

  // #1663: current-head findings an old bot concern is already independently
  // reported by. Keyed by the existing stable finding identity
  // (path/severity/category/message) — never fuzzy text similarity.
  const currentHeadByIdentity = new Map<string, ArtifactFinding>();
  for (const finding of findings) {
    if (typeof finding.thread_id === "string") continue;
    const identity = findingIdentityFromRecord(finding);
    if (identity !== null && !currentHeadByIdentity.has(identity)) {
      currentHeadByIdentity.set(identity, finding);
    }
  }

  const settled: Array<Record<string, unknown>> = [];
  let downgraded = 0;
  // #1681 r7 review: a note that only DISCLOSES state (a human `fixed`
  // settled at head whose thread stays physically open; an `open` flagged
  // without a current-head reason) never changed the model's disposition
  // and must not be billed as a downgrade. It still marks the settlement
  // as having something to disclose, so the section renders.
  let disclosed = 0;
  let settledWithdrawn = 0;
  let invalidated = 0;
  const counted = new Set<string>();
  const reemitted: ArtifactFinding[] = [];
  /** #1663: distinct carried concerns whose blocking validity the current
   * head did not establish. Counted once per stable finding identity, so
   * duplicate historical threads cannot multiply the uncertainty. */
  const unreassessed = new Set<string>();
  const carriedByIdentity = new Map<string, ArtifactFinding>();
  for (const thread of threads) {
    if (!thread || typeof thread.thread_id !== "string") continue;
    const threadId = thread.thread_id;
    const state = reconcileThreadState(threadId, reconciliation);
    // Provenance counts each listed thread once, even if a duplicate id
    // appears in the view (re-emission keeps the historical first-wins skip).
    if (!counted.has(threadId)) {
      counted.add(threadId);
      counts[state] += 1;
    }
    const entry = given.get(threadId) ?? {};
    // #1645: a thread the live listing no longer reports as open cannot be
    // settled into the finding set — record why it was dropped and move on.
    // The record carries the terminal "withdrawn" disposition (the dropped
    // thread's own disposition is moot — it is no longer an open review
    // thread) plus its reconciliation state, which carries the reason; a
    // null disposition would read back as "no disposition given" and could
    // withdraw the thread if it ever reappeared live.
    if (state === "resolved" || state === "absent") {
      settled.push({
        thread_id: threadId,
        reconciliation: state,
        disposition: "withdrawn",
        evidence: typeof entry.evidence === "string" ? entry.evidence : null,
      });
      continue;
    }
    const baseSeverity = reemittedSeverity(thread.severity);
    // #1663: what the forge proves about the root author. A legacy caller
    // that supplied no authorship keeps the historical reading in which the
    // enforcement view is the action's own listing.
    const authorship: ThreadAuthorship = thread.authorship ?? "action";
    // A carried concern the current review could not re-evaluate is only
    // worth a material unknown when its body actually claims to be one of
    // this action's findings; a stranger's marker-less comment is not a
    // blocking claim this reviewer has to settle.
    const blocking = isBlockingSeverity(baseSeverity) && !isAlwaysNonBlockingCategory(thread.category);
    const materialIfUnverified = blocking && (authorship !== "unproven" || thread.own_finding);
    let disposition = entry.disposition as string | undefined;
    const evidence = typeof entry.evidence === "string" ? entry.evidence : null;
    let note: string | null = null;
    // #1663: `confirmed` = current-head evidence still shows the defect;
    // `resolved` = evidence proves it fixed; `invalid` = evidence proves the
    // old finding was wrong; `unverified` = no usable current-head
    // re-evaluation. Only `confirmed` may re-emit a historical blocking
    // severity.
    let reassessment: "confirmed" | "resolved" | "invalid" | "unverified" | null = null;
    if (authorship === "unproven") {
      // The forge never established who wrote this root, so neither
      // authority may be asserted: no bot disposition closes it (it may be a
      // human thread), and its historical severity is never re-emitted (it
      // may be an automation finding under a publisher identity this run
      // cannot identify). A marker-bearing blocking concern settles as the
      // material unknown instead.
      if (disposition === "fixed" || disposition === "withdrawn" || disposition === "disputed") {
        disposition = "open";
        note = "authorship unproven: a bot disposition cannot close the thread";
      } else if (disposition === undefined || !THREAD_DISPOSITIONS.includes(disposition)) {
        disposition = "open";
        note = "no disposition given";
      }
      if (materialIfUnverified) reassessment = "unverified";
    } else if (authorship === "human") {
      // #1663: human-authored unresolved thread closed by the FORGE
      // (its live state above), never by a bot disposition — the action
      // never mutates another human's conversation. #1681 round 5 splits
      // what that non-closing rule does and does not mean: GitHub
      // `is_resolved` is PHYSICAL conversation state, not semantic
      // authority over whether the code defect still exists. A `fixed`
      // disposition carrying evidence that cites current code settles
      // the finding SEMANTICALLY: the concern is addressed at this head,
      // so it is not re-emitted as a current finding, does not count as
      // an unresolved semantic obligation, and cannot hold back approval
      // — while the thread stays physically open on the forge and the
      // record below discloses exactly that. Any weaker claim — `fixed`
      // without code-citing evidence, `withdrawn`, `disputed`, a bare or
      // missing disposition — does NOT prove the defect gone and keeps
      // the historical fail-closed reading: recorded open and re-emitted
      // at the human-side non-blocking severity.
      if (disposition === "fixed" && fixedCitationResolves(evidence, thread.path, grounding)) {
        note = "human-authored thread stays open on the forge — a bot disposition cannot close it; the current-head evidence establishes the concern is addressed, so it is not carried as a current finding";
      } else if (disposition === "fixed" || disposition === "withdrawn" || disposition === "disputed") {
        disposition = "open";
        note = "human-authored thread: a bot disposition cannot close it";
      } else if (disposition === undefined || !THREAD_DISPOSITIONS.includes(disposition)) {
        disposition = "open";
        note = "no disposition given";
      }
    } else if (disposition === undefined || !THREAD_DISPOSITIONS.includes(disposition)) {
      disposition = "open";
      note = "no disposition given";
      if (materialIfUnverified) reassessment = "unverified";
    } else if (disposition === "fixed" && !botFixedSettled(evidence, thread.path, grounding)) {
      disposition = "open";
      note = "fixed without evidence citing current code";
      if (materialIfUnverified) reassessment = "unverified";
    } else if (disposition === "fixed") {
      reassessment = "resolved";
    } else if (disposition === "disputed") {
      // #1663: `disputed` is the reviewer's current-head claim that the old
      // finding was originally invalid. Unlike `fixed`, that claim is not
      // about current code, so a reasoned explanation is enough — the
      // maintainer policy explicitly does not require fabricated
      // `path:line` proof for an originally invalid concern. An empty
      // answer is still unsupported and becomes uncertainty, not proof.
      if (evidence === null || evidence.trim() === "") {
        disposition = "open";
        note = "disputed without an explanation";
        if (materialIfUnverified) reassessment = "unverified";
      } else {
        reassessment = "invalid";
      }
    } else if (disposition === "withdrawn") {
      if (!WITHDRAWABLE_CATEGORIES.has(thread.category ?? "")) {
        disposition = "open";
        note = "withdrawn without a verification/question finding";
        if (materialIfUnverified) reassessment = "unverified";
      } else if (!isAlwaysNonBlockingCategory(thread.category) && isBlockingSeverity(thread.severity)) {
        // #977: a question the model could have blocked on may be a real
        // defect in disguise — only `fixed`, which demands code evidence,
        // may close it.
        disposition = "open";
        note = "withdrawn on a blocking finding";
        if (materialIfUnverified) reassessment = "unverified";
      } else if (evidence === null || evidence.trim() === "") {
        disposition = "open";
        note = "withdrawn without evidence from a reply";
        if (materialIfUnverified) reassessment = "unverified";
      } else {
        reassessment = "resolved";
      }
    } else if (blocking && (evidence === null || evidence.trim() === "")) {
      // #1663: `open` is the reviewer's claim that the defect remains at this
      // head, and for a carried BLOCKING concern that claim must carry the
      // reason the review settled on — the same support the reviewer gives
      // for a current-head finding. This check demands neither a citation
      // format nor a token count: it distinguishes a re-affirmation from the
      // default word the output shape encourages. An unsupported claim
      // withholds the historical severity and becomes the material unknown;
      // it never fabricates a blocker.
      note = "open without a current-head reason";
      if (materialIfUnverified) reassessment = "unverified";
    } else {
      // A supported `open` is the current-head re-affirmation (#1663 Reading
      // A); it preserves the severity.
      reassessment = "confirmed";
    }
    // #1645: `reconciliation` is stamped only when reconciliation actually
    // ran — a legacy caller (no input) keeps byte-identical settled records.
    const record: Record<string, unknown> = { thread_id: threadId, disposition, evidence };
    if (reconciliation !== null && reconciliation !== undefined) record.reconciliation = state;
    // #1681 round 7: carry the forge-proven owning review submission
    // through settlement so the human-change-request pass can aggregate
    // PER review. A forge without the link records nothing here — the
    // concern stays unassociated rather than being guessed onto a review.
    if (typeof thread.parent_review_id === "string" && thread.parent_review_id !== "") {
      record.parent_review_id = thread.parent_review_id;
    }
    if (note) {
      record.enforced = note;
      // Only a note that CHANGED the model's disposition is a downgrade;
      // a note that merely annotates the settled reading is a disclosure.
      if (entry.disposition === disposition) disclosed += 1;
      else downgraded += 1;
    }
    // #1681 r6: a human-authored thread additionally carries its SEMANTIC
    // concern state at this head — the single current-head answer the
    // human-change-request settlement aggregates. Proven fixed →
    // `addressed`; a supported `open` (no forcing note) → `present`; any
    // forced/unsupported/unevaluated reading (including a `fixed` whose
    // citation did not resolve, and an unverifiable live state) →
    // `unresolved`, never collapsed into either settled answer.
    if (authorship === "human") {
      record.concern = disposition === "fixed"
        ? "addressed"
        : state !== "live_unresolved"
          ? "unresolved"
          : disposition === "open" && note === null
            ? "present"
            : "unresolved";
    }
    settled.push(record);
    if (disposition === "withdrawn") settledWithdrawn += 1;
    if (reassessment === "invalid") invalidated += 1;

    // Identity (dedup + the fresh-finding exemption) stays keyed on the
    // thread's historical severity even for human/unproven roots, so a
    // fresh same-concern finding still vouches for it.
    const identity = findingIdentity({
      path: thread.path ?? "",
      severity: baseSeverity,
      category: thread.category ?? "",
      message: thread.message || "Unresolved review thread",
    });
    if (
      state === "live_unresolved"
      && reassessment === "unverified"
      // #1663: a fresh current-head finding that already proves the same
      // concern keeps it blocking on its own authority — its thread fallback
      // is not an unverified gap. Identity includes severity, so a match here
      // is the same blocking concern, not a weaker restatement.
      && !currentHeadByIdentity.has(identity)
    ) {
      // #1663: a live historical bot blocker the current head did not
      // re-evaluate is neither a blocker nor a clean resolution. Record the
      // uncertainty for the authoritative disposition (INCOMPLETE/COMMENT).
      unreassessed.add(identity);
    }
    // #1645: only a thread proven live and unresolved re-enters the finding
    // set. An `unknown` thread settles as bookkeeping but never blocks.
    // #1663: a historical blocking severity only re-enters when the current
    // head supported the re-affirmation; fixed/invalid/unverified never
    // preserve it.
    const reemit = state === "live_unresolved"
      && disposition === "open"
      && reassessment !== "unverified"
      && !knownThreadIds.has(threadId);
    if (!reemit) continue;
    const currentHeadFinding = currentHeadByIdentity.get(identity);
    const alreadyCarried = carriedByIdentity.get(identity);
    const existing = currentHeadFinding ?? alreadyCarried;
    if (existing !== undefined) {
      // #1663: one concern is counted once even when several historical
      // threads (or a fresh current-head finding) describe it. Keep every
      // thread id as provenance; never broaden into text similarity.
      const ids = Array.isArray(existing.thread_ids)
        ? existing.thread_ids.filter((id): id is string => typeof id === "string")
        : [];
      if (!ids.includes(threadId)) ids.push(threadId);
      existing.thread_ids = ids;
      continue;
    }
    // #1663: the pass never re-emits a blocking severity for a root the
    // forge does not attribute to an automation author. `enforcementView`
    // already caps human roots at minor and withholds unproven blocking
    // severity as the material unknown, so the shipped pipeline cannot
    // reach here with a blocking human/unproven row — the cap makes that
    // invariant local, so a hand-supplied view (unit callers) cannot
    // smuggle blocking authority past the settlement boundary.
    const severity = authorship === "human" || authorship === "unproven"
      ? (isBlockingSeverity(baseSeverity) ? "minor" : baseSeverity)
      : baseSeverity;
    const finding: ArtifactFinding = {
      severity,
      // #977: carry the non-blocking marker forward so a verification ask
      // cannot return as a blocking `other` finding on the next run. Every
      // other kind stays `other` — re-emission never changes what can block.
      category: thread.category && isAlwaysNonBlockingCategory(thread.category) ? thread.category : "other",
      file: thread.path,
      line: thread.line,
      message: `${thread.message || "Unresolved review thread"} (review thread ${threadId}: ${disposition})`,
      thread_id: threadId,
      thread_ids: [threadId],
      ...(reconciliation !== null && reconciliation !== undefined ? { thread_reconciliation: "live_unresolved" as const } : {}),
    };
    findings.push(finding);
    reemitted.push(finding);
    carriedByIdentity.set(identity, finding);
  }

  // #1645/#1663: persist bounded reconciliation provenance whenever
  // reconciliation ran, independent of whether settlement changed the
  // artifact. `state` describes the CARRIED THREAD SET: "incomplete" iff a
  // thread's live state could not be proven (unknown) OR a live historical
  // bot blocker had no usable current-head re-evaluation — in both cases the
  // artifact can never claim a settlement the published review discloses as
  // unresolved. The listing's own `complete` flag remains provenance for the
  // `absent` rule in reconcileThreadState, not for this field.
  // The engine supplies a reconciliation input whenever it supplies carried
  // threads (a failed read still arrives as `available: false`), so the
  // material count below is not lost on the production path. A legacy unit
  // caller WITHOUT one keeps the pre-#1663 record shape — but not the old
  // severity: a blocking bare-open row is still withheld from the finding
  // set, and with no reconciliation there is no `unreassessed` provenance,
  // so the gap appears only in the settled records and the disclosed
  // markdown. Callers that need the material unknown must supply the
  // reconciliation input, as the pipeline always does.
  if (reconciliation !== null && reconciliation !== undefined) {
    artifact.thread_reconciliation = {
      state: counts.unknown > 0 || unreassessed.size > 0 ? "incomplete" : "complete",
      head_sha: reconciliation.headSha,
      live_unresolved: counts.live_unresolved,
      resolved: counts.resolved,
      absent: counts.absent,
      unknown: counts.unknown,
      ...(unreassessed.size > 0 ? { unreassessed: unreassessed.size } : {}),
    };
  }

  if (settled.length === 0) {
    return { applied: false, reason: "" };
  }
  artifact.thread_dispositions = settled;
  artifact.findings = findings;
  const changed = downgraded > 0 || disclosed > 0 || reemitted.length > 0 || settledWithdrawn > 0
    || invalidated > 0 || unreassessed.size > 0;
  // #1645: the incompleteness disclosure must not hinge on a settlement
  // change — when every carried thread was already dispositioned, the human
  // review still has to say the live listing could not be proven. `unknown`
  // is exactly the state whose live truth could not be established (an
  // unreadable read, a partial listing, or a listed row that could not be
  // parsed), so it is the precise trigger: a listing that proved every
  // carried thread's state owes no disclosure.
  const discloseIncomplete = reconciliation !== null && reconciliation !== undefined
    && counts.unknown > 0;
  if (changed || discloseIncomplete) {
    const lines = ["", "", "## Unresolved Review Threads", ""];
    for (const record of settled) {
      // #1645: threads the live listing dropped are not unresolved review
      // threads anymore — only treated (live/unknown) records render.
      if (record.reconciliation === "resolved" || record.reconciliation === "absent") continue;
      const suffix = record.enforced ? ` — ${record.enforced}` : "";
      lines.push(`- \`${record.thread_id}\`: ${record.disposition}${suffix}`);
    }
    if (discloseIncomplete) {
      lines.push(
        "",
        "_Review-thread reconciliation incomplete: the live thread listing could not be read in full at settlement time, so carried threads were recorded but not treated as blocking._",
      );
    }
    if (unreassessed.size > 0) {
      lines.push(
        "",
        `_${unreassessed.size} live historical bot blocking concern(s) had no current-head re-evaluation; their original severity is not treated as a blocker, and the review cannot certify a clean result._`,
      );
    }
    artifact.review_markdown = (artifact.review_markdown || "") + lines.join("\n");
    const blockers = reemitted.filter((f) => f.severity === "blocker" && !isAlwaysNonBlockingCategory(f.category));
    if (
      verdictPolicy === "findings_severity_gated"
      && blockers.length > 0
      && artifact.verdict !== "request_changes"
    ) {
      artifact.review_markdown += (
        "\n\n_Verdict escalated from unresolved review threads "
        + `(verdict_policy=findings_severity_gated): ${blockers.length} blocker thread(s) `
        + `still open; model verdict was '${artifact.verdict}'._`
      );
      artifact.verdict = "request_changes";
      artifact.verdict_source = "findings";
      // #1248: this flip also retires any earlier relaxation note it
      // contradicts (the provenance stays "findings" — the escalated
      // thread blockers, not an enforcement overlay, decided here).
      markRelaxationNotesSuperseded(artifact);
    }
  }
  if (!changed) {
    return { applied: false, reason: "" };
  }
  return {
    applied: true,
    reason: `review threads: ${downgraded} disposition(s) downgraded, ${reemitted.length} finding(s) re-emitted${settledWithdrawn > 0 ? `, ${settledWithdrawn} withdrawn` : ""}${unreassessed.size > 0 ? `, ${unreassessed.size} blocking concern(s) without current-head re-evaluation` : ""}`,
  };
}
