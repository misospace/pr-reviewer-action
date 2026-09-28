import { appendFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { ciAttemptTimeoutMs } from "../platform/bounded.js";
import { ForgejoAdapter } from "../platform/forgejo.js";
import { GitHubAdapter } from "../platform/github.js";
import { jqCompact } from "../platform/jq.js";
import type { ExternalCheck } from "../platform/normalize.js";
import { resolvePlatform } from "../platform/resolve.js";
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
 * One approved divergence (tests/fixtures/parity/approved-divergences.json,
 * boundary `ci-gate`): reads use `transientAsUnknown`, so a transient read
 * failure is "unknown, retry" rather than the v2 fold to `[]`, which let
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
  const platform = resolvePlatform(ciEnv.PLATFORM, ciEnv.FORGEJO_API_URL ?? "", ciEnv.GITHUB_SERVER_URL ?? "");
  if (platform === "forgejo") {
    const forgejoToken = ciEnv.FORGEJO_TOKEN || ciEnv.GITHUB_TOKEN || ciEnv.GH_TOKEN || "";
    return new ForgejoAdapter({
      repo,
      prNumber,
      baseUrl: ciEnv.FORGEJO_API_URL ?? "",
      token: forgejoToken === "" ? undefined : forgejoToken,
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
 * split the row or forge a heading in the review corpus; this is an approved
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
  return checks.map((check) => `| ${escapeTableCell(check.name)} | ${escapeTableCell(check.state)} |`).join("\n");
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
  const statusContext = envOr(deps, "CI_STATUS_CONTEXT", "pr-reviewer-action");
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

  // One absolute outer deadline, established BEFORE the head-SHA lookup so
  // that request draws from the same budget as the poll loop.
  const startedAt = nowSec();
  const deadline = startedAt + timeoutSec;
  const bounds: ExternalChecksOptions = {
    runId,
    statusContext,
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

  const renderEvidence = (finalState: string): void => {
    if (checksFile === "") return;
    const rows = renderRows(checks ?? []);
    if (rows === "") return;
    const tmp = `${checksFile}.tmp.${deps.pid ?? process.pid}`;
    deps.onTmpChange?.(tmp);
    const body =
      `_CI reached a terminal state before this review began (overall: ${finalState}). These results are from the CI status API for commit ${sha} and are authoritative evidence of which checks ran and how they concluded._\n` +
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
