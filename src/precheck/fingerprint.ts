import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { extraHeaderFingerprint } from "../transport/headers.js";

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
  "FALLBACK_MODEL_CONTEXT_TOKENS",
  "PRIMARY_REQUEST_SHAPE",
  "SMART_REQUEST_SHAPE",
  // #1009: per-lane `response_format` selects which `response_format` body
  // shape the OpenAI-compatible lane emits. The `AI_*` prefix is swept
  // automatically by `collectConfigLines`; the note here is for reviewers
  // — changing the effective lane value IS model-affecting config, so an
  // unchanged diff must NOT skip a review that emitted a different request
  // byte sequence.
  "REVIEW_ROUTING_MODE",
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
  "REPOSITORY_SKILLS",
  "REPOSITORY_SKILL_PATH",
  "REPOSITORY_SKILLS_FINGERPRINT",
  "TOOL_MAX_REQUESTS",
  "PRIMARY_TOOL_MAX_REQUESTS",
  "SMART_TOOL_MAX_REQUESTS",
  "TOOL_MAX_ROUNDS",
  "SMART_TOOL_MAX_ROUNDS",
  "TOOL_LOOP_WALL_CLOCK_SEC",
  "SMART_TOOL_LOOP_WALL_CLOCK_SEC",
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
  "REVIEW_THREADS_CONTEXT",
  "REVIEW_THREADS_MAX_BYTES",
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

// O_NONBLOCK keeps a config path swapped to a FIFO (or a symlink to one)
// from blocking the open; such entries fail the fstat regular-file check
// below and are skipped — the same outcome v2's os.path.isfile produced.
const CONFIG_FILE_FLAGS: number = fsConstants.O_RDONLY | fsConstants.O_NONBLOCK;

/** Read a config file's content, or null when it is not a readable regular
 * file. The path is opened exactly once and both the regular-file check
 * (fstat on the descriptor) and the read (readFileSync on the descriptor)
 * operate on that one open, so a swap between the two cannot make them see
 * different resolutions of the same path — no check-then-use TOCTOU
 * (CodeQL #139, js/file-system-race). Symlink semantics match v2: a symlink
 * to a regular file reads the target; broken links, directories, FIFOs, and
 * unreadable/missing paths are skipped. */
function readFileText(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, CONFIG_FILE_FLAGS);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A descriptor that is already closed must not mask the result.
      }
    }
  }
}

/**
 * #998: the reasoning-effort family and its Anthropic opt-in are
 * model-affecting config — changing an effective effort changes the request
 * bytes, so an unchanged diff must NOT skip a review. But they are also
 * `AI_*` keys the sweep above would pick up UNCONDITIONALLY, and
 * `stageEnvFromConfig` projects every contract input even when empty, so a
 * plain sweep would emit `AI_REASONING_EFFORT=` / `..._SUPPORT=false` for
 * every existing user and invalidate every cached review on upgrade. These
 * keys are therefore removed from the unconditional sweep and re-emitted
 * below only when they actually change behavior: an unset configuration
 * produces a config hash IDENTICAL to a build without the feature.
 */
const CONDITIONAL_AI_KEYS: ReadonlySet<string> = new Set([
  "AI_REASONING_EFFORT",
  "AI_PRIMARY_REASONING_EFFORT",
  "AI_SMART_REASONING_EFFORT",
  // #1053: the fallback override stays "" in the resolved config when the
  // operator left it unset (load-config does not copy the base into it), so
  // only a configured value ever contributes a line here.
  "AI_FALLBACK_REASONING_EFFORT",
  "AI_SPECIALIST_REASONING_EFFORT",
  "AI_ANTHROPIC_EFFORT_SUPPORT",
  // #998 (#1049 review): the per-lane Anthropic effort opt-ins. Same rule:
  // the unconditional sweep would emit `..._SUPPORT=false` for every existing
  // user and invalidate every cached review, so only a `true` contributes.
  "AI_SMART_ANTHROPIC_EFFORT_SUPPORT",
  "AI_FALLBACK_ANTHROPIC_EFFORT_SUPPORT",
  "AI_SPECIALIST_ANTHROPIC_EFFORT_SUPPORT",
  // #1047: the per-lane Anthropic structured-output opt-ins — identical rule
  // (only a `true` changes request bytes and thus the fingerprint).
  "AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT",
  "AI_SMART_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT",
  "AI_FALLBACK_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT",
  // #1037: excluded from the unconditional sweep and re-emitted through the
  // canonical extra-header fingerprint below (see CANONICALIZED_AI_KEYS).
  "AI_EXTRA_HEADERS",
  // #1073: the confidence-scorer family. `stageEnvFromConfig` projects every
  // contract input even when empty, and `AI_CONFIDENCE_TIMEOUT_SEC` has a
  // NON-empty contract default (120), so the unconditional sweep would add a
  // new line for every existing installation and invalidate every cached
  // review on upgrade. The whole family is conditional below: with the
  // scorer disabled (the default) it contributes NOTHING — the config hash
  // is byte-identical to a build without the feature — and with the scorer
  // enabled its non-empty values contribute. `AI_CONFIDENCE_API_KEY` is
  // excluded from the sweep by the `*_API_KEY` rule and stays excluded here
  // (the loop only ever emits non-secret config keys).
  "AI_CONFIDENCE_MODEL",
  "AI_CONFIDENCE_BASE_URL",
  "AI_CONFIDENCE_API_FORMAT",
  "AI_CONFIDENCE_REASONING_EFFORT",
  "AI_CONFIDENCE_TIMEOUT_SEC",
  "AI_CONFIDENCE_API_KEY",
]);

/** #1037: the `ai-extra-headers` surface is hashed by its canonical
 * fingerprint, not by its raw text. The rule, in full: ephemeral
 * correlation/session/trace headers (`*-session-id`, `*-request-id`,
 * `*-correlation-id`, `*-trace-id`, `*-span-id`, `*-run-id`, `traceparent`,
 * `tracestate`, `x-b3-traceid`, `x-b3-spanid`, `x-b3-parentspanid`) participate
 * BY NAME only,
 * because their values legitimately change every run (`x-litellm-session-id:
 * <run id>`) and hashing them would break the unchanged-diff skip for exactly
 * the canonical user of this input; EVERY OTHER header participates by name
 * plus a truncated digest of its VALUE, so changing a non-ephemeral value —
 * swapping one `anthropic-beta` token for another, which really does change
 * the request bytes — invalidates the cached review and forces a fresh one.
 * Adding or removing a header invalidates too. The digest is one-way and the
 * raw value never enters the fingerprint. A value that cannot be parsed (only
 * possible if startup validation was bypassed) hashes to an explicit
 * `malformed` line — fail closed toward a fresh review, never toward a silent
 * skip — and blank/whitespace-only input emits nothing, so an unset
 * configuration keeps a byte-identical fingerprint. */
const CANONICALIZED_AI_KEYS: ReadonlySet<string> = new Set([
  "AI_EXTRA_HEADERS",
]);

/** The subset of `CONDITIONAL_AI_KEYS` that are booleans rather than efforts:
 * an explicit set, so a future `*_EFFORT_*` key can never be silently
 * half-emitted by a name-suffix guess. Keep in step with `schema.ts`
 * BOOLEAN_INPUTS and `routing/tiers.ts`. */
const ANTHROPIC_EFFORT_SUPPORT_KEYS: ReadonlySet<string> = new Set([
  "AI_ANTHROPIC_EFFORT_SUPPORT",
  "AI_SMART_ANTHROPIC_EFFORT_SUPPORT",
  "AI_FALLBACK_ANTHROPIC_EFFORT_SUPPORT",
  "AI_SPECIALIST_ANTHROPIC_EFFORT_SUPPORT",
  // #1047: same boolean treatment for the structured-output opt-ins.
  "AI_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT",
  "AI_SMART_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT",
  "AI_FALLBACK_ANTHROPIC_STRUCTURED_OUTPUT_SUPPORT",
]);

/** Collect configuration key=value lines from the environment map and
 * config files (port of `_collect_config_lines`). `AI_*` is swept as this
 * action's own namespace except `*_API_KEY` secrets; every other key is
 * matched by exact name so runner-preset provider vars cannot skew the
 * hash across runner images. */
export function collectConfigLines(env: Record<string, string>): string[] {
  const lines: string[] = [];
  const keys = Object.keys(env)
    .filter((key) => (
      (key.startsWith("AI_") && !key.endsWith("_API_KEY") && !CONDITIONAL_AI_KEYS.has(key))
      || (EXACT_CONFIG_KEY_SET.has(key) && !["REPOSITORY_SKILLS", "REPOSITORY_SKILL_PATH", "REPOSITORY_SKILLS_FINGERPRINT"].includes(key))
    ))
    .sort();
  for (const key of keys) lines.push(`${key}=${env[key]}`);

  // Repository skill opt-in and trusted-base content affect review context.
  // Disabled/default state emits no lines, preserving baseline fingerprints.
  const skillsEnabled = (env.REPOSITORY_SKILLS ?? "").trim().toLowerCase() === "true";
  if (skillsEnabled) lines.push("REPOSITORY_SKILLS=true");
  const explicitSkillPath = (env.REPOSITORY_SKILL_PATH ?? "").trim();
  if (explicitSkillPath !== "") lines.push(`REPOSITORY_SKILL_PATH=${explicitSkillPath}`);
  if (skillsEnabled || explicitSkillPath !== "") {
    const contentFingerprint = (env.REPOSITORY_SKILLS_FINGERPRINT ?? "").trim();
    lines.push(`REPOSITORY_SKILLS_FINGERPRINT=${contentFingerprint || "unavailable"}`);
  }

  // REVIEW_VERBOSITY hashes the value the review step assembles a prompt
  // from: only a genuine switch to concise changes the prompt, so only it
  // invalidates.
  if ((env.REVIEW_VERBOSITY ?? "").toLowerCase() === "concise") {
    lines.push("REVIEW_VERBOSITY=concise");
  }
  // CLAIM_FALSIFICATION (#785): only an enabled pre-pass changes the corpus,
  // so only "true" contributes and the default leaves existing fingerprints
  // valid.
  if ((env.CLAIM_FALSIFICATION ?? "").trim().toLowerCase() === "true") {
    lines.push("CLAIM_FALSIFICATION=true");
  }
  // #1003/#1005: human-review triage and its routing layer only run when
  // opted in, so only the enabled state contributes and the defaults leave
  // existing fingerprints valid (same rule as CLAIM_FALSIFICATION above).
  // The routing line carries the *effective* routing mode: with triage
  // disabled the mode is inert, so only triage-enabled non-`off` modes
  // contribute — `off`/unset never invalidates a cached review on upgrade.
  const triageEnabled = (env.REVIEW_TRIAGE ?? "").trim().toLowerCase() === "true";
  if (triageEnabled) {
    lines.push("REVIEW_TRIAGE=true");
  }
  const routingMode = (env.REVIEW_TRIAGE_ROUTING_MODE ?? "").trim().toLowerCase();
  if (triageEnabled && (routingMode === "advisory" || routingMode === "request")) {
    lines.push(`REVIEW_TRIAGE_ROUTING_MODE=${routingMode}`);
  }
  // #998: only a resolved effort contributes. The value is the request's own
  // field, so a change here is a real behavior change (and the emitted line
  // is byte-identical to the sweep's, keeping one canonical form per key).
  for (const key of CONDITIONAL_AI_KEYS) {
    if (CANONICALIZED_AI_KEYS.has(key)) {
      const raw = (env[key] ?? "").trim();
      if (raw !== "") {
        let fingerprint: string;
        try {
          fingerprint = extraHeaderFingerprint(raw);
        } catch {
          fingerprint = "malformed";
        }
        // Newline-only input parses to no headers — behaves as unset and
        // emits nothing, keeping the baseline fingerprint stable.
        if (fingerprint !== "") lines.push(`${key}=${fingerprint}`);
      }
      continue;
    }
    if (ANTHROPIC_EFFORT_SUPPORT_KEYS.has(key)) {
      if ((env[key] ?? "").trim().toLowerCase() === "true") lines.push(`${key}=true`);
      continue;
    }
    // #1073: the confidence-scorer family contributes only while the scorer
    // is enabled (`AI_CONFIDENCE_MODEL` non-empty). Disabled — the default —
    // emits nothing, so `AI_CONFIDENCE_TIMEOUT_SEC=120` (a non-empty contract
    // default) never invalidates an existing cached review on upgrade. The
    // `*_API_KEY` exclusion holds here too: the key is listed in
    // CONDITIONAL_AI_KEYS only so the sweep can never pick it up, and this
    // loop must not re-admit it.
    if (key.startsWith("AI_CONFIDENCE_")) {
      if (key.endsWith("_API_KEY")) continue;
      const scorerEnabled = (env.AI_CONFIDENCE_MODEL ?? "").trim() !== "";
      const value = (env[key] ?? "").trim();
      if (scorerEnabled && value !== "") lines.push(`${key}=${value}`);
      continue;
    }
    const effort = (env[key] ?? "").trim();
    if (effort !== "") lines.push(`${key}=${effort}`);
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
