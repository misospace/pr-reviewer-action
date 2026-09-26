/** Fixture-driven context CLIs for the #675 parity harness and tests-v3.
 * Each `run*Fixture` reads one JSON fixture and prints a single JSON line
 * `{ok, values}` (or `{ok:false, stderr}`) whose values are canonical
 * strings comparable byte-for-byte with the v2 side: artifacts serialize
 * through the explicit camelCase → snake_case serializers plus
 * `pythonJsonStringify` (sort_keys, ensure_ascii=False), documents render
 * through the byte-exact renderers. Network access is fixture-routed: the
 * image-provenance fixture supplies an ordered substring→payload table that
 * stands in for the registry/GitHub transport (fetch policy stays in v2). */

import { readFileSync } from "node:fs";
import { pythonJsonStringify } from "../precheck/metadata.js";
import {
  classifyUrl,
  extractCompareShas,
  extractGhcrImages,
  extractUrls,
  extractVersionHints,
  normalizeUrl,
  parseAllowedHosts,
  selectTargetVersion,
  urlClassificationToArtifact,
} from "./enrichment.js";
import {
  generateRepoMap,
  reframeForCorpus,
  RepoMapError,
  renderRepoMapJson,
  renderRepoMapMarkdown,
  repoMapToArtifact,
  trustFramingOverhead,
} from "./repo-map.js";
import { renderPrThread } from "./pr-thread.js";
import { enforcementView, prepareThreads, renderReviewThreads } from "./review-threads.js";
import { enforcementView as humanReviewEnforcementView, prepareReviews, renderOutstanding } from "./human-reviews.js";
import {
  buildRelatedContext,
  MAX_MARKDOWN_BYTES as MAX_MARKDOWN_BYTES_DEFAULT,
  relatedContextToArtifact,
  renderRelatedContextJson,
  renderRelatedContextMarkdown,
} from "./related-context.js";
import { buildImageProvenanceContext, parseDiff, type DigestChange } from "./image-provenance.js";

interface FixtureRecord {
  fixture?: string;
  [key: string]: unknown;
}

function loadFixture(fixturePath: string): FixtureRecord {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureRecord;
}

const fail = (stderr: string): { ok: false; stderr: string } => ({ ok: false, stderr });

// --- Enrichment normalization -------------------------------------------------

interface EnrichmentFixture extends FixtureRecord {
  body?: string;
  diff?: string;
  url_limit?: number | null;
  version_hint_limit?: number | null;
  allowed_hosts_raw?: string;
  title?: string | null;
  urls?: string[];
}

export function runEnrichmentFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = loadFixture(fixturePath) as EnrichmentFixture;
  const body = typeof fixture.body === "string" ? fixture.body : "";
  const diff = typeof fixture.diff === "string" ? fixture.diff : "";
  const urlLimit = "url_limit" in fixture ? (fixture.url_limit as number | null) : 25;
  const hintLimit = "version_hint_limit" in fixture ? (fixture.version_hint_limit as number | null) : 180;
  const urls = extractUrls(body, diff, urlLimit);
  const hints = extractVersionHints(diff, hintLimit);
  const targetVersion = selectTargetVersion(fixture.title ?? null, hints);
  const allowedHosts = [...parseAllowedHosts(typeof fixture.allowed_hosts_raw === "string" ? fixture.allowed_hosts_raw : "")].sort();
  const ghcrImages = extractGhcrImages(hints, diff);
  const compareShas = extractCompareShas(hints);
  const classified = (Array.isArray(fixture.urls) ? fixture.urls : []).map((url) => urlClassificationToArtifact(classifyUrl(url)));
  return {
    ok: true,
    values: {
      urls: pythonJsonStringify(urls),
      normalized_urls: pythonJsonStringify(urls.map((url) => normalizeUrl(url))),
      allowed_hosts: pythonJsonStringify(allowedHosts),
      version_hints: pythonJsonStringify(hints),
      target_version: pythonJsonStringify(targetVersion),
      ghcr_images: pythonJsonStringify(ghcrImages),
      compare_shas: pythonJsonStringify(compareShas),
      url_classes: pythonJsonStringify(classified),
    },
  };
}

// --- Repository map -------------------------------------------------------------

interface RepoMapFixture extends FixtureRecord {
  files?: unknown[];
  workspace?: string;
  options?: {
    max_depth?: number;
    max_entries?: number;
    max_files_per_category?: number;
    max_markdown_bytes?: number | null;
  };
}

export function runRepoMapFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = loadFixture(fixturePath) as RepoMapFixture;
  const workspace = process.env.PARITY_REPO_DIR ?? fixture.workspace ?? process.cwd();
  const options = fixture.options ?? {};
  try {
    const repoMap = generateRepoMap(workspace, {
      ...(typeof options.max_depth === "number" ? { maxDepth: options.max_depth } : {}),
      ...(typeof options.max_entries === "number" ? { maxEntries: options.max_entries } : {}),
      ...(typeof options.max_files_per_category === "number" ? { maxFilesPerCategory: options.max_files_per_category } : {}),
    });
    const markdown = renderRepoMapMarkdown(repoMap, options.max_markdown_bytes ?? null);
    return {
      ok: true,
      values: {
        repo_map: pythonJsonStringify(repoMapToArtifact(repoMap)),
        json_document: renderRepoMapJson(repoMap),
        markdown,
        framed_markdown: reframeForCorpus(markdown),
        framing_overhead: String(trustFramingOverhead(repoMap.version)),
      },
    };
  } catch (error) {
    if (error instanceof RepoMapError) return fail(error.message);
    throw error;
  }
}

// --- PR thread -------------------------------------------------------------------

interface PrThreadFixture extends FixtureRecord {
  comments?: unknown[];
  marker?: string;
  max_comments?: number;
  max_bytes?: number;
}

export function runPrThreadFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = loadFixture(fixturePath) as PrThreadFixture;
  const markdown = renderPrThread(
    Array.isArray(fixture.comments) ? fixture.comments : [],
    "marker" in fixture ? (fixture.marker as string) : undefined,
    "max_comments" in fixture ? (fixture.max_comments as number) : undefined,
    "max_bytes" in fixture ? (fixture.max_bytes as number) : undefined,
  );
  return { ok: true, values: { markdown } };
}

// --- Review threads (#766) ---------------------------------------------------

interface ReviewThreadsFixture extends FixtureRecord {
  threads?: unknown[];
  marker?: string;
  max_threads?: number;
  max_bytes?: number;
}

export function runReviewThreadsFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = loadFixture(fixturePath) as ReviewThreadsFixture;
  const threads = prepareThreads(
    Array.isArray(fixture.threads) ? fixture.threads : [],
    "marker" in fixture ? (fixture.marker as string) : undefined,
  );
  const [markdown, rendered] = renderReviewThreads(
    threads,
    "max_threads" in fixture ? (fixture.max_threads as number) : undefined,
    "max_bytes" in fixture ? (fixture.max_bytes as number) : undefined,
  );
  return { ok: true, values: { markdown, view: pythonJsonStringify(enforcementView(rendered)) } };
}

// --- Human reviews (outstanding change requests) -----------------------------

interface HumanReviewsFixture extends FixtureRecord {
  reviews?: unknown[];
  marker?: string;
  head_sha?: string | null;
  max_entries?: number;
  max_bytes?: number;
}

export function runHumanReviewsFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = loadFixture(fixturePath) as HumanReviewsFixture;
  const reviews = prepareReviews(
    Array.isArray(fixture.reviews) ? fixture.reviews : [],
    "marker" in fixture ? (fixture.marker as string) : undefined,
  );
  const [markdown, rendered] = renderOutstanding(
    reviews,
    "head_sha" in fixture ? (fixture.head_sha as string | null) : undefined,
    "max_entries" in fixture ? (fixture.max_entries as number) : undefined,
    "max_bytes" in fixture ? (fixture.max_bytes as number) : undefined,
  );
  return { ok: true, values: { markdown, view: pythonJsonStringify(humanReviewEnforcementView(rendered)) } };
}

// --- Related code -------------------------------------------------------------------

interface RelatedCodeFixture extends FixtureRecord {
  anchors?: unknown;
  files?: unknown[];
  workspace?: string;
  git_timeout?: number;
  markdown_max_bytes?: number;
}

export async function runRelatedCodeFixture(fixturePath: string): Promise<{ ok: boolean; values?: Record<string, string>; stderr?: string }> {
  const fixture = loadFixture(fixturePath) as RelatedCodeFixture;
  const workspace = process.env.PARITY_REPO_DIR ?? fixture.workspace ?? process.cwd();
  const related = await buildRelatedContext(fixture.anchors, workspace, Array.isArray(fixture.files) ? fixture.files : [], typeof fixture.git_timeout === "number" ? { gitTimeoutSec: fixture.git_timeout } : {});
  const artifact = relatedContextToArtifact(related);
  const markdownCap = "markdown_max_bytes" in fixture ? Number(fixture.markdown_max_bytes) : MAX_MARKDOWN_BYTES_DEFAULT;
  return {
    ok: true,
    values: {
      related: pythonJsonStringify(artifact),
      json_document: renderRelatedContextJson(artifact),
      markdown: renderRelatedContextMarkdown(artifact, markdownCap),
    },
  };
}

// --- Image provenance -------------------------------------------------------------------

interface HttpRoute {
  match: string;
  body?: unknown;
  error?: string;
}

interface ImageProvenanceFixture extends FixtureRecord {
  diff?: string;
  http?: HttpRoute[];
}

export async function runImageProvenanceFixture(fixturePath: string): Promise<{ ok: boolean; values?: Record<string, string>; stderr?: string }> {
  const fixture = loadFixture(fixturePath) as ImageProvenanceFixture;
  const routes = Array.isArray(fixture.http) ? fixture.http : [];
  const httpJson = async (url: string): Promise<unknown> => {
    for (const route of routes) {
      if (typeof route.match === "string" && url.includes(route.match)) {
        if (typeof route.error === "string") throw new Error(route.error);
        return route.body ?? null;
      }
    }
    throw new Error(`no fixture route for ${url}`);
  };
  const diffText = typeof fixture.diff === "string" ? fixture.diff : "";
  const changes: DigestChange[] = parseDiff(diffText);
  const markdown = await buildImageProvenanceContext(diffText, httpJson);
  return {
    ok: true,
    values: {
      changes: pythonJsonStringify(changes.map((change) => ({
        file: change.file,
        repository: change.repository,
        tag: change.tag,
        old_digest: change.oldDigest,
        new_digest: change.newDigest,
      }))),
      markdown,
    },
  };
}
