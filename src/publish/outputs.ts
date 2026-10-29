/**
 * Action outputs and step-summary finalization (#680).
 *
 * The workflow-facing output IDs are the canonical kebab-case v3 contract
 * (`contracts/action-v3.yml`); internal TypeScript stays camelCase. The
 * multiline outputs use a random heredoc-style delimiter so model-controlled
 * review text (which prompt injection in the PR can influence) cannot
 * terminate the assignment early and inject arbitrary step outputs — e.g.
 * flip the verdict. That delimiter discipline is the security boundary here;
 * keep it byte-faithful to the v2 writer.
 *
 * The step summary is a typed renderer, not a file reader: the #681
 * orchestrator supplies the telemetry objects the v2 pipeline scraped from
 * run artifacts. Rows render only when their data is supplied.
 */
import { sanitizeMarkdown, type UpstreamLinkMode } from "./sanitize.js";
import { redactText } from "../context/redact.js";
import { stripRevealedCapNoteTails } from "../confidence/result.js";
import { escapeTableCell } from "../gates/ci-wait.js";
import { SEVERITY_LABELS } from "./inline-findings.js";
import { resolveReviewTriageDecision } from "../model/triage.js";
import { isHumanReviewRoutingStatus } from "../routing/human-review-routing.js";

//
// ---------------------------------------------------------------------------
// #1003 human-review triage: the decision is resolved fail-closed — exact
// literal, and `not_required` only with a usable supporting reason — by
// src/model/triage.ts, shared with the parser and every other boundary. This
// module only bounds and escapes the model-authored reason for the two public
// surfaces (the published review body and the step summary).
// ---------------------------------------------------------------------------

/** Cap on the model-authored reason rendered on a public surface. The cap is
 * applied to the text BEFORE pipe-escaping (escaping expands `\` and `|`
 * two-fold, and cutting an escape pair in half would itself be a rendering
 * bug), so the published bytes are bounded at roughly twice this. */
export const MAX_REVIEW_TRIAGE_REASON_CHARS = 300;

/**
 * #1230: the confidence reason as it is published on a public surface (the
 * published review body and the step summary).
 *
 * The canonical reason arrives from the confidence module ALREADY bounded
 * (600 chars) and reveal-stripped, and the canonical reason's own trailing
 * note is the ACTION-OWNED one (`confidenceCapNote`, rebuilt from the
 * structured `caps` field), so a reason that FITS this surface's 300-char
 * budget is published whole and keeps that note verbatim.
 *
 * This surface's cap is TIGHTER than the confidence module's bound, so the
 * cut can drag an INTERIOR look-alike onto the trailing edge. A CUT reason
 * therefore takes the same reveal strip the confidence module uses (#1166):
 * a cut reason can never END in a model-authored `[deterministic cap: …]` —
 * complete, or truncated into an unterminated fragment. The cost is that a
 * cut reason DROPS the action-owned note instead of publishing it truncated;
 * the structured caps remain in `confidence-score.json`.
 *
 * The precondition this helper relies on is the confidence module's own
 * contract: the canonical reason it hands over is strip-clean, and only its
 * trailing note is the action-owned one. This helper does not re-derive that
 * property, and it is not a defence against a note-shaped span the CANONICAL
 * reason already ends in.
 *
 * The input is the reason AFTER the caller's own redaction / link
 * sanitization — this helper owns only the whitespace flattening, the
 * length cap, and the reveal strip.
 */
export function publishedConfidenceReason(reason: string): string {
  const text = reason.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_REVIEW_TRIAGE_REASON_CHARS) return text;
  return stripRevealedCapNoteTails(text.slice(0, MAX_REVIEW_TRIAGE_REASON_CHARS));
}

// ---------------------------------------------------------------------------
// Findings summary (moved from publish.ts, #975): the per-finding table a
// reader sees in place of bare counts, shared by the strict publish body and
// the step summary.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rows rendered before the visible "N more" cap keeps the body bounded
 * (50 findings of up to 2000 characters each would overrun a comment). */
export const FINDINGS_SUMMARY_MAX_ROWS = 50;

/** Cap on the model-controlled severity token rendered in the findings table's
 * severity column.
 *
 * #1249: the body-only native-review fallback publishes this summary, so the
 * bound is part of a published surface's contract, not this renderer's
 * internals. A severity outside the known set renders verbatim (the label map
 * has no entry to fall back on), so without a cap a hostile label would make
 * the summary unbounded.
 *
 * The cap applies to the CONTENT, before table escaping expands it (two-fold
 * for `\` and `|`, five-fold for `&`/`<`/`>`), so the published cell is at
 * most roughly five times this. The per-severity counts do NOT render a
 * severity at all — they render the closed vocabulary only, so they are
 * bounded without this cap. */
export const FINDINGS_SUMMARY_MAX_SEVERITY_CHARS = 64;

/** Cap on the model-controlled path rendered in the findings table's location
 * column. The path is the one findings field no producer bounds: the verdict
 * normalizer trims it but never caps it, so an over-long path would render
 * into the published body unbounded. Same convention as the severity cap.
 *
 * The cap applies to the PATH only — the line number is appended after it, so
 * a capped path never loses its line. */
export const FINDINGS_SUMMARY_MAX_LOCATION_CHARS = 300;

/** Cap on the model-controlled finding message rendered in the findings table's
 * message column. The cap is applied BEFORE table escaping (escaping expands
 * `\` and `|` two-fold and `&`/`<`/`>` into entities five-fold), so the
 * published cell is at most roughly five times this. */
export const FINDINGS_SUMMARY_MAX_MESSAGE_CHARS = 300;

/** #1283: aggregate bound on the WHOLE rendered findings-summary block — the
 * counts heading, the table header, every row, and the overflow disclosure —
 * measured in UTF-8 bytes on the exact string `renderFindingsSummary` returns.
 *
 * The per-cell caps (#1249 / #1281) bound every cell individually, but not the
 * summary as a whole: a full table of max-width rows is 50 × (64 + 300 + 300)
 * characters before table escaping expands it up to five-fold, which still
 * overruns the forge review-body limit (~65,536 characters on GitHub) and
 * makes the publication fail outright. 32,768 bytes is half that limit, so
 * even the worst-case summary leaves the other half for the rest of the body.
 * Legitimate runs are unaffected: 50 rows of ordinary findings render well
 * under 10 KB. */
export const FINDINGS_SUMMARY_MAX_BYTES = 32_768;

/** Bound one model-controlled token for the findings summary: the whitespace is
 * collapsed (so a newline can never forge a heading) and the text is truncated
 * to `max` characters BEFORE table escaping — escaping expands the text (two-fold
 * for `\` and `|`, five-fold for `&`/`<`/`>`), and cutting an escape pair in
 * half would itself be a rendering bug. */
function boundedSummaryToken(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

const SEVERITY_RANK = ["blocker", "major", "minor", "info"] as const;

/** Per-severity counts in rank order, zero entries omitted: `2 major, 4 minor`.
 *
 * The counts ride in a HEADING line (`### Findings (2 major)`), not in a table
 * cell, so they are never table-escaped: a severity carrying a newline would
 * otherwise forge a heading of its own, and a severity carrying a comma would
 * split into a second count token of its own.
 *
 * #1249: the heading is therefore rendered from the CLOSED severity vocabulary
 * only — no model-controlled text reaches it at all. Only the four known
 * severities render as a count token, and every finding whose severity is
 * outside the vocabulary is aggregated into one bounded
 * `N findings of unknown severity` clause (separate from the counts, so it can
 * never be read as another severity's count).
 *
 * Two properties follow, and both are what the counts line needs:
 *
 * - BOUNDED: the line's length is a function of the vocabulary size and the
 *   finding count alone, never of how many distinct severities a run
 *   produced. Capping each token's length is not enough on its own — a run
 *   with thousands of distinct severities renders thousands of tokens.
 * - UNFORGEABLE: a severity cannot inject a token boundary, a count, or a
 *   clause, because no part of a severity reaches the line.
 *
 * Published bytes are unchanged for every finding whose severity is in the
 * vocabulary, which is every finding the verdict normalizer produces
 * (`src/model/verdict.ts` maps every severity through its alias table onto
 * `blocker`/`major`/`minor`/`info`). */
export function severityCountsLabel(findings: unknown): string {
  if (!Array.isArray(findings)) return "";
  const counts = new Map<string, number>();
  let unknownSeverity = 0;
  for (const finding of findings) {
    const severity = isRecord(finding) && typeof finding.severity === "string"
      ? finding.severity
      : "info";
    if ((SEVERITY_RANK as readonly string[]).includes(severity)) {
      counts.set(severity, (counts.get(severity) ?? 0) + 1);
    } else {
      unknownSeverity += 1;
    }
  }
  const tokens = SEVERITY_RANK
    .filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity)} ${severity}`);
  if (unknownSeverity === 0) return tokens.join(", ");
  const clause = `${unknownSeverity} ${unknownSeverity === 1 ? "finding" : "findings"} of unknown severity`;
  return tokens.length > 0 ? `${tokens.join(", ")}; ${clause}` : clause;
}

/** Wrap an already-escaped body in a fence-safe inline-code span: the
 * delimiter is one backtick longer than the longest backtick run inside the
 * body, so embedded backticks (escaped to `\`` by `escapeTableCell`) or
 * Markdown link syntax cannot close the span and render clickable. Same
 * fail-closed strategy as `inlineCodeValue` (#903).
 *
 * A backtick-bearing body is additionally SPACE-PADDED (`delim + " " + body
 * + " " + delim`). Without the padding, a trailing escaped backtick runs
 * straight into the closing delimiter and merges with it into a longer run
 * (the 1-backtick escape + the 2-backtick fence = a 3-run) that no
 * CommonMark/GFM parser accepts as the equal-length closing delimiter, so
 * the span is left unterminated and the payload renders as live Markdown.
 * CommonMark strips exactly one leading+trailing space, so the visible span
 * content is unchanged. A backtick-free body stays an unpadded single-backtick
 * fence, byte-identical to `inlineCodeValue`. */
function fenceInlineCode(body: string): string {
  if (!body.includes("`")) return `\`${body}\``;
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const delim = "`".repeat(longest + 1);
  return `${delim} ${body} ${delim}`;
}

/** A path (model-controlled) as one bounded code span: whitespace collapsed
 * and fenced by a backtick run longer than any inside it, so it cannot open
 * markdown structure; pipes are escaped because GFM tables split cells even
 * inside code spans. The path is capped BEFORE escaping (an over-long path
 * would otherwise make the published cell unbounded).
 *
 * The cap deliberately does NOT go through `boundedSummaryToken`: that helper
 * trims its input, and trimming the path here would change what the cell
 * renders for a whitespace-padded path (`a.ts :5` today, `a.ts:5` after a
 * trim) — a published-byte change the bound does not need. The cap is applied
 * to the path alone, and the collapse still runs over the whole cell exactly
 * as before, so the line number always survives. */
function locationCell(finding: Record<string, unknown>): string {
  const file = typeof finding.file === "string" ? finding.file : "";
  const line = typeof finding.line === "number" && Number.isFinite(finding.line) ? String(finding.line) : "";
  if (file === "" && line === "") return "";
  const boundedFile = file.length > FINDINGS_SUMMARY_MAX_LOCATION_CHARS
    ? file.slice(0, FINDINGS_SUMMARY_MAX_LOCATION_CHARS)
    : file;
  const raw = boundedFile === "" ? line : line === "" ? boundedFile : `${boundedFile}:${line}`;
  return fenceInlineCode(escapeTableCell(raw.replace(/\s+/g, " ").trim()));
}

/**
 * The `### Findings (…)` section: one row per normalized still-open finding
 * — severity, `file:line` (or `file`, or blank), message — the same array
 * the verdict was decided on, so the body is the one place a reader sees the
 * whole set. Messages get redact_text, upstream-link neutralization,
 * whitespace collapse, a length cap, and table-cell escaping; a hostile
 * message cannot split the row or forge headings. Returns "" when there is
 * nothing to render.
 *
 * #1249: every model-controlled cell is BOUNDED — the severity label (≤
 * `FINDINGS_SUMMARY_MAX_SEVERITY_CHARS`), the location path (≤
 * `FINDINGS_SUMMARY_MAX_LOCATION_CHARS`, plus the line number), and the
 * message (≤ `FINDINGS_SUMMARY_MAX_MESSAGE_CHARS`). The caps apply to the
 * CONTENT, before table escaping expands it (two-fold for `\` and `|`,
 * five-fold for `&`/`<`/`>`), so a published cell is at most roughly five
 * times its cap and the published summary stays bounded even for a hostile
 * finding. The body-only native-review fallback publishes this summary, so
 * the bound is a published-surface contract, not this renderer's internals.
 * The per-severity counts ride in a heading line rather than a table cell, so
 * they are never table-escaped: no part of a finding's severity reaches that
 * line at all. The counts render the closed severity vocabulary only, and
 * every finding outside it is aggregated into one `N findings of unknown
 * severity` clause, so the heading's length is bounded by the vocabulary size
 * and the finding count — never by how many distinct severities a run
 * produced — and no severity can forge a count token or a clause there.
 *
 * #1283: the per-cell caps do not bound the summary AGGREGATE — a full table
 * of max-width rows still overruns the forge review-body limit and fails the
 * publication outright. So the whole returned block (counts heading, table
 * header, rows, and overflow disclosure) is capped at
 * `FINDINGS_SUMMARY_MAX_BYTES` UTF-8 bytes: rows past the byte budget are
 * dropped and disclosed in the same `_…and N more finding(s) not listed…_`
 * line the row overflow uses, with the size cause named. The worst-case
 * disclosure is reserved up front, so the bound holds for the exact string
 * returned — and the counts heading, which the block measurement includes,
 * is bounded by the same contract.
 *
 * Per-surface policy for the message cell (#975 / #988): the strict
 * published body (publish.ts) calls this with no opts, keeping the operator's
 * `upstream-link-mode` (linkMode) rendering verbatim; the step summary
 * (renderStepSummary) passes `messageAsInlineCode: true` and additionally
 * fences each non-empty message in a code span, so model-controlled Markdown
 * links/autolinks (e.g. `[x](https://evil.example)`) can never render
 * clickable. Maintainer review on PR #988 (head 43a0808); same fail-closed
 * rationale as `inlineCodeValue` (#903).
 */
export function renderFindingsSummary(
  findings: unknown,
  linkMode: UpstreamLinkMode,
  opts?: { messageAsInlineCode?: boolean },
): string {
  if (!Array.isArray(findings)) return "";
  const rows = findings.filter((item): item is Record<string, unknown> => isRecord(item));
  if (rows.length === 0) return "";
  const counts = severityCountsLabel(rows);
  const header = [
    `### Findings${counts ? ` (${counts})` : ""}`,
    "",
    "| Severity | Location | Finding |",
    "| --- | --- | --- |",
  ];
  // #1283: the rendered block is bounded in aggregate. Every row is admitted
  // only while the block still fits `FINDINGS_SUMMARY_MAX_BYTES` WITH room
  // reserved for the worst-case overflow disclosure (the long wording and the
  // largest possible omitted count, `rows.length`), so the byte bound holds
  // for the exact string returned here — including the counts heading, which
  // the same bound therefore measures.
  const reservedTailBytes = Buffer.byteLength(
    `\n\n_…and ${rows.length} more finding(s) not listed (summary truncated to fit the publish size limit)._\n`,
    "utf8",
  );
  // The closed-vocabulary heading and the reserved worst-case tail are a few
  // hundred bytes at most (the heading is bounded by #1249 and the omitted
  // count by log10(rows.length)), so the loop below can always admit at least
  // one row under the 32 KiB bound; the bound itself never depends on that.
  let usedBytes = Buffer.byteLength(`\n\n${header.join("\n")}`, "utf8");
  const rendered: string[] = [];
  for (const finding of rows.slice(0, FINDINGS_SUMMARY_MAX_ROWS)) {
    const rawSeverity = typeof finding.severity === "string" ? finding.severity : "info";
    const label = boundedSummaryToken(
      Object.hasOwn(SEVERITY_LABELS, rawSeverity) ? SEVERITY_LABELS[rawSeverity]! : rawSeverity,
      FINDINGS_SUMMARY_MAX_SEVERITY_CHARS,
    );
    const body = escapeTableCell(
      boundedSummaryToken(
        sanitizeMarkdown(redactText(String(finding.message ?? "")), linkMode),
        FINDINGS_SUMMARY_MAX_MESSAGE_CHARS,
      ),
    );
    // #988: fence only non-empty messages; an empty message stays an empty cell.
    const message = opts?.messageAsInlineCode === true && body !== "" ? fenceInlineCode(body) : body;
    const line = `| ${escapeTableCell(label)} | ${locationCell(finding)} | ${message} |`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (usedBytes + lineBytes + reservedTailBytes > FINDINGS_SUMMARY_MAX_BYTES) break;
    usedBytes += lineBytes;
    rendered.push(line);
  }
  const lines = [...header, ...rendered];
  const omitted = rows.length - rendered.length;
  if (omitted > 0) {
    // Disclose a byte-budget cut the way the row overflow already is, in the
    // same italic `_…and N more finding(s) not listed…_` line — with the size
    // cause visible so a reader never mistakes it for the ordinary row cap.
    const sizeTruncated = rendered.length < Math.min(rows.length, FINDINGS_SUMMARY_MAX_ROWS);
    lines.push("", sizeTruncated
      ? `_…and ${omitted} more finding(s) not listed (summary truncated to fit the publish size limit)._`
      : `_…and ${omitted} more finding(s) not listed._`);
  }
  return `\n\n${lines.join("\n")}\n`;
}

export const REVIEW_STEP_OUTPUT_IDS = [
  "verdict",
  "verdict-source",
  "required-checks",
  "review-result",
  "incomplete-reason",
  "review-route",
  "escalation-reason",
  "review-triage-decision",
  "review-triage-reason",
  "review-triage-routing",
  "confidence-status",
  "confidence-score",
  "confidence-risk",
  "confidence-reason",
  "confidence-model",
  "findings",
  "review-markdown",
  "analysis-engine",
  "tool-calls",
  "cache-hit-ratio",
] as const;

export type ReviewStepOutputId = (typeof REVIEW_STEP_OUTPUT_IDS)[number];

export type IncompleteReason = "none" | "execution" | "requirement_trace" | "both";
export const INCOMPLETE_REASON_VALUES: readonly IncompleteReason[] = ["none", "execution", "requirement_trace", "both"];
export function isIncompleteReason(value: unknown): value is IncompleteReason {
  return typeof value === "string" && INCOMPLETE_REASON_VALUES.includes(value as IncompleteReason);
}

export interface ReviewStepOutputs {
  verdict: string;
  /** #978: this verdict is eligible for the fail-on-request-changes bypass.
   * Read in-process by the gate and marker carry-forward; deliberately NOT a
   * published output id. */
  degradedGateBypass: boolean;
  verdictSource: string;
  requiredChecks: string;
  /** #873: the metadata marker's review_result state (clean/findings/
   * partial/issues) — additive; verdict's own value set is unchanged, so
   * a partial review still reports verdict "approve" here and the
   * incompleteness surfaces only through this field. */
  reviewResult: string;
  /** #954: why coverage is incomplete; "none" when complete. */
  incompleteReason: string;
  reviewRoute: string;
  escalationReason: string;
  /** #1003: the human-review triage decision — one of "not_required",
   * "required", "unknown" — or "" when `review-triage` is disabled. "" means
   * "did not run", which is deliberately distinct from the fail-closed
   * "unknown" answer. */
  reviewTriageDecision: string;
  /** #1003: the triage reason (possibly "" when the model gave none), or ""
   * when triage is disabled. */
  reviewTriageReason: string;
  /** #1005: the deterministic reviewer-routing status — one of the
   * non-`off` statuses — or "" when review-triage or review-triage-routing is
   * off ("routing did not run"). Never model text. */
  reviewTriageRouting: string;
  /** #1073: the confidence scorer's outputs, all "" when the scorer is
   * disabled (`ai-confidence-model` empty) — never a spurious `0`. Optional
   * in the type only so legacy literal callers keep compiling; the run
   * always populates all five. */
  confidenceStatus?: string;
  confidenceScore?: string;
  confidenceRisk?: string;
  confidenceReason?: string;
  confidenceModel?: string;
  /** #1337: deterministic dependency-coverage rollup
   * ("complete | partial | unavailable (N/5 aspects checked)"), or ""
   * when the model never emitted a `dependency_coverage` answer. Not a
   * public step-output id: it surfaces in the step summary and the
   * metadata marker only. */
  dependencyCoverageStatus?: string;
  /** Compact JSON array of the normalized findings. */
  findings: string;
  /** Full review markdown (model-controlled text). */
  reviewMarkdown: string;
  analysisEngine: string;
  /** Compact JSON array of {tier, tool, status} records. */
  toolCalls: string;
  /** "-" when the tool harness reported no ratio. */
  cacheHitRatio: string;
}

/** 16 random bytes as hex — the same entropy the v2 writer draws. */
function randomDelimiterSuffix(randomBytes: () => Uint8Array): string {
  return Array.from(randomBytes(), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Format one `KEY=value` assignment. Single-line values are written
 * directly; values containing newlines use a random `EOF_<hex>` delimiter
 * (never derived from the value — a model-chosen delimiter could otherwise
 * close its own assignment and inject following outputs).
 */
export function formatOutputAssignment(
  key: string,
  value: string,
  randomBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): string {
  if (!value.includes("\n")) {
    return `${key}=${value}\n`;
  }
  const delimiter = `EOF_${randomDelimiterSuffix(randomBytes)}`;
  return `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
}

const CONFIDENCE_RISK_OUTPUT_VALUES = ["low", "medium", "high", "critical", "unknown"] as const;

/** #1073: the five `confidence-*` output assignments, fail-closed at the
 * output boundary: only the exact literals `scored`/`unscored` are written,
 * the integer only for a scored answer, the risk only from the closed enum
 * (including its documented `unknown` member — a scored answer whose risk
 * band was not recognized still reports `unknown`, never the empty value
 * reserved for a disabled scorer), and the model-authored reason always
 * redacted. Disabled/absent → all "". */
function confidenceAssignments(outputs: Omit<ReviewStepOutputs, "degradedGateBypass">): Array<[string, string]> {
  const status = outputs.confidenceStatus === "scored" || outputs.confidenceStatus === "unscored"
    ? outputs.confidenceStatus
    : "";
  const score = status === "scored" && /^[0-5]$/.test(outputs.confidenceScore ?? "")
    ? outputs.confidenceScore!
    : "";
  const risk = status === "unscored"
    ? "unknown"
    : status === "scored" && (CONFIDENCE_RISK_OUTPUT_VALUES as readonly string[]).includes(outputs.confidenceRisk ?? "")
      ? outputs.confidenceRisk!
      : "";
  return [
    ["confidence-status", status],
    ["confidence-score", score],
    ["confidence-risk", risk],
    ["confidence-reason", status === "scored" ? redactText(outputs.confidenceReason ?? "") : ""],
    ["confidence-model", status === "" ? "" : (outputs.confidenceModel ?? "").slice(0, 200)],
  ];
}

/** Serialize all review-step outputs in contract order. The assignment keys
 * are derived from `REVIEW_STEP_OUTPUT_IDS` so the constant and the writer
 * cannot drift apart. */
export function formatReviewStepOutputs(
  outputs: Omit<ReviewStepOutputs, "degradedGateBypass">,
  randomBytes?: () => Uint8Array,
): string {
  // #1269: `redactText` runs LAST on this field, and masking can COMPLETE a
  // half-written cap-note look-alike at the trailing edge (the #1268 class),
  // so the reveal strip re-runs terminal to the redaction — this step output
  // never ends in a note-shaped span either. The decision is re-resolved
  // against the same stripped text the output carries.
  const triageReason = stripRevealedCapNoteTails(redactText(outputs.reviewTriageReason));
  // #1003: re-resolve rather than trust the caller, so an unsubstantiated
  // `not_required` (or any non-literal decision) can never be written as a
  // public step output. "" means triage did not run and stays "".
  const triageDecision = outputs.reviewTriageDecision === ""
    ? ""
    : resolveReviewTriageDecision(outputs.reviewTriageDecision, triageReason);
  const assignments: Array<[string, string]> = [
    ["verdict", outputs.verdict],
    ["verdict-source", outputs.verdictSource],
    ["required-checks", outputs.requiredChecks],
    ["review-result", outputs.reviewResult],
    ["incomplete-reason", outputs.incompleteReason],
    ["review-route", outputs.reviewRoute],
    ["escalation-reason", outputs.escalationReason],
    // #1003: triage telemetry. The decision is re-resolved above, and the
    // reason is model-authored text, so it takes the same redaction as
    // review-markdown/findings — a public step output must never carry raw
    // credentials.
    ["review-triage-decision", triageDecision],
    ["review-triage-reason", triageReason],
    // #1005: the routing status is a closed action-owned token; re-validate it
    // here so a carried-forward or hand-edited value can never be written as a
    // public output. "" means routing did not run and stays "".
    ["review-triage-routing", isHumanReviewRoutingStatus(outputs.reviewTriageRouting) ? outputs.reviewTriageRouting : ""],
    // #1073: the confidence scorer's outputs, fail-closed at this boundary
    // like every other closed-vocabulary field: "" (disabled) stays "",
    // `scored`/`unscored` pass, anything else is dropped. The integer is
    // written ONLY for a scored answer (never a spurious 0), the reason is
    // model-authored text and takes the same redaction as the other public
    // model-text outputs.
    ...confidenceAssignments(outputs),
    // Models echo diff lines; the public step output must not carry raw credentials; redactText is idempotent with the publish boundary.
    ["review-markdown", redactText(outputs.reviewMarkdown)],
    ["findings", redactText(outputs.findings)],
    ["tool-calls", outputs.toolCalls],
    ["cache-hit-ratio", outputs.cacheHitRatio],
    ["analysis-engine", outputs.analysisEngine],
  ];
  const declared = new Set<string>(REVIEW_STEP_OUTPUT_IDS);
  for (const [key] of assignments) {
    if (!declared.has(key)) {
      throw new Error(`review step output '${key}' is not in the declared contract IDs`);
    }
  }
  return assignments.map(([key, value]) => formatOutputAssignment(key, value, randomBytes)).join("");
}

/** One {tier, tool, status} tool-call record (the compact output surface). */
export interface ToolCallRecord {
  tier: "primary" | "smart";
  tool: string;
  status: string;
}

/**
 * Build the compact tool-trace output from the harness telemetry: which
 * read-only tools ran, without copying model-controlled arguments into
 * action outputs. Primary calls come first, then smart-tier calls.
 */
export function buildToolCallsOutput(
  primaryHarness: unknown,
  smartHarness: unknown,
): string {
  const records: ToolCallRecord[] = [];
  const collect = (harness: unknown, tier: "primary" | "smart"): void => {
    const calls = (harness as { tool_calls?: unknown } | null)?.tool_calls;
    if (!Array.isArray(calls)) return;
    for (const call of calls) {
      const record = call as { tool?: unknown; status?: unknown };
      if (typeof record?.tool !== "string") continue;
      records.push({ tier, tool: record.tool, status: String(record.status ?? "") });
    }
  };
  collect(primaryHarness, "primary");
  collect(smartHarness, "smart");
  return JSON.stringify(records);
}

/** Cache-hit-ratio step output: "-" when the harness reported nothing. */
export function buildCacheHitRatioOutput(primaryHarness: unknown): string {
  const ratio = (primaryHarness as { usage?: { cache_hit_ratio?: unknown } } | null)
    ?.usage?.cache_hit_ratio;
  return ratio === undefined || ratio === null ? "-" : String(ratio);
}

// ---------------------------------------------------------------------------
// Step summary
// ---------------------------------------------------------------------------

export interface HarnessSummaryTelemetry {
  executedRequestCount?: number;
  successfulToolCalls?: number;
  rounds?: number;
  stopReason?: string;
  /** Smart-tier extras (rendered only for the smart harness row). */
  issuedToolCalls?: number;
  requests?: number;
  verdictStatus?: string;
  fallback?: string;
  /** #702 tool-loop telemetry. */
  budget?: {
    route: string;
    used: number;
    effectiveMaxRequests: string;
    source: string;
    stopReason: string;
    remainingAtStop: string;
  };
}

export interface StepSummaryTelemetry {
  analysisEngine: string;
  verdict: string;
  verdictSource: string;
  findingsCount: number;
  blockersCount: number;
  requiredChecksStatus: string;
  /** #975: normalized still-open findings rendered as a table below the
   * counts row; empty/absent renders nothing (byte-identical to the v2 table). */
  findings?: unknown;
  /** #975: upstream-link neutralization for finding messages, mirroring the
   * strict publish body's link mode. The step summary additionally fences each
   * non-empty message cell in an inline-code span (see `renderFindingsSummary`)
   * so model-controlled Markdown links/autolinks can never render clickable on
   * this surface, independent of the link-mode choice. */
  upstreamLinkMode?: UpstreamLinkMode;
  requirementCoverage?: { total: number; unknown: number };
  primaryTools: HarnessSummaryTelemetry;
  smartTools?: HarnessSummaryTelemetry;
  nativeVerdict?: {
    status: string;
    transport?: string;
    attempts: number;
    retried: boolean;
    reason?: string;
    /** #1047: bounded failure-shape line (content-free) for a verdict turn
     * that produced no usable body — `class=… profile=… …`. */
    diagnostics?: string;
    /** #1047: the raised completion budget the single retry used, when the
     * failure shape justified one. */
    budgetRaisedTo?: number;
  };
  route: string;
  routeReason?: string;
  /** #1003: human-review triage telemetry, supplied only when triage
   * actually ran (`review-triage` enabled) — absent renders no row, so a
   * disabled run's summary is byte-identical to pre-#1003. `unknown` is a
   * real answer and renders like any other: the point of failing closed is
   * that the gap is visible, not silently reported as "not required". */
  reviewTriage?: { decision: string; reason: string };
  /** #1005: reviewer-routing telemetry, supplied only when routing ran
   * (mode != off) — absent renders no row. All action-owned/trusted-config
   * values, never model text. */
  reviewRouting?: { status: string; targetIds: string[]; users: string[]; teams: string[] };
  /** #1073: the independent confidence scorer's telemetry, supplied only
   * when the scorer ran (`ai-confidence-model` set) — absent renders no
   * row, so a disabled run's summary is byte-identical to pre-#1073. */
  confidence?: { status: string; score: string; risk: string; reason: string; model: string };
  /** #1337: dependency-upgrade coverage rollup ("complete | partial |
   * unavailable (N/5 aspects checked)"), supplied only when the model
   * emitted a `dependency_coverage` answer — absent renders no row. */
  dependencyCoverage?: string;
  /** #633 deep-review telemetry row (rendered only when deep review ran). */
  deepReview?: { leads: string; errors: boolean; autoSelection?: { selected: number; skipped: number } };
  budget: string;
  finalContext: string;
  primaryContext?: string;
  diffBytes: { actual: string; truncated: string };
  corpusBytes: { actual: string; truncated: string };
  promptTokens: string;
  completionTokens: string;
  cacheHitRatio: string;
}

/** Render the `### AI PR Review` step-summary table (v2 row structure). */
export function renderStepSummary(telemetry: StepSummaryTelemetry): string {
  const rows: string[] = [
    "| Engine | " + telemetry.analysisEngine + " |",
    `| Verdict | ${telemetry.verdict} (source: ${telemetry.verdictSource}) |`,
    `| Findings | ${telemetry.findingsCount} (blockers: ${telemetry.blockersCount}) |`,
    `| Required checks | ${telemetry.requiredChecksStatus} |`,
  ];
  if (telemetry.requirementCoverage && telemetry.requirementCoverage.total !== 0) {
    rows.push(`| Requirement coverage | ${telemetry.requirementCoverage.total} requirement(s); unresolved: ${telemetry.requirementCoverage.unknown} |`);
  }
  if (telemetry.dependencyCoverage !== undefined && telemetry.dependencyCoverage !== "") {
    rows.push(`| Dependency coverage | ${telemetry.dependencyCoverage} |`);
  }
  const primary = telemetry.primaryTools;
  rows.push(
    `| Primary tools | ${primary.executedRequestCount ?? 0} executed (${primary.successfulToolCalls ?? 0} successful); rounds: ${primary.rounds ?? 0}; stop: ${primary.stopReason ?? "disabled"} |`,
  );
  if (telemetry.smartTools) {
    const smart = telemetry.smartTools;
    rows.push(
      `| Smart tools | ${smart.issuedToolCalls ?? 0} issued; rounds: ${smart.rounds ?? 0}; requests: ${smart.requests ?? 0}; stop: ${smart.stopReason ?? "unknown"}; verdict: ${smart.verdictStatus ?? "corpus"}; fallback: ${smart.fallback ?? "unknown"} |`,
    );
  }
  if (telemetry.nativeVerdict) {
    let row = `| Native verdict | ${telemetry.nativeVerdict.status}`;
    if (telemetry.nativeVerdict.transport) {
      row += ` via ${telemetry.nativeVerdict.transport}`;
    }
    row += ` (attempts: ${telemetry.nativeVerdict.attempts}, retried: ${telemetry.nativeVerdict.retried}`;
    if (telemetry.nativeVerdict.reason) {
      row += `, reason: ${telemetry.nativeVerdict.reason}`;
    }
    if (telemetry.nativeVerdict.budgetRaisedTo !== undefined) {
      row += `, budget raised to ${telemetry.nativeVerdict.budgetRaisedTo}`;
    }
    row += ")";
    if (telemetry.nativeVerdict.diagnostics) {
      row += ` — ${telemetry.nativeVerdict.diagnostics}`;
    }
    row += " |";
    rows.push(row);
  }
  rows.push(`| Route | ${telemetry.route} (${telemetry.routeReason ?? ""}) |`);
  // #1003: compact one-row triage summary, rendered only when triage ran.
  if (telemetry.reviewTriage) {
    // Model-authored reason: redact, flatten to one cell, and escape pipes so
    // a hostile string cannot forge a row (same discipline as the findings
    // table's message cell). Capped at the same 300 characters as the
    // published-body section so one answer reads identically on both.
    // #1269: the triage reason never carries an action-owned cap note, so the
    // confidence module's reveal strip runs UNCONDITIONALLY after this cut —
    // the row never ends in a model-authored `[deterministic cap: …]`
    // look-alike the cut revealed.
    const stripped = stripRevealedCapNoteTails(
      redactText(telemetry.reviewTriage.reason).replace(/\s+/g, " ").trim().slice(0, MAX_REVIEW_TRIAGE_REASON_CHARS),
    );
    // The decision is re-resolved here rather than trusted: this summary is
    // a public surface, so a carried-forward or hand-edited value — including
    // an unsubstantiated `not_required` — must fail closed to `unknown`,
    // exactly as the parser and the publish body do. Re-resolved against the
    // STRIPPED reason, so a look-alike-only substantiation fails closed here
    // too (#1269).
    const decision = resolveReviewTriageDecision(telemetry.reviewTriage.decision, stripped);
    const reason = escapeTableCell(stripped);
    rows.push(`| Review triage | ${decision}${reason === "" ? "" : `: ${reason}`} (advisory only) |`);
  }
  // #1005: compact one-row routing summary, rendered only when routing ran.
  // Every value is action-owned or trusted-config; model text never appears.
  if (telemetry.reviewRouting) {
    const routing = telemetry.reviewRouting;
    const targets = routing.targetIds.length > 0 ? ` target(s): ${escapeTableCell(routing.targetIds.join(", "))}` : "";
    const resolved: string[] = [];
    if (routing.users.length > 0) resolved.push(`users: ${escapeTableCell(routing.users.join(", "))}`);
    if (routing.teams.length > 0) resolved.push(`teams: ${escapeTableCell(routing.teams.join(", "))}`);
    const reviewers = resolved.length > 0 ? `; ${resolved.join("; ")}` : "";
    rows.push(`| Reviewer routing | ${escapeTableCell(routing.status)}${targets}${reviewers} |`);
  }
  // #1073: compact one-row confidence summary, rendered only when the scorer
  // ran. The reason is model-authored: redacted, flattened, capped and
  // pipe-escaped exactly like the triage reason.
  if (telemetry.confidence) {
    const confidence = telemetry.confidence;
    const reason = escapeTableCell(
      publishedConfidenceReason(redactText(confidence.reason)),
    );
    let value: string;
    if (confidence.status === "scored" && /^[0-5]$/.test(confidence.score)) {
      value = `scored ${confidence.score}/5, risk: ${escapeTableCell(confidence.risk || "unknown")}`;
    } else if (confidence.status === "unscored") {
      value = "unscored";
    } else {
      value = escapeTableCell(confidence.status);
    }
    if (confidence.model !== "") {
      value += ` (model: ${escapeTableCell(confidence.model)})`;
    }
    if (reason !== "") {
      value += ` — ${reason}`;
    }
    rows.push(`| Independent confidence | ${value} (advisory only) |`);
  }
  const budgetRows: string[] = [];
  for (const harness of [telemetry.primaryTools, telemetry.smartTools]) {
    const budget = harness?.budget;
    if (!budget) continue;
    budgetRows.push(
      `${budget.route}: ${budget.used}/${budget.effectiveMaxRequests} requests (${budget.source}), stop: ${budget.stopReason}, left ${budget.remainingAtStop}`,
    );
  }
  if (budgetRows.length > 0) {
    rows.push(`| Tool budget | ${budgetRows.join("; ")} |`);
  }
  if (telemetry.deepReview) {
    let detail = "";
    if (telemetry.deepReview.autoSelection) {
      detail = ` (auto: ${telemetry.deepReview.autoSelection.selected} role(s) selected, ${telemetry.deepReview.autoSelection.skipped} skipped)`;
    }
    if (telemetry.deepReview.errors) {
      rows.push(`| Deep review | ${telemetry.deepReview.leads} specialist lead(s)${detail}; some roles recorded errors (advisory only) |`);
    } else {
      rows.push(`| Deep review | ${telemetry.deepReview.leads} specialist lead(s)${detail} (advisory only) |`);
    }
  }
  rows.push(`| Budget | ${telemetry.budget} |`);
  rows.push(`| Final context | ${telemetry.finalContext} |`);
  if (telemetry.primaryContext) {
    rows.push(`| Primary context | ${telemetry.primaryContext} |`);
  }
  rows.push(`| Diff bytes | ${telemetry.diffBytes.actual} (truncated: ${telemetry.diffBytes.truncated}) |`);
  rows.push(`| Corpus bytes | ${telemetry.corpusBytes.actual} (truncated: ${telemetry.corpusBytes.truncated}) |`);
  rows.push(`| Prompt tokens | ${telemetry.promptTokens} |`);
  if (telemetry.cacheHitRatio !== "-") {
    rows.push(`| Cache hit ratio | ${telemetry.cacheHitRatio} |`);
  }
  rows.push(`| Completion tokens | ${telemetry.completionTokens} |`);

  const lines = ["### AI PR Review", "", "| Field | Value |", "| --- | --- |", ...rows, ""];
  const block = renderFindingsSummary(telemetry.findings ?? [], telemetry.upstreamLinkMode ?? "inert", { messageAsInlineCode: true });
  return lines.join("\n") + block;
}
