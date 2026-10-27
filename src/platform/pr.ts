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

/** Whether a PR is open or terminal (closed/merged), or the state is
 * unrecognizable. */
export type PrState = "open" | "closed" | "unknown";

/**
 * The ONE PR-state derivation (#1301): a terminal PR is never reviewed.
 * GitHub reports a merged pull request as `state: "closed"` (with
 * `merged_at` set), and the Forgejo adapter's GitHub-shaped normalization
 * keeps the API's `open`/`closed`, so `closed` is the single terminal value
 * that already covers a merged PR. A missing or unrecognizable `state` is
 * `unknown`, and each caller decides which side uncertainty fails to: the
 * shared review-admission gate fails closed (only an exact `open` is
 * reviewable), while the comment-command gate keeps its legacy read of
 * unknown-as-open (the pulls API always supplies one). Only an explicit
 * string `state` is authoritative.
 */
export function derivePrState(raw: unknown): PrState {
  const value = asObject(raw).state;
  if (typeof value !== "string") return "unknown";
  const state = value.toLowerCase();
  if (state === "closed") return "closed";
  if (state === "open") return "open";
  return "unknown";
}

/** Which side a caller should fail to when the draft state is uncertain. */
export type DraftState = "draft" | "not-draft" | "unknown";

/**
 * The ONE draft derivation (#961): a PR the forge reports as a draft is
 * never reviewed. Only an explicit boolean `draft` value is authoritative:
 * `true` → draft, `false` → not-draft (the Forgejo adapter normalizes its
 * payload to a boolean at the seam; the GitHub pulls API sends one). A
 * missing, null, or unrecognizable draft value is `unknown` — the caller
 * decides which side uncertainty fails to, and the precheck fails closed:
 * a PR whose reviewability cannot be PROVEN is not reviewed.
 */
export function deriveDraftState(raw: unknown): DraftState {
  const value = asObject(raw).draft;
  if (value === true) return "draft";
  if (value === false) return "not-draft";
  return "unknown";
}

/** Whether a PR is still accepting work, as the forge reports it. `unknown`
 * means the read proved nothing (a failed lookup) — the caller fails closed. */
export type PrOpenState = "open" | "closed" | "unknown";

/** One parity-safe PR-state reading: the open/closed half mirrors the
 * `comment-pr-closed` derivation in `src/precheck/decide.ts` (a merged PR is
 * reported `closed` by both forges, so `closed` covers merged), and the draft
 * half IS {@link deriveDraftState} — the ONE draft derivation (#961). */
export interface PrStateReading {
  state: PrOpenState;
  draft: DraftState;
}

/**
 * The ONE PR-state derivation (#1298): read open/closed + draft off a
 * platform PR object (the GitHub pulls-API shape; the Forgejo adapter
 * normalizes `state` and `draft` to it at the seam). Fail closed (#1310):
 * only an explicit `open`/`closed` string is authoritative — a missing,
 * non-string, or unrecognized `state` proves NOTHING and reads `unknown`,
 * exactly like a null (or otherwise unusable) object (a failed lookup):
 * both halves read `unknown`, and the caller fails closed. Mirrors the
 * #1301 admission doctrine: a PR whose state cannot be PROVEN is not
 * reviewable on `draft: false` alone. This layer is only as strict as its
 * inputs: the Forgejo seam now carries `state` and `draft` through verbatim
 * (#1303/#1307) — a partial Forgejo read reaches this derivation as
 * unprovable and fails closed here, never as a fabricated `open`.
 */
export function derivePrStateReading(raw: unknown): PrStateReading {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { state: "unknown", draft: "unknown" };
  }
  const value = asObject(raw).state;
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  const state: PrOpenState = normalized === "open"
    ? "open"
    : normalized === "closed"
    ? "closed"
    : "unknown";
  return { state, draft: deriveDraftState(raw) };
}
