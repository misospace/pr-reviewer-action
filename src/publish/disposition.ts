/**
 * The published review disposition (#1596).
 *
 * A run publishes two statements about the same pull request: the
 * deterministic machine disposition (the final verdict, the `review_result`,
 * the required-check coverage, the native review event) and the
 * model-authored prose. Before #1596 those two could contradict each other:
 * the model writes its recommendation BEFORE the deterministic layers have
 * relaxed the verdict, so a review whose machine disposition was "incomplete"
 * (no proven blocking defect, approval withheld) still published prose that
 * said "Recommendation: request changes" — or, in the mirror case, prose that
 * said "Recommendation: Approve" above a withheld approval and a `partial`
 * marker. A reader of the prose could not tell which statement was
 * authoritative, and the prose is the part humans act on.
 *
 * This module is the single place where the authoritative disposition is
 * computed (`computeReviewDisposition`) and where the model prose is
 * reconciled with it (`normalizePublishedRecommendation`). It is a pure
 * function of signals the pipeline already produced — the final verdict, the
 * marker's `review_result`, the coverage state and the approval
 * certification — so it never adds a model call, a second reviewer, or a new
 * judgement of the findings.
 *
 * The authority model this encodes:
 * - The DETERMINISTIC disposition owns the recommendation. The model's
 *   prose is evidence about the review, never the verdict.
 * - A proven blocker outranks a coverage gap: `request_changes` means a
 *   blocking code defect was proven, and it is published as such even when
 *   the coverage is also incomplete.
 * - A coverage gap is an ABSTENTION, not an approval and not a defect
 *   claim: the disposition reads `incomplete`, the native event is a
 *   non-blocking COMMENT, and the published line says so in words (what the
 *   review did NOT prove, and that the approval was withheld).
 * - An unresolved review is NEVER silently converted into a clean approval:
 *   the native APPROVE event requires an explicitly certified approval, and
 *   the certification is only ever read from the publish boundary's own
 *   guardrails.
 * - The prose reconciliation is SUBTRACTIVE in effect: it rewrites the
 *   model's actionable recommendation into a non-actionable sentence that
 *   keeps the original suggestion visible as non-authoritative history. It
 *   never adds a line, never removes one, and never touches the findings.
 */

/** The closed disposition vocabulary. */
export type ReviewDispositionKind = "request_changes" | "incomplete" | "approve" | "unavailable";

export interface ReviewDisposition {
  kind: ReviewDispositionKind;
  /** The action-owned recommendation line published above the model prose. */
  recommendation: string;
  /** The plain-language statement of the disposition (no emoji/bold). */
  statement: string;
  /** The native review event this disposition permits. */
  nativeEvent: "REQUEST_CHANGES" | "COMMENT" | "APPROVE";
  /** True when a blocking code defect is proven (the deterministic verdict says so). */
  blockerProven: boolean;
  /** True when required evidence / coverage is unresolved. */
  coverageIncomplete: boolean;
  /** True when this run may certify a native APPROVE. */
  approvalCertified: boolean;
}

/**
 * The user-visible wording of each disposition. These strings are a
 * CONTRACT: the published recommendation line is what a human reads to learn
 * what the action decided, so the wording is fixed here (one place) instead
 * of being assembled at each call site.
 */
const REQUEST_CHANGES_WORDING = {
  recommendation: "⚠️ **Automated recommendation: REQUEST CHANGES**",
  statement: "Request changes",
} as const;
const APPROVE_WORDING = {
  recommendation: "✅ **Automated recommendation: APPROVE**",
  statement: "Approve",
} as const;
/**
 * A review that concluded "approve" but whose approval was NOT certified
 * (a verdict-bearing publication whose native event is a non-blocking
 * COMMENT). The recommendation must never read as a certified approval: the
 * prose says the reviewer approves, the publication withheld the approval.
 */
const ADVISORY_APPROVE_WORDING = {
  recommendation: "🟡 **Automated recommendation: APPROVE — advisory, no approval certified**",
  statement: "Approve",
} as const;
const NO_VERDICT_WORDING = {
  recommendation: "🟡 **Automated recommendation: NO VERDICT**",
  statement: "No verdict",
} as const;

/**
 * Why the coverage is incomplete, in the words the reader needs. The reason
 * detail used to live only in the recommendation line's wording; the
 * coverage-gap notice repeats it for the strict policy, but a non-strict
 * policy renders no notice — so the recommendation carries the reason
 * itself and the reader is never left with an unexplained abstention.
 */
const INCOMPLETE_REASON_CLAUSES: Record<string, string> = {
  execution: "review coverage incomplete",
  requirement_trace: "requirement trace incomplete",
  both: "review coverage and requirement trace incomplete",
};

/**
 * The incomplete wording. The defect clause states what the review actually
 * proved: under the strict policy an approve verdict means no blocker or
 * major finding is open, but a non-strict policy lets the model's own
 * approve stand with an open blocker — and the published line must never
 * claim a defect was NOT proven while the findings table lists one.
 */
function incompleteWording(input: { incompleteReason: string; blockingFindingOpen: boolean }): {
  recommendation: string;
  statement: string;
} {
  const reason = INCOMPLETE_REASON_CLAUSES[input.incompleteReason] ?? INCOMPLETE_REASON_CLAUSES.execution!;
  const defect = input.blockingFindingOpen
    ? "a blocking finding is still open"
    : "no blocking code defect proven";
  const statement = `Incomplete — ${defect}; approval withheld (${reason})`;
  return {
    recommendation: `🟡 **Automated recommendation: INCOMPLETE — ${defect}; approval withheld (${reason})**`,
    statement,
  };
}

/**
 * Compute the authoritative disposition of a published review.
 *
 * Kind precedence (fail-closed at every step):
 * 1. An invalid/missing verdict is `unavailable` — a failed run, never a
 *    clean review and never a blocking request.
 * 2. A `request_changes` verdict is `request_changes`: a proven blocking
 *    defect outranks a coverage gap, because the gap says nothing about
 *    whether the defect is real.
 * 3. An incomplete coverage state (`review_result === "partial"`) is
 *    `incomplete`: the review abstained, and an abstention is neither an
 *    approval nor a defect claim.
 * 4. Everything else is `approve`.
 *
 * The native event follows the disposition: a proven blocker publishes
 * REQUEST_CHANGES, a certified approve publishes APPROVE, and EVERY other
 * case (an incomplete coverage state, a withheld or uncertified approval, a
 * missing verdict, the blockers-only mode) publishes the non-blocking
 * COMMENT. The coverage state and the certification are OR-ed here so a
 * `partial` review result can never be reported as a clean approve even if a
 * caller passes the two fields inconsistently.
 *
 * The RECOMMENDATION follows the event on a verdict-bearing surface: an
 * approve whose approval was withheld publishes the advisory wording (it
 * never reads as a certified approval), so the published line and the native
 * event can never disagree. On an advisory surface (a sticky comment) there
 * is no verdict-bearing event to contradict, so the review's own conclusion
 * is published as the recommendation.
 */
export function computeReviewDisposition(input: {
  verdict: string;
  validVerdict: boolean;
  reviewResult: string;
  coverageIncomplete: boolean;
  approvalCertified: boolean;
  /** True when this publication's authoritative surface is a verdict-bearing
   * native review (`review_verdict` / `review_blockers`). On those surfaces
   * the published recommendation must agree with the native event, so a
   * recommendation that would read as a certified approval is not used when
   * the approval was withheld. An advisory publication (a sticky comment)
   * carries no verdict-bearing event to contradict. */
  verdictBearing: boolean;
  /** Why the coverage is incomplete ("none" | "execution" |
   * "requirement_trace" | "both"). */
  incompleteReason: string;
  /** True when a blocker/major finding is still open. */
  blockingFindingOpen: boolean;
}): ReviewDisposition {
  const coverageIncomplete = input.coverageIncomplete === true || input.reviewResult === "partial";
  const kind: ReviewDispositionKind = !input.validVerdict
    ? "unavailable"
    : input.verdict === "request_changes"
      ? "request_changes"
      : coverageIncomplete
        ? "incomplete"
        : "approve";
  const nativeEvent: ReviewDisposition["nativeEvent"] = kind === "request_changes"
    ? "REQUEST_CHANGES"
    : kind === "approve" && input.approvalCertified === true
      ? "APPROVE"
      : "COMMENT";
  const wording = kind === "request_changes"
    ? REQUEST_CHANGES_WORDING
    : kind === "incomplete"
      ? incompleteWording({ incompleteReason: input.incompleteReason, blockingFindingOpen: input.blockingFindingOpen })
      : kind === "approve" && input.verdictBearing && input.approvalCertified !== true
        ? ADVISORY_APPROVE_WORDING
        : kind === "approve"
          ? APPROVE_WORDING
          : NO_VERDICT_WORDING;
  return {
    kind,
    recommendation: wording.recommendation,
    statement: wording.statement,
    nativeEvent,
    blockerProven: kind === "request_changes",
    coverageIncomplete,
    approvalCertified: input.approvalCertified === true,
  };
}

/** The two actionable directions the model prose can state. */
type ModelDirection = "approve" | "request_changes";

/**
 * The approve-direction tokens, and the request-direction tokens. The
 * EARLIEST occurrence decides (so "Approve, no changes requested" is an
 * approve), which is why the tokens are scanned by position rather than by
 * a precedence table.
 */
const APPROVE_TOKENS = ["approve", "approved", "approving", "approval", "lgtm"];
/**
 * The request-direction tokens. The bare word "block" is deliberately NOT a
 * token: "blocking", "blocker" and "deadlock" are not recommendations, and
 * reading them as one would rewrite an unrelated sentence.
 */
const REQUEST_TOKENS = [
  "request changes",
  "requests changes",
  "requested changes",
  "requesting changes",
  "changes requested",
  "needs changes",
  "needs a change",
];

/**
 * A negation immediately before an approve word turns the approve word into a
 * request for changes ("do not approve", "cannot approve", "don't approve").
 * The look-back runs over the words immediately preceding the token, so
 * "Approve, no changes requested" is NOT negated (the negation is not
 * attached to the approve word).
 */
const NEGATION_BEFORE_APPROVE_RE = /(?:\b(?:not|never|no)\b|n't\b|cannot)[ \t]*$/;

/** True when the approve token at `at` is negated by the words before it. */
function isNegatedApproval(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 32), at);
  return NEGATION_BEFORE_APPROVE_RE.test(before);
}

/**
 * Rule A — the structured recommendation line: `Recommendation: <text>`, with
 * optional heading markers and optional bold markers around the label.
 * Horizontal whitespace only (`[ \t]`, never `\s`): `\s` also matches the
 * newline, so a `\s` grammar could match a label on one line against a
 * suggestion text on the NEXT line — and a replacement that spans lines
 * would change the published body's line count and could land inside a
 * different fence. The captured text is therefore always one line.
 *
 * The bold markers are captured on BOTH sides of the label AND after the
 * colon, so `**Recommendation:** Approve` keeps its label intact: the
 * closing marker of the label is part of the prefix, never part of the
 * recommendation text.
 */
const RECOMMENDATION_LABEL_RE =
  /^(?<prefix>(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*)(?<label>Automated recommendation|Recommendation)(?<mid>(?:\*\*|__)?[ \t]*:(?:\*\*|__)?[ \t]*)(?<text>[^\n]*?)(?<bold>\*\*|__)?(?<eol>\r?)$/i;

/**
 * Rule A, second form — the LABEL-ONLY recommendation heading: a
 * `Recommendation` (or `## Recommendation`) line whose recommendation text
 * is the next non-empty line. The model prompt asks for human-readable
 * markdown, and this heading form is a common way to write it. The label is
 * explicit, so matching it carries no false-positive risk of its own — the
 * rewrite still requires the FOLLOWING line to open with an actionable verb.
 */
const RECOMMENDATION_HEADING_RE =
  /^(?<prefix>(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*)(?<label>Automated recommendation|Recommendation)(?:\*\*|__)?[ \t]*:?[ \t]*$/i;

/**
 * Rule B — the leading statement: the first prose line that is neither blank
 * nor a markdown heading, opening with an actionable verb. It is a fallback
 * for the shape #1596 observed in the wild ("Approve. Both majors fixed."),
 * where the model states its recommendation without a label — and real prose
 * opens with a title, so the candidate is the first line AFTER the leading
 * headings.
 *
 * The verb list is deliberately narrower than the inline label's: a line
 * that merely opens with the noun "Approval" or the participle "Approved" is
 * not a recommendation ("Approval of this change requires a migration."), and
 * rewriting it would mangle an ordinary sentence. Only the imperative forms
 * and the negated approvals count.
 */
const LEADING_STATEMENT_RE =
  /^(?<open>\*\*|__)?[ \t]*(?<verb>(?:cannot|can't|don't|won't|not|do|does|did|should|must|can)(?:[ \t]+not)?[ \t]+approve|approve|lgtm|request[ \t]+changes?|changes[ \t]+requested|needs[ \t]+changes?|needs[ \t]+a[ \t]+change)\b(?<close>\*\*|__)?(?<punct>[.,;:!?]*)(?<rest>.*?)(?<eol>\r?)$/i;

/** A markdown heading line — skipped when looking for the leading statement. */
const MARKDOWN_HEADING_RE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;

/**
 * The direction a captured recommendation text states, or null when it
 * states no actionable direction at all (a neutral sentence must never be
 * rewritten). The earliest token wins, and a negated approve word ("do not
 * approve") states the request direction.
 */
function detectDirection(text: string): ModelDirection | null {
  const lower = text.toLowerCase();
  let approveAt = -1;
  let approveNegated = false;
  for (const token of APPROVE_TOKENS) {
    const at = lower.indexOf(token);
    if (at !== -1 && (approveAt === -1 || at < approveAt)) {
      approveAt = at;
      approveNegated = isNegatedApproval(lower, at);
    }
  }
  let requestAt = -1;
  for (const token of REQUEST_TOKENS) {
    const at = lower.indexOf(token);
    if (at !== -1 && (requestAt === -1 || at < requestAt)) requestAt = at;
  }
  if (approveAt === -1 && requestAt === -1) return null;
  if (approveAt === -1) return "request_changes";
  if (requestAt === -1) return approveNegated ? "request_changes" : "approve";
  if (requestAt < approveAt) return "request_changes";
  return approveNegated ? "request_changes" : "approve";
}

/**
 * The direction the disposition agrees with. `incomplete` and `unavailable`
 * agree with NEITHER: an abstention and a failed run are not an approval and
 * not a blocking request, so any actionable model recommendation about them
 * is a contradiction.
 */
function dispositionDirection(kind: ReviewDispositionKind): ModelDirection | null {
  if (kind === "approve") return "approve";
  if (kind === "request_changes") return "request_changes";
  return null;
}

/**
 * Strip the trailing period and whitespace of a captured recommendation
 * text, so the rewritten sentence does not carry a doubled period.
 */
function stripTrailingPeriod(text: string): string {
  let out = text.replace(/[ \t]+$/, "");
  while (out.endsWith(".")) {
    out = out.slice(0, -1).replace(/[ \t]+$/, "");
  }
  return out;
}

/**
 * The rewritten sentence: the authoritative statement first, then the
 * model's own suggestion kept visible as explicitly non-authoritative
 * history. The parenthetical is PLAIN TEXT on purpose — the captured model
 * text may contain underscores, so italic markers would risk opening an
 * unterminated span in the published body.
 */
function supersededSentence(statement: string, original: string): string {
  return `${statement}. (Model suggestion before validation, not authoritative: ${original}.)`;
}

/**
 * Reconcile the model-authored prose with the authoritative disposition
 * (#1596).
 *
 * The function is a NO-OP when the prose agrees with the disposition (the
 * markdown is returned byte-identical) and rewrites the model's actionable
 * recommendation when it disagrees. Three detectors, all applied to the
 * SANITIZED prose:
 *
 * - Rule A (inline): a `Recommendation: <text>` line, optional heading/bold
 *   markers.
 * - Rule A (heading): a label-only `Recommendation` heading whose
 *   recommendation text is the next non-empty line.
 * - Rule B: the first non-empty line opening with an actionable verb, for
 *   the prose that states its recommendation without any label.
 *
 * Every rewrite replaces exactly ONE line with exactly ONE line: the line
 * count never changes, no line break is introduced, and the replacement
 * carries no fence delimiter — so the published body's fence structure and
 * the publish-boundary byte accounting stay intact. The rewritten line keeps
 * the original prefix (the heading markers and the `Recommendation:` label),
 * so the model's structure survives while its actionable content becomes the
 * authoritative statement.
 *
 * The function is total: on any unexpected input it returns the markdown
 * unchanged rather than throwing — a reconciliation failure must never cost
 * the reader the review itself.
 */
export function normalizePublishedRecommendation(markdown: string, disposition: ReviewDisposition): string {
  if (typeof markdown !== "string" || markdown === "") return markdown;
  try {
    const authority = dispositionDirection(disposition.kind);
    const statement = disposition.statement;
    const lines = markdown.split("\n");
    /** The rewritten lines, keyed by their index. A line is rewritten at
     * most once: the first detector that claims it wins. */
    const rewritten = new Map<number, string>();
    // Rule A, inline form: a `Recommendation: <text>` line, anywhere.
    for (let index = 0; index < lines.length; index += 1) {
      const labelled = RECOMMENDATION_LABEL_RE.exec(lines[index]!);
      if (labelled === null) continue;
      const label = labelled.groups?.["label"] ?? "";
      const original = labelled.groups?.["text"] ?? "";
      const direction = detectDirection(original);
      // A model-authored line that claims the ACTION's own recommendation
      // surface ("Automated recommendation: ...") is renamed whatever its
      // direction says: the action's recommendation is action-owned, and a
      // model line must never read as the action's own statement.
      const claimsActionSurface = /^automated[ \t]+recommendation$/i.test(label);
      if (!claimsActionSurface && (direction === null || direction === authority)) continue;
      const prefix = labelled.groups?.["prefix"] ?? "";
      const mid = labelled.groups?.["mid"] ?? "";
      const bold = labelled.groups?.["bold"] ?? "";
      const eol = labelled.groups?.["eol"] ?? "";
      const renamed = claimsActionSurface ? "Model recommendation before validation" : label;
      const text = direction !== null && direction !== authority
        ? supersededSentence(statement, stripTrailingPeriod(original))
        : original;
      rewritten.set(index, `${prefix}${renamed}${mid}${text}${bold}${eol}`);
    }
    // Rule A, heading form: a label-only `Recommendation` heading whose
    // recommendation text is the next non-empty line.
    for (let index = 0; index < lines.length; index += 1) {
      if (rewritten.has(index)) continue;
      const heading = RECOMMENDATION_HEADING_RE.exec(lines[index]!);
      if (heading === null) continue;
      const label = heading.groups?.["label"] ?? "";
      const claimsActionSurface = /^automated[ \t]+recommendation$/i.test(label);
      const next = lines.findIndex((line, position) => position > index && line.trim() !== "");
      if (next === -1 || rewritten.has(next)) continue;
      const leadingMatch = LEADING_STATEMENT_RE.exec(lines[next]!);
      const verb = leadingMatch?.groups?.["verb"] ?? "";
      const direction = leadingMatch === null ? null : detectDirection(verb);
      const disagrees = direction !== null && direction !== authority;
      if (!claimsActionSurface && !disagrees) continue;
      const prefix = heading.groups?.["prefix"] ?? "";
      if (claimsActionSurface) {
        rewritten.set(index, `${prefix}Model recommendation before validation`);
      }
      if (!disagrees) continue;
      const rest = leadingMatch!.groups?.["rest"] ?? "";
      const eol = leadingMatch!.groups?.["eol"] ?? "";
      rewritten.set(next, `${supersededSentence(statement, stripTrailingPeriod(verb))}${rest}${eol}`);
    }
    // Rule B: the leading statement — the first prose line that is neither
    // blank nor a markdown heading, opening with an actionable verb, for the
    // prose that states its recommendation without any label. Real prose
    // opens with a title, so the leading headings are skipped.
    const leading = lines.findIndex((line) => line.trim() !== "" && !MARKDOWN_HEADING_RE.test(line));
    if (leading !== -1 && !rewritten.has(leading)) {
      const leadingMatch = LEADING_STATEMENT_RE.exec(lines[leading]!);
      if (leadingMatch !== null) {
        const verb = leadingMatch.groups?.["verb"] ?? "";
        const direction = detectDirection(verb);
        if (direction !== null && direction !== authority) {
          const rest = leadingMatch.groups?.["rest"] ?? "";
          const eol = leadingMatch.groups?.["eol"] ?? "";
          rewritten.set(leading, `${supersededSentence(statement, stripTrailingPeriod(verb))}${rest}${eol}`);
        }
      }
    }
    if (rewritten.size === 0) return markdown;
    return lines.map((line, index) => rewritten.get(index) ?? line).join("\n");
  } catch {
    return markdown;
  }
}
