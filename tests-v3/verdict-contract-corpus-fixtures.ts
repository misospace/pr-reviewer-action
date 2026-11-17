/**
 * Shared fixtures for the #1678 corpus-lane contract e2e tests. Mirrors the
 * platform/ledger helpers `run.test.ts` uses (two in-scope MUST requirements
 * via a linked issue) so the corpus lanes run with a deterministic expected
 * requirement set, without re-reading the requirement machinery here.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformReadAdapter } from "../src/platform/types.js";

/** One distinctive phrase shared by requirement 1 and the diff, mirroring
 * `run.test.ts`'s REQUIREMENT_TRACE_MARKER applicability anchor. */
export const REQUIREMENT_FIXTURE_MARKER = "the source SHA and the target branch";

export function baseVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "approve",
    review_markdown: "Looks fine.\n",
    smart_review_requested: false,
    smart_review_reason: null,
    findings: [],
    requirement_coverage: null,
    required_check_dispositions: [],
    ...overrides,
  };
}

/** A PR linking issue #824 whose body carries TWO MUST acceptance lines:
 * the ledger holds two requirements and both stay in trace scope (the
 * shape `run.test.ts`'s #1044 repair fixture establishes). */
export function mockRunPlatform(): PlatformReadAdapter {
  return {
    platform: "github",
    getPr: () => Promise.resolve({
      number: 7,
      title: "Bind context resolution",
      body: "Closes #824.\n\nResolve review context from the right identity.\n",
      state: "open",
      draft: false,
      head: { sha: "a".repeat(40), ref: "feature" },
      base: { ref: "main" },
      user: { login: "someone" },
      changed_files: 1,
      additions: 1,
      deletions: 1,
      html_url: "https://github.com/o/r/pull/7",
    }),
    getPrDiff: () => Promise.resolve(
      "diff --git a/src/context.ts b/src/context.ts\n--- /dev/null\n+++ b/src/context.ts\n@@ -0 +1 @@\n+// resolution must compare the source SHA and the target branch against the resolved pull\n"
        + "diff --git a/src/publish.ts b/src/publish.ts\n--- a/src/publish.ts\n+++ b/src/publish.ts\n@@ -1 +1 @@\n-old\n+// the publish gate must log the repository identity plus the source SHA\n",
    ),
    listPrFiles: () => Promise.resolve({
      ok: true,
      data: [
        { filename: "src/context.ts", status: "added", additions: 1, deletions: 0, changes: 1 },
        { filename: "src/publish.ts", status: "modified", additions: 1, deletions: 1, changes: 2 },
      ],
    }),
    getIssue: () => Promise.resolve({
      ok: true,
      data: {
        number: 824,
        title: "resolve review context from repository identity",
        state: "open",
        html_url: "https://github.com/o/r/issues/824",
        labels: [],
        body: `Context resolution MUST bind to the repository identity plus ${REQUIREMENT_FIXTURE_MARKER}.\n`
          + "The publish gate MUST log the repository identity plus the source SHA.\n",
      },
    }),
    listPrConversationComments: () => Promise.resolve({ ok: true, data: [] }),
    listReviewThreads: () => Promise.resolve({ ok: true, data: [] }),
    listPrReviewsPaginated: () => Promise.resolve({ ok: true, data: [] }),
    listIssueComments: () => Promise.resolve([]),
    listPrReviews: () => Promise.resolve([]),
    repoPermission: () => Promise.resolve(null),
    authenticatedIdentity: () => Promise.resolve(null),
    ghApi: () => Promise.resolve({ error: "not served" }),
    externalChecks: () => Promise.resolve([]),
  } as unknown as PlatformReadAdapter;
}

/** The requirement IDs the ledger rendered inside a model request body
 * (`(req-<hash>) `text`` list items), in ledger order. */
export function ledgerRequirementIds(requestBody: string): string[] {
  const ids: string[] = [];
  const re = /\(req-([0-9a-f]{12})\)/g;
  for (let match = re.exec(requestBody); match !== null; match = re.exec(requestBody)) {
    const id = `req-${match[1]}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The run's authoritative expected IDs, read from the contract artifact. */
export function reqRowsFrom(runDir: string): string[] {
  const artifact = JSON.parse(readFileSync(join(runDir, "verdict-contract.json"), "utf8")) as { expected_ids: string[] };
  assert.ok(Array.isArray(artifact.expected_ids), "the run persists the closing-verdict contract");
  return artifact.expected_ids;
}

/** Wire-vocabulary coverage rows: satisfied with a grounded file/test pair. */
export function coverageRows(ids: readonly string[]): Array<Record<string, unknown>> {
  return ids.map((id) => ({
    requirement_id: id,
    status: "satisfied",
    evidence: [
      { kind: "file", ref: "src/context.ts:1", detail: "the changed line implements the requirement" },
      { kind: "test", ref: "tests-v3/verdict-contract-corpus.test.ts:1", detail: "this suite exercises the behavior" },
    ],
  }));
}

export function withRunDir(): { runDir: string; cleanup: () => void } {
  const runDir = mkdtempSync(join(tmpdir(), "v3-contract-corpus-"));
  return { runDir, cleanup: (): void => rmSync(runDir, { recursive: true, force: true }) };
}
