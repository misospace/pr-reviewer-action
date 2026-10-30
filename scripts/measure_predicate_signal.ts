/**
 * #1347: retained corpus measurement for the requirement-trace predicate
 * shape tightening, so the false-downgrade claim in
 * `docs/architecture/owner-anchored-enforcement-citation.md` is a
 * reproducible artifact instead of an unretained one-off run.
 *
 * Runs BOTH shapes over every git-tracked TypeScript file in the repository:
 *
 *   - the pre-#1347 baseline (embedded verbatim from base revision
 *     8b91cf01bbadcf8c1f280c98227418089cd000fc, where `linePredicateSignal`
 *     matched raw text and `throw|reject|assert*|expect|invariant|must*`
 *     fired inside identifiers, comments and string literals), and
 *   - the shipped production shape, imported from
 *     `src/enforcement/requirement-trace.ts` (bundled from the working tree,
 *     never re-implemented here, so it cannot drift from the runtime) and
 *     read per FILE, so an open block comment or template literal carries
 *     across lines exactly as it does in the runtime.
 *
* Reports accepted-shape counts for each, how many lines the tightening
 * removed, and samples of BOTH change directions for human inspection:
 * removed lines (the false-downgrade direction) and lines the tightened
 * shape accepts that the baseline rejected — a faithful baseline does add
 * lines, because the old bare-word alternation (`\breject\b`) missed
 * prefixed assertion names while the tightened call-shape rule
 * (`rejectUnknown(…)`) correctly accepts them, so the additions are real
 * predicate shapes, not loosened copies.
 *
 * The report also carries the cross-line refinement on its own: the
 * LINE-LOCAL view of the same shipped scan (the shape as it read before the
 * open-span state was carried across lines) against the shipped
 * cross-line one, so this refinement's false-downgrade rate is measured
 * separately from the pre-#1347 baseline. `removed` is the NET difference
 * between the baseline and the shipped shape; `removed_total` is the count
 * of lines the baseline accepted and the shipped shape refuses, and the two
 * differ by `newly_accepted_total`.
 *
 * Optional positional args narrow the corpus to git path prefixes
 * (e.g. `node scripts/measure_predicate_signal.mjs src`); default is every
 * git-tracked TypeScript file.
 *
 * Launcher: `scripts/measure_predicate_signal.mjs` (esbuild bundle). Read
 * only: no network, no writes outside the process, exit 0 unless the scan
 * itself fails. Tooling, not part of the action.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { filePredicateSignal, linePredicateSignal } from "../src/enforcement/requirement-trace.js";

const BASE_COMPARISON_RE = /(===|!==|==|!=|<=|>=|<|>)/;
const BASE_GUARD_RE = /\b(if|unless)\b/i;
const BASE_LOGICAL_OR_TERNARY_RE = /(\?|&&|\|\|)/;
const BASE_ASSERTION_RE = /\b(throw|reject|assert\w*|expect|invariant|must\w*)\b/i;
const BASE_MATCH_CALL_RE = /\.(includes|startsWith|endsWith|equals|match|test)\s*\(/i;

function baselineLinePredicateSignal(line: string): boolean {
  return BASE_COMPARISON_RE.test(line)
    || BASE_GUARD_RE.test(line)
    || BASE_LOGICAL_OR_TERNARY_RE.test(line)
    || BASE_ASSERTION_RE.test(line)
    || BASE_MATCH_CALL_RE.test(line);
}

const launcherPath = process.argv[1];
if (launcherPath === undefined) {
  console.error("usage: node scripts/measure_predicate_signal.mjs");
  process.exit(1);
}
const repoRoot = path.resolve(path.dirname(launcherPath), "..");
const scopes = process.argv.slice(2);
const pathspecs = scopes.length > 0
  ? scopes.map((scope) => `:(glob)${scope}/**/*.ts`)
  : ["*.ts"];

const tracked = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
  cwd: repoRoot,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString("utf8")
  .split("\0")
  .filter((entry) => entry !== "");

let lines = 0;
let baselineAccepted = 0;
let currentAccepted = 0;
let removedTotal = 0;
let lineLocalAccepted = 0;
let crossLineRemoved = 0;
let crossLineAdded = 0;
const newlyAccepted: string[] = [];
const removedSamples: string[] = [];
const crossLineRemovedSamples: string[] = [];
const crossLineAddedSamples: string[] = [];
let newlyAcceptedTotal = 0;

for (const relative of tracked) {
  const text = readFileSync(path.join(repoRoot, relative), "utf8");
  const fileLines = text.split("\n");
  lines += fileLines.length;
  // The production shape is read per FILE, because an open block comment or
  // template literal carries across lines: a shape inside a multi-line span
  // is prose on every line of that span. The baseline stays line-local — it
  // IS the pre-#1347 line-local shape.
  const currentSignals = filePredicateSignal(fileLines);
  // The LINE-LOCAL view of the same shipped scan: the shape as it read
  // before the open-span state was carried across lines. Comparing the two
  // measures this refinement's false-downgrade rate on its own, separately
  // from the pre-#1347 baseline.
  const lineLocalSignals = fileLines.map((line) => linePredicateSignal(line));
  for (const [index, line] of fileLines.entries()) {
    const base = baselineLinePredicateSignal(line);
    const current = currentSignals[index] === true;
    const lineLocal = lineLocalSignals[index] === true;
    if (base && !current) {
      removedTotal += 1;
      if (removedSamples.length < 25) {
        removedSamples.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
    if (base) baselineAccepted += 1;
    if (current) currentAccepted += 1;
    if (current && !base) {
      newlyAcceptedTotal += 1;
      if (newlyAccepted.length < 25) {
        newlyAccepted.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
    if (lineLocal) lineLocalAccepted += 1;
    if (lineLocal && !current) {
      crossLineRemoved += 1;
      if (crossLineRemovedSamples.length < 25) {
        crossLineRemovedSamples.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
    if (current && !lineLocal) {
      crossLineAdded += 1;
      if (crossLineAddedSamples.length < 25) {
        crossLineAddedSamples.push(`${relative}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
}

const removed = baselineAccepted - currentAccepted;
const report = {
  corpus_files: tracked.length,
  corpus_lines: lines,
  baseline_accepted: baselineAccepted,
  current_accepted: currentAccepted,
  /** NET difference: the shapes the tightening took away, minus the ones it
   * added. `removed_total` is the count of lines the baseline accepted and
   * the shipped shape refuses. */
  removed,
  removed_total: removedTotal,
  removed_samples: removedSamples,
  newly_accepted_total: newlyAcceptedTotal,
  newly_accepted_samples: newlyAccepted,
  /** The LINE-LOCAL view of the same shipped scan — the shape as it read
   * before the open-span state was carried across lines — and what the
   * cross-line tracking took away from it and added to it. */
  line_local_accepted: lineLocalAccepted,
  cross_line_removed: crossLineRemoved,
  cross_line_added: crossLineAdded,
  cross_line_removed_samples: crossLineRemovedSamples,
  cross_line_added_samples: crossLineAddedSamples,
};
console.log(JSON.stringify(report, null, 2));
