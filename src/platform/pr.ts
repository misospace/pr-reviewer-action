/** PR identity / head-base normalization (#674). */

export interface PrIdentity {
  headSha: string;
  baseSha: string;
  headRepoFullName: string;
  baseRepoFullName: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Normalize a platform PR payload into the identity fields the precheck
 * decision needs (head/base SHAs and repo full names). Missing fields
 * normalize to "" — consumers must fail closed on empty values.
 */
export function normalizePrIdentity(raw: unknown): PrIdentity {
  const pr = asObject(raw);
  const head = asObject(pr.head);
  const base = asObject(pr.base);
  return {
    headSha: asString(head.sha),
    baseSha: asString(base.sha),
    headRepoFullName: asString(asObject(head.repo).full_name),
    baseRepoFullName: asString(asObject(base.repo).full_name),
  };
}

/**
 * The ONE fork derivation (#370 lineage): a missing/empty head repo full
 * name is treated as a fork — a present head against a missing base is
 * caught by head != base. Fork-ness gates Linear and other private-context
 * lookups while repo tokens are available, so an unknown origin MUST fail
 * closed. Mirrors `derive_is_fork_pr` (scripts/platform_api.sh) and its
 * Python mirror in build_selection_fingerprint.py.
 */
export function deriveIsFork(raw: unknown): boolean {
  const identity = normalizePrIdentity(raw);
  if (!identity.headRepoFullName) return true;
  return identity.headRepoFullName !== identity.baseRepoFullName;
}

/** Which side a caller should fail to when the draft state is uncertain. */
export type DraftState = "draft" | "not-draft" | "unknown";

/**
 * The ONE draft derivation (#961): a PR the forge reports as a draft is
 * never reviewed. `draft` is `true` only for an unambiguous draft (the
 * boolean the pulls APIs send, or the string form a shell/jq seam
 * produces), `not-draft` for an unambiguous non-draft — including an
 * absent field, mirroring the closed-PR check's treatment of a missing
 * `state` (the forge APIs always supply the flag; adapters that do not
 * surface it keep working) — and `unknown` when the payload carries a
 * draft value no forge ever sends. Callers decide which side uncertainty
 * fails to; the precheck fails closed.
 */
export function deriveDraftState(raw: unknown): DraftState {
  const value = asObject(raw).draft;
  if (value === true) return "draft";
  if (value === false) return "not-draft";
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return "draft";
    if (lowered === "false" || lowered === "") return "not-draft";
  }
  if (value === undefined || value === null) return "not-draft";
  return "unknown";
}
