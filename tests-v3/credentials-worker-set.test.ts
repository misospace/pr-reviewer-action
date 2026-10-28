import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerCredentialPlan,
  createResultChannelAuth,
  createSecretRedactor,
  InMemorySecretVault,
  resolveWorkerCredentials,
  validateCredentialPlan,
  type ScopeDimension,
  type SecretScope,
  type VaultEntry,
  type WorkerCredentialPlanInput,
} from "../src/credentials/index.js";

const MODEL_A = "model-profile-a";
const MODEL_B = "model-profile-b";
const EVIDENCE = "evidence-linked-sources";
const FORGE_CLONE = "forge-clone-token";
const FORGE_PUBLISH = "forge-publish-token";
const RUN = "run-20261028-0001";
const JOB = "job-20261028-0001";
const RC_KEY = "controller-signing-key-0123456789";

const UNSCOPED: readonly ScopeDimension[] = [
  "platform",
  "installationId",
  "repoFullName",
  "profileName",
];

function forgeScope(purpose: "forge_clone" | "forge_publish", repo: string): SecretScope {
  return {
    platform: "github",
    installationId: "1001",
    repoFullName: repo,
    profileName: "",
    purpose,
    unscopedDimensions: ["profileName"],
  };
}

function input(overrides: Partial<WorkerCredentialPlanInput> = {}): WorkerCredentialPlanInput {
  return {
    jobId: JOB,
    runId: RUN,
    platform: "github",
    repoFullName: "owner/repo-a",
    installationId: "1001",
    fork: false,
    modelMode: "direct_worker",
    modelProfileName: "profile-a",
    evidenceProfileName: "linked-sources",
    modelCredentialRef: MODEL_A,
    evidenceCredentialRef: EVIDENCE,
    forgeCloneCredentialRef: FORGE_CLONE,
    forgePublishCredentialRef: FORGE_PUBLISH,
    resultChannel: true,
    allowForkEvidence: false,
    ...overrides,
  };
}

function vaultWithSecrets(repo = "owner/repo-a"): { vault: InMemorySecretVault; secrets: string[] } {
  const secrets = [
    "ghs_clonesecretvalue0000001",
    "ghs_publishsecretvalue00001",
    "sk_modelasecretvalue00000001",
    "sk_evidencesecretvalue000001",
  ] as const;
  const entries: VaultEntry[] = [
    {
      reference: FORGE_CLONE,
      scope: forgeScope("forge_clone", repo),
      material: { value: secrets[0] as string, expiresAtMs: 0 },
    },
    {
      reference: FORGE_PUBLISH,
      scope: forgeScope("forge_publish", repo),
      material: { value: secrets[1] as string, expiresAtMs: 0 },
    },
    {
      // The model credential is bound to its PROFILE: the broker can detect
      // a controller mapping bug that hands profile B's job profile A's
      // credential.
      reference: MODEL_A,
      scope: {
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "profile-a",
        purpose: "model",
        unscopedDimensions: ["platform", "installationId", "repoFullName"],
      },
      material: { value: secrets[2] as string, expiresAtMs: 0 },
    },
    {
      reference: EVIDENCE,
      scope: {
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "linked-sources",
        purpose: "evidence",
        unscopedDimensions: ["platform", "installationId", "repoFullName"],
      },
      material: { value: secrets[3] as string, expiresAtMs: 0 },
    },
  ];
  return { vault: new InMemorySecretVault(entries), secrets: [...secrets] };
}

function rcAuth(): ReturnType<typeof createResultChannelAuth> {
  return createResultChannelAuth({ key: RC_KEY });
}

test("worker-set: plan carries exactly the five fixed names for a full non-fork run", () => {
  const plan = buildWorkerCredentialPlan(input());
  assert.deepEqual(
    plan.credentials.map((c) => c.name),
    ["forge-clone", "forge-publish", "model", "evidence", "result-channel"],
  );
});

test("worker-set: the selected model profile is the only model credential — structurally", () => {
  const planA = buildWorkerCredentialPlan(input());
  const planB = buildWorkerCredentialPlan(input({ modelCredentialRef: MODEL_B, modelProfileName: "profile-b" }));
  const modelA = planA.credentials.filter((c) => c.name === "model");
  const modelB = planB.credentials.filter((c) => c.name === "model");
  assert.equal(modelA.length, 1);
  assert.equal(modelB.length, 1);
  assert.equal(modelA[0]?.reference, MODEL_A);
  assert.equal(modelB[0]?.reference, MODEL_B);
  // Profile A's credential cannot appear anywhere in profile B's plan.
  assert.equal(JSON.stringify(planB).includes(MODEL_A), false);
});

test("worker-set: a mapping bug handing profile B's job profile A's ref is caught by the broker", async () => {
  // The controller bug scenario: profile-b job, but the plan carries
  // profile A's credential reference while claiming profile B.
  const { vault } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input({ modelProfileName: "profile-b" }));
  const result = await resolveWorkerCredentials(vault, plan);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.name, "model");
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.reason, "credential is bound to a different profile");
  }
});

test("worker-set: fork policy — evidence reference omitted unless explicitly allowed, durably", () => {
  const forked = buildWorkerCredentialPlan(input({ fork: true }));
  assert.equal(forked.fork, true);
  assert.equal(forked.forkEvidencePolicy, "off");
  assert.equal(forked.credentials.some((c) => c.name === "evidence"), false);

  const permitted = buildWorkerCredentialPlan(input({ fork: true, allowForkEvidence: true }));
  assert.equal(permitted.forkEvidencePolicy, "allowed");
  assert.equal(permitted.credentials.some((c) => c.name === "evidence" && c.reference === EVIDENCE), true);

  // Non-fork runs are unaffected by the flag: evidence rides normally.
  const plain = buildWorkerCredentialPlan(input({ allowForkEvidence: false }));
  assert.equal(plain.forkEvidencePolicy, "off");
  assert.equal(plain.credentials.some((c) => c.name === "evidence"), true);
});

test("worker-set: fork policy survives a durable round trip — validation enforces the boundary", async () => {
  const { vault } = vaultWithSecrets();
  // A fork plan built under policy "off", serialized to durable state
  // (references only), read back, re-validated, and resolved: the boundary
  // holds at the handoff seam, not just at the builder.
  const forked = buildWorkerCredentialPlan(input({ fork: true }));
  const durable = JSON.parse(JSON.stringify(forked));
  const restored = validateCredentialPlan(durable);
  const result = await resolveWorkerCredentials(vault, restored, { resultChannel: rcAuth() });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entries.some((e) => e.name === "evidence"), false);
  }

  // The tamper path: a fork plan under policy "off" that somehow carries an
  // evidence entry (forged, drifted, or stored by an older version) is
  // REFUSED by validation, so no resolver that only trusts validated plans
  // can hand the evidence secret to a fork worker.
  const forged = {
    ...JSON.parse(JSON.stringify(forked)),
    credentials: [
      ...JSON.parse(JSON.stringify(forked.credentials)),
      { name: "evidence", reference: EVIDENCE },
    ],
  };
  assert.throws(() => validateCredentialPlan(forged), /must not carry an 'evidence' credential/);
});

test("worker-set: forkEvidencePolicy 'allowed' is only valid on a fork plan", () => {
  assert.throws(
    () =>
      validateCredentialPlan({
        ...buildWorkerCredentialPlan(input()),
        fork: false,
        forkEvidencePolicy: "allowed",
      }),
    /only valid on a fork plan/,
  );
});

test("worker-set: empty forge/evidence references produce no entry; empty model ref fails closed", () => {
  const plan = buildWorkerCredentialPlan(
    input({
      evidenceCredentialRef: "",
      forgeCloneCredentialRef: "",
      forgePublishCredentialRef: "",
      resultChannel: false,
    }),
  );
  assert.deepEqual(
    plan.credentials.map((c) => c.name),
    ["model"],
  );
  // A review run without its model credential must fail at plan time.
  assert.throws(
    () => buildWorkerCredentialPlan(input({ modelCredentialRef: "" })),
    /requires a model credential reference/,
  );
});

test("worker-set: builder fails closed on malformed, secret-shaped references and unknown model mode", () => {
  assert.throws(() => buildWorkerCredentialPlan(input({ modelCredentialRef: "bad ref!" })), /grammar/);
  assert.throws(
    () => buildWorkerCredentialPlan(input({ modelCredentialRef: "sk-realapikeyvalue123456" })),
    /looks like secret material/,
  );
  assert.throws(
    () => buildWorkerCredentialPlan(input({ modelMode: "gateway" as never })),
    /unknown model mode/,
  );
  assert.throws(() => buildWorkerCredentialPlan(input({ runId: "" })), /runId/);
});

test("worker-set: resolveWorkerCredentials hands back exactly the plan's material, all-or-nothing", async () => {
  const { vault, secrets } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  const set = await resolveWorkerCredentials(vault, plan, { resultChannel: rcAuth() });
  if (!set.ok) {
    assert.fail(`handoff refused: ${set.code} ${set.reason}`);
    return;
  }
  assert.deepEqual(
    set.entries.map((e) => e.name),
    ["forge-clone", "forge-publish", "model", "evidence", "result-channel"],
  );
  // The result-channel token is minted per run, not stored: it is a v1
  // token with a real expiry.
  const resultChannel = set.entries.find((e) => e.name === "result-channel");
  assert.equal(resultChannel?.material.value.startsWith("v1."), true);
  assert.equal((resultChannel?.material.expiresAtMs ?? 0) > 0, true);
  assert.deepEqual(
    set.entries
      .filter((e) => e.name !== "result-channel")
      .map((e) => e.material.value)
      .sort(),
    [...secrets].sort(),
  );
});

test("worker-set: a result-channel request without an authority fails closed", async () => {
  const { vault } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  const result = await resolveWorkerCredentials(vault, plan);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.name, "result-channel");
    assert.equal(result.code, "invalid_request");
  }
});

test("worker-set: one refusal withholds the whole set — no partial handoff", async () => {
  const { vault } = vaultWithSecrets();
  vault.revoke(FORGE_PUBLISH);
  const plan = buildWorkerCredentialPlan(input());
  const result = await resolveWorkerCredentials(vault, plan, { resultChannel: rcAuth() });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.name, "forge-publish");
    assert.equal(result.code, "revoked");
  }
});

test("worker-set: multi-installation isolation end-to-end through plan → resolve", async () => {
  // The issue's mandated scenario exercised through the handoff path a
  // worker actually takes: the same plan shape, but the run's installation
  // is a different one — the forge credential refuses and the whole
  // handoff is withheld.
  const { vault } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input({ installationId: "2002" }));
  const result = await resolveWorkerCredentials(vault, plan, { resultChannel: rcAuth() });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.name, "forge-clone");
    assert.equal(result.code, "scope_mismatch");
    assert.equal(result.reason, "credential is bound to a different installation");
  }
});

test("worker-set: cross-repo model credential cannot be resolved into another repo's set", async () => {
  // A repo-scoped model credential is refused for a different repository —
  // credentials for model profile A cannot leak into other repositories'
  // jobs either.
  const repoScopedModel = new InMemorySecretVault([
    {
      reference: FORGE_CLONE,
      scope: forgeScope("forge_clone", "owner/repo-b"),
      material: { value: "ghs_clonesecretvalue0000001", expiresAtMs: 0 },
    },
    {
      reference: FORGE_PUBLISH,
      scope: forgeScope("forge_publish", "owner/repo-b"),
      material: { value: "ghs_publishsecretvalue00001", expiresAtMs: 0 },
    },
    {
      reference: MODEL_A,
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo-a",
        profileName: "profile-a",
        purpose: "model",
        unscopedDimensions: [],
      },
      material: { value: "sk_modelasecretvalue00000001", expiresAtMs: 0 },
    },
  ]);
  const plan = buildWorkerCredentialPlan(input({ repoFullName: "owner/repo-b" }));
  const result = await resolveWorkerCredentials(repoScopedModel, plan, { resultChannel: rcAuth() });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.name, "model");
    assert.equal(result.code, "scope_mismatch");
  }
});

test("worker-set: no secrets in durable payload — plan and executor request stay reference-only", async () => {
  const { vault, secrets } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  // The plan is what would be embedded into durable state / the execution
  // request envelope: references and names only.
  const planJson = JSON.stringify(plan);
  for (const secret of secrets) {
    assert.equal(planJson.includes(secret), false);
  }
  // An ExecutionRequest carrying the plan's credentials validates unchanged
  // and still contains no material.
  const request = {
    jobId: JOB,
    runId: RUN,
    attempt: 1,
    kind: "review" as const,
    platform: "github" as const,
    repoFullName: "owner/repo-a",
    prNumber: 7,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    deadlineAtMs: 0,
    workspace: {
      rootPath: "/controller/workspaces/ws-1",
      headSha: "a".repeat(40),
      mergeBaseSha: "b".repeat(40),
      platform: "github" as const,
      repoFullName: "owner/repo-a",
      createdAtMs: 1_000,
    },
    profiles: { executor: "local", model: "profile-a", evidence: "linked-sources" },
    credentials: plan.credentials,
    runDir: "/controller/runs/run-1",
    requestPath: "/controller/runs/run-1/request.json",
    resultPath: "/controller/runs/run-1/result.json",
  };
  const { validateExecutionRequest } = await import("../src/executor/index.js");
  const validated = validateExecutionRequest(request);
  const requestJson = JSON.stringify(validated);
  for (const secret of secrets) {
    assert.equal(requestJson.includes(secret), false);
  }
  // And the durable JobRecord shape carries none of the material either.
  const durableRecord = {
    job: { jobId: JOB, runId: RUN, platform: "github", repoFullName: "owner/repo-a" },
    credentialPlan: plan,
  };
  assert.equal(JSON.stringify(durableRecord).includes(secrets[2] as string), false);
});

test("worker-set: the resolved set serializes to credential names only, never material", async () => {
  const { vault, secrets } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  const set = await resolveWorkerCredentials(vault, plan, { resultChannel: rcAuth() });
  if (!set.ok) {
    assert.fail(`handoff refused: ${set.code} ${set.reason}`);
    return;
  }
  const serialized = JSON.stringify(set);
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(JSON.parse(serialized), {
    ok: true,
    credentialNames: ["forge-clone", "forge-publish", "model", "evidence", "result-channel"],
  });
  // The guard holds for the parts too: serializing the entries array (the
  // natural "just the credentials" diagnostic) yields names and expiries,
  // never values — the material value is non-enumerable.
  const entriesJson = JSON.stringify(set.entries);
  for (const secret of secrets) {
    assert.equal(entriesJson.includes(secret), false);
  }
  assert.equal(set.entries[0]?.material.value.startsWith("ghs_"), true);
});

test("worker-set: resolved material redacts from logs and artifacts", async () => {
  const { vault, secrets } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  const set = await resolveWorkerCredentials(vault, plan, { resultChannel: rcAuth() });
  if (!set.ok) {
    assert.fail(`handoff refused: ${set.code} ${set.reason}`);
    return;
  }
  const logLine = `POST /v1/chat/completions auth=Bearer ${secrets[2] as string} status=200`;
  assert.equal(set.redactor.redact(logLine).includes(secrets[2] as string), false);
  assert.equal(set.redactor.redact(logLine).includes("[REDACTED]"), true);
  const artifact = { endpoint: "https://api.example.test", headers: { authorization: secrets[0] as string } };
  const scrubbed = set.redactor.redactJson(artifact);
  for (const secret of secrets) {
    assert.equal(scrubbed.includes(secret), false);
  }
  assert.equal(scrubbed.includes("[REDACTED]"), true);
});

test("redactor: JSON-escaped forms of a secret are scrubbed too", () => {
  const secret = 'sk-quote"inside\\value\t-12345';
  const redactor = createSecretRedactor([secret]);
  const scrubbed = redactor.redactJson({ headers: { authorization: secret } });
  assert.equal(scrubbed.includes("inside"), false);
  assert.equal(scrubbed.includes("12345"), false);
  assert.equal(scrubbed.includes("[REDACTED]"), true);
});

test("redactor: longest-first replacement covers substring secrets", () => {
  const redactor = createSecretRedactor([
    "short-secret",
    "longer-secret-value-extends",
  ]);
  const text = "prefix longer-secret-value-extends suffix short-secret suffix";
  const scrubbed = redactor.redact(text);
  assert.equal(scrubbed.includes("short-secret"), false);
  assert.equal(scrubbed.includes("longer"), false);
  assert.equal(scrubbed.split("[REDACTED]").length, 3);
});

test("redactor: fails closed on too-short values, marker-bearing values, duplicates and empties", () => {
  assert.throws(() => createSecretRedactor(["short"]), /at least 8/);
  assert.throws(() => createSecretRedactor(["has[REDACTED]inside"]), /redaction marker/);
  const redactor = createSecretRedactor(["", "", "supersecretvalue1", "supersecretvalue1"]);
  assert.equal(redactor.redact("has supersecretvalue1 inside"), "has [REDACTED] inside");
  assert.equal(redactor.redact("nothing to see"), "nothing to see");
});

test("worker-set: a handoff credential too short to redact is a typed failure, not a throw", async () => {
  const shortVault = new InMemorySecretVault([
    {
      reference: MODEL_A,
      scope: {
        platform: "",
        installationId: "",
        repoFullName: "",
        profileName: "",
        purpose: "model",
        unscopedDimensions: UNSCOPED,
      },
      material: { value: "abc", expiresAtMs: 0 },
    },
  ]);
  const plan = buildWorkerCredentialPlan(
    input({
      resultChannel: false,
      forgeCloneCredentialRef: "",
      forgePublishCredentialRef: "",
      evidenceCredentialRef: "",
    }),
  );
  const result = await resolveWorkerCredentials(shortVault, plan);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_request");
    assert.equal(result.reason.includes("abc"), false);
  }
});

test("worker-set: a forged durable plan is a typed handoff refusal, not an uncaught throw", async () => {
  const { vault } = vaultWithSecrets();
  // A fork plan under policy "off" carrying an evidence entry — the exact
  // shape validation refuses — reaches the resolver as durable state.
  const forked = buildWorkerCredentialPlan(input({ fork: true }));
  const forged = {
    ...JSON.parse(JSON.stringify(forked)),
    credentials: [
      ...JSON.parse(JSON.stringify(forked.credentials)),
      { name: "evidence", reference: EVIDENCE },
    ],
  };
  const result = await resolveWorkerCredentials(vault, forged, { resultChannel: rcAuth() });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invalid_request");
    assert.equal(result.reason.startsWith("credential plan is invalid"), true);
    assert.equal(result.reason.includes(EVIDENCE), false);
  }
});

test("worker-set: validateCredentialPlan rejects unknown fields, duplicate names, prototype names", () => {
  const plan = buildWorkerCredentialPlan(input());
  assert.throws(
    () => validateCredentialPlan({ ...plan, extra: true }),
    /unsupported field 'extra'/,
  );
  assert.throws(
    () =>
      validateCredentialPlan({
        ...plan,
        credentials: [...plan.credentials, { name: "model", reference: MODEL_B }],
      }),
    /more than once/,
  );
  assert.throws(
    () =>
      validateCredentialPlan({
        ...plan,
        credentials: [{ name: "root", reference: MODEL_A }],
      }),
    /must be one of/,
  );
  // The prototype-chain boundary value itself: "constructor" must NOT pass
  // as a credential name (it walks Object.prototype through `in`).
  assert.throws(
    () =>
      validateCredentialPlan({
        ...plan,
        credentials: [{ name: "constructor", reference: MODEL_A }],
      }),
    /must be one of/,
  );
  // The validator returns a frozen deep copy, not the caller's object.
  const validated = validateCredentialPlan(plan);
  assert.notEqual(validated, plan);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.credentials), true);
  assert.equal(Object.isFrozen(validated.credentials[0]), true);
});
