import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The shadow runner's own seams (#809 review): the v2→v3 contract-name
 * mapping and the compare report, exercised through the script's CLI —
 * dogfood-only tooling, but its output is the qualification evidence. */

const SCRIPT = join(process.cwd(), "scripts", "v3_shadow_run.mjs");

test("compare mode maps the v2→v3 contract names and reports match/mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-shadow-cmp-"));
  try {
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({
      verdict: "approve", findings: [], review_markdown: "ok", verdict_source: "model",
      review_route: "legacy", escalation_reason: "", required_checks: "none",
      analysis_engine: "m@u (openai)", cache_hit_ratio: "-",
    }));
    writeFileSync(join(dir, "shadow-outputs.txt"), [
      "verdict=approve",
      "verdict-source=model",
      "review-route=legacy",
      "escalation-reason=",
      "required-checks=none",
      "analysis-engine=m@u (openai)",
      "cache-hit-ratio=-",
    ].join("\n"));
    writeFileSync(join(dir, "shadow-exit-code.txt"), "0");
    const report = join(dir, "shadow-comparison.md");
    execFileSync(process.execPath, [SCRIPT, "compare"], {
      env: {
        ...process.env,
        PR_REVIEWER_RUN_DIR: dir,
        SHADOW_REPORT: report,
        SHADOW_V2_VERDICT: "approve",
        SHADOW_V2_VERDICT_SOURCE: "model",
        SHADOW_V2_REVIEW_ROUTE: "legacy",
        SHADOW_V2_ESCALATION_REASON: "",
        SHADOW_V2_REQUIRED_CHECKS: "none",
        SHADOW_V2_ANALYSIS_ENGINE: "m@u (openai)",
        SHADOW_V2_CACHE_HIT_RATIO: "-",
        SHADOW_V2_FINDINGS: "[]",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const text = readFileSync(report, "utf8");
    assert.match(text, /# v3 shadow comparison/);
    assert.ok(!text.split("\n").some((line) => line.startsWith("- !=")), `unexpected divergence:\n${text}`);
    assert.match(text, /- == verdict: v2="approve" v3="approve"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compare mode flags a verdict divergence as != (the qualification signal)", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-shadow-div-"));
  try {
    writeFileSync(join(dir, "ai-output.json"), JSON.stringify({
      verdict: "request_changes", findings: [{ severity: "major", message: "m" }],
    }));
    writeFileSync(join(dir, "shadow-outputs.txt"), "verdict=request_changes\n");
    const report = join(dir, "shadow-comparison.md");
    execFileSync(process.execPath, [SCRIPT, "compare"], {
      env: {
        ...process.env,
        PR_REVIEWER_RUN_DIR: dir,
        SHADOW_REPORT: report,
        SHADOW_V2_VERDICT: "approve",
        SHADOW_V2_FINDINGS: "[]",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const text = readFileSync(report, "utf8");
    assert.match(text, /- != verdict: v2="approve" v3="request_changes"/);
    assert.match(text, /!= findings count: v2=0 v3=1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run-mode mapping projects v2 names onto the v3 INPUT_ contract", async () => {
  const { mappedEnv } = await import(pathToFileURL(SCRIPT).href) as { mappedEnv: (env: Record<string, string>) => Record<string, string> };
  const mapped = mappedEnv({
    PATH: "/usr/bin",
    ai_model: "m",
    ai_temperature: "",
    AI_BASE_URL: "https://example.invalid/v1",
    REPO: "o/r",
    GH_TOKEN: "t",
    NOT_A_CONTRACT_KEY: "x",
  });
  // Contract inputs bind both the hyphen and the underscore INPUT_ forms.
  assert.equal(mapped["INPUT_AI-MODEL"], "m");
  assert.equal(mapped.INPUT_AI_MODEL, "m");
  // Empty bindings are forwarded, like the composite's env blocks.
  assert.equal(mapped.INPUT_AI_TEMPERATURE, "");
  // Review-step raw names pass through and bind their contract input.
  assert.equal(mapped.AI_BASE_URL, "https://example.invalid/v1");
  assert.equal(mapped.INPUT_AI_BASE_URL, "https://example.invalid/v1");
  // Ambient runner context passes through; nothing else does.
  assert.equal(mapped.REPO, "o/r");
  assert.equal(mapped.GH_TOKEN, "t");
  assert.equal("NOT_A_CONTRACT_KEY" in mapped, false);
  assert.equal("PATH" in mapped, false);
});
