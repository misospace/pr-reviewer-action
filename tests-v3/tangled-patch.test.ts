/** Tangled pull patch decoding (#586) — pure, fail-closed tests for
 * `src/platform/tangled-patch.ts`.
 *
 * Three steps, all deterministic and I/O-free:
 *   pull record ── selectLatestPullRound ──▶ TangledPullRound
 *   blob bytes  ── decodeTangledPatchBlob ─▶ patch text (UTF-8, BOM-stripped)
 *   patch text  ── normalizeGitFormatPatch─▶ { diff, files, declaredHeadSha }
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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
// Year-flexible (2001) REAL git fixtures: this container's git stamps the
// mbox `From` line with `Mon Sep 17 00:00:00 2001`, not the 1997 placeholder.
// The envelope accepts any 4-digit year, so these normalize identically to
// the 1997-style fixtures above.
const F2001_MODIFY = "From 8974ba852cffe9366225127739cbc31d4d12c4af Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:18:29 +0000\nSubject: [PATCH] modify file\n\n---\n file.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/file.txt b/file.txt\nindex 4a58007..65b2df8 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-alpha\n+beta\n-- \n2.39.5\n\n";
const F2001_ADD = "From 836bf99246c907d0e886caad6250ed6f46666e93 Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:18:52 +0000\nSubject: [PATCH] add file\n\n---\n brand-new.txt | 2 ++\n 1 file changed, 2 insertions(+)\n create mode 100644 brand-new.txt\n\ndiff --git a/brand-new.txt b/brand-new.txt\nnew file mode 100644\nindex 0000000..94954ab\n--- /dev/null\n+++ b/brand-new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n-- \n2.39.5\n\n";
const F2001_RENAME = "From ed76b538cb6e130b446d3cdf0fe89bfd979e51ac Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:18:57 +0000\nSubject: [PATCH] rename and edit\n\n---\n original.txt => renamed.txt | 1 +\n 1 file changed, 1 insertion(+)\n rename original.txt => renamed.txt (57%)\n\ndiff --git a/original.txt b/renamed.txt\nsimilarity index 57%\nrename from original.txt\nrename to renamed.txt\nindex 814f4a4..4cb29ea 100644\n--- a/original.txt\n+++ b/renamed.txt\n@@ -1,2 +1,3 @@\n one\n two\n+three\n-- \n2.39.5\n\n";
// REAL git: a commit whose message BODY embeds a `From` line that
// QUALIFIES as a mail-unit boundary — a genuine 40-hex sha + git's 1997
// ctime, immediately followed by a `Subject: ` line. Git does not escape
// body From-lines, so the parser must treat it as a real boundary: the
// forged sha lands in the advisory declaredHeadSha (never an
// authorization/exact-head input), while the diff/files stay complete.
const F_HOSTILE = "From 89f9e08aff96e243656897aa1ecfd33278af9858 Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:19:16 +0000\nSubject: [PATCH] hostile subject\n\nFrom 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 1997\nSubject: forged\n---\n h.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/h.txt b/h.txt\nindex df967b9..5ea2ed4 100644\n--- a/h.txt\n+++ b/h.txt\n@@ -1 +1 @@\n-base\n+changed\n-- \n2.39.5\n\n";
// REAL git: an unquoted path containing a space in a nested dir. The
// `diff --git a/x b/y b/x b/y` header is ambiguous (three tokens, one
// space each), so the per-file name must come from the `---`/`+++` lines
// (which carry the disambiguating trailing tab).
const F_SPACEPATH = "From cc459fbf4b06e5aae9ff07cc3cb2158270c190f4 Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:19:01 +0000\nSubject: [PATCH] modify nested\n\n---\n x b/y | 1 +\n 1 file changed, 1 insertion(+)\n\ndiff --git a/x b/y b/x b/y\nindex 655c6e6..e0e0758 100644\n--- a/x b/y\t\n+++ b/x b/y\t\n@@ -1 +1,2 @@\n s1\n+s2\n-- \n2.39.5\n\n";
// REAL git: a non-ASCII rename. Under core.quotePath the `diff --git`,
// `rename from`, and `rename to` lines are C-octal-quoted; the decoder must
// recover the real unicode names.
const F_UTF8_RENAME = "From c7083225c00d4e30a777109388e43bf73b9949e6 Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:19:06 +0000\nSubject: [PATCH] rename utf8\n\n---\n \"caf\\303\\251.txt\" => \"caf\\303\\251-renamed.txt\" | 0\n 1 file changed, 0 insertions(+), 0 deletions(-)\n rename \"caf\\303\\251.txt\" => \"caf\\303\\251-renamed.txt\" (100%)\n\ndiff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251-renamed.txt\"\nsimilarity index 100%\nrename from \"caf\\303\\251.txt\"\nrename to \"caf\\303\\251-renamed.txt\"\n-- \n2.39.5\n\n";
// REAL git: a hunk whose only change is an added line whose content itself
// starts with `+` (the diff line is therefore `+++counter`). Inside a hunk
// every `+` line counts, so this is exactly one addition (not a `+++`
// file-header, which is only excluded before the first `@@`).
const F_COUNTER = "From da74c0ed06346c9a7c11bbde616f7cedd3ab1fae Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:19:10 +0000\nSubject: [PATCH] add counter\n\n---\n c.txt | 1 +\n 1 file changed, 1 insertion(+)\n\ndiff --git a/c.txt b/c.txt\nindex cbaf024..af707e0 100644\n--- a/c.txt\n+++ b/c.txt\n@@ -1 +1,2 @@\n existing\n+++counter\n-- \n2.39.5\n\n";
// REAL git: a single commit touching multiple files, one of which is a
// rename. Used by the `git apply --check` round-trip test.
const F_MULTI_RENAME = "From 99fb396f0ce081e5dad89c0bdac28fee2f7834c1 Mon Sep 17 00:00:00 2001\nFrom: Courier <courier@localhost>\nDate: Thu, 8 Oct 2026 03:20:45 +0000\nSubject: [PATCH] multi with rename\n\n---\n a.txt => b.txt | 2 ++\n keep.txt       | 1 +\n new.txt        | 1 +\n 3 files changed, 4 insertions(+)\n rename a.txt => b.txt (70%)\n create mode 100644 new.txt\n\ndiff --git a/a.txt b/b.txt\nsimilarity index 70%\nrename from a.txt\nrename to b.txt\nindex 85c3040..5367b48 100644\n--- a/a.txt\n+++ b/b.txt\n@@ -1,3 +1,5 @@\n alpha\n beta\n gamma\n+\n+added\ndiff --git a/keep.txt b/keep.txt\nindex b68fde2..ad2705a 100644\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1,2 @@\n k\n+k2\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..8ba3a16\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+n\n-- \n2.39.5\n\n";
// SYNTHETIC: a real modify patch carrying an Apple-git-style signature
// trailer `2.39.5 (Apple Git-154)`. The `-- ` marker line must be stripped
// (and so must not inflate the file's deletion count).
const F_APPLE = "From a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 Mon Sep 17 00:00:00 2001\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH] apple sig\n\n---\n file.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n\ndiff --git a/file.txt b/file.txt\nindex 4a58007..65b2df8 100644\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+BETA\n-- \n2.39.5 (Apple Git-154)\n\n";
// SYNTHETIC: a two-mail stream whose FIRST mail body contains a line that
// matches the mbox `From` boundary regex exactly (40-hex sha + ctime) but is
// NOT followed by a real mail header (it is followed by prose). The boundary
// detection must therefore reject it, yielding exactly two units.
const F_TWO_FAKE_BOUNDARY = "From 9786aba8af8b77ea44f406f7ea404df78d1f2f13 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH 1/2] first change\n\nFrom 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 1997\njust prose in the first mail body, not a mail header\n---\n x.txt | 1 +\n 1 file changed, 1 insertion(+)\n create mode 100644 x.txt\n\ndiff --git a/x.txt b/x.txt\nnew file mode 100644\nindex 0000000..587be6b\n--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+x\n-- \n2.39.5\n\n\nFrom 63e2c71688d654f5186ca42d9d7a115e6b24e484 Mon Sep 17 00:00:00 1997\nFrom: Fixture Author <fixture@example.com>\nDate: Mon, 5 Jan 2026 10:00:00 +0000\nSubject: [PATCH 2/2] second change\n\n---\n x.txt | 1 +\n 1 file changed, 1 insertion(+)\n\ndiff --git a/x.txt b/x.txt\nindex 587be6b..b77b4eb 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1,2 @@\n x\n+y\n-- \n2.39.5\n\n";
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

test("normalizeGitFormatPatch: single modify -> modified, counts, declaredHeadSha, clean diff", () => {
  const n = normalizeGitFormatPatch(F_MODIFY);
  assert.equal(n.declaredHeadSha, "9e413cdfd8a7c2d93a41dfeb3a6c7c82f9314208");
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
  assert.ok(!n.diff.includes(`From ${n.declaredHeadSha} Mon Sep 17`));
  assert.ok(!n.diff.includes("-- \n2.39.5"));
  assert.ok(!/ file[s]? changed,/.test(n.diff));
  assert.equal((n.diff.match(/^diff --git /gm) ?? []).length, 1);
  assert.ok(n.diff.startsWith("diff --git a/file.txt b/file.txt"));
  // per-file patch matches the joined diff for a single file
  assert.equal(n.diff, f.patch);
});

test("normalizeGitFormatPatch: add -> added (b side name, +++/--- excluded from counts)", () => {
  const n = normalizeGitFormatPatch(F_ADD);
  assert.equal(n.declaredHeadSha, "ecc83624543eb092d086382719942003b31895d7");
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
  assert.equal(n.declaredHeadSha, "a00233b67505e9fa630dd07ea4047a607777b4de");
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
  assert.equal(n.declaredHeadSha, "91043625f37f7c060e50eb3fadfaf94a9496d694");
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
  assert.equal(n.declaredHeadSha, "d93be07b7322d6fd51f89370aac6d7f5e5f51a04");
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
  assert.ok(!n.diff.includes(`From ${n.declaredHeadSha} Mon Sep 17`));
  assert.ok(!n.diff.includes("-- \n2.39.5"));
  assert.ok(!/ file[s]? changed,/.test(n.diff));
});

test("normalizeGitFormatPatch: two-commit range -> declaredHeadSha is the LAST commit, one section per commit", () => {
  const n = normalizeGitFormatPatch(F_TWO);
  // declaredHeadSha must be the SECOND commit's sha, not the first
  assert.equal(n.declaredHeadSha, "63e2c71688d654f5186ca42d9d7a115e6b24e484");
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
  assert.equal(n.declaredHeadSha, "c3c7a56588e443aff202789398899247aac28178");
  const f = n.files[0]!;
  assert.equal(f.filename, "base file.txt"); // the space survives
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

test("normalizeGitFormatPatch: non-ASCII octal-quoted path decodes to the real name", () => {
  const n = normalizeGitFormatPatch(F_UTF8);
  assert.equal(n.declaredHeadSha, "e292aaecdf7a6b594490468ee5f85ddcbc61520d");
  const f = n.files[0]!;
  assert.equal(f.filename, "café.txt"); // octal \303\251 -> é (U+00E9)
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

test("normalizeGitFormatPatch: binary add -> added with zero line counts", () => {
  const n = normalizeGitFormatPatch(F_BINARY);
  assert.equal(n.declaredHeadSha, "a51e34999b0131084b6afe3905b265065374f5f3");
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

test("normalizeGitFormatPatch: text over the 32 MiB hard cap -> patch-too-large before parsing", () => {
  const over = "a".repeat(32 * 1024 * 1024 + 1);
  throwsKind(() => normalizeGitFormatPatch(over), "patch-too-large");
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — year-flexible (2001) mail headers
//
// The 1997 placeholder in the examples above is git's canonical ctime; this
// container's git emits `Mon Sep 17 00:00:00 2001`. The envelope accepts any
// 4-digit year, so every 2001-dated fixture below normalizes identically to
// its 1997 twin, which also pins that a non-1997 year is never mis-read as
// non-envelope text.
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: 2001-dated modify normalizes like 1997", () => {
  const n = normalizeGitFormatPatch(F2001_MODIFY);
  assert.equal(n.declaredHeadSha, "8974ba852cffe9366225127739cbc31d4d12c4af");
  const f = n.files[0]!;
  assert.equal(f.filename, "file.txt");
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  assert.equal(f.changes, 2);
  assert.equal(f.previous_filename, null);
  assert.ok(n.diff.startsWith("diff --git a/file.txt b/file.txt"));
  assert.ok(!n.diff.includes("2.39.5")); // signature stripped
});

test("normalizeGitFormatPatch: 2001-dated add normalizes like 1997", () => {
  const n = normalizeGitFormatPatch(F2001_ADD);
  assert.equal(n.declaredHeadSha, "836bf99246c907d0e886caad6250ed6f46666e93");
  const f = n.files[0]!;
  assert.equal(f.filename, "brand-new.txt");
  assert.equal(f.status, "added");
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
  assert.equal(f.previous_filename, null);
});

test("normalizeGitFormatPatch: 2001-dated rename+edit normalizes like 1997", () => {
  const n = normalizeGitFormatPatch(F2001_RENAME);
  assert.equal(n.declaredHeadSha, "ed76b538cb6e130b446d3cdf0fe89bfd979e51ac");
  const f = n.files[0]!;
  assert.equal(f.filename, "renamed.txt");
  assert.equal(f.status, "renamed");
  assert.equal(f.previous_filename, "original.txt");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — hostile `From` lines
// (a non-qualifying fake is data, never a boundary; a qualifying 40-hex
// fake is indistinguishable from a real boundary and forges the advisory
// declaredHeadSha)
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: a qualifying forged boundary in a commit body forges declaredHeadSha; diff/files stay complete", () => {
  // The commit message body embeds a GENUINE 40-hex `From <sha> <ctime>`
  // line (git's 1997 ctime) immediately followed by a `Subject: ` line —
  // exactly the shape of a real mail-unit boundary, and git does not
  // escape body From-lines, so the parser must treat it as one. The
  // forged sha lands in declaredHeadSha instead of the real commit sha
  // (89f9e08a…): this demonstrates the field is ADVISORY metadata
  // decoded from untrusted content — never an authorization or
  // exact-head input (a verified head requires re-checking trusted
  // knot/record state in a later ticket). The diff/files remain
  // complete: the single h.txt section parses with its real counts.
  const n = normalizeGitFormatPatch(F_HOSTILE);
  assert.equal(n.files.length, 1);
  const f = n.files[0]!;
  assert.equal(f.filename, "h.txt");
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 1);
  assert.equal(f.changes, 2);
  // The forged boundary's sha — NOT the real commit sha 89f9e08a…:
  // advisory and forgeable, never an authorization or exact-head input.
  assert.equal(n.declaredHeadSha, "0123456789abcdef0123456789abcdef01234567");
  // Neither the forged From line nor its 1997 ctime survives into the
  // normalized diff; the hunk content is intact.
  assert.ok(!n.diff.includes("0123456789abcdef0123456789abcdef01234567"));
  assert.ok(!/Mon Sep 17 00:00:00 1997/.test(n.diff));
  assert.ok(n.diff.includes("-base"));
  assert.ok(n.diff.includes("+changed"));
});

test("normalizeGitFormatPatch: a fake 40-hex From in the first mail body still yields exactly 2 units", () => {
  // This fake line MATCHES the boundary regex (40-hex sha + ctime), but the
  // line that follows it is prose, not a `From:`/`Date:`/`Subject:` header —
  // so it is not a boundary. Exactly two units (one per real commit) survive,
  // and declaredHeadSha is the second (last) real commit.
  const n = normalizeGitFormatPatch(F_TWO_FAKE_BOUNDARY);
  assert.equal(n.declaredHeadSha, "63e2c71688d654f5186ca42d9d7a115e6b24e484");
  assert.equal(n.files.length, 2);
  assert.equal(n.files[0]!.status, "added");
  assert.equal(n.files[1]!.status, "modified");
  assert.equal(n.files[0]!.filename, "x.txt");
  assert.equal(n.files[1]!.filename, "x.txt");
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — Apple-style signature trailer
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: Apple-git `2.39.5 (Apple Git-154)` trailer is stripped and does not inflate deletions", () => {
  const n = normalizeGitFormatPatch(F_APPLE);
  assert.equal(n.declaredHeadSha, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  const f = n.files[0]!;
  assert.equal(f.filename, "file.txt");
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  // The single deletion is the real `-beta`; the `-- ` marker line is NOT
  // counted (a `--` in a hunk position would otherwise add a phantom deletion).
  assert.equal(f.deletions, 1);
  // The trailer (marker + Apple version line) is gone from the diff.
  assert.ok(!n.diff.includes("2.39.5 (Apple Git-154)"));
  assert.ok(!n.diff.includes("-- \n"));
  assert.ok(n.diff.endsWith("+BETA\n"));
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — ambiguous / non-ASCII-rename / `+`-content paths
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: ambiguous unquoted space path `x b/y` resolves via ---/+++ to the exact name", () => {
  const n = normalizeGitFormatPatch(F_SPACEPATH);
  assert.equal(n.declaredHeadSha, "cc459fbf4b06e5aae9ff07cc3cb2158270c190f4");
  const f = n.files[0]!;
  assert.equal(f.filename, "x b/y"); // not "x", "b/y", or a joined blob
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

test("normalizeGitFormatPatch: non-ASCII rename decodes octal-quoted rename from/to to the real names", () => {
  const n = normalizeGitFormatPatch(F_UTF8_RENAME);
  assert.equal(n.declaredHeadSha, "c7083225c00d4e30a777109388e43bf73b9949e6");
  const f = n.files[0]!;
  assert.equal(f.status, "renamed");
  assert.equal(f.filename, "café-renamed.txt"); // \303\251 -> é (U+00E9)
  assert.equal(f.previous_filename, "café.txt");
  assert.equal(f.additions, 0);
  assert.equal(f.deletions, 0);
});

test("normalizeGitFormatPatch: an added line whose content starts with `+` counts as exactly 1 addition", () => {
  const n = normalizeGitFormatPatch(F_COUNTER);
  assert.equal(n.declaredHeadSha, "da74c0ed06346c9a7c11bbde616f7cedd3ab1fae");
  const f = n.files[0]!;
  assert.equal(f.filename, "c.txt");
  assert.equal(f.status, "modified");
  // The hunk's `+++counter` line is one addition; the `+++ b/c.txt` file
  // header (before the hunk) is not double-counted.
  assert.equal(f.additions, 1);
  assert.equal(f.deletions, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — malformed-patch edge cases (fail-closed)
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: incomplete rename pair (only `rename from`) -> malformed-patch", () => {
  const p =
    `From ${SHA40} Mon Sep 17 00:00:00 2001\n` +
    "From: X <x@example.com>\n" +
    "Subject: [PATCH] incomplete rename\n" +
    "\n" +
    "---\n" +
    " a.txt => b.txt | 0\n" +
    "\n" +
    "diff --git a/a.txt b/b.txt\n" +
    "rename from a.txt\n" +
    "index 1111111..2222222 100644\n" +
    "--- a/a.txt\n" +
    "+++ b/b.txt\n" +
    "@@ -1 +1 @@\n" +
    "-x\n" +
    "+y\n" +
    "-- \n" +
    "2.39.5\n";
  throwsKind(() => normalizeGitFormatPatch(p), "malformed-patch", /incomplete rename pair/);
});

test("normalizeGitFormatPatch: unterminated quote in the diff header -> malformed-patch", () => {
  const p =
    `From ${SHA40} Mon Sep 17 00:00:00 2001\n` +
    "From: X <x@example.com>\n" +
    "Subject: [PATCH] unclosed\n" +
    "\n" +
    "---\n" +
    " x.txt | 0\n" +
    "\n" +
    'diff --git "a/unclosed.txt b/other.txt\n' +
    "Binary files a/unclosed.txt and b/other.txt differ\n" +
    "-- \n" +
    "2.39.5\n";
  throwsKind(() => normalizeGitFormatPatch(p), "malformed-patch", /unterminated quoted path/);
});

test("normalizeGitFormatPatch: unknown escape \\q in a quoted path -> malformed-patch", () => {
  const p =
    `From ${SHA40} Mon Sep 17 00:00:00 2001\n` +
    "From: X <x@example.com>\n" +
    "Subject: [PATCH] bad escape\n" +
    "\n" +
    "---\n" +
    " x.txt | 0\n" +
    "\n" +
    'diff --git "a/bad\\q.txt" b/other.txt\n' +
    "Binary files a/bad\\q.txt and b/other.txt differ\n" +
    "-- \n" +
    "2.39.5\n";
  throwsKind(() => normalizeGitFormatPatch(p), "malformed-patch", /unknown escape \\q/);
});

test("normalizeGitFormatPatch: diff header with a single (first) path only -> malformed-patch", () => {
  const p =
    `From ${SHA40} Mon Sep 17 00:00:00 2001\n` +
    "From: X <x@example.com>\n" +
    "Subject: [PATCH] one path\n" +
    "\n" +
    "---\n" +
    " only.txt | 0\n" +
    "\n" +
    'diff --git "a/only.txt" \n' +
    "Binary files a/only.txt and /dev/null differ\n" +
    "-- \n" +
    "2.39.5\n";
  throwsKind(() => normalizeGitFormatPatch(p), "malformed-patch", /no second path/);
});

test("normalizeGitFormatPatch: non-whitespace text before the first From boundary -> malformed-patch", () => {
  const p =
    "garbage before envelope\n" +
    `From ${SHA40} Mon Sep 17 00:00:00 2001\n` +
    "From: X <x@example.com>\n" +
    "Subject: [PATCH] x\n" +
    "\n" +
    "---\n" +
    " x.txt | 1 +\n" +
    "\n" +
    "diff --git a/x.txt b/x.txt\n" +
    "new file mode 100644\n" +
    "index 0000000..587be6b\n" +
    "--- /dev/null\n" +
    "+++ b/x.txt\n" +
    "@@ -0,0 +1 @@\n" +
    "+x\n" +
    "-- \n" +
    "2.39.5\n";
  throwsKind(() => normalizeGitFormatPatch(p), "malformed-patch", /non-envelope text before the first mail/);
});

// ═══════════════════════════════════════════════════════════════════════
// normalizeGitFormatPatch — git apply --check round-trip
//
// The normalized `diff` is a real unified diff; if git is available it must
// apply cleanly (check only) onto a working tree matching its a-side.
// ═══════════════════════════════════════════════════════════════════════

test("normalizeGitFormatPatch: joined multi-file+rename diff passes `git apply --check`", (t) => {
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (probe.error) {
    t.skip("git is not available on this host");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tangled-apply-"));
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  try {
    assert.equal(run(["init", "-q"]).status, 0);
    run(["config", "user.email", "fixture@example.com"]);
    run(["config", "user.name", "Fixture Author"]);
    // Rebuild the a-side working tree exactly as the patch expects.
    fs.writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
    fs.writeFileSync(path.join(dir, "keep.txt"), "k\n");
    assert.equal(run(["add", "-A"]).status, 0);
    assert.equal(run(["commit", "-q", "-m", "base"]).status, 0);

    const n = normalizeGitFormatPatch(F_MULTI_RENAME);
    assert.equal(n.files.length, 3); // rename + modify + add
    const patchFile = path.join(dir, "p.patch");
    fs.writeFileSync(patchFile, n.diff);

    const check = run(["apply", "--check", patchFile]);
    assert.equal(check.status, 0, `git apply --check failed: ${check.stderr?.toString() ?? ""}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

