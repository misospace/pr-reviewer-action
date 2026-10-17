/** #727: the deterministic Renovate-style repository adoption policy.
 *
 * Operator mode reviews repositories the operator **adopts** centrally — no
 * per-repository workflow file. This module is the pure, total state machine
 * behind that decision: given the operator's adoption policy and a
 * repository's attributes, it returns the repository's adoption state and
 * the reason, with no I/O and no nondeterminism (same inputs → same
 * decision, always).
 *
 * The state ladder mirrors #727 exactly:
 *
 * ```text
 * discovered → eligible → adopted → enabled / disabled
 * ```
 *
 * Forge installation visibility is deliberately NOT an input here — #727:
 * "do not confuse forge installation visibility with review adoption".
 * Discovery is the controller reconciler's concern: it feeds every
 * repository an approved installation can *see* into this function, and the
 * ladder below decides what adoption means for each one. A repository that
 * never becomes eligible simply stays `discovered`.
 *
 * Precedence is fixed and narrow-only, mirroring the config layers:
 *
 * - the operator denylist beats everything (hard off);
 * - the mode gate (`all_allowed` / `allowlist` / `opt_in` / `opt_out`)
 *   decides eligibility; the allowlist only applies in `allowlist` mode;
 * - `discoveredDefault` decides whether an eligible repository is adopted
 *   automatically or held at `eligible`;
 * - repository config may only ever **disable** (`enabled: false`), never
 *   force-enable an adoption the operator policy did not grant.
 *
 * Identity strings are `owner/name` validated at the instance-config layer
 * (`parseRepoRef` rules); this module treats them as opaque, comparable
 * tokens. Validation lives with the config that owns the lists, so this
 * module stays dependency-free and trivially auditable.
 */

export type AdoptionMode = "all_allowed" | "allowlist" | "opt_in" | "opt_out";

export type AdoptionState = "discovered" | "eligible" | "adopted" | "enabled" | "disabled";

export interface AdoptionPolicy {
  readonly mode: AdoptionMode;
  /** Repositories explicitly allowed (`allowlist` mode only). */
  readonly allowlist: readonly string[];
  /** Repositories refused in every mode; the operator's hard off switch. */
  readonly denylist: readonly string[];
  /** What a newly discovered, policy-eligible repository does: `adopt`
   * walks it straight to adopted/enabled, `skip` holds it at `eligible`
   * until the operator acts. */
  readonly discoveredDefault: "adopt" | "skip";
}

export interface AdoptionRepository {
  /** `owner/name` (opaque, comparable). */
  readonly identity: string;
  /** The operator's explicit opt-in record for `opt_in` mode, made through
   * the controller API — never through repository config. */
  readonly operatorOptedIn: boolean;
  /** The operator's explicit opt-out record for `opt_out` mode. */
  readonly operatorOptedOut: boolean;
  /** The repository config file's `enabled` key resolved from the trusted
   * base tree; `null` when the repository has no config file (or the key is
   * absent). A repository may only ever narrow: `false` disables review,
   * `true` is never able to force-enable an ungranted adoption. */
  readonly repositoryConfigEnabled: boolean | null;
}

export interface AdoptionDecision {
  readonly state: AdoptionState;
  /** Bounded, human-readable reason — never echoes repository-controlled
   * content beyond the repository identity the caller supplied. */
  readonly reason: string;
}

/** Classify one repository against the operator's adoption policy. Pure and
 * total: every input combination produces a decision, and the same inputs
 * always produce the same decision (#727 "adoption/default/opt-out
 * semantics are deterministic"). */
export function decideAdoption(policy: AdoptionPolicy, repository: AdoptionRepository): AdoptionDecision {
  // 1. The operator denylist is the hard off switch in every mode: it beats
  //    the allowlist, the mode gate, and anything repository config says.
  if (policy.denylist.includes(repository.identity)) {
    return { state: "disabled", reason: "on the operator denylist" };
  }
  // 2. The mode gate decides eligibility.
  let eligibleReason: string;
  switch (policy.mode) {
    case "all_allowed":
      eligibleReason = "installation-wide adoption (all allowed repositories)";
      break;
    case "allowlist":
      if (!policy.allowlist.includes(repository.identity)) {
        return { state: "discovered", reason: "not on the operator allowlist" };
      }
      eligibleReason = "on the operator allowlist";
      break;
    case "opt_in":
      if (!repository.operatorOptedIn) {
        return { state: "discovered", reason: "awaiting explicit operator opt-in" };
      }
      eligibleReason = "explicitly opted in by the operator";
      break;
    case "opt_out":
      if (repository.operatorOptedOut) {
        return { state: "discovered", reason: "explicitly opted out by the operator" };
      }
      eligibleReason = "adopted by default unless the operator opts out";
      break;
  }
  // 3. Eligibility → adoption follows the operator's default for newly
  //    discovered repositories. Holding at `eligible` is the conservative
  //    default: nothing reviews until the operator acts.
  if (policy.discoveredDefault === "skip") {
    return { state: "eligible", reason: `${eligibleReason}; the operator default for newly discovered repositories is skip` };
  }
  // 4. Adoption → enabled/disabled. Repository config is the narrow-only
  //    bottom layer: it may switch review OFF for itself, never on.
  if (repository.repositoryConfigEnabled === false) {
    return { state: "disabled", reason: `${eligibleReason}; adopted, but repository config disabled review` };
  }
  return { state: "enabled", reason: eligibleReason };
}
