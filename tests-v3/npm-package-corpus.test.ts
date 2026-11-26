/** #1821 AC5 (provider-free integration): the pure diff decision, the exact
 * published-package comparison over injected seams (fake registry docs +
 * hand-built tarballs, no network, no model), and the corpus wiring that
 * renders the section into the review body. */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  NPM_COMPARISONS_ARTIFACT_SCHEMA,
  buildNpmPackageProvenance,
  npmComparisonsArtifactJson,
  type NpmFetchBytes,
  type NpmFetchJson,
} from "../src/context/index.js";
import { npmPackageChangesFromDiff, runNpmPackageProvenancePhase } from "../src/run/stages.js";
import { RunWorkspace } from "../src/run/workspace.js";
import { buildReviewCorpus, type CorpusWorkspace } from "../src/corpus/index.js";

const enc = (text: string): Uint8Array => Buffer.from(text, "utf8");
const dec = (data: Uint8Array | null | undefined): string =>
  data === null || data === undefined ? "" : Buffer.from(data).toString("utf8");

// ── A minimal ustar-format .tar.gz builder (no npm, no archiver) ──────────

interface TarMember {
  name: string;
  body?: string;
}

function tarMember(member: TarMember): Buffer {
  const body = Buffer.from(member.body ?? "", "utf8");
  const header = Buffer.alloc(512, 0);
  const octal = (value: number, length: number): string => value.toString(8).padStart(length - 1, "0") + "\0";
  header.write(member.name, 0, Math.min(100, member.name.length), "utf8");
  header.write(octal(0o644, 8), 100, 8);
  header.write(octal(0, 8), 108, 8);
  header.write(octal(0, 8), 116, 8);
  header.write(octal(body.length, 12), 124, 12);
  header.write(octal(1_700_000_000, 12), 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(octal(sum, 8), 148, 8);
  const data = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(data);
  return Buffer.concat([header, data]);
}

function tarGz(members: TarMember[]): Uint8Array {
  const tar = Buffer.concat([...members.map(tarMember), Buffer.alloc(1024, 0)]);
  return new Uint8Array(gzipSync(tar));
}

// ── The exact #1819 shape: an @types/node 26.6.7 → 26.6.10 lockfile bump ──

const LOCKFILE_DIFF = [
  "diff --git a/package-lock.json b/package-lock.json",
  '    "node_modules/@types/node": {',
  '-      "version": "26.6.7",',
  '+      "version": "26.6.10",',
  '      "license": "MIT"',
  "    },",
].join("\n");

const DOC_URL = (version: string): string => `https://registry.npmjs.org/@types%2Fnode/${version}`;
const TARBALL_URL = (version: string): string => `https://registry.npmjs.org/@types/node/-/node-${version}.tgz`;

/** The published tree for one version: the new version carries one extra
 * file, one changed declared dependency, and one added declared dependency,
 * so both the file-level and the declaration-level deltas are observable
 * (#1821 independent review: paths alone cannot establish whether the
 * upstream API changed — the bounded declarations are rendered alongside). */
function publishedTarball(version: string, extra?: { name: string; body: string }): Uint8Array {
  const dependencies = version === "26.6.7"
    ? { "undici-types": "~6.21.0", "@types/express": "^4.17.0" }
    : { "undici-types": "~7.0.0", "new-required": "^1.0.0" };
  const members: TarMember[] = [
    { name: "package/package.json", body: JSON.stringify({ name: "@types/node", version, dependencies }) },
    { name: "package/index.d.ts", body: `// ${version}\n` },
  ];
  if (extra !== undefined) members.push({ name: `package/${extra.name}`, body: extra.body });
  return tarGz(members);
}

function registryDoc(version: string, tarball: Uint8Array): Record<string, unknown> {
  return {
    name: "@types/node",
    version,
    repository: { url: "git+https://github.com/DefinitelyTyped/DefinitelyTyped.git", directory: `types/node` },
    dist: {
      tarball: TARBALL_URL(version),
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    },
  };
}

const TARBALLS: Record<string, Uint8Array> = {
  "26.6.7": publishedTarball("26.6.7"),
  "26.6.10": publishedTarball("26.6.10", { name: "added.d.ts", body: "// new declaration\n" }),
};

/** Render the section through the pure comparison driver over fake seams. */
async function renderFixture(): Promise<{ markdown: string; comparisons: Awaited<ReturnType<typeof buildNpmPackageProvenance>>["comparisons"] }> {
  const fetchJson: NpmFetchJson = async (url) => {
    const version = url.slice(DOC_URL("").length);
    const tarball = TARBALLS[version];
    if (tarball === undefined) throw new Error(`unexpected version document request: ${url}`);
    return registryDoc(version, tarball);
  };
  const fetchBytes: NpmFetchBytes = async (url) => {
    const version = /node-(.+)\.tgz$/.exec(new URL(url).pathname)?.[1] ?? "";
    return TARBALLS[version] ?? null;
  };
  return buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }],
    { fetchJson, fetchBytes },
  );
}

// ── Corpus fixtures (mirroring corpus.test.ts's required workspace) ───────

const baseWorkspace = (): CorpusWorkspace => ({
  manifestContextMd: enc("manifests\n"),
  prJson: enc(JSON.stringify({ number: 1, title: "t", author: { login: "a" } })),
  classificationJson: enc(JSON.stringify({ pr_kind: "dependency_upgrade", risk_flags: [] })),
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
});

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

test("npmPackageChangesFromDiff pairs the exact @types/node bump from the lockfile diff", () => {
  assert.deepEqual(npmPackageChangesFromDiff(LOCKFILE_DIFF), [
    { slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" },
  ]);
  // No dependency change → nothing to compare (the phase then does no network).
  assert.deepEqual(npmPackageChangesFromDiff("diff --git a/src/a.ts b/src/a.ts\n+const answer = 42;\n"), []);
  // A single added version (no removal side) is not an old→new comparison.
  assert.deepEqual(npmPackageChangesFromDiff(
    'diff --git a/package-lock.json b/package-lock.json\n'
    + '@@ -1,0 +1,5 @@\n'
    + '+    "node_modules/@types/node": {\n'
    + '+      "version": "26.6.10",\n'
    + '+      "license": "MIT"\n'
    + '+    }\n',
  ), []);
});

// ── #1821 review round 2: two recorded tokens are a bump only with side
//    provenance. A dependency-RANGE edit records two exact tokens on the ADDED
//    side alone (">=26.6.7 <26.7.0" tokenizes to 26.6.7 AND 26.7.0) and a
//    single added/removed line carries no transition at all — the section must
//    never assert a published delta nobody installed their way through.

const manifestDiff = (lines: string[]): string => [
  "diff --git a/package.json b/package.json",
  "@@ -1,5 +1,5 @@",
  " {",
  '   "dependencies": {',
  ...lines,
  "   }",
  " }",
].join("\n");

test("a manifest dependency-RANGE edit is not an old→new bump (regression #1821 review round 2)", () => {
  // The reviewer's exact shape: one changed range line whose tokens are 1.0.0
  // and 2.0.0 — the old code compared them as a published transition.
  assert.deepEqual(npmPackageChangesFromDiff(manifestDiff([
    '-    "@types/node": "^26.6.7"',
    '+    "@types/node": ">=26.6.7 <26.7.0"',
  ])), []);
  // A brand-new dependency pinned by a range: added side only, no transition.
  assert.deepEqual(npmPackageChangesFromDiff(manifestDiff([
    '+    "left-pad": ">=1.0.0 <2.0.0"',
  ])), []);
  // A dependency REMOVAL: removed side only, no transition.
  assert.deepEqual(npmPackageChangesFromDiff(manifestDiff([
    '-    "left-pad": "^1.3.0"',
  ])), []);
  // A clean caret bump still compares: one exact token per side of the change.
  assert.deepEqual(npmPackageChangesFromDiff(manifestDiff([
    '-    "chalk": "^5.3.0"',
    '+    "chalk": "^5.4.1"',
  ])), [{ slug: "chalk", oldVersion: "5.3.0", newVersion: "5.4.1" }]);
  // Direction comes from the SIDES, not first-seen order: the lockfile hunk
  // records the '+' token BEFORE the manifest hunk records the '-'.
  assert.deepEqual(npmPackageChangesFromDiff([
    'diff --git a/package-lock.json b/package-lock.json',
    '@@ -1,3 +1,4 @@',
    '     "node_modules/chalk": {',
    '+      "version": "5.4.1",',
    '       "license": "MIT"',
    '     }',
    'diff --git a/package.json b/package.json',
    '@@ -1,5 +1,4 @@',
    ' {',
    '   "dependencies": {',
    '-    "chalk": "^5.3.0"',
    '   }',
  ].join("\n")), [{ slug: "chalk", oldVersion: "5.3.0", newVersion: "5.4.1" }]);
  // A downgrade compares in the downgrade direction, not first→last.
  assert.deepEqual(npmPackageChangesFromDiff(manifestDiff([
    '-    "chalk": "^5.4.1"',
    '+    "chalk": "^5.3.0"',
  ])), [{ slug: "chalk", oldVersion: "5.4.1", newVersion: "5.3.0" }]);
  // The pure function applies no cap of its own — the phase caps and discloses.
  const many = manifestDiff(
    Array.from({ length: 13 }, (_unused, index) => [
      `-    "pkg-${index}": "^1.0.${index}"`,
      `+    "pkg-${index}": "^1.1.${index}"`,
    ]).flat(),
  );
  const all = npmPackageChangesFromDiff(many);
  assert.equal(all.length, 13, "all 13 clean bumps stay visible to the phase");
  assert.deepEqual(all[12], { slug: "pkg-12", oldVersion: "1.0.12", newVersion: "1.1.12" });
});

test("bumps past the per-run cap are disclosed unfetched, never silently dropped", async () => {
  const fetched = Array.from({ length: 12 }, (_unused, index) => ({ slug: `pkg-${index}`, oldVersion: "1.0.0", newVersion: "1.1.0" }));
  const skipped = [{ slug: "pkg-12", oldVersion: "1.0.12", newVersion: "1.1.12" }, { slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }];
  // The compared set fails closed (no fixture documents) — the disclosure is
  // independent of what was fetched.
  const { markdown } = await buildNpmPackageProvenance(fetched, {
    fetchJson: async () => { throw new Error("offline"); },
    fetchBytes: async () => null,
  }, skipped);
  assert.ok(markdown.includes("## Not compared (over the per-run comparison cap)"), "the over-cap set is a visible section");
  assert.ok(markdown.includes("- `pkg-12` 1.0.12 → 1.1.12"), "each skipped bump names its exact pair");
  assert.ok(markdown.includes("- `types/node` 26.6.7 → 26.6.10"));
  assert.ok(markdown.includes("were NOT fetched"), "the disclosure states the reads never happened");
});

test("the seam-driven comparison renders the resolved package-version delta", async () => {
  const { markdown } = await renderFixture();
  assert.ok(markdown.includes("## `types/node` 26.6.7 → 26.6.10"), "the bump row renders with the scope-normalized slug");
  assert.ok(markdown.includes("exact published package contents"), "the comparison method is disclosed");
  assert.ok(markdown.includes("package-version delta"), "the delta is never read as a source-commit delta");
  assert.ok(markdown.includes("- Added files (1):"), "the new file is itemized");
  assert.ok(markdown.includes("`added.d.ts`"));
  assert.ok(markdown.includes("- Changed files (2):"), "the changed declaration is itemized");
  assert.ok(markdown.includes("`index.d.ts`"));
  // #1821 independent review: the actual changed declarations and the
  // registry's own source metadata render alongside the file-level delta.
  assert.ok(markdown.includes("Changed dependency ranges (1):"));
  assert.ok(markdown.includes("`undici-types: ~6.21.0 → ~7.0.0`"), "the changed range is itemized");
  assert.ok(markdown.includes("`@types/express@^4.17.0`"), "the removed declaration is itemized");
  assert.ok(markdown.includes("`new-required@^1.0.0`"), "the added declaration is itemized");
  assert.ok(markdown.includes("declare the same source repository"), "the registry-declared source metadata is rendered");
  assert.ok(markdown.includes("not a verified mapping"), "…as the document's claim, never a verified mapping");
  assert.ok(!markdown.includes(": **unresolved**"), "a fully verified read renders no unresolved version row");
  assert.ok(!markdown.includes("Delta: **unresolved**"), "the delta is resolved, not fail-closed");
});

test("the #1819 verified comparison lands in the settlement artifact (#1821 AC1)", async () => {
  const { comparisons } = await renderFixture();
  const artifact = JSON.parse(npmComparisonsArtifactJson(comparisons)) as { schema: string; verified: unknown[] };
  assert.equal(artifact.schema, NPM_COMPARISONS_ARTIFACT_SCHEMA);
  assert.deepEqual(artifact.verified, [{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }],
    "the exact tag-less comparison the Markdown discloses is the same fact the ledger consumes");
});

test("the settlement artifact is cleared or rewritten on every phase path — a stale verified list never survives (#1821 AC1)", async () => {
  const ws = new RunWorkspace("/run-dir-not-used", false);
  // A prior derivation's verified list sits in the shared run directory.
  ws.write("npm-package-comparisons.json", JSON.stringify({
    schema: NPM_COMPARISONS_ARTIFACT_SCHEMA,
    verified: [{ slug: "pkg/from-prior-run", oldVersion: "1.0.0", newVersion: "2.0.0" }],
  }));
  // This run carries no comparable npm bump → the stale list is CLEARED.
  await runNpmPackageProvenancePhase(ws, "diff --git a/src/a.ts b/src/a.ts\n+const answer = 42;\n", {});
  assert.equal(ws.readText("npm-package-comparisons.json"), "");
  // This run DOES carry the #1819 bump, but the registry host is not
  // allowlisted: every read fails closed and the rewritten artifact verifies
  // nothing (no network touched: the allowlist refuses before any request).
  await runNpmPackageProvenancePhase(ws, LOCKFILE_DIFF, {});
  const artifact = JSON.parse(ws.readText("npm-package-comparisons.json")!) as { schema: string; verified: unknown[] };
  assert.equal(artifact.schema, NPM_COMPARISONS_ARTIFACT_SCHEMA);
  assert.deepEqual(artifact.verified, []);
});

test("the rendered section rides in the corpus body between the provenance sections", async () => {
  const { markdown } = await renderFixture();
  const withSection = buildReviewCorpus(
    { ...baseWorkspace(), npmPackageProvenanceMd: new TextEncoder().encode(markdown) },
    baseOptions,
  );
  const corpus = dec(withSection.artifacts.get("review-corpus.md"));
  assert.ok(corpus.includes("# Published npm Package Comparison"), "the section heading lands in the body");
  assert.ok(corpus.includes("## `types/node` 26.6.7 → 26.6.10"), "the section body is carried verbatim");
  const digestAt = corpus.indexOf("# Image Digest Provenance");
  const npmAt = corpus.indexOf("# Published npm Package Comparison");
  const linkedAt = corpus.indexOf("# Linked Sources");
  assert.ok(npmAt > digestAt, "the npm comparison follows the provenance evidence it complements");
  assert.ok(npmAt < linkedAt, "the npm comparison precedes the low-value tail sections");

  // An absent/null field adds nothing and keeps the pre-#1821 bytes.
  const without = dec(buildReviewCorpus(baseWorkspace(), baseOptions).artifacts.get("review-corpus.md"));
  const nullField = dec(buildReviewCorpus({ ...baseWorkspace(), npmPackageProvenanceMd: null }, baseOptions).artifacts.get("review-corpus.md"));
  assert.ok(!without.includes("Published npm Package Comparison"));
  assert.equal(nullField, without);
});
