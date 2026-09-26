/** Corpus assembly migration (#676): typed, in-memory review-corpus
 * assembly with byte-exact v2 parity. See assemble.ts for the contract. */
export {
  buildBoundedRepoMap,
  buildReviewCorpus,
  gateFeatureForForks,
  prepareStandardsContext,
  prepareToolHarness,
  type CorpusBuildOptions,
  type CorpusBuildResult,
  type CorpusSlot,
  type CorpusTier,
  type CorpusWorkspace,
} from "./assemble.js";
export { BudgetError, resolveTierBudgets, type BudgetInputs, type TierBudgets } from "./budgets.js";
export { runCorpusFixture, runDiffPriorityFixture } from "./fixture.js";
export { replaceHarnessFindingsSection } from "./harness-section.js";
export { classificationLine, prMetadataLine, ProjectionError } from "./projections.js";
export { decodeUtf8Ignore, truncateClean } from "./truncate.js";
export {
  DEFAULT_DIFF_MARKER,
  MIN_CHUNK_BYTES,
  prioritizeDiff,
  rankPath,
  splitChunks,
  truncatePlain,
  type PrioritizeDiffOptions,
} from "./diff-priority.js";
