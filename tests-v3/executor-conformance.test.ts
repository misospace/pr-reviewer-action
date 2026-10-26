/** Shared executor conformance suite (#733): the SAME scenario set run
 * over the real LocalExecutor (via the fixture worker, end to end) and
 * over a scripted in-process fake Executor — proving the suite is
 * reusable by a non-local executor without spawning processes, and that
 * both implementations satisfy identical rails. */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  defaultConformanceRequest,
  executorConformanceTests,
  type ConformanceScenario,
  type ConformanceTest,
} from "../src/executor/index.js";
import { LocalExecutor } from "../src/executor/index.js";
import type {
  ExecutionHandle,
  ExecutionReconcileOutcome,
  ExecutionRequest,
  ExecutionResult,
  Executor,
} from "../src/executor/index.js";

const WORKER = path.resolve(__dirname, "..", "..", "tests-v3", "fixtures", "executor-worker.mjs");
const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";

let runSeq = 0;

interface Fixture {
  readonly request: ExecutionRequest;
  readonly root: string;
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "executor-conformance-"));
  const runDir = path.join(root, "run");
  const request: ExecutionRequest = Object.freeze({
    jobId: "job-1",
    runId: `run-${++runSeq}`,
    attempt: 1,
    kind: "review",
    platform: "github",
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
    credentials: Object.freeze([]),
    runDir,
    requestPath: path.join(runDir, "request.json"),
    resultPath: path.join(runDir, "result.json"),
    ...overrides,
  });
  return { request, root };
}

/** Register a suite's definitions under one executor name; `cleanup`
 * runs after every scenario (the test file owns filesystem/temp-state
 * lifecycle — the suite stays a pure library). */
function register(suiteName: string, tests: readonly ConformanceTest[], cleanup: () => void): void {
  for (const t of tests) {
    test(`${suiteName}: ${t.name}`, async () => {
      try {
        await t.run();
      } finally {
        cleanup();
      }
    });
  }
}

// ── the real LocalExecutor, via the fixture worker ──────────────────────

const WORKER_SCENARIO: Record<ConformanceScenario, string> = {
  "happy-path": "ok",
  "duplicate-collect": "ok",
  "cancel-before-settle": "sleep-long",
  "deadline": "sleep-long",
  "past-deadline": "ok",
  "worker-crash": "crash",
  "no-result": "silent",
  "stale-result": "wrong-run",
  "reconcile-unknown": "ok",
  "reconcile-running": "sleep-long",
  "reconcile-terminal": "ok",
};

let activeRoots: string[] = [];

const localTests = executorConformanceTests(
  () => {
    throw new Error("the local suite binds an executor per scenario");
  },
  {
    requestOf: (scenario: ConformanceScenario): ExecutionRequest => {
      const fixture = makeRequest({
        deadlineAtMs: scenario === "deadline"
          ? Date.now() + 500
          : scenario === "past-deadline" ? Date.now() - 1_000 : 0,
      });
      activeRoots.push(fixture.root);
      return fixture.request;
    },
    executorFor: (scenario: ConformanceScenario) =>
      new LocalExecutor(
        {
          command: process.execPath,
          args: [WORKER, WORKER_SCENARIO[scenario]],
        },
        // The reconcile-running scenario pins the live-pid branch
        // deterministically: the probe always says alive.
        scenario === "reconcile-running" ? { pidAlive: () => true } : {},
      ),
  },
);

register("local executor", localTests, () => {
  for (const root of activeRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── a scripted fake Executor (no processes) ─────────────────────────────

type ScriptedOutcome =
  | { readonly kind: "completed" }
  | { readonly kind: "running" }
  | {
      readonly kind: "failed";
      readonly failureCategory: "deadline" | "worker_crash" | "no_result" | "stale_result";
    };

const FAKE_OUTCOME: Record<ConformanceScenario, ScriptedOutcome> = {
  "happy-path": { kind: "completed" },
  "duplicate-collect": { kind: "completed" },
  "cancel-before-settle": { kind: "completed" },
  "deadline": { kind: "failed", failureCategory: "deadline" },
  "past-deadline": { kind: "failed", failureCategory: "deadline" },
  "worker-crash": { kind: "failed", failureCategory: "worker_crash" },
  "no-result": { kind: "failed", failureCategory: "no_result" },
  "stale-result": { kind: "failed", failureCategory: "stale_result" },
  "reconcile-unknown": { kind: "completed" },
  "reconcile-running": { kind: "running" },
  "reconcile-terminal": { kind: "completed" },
};

/** A fake whose handles are driven by the scenario the request was built
 * for: no processes, no filesystem. Cancellation is honored by the
 * handle (a cancelled run settles cancelled whatever the script said),
 * the first collected result is cached (first-terminal-wins), and
 * `reconcile` reports only executions this instance actually started —
 * alive-but-unsettled as `running`, settled as `settled`, never started
 * as `none`. */
class ScriptedExecutor implements Executor {
  private readonly outcomes = new Map<string, ScriptedOutcome>();
  private readonly started = new Set<string>();
  private readonly settled = new Map<string, ExecutionResult>();

  script(scenario: ConformanceScenario, request: ExecutionRequest): void {
    this.outcomes.set(request.runId, FAKE_OUTCOME[scenario]);
  }

  forgetAll(): void {
    this.outcomes.clear();
    this.started.clear();
    this.settled.clear();
  }

  async start(request: ExecutionRequest, _signal: AbortSignal): Promise<ExecutionHandle> {
    // Same fail-closed refusal the contract requires: an already-expired
    // deadline never launches and never reconciles as ours.
    if (request.deadlineAtMs !== 0 && request.deadlineAtMs <= Date.now()) {
      const refused: ExecutionResult = Object.freeze({
        status: "failed" as const,
        runId: request.runId,
        jobId: request.jobId,
        resultHeadSha: "",
        failureCategory: "deadline" as const,
        failureMessage: "the execution deadline already passed before the worker was launched",
        resultArtifactPath: "",
        diagnostics: "scripted refusal",
        artifactPaths: Object.freeze([]),
        resourceMs: 0,
        observedAtMs: 0,
      });
      return {
        observe: async () => Object.freeze({
          phase: "terminal" as const,
          status: refused.status,
          observedAtMs: refused.observedAtMs,
        }),
        cancel: async () => {},
        collect: async () => refused,
      };
    }
    const outcome = this.outcomes.get(request.runId);
    if (outcome === undefined) {
      throw new Error(`no scripted outcome for run ${request.runId}`);
    }
    this.started.add(request.runId);
    let cancelled = false;
    let cached: ExecutionResult | null = null;
    const build = (): ExecutionResult => {
      if (cancelled || outcome.kind === "running") {
        return Object.freeze({
          status: "cancelled" as const,
          runId: request.runId,
          jobId: request.jobId,
          resultHeadSha: "",
          failureCategory: "" as const,
          failureMessage: "",
          resultArtifactPath: "",
          diagnostics: "scripted cancellation",
          artifactPaths: Object.freeze([]),
          resourceMs: 0,
          observedAtMs: 0,
        });
      }
      if (outcome.kind === "completed") {
        return Object.freeze({
          status: "completed" as const,
          runId: request.runId,
          jobId: request.jobId,
          resultHeadSha: request.headSha,
          failureCategory: "" as const,
          failureMessage: "",
          resultArtifactPath: request.resultPath,
          diagnostics: "scripted completion",
          artifactPaths: Object.freeze([]),
          resourceMs: 1,
          observedAtMs: 0,
        });
      }
      return Object.freeze({
        status: "failed" as const,
        runId: request.runId,
        jobId: request.jobId,
        resultHeadSha: "",
        failureCategory: outcome.failureCategory,
        failureMessage: `scripted ${outcome.failureCategory}`,
        resultArtifactPath: "",
        diagnostics: "scripted failure",
        artifactPaths: Object.freeze([]),
        resourceMs: 1,
        observedAtMs: 0,
      });
    };
    return {
      observe: async () =>
        cached === null
          ? Object.freeze({ phase: "running" as const, status: "" as const, observedAtMs: 0 })
          : Object.freeze({
              phase: "terminal" as const,
              status: cached.status,
              observedAtMs: cached.observedAtMs,
            }),
      cancel: async () => {
        cancelled = true;
      },
      collect: async () => {
        if (cached === null) {
          cached = build();
          this.settled.set(request.runId, cached);
        }
        return cached;
      },
    };
  }

  async reconcile(request: ExecutionRequest): Promise<ExecutionReconcileOutcome> {
    const settled = this.settled.get(request.runId);
    if (settled !== undefined) {
      return Object.freeze({ kind: "settled" as const, result: settled });
    }
    return this.started.has(request.runId)
      ? Object.freeze({ kind: "running" as const })
      : Object.freeze({ kind: "none" as const });
  }
}

const fake = new ScriptedExecutor();

const fakeTests = executorConformanceTests(() => fake, {
  requestOf: (scenario: ConformanceScenario): ExecutionRequest => {
    const base = defaultConformanceRequest(scenario);
    const request = scenario === "past-deadline"
      ? Object.freeze({ ...base, deadlineAtMs: Date.now() - 1_000 })
      : base;
    fake.script(scenario, request);
    return request;
  },
});

register("scripted executor", fakeTests, () => fake.forgetAll());

// ── reuse proof ─────────────────────────────────────────────────────────

test("both executors are held to the identical scenario set", () => {
  const localNames = localTests.map((t) => t.name);
  const fakeNames = fakeTests.map((t) => t.name);
  assert.ok(localNames.length >= 11, "the suite stays bounded but complete");
  assert.deepEqual(localNames, fakeNames);
});
