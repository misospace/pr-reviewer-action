/** Harness-authored verification obligations (#796).
 *
 * Deterministic review questions derived from what the related-code layer
 * already resolves (change anchors + the related-context scan) and injected
 * into the requirement ledger as ordinary entries. The intent: most review
 * misses have the defective code already in the assembled corpus — more
 * evidence alone does not fix attention, so the harness converts surfaced
 * evidence into named obligations the reviewer must answer through the
 * existing strict `requirement_coverage` contract.
 *
 * Advisory by construction: obligations are ledger entries, the verdict
 * remains the reviewer's, and the deterministic extraction (standards /
 * linked issues / PR body) always outranks them — obligations are appended
 * last and are the first entries dropped by the cap. Ordering is
 * most-connected first so the capped tail keeps the questions with the most
 * consumers at stake.
 */
import type { ChangeAnchorsArtifact } from "../context/change-anchors.js";
import type { RelatedContext } from "../context/related-context.js";
import { MAX_REQUIREMENTS, MAX_REQUIREMENT_CHARS } from "./ledger.js";

/** One candidate obligation before ledger injection. `connects` is the
 * consumer/caller count that drives the most-connected-first cap. */
export interface HarnessObligation {
  text: string;
  /** The changed file the question is anchored to (the provenance ref). */
  source: string;
  line: number;
  connects: number;
}

/** Caller sites eligible for listing: bounded, deduplicated, `path:line`. */
function siteList(references: ReadonlyArray<{ path: string; line: number }>, limit: number): { list: string; total: number } {
  const seen = new Set<string>();
  const sites: string[] = [];
  let total = 0;
  for (const ref of references) {
    const site = `${ref.path}:${ref.line}`;
    if (seen.has(site)) continue;
    seen.add(site);
    total += 1;
    if (sites.length < limit) sites.push(`\`${site}\``);
  }
  return { list: sites.join(", "), total };
}

/** UP_SNAKE config-style literal: dispatched on rather than called. */
function isUpperSnakeLiteral(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name);
}

export interface BuildObligationsInput {
  anchors?: ChangeAnchorsArtifact | null | undefined;
  related?: RelatedContext | null | undefined;
  /** Caller/consumer sites listed per obligation before an "and N more". */
  maxSites?: number;
  /** Hard cap on emitted obligations (pre-ledger; the ledger's own
   * MAX_REQUIREMENTS cap still applies after injection). */
  maxObligations?: number;
}

const DEFAULT_MAX_SITES = 5;
const DEFAULT_MAX_OBLIGATIONS = 12;

/** Build the deterministic obligation set: edited functions with callers,
 * changed keys with consumers, counterpart (port) pairs, and upper-snake
 * literals with dispatch sites. Most-connected first; never throws on
 * unusable input (an advisory evidence source must not break the pipeline). */
export function buildHarnessObligations(input: BuildObligationsInput = {}): HarnessObligation[] {
  const maxSites = input.maxSites ?? DEFAULT_MAX_SITES;
  const maxObligations = input.maxObligations ?? DEFAULT_MAX_OBLIGATIONS;
  const anchors = input.anchors ?? null;
  const related = input.related ?? null;
  if (anchors === null && related === null) return [];

  const obligations: HarnessObligation[] = [];
  const seen = new Set<string>();
  const push = (obligation: HarnessObligation): void => {
    const key = obligation.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    obligations.push(obligation);
  };

  // Consumer keys indexed by their (case-normalized) key text, so anchors'
  // symbols/keys can find their call/reference sites.
  const consumersByKey = new Map<string, { key: string; references: Array<{ path: string; line: number }> }>();
  for (const consumer of related?.consumers ?? []) {
    const normalized = consumer.key.toLowerCase();
    const existing = consumersByKey.get(normalized);
    if (existing === undefined) {
      consumersByKey.set(normalized, {
        key: consumer.key,
        references: consumer.references.map((ref) => ({ path: ref.path, line: ref.line })),
      });
    } else {
      existing.references.push(...consumer.references.map((ref) => ({ path: ref.path, line: ref.line })));
    }
  }

  for (const file of anchors?.files ?? []) {
    // 1. Edited functions/methods with callers (#790).
    for (const symbol of file.symbols) {
      if (symbol.kind !== "function" && symbol.kind !== "method") continue;
      const consumers = consumersByKey.get(symbol.name.toLowerCase());
      if (consumers === undefined || consumers.references.length === 0) continue;
      const { list, total } = siteList(consumers.references, maxSites);
      const more = total > maxSites ? ` (+${total - maxSites} more)` : "";
      push({
        text: `\`${symbol.name}\` changed; callers: ${list}${more}. Does each caller still get what it expects?`,
        source: file.path,
        line: symbol.line,
        connects: total,
      });
    }
    // 2. Changed config keys with consumers (#795) — dispatched literals are
    //    class 4 below; everything else asks what the consumer does with it.
    for (const key of file.keys ?? []) {
      const consumers = consumersByKey.get(key.name.toLowerCase());
      if (consumers === undefined || consumers.references.length === 0) continue;
      if (isUpperSnakeLiteral(key.name)) {
        const { list, total } = siteList(consumers.references, maxSites);
        const more = total > maxSites ? ` (+${total - maxSites} more)` : "";
        push({
          text: `\`${key.name}\` changed; each dispatch site must handle the new value: ${list}${more}.`,
          source: file.path,
          line: key.line,
          connects: total,
        });
      } else {
        const { list, total } = siteList(consumers.references, maxSites);
        const more = total > maxSites ? ` (+${total - maxSites} more)` : "";
        push({
          text: `\`${key.name}\` changed; consumed by ${list}${more}. What does the consumer do with it, and does the change widen that?`,
          source: file.path,
          line: key.line,
          connects: total,
        });
      }
    }
    // 3. Port / counterpart pairs (#795): the changed file claims parity
    //    with another implementation of the same shape.
    for (const counterpart of file.counterparts ?? []) {
      push({
        text: `\`${counterpart.name}\` claims parity with \`${counterpart.ref_name}\` (\`${counterpart.ref_path}\`): compare each truncation, encoding and edge case.`,
        source: file.path,
        line: counterpart.line,
        connects: 1,
      });
    }
  }

  // 4. Upper-snake literals with consumers but no anchor key entry (#793
  //    class): the related-context scan found dispatch sites the anchor
  //    extraction did not surface as a key.
  const anchoredKeyNames = new Set<string>();
  for (const file of anchors?.files ?? []) {
    for (const key of file.keys ?? []) anchoredKeyNames.add(key.name.toLowerCase());
    for (const symbol of file.symbols) anchoredKeyNames.add(symbol.name.toLowerCase());
  }
  for (const [normalized, consumer] of consumersByKey) {
    if (!isUpperSnakeLiteral(consumer.key)) continue;
    if (anchoredKeyNames.has(normalized)) continue;
    if (consumer.references.length < 2) continue;
    const { list, total } = siteList(consumer.references, maxSites);
    const more = total > maxSites ? ` (+${total - maxSites} more)` : "";
    push({
      text: `\`${consumer.key}\` changed; each dispatch site must handle the new value: ${list}${more}.`,
      source: consumer.references[0]?.path ?? "",
      line: consumer.references[0]?.line ?? 0,
      connects: total,
    });
  }

  obligations.sort((a, b) => b.connects - a.connects || a.source.localeCompare(b.source) || a.line - b.line);
  return obligations.slice(0, Math.max(0, maxObligations));
}

/** Render one obligation as a ledger-entry text (the exact string the
 * reviewer sees in the ledger section and must answer in
 * `requirement_coverage`). Bounded by MAX_REQUIREMENT_CHARS with the same
 * visible truncation the extraction uses. */
export function obligationText(obligation: HarnessObligation): { text: string; truncated: boolean } {
  if (obligation.text.length <= MAX_REQUIREMENT_CHARS) {
    return { text: obligation.text, truncated: false };
  }
  return { text: obligation.text.slice(0, MAX_REQUIREMENT_CHARS), truncated: true };
}

/** Most-connected-first, the order obligations are injected in. */
export function obligationComparator(): (a: HarnessObligation, b: HarnessObligation) => number {
  return (a, b) => b.connects - a.connects || a.source.localeCompare(b.source) || a.line - b.line;
}

/** The reserved source tag for harness-authored provenance. */
export const HARNESS_SOURCE = "harness";

export { MAX_REQUIREMENTS };
