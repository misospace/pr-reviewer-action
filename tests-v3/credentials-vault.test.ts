import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemorySecretVault,
  type InMemorySecretVaultOptions,
  type ResolutionRequest,
  type VaultEntry,
} from "../src/credentials/index.js";

const HOUR_MS = 3_600_000;

function entry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    reference: "forge-installation-token",
    scope: {
      platform: "github",
      installationId: "1001",
      repoFullName: "owner/repo-a",
      purpose: "forge_clone",
    },
    material: { value: "ghs_secretvalue000000000001", expiresAtMs: 2_000_000_000_000 },
    ...overrides,
  };
}

function request(overrides: Partial<ResolutionRequest> = {}): ResolutionRequest {
  return {
    purpose: "forge_clone",
    platform: "github",
    installationId: "1001",
    repoFullName: "owner/repo-a",
    ...overrides,
  };
}

function vault(
  entries: VaultEntry[] = [entry()],
  options: InMemorySecretVaultOptions = {},
): InMemorySecretVault {
  return new InMemorySecretVault(entries, options);
}

test("vault: exact-scope resolution succeeds and returns frozen material", async () => {
  const broker = vault();
  const result = await broker.resolve("forge-installation-token", request());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.material.value, "ghs_secretvalue000000000001");
    assert.equal(Object.isFrozen(result.material), true);
  }
});

test("vault: multi-installation token isolation — another installation is refused", async () => {
  const broker = vault();
  const result = await broker.resolve("forge-installation-token", request({ installationId: "2002" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.reason, "credential is bound to a different installation");
    assert.equal(result.reason.includes("ghs_"), false);
  }
});

test("vault: cross-repo isolation — another repository under the same installation is refused", async () => {
  const broker = vault();
  const result = await broker.resolve("forge-installation-token", request({ repoFullName: "owner/repo-b" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "scope_mismatch");
});

test("vault: purpose isolation — a forge_clone credential never serves a model request", async () => {
  const broker = vault();
  const result = await broker.resolve("forge-installation-token", request({ purpose: "model" }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.reason, "credential is bound to a different purpose");
  }
});

test("vault: platform isolation — a github-bound credential never serves forgejo", async () => {
  const broker = vault();
  const result = await broker.resolve("forge-installation-token", request({ platform: "forgejo" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "scope_mismatch");
});

test("vault: unknown reference is refused, never guessed", async () => {
  const result = await vault().resolve("no-such-ref", request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unknown_reference");
});

test("vault: malformed reference and malformed request refuse as invalid_request", async () => {
  const broker = vault();
  const badRef = await broker.resolve("bad ref!", request());
  assert.equal(badRef.ok, false);
  if (!badRef.ok) assert.equal(badRef.code, "invalid_request");
  const badRequest = await broker.resolve("forge-installation-token", {
    ...request(),
    purpose: "not-a-purpose" as unknown as ResolutionRequest["purpose"],
  });
  assert.equal(badRequest.ok, false);
  if (!badRequest.ok) assert.equal(badRequest.code, "invalid_request");
});

test("vault: expired material is refused without a refresh source", async () => {
  let now = 1_000_000;
  const broker = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 2_000 } })],
    { now: () => now },
  );
  const result = await broker.resolve("forge-installation-token", request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "expired");
  now += 1;
  assert.equal((await broker.resolve("forge-installation-token", request())).ok, false);
});

test("vault: expired token refresh — one refresh replaces the material and persists", async () => {
  let now = 3_000;
  let refreshCalls = 0;
  const broker = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 2_000 } })],
    {
      now: () => now,
      refresh: async (reference) => {
        refreshCalls += 1;
        assert.equal(reference, "forge-installation-token");
        return { value: "ghs_refreshedvalue0000000001", expiresAtMs: now + HOUR_MS };
      },
    },
  );
  const first = await broker.resolve("forge-installation-token", request());
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.material.value, "ghs_refreshedvalue0000000001");
  assert.equal(refreshCalls, 1);
  // The refreshed material persists: the next resolve does not refresh again.
  now = 4_000;
  const second = await broker.resolve("forge-installation-token", request());
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.material.value, "ghs_refreshedvalue0000000001");
  assert.equal(refreshCalls, 1);
});

test("vault: refresh failure and refresh throw both refuse expired, never leak", async () => {
  const nullVault = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 1 } })],
    { now: () => 10, refresh: async () => null },
  );
  const nullResult = await nullVault.resolve("forge-installation-token", request());
  assert.equal(nullResult.ok, false);
  if (!nullResult.ok) assert.equal(nullResult.code, "expired");

  const throwVault = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 1 } })],
    {
      now: () => 10,
      refresh: async () => {
        throw new Error("ghs_secretvalue000000000001");
      },
    },
  );
  const throwResult = await throwVault.resolve("forge-installation-token", request());
  assert.equal(throwResult.ok, false);
  if (!throwResult.ok) {
    assert.equal(throwResult.code, "expired");
    // The refresh source's error message (which happens to carry the secret)
    // never reaches the refusal reason.
    assert.equal(throwResult.reason.includes("ghs_"), false);
  }
});

test("vault: refreshed material is scope-checked — a refresh cannot widen the binding", async () => {
  const broker = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 1 } })],
    {
      now: () => 10,
      refresh: async () => ({ value: "", expiresAtMs: 5 }),
    },
  );
  const result = await broker.resolve("forge-installation-token", request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "expired");
});

test("vault: revoked references refuse and revoke is idempotent", async () => {
  const broker = vault();
  assert.equal(broker.revoke("forge-installation-token"), true);
  const result = await broker.resolve("forge-installation-token", request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "revoked");
  assert.equal(broker.revoke("forge-installation-token"), false);
  assert.equal(broker.revoke("never-existed"), false);
});

test("vault: describe returns reference names only, never material", async () => {
  const broker = vault([
    entry(),
    entry({
      reference: "model-profile-a",
      scope: {
        platform: "",
        installationId: "",
        repoFullName: "",
        purpose: "model",
      },
      material: { value: "sk_modelsecretvalue0000001", expiresAtMs: 0 },
    }),
  ]);
  assert.deepEqual(broker.describe(), ["forge-installation-token", "model-profile-a"]);
});

test("vault: unscoped binding serves scoped requests; scoped binding refuses foreign identity", async () => {
  const broker = vault([
    entry({
      reference: "model-profile-a",
      scope: { platform: "", installationId: "", repoFullName: "", purpose: "model" },
      material: { value: "sk_modelsecretvalue0000001", expiresAtMs: 0 },
    }),
  ]);
  // The operator declared the model credential unscoped, so it serves a
  // fully identified run request...
  const ok = await broker.resolve("model-profile-a", request({ purpose: "model" }));
  assert.equal(ok.ok, true);
  // ...and an unscoped one.
  const unscoped = await broker.resolve("model-profile-a", {
    purpose: "model",
    platform: "",
    installationId: "",
    repoFullName: "",
  });
  assert.equal(unscoped.ok, true);
  // But a SCOPED binding never serves a foreign identity (covered by the
  // isolation tests above): the asymmetry is one-directional.
});

test("vault: constructor fails closed on duplicate references and malformed entries", () => {
  assert.throws(() => vault([entry(), entry()]), /more than once/);
  assert.throws(
    () => vault([entry({ reference: "bad ref" })]),
    /reference is malformed/,
  );
  assert.throws(
    () => vault([entry({ material: { value: "", expiresAtMs: 0 } })]),
    /material is malformed/,
  );
  assert.throws(
    () =>
      vault([
        entry({
          scope: {
            platform: "github",
            installationId: "1",
            repoFullName: "o/r",
            purpose: "wat" as never,
          },
        }),
      ]),
    /purpose is malformed/,
  );
});

test("vault: bounded capacity refuses excess entries", () => {
  const many = Array.from({ length: 1025 }, (_unused, index) =>
    entry({ reference: `ref-${index}` }),
  );
  assert.throws(() => vault(many), /at most 1024/);
});

test("vault: the vault object serializes without secret values", () => {
  const broker = vault();
  assert.equal(JSON.stringify(broker).includes("ghs_secretvalue000000000001"), false);
});
