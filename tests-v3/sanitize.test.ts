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
  assert.equal(RESERVED_MARKER_PATTERNS.length, 4);
  assert.equal(stripReservedMarkers("x<!-- ai-pr-review-sha:deadbeef -->y<!-- AI-PR-REVIEW-FINGERPRINT: x -->z"), "xyz");
  // #762: the rejection carry marker is reserved too — model markdown can
  // never smuggle a suppression claim into a published body.
  assert.equal(stripReservedMarkers(`y<!-- PR-Reviewer:Rejected-Prescriptions:v1:${"a".repeat(64)} -->z`), "yz");
  // #1027: the finding-identity marker is reserved as well — model markdown
  // can never mint or rewrite a finding identity into a published body.
  assert.equal(stripReservedMarkers(`w<!-- PR-Reviewer:Finding-Id:v1:${"b".repeat(64)} -->z`), "wz");
});

test("#1107: the prescription opener is reserved on model markdown — the fence is dropped, the word kept, the block dissolved", () => {
  // The review-markdown surface (#1107): the opener is a REWRITE, not a
  // removal, so it is not in `RESERVED_MARKER_PATTERNS` (still 3 above). The
  // boundary token ITSELF, in the exact bytes a model emits. The block's
  // closing fence is dissolved with it: left alone it would survive as a live
  // plain-fence opener in the rewritten prose and capture whatever the action
  // appends next, so it is escaped into inert text.
  assert.equal(stripReservedMarkers("```suggestion\nREPL\n```"), "suggestion\nREPL\n\\`\\`\\`");
  assert.equal(stripReservedMarkers("a\n  ```suggestion\nb"), "a\n  suggestion\nb", "any indent is reserved, indent preserved");
  assert.equal(stripReservedMarkers("````suggestion"), "suggestion", "any fence length is reserved");
  assert.equal(stripReservedMarkers("~~~suggestion"), "suggestion", "a tilde fence is reserved");
  assert.equal(stripReservedMarkers("~~~SUGGESTION  "), "suggestion", "case-insensitive, trailing space trimmed");
  assert.equal(stripReservedMarkers("```suggestion\r\nREPL"), "suggestion\nREPL", "CRLF-terminated opener is reserved");
  // A lone CR is a line ending to a Markdown renderer (GitHub normalizes it),
  // so an opener it hides must be reserved too — not passed through as one
  // "line" this pass cannot see.
  assert.equal(stripReservedMarkers("```suggestion\rEVIL\r```"), "suggestion\nEVIL\n\\`\\`\\`");
  assert.equal(stripReservedMarkers("```suggestion\r```"), "suggestion\n\\`\\`\\`", "a CR-only block still leaves no live opener");
  // Dissolution is bounded by the block's real closer: a fence the model wrote
  // OUTSIDE the reserved block is untouched, and a fence-shaped line inside the
  // dissolved region cannot go live either (a tilde line would otherwise become
  // an unclosed opener once the block's own fences are gone).
  assert.equal(
    stripReservedMarkers("```suggestion\n~~~\nINJECTED\n```\n\n```ts\nconst x = 1;\n```"),
    "suggestion\n\\~\\~\\~\nINJECTED\n\\`\\`\\`\n\n```ts\nconst x = 1;\n```",
    "the dissolved region is neutralized, a following benign block is untouched",
  );
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

test("#1136: an ordinary block still open at end of text is dissolved, walk output ends fence-closed", () => {
  // The boundary shape itself: a model message ending in an unclosed
  // ordinary fence leaves the walk open, so anything appended after this
  // pass — the validated prescription region in particular — would render
  // as its content. Pinned policy: the walk dissolves it like a reserved
  // block (opener and interior fence-shaped lines escaped). This must hold
  // WITHOUT the `suggestion` token too: a token-free unclosed fence is
  // exactly the shape that would swallow a validated prescription on the
  // same finding silently, so the old token-gated early return was the
  // hazard's blind spot.
  assert.equal(
    stripReservedMarkers("note\n```ts\nconst x = 1;"),
    "note\n\\`\\`\\`ts\nconst x = 1;",
    "token-free unclosed fence dissolved",
  );
  assert.equal(
    stripReservedMarkers("head\n```ts\n~~~\nconst x = 1;"),
    "head\n\\`\\`\\`ts\n\\~\\~\\~\nconst x = 1;",
    "interior fence-shaped lines of the unclosed block cannot go live either",
  );
  assert.equal(
    stripReservedMarkers("note\n```ts\n```suggestion\nconst x = 1;"),
    "note\n\\`\\`\\`ts\nsuggestion\nconst x = 1;",
    "a reserved opener inside the unclosed block is rewritten, not left to reopen anything",
  );
  // A block that IS closed never reaches the end-of-text branch: byte-identical,
  // CRLF endings included (the fast path returns the original string).
  const closed = "Review.\r\n\r\n```ts\r\nconst x = 1;\r\n```\r\ndone";
  assert.equal(stripReservedMarkers(closed), closed, "benign closed block stays byte-identical, CRLF intact");
  assert.equal(stripReservedMarkers(""), "");
  // Dissolution must not over-reach: a benign block that closed earlier in
  // the same text keeps its bytes; only the trailing unclosed block is
  // rewritten.
  assert.equal(
    stripReservedMarkers("```ts\nkeep\n```\nthen\n~~~\nmore"),
    "```ts\nkeep\n```\nthen\n\\~\\~\\~\nmore",
    "an earlier closed block is untouched, only the trailing unclosed one dissolves",
  );
  // The dissolve path rejoins with LF (a rewrite happened), so a CR/CRLF
  // message that ends fence-open normalizes — pinned so the change stays a
  // decision, not an accident.
  assert.equal(
    stripReservedMarkers("note\r\n```ts\r\nconst x = 1;"),
    "note\n\\`\\`\\`ts\nconst x = 1;",
    "dissolve path normalizes line endings, closed path keeps CRLF bytes",
  );
  // Idempotent: dissolving twice changes nothing.
  const once = stripReservedMarkers("note\n```ts\nconst x = 1;");
  assert.equal(stripReservedMarkers(once), once);
});

test("#1112: container-prefixed prescription openers are reserved — prefix kept, block dissolved", () => {
  // #252: the boundary token ITSELF, behind the containers that render it. A
  // `> ` / `- ` / `1. ` prefix is not decoration — GitHub renders the same live
  // one-click prescription behind it, and `recoverPublishedSuggestion` (which
  // reads only the bare opener line) never saw one, so a container-prefixed
  // opener was a prescription this action never validated wearing our comment.
  const arms: Array<[string, string, string]> = [
    ["blockquote", "> ```suggestion\nINJECTED\n> ``` ", "> suggestion\nINJECTED\n> \\`\\`\\` "],
    ["double blockquote", ">> ```suggestion\nINJECTED\n>> ``` ", ">> suggestion\nINJECTED\n>> \\`\\`\\` "],
    ["nested blockquotes", "> > ```suggestion\nINJECTED\n> > ``` ", "> > suggestion\nINJECTED\n> > \\`\\`\\` "],
    ["bullet list", "- ```suggestion\nINJECTED\n  ``` ", "- suggestion\nINJECTED\n  \\`\\`\\` "],
    ["ordered list", "1. ```suggestion\nINJECTED\n   ``` ", "1. suggestion\nINJECTED\n   \\`\\`\\` "],
    ["blockquote around a list", "> - ```suggestion\n>   INJECTED\n>   ``` ", "> - suggestion\n>   INJECTED\n>   \\`\\`\\` "],
    ["tilde fence, uppercase, trailing spaces", "> ~~~SUGGESTION  \nINJECTED\n> ~~~  ", "> suggestion\nINJECTED\n> \\~\\~\\~  "],
    ["CRLF line endings", "> ```suggestion\r\nINJECTED\r\n> ``` ", "> suggestion\nINJECTED\n> \\`\\`\\` "],
    ["indent kept inside the container", ">   ```suggestion\nINJECTED\n>   ``` ", ">   suggestion\nINJECTED\n>   \\`\\`\\` "],
    ["unclosed reserved opener", "> ```suggestion", "> suggestion"],
  ];
  for (const [label, source, expected] of arms) {
    const once = stripReservedMarkers(source);
    assert.equal(once, expected, label);
    assert.equal(stripReservedMarkers(once), once, `${label}: a second pass changes nothing`);
    assert.equal(/(^|[^\\])`{3,}/.test(once), false, `${label}: every fence run left behind is escaped, so no opener renders`);
  }

  // The LAZY closer: a bare fence that drifted out of the blockquote cannot
  // close a fenced block inside it (a fenced block needs its container markers),
  // so ending the dissolution there would leave the rest of the reserved block
  // live. It is escaped instead and the dissolution runs to the real closer.
  assert.equal(
    stripReservedMarkers("> ```suggestion\nINJECTED\n``` \ntail\n> ``` "),
    "> suggestion\nINJECTED\n\\`\\`\\` \ntail\n> \\`\\`\\` ",
    "a lazy bare fence does not close a blockquote fence",
  );
  // Same for a LIST: `- ``` ` opens a list item of its own, it does not close a
  // fence that started outside one — and its column alone cannot say so, since a
  // bare opener and a list-prefixed fence both sit in the first three columns.
  // Accepting it would leave the block's real closer live, and a live fence
  // there captures the validated region the action appends afterwards.
  assert.equal(
    stripReservedMarkers("```suggestion\n- ```\nINJECTED\n``` \ntail"),
    "suggestion\n- \\`\\`\\`\nINJECTED\n\\`\\`\\` \ntail",
    "a list-prefixed fence does not close a fence opened outside the list",
  );

  // Over-indent inside a container keeps today's over-indent reading: rewritten
  // with the prefix and the indent intact, but never a real fence — so its own
  // closer stays exactly as inert as it was before the rewrite.
  assert.equal(
    stripReservedMarkers(">     ```suggestion\nINJECTED\n>     ``` "),
    ">     suggestion\nINJECTED\n>     ``` ",
    "`> ` plus a 4-space indent is an indented code block, not a fence",
  );

  // Byte-identity: the container walk only ever touches reserved openers and
  // the lines inside a dissolving reserved block.
  for (const clean of [
    "> ```ts\n> const x = 1;\n> ``` ",
    "> ```\n> a bare fence in a quote\n> ```",
    "- item one\n- item two",
    "1. ordered item",
    "A ```suggestion``` mention stays prose",
    "> quoted note\n> more quoted note",
    "no token at all",
  ]) {
    assert.equal(stripReservedMarkers(clean), clean, `benign container text is byte-identical: ${JSON.stringify(clean)}`);
  }
});

test("#1137: Unicode-space-terminated suggestion info strings are reserved — the unverified tail fails closed", () => {
  // The boundary token ITSELF, terminated by each Unicode space class the
  // comment pipeline could honor. GitHub's own parsing is not reproducible
  // offline — the POST /markdown GFM endpoint never renders a suggestion
  // block (not even for the canonical control spelling), so it cannot
  // discriminate — and an unverified spelling must not be assumed inert.
  // Each widening is the same rewrite as the bare opener: fence characters
  // dropped, the word kept, and the block dissolved so no live fence is left
  // behind.
  const dissolved = "suggestion\nINJECTED\n\\`\\`\\`";
  const arms: Array<[string, string, string]> = [
    ["NBSP U+00A0 tail", "```suggestion\u00A0\nINJECTED\n```", dissolved],
    ["em space U+2003 tail", "```suggestion\u2003\nINJECTED\n```", dissolved],
    ["ideographic space U+3000 tail", "```suggestion\u3000\nINJECTED\n```", dissolved],
    ["BOM U+FEFF tail", "```suggestion\ufeff\nINJECTED\n```", dissolved],
    ["mixed ASCII + NBSP tail run", "```suggestion \u00A0\nINJECTED\n```", dissolved],
    ["vertical tab U+000B tail", "```suggestion\u000B\nINJECTED\n```", dissolved],
    ["line separator U+2028 tail", "```suggestion\u2028\nINJECTED\n```", dissolved],
    ["paragraph separator U+2029 tail", "```suggestion\u2029\nINJECTED\n```", dissolved],
    ["narrow no-break space U+202F tail", "```suggestion\u202F\nINJECTED\n```", dissolved],
    ["NBSP between fence and token", "```\u00A0suggestion\nINJECTED\n```", dissolved],
    ["container-prefixed NBSP tail", "> ```suggestion\u00A0\nINJECTED\n> ``` ", "> suggestion\nINJECTED\n> \\`\\`\\` "],
  ];
  for (const [label, source, expected] of arms) {
    const once = stripReservedMarkers(source);
    assert.equal(once, expected, label);
    assert.equal(stripReservedMarkers(once), once, `${label}: a second pass changes nothing`);
    assert.equal(/(^|[^\\])`{3,}/.test(once), false, `${label}: every fence run left behind is escaped, so no opener renders`);
  }
  // The token grammar itself is unchanged: a Unicode space that terminates a
  // LONGER info string is not a terminator of `suggestion` — the same
  // treatment the ASCII `suggestion foo` spelling already gets.
  assert.equal(
    stripReservedMarkers("```suggestion\u00A0foo\nINJECTED\n```"),
    "```suggestion\u00A0foo\nINJECTED\n```",
    "a Unicode space before MORE info-string content does not widen the token",
  );
  // A character that is NOT a Unicode space class changes nothing either:
  // ZWSP (U+200B, category Cf) stays part of the info string, and an NBSP
  // inside the container prefix is not indentation, so the line is a
  // paragraph, not a fence — both byte-identical, the documented assumption.
  assert.equal(
    stripReservedMarkers("```suggestion\u200B\nINJECTED\n```"),
    "```suggestion\u200B\nINJECTED\n```",
    "ZWSP is not a Unicode space class and stays as written",
  );
  assert.equal(
    stripReservedMarkers("> \u00A0```suggestion\nINJECTED\n> \u00A0```"),
    "> \u00A0```suggestion\nINJECTED\n> \u00A0```",
    "an NBSP the container walk does not read as indent makes the line a paragraph, not a fence",
  );
});

test("#1178: the documented multi-line suggestion opener spellings are reserved — the range token grammar fails closed", () => {
  // The boundary spellings THEMSELVES, in the bytes a model emits. GitHub
  // renders `suggestion-0+0` (the documented `-X+Y` multi-line range grammar)
  // and the `:`-prefixed `suggestion:-0+0` form seen in the wild as live
  // one-click prescriptions exactly like the bare opener; the `-0+0` attaches
  // to the token with no whitespace, so the #1137 whitespace-class widening
  // never covered it. GitHub's own rendering is not reproducible offline —
  // the POST /markdown GFM endpoint never applies the suggestion filter — so
  // the documented grammar is reserved rather than assumed inert. Each
  // widening is the same rewrite as the bare opener: fence characters AND the
  // range suffix dropped, the word kept, and the block dissolved so no live
  // fence is left behind.
  const dissolved = "suggestion\nINJECTED\n\\`\\`\\`";
  const arms: Array<[string, string, string]> = [
    ["backtick range spelling", "```suggestion-0+0\nINJECTED\n```", dissolved],
    ["colon-prefixed range spelling", "```suggestion:-0+0\nINJECTED\n```", dissolved],
    ["range with count pair", "```suggestion-0+0-2+2\nINJECTED\n```", dissolved],
    ["nonzero range", "```suggestion-1+2\nINJECTED\n```", dissolved],
    ["tilde fence, case-insensitive, trailing space", "~~~SUGGESTION:-0+0 \nINJECTED\n~~~", "suggestion\nINJECTED\n\\~\\~\\~"],
    ["colon before a later pair", "```suggestion-0+0:-1+1\nINJECTED\n```", dissolved],
    ["any fence length", "````suggestion-0+0\nINJECTED\n````", "suggestion\nINJECTED\n\\`\\`\\`\\`"],
    ["container-prefixed range opener", "> ```suggestion-0+0\nINJECTED\n> ```", "> suggestion\nINJECTED\n> \\`\\`\\`"],
    ["CRLF-terminated range opener", "```suggestion-0+0\r\nINJECTED", "suggestion\nINJECTED"],
  ];
  for (const [label, source, expected] of arms) {
    const once = stripReservedMarkers(source);
    assert.equal(once, expected, label);
    assert.equal(stripReservedMarkers(once), once, `${label}: a second pass changes nothing`);
    assert.equal(/(^|[^\\])`{3,}/.test(once), false, `${label}: every fence run left behind is escaped, so no opener renders`);
  }
  // A reserved shape inside an open ORDINARY block is content there — the
  // same rewrite the top-level opener gets — and never closes the block it
  // sits in, so the benign block survives intact (its fences stay live).
  assert.equal(
    stripReservedMarkers("```ts\n```suggestion-0+0\nINJECTED\n```"),
    "```ts\nsuggestion\nINJECTED\n```",
    "reserved range opener inside an ordinary block is rewritten as content",
  );
  // A lone CR is a line ending to a Markdown renderer (GitHub normalizes it),
  // so an opener it hides must be reserved too.
  assert.equal(stripReservedMarkers("```suggestion-0+0\rEVIL\r```"), "suggestion\nEVIL\n\\`\\`\\`");
  // The token grammar widens ONLY over the documented range spellings: other
  // info strings starting with `suggestion` are different info strings the
  // same way `suggestion foo` is (#1137) and stay as written.
  const inert: Array<[string, string]> = [
    ["a bare colon is not a documented spelling", "```suggestion:\nINJECTED\n```"],
    ["a non-range suffix stays as written", "```suggestion-foo\nINJECTED\n```"],
    ["a whitespace-separated range is a different info string", "```suggestion -0+0\nINJECTED\n```"],
    ["a Unicode space before the range is not the documented spelling", "```suggestion\u00A0-0+0\nINJECTED\n```"],
    ["trailing content after the range stays as written", "```suggestion-0+0x\nINJECTED\n```"],
    ["a colon-suffixed non-range stays as written", "```suggestion:foo\nINJECTED\n```"],
  ];
  for (const [label, source] of inert) {
    assert.equal(stripReservedMarkers(source), source, label);
  }
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
