import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

test("committed bundle embeds the canonical contract and runs without source files", () => {
  const secret = "bundle-secret-probe";
  const bundle = resolve("dist/index.js");
  const source = parse(readFileSync("contracts/action-v3.yml", "utf8")) as {
    schema_version: number;
    inputs: { id: string }[];
  };
  const cwd = mkdtempSync(join(tmpdir(), "v3-bundle-"));
  try {
    const result = spawnSync(process.execPath, [bundle], {
      cwd,
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
    const debug = JSON.parse(result.stdout) as {
      schemaVersion: number;
      inputs: number;
      config: Record<string, unknown>;
    };
    assert.equal(debug.schemaVersion, source.schema_version);
    assert.equal(debug.inputs, source.inputs.length);
    assert.deepEqual(
      Object.keys(debug.config).sort(),
      source.inputs.map(({ id }) => id.replace(/-([a-z0-9])/g, (_match, char: string) => char.toUpperCase())).sort(),
    );
    assert.equal(debug.config.githubToken, "[REDACTED]");
    assert.equal(debug.config.aiPrimaryModel, "test-model");
    assert.equal(debug.config.aiFallbackBaseUrl, "https://example.invalid");

    const invalid = spawnSync(process.execPath, [bundle], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        INPUT_GITHUB_TOKEN: secret,
        INPUT_AI_BASE_URL: "https://example.invalid",
        INPUT_AI_MODEL: "test-model",
        INPUT_AI_API_FORMAT: "unsupported-format",
      },
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Input 'ai-api-format' must be one of/);
    assert.equal(invalid.stderr.includes(secret), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
