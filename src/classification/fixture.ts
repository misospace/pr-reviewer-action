import { readFileSync } from "node:fs";
import { pythonJsonStringify } from "../precheck/metadata.js";
import { canonicalChangedFile, normalizeLinkedIssues } from "../context/types.js";
import { classifyPr } from "./classify.js";
import { selectSpecialistRoles } from "./role-selection.js";

/** Fixture-driven classification CLI for the #675 parity harness and
 * tests-v3: `node dist/index.js classification-fixture <fixture.json>` prints
 * a single JSON line `{ok, values}` where `values` carries the canonical
 * classification and the specialist role selection, serialized with the same
 * canonical Python-JSON form the v2 runner emits. The fixture mirrors the v2
 * runner's inputs exactly: the raw changed-file list, the truncated diff,
 * the linked-issue list, the linked-metadata status artifact, and an
 * optional direct `role_selection_input` override (used to drive the role
 * selector's conservative fallbacks in parity). */

export interface ClassificationFixture {
  fixture?: string;
  description?: string;
  pr_files?: unknown[];
  diff?: string;
  linked_issues?: unknown[];
  metadata_status?: unknown;
  /** When present, the role selector runs on this raw value instead of the
   * classification output (malformed artifact / unknown-kind fallbacks). */
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
  const selectionInput = Object.hasOwn(fixture, "role_selection_input") ? fixture.role_selection_input : classification;
  const selection = selectSpecialistRoles(selectionInput);
  return {
    ok: true,
    values: {
      classification: pythonJsonStringify(classification),
      role_selection: pythonJsonStringify(selection),
    },
  };
}

export async function classificationFixtureMain(fixturePath: string): Promise<void> {
  const result = runClassificationFixture(fixturePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
