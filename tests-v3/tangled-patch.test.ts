/** Tangled pull patch decoding (#586) — pure, fail-closed tests for
 * `src/platform/tangled-patch.ts`.
 *
 * Three steps, all deterministic and I/O-free:
 *   pull record ── selectLatestPullRound ──▶ TangledPullRound
 *   blob bytes  ── decodeTangledPatchBlob ─▶ patch text (UTF-8, BOM-stripped)
 *   patch text  ── normalizeGitFormatPatch─▶ { diff, files, headSha }
 *
 * The git-format-patch fixtures below are REAL `git format-patch` output
 * (captured with `git init` + commits + `format-patch` in a scratch repo),
 * so the mail envelope (`From <sha> Mon Sep 17 00:00:00 1997`), mail headers,
 * diffstat, `index`/mode lines, and the `-- \n<git-version>` signature
 * trailer are all exactly what git produces — including the tab git appends
 * to `---`/`+++` for a path with a space, and the octal-quoted (`\303\251`)
 * non-ASCII path under `core.quotePath`. The trust posture under test: the
 * record, blob bytes, and patch text are UNTRUSTED, and the module fails
 * closed with exactly one `TangledPatchError` kind per failure, never
 * falling back to an older round and never reporting an empty diff as
 * success. */
import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  selectLatestPullRound,
  decodeTangledPatchBlob,
  normalizeGitFormatPatch,
  TangledPatchError,
} from "../src/platform/tangled-patch.js";
import type { TangledPatchFailure } from "../src/platform/tangled-patch.js";

// ── helpers ─────────────────────────────────────────────────────────────

/** A valid `sh.tangled.repo.pull` round whose BlobRef carries a non-empty
 * `$link` CID. */
const CREATED_AT = "2026-01-05T10:00:00Z";
const MIME = "application/x-git-format-patch";
const SIZE = 1234;

function roundWith(cid: string): Record<string, unknown> {
  return { createdAt: CREATED_AT, patchBlob: { $link: cid, mimeType: MIME, size: SIZE } };
}

/** Assert `fn` throws a `TangledPatchError` of the given `kind` (and, when
 * `messageRe` is given, whose message matches). */
function throwsKind(fn: () => unknown, kind: TangledPatchFailure, messageRe?: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    const got = e instanceof TangledPatchError ? e.kind : `<not TangledPatchError: ${e}>`;
    if (got !== kind) {
      throw new Error(`expected kind "${kind}", got "${got}" (msg: ${e instanceof Error ? e.message : "?"})`);
    }
    if (messageRe && !(e instanceof Error && messageRe.test(e.message))) {
      throw new Error(`kind "${kind}" matched but message "${e instanceof Error ? e.message : "?"}" !~ ${messageRe}`);
    }
    return true;
  });
}

/** A 40-hex commit sha for crafting mail envelopes in the edge tests. */
const SHA40 = "0123456789abcdef0123456789abcdef01234567";

const F_MODIFY = "From 9e413cdfd8a7c2d93a41dfeb3a6c7c82f9314208 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] modify file\n\n---\n file.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/file.txt b/file.txt\nindex fbbee86..cd964df 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n-- \n2.39.5\n\n";
const F_ADD = "From ecc83624543eb092d086382719942003b31895d7 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] add file\n\n---\n brand-new.txt | 2 ++\n 1 file changed, 2 insertions(+)\n create mode 100644 brand-new.txt\n\ndiff --git a/brand-new.txt b/brand-new.txt\nnew file mode 100644\nindex 0000000..94954ab\n--- /dev/null\n+++ b/brand-new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n-- \n2.39.5\n\n";
const F_DELETE = "From a00233b67505e9fa630dd07ea4047a607777b4de Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] delete file\n\n---\n doomed.txt | 2 --\n 1 file changed, 2 deletions(-)\n delete mode 100644 doomed.txt\n\ndiff --git a/doomed.txt b/doomed.txt\ndeleted file mode 100644\nindex e5c5c55..0000000\n--- a/doomed.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line one\n-line two\n-- \n2.39.5\n\n";
const F_RENAME = "From 91043625f37f7c060e50eb3fadfaf94a9496d694 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] rename and edit\n\n---\n original.txt => renamed.txt | 1 +\n 1 file changed, 1 insertion(+)\n rename original.txt => renamed.txt (57%)\n\ndiff --git a/original.txt b/renamed.txt\nsimilarity index 57%\nrename from original.txt\nrename to renamed.txt\nindex 814f4a4..4cb29ea 100644\n--- a/original.txt\n+++ b/renamed.txt\n@@ -1,2 +1,3 @@\n one\n two\n+three\n-- \n2.39.5\n\n";
const F_MULTI = "From d93be07b7322d6fd51f89370aac6d7f5e5f51a04 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] touch both files\n\n---\n one.txt | 1 +\n two.txt | 1 +\n 2 files changed, 2 insertions(+)\n\ndiff --git a/one.txt b/one.txt\nindex da0f8ed..0016606 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1,2 @@\n a1\n+a2\ndiff --git a/two.txt b/two.txt\nindex c9c6af7..9b89cd5 100644\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1,2 @@\n b1\n+b2\n-- \n2.39.5\n\n";
const F_TWO = "From 9786aba8af8b77ea44f406f7ea404df78d1f2f13 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH 1/2] first change\n\n---\n x.txt | 1 +\n 1 file changed, 1 insertion(+)\n create mode 100644 x.txt\n\ndiff --git a/x.txt b/x.txt\nnew file mode 100644\nindex 0000000..587be6b\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n-- \n2.39.5\n\n\nFrom 63e2c71688d654f5186ca42d9d7a115e6b24e484 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH 2/2] second change\n\n---\n x.txt | 1 +\n 1 file changed, 1 insertion(+)\n\ndiff --git a/x.txt b/x.txt\nindex 587be6b..b77b4eb 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1,2 @@\n x\n+y\n-- \n2.39.5\n\n";
const F_SPACE = "From c3c7a56588e443aff202789398899247aac28178 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] modify spaced file\n\n---\n base file.txt | 1 +\n 1 file changed, 1 insertion(+)\n\ndiff --git a/base file.txt b/base file.txt\nindex 655c6e6..e0e0758 100644\n--- a/base file.txt\t\n+++ b/base file.txt\t\n@@ -1 +1,2 @@\n s1\n+s2\n-- \n2.39.5\n\n";
const F_UTF8 = "From e292aaecdf7a6b594490468ee5f85ddcbc61520d Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] modify utf8 path\n\n---\n \"caf\\303\\251.txt\" | 1 +\n 1 file changed, 1 insertion(+)\n\ndiff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\nindex 3eac62e..2fe4df4 100644\n--- \"a/caf\\303\\251.txt\"\n+++ \"b/caf\\303\\251.txt\"\n@@ -1 +1,2 @@\n n1\n+n2\n-- \n2.39.5\n\n";
const F_BINARY = "From a51e34999b0131084b6afe3905b265065374f5f3 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] add binary\n\n---\n blob.bin | Bin 0 -> 5 bytes\n 1 file changed, 0 insertions(+), 0 deletions(-)\n create mode 100644 blob.bin\n\ndiff --git a/blob.bin b/blob.bin\nnew file mode 100644\nindex 0000000..006f8dd\nBinary files /dev/null and b/blob.bin differ\n-- \n2.39.5\n\n";
// ═══════════════════════════════════════════════════════════════════════
// selectLatestPullRound
// ═══════════════════════════════════════════════════════════════════════

test("selectLatestPullRound picks the single valid round", () => {
  const r = selectLatestPullRound({ rounds: [roundWith("cid-single")] });
  assert.equal(r.index, 0);
  assert.equal(r.createdAt, CREATED_AT);
  assert.equal(r.blobCid, "cid-single");
  assert.equal(r.mimeType, MIME);
  assert.equal(r.size, SIZE);
});

test("selectLatestPullRound picks the LAST of multiple rounds", () => {
  const r = selectLatestPullRound({ rounds: [roundWith("cid-0"), roundWith("cid-1"), roundWith("cid-2")] });
  assert.equal(r.index, 2);
  assert.equal(r.blobCid, "cid-2");
});

test("selectLatestPullRound: missing / empty / non-array rounds -> no-round", () => {
  throwsKind(() => selectLatestPullRound({}), "no-round");
  throwsKind(() => selectLatestPullRound({ rounds: [] }), "no-round");
  throwsKind(() => selectLatestPullRound({ rounds: "not-an-array" }), "no-round");
});

test("selectLatestPullRound: every malformation of the LAST round -> invalid-round", () => {
  // not an object
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), "not-an-object"] }), "invalid-round", /not an object/);
  // createdAt missing
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { patchBlob: { $link: "x" } }] }), "invalid-round", /createdAt/);
  // createdAt empty
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: "", patchBlob: { $link: "x" } }] }), "invalid-round", /createdAt/);
  // createdAt non-string
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: 5, patchBlob: { $link: "x" } }] }), "invalid-round", /createdAt/);
  // patchBlob missing
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: CREATED_AT }] }), "invalid-round", /patchBlob/);
  // patchBlob not an object
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: CREATED_AT, patchBlob: "nope" }] }), "invalid-round", /patchBlob/);
  // patchBlob with no CID at all
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: CREATED_AT, patchBlob: {} }] }), "invalid-round", /CID/);
  // patchBlob with empty-string CID
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: CREATED_AT, patchBlob: { $link: "" } }] }), "invalid-round", /CID/);
  // patchBlob with non-string CID
  throwsKind(() => selectLatestPullRound({ rounds: [roundWith("ok"), { createdAt: CREATED_AT, patchBlob: { $link: 42 } }] }), "invalid-round", /CID/);
});

test("selectLatestPullRound accepts $link or ref as the CID ($link wins)", () => {
  const byRef = selectLatestPullRound({ rounds: [{ createdAt: CREATED_AT, patchBlob: { ref: "cid-ref" } }] });
  assert.equal(byRef.blobCid, "cid-ref");
  const byLinkAndRef = selectLatestPullRound({ rounds: [{ createdAt: CREATED_AT, patchBlob: { $link: "cid-link", ref: "cid-ref" } }] });
  assert.equal(byLinkAndRef.blobCid, "cid-link");
});

test("selectLatestPullRound: a corrupt LAST round does NOT fall back to an earlier valid round", () => {
  // round 0 is perfectly valid, but the selection only ever inspects the LAST
  // round (round 1), which is corrupt — so it must fail closed, never return
  // round 0's CID.
  const valid0 = roundWith("cid-valid-0");
  throwsKind(() => selectLatestPullRound({ rounds: [valid0, { createdAt: CREATED_AT }] }), "invalid-round");
});

// ═══════════════════════════════════════════════════════════════════════
// decodeTangledPatchBlob
// ═══════════════════════════════════════════════════════════════════════

test("decodeTangledPatchBlob round-trips a real gzip of a git patch fixture", () => {
  const gz = gzipSync(Buffer.from(F_MODIFY));
  assert.equal(decodeTangledPatchBlob(gz), F_MODIFY);
});

test("decodeTangledPatchBlob: non-gzip bytes -> undecodable-blob", () => {
  throwsKind(() => decodeTangledPatchBlob(Buffer.from("definitely not a gzip stream")), "undecodable-blob", /gzip magic/);
  throwsKind(() => decodeTangledPatchBlob(new Uint8Array([0x1f])), "undecodable-blob", /gzip magic/); // too short for the magic
  throwsKind(() => decodeTangledPatchBlob(new Uint8Array([0x00, 0x01, 0x02, 0x03])), "undecodable-blob", /gzip magic/);
});

test("decodeTangledPatchBlob: truncated gzip -> undecodable-blob", () => {
  const gz = gzipSync(Buffer.from(F_MODIFY));
  const truncated = new Uint8Array(gz.subarray(0, 16)); // header + a few bytes, no stream end / trailer
  throwsKind(() => decodeTangledPatchBlob(truncated), "undecodable-blob", /gunzip failed/);
});

test("decodeTangledPatchBlob: decompressed size over maxBytes -> patch-too-large", () => {
  const gz = gzipSync(Buffer.from("A".repeat(20000))); // decompresses to 20000 bytes
  throwsKind(() => decodeTangledPatchBlob(gz, 100), "patch-too-large", /limit/);
});

test("decodeTangledPatchBlob strips a leading UTF-8 BOM", () => {
  const gz = gzipSync(Buffer.from("\uFEFF" + F_MODIFY));
  assert.equal(decodeTangledPatchBlob(gz), F_MODIFY); // the BOM is not part of the result
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — single-commit fixtures (real git output)
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: single modify -> modified, counts, headSha, clean diff", () => {
  const n = normalizeGitFormatPatch(F_MODIFY);
  assert.equal(n.headSha, "9e413cdfd8a7c2d93a41dfeb3a6c7c82f9314208");
  assert.equal(n.files.length, 1);
  const f = n.files[0]!;
  assert.equal(f.filename, "file.txt");
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  assert.equal(f.changes, 2);
  assert.equal(f.previous_filename, null);
  // The diff is a pure unified diff: no mail From line, no signature trailer,
  // no diffstat, exactly one file section.
  assert.ok(!n.diff.includes(`From ${n.headSha} Mon Sep 17`));
  assert.ok(!n.diff.includes("-- \n2.39.5"));
  assert.ok(!/ file[s]? changed,/.test(n.diff));
  assert.equal((n.diff.match(/^diff --git /gm) ?? []).length, 1);
  assert.ok(n.diff.startsWith("diff --git a/file.txt b/file.txt"));
  // per-file patch matches the joined diff for a single file
  assert.equal(n.diff, f.patch);
});

test("normalizeGitFormatPatch: add -> added (b side name, +++/--- excluded from counts)", () => {
  const n = normalizeGitFormatPatch(F_ADD);
  assert.equal(n.headSha, "ecc83624543eb092d086382719942003b31895d7");
  const f = n.files[0]!;
  assert.equal(f.filename, "brand-new.txt");
  assert.equal(f.status, "added");
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
  assert.equal(f.changes, 2);
  assert.equal(f.previous_filename, null);
});

test("normalizeGitFormatPatch: delete -> removed (name from the a side, /dev/null b side)", () => {
  const n = normalizeGitFormatPatch(F_DELETE);
  assert.equal(n.headSha, "a00233b67505e9fa630dd07ea4047a607777b4de");
  const f = n.files[0]!;
  assert.equal(f.filename, "doomed.txt");
  assert.equal(f.status, "removed");
  assert.equal(f.additions, 0);
  assert.equal(f.deletions, 2);
  assert.equal(f.changes, 2);
  assert.equal(f.previous_filename, null);
});

test("normalizeGitFormatPatch: rename with edit -> renamed (rename to/from fix name + previous)", () => {
  const n = normalizeGitFormatPatch(F_RENAME);
  assert.equal(n.headSha, "91043625f37f7c060e50eb3fadfaf94a9496d694");
  const f = n.files[0]!;
  assert.equal(f.filename, "renamed.txt");
  assert.equal(f.status, "renamed");
  assert.equal(f.previous_filename, "original.txt");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
  assert.equal(f.changes, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — multi-file / multi-commit fixtures
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: multi-file single commit -> one section per file, each isolated", () => {
  const n = normalizeGitFormatPatch(F_MULTI);
  assert.equal(n.headSha, "d93be07b7322d6fd51f89370aac6d7f5e5f51a04");
  assert.equal(n.files.length, 2);
  const [f0, f1] = [n.files[0]!, n.files[1]!];
  assert.equal(f0.filename, "one.txt");
  assert.equal(f0.status, "modified");
  assert.equal(f0.additions, 1);
  assert.equal(f0.deletions, 0);
  assert.equal(f1.filename, "two.txt");
  assert.equal(f1.status, "modified");
  assert.equal(f1.additions, 1);
  assert.equal(f1.deletions, 0);
  // each file.patch contains ONLY its own section
  assert.ok(f0.patch.startsWith("diff --git a/one.txt b/one.txt"));
  assert.ok(!f0.patch.includes("two.txt"));
  assert.ok(f1.patch.startsWith("diff --git a/two.txt b/two.txt"));
  assert.ok(!f1.patch.includes("one.txt"));
  // the joined diff has exactly two sections, no mail headers / trailer / diffstat
  assert.equal((n.diff.match(/^diff --git /gm) ?? []).length, 2);
  assert.ok(!n.diff.includes(`From ${n.headSha} Mon Sep 17`));
  assert.ok(!n.diff.includes("-- \n2.39.5"));
  assert.ok(!/ file[s]? changed,/.test(n.diff));
});

test("normalizeGitFormatPatch: two-commit range -> headSha is the LAST commit, one section per commit", () => {
  const n = normalizeGitFormatPatch(F_TWO);
  // headSha must be the SECOND commit's sha, not the first
  assert.equal(n.headSha, "63e2c71688d654f5186ca42d9d7a115e6b24e484");
  assert.equal(n.files.length, 2);
  // first commit added x.txt; second commit modified x.txt
  assert.equal(n.files[0]!.status, "added");
  assert.equal(n.files[0]!.filename, "x.txt");
  assert.equal(n.files[1]!.status, "modified");
  assert.equal(n.files[1]!.filename, "x.txt");
  // both mail From lines and both signature trailers are stripped from the diff
  assert.equal((n.diff.match(/^diff --git /gm) ?? []).length, 2);
  assert.ok(!n.diff.includes("From 9786aba8af8b77ea44f406f7ea404df78d1f2f13 Mon Sep 17"));
  assert.ok(!n.diff.includes("From 63e2c71688d654f5186ca42d9d7a115e6b24e484 Mon Sep 17"));
  assert.ok(!n.diff.includes("-- \n2.39.5"));
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — path-quoting edge fixtures
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: filename with a space is unquoted and preserved", () => {
  const n = normalizeGitFormatPatch(F_SPACE);
  assert.equal(n.headSha, "c3c7a56588e443aff202789398899247aac28178");
  const f = n.files[0]!;
  assert.equal(f.filename, "base file.txt"); // the space survives
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

test("normalizeGitFormatPatch: non-ASCII octal-quoted path decodes to the real name", () => {
  const n = normalizeGitFormatPatch(F_UTF8);
  assert.equal(n.headSha, "e292aaecdf7a6b594490468ee5f85ddcbc61520d");
  const f = n.files[0]!;
  assert.equal(f.filename, "café.txt"); // octal \303\251 -> é (U+00E9)
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

test("normalizeGitFormatPatch: binary add -> added with zero line counts", () => {
  const n = normalizeGitFormatPatch(F_BINARY);
  assert.equal(n.headSha, "a51e34999b0131084b6afe3905b265065374f5f3");
  const f = n.files[0]!;
  assert.equal(f.filename, "blob.bin");
  assert.equal(f.status, "added");
  assert.equal(f.additions, 0);
  assert.equal(f.deletions, 0);
  assert.equal(f.changes, 0);
  // the binary marker is kept in the section
  assert.ok(f.patch.includes("Binary files /dev/null and b/blob.bin differ"));
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — fail-closed edge cases
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: envelope with no diff section (cover letter) -> empty-patch", () => {
  const cover =
    `From ${SHA40} Mon Sep 17 00:00:00 1997\n` +
    "From: X <x@example.com>\n" +
    "Subject: [PATCH] cover letter only\n" +
    "\n" +
    "This mail has an envelope but no `diff --git` section at all.\n" +
    "-- \n2.39.5\n";
  throwsKind(() => normalizeGitFormatPatch(cover), "empty-patch");
});

test("normalizeGitFormatPatch: bare unified diff without a From envelope -> malformed-patch", () => {
  const bare =
    "diff --git a/file.txt b/file.txt\n" +
    "index 1a2b3c4..5d6e7f8 100644\n" +
    "--- a/file.txt\n" +
    "+++ b/file.txt\n" +
    "@@ -1 +1 @@\n" +
    "-a\n" +
    "+b\n";
  throwsKind(() => normalizeGitFormatPatch(bare), "malformed-patch");
});

test("normalizeGitFormatPatch: empty / whitespace-only text -> empty-patch", () => {
  throwsKind(() => normalizeGitFormatPatch(""), "empty-patch");
  throwsKind(() => normalizeGitFormatPatch("   \n  \n"), "empty-patch");
});

test("normalizeGitFormatPatch: text over the 32 MiB hard cap -> malformed-patch before parsing", () => {
  const over = "a".repeat(32 * 1024 * 1024 + 1);
  throwsKind(() => normalizeGitFormatPatch(over), "malformed-patch");
});

