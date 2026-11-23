import { requestText } from "./http.js";
import { GITHUB_API_BASE, parsePlatformBaseUrl } from "./urls.js";

type GitHubEnv = Readonly<Record<string, string | undefined>>;

export function githubApiBase(env: GitHubEnv): string {
  return parsePlatformBaseUrl(env.GITHUB_API_URL || GITHUB_API_BASE, "GitHub API base URL").base;
}

/** Ancillary GitHub writes use the shared typed transport: the configured
 * base is validated before credentials are attached, requests are bound to
 * that origin, redirects are refused, and transport errors are credential-free. */
export async function githubAncillaryWrite(
  env: GitHubEnv,
  url: string,
  method: "DELETE" | "POST",
  body?: unknown,
): Promise<void> {
  const { origin } = parsePlatformBaseUrl(env.GITHUB_API_URL || GITHUB_API_BASE, "GitHub API base URL");
  await requestText(url, {
    method,
    token: `Bearer ${env.GH_TOKEN ?? ""}`,
    allowedOrigin: origin,
    timeoutMs: 15_000,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
