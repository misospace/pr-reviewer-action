/** Shared comment-command authority (#914, generalized for #763).
 *
 * The forge API that answers "may this user drive the reviewer?" returns a
 * repository-collaborator permission record. Both the shipped `/ai-review`
 * comment command (`src/precheck/decide.ts`) and the conversational follow-up
 * planner (#763) gate REVIEW work on the SAME triage-or-higher bar, so that
 * decision lives here once: the precheck and the follow-up planner parse the
 * payload with the same function and classify it with the same predicate, and
 * the two comment-driven review paths can never drift into different bars.
 * (The separate #762 reaction-feedback suppression gate reads the same forge
 * endpoint for a different purpose and is intentionally out of scope here.)
 *
 * Pure and side-effect free: it never performs I/O and never throws for any
 * value shape — an unusable payload reads as `null` ("unknown"), which every
 * caller fails closed on. A comment (or the permission record it triggers) is
 * data the forge reports, never a self-authorization.
 */

/** The repository permission levels that authorize comment-driven reviewer
 * work — the `permission` field of the collaborator-permission API at
 * triage-or-higher: `write`/`maintain`/`admin` on GitHub, `write`/`admin`/
 * `owner` on Forgejo. A GitHub `triage` user arrives as `permission: "read"`
 * (the API collapses maintain→write and triage→read in the legacy
 * `permission` field), so the un-collapsed `role_name` is the second signal;
 * anything else (`read`, `none`, or an unrecognized value) fails closed. */
const AUTHORIZED_PERMISSIONS: ReadonlySet<string> = new Set([
  "admin",
  "maintain",
  "write",
  "triage",
  "owner",
]);

/** `role_name` values that prove triage-or-higher when the collapsed legacy
 * `permission` says `read`. Custom roles are deliberately NOT authorized
 * here — an unrecognizable role cannot prove the bar. */
const AUTHORIZED_ROLE_NAMES: ReadonlySet<string> = new Set([
  "triage",
  "triage_plus",
]);

/** How the permission response names its own subject: `absent` (schema-allowed
 * and nothing provable is wrong with it), `named` (with a well-formed `login`),
 * or `unusable` (a subject that is not a well-formed user object with a
 * non-empty string login — unverifiable, so it fails closed exactly like a
 * mismatched one). */
export type AuthoritySubject = "absent" | "named" | "unusable";

/** The parsed, forge-neutral collaborator-permission reading. `permission` and
 * `roleName` are already lowercased; `subjectLogin` is present ONLY under
 * `named` (never an `undefined` value under `exactOptionalPropertyTypes`).
 * This is the SAME reading shape the publish seam reports from
 * `collaboratorPermission()` (`src/platform/publish-api.ts`), so a follow-up
 * planner may read through either seam and classify identically. */
export interface AuthorityReading {
  /** Lowercased `permission` as the forge reported it. */
  permission: string;
  /** Lowercased `role_name`; "" when the response carries none. */
  roleName: string;
  subject: AuthoritySubject;
  /** Lowercased login the response attributes the permission to (`named` only). */
  subjectLogin?: string;
}

/** `authorized` (triage-or-higher, subject proven or absent), `unauthorized`
 * (proven read/none), or `unknown` (any uncertainty — a lookup failure, a
 * missing/non-string permission, a subject that names someone other than the
 * actor, an unusable subject, or an unrecognized permission value). Callers
 * act ONLY on `authorized`; they distinguish the skip wording between
 * `unauthorized` and `unknown` but never authorize on `unknown`. */
export type AuthorityDecision = "authorized" | "unauthorized" | "unknown";

/** Parse a raw collaborator-permission API payload (the `data` of the
 * read-only `ghApi` seam, or the object a forge returns from its permission
 * endpoint) into an `AuthorityReading`, or `null` when the payload proves
 * nothing (not an object, an array, or a missing/non-string `permission`).
 *
 * The subject is classified exactly as the publish seam does so the two read
 * paths agree: an absent subject is `absent`; a subject that is a well-formed
 * user object with a non-empty string login is `named` (login lowercased);
 * anything else that is present-but-malformed (a bare string, an array, an
 * object without a usable login) is `unusable`. */
export function authorityReadingFromPayload(data: unknown): AuthorityReading | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.permission !== "string") return null;
  const permission = record.permission.toLowerCase();
  const roleName = typeof record.role_name === "string" ? record.role_name.toLowerCase() : "";
  const subject = record.user;
  if (subject === null || subject === undefined) {
    return { permission, roleName, subject: "absent" };
  }
  const subjectLogin =
    typeof subject === "object" && !Array.isArray(subject)
      ? (subject as Record<string, unknown>).login
      : undefined;
  if (typeof subjectLogin !== "string" || subjectLogin === "") {
    return { permission, roleName, subject: "unusable" };
  }
  return { permission, roleName, subject: "named", subjectLogin: subjectLogin.toLowerCase() };
}

/** Decide the authority of `actorLogin` from a parsed reading.
 *
 * `actorLogin` is the login whose permission was looked up. A reading that
 * names a DIFFERENT subject than the actor can never authorize the actor — an
 * echo of the caller's own permission, or a response about somebody else, is
 * unverifiable and fails closed (`unknown`); so is an unusable subject. Logins
 * are compared case-insensitively, safe on both forges because GitHub and
 * Forgejo enforce case-insensitive username uniqueness. The permission set is
 * checked ONLY after the subject is proven consistent, so a mismatched subject
 * never authorizes even when the `permission` value itself is high enough.
 *
 * A `null` reading is `unknown` by definition (the read proved nothing). */
export function classifyCommentAuthority(
  reading: AuthorityReading | null,
  actorLogin: string,
): AuthorityDecision {
  if (reading === null) return "unknown";
  if (reading.subject === "unusable") return "unknown";
  if (reading.subject === "named") {
    const login = reading.subjectLogin;
    if (typeof login !== "string" || login === "" || login !== actorLogin.toLowerCase()) {
      return "unknown";
    }
  }
  if (AUTHORIZED_PERMISSIONS.has(reading.permission)) return "authorized";
  if (reading.permission === "read" && AUTHORIZED_ROLE_NAMES.has(reading.roleName)) {
    // GitHub's collapsed shape for a triage user: permission "read",
    // role_name "triage". Only the role name can prove the bar.
    return "authorized";
  }
  if (reading.permission === "read" || reading.permission === "none") return "unauthorized";
  // An unrecognized permission value is not a lower bar to clear — it proves
  // nothing about the actor, so it fails closed exactly like a failed lookup.
  return "unknown";
}

/** Convenience: parse a raw payload AND classify it in one step (the shape the
 * shipped precheck uses: it already holds the raw `ghApi` result). A read
 * error is represented by the caller passing `null` here, never a payload. */
export function decideAuthorityFromPayload(
  data: unknown,
  actorLogin: string,
): AuthorityDecision {
  return classifyCommentAuthority(authorityReadingFromPayload(data), actorLogin);
}
