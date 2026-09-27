/** Small file-backed parity adapter for review-sanitize/v1 fixtures. */
import { readFileSync } from "node:fs";
import {
  sanitizeMarkdown,
  stripEmptyConditionalSections,
  stripReservedMarkers,
  type ConditionalSectionPresence,
  type UpstreamLinkMode,
} from "./sanitize.js";

interface SanitizeCase {
  name: string;
  markdown: string;
  link_mode: UpstreamLinkMode;
  presence: {
    linked_issue: boolean;
    evidence_provider: boolean;
    standards: boolean;
    tool_harness_findings: boolean;
    tool_harness_results: boolean;
  };
}

interface SanitizeFixture {
  contract: "review-sanitize/v1";
  cases: SanitizeCase[];
}

/** Run the production v3 sanitizer pipeline for one JSON fixture. */
export function runSanitizeFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  try {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as SanitizeFixture;
    if (fixture.contract !== "review-sanitize/v1" || !Array.isArray(fixture.cases)) {
      throw new Error("fixture is not review-sanitize/v1");
    }
    const values: Record<string, string> = {};
    for (const item of fixture.cases) {
      const presence: ConditionalSectionPresence = {
        linkedIssue: item.presence.linked_issue,
        evidenceProvider: item.presence.evidence_provider,
        standards: item.presence.standards,
        toolHarnessFindings: item.presence.tool_harness_findings,
        toolHarnessResults: item.presence.tool_harness_results,
      };
      const cleanMarkers = stripReservedMarkers(item.markdown);
      const sanitized = sanitizeMarkdown(cleanMarkers, item.link_mode);
      values[item.name] = stripEmptyConditionalSections(sanitized, presence);
    }
    return { ok: true, values };
  } catch (error: unknown) {
    return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
  }
}
