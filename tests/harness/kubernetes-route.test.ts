/** End-to-end test of the route-D driver (#1484).
 *
 * The driver (tests/harness/kubernetes-route.ts) is the harness's own
 * cluster double around the SHIPPED Kubernetes executor: it injects the
 * executor's API and credential-store seams and lets the manifest
 * building, envelope write, credential projection, job polling and
 * result collection run unmodified. The self-hosted qualification
 * harness runs the compiled driver against a REAL container runtime;
 * this test runs the SAME driver against a FAKE container runtime, so
 * the driver's end-to-end path and its refusal paths are covered by the
 * authoritative suite instead of by a structural gate alone.
 *
 * The fake stands in ONLY for the container runtime: a temporary
 * `docker` executable on the child process's PATH receives the
 * executor's manifest as an argv, writes the worker's result artifact
 * and exits. Everything else — the executor, the driver's doubles, the
 * result contract — is the shipped code.
 *
 * Hermetic: no network, no docker daemon, no git checkout, no model
 * call. Every artifact lives in a temporary directory the test removes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

/** The compiled driver, next to this compiled test: the same artifact the
 * qualification harness runs. */
const DRIVER_PATH = path.join(__dirname, "kubernetes-route.js");

const HEAD = "aa11bb22cc33dd44ee55ff667788990001122334";
const BASE = "dd44ee55ff66aa77bb88cc99001122334455667788";
const IMAGE = "ghcr.io/acme/pr-reviewer-worker:1.2.3";
const MATERIAL = "parity-stub-model-material";
const CLAIM = "pr-reviewer-parity";

/** The fake container runtime: it stands in for `docker` only. It reads
 * the executor's manifest out of its own argv, records the invocation,
 * and — in the succeeding mode — writes the worker's result artifact
 * exactly as the worker-image contract pins it. */
const FAKE_DOCKER_SOURCE = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const assignments = new Map();
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] !== "-e") continue;
  const spec = argv[index + 1] || "";
  index += 1;
  const split = spec.indexOf("=");
  if (split >= 0) assignments.set(spec.slice(0, split), spec.slice(split + 1));
}
const requestPath = assignments.get("PR_REVIEWER_EXECUTION_REQUEST") || "";
const resultPath = assignments.get("PR_REVIEWER_EXECUTION_RESULT") || "";
const tmp = process.env.TMPDIR || "";
const modePath = path.join(tmp, "fake-docker-mode");
const mode = fs.existsSync(modePath) ? fs.readFileSync(modePath, "utf8").trim() : "succeed";

const credentials = {};
for (const [name, value] of Object.entries(process.env)) {
  if (name.startsWith("PR_REVIEWER_CREDENTIAL_")) credentials[name] = value;
}

fs.writeFileSync(path.join(tmp, "docker-invocation.json"), JSON.stringify({
  argv: argv,
  mode: mode,
  credentials: credentials,
  gitConfigCount: process.env.GIT_CONFIG_COUNT || "",
  gitConfigKey: process.env.GIT_CONFIG_KEY_0 || "",
  gitConfigValue: process.env.GIT_CONFIG_VALUE_0 || "",
  requestPath: requestPath,
  resultPath: resultPath,
}));

if (mode === "fail") {
  process.stderr.write("fake container: the worker exited non-zero\\n");
  process.exit(1);
}

const envelope = JSON.parse(fs.readFileSync(requestPath, "utf8"));
const artifactPath = path.join(path.dirname(resultPath), "review-artifact.json");
fs.writeFileSync(artifactPath, JSON.stringify({ verdict: "comment", headSha: envelope.headSha }));
fs.writeFileSync(resultPath, JSON.stringify({
  status: "completed",
  runId: envelope.runId,
  jobId: envelope.jobId,
  resultHeadSha: envelope.headSha,
  failureCategory: "",
  failureMessage: "",
  resultArtifactPath: artifactPath,
  diagnostics: "",
  artifactPaths: [],
  resourceMs: 5,
  observedAtMs: 1,
}));
process.exit(0);
`;

interface FakeInvocation {
  readonly argv: readonly string[];
  readonly mode: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly gitConfigCount: string;
  readonly gitConfigKey: string;
  readonly gitConfigValue: string;
  readonly requestPath: string;
  readonly resultPath: string;
}

/** The driver's one-line summary. */
interface RouteSummary {
  readonly status: string;
  readonly resultHeadSha: string;
  readonly failureCategory: string;
  readonly failureMessage: string;
  readonly artifactPath: string;
  readonly sharedClaimRelaxed: boolean;
}

interface Fixture {
  readonly root: string;
  readonly recordDir: string;
  readonly inputPath: string;
  readonly configPath: string;
  readonly runDir: string;
  readonly requestPath: string;
  readonly resultPath: string;
  readonly head: string;
  readonly material: string;
}

interface FixtureOptions {
  /** The credential names the route config holds material for. */
  readonly credentialMaterial?: Readonly<Record<string, string>>;
  /** The credential references the execution request asks for. */
  readonly credentials?: readonly { readonly name: string; readonly reference: string }[];
  /** Where the claim is mounted: the run root, or a claim of its own
   * that does not cover the run directory. */
  readonly volumeRoot?: "run-root" | "separate-claim";
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "kubernetes-route-"));
  const binDir = path.join(root, "bin");
  const recordDir = path.join(root, "records");
  const driverDir = path.join(root, "driver");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(driverDir, { recursive: true });
  mkdirSync(path.join(root, "workspace"), { recursive: true });

  // The fake container runtime: a shell wrapper that execs node on the
  // fake, so the launcher does not depend on `node` being on the PATH.
  const fakePath = path.join(binDir, "fake-docker.js");
  writeFileSync(fakePath, FAKE_DOCKER_SOURCE, "utf8");
  const launcherPath = path.join(binDir, "docker");
  writeFileSync(
    launcherPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakePath)} "$@"\n`,
    "utf8",
  );
  chmodSync(launcherPath, 0o755);

  const runId = "run-route-d";
  const runDir = path.join(root, "runs", runId);
  const requestPath = path.join(runDir, "request.json");
  const resultPath = path.join(runDir, "result.json");
  const inputPath = path.join(driverDir, "execution-request.json");
  const configPath = path.join(driverDir, "route-config.json");

  const credentials = options.credentials ?? [{ name: "model", reference: "vault:model-ref-1" }];
  writeFileSync(
    inputPath,
    JSON.stringify({
      jobId: "job-route-d",
      runId,
      attempt: 1,
      kind: "review",
      platform: "github",
      forgeApiUrl: "https://api.github.com",
      repoFullName: "owner/repo",
      prNumber: 7,
      headSha: HEAD,
      baseSha: BASE,
      deadlineAtMs: Date.now() + 600_000,
      workspace: {
        rootPath: path.join(root, "workspace"),
        headSha: HEAD,
        mergeBaseSha: BASE,
        platform: "github",
        repoFullName: "owner/repo",
        createdAtMs: 0,
      },
      profiles: { executor: "k8s-dev", model: "fast", evidence: "default" },
      modelSelection: {
        baseUrl: "https://model.example/v1",
        modelId: "test-model",
        apiFormat: "openai",
      },
      credentials,
      runDir,
      requestPath,
      resultPath,
    }),
    "utf8",
  );

  const volumeRoot = options.volumeRoot === "separate-claim"
    ? path.join(root, "claim")
    : root;
  mkdirSync(volumeRoot, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      image: IMAGE,
      args: ["worker"],
      namespace: "review-workers",
      serviceAccount: "pr-reviewer-worker",
      ttlSecondsAfterFinished: 600,
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
      volumes: [{ claim: CLAIM, controllerRoot: volumeRoot }],
      credentialMaterial: options.credentialMaterial ?? { model: MATERIAL },
    }),
    "utf8",
  );

  return {
    root,
    recordDir,
    inputPath,
    configPath,
    runDir,
    requestPath,
    resultPath,
    head: HEAD,
    material: MATERIAL,
  };
}

interface DriverRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The fake launcher's recorded invocation, or null when it never ran. */
  readonly invocation: FakeInvocation | null;
  /** The driver's one-line summary. */
  readonly summary: RouteSummary;
}

/** Run the compiled driver against the fake container runtime. */
async function runDriver(fixture: Fixture, mode: "succeed" | "fail"): Promise<DriverRun> {
  writeFileSync(path.join(fixture.recordDir, "fake-docker-mode"), mode, "utf8");
  const invocationPath = path.join(fixture.recordDir, "docker-invocation.json");
  return await new Promise<DriverRun>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [DRIVER_PATH, "--request", fixture.inputPath, "--config", fixture.configPath],
      {
        env: {
          PATH: `${path.join(fixture.root, "bin")}${path.delimiter}${process.env["PATH"] ?? ""}`,
          TMPDIR: fixture.recordDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const lines = stdout.split("\n").filter((line) => line.trim() !== "");
      if (lines.length !== 1) {
        reject(new Error(`the driver printed ${lines.length} lines on stdout: ${stdout}`));
        return;
      }
      let summary: RouteSummary;
      try {
        summary = JSON.parse(lines[0]!) as RouteSummary;
      } catch {
        reject(new Error(`the driver printed a line that is not JSON: ${lines[0]!}`));
        return;
      }
      const invocation = existsSync(invocationPath)
        ? (JSON.parse(readFileSync(invocationPath, "utf8")) as FakeInvocation)
        : null;
      resolve({ code, stdout, stderr, invocation, summary });
    });
  });
}

/** The index of the value that follows a flag, or -1. */
function flagValue(argv: readonly string[], flag: string, value: string): number {
  const index = argv.indexOf(value);
  if (index <= 0) return -1;
  return argv[index - 1] === flag ? index : -1;
}

test("the route-D driver runs the real executor end to end against a fake container runtime", async () => {
  const fixture = makeFixture();
  try {
    const run = await runDriver(fixture, "succeed");

    assert.equal(run.code, 0, `the driver must exit 0 on a completed route: ${run.stderr}`);
    assert.equal(run.summary.status, "completed", "the settled route is a completed execution");
    assert.equal(run.summary.resultHeadSha, HEAD, "the route reports the head the worker verified");
    assert.equal(run.summary.failureCategory, "", "a completed route carries no failure category");
    assert.equal(run.summary.failureMessage, "", "a completed route carries no failure message");
    assert.equal(
      run.summary.sharedClaimRelaxed,
      true,
      "the controller writes the envelope 0600 and the worker writes the result 0600, so the double stood in for the shared claim's permission model and must say so",
    );

    // The artifact the review produced: the route's output, inside the
    // run directory the executor owns.
    assert.equal(run.summary.artifactPath, path.join(fixture.runDir, "review-artifact.json"));
    assert.ok(existsSync(run.summary.artifactPath), "the review artifact exists");
    assert.ok(
      readFileSync(run.summary.artifactPath, "utf8").includes(HEAD),
      "the review artifact carries the reviewed head",
    );

    // The launcher was actually driven with the executor's manifest.
    const invocation = run.invocation;
    assert.ok(invocation !== null, "the fake container runtime was launched");
    const argv = invocation.argv;
    assert.equal(argv[0], "run");
    assert.ok(argv.includes("--rm"));
    assert.ok(argv.includes("--network"));
    assert.ok(argv.includes("host"));
    assert.ok(
      argv.includes("host.docker.internal:host-gateway"),
      "the launcher maps the host-gateway alias: the container routes reach the host through it (colima's --network host is the VM's loopback, not the host's)",
    );
    assert.ok(
      flagValue(argv, "--user", "65532:65532") >= 0,
      "the container runs as the executor's pinned non-root identity",
    );
    assert.ok(
      flagValue(argv, "-v", `${fixture.root}:${fixture.root}`) >= 0,
      "the claim is mounted at the same absolute path on both sides",
    );
    // The manifest's image and argv: the operator's image, the worker
    // argv prefix, and the envelope path as the final argument.
    assert.equal(argv[argv.length - 3], IMAGE, "the manifest's image reaches the launcher");
    assert.equal(argv[argv.length - 2], "worker", "the operator's argv prefix reaches the launcher");
    assert.equal(argv[argv.length - 1], fixture.requestPath, "the envelope path is the worker's final argument");

    // The projected credential travels through the client environment
    // only: the argv names the variable, never its value.
    assert.ok(
      flagValue(argv, "-e", "PR_REVIEWER_CREDENTIAL_MODEL") >= 0,
      "the credential variable is named on the launcher's command line",
    );
    assert.ok(
      !argv.join(" ").includes(fixture.material),
      "the credential material never rides the launcher's argv",
    );
    assert.equal(
      invocation.credentials["PR_REVIEWER_CREDENTIAL_MODEL"],
      fixture.material,
      "the projected material reaches the worker through the environment",
    );

    // The git safe.directory pin the other parity routes use.
    assert.ok(flagValue(argv, "-e", "GIT_CONFIG_COUNT") >= 0);
    assert.ok(flagValue(argv, "-e", "GIT_CONFIG_KEY_0") >= 0);
    assert.ok(flagValue(argv, "-e", "GIT_CONFIG_VALUE_0") >= 0);
    assert.equal(invocation.gitConfigCount, "1");
    assert.equal(invocation.gitConfigKey, "safe.directory");
    assert.equal(invocation.gitConfigValue, "*");

    // The executor wrote the envelope the worker read.
    assert.ok(existsSync(fixture.requestPath), "the executor wrote the request envelope");
    assert.equal(invocation.requestPath, fixture.requestPath);
    assert.equal(invocation.resultPath, fixture.resultPath);
    assert.ok(
      !run.stdout.includes(fixture.material),
      "the credential material never reaches the route's own output",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the route-D driver refuses an execution the executor cannot launch, and launches nothing", async () => {
  // The claim's controller root does not cover the run directory, so the
  // executor's manifest cannot be built: the launch is refused before
  // the first write, so no envelope and no container exist afterwards.
  const fixture = makeFixture({ volumeRoot: "separate-claim" });
  try {
    const run = await runDriver(fixture, "succeed");

    assert.equal(run.code, 1, "a refused route exits non-zero");
    assert.equal(run.summary.status, "failed");
    assert.equal(run.summary.failureCategory, "launch_refused");
    assert.match(
      run.summary.failureMessage,
      /the request-envelope path is not covered by any configured volume mapping/,
      "the refusal names the reason the executor refused",
    );
    assert.equal(
      run.summary.sharedClaimRelaxed,
      false,
      "nothing was launched, so the double never stood in for the shared claim",
    );
    assert.equal(run.invocation, null, "no container was launched");
    assert.ok(!existsSync(fixture.requestPath), "a refused launch leaves no envelope behind");
    assert.ok(!existsSync(fixture.runDir), "a refused launch leaves no run directory behind");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the route-D driver refuses a credential the harness resolver does not know, and launches nothing", async () => {
  // The route config holds material for one credential; the request asks
  // for a second one. The driver's resolver refuses it, so the launch is
  // refused — never half-credentialed.
  const fixture = makeFixture({
    credentials: [
      { name: "model", reference: "vault:model-ref-1" },
      { name: "forge-publish", reference: "vault:forge-ref-1" },
    ],
  });
  try {
    const run = await runDriver(fixture, "succeed");

    assert.equal(run.code, 1, "a refused route exits non-zero");
    assert.equal(run.summary.status, "failed");
    assert.equal(run.summary.failureCategory, "launch_refused");
    assert.match(
      run.summary.failureMessage,
      /credential resolution refused \(unknown_reference\)/,
      "the refusal names the closed refusal code, never the resolver's free text",
    );
    assert.equal(run.invocation, null, "no container was launched");
    assert.equal(run.summary.artifactPath, "", "a refused launch produced no review artifact");
    assert.equal(run.summary.resultHeadSha, "", "a refused launch verified no head");
    assert.ok(
      existsSync(fixture.requestPath),
      "the envelope is written before the credential handoff, so the refusal leaves it behind",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the route-D driver reports a container that exited non-zero", async () => {
  const fixture = makeFixture();
  try {
    const run = await runDriver(fixture, "fail");

    assert.equal(run.code, 1, "a failed route exits non-zero");
    assert.equal(run.summary.status, "failed");
    assert.equal(run.summary.failureCategory, "worker_error", "a container that ran and failed is a worker error");
    assert.equal(run.summary.failureMessage, "the worker job failed");
    assert.equal(run.summary.resultHeadSha, "", "a failed route verified no head");
    assert.equal(run.summary.artifactPath, "", "a failed route produced no review artifact");
    assert.ok(run.invocation !== null, "the container WAS launched");
    assert.equal(run.invocation.mode, "fail");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
