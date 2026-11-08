/** The controller daemon's forge capability composition (#1348/#738): the
 * thin, typed binding between the daemon's `ControllerForgeCapability` /
 * follow-up adapter seams and the platform capability layer
 * (`src/platform/`, the GitHub App ingress clients) for ONE platform.
 *
 * COMPOSITION ONLY, like the daemon itself: no new policy, no second
 * reviewer, and above all NO forge CLI anywhere — every read and write
 * goes through the platform adapters, the GitHub App authenticator/client,
 * the Forgejo ingress client, or the publish APIs over the shared typed
 * transport (`requestJson`, origin-bound, credential-free errors).
 *
 * ONE PLATFORM PER INSTANCE (the daemon's invariant): the instance config's
 * `forges` entries must describe exactly one platform, and this module
 * composes the capability for that platform only. A requested platform the
 * composition cannot serve (no GitHub App material, no Forgejo token) fails
 * CLOSED at startup — the daemon never runs with a forge capability that
 * cannot act on its own intake.
 *
 * Secret discipline: material enters through the environment, is bound to
 * the ONE validated origin inside the platform seams, and never appears in
 * a URL, an argv, a durable record, or an error message — every error text
 * is a fixed/bounded phrase or a value the platform seam already guarantees
 * credential-free. Clone credentials travel only as HTTP Basic
 * authorization inside the #732 mirror's git child environment.
 */

import type { FetchLike } from "../platform/http.js";
import { requestJson } from "../platform/http.js";
import { parsePlatformBaseUrl, GITHUB_API_BASE } from "../platform/urls.js";
import { parseRepoRef, repoScopedUrl } from "../platform/repo-ref.js";
import { GitHubAdapter } from "../platform/github.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import {
  GitHubPublishApi,
  ForgejoPublishApi,
} from "../platform/publish-api.js";
import { GitHubAppAuthenticator } from "../ingress/github-app-auth.js";
import { GitHubAppCapabilityClient } from "../ingress/github-app-client.js";
import { ForgejoIngressClient } from "../ingress/api-client.js";
import { buildCloneCredential } from "../ingress/clone-credentials.js";
import { toFetchCredentials } from "../acquisition/git-env.js";
import { MirrorCache } from "../acquisition/mirror.js";
import { derivePrStateReading, type PrStateReading } from "../platform/pr.js";
import { DEFAULT_MANAGED_MARKER } from "../context/pr-thread.js";
import { authorityReadingFromPayload, type AuthorityReading } from "../precheck/comment-authority.js";
import type { FollowUpForgeAdapter } from "../ingress/followup-host.js";
import type { ReviewJob } from "../jobs/types.js";
import type { ControllerForgeCapability } from "./daemon.js";

/** The managed sticky-comment marker (the same identity the production
 * publisher uses): the durable result is published as ONE sticky comment
 * per PR, updated in place — never one comment per head. */
export const CONTROLLER_STICKY_MARKER = DEFAULT_MANAGED_MARKER;

/** The publication id prefix the platform writes report (opaque
 * forge-write references in the durable record — never credentials). */
const GITHUB_PUBLICATION_PREFIX = "github-comment:";
const FORGEJO_PUBLICATION_PREFIX = "forgejo-comment:";

/** GitHub's API base and its web origin: the clone URL lives on the WEB
 * host, never on the API host (`api.github.com` serves no git protocol). */
function webOriginFromApiBase(apiBaseUrl: string): string {
  const { base } = parsePlatformBaseUrl(apiBaseUrl, "GitHub API base URL");
  // GHE: `<host>/api/v3` → `https://<host>`.
  if (base.endsWith("/api/v3")) return base.slice(0, -"/api/v3".length);
  // GitHub.com: `https://api.github.com` → `https://github.com`.
  if (base === GITHUB_API_BASE) return "https://github.com";
  if (new URL(base).hostname.startsWith("api.")) {
    return base.replace("//api.", "//");
  }
  return base;
}

/** The forge comment-body ceiling (#1558): 65,536 bytes — the same bound
 * the GitHub App ingress client enforces before its write
 * (`MAX_COMMENT_BYTES` in `src/ingress/github-app-client.ts`), and the
 * bound the review body is guarded against in #1554. It is applied as a
 * BYTE bound, counting UTF-8 bytes, the stricter measure: a body over
 * the ceiling is not trimmed by the forge, it is REFUSED, and a refused
 * publication loses the whole result. */
export const FORGE_COMMENT_MAX_BYTES = 65_536;

/** Assemble `marker + fence + payload + fence` with the fence chosen
 * LONGER than any backtick run inside the payload, so hostile review
 * content can never close its own fence and forge markdown structure
 * around it (the fence-safe rendering rule). UNBOUNDED: use
 * `renderDurableResultBody` (which enforces the ceiling) or
 * `durableResultPayloadFitsCeiling` (which predicts it). */
function assembleDurableResultBody(marker: string, resultPayload: string): string {
  let longest = 0;
  let run = 0;
  for (const char of resultPayload) {
    if (char === "`") {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${marker}\n\n${fence}json\n${resultPayload}\n${fence}`;
}

/** A fenced, marker-carrying comment body for the durable result payload.
 *
 * #1558: the assembled body is bounded against `FORGE_COMMENT_MAX_BYTES`.
 * The payload's own ceiling (`PUBLICATION_PAYLOAD_MAX_CHARS`, and the
 * review bundle's `REVIEW_BUNDLE_MAX_BYTES`) is exactly the comment
 * ceiling, so the marker and the fences used to push the assembled body
 * PAST it — the forge refused the oversized comment and the whole
 * publication was lost (the same failure #1554 fixed for the review
 * body). The payload is a machine document and #1554's policy forbids
 * trimming one, so the guard here is fail-closed: a payload that does
 * not fit the room the marker and the fences leave renders NOTHING and
 * says by how much it overflowed. The durable publisher refuses such a
 * payload BEFORE it persists a record or reaches the forge, so the
 * refusal is a bounded local diagnostic, never a forge rejection. */
export function renderDurableResultBody(marker: string, resultPayload: string): string {
  const body = assembleDurableResultBody(marker, resultPayload);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > FORGE_COMMENT_MAX_BYTES) {
    throw new Error(
      `the durable result comment exceeds the forge comment ceiling by ${bytes - FORGE_COMMENT_MAX_BYTES} byte(s)`,
    );
  }
  return body;
}

/** #1558: whether a result payload survives the durable-result rendering
 * inside the comment ceiling. The test IS the render with the controller's
 * own sticky marker, byte-measured — the fence grows with the payload's
 * longest backtick run, so no static reserve can prove the fit; the
 * exact assembled body is the only honest measure. */
export function durableResultPayloadFitsCeiling(resultPayload: string): boolean {
  return Buffer
    .byteLength(assembleDurableResultBody(CONTROLLER_STICKY_MARKER, resultPayload), "utf8")
    <= FORGE_COMMENT_MAX_BYTES;
}

/** Validate a repository full name for raw path composition (fail closed). */
function repoRefOf(repoFullName: string): { readonly owner: string; readonly name: string } {
  const ref = parseRepoRef(repoFullName);
  if (ref === null) throw new Error(`invalid repository identity: ${repoFullName}`);
  return { owner: ref.owner, name: ref.name };
}

/** The composed forge surface for one platform. */
export interface ComposedForge {
  readonly platform: "github" | "forgejo";
  readonly capability: ControllerForgeCapability;
  readonly followUp: FollowUpForgeAdapter;
  /** The reviewer's own authenticated identity probe (the follow-up
   * consumer's loop/mention guard). */
  botLogin(): Promise<string | null>;
  /** The bounded open-PR lister the missed-webhook reconciliation binds. */
  listOpenPullRequests(repo: string): Promise<{ readonly ok: true; readonly data: unknown[] } | { readonly ok: false; readonly error: string }>;
  /** The installation id the reconciliation poll authenticates as
   * (GitHub only; "" on Forgejo). */
  readonly pollInstallationId: string;
  /** Bounded, secret-free identity of this composition (startup log). */
  describe(): string;
}

export interface ForgeCompositionInput {
  readonly platform: "github" | "forgejo";
  /** The forge integration endpoint from the instance config (validated:
   * absolute http(s), no embedded credentials). */
  readonly endpoint: string;
  /** The controller-owned workspace cache root (#732 mirrors). */
  readonly workspaceCacheRoot: string;
  /** GitHub App material (required when platform is `github`). */
  readonly githubAppId?: string;
  readonly githubAppPrivateKeyPem?: string;
  /** The installation id the reconciliation poll authenticates as
   * (required when platform is `github` and reconciliation is enabled). */
  readonly githubPollInstallationId?: string;
  /** The Forgejo token (required when platform is `forgejo`); resolved
   * by the caller from the environment (`forgejoTokenFromEnv`). */
  readonly forgejoToken?: string;
  readonly fetchImpl?: FetchLike;
}

/** Compose the forge capability, follow-up adapter, and reconcile lister
 * for ONE platform. Fails closed on any missing material or an unusable
 * endpoint — before the daemon is constructed, never mid-flight. */
export function composeForgeCapability(input: ForgeCompositionInput): ComposedForge {
  if (input.platform === "github") {
    if (input.githubAppId === undefined || input.githubAppPrivateKeyPem === undefined) {
      throw new Error(
        "the instance config serves github but the GitHub App material is missing (PR_REVIEWER_GITHUB_APP_ID / PR_REVIEWER_GITHUB_APP_PRIVATE_KEY)",
      );
    }
    return composeGitHub(input);
  }
  if (input.forgejoToken === undefined) {
    throw new Error(
      "the instance config serves forgejo but no Forgejo token is configured (FORGEJO_TOKEN)",
    );
  }
  return composeForgejo(input);
}

// ── GitHub ───────────────────────────────────────────────────────────────

function composeGitHub(input: ForgeCompositionInput): ComposedForge {
  const apiBaseUrl = input.endpoint;
  const webOrigin = webOriginFromApiBase(apiBaseUrl);
  const authenticator = new GitHubAppAuthenticator({
    apiBaseUrl,
    appId: input.githubAppId!,
    privateKeyPem: input.githubAppPrivateKeyPem!,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });
  /** Mint (or reuse) the installation token for one job's installation.
   * A classified failure is a bounded, credential-free reason — safe to
   * propagate as an error message. */
  const tokenFor = async (installationId: string): Promise<string> => {
    const result = await authenticator.installationToken(installationId);
    if (!result.ok) throw new Error(`GitHub App authentication failed: ${result.reason}`);
    return result.data.token;
  };
  const bearer = (token: string): string => `Bearer ${token}`;

  /** The installation the follow-up lane and the reconcile lister
   * authenticate as. The daemon's follow-up adapter is a single-capability
   * surface; deployments serving one installation set the env id, and an
   * unprovable installation degrades the lane's writes (never
   * mis-authenticates). */
  const fixedInstallationId = input.githubPollInstallationId ?? "";
  const installationIdOf = (_repoFullName: string): string => fixedInstallationId;

  const capability: ControllerForgeCapability = {
    async mirrorFor(job: ReviewJob): Promise<MirrorCache> {
      const ref = repoRefOf(job.repoFullName);
      const token = await tokenFor(job.installationId);
      const credential = buildCloneCredential(webOrigin, job.repoFullName, token, "x-access-token");
      if (credential === null) {
        throw new Error(`no clone endpoint could be resolved for ${ref.owner}/${ref.name}`);
      }
      const credentials = toFetchCredentials(credential);
      if (credentials === null) {
        throw new Error(`no clone credential could be built for ${ref.owner}/${ref.name}`);
      }
      return new MirrorCache({
        rootDir: input.workspaceCacheRoot,
        platform: "github",
        repoFullName: job.repoFullName,
        cloneUrl: credentials.cloneUrl,
        credentials,
      });
    },
    async currentHeadSha(job: ReviewJob): Promise<string | null> {
      const adapter = new GitHubAdapter({
        repo: job.repoFullName,
        prNumber: String(job.prNumber),
        baseUrl: apiBaseUrl,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const pr = await adapter.getPr();
      if (typeof pr !== "object" || pr === null) return null;
      const head = (pr as Record<string, unknown>).head;
      if (typeof head !== "object" || head === null) return null;
      const sha = (head as Record<string, unknown>).sha;
      return typeof sha === "string" && sha !== "" ? sha : null;
    },
    async publish(input_: { readonly job: ReviewJob; readonly resultPayload: string }): Promise<{
      readonly publicationId: string;
    }> {
      const client = new GitHubAppCapabilityClient({
        apiBaseUrl,
        appId: input.githubAppId!,
        privateKeyPem: input.githubAppPrivateKeyPem!,
        installationId: input_.job.installationId,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const written = await client.upsertIssueComment(
        input_.job.repoFullName,
        input_.job.prNumber,
        CONTROLLER_STICKY_MARKER,
        renderDurableResultBody(CONTROLLER_STICKY_MARKER, input_.resultPayload),
      );
      if (!written.ok) throw new Error(`the GitHub publication failed: ${written.error}`);
      return { publicationId: `${GITHUB_PUBLICATION_PREFIX}${written.id ?? "unknown"}` };
    },
  };

  /** One collaborator-permission read for the follow-up planner's
   * authority gate, through the adapter's validated read-only seam. */
  const permissionAdapter = (repo: string): GitHubAdapter =>
    new GitHubAdapter({
      repo,
      prNumber: "0",
      baseUrl: apiBaseUrl,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });

  const followUp: FollowUpForgeAdapter = {
    async readPermission(repoFullName: string, login: string): Promise<AuthorityReading | null> {
      const ref = repoRefOf(repoFullName);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(login)) return null;
      const result = await permissionAdapter(repoFullName).ghApi(
        `/repos/${ref.owner}/${ref.name}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      if ("error" in result) return null;
      return authorityReadingFromPayload(result.data);
    },
    async readComment(repoFullName: string, commentId: string): Promise<string> {
      // Validate the identity BEFORE minting an installation token (the
      // call's result is not needed here; `repoScopedUrl` below re-checks).
      repoRefOf(repoFullName);
      if (!/^[1-9][0-9]{0,18}$/.test(commentId)) {
        throw new Error("invalid comment id");
      }
      const token = await tokenFor(installationIdOf(repoFullName));
      const url = repoScopedUrl(
        authenticator.apiBase,
        repoFullName,
        "/issues/comments",
        `/${commentId}`,
      );
      if (url === null) throw new Error("invalid comment read target");
      const { status, data } = await requestJson(url, {
        method: "GET",
        token: bearer(token),
        allowedOrigin: authenticator.origin,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      if (status !== 200) throw new Error(`the comment read failed with status ${status}`);
      const body = (data as Record<string, unknown> | null)?.body;
      if (typeof body !== "string") throw new Error("the comment read returned no body");
      return body;
    },
    async fetchThreadComments(repoFullName: string, prNumber: number): Promise<readonly unknown[]> {
      const adapter = new GitHubAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: apiBaseUrl,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const listed = await adapter.listPrConversationComments();
      if (!listed.ok) throw new Error(`the thread read failed: ${listed.error}`);
      return listed.data;
    },
    async readPrState(repoFullName: string, prNumber: number): Promise<PrStateReading> {
      const adapter = new GitHubAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: apiBaseUrl,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      return derivePrStateReading(await adapter.getPr());
    },
    async postComment(repoFullName: string, prNumber: number, body: string): Promise<boolean> {
      const token = await tokenFor(installationIdOf(repoFullName));
      const api = new GitHubPublishApi({
        repo: repoFullName,
        prNumber: String(prNumber),
        token: bearer(token),
        baseUrl: apiBaseUrl,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const posted = await api.postIssueComment(body);
      return posted.ok === true && posted.created === true;
    },
    async resolveHeadSha(repoFullName: string, prNumber: number): Promise<string | null> {
      const adapter = new GitHubAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: apiBaseUrl,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const pr = await adapter.getPr();
      if (typeof pr !== "object" || pr === null) return null;
      const head = (pr as Record<string, unknown>).head;
      const sha = typeof head === "object" && head !== null
        ? (head as Record<string, unknown>).sha
        : undefined;
      return typeof sha === "string" && sha !== "" ? sha : null;
    },
    async resolvePrIdentity(repoFullName: string, prNumber: number): Promise<{ prId: number; baseSha: string } | null> {
      const adapter = new GitHubAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: apiBaseUrl,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const pr = await adapter.getPr();
      if (typeof pr !== "object" || pr === null) return null;
      const record = pr as Record<string, unknown>;
      const id = typeof record.id === "number" && Number.isSafeInteger(record.id) ? record.id : 0;
      const base = typeof record.base === "object" && record.base !== null
        ? (record.base as Record<string, unknown>).sha
        : undefined;
      return {
        prId: id,
        baseSha: typeof base === "string" ? base : "",
      };
    },
  };

  const lister = fixedInstallationId === ""
    ? null
    : new GitHubAppCapabilityClient({
        apiBaseUrl,
        appId: input.githubAppId!,
        privateKeyPem: input.githubAppPrivateKeyPem!,
        installationId: fixedInstallationId,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });

  return {
    platform: "github",
    capability,
    followUp,
    botLogin: () => authenticator.appIdentity(),
    listOpenPullRequests: (repo) =>
      lister === null
        ? Promise.resolve({ ok: false as const, error: "no reconcile installation is configured" })
        : lister.listOpenPullRequests(repo),
    pollInstallationId: fixedInstallationId,
    describe: () => `github app ${input.githubAppId} via ${authenticator.origin}`,
  };
}

// ── Forgejo ──────────────────────────────────────────────────────────────

function composeForgejo(input: ForgeCompositionInput): ComposedForge {
  const endpoint = input.endpoint;
  const token = input.forgejoToken!;
  const ingress = new ForgejoIngressClient({
    endpoint,
    token,
    ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
  });

  const capability: ControllerForgeCapability = {
    async mirrorFor(job: ReviewJob): Promise<MirrorCache> {
      const ref = repoRefOf(job.repoFullName);
      const credential = buildCloneCredential(endpoint, job.repoFullName, token, "x-access-token");
      if (credential === null) {
        throw new Error(`no clone endpoint could be resolved for ${ref.owner}/${ref.name}`);
      }
      const credentials = toFetchCredentials(credential);
      if (credentials === null) {
        throw new Error(`no clone credential could be built for ${ref.owner}/${ref.name}`);
      }
      return new MirrorCache({
        rootDir: input.workspaceCacheRoot,
        platform: "forgejo",
        repoFullName: job.repoFullName,
        cloneUrl: credentials.cloneUrl,
        credentials,
      });
    },
    async currentHeadSha(job: ReviewJob): Promise<string | null> {
      const adapter = new ForgejoAdapter({
        repo: job.repoFullName,
        prNumber: String(job.prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const pr = await adapter.getPr();
      if (typeof pr !== "object" || pr === null) return null;
      const head = (pr as Record<string, unknown>).head;
      const sha = typeof head === "object" && head !== null
        ? (head as Record<string, unknown>).sha
        : undefined;
      return typeof sha === "string" && sha !== "" ? sha : null;
    },
    async publish(input_: { readonly job: ReviewJob; readonly resultPayload: string }): Promise<{
      readonly publicationId: string;
    }> {
      const api = new ForgejoPublishApi({
        repo: input_.job.repoFullName,
        prNumber: String(input_.job.prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const written = await api.upsertStickyComment(
        CONTROLLER_STICKY_MARKER,
        renderDurableResultBody(CONTROLLER_STICKY_MARKER, input_.resultPayload),
      );
      if (!written.ok) throw new Error(`the Forgejo publication failed: ${written.error ?? "unknown error"}`);
      return { publicationId: `${FORGEJO_PUBLICATION_PREFIX}${written.commentId ?? "unknown"}` };
    },
  };

  const followUp: FollowUpForgeAdapter = {
    async readPermission(repoFullName: string, login: string): Promise<AuthorityReading | null> {
      const ref = repoRefOf(repoFullName);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(login)) return null;
      const listed = await ingress.getJson(
        `/repos/${ref.owner}/${ref.name}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      if (!listed.ok) return null;
      return authorityReadingFromPayload(listed.data);
    },
    async readComment(repoFullName: string, commentId: string): Promise<string> {
      const ref = repoRefOf(repoFullName);
      if (!/^[1-9][0-9]{0,18}$/.test(commentId)) {
        throw new Error("invalid comment id");
      }
      const listed = await ingress.getJson(
        `/repos/${ref.owner}/${ref.name}/issues/comments/${commentId}`,
      );
      if (!listed.ok) throw new Error("the comment read failed");
      const body = (listed.data as Record<string, unknown> | null)?.body;
      if (typeof body !== "string") throw new Error("the comment read returned no body");
      return body;
    },
    async fetchThreadComments(repoFullName: string, prNumber: number): Promise<readonly unknown[]> {
      const adapter = new ForgejoAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const listed = await adapter.listPrConversationComments();
      if (!listed.ok) throw new Error(`the thread read failed: ${listed.error}`);
      return listed.data;
    },
    async readPrState(repoFullName: string, prNumber: number): Promise<PrStateReading> {
      const adapter = new ForgejoAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      return derivePrStateReading(await adapter.getPr());
    },
    async postComment(repoFullName: string, prNumber: number, body: string): Promise<boolean> {
      const api = new ForgejoPublishApi({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const posted = await api.postIssueComment(body);
      return posted.ok === true && posted.created === true;
    },
    async resolveHeadSha(repoFullName: string, prNumber: number): Promise<string | null> {
      const adapter = new ForgejoAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const pr = await adapter.getPr();
      if (typeof pr !== "object" || pr === null) return null;
      const head = (pr as Record<string, unknown>).head;
      const sha = typeof head === "object" && head !== null
        ? (head as Record<string, unknown>).sha
        : undefined;
      return typeof sha === "string" && sha !== "" ? sha : null;
    },
    async resolvePrIdentity(repoFullName: string, prNumber: number): Promise<{ prId: number; baseSha: string } | null> {
      const adapter = new ForgejoAdapter({
        repo: repoFullName,
        prNumber: String(prNumber),
        baseUrl: endpoint,
        token,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      });
      const pr = await adapter.getPr();
      if (typeof pr !== "object" || pr === null) return null;
      const record = pr as Record<string, unknown>;
      const id = typeof record.id === "number" && Number.isSafeInteger(record.id) ? record.id : 0;
      const base = typeof record.base === "object" && record.base !== null
        ? (record.base as Record<string, unknown>).sha
        : undefined;
      return {
        prId: id,
        baseSha: typeof base === "string" ? base : "",
      };
    },
  };

  return {
    platform: "forgejo",
    capability,
    followUp,
    botLogin: async () => {
      const who = await ingress.getJson("/user");
      if (!who.ok) return null;
      const login = (who.data as Record<string, unknown> | null)?.login;
      return typeof login === "string" && login !== "" ? login : null;
    },
    listOpenPullRequests: (repo) => ingress.listOpenPullRequests(repo),
    pollInstallationId: "",
    describe: () => `forgejo via ${ingress.endpoints.origin}`,
  };
}
