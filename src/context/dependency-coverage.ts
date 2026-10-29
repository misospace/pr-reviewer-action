/** #1337: deterministic dependency-upgrade coverage accounting.
 *
 * Builds the bounded corpus section `# Dependency Upgrade Coverage
 * Accounting` for dependency-upgrade PRs. For every detected dependency
 * change it states, per coverage aspect, what the deterministic layer
 * itself established versus what is explicitly not checked — so a
 * completed negative check is never indistinguishable from a skipped one
 * and provenance/signature verification can never be fabricated from
 * unrelated release metadata (issue #1337: a release note's cosign example
 * for `ghcr.io/berriai/litellm` proves nothing about the deployed
 * `ghcr.io/berriai/litellm-database` image).
 *
 * Everything interpolated from the diff or PR body is untrusted data:
 * values are collapsed to single bounded lines and rendered as list
 * bullets only, so no PR-controlled byte can forge a heading, a row, or a
 * fence. Detection is deterministic: image digest changes reuse
 * `parseDiff` from the image-provenance layer, plain tag bumps get their
 * own parser with the same bucketing shape. An empty string is returned
 * when nothing dependency-shaped is detected, so non-dependency PRs keep
 * today's corpus byte-for-byte.
 */

import { pySplitLines } from "../requirements/ledger.js";
import { parseDiff } from "./image-provenance.js";
import { DEPENDENCY_COVERAGE_ASPECTS } from "../model/dependency-coverage.js";

/** Hard row cap: over-cap detection is reported, not silently truncated. */
export const MAX_DEPENDENCY_CHANGES = 12;

export interface DependencyChange {
  file: string;
  repository: string;
  tag: string;
  /** Old/new version values as they appeared in the diff (either may be
   * empty for one-sided detections such as an added pin). */
  oldVersion: string;
  newVersion: string;
  /** `digest` when the change pairs full image digests, `tag` for a plain
   * tag/version value bump. */
  kind: "digest" | "tag";
}

export interface BuildDependencyCoverageInput {
  /** Classification pr_kind — the same infra set the prompt fragment
   * gates on (the section stays empty for other kinds). */
  prKind: string;
  /** Full PR diff text (deterministic detection only, never rendered whole). */
  diffText: string;
  /** Redacted PR body text (release-notes link detection only). */
  prBody: string | null | undefined;
}

/** The kinds the coverage accounting section and prompt fragment gate on —
 * the "infra" set `VERSION_BUMP_GUIDANCE` uses plus the two digest-only
 * kinds (a digest-only image update is exactly the shape where signature
 * verification accounting matters most). */
export function dependencyCoverageKindEnabled(prKind: string): boolean {
  return (
    prKind === "dependency_upgrade" ||
    prKind === "k8s_manifest" ||
    prKind === "renovate_chart_update" ||
    prKind === "renovate_image_update" ||
    prKind === "renovate_digest_only" ||
    prKind === "image_digest_only"
  );
}

// Diff parsing (mirror of image-provenance.ts's lexical rules, kept local so
// the digest parser's behavior is never perturbed).

const DIFF_FILE_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const REPO_RE = /^[ +\-]?\s*repository:\s*['"]?([^'"\s,]+)/;
const TAG_LINE_RE = /^([+-])\s*tag:\s*['"]?([^'"\s,]+)/;
const IMAGE_TAG_RE = /^([+-])\s*image:\s*['"]?([^'"\s,]+)$/;
const DIGEST_IN_VALUE_RE = /@sha256:[0-9a-f]{64}/;
const CHART_VERSION_RE = /^([+-])\s*(?:version|appVersion):\s*['"]?([^'"\s,]+)/;
const APP_VERSION_KEY_RE = /^[+-]\s*appVersion:/;

/** Bucketed old→new value pairing, first-seen order (v2 dict-insertion
 * parity with `parseDiff`). */
interface ValueBucket {
  old: string[];
  new: string[];
}

/** Detect plain tag/version bumps in the diff: a `tag:`, `image:` (tag-only
 * form) or `version:`/`appVersion:` line whose VALUE changed while the
 * surrounding key and (where named) repository stayed fixed. Values with an
 * inline digest are left to `parseDiff` — double-counting one change would
 * double the coverage rows. Buckets pair by STABLE identity (file +
 * repository + key kind), never by the changing value itself. */
export function parseTagChanges(diffText: string): DependencyChange[] {
  let currentFile = "";
  let currentRepo = "";
  const buckets = new Map<string, { file: string; repoIdentity: string; tagLabel: string; values: ValueBucket }>();

  const bucketFor = (file: string, repoIdentity: string, tagLabel: string): ValueBucket => {
    const mapKey = `${file}\u0000${repoIdentity}\u0000${tagLabel}`;
    let bucket = buckets.get(mapKey);
    if (!bucket) {
      bucket = { file, repoIdentity, tagLabel, values: { old: [], new: [] } };
      buckets.set(mapKey, bucket);
    }
    return bucket.values;
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
    const rule = (sign: string, value: string, repoIdentity: string, tagLabel: string): void => {
      if (DIGEST_IN_VALUE_RE.test(value)) return;
      bucketFor(currentFile, repoIdentity, tagLabel)[sign === "-" ? "old" : "new"].push(value);
    };
    const matchTag = TAG_LINE_RE.exec(raw);
    if (matchTag) {
      rule(matchTag[1] as string, matchTag[2] as string, currentRepo, "(tag-line)");
      continue;
    }
    const matchImage = IMAGE_TAG_RE.exec(raw);
    if (matchImage) {
      const imageRef = matchImage[2] as string;
      if (DIGEST_IN_VALUE_RE.test(imageRef)) continue; // parseDiff's record
      const splitIndex = imageRef.lastIndexOf(":");
      if (splitIndex <= imageRef.lastIndexOf("/")) continue; // no tag component
      const repoIdentity = imageRef.slice(0, splitIndex);
      rule(matchImage[1] as string, imageRef.slice(splitIndex + 1), repoIdentity, "(image-line)");
      continue;
    }
    const matchChart = CHART_VERSION_RE.exec(raw);
    if (matchChart) {
      // `version:` and `appVersion:` are distinct keys with independent
      // values — separate identities, never positional cross-pairs.
      const label = raw.match(APP_VERSION_KEY_RE) !== null ? "(chart-appVersion)" : "(chart-version)";
      rule(matchChart[1] as string, matchChart[2] as string, currentRepo, label);
    }
  }

  const changes: DependencyChange[] = [];
  for (const { file, repoIdentity, tagLabel, values } of buckets.values()) {
    const pairs = Math.min(values.old.length, values.new.length);
    for (let index = 0; index < pairs; index += 1) {
      const oldVersion = values.old[index] as string;
      const newVersion = values.new[index] as string;
      if (oldVersion !== newVersion) {
        changes.push({
          file,
          repository: repoIdentity,
          // Identity label, not the (changing) value: the old→new values
          // render in their own row below.
          tag: tagLabel,
          oldVersion,
          newVersion,
          kind: "tag",
        });
      }
    }
  }
  return changes;
}

/** An untrusted one-line value: control chars and line breaks collapse to
 * spaces, backticks are removed (they must never render as code spans or
 * fence runs inside a list bullet), and the value is capped. */
function safeInlineValue(value: string, cap = 120): string {
  const collapsed = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/`/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed.length > cap ? collapsed.slice(0, cap - 1) + "…" : collapsed;
}

const safeOrUnknown = (value: string): string => (value === "" ? "(unknown)" : safeInlineValue(value));

/** Release-notes evidence heuristic (bounded, deterministic): Renovate
 * bodies conventionally carry release/changelog links. The heuristic only
 * reports that a link-SHAPED line exists — the PR author controls the
 * body, so this is never treated as verified provenance or as fetched
 * release notes. Never parsed as instructions. */
function releaseNotesState(prBody: string | null | undefined): { found: boolean; detail: string } {
  if (typeof prBody !== "string" || prBody.trim() === "") {
    return { found: false, detail: "no release-notes-style link in PR body; consult the commit-compare evidence in the corpus or report release_notes: unavailable" };
  }
  const lines = pySplitLines(prBody).filter((line) =>
    /\b(releases|release|changelog)\b/i.test(line) && /https?:\/\//.test(line),
  );
  if (lines.length === 0) {
    return { found: false, detail: "no release-notes-style link in PR body; consult the commit-compare evidence in the corpus or report release_notes: unavailable" };
  }
  return { found: true, detail: `unverified release-notes-style link present in PR body (${Math.min(lines.length, 3)} line(s); author-controlled — consult the commit-compare evidence in the corpus before treating it as release notes)` };
}

/** Build the deterministic coverage-accounting section. Empty string when
 * the kind is out of scope or no dependency change is detected. */
export function buildDependencyCoverageContext(input: BuildDependencyCoverageInput): string {
  if (!dependencyCoverageKindEnabled(input.prKind)) return "";

  // Digest changes come from the provenance layer's own parser so the two
  // sections always agree on what changed.
  const digestChanges = parseDigestChangesSafe(input.diffText);
  const tagChanges = parseTagChanges(input.diffText);
  const changes = [...digestChanges, ...tagChanges];
  if (changes.length === 0) return "";

  const notes = releaseNotesState(input.prBody);
  const lines: string[] = [];
  lines.push("# Dependency Upgrade Coverage Accounting");
  lines.push("");
  lines.push(
    "Deterministic coverage accounting for this dependency upgrade. Each aspect below states what the harness itself established; aspects marked `not checked` were NOT investigated and must never be reported as completed negative checks (a missing advisory lookup is `not_checked`, never \"no known vulnerabilities\"). Signature verification is never grounded in a successful image pull or a signing example in release notes — especially one naming a different image than the one deployed.",
  );
  lines.push("");
  lines.push(`- Release-notes evidence: ${notes.detail}`);
  for (const [index, change] of changes.slice(0, MAX_DEPENDENCY_CHANGES).entries()) {
    lines.push(`## Change ${index + 1}: ${safeOrUnknown(change.repository)}`);
    lines.push(`- File: \`${safeInlineValue(change.file)}\``);
    lines.push(`- ${change.kind === "digest" ? "Image digest" : "Version/tag"}: \`${safeOrUnknown(change.oldVersion)}\` → \`${safeOrUnknown(change.newVersion)}\``);
    for (const aspect of DEPENDENCY_COVERAGE_ASPECTS) {
      lines.push(`- ${aspect}: ${deterministicAspectState(aspect, change)}`);
    }
  }
  if (changes.length > MAX_DEPENDENCY_CHANGES) {
    lines.push(`- (+${changes.length - MAX_DEPENDENCY_CHANGES} more dependency changes not itemized; report coverage for the upgrade as a whole)`);
  }
  lines.push("");
  lines.push(
    "Report the machine-readable `dependency_coverage` answer for these aspects using ONLY these closed values — `aspect` one of source_mapping, release_notes, advisories, signature_verification, relevance; `status` one of checked_no_match, finding_present, unavailable, not_checked, skipped — with an optional one-sentence grounded `note`. Coverage gaps are informational: they never justify a finding or a change of verdict on their own.",
  );
  return `${lines.join("\n")}\n`;
}

function deterministicAspectState(aspect: string, change: DependencyChange): string {
  switch (aspect) {
    case "source_mapping":
      return "deterministic evidence: image repository and tag/digest pair in this row; canonical upstream mapping requires the OCI source labels in the Image Digest Provenance section when present — state unknown when that section shows no source label";
    case "release_notes":
      return "deterministic evidence: the release-notes link state in this section; the compare/review investigation path is the reviewer's";
    case "advisories":
      return "not checked (the harness performs no advisory lookup; a missing lookup is `not_checked`, never \"no known vulnerabilities\")";
    case "signature_verification":
      return `not checked (no verification receipt exists; a registry pull or a cosign example in release notes — even for \`${safeInlineValue(change.repository)}\` — is not verification)`;
    case "relevance":
      return "reviewer assessment required (relevance to the deployed version/configuration)";
    default:
      return "not checked";
  }
}

/** Digest changes via the provenance layer's own parser so the two
 * sections always agree on what changed. The parse is pure/total; the
 * guard keeps an unexpected throw from breaking the review pipeline
 * (advisory evidence must never abort the run). */
function parseDigestChangesSafe(diffText: string): Array<{ file: string; repository: string; tag: string; oldVersion: string; newVersion: string; kind: "digest" }> {
  try {
    return parseDiff(diffText).map((change) => ({
      file: change.file,
      repository: change.repository,
      tag: change.tag,
      oldVersion: change.oldDigest,
      newVersion: change.newDigest,
      kind: "digest" as const,
    }));
  } catch {
    return [];
  }
}
