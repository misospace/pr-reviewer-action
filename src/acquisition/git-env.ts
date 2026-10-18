/** Git child-environment policy for acquisition (#732).
 *
 * Two rules, both normative:
 *
 * - Child environments are allowlists (`buildChildEnv`), never ambient
 *   passthrough. The git base env additionally FORCES the global/system git
 *   config to `/dev/null` and disables terminal prompting, so a tenant's
 *   `~/.gitconfig` (including `safe.directory`, credential helpers, or hook
 *   path overrides) can never reach a controller git invocation —
 *   `safe.directory` cannot become a cross-tenant escape because no
 *   tenant-controlled global/system config is ever read (git also ignores
 *   `safe.directory` from repo-local config by design).
 * - Git credentials never appear in process argv (world-readable via ps)
 *   and are never persisted into repo config or remotes. The fetch
 *   credential travels ONLY through this invocation's environment as
 *   `GIT_CONFIG_KEY_n=http.<host-url>.extraheader` /
 *   `GIT_CONFIG_VALUE_n=Authorization: Basic ...`, which git applies as
 *   transient config for that single command — nothing is written to disk.
 */

import { buildChildEnv, extendAllowlist } from "../runtime/env.js";
import type { CloneCredential } from "../ingress/clone-credentials.js";
import type { FetchCredentials } from "./types.js";

/** Keys inherited from the ambient environment, when set, for the git child. */
export const GIT_ENV_ALLOWLIST = ["PATH", "HOME"] as const;

const GIT_FORCED_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // Defense in depth: git also reads $XDG_CONFIG_HOME/git/config; pin it to
  // a path that cannot exist so the global scope is closed even if a future
  // git build reads it before the GIT_CONFIG_GLOBAL override.
  XDG_CONFIG_HOME: "/dev/null/nonexistent-xdg-config",
  GIT_TERMINAL_PROMPT: "0",
};

/** Minimal allowlisted git environment with global/system config neutralized. */
export function gitEnv(ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...buildChildEnv(GIT_ENV_ALLOWLIST, ambient), ...GIT_FORCED_ENV };
}

/** Validate a clone URL for git use: http(s), a hostname, and no embedded
 * credentials (userinfo would leak the credential into the persisted
 * fetch URL/reflog and defeat the env-only rule). Returns the URL string
 * without userinfo, or null when refused. */
export function safeCloneUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hostname === "") return null;
  return url.toString();
}

/** Convert the #730 clone credential into the acquisition-layer credential,
 * carrying the clone URL it authorizes. Null when the credential is for a
 * URL this layer refuses (non-http(s), userinfo-bearing). */
export function toFetchCredentials(credential: CloneCredential): FetchCredentials | null {
  const url = safeCloneUrl(credential.cloneUrl);
  if (url === null) return null;
  return { cloneUrl: url, authorization: credential.headerValue };
}

/** The per-invocation env entries carrying the fetch credential for one
 * command against one host. `GIT_CONFIG_KEY_0` is keyed on the
 * scheme-qualified host URL (`http.<scheme>://<host>/.extraheader`) so the
 * header applies to that host only; the value is the Basic authorization
 * pair. The credential's own cloneUrl must match the invocation's URL — a
 * mismatch would send one host's token to another host, so it is refused.
 * Returns {} when `credentials` is absent or any URL was refused. */
export function gitCredentialEnv(
  credentials: FetchCredentials | undefined,
  cloneUrl: string,
): NodeJS.ProcessEnv {
  if (credentials === undefined) return {};
  const boundUrl = safeCloneUrl(credentials.cloneUrl);
  const url = safeCloneUrl(cloneUrl);
  if (boundUrl === null || url === null || boundUrl !== url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const key = `http.${parsed.protocol}//${parsed.hostname}${parsed.port === "" ? "" : `:${parsed.port}`}/.extraheader`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: credentials.authorization,
  };
}

/** Compose the full child env for one git invocation. */
export function gitInvocationEnv(
  ambient: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return { ...gitEnv(ambient), ...extra };
}

export { buildChildEnv, extendAllowlist };
