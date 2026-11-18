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
 * Today exactly three behaviors differ:
 * - the PRODUCT NAME an operator reads in a diagnostic;
 * - the TOKEN READER, because Authorized OAuth Integrations (an
 *   OIDC-asserted JWT exchanged for a short-lived API token) exist only on
 *   Forgejo. A Gitea instance configured for that mode is refused by the
 *   Gitea token reader, never by the Forgejo one;
 * - the WEBHOOK INTAKE MOUNT: a Gitea intake is mounted exactly on its
 *   canonical route, while the pre-existing Forgejo intake keeps its
 *   historical path-agnostic surface (#1683).
 */

import { forgejoTokenFromEnv } from "./forgejo-auth.js";
import { giteaTokenFromEnv } from "./gitea.js";
import type { ForgeId, GiteaFamilyForge } from "./resolve.js";

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

/** True when the declared forge mounts its webhook intake EXACTLY on the
 * canonical route named by the ingress seam (`ingressWebhookPath`).
 *
 * The decision is the DECLARED PRODUCT's, not the controller's (#1683): a
 * Gitea intake — introduced by #1682 with the canonical route as its only
 * mount — answers nowhere else, so a signed payload cannot drive a review
 * through a path the operator never mounted. The Forgejo intake predates
 * the route and keeps its historical path-agnostic surface (its canonical
 * route is REPORTED, not enforced), and GitHub's App intake is
 * path-agnostic by design. A GitLab intake (#740) enforces its canonical
 * route exactly like Gitea's: it was introduced WITH the route, so it has no
 * historical path-agnostic surface to preserve. Every consumer that serves
 * an intake asks THIS rule; nothing outside the seam branches on the product
 * name to decide it. */
export function forgeEnforcesWebhookRoute(forge: ForgeId): boolean {
  return forge === "gitea" || forge === "gitlab";
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
