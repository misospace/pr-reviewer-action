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
 * listed thread is then `unknown`. When no input is provided at all (unit
 * callers without a listing), each listed thread is treated as
 * `live_unresolved`, preserving the historical contract that the
 * enforcement view IS the live listing. */
export interface ThreadReconciliationInput {
  available: boolean;
  unresolvedIds: ReadonlySet<string>;
  resolvedIds: ReadonlySet<string>;
  headSha: string;
}

function reconcileThreadState(threadId: string, reconciliation: ThreadReconciliationInput | null | undefined): ThreadReconciliationState {
  if (reconciliation === null || reconciliation === undefined) return "live_unresolved";
  if (!reconciliation.available) return "unknown";
  if (reconciliation.unresolvedIds.has(threadId)) return "live_unresolved";
  if (reconciliation.resolvedIds.has(threadId)) return "resolved";
  return "absent";
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
 * #1645: before a listed thread can settle into the finding set it must
 * reconcile against the authoritative live thread listing. Only a
 * `live_unresolved` thread is re-emitted; a `resolved`/`absent` thread is
 * recorded with its reconciliation state and dropped (its disposition is
 * moot — the thread no longer exists as an open review thread); an
 * `unknown` thread (live state unreadable) settles bookkeeping but is never
 * re-emitted, so unverifiable historical state cannot force REQUEST_CHANGES
 * — the incompleteness is disclosed instead. Bounded per-run provenance is
 * persisted on the artifact whenever reconciliation ran.
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
  let settledWithdrawn = 0;
  const counted = new Set<string>();
  const reemitted: ArtifactFinding[] = [];
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
    if (state === "resolved" || state === "absent") {
      settled.push({
        thread_id: threadId,
        reconciliation: state,
        disposition: typeof entry.disposition === "string" ? entry.disposition : null,
        evidence: typeof entry.evidence === "string" ? entry.evidence : null,
      });
      continue;
    }
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
    // #1645: only a thread proven live and unresolved re-enters the finding
    // set. An `unknown` thread settles as bookkeeping but never blocks.
    if (
      state === "live_unresolved"
      && disposition !== "fixed" && disposition !== "withdrawn"
      && !knownThreadIds.has(threadId)
    ) {
      const finding: ArtifactFinding = {
        severity: reemittedSeverity(thread.severity),
        // #977: carry the non-blocking marker forward so a verification ask
        // cannot return as a blocking `other` finding on the next run. Every
        // other kind stays `other` — re-emission never changes what can block.
        category: thread.category && isAlwaysNonBlockingCategory(thread.category) ? thread.category : "other",
        file: thread.path,
        line: thread.line,
        message: `${thread.message || "Unresolved review thread"} (review thread ${threadId}: ${disposition})`,
        thread_id: threadId,
        ...(reconciliation !== null && reconciliation !== undefined ? { thread_reconciliation: "live_unresolved" as const } : {}),
      };
      findings.push(finding);
      reemitted.push(finding);
    }
  }

  // #1645: persist bounded reconciliation provenance whenever reconciliation
  // ran, independent of whether settlement changed the artifact.
  if (reconciliation !== null && reconciliation !== undefined) {
    artifact.thread_reconciliation = {
      state: reconciliation.available ? "complete" : "incomplete",
      head_sha: reconciliation.headSha,
      live_unresolved: counts.live_unresolved,
      resolved: counts.resolved,
      absent: counts.absent,
      unknown: counts.unknown,
    };
  }

  if (settled.length === 0) {
    return { applied: false, reason: "" };
  }
  artifact.thread_dispositions = settled;
  artifact.findings = findings;
  const changed = downgraded > 0 || reemitted.length > 0 || settledWithdrawn > 0;
  // #1645: the incompleteness disclosure must not hinge on a settlement
  // change — when every carried thread was already dispositioned, the human
  // review still has to say the live listing could not be proven.
  const discloseIncomplete = reconciliation !== null && reconciliation !== undefined
    && !reconciliation.available && counts.unknown > 0;
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
        "_Review-thread reconciliation incomplete: the live thread listing could not be read at settlement time, so carried threads were recorded but not treated as blocking._",
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
    reason: `review threads: ${downgraded} disposition(s) downgraded, ${reemitted.length} finding(s) re-emitted${settledWithdrawn > 0 ? `, ${settledWithdrawn} withdrawn` : ""}`,
  };
}
