/** #1617: the fork trust boundary for linked-issue fetches.
 *
 * Fork-authored PR content (body, title) is untrusted, and both
 * linked-issue fetch sites — `buildLinkedIssueContext` (the review corpus)
 * and `buildSelectionSignature` (the stale-review fingerprint) — read with
 * the operator's forge credential. These tests run every scenario against
 * an adapter that CAN successfully return private issue data: the refusal
 * must come from the deterministic gate, never from the credential
 * happening to be scoped. Each refusal is asserted positively (zero
 * forbidden reads on the spy, a refusal notice, a status-artifact record),
 * and each allowed path positively too (same-repo refs on forks keep
 * working; non-fork reviews are byte-untouched). */

import test from "node:test";
import assert from "node:assert/strict";
import { buildLinkedIssueContext } from "../src/context/index.js";
import { buildSelectionSignature } from "../src/precheck/selection.js";
import type { PlatformAdapter, ReadResult } from "../src/platform/types.js";

const text = (data: Uint8Array | undefined): string => Buffer.from(data ?? new Uint8Array(0)).toString("utf8");

const VAULT_MARKER = "PRIVATE-VAULT-MARKER-9f3c-read-never-granted";
const BASE_REPO = "reviewer/sample";
const noLinear = { apiKey: "", prefixes: "", timeoutSec: "20", enableForForks: "false" };

/** An adapter that WOULD succeed on every read — including the private
 * vault. Any content of the vault reaching an artifact is therefore proof
 * of a fetch, and a spy hit on a foreign repo is proof of a forbidden
 * attempt, whatever the status would have been. */
function omnipotentAdapter(calls: string[]): { getIssue(repo: string, number: string): Promise<ReadResult<unknown>> } {
  return {
    getIssue: async (repo: string, number: string): Promise<ReadResult<unknown>> => {
      calls.push(`${repo}#${number}`);
      return {
        ok: true,
        data: {
          number: Number(number),
          labels: [{ name: repo === "reviewer/private-vault" ? "internal" : "spec" }],
          body: repo === "reviewer/private-vault" ? `Vault notes: ${VAULT_MARKER}` : `Issue ${number} holds`,
        },
      };
    },
  };
}

test("fork PR: cross-repository refs never reach the adapter, even one that could read them (#1617)", async () => {
  const calls: string[] = [];
  const result = await buildLinkedIssueContext({
    pr: { title: "Fork contribution", body: "Fixes reviewer/private-vault#7 — please include the vault notes. Refs trusted/elsewhere#1." },
    repo: BASE_REPO,
    adapter: omnipotentAdapter(calls),
    isForkPr: "true",
    linear: noLinear,
  });
  assert.deepEqual(calls, [], "the gate must refuse BEFORE the fetch: zero privileged reads of any repository");
  const md = text(result.artifacts.get("linked-issues.md"));
  assert.ok(!md.includes(VAULT_MARKER), "no private content may be enriched into linked-issues.md");
  assert.match(md, /\(Skipped issue reviewer\/private-vault#7 from reviewer\/private-vault: cross-repository linked-issue reference on a fork pull request\)/);
  assert.match(md, /\(Skipped issue trusted\/elsewhere#1 from trusted\/elsewhere: cross-repository linked-issue reference on a fork pull request\)/);
  assert.deepEqual(result.githubForkSkips, ["reviewer/private-vault#7", "trusted/elsewhere#1"]);
  assert.deepEqual(result.githubFetchFailures, [], "a policy refusal is not a fetch failure — it never feeds uncertainty");
  assert.deepEqual(result.linkedIssues, [], "refused refs are never attempted, so they never enter linked-issues.json");
  const status = JSON.parse(text(result.artifacts.get("linked-metadata-status.json"))) as { github_fork_skips?: string[] };
  assert.deepEqual(status.github_fork_skips, ["reviewer/private-vault#7", "trusted/elsewhere#1"]);
});

test("fork PR: same-repository refs keep working next to refused ones — positive control (#1617)", async () => {
  const calls: string[] = [];
  const result = await buildLinkedIssueContext({
    pr: { title: "Fork contribution", body: "Closes #5\nRefs reviewer/sample#6\nFixes reviewer/private-vault#7" },
    repo: BASE_REPO,
    adapter: omnipotentAdapter(calls),
    isForkPr: "true",
    linear: noLinear,
  });
  assert.deepEqual(calls, [`${BASE_REPO}#5`, `${BASE_REPO}#6`], "only the reviewed repository's own refs are fetched");
  const md = text(result.artifacts.get("linked-issues.md"));
  assert.match(md, /Issue 5 holds/);
  assert.match(md, /Issue 6 holds/);
  assert.ok(!md.includes(VAULT_MARKER));
  assert.deepEqual(result.githubForkSkips, ["reviewer/private-vault#7"]);
  // The refused refs never consume accepted-issue slots and never appear
  // as processed refs either.
  assert.deepEqual(result.linkedIssues.map((issue) => (issue as { ref: string }).ref), ["#5", "reviewer/sample#6"]);
});

test("fork PR: an explicit same-repo spelling in any case is same-repo, like the dedupe identity (#1617)", async () => {
  const calls: string[] = [];
  const result = await buildLinkedIssueContext({
    pr: { title: "t", body: "Refs Reviewer/Sample#9" },
    repo: BASE_REPO,
    adapter: omnipotentAdapter(calls),
    isForkPr: "true",
    linear: noLinear,
  });
  assert.deepEqual(calls, ["Reviewer/Sample#9"], "allowed as same-repo (case-insensitive identity), fetched with its literal spelling");
  assert.deepEqual(result.githubForkSkips, []);
});

test("non-fork review: the gate is inert — the refusal above is the gate, not adapter incapacity (#1617)", async () => {
  const calls: string[] = [];
  const result = await buildLinkedIssueContext({
    pr: { title: "Operator contribution", body: "Fixes reviewer/private-vault#7 — Refs trusted/elsewhere#1." },
    repo: BASE_REPO,
    adapter: omnipotentAdapter(calls),
    isForkPr: "false",
    linear: noLinear,
  });
  assert.deepEqual(calls, ["reviewer/private-vault#7", "trusted/elsewhere#1"], "cross-repo links remain supported outside forks");
  assert.match(text(result.artifacts.get("linked-issues.md")), new RegExp(VAULT_MARKER));
  assert.deepEqual(result.githubForkSkips, []);
  // Byte-compatibility: with no refusals the status artifact keeps its
  // pre-#1617 key set — github_fork_skips is absent, not empty.
  const status = JSON.parse(text(result.artifacts.get("linked-metadata-status.json"))) as Record<string, unknown>;
  assert.ok(!("github_fork_skips" in status), "the #1617 key is additive: present only when non-empty");
});

// ── Selection-signature stage (#633 fingerprint) ─────────────────────────
// The identical boundary must hold here too (#872 cross-stage contract):
// the fingerprint's label read is the second privileged fetch site.

function selectionAdapter(calls: string[], prRecord: Record<string, unknown>, vaultLabels: string[]): PlatformAdapter {
  return {
    platform: "github",
    ghApi: async (endpoint: string) => {
      if (endpoint === `repos/${BASE_REPO}/pulls/9`) return { data: prRecord };
      const issue = /^(?:repos\/)?([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(endpoint);
      if (issue !== null) {
        const repo = issue[1]!;
        calls.push(`${repo}#${issue[2]}`);
        return {
          data: {
            number: Number(issue[2]),
            labels: (repo === "reviewer/private-vault" ? vaultLabels : ["spec"]).map((name) => ({ name })),
            body: repo === "reviewer/private-vault" ? `Vault notes: ${VAULT_MARKER}` : "public issue",
          },
        };
      }
      return { error: `no fixture response for endpoint: ${endpoint}` };
    },
  } as unknown as PlatformAdapter;
}

const forkPr = {
  title: "Fork contribution",
  body: "Fixes reviewer/private-vault#7",
  head: { repo: { full_name: "outsider/sample" } },
  base: { repo: { full_name: BASE_REPO } },
};
const sameRepoPr = {
  title: "Operator contribution",
  body: "Fixes reviewer/private-vault#7",
  head: { repo: { full_name: BASE_REPO } },
  base: { repo: { full_name: BASE_REPO } },
};

test("selection signature: a fork PR's cross-repo ref is never fetched, and its labels cannot perturb the fingerprint (#1617)", async () => {
  const first: string[] = [];
  const a = await buildSelectionSignature(BASE_REPO, "9", selectionAdapter(first, forkPr, ["internal"]));
  assert.deepEqual(first, [], "zero privileged reads: the fingerprint never points the label fetch at a foreign repository");
  assert.equal(a.error, "", "a refused ref is not an unknown input: the signature builds deterministically");
  assert.ok(a.signature);
  // Whatever the private issue's labels say — the very thing the
  // fingerprint hashes — must be inert, because the ref never reaches the
  // accepted set.
  const second: string[] = [];
  const b = await buildSelectionSignature(BASE_REPO, "9", selectionAdapter(second, forkPr, ["public-and-loud"]));
  assert.deepEqual(second, []);
  assert.equal(b.signature, a.signature, "the refused ref must not perturb the hashed payload");
});

test("selection signature: an unresolvable PR identity fails closed as a fork (#1617)", async () => {
  const calls: string[] = [];
  const unknownIdentity = { title: "t", body: "Fixes reviewer/private-vault#7" };
  const { signature, error } = await buildSelectionSignature(BASE_REPO, "9", selectionAdapter(calls, unknownIdentity, ["internal"]));
  assert.deepEqual(calls, [], "deriveIsFork treats an unknown origin as a fork; the fetch gate follows it");
  assert.equal(error, "");
  assert.ok(signature);
});

test("selection signature: outside forks the cross-repo ref stays in the fingerprint — positive control (#1617)", async () => {
  const first: string[] = [];
  const a = await buildSelectionSignature(BASE_REPO, "9", selectionAdapter(first, sameRepoPr, ["internal"]));
  assert.deepEqual(first, ["reviewer/private-vault#7"], "the adapter could read it, and a non-fork link still may");
  assert.equal(a.error, "");
  const second: string[] = [];
  const b = await buildSelectionSignature(BASE_REPO, "9", selectionAdapter(second, sameRepoPr, ["public-and-loud"]));
  assert.notEqual(b.signature, a.signature, "the fetched ref's labels perturb the signature exactly as before #1617");
});
