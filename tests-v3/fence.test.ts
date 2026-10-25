/** Unit tests for the canonical adaptive-fence seam (#1258): one longest-run
 * scan shared by every fence that wraps untrusted bytes. */

import test from "node:test";
import assert from "node:assert/strict";

import { fenceDelimiterFor, longestBacktickRun } from "../src/context/fence.js";

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
