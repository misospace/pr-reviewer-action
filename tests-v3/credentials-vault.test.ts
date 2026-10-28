import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemorySecretVault,
  type ResolutionRequest,
  type ScopeDimension,
  type SecretScope,
  type VaultEntry,
} from "../src/credentials/index.js";

const HOUR_MS = 3_600_000;

const UNSCOPED: readonly ScopeDimension[] = [
  "platform",
  "installationId",
  "repoFullName",
  "profileName",
];

function scope(overrides: Partial<SecretScope> = {}): SecretScope {
  return {
    platform: "github",
    installationId: "1001",
    repoFullName: "owner/repo-a",
    profileName: "",
    purpose: "forge_clone",
    // Default fixture binding: forge clone is repo/installation-bound and
    // has no profile dimension, so profileName is explicitly unscoped.
    unscopedDimensions: ["profileName"],
    ...overrides,
  };
}

function entry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    reference: "forge-installation-token",
    scope: scope(),
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
    profileName: "",
    ...overrides,
  };
}

function vault(
  entries: VaultEntry[] = [entry()],
  options: Parameters<typeof InMemorySecretVault.prototype.resolve>[0] extends never
    ? never
    : { now?: () => number; refresh?: (reference: string) => Promise<{ value: string; expiresAtMs: number } | null>; minRemainingMs?: number } = {},
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
  const result = await broker.resolve(
    "forge-installation-token",
    request({ installationId: "2002" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.reason, "credential is bound to a different installation");
    assert.equal(result.reason.includes("ghs_"), false);
  }
});

test("vault: cross-repo isolation — another repository under the same installation is refused", async () => {
  const broker = vault();
  const result = await broker.resolve(
    "forge-installation-token",
    request({ repoFullName: "owner/repo-b" }),
  );
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

test("vault: profile isolation — a credential bound to model profile A refuses profile B", async () => {
  const broker = vault([
    entry({
      reference: "model-profile-a",
      scope: scope({
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "profile-a",
        purpose: "model",
        unscopedDimensions: ["platform", "installationId", "repoFullName"],
      }),
      material: { value: "sk_modelsecretvalue0000001", expiresAtMs: 0 },
    }),
  ]);
  const ok = await broker.resolve("model-profile-a", request({ purpose: "model", profileName: "profile-a" }));
  assert.equal(ok.ok, true);
  const other = await broker.resolve("model-profile-a", request({ purpose: "model", profileName: "profile-b" }));
  assert.equal(other.ok, false);
  if (!other.ok) {
    assert.equal(other.code, "scope_mismatch");
    assert.equal(other.reason, "credential is bound to a different profile");
  }
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
  const secretShaped = await broker.resolve("sk-realapikeyvalue123456", request());
  assert.equal(secretShaped.ok, false);
  if (!secretShaped.ok) assert.equal(secretShaped.code, "invalid_request");
});

test("vault: a secret-shaped reference is refused at construction", () => {
  assert.throws(
    () => vault([entry({ reference: "ghp_0123456789abcdefghij" })]),
    /reference is malformed/,
  );
});

test("vault: expired (past-margin) material is refused without a refresh source", async () => {
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

test("vault: material inside the refresh margin is treated as expiring (#729 parity)", async () => {
  // 30 seconds of life left against the default 60s margin: refused.
  let now = 1_970_000;
  const broker = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 2_000_000 } })],
    { now: () => now },
  );
  const result = await broker.resolve("forge-installation-token", request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "expired");
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

test("vault: refresh returning already-expiring material is refused, never handed out", async () => {
  let now = 3_000;
  const broker = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 2_000 } })],
    {
      now: () => now,
      // A "refreshed" token with almost no life left (or already expired)
      // must not pass the margin check.
      refresh: async () => ({ value: "ghs_refreshedvalue0000000001", expiresAtMs: 3_000 }),
    },
  );
  const result = await broker.resolve("forge-installation-token", request());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "expired");
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

test("vault: refreshed material is re-validated — malformed refresh output is refused", async () => {
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

test("vault: revocation wins the race against an in-flight refresh", async () => {
  let releaseRefresh: ((material: { value: string; expiresAtMs: number }) => void) | undefined;
  let signalInFlight: (() => void) | undefined;
  const refreshInFlight = new Promise<void>((resolve) => {
    signalInFlight = resolve;
  });
  let now = 3_000;
  const broker = vault(
    [entry({ material: { value: "ghs_secretvalue000000000001", expiresAtMs: 2_000 } })],
    {
      now: () => now,
      refresh: () =>
        new Promise((resolve) => {
          releaseRefresh = resolve;
          signalInFlight!();
        }),
    },
  );
  const pending = broker.resolve("forge-installation-token", request());
  await refreshInFlight;
  // The reference is revoked while the refresh is still in flight.
  assert.equal(broker.revoke("forge-installation-token"), true);
  releaseRefresh!({ value: "ghs_refreshedvalue0000000001", expiresAtMs: now + HOUR_MS });
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "revoked");
  // The in-flight resolution never stored or returned the refreshed
  // material, and later resolutions keep refusing revoked.
  const after = await broker.resolve("forge-installation-token", request());
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.code, "revoked");
});

test("vault: describe returns reference names only, never material", async () => {
  const broker = vault([
    entry(),
    entry({
      reference: "model-profile-a",
      scope: scope({
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "profile-a",
        purpose: "model",
        unscopedDimensions: ["platform", "installationId", "repoFullName"],
      }),
      material: { value: "sk_modelsecretvalue0000001", expiresAtMs: 0 },
    }),
  ]);
  assert.deepEqual(broker.describe(), ["forge-installation-token", "model-profile-a"]);
});

test("vault: an unscoped binding serves any request value for the declared dimensions", async () => {
  const broker = vault([
    entry({
      reference: "model-profile-a",
      scope: scope({
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "",
        purpose: "model",
        unscopedDimensions: UNSCOPED,
      }),
      material: { value: "sk_modelsecretvalue0000001", expiresAtMs: 0 },
    }),
  ]);
  const ok = await broker.resolve("model-profile-a", request({ purpose: "model", profileName: "profile-a" }));
  assert.equal(ok.ok, true);
  const other = await broker.resolve("model-profile-a", request({ purpose: "model", profileName: "profile-b" }));
  assert.equal(other.ok, true);
});

test("vault: constructor fails closed on duplicate references and malformed entries", () => {
  assert.throws(() => vault([entry(), entry()]), /more than once/);
  assert.throws(() => vault([entry({ reference: "bad ref" })]), /reference is malformed/);
  assert.throws(
    () => vault([entry({ material: { value: "", expiresAtMs: 0 } })]),
    /material is malformed/,
  );
  assert.throws(
    () => vault([entry({ scope: scope({ purpose: "wat" as never }) })]),
    /purpose is malformed/,
  );
});

test("vault: blank bound scope dimension is a construction error, never a silent grant", () => {
  // The blank-template typo: installationId "" with no unscoped declaration.
  assert.throws(
    () => vault([entry({ scope: scope({ installationId: "" }) })]),
    /bind it or declare it unscoped/,
  );
  // platform "" without a declaration is the same failure.
  assert.throws(
    () => vault([entry({ scope: scope({ platform: "", unscopedDimensions: ["profileName"] }) })]),
    /bind it or declare it unscoped/,
  );
  // Declaring unscoped but carrying a value makes the declaration a lie —
  // including for platform, where the stored "github" answering a forgejo
  // request would be cross-forge confusion.
  assert.throws(
    () => vault([entry({ scope: scope({ unscopedDimensions: ["profileName"], profileName: "profile-a" }) })]),
    /declared unscoped but carries a value/,
  );
  assert.throws(
    () => vault([entry({ scope: scope({ unscopedDimensions: ["platform"] }) })]),
    /declared unscoped but carries a value/,
  );
});

test("vault: unknown fields on entry, scope, and material are rejected", () => {
  // A misspelled scope dimension must not quietly unscope the credential.
  assert.throws(
    () =>
      vault([
        entry({
          scope: {
            ...scope(),
            instalationId: "1001",
          } as unknown as SecretScope,
        }),
      ]),
    /unsupported field 'instalationId'/,
  );
  // An extra material field must not ride out unredacted.
  assert.throws(
    () =>
      vault([
        entry({
          material: {
            value: "ghs_secretvalue000000000001",
            expiresAtMs: 2_000_000_000_000,
            previousValue: "ghs_previoussecretvalue01",
          } as VaultEntry["material"],
        }),
      ]),
    /material has unsupported field 'previousValue'/,
  );
  assert.throws(
    () => vault([{ ...entry(), junk: true } as VaultEntry]),
    /entry has unsupported field 'junk'/,
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
