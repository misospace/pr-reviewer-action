import type { FetchLike } from "../platform/http.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import { GitHubAdapter } from "../platform/github.js";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import { SemanticFixtureAdapter, semanticFixtureDir } from "../platform/semantic-fixture.js";
import type { PlatformReadAdapter } from "../platform/types.js";
import type { StageEnv } from "./env.js";

/**
 * Real platform seam construction (#809): the adapter the orchestrator hands
 * to every context producer, built from the resolved run environment. GitHub
 * and Forgejo are first-class; the platform choice is the precheck's
 * resolved `PLATFORM` (auto → forgejo when FORGEJO_API_URL is set or the
 * server URL is non-github), never a capability conditional.
 *
 * Eval fixture mode (`SEMANTIC_FIXTURE_MODE=true` + `SEMANTIC_FIXTURE_DIR`)
 * intercepts first: every read is served from the fixture directory, the
 * same interception `scripts/platform_api.sh` performed for the harness's
 * semantic-corpus runs. Production runs never set those variables.
 */
export function buildPlatformReadAdapter(env: StageEnv, fetchImpl?: FetchLike): PlatformReadAdapter {
  const platform = resolvePlatform(env.PLATFORM, env.FORGEJO_API_URL ?? "", env.GITHUB_SERVER_URL ?? "", env.TANGLED_REPO_DID ?? "");
  // Fail closed before anything else — fixture interception included — the
  // same ordering `_platform_tangled_guard` gives the v2 shell seam.
  requireImplementedBackend(platform);
  const fixtureDir = semanticFixtureDir(env);
  if (fixtureDir !== null) {
    return new SemanticFixtureAdapter({ dir: fixtureDir, platform });
  }
  const repo = env.REPO!;
  const prNumber = env.PR_NUMBER!;
  if (platform === "forgejo") {
    return new ForgejoAdapter({
      repo,
      prNumber,
      baseUrl: env.FORGEJO_API_URL ?? "",
      token: env.FORGEJO_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
      ...(env.FORGEJO_AUTH_METHOD !== undefined ? { authMethod: env.FORGEJO_AUTH_METHOD } : {}),
      ...(env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE !== undefined
        ? { authorizedIntegrationAudience: env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE }
        : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
  }
  const token = env.GH_TOKEN ?? "";
  return new GitHubAdapter({
    repo,
    prNumber,
    ...(token ? { token: `Bearer ${token}` } : {}),
    ...(env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}),
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
}
