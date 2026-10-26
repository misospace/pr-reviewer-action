// Standalone ESM fixture worker for tests-v3/executor-local.test.ts (#733).
// Deliberately self-contained: no imports from src/. It reads the execution
// request envelope from PR_REVIEWER_EXECUTION_REQUEST (the executor's
// coordination env var — stdout is never the protocol), and performs the
// scenario named as its first custom argv element (the executor appends the
// request path AFTER the operator's fixed args, so the envelope path is the
// last argv element and is ignored here).
//
// Scenarios:
//   ok         — write a valid completed result, exit 0
//   exit3      — exit 3, write nothing (worker_error)
//   silent     — exit 0, write nothing (no_result)
//   wrong-run  — write a valid-shaped result with a FOREIGN runId (stale_result)
//   sleep-long — sleep past any test deadline (deadline / cancellation)
//   crash      — SIGKILL itself (worker_crash)
import { readFileSync, writeFileSync } from "node:fs";

const scenario = process.argv[2];
const requestPath = process.env.PR_REVIEWER_EXECUTION_REQUEST ?? "";
const resultPath = process.env.PR_REVIEWER_EXECUTION_RESULT ?? "";

function writeResult(overrides = {}) {
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  writeFileSync(
    resultPath,
    JSON.stringify({
      status: "completed",
      runId: request.runId,
      jobId: request.jobId,
      resultHeadSha: request.headSha,
      resultArtifactPath: resultPath,
      failureCategory: "",
      failureMessage: "",
      diagnostics: "",
      artifactPaths: [],
      resourceMs: 1,
      observedAtMs: Date.now(),
      ...overrides,
    }),
    "utf8",
  );
}

switch (scenario) {
  case "ok":
    writeResult();
    break;
  case "exit3":
    process.exit(3);
    break;
  case "silent":
    break;
  case "wrong-run":
    writeResult({ runId: "generation-0" });
    break;
  case "sleep-long":
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    break;
  case "crash":
    process.kill(process.pid, "SIGKILL");
    break;
  default:
    process.exit(2);
}
