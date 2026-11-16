/** The #1682 identity pin for the forge capability composition: `gitea` is
 * an identity served by the Forgejo-compatible stack — the composition
 * builds the same adapters under the `gitea` identity (the identity only
 * reaches `describe()`), fails closed without the shared FORGEJO_TOKEN
 * material, and the `forgejo` identity keeps its own diagnostic unchanged. */

import test from "node:test";
import assert from "node:assert/strict";

import { composeForgeCapability } from "../src/controller/forge-capability.js";

test("a gitea composition serves the forgejo-family adapters under the gitea identity (#1682)", () => {
  const composed = composeForgeCapability({
    platform: "gitea",
    endpoint: "https://gitea.example/api/v1",
    workspaceCacheRoot: "/tmp/unused-cache",
    forgejoToken: "t",
  });
  assert.equal(composed.platform, "gitea");
  assert.match(composed.describe(), /^gitea via /);
  for (const name of ["mirrorFor", "currentHeadSha", "publish"] as const) {
    assert.equal(typeof composed.capability[name], "function", `capability.${name}`);
  }
  for (const name of [
    "readPermission",
    "readComment",
    "fetchThreadComments",
    "readPrState",
    "postComment",
    "resolveHeadSha",
  ] as const) {
    assert.equal(typeof composed.followUp[name], "function", `followUp.${name}`);
  }
  assert.equal(composed.pollInstallationId, "", "the forgejo family has no App installation poll");
});

test("a gitea composition without a token fails closed naming FORGEJO_TOKEN (#1682)", () => {
  assert.throws(
    () =>
      composeForgeCapability({
        platform: "gitea",
        endpoint: "https://gitea.example/api/v1",
        workspaceCacheRoot: "/tmp/unused-cache",
      }),
    /serves gitea but no Gitea token is configured \(FORGEJO_TOKEN\)/,
  );
});

test("a forgejo composition keeps the forgejo identity (#1682 regression pin)", () => {
  const composed = composeForgeCapability({
    platform: "forgejo",
    endpoint: "https://gitea.example/api/v1",
    workspaceCacheRoot: "/tmp/unused-cache",
    forgejoToken: "t",
  });
  assert.equal(composed.platform, "forgejo");
  assert.match(composed.describe(), /^forgejo via /);
});
