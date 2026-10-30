import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateContract } from "../src/config/contract.js";
import { validateInstanceConfig } from "../src/config/instance-config.js";
import {
  selectNamespacePolicy,
  validateNamespacePolicies,
  type NamespaceScope,
} from "../src/config/namespace-policy.js";

const contract = validateContract(parse(readFileSync("contracts/action-v3.yml", "utf8")));

function instance(overrides: Record<string, unknown> = {}) {
  return validateInstanceConfig(
    {
      version: 1,
      "model-profiles": [
        { name: "fast", endpoint: "http://model.internal:4000", "api-format": "openai", credential: "ref-a" },
      ],
      "default-model-profile": "fast",
      ...overrides,
    },
    contract,
  );
}

function policies(value: unknown) {
  return validateNamespacePolicies(value, contract);
}

const validPolicy = {
  name: "frontend",
  owners: ["frontend-org"],
  "reviewer-defaults": { "review-verbosity": "concise" },
};

test("a namespace policy round-trips and normalizes identities to lowercase", () => {
  const [policy] = policies([{ ...validPolicy, owners: ["Frontend-Org"], repositories: ["Frontend/Web"], "exclude-owners": ["Archive"], "exclude-repositories": ["Frontend/Legacy"] }]);
  assert.ok(policy);
  assert.equal(policy.name, "frontend");
  assert.deepEqual([...policy.owners], ["frontend-org"]);
  assert.deepEqual([...policy.repositories], ["frontend/web"]);
  assert.deepEqual([...policy.excludeOwners], ["archive"]);
  assert.deepEqual([...policy.excludeRepositories], ["frontend/legacy"]);
  assert.deepEqual({ ...policy.reviewerDefaults }, { "review-verbosity": "concise" });
  assert.equal(policy.requireSuggestedFix, false);
  assert.deepEqual([...policy.ignorePaths], []);
  assert.deepEqual([...policy.skipOnlyPaths], []);
  assert.deepEqual([...policy.reviewInstructions], []);
});

test("namespace policies are absent by default and empty lists are accepted", () => {
  assert.equal(instance().namespacePolicies.length, 0);
  assert.deepEqual([...policies([])], []);
  assert.deepEqual([...policies(undefined)], []);
});

test("unknown fields, bad names, and policies matching nothing fail closed", () => {
  assert.throws(() => policies([{ ...validPolicy, credential: "stolen" }]), /unsupported field 'credential'/);
  assert.throws(() => policies([{ ...validPolicy, name: "Bad_Name" }]), /must match/);
  assert.throws(() => policies([{ name: "x", "reviewer-defaults": {} }]), /must govern at least one account or repository/);
  assert.throws(() => policies("nope"), /must be a list/);
  assert.throws(() => policies([{ ...validPolicy, owners: [] }]), /must govern at least one account or repository/);
  assert.throws(() => policies([{ name: "x", owners: ["/etc/passwd"] }]), /must be a forge account/);
  assert.throws(() => policies([{ name: "x", owners: ["ok"], repositories: ["owner/name/extra"] }]), /'owner\/name' repository identity/);
});

test("duplicate identities — including case-variant duplicates — fail closed", () => {
  assert.throws(() => policies([{ name: "x", owners: ["dup", "dup"] }]), /duplicate identities/);
  assert.throws(() => policies([{ name: "x", owners: ["Dup", "dup"] }]), /duplicate identities/);
  assert.throws(() => policies([{ name: "x", repositories: ["a/b", "A/B"] }]), /duplicate identities/);
  // Self-exclusion inside one policy is well-defined (that identity never
  // matches) and allowed; the conflict logic works on effective claims.
});

test("an account or repository is governed by at most one policy (deterministic matching space)", () => {
  assert.throws(
    () => policies([validPolicy, { name: "other", owners: ["frontend-org"] }]),
    /policies 'frontend' and 'other' both govern account 'frontend-org'/,
  );
  assert.throws(
    () => policies([validPolicy, { name: "other", repositories: ["frontend-org/web"] }]),
    /policies 'frontend' and 'other' both match repository 'frontend-org\/web'/,
  );
  assert.throws(
    () => policies([
      { name: "one", repositories: ["a/b"] },
      { name: "two", repositories: ["a/b"] },
    ]),
    /policies 'one' and 'two' both match repository 'a\/b'/,
  );
  // Exclusions limit only the policy that declares them; they never resolve
  // a conflict between two policies.
  assert.throws(
    () => policies([
      validPolicy,
      { name: "other", owners: ["frontend-org"], "exclude-repositories": ["frontend-org/web"] },
    ]),
    /both govern account 'frontend-org'/,
  );
  // A policy carving a conflicting account out of its own claim does not
  // conflict: its effective claim set no longer contains the account.
  assert.doesNotThrow(() => policies([
    { name: "one", owners: ["a"] },
    { name: "two", owners: ["a", "b"], "exclude-owners": ["a"] },
  ]));
});

test("conflict detection is order-independent: the same policy set validates identically in any listing order", () => {
  const repoScoped = { name: "repo-scoped", repositories: ["acme/widgets"] };
  const accountScoped = { name: "account-scoped", owners: ["acme"] };
  assert.throws(() => policies([repoScoped, accountScoped]), /account-scoped.*repo-scoped|repo-scoped.*account-scoped/);
  assert.throws(() => policies([accountScoped, repoScoped]), /account-scoped.*repo-scoped|repo-scoped.*account-scoped/);
  // Mirror case: the repo-scoped policy's claim is dead — its own owner
  // exclusion kills the policy wholesale, exactly as the selector models it,
  // so the policy governs nothing and validation rejects it — in BOTH
  // orders, never order-dependently.
  const dead = { name: "dead", owners: ["acme"], "exclude-owners": ["acme"], repositories: ["acme/widgets"] };
  assert.throws(() => policies([dead, accountScoped]), /governs nothing after its own exclusions/);
  assert.throws(() => policies([accountScoped, dead]), /governs nothing after its own exclusions/);
  // A live policy whose repository entries live under an account another
  // policy excludes-only is not a conflict either way.
  const carveOut = { name: "carve-out", owners: ["acme"], "exclude-owners": ["acme"], repositories: ["other/repo"] };
  assert.doesNotThrow(() => policies([carveOut, accountScoped]));
  assert.doesNotThrow(() => policies([accountScoped, carveOut]));
});

test("a policy whose claims are entirely carved out by its own exclusions fails closed", () => {
  assert.throws(
    () => policies([{ name: "empty", owners: ["acme"], "exclude-owners": ["acme"] }]),
    /governs nothing after its own exclusions/,
  );
  assert.throws(
    () => policies([{ name: "empty", repositories: ["acme/widgets"], "exclude-owners": ["acme"] }]),
    /governs nothing after its own exclusions/,
  );
});

test("caps are enforced", () => {
  assert.throws(() => policies(Array.from({ length: 65 }, (_, i) => ({ name: `p${i}`, owners: ["a"] }))), /at most 64 entries/);
  assert.throws(() => policies([{ name: "x", owners: Array.from({ length: 257 }, (_, i) => `o${i}`) }]), /at most 256 entries/);
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "review-instructions": Array.from({ length: 17 }, () => "text") }]),
    /at most 16 blocks/,
  );
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "review-instructions": ["x".repeat(65_537)] }]),
    /at most 65536 bytes/,
  );
  assert.throws(
    () => policies([
      { name: "x", owners: ["a"], "review-instructions": ["x".repeat(60_000), "x".repeat(60_000)] },
      { name: "y", owners: ["b"], "review-instructions": ["x".repeat(60_000), "x".repeat(60_000)] },
    ]),
    /131072-byte total/,
  );
});

test("inline instruction blocks allow newlines and tabs but no other control characters", () => {
  const ok = policies([{ name: "x", owners: ["a"], "review-instructions": ["line one\nline two\ttabbed"] }]);
  assert.deepEqual([...ok[0]!.reviewInstructions], ["line one\nline two\ttabbed"]);
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "review-instructions": ["bad\u0000nul"] }]),
    /must not contain control characters/,
  );
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "review-instructions": ["bad\u001besc"] }]),
    /must not contain control characters/,
  );
});

test("path globs are repository-relative, bounded, and fail closed at the operator layer", () => {
  const ok = policies([{ name: "x", owners: ["a"], "ignore-paths": ["generated/**"], "skip-only-paths": "docs/**" }]);
  assert.deepEqual([...ok[0]!.ignorePaths], ["generated/**"]);
  assert.deepEqual([...ok[0]!.skipOnlyPaths], ["docs/**"]);
  assert.throws(() => policies([{ name: "x", owners: ["a"], "ignore-paths": ["/absolute"] }]), /repository-relative/);
  assert.throws(() => policies([{ name: "x", owners: ["a"], "ignore-paths": ["../escape"] }]), /repository-relative/);
  assert.throws(() => policies([{ name: "x", owners: ["a"], "ignore-paths": ["bad\u0000nul"] }]), /control characters/);
  assert.throws(() => policies([{ name: "x", owners: ["a"], "ignore-paths": Array.from({ length: 65 }, (_, i) => `p${i}/**`) }]), /at most 64 entries/);
});

test("reviewer-defaults reject everything beyond the trusted ceiling", () => {
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "reviewer-defaults": { "ai-api-key": "stolen" } }]),
    /is not a repo-configurable input/,
  );
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "reviewer-defaults": { "tool-mode": "native_loop" } }]),
    /is not a repo-configurable input/,
  );
  assert.throws(
    () => policies([{ name: "x", owners: ["a"], "reviewer-defaults": { "review-verbosity": "shouting" } }]),
    /must be one of/,
  );
  const ok = policies([{ name: "x", owners: ["a"], "reviewer-defaults": { "inline-findings-max": 5, "review-verbosity": "concise" } }]);
  assert.deepEqual({ ...ok[0]!.reviewerDefaults }, { "inline-findings-max": "5", "review-verbosity": "concise" });
});

test("the namespace-policies block fails instance validation closed", () => {
  assert.throws(
    () => instance({ "namespace-policies": [{ name: "Bad Name", owners: ["a"] }] }),
    (error: unknown) => error instanceof Error && /namespace-policies\[0\]\.name/.test(error.message),
  );
  const good = instance({ "namespace-policies": [validPolicy] });
  assert.equal(good.namespacePolicies.length, 1);
  assert.equal(good.namespacePolicies[0]!.name, "frontend");
});

test("selection is deterministic: owner match, repository refinement, carve-outs, no match", () => {
  const list = policies([
    { name: "web", owners: ["web-org"], "exclude-repositories": ["web-org/archive"], "reviewer-defaults": { "review-verbosity": "concise" } },
    { name: "mobile", repositories: ["mobile-org/app"] },
  ]);
  const pick = (owner: string, name: string): string | null => selectNamespacePolicy(list, { owner, name } satisfies NamespaceScope)?.name ?? null;
  assert.equal(pick("web-org", "api"), "web");
  assert.equal(pick("WEB-ORG", "API"), "web");
  assert.equal(pick("web-org", "archive"), null);
  assert.equal(pick("mobile-org", "app"), "mobile");
  assert.equal(pick("mobile-org", "other"), null);
  assert.equal(pick("unowned", "repo"), null);
});

test("ambiguous selection fails closed even for an unvalidated list", () => {
  // A validated instance can never produce two matching policies, but the
  // resolver still guards: hand it two structurally-complete policies that
  // both claim the same owner and it must throw rather than pick one.
  const rawPolicy = (name: string) => ({
    name,
    owners: ["a"],
    excludeOwners: [],
    repositories: [],
    excludeRepositories: [],
    reviewerDefaults: {},
    ignorePaths: [],
    skipOnlyPaths: [],
    reviewInstructions: [],
    requireSuggestedFix: false,
  });
  assert.throws(
    () => selectNamespacePolicy([rawPolicy("one"), rawPolicy("two")], { owner: "a", name: "b" }),
    /selection is ambiguous/,
  );
});
