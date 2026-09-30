/** v3 prompt and message layer (#706 PR 4): system-prompt assembly, the
 * final-review user message, the model-failure notice and the
 * analysis-engine annotation, byte-exact against the v2 shell. */

export { BUNDLED_PROMPT_ASSETS, MissingPromptFragmentError, rawFragment, type PromptAssets } from "./assets.js";
export { bashCapture, jqRawPrKind, workspaceAt, type PromptWorkspace } from "./bash.js";
export {
  CROSS_STEP_TRACE_GUIDANCE,
  PROMPT_PRESENCE_FILES,
  SystemPromptFileError,
  applySpecialistLeadsFragment,
  applySupersededDiscussionFragment,
  applyRequirementTraceFragment,
  SUPERSEDED_DISCUSSION_GUIDANCE,
  applySystemPromptFragments,
  resolveSystemPrompt,
  type FragmentDials,
  type SystemPromptSettings,
  type SystemPromptState,
} from "./system-prompt.js";
export { USER_MESSAGE_BASE, UserMessageBuildError, buildUserMessage } from "./user-message.js";
export {
  MODEL_UNAVAILABLE_ENGINE,
  analysisEngineBase,
  annotateAnalysisEngine,
  handleModelFailure,
  modelFailureNoticeMarkdown,
  publicAnalysisEngine,
  type AnalysisEngineOrigin,
  type EngineRouting,
  type ModelFailureOutcome,
} from "./failure.js";
