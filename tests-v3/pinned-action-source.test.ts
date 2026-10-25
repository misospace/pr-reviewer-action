import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ACTION_SOURCE_BYTES, type ActionSourceReadResult } from "../src/enforcement/action-source.js";
import { ACTION_GATES } from "../src/enforcement/action-gates.js";
import {
  ACTION_MANIFEST_PATH,
  MAX_PINNED_ACTION_SOURCE_READS,
  createPinnedActionWitness,
  pinnedServedPaths,
  resolvePinnedActionRevision,
  type GhApiLike,
  type PinnedActionRevision,
} from "../src/enforcement/pinned-action-source.js";

/**
 * #1238/#1240: the witness over the CONSUMER-PINNED revision of the
 * action's own repository. The runner's env pins the step exactly (slug +
 * full commit SHA); claims naming that revision are decided against its
 * real bytes fetched through the platform's own API seam — and every
 * undecidable shape fails closed to `unavailable`, never to a refutation.
 */

/** A full 40-character commit SHA (lowercase hex). */
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PINNED: PinnedActionRevision = { repository: "o/r", revision: SHA };

/** The file body the fake endpoint serves. */
const BODY = "hello world\nsecond line";
const B64 = Buffer.from(BODY, "utf8").toString("base64");
// The contents API's inline content carries newlines (one per ~72 chars):
// a valid payload must still decode with them embedded.
const B64_WITH_NEWLINES = B64.replace(/(.{6})/g, "$1\n");

type GhResponse = { data?: unknown; error?: string };

/** A fake of the platform's read-only API seam, recording every endpoint. */
function makeGhApi(handler: (endpoint: string) => GhResponse): { ghApi: GhApiLike; calls: string[] } {
  const calls: string[] = [];
  const ghApi: GhApiLike = async (endpoint: string) => {
    calls.push(endpoint);
    return handler(endpoint);
  };
  return { ghApi, calls };
}

function fileResponse(text: string): GhResponse {
  return { data: { type: "file", content: Buffer.from(text, "utf8").toString("base64") } };
}

function reasonOf(result: ActionSourceReadResult): string {
  return result.status === "unavailable" ? result.reason : "";
}

test("resolvePinnedActionRevision: a well-formed slug and full SHA pin, lowercased", () => {
  const env = { GITHUB_ACTION_REPOSITORY: "Miso/Repo_One-2", GITHUB_ACTION_REF: `  ${SHA.toUpperCase()}  ` };
  assert.deepEqual(resolvePinnedActionRevision(env), { repository: "miso/repo_one-2", revision: SHA });
});

test("resolvePinnedActionRevision: a short SHA is a mutable or ambiguous pin", () => {
  assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: "o/r", GITHUB_ACTION_REF: "0123456" }), null);
});

test("resolvePinnedActionRevision: a branch or tag ref is a mutable pin", () => {
  assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: "o/r", GITHUB_ACTION_REF: "main" }), null);
  assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: "o/r", GITHUB_ACTION_REF: "v1.2.3" }), null);
});

test("resolvePinnedActionRevision: a 40-character ref with a non-hex character is not a SHA", () => {
  assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: "o/r", GITHUB_ACTION_REF: "g".repeat(40) }), null);
});

test("resolvePinnedActionRevision: missing or blank runner env admits no witness", () => {
  assert.equal(resolvePinnedActionRevision({}), null);
  assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: "o/r" }), null);
  assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: "o/r", GITHUB_ACTION_REF: "   " }), null);
});

test("resolvePinnedActionRevision: a malformed slug admits no witness", () => {
  for (const bad of ["owner only", "o//r", "o/r/x", "o", "o/r/"]) {
    assert.equal(resolvePinnedActionRevision({ GITHUB_ACTION_REPOSITORY: bad, GITHUB_ACTION_REF: SHA }), null, bad);
  }
});

test("resolvePinnedActionRevision: a pin naming the repository under review admits no witness", () => {
  // The executing reader refuses the `uses: ./` shape for the same reason:
  // the reviewed repository's bytes are PR-controlled and must never
  // decide a refutation. Same comparison, pinned form.
  assert.equal(resolvePinnedActionRevision({
    GITHUB_ACTION_REPOSITORY: "MisoSpace/Pr-Reviewer-Action",
    GITHUB_ACTION_REF: SHA,
    GITHUB_REPOSITORY: "misospace/pr-reviewer-action",
  }), null);
  // A different reviewed repository keeps the witness; a missing
  // GITHUB_REPOSITORY gives no identity to refuse on.
  assert.notEqual(resolvePinnedActionRevision({
    GITHUB_ACTION_REPOSITORY: "misospace/pr-reviewer-action",
    GITHUB_ACTION_REF: SHA,
    GITHUB_REPOSITORY: "someone/else",
  }), null);
  assert.notEqual(resolvePinnedActionRevision({
    GITHUB_ACTION_REPOSITORY: "misospace/pr-reviewer-action",
    GITHUB_ACTION_REF: SHA,
  }), null);
});

test("read: the pinned file's bytes, with the contents API's newlined base64", async () => {
  const { ghApi, calls } = makeGhApi(() => ({ data: { type: "file", content: B64_WITH_NEWLINES } }));
  const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
  assert.equal(witness.revision, SHA, "the witness exposes the pinned revision as given");
  const result = await witness.read("src/precheck/decide.ts");
  assert.equal(result.status, "ok");
  assert.equal(result.status === "ok" ? result.text : "", BODY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `repos/o/r/contents/src/precheck/decide.ts?ref=${SHA}`);
});

test("read: an unknown path and a NUL path are refused without a fetch", async () => {
  const { ghApi, calls } = makeGhApi(() => fileResponse(BODY));
  const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
  const unknown = await witness.read("no-such-file.ts");
  assert.equal(unknown.status, "unavailable");
  assert.equal(reasonOf(unknown), "not-served");
  const traversal = await witness.read("../src/precheck/decide.ts");
  assert.equal(traversal.status, "unavailable");
  assert.equal(reasonOf(traversal), "not-served");
  const nul = await witness.read("src/precheck/decide.ts\0");
  assert.equal(nul.status, "unavailable");
  assert.equal(reasonOf(nul), "invalid-path");
  const empty = await witness.read("");
  assert.equal(empty.status, "unavailable");
  assert.equal(reasonOf(empty), "invalid-path");
  assert.deepEqual(calls, [], "no refused path may reach the API seam");
});

test("read: every hostile response shape fails closed with its exact reason", async () => {
  const hostile: Array<{ label: string; response: GhResponse | "throw"; reason: string }> = [
    { label: "an error response", response: { error: "boom" }, reason: "fetch-error" },
    { label: "a thrown request", response: "throw", reason: "fetch-error" },
    { label: "null data", response: { data: null }, reason: "not-a-file" },
    { label: "absent data", response: {}, reason: "not-a-file" },
    { label: "array data", response: { data: [{ type: "file", content: B64 }] }, reason: "not-a-file" },
    { label: "a directory entry", response: { data: { type: "dir", path: "src" } }, reason: "not-a-file" },
    // The contents API names these entry shapes directly: a symlink or a
    // gitlink is not a file's bytes, whatever content-like field travels
    // with it.
    { label: "a symlink entry", response: { data: { type: "symlink", target: "/etc/passwd" } }, reason: "not-a-file" },
    { label: "a symlink entry carrying content", response: { data: { type: "symlink", content: B64 } }, reason: "not-a-file" },
    { label: "a submodule (gitlink) entry", response: { data: { type: "submodule", sha: SHA } }, reason: "not-a-file" },
    { label: "missing inline content", response: { data: { type: "file" } }, reason: "content-missing" },
    { label: "non-string content", response: { data: { type: "file", content: 42 } }, reason: "content-missing" },
    // An empty content string says "nothing inline", not "an empty file".
    { label: "empty content string", response: { data: { type: "file", content: "" } }, reason: "content-missing" },
    { label: "a non-base64 body", response: { data: { type: "file", content: "!!!" } }, reason: "invalid-response" },
    { label: "non-canonical padding", response: { data: { type: "file", content: "ab=" } }, reason: "invalid-response" },
    { label: "stray trailing padding", response: { data: { type: "file", content: "abcd=" } }, reason: "invalid-response" },
  ];
  for (const row of hostile) {
    const response = row.response;
    const { ghApi } =
      response === "throw"
        ? makeGhApi(() => {
            throw new Error("boom");
          })
        : makeGhApi(() => response);
    const result = await createPinnedActionWitness({ pinned: PINNED, ghApi }).read(ACTION_MANIFEST_PATH);
    assert.equal(result.status, "unavailable", row.label);
    assert.equal(reasonOf(result), row.reason, row.label);
  }
});

test("read: a decoded file over the byte cap is too-large, never served", async () => {
  // The smallest body that decodes one byte over the cap; its base64 is a
  // megabyte-scale string the decoder handles in a single pass.
  const oversize = Buffer.from("a".repeat(MAX_ACTION_SOURCE_BYTES + 1), "utf8").toString("base64");
  const { ghApi } = makeGhApi(() => ({ data: { type: "file", content: oversize } }));
  const result = await createPinnedActionWitness({ pinned: PINNED, ghApi }).read(ACTION_MANIFEST_PATH);
  assert.equal(result.status, "unavailable");
  assert.equal(reasonOf(result), "too-large");
});

test("the served set is the manifest plus every registry implementation path", () => {
  const served = pinnedServedPaths();
  assert.ok(served.has(ACTION_MANIFEST_PATH), "the manifest must be served");
  for (const gate of ACTION_GATES) {
    assert.ok(served.has(gate.implementation), `gate ${gate.id} implementation must be served`);
  }
  const expected = new Set([ACTION_MANIFEST_PATH, ...ACTION_GATES.map((gate) => gate.implementation)]);
  assert.equal(served.size, expected.size, "nothing beyond the registry constants may be served");
  for (const path of served) assert.ok(expected.has(path));
});

test("budget: one fetch per distinct served path; repeats are cached; the cap bounds distinct reads", async () => {
  const served = [...pinnedServedPaths()].sort();
  const { ghApi, calls } = makeGhApi(() => fileResponse(BODY));
  const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
  for (const path of served) {
    assert.equal((await witness.read(path)).status, "ok", path);
  }
  assert.equal(calls.length, Math.min(served.length, MAX_PINNED_ACTION_SOURCE_READS), "one fetch per distinct path");
  // Repeats of the same path are served from the cache: no further fetches.
  for (const path of served) {
    assert.equal((await witness.read(path)).status, "ok", path);
  }
  assert.equal(calls.length, Math.min(served.length, MAX_PINNED_ACTION_SOURCE_READS), "repeats must not fetch");
  if (served.length > MAX_PINNED_ACTION_SOURCE_READS) {
    // cap+1 distinct reads: only the first MAX fetch; the rest are budget
    // exhausted, with no fetch.
    const extraPath = served[MAX_PINNED_ACTION_SOURCE_READS];
    assert.ok(extraPath !== undefined, "a (cap+1)th distinct served path must exist");
    const extra = await witness.read(extraPath);
    assert.equal(extra.status, "unavailable");
    assert.equal(reasonOf(extra), "read-budget-exhausted");
    assert.equal(calls.length, MAX_PINNED_ACTION_SOURCE_READS);
  } else {
    // The registry currently cites fewer distinct paths than the cap, so
    // the exhaustion branch is dormant until the registry grows; the
    // budget still bounds every fetch this witness can perform.
    assert.ok(served.length <= MAX_PINNED_ACTION_SOURCE_READS);
  }
});

test("declaredInputs: declared input names are lowercased", async () => {
  const manifest = "name: pr-reviewer-action\ninputs:\n  Model-Id: {description: m}\n  DRY_RUN: \"false\"\n  simple: 1\n";
  const { ghApi, calls } = makeGhApi(() => fileResponse(manifest));
  const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
  assert.deepEqual(await witness.declaredInputs(), new Set(["model-id", "dry_run", "simple"]));
  assert.equal(calls[0], `repos/o/r/contents/${ACTION_MANIFEST_PATH}?ref=${SHA}`);
});

test("declaredInputs: an absent or empty inputs block declares none (a positive fact)", async () => {
  for (const manifest of ["name: x\n", "name: x\ninputs: {}\n"]) {
    const { ghApi } = makeGhApi(() => fileResponse(manifest));
    const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
    assert.deepEqual(await witness.declaredInputs(), new Set(), manifest);
  }
});

test("declaredInputs: an undecidable manifest shape is null", async () => {
  const cases: Array<[string, string]> = [
    ["invalid yaml (unclosed flow)", "foo: [1, 2"],
    ["invalid yaml (tab indent)", "inputs:\n\t- a\n"],
    ["top-level scalar", "just a string"],
    ["top-level array", "- a\n- b\n"],
    ["string inputs", "inputs: \"x\"\n"],
    ["array inputs", "inputs: [a, b]\n"],
    ["number inputs", "inputs: 5\n"],
  ];
  for (const [label, manifest] of cases) {
    const { ghApi } = makeGhApi(() => fileResponse(manifest));
    const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
    assert.equal(await witness.declaredInputs(), null, label);
  }
});

test("declaredInputs: a manifest fetch failure is null", async () => {
  const { ghApi } = makeGhApi(() => ({ error: "boom" }));
  const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
  assert.equal(await witness.declaredInputs(), null);
});

test("declaredInputs: repeated calls fetch the manifest exactly once", async () => {
  const { ghApi, calls } = makeGhApi(() => fileResponse("name: x\ninputs: {A: 1}\n"));
  const witness = createPinnedActionWitness({ pinned: PINNED, ghApi });
  const [a, b, c] = await Promise.all([witness.declaredInputs(), witness.declaredInputs(), witness.declaredInputs()]);
  assert.deepEqual(a, new Set(["a"]));
  assert.deepEqual(b, new Set(["a"]));
  assert.deepEqual(c, new Set(["a"]));
  assert.equal(calls.length, 1, "the manifest must be fetched once across repeated calls");
});
