/** #1093: the forge-agnostic owner-identity policy shared by the precheck
 * skip/carry-forward path, the publish cleanup gate, and the Forgejo sticky
 * comment. Two proof kinds exist:
 *
 * - `login` — the forge-reported login of the authenticated account, proven
 *   by an identity read (GitHub GraphQL viewer / REST `/user`, Forgejo
 *   `/user`). Compared trimmed and case-insensitively (both forges enforce
 *   case-insensitive username uniqueness, #970).
 * - `userId` — the Forgejo Authorized Integration audience's owner id
 *   (`u:<id>:<uuid>`, the same proof `ForgejoPublishApi` already trusts for
 *   sticky-comment ownership). The id is the ONLY authoritative signal: a
 *   candidate's login is never compared against a user-id identity, because
 *   a repo-scoped integration JWT may not resolve to any login at all.
 *
 * Every matcher fails closed: an unproven identity or an unusable candidate
 * never matches. Diagnostic reason codes are bounded lowercase enums plus
 * HTTP status digits only — never user, network, token, or body content.
 */

export type TrustedOwnerIdentity =
  | { kind: "login"; login: string }
  | { kind: "userId"; userId: string };

/** Outcome of a trusted-owner resolution: the identity (or null when
 * unproven) plus a bounded diagnostic reason from the fixed enum. */
export interface IdentityResolution {
  identity: TrustedOwnerIdentity | null;
  reason: string;
}

/** Forgejo generates integration audiences as `u:<owner ID>:<UUID>`
 * (moved verbatim from `publish-api.ts`, #1093). */
export function integrationOwnerIdFromAudience(audience: string | undefined): string | null {
  const match = /^u:([1-9]\d*):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(audience ?? "");
  return match?.[1] ?? null;
}

/** #1093: a forge-reported user id in its canonical positive-integer string
 * form. A safe positive integer number or a `^[1-9]\d*$` string canonicalizes;
 * anything else (including `0`, negative, non-numeric, or zero-padded strings)
 * is unproven. */
export function canonicalUserId(value: unknown): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}

/** A user object that carries at least one usable identity signal (a
 * non-empty login or a canonical user id). Adapters use this to distinguish
 * "unproven but well-formed" rows from rows the forge did not attribute at
 * all, which fail closed. */
export function hasUsableOwner(user: { login?: unknown; id?: unknown } | null | undefined): boolean {
  if (user === null || typeof user !== "object") return false;
  const login = (user as { login?: unknown }).login;
  if (typeof login === "string" && login.trim() !== "") return true;
  return canonicalUserId((user as { id?: unknown }).id) !== null;
}

/** #1093: does a forge-reported `user` object belong to the trusted owner
 * identity? False whenever the identity or the user is absent/unusable —
 * uncertain ownership never matches. Login-kind compares trimmed logins
 * case-insensitively; user-id-kind compares canonical positive-integer ids
 * and NEVER falls back to the login (the id is the authoritative proof). */
export function ownerMatchesIdentity(
  user: { login?: unknown; id?: unknown } | null | undefined,
  identity: TrustedOwnerIdentity | null | undefined,
): boolean {
  if (identity === null || identity === undefined) return false;
  if (user === null || typeof user !== "object") return false;
  if (identity.kind === "userId") {
    const id = canonicalUserId((user as { id?: unknown }).id);
    return id !== null && id === identity.userId;
  }
  const login = (user as { login?: unknown }).login;
  if (typeof login !== "string" || login.trim() === "") return false;
  if (identity.login.trim() === "") return false;
  return login.trim().toLowerCase() === identity.login.trim().toLowerCase();
}
