/** The production worker entrypoint (#733 worker-image contract, #738
 * Phase A1): envelope resolution (final argv element vs the coordination
 * env var), fail-closed envelope parsing/validation (no result file on an
 * unreadable or invalid envelope), the result-file protocol (a valid,
 * executor-contract-conforming result is written for every terminal
 * outcome), and the cancellation/deadline semantics agreed with the local
 * executor's classification, and the #1496 model-selection mapping
 * (envelope coordinates → engine inputs, #735 projected credential →
 * optional `ai-api-key` input that never reaches the result file). The
 * review runner is injected — the worker must not need model calls to be
 * testable. */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  EXECUTION_REQUEST_ENV_KEY,
  validateExecutionResult,
  type ExecutionRequest,
  type ExecutionResult,
} from "../src/executor/index.js";
import { executionCredentialEnvName } from "../src/executor/types.js";
import { workerMain } from "../src/executor/worker-main.js";
import type { WorkerEngineOutcome } from "../src/executor/worker-main.js";
import type { ReviewDependencies, ReviewRequest } from "../src/engine/types.js";

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";

// ── in-file harness ─────────────────────────────────────────────────────

let runSeq = 0;

interface Fixture {
  readonly request: ExecutionRequest;
  readonly root: string;
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "worker-main-"));
  const runDir = path.join(root, "run");
  mkdirSync(runDir, { recursive: true });
  const request: ExecutionRequest = Object.freeze({
    jobId: "job-1",
    runId: `run-${++runSeq}`,
    attempt: 1,
    kind: "review",
    platform: "github",
    forgeApiUrl: "https://api.github.com",
    repoFullName: "owner/repo",
    prNumber: 7,
    headSha: HEAD,
    baseSha: BASE,
    deadlineAtMs: 0,
    workspace: Object.freeze({
      rootPath: root,
      headSha: HEAD,
      mergeBaseSha: BASE,
      platform: "github",
      repoFullName: "owner/repo",
      createdAtMs: 0,
    }),
    profiles: Object.freeze({ executor: "local-dev", model: "fast", evidence: "default" }),
    modelSelection: Object.freeze({
      baseUrl: "https://model.example/v1",
      modelId: "test-model-42",
      apiFormat: "openai" as const,
    }),
    credentials: Object.freeze([]) as readonly { name: string; reference: string }[],
    runDir,
    requestPath: path.join(runDir, "request.json"),
    resultPath: path.join(runDir, "result.json"),
    ...overrides,
  });
  writeFileSync(request.requestPath, JSON.stringify(request), "utf8");
  return { request, root };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

/** The fake review runner the tests inject: it records the request and
 * dependencies it was handed and resolves with the given outcome (or
 * rejects with the given error) — no model calls. */
interface FakeRun {
  requests: ReviewRequest[];
  dependencies: ReviewDependencies[];
}

function fakeRunner(
  behavior: (request: ReviewRequest, dependencies: ReviewDependencies) => Promise<WorkerEngineOutcome>,
): { run: FakeRun; deps: { runReview: (request: ReviewRequest, dependencies: ReviewDependencies) => Promise<WorkerEngineOutcome> } } {
  const run: FakeRun = { requests: [], dependencies: [] };
  return {
    run,
    deps: {
      runReview: async (request: ReviewRequest, dependencies: ReviewDependencies): Promise<WorkerEngineOutcome> => {
        run.requests.push(request);
        run.dependencies.push(dependencies);
        return await behavior(request, dependencies);
      },
    },
  };
}

function readResult(request: ExecutionRequest): unknown {
  return JSON.parse(readFileSync(request.resultPath, "utf8"));
}

function assertConformingResult(
  request: ExecutionRequest,
  expected: Partial<ExecutionResult>,
): ExecutionResult {
  const parsed: unknown = readResult(request);
  const result = validateExecutionResult(parsed, { runDir: request.runDir });
  assert.equal(result.runId, request.runId);
  assert.equal(result.jobId, request.jobId);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual((result as unknown as Record<string, unknown>)[key], value);
  }
  return result;
}

// ── happy path ──────────────────────────────────────────────────────────

test("a completed run writes a contract-conforming result naming the publication artifact", async () => {
  const fixture = makeRequest();
  try {
    const { run, deps } = fakeRunner(async (_request, dependencies) => {
      // The real engine persists its run artifacts (ai-output.json among
      // them) into the run directory it was handed; the fake mirrors that
      // so the completion check sees a real engine run's shape.
      writeFileSync(path.join(dependencies.runDir, "ai-output.json"), "{}", "utf8");
      return { reviewedHeadSha: HEAD };
    });
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    // The fake engine ran against the mapped engine request.
    assert.equal(run.requests.length, 1);
    assert.equal(run.requests[0]?.repository, "owner/repo");
    assert.equal(run.requests[0]?.prNumber, "7");
    assert.equal(run.requests[0]?.headSha, HEAD);
    assert.equal(run.requests[0]?.baseRef, BASE);
    assert.equal(run.requests[0]?.platform, "github");
    assert.equal(run.dependencies[0]?.workspace, fixture.root);
    assert.equal(run.dependencies[0]?.runDir, fixture.request.runDir);
    // The result names the publication artifact the engine persisted.
    const result = assertConformingResult(fixture.request, {
      status: "completed",
      resultHeadSha: HEAD,
      failureCategory: "",
      failureMessage: "",
      resultArtifactPath: path.join(fixture.request.runDir, "ai-output.json"),
    });
    assert.ok(existsSync(result.resultArtifactPath));
    assert.ok(result.resourceMs >= 0);
  } finally {
    cleanup(fixture);
  }
});

test("the envelope's forge API base URL reaches the engine request verbatim (#1433)", async () => {
  const cases: readonly { readonly platform: "github" | "forgejo"; readonly forgeApiUrl: string }[] = [
    { platform: "github", forgeApiUrl: "https://ghe.example/api/v3" },
    // "" means "engine default" and must NOT be replaced by a `??`-style
    // fallback: the engine's own admission applies the platform default.
    { platform: "github", forgeApiUrl: "" },
    { platform: "forgejo", forgeApiUrl: "https://forge.example" },
  ];
  for (const testCase of cases) {
    const fixture = makeRequest({ platform: testCase.platform, forgeApiUrl: testCase.forgeApiUrl });
    try {
      const { run, deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
      writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
      assert.equal(await workerMain([fixture.request.requestPath], {}, deps), 0);
      assert.equal(run.requests.length, 1);
      assert.equal(run.requests[0]?.platform, testCase.platform);
      assert.equal(run.requests[0]?.forgejoApiUrl, testCase.forgeApiUrl);
    } finally {
      cleanup(fixture);
    }
  }
});

test("the envelope path resolves from the FINAL argv element, even with operator args", async () => {
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
    writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
    const exit = await workerMain(["--verbose", "nonsense", fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, { status: "completed" });
  } finally {
    cleanup(fixture);
  }
});

test("a bare envelope as argv[0] (zero operator args) is the final element too", async () => {
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
    writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, { status: "completed" });
  } finally {
    cleanup(fixture);
  }
});

test("the coordination env var is the fallback when argv carries no envelope path", async () => {
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
    writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
    const exit = await workerMain([], { [EXECUTION_REQUEST_ENV_KEY]: fixture.request.requestPath }, deps);
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, { status: "completed" });
  } finally {
    cleanup(fixture);
  }
});

test("argv wins over the env var when both name an envelope", async () => {
  const other = makeRequest();
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
    writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
    const exit = await workerMain(
      [fixture.request.requestPath],
      { [EXECUTION_REQUEST_ENV_KEY]: other.request.requestPath },
      deps,
    );
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, { status: "completed" });
    assert.equal(existsSync(other.request.resultPath), false);
  } finally {
    cleanup(other);
    cleanup(fixture);
  }
});

test("the engine's verified reviewed head is the result head when the envelope pins none", async () => {
  const fixture = makeRequest({ headSha: "" });
  try {
    const { deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
    writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, { status: "completed", resultHeadSha: HEAD });
  } finally {
    cleanup(fixture);
  }
});

// ── model selection (#1496) ─────────────────────────────────────────────

test("the envelope's model selection reaches the engine inputs verbatim (#1496)", async () => {
  const fixture = makeRequest();
  try {
    const { run, deps } = fakeRunner(async (_request, dependencies) => {
      writeFileSync(path.join(dependencies.runDir, "ai-output.json"), "{}", "utf8");
      return { reviewedHeadSha: HEAD };
    });
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    assert.equal(run.requests.length, 1);
    const inputs = run.requests[0]?.inputs ?? {};
    assert.equal(inputs["ai-base-url"], fixture.request.modelSelection.baseUrl);
    assert.equal(inputs["ai-model"], fixture.request.modelSelection.modelId);
    assert.equal(inputs["ai-api-format"], fixture.request.modelSelection.apiFormat);
  } finally {
    cleanup(fixture);
  }
});

test("the projected model credential becomes the ai-api-key input and never lands in the result (#735/#1496)", async () => {
  const fixture = makeRequest();
  const secret = "sk-test-material";
  try {
    const { run, deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
    writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
    const exit = await workerMain(
      [fixture.request.requestPath],
      { [executionCredentialEnvName("model")]: secret },
      deps,
    );
    assert.equal(exit, 0);
    // The #735 projected material arrives under the shared derivation and
    // becomes the engine's optional credential input.
    assert.equal(run.requests[0]?.inputs["ai-api-key"], secret);
    // The secret must appear NOWHERE in the written result file: the
    // diagnostics tail (fed by the worker's log/error sinks) is the leak
    // vector, and the result file is the only file the worker writes.
    const resultText = readFileSync(fixture.request.resultPath, "utf8");
    assert.equal(resultText.includes(secret), false);
  } finally {
    cleanup(fixture);
  }
});

test("absent or empty projected credential material leaves no ai-api-key input (#735/#1496)", async () => {
  for (const envCase of [
    {} as NodeJS.ProcessEnv,
    { [executionCredentialEnvName("model")]: "" } as NodeJS.ProcessEnv,
  ]) {
    const fixture = makeRequest();
    try {
      const { run, deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
      writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
      // A self-hosted endpoint can be unauthenticated: the input is absent
      // entirely, never an empty-string key.
      assert.equal(await workerMain([fixture.request.requestPath], envCase, deps), 0);
      assert.equal(Object.prototype.hasOwnProperty.call(run.requests[0]?.inputs ?? {}, "ai-api-key"), false);
    } finally {
      cleanup(fixture);
    }
  }
});

// ── forge-read ambient credential (#1484) ───────────────────────────────

test("the projected forge-publish material rides the engine ambient under the platform-correct keys and nothing else (#735/#1484)", async () => {
  const secret = "gh-test-forge-read-material";
  const cases: readonly {
    readonly platform: "github" | "forgejo";
    readonly expected: Record<string, string>;
  }[] = [
    { platform: "github", expected: { GH_TOKEN: secret, GITHUB_TOKEN: secret } },
    { platform: "forgejo", expected: { FORGEJO_TOKEN: secret } },
  ];
  for (const testCase of cases) {
    const fixture = makeRequest({ platform: testCase.platform });
    try {
      const { run, deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
      writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
      const exit = await workerMain(
        [fixture.request.requestPath],
        { [executionCredentialEnvName("forge-publish")]: secret },
        deps,
      );
      assert.equal(exit, 0);
      assert.equal(run.requests.length, 1);
      // Exactly the platform-correct admission-resolvable keys — the
      // ambient object carries nothing else.
      assert.deepEqual({ ...run.requests[0]?.ambient }, testCase.expected);
      // The engine inputs stay credential-free for forge material: it
      // travels the ambient environment, never the inputs object.
      assert.equal(Object.prototype.hasOwnProperty.call(run.requests[0]?.inputs ?? {}, "ai-api-key"), false);
      // The material never reaches the result file (diagnostics tail
      // included): the ambient object is in-process only.
      const resultText = readFileSync(fixture.request.resultPath, "utf8");
      assert.equal(resultText.includes(secret), false);
    } finally {
      cleanup(fixture);
    }
  }
});

test("absent forge-publish material leaves the engine ambient empty (#735/#1484)", async () => {
  for (const envCase of [
    {} as NodeJS.ProcessEnv,
    { [executionCredentialEnvName("forge-publish")]: "" } as NodeJS.ProcessEnv,
  ]) {
    for (const platform of ["github", "forgejo"] as const) {
      const fixture = makeRequest({ platform });
      try {
        const { run, deps } = fakeRunner(async () => ({ reviewedHeadSha: HEAD }));
        writeFileSync(path.join(fixture.request.runDir, "ai-output.json"), "{}", "utf8");
        assert.equal(await workerMain([fixture.request.requestPath], envCase, deps), 0);
        assert.deepEqual({ ...run.requests[0]?.ambient }, {});
      } finally {
        cleanup(fixture);
      }
    }
  }
});

// ── fail-closed envelope handling ───────────────────────────────────────

test("a missing envelope path exits non-zero without writing a result", async () => {
  const fixture = makeRequest();
  try {
    const exit = await workerMain([], {});
    assert.equal(exit === 0, false);
    assert.equal(existsSync(fixture.request.resultPath), false);
  } finally {
    cleanup(fixture);
  }
});

test("an unreadable envelope exits non-zero without writing a result", async () => {
  const fixture = makeRequest();
  try {
    const exit = await workerMain([path.join(fixture.request.runDir, "absent.json")], {});
    assert.equal(exit === 0, false);
    assert.equal(existsSync(fixture.request.resultPath), false);
  } finally {
    cleanup(fixture);
  }
});

test("a non-JSON envelope exits non-zero without writing a result", async () => {
  const fixture = makeRequest();
  try {
    writeFileSync(fixture.request.requestPath, "{not json", "utf8");
    const exit = await workerMain([fixture.request.requestPath], {});
    assert.equal(exit === 0, false);
    assert.equal(existsSync(fixture.request.resultPath), false);
  } finally {
    cleanup(fixture);
  }
});

test("a structurally invalid envelope exits non-zero and writes no result file", async () => {
  const fixture = makeRequest();
  try {
    // A plausible-looking envelope that fails the request contract: the
    // result path it names must NEVER be written (there is nothing to
    // correlate), even though the path itself is well-formed.
    writeFileSync(
      fixture.request.requestPath,
      JSON.stringify({ ...fixture.request, jobId: "" }),
      "utf8",
    );
    const exit = await workerMain([fixture.request.requestPath], {});
    assert.equal(exit === 0, false);
    assert.equal(existsSync(fixture.request.resultPath), false);
  } finally {
    cleanup(fixture);
  }
});

// ── cancellation ────────────────────────────────────────────────────────

test("SIGTERM mid-run aborts the engine and settles a cancelled result", async () => {
  const fixture = makeRequest();
  try {
    let release: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = fakeRunner(async (request): Promise<WorkerEngineOutcome> => {
      // Mirror the real engine: the runner observes the request's
      // cancellation signal and abandons the run when it aborts.
      release?.();
      await new Promise<void>((_resolve, reject) => {
        if (request.signal?.aborted === true) {
          reject(new Error("review request cancelled"));
          return;
        }
        request.signal?.addEventListener("abort", () => reject(new Error("review request cancelled")), {
          once: true,
        });
      });
      return { reviewedHeadSha: HEAD };
    });
    const pending = workerMain([fixture.request.requestPath], {}, deps);
    await started;
    process.emit("SIGTERM", "SIGTERM");
    const exit = await pending;
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, {
      status: "cancelled",
      resultHeadSha: "",
      failureCategory: "",
      failureMessage: "",
      resultArtifactPath: "",
    });
    const result = validateExecutionResult(readResult(fixture.request), { runDir: fixture.request.runDir });
    assert.match(result.diagnostics, /SIGTERM/);
  } finally {
    cleanup(fixture);
  }
});

// ── deadline ────────────────────────────────────────────────────────────

test("an engine still running at the deadline settles a deadline failure", async () => {
  const fixture = makeRequest({
    deadlineAtMs: Date.now() + 100,
  });
  try {
    const { deps } = fakeRunner(async (request): Promise<WorkerEngineOutcome> => {
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("review request cancelled")), {
          once: true,
        });
      });
      return { reviewedHeadSha: HEAD };
    });
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    assertConformingResult(fixture.request, {
      status: "failed",
      resultHeadSha: "",
      failureCategory: "deadline",
      resultArtifactPath: "",
    });
  } finally {
    cleanup(fixture);
  }
});

test("a deadline that already expired never runs the engine", async () => {
  const fixture = makeRequest({ deadlineAtMs: Date.now() - 1_000 });
  try {
    const { run, deps } = fakeRunner(async (): Promise<WorkerEngineOutcome> => ({ reviewedHeadSha: HEAD }));
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    assert.equal(run.requests.length, 0);
    assertConformingResult(fixture.request, {
      status: "failed",
      failureCategory: "deadline",
    });
  } finally {
    cleanup(fixture);
  }
});

// ── engine failure ──────────────────────────────────────────────────────

test("an engine failure settles a bounded worker_error result", async () => {
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async (): Promise<WorkerEngineOutcome> => {
      throw new Error("the model endpoint refused the request");
    });
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    const result = assertConformingResult(fixture.request, {
      status: "failed",
      resultHeadSha: "",
      failureCategory: "worker_error",
      resultArtifactPath: "",
    });
    assert.match(result.failureMessage, /model endpoint refused/);
    assert.ok(result.failureMessage.length <= 2_000);
  } finally {
    cleanup(fixture);
  }
});

// ── publication artifact discipline ─────────────────────────────────────

test("a completed engine run without the publication artifact is a worker_error, never a completed result", async () => {
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async (): Promise<WorkerEngineOutcome> => ({ reviewedHeadSha: HEAD }));
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    const result = assertConformingResult(fixture.request, {
      status: "failed",
      failureCategory: "worker_error",
      resultArtifactPath: "",
    });
    assert.match(result.failureMessage, /ai-output\.json/);
  } finally {
    cleanup(fixture);
  }
});

test("an engine that reports no verified head settles a worker_error, never a completed result at the envelope's head (#1500)", async () => {
  const fixture = makeRequest();
  try {
    const { deps } = fakeRunner(async (_request, dependencies) => {
      // The fake mirrors a contract-violating engine: it leaves the
      // publication artifact on disk (so the artifact check passes and the
      // completion path is reached) but names no verified reviewed head.
      writeFileSync(path.join(dependencies.runDir, "ai-output.json"), "{}", "utf8");
      return { reviewedHeadSha: "" };
    });
    const exit = await workerMain([fixture.request.requestPath], {}, deps);
    assert.equal(exit, 0);
    // The result file is the only thing writeFileNoFollow ever writes, and
    // its settled shape is a failed worker_error with no head: no completed
    // result — least of one carrying the envelope's head pin the engine
    // never verified — can reach the result protocol.
    const result = assertConformingResult(fixture.request, {
      status: "failed",
      resultHeadSha: "",
      failureCategory: "worker_error",
      resultArtifactPath: "",
    });
    assert.equal(result.resultHeadSha, "");
    assert.match(result.failureMessage, /resultHeadSha/);
  } finally {
    cleanup(fixture);
  }
});
