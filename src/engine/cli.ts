import { readFileSync } from "node:fs";
import { runReviewEngine, RunReviewError } from "./review.js";
import type { ReviewDependencies, ReviewRequest } from "./types.js";

const USAGE = "usage: engine --request <request.json>";

export async function engineMain(argv: string[], _env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--request" || argv[1] === undefined || argv[1] === "") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(argv[1], "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    data = parsed as Record<string, unknown>;
  } catch {
    process.stderr.write("engine: request file must contain a JSON object\n");
    return 2;
  }
  for (const key of ["repository", "prNumber", "workspace", "runDir"] as const) {
    if (typeof data[key] !== "string" || data[key] === "") {
      process.stderr.write(`engine: request field '${key}' is required\n`);
      return 2;
    }
  }
  const stringField = (key: string): string => typeof data[key] === "string" ? data[key] as string : "";
  if (typeof data.inputs !== "object" || data.inputs === null || Array.isArray(data.inputs)) {
    process.stderr.write("engine: request field 'inputs' must be an object\n");
    return 2;
  }
  // #726: the local entrypoint drives the typed cancellation lifecycle —
  // Ctrl-C / SIGTERM aborts the run through `ReviewRequest.signal` instead
  // of killing the process mid-write.
  const controller = new AbortController();
  const abortHandlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    const handler = (): void => controller.abort(signalName);
    process.on(signalName, handler);
    abortHandlers.push([signalName, handler]);
  }
  // #726: a request may carry the received event summary (`event`) and its
  // head SHA (`eventHeadSha`); the engine's admission stage consumes them.
  // With neither, admission runs with no event — manual semantics: the
  // label/comment-command gates are inert and the fingerprint skip logic
  // still applies, so a repeated manual run skips coherently (use
  // `forceRereview`-style config or FORCE_REVIEW to override).
  const event = typeof data.event === "object" && data.event !== null && !Array.isArray(data.event)
    ? data.event as ReviewRequest["event"]
    : undefined;
  const eventHeadSha = stringField("eventHeadSha");
  const request: ReviewRequest = {
    signal: controller.signal,
    repository: stringField("repository"),
    prNumber: stringField("prNumber"),
    headSha: stringField("headSha"),
    baseRef: stringField("baseRef"),
    isForkPr: stringField("isForkPr"),
    platform: stringField("platform"),
    forgejoApiUrl: stringField("forgejoApiUrl"),
    ciChecksFile: stringField("ciChecksFile"),
    inputs: data.inputs as ReviewRequest["inputs"],
    ambient: typeof data.ambient === "object" && data.ambient !== null && !Array.isArray(data.ambient)
      ? data.ambient as Record<string, string | undefined> : {},
    triggerReason: stringField("triggerReason"),
    forceRereview: data.forceRereview === true,
    ...(event !== undefined ? { event } : {}),
    ...(eventHeadSha !== "" ? { eventHeadSha } : {}),
  };
  const dependencies: ReviewDependencies = {
    workspace: stringField("workspace"),
    runDir: stringField("runDir"),
    outputsSink: stringField("outputsSink") || "/dev/null",
    stepSummaryPath: stringField("stepSummaryPath"),
    ...(typeof data.persistArtifacts === "boolean" ? { persistArtifacts: data.persistArtifacts } : {}),
    log: (line) => process.stderr.write(`[v3] ${line}\n`),
    error: (line) => process.stderr.write(`[v3] ERROR: ${line}\n`),
    annotate: (line) => process.stdout.write(`${line}\n`),
  };
  try {
    await runReviewEngine(request, dependencies);
    return 0;
  } catch (error) {
    if (error instanceof RunReviewError && error.exitCode === 2) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  } finally {
    // A finished local run never keeps the process's signal handlers (and a
    // stale controller) alive: repeated in-process invocations must not
    // accumulate listeners or abort each other's controllers.
    for (const [signalName, handler] of abortHandlers) process.removeListener(signalName, handler);
  }
}
