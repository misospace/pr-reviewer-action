/** Inline finding anchoring port of `scripts/build_review_comments.py` (#680).
 * The diff walk preserves both final-file lines and patch-relative positions so
 * GitHub and Forgejo publish the same validated findings. */
import { createHash } from "node:crypto";
import { redactText } from "../context/redact.js";
import { reserveSuggestionOpeners } from "../metadata/markers.js";
import { sanitizeMarkdown } from "./sanitize.js";

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
/** Exported for the outside-diff summary renderer (v3-only, `../enforcement/outside-diff.js`
 * pairs it with `diffPositions` below) so severity labels never drift between the
 * two finding-rendering call sites. */
export const SEVERITY_LABELS: Record<string, string> = {
  blocker: "🛑 Blocker",
  major: "⚠️ Major",
  minor: "Minor",
  info: "Info",
};

type PositionMap = Map<string, Map<number, number>>;
type Finding = Record<string, unknown>;

/** The per-comment disclaimer every inline finding body carries. Exported so
 * the usefulness-feedback recovery can prove a comment is one of ours before
 * it reads a prescription out of it. */
export const INLINE_DISCLAIMER = "_Automated finding from AI PR review._";

/** #762: the single static usefulness affordance appended to an actionable
 * finding. Static text only — never model-authored, so no finding text can
 * forge or extend it — and advisory by construction: a reaction is telemetry
 * and can never resolve a finding or change this review's verdict. Appended
 * only where a replacement block was actually rendered, exactly once. */
export const FEEDBACK_AFFORDANCE =
  "👍 helpful · 👎 not helpful — advisory only; it never changes this review's verdict.";

/** #762: the correlation key for "this exact prescription at this exact
 * published range". The range — not a single line — is part of the key because
 * a multi-line prescription is published anchored at its END line: keying on
 * one line would let a rejection of a 1-2 range silently drop a different,
 * single-line-at-2 prescription with the same text. Serialized as a JSON
 * array: quoting neutralizes the array's own separators and escaping
 * neutralizes NUL, so the encoding is injective over these four fields and no
 * path, line, or replacement text can be arranged to collide with another key.
 *
 * #1119: the previous bare-NUL join was forgeable — `replacement` is model
 * text and `redactText` does not filter NUL, so a NUL-bearing value could
 * shift a field boundary and land on another key. Re-keying changes every
 * `prescriptionKeyDigest`, so rejection-carry markers published by earlier
 * versions no longer match and previously-👎-rejected prescriptions may be
 * re-suggested once after upgrade; the new digests re-establish from that run
 * on. Accepted one-time self-healing reset — no legacy-digest path. */
export function prescriptionKey(path: string, rangeStart: number, rangeEnd: number, replacement: string): string {
  return JSON.stringify([path, rangeStart, rangeEnd, replacement]);
}

/** #762 (review round: durable suppression): the rejection memory must outlive
 * the comment the trusted 👎 landed on, because cleanup retires that comment.
 * The memory travels as the SHA-256 digest of the prescription key — never the
 * replacement text (which can carry content resembling secrets) and never any
 * forgeable identity claim — embedded in the replacement comment this action
 * publishes as a hidden single-line HTML carry marker. */
export function prescriptionKeyDigest(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** #762: carry-marker grammar. One line: the exact prefix, then a
 * comma-separated run of tokens that are EACH exactly 64 lowercase hex chars,
 * then the exact HTML comment close. Nothing else is the grammar — a
 * 63/65-char token, an uppercase one, a list with one bad token, or any
 * trailing text is ordinary content, not state.
 *
 * This is the ONE predicate `parseRejectionCarryover` and
 * `stripRejectionCarryover` both run, so the two can never disagree: a line
 * is either stripped from publication AND parseable, or retained in
 * publication AND unparseable. A near-miss line therefore survives verbatim
 * into our own comment (fail-open, no state smuggled) while a line the parser
 * honors can never linger as content a model dressed up as grammar. A forged
 * canonical copy can only name digests, whose one and only effect is
 * withholding a replacement block, so the marker cannot inject content,
 * promote itself, or change a verdict. */
const CARRYOVER_LINE_RE = /^<!-- pr-reviewer:rejected-prescriptions:v1:((?:[0-9a-f]{64})(?:,[0-9a-f]{64})*) -->$/;
const CARRYOVER_DIGEST_RE = /^[0-9a-f]{64}$/;

/** #762: upper bounds on carry-marker content per comment and per run's read. */
export const MAX_CARRYOVER_KEYS_PER_COMMENT = 64;
export const MAX_CARRYOVER_KEYS_PER_RUN = 256;

/** #762: render the carry marker for the digests a suppressed prescription
 * leaves behind, or "" when there is nothing to carry. */
export function renderRejectionCarryover(digests: readonly string[]): string {
  const kept = digests.slice(0, MAX_CARRYOVER_KEYS_PER_COMMENT);
  if (kept.length === 0) return "";
  return `\n\n<!-- pr-reviewer:rejected-prescriptions:v1:${kept.join(",")} -->`;
}

/** #762: recover the carry digests from a previously published comment body.
 * Only a standalone line matching the exact canonical grammar
 * (`CARRYOVER_LINE_RE`, the same predicate the strip runs) counts; duplicates
 * collapse and the per-comment cap binds, so a hostile body cannot bloat or
 * spoof the set beyond naming digests. */
export function parseRejectionCarryover(body: string): string[] {
  if (typeof body !== "string" || !body.includes("pr-reviewer:rejected-prescriptions:v1:")) return [];
  const found: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = CARRYOVER_LINE_RE.exec(line);
    if (match === null) continue;
    for (const token of match[1]!.split(",")) {
      if (!CARRYOVER_DIGEST_RE.test(token)) continue;
      if (!found.includes(token)) found.push(token);
      if (found.length >= MAX_CARRYOVER_KEYS_PER_COMMENT) return found;
    }
  }
  return found;
}

/** #762: remove any carry-marker line from a body — the marker is this action's
 * machine state, never finding content, so message extraction must not see it
 * (same rule as the disclaimer trailer and the usefulness affordance).
 *
 * Shared grammar with `parseRejectionCarryover` by construction: a stripped
 * line is one the parser honors, and a line the parser would refuse (a
 * near-miss) stays in the body as ordinary content. */
export function stripRejectionCarryover(body: string): string {
  if (!body.includes("pr-reviewer:rejected-prescriptions:v1:")) return body;
  return body
    .split("\n")
    .filter((rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      return CARRYOVER_LINE_RE.exec(line) === null;
    })
    .join("\n");
}

/** Verbatim diff-position walk from `scripts/build_review_comments.py` (#680). */
export function diffPositions(diffText: string): PositionMap {
  const positionsByPath: PositionMap = new Map();
  let currentPath: string | null = null;
  let newLine = 0;
  let diffPosition = 0;
  let inHunk = false;

  const lines = diffText === "" ? [] : diffText.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "" && /(?:\r\n|\n|\r)$/.test(diffText)) lines.pop();
  for (const raw of lines) {
    if (raw.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      diffPosition = 0;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      currentPath = target === "/dev/null" ? null : target.startsWith("b/") ? target.slice(2) : target;
      continue;
    }
    const match = HUNK_RE.exec(raw);
    if (match) {
      newLine = Number.parseInt(match[1]!, 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentPath === null || raw.startsWith("\\")) continue;

    diffPosition += 1;
    let map = positionsByPath.get(currentPath);
    if (raw.startsWith("+")) {
      if (!map) positionsByPath.set(currentPath, (map = new Map()));
      map.set(newLine, diffPosition);
      newLine += 1;
    } else if (!raw.startsWith("-")) {
      if (!map) positionsByPath.set(currentPath, (map = new Map()));
      map.set(newLine, diffPosition);
      newLine += 1;
    }
  }
  return positionsByPath;
}

/** Render one finding using the v2 label, redaction, and markdown boundaries (#561).
 *
 * #1107: every model-authored string is reserved twice on purpose. Before
 * assembly, so a fence the model wrote stays line-initial inside its own field
 * and is caught there rather than only after this function's own `**label:** `
 * prefix has been glued onto its front (which would leave the token sitting
 * where a later template edit could make it live). After assembly, because the
 * transforms ahead of it delete text — a reserved marker stripped next to a
 * fence, or a message that reads as a suggestion only once redaction has
 * rewritten part of its line — and either can leave a live one-click
 * prescription this run never validated. Nothing appended after this point can
 * hold a fence. A finding without the token renders byte-identically. */
export function findingToBody(finding: Finding, linkMode: string): string {
  const severity = finding.severity || "info";
  const rawSeverity = String(severity);
  const label = Object.hasOwn(SEVERITY_LABELS, rawSeverity) ? SEVERITY_LABELS[rawSeverity]! : rawSeverity;
  const category = finding.category;
  const suffix = category && category !== "other" ? ` (${String(category)})` : "";
  const message = reserveSuggestionOpeners(String(finding.message || "").trim());
  const body = `**${reserveSuggestionOpeners(label)}${reserveSuggestionOpeners(suffix)}:** ${message}\n\n${INLINE_DISCLAIMER}`;
  const mode = linkMode === "inert" || linkMode === "togithub" ? linkMode : "inert";
  return reserveSuggestionOpeners(sanitizeMarkdown(redactText(body), mode));
}

function isRecord(value: unknown): value is Finding {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

/** #762: the validated one-click suggestion action for a comment. */
export type Actionable = { start: number; end: number; replacement: string };

/** #762: longest run of consecutive backticks in *content* (0 when none) —
 * the fence length must outlast it so no inner run can close the block.
 * #1107 review round: reservation escapes a dissolved block's fence
 * characters ("\`\`\`"); such a line can never close a fence, but it still
 * reads as a run of backticks, so measure escaped backticks as the runs they
 * render as and keep the wrap strictly longer than anything the content
 * shows. */
function longestBacktickRun(content: string): number {
  const visible = content.replace(/\\`/g, "`");
  let longest = 0;
  let run = 0;
  for (const ch of visible) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** #762: wrap *content* in a backtick fence of `max(3, longestRun + 1)`
 * backticks so any inner backtick run cannot break out of the fence. */
function wrapFence(content: string, lang = ""): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(content) + 1));
  return `${fence}${lang}\n${content}\n${fence}`;
}

/** #762: the trailing-newline trim a suggestion is rendered with, so a
 * published prescription and the rejection key describing it carry the same
 * text. */
export function normalizedReplacement(suggestion: string): string {
  return suggestion.replace(/[\r\n]+$/, "");
}

/** #1107: the publishable one-click prescription this finding carries, or null
 * when publication would render none: `suggestion` absent/blank,
 * fence-hostile (any line whose trim() begins with 3+ backticks or 3+ tildes),
 * or a [start..end_line] range not fully presentable in the diff. The anchor
 * line is already validated by the caller's existing anchor check.
 *
 * THE single predicate: `buildComments` renders a prescription exactly when it
 * returns non-null, and the usefulness-feedback pre-check
 * (`hasPublishablePrescription`) asks the same question through the same
 * function, so the pre-check cannot drift weaker than publication and spend
 * reads on prescriptions that cannot exist.
 *
 * The replacement is made marker-free HERE, before it is digested, rendered,
 * or recovered: the suppression digest must describe exactly the text the
 * published fence carries, or a later run recomputes it from the published
 * (marker-free) body and fails to suppress the prescription it did reject.
 * It is derived normalized -> stripped -> normalized so the emptiness
 * predicate is the SAME one `recoverPublishedSuggestion` applies to a
 * published body: stripping a marker line out of `<marker>\n\n\n<marker>`
 * leaves whitespace, which is not `""`, so an un-re-normalized replacement
 * would publish a content-free ```suggestion block (with the affordance) that
 * recovery can never find again. Stripping to nothing drops the action
 * entirely — no replacement block, no affordance, no digest to misdescribe
 * one. */
export function publishablePrescription(rec: Finding, line: number, pathPositions: Map<number, number>): Actionable | null {
  if (typeof rec.suggestion !== "string") return null;
  const replacement = normalizedReplacement(stripRejectionCarryover(normalizedReplacement(rec.suggestion)));
  if (replacement === "") return null;
  for (const suggestionLine of replacement.split("\n")) {
    if (/^(`{3,}|~{3,})/.test(suggestionLine.trim())) return null;
  }
  let end = line;
  const endLine = rec.end_line;
  if (typeof endLine === "number" && Number.isInteger(endLine) && endLine > 0 && endLine >= line) {
    for (let candidate = line; candidate <= endLine; candidate += 1) {
      if (!pathPositions.has(candidate)) return null;
    }
    end = endLine;
  }
  return { start: line, end, replacement };
}

/** #1107: the anchor a finding needs to be commented at all, or null for every
 * finding `buildComments` skips. Both the publish loop and the feedback
 * pre-check run this one predicate, so neither can answer for a finding the
 * other would drop. */
interface CommentAnchor {
  path: string;
  line: number;
  pathPositions: Map<number, number>;
}

function commentAnchor(value: Finding, positions: PositionMap): CommentAnchor | null {
  if (value.thread_id) return null;
  const path = value.file;
  const line = value.line;
  if (!safePath(path) || typeof line !== "number" || !Number.isInteger(line) || line <= 0) return null;
  const pathPositions = positions.get(path);
  if (!pathPositions?.has(line)) return null;
  return { path, line, pathPositions };
}

/** #1107: whether this finding set contains a prescription publication would
 * actually render — the usefulness-feedback pre-check's question, asked through
 * exactly the predicates publication uses (`commentAnchor` +
 * `publishablePrescription`). A false answer means the feedback read, and every
 * forge request behind it, has nothing it could ever correlate, so it never
 * runs: a fence-hostile, out-of-range, marker-stripped-to-nothing, or blank
 * `suggestion` costs no `listReviews`, no reaction read, and no permission
 * lookup.
 *
 * Deliberately NOT bounded by `maxComments`: that cap is a publication-volume
 * policy applied after the findings that carry prescriptions are known, and
 * mirroring it here would duplicate its semantics for a read this action would
 * merely waste. The bound is fail-open on cost only — it can never change a
 * suppression decision. */
export function hasPublishablePrescription(findings: unknown, diffText: string): boolean {
  if (!Array.isArray(findings)) return false;
  const positions = diffPositions(diffText);
  for (const value of findings) {
    if (!isRecord(value)) continue;
    const anchor = commentAnchor(value, positions);
    if (anchor === null) continue;
    if (publishablePrescription(value, anchor.line, anchor.pathPositions) !== null) return true;
  }
  return false;
}

/** #762: the one-click suggestion region this module writes — a blank line, a
 * ````suggestion` opener, the replacement, and a lone ````` terminator. */
const SUGGESTION_OPENER = "```suggestion";
const FENCE_TERMINATOR = "```";

/** #762: recover the replacement a previously published comment of ours
 * carried, or null when it carries none that can be recovered unambiguously.
 * Only this module's own region is read, and only when the body still carries
 * our disclaimer: `publishablePrescription` refuses any replacement line whose
 * trim starts with three backticks or tildes, so no inner lone fence line can
 * exist and the terminator is unambiguous. Zero or several openers, a missing
 * terminator, and a blank replacement all mean "no prior prescription" — the
 * caller then posts the current one.
 *
 * #1107: "several openers" can no longer be reached through model prose — every
 * model-authored surface reserves the opener before assembly — so the ambiguous
 * read stays a defensive branch and cannot become the fail-open path a second
 * opener used to open. */
export function recoverPublishedSuggestion(body: string): string | null {
  if (typeof body !== "string" || !body.includes(INLINE_DISCLAIMER)) return null;
  const lines = body.split("\n");
  let opener = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] !== SUGGESTION_OPENER || index === 0 || lines[index - 1] !== "") continue;
    if (opener !== -1) return null;
    opener = index;
  }
  if (opener === -1) return null;
  let end = -1;
  for (let index = opener + 1; index < lines.length; index += 1) {
    if (lines[index] === FENCE_TERMINATOR) { end = index; break; }
  }
  if (end === -1) return null;
  const replacement = lines.slice(opener + 1, end).join("\n");
  return normalizedReplacement(replacement) === "" ? null : replacement;
}

/** Build anchorable comments; thread-backed findings are deduplicated (#766). */
export function buildComments(
  findings: unknown,
  diffText: string,
  maxComments: number,
  opts: { forgejoPositions: boolean; linkMode?: string; rejectedPrescriptions?: ReadonlySet<string> },
): { comments: unknown[]; skipped: number; suppressed: number } {
  if (!Array.isArray(findings)) return { comments: [], skipped: 0, suppressed: 0 };
  const positions = diffPositions(diffText);
  // #762: same inert/togithub normalization `findingToBody` applies.
  const mode = opts.linkMode === "inert" || opts.linkMode === "togithub" ? opts.linkMode : "inert";
  const comments: unknown[] = [];
  let skipped = 0;
  let suppressed = 0;
  for (const value of findings) {
    if (!isRecord(value)) { skipped += 1; continue; }
    // #1107: one anchor predicate, shared with the usefulness-feedback pre-check.
    const anchor = commentAnchor(value, positions);
    if (anchor === null) { skipped += 1; continue; }
    const { path, line, pathPositions } = anchor;
    let body = findingToBody(value, opts.linkMode ?? "inert");
    const comment: Record<string, unknown> = { path, body };
    if (opts.forgejoPositions) comment.new_position = pathPositions.get(line)!;
    else { comment.line = line; comment.side = "RIGHT"; }
    // #762: actionable one-click suggestion (GitHub) / degraded plain block
    // (Forgejo) + opt-in agent-prompt section. Findings without the new keys
    // render byte-identically to before.
    const action = publishablePrescription(value, line, pathPositions);
    // #762: the digest a suppressed prescription carries into this comment so
    // the rejection outlives the comment the trusted 👎 landed on.
    let carriedDigest: string | null = null;
    if (action) {
      // #762: a rejected prescription (a trusted 👎 on the prior run's
      // identical replacement at this exact published range, or the carry
      // marker a later run inherited from it) removes ONLY the replacement
      // block. The comment still posts with its message, severity, category,
      // and agent prompt; the finding is never skipped, resolved, or deduped,
      // and the verdict is untouched. The key covers the rendered (redacted)
      // text over the whole validated range, so a rejection of a 1-2 range
      // can never drop a different single-line-at-2 prescription. The set is
      // keyed by digest so carry markers never carry raw prescription text.
      // #1101: `action.replacement` is already the marker-free string published
      // into the fence below, so this digest and the one a later run computes
      // from `recoverPublishedSuggestion` of that body are the same key.
      const digest = prescriptionKeyDigest(prescriptionKey(path, action.start, action.end, redactText(action.replacement)));
      const rejected = opts.rejectedPrescriptions?.has(digest) === true;
      if (rejected) {
        suppressed += 1;
        carriedDigest = digest;
      } else {
        if (opts.forgejoPositions) {
          body +=
            `\n\nReplacement for lines ${action.start}-${action.end} (this forge cannot apply a one-click suggestion):\n\n\`\`\`\n` +
            redactText(action.replacement) +
            "\n```";
        } else {
          body += `\n\n\`\`\`suggestion\n${redactText(action.replacement)}\n\`\`\``;
          comment.line = action.end;
          if (action.end > action.start) {
            comment.start_line = action.start;
            comment.start_side = "RIGHT";
          }
        }
        body += `\n\n${FEEDBACK_AFFORDANCE}`;
      }
    }
    if (typeof value.agent_prompt === "string" && value.agent_prompt.trim() !== "") {
      // #1107: the prompt is model text, so its opener is reserved both before
      // the wrap — where a fence it wrote is still line-initial in its own text
      // — and on the assembled section, since the wrap and the sanitizers ahead
      // of that edit text. `recoverPublishedSuggestion` also reads raw lines
      // fence-blind, so an opener left anywhere in here would still count as a
      // second one.
      const section =
        `\n\n<details><summary>Suggested agent prompt</summary>\n\n` +
        wrapFence(reserveSuggestionOpeners(value.agent_prompt)) +
        "\n\n</details>";
      body += reserveSuggestionOpeners(sanitizeMarkdown(redactText(section), mode));
    }
    // #762: no model-authored text (message, suggestion, or agent prompt) may
    // carry the reserved carry-marker grammar: the digest is recomputable
    // from published state, so an echoed marker line would ride our own
    // comment's provenance into a permanent self-suppression. Strip any such
    // line from the assembled body before we append our own marker. (The
    // suggestion region is already marker-free by `publishablePrescription`, so
    // this is a no-op there; it still covers `message` and `agent_prompt`.)
    body = stripRejectionCarryover(body);
    // #762: a suppressed prescription's rejection survives this run as a
    // digest-only carry marker on the replacement comment — the reaction on
    // the original comment is lost when cleanup retires it, so without the
    // carry the next run would re-post the rejected text.
    if (carriedDigest !== null) body += renderRejectionCarryover([carriedDigest]);
    comment.body = body;
    comments.push(comment);
    if (comments.length >= maxComments) break;
  }
  return { comments, skipped, suppressed };
}

/** Parse INLINE_FINDINGS_MAX with Python's ValueError fallback and lower
 * bound. Null/undefined and any non-integer value fall back to `fallback`
 * (v2 always falls back to its 20 default because it has no parameter); the
 * result is never below 1. */
export function parseInlineFindingsMax(raw: string | null | undefined, fallback = 20): number {
  if (raw === null || raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.max(1, parsed);
}
