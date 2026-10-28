/** The syntax-provider registry (#764, phase 1).
 *
 * This module is the SINGLE place that holds the provider→id mapping, so a
 * parser-backed provider can be registered later without the builder — or
 * any policy that consumes it — changing shape. The builder asks the
 * registry for a provider by id and reports what it got; it never names a
 * provider implementation itself.
 *
 * The registry stores DESCRIPTORS, not provider objects: every provider
 * runs in an isolated worker thread (see `./provider-host.ts`), and a
 * function cannot cross a thread boundary. A registration says WHICH
 * provider and HOW the runtime loads it; the provider module implements
 * the `SyntaxProvider` interface inside the worker.
 *
 * Resolution NEVER throws: an unknown id resolves to the default provider
 * with `fallback: true` and a reason naming the unknown id, because a
 * misconfigured provider id must degrade the stage, not fail the review. */

import { STRUCTURAL_PROVIDER_ID } from "./providers/structural.js";
import type { SyntaxProviderLoader, SyntaxProviderRegistration } from "./types.js";

/** The id of the provider used when none is requested. */
export const DEFAULT_SYNTAX_PROVIDER_ID = STRUCTURAL_PROVIDER_ID;

/** The registration of the built-in provider: the dependency-free
 * structural provider, which the worker builds without loading a module. */
export const BUILTIN_SYNTAX_PROVIDER_REGISTRATION: SyntaxProviderRegistration = Object.freeze({
  id: DEFAULT_SYNTAX_PROVIDER_ID,
  loader: Object.freeze({ kind: "builtin" as const }) as SyntaxProviderLoader,
});

/** The registered providers, by id. */
const PROVIDERS = new Map<string, SyntaxProviderRegistration>([
  [DEFAULT_SYNTAX_PROVIDER_ID, BUILTIN_SYNTAX_PROVIDER_REGISTRATION],
]);

export interface SyntaxProviderResolution {
  /** The registration the runtime must load. */
  registration: SyntaxProviderRegistration;
  /** The id that was requested ("" or undefined => default). */
  requestedId: string;
  /** True when the requested provider was unknown or failed and the default was used instead. */
  fallback: boolean;
  /** Why the fallback happened; null when no fallback occurred. */
  reason: string | null;
}

/** Whether a loader descriptor names a provider the runtime can load. */
function isLoader(value: unknown): value is SyntaxProviderLoader {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "builtin") return true;
  if (kind !== "module") return false;
  const module = (value as { module?: unknown }).module;
  return typeof module === "string" && module !== "";
}

/** Whether a value is a usable registration. A malformed one is IGNORED:
 * a broken registration must degrade the stage, not break the registry. */
function isRegistration(value: unknown): value is SyntaxProviderRegistration {
  if (value === null || typeof value !== "object") return false;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim() === "") return false;
  return isLoader((value as { loader?: unknown }).loader);
}

/** Register a provider under `id`, replacing any provider already
 * registered under it. A later phase registers a parser-backed provider
 * here; the builder is unaffected.
 *
 * The registration is stored NORMALIZED: its `id` becomes the registry
 * KEY. The artifact reports the registration's id, so a registration whose
 * own id differs from the key it was registered under would report a
 * provider id the operator never asked for. */
export function registerSyntaxProvider(id: string, registration: SyntaxProviderRegistration): void {
  if (!isRegistration(registration)) return;
  const key = id.trim() !== "" ? id.trim() : registration.id.trim();
  if (key === "") return;
  PROVIDERS.set(key, { ...registration, id: key });
}

/** The ids the registry knows, in registration order. */
export function syntaxProviderIds(): string[] {
  return [...PROVIDERS.keys()];
}

/** The registration registered under `id`, or null. */
export function syntaxProviderById(id: string): SyntaxProviderRegistration | null {
  return PROVIDERS.get(id.trim()) ?? null;
}

/** Resolve the provider to use. An empty, missing, or unknown id resolves
 * to the default provider; an unknown id is reported as a fallback with the
 * unknown id named in the reason. Never throws. */
export function resolveSyntaxProvider(id?: string | null): SyntaxProviderResolution {
  const requestedId = typeof id === "string" ? id.trim() : "";
  if (requestedId === "") {
    return { registration: BUILTIN_SYNTAX_PROVIDER_REGISTRATION, requestedId, fallback: false, reason: null };
  }
  const found = PROVIDERS.get(requestedId);
  if (found !== undefined) {
    return { registration: found, requestedId, fallback: false, reason: null };
  }
  return {
    registration: BUILTIN_SYNTAX_PROVIDER_REGISTRATION,
    requestedId,
    fallback: true,
    reason: `unknown syntax provider: ${requestedId}`,
  };
}
