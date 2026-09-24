import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyUrl,
  extractCompareShas,
  extractGhcrImages,
  extractUrls,
  extractVersionHints,
  normalizeUrl,
  parseAllowedHosts,
  selectTargetVersion,
  urlClassificationToArtifact,
} from "../src/context/index.js";

test("URL extraction dedups, sorts, strips trailing punctuation, and respects the cap", () => {
  const body = "See https://example.com/b. and https://example.com/a,";
  const diff = "+ https://example.com/c;\n+ https://example.com/a again\n";
  assert.deepEqual(extractUrls(body, diff), ["https://example.com/a", "https://example.com/b", "https://example.com/c"]);
  assert.deepEqual(extractUrls(body, diff, 2), ["https://example.com/a", "https://example.com/b"]);
  const all = extractUrls(body, diff, null);
  assert.ok(all.length >= 3);
});

test("redirect.github.com normalizes to github.com for both schemes", () => {
  assert.equal(normalizeUrl("https://redirect.github.com/o/r/pull/1"), "https://github.com/o/r/pull/1");
  assert.equal(normalizeUrl("http://redirect.github.com/o/r/pull/1"), "http://github.com/o/r/pull/1");
  assert.equal(normalizeUrl("https://example.com/redirect.github.com"), "https://example.com/redirect.github.com");
});

test("allowlist parsing lowercases, trims, and skips empties", () => {
  assert.deepEqual([...parseAllowedHosts(" GitHub.COM , ,ghcr.io,,")].sort(), ["ghcr.io", "github.com"]);
  assert.equal(parseAllowedHosts("").size, 0);
});

test("version hints match only changed lines with the five keywords, in order, capped", () => {
  const diff = [
    "+ image: quay.io/a:1",
    "  version: unchanged-context",
    "- chart: c-0.1.2",
    "+appVersion: 2.0",
    "\u000b+ version: vertical-tab-line".slice(1),
    "+ digest: sha256:" + "a".repeat(64),
    "+ version: 9.9.9",
  ].join("\n");
  assert.deepEqual(
    extractVersionHints(diff, 3),
    ["+ image: quay.io/a:1", "- chart: c-0.1.2", "+appVersion: 2.0"],
  );
  assert.equal(extractVersionHints("plain text\n", null).length, 0);
});

test("target version prefers the last title token over the last hint semver", () => {
  assert.equal(selectTargetVersion("Bump x from 1.2.2 to v1.2.3", ["+ image: y:9.8.7"]), "1.2.3");
  assert.equal(selectTargetVersion(null, ["+ version: 1.0.0", "+ version: 2.0.0"]), "2.0.0");
  assert.equal(selectTargetVersion("no versions here", ["+ chart: c-1.2.3"]), "1.2.3");
  assert.equal(selectTargetVersion("no versions", ["no hints"]), "");
});

test("GHCR extraction strips tags and digests and dedups sorted", () => {
  const hints = ["+ image: ghcr.io/o/app:v1@sha256:abcdef", "+ chart: oci://ghcr.io/o/charts/app"];
  assert.deepEqual(extractGhcrImages(hints, "x ghcr.io/o/app@sha256:fff y"), ["o/app", "o/charts/app\nx"]);
  assert.deepEqual(extractGhcrImages([], "nothing"), []);
  // The capture class excludes :@'" ) and space but NOT newlines, so a hint
  // glued to the next line captures across it — preserved from v2 verbatim.
  assert.deepEqual(extractGhcrImages(["+ image: ghcr.io/o/app"], "tail"), ["o/app\ntail"]);
});

test("compare SHAs require exactly one hex pair with letters, lowercased", () => {
  const good = ["- tag: a@sha256:aaaa1111bbbb", "+ tag: a@sha256:bbbb2222cccc"];
  assert.deepEqual(extractCompareShas(good), ["aaaa1111bbbb", "bbbb2222cccc"]);
  assert.equal(extractCompareShas(["- v: 1234567890", "+ v: 0987654321"]), null);
  assert.equal(extractCompareShas(["- a: abc1111", "- b: def2222", "+ c: 111aaaa"]), null);
  assert.equal(extractCompareShas(["- a: abc1111", "+ a: abc1111"]), null);
});

test("URL classification covers both forges and rejects the rest", () => {
  assert.deepEqual(urlClassificationToArtifact(classifyUrl("https://github.com/o/r/releases/tag/v1.0")), {
    type: "github_release", owner: "o", repo: "r", tag: "v1.0",
  });
  assert.deepEqual(urlClassificationToArtifact(classifyUrl("https://github.com/o/r/compare/v1...v2?w=1")), {
    type: "github_compare", owner: "o", repo: "r", compare_spec: "v1...v2",
  });
  assert.deepEqual(urlClassificationToArtifact(classifyUrl("https://forge.example/o/p/releases/tag/2.0")), {
    type: "forgejo_release", host: "forge.example", owner: "o", repo: "p", tag: "2.0",
  });
  assert.deepEqual(urlClassificationToArtifact(classifyUrl("https://forge.example/o/p/compare/a...b#x")), {
    type: "forgejo_compare", host: "forge.example", owner: "o", repo: "p", compare_spec: "a...b",
  });
  assert.equal(classifyUrl("https://github.com/o/r/wiki"), null);
  assert.equal(urlClassificationToArtifact(null), null);
});
