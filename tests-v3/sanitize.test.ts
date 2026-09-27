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
  assert.equal(RESERVED_MARKER_PATTERNS.length, 2);
  assert.equal(stripReservedMarkers("x<!-- ai-pr-review-sha:deadbeef -->y<!-- AI-PR-REVIEW-FINGERPRINT: x -->z"), "xyz");
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
