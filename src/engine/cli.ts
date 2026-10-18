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
  const request: ReviewRequest = {
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
  }
}
