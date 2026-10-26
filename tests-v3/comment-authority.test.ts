import test from "node:test";
import assert from "node:assert/strict";
import {
  authorityReadingFromPayload,
  classifyCommentAuthority,
  decideAuthorityFromPayload,
  type AuthorityReading,
} from "../src/precheck/comment-authority.js";

// #763: the shared comment-command authority — the SAME predicate the shipped
// `/ai-review` command (#914) and the follow-up planner use, so the two
// comment-driven review paths can never drift. These pin the pure predicate;
// the skip-reason behavior stays covered by precheck-comment-command.test.ts.

function reading(permission: string, extra: Partial<AuthorityReading> = {}): AuthorityReading {
  return { permission: permission.toLowerCase(), roleName: "", subject: "absent", ...extra };
}

test("triage-or-higher permissions authorize", () => {
  for (const permission of ["admin", "maintain", "write", "triage", "owner", "ADMIN", "Write"]) {
    assert.equal(classifyCommentAuthority(reading(permission), "alice"), "authorized", permission);
  }
});

test("a GitHub collapsed triage authorizes via role_name only", () => {
  assert.equal(classifyCommentAuthority(reading("read", { roleName: "triage" }), "alice"), "authorized");
  assert.equal(classifyCommentAuthority(reading("read", { roleName: "triage_plus" }), "alice"), "authorized");
  // A read with an unrelated or absent role cannot prove the bar.
  assert.equal(classifyCommentAuthority(reading("read"), "alice"), "unauthorized");
  assert.equal(classifyCommentAuthority(reading("read", { roleName: "deploy-bot" }), "alice"), "unauthorized");
});

test("proven read/none is unauthorized, an unrecognized value is unknown", () => {
  assert.equal(classifyCommentAuthority(reading("read"), "alice"), "unauthorized");
  assert.equal(classifyCommentAuthority(reading("none"), "alice"), "unauthorized");
  assert.equal(classifyCommentAuthority(reading("surprise"), "alice"), "unknown");
});

test("a null reading proves nothing → unknown", () => {
  assert.equal(classifyCommentAuthority(null, "alice"), "unknown");
});

test("the subject echo fails closed, but an absent or matching subject passes", () => {
  // A named subject matching the actor (case-insensitively) authorizes.
  const named = reading("admin", { subject: "named", subjectLogin: "alice" });
  assert.equal(classifyCommentAuthority(named, "Alice"), "authorized");
  // A named subject that is somebody else can never authorize the actor.
  assert.equal(classifyCommentAuthority(reading("admin", { subject: "named", subjectLogin: "ci-bot" }), "alice"), "unknown");
  // An unusable subject fails closed the same way.
  assert.equal(classifyCommentAuthority(reading("admin", { subject: "unusable" }), "alice"), "unknown");
  // The subject check precedes the permission set: a mismatched subject never
  // authorizes even when the permission value itself is high enough.
  assert.equal(classifyCommentAuthority(reading("write", { subject: "named", subjectLogin: "mallory" }), "alice"), "unknown");
});

test("authorityReadingFromPayload mirrors the seam's subject classification", () => {
  assert.equal(authorityReadingFromPayload(null), null);
  assert.equal(authorityReadingFromPayload([1, 2]), null);
  assert.equal(authorityReadingFromPayload({}), null);
  assert.equal(authorityReadingFromPayload({ role: "x" }), null);
  // Absent subject.
  assert.deepEqual(authorityReadingFromPayload({ permission: "Write" }), { permission: "write", roleName: "", subject: "absent" });
  // role_name lowercased.
  assert.deepEqual(authorityReadingFromPayload({ permission: "read", role_name: "Triage" }), { permission: "read", roleName: "triage", subject: "absent" });
  // Named subject, login lowercased.
  assert.deepEqual(authorityReadingFromPayload({ permission: "admin", user: { login: "Alice" } }), { permission: "admin", roleName: "", subject: "named", subjectLogin: "alice" });
  // Unusable subjects: bare string, array, object with no/non-string login.
  for (const user of ["alice", [{ login: "alice" }], {}, { login: 123 }, { login: "" }]) {
    const r = authorityReadingFromPayload({ permission: "admin", user });
    assert.equal(r?.subject, "unusable", JSON.stringify(user));
    assert.equal(r?.subjectLogin, undefined);
  }
});

test("decideAuthorityFromPayload composes parse + classify", () => {
  assert.equal(decideAuthorityFromPayload({ permission: "write" }, "alice"), "authorized");
  assert.equal(decideAuthorityFromPayload({ permission: "read" }, "alice"), "unauthorized");
  assert.equal(decideAuthorityFromPayload({ permission: "admin", user: { login: "other" } }, "alice"), "unknown");
  assert.equal(decideAuthorityFromPayload({ permission: 42 }, "alice"), "unknown");
});
