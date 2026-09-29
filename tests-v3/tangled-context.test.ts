import test from "node:test";
import assert from "node:assert/strict";
import { tangledContextFromEnv } from "../src/platform/tangled.js";

/**
 * The Spindle runtime-context normalization (#583), ported from the v2
 * oracle `pr_reviewer/tangled_context.py`. Environment-driven only: no
 * network, no GitHub event JSON.
 */

const MISSING_DID = "platform 'tangled' requires TANGLED_REPO_DID (Tangled repository owner DID) to be set";

test("tangled context normalizes the full Spindle environment", () => {
  const ctx = tangledContextFromEnv({
    TANGLED_REPO_DID: "did:plc:example-owner",
    TANGLED_REPO_REPO_DID: "did:plc:example-repo",
    TANGLED_REPO_NAME: "owner/repo",
    TANGLED_PR_SOURCE_BRANCH: "feature/x",
    TANGLED_PR_TARGET_BRANCH: "main",
    TANGLED_PR_SOURCE_SHA: "0123456789abcdef0123456789abcdef01234567",
    TANGLED_REPO_KNOT: "knot1.tangled.sh",
    TANGLED_BOBBIN_URL: "https://bobbin.example.com",
  });
  assert.deepEqual(ctx, {
    ownerDid: "did:plc:example-owner",
    repoDid: "did:plc:example-repo",
    repoName: "owner/repo",
    sourceBranch: "feature/x",
    targetBranch: "main",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    knotHost: "knot1.tangled.sh",
    bobbinUrl: "https://bobbin.example.com",
  });
});

test("values are trimmed; blank optional values are absent", () => {
  const ctx = tangledContextFromEnv({ TANGLED_REPO_DID: "  did:plc:example-owner  " });
  assert.equal(ctx.ownerDid, "did:plc:example-owner");
  const blank = tangledContextFromEnv({
    TANGLED_REPO_DID: "did:plc:owner",
    TANGLED_REPO_REPO_DID: "",
    TANGLED_REPO_NAME: "",
    TANGLED_PR_SOURCE_BRANCH: "  ",
    TANGLED_PR_TARGET_BRANCH: "",
    TANGLED_PR_SOURCE_SHA: "",
    TANGLED_REPO_KNOT: "",
    TANGLED_BOBBIN_URL: "",
  });
  for (const field of ["repoDid", "repoName", "sourceBranch", "targetBranch", "sourceSha", "knotHost", "bobbinUrl"] as const) {
    assert.equal(blank[field], undefined, field);
  }
});

test("the owner DID is required and the failure names it", () => {
  assert.throws(
    () => tangledContextFromEnv({ TANGLED_REPO_NAME: "owner/repo" }),
    (e: unknown) => e instanceof Error && e.message === MISSING_DID,
  );
  assert.throws(
    () => tangledContextFromEnv({ TANGLED_REPO_DID: "   " }),
    (e: unknown) => e instanceof Error && e.message === MISSING_DID,
  );
});

test("TANGLED_REPO_DID is the owner DID; TANGLED_REPO_REPO_DID is separate", () => {
  const ctx = tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:owner", TANGLED_REPO_REPO_DID: "  did:plc:repo  " });
  assert.equal(ctx.ownerDid, "did:plc:owner");
  assert.equal(ctx.repoDid, "did:plc:repo");
});

test("the fictional TANGLED_KNOT_URL is never read", () => {
  const ctx = tangledContextFromEnv({
    TANGLED_REPO_DID: "did:plc:owner",
    TANGLED_KNOT_URL: "https://knot.example.com/knots/123",
  });
  assert.equal(ctx.knotHost, undefined);
});

test("TANGLED_REPO_KNOT must be a bare hostname", () => {
  assert.equal(tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_REPO_KNOT: "knot1.tangled.sh" }).knotHost, "knot1.tangled.sh");
  assert.equal(tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_REPO_KNOT: "localhost" }).knotHost, "localhost");
  // Stored verbatim: only the validation lowercases.
  assert.equal(tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_REPO_KNOT: "Knot1.Tangled.SH" }).knotHost, "Knot1.Tangled.SH");
  for (const bad of ["https://knot1.tangled.sh", "knot1.tangled.sh/knots", "knot1.tangled.sh:443", "knot..example.com"]) {
    assert.throws(
      () => tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_REPO_KNOT: bad }),
      (e: unknown) => e instanceof Error && e.message === "TANGLED_REPO_KNOT must be a valid hostname",
      bad,
    );
  }
});

test("TANGLED_BOBBIN_URL: absolute https, loopback http, nothing looser", () => {
  assert.equal(tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_BOBBIN_URL: "https://bobbin.example.com" }).bobbinUrl, "https://bobbin.example.com");
  for (const [bad, message] of [
    ["bobbin.example.com", "TANGLED_BOBBIN_URL must be an http(s) URL"],
    ["ftp://bobbin.example.com", "TANGLED_BOBBIN_URL must be an http(s) URL"],
    ["http://bobbin.example.com", "TANGLED_BOBBIN_URL must be an https URL; plaintext http is accepted for loopback hosts only"],
  ] as const) {
    assert.throws(
      () => tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_BOBBIN_URL: bad }),
      (e: unknown) => e instanceof Error && e.message === message,
      bad,
    );
  }
  for (const loopback of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    assert.equal(
      tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_BOBBIN_URL: loopback }).bobbinUrl,
      loopback,
    );
  }
  // A path or query on the base URL is configuration, not a security
  // boundary (the API boundary owns per-request validation).
  const pathed = tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_BOBBIN_URL: "https://bobbin.example.com/base?x=1" });
  assert.equal(pathed.bobbinUrl, "https://bobbin.example.com/base?x=1");
});

// Adversarial boundary (#252): feed the fence the hostile delimiter itself —
// a malformed IPv6 literal must fail naming the field, never leaking the
// bare parser message.
test("malformed IPv6 and parser boundaries fail with the field named", () => {
  for (const field of ["TANGLED_BOBBIN_URL", "TANGLED_REPO_KNOT"] as const) {
    assert.throws(
      () => tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", [field]: "http://[::1" }),
      (e: unknown) => e instanceof Error && e.message.includes(field),
      field,
    );
  }
  assert.throws(
    () => tangledContextFromEnv({ TANGLED_REPO_DID: "did:plc:x", TANGLED_BOBBIN_URL: "http:///" }),
    (e: unknown) => e instanceof Error && e.message === "TANGLED_BOBBIN_URL must be an absolute http(s) URL with a host",
  );
});
