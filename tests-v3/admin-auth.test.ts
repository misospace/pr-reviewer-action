/** Bearer authentication boundary for controller admin routes. */
import test from "node:test";
import assert from "node:assert/strict";
import { AdminAuthenticator } from "../src/admin/auth.js";

test("admin bearer token compares exact values and rejects malformed headers", () => {
  const auth = new AdminAuthenticator("secret-value");
  assert.equal(auth.authenticate("Bearer secret-value"), true);
  assert.equal(auth.authenticate("bearer secret-value"), true);
  for (const header of [undefined, "", "Basic secret-value", "Bearer ", "Bearer secret-value extra", ["Bearer secret-value"]]) {
    assert.equal(auth.authenticate(header), false);
  }
  assert.equal(auth.authenticate("Bearer wrong-value"), false);
});

test("missing token is unavailable and empty configured tokens are refused", () => {
  assert.equal(new AdminAuthenticator(undefined).configured(), false);
  assert.throws(() => new AdminAuthenticator("   "), TypeError);
});
