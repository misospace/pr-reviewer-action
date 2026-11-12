import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  MAX_EVIDENCE_CHECKS,
  MAX_EVIDENCE_FIELD_LENGTH,
  MAX_EVIDENCE_RAW_JSON_CHARS,
  isTestExecutionCheckName,
  parseHeadBoundCiEvidence,
} from "../enforcement/required-check-ci.js";
import { ciAttemptTimeoutMs } from "../platform/bounded.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import { forgejoTokenFromEnv } from "../platform/forgejo-auth.js";
import { GitHubAdapter } from "../platform/github.js";
import { jqCompact } from "../platform/jq.js";
import { forgejoSelfRunOrigin, type ExternalCheck } from "../platform/normalize.js";
import { resolvePlatform } from "../platform/resolve.js";
import { requireImplementedBackend } from "../platform/tangled.js";
import type { ExternalChecksOptions, PlatformReadAdapter } from "../platform/types.js";

/**
 * CI gate workload (#706 PR 6): the v3 port of `scripts/wait_for_ci.sh`,
 * launched as `node dist/index.js gate-ci` by `runConcurrentGates` under the
 * `CI_GATE_ENV_KEYS` allowlist.
 *
 * Polls `PlatformReadAdapter.externalChecks` until every external check is
 * final, a failure is seen, or the timeout expires. The loop is a pure
 * reducer over the normalized `[{name, state}]` list: any failure → failure;
 * any pending → wait; empty → no external CI (after two intervals); all
 * success → success. Kept from v2 verbatim:
 *
 * - one absolute deadline (`CI_TIMEOUT_SEC` from the start) shared by the
 *   head-SHA lookup and every bounded API attempt; the deadline-aware sleep
 *   never sleeps past it;
 * - the head SHA is resolved once (`PR_HEAD_SHA`, else the PR lookup) and
 *   pinned for the whole wait — a head that moves mid-wait does not re-target
 *   the poll (the publish-boundary exact-head guard owns that case);
 * - exit codes 0 (terminal: success/failure/none, or gate disabled/skipped),
 *   1 (timeout with `CI_SKIP_ON_TIMEOUT=true`), 2 (fatal, or timeout without
 *   skip); the `ci_status_*` outputs; the atomic `ci-checks-context.md`
 *   evidence file and its temp-file cleanup on TERM/INT.
 *
 * #1594 adds one v3-only output: on a FINALIZED wait (never on timeout or
 * skip) the gate also writes a `ci_checks_evidence=` line — the compact-JSON,
 * head-bound check list the enforcement pass reconciles required-check
 * completion against (`src/enforcement/required-check-ci.ts`). It stays out
 * of the published action outputs (the `ciGateOutputs` whitelist does not
 * name it) and re-presents only data this gate already read.
 *
 * One deliberate divergence from v2 (covered by the retained node:test
 * regression): reads use `transientAsUnknown`, so a transient read failure is
 * "unknown, retry" rather than the v2 fold to `[]`, which let
 * the wait finalize "none" (or a partial list) while CI was still running.
 */

export const CI_EVIDENCE_TIMEOUT_STATE = "timeout (CI did not finish in time)";

export type CiEnv = Readonly<Record<string, string | undefined>>;

export interface CiWaitDeps {
  env: CiEnv;
  /** Builds the platform adapter; defaults to `ciAdapterFromEnv`. */
  adapterFactory?: (env: CiEnv, repo: string, prNumber: string, token: string) => PlatformReadAdapter;
  /** Epoch milliseconds. */
  now?: () => number;
  sleep?: (seconds: number) => Promise<void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** `date +'%H:%M:%S'` for the log prefix. */
  formatClock?: (epochMs: number) => string;
  /** Suffix for the evidence temp file (`$$` in v2). */
  pid?: number;
  /** Receives the in-flight evidence temp path (null once published or
   * removed) so a signal handler can clean it up. */
  onTmpChange?: (path: string | null) => void;
}

function env(deps: CiWaitDeps, key: string): string {
  return deps.env[key] ?? "";
}

/** bash `${VAR:-default}`. */
function envOr(deps: CiWaitDeps, key: string, fallback: string): string {
  const value = env(deps, key);
  return value === "" ? fallback : value;
}

function intOr(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  return /^-?[0-9]+$/.test(trimmed) ? Number(trimmed) : fallback;
}

function localClock(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Adapter for the CI child: PLATFORM/FORGEJO_API_URL/GITHUB_SERVER_URL
 * select the backend exactly like `platform_resolve`; GitHub uses
 * `GITHUB_API_URL` when the runner provides one. */
export function ciAdapterFromEnv(ciEnv: CiEnv, repo: string, prNumber: string, token: string): PlatformReadAdapter {
  const platform = resolvePlatform(ciEnv.PLATFORM, ciEnv.FORGEJO_API_URL ?? "", ciEnv.GITHUB_SERVER_URL ?? "", ciEnv.TANGLED_REPO_DID ?? "");
  requireImplementedBackend(platform);
  if (platform === "forgejo") {
    const forgejoToken = forgejoTokenFromEnv(ciEnv);
    return new ForgejoAdapter({
      repo,
      prNumber,
      baseUrl: ciEnv.FORGEJO_API_URL ?? "",
      token: forgejoToken,
      authMethod: (ciEnv.FORGEJO_AUTH_METHOD ?? "").trim().toLowerCase() || undefined,
      authorizedIntegrationAudience: (ciEnv.FORGEJO_AUTHORIZED_INTEGRATION_AUDIENCE ?? "").trim() || undefined,
    });
  }
  return new GitHubAdapter({
    repo,
    prNumber,
    token: `Bearer ${token}`,
    baseUrl: ciEnv.GITHUB_API_URL || undefined,
  });
}

/** Control characters, C1 controls, and the Unicode line/paragraph
 * separators: any of them could end the table row. */
const CELL_BREAK_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** One Markdown table cell from untrusted check data (check names are
 * chosen by whoever configures CI). v2 interpolated them raw (jq
 * `"| \(.name) | \(.state) |"`), so a name carrying `|` or a newline could
 * split the row or forge a heading in the review corpus; this is a deliberate
 * `ci-gate` divergence. Non-strings render as compact JSON first, as jq
 * does. Then control runs collapse to one space, `\` / `|` / backticks are
 * backslash-escaped (backslash first, so `\|` cannot un-escape a pipe), and
 * `&` `<` `>` become entities so no HTML survives. */
export function escapeTableCell(value: unknown): string {
  const text = typeof value === "string" ? value : jqCompact(value);
  return text
    .replace(CELL_BREAK_RE, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderRows(checks: readonly ExternalCheck[]): string {
  return checks.map((check) => `| ${escapeTableCell(check.name)} | ${escapeTableCell(check.conclusion ?? check.state)} |`).join("\n");
}

/** Collapse control runs and truncate to the parser's UTF-16 field bound
 * without splitting a surrogate pair (`Array.from` truncates by code point,
 * the parser counts UTF-16 units — an emoji-heavy name must still fit). */
function boundedEvidenceField(value: string): string {
  const collapsed = value.replace(CELL_BREAK_RE, " ").trim();
  let bounded = "";
  for (const codePoint of collapsed) {
    if (bounded.length + codePoint.length > MAX_EVIDENCE_FIELD_LENGTH) break;
    bounded += codePoint;
  }
  return bounded;
}

interface EvidenceRow {
  name: string;
  state: string;
  conclusion?: string;
}

/** #1594: the head-bound check-evidence gate output — the compact-JSON
 * artifact the enforcement pass reconciles required-check completion against
 * (src/enforcement/required-check-ci.ts). Written ONLY on a finalized wait
 * (never on timeout or skip), so a mid-wait or skipped gate produces no
 * evidence. Check names and conclusions remain untrusted DATA: control runs
 * collapse, both are bounded to the parser's 200-UTF-16-unit field limit,
 * invalid states and empty values are dropped, and a malformed SHA yields no
 * line at all.
 *
 * The producer obeys the consumer's limits without ever dropping decision
 * evidence. Test-execution rows (the ones the consumer can discharge or
 * contradict from) are retained in full; non-test rows are context and may
 * be trimmed to fit 50 rows / 16,384 characters. If the complete test-row
 * set itself cannot fit, NO evidence line is emitted: an artifact missing a
 * skipped/pending test leg could otherwise look falsely complete and
 * discharge a full-suite ask. When trimming non-test rows, failed rows are
 * kept first. The final strict parser round-trip is a self-check: if it ever
 * refuses the line, emit nothing rather than an unusable artifact. The line
 * is NOT in the `ciGateOutputs` action-output whitelist, so it never reaches
 * published action outputs. */
export function renderCiEvidenceOutput(sha: string, finalState: string, checks: readonly ExternalCheck[]): string {
  try {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) return "";
    if (finalState !== "success" && finalState !== "failure" && finalState !== "none") return "";
    const rows: EvidenceRow[] = [];
    for (const check of checks) {
      if (typeof check.name !== "string") continue;
      if (check.state !== "pending" && check.state !== "success" && check.state !== "failure") continue;
      const name = boundedEvidenceField(check.name);
      if (name === "") continue;
      const conclusion = typeof check.conclusion === "string" ? boundedEvidenceField(check.conclusion) : "";
      rows.push({
        name,
        state: check.state,
        ...(conclusion === "" ? {} : { conclusion }),
      });
    }
    if (rows.length === 0) return "";
    const serialize = (candidate: readonly EvidenceRow[]): string =>
      jqCompact({ version: 1, head_sha: sha, final_state: finalState, checks: candidate });
    const emit = (json: string): string => {
      if (json.length > MAX_EVIDENCE_RAW_JSON_CHARS) return "";
      // Same parser the enforcement pass uses; a refused line is no evidence.
      if (parseHeadBoundCiEvidence(json) === null) return "";
      return `ci_checks_evidence=${json}`;
    };
    // Fast path: no truncation needed, preserve the original row order.
    if (rows.length <= MAX_EVIDENCE_CHECKS) {
      const json = serialize(rows);
      if (json.length <= MAX_EVIDENCE_RAW_JSON_CHARS) return emit(json);
    }
    // Lossy truncation is allowed ONLY for rows the consumer ignores. Test-
    // execution rows are the decision evidence: retain every one or emit
    // nothing at all. A failure-first order keeps red rows visible when
    // non-test context is trimmed.
    const byFailureFirst = (list: readonly EvidenceRow[]): EvidenceRow[] => [
      ...list.filter((row) => row.state === "failure"),
      ...list.filter((row) => row.state !== "failure"),
    ];
    const testRows = byFailureFirst(rows.filter((row) => isTestExecutionCheckName(row.name)));
    if (testRows.length > MAX_EVIDENCE_CHECKS) return "";
    const otherRows = byFailureFirst(rows.filter((row) => !isTestExecutionCheckName(row.name)));
    let retained = [...testRows];
    let json = serialize(retained);
    if (json.length > MAX_EVIDENCE_RAW_JSON_CHARS) return "";
    for (const row of otherRows) {
      if (retained.length >= MAX_EVIDENCE_CHECKS) break;
      const next = [...retained, row];
      const nextJson = serialize(next);
      if (nextJson.length > MAX_EVIDENCE_RAW_JSON_CHARS) break;
      retained = next;
      json = nextJson;
    }
    if (retained.length === 0) return "";
    return emit(json);
  } catch {
    return "";
  }
}

class Finished {
  constructor(readonly code: number) {}
}

export async function runCiWait(deps: CiWaitDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const clock = deps.formatClock ?? localClock;
  const nowSec = (): number => Math.floor(now() / 1000);

  const token = env(deps, "GH_TOKEN") || env(deps, "GITHUB_TOKEN");
  const repo = env(deps, "REPO") || env(deps, "GITHUB_REPOSITORY");
  const prNumber = env(deps, "PR_NUMBER");
  const headShaHint = env(deps, "PR_HEAD_SHA");
  const runId = env(deps, "GITHUB_RUN_ID");
  const explicitStatusContext = env(deps, "CI_STATUS_CONTEXT");
  const statusCheck = envOr(deps, "CI_STATUS_CHECK", "false");
  const timeoutRaw = envOr(deps, "CI_TIMEOUT_SEC", "300");
  const timeoutSec = intOr(timeoutRaw, 300);
  const intervalRaw = envOr(deps, "CI_INTERVAL_SEC", "15");
  const intervalSec = intOr(intervalRaw, 15);
  const skipOnTimeout = envOr(deps, "CI_SKIP_ON_TIMEOUT", "true");
  const outputFile = envOr(deps, "GITHUB_OUTPUT", "/dev/null");
  const checksFile = env(deps, "CI_CHECKS_FILE");

  const output = (line: string): void => {
    appendFileSync(outputFile, `${line}\n`);
  };
  const log = (message: string): void => stdout(`[CI-status] ${clock(now())} ${message}`);
  const error = (message: string): void => stderr(`[CI-status] ${clock(now())} ERROR: ${message}`);

  if (statusCheck !== "true") {
    output("ci_status_skipped=true");
    return 0;
  }
  if (token === "" || repo === "" || prNumber === "") {
    stderr("Missing GH_TOKEN, REPO, or PR_NUMBER for CI status check");
    output("ci_status_skipped=true");
    return 0;
  }

  const factory = deps.adapterFactory ?? ciAdapterFromEnv;
  let adapter: PlatformReadAdapter;
  try {
    adapter = factory(deps.env, repo, prNumber, token);
  } catch (cause) {
    error(`CI status platform unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 2;
  }
  const autoSelfStatus = adapter.platform === "forgejo" && explicitStatusContext.trim() === "";
  const selfRunNumbers = autoSelfStatus
    ? [...new Set(["FORGEJO_RUN_NUMBER", "GITHUB_RUN_NUMBER"]
      .map((key) => env(deps, key).trim()).filter((value) => /^\d+$/.test(value)))]
    : undefined;
  const selfRunId = autoSelfStatus
    ? [deps.env.FORGEJO_RUN_ID, deps.env.GITHUB_RUN_ID]
      .map((value) => value?.trim() ?? "").find((value) => /^\d+$/.test(value)) ?? ""
    : "";
  const selfRunRepo = autoSelfStatus ? env(deps, "FORGEJO_REPOSITORY") || env(deps, "GITHUB_REPOSITORY") : undefined;
  const selfRunOrigin = autoSelfStatus
    ? forgejoSelfRunOrigin(env(deps, "FORGEJO_API_URL"), env(deps, "GITHUB_SERVER_URL"))
    : undefined;
  const statusContext = explicitStatusContext !== ""
    ? explicitStatusContext
    : adapter.platform === "github" ? "pr-reviewer-action" : "";
  const selfStatusDiscovery = autoSelfStatus
    ? {
        found: false, ambiguous: false, matchCount: 0, context: null as string | null,
        runJobs: "unknown" as "unknown" | "single" | "multi" | "unavailable", runJobCount: null as number | null,
        runJobCountExact: false, runJobHtmlUrl: null as string | null, runJobsUnavailableReason: null as string | null,
      }
    : undefined;

  // One absolute outer deadline, established BEFORE the head-SHA lookup so
  // that request draws from the same budget as the poll loop.
  const startedAt = nowSec();
  const deadline = startedAt + timeoutSec;
  const bounds: ExternalChecksOptions = {
    runId,
    statusContext,
    githubWorkflow: env(deps, "GITHUB_WORKFLOW"),
    githubJob: env(deps, "GITHUB_JOB"),
    ...(selfRunNumbers === undefined ? {} : { selfRunNumbers, selfRunId, selfRunRepo, selfRunOrigin, selfStatusDiscovery }),
    apiTimeoutSec: env(deps, "CI_API_TIMEOUT_SEC"),
    ciTimeoutSec: timeoutRaw,
    deadlineEpoch: String(deadline),
    now,
    transientAsUnknown: true,
  };

  let sha = headShaHint;
  if (sha === "") sha = await boundedHeadSha(adapter, bounds);
  if (sha === "") {
    error(`Could not resolve head SHA for #${prNumber}`);
    return 2;
  }

  let checks: ExternalCheck[] | null = null;
  let elapsed = 0;
  let selfStatusDiscovered = false;
  let selfStatusDiscoveryLogged = false;
  let selfStatusAmbiguityLogged = false;
  let selfStatusMultiJobLogged = false;
  let selfStatusUnavailableLogged = false;

  const renderEvidence = (finalState: string): void => {
    if (checksFile === "") return;
    const rows = renderRows(checks ?? []);
    if (rows === "") return;
    // CodeQL js/http-to-file-access: writing the CI evidence file is the
    // sanctioned pipeline by design — this artifact's whole purpose is to
    // carry forge-API check results into the review corpus as UNTRUSTED
    // DATA. The untrusted-data boundary holds downstream: every table cell
    // is escaped (escapeTableCell) and the corpus renderer fences the
    // section, so the network content can never forge instructions.
    const tmp = `${checksFile}.tmp.${deps.pid ?? process.pid}`;
    deps.onTmpChange?.(tmp);
    const body =
      `_Other checks on commit ${sha} (${finalState}): shown for context only — these checks gate the merge on their own. A check conclusion is not by itself a review finding; do not raise blockers or majors whose only basis is a row below._\n` +
      "\n| Check | State |\n| --- | --- |\n" +
      `${rows}\n`;
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, checksFile);
    } catch {
      rmSync(tmp, { force: true });
    }
    deps.onTmpChange?.(null);
  };

  const finalize = (state: string): never => {
    renderEvidence(state);
    const evidenceLine = renderCiEvidenceOutput(sha, state, checks ?? []);
    if (evidenceLine !== "") output(evidenceLine);
    output(`ci_status_final=${state}`);
    output("ci_status_skipped=false");
    throw new Finished(0);
  };

  // Deadline-aware poll sleep: never past the outer deadline.
  const deadlineSleep = async (): Promise<void> => {
    const remaining = deadline - nowSec();
    if (remaining < 1) return;
    if (remaining < intervalSec) {
      await sleep(remaining);
      elapsed += remaining;
    } else {
      await sleep(intervalSec);
      elapsed += intervalSec;
    }
  };

  log(`Polling CI checks for ${sha} (timeout=${timeoutRaw}s, interval=${intervalRaw}s, own run=${runId === "" ? "none" : runId})...`);

  try {
    for (;;) {
      if (elapsed >= timeoutSec || nowSec() >= deadline) {
        log(`Timeout reached after ${nowSec() - startedAt}s`);
        if (autoSelfStatus && selfStatusDiscovery && !selfStatusDiscovered && !selfStatusAmbiguityLogged
          && !selfStatusUnavailableLogged) {
          log("Warning: could not identify this run's own Forgejo status; it may have blocked the CI gate (set CI_STATUS_CONTEXT to disambiguate)");
        }
        if (skipOnTimeout.toLowerCase() === "true") {
          log("ci_skip_on_timeout=true — proceeding without CI context");
          renderEvidence(CI_EVIDENCE_TIMEOUT_STATE);
          output("ci_status_skipped=true");
          return 1;
        }
        error("Timeout reached and ci_skip_on_timeout=false — aborting review");
        output("ci_status_skipped=true");
        return 2;
      }

      const attemptStart = nowSec();
      checks = await adapter.externalChecks(sha, bounds);
      elapsed += nowSec() - attemptStart;
      if (selfStatusDiscovery?.found) {
        selfStatusDiscovered = true;
        if (!selfStatusDiscoveryLogged) {
          if (selfStatusDiscovery.context !== null) {
            const context = selfStatusDiscovery.context.replace(CELL_BREAK_RE, " ").slice(0, 200);
            log(`CI self status excluded by run match (context: ${context})`);
          } else {
            log("CI self status excluded by run match (context: unknown)");
          }
          selfStatusDiscoveryLogged = true;
        }
      }
      if (selfStatusDiscovery?.runJobs === "unavailable" && !selfStatusUnavailableLogged
        && selfStatusDiscovery.matchCount === 1 && selfStatusDiscovery.runJobsUnavailableReason !== null) {
        const reason = selfStatusDiscovery.runJobsUnavailableReason.replace(CELL_BREAK_RE, " ").slice(0, 160);
        log(`Warning: Forgejo run-jobs API unavailable (${reason}); cannot auto-exclude this run's own status — set CI_STATUS_CONTEXT to disambiguate`);
        selfStatusUnavailableLogged = true;
      }
      if (selfStatusDiscovery?.ambiguous && !selfStatusAmbiguityLogged) {
        log(`Warning: ${selfStatusDiscovery.matchCount} statuses matched this run's Forgejo run number; excluding none to avoid hiding sibling CI (set CI_STATUS_CONTEXT to disambiguate)`);
        selfStatusAmbiguityLogged = true;
      }
      if (selfStatusDiscovery?.runJobs === "multi" && !selfStatusMultiJobLogged) {
        const count = selfStatusDiscovery.runJobCount;
        const renderedCount = count === null ? "at least one" : String(count);
        log(`Warning: this Forgejo workflow run has ${renderedCount} jobs; auto-discovery only supports single-job runs, set CI_STATUS_CONTEXT to disambiguate`);
        selfStatusMultiJobLogged = true;
      }

      if (checks === null) {
        // Under transientAsUnknown every null is a transient read failure
        // (v2 logged "API returned empty" for its both-reads-empty case).
        log("CI status read failed transiently (unknown, not 'no CI'); backing off before retrying (clamped to the outer deadline)...");
        await deadlineSleep();
        continue;
      }

      const total = checks.length;
      const pending = checks.filter((check) => check.state === "pending").length;
      const failed = checks.filter((check) => check.state === "failure").length;

      if (failed > 0) {
        log(`Detected ${failed} failed check(s) — treating as failure`);
        finalize("failure");
      }

      if (total === 0) {
        if (elapsed >= intervalSec * 2) {
          log(`No external CI checks found after ${elapsed}s — proceeding without CI gating`);
          finalize("none");
        }
        log("No external CI checks registered yet — waiting (clamped to the outer deadline)...");
        await deadlineSleep();
        continue;
      }

      if (pending === 0) {
        log(`CI checks finalized: success (${total} external check(s))`);
        finalize("success");
      } else {
        log(`Pending: ${pending}/${total} external check(s) — waiting (clamped to the outer deadline)...`);
      }
      await deadlineSleep();
    }
  } catch (caught) {
    if (caught instanceof Finished) return caught.code;
    throw caught;
  }
}

/** `platform_pr_head_sha` under the CI deadline (#663): the lookup is one
 * bounded attempt; an exhausted budget or a failed read yields "". */
async function boundedHeadSha(adapter: PlatformReadAdapter, bounds: ExternalChecksOptions): Promise<string> {
  const timeoutMs = ciAttemptTimeoutMs(bounds);
  if (timeoutMs === null) return "";
  let timer: NodeJS.Timeout | undefined;
  // `undefined` = CI_API_TIMEOUT_SEC=0 with no outer budget: unbounded, so
  // only the adapter's own request timeout applies.
  const expired = new Promise<null>((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const pr = await Promise.race([adapter.getPr().catch(() => null), expired]);
    const head = typeof pr === "object" && pr !== null ? (pr as Record<string, unknown>).head : null;
    const sha = typeof head === "object" && head !== null ? (head as Record<string, unknown>).sha : null;
    return typeof sha === "string" ? sha : "";
  } finally {
    clearTimeout(timer);
  }
}
