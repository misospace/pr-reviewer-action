import test from "node:test";
import assert from "node:assert/strict";

import { buildCloneCredential } from "../src/ingress/clone-credentials.js";
import { resolveForgejoEndpoints, resolveRepositoryEndpoints } from "../src/ingress/endpoints.js";
import { PlatformUrlError } from "../src/platform/urls.js";

const SELF_HOSTED = "https://git.example.internal:3000";

test("resolveForgejoEndpoints: cloud and self-hosted share the identical code path", () => {
  const cloud = resolveForgejoEndpoints("https://codeberg.org");
  assert.equal(cloud.base, "https://codeberg.org");
  assert.equal(cloud.origin, "https://codeberg.org");
  assert.equal(cloud.apiBase, "https://codeberg.org/api/v1");
  assert.equal(cloud.webBase, "https://codeberg.org");

  const selfHosted = resolveForgejoEndpoints(`${SELF_HOSTED}/`);
  assert.equal(selfHosted.base, SELF_HOSTED);
  assert.equal(selfHosted.origin, SELF_HOSTED);
  assert.equal(selfHosted.apiBase, `${SELF_HOSTED}/api/v1`);
  assert.equal(selfHosted.webBase, SELF_HOSTED);
});

test("resolveForgejoEndpoints rejects bad input with PlatformUrlError", () => {
  assert.throws(() => resolveForgejoEndpoints("https://user:pass@host.example.com"), PlatformUrlError);
  assert.throws(() => resolveForgejoEndpoints("ftp://host"), PlatformUrlError);
  assert.throws(() => resolveForgejoEndpoints(""), PlatformUrlError);
});

test("resolveRepositoryEndpoints: repo-scoped REST URL and clean clone URL", () => {
  const eps = resolveRepositoryEndpoints(SELF_HOSTED, "org/repo");
  assert.ok(eps);
  assert.deepEqual(eps.repoRef, { owner: "org", name: "repo" });
  assert.equal(eps.repoApiUrl, `${SELF_HOSTED}/api/v1/repos/org/repo`);
  assert.equal(eps.cloneUrl, `${SELF_HOSTED}/org/repo.git`);
  assert.equal(eps.forgejo.apiBase, `${SELF_HOSTED}/api/v1`);
  assert.equal(eps.forgejo.base, SELF_HOSTED);
});

test("resolveRepositoryEndpoints returns null (never throws) on invalid input", () => {
  assert.equal(resolveRepositoryEndpoints(SELF_HOSTED, "nope"), null);
  assert.equal(resolveRepositoryEndpoints(SELF_HOSTED, "../evil"), null);
  assert.equal(resolveRepositoryEndpoints("", "org/repo"), null);
  assert.equal(resolveRepositoryEndpoints("ftp://host", "org/repo"), null);
});

test("buildCloneCredential: the token travels only as the Basic Authorization header", () => {
  const cred = buildCloneCredential(SELF_HOSTED, "org/repo", "tok123");
  assert.ok(cred);
  assert.equal(cred.headerName, "Authorization");
  assert.equal(cred.headerValue, `Basic ${Buffer.from("x-access-token:tok123").toString("base64")}`);
  assert.equal(cred.cloneUrl, `${SELF_HOSTED}/org/repo.git`);
  assert.ok(!cred.cloneUrl.includes("tok123"));
  assert.ok(!cred.cloneUrl.includes("@"));

  const custom = buildCloneCredential(SELF_HOSTED, "org/repo", "tok123", "myuser");
  assert.ok(custom);
  assert.equal(custom.headerValue, `Basic ${Buffer.from("myuser:tok123").toString("base64")}`);
  assert.equal(custom.cloneUrl, `${SELF_HOSTED}/org/repo.git`);
});

test("buildCloneCredential returns null on invalid endpoint, repo, or token", () => {
  assert.equal(buildCloneCredential(SELF_HOSTED, "org/repo", ""), null);
  assert.equal(buildCloneCredential(SELF_HOSTED, "org/repo", "a\r\nb"), null);
  assert.equal(buildCloneCredential(SELF_HOSTED, "org/repo", "a\nb"), null);
  assert.equal(buildCloneCredential(SELF_HOSTED, "bad", "tok123"), null);
  assert.equal(buildCloneCredential(SELF_HOSTED, "../evil", "tok123"), null);
  assert.equal(buildCloneCredential("", "org/repo", "tok123"), null);
});

test("a serialized CloneCredential carries the token in exactly one place: the encoded header", () => {
  const cred = buildCloneCredential(SELF_HOSTED, "org/repo", "tok123");
  assert.ok(cred);
  const json = JSON.stringify(cred);
  // The raw token never appears in the serialized credential: it is present
  // only base64-encoded inside the header value, and the clone URL is clean.
  assert.equal(json.split("tok123").length - 1, 0);
  // Decoding the header value yields the token exactly once.
  const decoded = Buffer.from(cred.headerValue.slice("Basic ".length), "base64").toString("utf8");
  assert.equal(decoded.split("tok123").length - 1, 1);
});
