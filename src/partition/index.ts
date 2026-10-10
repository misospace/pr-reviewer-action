/**
 * Deterministic partitioning foundation for the optional large-PR review mode
 * (#1026). Not yet wired into the running pipeline: this barrel exposes the
 * planner, coverage accounting and finding merge for the future per-partition
 * execution stage. See `docs/architecture/partitioned-review.md`.
 */

export * from "./types.js";
export * from "./plan.js";
export * from "./coverage.js";
export * from "./merge.js";
