/** Unit tests for the canonical adaptive-fence seam (#1258): one longest-run
 * scan shared by every fence that wraps untrusted bytes. */

import test from "node:test";
import assert from "node:assert/strict";

import { endsWithNewline, escapeCodeSpan, fenceDelimiterFor, longestBacktickRun } from "../src/context/fence.js";

test("longestBacktickRun agrees between a string and its raw bytes", () => {
  const samples = ["", "no ticks", "a ` b `` c", "```\n```", "é`中文``x", "`".repeat(64)];
  for (const sample of samples) {
    assert.equal(longestBacktickRun(Buffer.from(sample, "utf8")), longestBacktickRun(sample));
  }
});

test("longestBacktickRun counts runs across the whole payload and survives invalid UTF-8", () => {
  assert.equal(longestBacktickRun("+```\n ```\n````"), 4);
  // Multibyte sequences never contain the ASCII backtick byte, and invalid
  // bytes are just run-breakers — the scan never decodes.
  assert.equal(longestBacktickRun(new Uint8Array([0x60, 0xcc, 0x81, 0x60, 0x60])), 2);
  assert.equal(longestBacktickRun(new Uint8Array([0x60, 0xff, 0x60, 0x60, 0x60])), 3);
  assert.equal(longestBacktickRun(new Uint8Array(0)), 0);
});

test("fenceDelimiterFor is floored at three and always one longer than the payload's longest run", () => {
  assert.equal(fenceDelimiterFor(""), "```");
  assert.equal(fenceDelimiterFor("plain"), "```");
  assert.equal(fenceDelimiterFor("a `` pair"), "```");
  assert.equal(fenceDelimiterFor("+```"), "````");
  assert.equal(fenceDelimiterFor(Buffer.from("+``````````\n", "utf8")), "```````````");
});

test("endsWithNewline treats only a real trailing newline (or emptiness) as newline-terminated", () => {
  assert.equal(endsWithNewline(""), true);
  assert.equal(endsWithNewline("\n"), true);
  assert.equal(endsWithNewline("payload"), false);
  assert.equal(endsWithNewline("payload\n"), true);
  assert.equal(endsWithNewline(new Uint8Array(0)), true);
  assert.equal(endsWithNewline(Buffer.from("payload", "utf8")), false);
  assert.equal(endsWithNewline(Buffer.from("payload\n", "utf8")), true);
  // \r alone is not a line terminator for this purpose: a \r-final payload
  // still needs the separator before the closer.
  assert.equal(endsWithNewline(Buffer.from("payload\r", "utf8")), false);
});

test("escapeCodeSpan strips the boundary tokens it must never render (#252)", () => {
  // The hostile tokens THEMSELVES, not benign input: the fence token, the
  // heading marker and the line break are fed back in.
  assert.equal(escapeCodeSpan("```", 200), "'''");
  assert.equal(escapeCodeSpan("a`b", 200), "a'b");
  // A newline can start a new line — and a new line can carry a heading or a
  // fence opener — so the whole value is flattened onto one.
  assert.equal(escapeCodeSpan("a\nb", 200), "a b");
  assert.equal(escapeCodeSpan("a\r\nb\tc", 200), "a b c");
  assert.equal(escapeCodeSpan("  padded  ", 200), "padded");
  // Control characters (NUL, ESC) never reach the rendered surface: an ESC
  // sequence can repaint a terminal or a log viewer.
  assert.equal(escapeCodeSpan("a\u0000b\u001b[31m", 200), "ab[31m");
  assert.ok(!/[\u0000-\u001f\u007f]/.test(escapeCodeSpan("a\u0000b\u001b[31m", 200)));
  // The cap is applied to the RENDERED value, so an over-long path is bounded
  // and marked as truncated.
  assert.equal(escapeCodeSpan("x".repeat(300), 200), `${"x".repeat(200)}…`);
  assert.equal(escapeCodeSpan("x".repeat(200), 200), "x".repeat(200));
  // Whatever it holds, the escaped value carries no newline and no
  // backtick: it can neither start a line nor close its surrounding code
  // span. (A fence OPENER additionally needs the value at a line start,
  // which is the caller's placement — the corpus-borne renderer keeps every
  // value mid-line, and its own test asserts the rendered section.)
  for (const hostile of ["```\n## heading\n```", "~~~\n", "`".repeat(64), "#".repeat(8)]) {
    const escaped = escapeCodeSpan(hostile, 400);
    assert.ok(!escaped.includes("`"), escaped);
    assert.ok(!escaped.includes("\n"), escaped);
    assert.ok(!/^ {0,3}`{3,}/.test(escaped), escaped);
  }
});
