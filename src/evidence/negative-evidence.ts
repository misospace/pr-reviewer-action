/**
 * Deterministic negative-evidence derivation (#1517).
 *
 * A trusted, configured evidence provider that ran CLEAN against the exact
 * reviewed head is bounded negative evidence: it may contradict narrow
 * classes of model findings that its operator-declared rule explicitly
 * covers (a formatter-clean run against pure formatting claims, a linter
 * clean against claims of violating that linter, a schema validator clean
 * against schema-invalid claims). Derivation happens here, at the evidence
 * phase, where the operator's provider specs and the run's actual results
 * are both in scope; the persisted rules are consumed and APPLIED after
 * finding normalization by `src/enforcement/negative-evidence.ts`.
 *
 * Trust source: rules derive ONLY from the `negative_evidence` key of the
 * operator-managed provider spec (src/evidence/providers.ts) combined with
 * the entry's own execution facts. Nothing a provider PRINTS can create,
 * widen or re-enable a rule — external/untrusted status text cannot
 * self-declare negative-evidence authority.
 *
 * The clean-run gate is deliberately narrow. A rule is derived only when the
 * entry says the provider: completed (`status === "ok"`), exited 0, reported
 * ZERO findings, and had NO stdout truncation (a cut stream could hide
 * findings the parse never saw — a partially visible report is not a clean
 * one). Missing, skipped, timed-out, errored, invalid, finding-bearing and
 * truncated runs derive no rule. SARIF entries derive no rule (they are
 * pre-existing findings files with no per-file operator declaration; a stale
 * SARIF is exactly the stale-evidence shape this capability refuses).
 *
 * Freshness/provenance: every derived rule records the exact head the
 * evidence phase ran against, taken from the run's `PR_HEAD_SHA` stage env
 * (set by the engine from the resolved review head). A rule whose head is
 * unknown or shape-invalid is still persisted — for calibration visibility —
 * but the application boundary (`negativeEvidenceRulesFromArtifact`) refuses
 * every rule whose recorded head does not equal the head under review, so
 * stale-head clean evidence is ignored, never applied.
 *
 * No additional model call: everything here is deterministic over the
 * provider entries and the operator config.
 */

import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { EvidenceProviderEntry } from "./providers.js";
import { parseNegativeEvidenceSpec } from "./providers.js";
import { isPyDict, pyJsonDumps } from "./pyjson.js";

/** Persisted sidecar schema id. A reader refuses any other value. */
export const NEGATIVE_EVIDENCE_SCHEMA = "negative-evidence/v1";

/** Written next to `evidence-providers.json` whenever the evidence phase
 * runs (including its fork-skip and failure fallbacks, which write zero
 * rules), so a shared run directory can never serve a previous run's rules
 * as this run's evidence. */
export const EVIDENCE_NEGATIVE_EVIDENCE_FILE = "evidence-negative-evidence.json";

export interface NegativeEvidenceRule {
  /** The provider entry id the rule was derived from (tool identity). */
  provider: string;
  domain: "formatter" | "lint" | "schema";
  /** Repo-relative covered path patterns (operator-declared). */
  paths: string[];
  /** Finding categories the rule may contradict (operator-declared). */
  categories: string[];
  /** The most severe severity the rule may contradict. */
  max_severity: "major" | "minor" | "info";
  /** The tool identity a lint/schema claim must name (defaults to the
   * provider id at parse time). */
  identity: string;
  /** Exact rule ids a claim may cite (lint rule family / schema rule). */
  rules: string[];
  /** The lowercase exact head the clean run is provenance for; null when
   * the run's head was unknown — such a rule is never applied. */
  head_sha: string | null;
}

/** A head SHA whose shape the application boundary can pin provenance with
 * (the same 40/64-hex shapes the engine's own revision guard accepts). */
const HEAD_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** Normalize the run head for provenance stamping: lowercase hex, or null
 * when the value is absent or not sha-shaped (an unstamped derivation —
 * e.g. a test harness without PR_HEAD_SHA — must not mint provenance). */
export function negativeEvidenceHeadSha(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim().toLowerCase();
  return HEAD_SHA_RE.test(text) ? text : null;
}

/** True when the entry is a CLEAN provider run in the negative-evidence
 * sense (see the module docblock). Exported for tests. */
export function isCleanNegativeEvidenceRun(entry: EvidenceProviderEntry): boolean {
  return entry.status === "ok"
    && entry.exit_code === 0
    && entry.findings.length === 0
    && entry.stdout_truncated === false;
}

/**
 * Derive the run's negative-evidence rules: zip the (config-order) provider
 * specs with their (config-order) execution entries — the same alignment the
 * orchestrator's pool preserves — and emit a rule for every spec that
 * declares one AND whose entry passed the clean-run gate. Entries that are
 * not plain provider executions (SARIF) never pair with a spec here.
 */
export function deriveNegativeEvidenceRules(
  specs: readonly unknown[],
  entries: readonly EvidenceProviderEntry[],
  headSha: string | null,
  /** #1529 review (trust boundary): whether the provider definitions came
   * from a TRUSTED operator/base source. The standard providers config
   * resolves inside the reviewed-head checkout — PR-writable content — and
   * a PR must never be able to mint its own clean-run authority: an
   * untrusted source derives ZERO negative-evidence rules (ordinary
   * positive evidence keeps its existing behavior). The caller decides
   * from where the config actually resolved; nothing a provider printed
   * or executed can flip this. */
  trustedSource: boolean,
): NegativeEvidenceRule[] {
  if (!trustedSource) return [];
  const rules: NegativeEvidenceRule[] = [];
  const count = Math.min(specs.length, entries.length);
  for (let i = 0; i < count; i += 1) {
    const providerSpec = specs[i];
    const declaration = isPyDict(providerSpec) ? providerSpec.negative_evidence : undefined;
    const spec = declaration === undefined ? null : parseNegativeEvidenceSpec(declaration);
    if (spec === null) continue;
    const entry = entries[i]!;
    if (!isCleanNegativeEvidenceRun(entry)) continue;
    rules.push({
      provider: entry.id,
      domain: spec.domain,
      paths: spec.paths,
      categories: spec.categories,
      max_severity: spec.max_severity,
      identity: spec.identity ?? entry.id,
      rules: spec.rules,
      head_sha: headSha,
    });
    if (rules.length >= 128) break;
  }
  return rules;
}

export function serializeNegativeEvidenceArtifact(
  headSha: string | null,
  rules: readonly NegativeEvidenceRule[],
): string {
  return `${pyJsonDumps({ schema_version: NEGATIVE_EVIDENCE_SCHEMA, head_sha: headSha, rules })}\n`;
}

/** Write the sidecar next to the other evidence artifacts. Always called by
 * the evidence phase (any outcome), so the artifact is this run's own. */
export function writeNegativeEvidenceArtifact(
  cwd: string,
  headSha: string | null,
  rules: readonly NegativeEvidenceRule[],
): void {
  writeFileSync(resolvePath(cwd, EVIDENCE_NEGATIVE_EVIDENCE_FILE), serializeNegativeEvidenceArtifact(headSha, rules), "utf8");
}
