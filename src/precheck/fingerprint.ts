import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { extraHeaderFingerprint } from "../transport/headers.js";
import { ACTION_VERSION } from "../version.js";
import { CONFIDENCE_RUBRIC_VERSION } from "../confidence/result.js";

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
  "TOOL_MAX_RESPONSE_BYTES",
  "TOOL_ALLOWED_GH_API_REPOS",
  "TOOL_REQUEST_TIMEOUT_SEC",
  "TOOL_FAILURE_ENFORCEMENT",
  "TOOL_MIN_SUCCESSFUL_REQUESTS",
  "TOOL_ENABLE_FOR_FORKS",
  "RELATED_CODE_CONTEXT",
  "RELATED_CODE_MAX_BYTES",
  // #764: toggling the syntax-aware context stage (or its budget /
  // provider) changes what the review corpus carries, so it must
  // invalidate a cached review instead of silently reusing it.
  "SYNTAX_CONTEXT",
  "SYNTAX_CONTEXT_MAX_BYTES",
  "SYNTAX_CONTEXT_PROVIDER",
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
  // excluded from the unconditional sweep by the `*_API_KEY` rule and is
  // re-admitted below only as a one-way DIGEST, never as its raw value:
  // rotating the scorer's credential changes which account (and therefore
  // provider identity, availability, and score) answers, so the cached
  // review must not survive the rotation — see `credentialDigest`.
  // `AI_CONFIDENCE_ENABLE_FOR_FORKS` decides whether the scorer runs at all on
  // a fork PR, so it changes what is published; it must contribute whenever the
  // scorer is enabled, or a cached review made with the scorer gated off would
  // be republished after the operator turns it on. Its contract default
  // ("false") is non-empty and stable, so it adds no upgrade churn.
  "AI_CONFIDENCE_MODEL",
  "AI_CONFIDENCE_BASE_URL",
  "AI_CONFIDENCE_API_FORMAT",
  "AI_CONFIDENCE_REASONING_EFFORT",
  "AI_CONFIDENCE_TIMEOUT_SEC",
  // #1368: the scorer's token budgets and capability assertions are
  // non-secret config that changes the request bytes, so they contribute
  // exactly like the rest of the family: only while the scorer is enabled
  // (`AI_CONFIDENCE_MODEL` non-empty), and only when non-empty. The boolean
  // assertions' contract default is "false" (non-empty and stable), so they
  // add no upgrade churn and never touch the ANTHROPIC_EFFORT_SUPPORT_KEYS
  // sweep above — the confidence-family gate below owns them.
  "AI_CONFIDENCE_MAX_TOKENS",
  "AI_CONFIDENCE_PROMPT_TOKENS",
  "AI_CONFIDENCE_MODEL_CONTEXT_TOKENS",
  "AI_CONFIDENCE_ANTHROPIC_EFFORT_SUPPORT",
  "AI_CONFIDENCE_STRUCTURED_OUTPUT_SUPPORT",
  "AI_CONFIDENCE_API_KEY",
  "AI_CONFIDENCE_ENABLE_FOR_FORKS",
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

/**
 * #1152: rotating a provider credential must invalidate the cached review
 * that credential produced, so a configured lane credential re-enters the
 * config lines as a one-way digest instead of being dropped by the
 * `*_API_KEY` sweep rule outright (the pattern #1073 settled for the
 * confidence scorer's credential). The raw value is never emitted for ANY
 * key — only the digest enters the lines, and only the SHA256 over the lines
 * ever reaches the public marker comment.
 *
 * The digest covers the EXACT configured bytes, with no trim: the tier lanes
 * resolve their credential with `value()` (no trim, src/routing/tiers.ts) and
 * the transport writes it into the auth header verbatim
 * (`src/transport/http.ts`), so trimming here would fingerprint something
 * other than what the lane sends — the same "what was SENT, never what the
 * config named" rule #998 states for the effort family. The consequence is
 * deliberate: whitespace around a key is part of its identity, and on the
 * primary/smart/fallback lanes a whitespace-only value is truthy for the
 * `||` resolution, so it is a configured credential and must contribute.
 * (The specialist lane trims before its `||` and falls back to the base key,
 * so there the raw digest is FINER than what that lane sends — again
 * over-invalidation only.) Trimmed and untrimmed variants of the same secret
 * therefore digest differently; a trim here could only ever LOSE an
 * invalidation, which is the direction this fingerprint never takes.
 *
 * The same-endpoint inheritance case, decided explicitly per lane: the
 * fingerprint covers each lane's OWN configured value, never a resolved one.
 * A lane whose key is unset resolves its credential at CALL time in
 * `routing/tiers.ts`: primary = `AI_PRIMARY_API_KEY` else `AI_API_KEY`;
 * smart = `AI_SMART_API_KEY` else `AI_API_KEY`; fallback =
 * `AI_FALLBACK_API_KEY` else `AI_API_KEY`; specialist =
 * `AI_SPECIALIST_API_KEY` else the BASE `AI_API_KEY` (the profile it falls
 * back to is built from the base keys, not from `AI_PRIMARY_API_KEY`). Every
 * credential a lane can actually send is therefore either its own configured
 * key or `AI_API_KEY`, and both contribute whenever non-empty: rotating
 * `AI_API_KEY` invalidates every lane that inherits it, while an unset lane
 * key emits no line, so a credential-free (contract-default) configuration
 * stays byte-identical to the pre-#1152 hash. Re-implementing the per-lane
 * resolution inside precheck was rejected: it would duplicate `tiers.ts`
 * (drift risk) and digest the same secret once per inheriting lane.
 * Over-invalidation is the accepted direction throughout — a
 * configured-but-unused lane key (e.g. a smart key with no smart model) still
 * contributes, and its rotation then costs at most a fresh review; the
 * fingerprint fails toward re-review, never toward a stale skip.
 *
 * A new `ai-*-api-key` contract input must be added to this set in the same
 * release, exactly like `EXACT_CONFIG_KEYS`, or its rotation goes unnoticed
 * (pinned by the contract-driven registration test in
 * `tests-v3/precheck.test.ts`). `LINEAR_API_KEY` is not a model lane: its
 * contribution stays the `LINEAR_API_KEY_CONFIGURED` boolean in
 * `EXACT_CONFIG_KEYS`. */
export const CREDENTIAL_AI_KEYS: ReadonlySet<string> = new Set([
  "AI_API_KEY",
  "AI_PRIMARY_API_KEY",
  "AI_SMART_API_KEY",
  "AI_FALLBACK_API_KEY",
  "AI_SPECIALIST_API_KEY",
]);

/** One-way, domain-separated credential digest — the same shape
 * `extraHeaderFingerprint` (#1037) emits for header values: SHA256 over
 * `<key>\0<value>`, first 12 hex chars. The key name in the preimage keeps
 * one secret under two different lanes distinguishable. */
function credentialDigest(key: string, value: string): string {
  return sha256Hex(`${key}\0${value}`).slice(0, 12);
}

/** Collect configuration key=value lines from the environment map and
 * config files (port of `_collect_config_lines`). `AI_*` is swept as this
 * action's own namespace except `*_API_KEY` secrets, which re-enter only as
 * one-way digests (#1152, see `CREDENTIAL_AI_KEYS`); every other key is
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
    // default) never invalidates an existing cached review on upgrade.
    if (key.startsWith("AI_CONFIDENCE_")) {
      const scorerEnabled = (env.AI_CONFIDENCE_MODEL ?? "").trim() !== "";
      const value = (env[key] ?? "").trim();
      if (!scorerEnabled || value === "") continue;
      // The credential is the one model-affecting setting the raw-value rule
      // cannot cover: it is secret, but a rotation changes the answer, so it
      // contributes as a domain-separated one-way digest — the same shape
      // `extraHeaderFingerprint` emits for header values. The gate is
      // "configured", and digesting it is REQUIRED for correctness: a
      // configured scorer key IS used (including on the same endpoint, where
      // the transport is the primary's but the credential is the scorer's
      // own), so a rotation changes WHICH credential answers and must
      // invalidate the cached score. The digest is never the raw secret.
      if (key.endsWith("_API_KEY")) {
        lines.push(`${key}=${credentialDigest(key, value)}`);
        continue;
      }
      // #1073: the scorer's prompt/code ride action releases, so while the
      // scorer is enabled a version change must invalidate the cached review
      // and force the score to be recomputed. Emitted once per family block,
      // keyed on the enabled gate above; the over-eager direction only ever
      // costs a fresh review. Disabled (the default) emits nothing,
      // preserving baseline fingerprints.
      if (key === "AI_CONFIDENCE_MODEL") {
        lines.push(`SCORER_ACTION_VERSION=${ACTION_VERSION}`);
        // #1369: the rubric version invalidates cached scores when the
        // scoring semantics change, independent of release versioning —
        // a rubric change re-verifies even within one action release.
        lines.push(`SCORER_RUBRIC_VERSION=${CONFIDENCE_RUBRIC_VERSION}`);
      }
      lines.push(`${key}=${value}`);
      continue;
    }
    const effort = (env[key] ?? "").trim();
    if (effort !== "") lines.push(`${key}=${effort}`);
  }

  // #1152: configured lane credentials contribute as one-way digests over
  // their exact configured bytes (see CREDENTIAL_AI_KEYS for the inheritance
  // decision and why there is no trim). An unset/empty key emits nothing, so
  // a credential-free configuration keeps its byte-identical baseline hash.
  for (const key of CREDENTIAL_AI_KEYS) {
    const value = env[key] ?? "";
    if (value !== "") lines.push(`${key}=${credentialDigest(key, value)}`);
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
