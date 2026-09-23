import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("committed bundle boots on the current supported Node and reports config without secrets", () => {
  const secret = "bundle-secret-probe";
  const result = spawnSync(process.execPath, ["dist/index.js"], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_GITHUB_TOKEN: secret,
      INPUT_AI_BASE_URL: "https://example.invalid",
      INPUT_AI_MODEL: "test-model",
      PR_REVIEWER_V3_DEBUG: "true",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(secret), false);
  assert.match(result.stdout, /"schemaVersion":1,"inputs":123/);
  assert.match(result.stdout, /"githubToken":"\[REDACTED\]"/);
  assert.ok(readFileSync("dist/index.js", "utf8").includes("github-action"));
});
