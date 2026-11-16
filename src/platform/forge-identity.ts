/** The DECLARED forge identity's own behavior (#1682).
 *
 * The wire family is one thing (`github` | `forgejo`, `forgeWireFamily`) and
 * the product an operator declared is another (`github` | `forgejo` |
 * `gitea`, `ForgeId`). Everything that differs BETWEEN the two Gitea-family
 * products lives in this module, so the controller startup — and every other
 * consumer outside the platform seam — asks the seam instead of branching on
 * a product name of its own. A `platform === "gitea"` branch in controller
 * code is a forge-specific decision outside the adapters, and this module is
 * where it belongs.
 *
 * Today exactly two behaviors differ, and both are refusals:
 * - the PRODUCT NAME an operator reads in a diagnostic;
 * - the TOKEN READER, because Authorized OAuth Integrations (an
 *   OIDC-asserted JWT exchanged for a short-lived API token) exist only on
 *   Forgejo. A Gitea instance configured for that mode is refused by the
 *   Gitea token reader, never by the Forgejo one.
 */

import { forgejoTokenFromEnv } from "./forgejo-auth.js";
import { giteaTokenFromEnv } from "./gitea.js";
import type { GiteaFamilyForge } from "./resolve.js";

/** The product name an operator reads in a diagnostic. */
export function forgeProductLabel(forge: GiteaFamilyForge): "Forgejo" | "Gitea" {
  return forge === "gitea" ? "Gitea" : "Forgejo";
}

/** True when the declared identity refuses the given auth method.
 *
 * Authorized OAuth Integrations (an OIDC-asserted JWT exchanged for a
 * short-lived API token) exist only on Forgejo, so `authorized_integration`
 * is a Forgejo-only mode. The rule lives here so every boundary that
 * applies it asks the seam: the token reader below, the read adapter, the
 * publish client, and the typed input boundary.
 */
export function forgeRefusesAuthMethod(
  forge: GiteaFamilyForge,
  authMethod: string | undefined,
): boolean {
  return (
    forge === "gitea" &&
    (authMethod ?? "").trim().toLowerCase() === "authorized_integration"
  );
}

/** The token reader for a declared Gitea-family identity.
 *
 * The family's own environment contract is shared (`FORGEJO_TOKEN`), so the
 * Forgejo reader resolves it; the Gitea reader resolves the same variable and
 * REFUSES the Forgejo-only `authorized_integration` mode (and a bare
 * authorized-integration audience) before any token lookup — Gitea has no
 * Forgejo "authorized integration", and a configuration that named one must
 * fail with that reason, not with "no token configured".
 *
 * The refusal THROWS: it is a misconfiguration, not a missing credential. A
 * caller that wants a startup refusal turns it into one; a caller that wants
 * a value must not swallow it.
 */
export function forgeTokenFromEnv(
  forge: GiteaFamilyForge,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return forge === "gitea" ? giteaTokenFromEnv(env) : forgejoTokenFromEnv(env);
}
