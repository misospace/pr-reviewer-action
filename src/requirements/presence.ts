/** Requirement-ledger presence signal (#706 PR 3): port of the post-build
 * half of `build_requirement_ledger` in scripts/sections/context.sh.
 *
 * The signal is written only when the rendered ledger is non-empty AND fits
 * a MAX_CORPUS reservation: ledger bytes plus the section framing (the
 * header, its newline, and corpus.sh's trailing blank line) must stay
 * strictly below MAX_CORPUS — the exact complement of the corpus's own
 * section-emission predicate, so the prompt fragment never promises a
 * section the corpus drops. The signal body is the ledger's `sha`
 * (`jq -r '.sha // empty'`, trailing newlines stripped by `$(...)`), or `1`
 * when there is none. An empty ledger also empties `requirement-ledger.json`.
 * The build itself is `extractRequirementLedger` + the renderer. */

import { jqAlt, jqField, jqRaw } from "../platform/jq.js";

export const REQUIREMENT_LEDGER_HEADER = "# Explicit Requirement Ledger";
/** Header text + its newline + the trailing blank line corpus.sh appends. */
export const REQUIREMENT_LEDGER_FRAMING_BYTES = REQUIREMENT_LEDGER_HEADER.length + 2;

/** The MAX_CORPUS fit predicate shared by the signal and the corpus. */
export function requirementLedgerFits(ledgerMarkdownBytes: number, maxCorpus: number): boolean {
  return ledgerMarkdownBytes + REQUIREMENT_LEDGER_FRAMING_BYTES < maxCorpus;
}

function ledgerSha(ledgerJson: Uint8Array | null): string {
  if (ledgerJson === null || ledgerJson.length === 0) return "";
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(ledgerJson).toString("utf8")) as unknown;
  } catch {
    return "";
  }
  try {
    const sha = jqAlt(jqField(value, "sha"), null);
    return sha === null ? "" : jqRaw(sha).replace(/\n+$/, "");
  } catch {
    return "";
  }
}

export interface LedgerPresenceResult {
  /** `requirement-ledger.json`, `requirement-ledger.md`,
   * `requirement-ledger-present.txt` and the reset
   * `requirement-ledger.section.md`. */
  artifacts: Map<string, Uint8Array>;
  present: boolean;
}

/** Presence signal from the freshly built ledger artifacts (`null` = the
 * build wrote nothing). */
export function requirementLedgerPresence(
  ledgerMarkdown: Uint8Array | null,
  ledgerJson: Uint8Array | null,
  maxCorpus: number,
): LedgerPresenceResult {
  const markdown = ledgerMarkdown ?? new Uint8Array(0);
  const artifacts = new Map<string, Uint8Array>([
    ["requirement-ledger.md", markdown],
    ["requirement-ledger.section.md", new Uint8Array(0)],
  ]);
  let present = false;
  if (markdown.length > 0) {
    artifacts.set("requirement-ledger.json", ledgerJson ?? new Uint8Array(0));
    if (requirementLedgerFits(markdown.length, maxCorpus)) {
      present = true;
      artifacts.set("requirement-ledger-present.txt", Buffer.from(`${ledgerSha(ledgerJson) || "1"}\n`, "utf8"));
    } else {
      artifacts.set("requirement-ledger-present.txt", new Uint8Array(0));
    }
  } else {
    artifacts.set("requirement-ledger.json", new Uint8Array(0));
    artifacts.set("requirement-ledger-present.txt", new Uint8Array(0));
  }
  return { artifacts, present };
}
