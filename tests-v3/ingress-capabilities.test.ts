import test from "node:test";
import assert from "node:assert/strict";

import {
  FORGEJO_CAPABILITIES,
  GITHUB_CAPABILITIES,
  capabilitiesFor,
  requireCapability,
} from "../src/ingress/capabilities.js";
import type { CapabilityName, ForgePlatform } from "../src/ingress/capabilities.js";

test("capability manifests: github all true, forgejo degraded on checkRuns and graphql, both frozen", () => {
  assert.deepEqual(GITHUB_CAPABILITIES, {
    nativeReview: true,
    stickyComment: true,
    inlineReviewComments: true,
    checkRuns: true,
    commitStatus: true,
    graphql: true,
  });
  assert.deepEqual(FORGEJO_CAPABILITIES, {
    nativeReview: true,
    stickyComment: true,
    inlineReviewComments: true,
    checkRuns: false,
    commitStatus: true,
    graphql: false,
  });
  assert.ok(Object.isFrozen(GITHUB_CAPABILITIES));
  assert.ok(Object.isFrozen(FORGEJO_CAPABILITIES));
});

test("requireCapability: github passes every capability name", () => {
  for (const capability of Object.keys(GITHUB_CAPABILITIES) as CapabilityName[]) {
    assert.deepEqual(requireCapability("github", capability), { ok: true });
  }
});

test("requireCapability: forgejo checkRuns degrades to commit status", () => {
  const check = requireCapability("forgejo", "checkRuns");
  assert.equal(check.ok, false);
  if (check.ok) assert.fail("expected ok:false");
  assert.equal(check.platform, "forgejo");
  assert.equal(check.capability, "checkRuns");
  assert.ok(check.degradation.length > 0);
  assert.ok(check.degradation.includes("forgejo"));
  assert.ok(check.degradation.includes("commit status"));
});

test("requireCapability: forgejo graphql degrades without fallback", () => {
  const check = requireCapability("forgejo", "graphql");
  assert.equal(check.ok, false);
  if (check.ok) assert.fail("expected ok:false");
  assert.equal(check.platform, "forgejo");
  assert.equal(check.capability, "graphql");
  assert.ok(check.degradation.includes("graphql"));
  assert.ok(check.degradation.includes("forgejo"));
});

test("requireCapability: forgejo supports the comment/review/status capabilities", () => {
  for (const capability of ["stickyComment", "nativeReview", "inlineReviewComments", "commitStatus"] as CapabilityName[]) {
    assert.deepEqual(requireCapability("forgejo", capability), { ok: true });
  }
});

test("requireCapability rejects unknown capability names instead of defaulting to ok", () => {
  for (const platform of ["github", "forgejo"] as ForgePlatform[]) {
    const check = requireCapability(platform, "notACapability" as CapabilityName);
    assert.equal(check.ok, false);
    if (check.ok) assert.fail(`expected ok:false for platform ${platform}`);
    assert.equal(check.platform, platform);
    assert.equal(check.capability, "notACapability");
    assert.ok(check.degradation.includes("unknown capability"));
  }
});

test("capabilitiesFor: identity per known platform, throws on unknown", () => {
  assert.equal(capabilitiesFor("github"), GITHUB_CAPABILITIES);
  assert.equal(capabilitiesFor("forgejo"), FORGEJO_CAPABILITIES);
  assert.throws(() => capabilitiesFor("gitlab" as ForgePlatform));
});