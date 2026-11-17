import type { FetchLike } from "../platform/http.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import { giteaAdapterFromEnv } from "../platform/gitea.js";
import { forgejoTokenFromEnv } from "../platform/forgejo-auth.js";
import { GitHubAdapter } from "../platform/github.js";
import { declaredForgeId, resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend, tangledContextFromEnv } from "../platform/tangled.js";
import { TangledAdapter } from "../platform/tangled-adapter.js";
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
  // Tangled (#585) is the first read-only backend, so it is built here instead
  // of failing at the guard below: it resolves the run's pull from the DID in
  // the stage env and projects it into the GitHub-REST shape, and every
  // non-metadata read fails closed rather than driving a GitHub/Forgejo
  // fallback.
  if (platform === "tangled") {
    return new TangledAdapter({
      context: tangledContextFromEnv(env),
      // The run workspace (the Spindle checkout of the pull's selected
      // round) is the Git read surface the reviewed diff/files are derived
      // from (#1690). The run directory carries the resolved review
      // identity to the publication boundary (#1695 TOCTOU).
      ...(env.GITHUB_WORKSPACE !== undefined ? { workspace: env.GITHUB_WORKSPACE } : {}),
      ...(env.PR_REVIEWER_RUN_DIR !== undefined ? { runDir: env.PR_REVIEWER_RUN_DIR } : {}),
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
  }
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
    // #1678/#1681 review: Gitea is the same wire family, so it gets the
    // Forgejo-family adapter with the Gitea identity through `giteaAdapterFromEnv`
    // — the factory that refuses the Forgejo-only auth settings BEFORE the
    // adapter is constructed: `giteaTokenFromEnv(env)` raises on a declared
    // `FORGEJO_AUTH_METHOD=authorized_integration` or a set
    // `FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE`, and the adapter's own
    // constructor guard repeats the refusal under the Gitea identity. The
    // method/audience are absent from these options because the identity has
    // one auth mode — never because a declared integration config degrades to
    // token mode here.
    if (declaredForgeId(env.PLATFORM, "forgejo") === "gitea") {
      return giteaAdapterFromEnv(env, repo, prNumber, fetchImpl);
    }
    return new ForgejoAdapter({
      repo,
      prNumber,
      baseUrl: env.FORGEJO_API_URL ?? "",
      token: forgejoTokenFromEnv(env),
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
