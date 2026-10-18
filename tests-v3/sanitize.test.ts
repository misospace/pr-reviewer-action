import test from "node:test";
import assert from "node:assert/strict";
import {
  RESERVED_MARKER_PATTERNS,
  sanitizeMarkdown,
  stripEmptyConditionalSections,
  stripReservedMarkers,
  type ConditionalSectionPresence,
} from "../src/publish/sanitize.js";

const allPresent: ConditionalSectionPresence = {
  linkedIssue: true,
  evidenceProvider: true,
  standards: true,
  toolHarnessFindings: true,
  toolHarnessResults: true,
};

test("all four upstream URL classes rewrite in inert and togithub modes", () => {
  const source = [
    "https://github.com/acme/app/pull/12",
    "https://github.com/acme/app/issues/13",
    "https://github.com/acme/app/commit/deadbee",
    "https://github.com/acme/app/compare/v1...v2",
  ].join(" ");
  assert.equal(sanitizeMarkdown(source, "inert"), "upstream acme/app PR 12 upstream acme/app issue 13 upstream acme/app commit deadbee upstream acme/app compare v1...v2");
  assert.equal(sanitizeMarkdown(source, "togithub"), source.replaceAll("github.com", "togithub.com"));
});

test("cross-repo refs, bare refs, mention boundaries and email local parts", () => {
  const source = "acme/app#123 #456 foo@bar.com `@code` @user";
  assert.equal(sanitizeMarkdown(source, "inert"), "acme/app PR 123 PR 456 foo@bar.com `@code` @\u200buser");
});

test("inline code spans remain verbatim while fenced code is sanitized", () => {
  const source = "`#123 @inline`\n```\n#456 @fenced\n```";
  assert.equal(sanitizeMarkdown(source, "inert"), "`#123 @inline`\n```\nPR 456 @\u200bfenced\n```");
});

test("reserved markers are removed case-insensitively", () => {
  assert.equal(RESERVED_MARKER_PATTERNS.length, 3);
  assert.equal(stripReservedMarkers("x<!-- ai-pr-review-sha:deadbeef -->y<!-- AI-PR-REVIEW-FINGERPRINT: x -->z"), "xyz");
  // #762: the rejection carry marker is reserved too — model markdown can
  // never smuggle a suppression claim into a published body.
  assert.equal(stripReservedMarkers(`y<!-- PR-Reviewer:Rejected-Prescriptions:v1:${"a".repeat(64)} -->z`), "yz");
});

test("#1107: the prescription opener is reserved on model markdown — the fence is dropped, the word kept", () => {
  // The review-markdown surface (#1107): the opener is a REWRITE, not a
  // removal, so it is not in `RESERVED_MARKER_PATTERNS` (still 3 above). The
  // boundary token ITSELF, in the exact bytes a model emits.
  assert.equal(stripReservedMarkers("```suggestion\nREPL\n```"), "suggestion\nREPL\n```");
  assert.equal(stripReservedMarkers("a\n  ```suggestion\nb"), "a\n  suggestion\nb", "any indent is reserved, indent preserved");
  assert.equal(stripReservedMarkers("````suggestion"), "suggestion", "any fence length is reserved");
  assert.equal(stripReservedMarkers("~~~suggestion"), "suggestion", "a tilde fence is reserved");
  assert.equal(stripReservedMarkers("~~~SUGGESTION  "), "suggestion", "case-insensitive, trailing space trimmed");
  assert.equal(stripReservedMarkers("```suggestion\r\nREPL"), "suggestion\nREPL", "CRLF-terminated opener is reserved");
  // Both halves of the reserved grammar apply to the same model text, in order.
  assert.equal(
    stripReservedMarkers(`<!-- ai-pr-review-sha:forged -->\n\`\`\`suggestion\nREPL`),
    "\nsuggestion\nREPL",
  );
  // Byte-identical without the token — including text that merely mentions the
  // word, and a fence whose info string is something else.
  const clean = "Review.\n\nA ```suggestion``` block would apply this.\n\n```ts\nconst x = 1;\n```";
  assert.equal(stripReservedMarkers(clean), clean);
  assert.equal(stripReservedMarkers(""), "");
  // Idempotent: a second pass over reserved text changes nothing.
  const once = stripReservedMarkers("```suggestion\nREPL\n```");
  assert.equal(stripReservedMarkers(once), once);

  // #252: the opener is reserved LAST, so the boundary token cannot be
  // MANUFACTURED by the very pass that removes a reserved marker — the marker
  // and the fence share one line, so an opener check that ran first would miss
  // it and leave a live prescription behind the marker.
  const smuggled = "hi\n<!-- ai-pr-review-fingerprint:deadbeef -->```suggestion\nrm -rf /\n```\ntail";
  const opened = stripReservedMarkers(smuggled);
  assert.equal(opened.includes("```suggestion"), false, "no opener survives the marker removal next to it");
  assert.equal(opened.split("\n").some((line) => line.trim() === "```suggestion"), false);
  assert.ok(opened.includes("hi") && opened.includes("tail") && opened.includes("rm -rf /"), "the surrounding text is untouched");
});

test("unknown link mode throws", () => {
  assert.throws(() => sanitizeMarkdown("#1", "other" as never), /unknown upstream link mode/);
});

test("conditional sections consume through next same-or-higher heading, fence-aware", () => {
  const source = "## Summary\nkeep\n\n## Standards Compliance\nfiller\n```md\n## Standards\nnot a boundary\n```\n\n### Detail\nalso removed\n\n## Next\nkeep too";
  const result = stripEmptyConditionalSections(source, { ...allPresent, standards: false });
  assert.equal(result, "## Summary\nkeep\n\n## Next\nkeep too");
});

test("target matching normalizes title punctuation but tool harness uses exact titles", () => {
  const source = "## Standards: ---\nremove\n## Tool Harness Results Leak Secrets\nkeep finding\n## Tool Harness Results...\nremove too\n## End\nkeep";
  const result = stripEmptyConditionalSections(source, { ...allPresent, standards: false, toolHarnessResults: false });
  assert.equal(result, "## Tool Harness Results Leak Secrets\nkeep finding\n## End\nkeep");
});

test("removed content collapses blank lines and trims document edges", () => {
  const source = "\n\n## Linked Issue Fit\nremove\n\n\n\n## End\nkeep\n\n";
  assert.equal(stripEmptyConditionalSections(source, { ...allPresent, linkedIssue: false }), "## End\nkeep");
});
