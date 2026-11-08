/** #1516: safe incremental re-review evidence reuse — files proven
 * byte-identical to the prior reviewed head are seeded as prior evidence
 * candidates, changed/renamed/deleted/impact-affected paths are forced to
 * fresh reads, and nothing verdict-shaped is ever carried forward. */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildReviewCorpus, type CorpusWorkspace } from "../src/corpus/index.js";
import {
  buildReReviewEvidenceMd,
  computeReReviewEvidencePlan,
  MAX_EVIDENCE_CANDIDATES,
  renderReReviewEvidenceJson,
  type ReReviewEvidencePlan,
} from "../src/context/rereview-evidence.js";
import { computeReReviewDelta, type ReReviewScopeDelta } from "../src/context/rereview-scope.js";
import type { RelatedContext } from "../src/context/related-context.js";
import { runReviewEngine } from "../src/engine/review.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import { startMockServer } from "./helpers.js";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const dec = (data: Uint8Array | null | undefined): string =>
  data === null || data === undefined ? "" : Buffer.from(data).toString("utf8");

// ---------------------------------------------------------------------------
// Git workspace fixtures
// ---------------------------------------------------------------------------

const GIT = "git -c user.email=test@example.com -c user.name=test";

/** A repository with a prior reviewed head B (changes base.txt over base A)
 * and a follow-up head C (changes README.md only) — the plain follow-up
 * push shape: everything except README.md is byte-identical between B and
 * C. A hostile-named file rides in the base tree for the fence tests. */
function evidenceRepo(): { root: string; shaA: string; shaB: string; shaC: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "v3-rereview-evidence-repo-"));
  const git = (args: string): void => {
    execSync(`${GIT} ${args}`, { cwd: root, stdio: "ignore" });
  };
  git("init -q -b main");
  mkdirSync(join(root, "lib"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  const write = (name: string, content: string): void => {
    writeFileSync(join(root, name), content);
  };
  write("base.txt", "version: 1.0.0\n");
  write("README.md", "hello\n");
  write("lib/util.ts", "export const util = 1;\n");
  write("lib/helper.ts", "export const helper = 2;\n");
  write("docs/guide.md", "guide\n");
  write('back`tick`path "quoted" name.txt', "hostile name, benign bytes\n");
  git("add -A");
  git(`commit -q -m "base A"`);
  const shaA = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  git("checkout -q -b feature");
  write("base.txt", "version: 2.2.2\n");
  git("commit -qam " + JSON.stringify("B: prior reviewed head"));
  const shaB = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  write("README.md", "hello\nchanged\n");
  git("commit -qam " + JSON.stringify("C: touch README"));
  const shaC = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  return { root, shaA, shaB, shaC, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}

/** A repository whose delta renames one file and deletes another. */
function renameDeleteRepo(): { root: string; shaPrior: string; shaHead: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "v3-rereview-rename-repo-"));
  const git = (args: string): void => {
    execSync(`${GIT} ${args}`, { cwd: root, stdio: "ignore" });
  };
  git("init -q -b main");
  const write = (name: string, content: string): void => {
    writeFileSync(join(root, name), content);
  };
  write("old.txt", "moves\n");
  write("del.txt", "goes away\n");
  write("keep.txt", "stays\n");
  git("add -A");
  git(`commit -q -m "base"`);
  const shaPrior = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  execSync("git mv old.txt new.txt", { cwd: root, stdio: "ignore" });
  rmSync(join(root, "del.txt"));
  git("add -A");
  git(`commit -q -m "rename and delete"`);
  const shaHead = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  return { root, shaPrior, shaHead, cleanup: (): void => rmSync(root, { recursive: true, force: true }) };
}

function makeRelated(overrides: Partial<RelatedContext> = {}): RelatedContext {
  return {
    version: 1,
    files: [],
    truncated: false,
    errors: [],
    truncation: {
      truncated: false,
      reasons: [],
      omittedSymbols: 0,
      omittedReferences: 0,
      omittedTests: 0,
      omittedManifests: 0,
      omittedOutputBytes: 0,
    },
    ...overrides,
  };
}

async function planFor(
  repo: { root: string; shaB: string; shaC: string },
  related: RelatedContext | null = makeRelated(),
  probeOptions: Parameters<typeof computeReReviewEvidencePlan>[3] = {},
  anchorsTruncated = false,
): Promise<ReReviewEvidencePlan> {
  const delta = await computeReReviewDelta(repo.root, repo.shaB, repo.shaC);
  return computeReReviewEvidencePlan(
    repo.root,
    delta,
    related === null ? null : { context: related, anchorsTruncated },
    probeOptions,
  );
}

// ---------------------------------------------------------------------------
// computeReReviewEvidencePlan
// ---------------------------------------------------------------------------

test("#1516: a one-file follow-up commit seeds the untouched files and forces the changed one fresh", async () => {
  const repo = evidenceRepo();
  try {
    const plan = await planFor(repo);
    assert.equal(plan.degradedReason, null);
    assert.equal(plan.enumerated, true);
    assert.equal(plan.treeUnchanged, false);
    assert.deepEqual([...plan.changed], ["README.md"]);
    assert.ok(!plan.seeded.includes("README.md"), "the changed file is never seeded");
    assert.deepEqual([...plan.seeded].sort(), [
      'back`tick`path "quoted" name.txt',
      "base.txt",
      "docs/guide.md",
      "lib/helper.ts",
      "lib/util.ts",
    ]);
    assert.equal(plan.verifiedBlobs, 5);
    assert.equal(plan.seededTruncated, false);
    assert.equal(plan.relatedAvailable, true);
    assert.deepEqual([...plan.renamed], []);
    assert.deepEqual([...plan.deleted], []);
    assert.deepEqual([...plan.impactInvalidated], []);
  } finally { repo.cleanup(); }
});

test("#1516: a related unchanged file is impact-invalidated out of the seeded set", async () => {
  const repo = evidenceRepo();
  try {
    const plan = await planFor(repo, makeRelated({
      files: [{ path: "./lib/util.ts", symbols: [], tests: [], manifests: [] }],
      consumers: [{
        key: "util", kind: "function", source: "lib/util.ts", line: 1,
        references: [{ path: "lib/helper.ts", line: 3 }],
      }],
      counterparts: [{ path: "docs/guide.md", name: "guide", line: 1, refPath: "README.md", refName: "r", refLine: 1, lines: [] }],
    }));
    assert.equal(plan.degradedReason, null);
    assert.deepEqual([...plan.impactInvalidated].sort(), ["docs/guide.md", "lib/helper.ts", "lib/util.ts"]);
    assert.ok(!plan.seeded.includes("lib/util.ts"));
    assert.ok(plan.seeded.includes("base.txt"));
    assert.equal(plan.seeded.length + plan.impactInvalidated.length, plan.verifiedBlobs);
  } finally { repo.cleanup(); }
});

test("#1516: a related file's test and manifest bindings are impact-invalidated too", async () => {
  const repo = evidenceRepo();
  try {
    const plan = await planFor(repo, makeRelated({
      files: [{ path: "lib/util.ts", symbols: [], tests: ["lib/helper.ts"], manifests: ["docs/guide.md"] }],
    }));
    assert.equal(plan.degradedReason, null);
    assert.deepEqual([...plan.impactInvalidated].sort(), ["docs/guide.md", "lib/helper.ts", "lib/util.ts"],
      "the related file itself plus its test and manifest bindings all invalidate");
    assert.ok(plan.seeded.includes("base.txt"), "unrelated candidates still seed");
  } finally { repo.cleanup(); }
});

test("#1516: a truncated change-anchor artifact degrades the impact rule", async () => {
  const repo = evidenceRepo();
  try {
    const plan = await planFor(repo, makeRelated(), {}, true);
    assert.equal(plan.degradedReason, "related-code-context-incomplete");
    assert.deepEqual([...plan.seeded], []);
    assert.deepEqual([...plan.changed], ["README.md"], "the forced-fresh delta survives the degradation");
  } finally { repo.cleanup(); }
});

test("#1516: missing related-code context degrades to a full re-read", async () => {
  const repo = evidenceRepo();
  try {
    const unavailable = await planFor(repo, null);
    assert.equal(unavailable.degradedReason, "related-code-context-unavailable");
    assert.deepEqual([...unavailable.seeded], []);
    assert.deepEqual([...unavailable.changed], ["README.md"], "the forced-fresh delta survives the degradation");

    const truncated = await planFor(repo, makeRelated({ truncated: true }));
    assert.equal(truncated.degradedReason, "related-code-context-incomplete");
    const errored = await planFor(repo, makeRelated({ errors: ["grep failed"] }));
    assert.equal(errored.degradedReason, "related-code-context-incomplete");
  } finally { repo.cleanup(); }
});

test("#1516: renamed and deleted paths are forced fresh and never seeded", async () => {
  const repo = renameDeleteRepo();
  try {
    const plan = await planFor({ root: repo.root, shaB: repo.shaPrior, shaC: repo.shaHead });
    assert.equal(plan.degradedReason, null);
    assert.deepEqual(plan.renamed, [{ from: "old.txt", to: "new.txt" }]);
    assert.deepEqual([...plan.deleted], ["del.txt"]);
    assert.deepEqual([...plan.seeded], ["keep.txt"]);
    assert.ok(!plan.seeded.includes("old.txt"), "the renamed-away path is not a candidate");
  } finally { repo.cleanup(); }
});

test("#1516: a non-enumerable delta degrades without seeding", async () => {
  const repo = evidenceRepo();
  try {
    const delta: ReReviewScopeDelta = {
      priorHeadSha: repo.shaB, headSha: repo.shaC,
      enumerated: false, treeUnchanged: false,
      commits: [], commitsTruncated: false, files: [], filesTruncated: false,
    };
    const plan = await computeReReviewEvidencePlan(repo.root, delta, { context: makeRelated() });
    assert.equal(plan.enumerated, false);
    assert.equal(plan.degradedReason, "delta-not-enumerable");
    assert.deepEqual([...plan.seeded], []);
    assert.equal(buildReReviewEvidenceMd(plan, { priorHeadSha: repo.shaB, headSha: repo.shaC }), "");
    const json = JSON.parse(renderReReviewEvidenceJson(plan, { priorHeadSha: repo.shaB, headSha: repo.shaC, baseSha: repo.shaA }));
    assert.equal(json.degraded, "delta-not-enumerable");
  } finally { repo.cleanup(); }
});

test("#1516: a delta the plan cannot classify or render fails closed", async () => {
  const repo = evidenceRepo();
  try {
    const delta = await computeReReviewDelta(repo.root, repo.shaB, repo.shaC);
    const unknownStatus = await computeReReviewEvidencePlan(repo.root, delta, { context: makeRelated() }, { overrideDiffStatus: "X\0mystery.txt\0" });
    assert.equal(unknownStatus.degradedReason, "delta-status-unparsed");
    const controlChar = await computeReReviewEvidencePlan(repo.root, delta, { context: makeRelated() }, { overrideDiffStatus: "M\0bad\npath.txt\0" });
    assert.equal(controlChar.degradedReason, "unrenderable-delta-path");
  } finally { repo.cleanup(); }
});

test("#1516: a blob digest that contradicts the delta refuses reuse entirely", async () => {
  const repo = evidenceRepo();
  try {
    // The delta probe is overridden to report NO changes while README.md
    // genuinely differs between the two heads: the digest pass must catch
    // the contradiction and refuse reuse, not silently seed a changed file.
    const plan = await planFor(repo, makeRelated(), { overrideDiffStatus: "" });
    assert.equal(plan.degradedReason, "blob-digest-mismatch");
    assert.deepEqual([...plan.seeded], []);
    assert.equal(buildReReviewEvidenceMd(plan, { priorHeadSha: repo.shaB, headSha: repo.shaC }), "");
  } finally { repo.cleanup(); }
});

test("#1516: a head-only file the delta failed to report refuses reuse entirely", async () => {
  const root = mkdtempSync(join(tmpdir(), "v3-rereview-evidence-add-"));
  const git = (args: string): void => { execSync(`${GIT} ${args}`, { cwd: root, stdio: "ignore" }); };
  try {
    git("init -q -b main");
    writeFileSync(join(root, "kept.txt"), "same\n");
    git("add -A");
    git(`commit -q -m "prior"`);
    const shaPrior = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    writeFileSync(join(root, "kept.txt"), "same\n");
    writeFileSync(join(root, "added.txt"), "new file\n");
    git("add -A");
    git(`commit -q -m "adds a file"`);
    const shaHead = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    // The overridden delta claims only kept.txt changed, hiding added.txt —
    // an addition the delta failed to report is a contradiction too.
    const delta = await computeReReviewDelta(root, shaPrior, shaHead);
    const plan = await computeReReviewEvidencePlan(
      root, delta, { context: makeRelated() }, { overrideDiffStatus: "M\0kept.txt\0" },
    );
    assert.equal(plan.degradedReason, "blob-digest-mismatch");
    assert.deepEqual([...plan.seeded], []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1516: a path with pathspec magic seeds through the literal pathspec", async () => {
  const root = mkdtempSync(join(tmpdir(), "v3-rereview-evidence-colon-"));
  const git = (args: string): void => { execSync(`${GIT} ${args}`, { cwd: root, stdio: "ignore" }); };
  try {
    git("init -q -b main");
    writeFileSync(join(root, ":colon.txt"), "colon path\n");
    writeFileSync(join(root, "plain.txt"), "plain\n");
    git("add -A");
    git(`commit -q -m "prior"`);
    const shaPrior = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    writeFileSync(join(root, "changed.txt"), "changed\n");
    git("add -A");
    git(`commit -q -m "touch another file"`);
    const shaHead = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    const delta = await computeReReviewDelta(root, shaPrior, shaHead);
    const plan = await computeReReviewEvidencePlan(root, delta, { context: makeRelated() });
    assert.equal(plan.degradedReason, null);
    assert.ok(plan.seeded.includes(":colon.txt"), "the colon path seeds instead of being silently dropped");
    assert.ok(plan.seeded.includes("plain.txt"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("#1516: a capped tree enumeration and a failing digest call degrade", async () => {
  const repo = evidenceRepo();
  try {
    const truncated = await planFor(repo, makeRelated(), { overrideDiffStatus: "", maxGitOutputBytes: 8 });
    assert.equal(truncated.degradedReason, "tree-enumeration-truncated");
    assert.deepEqual([...truncated.seeded], []);

    const failed = await planFor(repo, makeRelated(), { forceDigestFailure: true });
    assert.equal(failed.degradedReason, "digest-verification-failed");
    assert.deepEqual([...failed.seeded], []);
  } finally { repo.cleanup(); }
});

test("#1516: the candidate cap truncates with the ls-tree order kept", async () => {
  const repo = evidenceRepo();
  try {
    const plan = await planFor(repo, makeRelated(), { maxCandidates: 2 });
    assert.equal(plan.degradedReason, null);
    assert.equal(plan.seeded.length, 2);
    assert.equal(plan.seededTruncated, true);
    // git's tree order: base.txt before lib/ before docs/ is FALSE — git
    // sorts by byte order, so "back`tick`..." and "base.txt" lead.
    assert.deepEqual([...plan.seeded], ['back`tick`path "quoted" name.txt', "base.txt"]);
  } finally { repo.cleanup(); }
});

test("#1516: a rebase-only push proves whole-tree identity without a digest pass", async () => {
  const repo = evidenceRepo();
  try {
    execSync(`${GIT} checkout -q -b rebased ${repo.shaB}`, { cwd: repo.root, stdio: "ignore" });
    execSync(`${GIT} commit -q --allow-empty -m rebase`, { cwd: repo.root, stdio: "ignore" });
    const shaE = execSync("git rev-parse HEAD", { cwd: repo.root }).toString().trim();
    const delta = await computeReReviewDelta(repo.root, repo.shaB, shaE);
    const plan = await computeReReviewEvidencePlan(repo.root, delta, { context: makeRelated() });
    assert.equal(plan.treeUnchanged, true);
    assert.equal(plan.degradedReason, null);
    assert.deepEqual([...plan.seeded], []);
    assert.deepEqual([...plan.changed], []);
    assert.equal(plan.verifiedBlobs, 0);
    const section = buildReReviewEvidenceMd(plan, { priorHeadSha: repo.shaB, headSha: shaE });
    assert.match(section, /byte-identical to the prior reviewed head/);
    assert.ok(!section.includes("```"), "the whole-tree case lists no paths");
  } finally { repo.cleanup(); }
});

// ---------------------------------------------------------------------------
// buildReReviewEvidenceMd
// ---------------------------------------------------------------------------

function syntheticPlan(overrides: Partial<ReReviewEvidencePlan> = {}): ReReviewEvidencePlan {
  return {
    priorHeadSha: "b".repeat(40),
    headSha: "c".repeat(40),
    enumerated: true,
    treeUnchanged: false,
    seeded: ["keep.ts"],
    seededTruncated: false,
    changed: ["changed.ts"],
    renamed: [],
    deleted: [],
    impactInvalidated: [],
    relatedAvailable: true,
    degradedReason: null,
    verifiedBlobs: 1,
    ...overrides,
  };
}

test("#1516: the section names both heads, the reuse provenance, and the rules", () => {
  const section = buildReReviewEvidenceMd(syntheticPlan(), { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40) });
  assert.match(section, /^# Re-Review Evidence\n/);
  assert.match(section, /b{40}/);
  assert.match(section, /c{40}/);
  assert.match(section, /computed in this run against the current checkout/);
  assert.match(section, /nothing was imported from the prior run's artifacts/);
  assert.match(section, /Unresolved prior findings are always reconsidered at the current head/);
  assert.match(section, /reuse never bypasses merge gating/);
  assert.match(section, /never carried into this review/);
  assert.match(section, /a hint, not a current finding/);
  assert.match(section, /keep\.ts/);
  assert.match(section, /changed\.ts/);
});

test("#1516: there is nothing to say when the plan carries no reuse and no forced reads", () => {
  const empty = syntheticPlan({ seeded: [], changed: [], verifiedBlobs: 0 });
  assert.equal(buildReReviewEvidenceMd(empty, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40) }), "");
  assert.equal(buildReReviewEvidenceMd(null, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40) }), "");
  assert.equal(
    buildReReviewEvidenceMd(syntheticPlan({ degradedReason: "related-code-context-unavailable" }), { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40) }),
    "",
  );
});

test("#1516: hostile path bytes stay inside a fence they cannot close", () => {
  const hostile = syntheticPlan({
    seeded: ['back`tick`path "quoted" name.txt'],
    changed: ["```evil```.txt"],
  });
  const section = buildReReviewEvidenceMd(hostile, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40) });
  assert.ok(section.includes('back`tick`path "quoted" name.txt'), "the seeded path survives verbatim");
  assert.ok(section.includes("```evil```.txt"), "the changed path survives verbatim");
  const lines = section.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(`{3,})$/.exec(lines[index] ?? "");
    if (!opener) continue;
    const openerLength = opener[1]!.length;
    let closerAt = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = /^(`{3,})$/.exec(lines[scan] ?? "");
      if (candidate && candidate[1]!.length >= openerLength) {
        closerAt = scan;
        break;
      }
    }
    assert.ok(closerAt > index, "each fence opens with a matching closer");
    for (let interior = index + 1; interior < closerAt; interior += 1) {
      const interiorRun = /^(`+)$/.exec(lines[interior] ?? "");
      assert.ok(!interiorRun || interiorRun[1]!.length < openerLength, "no interior run can close the fence early");
    }
    index = closerAt;
  }
});

test("#1516: an oversized section shrinks by dropping list entries, never mid-fence", () => {
  const section = buildReReviewEvidenceMd(
    syntheticPlan({
      seeded: Array.from({ length: 120 }, (_, index) => `very-long-descriptive-path-${index}-padding-padding-padding.txt`),
      seededTruncated: true,
      changed: Array.from({ length: 120 }, (_, index) => `changed-${index}-padding-padding-padding-padding.txt`),
    }),
    { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40) },
  );
  assert.ok(Buffer.byteLength(section, "utf8") <= 4096, "the cap holds exactly");
  assert.match(section, /(truncated|omitted for size)/);
  const lines = section.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(`{3,})$/.exec(lines[index] ?? "");
    if (!opener) continue;
    let closerAt = -1;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = /^(`{3,})$/.exec(lines[scan] ?? "");
      if (candidate && candidate[1]!.length >= opener[1]!.length) {
        closerAt = scan;
        break;
      }
    }
    assert.ok(closerAt > index, "every capped variant still closes its fences");
    index = closerAt;
  }
});

// ---------------------------------------------------------------------------
// renderReReviewEvidenceJson
// ---------------------------------------------------------------------------

test("#1516: the telemetry artifact carries counts and the current-head proof — and no verdict", async () => {
  const repo = evidenceRepo();
  try {
    const plan = await planFor(repo, makeRelated({
      files: [{ path: "lib/util.ts", symbols: [], tests: [], manifests: [] }],
    }));
    const json = JSON.parse(renderReReviewEvidenceJson(plan, { priorHeadSha: repo.shaB, headSha: repo.shaC, baseSha: repo.shaA }));
    assert.equal(json.schema_version, "1");
    assert.equal(json.prior_head_sha, repo.shaB);
    assert.equal(json.head_sha, repo.shaC);
    assert.equal(json.base_sha, repo.shaA);
    assert.equal(json.enumerated, true);
    assert.equal(json.tree_unchanged, false);
    assert.equal(json.related_context_available, true);
    assert.equal(json.reused, 4);
    assert.equal(json.invalidated, 1);
    assert.equal(json.reusable_candidates, 5);
    assert.equal(json.verified_blobs, 5);
    assert.equal(json.seeded_truncated, false);
    assert.equal(json.degraded, null);
    assert.deepEqual(json.forced_fresh.changed, ["README.md"]);
    assert.deepEqual(json.forced_fresh.impact_invalidated, ["lib/util.ts"]);
    assert.deepEqual(json.forced_fresh.renamed, []);
    assert.deepEqual(json.forced_fresh.deleted, []);
    assert.equal(json.proof.current_head, repo.shaC);
    assert.match(json.proof.method, /git diff --name-status/);
    // The old verdict is never copied: no verdict-shaped key anywhere.
    const keys: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          keys.push(key.toLowerCase());
          walk(entry);
        }
      }
    };
    walk(json);
    for (const key of keys) {
      assert.ok(!/verdict|approve|recommend/.test(key), `no verdict-shaped key: ${key}`);
    }
  } finally { repo.cleanup(); }
});

test("#1516: hostile path bytes survive the telemetry artifact as data", () => {
  const plan = syntheticPlan({
    changed: ['bad "quoted" \\path.txt'],
    renamed: [{ from: "old\tname.txt", to: "new\x1fname.txt" }],
    impactInvalidated: [],
    seeded: [],
    degradedReason: null,
    enumerated: true,
  });
  const json = JSON.parse(renderReReviewEvidenceJson(plan, { priorHeadSha: "b".repeat(40), headSha: "c".repeat(40), baseSha: "a".repeat(40) }));
  assert.deepEqual(json.forced_fresh.changed, ['bad "quoted" \\path.txt']);
  assert.deepEqual(json.forced_fresh.renamed, [{ from: "old\tname.txt", to: "new\x1fname.txt" }]);
  assert.ok(!json.forced_fresh.changed[0].includes("\\\""), "the escape stays inside the JSON encoding, not doubled into the value");
});

// ---------------------------------------------------------------------------
// Engine regression
// ---------------------------------------------------------------------------

const FULL_AC_DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  " hello",
  "+changed",
  "diff --git a/base.txt b/base.txt",
  "--- a/base.txt",
  "+++ b/base.txt",
  "@@ -1 +1 @@",
  "-version: 1.0.0",
  "+version: 2.2.2",
  "",
].join("\n");

function engineAdapter(options: { shaC: string; shaA: string; comments: { body: string; author: string }[]; identity: string | null }): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: async () => ({
      number: 7, title: "Touch README", body: "", state: "open", draft: false,
      head: { sha: options.shaC, ref: "feature", repo: { full_name: "o/r" } },
      base: { sha: options.shaA, ref: "main", repo: { full_name: "o/r" } },
      user: { login: "someone" }, changed_files: 2, additions: 2, deletions: 1,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: async () => FULL_AC_DIFF,
    listPrFiles: async () => ({ ok: true, data: [
      { filename: "README.md", status: "modified", additions: 1, deletions: 0, changes: 1 },
      { filename: "base.txt", status: "modified", additions: 1, deletions: 1, changes: 2 },
    ] }),
    getIssue: async () => ({ ok: false, error: "not served" }),
    listPrConversationComments: async () => ({ ok: true, data: [] }),
    listReviewThreads: async () => ({ ok: true, data: [] }),
    listPrReviewsPaginated: async () => ({ ok: true, data: [] }),
    listIssueComments: async () => options.comments.map((comment, index) => ({ id: index + 1, body: comment.body, created_at: "2024-01-01T00:00:00Z", author: comment.author })),
    listPrReviews: async () => [],
    repoPermission: async () => null,
    authenticatedIdentity: async () => options.identity,
    ghApi: async () => ({ error: "not served" }),
    externalChecks: async () => [],
  } as unknown as PlatformReadAdapter;
}

function verdictBody(): string {
  return JSON.stringify({ id: "c1", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ verdict: "approve", review_markdown: "Looks fine.\n", smart_review_requested: false, smart_review_reason: null, findings: [], requirement_coverage: null, required_check_dispositions: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
}

const inputs = { "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": "", "ai-model": "m", "ai-stream": "false", "ai-api-key": "k" };

function managedBody(headSha: string): string {
  return [
    "<!-- ai-pr-reviewer -->",
    `<!-- ai-pr-reviewer:{"version":1,"head_sha":"${headSha}","base_sha":"base","review_result":"issues"} -->`,
    "",
  ].join("\n");
}

test("#1516 engine: a re-review seeds reuse evidence while the gates still run at the current head", async () => {
  const repo = evidenceRepo();
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const runDir = mkdtempSync(join(tmpdir(), "v3-rereview-evidence-run-"));
  try {
    const result = await runReviewEngine(
      {
        repository: "o/r", prNumber: "7", headSha: repo.shaC, baseRef: "", isForkPr: "false",
        platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"),
        inputs: { ...inputs, "ai-base-url": server.url }, ambient: {}, triggerReason: "manual", forceRereview: false,
      },
      {
        workspace: repo.root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(runDir, "summary.md"),
        adapter: engineAdapter({
          shaC: repo.shaC, shaA: repo.shaA,
          comments: [{ body: managedBody(repo.shaB), author: "pr-reviewer[bot]" }],
          identity: "pr-reviewer[bot]",
        }),
        persistArtifacts: true, quiet: true,
        log: () => {}, error: () => {}, annotate: () => {},
      },
    );
    assert.equal(result.outputs.verdict, "approve", "the second review emits its own verdict");
    const evidence = readFileSync(join(runDir, "re-review-evidence.md"), "utf8");
    assert.match(evidence, /^# Re-Review Evidence\n/);
    assert.ok(evidence.includes(repo.shaB) && evidence.includes(repo.shaC), "both heads are named");
    assert.ok(evidence.includes("base.txt"), "an unchanged file is seeded");
    assert.ok(evidence.includes("README.md"), "the changed file is forced fresh");
    assert.match(evidence, /reuse never bypasses merge gating/);
    // Merge gating is untouched: the deterministic artifacts exist for the
    // current head even on a high-reuse run.
    assert.ok(readFileSync(join(runDir, "requirement-trace.json"), "utf8").length >= 0);
    assert.ok(readFileSync(join(runDir, "required-evidence-state.json"), "utf8").length >= 0);
    const corpus = readFileSync(join(runDir, "review-corpus.md"), "utf8");
    const scopeAt = corpus.indexOf("# Re-Review Scope");
    const evidenceAt = corpus.indexOf("# Re-Review Evidence");
    const filesAt = corpus.indexOf("# PR Files");
    assert.ok(scopeAt >= 0 && evidenceAt > scopeAt && filesAt > evidenceAt, "the evidence section rides between scope and files");
    const json = JSON.parse(readFileSync(join(runDir, "re-review-evidence.json"), "utf8"));
    assert.equal(json.head_sha, repo.shaC);
    assert.equal(json.degraded, null);
    assert.ok(json.reused >= 1);
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("#1516 engine: a first review carries empty evidence artifacts and no corpus section", async () => {
  const repo = evidenceRepo();
  const server = await startMockServer((_req, _body, res) => { res.setHeader("Content-Type", "application/json"); res.end(verdictBody()); });
  const runDir = mkdtempSync(join(tmpdir(), "v3-rereview-evidence-run-"));
  try {
    await runReviewEngine(
      {
        repository: "o/r", prNumber: "7", headSha: repo.shaC, baseRef: "", isForkPr: "false",
        platform: "github", forgejoApiUrl: "", ciChecksFile: join(runDir, "ci-checks-context.md"),
        inputs: { ...inputs, "ai-base-url": server.url }, ambient: {}, triggerReason: "manual", forceRereview: false,
      },
      {
        workspace: repo.root, runDir, outputsSink: "/dev/null", stepSummaryPath: join(runDir, "summary.md"),
        adapter: engineAdapter({ shaC: repo.shaC, shaA: repo.shaA, comments: [], identity: null }),
        persistArtifacts: true, quiet: true,
        log: () => {}, error: () => {}, annotate: () => {},
      },
    );
    assert.equal(readFileSync(join(runDir, "re-review-evidence.md"), "utf8"), "", "the artifact is cleared, never stale");
    assert.equal(readFileSync(join(runDir, "re-review-evidence.json"), "utf8"), "");
    const corpus = readFileSync(join(runDir, "review-corpus.md"), "utf8");
    assert.ok(!corpus.includes("# Re-Review Evidence"), "a fresh review's corpus is unchanged");
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Corpus assembly placement
// ---------------------------------------------------------------------------

function baseWorkspace(): CorpusWorkspace {
  return {
    manifestContextMd: enc("manifests\n"),
    prJson: enc(JSON.stringify({ number: 1, title: "t", author: { login: "a" } })),
    classificationJson: enc(JSON.stringify({ pr_kind: "app_code", risk_flags: [] })),
    relatedCodeTruncatedMd: null,
    repoMapMd: null,
    prThreadMd: null,
    reviewThreadsMd: null,
    humanReviewsMd: null,
    linkedIssuesMd: null,
    ciChecksContent: null,
    versionHintsTruncatedTxt: null,
    toolHarnessMd: null,
    toolHarnessSmartMd: null,
    evidenceProvidersMd: null,
    imageDigestContextMd: enc("no digests\n"),
    linkedSourcesMd: enc("no sources\n"),
    repoImpactTruncatedMd: enc("no impact\n"),
    repoHistoryTruncatedMd: enc("no history\n"),
    prDiff: enc("diff\n"),
    prFilesJson: enc("[]"),
    prDiffTruncated: enc("diff\n"),
    prFilesTruncatedJson: enc("[]"),
    standardsContextMd: enc("# Standards\ntext\n"),
    requirementLedgerMd: null,
    specialistsMd: null,
    requirementLedgerPresent: null,
    specialistLeadsPresent: null,
    standardsFileContent: enc("standards body\n"),
  };
}

const baseOptions = {
  tier: "primary" as const,
  slot: "primary" as const,
  maxCorpus: 220000,
  diffBudget: 140000,
  filesBudget: 70000,
  repoMapMaxBytes: 12000,
  standardsFile: "AGENTS.md",
  ciChecksFile: "",
  budgetGuard: false,
};

test("#1516 corpus: the evidence section lands between the scope section and the file list", () => {
  const result = buildReviewCorpus(
    {
      ...baseWorkspace(),
      reReviewScopeMd: enc("# Re-Review Scope\nscope body\n"),
      reReviewEvidenceMd: enc("# Re-Review Evidence\nevidence body\n"),
    },
    baseOptions,
  );
  const corpus = dec(result.artifacts.get("review-corpus.md")!);
  const scopeAt = corpus.indexOf("# Re-Review Scope");
  const evidenceAt = corpus.indexOf("# Re-Review Evidence");
  const filesAt = corpus.indexOf("# PR Files");
  assert.ok(scopeAt >= 0 && evidenceAt > scopeAt && filesAt > evidenceAt);
});

test("#1516 corpus: an absent, empty, or null evidence section leaves the corpus byte-identical", () => {
  const absent = buildReviewCorpus(baseWorkspace(), baseOptions);
  const empty = buildReviewCorpus({ ...baseWorkspace(), reReviewEvidenceMd: new Uint8Array(0) }, baseOptions);
  const explicitNull = buildReviewCorpus({ ...baseWorkspace(), reReviewEvidenceMd: null }, baseOptions);
  assert.deepEqual(absent.artifacts.get("review-corpus.md"), empty.artifacts.get("review-corpus.md"));
  assert.deepEqual(absent.artifacts.get("review-corpus.md"), explicitNull.artifacts.get("review-corpus.md"));
});

assert.ok(MAX_EVIDENCE_CANDIDATES >= 1);
