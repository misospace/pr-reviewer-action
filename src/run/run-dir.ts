import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";

/**
 * A fresh, private run directory per invocation (#838): the run workspace
 * reads through to disk (it reuses pr.diff / pr-object.json when present when
 * an explicit run dir is reused across a job), so the default run dir must
 * never be a directory the reviewed checkout can write into — a PR that
 * commits `pr.diff` / `pr-files.seed.json` at its repository root must never
 * have those files mistaken for artifacts this run already produced.
 */
export function createRunDir(temp: string): string {
  mkdirSync(temp, { recursive: true });
  return mkdtempSync(join(temp, "v3-review-run-"));
}
