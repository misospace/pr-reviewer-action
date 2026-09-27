import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BUNDLED_PROMPT_ASSETS,
  CROSS_STEP_TRACE_GUIDANCE,
  MODEL_UNAVAILABLE_ENGINE,
  SystemPromptFileError,
  USER_MESSAGE_BASE,
  UserMessageBuildError,
  annotateAnalysisEngine,
  applySpecialistLeadsFragment,
  applySystemPromptFragments,
  buildUserMessage,
  handleModelFailure,
  jqRawPrKind,
  resolveSystemPrompt,
  workspaceAt,
} from "../src/prompt/index.js";
import { seedPromptWorkspace } from "../src/prompt/fixture.js";
import { resolveReviewSystemPrompt } from "../src/tools/harness.js";

const FRAGMENT_DIR = "scripts/prompt_fragments";
const PLACEHOLDERS = [
  "RELATED_CODE_GUIDANCE", "PR_THREAD_GUIDANCE", "REVIEW_THREADS_GUIDANCE", "HUMAN_REVIEWS_GUIDANCE",
  "VERSION_BUMP_GUIDANCE", "REQUIREMENT_LEDGER_GUIDANCE", "SPECIALIST_LEADS_GUIDANCE",
  "IMAGE_DIGEST_GUIDANCE", "RELEASE_NOTES_GUIDANCE", "VERBOSITY_GUIDANCE",
];

function withWorkspace(files: Record<string, string>, body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "v3-prompt-test-"));
  try {
    seedPromptWorkspace(dir, files);
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("embedded prompt assets are byte-identical to the shipped files", () => {
  assert.equal(BUNDLED_PROMPT_ASSETS.defaultSystemPrompt, readFileSync("scripts/default_system_prompt.txt", "utf8"));
  const names = readdirSync(FRAGMENT_DIR).filter((n) => n.endsWith(".txt")).map((n) => n.slice(0, -4)).sort();
  assert.deepEqual(Object.keys(BUNDLED_PROMPT_ASSETS.fragments).sort(), names);
  for (const name of names) {
    assert.equal(BUNDLED_PROMPT_ASSETS.fragments[name], readFileSync(`${FRAGMENT_DIR}/${name}.txt`, "utf8"), name);
  }
});

test("fragments stay literal under bash patsub_replacement and carry no placeholders", () => {
  // v2 substitutes fragments with an unquoted ${var/pattern/$frag}; on bash
  // >= 5.2 an `&` (or a backslash escape) in $frag is expanded, so the v3
  // literal replacement would diverge by bash version.
  for (const [name, text] of Object.entries(BUNDLED_PROMPT_ASSETS.fragments)) {
    assert.equal(/[&\\]/.test(text), false, `${name}.txt must not contain '&' or '\\'`);
    assert.equal(text.includes("{{"), false, `${name}.txt must not contain a placeholder`);
  }
});

test("the default prompt carries each placeholder exactly once (first-occurrence substitution suffices)", () => {
  const text = BUNDLED_PROMPT_ASSETS.defaultSystemPrompt;
  for (const name of PLACEHOLDERS) {
    assert.equal(text.split(`{{${name}}}`).length - 1, 1, name);
  }
  assert.deepEqual([...text.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]).sort(), [...PLACEHOLDERS].sort());
});

test("assembly leaves no placeholder on any gate combination and appends the trace sentence", () => {
  const combos: Record<string, string>[] = [
    {},
    { "classification.json": '{"pr_kind":"k8s_manifest"}', "review-threads-present.txt": "1", "human-reviews-present.txt": "1", "requirement-ledger-present.txt": "1" },
    { "classification.json": '{"pr_kind":"renovate_digest_only"}' },
  ];
  for (const files of combos) {
    withWorkspace(files, (dir) => {
      const ws = workspaceAt(dir);
      const state = applySystemPromptFragments(resolveSystemPrompt({}, ws), { reviewVerbosity: "concise" }, ws);
      assert.equal(state.systemPrompt.includes("{{"), false);
      assert.equal(state.systemPrompt.endsWith(CROSS_STEP_TRACE_GUIDANCE), true);
    });
  }
});

test("replace mode keeps the operator prompt verbatim; append mode composes it after assembly", () => {
  withWorkspace({ "p.md": "File rules.\n\n", "specialist-leads-present.txt": "1" }, (dir) => {
    const ws = workspaceAt(dir);
    const replaced = resolveSystemPrompt({ systemPromptFile: "p.md", systemPrompt: "Inline." }, ws);
    assert.deepEqual(replaced, { systemPrompt: "File rules.\n\nInline.", isDefault: false, addendum: "" });
    const final = applySpecialistLeadsFragment(applySystemPromptFragments(replaced, {}, ws), ws);
    assert.equal(final.systemPrompt, "File rules.\n\nInline.");

    const appended = resolveSystemPrompt({ systemPrompt: "Addendum.", systemPromptMode: "append" }, ws);
    assert.equal(appended.isDefault, true);
    const assembled = applySystemPromptFragments(appended, {}, ws);
    assert.equal(assembled.systemPrompt.endsWith(`${CROSS_STEP_TRACE_GUIDANCE}\n\nAddendum.`), true);
  });
});

test("a missing SYSTEM_PROMPT_FILE is a hard error", () => {
  withWorkspace({}, (dir) => {
    assert.throws(() => resolveSystemPrompt({ systemPromptFile: "nope.txt" }, workspaceAt(dir)), SystemPromptFileError);
  });
});

test("specialist-leads guidance is appended once, only for the default prompt with a non-empty signal", () => {
  withWorkspace({ "specialist-leads-present.txt": "1" }, (dir) => {
    const ws = workspaceAt(dir);
    const assembled = applySystemPromptFragments(resolveSystemPrompt({}, ws), {}, ws);
    const once = applySpecialistLeadsFragment(assembled, ws);
    assert.notEqual(once.systemPrompt, assembled.systemPrompt);
    assert.equal(applySpecialistLeadsFragment(once, ws).systemPrompt, once.systemPrompt);
  });
  withWorkspace({ "specialist-leads-present.txt": "" }, (dir) => {
    const ws = workspaceAt(dir);
    const assembled = applySystemPromptFragments(resolveSystemPrompt({}, ws), {}, ws);
    assert.equal(applySpecialistLeadsFragment(assembled, ws), assembled);
  });
});

test("jqRawPrKind mirrors the jq capture", () => {
  assert.equal(jqRawPrKind('{"pr_kind":"k8s_manifest"}'), "k8s_manifest");
  assert.equal(jqRawPrKind('{"pr_kind":"k8s_manifest"}\n{}'), "k8s_manifest");
  assert.equal(jqRawPrKind('{"pr_kind":"a"} tru'), "a");
  assert.equal(jqRawPrKind('﻿{"pr_kind":"a"}'), "a");
  assert.equal(jqRawPrKind('["k8s_manifest"]'), "");
  assert.equal(jqRawPrKind('{"pr_kind":false}'), "");
  assert.equal(jqRawPrKind('{"pr_kind":"x\\n"}'), "x");
  assert.equal(jqRawPrKind(""), "");
});

test("buildUserMessage: base fallbacks, steering, and Python crash shapes", () => {
  withWorkspace({}, (dir) => assert.equal(buildUserMessage(workspaceAt(dir)), USER_MESSAGE_BASE));
  withWorkspace({ "classification.json": "{bad" }, (dir) => assert.equal(buildUserMessage(workspaceAt(dir)), USER_MESSAGE_BASE));
  withWorkspace({ "classification.json": '{"pr_kind":"app_code","must_check":["a\\n\\n"]}' }, (dir) => {
    const message = buildUserMessage(workspaceAt(dir));
    assert.equal(message.startsWith(`${USER_MESSAGE_BASE}\nPR kind (deterministic classification): app_code.\nRequired checks`), true);
    assert.equal(message.endsWith("\n- a"), true);
  });
  withWorkspace({ "classification.json": '{"risk_flags":["x"],"risk_flags_with_files":["x"]}' }, (dir) => {
    assert.throws(() => buildUserMessage(workspaceAt(dir)), UserMessageBuildError);
  });
  withWorkspace({ "classification.json": '{"risk_flags":["x"],"risk_flags_with_files":{"x":[1]}}' }, (dir) => {
    assert.throws(() => buildUserMessage(workspaceAt(dir)), UserMessageBuildError);
  });
});

test("handleModelFailure: fail by default, notice emits the v2 ai-output.json bytes", () => {
  assert.deepEqual(handleModelFailure("boom"), { action: "fail", reason: "boom" });
  assert.deepEqual(handleModelFailure("boom", "Fail"), { action: "fail", reason: "boom" });
  const notice = handleModelFailure("café \"x\"", "NOTICE");
  assert.equal(notice.action, "notice");
  if (notice.action !== "notice") return;
  assert.equal(notice.analysisEngine, MODEL_UNAVAILABLE_ENGINE);
  assert.equal(notice.aiOutputJson.endsWith("}\n"), true);
  assert.equal(notice.aiOutputJson.includes("caf\\u00e9 \\\"x\\\""), true);
  const parsed = JSON.parse(notice.aiOutputJson) as { verdict: string; review_markdown: string };
  assert.equal(parsed.verdict, "request_changes");
  assert.equal(parsed.review_markdown.startsWith("## AI review could not run\n\n"), true);
});

test("annotateAnalysisEngine explains the route", () => {
  const e = "m@u (openai)";
  assert.equal(annotateAnalysisEngine(e, "primary"), e);
  assert.equal(annotateAnalysisEngine(e, "primary", { reviewRoute: "primary" }), `${e} — primary route`);
  assert.equal(annotateAnalysisEngine(e, "primary", { reviewRoute: "smart" }), `${e} — routed smart (risk match)`);
  assert.equal(annotateAnalysisEngine(e, "fallback"), `${e} — fallback (primary failed)`);
  assert.equal(annotateAnalysisEngine(e, "escalated", { escalationReasons: "r" }), `${e} — escalated (r)`);
  assert.equal(annotateAnalysisEngine(e, "escalated"), `${e} — escalated (unknown)`);
});

test("harness fallback strips placeholders from the bundled default when no prompt is assembled", () => {
  const prompt = resolveReviewSystemPrompt({
    env: {},
    cwd: ".",
    readText: () => null,
    exists: () => false,
    writeArtifact: () => undefined,
    transport: async () => ({}),
  });
  assert.equal(prompt, BUNDLED_PROMPT_ASSETS.defaultSystemPrompt.replace(/\{\{[A-Z0-9_]+\}\}/g, ""));
  assert.equal(prompt.includes("{{"), false);
});

test("the bundle assembles prompts without the repository's scripts/ directory", () => {
  const cwd = mkdtempSync(join(tmpdir(), "v3-prompt-bundle-"));
  try {
    const fixture = join(cwd, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ env: { REVIEW_VERBOSITY: "concise" }, files: { "classification.json": '{"pr_kind":"k8s_manifest"}' } }));
    const result = spawnSync(process.execPath, [resolve("dist/index.js"), "prompt-assembly-fixture", fixture], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { ok: boolean; values: Record<string, string> };
    assert.equal(payload.ok, true);
    assert.equal(payload.values.system_prompt!.includes(BUNDLED_PROMPT_ASSETS.fragments.version_bump!.trimEnd()), true);
    assert.equal(payload.values.system_prompt!.includes(BUNDLED_PROMPT_ASSETS.fragments.concise!.trimEnd()), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
