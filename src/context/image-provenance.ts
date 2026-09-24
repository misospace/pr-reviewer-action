/** Image digest provenance (#675 port of the deterministic parts of
 * `scripts/image_digest_analysis.py`): `parseDiff` turns the raw diff into
 * old→new digest change records; `registryTargets` maps repositories onto
 * registry/token endpoints; `fetchDigestMetadata`/`fetchGithubCompare` shape
 * registry and GitHub API payloads into normalized provenance records via an
 * injected fetch seam; `resolveCompareRepo` picks the GitHub repo to compare
 * revisions against; and the renderer produces the exact `# Image Digest
 * Provenance Analysis` document. The HTTP transport itself (curl invocation,
 * budgets, tokens) is fetch policy and stays in v2 — this module only
 * normalizes data, with the network access parameterized. */

import { pySplitLines } from "../requirements/ledger.js";

export interface DigestChange {
  file: string;
  repository: string;
  tag: string;
  oldDigest: string;
  newDigest: string;
}

export interface DigestMeta {
  repository: string;
  digest: string;
  mediaType: string | null;
  configDigest: string | null;
  created: string | null;
  revision: string | null;
  source: string | null;
  version: string | null;
  refName: string | null;
  error: string | null;
  indexManifests: Array<{ digest: unknown; mediaType: unknown; platform: unknown }> | null;
}

export interface CompareResult {
  repo: string | null;
  old_revision: string | null;
  new_revision: string | null;
  status: unknown;
  ahead_by: unknown;
  behind_by: unknown;
  total_commits: unknown;
  html_url: unknown;
  commits: Array<{ sha: string; message: string }>;
  files: Array<{ filename: unknown; status: unknown; changes: unknown }>;
  error: string | null;
  repo_source: string | null;
}

export interface RegistryTargets {
  repoPath: string;
  tokenUrl: string;
  baseUrl: string;
}

const REPOSITORY_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

function validRepositoryPath(path: string): boolean {
  return path.length > 0 && path.split("/").every((part) => REPOSITORY_COMPONENT.test(part));
}

function registryAndPath(repo: string): { registry: string; path: string } {
  const parts = repo.split("/");
  const explicitRegistry = parts.length > 1 ? parts[0] as string : "";
  if (explicitRegistry === "docker.io" || explicitRegistry === "ghcr.io") {
    const path = parts.slice(1).join("/");
    if (!validRepositoryPath(path)) throw new Error(`invalid repository path for ${explicitRegistry}`);
    return { registry: explicitRegistry, path };
  }
  if (["quay.io", "gcr.io", "registry.k8s.io"].includes(explicitRegistry)) {
    throw new Error(`unsupported registry for repo ${repo}`);
  }
  if (parts.length === 2 && validRepositoryPath(repo)) return { registry: "docker.io", path: repo };
  throw new Error(`unsupported registry for repo ${repo}`);
}

/** Registry routing for anonymous pulls: docker.io (and bare owner/repo)
 * repos go to registry-1.docker.io with auth.docker.io tokens; ghcr.io repos
 * to ghcr.io with ghcr.io tokens. Unknown registries raise. */
export function registryTargets(repo: string): RegistryTargets {
  // urllib.parse.quote(..., safe=":") semantics: "/" stays literal (default
  // safe), ":" stays literal (explicit safe), everything reserved is %XX.
  const quote = (scope: string): string =>
    encodeURIComponent(scope)
      .replaceAll("%2F", "/")
      .replaceAll("%3A", ":")
      .replaceAll("%21", "!")
      .replaceAll("%27", "'")
      .replaceAll("%28", "(")
      .replaceAll("%29", ")")
      .replaceAll("%2A", "*");
  const { registry, path } = registryAndPath(repo);
  if (registry === "docker.io") {
    return {
      repoPath: path,
      tokenUrl: `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${quote(path)}:pull`,
      baseUrl: "https://registry-1.docker.io",
    };
  }
  return { repoPath: path, tokenUrl: `https://ghcr.io/token?scope=repository:${quote(path)}:pull`, baseUrl: "https://ghcr.io" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function labelsOfConfig(config: unknown): Record<string, unknown> {
  if (!isRecord(config)) return {};
  const direct = isRecord(config.config) ? (config.config as Record<string, unknown>) : null;
  const container = isRecord(config.container_config) ? (config.container_config as Record<string, unknown>) : null;
  const labels = (direct?.Labels as Record<string, unknown> | undefined) ?? (container?.Labels as Record<string, unknown> | undefined) ?? {};
  return isRecord(labels) ? labels : {};
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Shape a registry manifest + config blob pair into the normalized digest
 * metadata record (OCI labels drive the revision/source/version fields). */
export async function fetchDigestMetadata(
  repo: string,
  digest: string,
  httpJson: (url: string) => Promise<unknown>,
  deadline: number | null = null,
): Promise<DigestMeta> {
  const result: DigestMeta = {
    repository: repo,
    digest,
    mediaType: null,
    configDigest: null,
    created: null,
    revision: null,
    source: null,
    version: null,
    refName: null,
    error: null,
    indexManifests: null,
  };
  const run = async (): Promise<void> => {
    if (deadline !== null && Date.now() >= deadline) throw new Error("image digest time budget exceeded");
    const { repoPath, tokenUrl, baseUrl } = registryTargets(repo);

    const tokenBody = await httpJson(tokenUrl);
    const token = isRecord(tokenBody) ? tokenBody.token : undefined;
    if (!token || typeof token !== "string") throw new Error("registry token unavailable");
    const manifest = await httpJson(`${baseUrl}/v2/${repoPath}/manifests/${digest}`);
    if (!isRecord(manifest)) throw new Error("manifest is not a JSON object");
    result.mediaType = strOrNull(manifest.mediaType);
    if (Array.isArray(manifest.manifests)) {
      result.indexManifests = (manifest.manifests as unknown[]).slice(0, 6).map((entry) => {
        const rec = isRecord(entry) ? entry : {};
        return { digest: rec.digest ?? null, mediaType: rec.mediaType ?? null, platform: rec.platform ?? null };
      });
    }
    const config = isRecord(manifest.config) ? manifest.config : {};
    const configDigest = strOrNull(config.digest);
    result.configDigest = configDigest;
    if (configDigest) {
      if (deadline !== null && Date.now() >= deadline) throw new Error("image digest time budget exceeded");
      const blob = await httpJson(`${baseUrl}/v2/${repoPath}/blobs/${configDigest}`);
      if (!isRecord(blob)) throw new Error("config blob is not a JSON object");
      const labels = labelsOfConfig(blob);
      result.created = strOrNull(blob.created);
      result.revision = strOrNull(labels["org.opencontainers.image.revision"]);
      result.source = strOrNull(labels["org.opencontainers.image.source"]);
      result.version = strOrNull(labels["org.opencontainers.image.version"]);
      result.refName = strOrNull(labels["org.opencontainers.image.ref.name"]);
    }
  };
  try {
    await run();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** Map an OCI source label (or bare owner/repo string) onto a GitHub repo. */
export function githubRepoFromSource(source: string | null | undefined): string | null {
  if (!source) return null;
  const src = source.trim();
  const match = /github\.com[:/]([^/\s]+)\/([^/\s?#]+)/i.exec(src);
  if (match) {
    let repo = match[2] as string;
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    return `${match[1] as string}/${repo}`;
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(src)) return src;
  return null;
}

/** Heuristic: first two path segments of an image repo. */
export function guessRepoFromImage(imageRepo: string): string | null {
  let parsed: { registry: string; path: string };
  try {
    parsed = registryAndPath(imageRepo);
  } catch {
    return null;
  }
  const parts = parsed.path.split("/");
  if (parsed.registry === "docker.io" && parts.length === 1) return `library/${parts[0]}`;
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return null;
}

export async function fetchGithubCompare(
  repo: string | null,
  oldRev: string | null | undefined,
  newRev: string | null | undefined,
  httpJson: (url: string) => Promise<unknown>,
  deadline: number | null = null,
): Promise<CompareResult> {
  const result: CompareResult = {
    repo,
    old_revision: oldRev ?? null,
    new_revision: newRev ?? null,
    status: null,
    ahead_by: null,
    behind_by: null,
    total_commits: null,
    html_url: null,
    commits: [],
    files: [],
    error: null,
    repo_source: null,
  };
  if (!repo) {
    result.error = "repo unavailable";
    return Promise.resolve(result);
  }
  if (!oldRev || !newRev) {
    result.error = "revision labels missing";
    return Promise.resolve(result);
  }
  if (deadline !== null && Date.now() >= deadline) {
    result.error = "image digest time budget exceeded";
    return Promise.resolve(result);
  }
  const run = async (): Promise<void> => {
    const data = await httpJson(`https://api.github.com/repos/${repo}/compare/${oldRev}...${newRev}`);
    if (!isRecord(data)) throw new Error("compare payload is not a JSON object");
    result.status = data.status ?? null;
    result.ahead_by = data.ahead_by ?? null;
    result.behind_by = data.behind_by ?? null;
    result.total_commits = data.total_commits ?? null;
    result.html_url = data.html_url ?? null;
    result.commits = (Array.isArray(data.commits) ? (data.commits as unknown[]) : []).slice(0, 15).map((commit) => {
      const rec = isRecord(commit) ? commit : {};
      const info = isRecord(rec.commit) ? rec.commit : {};
      const message = typeof info.message === "string" ? info.message : "";
      const lines = pySplitLines(message);
      if (lines.length === 0) throw new Error("list index out of range");
      return { sha: (typeof rec.sha === "string" ? rec.sha : "").slice(0, 12), message: lines[0] as string };
    });
    result.files = (Array.isArray(data.files) ? (data.files as unknown[]) : []).slice(0, 20).map((file) => {
      const rec = isRecord(file) ? file : {};
      return { filename: rec.filename ?? null, status: rec.status ?? null, changes: rec.changes ?? null };
    });
  };
  try {
    await run();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export interface ResolvedCompareRepo {
  compareRepo: string | null;
  compareRepoSource: string;
  mismatch: [string, string] | null;
}

/** Pick the GitHub repo to compare revisions against: agreeing OCI source
 * labels win, then whichever side has a label, then the image-repo
 * heuristic. Disagreeing labels are reported as a mismatch. */
export function resolveCompareRepo(oldMeta: DigestMeta, newMeta: DigestMeta, imageRepo: string): ResolvedCompareRepo {
  const oldRepo = githubRepoFromSource(oldMeta.source);
  const newRepo = githubRepoFromSource(newMeta.source);
  let compareRepo: string | null = null;
  let compareRepoSource = "";
  let mismatch: [string, string] | null = null;
  if (oldRepo && newRepo && oldRepo === newRepo) {
    compareRepo = oldRepo;
    compareRepoSource = "oci-source-label";
  } else if (oldRepo && !newRepo) {
    compareRepo = oldRepo;
    compareRepoSource = "oci-source-label-old";
  } else if (newRepo && !oldRepo) {
    compareRepo = newRepo;
    compareRepoSource = "oci-source-label-new";
  } else if (oldRepo && newRepo && oldRepo !== newRepo) {
    mismatch = [oldRepo, newRepo];
  }
  if (!compareRepo) {
    const guessed = guessRepoFromImage(imageRepo);
    if (guessed) {
      compareRepo = guessed;
      compareRepoSource = "image-repo-heuristic";
    }
  }
  return { compareRepo, compareRepoSource, mismatch };
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

interface DigestBucket {
  old: string[];
  new: string[];
}

const DIFF_FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const REPO_RE = /^[ +\-]?\s*repository:\s*['"]?([^'"\s,]+)/;
const TAG_RE = /^([+-])\s*tag:\s*['"]?([^'"\s,]+)/;
const TAG_DIGEST_RE = /([^@\s]+)@sha256:([0-9a-f]{64})/;
const DIGEST_ONLY_RE = /^([+-])\s*digest:\s*['"]?(sha256:[0-9a-f]{64})/;
const IMAGE_RE = /^([+-])\s*image:\s*['"]?([^'"\s,]+@sha256:[0-9a-f]{64})/;

/** Parse image digest changes out of the diff: repository:/tag:/digest:/
 * image: lines are bucketed per (file, repo, tag) and paired old→new in
 * first-seen order (matching the v2 dict insertion order). */
export function parseDiff(diffText: string): DigestChange[] {
  let currentFile = "";
  let currentRepo = "";
  const buckets = new Map<string, DigestBucket>();

  const bucketFor = (key: string): DigestBucket => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { old: [], new: [] };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const raw of pySplitLines(diffText)) {
    const matchFile = DIFF_FILE_RE.exec(raw);
    if (matchFile) {
      currentFile = matchFile[2] as string;
      currentRepo = "";
      continue;
    }
    const matchRepo = REPO_RE.exec(raw);
    if (matchRepo) {
      currentRepo = matchRepo[1] as string;
      continue;
    }
    const matchTag = TAG_RE.exec(raw);
    if (matchTag) {
      const sign = matchTag[1] as string;
      const tagVal = matchTag[2] as string;
      const matchDigest = TAG_DIGEST_RE.exec(tagVal);
      if (matchDigest && currentRepo) {
        const tagBase = matchDigest[1] as string;
        const digest = `sha256:${matchDigest[2] as string}`;
        const key = `${currentFile}\u0000${currentRepo}\u0000${tagBase}`;
        bucketFor(key)[sign === "-" ? "old" : "new"].push(digest);
      } else if (currentRepo) {
        const key = `${currentFile}\u0000${currentRepo}\u0000${tagVal}`;
        bucketFor(key);
      }
      continue;
    }
    const matchDigestOnly = DIGEST_ONLY_RE.exec(raw);
    if (matchDigestOnly && currentRepo) {
      const sign = matchDigestOnly[1] as string;
      const digest = matchDigestOnly[2] as string;
      const key = `${currentFile}\u0000${currentRepo}\u0000(digest-only)`;
      bucketFor(key)[sign === "-" ? "old" : "new"].push(digest);
      continue;
    }
    const matchImage = IMAGE_RE.exec(raw);
    if (matchImage) {
      const sign = matchImage[1] as string;
      const imageRef = matchImage[2] as string;
      const [repoAndTag, digestRaw] = imageRef.split("@", 2) as [string, string];
      const digest = digestRaw.startsWith("sha256:") ? digestRaw : `sha256:${digestRaw}`;
      let repo = repoAndTag;
      let tagBase = "(inline-image)";
      const lastSegment = repoAndTag.includes("/") ? repoAndTag.slice(repoAndTag.lastIndexOf("/") + 1) : repoAndTag;
      if (lastSegment.includes(":")) {
        const splitIndex = repoAndTag.lastIndexOf(":");
        repo = repoAndTag.slice(0, splitIndex);
        tagBase = repoAndTag.slice(splitIndex + 1);
      }
      const key = `${currentFile}\u0000${repo}\u0000${tagBase}`;
      bucketFor(key)[sign === "-" ? "old" : "new"].push(digest);
    }
  }

  const changes: DigestChange[] = [];
  for (const [key, values] of buckets) {
    const [filePath, repo, tagBase] = key.split("\u0000") as [string, string, string];
    const pairs = Math.min(values.old.length, values.new.length);
    for (let index = 0; index < pairs; index += 1) {
      const oldDigest = values.old[index] as string;
      const newDigest = values.new[index] as string;
      if (oldDigest !== newDigest) {
        changes.push({ file: filePath, repository: repo, tag: tagBase, oldDigest, newDigest });
      }
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function short(value: unknown): string {
  if (!value) return "(unknown)";
  if (typeof value === "string" && value.length > 120) return value.slice(0, 117) + "...";
  return String(value);
}

/** Fetch metadata for every unique (repository, digest) pair, sequentially
 * (the v2 runs pairs in parallel; the results are order-independent and the
 * pair set is deterministic). */
export async function fetchAllMetadata(
  changes: readonly DigestChange[],
  httpJson: (url: string) => Promise<unknown>,
  deadline: number | null = null,
): Promise<Map<string, DigestMeta>> {
  const pairs = [...new Set(changes.flatMap((change) => [`${change.repository}\u0000${change.oldDigest}`, `${change.repository}\u0000${change.newDigest}`]))].sort();
  const metas = new Map<string, DigestMeta>();
  for (const pair of pairs) {
    const [repo, digest] = pair.split("\u0000") as [string, string];
    metas.set(pair, await fetchDigestMetadata(repo, digest, httpJson, deadline));
  }
  return metas;
}

/** Full provenance document for a diff, with the registry/GitHub reads
 * routed through the injected *httpJson* seam (null deadline = unbounded). */
export async function buildImageProvenanceContext(
  diffText: string,
  httpJson: (url: string) => Promise<unknown>,
  deadline: number | null = null,
): Promise<string> {
  const changes = parseDiff(diffText);
  const lines: string[] = [];
  if (changes.length === 0) {
    lines.push("No image digest changes detected in PR diff.");
  } else {
    const metas = await fetchAllMetadata(changes, httpJson, deadline);

    // Wave 2: revision compares, deduplicated by (repo, old_rev, new_rev).
    const prepared: Array<{
      change: DigestChange;
      oldMeta: DigestMeta;
      newMeta: DigestMeta;
      compareRepo: string | null;
      compareRepoSource: string;
      mismatch: [string, string] | null;
      key: [string, string, string];
    }> = [];
    const compareKeys = new Set<string>();
    for (const change of changes) {
      const oldMeta = metas.get(`${change.repository}\u0000${change.oldDigest}`) as DigestMeta;
      const newMeta = metas.get(`${change.repository}\u0000${change.newDigest}`) as DigestMeta;
      const { compareRepo, compareRepoSource, mismatch } = resolveCompareRepo(oldMeta, newMeta, change.repository);
      const key = `${compareRepo ?? "None"}\u0000${oldMeta.revision ?? "None"}\u0000${newMeta.revision ?? "None"}`;
      compareKeys.add(key);
      prepared.push({ change, oldMeta, newMeta, compareRepo, compareRepoSource, mismatch, key: key.split("\u0000") as [string, string, string] });
    }

    const keySortString = (parts: [string, string, string]): string => parts.map((p) => String(p)).join("\u0000");
    const sortedKeys = [...compareKeys].sort((a, b) => {
      const left = a.split("\u0000");
      const right = b.split("\u0000");
      for (let i = 0; i < left.length; i += 1) {
        const l = left[i] as string;
        const r = right[i] as string;
        if (l !== r) return l < r ? -1 : 1;
      }
      return 0;
    });
    const compares = new Map<string, CompareResult>();
    for (const key of sortedKeys) {
      const parts = key.split("\u0000");
      const repo: string | null = parts[0] === "None" ? null : (parts[0] as string);
      const oldRev: string | null = parts[1] === "None" ? null : (parts[1] as string);
      const newRev: string | null = parts[2] === "None" ? null : (parts[2] as string);
      compares.set(key, await fetchGithubCompare(repo, oldRev, newRev, httpJson, deadline));
    }

    lines.push("# Image Digest Provenance Analysis");
    lines.push("");
    let index = 1;
    for (const { change, oldMeta, newMeta, compareRepo, compareRepoSource, mismatch, key } of prepared) {
      lines.push(`## Image ${index}: ${change.repository}`);
      lines.push(`- File: \`${change.file}\``);
      lines.push(`- Tag/variant: \`${change.tag}\``);
      lines.push(`- Old digest: \`${change.oldDigest}\``);
      lines.push(`- New digest: \`${change.newDigest}\``);
      lines.push(`- Old revision: \`${short(oldMeta.revision)}\``);
      lines.push(`- New revision: \`${short(newMeta.revision)}\``);
      lines.push(`- Old created: \`${short(oldMeta.created)}\``);
      lines.push(`- New created: \`${short(newMeta.created)}\``);
      lines.push(`- Old source: \`${short(oldMeta.source)}\``);
      lines.push(`- New source: \`${short(newMeta.source)}\``);

      const oldRev = oldMeta.revision;
      const newRev = newMeta.revision;
      if (oldRev && newRev) {
        if (oldRev !== newRev) {
          lines.push("- Revision changed: **yes** (new code revision present)");
        } else {
          lines.push("- Revision changed: **no** (likely rebuild or republish of same source revision)");
        }
      } else {
        lines.push("- Revision changed: **unknown** (missing OCI revision labels)");
      }

      if (mismatch) {
        lines.push(`- Root repo mismatch between old/new labels: \`${mismatch[0]}\` vs \`${mismatch[1]}\``);
      }

      const compare = compares.get(keySortString(key)) as CompareResult;

      lines.push(`- Root repo for commit compare: \`${short(compareRepo)}\` (source: \`${short(compareRepoSource || "none")}\`)`);
      if (compare.html_url) lines.push(`- Commit compare URL: ${String(compare.html_url)}`);
      if (compare.total_commits !== null) {
        lines.push(`- Compare summary: status=${short(compare.status)}, total_commits=${short(compare.total_commits)}, ahead_by=${short(compare.ahead_by)}, behind_by=${short(compare.behind_by)}`);
      } else if (compare.error) {
        lines.push(`- Compare lookup: **unavailable** (${short(compare.error)})`);
      }

      const commits = compare.commits;
      if (commits.length > 0) {
        lines.push("- Commits between old/new revision:");
        for (const commit of commits) {
          lines.push(`  - \`${short(commit.sha)}\` ${short(commit.message)}`);
        }
      }

      const files = compare.files;
      if (files.length > 0) {
        lines.push("- Changed files in root repo compare (first 20):");
        for (const file of files) {
          lines.push(`  - \`${short(file.filename)}\` status=${short(file.status)} changes=${short(file.changes)}`);
        }
      }

      // The bullets above already carry every field the reviewer needs; the
      // full metadata JSON dumps doubled this section's size for no added
      // signal. Keep only fetch errors, which the bullets omit.
      if (oldMeta.error) lines.push(`- Old digest metadata error: \`${short(oldMeta.error)}\``);
      if (newMeta.error) lines.push(`- New digest metadata error: \`${short(newMeta.error)}\``);
      lines.push("");
      index += 1;
    }
  }
  return `${lines.join("\n")}\n`;
}
