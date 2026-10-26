/** Conversational PR follow-ups (#763): the forge-agnostic control plane the
 * Action path and the self-hosted operator path share. Reads/writes route
 * through the configured forge capability (the read seam and the publish seam),
 * never a forge CLI; the review pipeline itself is reused, never duplicated. */

export {
  classifyFollowUpComment,
  mentionsHandle,
  FOLLOWUP_REPLY_MARKER,
  type ClassifyFollowUpInput,
} from "./classify.js";
export {
  InMemoryRateLimitStore,
  MAX_RATE_LIMIT_KEYS,
  consumeFollowUpBudget,
  type RateLimitRule,
  type RateLimitScope,
  type RateLimitStore,
} from "./rate-limit.js";
export { renderFollowUpReply } from "./reply.js";
export {
  ForgeFollowUpBudget,
  type ForgeFollowUpBudgetOptions,
} from "./forge-budget.js";
export {
  buildFollowUpPrompt,
  FOLLOW_UP_PROMPT_MAX_BYTES,
  MANAGED_REVIEW_MAX_BYTES,
  QUESTION_MAX_BYTES,
  THREAD_MAX_BYTES,
  THREAD_MAX_COMMENTS,
  type FollowUpPromptContext,
} from "./prompt.js";
export {
  DEFAULT_FOLLOW_UP_RATE_LIMITS,
  planFollowUp,
  type FollowUpPlanConfig,
  type FollowUpPlanDeps,
  type FollowUpPlanRequest,
  type FollowUpRateLimits,
  type PermissionProbe,
} from "./plan.js";
export {
  FOLLOWUP_ANSWER_MAX_BYTES,
  runFollowUpEvent,
  type FollowUpEffects,
  type FollowUpRereviewDisposition,
  type FollowUpRunOutcome,
} from "./controller.js";
export {
  createFollowUpAnswerExecutor,
  FOLLOWUP_ANSWER_MAX_TOKENS,
  type FollowUpAnswerProfile,
  type FollowUpExecutorOptions,
} from "./executor.js";
export type {
  ClassifyResult,
  FollowUpIgnoreReason,
  FollowUpIntent,
  FollowUpPlan,
} from "./types.js";
