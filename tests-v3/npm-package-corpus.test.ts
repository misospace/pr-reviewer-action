/** #1821 AC5 (provider-free integration): the pure diff decision, the exact
 * published-package comparison over injected seams (fake registry docs +
 * hand-built tarballs, no network, no model), and the corpus wiring that
 * renders the section into the review body. */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  buildNpmPackageProvenance,
  type NpmFetchBytes,
  type NpmFetchJson,
} from "../src/context/index.js";
import { npmPackageChangesFromDiff } from "../src/run/stages.js";
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
 * file and a changed declaration, so the delta is non-empty and observable. */
function publishedTarball(version: string, extra?: { name: string; body: string }): Uint8Array {
  const members: TarMember[] = [
    { name: "package/package.json", body: JSON.stringify({ name: "@types/node", version }) },
    { name: "package/index.d.ts", body: `// ${version}\n` },
  ];
  if (extra !== undefined) members.push({ name: `package/${extra.name}`, body: extra.body });
  return tarGz(members);
}

function registryDoc(version: string, tarball: Uint8Array): Record<string, unknown> {
  return {
    name: "@types/node",
    version,
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
async function renderSection(): Promise<string> {
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
  const { markdown } = await buildNpmPackageProvenance(
    [{ slug: "types/node", oldVersion: "26.6.7", newVersion: "26.6.10" }],
    { fetchJson, fetchBytes },
  );
  return markdown;
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

test("the seam-driven comparison renders the resolved package-version delta", async () => {
  const markdown = await renderSection();
  assert.ok(markdown.includes("## `types/node` 26.6.7 → 26.6.10"), "the bump row renders with the scope-normalized slug");
  assert.ok(markdown.includes("exact published package contents"), "the comparison method is disclosed");
  assert.ok(markdown.includes("package-version delta"), "the delta is never read as a source-commit delta");
  assert.ok(markdown.includes("- Added files (1):"), "the new file is itemized");
  assert.ok(markdown.includes("`added.d.ts`"));
  assert.ok(markdown.includes("- Changed files (2):"), "the changed declaration is itemized");
  assert.ok(markdown.includes("`index.d.ts`"));
  assert.ok(!markdown.includes(": **unresolved**"), "a fully verified read renders no unresolved version row");
  assert.ok(!markdown.includes("Delta: **unresolved**"), "the delta is resolved, not fail-closed");
});

test("the rendered section rides in the corpus body between the provenance sections", async () => {
  const markdown = await renderSection();
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
