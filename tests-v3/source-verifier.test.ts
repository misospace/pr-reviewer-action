import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHeadSourceReader } from "../src/enforcement/source-verifier.js";
import { applyBlockerVerification } from "../src/enforcement/blocker-verification.js";
import { applyStrictVerdictPolicy } from "../src/enforcement/verdict-policy.js";
import type { ArtifactFinding } from "../src/enforcement/artifact.js";
import type { ReviewArtifact } from "../src/enforcement/artifact.js";

function finding(overrides: Partial<ArtifactFinding> = {}): ArtifactFinding {
  return {
    severity: "blocker",
    category: "bug",
    file: "src/literal.ts",
    line: 1,
    message: "finding",
    ...overrides,
  };
}

function artifact(overrides: Partial<ReviewArtifact> = {}): ReviewArtifact {
  return {
    verdict: "request_changes",
    review_markdown: "review",
    findings: [],
    ...overrides,
  } as ReviewArtifact;
}

const revision = "a".repeat(40);

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("source reader rejects missing revision and unsafe paths", async () => {
  const invalidRevision = createHeadSourceReader({ workspace: "/tmp", revision: null, execFile: () => { throw new Error("must not execute"); } });
  assert.deepEqual(await invalidRevision("src/a.ts"), { status: "unavailable", reason: "no-exact-revision" });
  const invalidPath = createHeadSourceReader({ workspace: "/tmp", revision, execFile: () => { throw new Error("must not execute"); } });
  for (const hostile of ["../etc/passwd", "/etc/passwd", "-foo", "--help", "a/../../b", "a\0b", ""]) {
    assert.deepEqual(await invalidPath(hostile), { status: "unavailable", reason: "path-invalid" }, `expected ${JSON.stringify(hostile)} to be rejected`);
  }
});

test("source reader maps synthetic execution failures to bounded reasons", async () => {
  // Synthetic (non-git, non-repository) failures map to bounded reasons
  // without ever claiming a file path was proven missing.
  const error = (properties: Record<string, unknown>) => Object.assign(new Error("failed"), properties);
  const reader = (failure: Error) => createHeadSourceReader({
    workspace: "/tmp", revision, execFile: () => { throw failure; },
  });
  assert.deepEqual(await reader(error({ code: "ENOENT" }))("src/a.ts"), { status: "unavailable", reason: "read-failed" });
  assert.deepEqual(await reader(error({ code: "ENOBUFS" }))("src/a.ts"), { status: "unavailable", reason: "too-large" });
  assert.deepEqual(await reader(error({ message: "output too large" }))("src/a.ts"), { status: "unavailable", reason: "too-large" });
  // A generic non-git failure now classifies as `revision-unreachable`
  // (pre-flight gate rejects the SHA in this workspace), not `not-found`,
  // so the boundary cannot spuriously refute a real blocker when the
  // local checkout is malformed or non-repository.
  assert.deepEqual(await reader(error({ status: 128 }))("src/a.ts"), { status: "unavailable", reason: "revision-unreachable" });
});

test("source reader returns exact committed git content and provenance", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = 'const marker = "⟦redacted:credential⟧";\n';
    fs.writeFileSync(file, text);
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);
    const read = createHeadSourceReader({ workspace, revision: sha });

    const result = await read("src/literal.ts");
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.text, text);
      assert.equal(result.provenance.representation, "committed_source");
      assert.equal(result.provenance.revision, sha);
      assert.match(result.text, /⟦redacted:credential⟧/);
    }
    assert.deepEqual(await read("src/unknown.ts"), { status: "unavailable", reason: "not-found" });
    // Non-normalized citations read the canonical committed entry.
    assert.deepEqual(await read("./src//literal.ts"), result);
    assert.deepEqual(await createHeadSourceReader({ workspace, revision: "bogus" })("src/literal.ts"), {
      status: "unavailable", reason: "no-exact-revision",
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("source reader proves path absence only against a reachable SHA in a real git workspace", async () => {
  // #1016 (review pass): the only situation where the reader may return
  // `not-found` is when (a) the workspace is a git repository, (b) the
  // supplied SHA resolves to an object in this workspace's DB, AND (c) the
  // file path genuinely does not exist in that tree. Any other failure
  // mode is unknown evidence (`revision-unreachable`), which the
  // boundary treats as `unverified` and the strict mapping refuses to
  // certify as a clean review.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "const x = 1;\n");
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);

    // (a) + (c): reachable SHA, genuinely absent path → proven absence.
    const goodReader = createHeadSourceReader({ workspace, revision: sha });
    assert.deepEqual(await goodReader("src/missing.ts"), { status: "unavailable", reason: "not-found" });

    // (a) + ¬(b): reachable workspace, but the SHA names no object in
    // its object DB. The boundary must treat this as unknown evidence,
    // not refutation, so a real blocker cannot silently downgrade to
    // APPROVE because the local checkout is incomplete.
    const badShaReader = createHeadSourceReader({ workspace, revision: "a".repeat(40) });
    assert.deepEqual(await badShaReader("src/literal.ts"), { status: "unavailable", reason: "revision-unreachable" });
    assert.deepEqual(await badShaReader("src/missing.ts"), { status: "unavailable", reason: "revision-unreachable" });

    // ¬(a): workspace is not a git repository at all. Same fail-closed
    // treatment as above.
    const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
    try {
      const emptyReader = createHeadSourceReader({ workspace: noRepo, revision: "a".repeat(40) });
      assert.deepEqual(await emptyReader("src/literal.ts"), { status: "unavailable", reason: "revision-unreachable" });
    } finally {
      fs.rmSync(noRepo, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("source reader proves tree absence with ls-tree before refuting a git show failure", async () => {
  // #1016 (review pass): after the commit pre-flight succeeds, a failed
  // `git show` must NOT be mapped straight to `not-found`. The reader has
  // to prove absence in the validated commit tree with an exact-path
  // `git ls-tree`; anything but a clean no-entry listing is unknown
  // evidence (`read-failed`), never positive refutation.
  const showFailure = Object.assign(new Error("fatal: bad object"), { status: 128 });
  const calls: string[][] = [];
  const readerFor = (lsTree: () => Buffer) => createHeadSourceReader({
    workspace: "/tmp",
    revision,
    execFile: (_file, args) => {
      calls.push([...args]);
      if (args[0] === "cat-file") return Buffer.alloc(0);
      if (args[0] === "show") throw showFailure;
      return lsTree();
    },
  });

  // Tree lists the exact path but the blob read failed ⇒ unknown evidence.
  assert.deepEqual(
    await readerFor(() => Buffer.from("100644 blob 1111111111111111111111111111111111111111\tsrc/a.ts\0"))("src/a.ts"),
    { status: "unavailable", reason: "read-failed" },
  );
  // The lookup must be an exact, raw-path (-z) literal-pathspec query,
  // never a glob, and must use the `--` separator.
  const lookup = calls[calls.length - 1]!;
  assert.deepEqual(lookup.slice(0, 3), ["ls-tree", "-z", revision]);
  assert.equal(lookup[3], "--");
  assert.equal(lookup[4], ":(literal)src/a.ts");

  // Tree cleanly has no such entry ⇒ proven absence (refutation allowed).
  assert.deepEqual(await readerFor(() => Buffer.from(""))("src/a.ts"), { status: "unavailable", reason: "not-found" });
  // A listing that carries entries but none matching is NOT proof of absence
  // (#1016 review pass): the exact-pathspec query answered with content this
  // reader cannot reconcile with a missing path, so it stays unknown evidence.
  assert.deepEqual(
    await readerFor(() => Buffer.from("100644 blob 1111111111111111111111111111111111111111\tsrc/a.ts.bak\0"))("src/a.ts"),
    { status: "unavailable", reason: "read-failed" },
  );
  // Tree inspection itself fails ⇒ fail closed, not refutation.
  assert.deepEqual(
    await readerFor(() => { throw Object.assign(new Error("fatal: could not read tree"), { status: 128 }); })("src/a.ts"),
    { status: "unavailable", reason: "read-failed" },
  );
});

test("source reader refuses to prove absence from a truncated or malformed ls-tree stream", async () => {
  // #1016 (review pass, blocker): absence must be proven, not inferred. The
  // pre-#1016 loop fell through to `not-found` on ANY listing that did not
  // contain the cited path — including a truncated buffer, a record that does
  // not parse as `<mode> SP <type> SP <object-id> TAB <path>`, and a buffer
  // that does not end on a record boundary. Each of those is unknown evidence
  // (the entry that would refute the claim may be in the part that never
  // arrived), so it must read-fail and never refute.
  const showFailure = Object.assign(new Error("fatal: bad object"), { status: 128 });
  const readerFor = (listing: Buffer) => createHeadSourceReader({
    workspace: "/tmp",
    revision,
    execFile: (_file, args) => {
      if (args[0] === "cat-file") return Buffer.alloc(0);
      if (args[0] === "show") throw showFailure;
      return listing;
    },
  });
  const malformed: Array<[string, Buffer]> = [
    // Record stream cut mid-record (no trailing NUL).
    ["truncated buffer", Buffer.from("100644 blob 1111111111111111111111111111111111111111\tsrc/")],
    // Header truncated: only 20 of the 40 object-id bytes arrived.
    ["short object id", Buffer.from("100644 blob 11111111111111111111\tsrc/a.ts\0")],
    // No TAB at all — the record has no path field.
    ["missing tab", Buffer.from("100644 blob 1111111111111111111111111111111111111111 src/a.ts\0")],
    // Empty path after the TAB.
    ["empty path", Buffer.from("100644 blob 1111111111111111111111111111111111111111\t\0")],
    // Non-object-id junk in the header.
    ["junk header", Buffer.from("garbage\tsrc/a.ts\0")],
    // A well-formed entry, then a NUL-terminated empty record.
    ["empty record", Buffer.concat([
      Buffer.from("100644 blob 1111111111111111111111111111111111111111\tsrc/b.ts\0"),
      Buffer.from("\0"),
    ])],
  ];
  for (const [label, listing] of malformed) {
    assert.deepEqual(
      await readerFor(listing)("src/a.ts"),
      { status: "unavailable", reason: "read-failed" },
      `expected ${label} to be unknown evidence, not proven absence`,
    );
  }

  // Control: only a cleanly completed, well-formed, EMPTY listing proves
  // absence — the shape `git ls-tree` returns for a path the tree lacks.
  assert.deepEqual(await readerFor(Buffer.from(""))("src/a.ts"), { status: "unavailable", reason: "not-found" });
});

test("source reader canonicalizes non-normalized citations and compares tree names byte-exactly", async () => {
  // #1016 (review pass, minor): git keys trees by the CANONICAL path — a
  // citation like `src//a.ts` fails `git show` even when `src/a.ts` exists,
  // while `git ls-tree` reports the canonical entry name — so a raw
  // non-normalized citation could still reach `not-found`. The reader
  // normalizes empty/dot segments before BOTH lookups; the name
  // comparison is byte-exact on the raw `-z` listing.
  const calls: string[][] = [];
  const reader = createHeadSourceReader({
    workspace: "/tmp",
    revision,
    execFile: (_file, args) => {
      calls.push([...args]);
      if (args[0] === "cat-file") return Buffer.alloc(0);
      if (args[0] === "show") {
        // Mirror git: only the canonical revarg resolves.
        if (args[1] === `${revision}:src/a.ts`) return Buffer.from("const x = 1;\n");
        throw Object.assign(new Error("fatal: bad object"), { status: 128 });
      }
      // ls-tree: canonical entry present (blob unreadable for the failing
      // revargs is impossible here — show succeeded); return the entry for
      // every lookup to prove the comparison uses the canonical name.
      return Buffer.from("100644 blob 1111111111111111111111111111111111111111\tsrc/a.ts\0");
    },
  });
  for (const citation of ["src//a.ts", "./src/a.ts", "src/./a.ts"]) {
    const result = await reader(citation);
    assert.equal(result.status, "ok", `expected ${JSON.stringify(citation)} to read the canonical entry`);
  }
  // The revarg the reader actually ran is canonical for every citation form.
  const showRevargs = calls.filter((args) => args[0] === "show").map((args) => args[1]);
  assert.deepEqual(showRevargs, [`${revision}:src/a.ts`, `${revision}:src/a.ts`, `${revision}:src/a.ts`]);

  // Byte-exact comparison: an entry whose raw bytes merely LOOK like the
  // cited path after lossy UTF-8 decoding (invalid UTF-8 → U+FFFD) must not
  // match. Under the strengthened invariant a well-formed non-matching
  // listing is unknown evidence rather than proven absence, so this asserts
  // the safe direction the byte-exact comparison preserves.
  const byteExact = createHeadSourceReader({
    workspace: "/tmp",
    revision,
    execFile: (_file, args) => {
      if (args[0] === "cat-file") return Buffer.alloc(0);
      if (args[0] === "show") throw Object.assign(new Error("fatal: bad object"), { status: 128 });
      // Raw byte `0xff` in the entry name: decodes to U+FFFD, not "café".
      return Buffer.concat([Buffer.from("100644 blob 1111111111111111111111111111111111111111\tsrc/caf"), Buffer.from([0xff]), Buffer.from(".ts\0")]);
    },
  });
  assert.deepEqual(await byteExact("src/café.ts"), { status: "unavailable", reason: "read-failed" });

  // Empty/dot-only citations are path-invalid, never a root-tree lookup.
  for (const citation of [".", "./", "//"]) {
    assert.deepEqual(await reader(citation), { status: "unavailable", reason: "path-invalid" }, citation);
  }
});

test("source reader returns read-failed when the tree lists the path but its blob is unreadable", async () => {
  // Real-git reproduction of the reviewer's corrupt-object-DB shape:
  // commit `src/literal.ts`, delete its loose blob object, and confirm the
  // pre-flight still passes (the commit resolves) while the reader refuses
  // to refute the read failure. A genuinely absent path in the same
  // workspace must still be proven `not-found`.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    git(workspace, ["config", "gc.auto", "0"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'const marker = "⟦redacted:credential⟧";\n');
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);
    const blob = git(workspace, ["rev-parse", `${sha}:src/literal.ts`]);
    const looseBlob = path.join(workspace, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    assert.ok(fs.existsSync(looseBlob), "fixture expects the blob to be a loose object");
    fs.rmSync(looseBlob);

    const read = createHeadSourceReader({ workspace, revision: sha });
    assert.deepEqual(await read("src/literal.ts"), { status: "unavailable", reason: "read-failed" });
    assert.deepEqual(await read("src/missing.ts"), { status: "unavailable", reason: "not-found" });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("source reader's read-failed keeps request_changes through the boundary", async () => {
  // Fail-closed guarantee for the same boundary (mirrors the
  // revision-unreachable test): a commit whose tree contains the cited
  // path but whose blob cannot be read must surface as `unverified`
  // (reason `read-failed`) through `applyBlockerVerification` and keep
  // `request_changes` under the strict mapping — unknown evidence can
  // never certify a clean review.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    git(workspace, ["config", "gc.auto", "0"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'const marker = "⟦redacted:credential⟧";\n');
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);
    const blob = git(workspace, ["rev-parse", `${sha}:src/literal.ts`]);
    fs.rmSync(path.join(workspace, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

    const readSource = createHeadSourceReader({ workspace, revision: sha });
    const a = artifact({
      findings: [finding({
        message: "line 1 commits the literal `⟦redacted:credential⟧`",
        file: "src/literal.ts",
        line: 1,
      })],
    });
    const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: sha });
    assert.equal(result.demoted, 1);
    assert.equal(a.findings[0]!.grounding_status, "unverified");
    assert.equal(a.findings[0]!.severity, "minor");
    assert.equal(result.findings[0]!.reason, "read-failed");

    const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
    assert.equal(a.verdict, "request_changes");
    assert.equal(outcome.verdict, "request_changes");
    assert.ok(a.review_markdown.includes("blocker-verification boundary could not confirm a demoted source claim"));
    assert.ok(a.review_markdown.includes("#1016"));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("source reader's revision-unreachable keeps request_changes through the boundary", async () => {
  // #1016 (review pass, fail-closed guarantee): a real git workspace
  // + a well-formed but non-object SHA — the exact shape of the reviewer's
  // "false APPROVE" reproduction — must surface as `unverified` through
  // `applyBlockerVerification` and survive `applyStrictVerdictPolicy` as
  // `request_changes`. The strict mapping's `forced || unverifiedGrounding`
  // branch must NOT be bypassed by the boundary's pre-flight, otherwise
  // a malformed local checkout can certify a clean review.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "const x = 1;\n");
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const realSha = git(workspace, ["rev-parse", "HEAD"]);
    const bogusSha = "a".repeat(40);

    const readSource = createHeadSourceReader({ workspace, revision: bogusSha });
    const a = artifact({
      findings: [finding({
        message: "line 1 commits the literal `⟦redacted:credential⟧`",
        file: "src/literal.ts",
        line: 1,
      })],
    });
    const result = await applyBlockerVerification(a.findings, { readSource, expectedRevision: bogusSha });
    assert.equal(result.demoted, 1);
    assert.equal(a.findings[0]!.grounding_status, "unverified");
    assert.equal(a.findings[0]!.severity, "minor");

    // Strict policy: an `unverified` demotion in the boundary must keep
    // request_changes even when the model verdict was approve.
    const outcome = applyStrictVerdictPolicy(a, { modelVerdict: "approve", forced: false });
    assert.equal(a.verdict, "request_changes");
    assert.equal(outcome.verdict, "request_changes");
    assert.ok(a.review_markdown.includes("blocker-verification boundary could not confirm a demoted source claim"));
    assert.ok(a.review_markdown.includes("#1016"));
    // The workspace's real SHA proves the bogus SHA is missing from the
    // disk, not from a misconfiguration: the boundary is the layer under
    // test, and the repo carries a verifiable commit when asked.
    assert.notEqual(realSha, bogusSha);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// #1016 (review pass, hypothesis the reviewer raised): if the source safe-
// redactor (`redactSourceTextDetailed`) ever redacted a real committed
// `⟦redacted:credential⟧` literal, the marker would no longer match and
// the boundary would spuriously `refuted` a real finding. The current
// masker does not redact this literal (it only REDACTs credentials INTO
// this marker), so the committed-marker path stays `grounded`. This
// real-git round-trip pins the positive path so a future masker change
// cannot silently regress it.
test("source-verifier + boundary: committed marker stays grounded through the real git reader", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "source-verifier-"));
  try {
    git(workspace, ["init"]);
    const file = path.join(workspace, "src", "literal.ts");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = 'const marker = "⟦redacted:credential⟧";\n';
    fs.writeFileSync(file, text);
    git(workspace, ["add", "src/literal.ts"]);
    git(workspace, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "fixture"]);
    const sha = git(workspace, ["rev-parse", "HEAD"]);

    // The message asserts the marker is committed source: a backtick-quoted
    // `⟦redacted:credential⟧` cited inside a sentence with an existence
    // cue (`commits`) and no mention/expectation cue. This is the shape
    // `assertsCommittedMarker` accepts — `value is [REDACTED]` was
    // deliberately not cited and the previous test therefore never
    // exercised the source reader, leaving the grounded path unobserved.
    const readSource = createHeadSourceReader({ workspace, revision: sha });
    const findings = [finding({
      message: "line 1 commits the literal `⟦redacted:credential⟧`",
      file: "src/literal.ts",
      line: 1,
    })];
    const result = await applyBlockerVerification(findings, { readSource, expectedRevision: sha });
    assert.equal(result.demoted, 0, "committed marker must stay grounded after redaction");
    assert.equal(findings[0]!.grounding_status, undefined);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.status, "grounded");
    assert.equal(result.findings[0]!.kind, "committed_literal");
    assert.equal(result.findings[0]!.reason, "marker-present");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
