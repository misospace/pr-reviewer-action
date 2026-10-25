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
 * scan of its decoded form even when the raw bytes are not valid UTF-8. */

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
