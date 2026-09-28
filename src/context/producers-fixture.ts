/** `node dist/index.js context-producers-fixture <fixture.json>`: the v3 side
 * of the `context-producers` parity boundary (#706 PR 3). One fixture runs
 * one deterministic producer against the harness-prepared worktree in
 * `PARITY_REPO_DIR` and prints `{ok, values}` with every artifact as
 * `file:<name>` — UTF-8 text when the bytes decode strictly, else
 * `!b64:<base64>` — the same encoding the v2 runner uses. Platform and Linear
 * reads are served from the fixture. */

import { readFileSync } from "node:fs";
import type { FetchLike } from "../platform/http.js";
import type { ReadResult } from "../platform/types.js";
import { buildManifestContext } from "./manifest-context.js";
import { buildRepoImpactHistory } from "./repo-impact.js";
import { buildLinkedIssueContext } from "./linked-issue-context.js";
import { resolveStandardsFile } from "./standards-file.js";
import { clipRelatedCodeMarkdown } from "./related-context.js";
import { requirementLedgerPresence } from "../requirements/presence.js";

type Content = string | { b64: string } | null | undefined;

interface ProducersFixture {
  fixture?: string;
  producer?: string;
  [key: string]: unknown;
}

type FixtureResult = { ok: true; values: Record<string, string> } | { ok: false; stderr: string };

function decodeContent(content: Content): Uint8Array | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return Buffer.from(content.b64, "base64");
}

export function encodeArtifact(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return `!b64:${Buffer.from(data).toString("base64")}`;
  }
}

function fileValues(artifacts: Map<string, Uint8Array>, names: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    const data = artifacts.get(name);
    values[`file:${name}`] = data === undefined ? "!absent" : encodeArtifact(data);
  }
  return values;
}

const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);

interface LinearResponse {
  json?: unknown;
  body?: string;
  status?: number;
}

function linearFetch(responses: Record<string, LinearResponse>): FetchLike {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body ?? "{}")) as { variables?: { id?: string } };
    const spec = responses[request.variables?.id ?? ""] ?? { status: 404 };
    if (spec.status !== undefined && (spec.status < 200 || spec.status >= 300)) {
      return new Response("", { status: spec.status });
    }
    const payload = spec.body !== undefined ? spec.body : JSON.stringify(spec.json ?? null);
    return new Response(payload, { status: spec.status ?? 200 });
  };
}

export async function runContextProducersFixture(fixturePath: string): Promise<FixtureResult> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ProducersFixture;
  const workspace = process.env.PARITY_REPO_DIR ?? process.cwd();
  switch (fixture.producer) {
    case "manifest": {
      let prFiles: unknown = fixture.pr_files_raw;
      if (typeof fixture.pr_files_raw_text === "string") {
        try {
          prFiles = JSON.parse(fixture.pr_files_raw_text);
        } catch {
          prFiles = undefined;
        }
      }
      const { artifacts } = buildManifestContext(prFiles, workspace);
      return { ok: true, values: fileValues(artifacts, ["manifest-context.md"]) };
    }
    case "repo-impact": {
      const { artifacts } = await buildRepoImpactHistory({
        pr: fixture.pr,
        versionHintsTruncated: decodeContent(fixture.version_hints as Content),
        workspace,
      });
      return {
        ok: true,
        values: fileValues(artifacts, [
          "terms.all.txt", "terms.txt", "repo-impact.truncated.md", "repo-history.truncated.md",
        ]),
      };
    }
    case "linked-issues": {
      const issues = (fixture.issues ?? {}) as Record<string, { data?: unknown; fail?: boolean }>;
      const linear = (fixture.linear ?? {}) as Record<string, unknown>;
      const getIssue = async (repo: string, number: string): Promise<ReadResult<unknown>> => {
        const spec = issues[`${repo}#${number}`];
        if (spec === undefined || spec.fail === true) return { ok: false, error: "fixture: issue fetch failed" };
        return { ok: true, data: spec.data ?? null };
      };
      try {
        const result = await buildLinkedIssueContext({
          pr: fixture.pr,
          repo: text(fixture.repo),
          adapter: { getIssue },
          isForkPr: text(fixture.is_fork_pr),
          linear: {
            apiKey: text(linear.api_key),
            prefixes: text(linear.prefixes),
            timeoutSec: text(linear.timeout, "20"),
            enableForForks: text(linear.enable_for_forks, "false"),
            fetchImpl: linearFetch((linear.responses ?? {}) as Record<string, LinearResponse>),
          },
        });
        return {
          ok: true,
          values: fileValues(result.artifacts, [
            "linked-issues.json", "linked-issues.md", "linear-issues.json", "linear-issues.md", "linked-metadata-status.json",
          ]),
        };
      } catch (error) {
        return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
      }
    }
    case "ledger-signal": {
      const { artifacts } = requirementLedgerPresence(
        decodeContent(fixture.ledger_md as Content),
        decodeContent(fixture.ledger_json as Content),
        Number(fixture.max_corpus),
      );
      return {
        ok: true,
        values: fileValues(artifacts, [
          "requirement-ledger.json", "requirement-ledger.md", "requirement-ledger-present.txt", "requirement-ledger.section.md",
        ]),
      };
    }
    case "standards": {
      const resolved = resolveStandardsFile({
        standardsFile: text(fixture.standards_file),
        candidates: text(fixture.candidates),
        workspace,
      });
      return { ok: true, values: { standards_file: resolved } };
    }
    case "related-clip": {
      const markdown = decodeContent(fixture.markdown as Content) ?? new Uint8Array(0);
      const clipped = clipRelatedCodeMarkdown(markdown, Number(fixture.max_bytes));
      const artifacts = new Map<string, Uint8Array>([
        ["related-code.md", clipped === null ? new Uint8Array(0) : markdown],
        ["related-code.truncated.md", clipped ?? new Uint8Array(0)],
      ]);
      return { ok: true, values: fileValues(artifacts, ["related-code.md", "related-code.truncated.md"]) };
    }
    default:
      return { ok: false, stderr: `unknown producer '${String(fixture.producer)}'` };
  }
}
