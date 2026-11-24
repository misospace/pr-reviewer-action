/** The shared repository-identity canonicalizer (#1783).
 *
 * Lives in the platform seam — not in the event-normalization module —
 * because both sides of the identity comparison consume it: `src/events/`
 * canonicalizes inbound forge event payloads with it, and `src/config/`
 * canonicalizes the operator's adoption allowlist/denylist entries at the
 * validation boundary so a stored entry compares equal to the lowercased
 * event identity. A pure leaf helper keeps the config↔events dependency
 * one-way and obvious.
 *
 * Grammar (unchanged from its events/normalize.ts origin): trim, lowercase,
 * and require exactly one "/" with both halves non-empty. Exported because
 * the reconciliation poll adapter (`src/ingress/reconcile.ts`) must reject
 * entries whose normalized target repository disagrees with the configured
 * repository it polled using the SAME definition the normalizer applies —
 * raw or ad-hoc string comparisons would let malformed envelopes slip past
 * the boundary (#1025). */
export function normalizeRepoFullName(fullName: string): string {
  const trimmed = fullName.trim().toLowerCase();
  if (trimmed === "") return "";
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1 || trimmed.indexOf("/", slash + 1) !== -1) {
    return "";
  }
  return trimmed;
}
