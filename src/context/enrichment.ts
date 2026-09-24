/** Pure PR-enrichment extraction/normalization (#675 port of
 * `pr_reviewer/enrichment.py`): URL extraction with redirect.github.com
 * normalization, the version-hint extractor (image/tag/version/chart/
 * appVersion/digest changed lines), target-version selection (title token
 * beats the last hint semver, `tail -n1` semantics), GHCR image extraction,
 * old→new compare-SHA extraction, and release/compare URL classification.
 * These are the enrichment *normalization* producers: text in, canonical
 * camelCase structures out — every consumer receives these objects instead of
 * re-running the brittle shell pipelines. Deliberately NOT ported here: the
 * host allowlist DNS resolution / public-IP checks (`host_allowed` and
 * friends) — that is fetch/security policy owned by the platform/tool
 * boundaries and stays in v2 until the fetch seam migrates. */

import { pySplitLines } from "../requirements/ledger.js";

// --- URL extraction ---------------------------------------------------------

const URL_RE = /https?:\/\/[^ )\r\n]+/g;

/** Extract unique sorted URLs from PR body and diff, strip trailing
 * punctuation. `limit = null` extracts unbounded. */
export function extractUrls(body: string, diff: string, limit: number | null = 25): string[] {
  const combined = `${body}\n${diff}`;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of combined.matchAll(URL_RE)) {
    const url = match[0].replace(/[".,;]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  urls.sort();
  return limit === null ? urls : urls.slice(0, limit);
}

/** Normalize redirect.github.com to github.com. */
export function normalizeUrl(url: string): string {
  if (url.startsWith("https://redirect.github.com/")) {
    return `https://github.com/${url.slice("https://redirect.github.com/".length)}`;
  }
  if (url.startsWith("http://redirect.github.com/")) {
    return `http://github.com/${url.slice("http://redirect.github.com/".length)}`;
  }
  return url;
}

// --- Host allowlist parsing (policy-free string normalization only) ---------

/** Parse comma-separated ALLOWED_SOURCE_HOSTS into a lowercase set. */
export function parseAllowedHosts(raw: string): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").filter((host) => host.trim() !== "").map((host) => host.trim().toLowerCase()));
}

/** Lowercase hostname of a URL (empty string when unparseable). */
export function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// --- Version hints -----------------------------------------------------------

const VERSION_HINT_RE = /^[+-].*(?:image:|tag:|version:|chart:|appVersion:|digest:)/;

/** Extract changed lines containing image/tag/version/chart/appVersion/digest.
 * `limit = null` extracts unbounded. */
export function extractVersionHints(diff: string, limit: number | null = 180): string[] {
  const hints: string[] = [];
  for (const line of pySplitLines(diff)) {
    if (VERSION_HINT_RE.test(line)) {
      hints.push(line);
      if (limit !== null && hints.length >= limit) break;
    }
  }
  return hints;
}

// --- Target version selection -------------------------------------------------

const TITLE_VERSION_RE = /v?(\d+(?:\.\d+)+)/g;
const HINT_VERSION_RE = /v?(\d+\.\d+\.\d+)/;

/** Select target version: title last version token > hint fallback > "".
 * Falls back to the *last* semver found in hints (matching the old shell
 * `tail -n1` semantics). Never throws; "" when no version is found. */
export function selectTargetVersion(title: string | null | undefined, versionHints: string[]): string {
  if (title) {
    const matches = [...title.matchAll(TITLE_VERSION_RE)].map((m) => m[1]);
    if (matches.length > 0) return matches[matches.length - 1] as string;
  }
  // Last semver in hints wins (tail -n1 semantics).
  let last: string | null = null;
  for (const hint of versionHints) {
    const match = HINT_VERSION_RE.exec(hint);
    if (match) last = match[1] as string;
  }
  return last ?? "";
}

// --- GHCR image extraction -----------------------------------------------------

const GHCR_RE = /(?:oci:\/\/)?ghcr\.io\/([^/]+(?:\/[^:"'@ )]+)+)/g;

/** Extract ghcr.io image/chart repos from version hints and diff, strip
 * tag/digest suffixes. Sorted, deduplicated. */
export function extractGhcrImages(versionHints: string[], diff: string): string[] {
  const combined = `${versionHints.join("\n")}\n${diff}`;
  const repos = new Set<string>();
  for (const match of combined.matchAll(GHCR_RE)) {
    const path = (match[1] as string).replace(/[:@].*/, "");
    if (path) repos.add(path);
  }
  return [...repos].sort();
}

// --- Compare SHA extraction ------------------------------------------------------

const HEX_SHA_RE = /\b([0-9a-fA-F]{7,40})\b/g;
const HEX_HAS_LETTER = /[a-fA-F]/;

/** Extract old→new short-SHA pair from version hints. Returns
 * `[oldSha, newSha]` when exactly one hex SHA on removed lines and exactly one
 * on added lines, both containing a-f, and different; null otherwise. */
export function extractCompareShas(versionHints: string[]): [string, string] | null {
  const oldShas = new Set<string>();
  const newShas = new Set<string>();
  for (const line of versionHints) {
    if (!line) continue;
    const hexShas = new Set(
      [...line.matchAll(HEX_SHA_RE)].map((m) => (m[1] as string).toLowerCase()).filter((sha) => HEX_HAS_LETTER.test(sha)),
    );
    if (line.startsWith("-")) {
      for (const sha of hexShas) oldShas.add(sha);
    } else if (line.startsWith("+")) {
      for (const sha of hexShas) newShas.add(sha);
    }
  }
  if (oldShas.size === 1 && newShas.size === 1) {
    const oldSha = [...oldShas][0] as string;
    const newSha = [...newShas][0] as string;
    if (oldSha !== newSha) return [oldSha, newSha];
  }
  return null;
}

// --- URL classification -----------------------------------------------------------

export type UrlClassification =
  | { type: "github_release"; owner: string; repo: string; tag: string }
  | { type: "github_compare"; owner: string; repo: string; compareSpec: string }
  | { type: "forgejo_release"; host: string; owner: string; repo: string; tag: string }
  | { type: "forgejo_compare"; host: string; owner: string; repo: string; compareSpec: string };

const GH_RELEASE_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/tag\/([^/?#]+)/;
const GH_COMPARE_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/compare\/([^?#]+)/;
const FORGE_RELEASE_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/releases\/tag\/([^/?#]+)/;
const FORGE_COMPARE_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/compare\/([^?#]+)/;

/** Classify a URL into GitHub/Forgejo release or compare metadata, or null.
 * Query strings and fragments in compare URLs do not break capture. */
export function classifyUrl(url: string): UrlClassification | null {
  const ghRelease = GH_RELEASE_RE.exec(url);
  if (ghRelease) {
    return { type: "github_release", owner: ghRelease[1] as string, repo: ghRelease[2] as string, tag: ghRelease[3] as string };
  }
  const ghCompare = GH_COMPARE_RE.exec(url);
  if (ghCompare) {
    return { type: "github_compare", owner: ghCompare[1] as string, repo: ghCompare[2] as string, compareSpec: ghCompare[3] as string };
  }
  // Forgejo (github.com is handled above)
  if (urlHost(url).toLowerCase() !== "github.com") {
    const forgeRelease = FORGE_RELEASE_RE.exec(url);
    if (forgeRelease) {
      return {
        type: "forgejo_release",
        host: forgeRelease[1] as string,
        owner: forgeRelease[2] as string,
        repo: forgeRelease[3] as string,
        tag: forgeRelease[4] as string,
      };
    }
    const forgeCompare = FORGE_COMPARE_RE.exec(url);
    if (forgeCompare) {
      return {
        type: "forgejo_compare",
        host: forgeCompare[1] as string,
        owner: forgeCompare[2] as string,
        repo: forgeCompare[3] as string,
        compareSpec: forgeCompare[4] as string,
      };
    }
  }
  return null;
}

// --- Artifact serialization (#669 camelCase → snake_case boundary) -----------

/** Serialize a classification to the v2-identical snake_case artifact shape. */
export function urlClassificationToArtifact(value: UrlClassification | null): Record<string, unknown> | null {
  if (value === null) return null;
  const base: Record<string, unknown> = { type: value.type };
  if ("host" in value) base.host = value.host;
  base.owner = value.owner;
  base.repo = value.repo;
  if ("tag" in value) base.tag = value.tag;
  else base.compare_spec = value.compareSpec;
  return base;
}
