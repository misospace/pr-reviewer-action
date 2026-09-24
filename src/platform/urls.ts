const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export class PlatformUrlError extends Error {}

export interface ParsedBaseUrl {
  /** Validated absolute origin + path prefix, without a trailing slash. */
  base: string;
  origin: string;
}

/**
 * Parse and validate a configured platform base URL before any credential
 * is attached to it (#674 SSRF boundary from #670/#682).
 *
 * Runner/config values are external input even when they are normally
 * trusted: only http/https are accepted, embedded credentials are rejected,
 * and the URL must carry a hostname. The returned base is normalized the
 * same way the v2 Forgejo transport normalizes FORGEJO_API_URL (trailing
 * slashes stripped) so path joining stays identical.
 */
export function parsePlatformBaseUrl(raw: string, label = "base URL"): ParsedBaseUrl {
  const text = raw.trim();
  if (!text) throw new PlatformUrlError(`${label} must not be empty`);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PlatformUrlError(`${label} is not a valid URL`);
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new PlatformUrlError(`${label} must use http or https (got '${url.protocol}')`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new PlatformUrlError(`${label} must not embed credentials`);
  }
  if (url.hostname === "") {
    throw new PlatformUrlError(`${label} must include a hostname`);
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { base, origin: url.origin };
}

export function sameOrigin(a: string, b: string): boolean {
  return parsePlatformBaseUrl(a).origin === parsePlatformBaseUrl(b).origin;
}

/** Default GitHub REST API base — the platform origin for GitHub mode. */
export const GITHUB_API_BASE = "https://api.github.com";

/** Linked-source enrichment always targets github.com, never the hosting
 * platform API base (#674): this is the one pinned origin for third-party
 * repo lookups. */
export const LINKED_SOURCE_GITHUB_BASE = "https://api.github.com";
