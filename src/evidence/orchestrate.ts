/** Evidence-provider orchestration (#706 PR 5a): the port of
 * `scripts/run_evidence_providers.py` `main()` plus its shell glue — the
 * fork gate (`gate_feature_for_forks` in scripts/sections/common.sh, called
 * from classification.sh) and the failure fallback
 * (`harvest_advisory_phases`).
 *
 * Output contract (byte-identical to v2): `evidence-providers.json` is
 * `json.dumps(summary, indent=2, ensure_ascii=False)` plus a newline, and
 * `evidence-providers.md` is the redacted markdown with one trailing newline
 * — or a truly empty file when nothing is configured, so the corpus
 * builder's `[ -s ]` gate omits the section (#399/#409).
 *
 * Execution: up to 25 configured providers run through a bounded pool of
 * `EVIDENCE_PROVIDER_PARALLELISM` (default 4) workers; results keep config
 * order regardless of completion order. Each provider runs under its own
 * deadline with whole-tree termination (`runEvidenceProvider` →
 * `src/runtime`) and the evidence env allowlist, which is never widened here.
 * SARIF files follow the providers and share one collective finding cap.
 *
 * Markdown embeds are head+tail capped per stream and in aggregate, so one
 * chatty provider cannot crowd the rest out of the corpus; the JSON keeps
 * the full (per-provider capped) output. The whole markdown is redacted once
 * more before it is written.
 *
 * No production wiring yet: the orchestrator (PR 7) calls
 * `runEvidenceProvidersPhase`. */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { redactText } from "../context/redact.js";
import {
  DEFAULT_PROVIDER_MAX_OUTPUT_BYTES,
  DEFAULT_PROVIDER_TIMEOUT_SEC,
  runEvidenceProvider,
  type EvidenceProviderEntry,
  type RunEvidenceProviderOptions,
} from "./providers.js";
import {
  PyUncaughtError,
  decodeUtf8Strict,
  isPyDict,
  pyEnvInt,
  pyIntFromText,
  pyJsonDumps,
  pyJsonLoads,
  pyStr,
  pyStrip,
  pyTruthy,
} from "./pyjson.js";
import { MAX_FINDINGS as SARIF_DEFAULT_MAX_FINDINGS, pyOsErrorMessage, sarifProviderEntry, splitSarifPaths, type SarifEvidenceEntry } from "./sarif.js";

export const EVIDENCE_MARKDOWN_FILE = "evidence-providers.md";
export const EVIDENCE_JSON_FILE = "evidence-providers.json";
/** v2: `providers[:25]`. */
export const MAX_CONFIGURED_PROVIDERS = 25;
/** v2: `findings[:15]` per provider in the markdown. */
export const MAX_MARKDOWN_FINDINGS = 15;

/** The skip artifacts `gate_feature_for_forks` writes (printf '%s\n'). */
export const FORK_SKIP_MARKDOWN =
  "Evidence providers were skipped for a cross-repository pull request. Set evidence_enable_for_forks=true to override.\n";
export const FORK_SKIP_JSON = '{"configured": false, "has_blocker": false, "providers": [], "skipped": true, "skip_reason": "fork-pr"}\n';
/** The fallback artifacts `harvest_advisory_phases` writes on failure. */
export const FAILURE_FALLBACK_MARKDOWN = "Evidence providers failed to run in this review.\n";
export const FAILURE_FALLBACK_JSON = '{"configured": false, "has_blocker": false, "providers": [], "error": "execution failed"}\n';

export type EvidenceEntry = EvidenceProviderEntry | SarifEvidenceEntry;

export interface EvidenceSummary {
  configured: boolean;
  config_path: string;
  sarif_files: string[];
  has_blocker: boolean;
  providers: EvidenceEntry[];
  error?: string;
  provider_count?: number;
}

export interface EvidenceRunOptions {
  /** Source of the EVIDENCE_* / SARIF_* settings, and the ambient env the
   * provider allowlist draws from. */
  env: NodeJS.ProcessEnv;
  /** The review working directory: relative config paths resolve here,
   * providers run here, and artifacts are written here (v2: process cwd). */
  cwd: string;
  /** Monotonic clock in ms (tests freeze it). */
  clock?: () => number;
  log?: (line: string) => void;
  /** Test seam: replace the per-provider executor. */
  runProvider?: (provider: unknown, options: RunEvidenceProviderOptions) => Promise<EvidenceProviderEntry>;
}

/** `head_tail_cap`: keep the head (60%) and the tail, UTF-8 safe
 * (`errors="ignore"` at both cut points). */
export function headTailCap(text: string, maxBytes: number): string {
  const raw = Buffer.from(text, "utf8");
  if (raw.length <= maxBytes) return text;
  const headBytes = Math.floor((maxBytes * 6) / 10);
  const tailBytes = maxBytes - headBytes;
  let headEnd = headBytes;
  // Drop an incomplete trailing sequence from the head.
  let back = headEnd - 1;
  while (back >= 0 && back > headEnd - 4 && ((raw[back] as number) & 0xc0) === 0x80) back -= 1;
  if (back >= 0) {
    const lead = raw[back] as number;
    const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (back + width > headEnd) headEnd = back;
  }
  let tailStart = raw.length - tailBytes;
  // Drop orphaned continuation bytes from the tail.
  while (tailStart < raw.length && ((raw[tailStart] as number) & 0xc0) === 0x80) tailStart += 1;
  const head = raw.subarray(0, Math.max(headEnd, 0)).toString("utf8");
  const tail = raw.subarray(tailStart).toString("utf8");
  return `${head}\n…[middle truncated]…\n${tail}`;
}

/** str(Path(raw)): collapse separators, drop `.` components. */
function pyPathStr(raw: string): string {
  const leading = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  const body = parts.join("/");
  return leading + body || (leading === "" ? "." : leading);
}

function pyRstrip(text: string): string {
  return pyStrip(`x${text}`).slice(1);
}

function loadConfig(configPathRaw: string, cwd: string): { providers: unknown[]; error: string } {
  const configPath = resolvePath(cwd, configPathRaw);
  let exists = false;
  try {
    exists = existsSync(configPath) && statSync(configPath) !== undefined;
  } catch {
    exists = false;
  }
  if (!exists) return { providers: [], error: `Config file not found: ${configPathRaw}` };
  let payload: unknown;
  try {
    let bytes: Buffer;
    try {
      bytes = readFileSync(configPath);
    } catch (error) {
      throw new Error(pyOsErrorMessage(error, pyPathStr(configPathRaw)));
    }
    // Path.read_text: strict UTF-8, universal newlines.
    const text = decodeUtf8Strict(bytes).replace(/\r\n?/g, "\n");
    payload = pyJsonLoads(text);
  } catch (error) {
    // `except Exception`: whatever the read/decode/parse raised becomes the
    // message (OSError text, UnicodeDecodeError, JSONDecodeError, ValueError).
    return { providers: [], error: `Invalid JSON config: ${error instanceof Error ? error.message : String(error)}` };
  }
  let providers: unknown = [];
  if (isPyDict(payload)) {
    providers = Object.prototype.hasOwnProperty.call(payload, "providers") ? payload.providers : [];
  } else if (Array.isArray(payload)) {
    providers = payload;
  }
  return { providers: Array.isArray(providers) ? providers : [], error: "" };
}

async function mapPool<T, R>(items: readonly T[], width: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => lane()));
  // ThreadPoolExecutor.map: every task ran; the first failure in order raises.
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

/** `main()` minus the file writes: the summary and the markdown. */
export async function runEvidenceProviders(options: EvidenceRunOptions): Promise<{ summary: EvidenceSummary; markdown: string }> {
  const { env, cwd } = options;
  const configPathRaw = pyStrip(env.EVIDENCE_PROVIDERS_FILE ?? "");
  const sarifPaths = splitSarifPaths(env.SARIF_FILES ?? "");
  const defaultTimeout = pyEnvInt(env, "EVIDENCE_PROVIDER_TIMEOUT_SEC", DEFAULT_PROVIDER_TIMEOUT_SEC);
  const defaultMaxOutput = pyEnvInt(env, "EVIDENCE_PROVIDER_MAX_OUTPUT_BYTES", DEFAULT_PROVIDER_MAX_OUTPUT_BYTES);
  let sarifMaxFindings = SARIF_DEFAULT_MAX_FINDINGS;
  if (env.SARIF_MAX_FINDINGS !== undefined) {
    const parsed = pyIntFromText(env.SARIF_MAX_FINDINGS);
    if (parsed !== null && parsed >= 1) sarifMaxFindings = typeof parsed === "bigint" ? Number.MAX_SAFE_INTEGER : parsed;
  }
  const workspaceRoot = safeRealpath(resolvePath(cwd, env.GITHUB_WORKSPACE || cwd));

  const summary: EvidenceSummary = {
    configured: Boolean(configPathRaw || sarifPaths.length > 0),
    config_path: configPathRaw,
    sarif_files: sarifPaths,
    has_blocker: false,
    providers: [],
  };

  if (!configPathRaw && sarifPaths.length === 0) {
    // The normal state for consumers with no evidence providers: an empty
    // markdown, not a "not configured" diagnostic (#399/#409).
    return { summary, markdown: "" };
  }

  let providers: unknown[] = [];
  let configError = "";
  if (configPathRaw) ({ providers, error: configError } = loadConfig(configPathRaw, cwd));

  if (configError) summary.error = configError;
  summary.configured = true;
  summary.provider_count = providers.length;

  const mdLines: string[] = ["Evidence providers executed before final review synthesis.", ""];
  if (configError) {
    if (configError.startsWith("Config file not found:")) {
      mdLines.push(`Evidence providers config was not found: \`${configPathRaw}\``);
    } else {
      const detail = configError.startsWith("Invalid JSON config: ") ? configError.slice("Invalid JSON config: ".length) : configError;
      mdLines.push(`Evidence providers config could not be parsed: \`${detail}\``);
    }
    mdLines.push("");
  }

  const parallelism = pyEnvInt(env, "EVIDENCE_PROVIDER_PARALLELISM", 4);
  const indexed = providers.slice(0, MAX_CONFIGURED_PROVIDERS).map((provider, i) => ({ index: i + 1, provider }));
  const execute = options.runProvider ?? runEvidenceProvider;
  const run = (item: { index: number; provider: unknown }): Promise<EvidenceProviderEntry> =>
    execute(item.provider, {
      index: item.index,
      timeoutSec: defaultTimeout,
      maxOutputBytes: defaultMaxOutput,
      ambientEnv: env,
      cwd,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  let entries: EvidenceProviderEntry[];
  if (indexed.length <= 1 || parallelism <= 1) {
    entries = [];
    for (const item of indexed) entries.push(await run(item));
  } else {
    entries = await mapPool(indexed, Math.min(parallelism, indexed.length), run);
  }

  for (const entry of entries) {
    if (entry.provider_severity === "blocker") summary.has_blocker = true;
    summary.providers.push(entry);
  }

  let remainingSarifFindings = sarifMaxFindings;
  sarifPaths.forEach((pathText, i) => {
    const entry = sarifProviderEntry(i + 1, pathText, workspaceRoot, remainingSarifFindings);
    summary.providers.push(entry);
    remainingSarifFindings -= entry.findings.length;
  });
  summary.provider_count = summary.providers.length;

  const mdStdoutCap = pyEnvInt(env, "EVIDENCE_MARKDOWN_STDOUT_BYTES", 4000);
  const mdStderrCap = pyEnvInt(env, "EVIDENCE_MARKDOWN_STDERR_BYTES", 2000);
  let mdBudget = pyEnvInt(env, "EVIDENCE_MARKDOWN_AGGREGATE_BYTES", 24000);

  const emitStream = (label: string, text: string, perCap: number): void => {
    if (mdBudget < 256) {
      mdLines.push(`- ${label}: (omitted — aggregate evidence output cap reached; full output in evidence-providers.json)`);
      return;
    }
    const block = headTailCap(text, Math.min(perCap, mdBudget));
    mdBudget -= Buffer.byteLength(block, "utf8");
    mdLines.push(`- ${label}:`);
    mdLines.push("```text");
    mdLines.push(block);
    mdLines.push("```");
  };

  if (summary.providers.length === 0 && !configError) {
    mdLines.push("No providers were configured in the config file.");
  } else {
    for (const provider of summary.providers) {
      mdLines.push(`## ${provider.id}`);
      mdLines.push(
        `- status: ${provider.status}; severity: ${provider.provider_severity}; exit_code: ${pyStr(provider.exit_code)}; duration_sec: ${pyStr(provider.duration_sec)}`,
      );
      if ("kind" in provider && provider.kind === "sarif") {
        mdLines.push(`- SARIF source: \`${provider.source}\``);
      } else {
        mdLines.push(`- command: \`${provider.command}\``);
      }

      const findings = provider.findings;
      if (findings.length > 0) {
        mdLines.push("- findings:");
        for (const finding of findings.slice(0, MAX_MARKDOWN_FINDINGS)) {
          const source = pyTruthy(finding.source) ? ` (${finding.source})` : "";
          mdLines.push(`  - [${finding.severity}] ${finding.message}${source}`);
        }
      }

      const stdoutText = pyStrip(provider.stdout);
      if (stdoutText && findings.length === 0) emitStream("stdout", stdoutText, mdStdoutCap);
      const stderrText = pyStrip(provider.stderr);
      if (stderrText) emitStream("stderr", stderrText, mdStderrCap);

      mdLines.push("");
    }
  }

  return { summary, markdown: redactText(mdLines.join("\n")) };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDFFF]/u.test(text);
}

/** `write_outputs`. A lone surrogate cannot be UTF-8 encoded: v2's
 * `write_text` raises there, which the phase reports as a failure. */
export function writeEvidenceArtifacts(cwd: string, summary: EvidenceSummary, markdown: string): void {
  const json = `${pyJsonDumps(summary)}\n`;
  if (hasLoneSurrogate(json)) throw new PyUncaughtError("UnicodeEncodeError", "surrogates not allowed in evidence-providers.json");
  writeFileSync(resolvePath(cwd, EVIDENCE_JSON_FILE), json, "utf8");
  const md = pyStrip(markdown) ? `${pyRstrip(markdown)}\n` : "";
  if (hasLoneSurrogate(md)) throw new PyUncaughtError("UnicodeEncodeError", "surrogates not allowed in evidence-providers.md");
  writeFileSync(resolvePath(cwd, EVIDENCE_MARKDOWN_FILE), md, "utf8");
}

/** `gate_feature_for_forks` for the evidence phase: the fork flag is the
 * exact string "true" (fail-closed derivation upstream) and the override is
 * compared lowercased (ASCII `tr`). */
export function evidenceForkGateApplies(isForkPr: string | boolean, enableForForks: string | boolean): boolean {
  const fork = typeof isForkPr === "boolean" ? isForkPr : isForkPr === "true";
  const enabled = typeof enableForForks === "boolean" ? enableForForks : enableForForks.replace(/[A-Z]/g, (c) => c.toLowerCase()) === "true";
  return fork && !enabled;
}

export interface EvidencePhaseOptions extends EvidenceRunOptions {
  /** IS_FORK_PR as resolved by the precheck. */
  isForkPr: string | boolean;
  /** EVIDENCE_ENABLE_FOR_FORKS. */
  enableForForks: string | boolean;
}

export type EvidencePhaseOutcome = "skipped" | "ran" | "failed";

/** The whole evidence phase as the v2 shell runs it: fork gate → run →
 * write, with the fallback artifacts on any failure. Never throws. */
export async function runEvidenceProvidersPhase(options: EvidencePhaseOptions): Promise<EvidencePhaseOutcome> {
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  if (evidenceForkGateApplies(options.isForkPr, options.enableForForks)) {
    writeFileSync(resolvePath(options.cwd, EVIDENCE_MARKDOWN_FILE), FORK_SKIP_MARKDOWN, "utf8");
    writeFileSync(resolvePath(options.cwd, EVIDENCE_JSON_FILE), FORK_SKIP_JSON, "utf8");
    return "skipped";
  }
  try {
    const { summary, markdown } = await runEvidenceProviders(options);
    writeEvidenceArtifacts(options.cwd, summary, markdown);
    return "ran";
  } catch (error) {
    log(`ERROR: Evidence provider execution failed: ${error instanceof Error ? error.message : String(error)}`);
    writeFileSync(resolvePath(options.cwd, EVIDENCE_MARKDOWN_FILE), FAILURE_FALLBACK_MARKDOWN, "utf8");
    writeFileSync(resolvePath(options.cwd, EVIDENCE_JSON_FILE), FAILURE_FALLBACK_JSON, "utf8");
    return "failed";
  }
}
