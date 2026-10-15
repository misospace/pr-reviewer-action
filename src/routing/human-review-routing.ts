/** #1005: the deterministic reviewer-routing resolver.
 *
 * The model may decide WHICH configured review capability is needed (by
 * emitting a LOGICAL target id from `review_triage_targets`); trusted
 * configuration decides WHO that capability means. This pure function is the
 * boundary: it accepts only configured logical ids, resolves them to the
 * concrete GitHub users/teams declared in the trusted base-ref config, and
 * fails closed on every uncertain or inconsistent state — an unknown target,
 * a `not_required` answer carrying targets, or a target that resolves to no
 * identity all produce `invalid` and request nothing. It never contacts the
 * forge and never sees model prose; the model cannot name a concrete GitHub
 * identity anywhere in this path.
 */

import type { ReviewerRoutingTarget } from "../config/reviewer-routing.js";
import type { ReviewTriageDecision } from "../model/types.js";

export type HumanReviewRoutingMode = "off" | "advisory" | "request";

export type HumanReviewRoutingStatus =
  | "off"
  | "not_required"
  | "no_targets"
  | "invalid"
  | "advisory"
  | "request"
  | "requested"
  | "request_failed"
  | "fork_blocked";

export const HUMAN_REVIEW_ROUTING_STATUSES: readonly HumanReviewRoutingStatus[] = [
  "off",
  "not_required",
  "no_targets",
  "invalid",
  "advisory",
  "request",
  "requested",
  "request_failed",
  "fork_blocked",
];

export function isHumanReviewRoutingStatus(value: unknown): value is HumanReviewRoutingStatus {
  return typeof value === "string" && (HUMAN_REVIEW_ROUTING_STATUSES as readonly string[]).includes(value);
}

/** Statuses that must never cause a forge mutation. `request` is the only
 * status the publish step may act on. */
export const NON_MUTATING_ROUTING_STATUSES: readonly HumanReviewRoutingStatus[] = [
  "off",
  "not_required",
  "no_targets",
  "invalid",
  "advisory",
  "fork_blocked",
];

export interface HumanReviewRoutingPlan {
  mode: HumanReviewRoutingMode;
  status: HumanReviewRoutingStatus;
  /** Canonical configured logical ids the model selected (sorted). */
  targetIds: string[];
  /** Concrete GitHub logins from trusted configuration (deduped, sorted). */
  users: string[];
  /** Concrete GitHub team slugs from trusted configuration (deduped, sorted). */
  teams: string[];
  /** Bounded action-owned explanation; never model text. */
  detail: string;
}

function plan(
  mode: HumanReviewRoutingMode,
  status: HumanReviewRoutingStatus,
  detail: string,
  resolved: { targetIds?: string[]; users?: string[]; teams?: string[] } = {},
): HumanReviewRoutingPlan {
  return {
    mode,
    status,
    targetIds: resolved.targetIds ?? [],
    users: resolved.users ?? [],
    teams: resolved.teams ?? [],
    detail,
  };
}

/**
 * Resolve a routing plan from the triage answer and the trusted config.
 * Total and pure: every failure mode returns a non-mutating status.
 */
export function resolveHumanReviewRouting(input: {
  mode: HumanReviewRoutingMode;
  decision: ReviewTriageDecision;
  targets: readonly string[];
  config: ReadonlyMap<string, ReviewerRoutingTarget>;
  isForkPr: boolean;
}): HumanReviewRoutingPlan {
  const { mode, decision, targets, config, isForkPr } = input;
  if (mode === "off") return plan(mode, "off", "review-triage-routing is off");

  if (decision !== "required") {
    if (targets.length > 0) {
      return plan(mode, "invalid", "triage did not require specialized review, so named routing targets are ignored and no reviewer was requested");
    }
    return plan(mode, "not_required", "triage did not require specialized review");
  }

  if (targets.length === 0) {
    return plan(mode, "no_targets", "triage required specialized review but selected no configured routing target; no reviewer was requested");
  }

  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const raw of targets) {
    const key = raw.trim().toLowerCase();
    if (!config.has(key)) {
      return plan(mode, "invalid", "triage selected a routing target that is not configured; no reviewer was requested");
    }
    if (!seen.has(key)) {
      seen.add(key);
      canonical.push(key);
    }
  }
  canonical.sort();

  const users = new Set<string>();
  const teams = new Set<string>();
  for (const key of canonical) {
    const target = config.get(key);
    if (target === undefined) continue;
    for (const user of target.users) users.add(user);
    for (const team of target.teams) teams.add(team);
  }
  const userList = [...users].sort();
  const teamList = [...teams].sort();
  if (userList.length === 0 && teamList.length === 0) {
    return plan(mode, "invalid", "the configured routing targets resolved to no reviewers; no reviewer was requested");
  }

  const resolved = { targetIds: canonical, users: userList, teams: teamList };
  if (mode === "advisory") {
    return plan(mode, "advisory", "advisory mode: the configured reviewers are reported but none was requested", resolved);
  }
  if (isForkPr) {
    return plan(mode, "fork_blocked", "fork privilege separation: this is a fork pull request, so no reviewer was requested", resolved);
  }
  return plan(mode, "request", "requesting the configured reviewers", resolved);
}
