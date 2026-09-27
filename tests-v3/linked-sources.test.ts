/** Unit tests for the linked-sources port (#706 PR 5b); the byte-level
 * contract against v2 lives in the `linked-sources` parity boundary. */

import test from "node:test";
import assert from "node:assert/strict";
import { BudgetTracker, DeadlineBudget, pyParseInt } from "../src/context/budget.js";
import {
  parseAllowedRepos,
  pyJsonDumpsIndent2,
  renderLinkedSources,
  repoAllowed,
  type LinkedSourcesDeps,
} from "../src/context/linked-sources.js";
import { pyDecodeUtf8Ignore, pyHtmlUnescape, PyValueError, reduceSource } from "../src/context/strip-source-text.js";
import { ForgejoEnrichClient, GitHubEnrichClient, validEnrichEndpoint } from "../src/platform/enrich.js";
import type { FetchLike } from "../src/platform/http.js";

test("reduceSource strips HTML like strip_source_text.py", () => {
  const html = "<html><head><title>t</title></head><body><script>x()</script><p>A &amp; B&notit; &#x1F680;</p>\n\n\n<p>c</p></body></html>";
  assert.equal(reduceSource(Buffer.from(html), 4000), "A & B¬it; 🚀 \n c");
  assert.equal(reduceSource(Buffer.from("plain\0text"), 4000), "plain text");
  assert.equal(reduceSource(Buffer.from("é".repeat(5)), 5), "éé\n…[source truncated]");
  assert.equal(pyDecodeUtf8Ignore(Uint8Array.from([0x61, 0xe2, 0x82, 0x62, 0xed, 0xa0, 0x80, 0x63])), "abc");
  assert.equal(pyHtmlUnescape("&#0;&#13;&#128;&#xD800;&#1114112;&#11;&ampx&amp"), "�\r€��&x&");
  assert.throws(() => pyHtmlUnescape(`&#${"0".repeat(4301)};`), PyValueError);
});

test("the tag-block regex replacement stays linear on hostile input", () => {
  const hostile = Buffer.from(`<${"<head ".repeat(40_000)}${"</script>".repeat(40_000)}${"<".repeat(40_000)}x${"\u3000".repeat(200_000)}x`);
  const started = Date.now();
  reduceSource(hostile, 4000);
  assert.ok(Date.now() - started < 2000, "no quadratic backtracking");
});

test("json.dumps(indent=2) is ASCII-escaped with Python float repr", () => {
  assert.equal(
    pyJsonDumpsIndent2({ a: [1, 2.5, 1e-7, 1e16 + 0.5, true, null], "é": { "😀": [] }, s: "q\"\\\u007f " }),
    '{\n  "a": [\n    1,\n    2.5,\n    1e-07,\n    10000000000000000,\n    true,\n    null\n  ],\n  "\\u00e9": {\n    "\\ud83d\\ude00": []\n  },\n  "s": "q\\"\\\\\\u007f\\u2028"\n}',
  );
});

test("the #509 repo gate mirrors _repo_allowed", () => {
  assert.equal(repoAllowed("O", "R", "o/r", null), true);
  assert.equal(repoAllowed("x", "y", "o/r", new Set(["X/Y"])), true);
  assert.equal(repoAllowed("x", "y", "o/r", new Set(["x/*"])), false, "'owner/*' only matches the bare owner key");
  assert.equal(repoAllowed("x", "y", null, new Set(["", "*"])), true);
  assert.equal(repoAllowed("x", "y", "", null), false);
  assert.deepEqual(parseAllowedRepos(" a/b \n c/d,,"), new Set(["a/b", "c/d"]));
  assert.equal(parseAllowedRepos(" , "), null);
});

test("BudgetTracker warns once; DeadlineBudget follows from_env", () => {
  let now = 0;
  const warnings: string[] = [];
  const budget = new BudgetTracker(2, { now: () => now, warn: (line) => warnings.push(line) });
  assert.equal(budget.ok(), true);
  now = 2;
  assert.equal(budget.ok(), false);
  assert.equal(budget.ok(), false);
  assert.deepEqual(warnings, ["WARNING: enrichment budget exceeded"]);
  assert.equal(new DeadlineBudget(0).deadline, null);
  let mono = 10;
  const deadline = DeadlineBudget.fromEnv({ X: " 1_0 " }, "X", 60, () => mono);
  assert.equal(deadline.deadline, 20);
  mono = 20;
  assert.equal(deadline.exceeded(), true);
  assert.equal(DeadlineBudget.fromEnv({ X: "nope" }, "X", 7, () => 0).deadline, 7);
  assert.equal(pyParseInt("+5"), 5);
});

test("enrich clients reject dot-segment owner/repo/path steering with zero network calls", async () => {
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    seen.push(String(input));
    return new Response("{}", { status: 200 });
  };
  const github = new GitHubEnrichClient({ token: "token t", fetchImpl });
  for (const endpoint of [
    "repos/../orgs/releases/tags/v1",
    "repos/o/../releases?per_page=30",
    "repos/./r/compare/a...b",
    "repos/o/r/compare/%2e%2e/%2e%2e/user",
    "repos/o/r/releases/tags/%2E%2E/x",
    "repos/o/r/compare/a\\..\\..\\user",
  ]) {
    assert.equal(await github.get(endpoint), null, endpoint);
    if (!endpoint.includes("%")) assert.equal(validEnrichEndpoint(endpoint), false, endpoint);
  }
  const forgejo = new ForgejoEnrichClient({ configuredApiUrl: "https://forge.example", configuredAuthorization: async () => "token t", fetchImpl });
  assert.equal(await forgejo.release("forge.example", "../admin", "v1"), null);
  assert.equal(await forgejo.release("forge.example", "o/..", "v1"), null);
  assert.equal(await forgejo.release("forge.example", "o/r", ".."), null);
  assert.equal(await forgejo.compare("forge.example", "./r", "a...b"), null);
  assert.deepEqual(seen, []);
  assert.equal(validEnrichEndpoint("repos/o/r/releases?per_page=30"), true);
});

function deps(overrides: Partial<LinkedSourcesDeps> = {}): LinkedSourcesDeps {
  return {
    budget: new BudgetTracker(60, { now: () => 0, warn: () => undefined }),
    github: { get: async () => null },
    forgejo: { release: async () => null, compare: async () => null },
    resolver: async () => ["104.16.1.1"],
    fetchSource: async () => null,
    ...overrides,
  };
}

test("renderLinkedSources hands the fetcher DEFAULT ∩ ALLOWED_SOURCE_HOSTS for every hop", async () => {
  const allowlists: string[][] = [];
  const md = await renderLinkedSources(
    { urls: ["https://artifacthub.io/p"], allowedHosts: new Set(["artifacthub.io", "docs.example"]), targetVersion: "", ghcrImages: [], compareShas: null },
    deps({
      fetchSource: async (_url, allowed) => {
        allowlists.push([...allowed]);
        return Buffer.from("<p>hi</p>");
      },
    }),
  );
  assert.deepEqual(allowlists, [["artifacthub.io"]]);
  assert.equal(md, "## Source 1\nURL: https://artifacthub.io/p\n\n### Fetched Content (truncated)\n```text\nhi\n\n```\n\n");
  assert.equal(await renderLinkedSources({ urls: [], allowedHosts: new Set(), targetVersion: "", ghcrImages: [], compareShas: null }, deps()), "");
});
