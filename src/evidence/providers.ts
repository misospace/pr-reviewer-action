import { constants as osConstants } from "node:os";
import { runProcess } from "../runtime/subprocess.js";
import { buildChildEnv, extendAllowlist } from "../runtime/env.js";
import type { EnvAllowlist } from "../runtime/env.js";
import { redactText } from "../context/redact.js";
import {
  PyFloat,
  PyJsonDecodeError,
  PyUncaughtError,
  clampToNumber,
  isPyDict,
  pyIntOf,
  pyJsonLoads,
  pyReprStr,
  pyRound3,
  pyStr,
  pyStrip,
  pyTruthy,
} from "./pyjson.js";

/**
 * Evidence-provider execution (#679, #706 PR 5a) — the port of `run_provider`
 * and `parse_findings` in `scripts/run_evidence_providers.py`. The
 * orchestration around it (config, pool, SARIF, rendering, fork gate,
 * fallback) lives in `orchestrate.ts`.
 *
 * Trust boundary preserved verbatim: a string `command` is trusted
 * operator-supplied input and runs via `bash -lc` (the full shell-injection
 * surface is intentional for that shape; argv lists are preferred), exactly
 * like v2. Provenance constraint: provider specs come from operator-managed
 * workflow configuration (the `evidence_providers_file` input), never from
 * PR-controlled content — a future caller must not wire PR/issue-derived
 * specs into this executor without adding its own allowlist layer. The
 * executed child owns a process group, so a provider that outlives its
 * deadline cannot leave transport children behind — the whole tree is
 * terminated (the v2 `subprocess.run(timeout=)` path only killed the direct
 * child).
 *
 * Environment authority is narrower than v2 production: v2 passed
 * `os.environ` minus five scrubbed keys; v3 passes an explicit allowlist
 * (transport config, gh auth family, workspace/PR identity). `GH_TOKEN` stays
 * — providers commonly use gh. Callers widen authority only through the
 * explicit `allowEnv` extension, never through passthrough.
 *
 * Output handling is v2's: `redact_text` masks each stream before the byte
 * cut (`mask_and_truncate`), stdout is masked a second time before the JSON
 * parse, and parsing uses the CPython-faithful decoder so `output_format`
 * and the stringified findings match byte-for-byte.
 */

/**
 * Provider child environment allowlist. Deliberately narrower than the v2
 * `os.environ` passthrough: no model/Linear/MCP credentials.
 */
export const EVIDENCE_ENV_ALLOWLIST: EnvAllowlist = [
  // Process basics.
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  // Network transport (providers may talk to external services).
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  // gh CLI auth + config (GH_TOKEN kept from v2 policy).
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  // Workspace / repository identity.
  "GITHUB_WORKSPACE",
  "GITHUB_REPOSITORY",
  "GITHUB_API_URL",
  "REPO",
  "PR_NUMBER",
  "PLATFORM",
];

export const DEFAULT_PROVIDER_TIMEOUT_SEC = 30;
export const DEFAULT_PROVIDER_MAX_OUTPUT_BYTES = 20_000;
/** v2 contract: at most 40 findings per provider. */
export const MAX_PROVIDER_FINDINGS = 40;
/** setTimeout's ceiling (a larger delay fires immediately in Node). */
const MAX_TIMER_MS = 2_147_483_647;

export type ProviderSeverity = "info" | "minor" | "warning" | "major" | "blocker";

export interface ProviderFinding {
  severity: ProviderSeverity;
  message: string;
  source: string;
}

/**
 * Structured result for one provider execution. Snake_case: this is the
 * persisted artifact shape consumed by the corpus builder (v2-identical,
 * including key order). `duration_sec` is a Python float; `output_format` is
 * absent on an invalid entry, exactly like v2's early return.
 */
export interface EvidenceProviderEntry {
  id: string;
  status: "ok" | "error" | "timeout" | "invalid";
  command: string;
  duration_sec: PyFloat;
  exit_code: number | null;
  provider_severity: ProviderSeverity;
  findings: ProviderFinding[];
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  output_format?: "json" | "text";
}

export interface ProviderSpec {
  id?: unknown;
  command?: unknown;
  timeout_sec?: unknown;
  max_output_bytes?: unknown;
  [key: string]: unknown;
}

export interface RunEvidenceProviderOptions {
  /** 1-based config position; names the entry `provider-<index>` when the
   * spec carries no usable id. */
  index?: number;
  timeoutSec?: number;
  maxOutputBytes?: number;
  /** Explicit per-provider widening of the default allowlist. */
  allowEnv?: EnvAllowlist;
  /** Secret mask (default: the v2 `redact_text` port). */
  redact?: (text: string) => string;
  /** Ambient environment the allowlist draws from; defaults to process.env. */
  ambientEnv?: NodeJS.ProcessEnv;
  /** Working directory for the child (v2: the review workspace cwd). */
  cwd?: string;
  /** Monotonic clock in milliseconds (injected by the parity fixtures). */
  clock?: () => number;
  /** Diagnostic sink (v2: the logging module's stderr fallback). */
  log?: (line: string) => void;
}

export function normalizeSeverity(value: unknown): ProviderSeverity {
  if (value === null || value === undefined) return "info";
  const text = pyStrip(pyStr(value)).toLowerCase();
  if (text === "info" || text === "minor" || text === "warning" || text === "major" || text === "blocker") {
    return text;
  }
  return "info";
}

export function severityRank(value: ProviderSeverity): number {
  if (value === "blocker") return 3;
  if (value === "major" || value === "warning") return 2;
  return 1;
}

function dictGet(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Faithful port of `parse_findings` in scripts/run_evidence_providers.py:
 * Python truthiness for the `or` chains and `str()` for non-string values. */
export function parseProviderFindings(payload: unknown): {
  providerSeverity: ProviderSeverity;
  findings: ProviderFinding[];
} {
  let providerSeverity: ProviderSeverity = "info";
  const findings: ProviderFinding[] = [];

  if (!isPyDict(payload)) {
    return { providerSeverity, findings };
  }

  providerSeverity = normalizeSeverity(dictGet(payload, "severity"));
  const rawFindings = dictGet(payload, "findings");

  if (Array.isArray(rawFindings)) {
    for (const item of rawFindings) {
      if (typeof item === "string") {
        findings.push({ severity: "info", message: item, source: "" });
        continue;
      }
      if (!isPyDict(item)) continue;

      let message = dictGet(item, "message");
      if (!pyTruthy(message)) message = dictGet(item, "summary");
      if (!pyTruthy(message)) message = dictGet(item, "title");
      if (message === null || message === undefined) continue;

      let source = dictGet(item, "source");
      const sources = dictGet(item, "sources");
      if ((source === null || source === undefined) && Array.isArray(sources)) {
        source = sources.filter((part) => pyTruthy(part)).map((part) => pyStr(part)).join(", ");
      }

      findings.push({
        severity: normalizeSeverity(dictGet(item, "severity")),
        message: pyStr(message),
        source: source === null || source === undefined ? "" : pyStr(source),
      });
    }
  }

  if (findings.length === 0) {
    let fallback = dictGet(payload, "message");
    if (!pyTruthy(fallback)) fallback = dictGet(payload, "summary");
    if (fallback !== null && fallback !== undefined) {
      findings.push({ severity: providerSeverity, message: pyStr(fallback), source: "" });
    }
  }

  let highest = providerSeverity;
  for (const finding of findings) {
    if (severityRank(finding.severity) > severityRank(highest)) {
      highest = finding.severity;
    }
  }

  return { providerSeverity: highest, findings: findings.slice(0, MAX_PROVIDER_FINDINGS) };
}

function emptyEntry(id: string): EvidenceProviderEntry {
  return {
    id,
    status: "invalid",
    command: "",
    duration_sec: new PyFloat(0),
    exit_code: null,
    provider_severity: "info",
    findings: [],
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
  };
}

/** `max(minimum, int(raw))` inside `try/except (TypeError, ValueError)`. */
function coerceOverride(raw: unknown, fallback: number, minimum: number): number {
  if (raw === null || raw === undefined) return fallback;
  const parsed = pyIntOf(raw);
  if (parsed === null) return fallback;
  return clampToNumber(parsed, minimum);
}

/**
 * Captured bytes → the v2 `mask_and_truncate` result. v2 captured the whole
 * stream, masked it, then cut it to `maxOutput` bytes with a `\n[truncated]`
 * marker. v3 bounds capture at `captureCap` bytes; when capture overflowed,
 * the kept prefix is first cut back to its last ASCII whitespace byte so a
 * credential split by the capture boundary can never survive unmasked as a
 * pattern-defeating fragment, and the result is always marked truncated.
 * Below the capture cap this is byte-identical to v2.
 */
function maskCaptured(
  bytes: Buffer,
  overflowed: boolean,
  maxOutput: number,
  mask: (text: string) => string,
): { text: string; truncated: boolean } {
  let kept = bytes;
  if (overflowed) {
    let cut = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      const byte = kept[i] as number;
      if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) {
        cut = i;
        break;
      }
    }
    kept = kept.subarray(0, Math.max(cut, 0));
  }
  const masked = mask(kept.toString("utf8"));
  const raw = Buffer.from(masked, "utf8");
  if (raw.length <= maxOutput) {
    return overflowed ? { text: `${masked}\n[truncated]`, truncated: true } : { text: masked, truncated: false };
  }
  return { text: `${raw.subarray(0, maxOutput).toString("utf8")}\n[truncated]`, truncated: true };
}

/** Per-stream capture bound: `4 * max_output_bytes + 64 KiB` (v2 read the
 * streams unbounded). */
export function providerCaptureCap(maxOutput: number): number {
  return Math.min(maxOutput * 4 + 65_536, Number.MAX_SAFE_INTEGER);
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  const number = signal === null ? undefined : (osConstants.signals as Record<string, number | undefined>)[signal];
  return number === undefined ? -1 : -number;
}

/**
 * Execute a single evidence provider and return its structured entry — the
 * port of `run_provider`. Malformed specs, nonzero exits and timeouts all
 * produce a typed entry (fail-soft, like v2). Where v2 itself raised past
 * `run_provider` (an argv whose program cannot be spawned, `int(inf)` in an
 * override, an over-long JSON integer) this rejects with `PyUncaughtError`,
 * so the orchestrator reproduces the v2 phase failure and its fallback
 * artifacts. v3-only launch refusals (no pgrep, non-POSIX) stay an error
 * entry: they are fail-closed policy, not a v2 crash path.
 */
export async function runEvidenceProvider(
  provider: unknown,
  options: RunEvidenceProviderOptions = {},
): Promise<EvidenceProviderEntry> {
  const defaultTimeout = options.timeoutSec ?? DEFAULT_PROVIDER_TIMEOUT_SEC;
  const defaultMaxOutput = options.maxOutputBytes ?? DEFAULT_PROVIDER_MAX_OUTPUT_BYTES;
  const mask = options.redact ?? redactText;
  const clock = options.clock ?? ((): number => performance.now());
  const log = options.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });

  const entry = emptyEntry(`provider-${options.index ?? 1}`);
  const spec = isPyDict(provider) ? provider : null;
  if (spec !== null && pyTruthy(dictGet(spec, "id"))) entry.id = pyStr(dictGet(spec, "id"));

  let timeoutSec = defaultTimeout;
  let maxOutput = defaultMaxOutput;
  let command: unknown = undefined;
  if (spec !== null) {
    command = dictGet(spec, "command");
    timeoutSec = coerceOverride(dictGet(spec, "timeout_sec"), defaultTimeout, 1);
    maxOutput = coerceOverride(dictGet(spec, "max_output_bytes"), defaultMaxOutput, 256);
  }

  if (!pyTruthy(command)) {
    entry.status = "invalid";
    entry.stderr = "Missing required field: command";
    return entry;
  }

  let file: string;
  let args: readonly string[];
  if (Array.isArray(command)) {
    const argv = command.map((part) => pyStr(part));
    file = argv[0] as string;
    args = argv.slice(1);
    entry.command = argv.map((part) => shellQuote(part)).join(" ");
  } else {
    const commandText = pyStr(command);
    entry.command = commandText;
    // Trusted operator input; the shell surface is deliberate (v2 parity).
    log(
      `evidence provider ${pyReprStr(entry.id)}: command is a shell string and will be executed via \`bash -lc\`.  ` +
        "Prefer an argv list to avoid the bash trust boundary (see SECURITY.md).",
    );
    file = "bash";
    args = ["-lc", commandText];
  }

  const env = buildChildEnv(
    extendAllowlist(EVIDENCE_ENV_ALLOWLIST, options.allowEnv ?? []),
    options.ambientEnv ?? process.env,
  );

  const captureCap = providerCaptureCap(maxOutput);
  const start = clock();
  let handle;
  try {
    handle = runProcess({
      file,
      args,
      env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      timeoutMs: Math.min(timeoutSec * 1000, MAX_TIMER_MS),
      maxOutputBytes: captureCap,
    });
  } catch (error) {
    throw new PyUncaughtError("OSError", error instanceof Error ? error.message : String(error));
  }
  const result = await handle.result;

  if (result.status === "spawn_error") {
    if (handle.launchRefusal === null) {
      // v2's subprocess.run raised (FileNotFoundError / PermissionError /
      // ValueError) straight out of run_provider.
      throw new PyUncaughtError("OSError", result.launchError ?? "provider failed to launch");
    }
    entry.status = "error";
    entry.stderr = mask(result.stderr.toString("utf8")) || result.launchError || "provider failed to launch";
    entry.stdout = mask(result.stdout.toString("utf8"));
    entry.output_format = "text";
    return entry;
  }

  entry.duration_sec = pyRound3((clock() - start) / 1000);
  if (result.status === "timeout" || result.status === "cancelled") {
    entry.status = "timeout";
    entry.exit_code = null;
  } else {
    entry.exit_code = result.status === "signalled" ? signalExitCode(result.signal) : result.exitCode ?? -1;
    entry.status = entry.exit_code === 0 ? "ok" : "error";
  }
  const stdout = maskCaptured(result.stdout, result.stdoutTruncated, maxOutput, mask);
  const stderr = maskCaptured(result.stderr, result.stderrTruncated, maxOutput, mask);
  entry.stdout = stdout.text;
  entry.stdout_truncated = stdout.truncated;
  entry.stderr = stderr.text;
  entry.stderr_truncated = stderr.truncated;

  // v2 redacts the stored stdout a second time before the JSON parse.
  entry.stdout = mask(entry.stdout);

  let parsed: unknown = null;
  if (pyStrip(entry.stdout).length > 0) {
    try {
      parsed = pyJsonLoads(entry.stdout);
    } catch (error) {
      if (!(error instanceof PyJsonDecodeError)) throw error;
      parsed = null;
    }
  }

  if (parsed !== null) {
    entry.output_format = "json";
    const { providerSeverity, findings } = parseProviderFindings(parsed);
    entry.provider_severity = providerSeverity;
    entry.findings = findings;
  } else {
    entry.output_format = "text";
  }

  return entry;
}

/** `shlex.quote`. */
function shellQuote(part: string): string {
  if (part !== "" && !/[^A-Za-z0-9_@%+=:,./-]/.test(part)) return part;
  return `'${part.replaceAll("'", "'\\''")}'`;
}
