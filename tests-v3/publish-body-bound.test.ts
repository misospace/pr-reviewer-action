import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPublishedBody,
  fitReviewProseToBytes,
  MAX_PUBLISHED_BODY_BYTES,
  publishReview,
  renderFindingsSummary,
} from "../src/publish/publish.js";
import { REVIEW_HANDOFF_ANCHOR } from "../src/publish/handoff.js";
import type {
  NativeReviewRequest,
  NativeReviewSurface,
  PublishCommentRef,
  PublishPlatformApi,
  PublishReviewRef,
  ReviewerRequestResult,
} from "../src/platform/publish-api.js";

const MARKER = "<!-- ai-pr-review -->";
const HEAD = "head-123";
const HANDOFF = `${REVIEW_HANDOFF_ANCHOR}\n\`\`\`json\n{"schema":"review-handoff/v1"}\n\`\`\``;
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n old\n+new line\n";

/** The #1554 disclosure notes, exactly as the builder renders them. */
const TRUNCATED_NOTE_PREFIX = "_Review prose truncated to fit the forge's comment ceiling: ";
const TRUNCATED_NOTE_SUFFIX = " character(s) dropped. The verdict, coverage notices, and machine documents above are complete._";
const OMITTED_NOTE = "_The review prose did not fit the forge's comment ceiling and was omitted. The verdict, coverage notices, and machine documents above are complete._";

class MockPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  readonly nativeReviewSurface: NativeReviewSurface = { supported: true };
  head: string | null = HEAD;
  sticky: { marker: string; body: string }[] = [];
  reviews: PublishReviewRef[] = [];
  submitted: NativeReviewRequest[] = [];
  reviewResults: { ok: boolean; error?: string }[] = [];
  comments: PublishCommentRef[] = [];
  async getHeadSha(): Promise<string | null> { return this.head; }
  async listIssueComments(): Promise<PublishCommentRef[]> { return this.comments; }
  async upsertStickyComment(marker: string, body: string) {
    this.sticky.push({ marker, body });
    return { ok: true, created: true, commentId: 100 + this.sticky.length, updatedAt: "2026-01-01T00:00:00Z" };
  }
  async listReviews(): Promise<PublishReviewRef[]> { return this.reviews; }
  async listManagedInlineComments(): ReturnType<PublishPlatformApi["listManagedInlineComments"]> {
    return { supported: true, complete: true, comments: [] };
  }
  async retireInlineComment(): Promise<boolean> { return true; }
  async createReview(request: NativeReviewRequest) {
    this.submitted.push(request);
    const result = this.reviewResults.shift() ?? { ok: true };
    if (!result.ok) return result;
    const reviewId = 1000 + this.submitted.length;
    this.reviews = [...this.reviews, { id: reviewId, body: request.body, user: { login: "bot" } }];
    return { ...result, reviewId };
  }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async minimizeReview(): Promise<boolean> { return true; }
  async unresolvedSupersededThreads(): Promise<{ ok: boolean; threads: { id: string }[]; hasNextPage: boolean }> {
    return { ok: true, threads: [], hasNextPage: false };
  }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
  async requestReviewers(): Promise<ReviewerRequestResult> {
    return { ok: true, supported: true, requestedUsers: [], requestedTeams: [], alreadyRequestedUsers: [], alreadyRequestedTeams: [] };
  }
}

function publishInput(overrides: Partial<Parameters<typeof publishReview>[0]> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "Safe.", verdict: "approve", analysisEngine: "m",
    baseSha: "base-1", headSha: HEAD, prNumber: "7", commentMarker: MARKER,
    requiredChecks: "complete", reviewRoute: "primary", escalationReason: "", cacheHitRatio: "-",
    inlineFindings: false, inlineFindingsMax: 10, findings: [], cleanupPreviousNativeReviews: "false",
    allowApprove: false, approveForks: false, isForkPr: false, upstreamLinkMode: "inert",
    conditionalPresence: {
      linkedIssue: false, evidenceProvider: false, standards: false,
      toolHarnessFindings: false, toolHarnessResults: false,
    },
    forgejoPositions: false,
    ...overrides,
  };
}

const codepoints = (value: string): number => [...value].length;

test("#1554: a fitting body is byte-identical to the unguarded build, with and without a tail block", () => {
  const options = {
    markers: MARKER,
    handoffBlock: HANDOFF,
    header: "# AI Automated Review",
    note: "_Full PR review._",
    analysisEngine: "m (openai)",
    sanitizedMarkdown: "REVIEW",
    coverageNotice: "COVERAGE",
    stateBlock: "STATE",
    triageBlock: "TRIAGE",
    actionVersion: "test",
  };
  const expected = `${MARKER}\n${HANDOFF}\n\n# AI Automated Review\n\n_Full PR review._\n`
    + "\n_Analysis engine: m (openai) · pr-reviewer-action test_\n\nCOVERAGE\n\nSTATE\n\nTRIAGE\n\nREVIEW\n";
  assert.equal(buildPublishedBody(options), expected);
  // Raw-concatenation tail: the tail block is appended to exactly the bytes
  // the unguarded build returned, so a caller's old `body += notice` is
  // reproduced verbatim.
  const notice = "\n> **Withheld**: advisory only.\n";
  assert.equal(buildPublishedBody({ ...options, tailBlock: notice }), expected + notice);
});

test("#1554: ~200 KiB of multi-byte prose is trimmed under the ceiling with machine documents intact", () => {
  const prose = "審査".repeat(100_000); // 200,000 codepoints, 600,000 UTF-8 bytes
  const body = buildPublishedBody({
    markers: MARKER,
    handoffBlock: HANDOFF,
    header: "# AI Automated Review",
    analysisEngine: "m (openai)",
    sanitizedMarkdown: prose,
    actionVersion: "test",
  });
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_PUBLISHED_BODY_BYTES);
  // The machine documents survive a multi-hundred-KiB prose untouched.
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.ok(body.includes(REVIEW_HANDOFF_ANCHOR));
  assert.ok(body.includes("_Analysis engine: m (openai) · pr-reviewer-action test_"));
  // The disclosure note is the final line of the body.
  const lines = body.split("\n");
  const lastLine = lines[lines.length - 2]!;
  assert.ok(lastLine.startsWith(TRUNCATED_NOTE_PREFIX));
  assert.ok(lastLine.endsWith(TRUNCATED_NOTE_SUFFIX));
  assert.ok(lines[lines.length - 1] === "");
  // The dropped count is a plausible number of dropped Unicode codepoints,
  // and the kept prose is exactly that many-codepoint prefix of the original.
  const dropped = Number(/: (\d+) character/.exec(lastLine)![1]);
  assert.ok(dropped > 100_000);
  assert.ok(dropped < codepoints(prose));
  const kept = Array.from(prose).slice(0, codepoints(prose) - dropped).join("");
  assert.ok(body.includes(kept));
});

test("#1554: prose that is one giant fenced block is dropped whole, never left open", () => {
  const prose = `intro\n\`\`\`js\n${"x".repeat(500_000)}\n`;
  const body = buildPublishedBody({
    markers: MARKER,
    handoffBlock: HANDOFF,
    analysisEngine: "m (openai)",
    sanitizedMarkdown: prose,
    actionVersion: "test",
  });
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_PUBLISHED_BODY_BYTES);
  // The kept prose ends before the fence opener: no fence can be left open.
  const proseStart = body.indexOf("intro\n");
  const proseRegion = body.slice(proseStart, body.indexOf(TRUNCATED_NOTE_PREFIX));
  assert.ok(!proseRegion.includes("```"));
  const lastLine = body.split("\n")[body.split("\n").length - 2]!;
  assert.ok(lastLine.startsWith(TRUNCATED_NOTE_PREFIX));
  // The dropped unfinished block counts toward the dropped characters.
  const dropped = Number(/: (\d+) character/.exec(lastLine)![1]);
  assert.equal(codepoints(prose) - dropped, codepoints("intro\n"));
});

test("#1554: prose smaller than the note reserve is omitted entirely (full-omission variant)", () => {
  // Size the tail block so the prose budget lands at exactly zero: the
  // prefix bytes are measured from a prose-free build, and the note reserve
  // mirrors the builder's own worst-case sizing.
  const prose = "z".repeat(5_000);
  const proseFree = buildPublishedBody({
    markers: MARKER,
    handoffBlock: HANDOFF,
    analysisEngine: "m (openai)",
    sanitizedMarkdown: "",
    actionVersion: "test",
  });
  const prefixBytes = Buffer.byteLength(proseFree, "utf8") - 2;
  const reserve = Buffer.byteLength(TRUNCATED_NOTE_PREFIX + TRUNCATED_NOTE_SUFFIX, "utf8")
    + String(codepoints(prose)).length + 1;
  const hugeTail = `\n${"y".repeat(MAX_PUBLISHED_BODY_BYTES - prefixBytes - 2 - reserve - 2)}\n`;
  const body = buildPublishedBody({
    markers: MARKER,
    handoffBlock: HANDOFF,
    analysisEngine: "m (openai)",
    sanitizedMarkdown: prose,
    tailBlock: hugeTail,
    actionVersion: "test",
  });
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_PUBLISHED_BODY_BYTES);
  assert.ok(!body.includes(prose));
  const lastLine = body.split("\n")[body.split("\n").length - 2]!;
  assert.equal(lastLine, OMITTED_NOTE);
});

test("#1554: fitReviewProseToBytes cuts at codepoint boundaries and reports dropped codepoints", () => {
  assert.deepEqual(fitReviewProseToBytes("abc", 10), { text: "abc", dropped: 0 });
  // a(1) é(2) 世(3) b(1): a cut at 4 bytes lands inside 世 and backs up to 3.
  assert.deepEqual(fitReviewProseToBytes("aé世b", 3), { text: "aé", dropped: 2 });
  assert.deepEqual(fitReviewProseToBytes("aé世b", 4), { text: "aé", dropped: 2 });
  assert.deepEqual(fitReviewProseToBytes("aé世b", 0), { text: "", dropped: 4 });
  // a(1) 😀(4) b(1): a cut at 3 bytes lands inside the 4-byte astral
  // codepoint and backs up to 1.
  assert.deepEqual(fitReviewProseToBytes("a😀b", 3), { text: "a", dropped: 2 });
  assert.deepEqual(fitReviewProseToBytes("a😀b", 5), { text: "a😀", dropped: 1 });
});

test("#1554: fitReviewProseToBytes keeps closed fences whole and drops an open one whole", () => {
  const closed = "a\n```\ncode\n```\nb";
  // Cut lands after the closing fence: the whole closed fence is kept.
  assert.deepEqual(fitReviewProseToBytes(closed, Buffer.byteLength(closed) - 1), { text: "a\n```\ncode\n```\n", dropped: 1 });
  const open = "ok\n```js\nlet x = 1;\n";
  // Any cut inside the unterminated block cuts back to before its opener.
  assert.deepEqual(fitReviewProseToBytes(open, Buffer.byteLength(open) - 1), { text: "ok\n", dropped: codepoints(open) - codepoints("ok\n") });
  assert.deepEqual(fitReviewProseToBytes(open, Buffer.byteLength(open) - 10), { text: "ok\n", dropped: codepoints(open) - codepoints("ok\n") });
  // Tilde fences behave the same, and a longer closer closes a shorter opener.
  const tilde = "a\n~~~\ncode\n~~~~\nb";
  assert.deepEqual(fitReviewProseToBytes(tilde, Buffer.byteLength(tilde) - 1), { text: "a\n~~~\ncode\n~~~~\n", dropped: 1 });
});

test("#1554: fences in the middle of prose are preserved when nothing is trimmed", () => {
  const prose = "one\n```js\nlet a = 1;\n```\ntwo\n```ts\nlet b = 2;\n```\nthree";
  const body = buildPublishedBody({
    markers: MARKER,
    analysisEngine: "m (openai)",
    sanitizedMarkdown: prose,
    actionVersion: "test",
  });
  assert.ok(body.includes("```js\nlet a = 1;\n```"));
  assert.ok(body.includes("```ts\nlet b = 2;\n```"));
  assert.ok(body.endsWith(`${prose}\n`));
});

test("#1554: hostile fence openers inside blockquotes and list items are dropped whole on trim", () => {
  // A fence opener behind a container prefix is a real opener in CommonMark;
  // a scan that misses it would let an unfinished hostile fence survive
  // truncation and swallow the action-owned blocks after the prose. Each
  // kept prose must end before the opener, with the block dropped whole.
  // Blockquote fence content carries the `>` continuation itself.
  for (const opener of ["> ```js", "- ```js", "1. ```js", "1) ```js", "> - ```js", "* ```js"]) {
    const content = opener.startsWith(">") ? "> let x = 1;" : "  let x = 1;";
    const prose = `ok\n${opener}\n${content}\n${"x".repeat(500_000)}\n`;
    const fitted = fitReviewProseToBytes(prose, Buffer.byteLength(prose) - 1);
    assert.deepEqual(fitted, { text: "ok\n", dropped: codepoints(prose) - codepoints("ok\n") }, opener);
  }
});

test("#1554: an indented-code decoy never opens a phantom fence", () => {
  // `    ``` is indented code in CommonMark, never a fence. A scan that
  // opened a phantom fence there would consume the real flush-left opener
  // below as its closer and let the prose after it survive inside a live
  // fence; the scan must ignore the decoy and cut back to the real opener.
  const prose = "intro\n\n    ```\nnot a fence\n```\nswallowed now\n";
  const kept = "intro\n\n    ```\nnot a fence\n";
  assert.deepEqual(
    fitReviewProseToBytes(prose, Buffer.byteLength(prose) - 1),
    { text: kept, dropped: codepoints(prose) - codepoints(kept) },
  );
  // A tab-indented delimiter line is indented code the same way.
  const tabbed = "intro\n\n\t```js\nnot a fence\n```\nswallowed now\n";
  const keptTabbed = "intro\n\n\t```js\nnot a fence\n";
  assert.deepEqual(
    fitReviewProseToBytes(tabbed, Buffer.byteLength(tabbed) - 1),
    { text: keptTabbed, dropped: codepoints(tabbed) - codepoints(keptTabbed) },
  );
  // A 4-space-indented delimiter line inside a live top-level fence is
  // indented code, never a closer: the fence stays open and the cut drops
  // the block whole.
  const deep = "ok\n```\ncode\n    ```\nmore\n";
  assert.deepEqual(
    fitReviewProseToBytes(deep, Buffer.byteLength(deep) - 1),
    { text: "ok\n", dropped: codepoints(deep) - codepoints("ok\n") },
  );
});

test("#1554: a fence opened on a list-item continuation line never closes on a flush delimiter", () => {
  // `  ```js is a fence inside the list item (container inherited from the
  // marker line); the flush-left ``` is a NEW top-level fence opener in the
  // renderer, never that fence's closer. The scan must stay open from the
  // item fence's opener.
  const prose = "intro\n\n- foo\n  ```js\nnot a fence\n```\nswallowed now\n";
  const kept = "intro\n\n- foo\n";
  assert.deepEqual(
    fitReviewProseToBytes(prose, Buffer.byteLength(prose) - 1),
    { text: kept, dropped: codepoints(prose) - codepoints(kept) },
  );
  // A flush-left closer after an indented opener is the same shape: the
  // scan keeps the indent floor and over-trims (disclosed) rather than
  // risk a live fence.
  const flushCloser = "ok\n  ```js\ncode\n```\nmore\n";
  assert.deepEqual(
    fitReviewProseToBytes(flushCloser, Buffer.byteLength(flushCloser) - 1),
    { text: "ok\n", dropped: codepoints(flushCloser) - codepoints("ok\n") },
  );
});

test("#1554: a container delimiter inside an open top-level fence never closes it", () => {
  // Hostile `> ``` inside a live top-level fence is literal fence content,
  // never a closer: the scan must stay open and cut back to the real opener
  // instead of letting the prose after the hostile line look fence-safe.
  const hostile = "ok\n```\n> ```\nhidden\n";
  assert.deepEqual(
    fitReviewProseToBytes(hostile, Buffer.byteLength(hostile) - 1),
    { text: "ok\n", dropped: codepoints(hostile) - codepoints("ok\n") },
  );
});

test("#1554: closed container fences survive trim; a deeper marker never closes a shallower one", () => {
  // A legitimately closed blockquote fence (every content line carries the
  // `>` continuation) is recognized as closed: a cut landing after its
  // closer keeps the whole block.
  const closedQuote = "a\n> ```\n> code\n> ```\nb";
  assert.deepEqual(
    fitReviewProseToBytes(closedQuote, Buffer.byteLength(closedQuote) - 1),
    { text: "a\n> ```\n> code\n> ```\n", dropped: 1 },
  );
  // Same for an indented top-level fence closed at its own indent.
  const closedIndented = "a\n  ```js\n  code\n  ```\nb";
  assert.deepEqual(
    fitReviewProseToBytes(closedIndented, Buffer.byteLength(closedIndented) - 1),
    { text: "a\n  ```js\n  code\n  ```\n", dropped: 1 },
  );
  // A level-1 `> ``` line does not close a level-2 `>>` fence.
  const hostile = "ok\n>> ```js\n> ```\nswallowed\n";
  assert.deepEqual(
    fitReviewProseToBytes(hostile, Buffer.byteLength(hostile) - 1),
    { text: "ok\n", dropped: codepoints(hostile) - codepoints("ok\n") },
  );
  const closedNested = "a\n>> ```\n> code\n>> ```\nb";
  assert.deepEqual(
    fitReviewProseToBytes(closedNested, Buffer.byteLength(closedNested) - 1),
    { text: "a\n>> ```\n> code\n>> ```\n", dropped: 1 },
  );
});

test("#1554: a blank line ends a blockquote fence, making a later delimiter a new opener", () => {
  // The blank line ends the blockquote, so the trailing `> ``` is a NEW
  // unclosed opener in the renderer. The scan must stay open from the
  // FIRST opener and trim back past it instead of trusting the later
  // delimiter as a closer.
  const prose = "ok\n> ```js\n> code\n\nmore\n\n> ```\nswallowed\n";
  assert.deepEqual(
    fitReviewProseToBytes(prose, Buffer.byteLength(prose) - 1),
    { text: "ok\n", dropped: codepoints(prose) - codepoints("ok\n") },
  );
});

test("#1554: a backtick in the info string is paragraph text, even behind a container", () => {
  const prose = "ok\n> ``` a`b\ncode\n```\ntail";
  const kept = "ok\n> ``` a`b\ncode\n";
  assert.deepEqual(
    fitReviewProseToBytes(prose, Buffer.byteLength(prose) - 1),
    { text: kept, dropped: codepoints(prose) - codepoints(kept) },
  );
});

test("#1554: fallback body is byte-identical to the old primary + findings-summary formula", async () => {
  const api = new MockPublishApi();
  api.reviewResults = [{ ok: false }, { ok: true }];
  const findings = [{ file: "a.ts", line: 2, severity: "major", message: "A finding" }];
  const result = await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "request_changes",
    findings,
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted.length, 2);
  const [primary, fallback] = api.submitted;
  // No published prescriptions and a non-strict policy: the rebuilt fallback
  // must equal the old formula `sansSuggestions(primary) + summary`, which
  // here is `primary + summary` (the handoff carries no suggestions).
  assert.equal(fallback!.body, primary!.body + renderFindingsSummary(findings, "inert"));
});

test("#1554: recovery body is byte-identical to the old primary + findings-summary formula", async () => {
  const api = new MockPublishApi();
  api.reviewResults = [{ ok: false }];
  const findings = [{ file: "a.ts", line: 2, severity: "major", message: "A finding" }];
  const result = await publishReview(publishInput({
    mode: "review_comment",
    inlineFindings: true,
    findings,
  }), api, { diffText: DIFF });
  assert.equal(result.status, "published");
  assert.equal(api.sticky.length, 2);
  const [primary, recovery] = api.sticky;
  assert.equal(recovery!.body, primary!.body + renderFindingsSummary(findings, "inert"));
});

test("#1554: a tail block without a trailing newline still separates the disclosure note onto its own line", () => {
  const prose = "審査".repeat(60_000); // 120,000 codepoints, 360,000 UTF-8 bytes
  const body = buildPublishedBody({
    markers: MARKER,
    handoffBlock: HANDOFF,
    analysisEngine: "m (openai)",
    sanitizedMarkdown: prose,
    tailBlock: "TAIL",
    actionVersion: "test",
  });
  assert.ok(Buffer.byteLength(body, "utf8") <= MAX_PUBLISHED_BODY_BYTES);
  // The trimmed prose, the newline-less tail and the note each end a line:
  // the separator the builder inserts keeps the note out of the tail's line.
  assert.ok(body.includes(`\nTAIL\n${TRUNCATED_NOTE_PREFIX}`));
});

test("#1554: the rebuilt fallback body stays under the ceiling when the review prose is huge", async () => {
  const api = new MockPublishApi();
  api.reviewResults = [{ ok: false }, { ok: true }];
  const findings = [{ file: "a.ts", line: 2, severity: "major", message: "A finding" }];
  const result = await publishReview(publishInput({
    mode: "review_verdict",
    verdict: "request_changes",
    findings,
    reviewMarkdown: "審査".repeat(80_000),
  }), api, { diffText: "" });
  assert.equal(result.status, "published");
  assert.equal(api.submitted.length, 2);
  for (const review of api.submitted) {
    assert.ok(Buffer.byteLength(review.body, "utf8") <= MAX_PUBLISHED_BODY_BYTES);
    assert.ok(review.body.includes(REVIEW_HANDOFF_ANCHOR));
  }
});

test("#1554: the rebuilt recovery body stays under the ceiling when the review prose is huge", async () => {
  const api = new MockPublishApi();
  api.reviewResults = [{ ok: false }];
  const findings = [{ file: "a.ts", line: 2, severity: "major", message: "A finding" }];
  const result = await publishReview(publishInput({
    mode: "review_comment",
    inlineFindings: true,
    findings,
    reviewMarkdown: "審査".repeat(80_000),
  }), api, { diffText: DIFF });
  assert.equal(result.status, "published");
  assert.equal(api.sticky.length, 2);
  for (const comment of api.sticky) {
    assert.ok(Buffer.byteLength(comment.body, "utf8") <= MAX_PUBLISHED_BODY_BYTES);
    assert.ok(comment.body.includes(REVIEW_HANDOFF_ANCHOR));
  }
});
