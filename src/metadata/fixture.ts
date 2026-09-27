/**
 * Fixture-mode metadata-marker CLI for the #680 parity harness and tests-v3:
 * `node dist/index.js metadata-markers-fixture <fixture.json>` runs the
 * publication-side marker boundary — marker build, preamble emission,
 * managed-body detection, and reserved-marker stripping — and emits one
 * JSON line `{ok, values, stderr}`.
 */
import { readFileSync } from "node:fs";
import {
  buildRunMetadataMarker,
  emitReviewMarkers,
  isManagedBody,
  stripReservedMarkers,
  type MarkerPreamble,
  type RunMarkerContext,
} from "./markers.js";

interface MarkerFixture {
  contract: string;
  cases: Array<{
    name: string;
    /** Marker-build context (all optional except base/review result). */
    marker?: {
      head_sha?: string;
      base_sha: string;
      review_result: string;
      required_checks?: string;
      review_route?: string;
      escalation_reason?: string;
      cache_hit_ratio?: string;
    };
    /** Preamble emission (requires comment_marker/metadata_marker). */
    preamble?: {
      comment_marker: string;
      metadata_marker?: string;
      head_sha?: string;
      broad_fingerprint?: string;
    };
    /** Managed-body detection cases. */
    managed_bodies?: Array<{ body: string; marker?: string }>;
    /** Reserved-marker stripping over model markdown. */
    strip?: string;
    /** Expected marker value, enforced by both runners (fail closed). */
    expected?: string;
  }>;
}

export function runMetadataMarkersFixture(fixturePath: string): {
  ok: boolean;
  values?: Record<string, string>;
  stderr?: string;
} {
  let fixture: MarkerFixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as MarkerFixture;
  } catch (error) {
    return { ok: false, stderr: `fixture unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (fixture.contract !== "metadata-markers/v1") {
    return { ok: false, stderr: "fixture is not metadata-markers/v1" };
  }
  const values: Record<string, string> = {};
  const failures: string[] = [];
  try {
    for (const testCase of fixture.cases) {
      const parts: string[] = [];
      if (testCase.marker) {
        const marker = buildRunMetadataMarker((() => {
          const context: RunMarkerContext = {
            headSha: testCase.marker.head_sha ?? "unknown",
            baseSha: testCase.marker.base_sha,
            reviewResult: testCase.marker.review_result,
          };
          if (testCase.marker.required_checks !== undefined) context.requiredChecks = testCase.marker.required_checks;
          if (testCase.marker.review_route !== undefined) context.reviewRoute = testCase.marker.review_route;
          if (testCase.marker.escalation_reason !== undefined) context.escalationReason = testCase.marker.escalation_reason;
          if (testCase.marker.cache_hit_ratio !== undefined) context.cacheHitRatio = testCase.marker.cache_hit_ratio;
          return context;
        })());
        parts.push(`marker=${marker}`);
        if (testCase.expected !== undefined && marker !== testCase.expected) {
          failures.push(`${testCase.name}: marker mismatch`);
        }
      }
      if (testCase.preamble) {
        const preamble: MarkerPreamble = { commentMarker: testCase.preamble.comment_marker, metadataMarker: testCase.preamble.metadata_marker ?? "" };
        if (testCase.preamble.head_sha !== undefined) preamble.headSha = testCase.preamble.head_sha;
        if (testCase.preamble.broad_fingerprint !== undefined) preamble.broadFingerprint = testCase.preamble.broad_fingerprint;
        parts.push(`preamble=${JSON.stringify(emitReviewMarkers(preamble))}`);
      }
      if (testCase.managed_bodies) {
        const decisions = testCase.managed_bodies.map((entry) =>
          isManagedBody(entry.body, entry.marker ?? "<!-- ai-pr-reviewer -->") ? "managed" : "foreign");
        parts.push(`managed=${decisions.join(",")}`);
      }
      if (testCase.strip !== undefined) {
        parts.push(`stripped=${JSON.stringify(stripReservedMarkers(testCase.strip))}`);
      }
      values[testCase.name] = parts.join("|");
    }
  } catch (error) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
  if (failures.length > 0) {
    return { ok: false, stderr: failures.join("; ") };
  }
  return { ok: true, values };
}
