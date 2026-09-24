import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/** Precheck fingerprinting (#674) — the faithful TS port of
 * `pr_reviewer/precheck.py`. The marker form `<diff_fp>|cfg:<config_hash>`
 * is stored in the `ai-pr-review-fingerprint` comment marker and compared
 * against on the next run, so byte-level fidelity here is what makes the
 * unchanged-review skip work across v2 and v3. */

export const FP_PREFIX = "diff-fp:";
export const FP_DELIMITER = "|";
export const EMPTY_DIFF_FINGERPRINT = "empty-diff";
export const CONFIG_HASH_MARKER = "cfg:";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** SHA256 of the diff content; "" for empty/whitespace-only input. */
export function computeDiffFingerprint(diffContent: string): string {
  if (!diffContent || !diffContent.trim()) return "";
  return sha256Hex(diffContent);
}

/**
 * Exact allowlist of non-`AI_` config keys that participate in the config
 * hash (port of `_EXACT_CONFIG_KEYS`). A key added to the v2 list must be
 * added here in the same release or a config change stops invalidating
 * stale reviews.
 */
export const EXACT_CONFIG_KEYS: readonly string[] = [
  "ANTHROPIC_VERSION",
  "AZURE_DEPLOYMENT_ID",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_ENDPOINT",
  "OPENAI_BASE_URL",
  "ACTION_REF",
  "CONTEXT_LIMIT_MODE",
  "MODEL_CONTEXT_TOKENS",
  "PRIMARY_MODEL_CONTEXT_TOKENS",
  "SMART_MODEL_CONTEXT_TOKENS",
  "PRIMARY_REQUEST_SHAPE",
  "SMART_REQUEST_SHAPE",
  "REVIEW_ROUTING_MODE",
  "ESCALATE_ON_RISK_FLAGS",
  "SYSTEM_PROMPT",
  "STANDARDS_FILE_CANDIDATES",
  "LINEAR_API_KEY_CONFIGURED",
  "LINEAR_ISSUE_PREFIXES",
  "LINEAR_ISSUE_TIMEOUT_SEC",
  "LINEAR_ENABLE_FOR_FORKS",
  "EVIDENCE_PROVIDER_TIMEOUT_SEC",
  "EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES",
  "SARIF_FILES",
  "SARIF_MAX_FINDINGS",
  "EVIDENCE_BLOCKER_ENFORCEMENT",
  "EVIDENCE_ENABLE_FOR_FORKS",
  "TOOL_MODE",
  "TOOL_MAX_REQUESTS",
  "TOOL_MAX_ROUNDS",
  "TOOL_TURN_TIMEOUT_SEC",
  "TOOL_CORPUS_MAX_BYTES",
  "TOOL_MAX_TOKENS_PER_TURN",
  "TOOL_PLANNING_TIMEOUT_SEC",
  "TOOL_PLANNING_MAX_CONTEXT_BYTES",
  "TOOL_PLANNING_MAX_TOKENS",
  "TOOL_MAX_RESPONSE_BYTES",
  "TOOL_ALLOWED_GH_API_REPOS",
  "TOOL_REQUEST_TIMEOUT_SEC",
  "TOOL_FAILURE_ENFORCEMENT",
  "TOOL_MIN_SUCCESSFUL_REQUESTS",
  "TOOL_ENABLE_FOR_FORKS",
  "RELATED_CODE_CONTEXT",
  "RELATED_CODE_MAX_BYTES",
  "REPO_MAP_CONTEXT",
  "REPO_MAP_MAX_BYTES",
  "PR_THREAD_CONTEXT",
  "PR_THREAD_MAX_BYTES",
  "DEEP_REVIEW",
  "DEEP_REVIEW_TIMEOUT_SEC",
  "DEEP_REVIEW_MAX_TOKENS",
  "DEEP_REVIEW_CORPUS_MAX_BYTES",
  "PRECHECK_SELECTION_SIGNATURE",
];

const EXACT_CONFIG_KEY_SET = new Set<string>(EXACT_CONFIG_KEYS);

/** Config files whose *content* feeds the hash (paths sorted, broken or
 * unreadable files skipped) — same list as `_collect_config_lines`. */
const CONFIG_FILE_VARS: readonly string[] = [
  "AI_CONFIG_FILE",
  "AI_ADDITIONAL_INSTRUCTIONS_FILE",
  "AI_EXCLUDES_FILE",
  "AI_INCLUDES_FILE",
  "AI_PROMPT_FILE",
  "AI_RULES_FILE",
  "SYSTEM_PROMPT_FILE",
  "STANDARDS_FILE",
  "EVIDENCE_PROVIDERS_FILE",
];

function readFileText(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Collect configuration key=value lines from the environment map and
 * config files (port of `_collect_config_lines`). `AI_*` is swept as this
 * action's own namespace except `*_API_KEY` secrets; every other key is
 * matched by exact name so runner-preset provider vars cannot skew the
 * hash across runner images. */
export function collectConfigLines(env: Record<string, string>): string[] {
  const lines: string[] = [];
  const keys = Object.keys(env)
    .filter((key) => (key.startsWith("AI_") && !key.endsWith("_API_KEY")) || EXACT_CONFIG_KEY_SET.has(key))
    .sort();
  for (const key of keys) lines.push(`${key}=${env[key]}`);

  // REVIEW_VERBOSITY hashes the value the review step assembles a prompt
  // from: only a genuine switch to concise changes the prompt, so only it
  // invalidates.
  if ((env.REVIEW_VERBOSITY ?? "").toLowerCase() === "concise") {
    lines.push("REVIEW_VERBOSITY=concise");
  }

  const filePaths = CONFIG_FILE_VARS
    .map((name) => env[name])
    .filter((path): path is string => Boolean(path))
    .sort();
  for (const path of filePaths) {
    const content = readFileText(path);
    if (content !== null) lines.push(`file:${path}=${content}`);
  }
  return lines;
}

/** SHA256 over the sorted, comment/blank-filtered config lines; "" when no
 * lines. Deterministic regardless of input order. */
export function computeConfigHash(configLines?: string[]): string {
  const lines = configLines ?? [];
  const filtered = lines
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .sort();
  if (filtered.length === 0) return "";
  return sha256Hex(`${filtered.join("\n")}\n`);
}

/** Library-internal broad form `{diff_fp}|{config_hash}` (no placeholder). */
export function buildBroadFingerprint(diffFp: string, configHash: string): string {
  if (!configHash) return diffFp;
  return `${diffFp}${FP_DELIMITER}${configHash}`;
}

/** The exact marker fingerprint stored in the managed comment:
 * `<diff_fp or empty-diff>|cfg:<config_hash>`. The empty-diff placeholder
 * gives an empty diff a stable, matchable value so subsequent runs skip. */
export function buildMarkerFingerprint(diffFp: string, configHash: string): string {
  const fp = diffFp || EMPTY_DIFF_FINGERPRINT;
  return `${fp}${FP_DELIMITER}${CONFIG_HASH_MARKER}${configHash}`;
}

/** Parse the marker fingerprints a stored comment body carries. Mirrors the
 * v2 sed extraction: only lines of the exact form
 * `<!-- ai-pr-review-fingerprint:<value> -->` count, and only the FIRST
 * occurrence is read. */
export function parseMarkerFingerprints(body: string): string[] {
  const found: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^<!-- ai-pr-review-fingerprint:([^>]*) -->$/.exec(line);
    if (match) {
      found.push(match[1] ?? "");
      break;
    }
  }
  return found;
}

/** Exact membership against the stored fingerprints. */
export function fingerprintsMatch(currentFp: string, previousFingerprints: readonly string[]): boolean {
  return previousFingerprints.includes(currentFp);
}
