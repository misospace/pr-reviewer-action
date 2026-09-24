import { readFileSync } from "node:fs";
import { pythonJsonStringify } from "../precheck/metadata.js";
import {
  MAX_LEDGER_MARKDOWN_BYTES,
  extractRequirementLedger,
  ledgerToArtifact,
  renderRequirementLedgerMarkdown,
  type RequirementLedger,
} from "./ledger.js";

/** Fixture-driven requirement-ledger CLI for the #675 parity harness and
 * tests-v3: `node dist/index.js requirement-ledger-fixture <fixture.json>`
 * prints a single JSON line `{ok, values}` carrying the ledger artifact
 * (canonical Python-JSON form, matching the v2 runner) and the rendered
 * markdown byte-for-byte. The fixture mirrors the v2 CLI's inputs. */

export interface RequirementLedgerFixture {
  fixture?: string;
  description?: string;
  pr_json?: string | null;
  linked_issues_markdown?: string | null;
  standards_text?: string | null;
  standards_ref?: string | null;
  markdown_max_bytes?: number | null;
}

export function runRequirementLedgerFixture(fixturePath: string): { ok: boolean; values?: Record<string, string>; stderr?: string } {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RequirementLedgerFixture;
  const ledger: RequirementLedger = extractRequirementLedger({
    prJson: Object.hasOwn(fixture, "pr_json") ? fixture.pr_json : null,
    linkedIssuesMarkdown: Object.hasOwn(fixture, "linked_issues_markdown") ? fixture.linked_issues_markdown : null,
    standardsText: Object.hasOwn(fixture, "standards_text") ? fixture.standards_text : null,
    standardsRef: Object.hasOwn(fixture, "standards_ref") ? fixture.standards_ref : null,
  });
  const hasCap = Object.hasOwn(fixture, "markdown_max_bytes");
  const maxBytes = hasCap ? fixture.markdown_max_bytes : MAX_LEDGER_MARKDOWN_BYTES;
  // An empty extraction renders as an empty string so `[ -s ]` gates work.
  const rendered = ledger.requirements.length === 0 ? "" : renderRequirementLedgerMarkdown(ledger, maxBytes);
  return {
    ok: true,
    values: {
      // The explicit camelCase → snake_case artifact serialization (then
      // canonical Python-JSON, sort_keys), byte-compatible with the v2
      // runner's `json.dumps`.
      ledger: pythonJsonStringify(ledgerToArtifact(ledger)),
      markdown: rendered,
    },
  };
}

export async function requirementLedgerFixtureMain(fixturePath: string): Promise<void> {
  const result = runRequirementLedgerFixture(fixturePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
