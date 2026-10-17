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
import type { ArtifactFinding, ReviewArtifact } from "./artifact.js";
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

/**
 * Settle every listed thread against the model's dispositions, in place.
 * Mirrors v2 exactly: the first disposition for a thread_id wins; unknown or
 * missing dispositions downgrade to `open`; `fixed` needs evidence citing
 * current code; open/disputed threads are re-emitted as findings with the
 * thread's original severity (default minor, never escalating, #812) unless
 * a finding already carries the thread_id; the settled records replace
 * `thread_dispositions` in the artifact.
 */
export function applyReviewThreadEnforcement(
  artifact: ReviewArtifact,
  threads: readonly EnforcementThread[] | null,
  verdictPolicy: string,
): ThreadEnforcementResult {
  if (!Array.isArray(threads) || threads.length === 0) {
    return { applied: false, reason: "" };
  }

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
  for (const thread of threads) {
    if (!thread || typeof thread.thread_id !== "string") continue;
    const threadId = thread.thread_id;
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
    settled.push(record);
    if (disposition !== "fixed" && disposition !== "withdrawn" && !knownThreadIds.has(threadId)) {
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
      };
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
  const changed = downgraded > 0 || reemitted.length > 0 || settledWithdrawn > 0;
  if (changed) {
    const lines = ["", "", "## Unresolved Review Threads", ""];
    for (const record of settled) {
      const suffix = record.enforced ? ` — ${record.enforced}` : "";
      lines.push(`- \`${record.thread_id}\`: ${record.disposition}${suffix}`);
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
