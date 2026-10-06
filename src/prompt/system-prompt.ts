/** System-prompt assembly (#706 PR 4): byte-exact port of
 * `resolve_system_prompt`, `apply_system_prompt_fragments` and
 * `apply_specialist_leads_fragment` (`scripts/sections/config.sh`).
 *
 * v2 runs these in three phases, and the orchestrator must keep them apart
 * because each gate's input only exists at its phase:
 *
 * 1. `resolveSystemPrompt` at config time — replace vs append, the
 *    `SYSTEM_PROMPT_FILE` + inline composition, the bundled default;
 * 2. `applySystemPromptFragments` after classification (`classification.sh`)
 *    — the context-dial, presence-file and `pr_kind` gated fragments, the
 *    verbosity dial, and the append-mode addendum;
 * 3. `applySpecialistLeadsFragment` after the specialist phase is reaped
 *    (`corpus.sh`) — its presence signal does not exist earlier.
 *
 * The assembled text is what v2 exports as `SYSTEM_PROMPT`: the value the
 * standard review call sends and the native-loop harness trusts verbatim
 * (`src/tools/harness.ts` `resolveReviewSystemPrompt`). */

import { BUNDLED_PROMPT_ASSETS, rawFragment, type PromptAssets } from "./assets.js";
import { MAX_DISTRIBUTED_HINTS, MAX_GROUPS_PER_RULE, MAX_GROUP_NAME_CHARS } from "../enforcement/requirement-trace.js";
import { bashCapture, bashLowerCapture, bashReadCapture, bashReplaceFirst, jqRawPrKind, type PromptWorkspace } from "./bash.js";

/** Workspace artifacts the fragment gates read, written by earlier phases. */
export const PROMPT_PRESENCE_FILES = {
  reviewThreads: "review-threads-present.txt",
  humanReviews: "human-reviews-present.txt",
  requirementLedger: "requirement-ledger-present.txt",
  specialistLeads: "specialist-leads-present.txt",
  classification: "classification.json",
} as const;

/** The sentence v2 appends to every assembled default prompt. */
export const CROSS_STEP_TRACE_GUIDANCE =
  " Trace producer -> persisted representation -> transport/environment -> consumer -> decision for cross-step features; verify the production wiring uses the same artifact and capability as the tests. A test or CI result absent from a truncated corpus is not evidence that the exact head failed or lacks coverage: distinguish omitted evidence from an observed counterexample, and do not request changes solely because a tail is missing.";

export class SystemPromptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemPromptFileError";
  }
}

/** Raw operator settings (`system-prompt`, `system-prompt-file`,
 * `system-prompt-mode`). Empty means unset, as in v2's `${VAR:-}`. */
export interface SystemPromptSettings {
  readonly systemPrompt?: string;
  readonly systemPromptFile?: string;
  /** Defaults to `replace`; only the exact value `append` appends. */
  readonly systemPromptMode?: string;
}

/** v2's `SYSTEM_PROMPT` / `SYSTEM_PROMPT_IS_DEFAULT` /
 * `SYSTEM_PROMPT_ADDENDUM` globals. */
export interface SystemPromptState {
  readonly systemPrompt: string;
  /** The bundled default is in use, so the fragment placeholders exist. */
  readonly isDefault: boolean;
  /** Append-mode operator prompt, composed on after fragment assembly. */
  readonly addendum: string;
}

/** Port of `resolve_system_prompt`. Throws `SystemPromptFileError` for a
 * configured `SYSTEM_PROMPT_FILE` that is not a regular file (v2: `error` +
 * `exit 1`). */
export function resolveSystemPrompt(
  settings: SystemPromptSettings,
  workspace: PromptWorkspace,
  assets: PromptAssets = BUNDLED_PROMPT_ASSETS,
): SystemPromptState {
  const inline = settings.systemPrompt ?? "";
  const file = settings.systemPromptFile ?? "";
  const mode = settings.systemPromptMode || "replace";
  let user = "";
  if (file !== "") {
    if (!workspace.isFile(file)) throw new SystemPromptFileError(`SYSTEM_PROMPT_FILE does not exist: ${file}`);
    const bytes = workspace.readBytes(file);
    if (bytes === null) throw new SystemPromptFileError(`SYSTEM_PROMPT_FILE could not be read: ${file}`);
    user = bashReadCapture(bytes);
    if (inline !== "") user = `${user}\n\n${inline}`;
  } else if (inline !== "") {
    user = inline;
  }
  if (user !== "" && mode !== "append") return { systemPrompt: user, isDefault: false, addendum: "" };
  return { systemPrompt: bashCapture(assets.defaultSystemPrompt), isDefault: true, addendum: user };
}

/** Dials `apply_system_prompt_fragments` reads from the environment. Raw
 * values; case and trailing newlines are normalized as v2 does. */
export interface FragmentDials {
  /** `related-code-context`; v2 default `true`. */
  readonly relatedCodeContext?: string;
  /** `pr-thread-context`; v2 default `true`. */
  readonly prThreadContext?: string;
  /** `review-verbosity`; `concise` substitutes the brevity fragment. */
  readonly reviewVerbosity?: string;
}

/** `"$(<fragment) "` — the guidance plus the separating space. */
function guidance(assets: PromptAssets, name: string): string {
  return `${bashCapture(rawFragment(assets, name))} `;
}

/** Port of `apply_system_prompt_fragments`. Dials left empty take the
 * config.sh defaults (`RELATED_CODE_CONTEXT`/`PR_THREAD_CONTEXT` = true). */
export function applySystemPromptFragments(
  state: SystemPromptState,
  dials: FragmentDials,
  workspace: PromptWorkspace,
  assets: PromptAssets = BUNDLED_PROMPT_ASSETS,
): SystemPromptState {
  let prompt = state.systemPrompt;
  const sub = (placeholder: string, text: string) => {
    prompt = bashReplaceFirst(prompt, `{{${placeholder}}}`, text);
  };
  if (state.isDefault) {
    sub("RELATED_CODE_GUIDANCE", bashLowerCapture(dials.relatedCodeContext || "true") === "true" ? guidance(assets, "related_code") : "");
    sub("PR_THREAD_GUIDANCE", bashLowerCapture(dials.prThreadContext || "true") === "true" ? guidance(assets, "pr_thread") : "");
    sub("REVIEW_THREADS_GUIDANCE", workspace.isNonEmpty(PROMPT_PRESENCE_FILES.reviewThreads) ? guidance(assets, "review_threads") : "");
    sub("HUMAN_REVIEWS_GUIDANCE", workspace.isNonEmpty(PROMPT_PRESENCE_FILES.humanReviews) ? guidance(assets, "human_reviews") : "");
    sub("REQUIREMENT_LEDGER_GUIDANCE", workspace.isNonEmpty(PROMPT_PRESENCE_FILES.requirementLedger) ? guidance(assets, "requirement_ledger") : "");
    // Neutralized here; applySpecialistLeadsFragment appends the guidance
    // once the (later) presence signal exists.
    sub("SPECIALIST_LEADS_GUIDANCE", "");
    sub("VERBOSITY_GUIDANCE", bashLowerCapture(dials.reviewVerbosity || "normal") === "concise" ? guidance(assets, "concise") : "");
    prompt += CROSS_STEP_TRACE_GUIDANCE;
  }
  if (state.isDefault && workspace.isFile(PROMPT_PRESENCE_FILES.classification)) {
    const bytes = workspace.readBytes(PROMPT_PRESENCE_FILES.classification);
    const kind = bytes === null ? "" : jqRawPrKind(bytes.toString("utf8"));
    const infra = kind === "dependency_upgrade" || kind === "k8s_manifest";
    const digest = kind === "renovate_digest_only" || kind === "image_digest_only";
    sub("VERSION_BUMP_GUIDANCE", infra ? guidance(assets, "version_bump") : "");
    sub("IMAGE_DIGEST_GUIDANCE", digest ? guidance(assets, "image_digest") : "");
    sub("RELEASE_NOTES_GUIDANCE", infra || digest ? guidance(assets, "release_notes") : "");
  } else {
    // Also runs on a replace-mode operator prompt: v2 strips these three
    // placeholders (first occurrence) from any prompt text.
    sub("VERSION_BUMP_GUIDANCE", "");
    sub("IMAGE_DIGEST_GUIDANCE", "");
    sub("RELEASE_NOTES_GUIDANCE", "");
  }
  if (state.addendum !== "") prompt = `${prompt}\n\n${state.addendum}`;
  return { ...state, systemPrompt: prompt };
}

/** Port of `apply_specialist_leads_fragment`: appends the leads guidance as
 * its own line when the default prompt is in use and
 * `specialist-leads-present.txt` is non-empty; idempotent. */
export function applySpecialistLeadsFragment(
  state: SystemPromptState,
  workspace: PromptWorkspace,
  assets: PromptAssets = BUNDLED_PROMPT_ASSETS,
): SystemPromptState {
  if (!state.isDefault) return state;
  if (!workspace.isNonEmpty(PROMPT_PRESENCE_FILES.specialistLeads)) return state;
  const leads = bashCapture(rawFragment(assets, "specialist_leads"));
  if (leads === "") return state;
  if (state.systemPrompt.includes(leads)) return state;
  return { ...state, systemPrompt: `${state.systemPrompt}\n${leads}` };
}

/**
 * #874: the requirement-trace guidance, appended only when the
 * `requirement-trace` input is enabled AND the requirement ledger is
 * non-empty (the same presence signal `REQUIREMENT_LEDGER_GUIDANCE` gates) —
 * a bare instruction with no ledger to trace would be dead weight. Runs
 * alongside `applySystemPromptFragments` (same phase: both the dial and the
 * ledger presence file exist by then); idempotent like the other appended
 * (non-placeholder) fragments.
 */
export function applyRequirementTraceFragment(
  state: SystemPromptState,
  workspace: PromptWorkspace,
  enabled: boolean,
  assets: PromptAssets = BUNDLED_PROMPT_ASSETS,
  scopeIds?: readonly string[],
  distributedHints?: readonly { requirementId: string; groups: readonly string[] }[],
): SystemPromptState {
  if (!state.isDefault || !enabled) return state;
  if (!workspace.isNonEmpty(PROMPT_PRESENCE_FILES.requirementLedger)) return state;
  // #935: with a deterministic scope, ask only for the in-scope requirements
  // (none in scope: no trace instructions at all).
  if (scopeIds !== undefined && scopeIds.length === 0) return state;
  let trace = bashCapture(rawFragment(assets, "requirement_trace"));
  if (trace === "") return state;
  if (scopeIds !== undefined) {
    trace = trace.replace(
      "For every acceptance/normative requirement in the Requirement Ledger,",
      `For every requirement in trace scope (${scopeIds.join(", ")}); other ledger requirements need no trace,`,
    );
  }
  if (distributedHints && distributedHints.length > 0) {
    const cleanName = (name: string): string => name.replace(/[\x00-\x1f\x7f`]/g, "").slice(0, MAX_GROUP_NAME_CHARS);
    const hintLine = `Distributed requirements — cite one enforcement location and one matching test in each declared seam (a single location cannot satisfy them): ${distributedHints
      .slice(0, MAX_DISTRIBUTED_HINTS)
      .map((hint) => `\`${cleanName(hint.requirementId)}\` → ${hint.groups.slice(0, MAX_GROUPS_PER_RULE).map(cleanName).join(", ")}`)
      .join("; ")}`;
    trace += `\n${hintLine}`;
  }
  if (state.systemPrompt.includes(trace)) return state;
  return { ...state, systemPrompt: `${state.systemPrompt}\n${trace}` };
}

/**
 * #812: the superseded-discussion rule, appended v3-only after the corpus's
 * discussion sections exist (never by the v2-parity fragment assembly). The
 * current PR description and linked issues are authoritative context, and a
 * claim in earlier discussion they override is not a blocker — thread
 * comments older than the latest description edit are labeled
 * "earlier discussion (may be superseded by the current description)" in the
 * corpus, so this rule tells the reviewer what that label means.
 */
export const SUPERSEDED_DISCUSSION_GUIDANCE =
  "The current PR description and any linked issues are authoritative context and outrank the discussion sections: a claim in earlier discussion (PR conversation comments or review threads, including a comment labeled \"earlier discussion (may be superseded by the current description)\") that the current PR description or a linked issue overrides or supersedes is not a blocker and must not be cited as a merge gate.";

/** Append `SUPERSEDED_DISCUSSION_GUIDANCE` once, when the default prompt is
 * in use and the corpus carries discussion (the PR-thread or review-threads
 * section); idempotent. Operator replace-mode prompts are left untouched,
 * like every other fragment. */
export function applySupersededDiscussionFragment(
  state: SystemPromptState,
  workspace: PromptWorkspace,
): SystemPromptState {
  if (!state.isDefault) return state;
  if (state.systemPrompt.includes(SUPERSEDED_DISCUSSION_GUIDANCE)) return state;
  const hasDiscussion = workspace.isNonEmpty("pr-thread.md") || workspace.isNonEmpty("review-threads.md");
  if (!hasDiscussion) return state;
  return { ...state, systemPrompt: `${state.systemPrompt}\n${SUPERSEDED_DISCUSSION_GUIDANCE}` };
}
