/** Semantic-fixture read adapter (#706 PR 1) — the port of the
 * `_platform_fixture_*` seams in `scripts/platform_api.sh`.
 *
 * `scripts/eval_harness.py` materializes a fixture repository and sets
 * `SEMANTIC_FIXTURE_MODE=true` + `SEMANTIC_FIXTURE_DIR=<repo>`; every read
 * is then served from `<repo>/.semantic-fixture/` (`pr.json`, `diff`,
 * `files.json`) or from the same empty stubs the shell seam prints, so an
 * eval run never reaches a forge. One deliberate difference: v2's Python
 * `gh_api` tool seam is not fixture-aware and would reach the network; this
 * adapter's `ghApi` refuses instead (fixture mode is offline by design). */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeExternalChecks, type ExternalCheck } from "./normalize.js";
import type { ExternalChecksOptions, GhApiResult, ManagedComment, ManagedReview, PlatformReadAdapter, ReadResult } from "./types.js";

const FIXTURE_CHECK_RUNS = '{"check_runs":[],"total_count":0}\n';
const FIXTURE_COMMIT_STATUS = '{"statuses":[],"total_count":0,"state":"pending"}\n';

/** `_platform_fixture_enabled`: the fixture directory, or null. */
export function semanticFixtureDir(env: Readonly<Record<string, string | undefined>>): string | null {
  const dir = env.SEMANTIC_FIXTURE_DIR ?? "";
  return env.SEMANTIC_FIXTURE_MODE === "true" && dir !== "" ? dir : null;
}

export interface SemanticFixtureAdapterOptions {
  /** `SEMANTIC_FIXTURE_DIR`. */
  dir: string;
  /** Which forge the run is configured for; reads are identical either
   * way, only `repoPermission` differs (the shell does not intercept it). */
  platform?: "github" | "forgejo" | undefined;
}

export class SemanticFixtureAdapter implements PlatformReadAdapter {
  readonly platform: "github" | "forgejo";
  private readonly dir: string;

  constructor(options: SemanticFixtureAdapterOptions) {
    this.dir = options.dir;
    this.platform = options.platform ?? "github";
  }

  private async file(name: string): Promise<string> {
    return readFile(join(this.dir, ".semantic-fixture", name), "utf8");
  }

  private async json(name: string): Promise<ReadResult<unknown>> {
    try {
      return { ok: true, data: JSON.parse(await this.file(name)) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getPr(): Promise<unknown | null> {
    const result = await this.json("pr.json");
    return result.ok ? result.data : null;
  }

  async getPrDiff(): Promise<string> {
    try {
      return await this.file("diff");
    } catch {
      return "";
    }
  }

  async listIssueComments(): Promise<ManagedComment[]> {
    return [];
  }

  async listPrReviews(): Promise<ManagedReview[]> {
    return [];
  }

  /** Not intercepted by the shell seam: GitHub answers "unknown"; Forgejo
   * would query the API, which fixture mode never does. */
  async repoPermission(): Promise<string | null> {
    return this.platform === "github" ? "unknown" : null;
  }

  async ghApi(endpoint: string): Promise<GhApiResult> {
    return { error: `gh_api is unavailable in semantic fixture mode: ${endpoint}` };
  }

  listPrFiles(): Promise<ReadResult<unknown>> {
    return this.json("files.json");
  }

  /** `printf '{"number":%s,"title":"","state":"open","html_url":"",
   * "labels":[],"body":""}'` — the number is spliced in verbatim. */
  async getIssue(_repo: string, issueNumber: string): Promise<ReadResult<unknown>> {
    try {
      return { ok: true, data: JSON.parse(`{"number":${issueNumber},"title":"","state":"open","html_url":"","labels":[],"body":""}`) as unknown };
    } catch {
      return { ok: false, error: `invalid issue number: ${issueNumber}` };
    }
  }

  async listPrConversationComments(): Promise<ReadResult<unknown[]>> {
    return { ok: true, data: [] };
  }

  async listReviewThreads(): Promise<ReadResult<unknown[]>> {
    return { ok: true, data: [] };
  }

  async listPrReviewsPaginated(): Promise<ReadResult<unknown[]>> {
    return { ok: true, data: [] };
  }

  async externalChecks(_sha: string, options: ExternalChecksOptions = {}): Promise<ExternalCheck[] | null> {
    return normalizeExternalChecks(FIXTURE_CHECK_RUNS, FIXTURE_COMMIT_STATUS, options.runId ?? "", options.statusContext ?? "");
  }
}
