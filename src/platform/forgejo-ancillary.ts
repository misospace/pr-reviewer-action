import { ForgejoAdapter } from "./forgejo.js";
import { forgejoTokenFromEnv } from "./forgejo-auth.js";
import { requestText } from "./http.js";
import { declaredFamilyForge } from "./resolve.js";
import { parsePlatformBaseUrl } from "./urls.js";

type ForgejoEnv = Readonly<Record<string, string | undefined>>;

export function forgejoApiBase(env: ForgejoEnv): string {
  return `${parsePlatformBaseUrl(env.FORGEJO_API_URL ?? "", "Forgejo API base URL").base}/api/v1`;
}

/** Ancillary writes use the same selected identity and origin guard as reads. */
export async function forgejoAncillaryWrite(
  env: ForgejoEnv,
  url: string,
  method: "DELETE" | "POST",
  body?: unknown,
): Promise<void> {
  const { origin } = parsePlatformBaseUrl(env.FORGEJO_API_URL ?? "", "Forgejo API base URL");
  const adapter = new ForgejoAdapter({
    repo: env.REPO ?? "",
    prNumber: env.PR_NUMBER ?? "",
    baseUrl: env.FORGEJO_API_URL ?? "",
    token: forgejoTokenFromEnv(env),
    authMethod: env.FORGEJO_AUTH_METHOD,
    authorizedIntegrationAudience: env.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE,
    // #1678: the declared forge identity is threaded here too, so the
    // Gitea refusal of the Forgejo-only `authorized_integration` mode cannot be
    // bypassed by an ancillary write that constructs its own adapter.
    forge: declaredFamilyForge(env.PLATFORM),
  });
  await requestText(url, {
    method,
    token: await adapter.authorizationHeaderForRequest(),
    allowedOrigin: origin,
    timeoutMs: 15_000,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
