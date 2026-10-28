/** Control-plane record contracts (#736): fail-closed validators,
 * rebuilt-frozen outputs, sentinel shape, the secret-free record
 * surface, and the no-fabricated-cost invariant. */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PUBLICATION_HISTORY_CAP,
  newRunRecord,
  validateAdoptedRepository,
  validateIdempotencyKey,
  validateInstallation,
  validatePublication,
  validateRun,
  validateUsage,
  type InstallationRecord,
  type PublicationRecord,
  type RunRecord,
  type UsageRecord,
} from "../src/state/index.js";

function validInstallation(): Record<string, unknown> {
  return {
    installationId: "123",
    platform: "github",
    profileName: "default",
    accountLogin: "octo-org",
    configRef: "instance-config:rev-7",
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };
}

function validAdoptedRepository(): Record<string, unknown> {
  return {
    platform: "github",
    installationId: "123",
    repoFullName: "octo-org/repo",
    adoptionEpoch: "epoch-1",
    configFingerprint: "abcdef1234567890",
    headFingerprint: "",
    enabled: true,
    adoptedAtMs: 1000,
    updatedAtMs: 1000,
  };
}

function validRun(): Record<string, unknown> {
  return {
    runId: "run-1",
    jobId: "job-1",
    kind: "review",
    state: "queued",
    executorIdentity: "local:v1",
    attempt: 0,
    headSha: "abcdef1234567",
    configFingerprint: "abcdef1234567890",
    leaseOwner: "",
    leaseExpiresAtMs: 0,
    resultHeadSha: "",
    failureReason: "",
    supersededByJobId: "",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    startedAtMs: 0,
    finishedAtMs: 0,
  };
}

function validIdempotencyKey(): Record<string, unknown> {
  return { key: "evt-1", binding: "job-1", createdAtMs: 1000, expiresAtMs: 0 };
}

function validPublication(): Record<string, unknown> {
  return {
    jobId: "job-1",
    publicationState: "pending",
    destination: "github-comment:42",
    publicationId: "",
    attempt: 0,
    lastError: "",
    resultHeadSha: "",
    history: [],
    createdAtMs: 1000,
    updatedAtMs: 1000,
  };
}

function validUsage(): Record<string, unknown> {
  return {
    usageId: "run-1:0",
    runId: "run-1",
    route: "primary-profile",
    role: "primary",
    requestCount: 2,
    inputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 50,
    costMicros: 0,
    costProvenance: "unknown",
    recordedAtMs: 1000,
  };
}

test("installation validator rebuilds frozen and drops extras", () => {
  const value = {
    ...validInstallation(),
    secret: "provider-api-key",
    extra: true,
  };
  const record = validateInstallation(value);
  assert.ok(record !== null);
  assert.deepEqual(Object.keys(record).sort(), [
    "accountLogin",
    "configRef",
    "createdAtMs",
    "installationId",
    "platform",
    "profileName",
    "updatedAtMs",
  ]);
  assert.equal(Object.isFrozen(record), true);
  assert.equal((record as unknown as Record<string, unknown>)["secret"], undefined);
});

test("installation validator rejects malformed shapes", () => {
  assert.equal(validateInstallation(null), null);
  assert.equal(validateInstallation("string"), null);
  assert.equal(validateInstallation({ ...validInstallation(), installationId: "0" }), null);
  assert.equal(validateInstallation({ ...validInstallation(), installationId: "x1" }), null);
  assert.equal(validateInstallation({ ...validInstallation(), platform: "gitea" }), null);
  assert.equal(validateInstallation({ ...validInstallation(), profileName: "" }), null);
  assert.equal(
    validateInstallation({ ...validInstallation(), profileName: "bad\nname" }),
    null,
  );
  assert.equal(validateInstallation({ ...validInstallation(), createdAtMs: -1 }), null);
  assert.equal(validateInstallation({ ...validInstallation(), updatedAtMs: Number.NaN }), null);
});

test("adopted-repository validator accepts and rebuilds", () => {
  const record = validateAdoptedRepository(validAdoptedRepository());
  assert.ok(record !== null);
  assert.equal(record!.enabled, true);
  assert.equal(record!.headFingerprint, "");
  const withHead = validateAdoptedRepository({
    ...validAdoptedRepository(),
    headFingerprint: "abcdef1234567",
  });
  assert.ok(withHead !== null);
  assert.equal(withHead!.headFingerprint, "abcdef1234567");
});

test("adopted-repository validator rejects malformed fields", () => {
  assert.equal(validateAdoptedRepository({ ...validAdoptedRepository(), repoFullName: "" }), null);
  assert.equal(
    validateAdoptedRepository({ ...validAdoptedRepository(), adoptionEpoch: "" }),
    null,
  );
  assert.equal(
    validateAdoptedRepository({ ...validAdoptedRepository(), configFingerprint: "xyz" }),
    null,
  );
  assert.equal(
    validateAdoptedRepository({ ...validAdoptedRepository(), headFingerprint: "ABCDEFG" }),
    null,
  );
  assert.equal(validateAdoptedRepository({ ...validAdoptedRepository(), enabled: "yes" }), null);
});

test("run validator accepts the sentinel shape and rebuilds", () => {
  const record = validateRun(validRun());
  assert.ok(record !== null);
  assert.equal(record!.state, "queued");
  assert.equal(record!.leaseOwner, "");
  assert.equal(record!.resultHeadSha, "");
  assert.equal(record!.supersededByJobId, "");
  assert.equal(Object.isFrozen(record), true);
});

test("run validator rejects malformed fields", () => {
  assert.equal(validateRun({ ...validRun(), runId: "" }), null);
  assert.equal(validateRun({ ...validRun(), runId: " run-1" }), null);
  assert.equal(validateRun({ ...validRun(), jobId: "" }), null);
  assert.equal(validateRun({ ...validRun(), kind: "qa" }), null);
  assert.equal(validateRun({ ...validRun(), state: "paused" }), null);
  assert.equal(validateRun({ ...validRun(), executorIdentity: "" }), null);
  assert.equal(validateRun({ ...validRun(), attempt: -1 }), null);
  assert.equal(validateRun({ ...validRun(), attempt: 1.5 }), null);
  assert.equal(validateRun({ ...validRun(), headSha: "ABCDEF1234567" }), null);
  assert.equal(validateRun({ ...validRun(), headSha: "abc" }), null);
  assert.equal(validateRun({ ...validRun(), configFingerprint: "abc" }), null);
  assert.equal(validateRun({ ...validRun(), leaseExpiresAtMs: -1 }), null);
  assert.equal(validateRun({ ...validRun(), startedAtMs: -1 }), null);
  assert.equal(validateRun({ ...validRun(), finishedAtMs: -1 }), null);
});

test("newRunRecord builds a sentinel-shaped queued run and fails closed", () => {
  const record = newRunRecord(
    {
      runId: "run-9",
      jobId: "job-9",
      kind: "follow_up",
      executorIdentity: "local:v1",
      headSha: "",
      configFingerprint: "",
    },
    5000,
  );
  assert.equal(record.state, "queued");
  assert.equal(record.attempt, 0);
  assert.equal(record.createdAtMs, 5000);
  assert.equal(record.updatedAtMs, 5000);
  assert.equal(record.startedAtMs, 0);
  assert.equal(record.finishedAtMs, 0);
  assert.equal(record.leaseOwner, "");
  assert.throws(() => newRunRecord(
    {
      runId: "run-9",
      jobId: "job-9",
      kind: "follow_up",
      executorIdentity: "local:v1",
      headSha: "",
      configFingerprint: "",
    },
    Number.NaN,
  ), RangeError);
  assert.throws(() => newRunRecord(
    {
      runId: "",
      jobId: "job-9",
      kind: "follow_up",
      executorIdentity: "local:v1",
      headSha: "",
      configFingerprint: "",
    },
    5000,
  ), RangeError);
});

test("idempotency-key validator accepts and rebuilds", () => {
  const record = validateIdempotencyKey(validIdempotencyKey());
  assert.ok(record !== null);
  assert.equal(record!.expiresAtMs, 0);
  const expiring = validateIdempotencyKey({ ...validIdempotencyKey(), expiresAtMs: 9000 });
  assert.ok(expiring !== null);
  assert.equal(expiring!.expiresAtMs, 9000);
});

test("idempotency-key validator rejects malformed fields", () => {
  assert.equal(validateIdempotencyKey({ ...validIdempotencyKey(), key: "" }), null);
  assert.equal(validateIdempotencyKey({ ...validIdempotencyKey(), binding: "" }), null);
  assert.equal(validateIdempotencyKey({ ...validIdempotencyKey(), createdAtMs: -1 }), null);
  assert.equal(validateIdempotencyKey({ ...validIdempotencyKey(), expiresAtMs: -1 }), null);
});

test("publication validator accepts, rebuilds, and enforces the history cap", () => {
  const record = validatePublication(validPublication());
  assert.ok(record !== null);
  assert.equal(record!.publicationState, "pending");
  const history = Array.from({ length: PUBLICATION_HISTORY_CAP }, (_, index) => ({
    atMs: 1000 + index,
    outcome: "attempt",
    detail: `attempt ${index}`,
  }));
  const atCap = validatePublication({ ...validPublication(), history });
  assert.ok(atCap !== null);
  assert.equal(atCap!.history.length, PUBLICATION_HISTORY_CAP);
  const overCap = validatePublication({
    ...validPublication(),
    history: [...history, { atMs: 99999, outcome: "failed", detail: "one too many" }],
  });
  assert.equal(overCap, null);
});

test("publication validator rejects malformed fields", () => {
  assert.equal(validatePublication({ ...validPublication(), publicationState: "retrying" }), null);
  assert.equal(validatePublication({ ...validPublication(), destination: "" }), null);
  assert.equal(validatePublication({ ...validPublication(), attempt: -1 }), null);
  assert.equal(validatePublication({ ...validPublication(), history: "nope" }), null);
  assert.equal(
    validatePublication({
      ...validPublication(),
      history: [{ atMs: 1000, outcome: "unknown", detail: "" }],
    }),
    null,
  );
  assert.equal(
    validatePublication({
      ...validPublication(),
      history: [{ atMs: 1000, outcome: "attempt", detail: "bad\u0000detail" }],
    }),
    null,
  );
});

test("usage validator accepts and rebuilds", () => {
  const record = validateUsage(validUsage());
  assert.ok(record !== null);
  assert.equal(record!.costProvenance, "unknown");
  assert.equal(record!.costMicros, 0);
});

test("usage validator rejects malformed fields", () => {
  assert.equal(validateUsage({ ...validUsage(), usageId: "" }), null);
  assert.equal(validateUsage({ ...validUsage(), requestCount: 0 }), null);
  assert.equal(validateUsage({ ...validUsage(), inputTokens: -1 }), null);
  assert.equal(validateUsage({ ...validUsage(), outputTokens: 1.5 }), null);
  assert.equal(validateUsage({ ...validUsage(), role: "orchestrator" }), null);
  assert.equal(validateUsage({ ...validUsage(), costProvenance: "guessed" }), null);
});

test("cost invariant: unknown provenance can never carry a nonzero cost", () => {
  assert.equal(
    validateUsage({ ...validUsage(), costProvenance: "unknown", costMicros: 500 }),
    null,
  );
  const reported = validateUsage({
    ...validUsage(),
    costProvenance: "provider-reported",
    costMicros: 500,
  });
  assert.ok(reported !== null);
  assert.equal(reported!.costMicros, 500);
  const estimated = validateUsage({
    ...validUsage(),
    costProvenance: "configured-estimate",
    costMicros: 250,
  });
  assert.ok(estimated !== null);
  assert.equal(estimated!.costProvenance, "configured-estimate");
});

test("record surfaces carry no secret-bearing fields", () => {
  // The #736 "do not persist" rule enforced structurally: no record
  // contract has a credential/secret-shaped field, and a hostile extra
  // key riding in on the input is DROPPED by the rebuilt-frozen
  // validators, never carried into durable state.
  const secretish = /(secret|password|credential|bearer|authorization|api_?key|auth_?token|^token$)/i;
  const surfaces: Array<[string, readonly string[]]> = [
    ["installation", Object.keys(validateInstallation(validInstallation())!)],
    [
      "adoptedRepository",
      Object.keys(validateAdoptedRepository(validAdoptedRepository())!),
    ],
    ["run", Object.keys(validateRun(validRun())!)],
    [
      "idempotencyKey",
      Object.keys(validateIdempotencyKey(validIdempotencyKey())!),
    ],
    [
      "publication",
      Object.keys(validatePublication(validPublication())!),
    ],
    ["usage", Object.keys(validateUsage(validUsage())!)],
  ];
  for (const [name, keys] of surfaces) {
    for (const key of keys) {
      assert.equal(
        secretish.test(key),
        false,
        `${name} record surface must not carry a secret-shaped field: ${key}`,
      );
    }
  }
  // A hostile `secret` field on ANY record input is dropped on rebuild.
  for (const value of [
    validInstallation(),
    validAdoptedRepository(),
    validRun(),
    validIdempotencyKey(),
    validPublication(),
    validUsage(),
  ]) {
    const poisoned = { ...value, secret: "provider-api-key" };
    const validators = [
      validateInstallation,
      validateAdoptedRepository,
      validateRun,
      validateIdempotencyKey,
      validatePublication,
      validateUsage,
    ];
    let survived = false;
    for (const validator of validators) {
      const rebuilt = validator(poisoned) as unknown as Record<string, unknown> | null;
      if (rebuilt !== null && rebuilt["secret"] !== undefined) {
        survived = true;
      }
    }    assert.equal(survived, false, "a smuggled secret field must never survive a rebuild");
  }
});
