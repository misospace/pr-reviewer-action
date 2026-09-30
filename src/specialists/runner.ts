/** Deep-review specialist runner (#608, v3 port of `scripts/run_specialists.py`).
 *
 * Runs the fixed specialist roles (or the classifier-driven #633 auto subset)
 * concurrently, one model call per role, against the bounded specialist
 * corpus, and produces per-role artifacts plus the deterministic
 * `specialists.json` aggregate and the #609 "Specialist Review Leads" corpus
 * section. Fail-soft throughout: no role failure raises, and the aggregate
 * is always produced.
 *
 * I/O boundary: this module is transport- and filesystem-agnostic by design
 * (matching the ported #678 routing/tool-loop modules) — the caller supplies
 * a `requestFn` (normally a thin adapter over `runChatRequest`,
 * `src/transport/transport.ts`) and receives back the artifacts to persist
 * however the embedding runtime chooses to (a real guarded workspace writer
 * is the #681 orchestrator cutover's concern, not this module's). */

import {
  DEFAULT_SPECIALIST_MAX_TOKENS,
  SPECIALIST_ROLES_ORDER,
  type SpecialistArtifact,
} from "./types.js";
import { emptyArtifact, extractSpecialistJson, normalizeSpecialistOutput, parseSpecialistResponse } from "./normalize.js";
import { buildSpecialistPayload, overrunRetryPayload, payloadBytes, type SpecialistPayload } from "./payload.js";
import { completionOverran, extractResponseText, extractResponseUsage, mergeUsage, type SpecialistUsage } from "./wire.js";
import { renderSpecialistLeadsSection } from "./render.js";
import { redactText } from "../context/redact.js";
import { pyStr } from "../platform/py.js";

/** v2's `redact_text(str(response["error"]))[:500]` for an error body. */
function errorBodyText(error: unknown): string {
  return Array.from(redactText(pyStr(error))).slice(0, 500).join("");
}

/** Total attempts per role (1 initial + 1 retry) on a transport failure.
 * Timeouts and contract (parse) outcomes are never retried. */
export const MAX_ATTEMPTS = 2;
/** Base delay between the retry attempts; further clamped to the deadline. */
export const RETRY_DELAY_SEC = 5.0;
/** Floor for a per-attempt timeout: a nonpositive remaining budget must never
 * reach the transport. */
export const MIN_ATTEMPT_TIMEOUT_SEC = 0.1;

export const EXECUTION_MODES = ["three_call", "combined_scout", "prime_then_fanout"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
export const DEFAULT_EXECUTION_MODE: ExecutionMode = "three_call";

/** Fixed instruction channel in front of the corpus in every role's user
 * message. Static text (no PR/secret material) so it cannot inject. */
const USER_PREFIX =
  "Analyze the following PR review corpus within your specialist lane and return your leads as strict JSON.";

export interface SpecialistTransportOutcome {
  ok: boolean;
  /** Raw (already-deserialized) response body; present when `ok`. */
  raw?: unknown;
  /** Masked/redacted failure text; present when `!ok`. */
  errorMessage?: string;
  /** True when the failure was itself a timeout (never retried). */
  timeout?: boolean;
  /** HTTP status of a failed attempt (#846); present only when the failure
   * was an actual HTTP error response — never for network/timeout/oversized
   * failures, which have no status to report. */
  status?: number;
  /** #846: a short, secret-redacted, length-capped "HTTP <status>: <body
   * excerpt>[ — hint]" detail, present alongside `status`, for surfacing in
   * the role's log line and telemetry (separate from `errorMessage`, which
   * keeps its own v2-parity phrasing). */
  statusDetail?: string;
}

/** `(payload, apiFormat, timeoutSec) => outcome`. Never throws — transport
 * failures are reported through the outcome, matching v2's fail-soft
 * contract (the caller's adapter is responsible for catching/redacting). */
export type SpecialistRequestFn = (
  payload: SpecialistPayload,
  apiFormat: string,
  timeoutSec: number,
) => Promise<SpecialistTransportOutcome>;

export interface SpecialistRoleEntry {
  role: string;
  status: "ok" | "degraded" | "error" | "skipped";
  error_kind: string | null;
  elapsed_sec: number;
  lead_count: number;
  errors_count: number;
  /** Absent on skipped entries (v2 `_skipped_entry`). */
  usage?: Record<string, number | null> | null;
  request_bytes: number | null;
  overrun_retry?: boolean;
  retry_max_tokens?: number | null;
  reason?: string;
  /** #846: present only for an error entry whose failure was an actual HTTP
   * error response from the model endpoint (never for input/timeout/guard
   * failures, or a 200 carrying an error body). */
  error_status?: number;
  /** #846: the redacted, length-capped "HTTP <status>: <excerpt>[ — hint]"
   * detail for `error_status`, meant for the role's log line. */
  error_detail?: string;
  /** #758: which corpus (and prompt family) this role ran against —
   * telemetry only, never a behavior switch downstream. Present only for
   * roles run through `_run_role`'s three_call/prime_then_fanout path
   * (combined_scout and skipped roles never carry it, matching v2). */
  corpus_source?: "standard" | "adversarial";
}

export interface SpecialistArtifacts {
  /** `specialist-<role>.request.json` payloads, keyed by role. */
  requests: Record<string, SpecialistPayload>;
  /** `specialist-<role>.response.json` bodies (or `{error}`), keyed by role. */
  responses: Record<string, unknown>;
  /** `specialist-<role>.json` normalized contract artifacts, keyed by role. */
  perRole: Record<string, SpecialistArtifact>;
}

export interface SpecialistRunConfig {
  apiFormat: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTokens: number;
  temperature: number | null;
  responseFormat: string;
  tokensParam: string;
  stream: boolean;
  roleTimeoutSec: number;
  phaseTimeoutSec: number;
  execution: ExecutionMode;
}

export interface SpecialistRunInput {
  config: SpecialistRunConfig;
  /** Bounded specialist corpus text; `null` when unreadable (soft input
   * error — every selected role records an `input` error). */
  corpus: string | null;
  corpusError: string | null;
  corpusBytes: number;
  /** Roles to actually call (already resolved by #633 auto-selection or
   * "true" mode = all three). */
  rolesToRun: readonly string[];
  /** Reason each role NOT in `rolesToRun` was skipped. */
  skippedReasons: Record<string, string>;
  /** Each role's system prompt fragment; a missing entry is an `input`
   * failure for that role (mirrors an unreadable prompt fragment file). */
  rolePrompts: Partial<Record<string, string>>;
  requestFn: SpecialistRequestFn;
  /** Opaque #633 selection artifact attached verbatim to the aggregate. */
  selectionArtifact?: unknown;
  deepReviewMode: "true" | "auto";
  /** #758 adversarial-correctness arm (benchmark-only, default off, never
   * set by any action input): when set and `corpus` is non-null, the
   * CORRECTNESS role runs against this author-blinded corpus with the
   * adversarial prompt variant (`rolePrompts.correctness` must already be
   * the adversarial variant text when this is active); security/tests keep
   * the standard corpus. `combined_scout` cannot express a per-role corpus,
   * so an active adversarial arm forces `three_call` for this run. */
  adversarial?: {
    corpus: string | null;
    corpusBytes: number;
  };
  /** Monotonic clock in fractional seconds; injectable for deterministic
   * tests. Defaults to `Date.now() / 1000`. */
  now?: () => number;
  /** Injectable sleep (seconds) for deterministic tests. */
  sleep?: (seconds: number) => Promise<void>;
  /** Byte cap for the #609 corpus section (`SPECIALISTS_SECTION_MAX_BYTES`). */
  sectionMaxBytes?: number;
}

export interface SpecialistRunResult {
  aggregate: Record<string, unknown>;
  artifacts: SpecialistArtifacts;
  specialistsMd: string;
  specialistLeadsPresent: string;
  /** Fail-soft advisory notices (e.g. the combined_scout→three_call
   * adversarial downgrade); never affects the exit status. */
  warnings: string[];
}

function defaultNow(): number {
  return Date.now() / 1000;
}

function defaultSleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

function statusOf(result: SpecialistArtifact): "ok" | "degraded" {
  if (result.errors.length > 0) return "degraded";
  if (result.truncated) return "degraded";
  return "ok";
}

function roleEntry(
  role: string,
  artifact: SpecialistArtifact,
  status: SpecialistRoleEntry["status"],
  errorKind: string | null,
  elapsedSec: number,
  options: {
    usage?: SpecialistUsage | null;
    requestBytes?: number | null;
    overrunRetry?: boolean;
    retryMaxTokens?: number | null;
    corpusSource?: "standard" | "adversarial";
    errorStatus?: number | undefined;
    errorDetail?: string | undefined;
  } = {},
): SpecialistRoleEntry {
  return {
    role,
    status,
    error_kind: errorKind,
    elapsed_sec: Math.round(elapsedSec * 1000) / 1000,
    lead_count: artifact.leads.length,
    errors_count: artifact.errors.length,
    usage: (options.usage as unknown as Record<string, number | null> | null | undefined) ?? null,
    request_bytes: options.requestBytes ?? null,
    overrun_retry: options.overrunRetry ?? false,
    retry_max_tokens: options.retryMaxTokens ?? null,
    ...(options.corpusSource !== undefined ? { corpus_source: options.corpusSource } : {}),
    ...(options.errorStatus !== undefined ? { error_status: options.errorStatus } : {}),
    ...(options.errorDetail !== undefined ? { error_detail: options.errorDetail } : {}),
  };
}

/** v2 `_skipped_entry`: exactly these keys, in this order (no usage or
 * overrun fields — a skipped role made no request). */
function skippedEntry(role: string, reason: string): SpecialistRoleEntry {
  return {
    role,
    status: "skipped",
    error_kind: null,
    elapsed_sec: 0,
    lead_count: 0,
    errors_count: 0,
    reason,
    request_bytes: null,
  };
}

class RoleFailure {
  constructor(
    public readonly kind: string,
    public readonly message: string,
    /** #846: HTTP status of the failed attempt, when the failure was an
     * actual HTTP error response. */
    public readonly status?: number,
    /** #846: redacted, length-capped "HTTP <status>: <excerpt>[ — hint]". */
    public readonly detail?: string,
  ) {}
}

/** Request meter: counts ACTUAL transport behavior for the aggregate (#635)
 * — every real wire attempt (any execution shape, retries included) exactly
 * once, so aggregate totals can never double-count a shared combined-scout
 * call. */
class RequestMeter {
  count = 0;
  bytes = 0;
  usage: Record<string, number | null> | null = null;

  wrap(fn: SpecialistRequestFn): SpecialistRequestFn {
    return async (payload, apiFormat, timeoutSec) => {
      this.count += 1;
      this.bytes += payloadBytes(payload);
      const outcome = await fn(payload, apiFormat, timeoutSec);
      if (outcome.ok) {
        const usage = extractResponseUsage(outcome.raw);
        if (usage !== null) this.usage = mergeUsage(this.usage, usage);
      }
      return outcome;
    };
  }
}

interface RoleRunOptions {
  role: string;
  userMessage: string;
  system: string | undefined;
  config: SpecialistRunConfig;
  deadline: number;
  now: () => number;
  sleep: (seconds: number) => Promise<void>;
  requestFn: SpecialistRequestFn;
  cancelled: { value: boolean };
  /** #758: telemetry-only tag for which corpus this role ran against. */
  corpusSource: "standard" | "adversarial";
  /** Called once the wire payload exists, before any attempt: v2 writes
   * `specialist-<role>.request.json` at that point, so a role later reaped
   * at the phase deadline still leaves its request artifact. */
  onRequest?: (payload: SpecialistPayload) => void;
}

interface RoleRunOutcome {
  entry: SpecialistRoleEntry;
  request: SpecialistPayload | null;
  response: unknown;
  artifact: SpecialistArtifact;
}

async function runSpecialistRole(options: RoleRunOptions): Promise<RoleRunOutcome> {
  const { role, userMessage, system, config, deadline, now, sleep, requestFn, cancelled, corpusSource } = options;
  const started = now();
  let requestBytes: number | null = null;
  let overrunRetry = false;
  let retryMaxTokens: number | null = null;
  // #846: set only when the terminal failure was an actual HTTP error
  // response (never for input/timeout/guard failures or a 200 carrying an
  // error body).
  let errorStatus: number | undefined;
  let errorDetail: string | undefined;

  const finish = (
    artifact: SpecialistArtifact,
    status: SpecialistRoleEntry["status"],
    errorKind: string | null,
    usage: SpecialistUsage | null,
    request: SpecialistPayload | null,
    response: unknown,
  ): RoleRunOutcome => ({
    entry: roleEntry(role, artifact, status, errorKind, now() - started, {
      usage,
      requestBytes,
      overrunRetry,
      retryMaxTokens,
      corpusSource,
      errorStatus,
      errorDetail,
    }),
    request,
    response,
    artifact,
  });

  if (system === undefined) {
    const failureArtifact = emptyArtifact(role);
    failureArtifact.errors.push("input: role prompt fragment unavailable");
    return finish(failureArtifact, "error", "input", null, null, { error: "input: role prompt fragment unavailable" });
  }

  const payload = buildSpecialistPayload({
    apiFormat: config.apiFormat,
    model: config.model,
    system,
    user: userMessage,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    responseFormat: config.responseFormat,
    tokensParam: config.tokensParam,
    stream: config.stream,
  });
  requestBytes = payloadBytes(payload);
  options.onRequest?.(payload);

  // v2 `_RoleFailure("timeout", ...)`: the message lands in the artifact's
  // errors and in the response artifact, both prefixed with the kind.
  const timeoutFailure = (message: string): RoleRunOutcome => {
    const failureArtifact = emptyArtifact(role);
    failureArtifact.errors.push(`timeout: ${message}`);
    return finish(failureArtifact, "error", "timeout", null, payload, { error: `timeout: ${message}` });
  };

  let lastFailure: RoleFailure | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (cancelled.value) {
      return finish(emptyArtifact(role), "error", "timeout", null, payload, null);
    }
    const remaining = deadline - now();
    if (remaining < MIN_ATTEMPT_TIMEOUT_SEC) {
      return timeoutFailure("specialist phase deadline exceeded");
    }
    const attemptTimeout = Math.min(config.roleTimeoutSec, remaining);
    let outcome: SpecialistTransportOutcome;
    try {
      outcome = await requestFn(payload, config.apiFormat, attemptTimeout);
    } catch (error) {
      outcome = { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }

    if (!outcome.ok) {
      if (outcome.timeout) {
        return timeoutFailure(outcome.errorMessage ?? "specialist phase deadline exceeded");
      }
      lastFailure = new RoleFailure("transport", outcome.errorMessage ?? "transport failure", outcome.status, outcome.statusDetail);
      errorStatus = outcome.status;
      errorDetail = outcome.statusDetail;
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(RETRY_DELAY_SEC, Math.max(0, deadline - now()));
        if (delay > 0) await sleep(delay);
        continue;
      }
      const failureArtifact = emptyArtifact(role);
      failureArtifact.errors.push(`${lastFailure.kind}: ${lastFailure.message}`);
      return finish(failureArtifact, "error", lastFailure.kind, null, payload, { error: `${lastFailure.kind}: ${lastFailure.message}` });
    }

    // A retried attempt succeeded after an earlier failed one: the earlier
    // attempt's HTTP detail must not leak onto a success entry (#846).
    errorStatus = undefined;
    errorDetail = undefined;

    // A 200 whose body is an error object is a transport failure (some
    // gateways do this); never parse it as a lead set.
    if (typeof outcome.raw === "object" && outcome.raw !== null && "error" in (outcome.raw as Record<string, unknown>) && (outcome.raw as Record<string, unknown>).error) {
      const message = `endpoint returned an error body: ${errorBodyText((outcome.raw as Record<string, unknown>).error)}`;
      const failureArtifact = emptyArtifact(role);
      failureArtifact.errors.push(`transport: ${message}`);
      return finish(failureArtifact, "error", "transport", null, payload, { error: `transport: ${message}` });
    }

    if (cancelled.value) {
      return finish(emptyArtifact(role), "error", "timeout", null, payload, outcome.raw);
    }

    let response = outcome.raw;
    let artifact = parseSpecialistResponse(extractResponseText(response), role);

    if (completionOverran(response) && artifact.errors.length > 0 && artifact.leads.length === 0) {
      const retryPayload = overrunRetryPayload(payload, config.maxTokens);
      const remainingForRetry = deadline - now();
      if (retryPayload !== null && !cancelled.value && remainingForRetry >= MIN_ATTEMPT_TIMEOUT_SEC) {
        const retryTokens = (retryPayload.max_tokens ?? retryPayload.max_completion_tokens) as number;
        overrunRetry = true;
        retryMaxTokens = retryTokens;
        let retried: SpecialistTransportOutcome | null = null;
        try {
          retried = await requestFn(retryPayload, config.apiFormat, Math.min(config.roleTimeoutSec, remainingForRetry));
        } catch {
          retried = null;
        }
        if (retried !== null && retried.ok && !(typeof retried.raw === "object" && retried.raw !== null && (retried.raw as Record<string, unknown>).error)) {
          const retriedArtifact = parseSpecialistResponse(extractResponseText(retried.raw), role);
          if (retriedArtifact.errors.length === 0) {
            response = retried.raw;
            artifact = retriedArtifact;
          }
        }
      }
    }

    return finish(artifact, statusOf(artifact), null, extractResponseUsage(response), payload, response);
  }

  const failureArtifact = emptyArtifact(role);
  const message = lastFailure ? `${lastFailure.kind}: ${lastFailure.message}` : "transport: no attempt completed";
  failureArtifact.errors.push(message);
  return finish(failureArtifact, "error", lastFailure?.kind ?? "transport", null, null, { error: message });
}

// ---------------------------------------------------------------------------
// #635 combined-scout execution mode (benchmark-only; three_call stays the
// production default)
// ---------------------------------------------------------------------------

const SCOUT_HEADER =
  "You are performing three specialist review passes in one combined pass over the same PR review corpus. " +
  "Apply each specialist lane below to the corpus, then return one role-keyed JSON object.";

const SCOUT_SHAPE =
  'Return strict JSON exactly in this shape (no prose, no fences):\n' +
  '{\n' +
  '  "correctness": {"leads": [...]},\n' +
  '  "security": {"leads": [...]},\n' +
  '  "tests": {"leads": []}\n' +
  '}\n' +
  "Each lead object follows the same schema as the individual specialist passes (severity/category/file/line/message). " +
  "A role with no leads returns an empty leads array. Never invent a role key.";

function buildScoutSystem(rolePrompts: Partial<Record<string, string>>): string | undefined {
  const parts = [SCOUT_HEADER];
  for (const role of SPECIALIST_ROLES_ORDER) {
    const fragment = rolePrompts[role];
    if (fragment === undefined) return undefined;
    parts.push(`## ${role} lane\n\n${fragment}`);
  }
  parts.push(SCOUT_SHAPE);
  return parts.join("\n\n");
}

function parseScoutResponse(text: string | null, roles: readonly string[]): Record<string, SpecialistArtifact> {
  const payload = extractSpecialistJson(text);
  const out: Record<string, SpecialistArtifact> = {};
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    for (const role of roles) {
      const artifact = emptyArtifact(role);
      artifact.errors.push("malformed JSON: no decodable role-keyed lead object found");
      out[role] = artifact;
    }
    return out;
  }
  const record = payload as Record<string, unknown>;
  for (const role of roles) {
    let roleValue = record[role];
    if (Array.isArray(roleValue)) roleValue = { leads: roleValue };
    const artifact = normalizeSpecialistOutput(roleValue, role);
    if (!(role in record)) {
      artifact.errors.push(`scout response omitted the '${role}' role`);
    }
    out[role] = artifact;
  }
  return out;
}

async function runSpecialistScout(
  roles: readonly string[],
  userMessage: string,
  rolePrompts: Partial<Record<string, string>>,
  config: SpecialistRunConfig,
  deadline: number,
  now: () => number,
  sleep: (seconds: number) => Promise<void>,
  requestFn: SpecialistRequestFn,
): Promise<{ entries: SpecialistRoleEntry[]; request: SpecialistPayload | null; response: unknown; artifacts: Record<string, SpecialistArtifact> }> {
  const started = now();
  const system = buildScoutSystem(rolePrompts);
  // #846: set only when the terminal failure was an actual HTTP error
  // response (never for input/timeout failures or a 200 carrying an error
  // body).
  let errorStatus: number | undefined;
  let errorDetail: string | undefined;
  const failureEntries = (message: string): { entries: SpecialistRoleEntry[]; request: SpecialistPayload | null; response: unknown; artifacts: Record<string, SpecialistArtifact> } => {
    const artifacts: Record<string, SpecialistArtifact> = {};
    const entries: SpecialistRoleEntry[] = [];
    for (const role of roles) {
      const artifact = emptyArtifact(role);
      artifact.errors.push(message);
      artifacts[role] = artifact;
      entries.push(roleEntry(role, artifact, "error", message.split(":", 1)[0] ?? "transport", now() - started, { errorStatus, errorDetail }));
    }
    // v2 writes specialist-scout.request.json before the call, so a failed
    // scout still leaves it; there is no response artifact on failure.
    return { entries, request: builtPayload, response: undefined, artifacts };
  };

  let builtPayload: SpecialistPayload | null = null;
  if (system === undefined) {
    return failureEntries("input: scout prompt unavailable");
  }

  const payload = buildSpecialistPayload({
    apiFormat: config.apiFormat,
    model: config.model,
    system,
    user: userMessage,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    responseFormat: config.responseFormat,
    tokensParam: config.tokensParam,
    stream: config.stream,
  });
  builtPayload = payload;

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - now();
    if (remaining < MIN_ATTEMPT_TIMEOUT_SEC) {
      lastError = "timeout: specialist phase deadline exceeded";
      break;
    }
    const attemptTimeout = Math.min(config.roleTimeoutSec, remaining);
    let outcome: SpecialistTransportOutcome;
    try {
      outcome = await requestFn(payload, config.apiFormat, attemptTimeout);
    } catch (error) {
      outcome = { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
    }
    if (!outcome.ok) {
      if (outcome.timeout) {
        lastError = `timeout: ${outcome.errorMessage ?? "specialist phase deadline exceeded"}`;
        break;
      }
      lastError = `transport: ${outcome.errorMessage ?? "transport failure"}`;
      errorStatus = outcome.status;
      errorDetail = outcome.statusDetail;
      if (attempt < MAX_ATTEMPTS) {
        const delay = Math.min(RETRY_DELAY_SEC, Math.max(0, deadline - now()));
        if (delay > 0) await sleep(delay);
        continue;
      }
      break;
    }
    if (typeof outcome.raw === "object" && outcome.raw !== null && (outcome.raw as Record<string, unknown>).error) {
      lastError = `transport: endpoint returned an error body: ${errorBodyText((outcome.raw as Record<string, unknown>).error)}`;
      break;
    }
    const artifacts = parseScoutResponse(extractResponseText(outcome.raw), roles);
    const elapsed = now() - started;
    const entries = roles.map((role) => roleEntry(role, artifacts[role]!, statusOf(artifacts[role]!), null, elapsed));
    return { entries, request: payload, response: outcome.raw, artifacts };
  }

  return failureEntries(lastError ?? "transport: no attempt completed");
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export async function runSpecialists(input: SpecialistRunInput): Promise<SpecialistRunResult> {
  const now = input.now ?? defaultNow;
  const sleep = input.sleep ?? defaultSleep;
  const config = input.config;
  const phaseStarted = now();
  const deadline = phaseStarted + config.phaseTimeoutSec;
  const meter = new RequestMeter();
  const meteredRequestFn = meter.wrap(input.requestFn);
  const cancelled = { value: false };

  const artifacts: SpecialistArtifacts = { requests: {}, responses: {}, perRole: {} };
  let entries: SpecialistRoleEntry[] = [];
  const warnings: string[] = [];

  // #758: the adversarial-correctness corpus is optional and fail-soft — an
  // unreadable/empty adversarial corpus keeps the correctness role on the
  // standard corpus and the default prompt (never blocks the phase).
  const adversarialActive = input.adversarial !== undefined && input.adversarial.corpus !== null;
  let execution = config.execution;
  if (adversarialActive && execution === "combined_scout") {
    // The #635 scout shares ONE call across roles with one user message; a
    // per-role corpus cannot be expressed in that shape. Degrade loudly to
    // three_call rather than silently feeding the correctness role the
    // standard corpus.
    execution = "three_call";
    warnings.push(
      "adversarial correctness corpus is incompatible with DEEP_REVIEW_EXECUTION=combined_scout; forcing three_call",
    );
  }

  if (input.corpus === null) {
    // No corpus means no calls at all: every SELECTED role is recorded as a
    // soft input failure and skipped roles keep their skip telemetry.
    for (const role of SPECIALIST_ROLES_ORDER) {
      if (!input.rolesToRun.includes(role)) {
        entries.push(skippedEntry(role, input.skippedReasons[role] ?? ""));
        continue;
      }
      const artifact = emptyArtifact(role);
      artifact.errors.push(`input: ${input.corpusError ?? "corpus unavailable"}`);
      artifacts.perRole[role] = artifact;
      entries.push(roleEntry(role, artifact, "error", "input", 0));
    }
  } else {
    const userMessage = `${USER_PREFIX}\n\n${input.corpus}`;

    if (execution === "combined_scout") {
      const scout = await runSpecialistScout(
        input.rolesToRun,
        userMessage,
        input.rolePrompts,
        config,
        deadline,
        now,
        sleep,
        meteredRequestFn,
      );
      for (const role of input.rolesToRun) artifacts.perRole[role] = scout.artifacts[role]!;
      if (scout.request !== null) {
        for (const role of input.rolesToRun) {
          artifacts.requests[role] = scout.request;
          if (scout.response !== undefined) artifacts.responses[role] = scout.response;
        }
      }
      const byRole = new Map(scout.entries.map((entry) => [entry.role, entry] as const));
      entries = SPECIALIST_ROLES_ORDER.map((role) => {
        if (byRole.has(role)) return byRole.get(role)!;
        return skippedEntry(role, input.skippedReasons[role] ?? "");
      });
    } else {
      const roleWork = new Map<string, Promise<RoleRunOutcome>>();
      const roleCancel = new Map<string, { value: boolean }>();
      for (const role of input.rolesToRun) roleCancel.set(role, { value: false });

      const launch = (role: string): void => {
        // #758: the correctness role runs blinded (adversarial corpus +
        // adversarial prompt variant) when the adversarial corpus is active;
        // security/tests always see the standard corpus and the default
        // prompt.
        const useAdversarial = role === "correctness" && adversarialActive;
        const roleUserMessage = useAdversarial ? `${USER_PREFIX}\n\n${input.adversarial!.corpus}` : userMessage;
        roleWork.set(
          role,
          runSpecialistRole({
            role,
            userMessage: roleUserMessage,
            system: input.rolePrompts[role],
            config,
            deadline,
            now,
            sleep,
            requestFn: meteredRequestFn,
            cancelled: roleCancel.get(role)!,
            corpusSource: useAdversarial ? "adversarial" : "standard",
            onRequest: (payload) => {
              artifacts.requests[role] = payload;
            },
          }),
        );
      };

      if (execution === "prime_then_fanout" && input.rolesToRun.length > 0) {
        // #635: sequential "prime once, then fan out" — the first selected
        // role (fixed order) completes before the remaining two launch.
        const first = SPECIALIST_ROLES_ORDER.find((role) => input.rolesToRun.includes(role))!;
        launch(first);
        await Promise.race([
          roleWork.get(first),
          sleep(Math.max(0, deadline - now())).then(() => {
            roleCancel.get(first)!.value = true;
          }),
        ]);
        for (const role of input.rolesToRun) {
          if (role !== first) launch(role);
        }
      } else {
        for (const role of input.rolesToRun) launch(role);
      }

      entries = [];
      for (const role of SPECIALIST_ROLES_ORDER) {
        if (!roleWork.has(role)) {
          entries.push(skippedEntry(role, input.skippedReasons[role] ?? ""));
          continue;
        }
        const remaining = Math.max(0, deadline - now());
        const timeoutSentinel = Symbol("timeout");
        const outcome = await Promise.race([
          roleWork.get(role)!,
          sleep(remaining).then(() => timeoutSentinel as unknown as RoleRunOutcome),
        ]);
        if ((outcome as unknown) === timeoutSentinel) {
          roleCancel.get(role)!.value = true;
          const timeoutArtifact = emptyArtifact(role);
          timeoutArtifact.errors.push(`timeout: specialist phase exceeded ${config.phaseTimeoutSec}s`);
          artifacts.perRole[role] = timeoutArtifact;
          entries.push(roleEntry(role, timeoutArtifact, "error", "timeout", now() - phaseStarted));
          // The straggler's own promise is left to resolve in the
          // background (fire-and-forget); it is never awaited again and its
          // rejection, if any, must not surface as unhandled.
          roleWork.get(role)!.catch(() => undefined);
          continue;
        }
        const settled = outcome;
        if (settled.request !== null) artifacts.requests[role] = settled.request;
        if (settled.response !== null) artifacts.responses[role] = settled.response;
        artifacts.perRole[role] = settled.artifact;
        entries.push(settled.entry);
      }
    }
  }

  cancelled.value = true; // no further writes from any straggler after this point
  const aggregateElapsed = now() - phaseStarted;
  const totalLeads = entries.reduce((sum, entry) => sum + entry.lead_count, 0);
  const anyErrors = entries.some((entry) => (entry.status !== "ok" && entry.status !== "skipped") || entry.errors_count > 0);

  const aggregate: Record<string, unknown> = {
    version: 1,
    enabled: true,
    deep_review_mode: input.deepReviewMode,
    execution,
    request_count: meter.count,
    request_bytes: meter.bytes,
    usage_totals: meter.usage,
    model: `${config.model}@${config.baseUrl} (${config.apiFormat})`,
    aggregate_elapsed_sec: Math.round(aggregateElapsed * 1000) / 1000,
    specialist_corpus_bytes: input.corpusBytes,
    // #758: whether the adversarial-correctness arm was active and which
    // corpus the correctness role actually ran against.
    adversarial_correctness_active: adversarialActive,
    adversarial_corpus_bytes: adversarialActive ? (input.adversarial?.corpusBytes ?? null) : null,
    specialist_max_tokens: config.maxTokens,
    total_leads: totalLeads,
    any_errors: anyErrors,
    roles: entries,
  };
  if (input.selectionArtifact !== undefined) {
    aggregate.selection = input.selectionArtifact;
  }

  const skippedSet = new Set(Object.keys(input.skippedReasons));
  const sectionMaxBytes = input.sectionMaxBytes ?? 12000;
  const specialistsMd = renderSpecialistLeadsSection(artifacts.perRole, sectionMaxBytes, [...skippedSet]);
  const specialistLeadsPresent = specialistsMd ? `${Buffer.byteLength(specialistsMd, "utf8")}\n` : "";

  return { aggregate, artifacts, specialistsMd, specialistLeadsPresent, warnings };
}

export { DEFAULT_SPECIALIST_MAX_TOKENS };
