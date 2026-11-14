/**
 * #1379: the deterministic dependency-evidence attribution vocabulary —
 * moved here from `src/tools/loop.ts` (#1657) so the enforcement-side
 * evidence-receipt layer (`src/enforcement/evidence-receipts.ts`) can share
 * ONE attribution implementation without importing the loop (an
 * enforcement → tools/loop edge closes a module cycle through
 * requirement-trace). Pure, lexical, total: never throws, never touches the
 * network.
 */
export const DEPENDENCY_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
]);

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
 * `web_fetch` URL or the `web_search` query) says it is serving. Bounded and
 * lexical — never throws, never touches the network. Only names in
 * DEPENDENCY_EVIDENCE_TOOLS attribute (any other tool → `[]`); an absent or
 * non-string target attributes nothing. A call can cover several
 * obligations; matches are returned deduped in canonical
 * DEPENDENCY_EVIDENCE_OBLIGATIONS order (possibly empty — an unattributed
 * evidence call executed inside the enforced window still counts toward the
 * no-lockout attempts cap, just credits nothing; pre-window it counts only
 * toward the run-wide attempts telemetry).
 */
export function dependencyEvidenceObligationsForCall(
  name: string,
  args: Record<string, unknown>,
): DependencyEvidenceObligation[] {
  if (!DEPENDENCY_EVIDENCE_TOOLS.has(name)) return [];
  const target = name === "web_fetch" ? args.url : args.query;
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
  return DEPENDENCY_EVIDENCE_OBLIGATIONS.filter((obligation) => matched.has(obligation));
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
