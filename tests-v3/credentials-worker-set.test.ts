import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerCredentialPlan,
  createResultChannelAuth,
  createSecretRedactor,
  InMemorySecretVault,
  resolveWorkerCredentials,
  validateCredentialPlan,
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

function input(overrides: Partial<WorkerCredentialPlanInput> = {}): WorkerCredentialPlanInput {
  return {
    jobId: JOB,
    runId: RUN,
    platform: "github",
    repoFullName: "owner/repo-a",
    installationId: "1001",
    fork: false,
    modelMode: "direct_worker",
    modelCredentialRef: MODEL_A,
    evidenceCredentialRef: EVIDENCE,
    forgeCloneCredentialRef: FORGE_CLONE,
    forgePublishCredentialRef: FORGE_PUBLISH,
    resultChannel: true,
    allowForkEvidence: false,
    ...overrides,
  };
}

function vaultWithSecrets(): { vault: InMemorySecretVault; secrets: string[] } {
  const secrets = [
    "ghs_clonesecretvalue0000001",
    "ghs_publishsecretvalue00001",
    "sk_modelasecretvalue00000001",
    "sk_evidencesecretvalue000001",
  ] as const;
  const entries: VaultEntry[] = [
    {
      reference: FORGE_CLONE,
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo-a",
        purpose: "forge_clone",
      },
      material: { value: secrets[0] as string, expiresAtMs: 0 },
    },
    {
      reference: FORGE_PUBLISH,
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo-a",
        purpose: "forge_publish",
      },
      material: { value: secrets[1] as string, expiresAtMs: 0 },
    },
    {
      // Model credentials are NOT repo/installation-scoped: they belong to
      // the operator's model profile, not to one repository.
      reference: MODEL_A,
      scope: { platform: "", installationId: "", repoFullName: "", purpose: "model" },
      material: { value: secrets[2] as string, expiresAtMs: 0 },
    },
    {
      reference: EVIDENCE,
      scope: { platform: "", installationId: "", repoFullName: "", purpose: "evidence" },
      material: { value: secrets[3] as string, expiresAtMs: 0 },
    },
  ];
  return { vault: new InMemorySecretVault(entries), secrets: [...secrets] };
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
  const planB = buildWorkerCredentialPlan(input({ modelCredentialRef: MODEL_B }));
  const modelA = planA.credentials.filter((c) => c.name === "model");
  const modelB = planB.credentials.filter((c) => c.name === "model");
  assert.equal(modelA.length, 1);
  assert.equal(modelB.length, 1);
  assert.equal(modelA[0]?.reference, MODEL_A);
  assert.equal(modelB[0]?.reference, MODEL_B);
  // Profile A's credential cannot appear anywhere in profile B's plan.
  assert.equal(JSON.stringify(planB).includes(MODEL_A), false);
});

test("worker-set: fork policy — evidence reference omitted unless explicitly allowed", () => {
  const forked = buildWorkerCredentialPlan(input({ fork: true }));
  assert.equal(forked.fork, true);
  assert.equal(forked.credentials.some((c) => c.name === "evidence"), false);

  const permitted = buildWorkerCredentialPlan(input({ fork: true, allowForkEvidence: true }));
  assert.equal(permitted.credentials.some((c) => c.name === "evidence" && c.reference === EVIDENCE), true);

  // Non-fork runs are unaffected by the flag's absence.
  const plain = buildWorkerCredentialPlan(input({ allowForkEvidence: false }));
  assert.equal(plain.credentials.some((c) => c.name === "evidence"), true);
});

test("worker-set: empty references produce no entry (sentinel discipline)", () => {
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
});

test("worker-set: builder fails closed on malformed references and unknown model mode", () => {
  assert.throws(() => buildWorkerCredentialPlan(input({ modelCredentialRef: "bad ref!" })), /grammar/);
  assert.throws(
    () => buildWorkerCredentialPlan(input({ modelMode: "gateway" as never })),
    /unknown model mode/,
  );
  assert.throws(() => buildWorkerCredentialPlan(input({ runId: "" })), /runId/);
});

test("worker-set: resolveWorkerCredentials hands back exactly the plan's material, all-or-nothing", async () => {
  const { vault, secrets } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  const set = await resolveWorkerCredentials(vault, plan, {
    resultChannel: createResultChannelAuth({ key: "controller-signing-key-0123456789" }),
  });
  assert.equal(set.ok, true);
  if (set.ok) {
    assert.deepEqual(
      set.entries.map((e) => e.name),
      ["forge-clone", "forge-publish", "model", "evidence", "result-channel"],
    );
    // The result-channel token is minted per run, not stored: it verifies
    // for exactly this (run, job) pair and no other.
    const resultChannel = set.entries.find((e) => e.name === "result-channel");
    assert.equal(resultChannel?.material.value.startsWith("v1."), true);
    assert.deepEqual(
      set.entries
        .filter((e) => e.name !== "result-channel")
        .map((e) => e.material.value)
        .sort(),
      [...secrets].sort(),
    );
  }
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
  const result = await resolveWorkerCredentials(vault, plan);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.name, "forge-publish");
    assert.equal(result.code, "revoked");
  }
});

test("worker-set: cross-scope model credential cannot be resolved into another repo's set", async () => {
  // A repo-scoped model credential is refused for a different repository —
  // credentials for model profile A cannot leak into jobs using profile B
  // OR into other repositories' jobs.
  const repoScopedModel = new InMemorySecretVault([
    {
      reference: FORGE_CLONE,
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo-b",
        purpose: "forge_clone",
      },
      material: { value: "ghs_clonesecretvalue0000001", expiresAtMs: 0 },
    },
    {
      reference: FORGE_PUBLISH,
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo-b",
        purpose: "forge_publish",
      },
      material: { value: "ghs_publishsecretvalue00001", expiresAtMs: 0 },
    },
    {
      reference: MODEL_A,
      scope: {
        platform: "github",
        installationId: "1001",
        repoFullName: "owner/repo-a",
        purpose: "model",
      },
      material: { value: "sk_modelasecretvalue00000001", expiresAtMs: 0 },
    },
  ]);
  const plan = buildWorkerCredentialPlan(input({ repoFullName: "owner/repo-b" }));
  const result = await resolveWorkerCredentials(repoScopedModel, plan);
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

test("worker-set: resolved material redacts from logs and artifacts", async () => {
  const { vault, secrets } = vaultWithSecrets();
  const plan = buildWorkerCredentialPlan(input());
  const set = await resolveWorkerCredentials(vault, plan, {
    resultChannel: createResultChannelAuth({ key: "controller-signing-key-0123456789" }),
  });
  if (!set.ok) {
    assert.fail(`handoff refused: ${set.code} ${set.reason}`);
    return;
  }
  const logLine = `POST /v1/chat/completions auth=Bearer ${secrets[2] as string} status=200`;
  assert.equal(set.redactor.redact(logLine).includes(secrets[2] as string), false);
  assert.equal(set.redactor.redact(logLine).includes("[REDACTED]"), true);
  const artifact = { endpoint: "https://api.example.test", headers: { authorization: secrets[0] } };
  const scrubbed = set.redactor.redactJson(artifact);
  for (const secret of secrets) {
    assert.equal(scrubbed.includes(secret), false);
  }
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

test("redactor: fails closed on too-short values, tolerates duplicates and empties", () => {
  assert.throws(() => createSecretRedactor(["short"]), /at least 8/);
  const redactor = createSecretRedactor(["", "", "supersecretvalue1", "supersecretvalue1"]);
  assert.equal(redactor.redact("has supersecretvalue1 inside"), "has [REDACTED] inside");
  assert.equal(redactor.redact("nothing to see"), "nothing to see");
});

test("worker-set: validateCredentialPlan rejects unknown fields and duplicate names", () => {
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
  // The validator returns a frozen deep copy, not the caller's object.
  const validated = validateCredentialPlan(plan);
  assert.notEqual(validated, plan);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.credentials), true);
  assert.equal(Object.isFrozen(validated.credentials[0]), true);
});
