/** The syntax-provider registry (#764, phase 1).
 *
 * This module is the SINGLE place that holds the provider→id mapping, so a
 * parser-backed provider can be registered later without the builder — or
 * any policy that consumes it — changing shape. The builder asks the
 * registry for a provider by id and reports what it got; it never names a
 * provider implementation itself.
 *
 * Resolution NEVER throws: an unknown id resolves to the default provider
 * with `fallback: true` and a reason naming the unknown id, because a
 * misconfigured provider id must degrade the stage, not fail the review. */

import { structuralSyntaxProvider, STRUCTURAL_PROVIDER_ID } from "./providers/structural.js";
import type { SyntaxProvider } from "./types.js";

/** The id of the provider used when none is requested. */
export const DEFAULT_SYNTAX_PROVIDER_ID = STRUCTURAL_PROVIDER_ID;

/** The registered providers, by id. */
const PROVIDERS = new Map<string, SyntaxProvider>([[DEFAULT_SYNTAX_PROVIDER_ID, structuralSyntaxProvider]]);

export interface SyntaxProviderResolution {
  provider: SyntaxProvider;
  /** The id that was requested ("" or undefined => default). */
  requestedId: string;
  /** True when the requested provider was unknown or failed and the default was used instead. */
  fallback: boolean;
  /** Why the fallback happened; null when no fallback occurred. */
  reason: string | null;
}

/** Register a provider under `id`, replacing any provider already
 * registered under it. A later phase registers a parser-backed provider
 * here; the builder is unaffected. */
export function registerSyntaxProvider(id: string, provider: SyntaxProvider): void {
  const key = id.trim();
  if (key === "" || provider === null || typeof provider !== "object") return;
  PROVIDERS.set(key, provider);
}

/** The ids the registry knows, in registration order. */
export function syntaxProviderIds(): string[] {
  return [...PROVIDERS.keys()];
}

/** The provider registered under `id`, or null. */
export function syntaxProviderById(id: string): SyntaxProvider | null {
  return PROVIDERS.get(id.trim()) ?? null;
}

/** Resolve the provider to use. An empty, missing, or unknown id resolves
 * to the default provider; an unknown id is reported as a fallback with the
 * unknown id named in the reason. Never throws. */
export function resolveSyntaxProvider(id?: string | null): SyntaxProviderResolution {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (requestedId === "") {
    const provider = PROVIDERS.get(DEFAULT_SYNTAX_PROVIDER_ID) ?? structuralSyntaxProvider;
    return { provider, requestedId, fallback: false, reason: null };
  }
  const found = PROVIDERS.get(requestedId);
  if (found !== undefined) {
    return { provider: found, requestedId, fallback: false, reason: null };
  }
  const provider = PROVIDERS.get(DEFAULT_SYNTAX_PROVIDER_ID) ?? structuralSyntaxProvider;
  return {
    provider,
    requestedId,
    fallback: true,
    reason: `unknown syntax provider: ${requestedId}`,
  };
}
