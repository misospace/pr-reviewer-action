/**
 * Review-thread enforcement (#680 port of
 * `pr_reviewer/enforcement.py::apply_review_thread_enforcement`, carrying
 * #766 and the #770 context/enforcement contract).
 *
 * Every unresolved review thread the corpus listed must be dispositioned by
 * the model. A listed thread the model did not disposition, or marked
 * `fixed` without evidence that cites current code, is downgraded to
 * `open`. Every `open`/`disputed` thread is re-emitted as a finding carrying
 * `thread_id` (the publish step skips those inline — the thread already
 * exists). Under `findings_severity_gated` a re-emitted blocker escalates
 * the verdict like any other blocker; under `strict` (#811) the settlement
 * never forces a verdict — the strict mapping alone derives one from the
 * final still-open findings set.
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
import type { ThreadLiveReconciliation, ThreadReconciliationState } from "./thread-reconcile.js";

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
  replies: number;
  category?: string | null;
}

export interface ThreadEnforcementResult {
  applied: boolean;
  reason: string;
  /** #1645: bounded provenance explaining, per carried thread, how it
   * reconciled against the current authoritative review-thread state
   * (identity, thread id, reconciliation result, current head SHA). Omitted
   * when no reconciliation was attempted, so a legacy caller's result keeps
   * its exact pre-#1645 shape. */
  reconciliation?: ThreadReconciliationProvenance;
}

/** #1645: how one listed thread reconciled against the CURRENT authoritative
 * forge review-thread listing read at enforcement time. */
export interface ThreadReconciliationEntry {
  thread_id: string;
  /** The severity re-emission would carry (the thread's own severity). */
  severity: string;
  reconciliation: ThreadReconciliationState;
  /** True when the reconciliation changed this thread's outcome: a would-be
   * re-emission was dropped (`resolved`/`absent`). */
  dropped: boolean;
}

export interface ThreadReconciliationProvenance {
  version: 1;
  head_sha: string;
  /** Whether the enforcement-time live listing was provably complete. */
  listing_complete: boolean;
  /** One row per settled thread (bounded upstream by the context cap). */
  entries: ThreadReconciliationEntry[];
}

/** #1645: the live state of one listed thread against the complete current
 * listing. `absent`/`resolved` are historical state, never current blockers. */
function reconcileThread(
  reconciliation: ThreadLiveReconciliation | null,
  threadId: string,
): ThreadReconciliationState {
  if (reconciliation === null || !reconciliation.listingComplete) return "unknown";
  const unresolved = reconciliation.unresolvedById.get(threadId);
  if (unresolved === undefined) return "absent";
  return unresolved ? "live-unresolved" : "resolved";
}

/**
 * Settle every listed thread against the model's dispositions, in place.
 * Mirrors v2 exactly: the first disposition for a thread_id wins; unknown or
 * missing dispositions downgrade to `open`; `fixed` needs evidence citing
 * current code; open/disputed threads are re-emitted as findings with the
 * thread's original severity (default minor, never escalating, #812) unless
 * a finding already carries the thread_id; the settled records replace
 * `thread_dispositions` in the artifact.
 *
 * #1645 live reconciliation: when the caller supplies a PROVABLY COMPLETE
 * listing of the forge's current threads, a listed thread the forge reports
 * `resolved` — or `absent` from entirely — is historical state: it settles as
 * bookkeeping and is NEVER re-emitted into the open-findings set, so neither
 * the strict mapping nor the severity gate can REQUEST_CHANGES on it. No
 * ghost blockers. A `live-unresolved` thread behaves exactly as before (live
 * unresolved blockers still count), and independently rediscovered current
 * findings are untouched by this pass. Without a complete listing
 * (`unknown`) settlement behaves as before PLUS the artifact and review
 * disclose that review-state reconciliation was incomplete: unverifiable
 * state is never silently promoted, and never silently trusted either.
 */
export function applyReviewThreadEnforcement(
  artifact: ReviewArtifact,
  threads: readonly EnforcementThread[] | null,
  verdictPolicy: string,
  options: { reconciliation?: ThreadLiveReconciliation | null; headSha?: string } = {},
): ThreadEnforcementResult {
  if (!Array.isArray(threads) || threads.length === 0) {
    return { applied: false, reason: "" };
  }
  const reconciliation = options.reconciliation ?? null;
  // A caller that supplies no reconciliation input at all (fixture replays,
  // legacy callers) keeps the pre-#1645 bytes exactly: no `reconciliation`
  // record field, no provenance, no severity capping.
  const reconciled = reconciliation !== null;

  const given = new Map<string, Record<string, unknown>>();
  for (const entry of (artifact.thread_dispositions ?? []) as Array<Record<string, unknown>>) {
    if (entry && typeof entry.thread_id === "string" && !given.has(entry.thread_id)) {
      given.set(entry.thread_id, entry);
    }
  }
  const findings: ArtifactFinding[] = Array.isArray(artifact.findings) ? artifact.findings : [];
  const knownThreadIds = new Set(
    findings.map((f) => f.thread_id).filter((id): id is string => typeof id === "string"),
  );

  const settled: Array<Record<string, unknown>> = [];
  let downgraded = 0;
  const reemitted: ArtifactFinding[] = [];
  // #1645: per-thread live-reconciliation rows, in settlement order.
  const reconciliationEntries: ThreadReconciliationEntry[] = [];
  let reconciliationDropped = 0;
  // #1645: true when an unverifiable (unknown) carried thread re-enters the
  // open findings at BLOCKING severity — the disclosure-worthy case.
  let unknownBlocking = false;
  for (const thread of threads) {
    if (!thread || typeof thread.thread_id !== "string") continue;
    const threadId = thread.thread_id;
    const state = reconcileThread(reconciliation, threadId);
    const entry = given.get(threadId) ?? {};
    let disposition = entry.disposition as string | undefined;
    const evidence = typeof entry.evidence === "string" ? entry.evidence : null;
    let note: string | null = null;
    if (disposition === undefined || !THREAD_DISPOSITIONS.includes(disposition)) {
      disposition = "open";
      note = "no disposition given";
    } else if (disposition === "fixed" && !evidenceCitesCode(evidence, thread.path)) {
      disposition = "open";
      note = "fixed without evidence citing current code";
    } else if (disposition === "withdrawn") {
      if (!WITHDRAWABLE_CATEGORIES.has(thread.category ?? "")) {
        disposition = "open";
        note = "withdrawn without a verification/question finding";
      } else if (!isAlwaysNonBlockingCategory(thread.category) && isBlockingSeverity(thread.severity)) {
        // #977: a question the model could have blocked on may be a real
        // defect in disguise — only `fixed`, which demands code evidence,
        // may close it.
        disposition = "open";
        note = "withdrawn on a blocking finding";
      } else if (evidence === null || evidence.trim() === "") {
        disposition = "open";
        note = "withdrawn without evidence from a reply";
      }
    }
    const record: Record<string, unknown> = { thread_id: threadId, disposition, evidence };
    if (note) {
      record.enforced = note;
      downgraded += 1;
    }
    // #1645: a thread the CURRENT authoritative listing reports resolved —
    // or does not contain at all — cannot stay open merely because a prior
    // review or a stale cached listing said so: it settles as bookkeeping
    // and is never re-emitted into the open-findings set. `unknown` (no
    // complete listing) keeps today's behavior and is disclosed. Without a
    // reconciliation input at all no field is recorded (fixture replays keep
    // their exact pre-#1645 bytes).
    const reconciledOut = state === "resolved" || state === "absent";
    if (reconciliation !== null) record.reconciliation = state;
    reconciliationEntries.push({
      thread_id: threadId,
      severity: reemittedSeverity(thread.severity),
      reconciliation: state,
      dropped: false,
    });
    settled.push(record);
    if (reconciledOut) {
      if (disposition !== "fixed" && disposition !== "withdrawn" && !knownThreadIds.has(threadId)) {
        reconciliationEntries[reconciliationEntries.length - 1]!.dropped = true;
        reconciliationDropped += 1;
      }
      continue;
    }
    if (disposition !== "fixed" && disposition !== "withdrawn" && !knownThreadIds.has(threadId)) {
      const baseSeverity = reemittedSeverity(thread.severity);
      // #1645: an `unknown` reconciliation cannot prove the thread live, but
      // the run's own context listing found it unresolved — that stays the
      // best available evidence (dropping it would silently disable
      // carried-blocker enforcement on every forge that cannot enumerate a
      // provably complete listing). The row keeps its severity and the
      // review DISCLOSES that the state is unverified, so a reader can tell
      // a confirmed-live blocker from an unproven one. A thread the complete
      // live listing reports `resolved`/`absent` is not re-emitted at all.
      if (reconciled && state === "unknown" && isBlockingSeverity(baseSeverity) && !isAlwaysNonBlockingCategory(thread.category)) {
        unknownBlocking = true;
      }
      const finding: ArtifactFinding = {
        severity: baseSeverity,
        // #977: carry the non-blocking marker forward so a verification ask
        // cannot return as a blocking `other` finding on the next run. Every
        // other kind stays `other` — re-emission never changes what can block.
        category: thread.category && isAlwaysNonBlockingCategory(thread.category) ? thread.category : "other",
        file: thread.path,
        line: thread.line,
        message: `${thread.message || "Unresolved review thread"} (review thread ${threadId}: ${disposition})`,
        thread_id: threadId,
      };
      if (reconciled && state === "unknown") {
        // #1645 diagnostic: this carried row's live state could not be
        // established at decision time (the artifact provenance names the
        // thread; the markdown discloses the incomplete reconciliation).
        finding.thread_state_unverified = true;
      }
      findings.push(finding);
      reemitted.push(finding);
    }
  }

  if (settled.length === 0) {
    return { applied: false, reason: "" };
  }
  artifact.thread_dispositions = settled;
  artifact.findings = findings;
  const settledWithdrawn = settled.filter((record) => record.disposition === "withdrawn").length;
  const changed = downgraded > 0 || reemitted.length > 0 || settledWithdrawn > 0 || reconciliationDropped > 0 || unknownBlocking;
  if (changed) {
    const lines = ["", "", "## Unresolved Review Threads", ""];
    for (const record of settled) {
      const suffix = record.enforced ? ` — ${record.enforced}` : "";
      lines.push(`- \`${record.thread_id}\`: ${record.disposition}${suffix}`);
    }
    artifact.review_markdown = (artifact.review_markdown || "") + lines.join("\n");
    // #1645: the reconciliation disclosure — which carried threads the
    // current-head disposition did NOT count, and why. A dropped thread is
    // historical state, never a ghost blocker; an incomplete reconciliation
    // is stated so no reader mistakes carried state for verified live state.
    const reconciliationLines: string[] = [];
    for (const entryRow of reconciliationEntries) {
      if (!entryRow.dropped) continue;
      const why = entryRow.reconciliation === "absent"
        ? "absent from the current review-thread listing"
        : "resolved on the forge since this listing";
      reconciliationLines.push(`- \`${entryRow.thread_id}\`: ${why} — historical state, not counted in the current-head findings (#1645)`);
    }
    if (reconciliationLines.length > 0) {
      artifact.review_markdown += ["", "", "## Review-Thread Reconciliation (#1645)", "", ...reconciliationLines].join("\n");
    } else if (unknownBlocking) {
      // Unknown reconciliation matters exactly when an unproven carried
      // thread carries BLOCKING severity: the review must say the live state
      // was never established, so a reader can tell it from a confirmed one.
      // Non-blocking carried rows disclose in the artifact provenance.
      artifact.review_markdown += (
        "\n\n_Review-state reconciliation incomplete: the current review-thread state could not be"
        + " fully established at decision time, so the carried blocking thread(s) above are marked"
        + " `unknown` — they were listed unresolved for this head but are not independently"
        + " proven live (#1645)._"
      );
    }
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
  const provenance: ThreadReconciliationProvenance | null = reconciliation === null ? null : {
    version: 1,
    head_sha: options.headSha ?? "",
    listing_complete: reconciliation.listingComplete,
    entries: reconciliationEntries,
  };
  if (!changed) {
    return provenance === null ? { applied: false, reason: "" } : { applied: false, reason: "", reconciliation: provenance };
  }
  return {
    applied: true,
    reason: `review threads: ${downgraded} disposition(s) downgraded, ${reemitted.length} finding(s) re-emitted${settledWithdrawn > 0 ? `, ${settledWithdrawn} withdrawn` : ""}${reconciliationDropped > 0 ? `, ${reconciliationDropped} dropped as historical (not live)` : ""}`,
    ...(provenance === null ? {} : { reconciliation: provenance }),
  };
}
