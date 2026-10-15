import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/run/review.js";
import { publishReview, renderReviewTriageBlock, buildPublishedBody } from "../src/publish/publish.js";
import { renderStepSummary } from "../src/publish/outputs.js";
import type { StepSummaryTelemetry } from "../src/publish/outputs.js";
import { applyReviewTriageFragment } from "../src/prompt/system-prompt.js";
import { BUNDLED_PROMPT_ASSETS } from "../src/prompt/assets.js";
import { startMockServer } from "./helpers.js";
import type { PlatformReadAdapter } from "../src/platform/types.js";
import type { PublishCommentRef, NativeReviewRequest, PublishPlatformApi, PublishReviewRef } from "../src/platform/publish-api.js";

/**
 * #1003 human-review triage: the opt-in, review-only, fail-closed
 * "does this need a specialized human review?" answer. Four properties are
 * pinned here, and they are the feature's whole contract:
 *
 *  (a) the prompt mentions the triage question only when enabled (and is
 *      otherwise byte-identical to the pre-#1003 assembly);
 *  (b) the step outputs are "" when disabled, and the tri-state answer when
 *      enabled — including a fail-closed `unknown`;
 *  (c) the published body gains the section only when triage ran;
 *  (d) enabling it changes no tool, fork, evidence or routing capability.
 */

function mockPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 7,
      title: "Update README",
      body: "",
      head: { sha: "a".repeat(40), ref: "feature" },
      base: { ref: "main" },
      user: { login: "someone" },
      changed_files: 1,
      additions: 4,
      deletions: 1,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: () => Promise.resolve("diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n"),
    listPrFiles: () => Promise.resolve({ ok: true, data: [{ filename: "README.md", status: "modified", additions: 4, deletions: 1, changes: 5 }] }),
    getIssue: () => Promise.resolve({ ok: false, error: "not served" }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

function verdictBody(triage: Record<string, unknown>): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: JSON.stringify({
          verdict: "approve",
          review_markdown: "Looks fine.\n",
          smart_review_requested: false,
          smart_review_reason: null,
          findings: [],
          requirement_coverage: null,
          required_check_dispositions: [],
          ...triage,
        }),
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  });
}

interface TriageRun {
  systemPrompt: string;
  outputs: string;
  stepSummary: string;
  artifact: Record<string, unknown>;
  runDir: string;
}

async function runTriageReview(options: {
  triage: Record<string, unknown>;
  inputs?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}): Promise<TriageRun> {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody(options.triage));
  });
  const runDir = mkdtempSync(join(tmpdir(), "v3-triage-"));
  try {
    const outputFile = join(runDir, "gh-output.txt");
    const stepSummaryFile = join(runDir, "step-summary.md");
    await runReview({
      env: { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: stepSummaryFile, ...options.env },
      inputs: {
        "github-token": "tok",
        repo: "o/r",
        "pr-number": "7",
        "ai-base-url": server.url,
        "ai-model": "m",
        "ai-stream": "false",
        "ai-api-key": "k",
        ...options.inputs,
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    const request = JSON.parse(
      readFileSync(join(runDir, "ai-request.primary.json"), "utf8"),
    ) as { messages: Array<{ role: string; content: string }> };
    return {
      systemPrompt: request.messages.find((message) => message.role === "system")!.content,
      outputs: readFileSync(outputFile, "utf8"),
      stepSummary: readFileSync(stepSummaryFile, "utf8"),
      artifact: JSON.parse(readFileSync(join(runDir, "ai-output.json"), "utf8")) as Record<string, unknown>,
      runDir,
    };
  } finally {
    await server.close();
  }
}

// ── (a) prompt assembly ───────────────────────────────────────────────────

test("#1003: applyReviewTriageFragment appends the triage question only when enabled", () => {
  const base = { systemPrompt: "BASE", isDefault: true, addendum: "" };
  const fragment = BUNDLED_PROMPT_ASSETS.fragments.review_triage!;
  const enabled = applyReviewTriageFragment(base, true);
  assert.equal(enabled.systemPrompt, `BASE\n${fragment.trimEnd()}`);
  // Disabled (and the default false) leaves the prompt byte-identical,
  // regardless of default/replace-mode — the only gate is the input.
  assert.equal(applyReviewTriageFragment(base, false).systemPrompt, "BASE");
  assert.equal(applyReviewTriageFragment({ ...base, isDefault: false }, false).systemPrompt, "BASE");
  // Idempotent: a second application adds nothing.
  assert.equal(applyReviewTriageFragment(enabled, true).systemPrompt, enabled.systemPrompt);
});

test("#1003: applyReviewTriageFragment composes with operator replace-mode prompts (the only fragment that does)", () => {
  // #1003 ("Configuration") says triage must compose with custom system
  // prompts. The operator prompt is preserved verbatim up to the appended
  // line so the existing prompts are not rewritten; only the triage question
  // is added. Other fragments stay tied to the default because they assume
  // the placeholder discipline the bundled default has; triage is opt-in by
  // config, so omitting the question from a custom prompt would silently
  // degrade the answer to `unknown` and leave the tri-state ungrounded.
  const fragment = BUNDLED_PROMPT_ASSETS.fragments.review_triage!;
  const operator = { systemPrompt: "OPERATOR PROMPT", isDefault: false, addendum: "" };
  const enabled = applyReviewTriageFragment(operator, true);
  assert.equal(enabled.systemPrompt, `OPERATOR PROMPT\n${fragment.trimEnd()}`);
  // The operator's content is preserved verbatim — the triage line is only an
  // addition, never a rewrite of operator prose.
  assert.equal(enabled.systemPrompt.startsWith("OPERATOR PROMPT\n"), true);
  // Disabled never adds, even when the operator opted in.
  assert.equal(applyReviewTriageFragment(operator, false).systemPrompt, "OPERATOR PROMPT");
});

test("#1003: the triage fragment states the fail-closed, no-invented-owner and no-extra-access rules", () => {
  const fragment = BUNDLED_PROMPT_ASSETS.fragments.review_triage!;
  assert.match(fragment, /review_triage_decision/);
  assert.match(fragment, /`unknown`/);
  assert.match(fragment, /trusted instruction files/);
  assert.match(fragment, /never an invented owner, team, or user/);
  assert.match(fragment, /never ask for, request, or imply any additional access/);
  assert.match(fragment, /do not request any reviewer/);
});

test("#1003: a run without review-triage assembles a prompt with no triage text at all", async () => {
  const run = await runTriageReview({ triage: { review_triage_decision: "required", review_triage_reason: "policy" } });
  try {
    assert.doesNotMatch(run.systemPrompt, /triage/i);
    assert.ok(!run.systemPrompt.includes("review_triage_decision"));
    // The bundled default prompt is otherwise intact (sanity: it is a real
    // assembly, not an empty one).
    assert.match(run.systemPrompt, /review/i);
  } finally {
    rmSync(run.runDir, { recursive: true, force: true });
  }
});

test("#1003: review-triage=true adds the triage question to the prompt and nothing else", async () => {
  const off = await runTriageReview({ triage: { review_triage_decision: "unknown", review_triage_reason: "" } });
  const on = await runTriageReview({
    triage: { review_triage_decision: "unknown", review_triage_reason: "" },
    inputs: { "review-triage": "true" },
  });
  try {
    assert.match(on.systemPrompt, /review_triage_decision/);
    assert.doesNotMatch(off.systemPrompt, /review_triage_decision/);
    // Enabling adds exactly one appended line: the rest is byte-identical.
    assert.equal(on.systemPrompt, `${off.systemPrompt}\n${BUNDLED_PROMPT_ASSETS.fragments.review_triage!.trimEnd()}`);
  } finally {
    rmSync(off.runDir, { recursive: true, force: true });
    rmSync(on.runDir, { recursive: true, force: true });
  }
});

// ── (b) outputs ───────────────────────────────────────────────────────────

test("#1003: both triage outputs are empty strings when the input is disabled", async () => {
  for (const inputs of [{}, { "review-triage": "false" }]) {
    const run = await runTriageReview({
      triage: { review_triage_decision: "required", review_triage_reason: "payments contract change" },
      inputs,
    });
    try {
      assert.match(run.outputs, /^review-triage-decision=\n/m);
      assert.match(run.outputs, /^review-triage-reason=\n/m);
      // Disabled means "did not run" — never a decision, not even `unknown`.
      assert.equal(run.outputs.includes("review-triage-decision=unknown"), false);
      assert.doesNotMatch(run.stepSummary, /Review triage/);
    } finally {
      rmSync(run.runDir, { recursive: true, force: true });
    }
  }
});

test("#1003: enabled, the decision output carries the tri-state answer and the reason", async () => {
  for (const decision of ["not_required", "required", "unknown"] as const) {
    const run = await runTriageReview({
      triage: { review_triage_decision: decision, review_triage_reason: `because ${decision}` },
      inputs: { "review-triage": "true" },
    });
    try {
      assert.match(run.outputs, new RegExp(`^review-triage-decision=${decision}\\n`, "m"));
      assert.match(run.outputs, /^review-triage-reason=because /m);
      assert.equal(run.artifact.review_triage_decision, decision);
      // The step summary renders the row for every decision, `unknown`
      // included: a fail-closed answer must be visible.
      assert.match(
        run.stepSummary,
        new RegExp(`^\\| Review triage \\| ${decision}: because ${decision} \\(advisory only\\) \\|$`, "m"),
      );
    } finally {
      rmSync(run.runDir, { recursive: true, force: true });
    }
  }
});

test("#1003: a malformed or missing model answer reaches the outputs as unknown", async () => {
  for (const triage of [{}, { review_triage_decision: null }, { review_triage_decision: "maybe" }, { review_triage_decision: "required " }]) {
    const run = await runTriageReview({ triage, inputs: { "review-triage": "true" } });
    try {
      assert.match(run.outputs, /^review-triage-decision=unknown\n/m);
      assert.match(run.outputs, /^review-triage-reason=\n/m);
      assert.equal(run.artifact.review_triage_decision, "unknown");
    } finally {
      rmSync(run.runDir, { recursive: true, force: true });
    }
  }
});

// #1003 fail-closed: `not_required` is a positive claim ("no specialized
// human review is needed"), so it requires a usable supporting statement. An
// unsubstantiated one — empty, blank, missing, non-string — must read as
// `unknown`, never as a confident negative from a parser gap.
test("#1003: an unsubstantiated not_required fails closed to unknown", async () => {
  for (const triage of [
    { review_triage_decision: "not_required", review_triage_reason: "" },
    { review_triage_decision: "not_required", review_triage_reason: "   " },
    { review_triage_decision: "not_required", review_triage_reason: "\n\t " },
    { review_triage_decision: "not_required" },
    { review_triage_decision: "not_required", review_triage_reason: null },
    { review_triage_decision: "not_required", review_triage_reason: 42 },
  ]) {
    const run = await runTriageReview({ triage, inputs: { "review-triage": "true" } });
    try {
      const label = JSON.stringify(triage);
      assert.match(run.outputs, /^review-triage-decision=unknown\n/m, label);
      assert.equal(run.artifact.review_triage_decision, "unknown", label);
      assert.match(run.stepSummary, /^\| Review triage \| unknown \(advisory only\) \|$/m, label);
    } finally {
      rmSync(run.runDir, { recursive: true, force: true });
    }
  }
});

// The converse: a substantiated `not_required` is kept, and `required` /
// `unknown` stay valid without any reason (neither is a positive claim).
test("#1003: a substantiated not_required is kept, and required/unknown need no reason", async () => {
  const substantiated = await runTriageReview({
    triage: { review_triage_decision: "not_required", review_triage_reason: "no owning team in the escalation policy" },
    inputs: { "review-triage": "true" },
  });
  const required = await runTriageReview({ triage: { review_triage_decision: "required" }, inputs: { "review-triage": "true" } });
  const unknown = await runTriageReview({ triage: { review_triage_decision: "unknown" }, inputs: { "review-triage": "true" } });
  try {
    assert.equal(substantiated.artifact.review_triage_decision, "not_required");
    assert.match(substantiated.outputs, /^review-triage-decision=not_required\n/m);
    assert.equal(required.artifact.review_triage_decision, "required");
    assert.equal(unknown.artifact.review_triage_decision, "unknown");
  } finally {
    rmSync(substantiated.runDir, { recursive: true, force: true });
    rmSync(required.runDir, { recursive: true, force: true });
    rmSync(unknown.runDir, { recursive: true, force: true });
  }
});

test("#1003: triage never moves the verdict", async () => {
  const off = await runTriageReview({ triage: { review_triage_decision: "required", review_triage_reason: "x" } });
  const on = await runTriageReview({
    triage: { review_triage_decision: "required", review_triage_reason: "x" },
    inputs: { "review-triage": "true" },
  });
  try {
    for (const run of [off, on]) {
      assert.match(run.outputs, /^verdict=approve\n/m);
      assert.equal(run.artifact.verdict, "approve");
    }
  } finally {
    rmSync(off.runDir, { recursive: true, force: true });
    rmSync(on.runDir, { recursive: true, force: true });
  }
});

// ── (c) published body ────────────────────────────────────────────────────

const MARKER = "<!-- ai-pr-review -->";

class CapturingPublishApi implements PublishPlatformApi {
  readonly platform = "github" as const;
  sticky: { marker: string; body: string }[] = [];
  submitted: NativeReviewRequest[] = [];
  async getHeadSha(): Promise<string | null> { return "a".repeat(40); }
  async listIssueComments(): Promise<PublishCommentRef[]> { return []; }
  async upsertStickyComment(marker: string, body: string) { this.sticky.push({ marker, body }); return { ok: true, created: true }; }
  async listReviews(): Promise<PublishReviewRef[]> { return []; }
  async createReview(request: NativeReviewRequest) { this.submitted.push(request); return { ok: true }; }
  async dismissReview(): Promise<boolean> { return true; }
  async minimizeReview(): Promise<boolean> { return true; }
  async minimizedReviewIds(): Promise<string[]> { return []; }
  async unresolvedSupersededThreads() { return { ok: true, threads: [], hasNextPage: false }; }
  async listManagedInlineComments(_ids: readonly string[]): ReturnType<PublishPlatformApi["listManagedInlineComments"]> { return { supported: true, complete: true, comments: [] }; }
  async retireInlineComment(_review: string, _comment: string) { return true; }
  async resolveThread(): Promise<boolean> { return true; }
  async removeLabel(): Promise<boolean> { return true; }
}

function publishInput(overrides: Partial<Parameters<typeof publishReview>[0]> = {}): Parameters<typeof publishReview>[0] {
  return {
    mode: "comment", reviewMarkdown: "Looks fine.\n", verdict: "approve", analysisEngine: "m",
    baseSha: "base-1", headSha: "a".repeat(40), prNumber: "7", commentMarker: MARKER,
    requiredChecks: "complete", reviewRoute: "primary", escalationReason: "", cacheHitRatio: "-",
    inlineFindings: false, inlineFindingsMax: 10, findings: [], cleanupPreviousNativeReviews: "false",
    allowApprove: false, approveForks: false, isForkPr: false, upstreamLinkMode: "inert",
    conditionalPresence: {
      linkedIssue: false, evidenceProvider: false, standards: false,
      toolHarnessFindings: false, toolHarnessResults: false,
    },
    forgejoPositions: false,
    ...overrides,
  };
}

test("#1003: the published body gains the triage section only when triage ran", async () => {
  const withoutTriage = new CapturingPublishApi();
  await publishReview(publishInput(), withoutTriage, { diffText: "" });
  const withTriage = new CapturingPublishApi();
  await publishReview(
    publishInput({ reviewTriage: { decision: "required", reason: "changes the payments gateway contract" } }),
    withTriage,
    { diffText: "" },
  );
  const off = withoutTriage.sticky[0]!.body;
  const on = withTriage.sticky[0]!.body;
  assert.equal(off.includes("## Human Review Triage"), false);
  assert.equal(on.includes("## Human Review Triage"), true);
  assert.match(on, /> \*\*Human review triage: specialized human review required\*\* — changes the payments gateway contract/);
  // The rest of the body is unchanged: the section is inserted, not a rewrite.
  assert.equal(on.replace(`## Human Review Triage\n\n> **Human review triage: specialized human review required** — changes the payments gateway contract\n>\n_Advisory only: this triage answer does not change the review's verdict or findings, and it requests no reviewer._\n\n`, ""), off);
});

test("#1003: the triage section shows the reason for every decision, unknown included", () => {
  for (const [decision, label] of [
    ["not_required", "no specialized human review required"],
    ["required", "specialized human review required"],
    ["unknown", "unknown — the reviewer could not determine this"],
  ] as const) {
    const block = renderReviewTriageBlock({ decision, reason: "policy evidence" }, "inert");
    assert.match(block, new RegExp(`> \\*\\*Human review triage: ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\* — policy evidence`));
  }
  // No reason: the block still states the decision, with no dangling dash
  // AND still carries the advisory-only note — the note documents the
  // section's non-binding nature, not the reason; an empty reason never
  // hides it.
  assert.equal(
    renderReviewTriageBlock({ decision: "unknown", reason: "" }, "inert"),
    "## Human Review Triage\n\n> **Human review triage: unknown — the reviewer could not determine this**\n>\n_Advisory only: this triage answer does not change the review's verdict or findings, and it requests no reviewer._",
  );
  // Fail closed at this boundary too: a value that is not one of the three
  // literals renders as unknown.
  assert.match(renderReviewTriageBlock({ decision: "REQUESTED", reason: "" }, "inert"), /Human review triage: unknown/);
});

test("#1003: the published triage section always carries the advisory-only note, including on the empty-reason path", () => {
  // The advisory-only message is a property of the section, not of the
  // reason; it must render for every decision/reason combination, including
  // the case where the model gave no reason at all.
  for (const decision of ["not_required", "required", "unknown"] as const) {
    for (const reason of ["", "evidence here"]) {
      const block = renderReviewTriageBlock({ decision, reason }, "inert");
      assert.match(
        block,
        /_Advisory only: this triage answer does not change the review's verdict or findings, and it requests no reviewer\._/,
        `advisory-only note missing for decision=${JSON.stringify(decision)} reason=${JSON.stringify(reason)}`,
      );
    }
  }
});

test("#1003: a hostile triage reason cannot break out of the triage block", () => {
  const block = renderReviewTriageBlock(
    { decision: "required", reason: "|\n## Injected heading\n- [click](https://evil.example)" },
    "inert",
  );
  // Whitespace is flattened after sanitization, so the reason can never open
  // a line and forge a heading, and every pipe is table-escaped so it cannot
  // start a row. (Links are left exactly as the review body itself leaves
  // them — same sanitization pass, same link mode.)
  assert.equal(block.includes("\n## Injected heading"), false);
  assert.equal(block.split("\n").some((line) => line.startsWith("|")), false);
  assert.match(block, /\| ## Injected heading/);
  assert.match(block, /Human review triage: specialized human review required/);
  // A hostile reason must not be able to close the blockquote and put prose
  // outside it either.
  assert.equal(block.split("\n").filter((line) => line === ">").length, 1);
});

// Adversarial boundary (#252): the published body is a public surface, so an
// unvalidated decision must fail closed there exactly as it does in the step
// summary — never render a fourth decision nobody validated.
test("#1003: the published triage section fails closed on an unvalidated decision", () => {
  for (const decision of ["not_required ", "Required", "MAYBE", "no_review_needed"]) {
    const block = renderReviewTriageBlock({ decision, reason: "x" }, "inert");
    assert.match(block, /Human review triage: unknown — the reviewer could not determine this/);
    assert.equal(block.includes(decision), false, `decision ${JSON.stringify(decision)} must not render verbatim`);
  }
});

// #1003 fail-closed: the same evidence rule at the published body — an
// unsubstantiated `not_required` renders as `unknown`, never as "no
// specialized human review required" without a supporting statement.
test("#1003: the published triage section fails closed on an unsubstantiated not_required", () => {
  for (const reason of ["", "   ", "\n\t"]) {
    const block = renderReviewTriageBlock({ decision: "not_required", reason }, "inert");
    assert.match(block, /Human review triage: unknown — the reviewer could not determine this/, JSON.stringify(reason));
    assert.equal(block.includes("no specialized human review required"), false, JSON.stringify(reason));
  }
  const kept = renderReviewTriageBlock({ decision: "not_required", reason: "no owning team in the escalation policy" }, "inert");
  assert.match(kept, /Human review triage: no specialized human review required\*\* — no owning team in the escalation policy/);
});

test("#1003: buildPublishedBody is byte-identical when no triage block is supplied", () => {
  const options = { markers: MARKER, analysisEngine: "m (openai)", sanitizedMarkdown: "REVIEW", actionVersion: "" };
  assert.equal(buildPublishedBody(options), `${MARKER}\n_Analysis engine: m (openai)_\n\nREVIEW\n`);
  assert.notEqual(buildPublishedBody({ ...options, triageBlock: "T" }), buildPublishedBody(options));
});

// ── step summary row ──────────────────────────────────────────────────────

function telemetry(overrides: Partial<StepSummaryTelemetry> = {}): StepSummaryTelemetry {
  return {
    analysisEngine: "engine", verdict: "approve", verdictSource: "model", findingsCount: 0, blockersCount: 0,
    requiredChecksStatus: "complete", primaryTools: { stopReason: "disabled" }, route: "legacy",
    budget: "-", finalContext: "-", diffBytes: { actual: "1", truncated: "0" },
    corpusBytes: { actual: "1", truncated: "0" }, promptTokens: "0", completionTokens: "0", cacheHitRatio: "-",
    ...overrides,
  };
}

test("#1003: the step summary triage row renders only when supplied and escapes the reason", () => {
  assert.equal(renderStepSummary(telemetry()).includes("Review triage"), false);
  const row = renderStepSummary(telemetry({ reviewTriage: { decision: "required", reason: "policy | evidence" } }));
  assert.match(row, /\| Review triage \| required: policy \\\| evidence \(advisory only\) \|/);
  const unknown = renderStepSummary(telemetry({ reviewTriage: { decision: "unknown", reason: "" } }));
  assert.match(unknown, /\| Review triage \| unknown \(advisory only\) \|/);
});

// Adversarial boundary (#252): feed the fence the hostile value itself, not
// just benign input. A decision that is neither empty nor one of the three
// literals must fail closed to `unknown` at this public surface — the summary
// must never render a fourth decision a downstream gate could act on.
test("#1003: the step summary triage row fails closed on an unvalidated decision", () => {
  for (const decision of ["not_required ", "Required", "MAYBE", "no_review_needed", ""]) {
    const row = renderStepSummary(telemetry({ reviewTriage: { decision, reason: "x" } }));
    assert.match(row, /\| Review triage \| unknown: x \(advisory only\) \|/, `decision ${JSON.stringify(decision)} must fail closed`);
    // The unvalidated value must not reach the triage row in any form (the
    // check is scoped to that row — elsewhere in the summary "Required" is
    // legitimate text, e.g. the required-checks row).
    if (decision.trim() !== "") {
      const triageRow = row.split("\n").find((line) => line.startsWith("| Review triage |")) ?? "";
      assert.equal(triageRow.includes(decision.trim()), false, `decision ${JSON.stringify(decision)} must not render verbatim`);
    }
  }
});

// #1003 fail-closed: the summary applies the same evidence rule, so an
// unsubstantiated `not_required` shows `unknown` here too.
test("#1003: the step summary triage row fails closed on an unsubstantiated not_required", () => {
  for (const reason of ["", "   ", "\n\t"]) {
    const row = renderStepSummary(telemetry({ reviewTriage: { decision: "not_required", reason } }));
    assert.match(row, /\| Review triage \| unknown \(advisory only\) \|/, JSON.stringify(reason));
    const triageRow = row.split("\n").find((line) => line.startsWith("| Review triage |")) ?? "";
    assert.equal(triageRow.includes("not_required"), false, JSON.stringify(reason));
  }
  const kept = renderStepSummary(telemetry({ reviewTriage: { decision: "not_required", reason: "policy evidence" } }));
  assert.match(kept, /\| Review triage \| not_required: policy evidence \(advisory only\) \|/);
});

// ── (d) no capability change ──────────────────────────────────────────────

test("#1003: enabling triage changes no tool, fork, evidence or routing capability", async () => {
  // Identical inputs except review-triage: the tool harness artifact, the
  // corpus, the route and the model-request envelope must be byte-identical.
  const scripted = () => startMockServer((_req, body, res) => {
    res.setHeader("Content-Type", "application/json");
    const req = JSON.parse(body) as { tools?: unknown[] };
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      res.end(JSON.stringify({
        id: "c0", object: "chat.completion", model: "m",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      return;
    }
    res.end(verdictBody({ review_triage_decision: "required", review_triage_reason: "policy" }));
  });
  const baseInputs = {
    "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-model": "m", "ai-api-key": "k",
    "ai-stream": "false", "tool-mode": "native_loop", "review-routing-mode": "auto",
  };
  const compare = async (inputs: Record<string, string>) => {
    const server = await scripted();
    const runDir = mkdtempSync(join(tmpdir(), "v3-triage-caps-"));
    try {
      writeFileSync(join(runDir, "README.md"), "evidence marker\n");
      const result = await runReview({
        env: { IS_FORK_PR: "false" },
        inputs: { ...baseInputs, "ai-base-url": server.url, ...inputs },
        runDir,
        workspace: runDir,
        platformAdapter: mockPlatform(),
        persistArtifacts: true,
        quiet: true,
      });
      return {
        harness: JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as Record<string, unknown>,
        corpus: readFileSync(join(runDir, "review-corpus.truncated.md"), "utf8"),
        route: result.outputs.reviewRoute,
        // The tool-call trace records which tools ran; triage must not add,
        // remove, or reorder any.
        toolCalls: result.outputs.toolCalls,
      };
    } finally {
      await server.close();
      rmSync(runDir, { recursive: true, force: true });
    }
  };
  const off = await compare({});
  const on = await compare({ "review-triage": "true" });
  assert.equal(on.corpus, off.corpus);
  assert.equal(on.route, off.route);
  assert.equal(on.toolCalls, off.toolCalls);
  // Same tool surface, same budget, same execution — only the harness's
  // wall-clock/telemetry measurements are allowed to differ between two runs.
  const capabilityOf = (harness: Record<string, unknown>): unknown => ({
    ...harness,
    usage: harness.usage ? { ...(harness.usage as Record<string, unknown>), peak_conversation_tokens: undefined } : undefined,
    tool_loop_telemetry: harness.tool_loop_telemetry
      ? {
        ...(harness.tool_loop_telemetry as Record<string, unknown>),
        usage: (harness.tool_loop_telemetry as { usage: Record<string, unknown> }).usage
          ? { ...(harness.tool_loop_telemetry as { usage: Record<string, unknown> }).usage, elapsed_sec: undefined, peak_conversation_tokens: undefined }
          : undefined,
      }
      : undefined,
  });
  assert.deepEqual(capabilityOf(on.harness), capabilityOf(off.harness));
  // The capability the test is really about: triage is not an access grant,
  // so the harness still ran read-only tools it was already allowed to run.
  assert.equal((on.harness.executed_request_count as number) > 0, true);
});

test("#1003: a fork PR stays gated identically with triage enabled", async () => {
  const server = await startMockServer((_req, _body, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(verdictBody({ review_triage_decision: "unknown", review_triage_reason: "" }));
  });
  const runDir = mkdtempSync(join(tmpdir(), "v3-triage-fork-"));
  try {
    const result = await runReview({
      env: { IS_FORK_PR: "true" },
      inputs: {
        "github-token": "tok", repo: "o/r", "pr-number": "7", "ai-base-url": server.url,
        "ai-model": "m", "ai-api-key": "k", "ai-stream": "false",
        "tool-mode": "native_loop", "review-triage": "true",
      },
      runDir,
      workspace: runDir,
      platformAdapter: mockPlatform(),
      persistArtifacts: true,
      quiet: true,
    });
    // The #fork tool gate is untouched by triage: the harness stays skipped
    // for a cross-repository PR with tool_enable_for_forks unset.
    const harness = JSON.parse(readFileSync(join(runDir, "tool-harness.json"), "utf8")) as { skipped?: boolean; skip_reason?: string };
    assert.equal(harness.skipped, true);
    assert.equal(harness.skip_reason, "fork-pr");
    // Triage still answered (it is review-only, not an access grant).
    assert.equal(result.outputs.reviewTriageDecision, "unknown");
  } finally {
    await server.close();
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("#1003: there is no fork-grant input for triage", async () => {
  const contract = readFileSync("contracts/action-v3.yml", "utf8");
  assert.equal(/id: review-triage-enable-for-forks/.test(contract), false);
  // Operator-only: repository config must never be able to switch triage on.
  const entry = /- id: review-triage\n(?:\s+[a-z-]+: [^\n]*\n)*/.exec(contract)![0];
  assert.equal(entry.includes("repo-configurable"), false);
  assert.equal(entry.includes("v2_id"), false);
});