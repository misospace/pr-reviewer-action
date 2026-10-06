import { readFileSync } from "node:fs";
import path from "node:path";
import { classificationFromArtifact, selectionToArtifact, selectSpecialistRoles } from "../classification/role-selection.js";
import { pyJsonDump } from "../context/py-json.js";
import { redactText } from "../context/redact.js";
import { pyFloatRepr, pyStr } from "../platform/py.js";
import { emptyArtifact } from "../specialists/normalize.js";
import { loadSpecialistPrompt } from "../specialists/prompts.js";

import { renderSpecialistLeadsSection } from "../specialists/render.js";
import {
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODES,
  runSpecialists,
  type ExecutionMode,
  type SpecialistRequestFn,
  type SpecialistRoleEntry,
} from "../specialists/runner.js";
import { DEFAULT_SPECIALIST_MAX_TOKENS, MAX_INPUT_BYTES, SPECIALIST_ROLES_ORDER, type SpecialistArtifact } from "../specialists/types.js";
import { guardedWrite, resolveArtifactPath, resolveRoot } from "./guarded-write.js";
import { specialistRequestFn } from "./specialist-transport.js";
import { resolveSpecialistProfiles } from "../routing/tiers.js";

/**
 * Specialists gate workload (#706 PR 6): the glue around `runSpecialists`
 * (`src/specialists/runner.ts`) that `scripts/run_specialists.py main()`
 * is in v2, launched as `node dist/index.js gate-specialists [args]` by
 * `runConcurrentGates` under `SPECIALIST_GATE_ENV_KEYS`.
 *
 * It owns what the transport- and filesystem-agnostic runner does not:
 * CLI/env → config, the #633 auto role selection from `classification.json`,
 * the transport adapter, guarded workspace writes of every artifact
 * (`specialist-<role>.request.json` / `.response.json` / `.json`,
 * `specialists.json`, `specialists.md`, `specialist-leads-present.txt`), the
 * `MAX_CORPUS` fit check, and the log lines. Fail-soft: exit 0 whenever the
 * aggregate was written; 1 only when the aggregate write itself is refused.
 *
 * Persistence happens after the phase (the runner returns artifacts rather
 * than writing them), so a refused write is folded back into the role entry
 * exactly as v2's in-flight guard records it (`error_kind: "guard"`). The
 * specialists.md section is rendered from the role artifacts as persisted,
 * re-read from disk, as v2 does.
 */

/** Where each v2 artifact holds a Python float, by exact document path.
 * Role artifacts and raw provider response bodies have none: a response is
 * `json.dumps(json.loads(body))` in v2, so its numbers keep their own form. */
const REQUEST_FLOATS: ReadonlySet<string> = new Set(["temperature"]);
const AGGREGATE_FLOATS: ReadonlySet<string> = new Set(["aggregate_elapsed_sec", "roles[].elapsed_sec"]);
const NO_FLOATS: ReadonlySet<string> = new Set();

const ROLE_GUARD_MESSAGE = "refused to write the role artifact: workspace escape or symlink";

export interface SpecialistsGateArgs {
  corpus: string;
  adversarialCorpus: string;
  /** #875: an optional path to the correctness-only "Equivalent Paths to
   * Compare" section; empty means the feature is off or produced no
   * groups for this run. */
  equivalentPaths: string;
  workspaceRoot: string;
  classification: string;
}

export type SpecialistsEnv = Readonly<Record<string, string | undefined>>;

export interface SpecialistsGateDeps {
  env: SpecialistsEnv;
  argv: readonly string[];
  /** Base for relative corpus paths and the workspace default. */
  cwd?: string;
  /** Injected transport (tests); defaults to the v3 model transport. */
  requestFn?: SpecialistRequestFn;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => number;
  sleep?: (seconds: number) => Promise<void>;
}

/** argparse for run_specialists.py: `--flag value` and `--flag=value`. */
export function parseSpecialistsArgs(argv: readonly string[]): SpecialistsGateArgs {
  const args: SpecialistsGateArgs = {
    corpus: "specialist-corpus.md",
    adversarialCorpus: "",
    equivalentPaths: "",
    workspaceRoot: "",
    classification: "classification.json",
  };
  const flags: Record<string, keyof SpecialistsGateArgs> = {
    "--corpus": "corpus",
    "--adversarial-corpus": "adversarialCorpus",
    "--equivalent-paths": "equivalentPaths",
    "--workspace-root": "workspaceRoot",
    "--classification": "classification",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const key = flags[name];
    if (key === undefined) throw new Error(`unrecognized arguments: ${arg}`);
    if (eq > 0) {
      args[key] = arg.slice(eq + 1);
    } else {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`argument ${name}: expected one argument`);
      args[key] = value;
      index += 1;
    }
  }
  return args;
}

function envStr(env: SpecialistsEnv, name: string, fallback = ""): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

/** `_env_int`: blank or non-integer → default; clamped to `lo`. */
function envInt(env: SpecialistsEnv, name: string, fallback: number, lo = 1): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^[+-]?[0-9]+(_[0-9]+)*$/.test(raw)) return fallback;
  return Math.max(lo, Number(raw.replaceAll("_", "")));
}

/** `_env_temperature`: blank or unparseable → omit the field. */
function envTemperature(env: SpecialistsEnv): number | null {
  const raw = (env.AI_TEMPERATURE ?? "").trim();
  if (raw === "") return null;
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(raw)) return null;
  return Number(raw);
}

/** Python `bytes.strip()` emptiness (ASCII whitespace only). */
function isBlank(raw: Buffer): boolean {
  for (const byte of raw) {
    if (byte !== 0x20 && (byte < 0x09 || byte > 0x0d)) return false;
  }
  return true;
}

interface CorpusRead {
  text: string | null;
  error: string | null;
  bytes: number;
}

/** `_read_corpus`: soft input errors, never an exception. */
function readCorpus(corpusPath: string, cwd: string): CorpusRead {
  let raw: Buffer;
  try {
    raw = readFileSync(path.resolve(cwd, corpusPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { text: null, error: `corpus not found: ${corpusPath}`, bytes: 0 };
    return { text: null, error: `corpus unreadable: ${redactText(error instanceof Error ? error.message : String(error))}`, bytes: 0 };
  }
  if (raw.length > MAX_INPUT_BYTES) return { text: null, error: `corpus exceeds ${MAX_INPUT_BYTES} byte input cap`, bytes: 0 };
  if (isBlank(raw)) return { text: null, error: `specialist corpus is empty: ${corpusPath}`, bytes: 0 };
  return { text: raw.toString("utf8"), error: null, bytes: raw.length };
}

/** Python `repr(str)` for the invalid-execution message. */
function pyReprStr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  return `${quote}${text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)}${quote}`;
}

/** A sleep whose pending timers can be cancelled once the phase is over:
 * the runner races each role against a phase-deadline sleep it never
 * cancels, and a live 600s timer would hold the process open. The timers stay
 * ref'd while the phase runs (a retry backoff must keep the loop alive). */
function cancellableSleep(): { sleep: (seconds: number) => Promise<void>; cancelAll: () => void } {
  const timers = new Set<NodeJS.Timeout>();
  return {
    sleep: (seconds) => new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, Math.max(0, seconds) * 1000);
      timers.add(timer);
    }),
    cancelAll: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function jsonText(value: unknown, floatPaths: ReadonlySet<string> = NO_FLOATS): string {
  return `${pyJsonDump(value, 2, false, { floatPaths })}\n`;
}

/** `gate-specialists`: exit 0 whenever the aggregate was written. The
 * specialist role prompts are embedded at build time (#809) — there is no
 * action-checkout probe and no `actionRoot` dependency. */

function loadPrompt(role: string, variant = ""): string | undefined {
  try {
    return loadSpecialistPrompt(role, variant);
  } catch {
    return undefined;
  }
}

function roleLine(entry: SpecialistRoleEntry): string {
  const suffix = entry.error_kind ? ` (${entry.error_kind})` : "";
  let usageNote = "";
  const usage = entry.usage;
  if (usage !== null && usage !== undefined && typeof usage === "object") {
    usageNote = `, tokens in/out=${pyStr(usage.prompt_tokens ?? null)}/${pyStr(usage.completion_tokens ?? null)} cached=${pyStr(usage.cached_tokens ?? null)}`;
  }
  const reason = entry.reason ? ` — ${entry.reason}` : "";
  // #846: an actual HTTP error response carries its status and a redacted
  // body excerpt into the log line — the symptom this closes was a bare
  // "error (transport)" line with no clue the endpoint answered 404.
  const httpDetail = entry.error_status !== undefined && entry.error_detail ? ` — ${entry.error_detail}` : "";
  if (entry.overrun_retry === true) usageNote += ` overrun-retry(max_tokens=${pyStr(entry.retry_max_tokens ?? null)})`;
  return `specialist ${entry.role}: ${entry.status}${suffix}${reason}${httpDetail} — ${entry.lead_count} lead(s), ${entry.errors_count} error(s), ${pyFloatRepr(entry.elapsed_sec)}s${usageNote}`;
}

/** Fold a refused write into the role entry the way v2's in-flight guard
 * records it: the role artifact becomes the failure artifact, the entry an
 * `error`/`guard` with no usage. */
function guardFailure(entry: SpecialistRoleEntry, artifact: SpecialistArtifact): SpecialistRoleEntry {
  return {
    ...entry,
    status: "error",
    error_kind: "guard",
    lead_count: artifact.leads.length,
    errors_count: artifact.errors.length,
    usage: null,
  };
}

function persistRole(
  root: string,
  role: string,
  entry: SpecialistRoleEntry,
  request: unknown,
  response: unknown,
  artifact: SpecialistArtifact | undefined,
): SpecialistRoleEntry {
  let current = entry;
  let roleArtifact: SpecialistArtifact = artifact ?? emptyArtifact(role);
  let guardMessage: string | null = null;
  if (request !== undefined && !guardedWrite(root, `specialist-${role}.request.json`, jsonText(request, REQUEST_FLOATS))) {
    guardMessage = "guard: refused to write the request artifact";
  } else if (response !== undefined) {
    const body = typeof response === "object" && response !== null ? response : { raw_response: pyStr(response) };
    if (!guardedWrite(root, `specialist-${role}.response.json`, jsonText(body))) {
      guardMessage = "guard: refused to write the response artifact";
    }
  }
  if (guardMessage !== null) {
    roleArtifact = emptyArtifact(role);
    roleArtifact.errors.push(guardMessage);
    guardedWrite(root, `specialist-${role}.response.json`, jsonText({ error: guardMessage }));
    current = guardFailure(current, roleArtifact);
  }
  if (!guardedWrite(root, `specialist-${role}.json`, jsonText(roleArtifact))) {
    const refused = emptyArtifact(role);
    refused.errors.push(ROLE_GUARD_MESSAGE);
    guardedWrite(root, `specialist-${role}.json`, jsonText(refused));
    current = guardFailure(current, refused);
  }
  return current;
}

function readRoleArtifacts(root: string): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const role of SPECIALIST_ROLES_ORDER) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(root, `specialist-${role}.json`)).toString("utf8"));
      results[role] = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
      results[role] = null;
    }
  }
  return results;
}

export async function runSpecialistsGate(deps: SpecialistsGateDeps): Promise<number> {
  const env = deps.env;
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const args = parseSpecialistsArgs(deps.argv);

  const deepMode = envStr(env, "DEEP_REVIEW", "false").trim().toLowerCase();
  if (deepMode !== "true" && deepMode !== "auto") {
    stdout("deep_review disabled; no specialist passes run");
    return 0;
  }

  let execution = envStr(env, "DEEP_REVIEW_EXECUTION", DEFAULT_EXECUTION_MODE).trim().toLowerCase();
  if (!(EXECUTION_MODES as readonly string[]).includes(execution)) {
    stderr(`ERROR: invalid DEEP_REVIEW_EXECUTION ${pyReprStr(execution)}; using ${DEFAULT_EXECUTION_MODE}`);
    execution = DEFAULT_EXECUTION_MODE;
  }

  const root = resolveRoot(args.workspaceRoot || env.GITHUB_WORKSPACE || cwd);

  // #633 auto role selection: a deterministic classification lookup; an
  // unreadable artifact selects all roles through the conservative fallback.
  let selectionArtifact: Record<string, unknown> | undefined;
  let rolesToRun: string[] = [...SPECIALIST_ROLES_ORDER];
  const skippedReasons: Record<string, string> = {};
  if (deepMode === "auto") {
    let classification: unknown = null;
    const classificationPath = resolveArtifactPath(args.classification, root);
    if (classificationPath !== null) {
      try {
        classification = JSON.parse(readFileSync(classificationPath, "utf8"));
      } catch {
        classification = null;
      }
    }
    // #871: the persisted classification.json never carries
    // substantialCodeChange (see PRClassification's field doc — the parity
    // boundary compares that artifact as one opaque string per fixture).
    // review.ts threads the in-memory signal here via this env var instead,
    // set from the same classification the run already computed.
    const rebuilt = classificationFromArtifact(classification);
    const withSubstantialChange =
      rebuilt !== null && envStr(env, "SUBSTANTIAL_CODE_CHANGE").trim().toLowerCase() === "true"
        ? { ...rebuilt, substantialCodeChange: true }
        : rebuilt;
    const selection = selectSpecialistRoles(withSubstantialChange);
    selectionArtifact = selectionToArtifact(selection);
    const selected = new Set(selection.selectedRoles);
    rolesToRun = SPECIALIST_ROLES_ORDER.filter((role) => selected.has(role));
    for (const decision of selection.decisions) {
      if (!decision.selected) skippedReasons[decision.role] = decision.reason;
    }
    let note = `deep review mode auto: selected roles [${rolesToRun.length > 0 ? rolesToRun.join(", ") : "none"}]`;
    if (rolesToRun.length === 0 && selection.zeroSelectionReason) note += ` — ${selection.zeroSelectionReason}`;
    stdout(note);
  }

  const profiles = resolveSpecialistProfiles(env);
  for (const warning of profiles.warnings) stdout(`WARNING: ${warning}`);
  const configuredRoleOverrides = ["CORRECTNESS", "SECURITY", "TESTS"].some((role) =>
    envStr(env, `AI_SPECIALIST_${role}_MODEL`).trim() !== "",
  );
  const roleModels = profiles.overridesActive && !(execution === "combined_scout" && configuredRoleOverrides)
    ? profiles.roleModels
    : undefined;
  if (execution === "combined_scout" && configuredRoleOverrides) {
    stdout("WARNING: specialist model overrides ignored under DEEP_REVIEW_EXECUTION=combined_scout; the scout call runs on the specialist profile (or primary) model");
  }
  const { baseUrl, apiFormat, model, apiKey } = profiles.transport;
  const maxTokens = envInt(env, "DEEP_REVIEW_MAX_TOKENS", DEFAULT_SPECIALIST_MAX_TOKENS);
  const temperature = envTemperature(env);
  const responseFormat = envStr(env, "AI_RESPONSE_FORMAT", "off").trim().toLowerCase();
  const tokensParam = envStr(env, "AI_TOKENS_PARAM", "max_tokens").trim().toLowerCase();
  const stream = envStr(env, "AI_STREAM", "true").trim().toLowerCase() === "true";
  const roleTimeoutSec = envInt(env, "AI_REQUEST_TIMEOUT_SEC", 300);
  const phaseTimeoutSec = envInt(env, "DEEP_REVIEW_TIMEOUT_SEC", 600);

  const corpus = readCorpus(args.corpus, cwd);
  let adversarial: CorpusRead = { text: "", error: null, bytes: 0 };
  let adversarialActive = false;
  if (args.adversarialCorpus) {
    adversarial = readCorpus(args.adversarialCorpus, cwd);
    adversarialActive = Boolean(adversarial.text);
    if (adversarial.error && !adversarial.text) {
      stdout(`WARNING: adversarial corpus unreadable (${adversarial.error}); correctness falls back to the standard corpus`);
    }
  }
  if (adversarialActive && execution === "combined_scout") {
    execution = "three_call";
    stdout("WARNING: adversarial correctness corpus is incompatible with DEEP_REVIEW_EXECUTION=combined_scout; forcing three_call");
  }

  // #875: an optional correctness-only "Equivalent Paths to Compare"
  // section. Unreadable/empty is a soft skip — the reviewer still runs
  // without the hint.
  let equivalentPathsSection: string | null = null;
  if (args.equivalentPaths) {
    const read = readCorpus(args.equivalentPaths, cwd);
    if (read.text) {
      equivalentPathsSection = read.text;
    } else if (read.error) {
      stdout(`WARNING: equivalent-paths section unreadable (${read.error}); continuing without it`);
    }
  }

  const rolePrompts: Partial<Record<string, string>> = {};
  for (const role of SPECIALIST_ROLES_ORDER) {
    // #758: an active adversarial arm runs correctness on its own variant.
    const prompt = role === "correctness" && adversarialActive
      ? loadPrompt(role, "adversarial")
      : loadPrompt(role);
    if (prompt !== undefined) rolePrompts[role] = prompt;
  }

  const requestFn = deps.requestFn ?? specialistRequestFn({
    baseUrl,
    apiKey,
    anthropicVersion: envStr(env, "ANTHROPIC_VERSION", "2023-06-01"),
  });

  const timers = cancellableSleep();
  const result = await runSpecialists({
    config: {
      apiFormat,
      model,
      baseUrl,
      apiKey,
      maxTokens,
      temperature,
      responseFormat,
      tokensParam,
      stream,
      roleTimeoutSec,
      phaseTimeoutSec,
      execution: execution as ExecutionMode,
    },
    corpus: corpus.text,
    corpusError: corpus.error,
    corpusBytes: corpus.bytes,
    rolesToRun,
    skippedReasons,
    rolePrompts,
    ...(roleModels !== undefined ? { roleModels } : {}),
    requestFn,
    ...(selectionArtifact !== undefined ? { selectionArtifact } : {}),
    deepReviewMode: deepMode,
    ...(adversarialActive ? { adversarial: { corpus: adversarial.text, corpusBytes: adversarial.bytes } } : {}),
    ...(equivalentPathsSection !== null ? { equivalentPaths: { section: equivalentPathsSection } } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    sleep: deps.sleep ?? timers.sleep,
  }).finally(timers.cancelAll);
  for (const warning of result.warnings) stdout(`WARNING: ${warning}`);

  // Persist every role artifact under the guard, folding refusals back
  // into the entries before the aggregate is rendered.
  const aggregate = result.aggregate;
  // combined_scout: the one call's request (written even when the call
  // failed, as v2 writes it before calling) and, on success only, its
  // response. A refused write fails every role, as in v2's _run_scout.
  let scoutGuard: string | null = null;
  if (execution === "combined_scout") {
    const first = rolesToRun.find((role) => result.artifacts.requests[role] !== undefined);
    if (first !== undefined) {
      if (!guardedWrite(root, "specialist-scout.request.json", jsonText(result.artifacts.requests[first], REQUEST_FLOATS))) {
        scoutGuard = "guard: refused to write the scout request artifact";
      } else if (first in result.artifacts.responses) {
        const response = result.artifacts.responses[first];
        const body = typeof response === "object" && response !== null ? response : { raw_response: pyStr(response) };
        if (!guardedWrite(root, "specialist-scout.response.json", jsonText(body))) {
          scoutGuard = "guard: refused to write the scout response artifact";
        }
      }
    }
  }
  const entries = (aggregate.roles as SpecialistRoleEntry[]).map((entry) => {
    if (entry.status === "skipped") return entry;
    const role = entry.role;
    if (execution === "combined_scout") {
      if (scoutGuard !== null) {
        const failed = emptyArtifact(role);
        failed.errors.push(scoutGuard);
        return persistRole(root, role, guardFailure(entry, failed), undefined, undefined, failed);
      }
      return persistRole(root, role, entry, undefined, undefined, result.artifacts.perRole[role]);
    }
    let response = result.artifacts.responses[role];
    const artifact = result.artifacts.perRole[role];
    if (response === undefined && entry.error_kind === "timeout" && artifact !== undefined && artifact.errors.length > 0) {
      // Reaped at the phase deadline: v2 records the timeout on the
      // response artifact too (_write_role_failure_artifacts).
      response = { error: artifact.errors[0] };
    }
    return persistRole(root, role, entry, result.artifacts.requests[role], response, artifact);
  });
  aggregate.roles = entries;
  aggregate.total_leads = entries.reduce((sum, entry) => sum + entry.lead_count, 0);
  aggregate.any_errors = entries.some((entry) => (entry.status !== "ok" && entry.status !== "skipped") || entry.errors_count > 0);

  stdout(`specialist corpus: ${corpus.bytes} bytes; specialist max_tokens: ${maxTokens}`);
  for (const entry of entries) stdout(roleLine(entry));

  if (!guardedWrite(root, "specialists.json", jsonText(aggregate, AGGREGATE_FLOATS))) {
    stderr("ERROR: refused to write specialists.json (workspace escape or symlink at the aggregate path)");
    return 1;
  }
  stdout(`deep review complete: ${String(aggregate.total_leads)} lead(s) across ${entries.length} roles in ${pyFloatRepr(aggregate.aggregate_elapsed_sec as number)}s`);

  // #609 corpus section + presence signal, rendered from the persisted role
  // artifacts; dropped when it cannot fit the final corpus budget.
  try {
    const maxBytes = envInt(env, "SPECIALISTS_SECTION_MAX_BYTES", 12000);
    let section = renderSpecialistLeadsSection(readRoleArtifacts(root), maxBytes, Object.keys(skippedReasons));
    const rawMaxCorpus = (env.MAX_CORPUS ?? "").trim();
    let maxCorpus = 0;
    if (rawMaxCorpus !== "" && /^[+-]?[0-9]+(_[0-9]+)*$/.test(rawMaxCorpus)) {
      const value = Number(rawMaxCorpus.replaceAll("_", ""));
      if (value > 0) maxCorpus = value;
    }
    if (maxCorpus > 0 && Buffer.byteLength(section, "utf8") >= maxCorpus) section = "";
    const sectionBytes = Buffer.byteLength(section, "utf8");
    guardedWrite(root, "specialists.md", section);
    guardedWrite(root, "specialist-leads-present.txt", section ? `${sectionBytes}\n` : "");
  } catch {
    stderr("note: specialist-leads section render/write failed; continuing without the #609 corpus feed");
  }
  return 0;
}
