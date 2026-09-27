import { existsSync, readFileSync } from "node:fs";
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

/** Keys whose values are Python floats in the v2 artifacts. */
const FLOAT_KEYS: ReadonlySet<string> = new Set(["elapsed_sec", "aggregate_elapsed_sec", "temperature"]);

const ROLE_GUARD_MESSAGE = "refused to write the role artifact: workspace escape or symlink";

export interface SpecialistsGateArgs {
  corpus: string;
  adversarialCorpus: string;
  workspaceRoot: string;
  classification: string;
}

export type SpecialistsEnv = Readonly<Record<string, string | undefined>>;

export interface SpecialistsGateDeps {
  env: SpecialistsEnv;
  argv: readonly string[];
  /** Base for relative corpus paths and the workspace default. */
  cwd?: string;
  /** Where `scripts/prompt_fragments/` lives (the action checkout). */
  actionRoot?: string;
  /** Injected transport (tests); defaults to the v3 model transport. */
  requestFn?: SpecialistRequestFn;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => number;
  sleep?: (seconds: number) => Promise<void>;
}

/** argparse for run_specialists.py: `--flag value` and `--flag=value`. */
export function parseSpecialistsArgs(argv: readonly string[]): SpecialistsGateArgs {
  const args: SpecialistsGateArgs = { corpus: "specialist-corpus.md", adversarialCorpus: "", workspaceRoot: "", classification: "classification.json" };
  const flags: Record<string, keyof SpecialistsGateArgs> = {
    "--corpus": "corpus",
    "--adversarial-corpus": "adversarialCorpus",
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

function jsonText(value: unknown): string {
  return `${pyJsonDump(value, 2, false, { floatKeys: FLOAT_KEYS })}\n`;
}

/** The action checkout that holds `scripts/prompt_fragments/`: the nearest
 * ancestor of this module (the bundle's `dist/`, or the test build) that has
 * one, else the cwd. */
export function resolveActionRoot(start: string = __dirname, cwd: string = process.cwd()): string {
  let current = start;
  for (;;) {
    if (existsSync(path.join(current, "scripts", "prompt_fragments", "specialist_correctness.txt"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function loadPrompt(role: string, actionRoot: string, variant = ""): string | undefined {
  try {
    return loadSpecialistPrompt(role, actionRoot, variant);
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
  if (entry.overrun_retry === true) usageNote += ` overrun-retry(max_tokens=${pyStr(entry.retry_max_tokens ?? null)})`;
  return `specialist ${entry.role}: ${entry.status}${suffix}${reason} — ${entry.lead_count} lead(s), ${entry.errors_count} error(s), ${pyFloatRepr(entry.elapsed_sec)}s${usageNote}`;
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
  if (request !== undefined && !guardedWrite(root, `specialist-${role}.request.json`, jsonText(request))) {
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
    const selection = selectSpecialistRoles(classificationFromArtifact(classification));
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

  const baseUrl = envStr(env, "AI_BASE_URL");
  const apiFormat = envStr(env, "AI_API_FORMAT", "openai").trim().toLowerCase();
  const model = envStr(env, "AI_MODEL");
  const apiKey = envStr(env, "AI_API_KEY");
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

  const actionRoot = deps.actionRoot ?? resolveActionRoot();
  const rolePrompts: Partial<Record<string, string>> = {};
  for (const role of SPECIALIST_ROLES_ORDER) {
    // #758: an active adversarial arm runs correctness on its own variant.
    const prompt = role === "correctness" && adversarialActive
      ? loadPrompt(role, actionRoot, "adversarial")
      : loadPrompt(role, actionRoot);
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
    requestFn,
    ...(selectionArtifact !== undefined ? { selectionArtifact } : {}),
    deepReviewMode: deepMode,
    ...(adversarialActive ? { adversarial: { corpus: adversarial.text, corpusBytes: adversarial.bytes } } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    sleep: deps.sleep ?? timers.sleep,
  }).finally(timers.cancelAll);
  for (const warning of result.warnings) stdout(`WARNING: ${warning}`);

  // Persist every role artifact under the guard, folding refusals back
  // into the entries before the aggregate is rendered.
  const aggregate = result.aggregate;
  const entries = (aggregate.roles as SpecialistRoleEntry[]).map((entry) => {
    if (entry.status === "skipped") return entry;
    const role = entry.role;
    if (execution === "combined_scout") {
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
  if (execution === "combined_scout") {
    const first = rolesToRun.find((role) => result.artifacts.requests[role] !== undefined);
    if (first !== undefined) {
      guardedWrite(root, "specialist-scout.request.json", jsonText(result.artifacts.requests[first]));
      const response = result.artifacts.responses[first];
      guardedWrite(root, "specialist-scout.response.json", jsonText(typeof response === "object" && response !== null ? response : { raw_response: pyStr(response) }));
    }
  }
  aggregate.roles = entries;
  aggregate.total_leads = entries.reduce((sum, entry) => sum + entry.lead_count, 0);
  aggregate.any_errors = entries.some((entry) => (entry.status !== "ok" && entry.status !== "skipped") || entry.errors_count > 0);

  stdout(`specialist corpus: ${corpus.bytes} bytes; specialist max_tokens: ${maxTokens}`);
  for (const entry of entries) stdout(roleLine(entry));

  if (!guardedWrite(root, "specialists.json", jsonText(aggregate))) {
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
