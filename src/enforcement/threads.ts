/**
 * Review-thread enforcement (#680 port of
 * `pr_reviewer/enforcement.py::apply_review_thread_enforcement`, carrying
 * #766 and the #770 context/enforcement contract).
 *
 * Every unresolved review thread the corpus listed is settled against the
 * model's dispositions. #1663 splits two questions that were previously one:
 * the forge proves whether a thread is live (the #1645 reconciliation), and
 * the current-head review must still establish whether its finding is valid.
 * A live historical BOT finding re-emits at its original severity only when
 * the model re-affirms it `open`; a code-citing `fixed`/`disputed` settles it
 * without re-emission; a missing or unsupported re-evaluation withholds the
 * old blocking severity and records a MATERIAL `unverified_blocking_claim`
 * through `thread_reconciliation.unreassessed` (INCOMPLETE/COMMENT).
 * A HUMAN-authored unresolved thread is closed only by the forge's resolved
 * state — a bot disposition never dismisses it — and keeps its existing
 * non-blocking severity.
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

/** One thread from the enforcement view (`review-threads.json`). */
export interface EnforcementThread {
  thread_id: string;
  path: string | null;
  line: number | null;
  severity: string;
  message: string;
  own_finding: boolean;
  /** #1663: trusted forge authorship of the thread root (the authenticated
   * login posted the root comment). Absent for legacy callers, which keep the
   * historical body-marker reading (`own_finding`). */
  bot_authored?: boolean;
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
 * The first disposition for a thread_id wins. #1663: for a bot-authored
 * blocking thread, `open` re-affirms it (re-emitted at its original
 * severity, default minor, never escalating, #812); `fixed`/`disputed` need
 * evidence citing current code and never re-emit; a missing or unsupported
 * answer is recorded as unverified and its old blocking severity is withheld
 * (never re-emitted). A human-authored unresolved thread is never closed by
 * a bot disposition. The settled records replace `thread_dispositions` in
 * the artifact.
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
    const severity = reemittedSeverity(thread.severity);
    // #1663: legacy callers that supplied no trusted ownership keep treating
    // a carried thread as action-authored; the pipeline always supplies it.
    const botAuthored = thread.bot_authored ?? true;
    const blocking = isBlockingSeverity(severity) && !isAlwaysNonBlockingCategory(thread.category);
    let disposition = entry.disposition as string | undefined;
    const evidence = typeof entry.evidence === "string" ? entry.evidence : null;
    let note: string | null = null;
    // #1663: `confirmed` = current-head evidence still shows the defect;
    // `resolved` = evidence proves it fixed; `invalid` = evidence proves the
    // old finding was wrong; `unverified` = no usable current-head
    // re-evaluation. Only `confirmed` may re-emit a historical blocking
    // severity.
    let reassessment: "confirmed" | "resolved" | "invalid" | "unverified" | null = null;
    if (!botAuthored) {
      // #1663: a human-authored unresolved thread is closed by the forge
      // (its live state above), never by a bot disposition. The model's
      // fixed/withdrawn/disputed claim is recorded as open and the thread is
      // re-emitted at the existing human-thread severity (minor by default).
      if (disposition === "fixed" || disposition === "withdrawn" || disposition === "disputed") {
        disposition = "open";
        note = "human-authored thread: a bot disposition cannot close it";
      } else if (disposition === undefined || !THREAD_DISPOSITIONS.includes(disposition)) {
        disposition = "open";
        note = "no disposition given";
      }
    } else if (disposition === undefined || !THREAD_DISPOSITIONS.includes(disposition)) {
      disposition = "open";
      note = "no disposition given";
      if (blocking) reassessment = "unverified";
    } else if (disposition === "fixed" && !evidenceCitesCode(evidence, thread.path)) {
      disposition = "open";
      note = "fixed without evidence citing current code";
      if (blocking) reassessment = "unverified";
    } else if (disposition === "fixed") {
      reassessment = "resolved";
    } else if (disposition === "disputed") {
      // #1663: `disputed` is the reviewer's current-head claim that the old
      // finding was invalid. It needs a concrete code-citing explanation;
      // an unsupported invalidity claim is uncertainty, not proof.
      if (!evidenceCitesCode(evidence, thread.path)) {
        disposition = "open";
        note = "disputed without evidence citing current code";
        if (blocking) reassessment = "unverified";
      } else {
        reassessment = "invalid";
      }
    } else if (disposition === "withdrawn") {
      if (!WITHDRAWABLE_CATEGORIES.has(thread.category ?? "")) {
        disposition = "open";
        note = "withdrawn without a verification/question finding";
        if (blocking) reassessment = "unverified";
      } else if (!isAlwaysNonBlockingCategory(thread.category) && isBlockingSeverity(thread.severity)) {
        // #977: a question the model could have blocked on may be a real
        // defect in disguise — only `fixed`, which demands code evidence,
        // may close it.
        disposition = "open";
        note = "withdrawn on a blocking finding";
        if (blocking) reassessment = "unverified";
      } else if (evidence === null || evidence.trim() === "") {
        disposition = "open";
        note = "withdrawn without evidence from a reply";
        if (blocking) reassessment = "unverified";
      } else {
        reassessment = "resolved";
      }
    } else {
      // An explicit `open` is the model's current-head re-evaluation that
      // the defect remains (#1663 Reading A); it preserves the severity.
      reassessment = "confirmed";
    }
    // #1645: `reconciliation` is stamped only when reconciliation actually
    // ran — a legacy caller (no input) keeps byte-identical settled records.
    const record: Record<string, unknown> = { thread_id: threadId, disposition, evidence };
    if (reconciliation !== null && reconciliation !== undefined) record.reconciliation = state;
    if (note) {
      record.enforced = note;
      downgraded += 1;
    }
    settled.push(record);
    if (disposition === "withdrawn") settledWithdrawn += 1;
    if (reassessment === "invalid") invalidated += 1;

    const identity = findingIdentity({
      path: thread.path ?? "",
      severity,
      category: thread.category ?? "",
      message: thread.message || "Unresolved review thread",
    });
    if (state === "live_unresolved" && blocking && botAuthored && reassessment === "unverified") {
      // #1663: a live historical bot blocker the current head did not
      // re-evaluate is neither a blocker nor a clean resolution. Record the
      // uncertainty for the authoritative disposition (INCOMPLETE/COMMENT).
      unreassessed.add(identity);
    }
    // #1645: only a thread proven live and unresolved re-enters the finding
    // set. An `unknown` thread settles as bookkeeping but never blocks.
    // #1663: a historical bot blocker only re-enters when the current head
    // re-affirmed it (`open`); fixed/invalid/unverified never preserve it.
    const reemit = state === "live_unresolved"
      && disposition === "open"
      && !(blocking && botAuthored && reassessment === "unverified")
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
  const changed = downgraded > 0 || reemitted.length > 0 || settledWithdrawn > 0
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
