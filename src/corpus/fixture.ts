/** Fixture-driven corpus-assembly CLI for the #676 parity harness and
 * tests-v3: `node dist/index.js corpus-fixture <fixture.json>` prints a
 * single JSON line `{ok, values}` (or `{ok:false, stderr}`) whose values are
 * canonical strings comparable byte-for-byte with the v2 side.
 *
 * The driver mirrors the source-time sequence of scripts/sections/corpus.sh:
 * standards-context preparation → tool-harness placeholder states → primary
 * (or direct-smart-profile) build → optional gates rebuild → tool-harness
 * fork gate / simulated harness outputs → post-harness rebuild → any extra
 * explicit build calls → the optional harness-findings section swap. The v2
 * side (tests/parity_runners/v2_corpus.sh) runs the real corpus.sh top-level
 * code with stubbed gate/timer helpers and compares the resulting workspace
 * artifact bytes.
 *
 * All file contents cross the fixture boundary as base64 so invalid UTF-8
 * round-trips byte-exactly; a missing key means the file does not exist
 * (values use the "!absent" sentinel to distinguish that from an empty
 * file). */

import { readFileSync } from "node:fs";
import { BudgetError, resolveTierBudgets, type TierBudgets } from "./budgets.js";
import { ProjectionError } from "./projections.js";
import {
  buildReviewCorpus,
  gateFeatureForForks,
  prepareStandardsContext,
  prepareToolHarness,
  type CorpusBuildOptions,
  type CorpusSlot,
  type CorpusTier,
  type CorpusWorkspace,
} from "./assemble.js";
import { replaceHarnessFindingsSection } from "./harness-section.js";

const ABSENT = "!absent";

const ARTIFACT_NAMES = [
  "review-corpus.md",
  "review-corpus.truncated.md",
  "review-corpus.smart.truncated.md",
  "review-corpus.body.md",
  "review-corpus.body.truncated.md",
  "standards-context.md",
  "standards-context.capped.md",
  "standards-present.txt",
  "requirement-ledger.section.md",
  "requirement-ledger-present.txt",
  "specialist-leads-present.txt",
  "tool-harness.md",
  "tool-harness.json",
  "tool-harness.smart.md",
  "pr.diff.smart.truncated",
  "pr-files.smart.truncated.json",
  "repo-map.capped.md",
] as const;

const TOOL_SKIP_MD =
  "Tool harness was skipped for a cross-repository pull request. Set tool_enable_for_forks=true to override.";
const TOOL_SKIP_JSON =
  '{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[],"skipped":true,"skip_reason":"fork-pr"}';
const HARNESS_FAILURE_MD = "Tool harness failed to run in this review.\n";
const HARNESS_FAILURE_JSON =
  '{"mode":"native_loop","planned_request_count":0,"executed_request_count":0,"tool_results":[],"error":"execution failed"}\n';

interface CorpusFixture {
  context?: {
    model_context_tokens?: string;
    primary_model_context_tokens?: string;
    smart_model_context_tokens?: string;
    ai_max_tokens?: string;
    context_limit_mode?: string;
    review_context_profile?: string;
    ci_gate_active?: string;
  };
  env?: {
    tool_mode?: string;
    standards_file?: string;
    ci_checks_file?: string;
    tool_enable_for_forks?: string;
    is_fork_pr?: string;
    repo_map_max_bytes?: string;
  };
  /** Workspace files seeded before the pipeline runs. Plain strings are
   * UTF-8 text; `{"b64": ...}` carries exact bytes (invalid UTF-8). */
  files?: Record<string, FixtureContent>;
  /** Files the simulated tool harness writes between the placeholder
   * preparation and the post-harness rebuild; applied only when the fork
   * gate does not skip the harness. Mode "failure" instead triggers the
   * slice's own harness-failure artifacts (corpus.sh lines 540-545). */
  simulate_harness?: { mode?: string; files?: Record<string, FixtureContent> };
  extra_calls?: Array<{ tier: string; slot: string }>;
  harness_section_swap?: { corpus: FixtureContent; body: FixtureContent };
  /** Stop the corpus.sh source-time pipeline after the named build
   * ("initial" or "gates") so intermediate states — e.g. the tool-harness
   * placeholder corpus — are compared, not just the final one. */
  stop_after?: "initial" | "gates";
}

type FixtureContent = string | { b64?: string; text?: string };

const decodeContent = (value: FixtureContent): Uint8Array => {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  if (typeof value.b64 === "string") {
    return new Uint8Array(Buffer.from(value.b64, "base64"));
  }
  return Buffer.from(value.text ?? "", "utf8");
};

export function runCorpusFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as CorpusFixture;
  const context = fixture.context ?? {};
  const env = fixture.env ?? {};

  let budgets: { primary: TierBudgets; smart: TierBudgets };
  try {
    budgets = resolveTierBudgets({
      modelContextTokens: context.model_context_tokens,
      primaryModelContextTokens: context.primary_model_context_tokens,
      smartModelContextTokens: context.smart_model_context_tokens,
      aiMaxTokens: context.ai_max_tokens,
      contextLimitMode: context.context_limit_mode,
    });
  } catch (error) {
    if (error instanceof BudgetError) {
      return { ok: false, stderr: `ERROR: ${error.message}` };
    }
    return { ok: false, stderr: `ERROR: ${String(error)}` };
  }

  const state = new Map<string, Uint8Array>();
  for (const [name, value] of Object.entries(fixture.files ?? {})) {
    state.set(name, decodeContent(value));
  }
  const read = (name: string): Uint8Array | null => state.get(name) ?? null;

  const values: Record<string, string> = {};
  values["budget_primary_max_corpus"] = String(budgets.primary.maxCorpus);
  values["budget_primary_max_diff"] = String(budgets.primary.maxDiff);
  values["budget_primary_max_files"] = String(budgets.primary.maxFiles);
  values["budget_smart_max_corpus"] = String(budgets.smart.maxCorpus);
  values["budget_smart_max_diff"] = String(budgets.smart.maxDiff);
  values["budget_smart_max_files"] = String(budgets.smart.maxFiles);

  const apply = (writes: Map<string, Uint8Array>): void => {
    for (const [name, data] of writes) {
      state.set(name, Buffer.from(data));
    }
  };

  // corpus.sh source-time: standards context, then tool-harness states.
  // The standards context is derived from the file $STANDARDS_FILE points at
  // (seeded in `files` under its own name); an empty STANDARDS_FILE or a
  // missing file takes the explicit unavailable-note path.
  const standardsFile = env.standards_file ?? "";
  apply(prepareStandardsContext(standardsFile, standardsFile === "" ? null : read(standardsFile)));
  apply(prepareToolHarness(env.tool_mode ?? "", read("tool-harness.md"), read("tool-harness.json")));

  const profile = (context.review_context_profile ?? "primary") === "smart" ? "smart" : "primary";
  const repoMapMaxBytes = env.repo_map_max_bytes !== undefined && env.repo_map_max_bytes !== ""
    ? Number(env.repo_map_max_bytes)
    : 12000;
  const baseOptions = {
    repoMapMaxBytes,
    standardsFile,
    ciChecksFile: env.ci_checks_file ?? "",
  };

  const workspace = (): CorpusWorkspace => ({
    manifestContextMd: read("manifest-context.md"),
    prJson: read("pr.json"),
    classificationJson: read("classification.json"),
    relatedCodeTruncatedMd: read("related-code.truncated.md"),
    repoMapMd: read("repo-map.md"),
    prThreadMd: read("pr-thread.md"),
    linkedIssuesMd: read("linked-issues.md"),
    ciChecksContent: env.ci_checks_file ? read(env.ci_checks_file) : null,
    versionHintsTruncatedTxt: read("version-hints.truncated.txt"),
    toolHarnessMd: read("tool-harness.md"),
    toolHarnessSmartMd: read("tool-harness.smart.md"),
    evidenceProvidersMd: read("evidence-providers.md"),
    imageDigestContextMd: read("image-digest-context.md"),
    linkedSourcesMd: read("linked-sources.md"),
    repoImpactTruncatedMd: read("repo-impact.truncated.md"),
    repoHistoryTruncatedMd: read("repo-history.truncated.md"),
    prDiff: read("pr.diff"),
    prFilesJson: read("pr-files.json"),
    prDiffTruncated: read("pr.diff.truncated"),
    prFilesTruncatedJson: read("pr-files.truncated.json"),
    standardsContextMd: read("standards-context.md"),
    requirementLedgerMd: read("requirement-ledger.md"),
    specialistsMd: read("specialists.md"),
    requirementLedgerPresent: read("requirement-ledger-present.txt"),
    specialistLeadsPresent: read("specialist-leads-present.txt"),
    standardsFileContent: standardsFile === "" ? null : read(standardsFile),
  });

  const runBuild = (tier: CorpusTier, slot: CorpusSlot): boolean => {
    const options: CorpusBuildOptions = {
      tier,
      slot,
      maxCorpus: tier === "smart" ? budgets.smart.maxCorpus : budgets.primary.maxCorpus,
      diffBudget: tier === "smart" ? budgets.smart.maxDiff : budgets.primary.maxDiff,
      filesBudget: tier === "smart" ? budgets.smart.maxFiles : budgets.primary.maxFiles,
      // v2 guard condition, evaluated per call with that call's tier.
      budgetGuard: tier === "smart"
        || (context.primary_model_context_tokens !== undefined && context.primary_model_context_tokens !== "")
        || (context.model_context_tokens !== undefined && context.model_context_tokens !== ""),
      ...baseOptions,
    };
    const result = buildReviewCorpus(workspace(), options);
    apply(result.artifacts);
    return !result.overBudget;
  };

  let statusIndex = 0;
  const recordStatus = (ok: boolean): void => {
    statusIndex += 1;
    values[`status:extra:${statusIndex}`] = ok ? "0" : "1";
  };

  // Production runs build_review_corpus under `set -euo pipefail`, so a
  // projection failure (malformed pr.json / classification.json) or a
  // pipeline-level build failure ABORTS the review — fail closed. The driver
  // models that by propagating the throw out of the pipeline sequence; only
  // the explicit extra calls (the escalation call site, which handles a
  // failed smart build gracefully by keeping the primary review) record a
  // status instead.
  const runPipelineBuild = (tier: CorpusTier, slot: CorpusSlot): boolean => runBuild(tier, slot);
  const stopAfter = fixture.stop_after ?? "";

  try {
    // Build #1: the corpus.sh source-time primary (or direct-smart-profile) build.
    values["status:initial"] = runPipelineBuild(profile, "primary") ? "0" : "1";
    state.set("review-corpus.truncated.md", new Uint8Array(state.get("review-corpus.md") ?? []));

    if (stopAfter === "initial") {
      return emitState(values, state);
    }

    // Rebuild after the review gates resolve (#634): finalized CI evidence and
    // any usable specialist leads reach the corpus before the final review call.
    if ((context.ci_gate_active ?? "false") === "true" || nonEmpty(read("specialists.md"))) {
      values["status:gates"] = runPipelineBuild(profile, "primary") ? "0" : "1";
      state.set("review-corpus.truncated.md", new Uint8Array(state.get("review-corpus.md") ?? []));
    } else {
      values["status:gates"] = ABSENT;
    }

    if (stopAfter === "gates") {
      return emitState(values, state);
    }

  // Tool harness block (corpus.sh lines 530-550): fork gate, then the
  // post-harness rebuild. When the gate does not skip, the simulated harness
  // either writes fixture-provided outputs (mode "outputs") or fails so the
  // block's own harness-failure artifacts are exercised (mode "failure").
  if ((env.tool_mode ?? "").toLowerCase() === "native_loop") {
    const gate = gateFeatureForForks(env.tool_enable_for_forks ?? "", env.is_fork_pr ?? "", TOOL_SKIP_MD, TOOL_SKIP_JSON);
    if (gate.skipped) {
      const named = new Map<string, Uint8Array>();
      named.set("tool-harness.md", gate.artifacts.get("gate.md")!);
      named.set("tool-harness.json", gate.artifacts.get("gate.json")!);
      apply(named);
    } else {
      const simulate = fixture.simulate_harness;
      // The v2 runner's harness seam fails (return 1 → the block's own
      // failure artifacts) unless the fixture explicitly simulates outputs;
      // a missing mode means the same failure path on both sides.
      const mode = simulate?.mode ?? "failure";
      if (mode === "failure") {
        apply(new Map<string, Uint8Array>([
          ["tool-harness.md", Buffer.from(HARNESS_FAILURE_MD, "utf8")],
          ["tool-harness.json", Buffer.from(HARNESS_FAILURE_JSON, "utf8")],
        ]));
      } else if (mode === "outputs" && simulate?.files) {
        const simulated = new Map<string, Uint8Array>();
        for (const [name, value] of Object.entries(simulate.files)) {
          simulated.set(name, decodeContent(value));
        }
        apply(simulated);
      }
    }
    // The post-harness rebuild's status is not pinned (the v2 slice runs it
    // inside the sourced block); its artifacts are what the fixture compares.
    runPipelineBuild(profile, "primary");
    state.set("review-corpus.truncated.md", new Uint8Array(state.get("review-corpus.md") ?? []));
  }
  } catch (error) {
    if (!(error instanceof ProjectionError)) {
      throw error;
    }
    // Fail closed like production: the review aborts with a jq-class error.
    return { ok: false, stderr: `ERROR: jq: projection failed: ${error.message}` };
  }

  // Extra explicit build calls (escalation/coverage-style slot semantics and
  // the over-budget guard). No `cp` follows: only the corpus.sh source-time
  // builds refresh review-corpus.truncated.md. These mirror the escalation
  // call site, which handles a failed smart build gracefully — a thrown
  // projection failure records status 1 (primary review kept) instead of
  // aborting the fixture.
  if (stopAfter === "") {
    const extraCalls = fixture.extra_calls ?? [];
    for (const [index, call] of extraCalls.entries()) {
      const tier: CorpusTier = call.tier === "smart" ? "smart" : "primary";
      const slot: CorpusSlot = call.slot === "smart" ? "smart" : "primary";
      let ok: boolean;
      try {
        ok = runBuild(tier, slot);
      } catch (error) {
        if (!(error instanceof ProjectionError)) {
          throw error;
        }
        ok = false;
      }
      recordStatus(ok);
      values[`extra_call:${index + 1}`] = `${tier}/${slot}`;
    }

    if (fixture.harness_section_swap) {
      const corpus = Buffer.from(decodeContent(fixture.harness_section_swap.corpus)).toString("utf8");
      const body = Buffer.from(decodeContent(fixture.harness_section_swap.body)).toString("utf8");
      const swapped = replaceHarnessFindingsSection(corpus, body);
      values["swap_present"] = swapped === corpus ? "false" : "true";
      values["swap_corpus"] = encodeArtifact(Buffer.from(swapped, "utf8"));
    }
  }

  return emitState(values, state);
}

function emitState(values: Record<string, string>, state: Map<string, Uint8Array>): { ok: boolean; values: Record<string, string> } {
  for (const name of ARTIFACT_NAMES) {
    const data = state.get(name);
    values[`file:${name}`] = data === undefined ? ABSENT : encodeArtifact(data);
  }
  return { ok: true, values };
}

function nonEmpty(value: Uint8Array | null): boolean {
  return value !== null && value.length > 0;
}

function encodeArtifact(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
