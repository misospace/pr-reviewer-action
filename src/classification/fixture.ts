import { readFileSync } from "node:fs";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { canonicalChangedFile, normalizeLinkedIssues } from "../context/types.js";
import { classificationToArtifact, classifyPr } from "./classify.js";
import { classificationFromArtifact, selectSpecialistRoles, selectionToArtifact } from "./role-selection.js";

/** Fixture-driven classification CLI for the #675 parity harness and
 * tests-v3: `node dist/index.js classification-fixture <fixture.json>` prints
 * a single JSON line `{ok, values}` where `values` carries the classification
 * and specialist role selection, serialized through the explicit
 * camelCase → snake_case artifact serializers (then canonical Python-JSON)
 * so the bytes match the v2 runner. The fixture mirrors the v2 runner's
 * inputs exactly: the raw changed-file list, the truncated diff, the
 * linked-issue list, the linked-metadata status artifact, and an
 * optional direct `role_selection_input` override — a persisted
 * classification artifact (deserialized via `classificationFromArtifact`)
 * used to drive the role selector's conservative fallbacks in parity. */

export interface ClassificationFixture {
  fixture?: string;
  description?: string;
  pr_files?: unknown[];
  diff?: string;
  linked_issues?: unknown[];
  metadata_status?: unknown;
  /** When present, the role selector runs on this persisted classification
   * artifact instead of the classification output (malformed artifact /
   * unknown-kind fallbacks). */
  role_selection_input?: unknown;
}

export function runClassificationFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ClassificationFixture;
  const prFiles = (Array.isArray(fixture.pr_files) ? fixture.pr_files : []).map((raw) => canonicalChangedFile(raw));
  const linkedIssues = normalizeLinkedIssues(Array.isArray(fixture.linked_issues) ? fixture.linked_issues : []);
  const metadataStatus = Object.hasOwn(fixture, "metadata_status") ? fixture.metadata_status : null;
  const classification = classifyPr({
    prFiles,
    diffText: typeof fixture.diff === "string" ? fixture.diff : "",
    linkedIssues,
    metadataStatus,
  });
  const selection = Object.hasOwn(fixture, "role_selection_input")
    ? selectSpecialistRoles(classificationFromArtifact(fixture.role_selection_input))
    : selectSpecialistRoles(classification);
  return {
    ok: true,
    values: {
      classification: pythonJsonStringify(classificationToArtifact(classification)),
      role_selection: pythonJsonStringify(selectionToArtifact(selection)),
    },
  };
}

export async function classificationFixtureMain(fixturePath: string): Promise<void> {
  const result = runClassificationFixture(fixturePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
