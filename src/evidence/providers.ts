import { runProcess } from "../runtime/subprocess.js";
import { buildChildEnv, extendAllowlist } from "../runtime/env.js";
import type { EnvAllowlist } from "../runtime/env.js";

/**
 * Evidence-provider execution (#679) — the typed seam for the user-defined
 * provider commands `scripts/run_evidence_providers.py` runs in v2.
 *
 * Trust boundary preserved verbatim: a string `command` is trusted
 * operator-supplied input and runs via `bash -lc` (the full shell-injection
 * surface is intentional for that shape; argv lists are preferred), exactly
 * like v2. The executed child owns a process group, so a provider that
 * outlives its deadline cannot leave transport children behind — the whole
 * tree is terminated (the v2 `subprocess.run(timeout=)` path only killed the
 * direct child).
 *
 * Environment authority is narrower than production: v2 passed
 * `os.environ` minus five scrubbed keys; v3 passes an explicit allowlist
 * (transport config, gh auth family, workspace/PR identity). `GH_TOKEN` stays
 * — providers commonly use gh. Callers widen authority only through the
 * explicit `allowEnv` extension, never through passthrough.
 *
 * Secret redaction stays a downstream seam: v2 masks stdout/stderr via
 * `scripts/redact.py` before capture; the v3 executor accepts the same mask
 * as an injected `redact` function (default identity) until the redaction
 * pipeline itself migrates.
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

export type ProviderSeverity = "info" | "minor" | "warning" | "major" | "blocker";

/**
 * Structured result for one provider execution. Snake_case: this is the
 * persisted artifact shape consumed by the corpus builder (v2-identical).
 */
export interface EvidenceProviderEntry {
  id: string;
  status: "ok" | "error" | "timeout" | "invalid";
  command: string;
  duration_sec: number;
  exit_code: number | null;
  provider_severity: ProviderSeverity;
  findings: ProviderFinding[];
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  output_format: "json" | "text";
}

export interface ProviderFinding {
  severity: ProviderSeverity;
  message: string;
  source: string;
}

export interface ProviderSpec {
  id?: string;
  command?: string | readonly string[];
  timeout_sec?: number | string;
  max_output_bytes?: number | string;
}

export interface RunEvidenceProviderOptions {
  timeoutSec?: number;
  maxOutputBytes?: number;
  /** Explicit per-provider widening of the default allowlist. */
  allowEnv?: EnvAllowlist;
  /** Secret mask applied to captured output (default identity). */
  redact?: (text: string) => string;
  /** Ambient environment the allowlist draws from; defaults to process.env. */
  ambientEnv?: NodeJS.ProcessEnv;
}

export function normalizeSeverity(value: unknown): ProviderSeverity {
  if (value === null || value === undefined) return "info";
  const text = String(value).trim().toLowerCase();
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

/** Faithful port of `parse_findings` in scripts/run_evidence_providers.py. */
export function parseProviderFindings(payload: unknown): {
  providerSeverity: ProviderSeverity;
  findings: ProviderFinding[];
} {
  let providerSeverity: ProviderSeverity = "info";
  const findings: ProviderFinding[] = [];

  if (typeof payload !== "object" || payload === null) {
    return { providerSeverity, findings };
  }
  const record = payload as Record<string, unknown>;

  providerSeverity = normalizeSeverity(record.severity);
  const rawFindings = record.findings;

  if (Array.isArray(rawFindings)) {
    for (const item of rawFindings) {
      if (typeof item === "string") {
        findings.push({ severity: "info", message: item, source: "" });
        continue;
      }
      if (typeof item !== "object" || item === null) continue;

      const entry = item as Record<string, unknown>;
      const message = entry.message ?? entry.summary ?? entry.title;
      if (message === null || message === undefined) continue;

      let source: unknown = entry.source;
      if (source === null || source === undefined) {
        if (Array.isArray(entry.sources)) {
          source = entry.sources.filter((part) => part).join(", ");
        }
      }

      findings.push({
        severity: normalizeSeverity(entry.severity),
        message: String(message),
        source: source === null || source === undefined ? "" : String(source),
      });
    }
  }

  if (findings.length === 0) {
    const fallback = record.message ?? record.summary;
    if (fallback !== null && fallback !== undefined) {
      findings.push({ severity: providerSeverity, message: String(fallback), source: "" });
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
    duration_sec: 0,
    exit_code: null,
    provider_severity: "info",
    findings: [],
    stdout: "",
    stderr: "",
    stdout_truncated: false,
    stderr_truncated: false,
    output_format: "text",
  };
}

function coercePositiveInt(raw: unknown, fallback: number, minimum: number): number {
  if (raw === null || raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.trunc(value));
}

/**
 * Execute a single evidence provider and return its structured entry.
 * Never throws: malformed specs, transport failures, and timeouts all
 * produce a typed entry (fail-soft, like v2).
 */
export async function runEvidenceProvider(
  provider: ProviderSpec,
  options: RunEvidenceProviderOptions = {},
): Promise<EvidenceProviderEntry> {
  const defaultTimeout = options.timeoutSec ?? DEFAULT_PROVIDER_TIMEOUT_SEC;
  const defaultMaxOutput = options.maxOutputBytes ?? DEFAULT_PROVIDER_MAX_OUTPUT_BYTES;
  const redact = options.redact ?? ((text: string): string => text);

  const entry = emptyEntry(
    provider.id !== undefined && provider.id !== null && String(provider.id).length > 0
      ? String(provider.id)
      : "provider",
  );

  const timeoutSec = coercePositiveInt(provider.timeout_sec, defaultTimeout, 1);
  const maxOutput = coercePositiveInt(provider.max_output_bytes, defaultMaxOutput, 256);

  const spec = provider.command;
  if (spec === undefined || spec === null || spec === "" || (Array.isArray(spec) && spec.length === 0)) {
    entry.stderr = "Missing required field: command";
    return entry;
  }

  let file: string;
  let args: readonly string[];
  if (Array.isArray(spec)) {
    const argv = spec.map((part) => String(part));
    file = argv[0] ?? "";
    args = argv.slice(1);
    entry.command = argv.map((part) => shellQuote(part)).join(" ");
  } else {
    const commandText = String(spec);
    entry.command = commandText;
    // Trusted operator input; the shell surface is deliberate (v2 parity).
    file = "bash";
    args = ["-lc", commandText];
  }

  const env = buildChildEnv(
    extendAllowlist(EVIDENCE_ENV_ALLOWLIST, options.allowEnv ?? []),
    options.ambientEnv ?? process.env,
  );

  const handle = runProcess({
    file,
    args,
    env,
    timeoutMs: timeoutSec * 1000,
    maxOutputBytes: maxOutput,
  });
  const result = await handle.result;

  const stdoutText = redact(result.stdout.toString("utf8"));
  const stderrText = redact(result.stderr.toString("utf8"));

  if (result.status === "spawn_error") {
    entry.status = "error";
    entry.stderr = stderrText || result.launchError || "provider failed to launch";
    entry.stdout = stdoutText;
    return entry;
  }

  entry.duration_sec = Math.round((result.durationMs / 1000) * 1000) / 1000;
  entry.stdout_truncated = result.stdoutTruncated;
  entry.stderr_truncated = result.stderrTruncated;

  if (result.status === "timeout") {
    entry.status = "timeout";
    entry.exit_code = null;
    entry.stdout = stdoutText;
    entry.stderr = stderrText;
  } else {
    const exitCode = result.exitCode ?? -1;
    entry.exit_code = exitCode;
    entry.status = exitCode === 0 ? "ok" : "error";
    entry.stdout = stdoutText;
    entry.stderr = stderrText;
  }

  // Parse the (already masked) stdout for structured findings, like v2.
  const trimmed = entry.stdout.trim();
  if (trimmed.length > 0) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = null;
    }
    if (parsed !== null && typeof parsed === "object") {
      entry.output_format = "json";
      const { providerSeverity, findings } = parseProviderFindings(parsed);
      entry.provider_severity = providerSeverity;
      entry.findings = findings;
    } else {
      entry.output_format = "text";
    }
  }

  return entry;
}

function shellQuote(part: string): string {
  if (part !== "" && !/[^A-Za-z0-9_@%+=:,./-]/.test(part)) return part;
  return `'${part.replaceAll("'", "'\\''")}'`;
}
