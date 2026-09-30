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

/** Normalizes a possibly-absent, empty, or whitespace-only string to
 * `undefined` (#838 follow-up). `options.runDir`/`PR_REVIEWER_RUN_DIR` must
 * never resolve as the empty string: Node's `path` APIs treat `""` as the
 * process cwd, so `?? env.PR_REVIEWER_RUN_DIR` alone lets an ambient
 * `PR_REVIEWER_RUN_DIR=""` (or a blank value) silently re-open the exact
 * checkout-as-run-dir hole this run-dir default was fixed to close. Every
 * reader of `PR_REVIEWER_RUN_DIR` (the `run` default, `publish`'s artifact
 * reads) must go through this before treating the value as present. */
export function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
