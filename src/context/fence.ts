/** The canonical adaptive code-fence seam (#1258): the one implementation of
 * the "delimiter longer than any backtick run in the wrapped content" rule
 * that keeps untrusted bytes from closing their own fence.
 *
 * CommonMark closes a backtick code fence only with a line consisting solely
 * of backticks (beyond up to three leading spaces, plus trailing whitespace)
 * at least as long as the opening fence, so a delimiter of longest-run + 1 —
 * floored at three — cannot be matched by any line inside the block, and a
 * benign payload (no run of three or more) keeps the historical
 * three-backtick rendering byte-for-byte.
 *
 * The scan is over bytes (ASCII 0x60): UTF-8 continuation bytes never collide
 * with the backtick byte, so a byte scan of raw content agrees with a string
 * scan of its decoded form even when the raw bytes are not valid UTF-8.
 *
 * `escapeCodeSpan` is the same boundary's INLINE half: one implementation of
 * the "untrusted text renders as inert, single-line, length-capped content"
 * rule, shared by every surface that renders PR-derived text into markdown
 * (the published coverage notice and the corpus-borne harness findings). */

const BACKTICK = 0x60;

/** The longest run of backticks in `data` (a string, or raw UTF-8 bytes). */
export function longestBacktickRun(data: Uint8Array | string): number {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let longest = 0;
  let run = 0;
  for (const byte of bytes) {
    if (byte === BACKTICK) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/** A code-fence delimiter no backtick run in `data` can terminate. */
export function fenceDelimiterFor(data: Uint8Array | string): string {
  return "`".repeat(Math.max(3, longestBacktickRun(data) + 1));
}

/** True when `data` is empty or ends with a newline. An adaptive fence's
 * closer must begin on its own line (#1261 review): concatenating it onto a
 * payload that lacks a trailing newline leaves the fence unclosable — the
 * merged line is not a pure backtick run — and every section after it is
 * swallowed by the still-open block. */
export function endsWithNewline(data: Uint8Array | string): boolean {
  if (typeof data === "string") return data.length === 0 || data.endsWith("\n");
  return data.length === 0 || data[data.length - 1] === 0x0a;
}

/**
 * Fence-safe single-line code span for untrusted-derived text (changed-file
 * paths, specialist lead excerpts): backticks cannot be escaped inside a
 * code span, so they (and control characters) are replaced, and the length
 * is capped. Deterministic; biases toward rendering less rather than
 * letting hostile content break the section out.
 *
 * The three properties a hostile value must not have:
 * - a NEWLINE — it would start a new line and could forge a heading (or a
 *   fence opener) in a surface that renders untrusted text as markdown;
 * - a BACKTICK — it would close the surrounding code span, or (three in a
 *   row) open a fence that swallows every section after it;
 * - more than `maxChars` — it would flood the surface it renders into.
 *
 * `maxChars` is applied AFTER the flattening, so the cap bounds what is
 * rendered rather than the input.
 *
 * #1340: untrusted content must render inert — so the flattened value is
 * named for its trust level, and that name shares its line with the
 * control-character comparison below. The deterministic requirement trace
 * (#874/#854) accepts an enforcement citation only when the cited line
 * carries a term from the requirement text next to a predicate; while the
 * intermediate was named `singleLine`, no line of this function did, so every
 * citation into it was downgraded to `unverifiable`.
 */
export function escapeCodeSpan(text: string, maxChars: number): string {
  const untrusted = text.replace(/\s+/g, " ").replace(/[`]/g, "'");
  const stripped = [...untrusted].filter((ch) => ch.charCodeAt(0) >= 0x20).join("").trim();
  return stripped.length > maxChars ? stripped.slice(0, maxChars) + "…" : stripped;
}

const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
const BACKTICK_RUN_RE = /`+/g;

/** The fence-cap constant shared by every `safeFence` caller: a fence
 * delimiter is never allowed to grow past this many backticks. */
export const MAX_FENCE_BYTES = 12;

/** Escape control characters in untrusted text as visible escapes (`\n`,
 * `\t`, `\r`, or `\uXXXX`) so they cannot forge line structure in a markdown
 * surface that renders the text. */
export function escapeControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x0a) return "\\n";
    if (code === 0x09) return "\\t";
    if (code === 0x0d) return "\\r";
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Return `[neutralizedContent, fence]` where `fence` is backticks strictly
 * longer than any backtick run in `content`. Hostile runs of `MAX_FENCE_BYTES`
 * or more backticks are neutralized (a run of 11+ is reduced to 10) so the
 * emitted fence can never be matched by the content. */
export function safeFence(content: string): [string, string] {
  let longest = longestBacktickRun(content);
  let body = content;
  if (longest + 1 > MAX_FENCE_BYTES) {
    body = body.replace(BACKTICK_RUN_RE, (run) => (run.length >= 11 ? "`".repeat(10) : run));
    longest = Math.min(longest, 10);
  }
  const fence = "`".repeat(Math.max(longest + 1, 4));
  return [body, fence];
}

/** `label` followed by a fenced block whose delimiter no backtick run in
 * `content` can close (see `safeFence`). */
export function fenced(label: string, content: string): string {
  const [body, fence] = safeFence(content);
  return `${label}\n${fence}\n${body}\n${fence}`;
}
