/** Fixture CLI for the `specialists-gate` parity boundary (#706 PR 6):
 * `node dist/index.js specialists-gate-fixture <fixture.json>`.
 *
 * Runs the REAL v3 specialists gate workload (`runSpecialistsGate`, with the
 * real v3 model transport) in a scratch workspace against a local mock model
 * endpoint that serves the fixture's canned responses per role (the role is
 * identified from the system prompt it was sent). No real model is ever
 * called. The v2 runner (`tests/parity_runners/v2_specialists_gate.py`) runs
 * `scripts/run_specialists.py` (real curl transport) against its own mock
 * endpoint serving the same fixture, and both sides print `{ok, values}`:
 *
 * - `file:<name>`: every specialist artifact byte for byte, with only the
 *   wall-clock `elapsed_sec` values and the mock endpoint's port normalized;
 * - `requests`: per role, the canonical JSON bodies the endpoint received
 *   and whether a credential header arrived;
 * - `exit_code`, `stdout`, `stderr` (same normalization). */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPECIALIST_ROLES_ORDER } from "../specialists/types.js";
import { loadSpecialistPrompt } from "../specialists/prompts.js";
import { runSpecialistsGate } from "./specialists-gate.js";

interface MockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  raw?: string;
  sse?: string[];
}

interface SpecialistsFixture {
  env?: Record<string, string>;
  corpus?: string | null;
  adversarial_corpus?: string | null;
  classification?: unknown;
  args?: string[];
  responses?: Record<string, MockResponse[]>;
}

const SCOUT_PREFIX = "You are performing three specialist review passes";

export function normalizeSpecialistText(text: string): string {
  return text
    // Only a float (the contract's round(x, 3)) is a wall-clock value; an
    // integer field of the same name (e.g. in a provider body) is compared.
    .replace(/("(?:aggregate_)?elapsed_sec": )-?[0-9]+\.[0-9]+/g, '$1"<ELAPSED>"')
    .replace(/error\(s\), [0-9][0-9.e+-]*s/g, "error(s), <ELAPSED>s")
    .replace(/roles in [0-9][0-9.e+-]*s/g, "roles in <ELAPSED>s")
    .replace(/127\.0\.0\.1:[0-9]+/g, "127.0.0.1:<PORT>");
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function identifyRole(payload: Record<string, unknown>, prompts: Record<string, string>): string {
  let system = "";
  if (typeof payload.system === "string") system = payload.system;
  else if (Array.isArray(payload.messages)) {
    const first = payload.messages[0] as Record<string, unknown> | undefined;
    if (first && typeof first.content === "string") system = first.content;
  }
  if (system.startsWith(SCOUT_PREFIX)) return "scout";
  for (const [name, text] of Object.entries(prompts)) {
    if (system === text) return name.replace(/_adversarial$/, "");
  }
  return "unknown";
}

export async function runSpecialistsGateFixture(fixturePath: string): Promise<{ ok: boolean; values: Record<string, string> }> {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as SpecialistsFixture;
  const prompts: Record<string, string> = {};
  for (const role of SPECIALIST_ROLES_ORDER) {
    prompts[role] = loadSpecialistPrompt(role);
  }
  prompts.correctness_adversarial = loadSpecialistPrompt("correctness", "adversarial");

  const received: Record<string, { body: string; auth: boolean }[]> = {};
  const cursors: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const role = identifyRole(payload, prompts);
      (received[role] ??= []).push({ body: sortedJson(payload), auth: Boolean(req.headers.authorization || req.headers["x-api-key"]) });
      const sequence = fixture.responses?.[role] ?? [];
      const index = cursors[role] ?? 0;
      cursors[role] = index + 1;
      const entry = sequence[Math.min(index, sequence.length - 1)];
      if (entry === undefined) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `no mock response for ${role}` } }));
        return;
      }
      if (entry.sse !== undefined) {
        res.writeHead(entry.status ?? 200, { ...(entry.headers ?? {}), "Content-Type": "text/event-stream" });
        res.end(entry.sse.map((line) => `${line}\n\n`).join(""));
        return;
      }
      res.writeHead(entry.status ?? 200, { ...(entry.headers ?? {}), "Content-Type": "application/json" });
      res.end(entry.raw !== undefined ? entry.raw : JSON.stringify(entry.body ?? null));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  const workspace = mkdtempSync(join(tmpdir(), "specialists-gate-fixture-"));
  try {
    if (typeof fixture.corpus === "string") writeFileSync(join(workspace, "specialist-corpus.md"), fixture.corpus);
    const args = [...(fixture.args ?? [])];
    if (typeof fixture.adversarial_corpus === "string") {
      writeFileSync(join(workspace, "specialist-corpus-adversarial.md"), fixture.adversarial_corpus);
      args.push("--adversarial-corpus", "specialist-corpus-adversarial.md");
    }
    if (fixture.classification !== undefined) {
      writeFileSync(join(workspace, "classification.json"), JSON.stringify(fixture.classification));
    }
    const env: Record<string, string> = {
      AI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      AI_API_KEY: "fixture-api-key",
      AI_MODEL: "fixture-model",
      GITHUB_WORKSPACE: workspace,
      ...(fixture.env ?? {}),
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runSpecialistsGate({
      env,
      argv: ["--corpus", "specialist-corpus.md", ...args],
      cwd: workspace,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    const values: Record<string, string> = {
      exit_code: String(exitCode),
      stdout: normalizeSpecialistText(stdout.join("\n")),
      stderr: normalizeSpecialistText(stderr.join("\n")),
      requests: JSON.stringify(Object.fromEntries(Object.keys(received).sort().map((role) => [role, received[role]]))),
    };
    for (const name of readdirSync(workspace).sort()) {
      if (!name.startsWith("specialist")) continue;
      if (name === "specialist-corpus.md" || name === "specialist-corpus-adversarial.md") continue;
      values[`file:${name}`] = normalizeSpecialistText(readFileSync(join(workspace, name), "utf8"));
    }
    return { ok: true, values };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
