/**
 * Explicit child-environment construction (#679).
 *
 * Child environments are allowlists, never `process.env` passthrough: a
 * forked workload receives exactly the keys named for it, and only when they
 * are set in the source environment. A future reviewer-only secret added to
 * the ambient environment can never leak into a child by default — it has to
 * be named in that child's allowlist on purpose.
 */

export type EnvAllowlist = readonly string[];

/**
 * Build a child environment from an explicit allowlist. Keys absent from the
 * source environment are simply not set on the child (no empty-string
 * pollution).
 */
export function buildChildEnv(
  allowlist: EnvAllowlist,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Union two allowlists (deduplicated, first occurrence order kept). */
export function extendAllowlist(
  base: EnvAllowlist,
  extra: EnvAllowlist,
): EnvAllowlist {
  const seen = new Set<string>(base);
  const merged = [...base];
  for (const key of extra) {
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(key);
    }
  }
  return merged;
}

/**
 * Test/audit helper: keys from `forbidden` that leaked into `env`. Empty when
 * the allowlist held (the credential-canary assertion uses this).
 */
export function leakedEnvKeys(
  env: NodeJS.ProcessEnv,
  forbidden: EnvAllowlist,
): string[] {
  return [...forbidden].filter((key) => env[key] !== undefined);
}
