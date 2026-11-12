import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { linesInsideCodeFences } from "./helpers.js";

function loadV2Map(): Map<string, string> {
  const contract = parse(readFileSync("contracts/action-v3.yml", "utf8")) as {
    inputs: { id: string; v2_id?: string }[];
    outputs?: { id: string; v2_id?: string }[];
  };
  const map = new Map<string, string>();
  for (const entry of [...contract.inputs, ...(contract.outputs ?? [])]) {
    if (entry.v2_id && entry.v2_id.includes("_") && entry.v2_id !== entry.id) {
      map.set(entry.v2_id, entry.id);
    }
  }
  return map;
}

// Names that are v2 contract ids but are also legitimately snake_case
// elsewhere in the docs, so a bare word-boundary match cannot tell them
// apart from the contract reference. Keep this list short and justified.
const allowlist = new Map<string, string>([
  // The model's raw structured-output JSON schema key (src/model/conversation.ts,
  // src/model/request.ts) and the persisted ai-output.json artifact field
  // (src/enforcement/artifact.ts) are both literally `review_markdown` —
  // distinct from the action's own `review-markdown` output.
  ["review_markdown", "the model's raw JSON schema / ai-output.json artifact field, not the action output"],
  // Persisted ai-output.json artifact field (src/enforcement/artifact.ts,
  // src/run/review.ts), distinct from the action's own `verdict-source` output.
  ["verdict_source", "the ai-output.json artifact field, not the action output"],
  // The OpenAI/Anthropic provider API's own tool-calling field name, distinct
  // from the action's `tool-calls` output.
  ["tool_calls", "the provider API's own field name, not the action output"],
  // Literal filename the eval harness writes to disk (scripts/eval_harness.py,
  // scripts/sections/review.sh, scripts/artifact_paths.sh), not the action's
  // `analysis-engine` output.
  ["analysis_engine", "the eval harness's analysis_engine.txt filename, not the action output"],
  // The metadata marker's own raw JSON key (src/metadata/markers.ts,
  // src/precheck/decide.ts's carriedVerdict, src/enforcement/verdict-policy.ts's
  // StrictReviewResult) — literally `review_result` inside the marker's JSON
  // blob, distinct from the action's #873 `review-result` output (which
  // carries the same value under the kebab contract name).
  ["review_result", "the metadata marker's raw JSON field, not the action output"],
  ["incomplete_reason", "the metadata marker's raw JSON field, not the action output"],
  ["requirement_trace", "the incomplete-reason enum value, which collides with the requirement-trace input's v2 id"],
  // More raw marker JSON keys (src/metadata/markers.ts) that share a v2 id;
  // docs/telemetry.md documents the marker by its literal keys.
  ["required_checks", "the metadata marker's raw JSON field, not the action output"],
  ["review_route", "the metadata marker's raw JSON field, not the action output"],
  ["escalation_reason", "the metadata marker's raw JSON field, not the action output"],
  ["cache_hit_ratio", "the metadata marker's raw JSON field, not the action output"],
  // The metadata marker's own raw JSON keys for the independent verifier
  // (src/metadata/markers.ts, src/confidence/telemetry.ts) — literally
  // `confidence_status` and `confidence_score` inside the marker's JSON blob,
  // distinct from the action's own `confidence-status` / `confidence-score`
  // outputs, which carry the same values under the kebab contract names.
  ["confidence_status", "the metadata marker's raw JSON field, not the action output"],
  ["confidence_score", "the metadata marker's raw JSON field, not the action output"],
  // The review-bundle/v1 document's own literal JSON keys (#1425,
  // src/publish/bundle.ts, documented in docs/review-bundle.md). Persisted
  // snake_case per the naming rule, distinct from the same-named action
  // input/output contract ids.
  ["pr_number", "the review-bundle/v1 JSON key, not the pr-number input"],
  ["diff_fingerprint", "the review-bundle/v1 JSON key, not the diff-fingerprint output"],
  ["skip_reason", "the review-bundle/v1 JSON key, not the skip-reason output"],
  // Persisted ai-output.json artifact field names (src/enforcement/artifact.ts),
  // documented literally by the self-hosted qualification runbook's parity
  // normalization list (#1484), distinct from the `review-triage-decision` /
  // `review-triage-reason` action output ids.
  ["review_triage_decision", "the ai-output.json artifact field, not the action output"],
  ["review_triage_reason", "the ai-output.json artifact field, not the action output"],
]);

const excludedDocs = new Set(["docs/v3-migration.md", "docs/v3-teardown-audit.md"]);

function docFiles(): string[] {
  const files = ["README.md"];
  for (const name of readdirSync("docs")) {
    if (!name.endsWith(".md")) continue;
    const path = join("docs", name);
    if (excludedDocs.has(path)) continue;
    files.push(path);
  }
  return files;
}

test("README.md and docs/*.md use kebab-case contract ids, not v2 snake_case", () => {
  const v2ToKebab = loadV2Map();
  const violations: string[] = [];

  for (const file of docFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      for (const [v2, id] of v2ToKebab) {
        if (allowlist.has(v2)) continue;
        const re = new RegExp(`\\b${v2}\\b`, "g");
        if (re.test(line)) {
          violations.push(`${file}:${idx + 1}: \`${v2}\` should be \`${id}\``);
        }
      }
    });
  }

  assert.deepEqual(violations, [], `found v2 snake_case input/output ids in docs:\n${violations.join("\n")}`);
});

// #1568: merge/rebase accumulation left three duplicated module bullets in
// docs/architecture/code-map.md (`src/enforcement/`, `src/publish/`,
// `src/requirements/trace-repair.ts`), and the copies contradicted each other
// on current semantics. The guard below fails the suite when a bullet lead-in
// occurs more than once, and pins the #1505 enforcement wording so a stale
// copy cannot silently win.
const BULLET_LEAD_IN = /^\s*-\s+\*\*(.+?)\*\*/;

// The lead-in is compared normalized, so a copy that renders the same module
// differently (indented, or without the backticks) still counts as the same
// bullet instead of slipping past the guard.
function normalizeLeadIn(lead: string): string {
  return lead.replace(/[`*]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function bulletLeadInOccurrences(doc: string): Map<string, number[]> {
  const occurrences = new Map<string, number[]>();
  const fenced = linesInsideCodeFences(doc);
  doc.split("\n").forEach((line, idx) => {
    if (fenced.has(idx)) return;
    const lead = BULLET_LEAD_IN.exec(line)?.[1];
    if (lead === undefined) return;
    const key = normalizeLeadIn(lead);
    const seen = occurrences.get(key);
    if (seen) seen.push(idx + 1);
    else occurrences.set(key, [idx + 1]);
  });
  return occurrences;
}

// The bullet is a single ~20 KB line, so a head-only excerpt would hide the
// offending clause. Quote a window around the anchor the assertion is about.
function windowAround(text: string, anchor: string, radius = 200): string {
  const at = text.indexOf(anchor);
  if (at < 0) return text.slice(0, 300) + (text.length > 300 ? "..." : "");
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + anchor.length + radius);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

test("docs/architecture/code-map.md has no duplicated module bullets and states the #1505 enforcement semantics", () => {
  const file = join("docs", "architecture", "code-map.md");
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const occurrences = bulletLeadInOccurrences(text);

  const dupes: string[] = [];
  for (const [lead, nums] of occurrences) {
    if (nums.length > 1) dupes.push(`${lead} (lines ${nums.join(", ")})`);
  }
  assert.deepEqual(dupes, [], `duplicated module bullet lead-in(s) in ${file}:\n${dupes.join("\n")}`);

  // The guard must bite: a duplicated lead-in — even one that renders the
  // module differently — has to be reported, or a stale copy could return.
  const synthetic = ["- **`src/enforcement/`** — first copy", "  - **`src/enforcement/`** — indented copy"].join("\n");
  assert.equal(
    bulletLeadInOccurrences(synthetic).get("src/enforcement/")?.length,
    2,
    "the duplicate detector must report a repeated module bullet lead-in",
  );

  const enforcementLines = occurrences.get("src/enforcement/") ?? [];
  assert.equal(
    enforcementLines.length,
    1,
    `expected exactly one \`src/enforcement/\` bullet in ${file}, found ${enforcementLines.length} (line(s): ${enforcementLines.join(", ") || "none"})`,
  );
  const enforcementLine = enforcementLines[0] ?? 0;
  const enforcement = enforcementLine > 0 ? (lines[enforcementLine - 1] ?? "") : "";

  assert.ok(
    enforcement.includes("only for an `unmet` (confirmed-negative) FORCING row"),
    `the \`src/enforcement/\` bullet must scope enforcement to an \`unmet\` (confirmed-negative) FORCING row; got: ${windowAround(enforcement, "FORCING row")}`,
  );
  assert.ok(
    !enforcement.includes("ANY unresolved FORCING row"),
    `the \`src/enforcement/\` bullet must not claim enforcement for ANY unresolved FORCING row; got: ${windowAround(enforcement, "ANY unresolved FORCING row")}`,
  );
  assert.ok(
    enforcement.includes("withholds the trusted native approve at the publish boundary"),
    `the \`src/enforcement/\` bullet must state that an unresolved row withholds the trusted native approve at the publish boundary; got: ${windowAround(enforcement, "publish boundary")}`,
  );
});
