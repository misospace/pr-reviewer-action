import type { FetchLike } from "../platform/http.js";
import type { GhApiResult, ManagedComment, ManagedReview, PlatformAdapter } from "../platform/types.js";
import { type LinkedIssue } from "../context/types.js";
import { runPrecheck, type PrecheckOutput } from "./decide.js";
import { extractIssueIdentifiers, LINEAR_PRIORITY_LABELS, type CollectResult } from "./linear.js";

/** Fixture-driven precheck for the #673 parity harness (#674): a
 * PlatformAdapter whose responses come from the fixture JSON, plus the CLI
 * entry both the v3 parity runner and tests-v3 use. The fixture adapter
 * consumes the SAME platform responses the v2 runner replays through its
 * gh/curl stubs, so both implementations observe identical platform state. */

export interface PrecheckFixture {
  fixture?: string;
  description?: string;
  env: Record<string, string>;
  event?: { name?: string; action?: string; label?: string } | null | undefined;
  event_head_sha?: string | undefined;
  platform: {
    diff?: string;
    diff_error?: boolean;
    pr?: unknown;
    pr_error?: boolean;
    comments?: ManagedComment[];
    reviews?: ManagedReview[];
    permission?: string | null;
    permission_error?: boolean;
    /** Responses for the validated `ghApi` seam, keyed by endpoint. */
    gh_api?: Record<string, unknown>;
    /** Linear issue state for the selection signature, keyed by identifier. */
    linear?: Record<string, { title?: string; body?: string; state?: string; url?: string; priority?: number; labels?: string[] } | undefined>;
    /** Identifiers whose Linear lookup fails (conservative sentinel path). */
    linear_fail?: string[];
  };
}

export class FixtureAdapter implements PlatformAdapter {
  readonly platform: "github" | "forgejo";
  private readonly spec: PrecheckFixture["platform"];

  constructor(platform: "github" | "forgejo", spec: PrecheckFixture["platform"]) {
    this.platform = platform;
    this.spec = spec;
  }

  async getPr(): Promise<unknown | null> {
    if (this.spec.pr_error) return null;
    return this.spec.pr ?? null;
  }

  async getPrDiff(): Promise<string> {
    if (this.spec.diff_error) return "";
    return this.spec.diff ?? "";
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    return this.spec.comments ?? [];
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    return this.spec.reviews ?? [];
  }

  async repoPermission(): Promise<string | null> {
    if (this.spec.permission_error) return null;
    return this.spec.permission ?? null;
  }

  async ghApi(endpoint: string): Promise<GhApiResult> {
    const responses = this.spec.gh_api ?? {};
    if (Object.hasOwn(responses, endpoint)) {
      const value = responses[endpoint];
      if (typeof value === "object" && value !== null && !Array.isArray(value) && "error" in (value as Record<string, unknown>)) {
        return { error: String((value as Record<string, unknown>).error) };
      }
      return { data: value };
    }
    return { error: `no fixture response for endpoint: ${endpoint}` };
  }
}

/** Build a fixture-driven Linear collector mirroring the v2 runner's
 * `sitecustomize` stub: configured identifiers resolve to the fixture's
 * issue state, `linear_fail` identifiers raise the same error category. */
export function fixtureLinearCollector(spec: PrecheckFixture["platform"]): (title: string, prefixes: string[], apiKey: string, options?: { timeout?: number | undefined; fetchImpl?: FetchLike | undefined } | undefined) => Promise<CollectResult> {
  const linearMap = spec.linear ?? {};
  const linearFail = new Set(spec.linear_fail ?? []);
  return async (_title, prefixes) => {
    const issues: LinkedIssue[] = [];
    const errors: [string, string][] = [];
    for (const identifier of extractIssueIdentifiers(_title, prefixes)) {
      if (linearFail.has(identifier)) {
        errors.push([identifier, `Linear issue ${identifier} fetch failed (fixture)`]);
        continue;
      }
      const issue = linearMap[identifier];
      if (!issue) {
        errors.push([identifier, `Linear issue ${identifier} was not found`]);
        continue;
      }
      const priority = typeof issue.priority === "number" && issue.priority in LINEAR_PRIORITY_LABELS ? issue.priority : null;
      issues.push({
        source: "linear",
        ref: identifier,
        repo: "",
        number: 0,
        title: String(issue.title ?? ""),
        body: String(issue.body ?? ""),
        url: String(issue.url ?? ""),
        state: String(issue.state ?? ""),
        priority,
        priorityLabel: priority !== null ? LINEAR_PRIORITY_LABELS[priority] ?? "" : "",
        labels: (issue.labels ?? []).map((name) => ({ name: String(name) })),
      });
    }
    return { issues, errors };
  };
}

export async function runPrecheckFixture(fixturePath: string): Promise<{ ok: boolean; values?: PrecheckOutput; stderr?: string }> {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as PrecheckFixture;
  const platform = fixture.env.PLATFORM === "forgejo" || fixture.env.FORGEJO_API_URL
    ? "forgejo" as const
    : "github" as const;
  const adapter = new FixtureAdapter(platform, fixture.platform ?? {});
  try {
    const output = await runPrecheck({
      env: fixture.env ?? {},
      adapter,
      event: fixture.event ?? undefined,
      eventHeadSha: fixture.event_head_sha,
      linearCollect: fixtureLinearCollector(fixture.platform ?? {}),
    });
    return { ok: true, values: output };
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}

/** The parity-relevant v2 output surface for a fixture, used by tests-v3 to
 * assert against the same key set the v2 GITHUB_OUTPUT file carries. */
export function outputKeys(output: PrecheckOutput): string[] {
  return Object.keys(output).sort();
}

// Re-exported output key surface used by tests-v3.

