/** Prompt-assembly fixture CLI (#706 PR 4):
 * `node dist/index.js prompt-assembly-fixture <fixture.json>` prints one JSON
 * line `{ok, values, stderr}`. The keys stay byte-identical to what the v2
 * shell functions emit over the same scratch workspace.
 *
 * Fixture shape: `env` (the raw v2 environment: SYSTEM_PROMPT,
 * SYSTEM_PROMPT_FILE, SYSTEM_PROMPT_MODE, REVIEW_VERBOSITY,
 * RELATED_CODE_CONTEXT, PR_THREAD_CONTEXT), `files` (workspace-relative path
 * → UTF-8 text or `{"b64": ...}` bytes: presence files, classification.json,
 * a custom prompt file), `specialist_leads_calls` (default 1), `failures`
 * (`[{reason, on_model_failure?}]`) and `engines`
 * (`[{engine, origin, env?: {REVIEW_ROUTE, ROUTE_REASON, ESCALATION_REASONS}}]`). */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceAt } from "./bash.js";
import { annotateAnalysisEngine, handleModelFailure } from "./failure.js";
import { applySpecialistLeadsFragment, applySystemPromptFragments, resolveSystemPrompt } from "./system-prompt.js";
import { buildUserMessage } from "./user-message.js";

type FileContent = string | { b64: string };

interface PromptAssemblyFixture {
  env?: Record<string, string>;
  files?: Record<string, FileContent>;
  specialist_leads_calls?: number;
  failures?: { reason: string; on_model_failure?: string }[];
  engines?: { engine: string; origin: string; env?: Record<string, string> }[];
}

export interface PromptAssemblyFixtureResult {
  ok: boolean;
  values: Record<string, unknown>;
  stderr?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function seedPromptWorkspace(dir: string, files: Record<string, FileContent>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content.b64, "base64"));
  }
}

export function runPromptAssemblyFixture(fixturePath: string): PromptAssemblyFixtureResult {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as PromptAssemblyFixture;
  const env = fixture.env ?? {};
  const work = mkdtempSync(path.join(tmpdir(), "v3-prompt-assembly-"));
  try {
    seedPromptWorkspace(work, fixture.files ?? {});
    const workspace = workspaceAt(work);
    const resolved = resolveSystemPrompt(
      { systemPrompt: env.SYSTEM_PROMPT ?? "", systemPromptFile: env.SYSTEM_PROMPT_FILE ?? "", systemPromptMode: env.SYSTEM_PROMPT_MODE ?? "" },
      workspace,
    );
    const assembled = applySystemPromptFragments(
      resolved,
      {
        relatedCodeContext: env.RELATED_CODE_CONTEXT ?? "",
        prThreadContext: env.PR_THREAD_CONTEXT ?? "",
        reviewVerbosity: env.REVIEW_VERBOSITY ?? "",
      },
      workspace,
    );
    let final = assembled;
    for (let i = 0; i < (fixture.specialist_leads_calls ?? 1); i += 1) final = applySpecialistLeadsFragment(final, workspace);
    const userMessage = buildUserMessage(workspace);
    const failureNotices = (fixture.failures ?? []).map(({ reason, on_model_failure }) => {
      const outcome = handleModelFailure(reason, on_model_failure ?? "");
      return outcome.action === "notice"
        ? { reason, action: "notice", analysis_engine: outcome.analysisEngine, ai_output: outcome.aiOutputJson }
        : { reason, action: "fail", analysis_engine: "", ai_output: null };
    });
    const engineAnnotations = (fixture.engines ?? []).map(({ engine, origin, env: routing = {} }) =>
      annotateAnalysisEngine(engine, origin, {
        reviewRoute: routing.REVIEW_ROUTE ?? "",
        routeReason: routing.ROUTE_REASON ?? "",
        escalationReasons: routing.ESCALATION_REASONS ?? "",
      }));
    return {
      ok: true,
      values: {
        system_prompt_is_default: resolved.isDefault ? "1" : "0",
        system_prompt_resolved: resolved.systemPrompt,
        system_prompt_assembled: assembled.systemPrompt,
        system_prompt: final.systemPrompt,
        system_prompt_sha256: sha256(final.systemPrompt),
        user_message: userMessage,
        user_message_sha256: sha256(userMessage),
        failure_notices: failureNotices,
        engine_annotations: engineAnnotations,
      },
    };
  } catch (error) {
    return { ok: false, values: {}, stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
