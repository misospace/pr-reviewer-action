/**
 * #1379: the deterministic dependency-evidence attribution vocabulary —
 * moved here from `src/tools/loop.ts` (#1657) so the enforcement-side
 * evidence-receipt layer (`src/enforcement/evidence-receipts.ts`) can share
 * ONE attribution implementation without importing the loop (an
 * enforcement → tools/loop edge closes a module cycle through
 * requirement-trace). Pure, lexical, total: never throws, never touches the
 * network.
 *
 * #1726 (review): the forge-read channel is NOT named here — the tool name
 * and the endpoint-shape recognition live at the platform boundary
 * (`FORGE_READ_TOOL` / `forgeReadChannelTarget` /
 * `isCanonicalForgeApiRepoPath` in `src/platform/endpoint.ts`, beside the
 * cross-backend endpoint validator they mirror). This module stays
 * capability-neutral: it runs the obligation keyword vocabulary over
 * whatever target string a channel hands it.
 */
import { forgeReadChannelTarget, isCanonicalForgeApiRepoPath } from "../platform/endpoint.js";

export const DEPENDENCY_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
]);

/**
 * #1726 (review 5979360208): whether a call rides an upstream
 * dependency-evidence CHANNEL — the loop's no-lockout admission predicate
 * (the reserve-window escape hatch, the `windowEvidence` bookkeeping, and
 * the attempts-cap counters all ask this). The literal evidence tools plus
 * the platform seam's forge-read channel, through the SAME recognition
 * attribution consumes (`forgeReadChannelTarget`): an unattributed forge
 * read inside the reserved window is admitted as an evidence-channel
 * attempt and counts toward the no-lockout cap instead of being refused —
 * the forge-read channel is no longer a second-class evidence channel.
 * ADMISSION ONLY: this predicate never discharges an obligation row — row
 * discharge still requires `dependencyEvidenceObligationsForCall`'s lexical
 * attribution grammar, so an unattributed forge read credits nothing. An
 * endpoint-less `gh_api` call is no channel call (it presents no forge-API
 * target), exactly as attribution treats it. Pure, total, never throws.
 */
export function isDependencyEvidenceChannelCall(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (DEPENDENCY_EVIDENCE_TOOLS.has(name)) return true;
  return forgeReadChannelTarget(name, args) !== null;
}

/** #1379 review blocker 5728634290: the required upstream evidence
 * obligations the reserve window tracks individually. Canonical order is
 * load-bearing: the tracked set is the prefix the reserve can pay for, and
 * credits/outstanding lists are always projected in this order. */
export type DependencyEvidenceObligation = "provenance" | "release_delta" | "security_advisory";

export const DEPENDENCY_EVIDENCE_OBLIGATIONS: readonly DependencyEvidenceObligation[] = [
  "provenance",
  "release_delta",
  "security_advisory",
];

const SECURITY_ADVISORY_TOKENS: readonly string[] = [
  "advisor",
  "ghsa",
  "cve",
  "osv",
  "vulnerab",
  "security",
  "exploit",
  "bulletin",
];

const RELEASE_DELTA_TOKENS: readonly string[] = [
  "release",
  "changelog",
  "changes",
  "changeset",
  "compare",
  "diff",
  "commits",
  "commit",
  "tag",
  "news",
  "history",
  "migration",
  "upgrade",
  "notes",
];

const PROVENANCE_TOKENS: readonly string[] = [
  "registry",
  "repositor",
  "package",
  "artifact",
  "provenance",
  "sbom",
  "publisher",
  "vendor",
  "maintainer",
  "homepage",
  "readme",
  "chart",
  "helm",
  "mirror",
];

// Exact publisher/registry hosts: fetching one of these IS a provenance
// lookup regardless of path. Dots are kept in the tokenization so hosts
// survive as single tokens.
const PUBLISHER_REGISTRY_HOSTS: ReadonlySet<string> = new Set([
  "hub.docker.com",
  "docker.io",
  "index.docker.io",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "mcr.microsoft.com",
  "registry.k8s.io",
  "k8s.gcr.io",
  "pypi.org",
  "pypi.python.org",
  "www.npmjs.com",
  "npmjs.com",
  "registry.npmjs.org",
  "crates.io",
  "pkg.go.dev",
  "artifacthub.io",
  "hub.helm.sh",
  "operatorhub.io",
  // Ecosystem registries the same review shape reaches for (independent
  // review of this delta: rubygems/Maven/ECR lookups credited nothing while
  // npm/PyPI did, so those PRs burned refusals until the attempts cap).
  "rubygems.org",
  "repo1.maven.org",
  "search.maven.org",
  "mvnrepository.com",
  "maven.google.com",
  "packagist.org",
  "nuget.org",
  "pub.dev",
  "registry.terraform.io",
  "registry.nuget.org",
  "public.ecr.aws",
  "gallery.ecr.aws",
  "us.gcr.io",
  "eu.gcr.io",
  "asia.gcr.io",
]);

// Source hosts: only the host's canonical repository URL counts as a
// provenance lookup — owner/repo on github.com/gitlab.com/bitbucket.org,
// org/project/_git/repo on dev.azure.com. A shallower path identifies no
// repository (a profile/user page, a bare host, an Azure organization or
// project), and a deeper path is doing something else (release pages,
// advisories, files) — review blocker 5738958165: a profile URL must not
// credit provenance and release the obligation window without an
// owner/repository lookup ever having been attempted.
const SOURCE_CODE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "dev.azure.com",
]);

/**
 * #1379 review blocker 5728634290: deterministic, conservative attribution
 * of one dependency-evidence call to the obligations its own target (the
 * `web_fetch` URL, the `web_search` query, or — #1726 — the forge-read
 * channel's endpoint path, recognized through the platform seam) says it is
 * serving. Bounded and lexical — never throws, never touches the network.
 * Only the upstream evidence channels attribute (`web_fetch`, `web_search`,
 * and the platform seam's forge-read channel — any other tool → `[]`); an
 * absent or non-string target attributes nothing. A call can cover several
 * obligations; matches are returned deduped in canonical
 * DEPENDENCY_EVIDENCE_OBLIGATIONS order (possibly empty — an unattributed
 * evidence call executed inside the enforced window still counts toward the
 * no-lockout attempts cap, just credits nothing; pre-window it counts only
 * toward the run-wide attempts telemetry).
 *
 * #1726: the forge-read channel attributes by the SAME lexical rules — an
 * upstream release/advisory/provenance lookup through the forge API is the
 * same acquisition as the equivalent web URL, and when a registry host is
 * refused by the source-host allowlist the forge API is exactly the channel
 * the run re-routes through (the organic #1721 failure: every successful
 * upstream lookup was a forge-read call, attributed nothing, so the tracked
 * rows never discharged, the reserved window never released, and the
 * evidence never reached the receipt ledger). The endpoint path plays the
 * URL's role: keyword tokens over the path, plus the canonical repository
 * identity shape the platform seam recognizes — a bare repository path
 * identifies the repo exactly the way the source host rule does, while
 * endpoints that address no repository and no evidence surface (issues,
 * users, metadata) attribute nothing.
 */
export function dependencyEvidenceObligationsForCall(
  name: string,
  args: Record<string, unknown>,
): DependencyEvidenceObligation[] {
  const forgeTarget = forgeReadChannelTarget(name, args);
  const isForgeRead = forgeTarget !== null;
  if (!DEPENDENCY_EVIDENCE_TOOLS.has(name) && !isForgeRead) return [];
  const target = name === "web_fetch" ? args.url : isForgeRead ? forgeTarget : args.query;
  if (typeof target !== "string" || target === "") return [];
  const lower = target.toLowerCase();
  const tokens = lower.split(/[^a-z0-9.]+/).filter((token) => token !== "");
  const matched = new Set<DependencyEvidenceObligation>();
  for (const token of tokens) {
    if (SECURITY_ADVISORY_TOKENS.some((keyword) => token.includes(keyword))) matched.add("security_advisory");
    if (RELEASE_DELTA_TOKENS.some((keyword) => token.includes(keyword))) matched.add("release_delta");
    if (PROVENANCE_TOKENS.some((keyword) => token.includes(keyword))) matched.add("provenance");
  }
  const hostToken = tokens.find((token) => token.includes("."));
  if (hostToken !== undefined) {
    const host = hostToken.replace(/^www\./, "");
    if (PUBLISHER_REGISTRY_HOSTS.has(host)) {
      matched.add("provenance");
    } else if (SOURCE_CODE_HOSTS.has(host)) {
      const afterHost = lower.slice(lower.indexOf(hostToken) + hostToken.length);
      const path = afterHost.split(/[?#]/, 1)[0] ?? "";
      const segments = path.split("/").filter((segment) => segment !== "");
      if (host === "dev.azure.com") {
        // Azure DevOps' canonical repository URL is org/project/_git/repo;
        // org or org/project name an organization/project, not a repository.
        if (segments.length === 4 && segments[2] === "_git") matched.add("provenance");
      } else if (segments.length === 2) {
        matched.add("provenance");
      }
    }
  }
  if (isForgeRead) {
    // The canonical forge-API repository shape comes from the platform seam
    // (the same repo identity the endpoint validator scopes). A DEEPER path
    // attributes through its own keyword tokens above, the same way a deep
    // URL path does.
    if (isCanonicalForgeApiRepoPath(forgeTarget)) matched.add("provenance");
  }
  return DEPENDENCY_EVIDENCE_OBLIGATIONS.filter((obligation) => matched.has(obligation));
}

/**
 * #1748 (canonical-source rule): the AUTHORITATIVE registry package identity
 * a web target names, or `null` when the target is not an authoritative
 * registry document for a package. The provenance obligation SETTLES only
 * from this shape (see `dependencyCellCovered`): a package's publisher/
 * canonical-source fact is owned by the registry that enforces slug
 * uniqueness for the ecosystem the dependency came from — npm here, the
 * only ecosystem the trusted scope parse reads today. ANY repo on a forge,
 * under ANY owner (including the true-sounding one), and any same-named
 * artifact on a DIFFERENT registry (PyPI, crates, …) is registrable by an
 * attacker and proves nothing about who publishes an npm dependency — a
 * receipt whose target merely carries the slug never settles provenance.
 *
 * The surfaces accepted are exactly the npm registry's package documents —
 * the API (`registry.npmjs.org`, including the `/-/package/<name>/…`
 * metadata endpoints) and the website's package pages (`npmjs.com`, with or
 * without `www.`) — and the package path must name the slug EXACTLY (after
 * the scope parser's own normalization: lowercased, leading `@` stripped):
 * the full packument `/<name>`, the versioned manifest `/<name>/<version>`,
 * `/-/package/<name>/<rest>`, and `/package/<name>[/<rest>]` website pages —
 * in either npm spelling of a scoped name: the plain two-segment form
 * `@scope/pkg` or the canonical single-segment encoded form `@scope%2Fpkg`
 * (that separator escape is the only accepted encoding; any other
 * percent-escape, a near-miss path (`lodash-es`), or an attacker-scoped
 * sibling `@evil/<name>` names no clean package document and binds
 * nothing). A shallower page (registry root, search endpoints, a publisher
 * profile) names no package document and binds nothing.
 * A host carrying user-info or a port stays unset — fail closed, never an
 * inferred identity. Lexical and total: never throws, never touches the
 * network.
 */
const NPM_REGISTRY_HOSTS: ReadonlySet<string> = new Set([
  "registry.npmjs.org",
  "npmjs.com",
]);

function registrySpecSlug(spec: string, rest: readonly string[]): string | null {
  // The npm registry's canonical URL for a scoped package folds the whole
  // name into ONE path segment with an encoded slash — `@scope%2Fpkg` — so
  // that separator escape is legitimate here and binds the slug. It is the
  // ONLY legitimate encoding: any other percent-escape (a double-encoded
  // `%252F`, an encoded name character, an unscoped `%`) is not a clean
  // package path — fail closed, never decoded-guessed. The decode is
  // bounded to splitting that one separator: the scope and name halves must
  // themselves be escape-free (and the name must not carry a second `@`),
  // so a crafted segment cannot smuggle a slash, a scope marker, or any
  // other identity character past this rule.
  if (spec.startsWith("@")) {
    const second = rest[0] ?? "";
    if (second.includes("%")) return null;
    if (spec.includes("%2f")) {
      const encoded = spec.split("%2f");
      const scope = encoded[0];
      const name = encoded[1];
      if (encoded.length !== 2 || scope === undefined || name === undefined) return null;
      // The scope marker is the ONE leading `@`; the bare scope and the name
      // must both be non-empty and escape-free.
      const bareScope = scope.slice(1);
      if (bareScope === "" || name === "" || scope.includes("%") || name.includes("%") || bareScope.includes("@") || name.includes("@")) {
        return null;
      }
      return `${bareScope}/${name}`;
    }
    if (second === "" || spec.includes("%")) return null;
    const slug = `${spec.slice(1)}/${second}`;
    return slug === "" ? null : slug;
  }
  // An unscoped name segment carries no legitimate encoding.
  if (spec === "" || spec.includes("%")) return null;
  return spec;
}

export function authoritativeRegistryPackageSlug(url: string): string | null {
  const lower = url.trim().toLowerCase();
  const schemeAt = lower.indexOf("://");
  if (schemeAt === -1) return null;
  const rest = lower.slice(schemeAt + 3);
  const pathStart = rest.indexOf("/");
  const rawHost = pathStart === -1 ? rest : rest.slice(0, pathStart);
  // A host carrying credentials or a port is not a clean registry origin.
  if (rawHost.includes("@") || rawHost.includes(":")) return null;
  const host = rawHost.replace(/^www\./, "");
  if (!NPM_REGISTRY_HOSTS.has(host)) return null;
  const rawPath = pathStart === -1 ? "" : (rest.slice(pathStart).split(/[?#]/, 1)[0] ?? "");
  const path = rawPath.replace(/\/+$/, "").replace(/^\//, "");
  if (path === "") return null;
  if (host === "registry.npmjs.org" && path.startsWith("-/package/")) {
    const after = path.slice("-/package/".length);
    const segments = after.split("/").filter((segment) => segment !== "");
    return registrySpecSlug(segments[0] ?? "", segments.slice(1));
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  if (host === "registry.npmjs.org") {
    return registrySpecSlug(segments[0] ?? "", segments.slice(1));
  }
  // The npm website: only /package/<name>[/<rest>] pages are package
  // documents (a profile, a search page, or the site root names no package).
  if (!path.startsWith("package/")) return null;
  const after = segments.slice(1);
  return registrySpecSlug(after[0] ?? "", after.slice(1));
}

// Container/OCI registries whose CATALOG page for the exact repository path
// is the publisher-authoritative identity surface for the artifact (the
// image/chart analogue of NPM_REGISTRY_HOSTS above): the host enforces path
// uniqueness under its namespaces, so only the exact catalog/manifest page
// binds the identity. `hub.docker.com`/`docker.io`, `ghcr.io`, and `quay.io`
// have their own path spellings and are handled separately; these accept the
// plain `<host>/<path…>` shape with at least two path segments.
const PLAIN_IMAGE_CATALOG_HOSTS: ReadonlySet<string> = new Set([
  "gcr.io",
  "us.gcr.io",
  "eu.gcr.io",
  "asia.gcr.io",
  "registry.k8s.io",
  "k8s.gcr.io",
  "mcr.microsoft.com",
  "public.ecr.aws",
  "gallery.ecr.aws",
]);

/**
 * #1763 (canonical-registry-catalog rule): the AUTHORITATIVE container-registry
 * catalog identity a web target is the catalog/manifest surface FOR, or `null`
 * when the target is not a canonical registry catalog page. This is the
 * image/chart analogue of `authoritativeRegistryPackageSlug` beside it: the
 * registry host enforces path uniqueness under its namespaces, so the catalog
 * page for the EXACT image path is the publisher-authoritative identity for
 * that artifact — the provenance obligation for an `image`/`chart` scope entry
 * SETTLES only from this shape (see `dependencyCellCovered`). A same-named
 * image under a different namespace, a source-repository read on a forge, or
 * a search query proves nothing about who publishes the artifact.
 *
 * The accepted spellings canonicalize every surface to the ONE lowercase
 * identity the trusted scope parse records:
 * - `hub.docker.com` / `docker.io`: `r/<owner>/<name>` →
 *   `docker.io/<owner>/<name>`, with the official-image `library` namespace
 *   collapsing to `docker.io/<name>`, the `/_/<name>` official-image
 *   spelling → `docker.io/<name>`, and the repository-API document
 *   `v2/repositories/<owner>/<name>[/<rest>]` (the publisher-metadata JSON
 *   surface, #1782) → the same identity; every other Docker Hub path shape
 *   (search, profile, deeper listing) binds nothing;
 * - `ghcr.io`: at least two path segments → `ghcr.io/<joined path>` (OCI
 *   charts live at deeper paths such as `prometheus-community/charts/<chart>`);
 * - `quay.io`: `repository/<a>/<b>` (the app-catalog surface) strips its
 *   `repository` marker → `quay.io/<a>/<b>`; plain `<a>/<b>` →
 *   `quay.io/<a>/<b>`; anything else nothing;
 * - `gcr.io` (plus the `us.`/`eu.`/`asia.` regional hosts), `registry.k8s.io`,
 *   `k8s.gcr.io`, `mcr.microsoft.com`, `public.ecr.aws`, `gallery.ecr.aws`:
 *   at least two path segments → `<host>/<joined path>`.
 * An off-vocabulary host, a shallower page (registry root, search page,
 * publisher profile), and any percent-escape anywhere in the path bind
 * NOTHING — fail closed, never a decoded-guessed identity. A host carrying
 * user-info or a port is not a clean registry origin. Lexical and total:
 * never throws, never touches the network.
 */
export function canonicalRegistryCatalogImageIdentity(url: string): string | null {
  const lower = url.trim().toLowerCase();
  const schemeAt = lower.indexOf("://");
  if (schemeAt === -1) return null;
  const rest = lower.slice(schemeAt + 3);
  const pathStart = rest.indexOf("/");
  const rawHost = pathStart === -1 ? rest : rest.slice(0, pathStart);
  // A host carrying credentials or a port is not a clean registry origin.
  if (rawHost.includes("@") || rawHost.includes(":")) return null;
  const host = rawHost.replace(/^www\./, "");
  const rawPath = pathStart === -1 ? "" : (rest.slice(pathStart).split(/[?#]/, 1)[0] ?? "");
  const segments = rawPath.replace(/\/$/, "").split("/").filter((segment) => segment !== "");
  if (segments.length === 0) return null;
  // The scope grammar carries bare path names; an escaped segment is never
  // decoded-guessed into one.
  if (segments.some((segment) => segment.includes("%"))) return null;
  if (host === "hub.docker.com" || host === "docker.io") {
    if (segments.length === 3 && segments[0] === "r") {
      const owner = segments[1]!;
      const name = segments[2]!;
      // Docker Hub canonicalizes an official image to `docker.io/<name>` —
      // the `library/` namespace is spelling, not identity.
      return owner === "library" ? `docker.io/${name}` : `docker.io/${owner}/${name}`;
    }
    if (segments.length === 2 && segments[0] === "_") return `docker.io/${segments[1]}`;
    // The repository API document (`/v2/repositories/<owner>/<name>`, the
    // shape a reviewer actually reaches for when it wants the repository
    // METADATA — the publisher-owned `source`/`repository` fields): the
    // exact repository path under the namespace-owning host, deeper
    // sub-resources (`/tags`, `/images`) are pages OF that same document's
    // repository. #1782: without this spelling the organic Hub JSON surface
    // was invisible to the mapping rule even when the publisher HAD set
    // `source`.
    if (segments.length >= 4 && segments[0] === "v2" && segments[1] === "repositories") {
      const owner = segments[2]!;
      const name = segments[3]!;
      return owner === "library" ? `docker.io/${name}` : `docker.io/${owner}/${name}`;
    }
    return null;
  }
  if (host === "ghcr.io") {
    return segments.length >= 2 ? `${host}/${segments.join("/")}` : null;
  }
  if (host === "quay.io") {
    if (segments.length === 3 && segments[0] === "repository") return `quay.io/${segments[1]}/${segments[2]}`;
    if (segments.length === 2) return `quay.io/${segments[0]}/${segments[1]}`;
    return null;
  }
  if (PLAIN_IMAGE_CATALOG_HOSTS.has(host)) {
    return segments.length >= 2 ? `${host}/${segments.join("/")}` : null;
  }
  return null;
}

/**
 * #1782 (independent review blocker 1): normalize one claimed source/build
 * repository value into the canonical `host/owner/repo` identity, or `null`
 * when the claim is not one clean repository identity. Accepted spellings:
 * an `http(s)://` URL or a bare `host/owner/repo`, each optionally deeper
 * (`/tree/<ref>`, `/releases`, …) and with a trailing `.git`; the `www.`
 * prefix is spelling, not identity. A host carrying user-info, a port, or
 * any percent-escape, a scheme other than http(s), or fewer than three
 * clean segments names no repository — fail closed, never a decoded-guessed
 * identity. Lexical and total: never throws.
 */
function normalizeSourceRepoClaim(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  // Printable ASCII only: zero-width and other invisible code points (JS
  // `\s` does not cover U+200B) must never ride a retained identity into
  // the artifact or render spoofably in diagnostics.
  if (value === "" || !/^[\x21-\x7e]+$/.test(value)) return null;
  const schemeAt = value.indexOf("://");
  let rest: string;
  if (schemeAt === -1) {
    if (value.includes(":")) return null;
    rest = value;
  } else {
    const scheme = value.slice(0, schemeAt);
    if (scheme !== "https" && scheme !== "http") return null;
    rest = value.slice(schemeAt + 3);
  }
  const path = rest.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length < 3) return null;
  // The spelling strips run to fixpoint so the rule is idempotent on its
  // own output (the persisted `source_repo` must survive the strict
  // reader's re-check): `www.www.`, `…git.git`.
  let host = segments[0]!;
  while (host.startsWith("www.")) host = host.slice("www.".length);
  const owner = segments[1]!;
  let repo = segments[2]!;
  while (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
  for (const segment of [host, owner, repo]) {
    if (segment === "" || segment.includes("@") || segment.includes(":") || segment.includes("%")) return null;
  }
  if (!host.includes(".")) return null;
  return `${host}/${owner}/${repo}`;
}

/** `org.opencontainers.image.source` in any publisher spelling: the JSON
 * annotation form of an OCI manifest/config document (`"key":"value"`), and
 * the Dockerfile `LABEL key=value` build-metadata form. */
const OCI_SOURCE_ANNOTATION_RE = /org\.opencontainers\.image\.source["']?\s*[:=]\s*["']?([^\s"',;}\]]+)/gi;

/** Registry-metadata JSON fields whose value IS the artifact's source/build
 * repository: Docker Hub's repository API `source`, Quay's application API
 * `repository`. Matched only as a strict quoted JSON key with a quoted
 * string value — prose that merely spells the word binds nothing. */
const REGISTRY_SOURCE_METADATA_RE = /"(?:source|repository)"\s*:\s*"([^"\r\n]+)"/gi;

/**
 * #1782 (independent review blocker 1): the bounded registry-artifact →
 * source/build-repository mapping a canonical registry document CLAIMS, as
 * the canonical `host/owner/repo` identity, or `null` when the document
 * carries no attributable mapping. #1763 requires image provenance to prove
 * the image/source relationship, not just a pullable artifact identity: a
 * successful fetch of the catalog URL proves the registry serves the slug,
 * never WHICH repository builds it — the claim must come from the document's
 * own content (verified OCI `org.opencontainers.image.source` annotations,
 * registry metadata `source`/`repository` fields, or the Dockerfile `LABEL`
 * spelling of the same annotation, read ONLY from a document fetched at the
 * canonical catalog identity for the exact artifact path, which the caller
 * enforces — the registry host enforces path uniqueness under its
 * namespaces, so the publisher's own document is the authority for its
 * source mapping). Every claim in the document must normalize to ONE
 * identity: a malformed/irrepresentable claim, or several claims naming
 * different repositories (a repacked or ambiguous document), yields `null`
 * — fail closed, never pick a convenient mapping. Lexical and total: never
 * throws, never touches the network.
 */
export function registryDocumentSourceRepo(content: string): string | null {
  let mapping: string | null = null;
  const claims = [
    ...content.matchAll(OCI_SOURCE_ANNOTATION_RE),
    ...content.matchAll(REGISTRY_SOURCE_METADATA_RE),
  ];
  for (const match of claims) {
    const claim = normalizeSourceRepoClaim(match[1] ?? "");
    if (claim === null) return null;
    if (mapping !== null && mapping !== claim) return null;
    mapping = claim;
  }
  return mapping;
}

/** Whether a persisted `source_repo` claim is exactly the canonical
 * normalized form `normalizeSourceRepoClaim` produces — the strict ledger
 * reader re-enforces the grammar on reload instead of trusting the shape
 * it wrote. Lexical, total. */
export function isCanonicalSourceRepoIdentity(value: string): boolean {
  return normalizeSourceRepoClaim(value) === value;
}

/**
 * #1782 (independent review blocker 2): the canonical source-repository
 * identity a FETCHED web surface addresses — `host/owner/repo` from the
 * target's host and first two path segments (deeper paths are pages OF that
 * repository: `/compare/…`, `/releases`, `/commit/…`), or `null` when the
 * target is not a clean repository surface (no path, user-info or port on
 * the host, any percent-escape, a non-http scheme). This is the surface-side
 * counterpart of `registryDocumentSourceRepo`: an upstream release/advisory
 * fetch speaks for the dependency exactly when the repository IT addresses
 * equals the source/build mapping the artifact's canonical registry document
 * established — never when it merely spells one segment of it. Lexical and
 * total: never throws, never touches the network.
 */
export function sourceRepoSurfaceIdentity(url: string): string | null {
  const value = url.trim().toLowerCase();
  const schemeAt = value.indexOf("://");
  if (schemeAt === -1) return null;
  const scheme = value.slice(0, schemeAt);
  if (scheme !== "https" && scheme !== "http") return null;
  const rest = value.slice(schemeAt + 3);
  const pathStart = rest.indexOf("/");
  const rawHost = pathStart === -1 ? rest : rest.slice(0, pathStart);
  if (rawHost.includes("@") || rawHost.includes(":")) return null;
  let host = rawHost;
  while (host.startsWith("www.")) host = host.slice("www.".length);
  if (host === "" || host.includes("%") || !host.includes(".")) return null;
  const rawPath = pathStart === -1 ? "" : (rest.slice(pathStart).split(/[?#]/, 1)[0] ?? "");
  const segments = rawPath.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  const owner = segments[0]!;
  let repo = segments[1]!;
  while (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
  if (owner === "" || repo === "" || owner.includes("%") || repo.includes("%")) return null;
  return `${host}/${owner}/${repo}`;
}

/**
 * #1782 (independent review round 2, blocker 1): the artifact→source/build
 * mapping the REGISTRY HOST ITSELF asserts through a validated redirect
 * chain. `ghcr.io` answers a fetch of a package path NOT with a document at
 * that path: the registry 303s to GitHub's package page for the exact
 * artifact, and GitHub's own Location chain lands on
 * `github.com/<owner>/<repo>/pkgs/container/<artifact>` — the page OF the
 * repository the registry's operator associates with the package. That
 * terminal URL is executor-attested (the web_fetch hop loop re-validates
 * every Location against the source-host allowlist and reports the chain's
 * terminal URL as `finalUrl`); it is the registry operator's statement of
 * the image/source relationship — namespace-uniqueness-bound, reachable on
 * the organic surface, and readable WITHOUT trusting any fetched body.
 * Returns the mapped `github.com/<owner>/<repo>` identity, or `null`:
 * - `null` unless the REQUESTED URL canonicalizes (via
 *   `canonicalRegistryCatalogImageIdentity`) to a `ghcr.io/…` slug — no
 *   other accepted registry host redirects to a repository-addressing
 *   package page, so no other host asserts a mapping this way;
 * - `null` unless the terminal URL is a clean repository surface
 *   (`sourceRepoSurfaceIdentity`) ON `github.com`, its FIRST two path
 *   segments, immediately followed by the exact `pkgs/container/<artifact>`
 *   marker — a lookalike that merely spells the marker deeper in the path,
 *   a `github.com/-/<owner>/packages/…` hop that never resolved to a
 *   repository, or any other page shape asserts nothing;
 * - `null` unless the marker's artifact segment decodes (the registry's own
 *   `%2f`-only spelling) to exactly the slug's path below the ghcr.io
 *   namespace — the redirect must speak about THIS artifact, not some other
 *   package on the same host. Any other percent-escape fails closed.
 * Lexical and total: never throws, never touches the network.
 */
export function registryRedirectSourceMapping(requestedUrl: string, finalUrl: string): string | null {
  const slug = canonicalRegistryCatalogImageIdentity(requestedUrl);
  if (slug === null || !slug.startsWith("ghcr.io/")) return null;
  const repo = sourceRepoSurfaceIdentity(finalUrl);
  if (repo === null || !repo.startsWith("github.com/")) return null;
  const lower = finalUrl.trim().toLowerCase();
  const rest = lower.slice(lower.indexOf("://") + 3);
  const pathStart = rest.indexOf("/");
  if (pathStart === -1) return null;
  const rawPath = rest.slice(pathStart).split(/[?#]/, 1)[0] ?? "";
  const segments = rawPath.split("/").filter((segment) => segment !== "");
  if (segments.length !== 5 || segments[2] !== "pkgs" || segments[3] !== "container") return null;
  // The reserved `-` namespace (the repository-INDEPENDENT package hop) is
  // not an owner: a five-segment lookalike of it asserts no repository.
  if (segments[0] === "-") return null;
  const encoded = segments[4]!;
  // The registry's own spelling of a nested artifact path is `%2f`-joined;
  // any OTHER percent-escape is not a clean identity character.
  if (encoded.replace(/%2f/g, "").includes("%")) return null;
  // The pkgs marker names the artifact BELOW the ghcr.io namespace; the
  // namespace itself is the slug's first path segment and is not part of
  // the encoded page spelling.
  const artifact = slug.split("/").slice(2).join("/");
  if (artifact === "" || encoded.replace(/%2f/g, "/") !== artifact) return null;
  return repo;
}

/**
 * #1396: the obligation a deterministic dependency-evidence `must_check`
 * checklist text names (the DEPENDENCY_EVIDENCE_CHECKS family templates), or
 * null for any other check. The harness uses it to map a shown obligation row
 * onto its dependency-evidence SHAPE vocabulary: a real provenance or
 * advisories fetch does not repeat the check's prose words, so gating it on
 * prose tokens would refuse the very call that discharges the obligation
 * (#1396's cross-starvation). Lexical, total, never throws.
 */
export function dependencyObligationForCheckText(text: string): DependencyEvidenceObligation | null {
  const lower = text.toLowerCase();
  if (/establish upstream provenance/.test(lower)) return "provenance";
  if (/release delta/.test(lower)) return "release_delta";
  if (/security advisories/.test(lower)) return "security_advisory";
  return null;
}
