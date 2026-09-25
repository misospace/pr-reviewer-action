/**
 * Read-only MCP tool client — the v3 port of `pr_reviewer/mcp_client.py`
 * (#245, #678).
 *
 * Security posture (hard requirements, unchanged):
 *  - **Allowlist only** — a server is used only if explicitly listed; no
 *    discovery.
 *  - **Read-only** — a tool is advertised only if its name begins with an
 *    allowlisted read verb; anything else (create/update/delete/…) is
 *    default-denied, both at advertise time and again at call time. A
 *    separator-mangled lookalike cannot widen this: routing resolves only
 *    against already-advertised (read-only-filtered) routes.
 *  - **Namespaced** — advertised as `mcp__<server>__<tool>` so MCP names can
 *    never shadow a built-in tool.
 *  - **Bounded / untrusted** — results are treated as untrusted corpus text
 *    by the caller (masked + capped like web_fetch).
 *
 * The HTTP transport is an injected callable (`postFn`) so the module is
 * unit-testable against a scripted MCP server with no network.
 */
import { USER_AGENT } from "../platform/user-agent.js";
import { pyDumps } from "../model/conversation.js";

export const MCP_PREFIX = "mcp__";
const PROTOCOL_VERSION = "2024-11-05";

/** A tool is relayed only when its name starts with one of these read verbs.
 * Default-deny: an unrecognised verb (create/update/delete/set/run/exec/…) is
 * never advertised or called, even if the server lists it. The second segment
 * matching a read verb does NOT qualify (`set_status` is denied). */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "list", "get", "read", "search", "fetch", "describe", "show", "find",
  "lookup", "query", "head", "stat", "summary", "diff", "status", "view",
]);

/** True if a tool name begins with an allowlisted read verb. If a prefix from
 * `prefixes` matches the (normalized) leading `workload_` segment, it is
 * stripped before the verb check. */
export function isReadOnlyTool(name: unknown, prefixes: readonly string[] = []): boolean {
  if (typeof name !== "string" || !name) return false;
  let normalized = name.trim().toLowerCase().replaceAll("-", "_");
  for (const prefix of prefixes) {
    const prefixN = prefix.trim().toLowerCase().replaceAll("-", "_").replace(/_+$/, "");
    if (prefixN && normalized.startsWith(prefixN + "_")) {
      normalized = normalized.slice(prefixN.length + 1);
      break;
    }
  }
  const head = normalized.split("_", 1)[0] ?? "";
  return READ_ONLY_VERBS.has(head);
}

export function namespacedName(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`;
}

/** `mcp__server__tool` → `[server, tool]`; null if not MCP-namespaced. */
export function splitNamespaced(name: string): [string, string] | null {
  if (!name.startsWith(MCP_PREFIX)) return null;
  const rest = name.slice(MCP_PREFIX.length);
  const sepIndex = rest.indexOf("__");
  if (sepIndex <= 0 || sepIndex + 2 >= rest.length) return null;
  return [rest.slice(0, sepIndex), rest.slice(sepIndex + 2)];
}

/**
 * Resolve a model-emitted MCP tool name to an advertised route (port of
 * `run_tool_harness.resolve_mcp_tool_name`). Exact matches pass through. A
 * name that only differs in separators — e.g. `mcp_konflate_get_pr_summary`
 * for the advertised `mcp__konflate__get_pr_summary` — resolves iff exactly
 * one advertised route collapses to the same form. Ambiguity or no match
 * returns null; only already-advertised (allowlisted, read-only-filtered)
 * routes are ever returned.
 */
export function resolveMcpToolName(toolName: string, routes: Iterable<string>): string | null {
  const routeList = [...routes];
  if (routeList.includes(toolName)) return toolName;
  const wanted = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const matches = routeList.filter((k) => k.toLowerCase().replace(/[^a-z0-9]/g, "") === wanted);
  return matches.length === 1 ? matches[0]! : null;
}

/** Only http(s) URLs with a host reach the transport. The URL is operator-set
 * (not model/PR-controlled), but validating the scheme is cheap
 * defence-in-depth against a misconfigured `tool_mcp_servers` value becoming
 * an SSRF/LFI vector. Percent-encoded sequences (%00, %2f, …) are valid URL
 * encoding and are left intact. */
export function isSafeServerUrl(url: string): boolean {
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

/** Parse `tool_mcp_servers` (newline/comma list of `name=url`). Entries that
 * are malformed or whose URL is not a host-bearing http(s) URL are silently
 * dropped. */
export function parseServerSpecs(raw: string): Array<[string, string]> {
  const specs: Array<[string, string]> = [];
  if (!raw) return specs;
  for (const item of raw.replaceAll("\n", ",").split(",")) {
    const text = item.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    if (eq < 0) continue;
    const name = text.slice(0, eq).trim();
    const url = text.slice(eq + 1).trim();
    if (name && url && isSafeServerUrl(url)) specs.push([name, url]);
  }
  return specs;
}

/** Extract the JSON-RPC object from a plain or SSE-framed body (port of
 * `_parse_jsonrpc`): SSE framing pulls the last `data:` line. */
export function parseJsonRpc(body: string): unknown {
  let text = body.trim();
  if (!text) return null;
  if (text.includes("data:") && !text.startsWith("{")) {
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line.startsWith("data:")) {
        text = line.slice("data:".length).trim();
        break;
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type McpPostResult = { result: unknown; sessionId: string | null; error: string | null };
export type McpPostFn = (
  url: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
  token: string,
  timeoutSec: number,
) => Promise<McpPostResult>;

const jsonRpcErrorReason = (status: number): string => {
  const reasons: Record<number, string> = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable",
  };
  return reasons[status] ?? "Error";
};

/** Default transport: POST one JSON-RPC message; return
 * (result-or-null, session_id, error). Handles a plain `application/json`
 * body or an SSE (`text/event-stream`) framing — MCP streamable-HTTP may use
 * either. The session id is read from the `Mcp-Session-Id` response header
 * (set on initialize). */
export const defaultMcpPost: McpPostFn = async (url, payload, sessionId, token, timeoutSec) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": USER_AGENT,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const newSession = response.headers.get("Mcp-Session-Id") ?? sessionId;
    if (response.status >= 400) {
      return { result: null, sessionId: newSession, error: `HTTP Error ${response.status}: ${jsonRpcErrorReason(response.status)}` };
    }
    const body = await response.text();
    return { result: parseJsonRpc(body), sessionId: newSession, error: null };
  } catch (exc) {
    return { result: null, sessionId, error: exc instanceof Error ? exc.message : String(exc) };
  } finally {
    clearTimeout(timer);
  }
};

export interface McpSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** An initialized connection to one allowlisted MCP server. */
export class McpToolset {
  server: string;
  url: string;
  token: string;
  timeoutSec: number;
  schemas: McpSchema[] = [];
  private readonly namePrefixes: readonly string[];
  private readonly post: McpPostFn;
  private sessionId: string | null = null;
  private toolNames = new Set<string>();

  constructor(
    server: string,
    url: string,
    token = "",
    options: { timeoutSec?: number; postFn?: McpPostFn; namePrefixes?: readonly string[] } = {},
  ) {
    this.server = server;
    this.url = url;
    this.token = token;
    this.timeoutSec = options.timeoutSec ?? 20;
    this.namePrefixes = options.namePrefixes ?? [];
    this.post = options.postFn ?? defaultMcpPost;
  }

  private async rpc(method: string, params?: Record<string, unknown>, msgId?: number): Promise<{ result: unknown; error: string | null }> {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (msgId !== undefined) payload.id = msgId;
    if (params !== undefined) payload.params = params;
    const posted = await this.post(this.url, payload, this.sessionId, this.token, this.timeoutSec);
    this.sessionId = posted.sessionId;
    return { result: posted.result, error: posted.error };
  }

  /** initialize → tools/list → build namespaced read-only schemas.
   * Returns null on success, or an error string (the server is then skipped). */
  async connect(): Promise<string | null> {
    const { result: init, error: initError } = await this.rpc(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "ai-pr-reviewer", version: "1.0" },
      },
      1,
    );
    if (initError || init === null || typeof init !== "object" || !("result" in init)) {
      return `initialize failed: ${initError ?? "no result"}`;
    }
    // Best-effort initialized notification (no id, no response expected).
    await this.rpc("notifications/initialized");

    const { result: listed, error: listError } = await this.rpc("tools/list", {}, 2);
    if (listError || listed === null || typeof listed !== "object") {
      return `tools/list failed: ${listError ?? "no result"}`;
    }
    const tools = (listed as Record<string, unknown>).result;
    const toolsArray =
      tools !== null && typeof tools === "object" ? (tools as Record<string, unknown>).tools : undefined;
    if (!Array.isArray(toolsArray)) {
      return "tools/list returned no tools array";
    }

    for (const raw of toolsArray) {
      if (raw === null || typeof raw !== "object") continue;
      const tool = raw as Record<string, unknown>;
      const name = tool.name;
      if (typeof name !== "string" || !isReadOnlyTool(name, this.namePrefixes)) {
        continue; // default-deny non-read-verb tools
      }
      const schema = tool.inputSchema;
      const parameters =
        schema !== null && typeof schema === "object"
          ? (schema as Record<string, unknown>)
          : { type: "object", properties: {}, additionalProperties: true };
      this.toolNames.add(name);
      this.schemas.push({
        name: namespacedName(this.server, name),
        description: `[MCP:${this.server}] ${typeof tool.description === "string" && tool.description ? tool.description : name} (read-only external evidence)`,
        parameters,
      });
    }
    return null;
  }

  /** Call a relayed read-only tool; returns the executor result shape.
   * Re-checks the read-only allowlist at call time (defence in depth) and
   * refuses any tool not surfaced by connect(). */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.toolNames.has(tool) || !isReadOnlyTool(tool, this.namePrefixes)) {
      return { error: `MCP tool not allowed: ${tool}` };
    }
    const { result, error } = await this.rpc("tools/call", { name: tool, arguments: args ?? {} }, 3);
    if (error) return { error: `MCP call failed: ${error}` };
    if (result === null || typeof result !== "object" || !("result" in result)) {
      const rpcErr =
        result !== null && typeof result === "object" ? (result as Record<string, unknown>).error : null;
      return { error: `MCP error: ${rpcErr ? JSON.stringify(rpcErr) : "no result"}` };
    }
    return { content: renderContent((result as Record<string, unknown>).result) };
  }
}

/** Flatten an MCP tools/call result into plain text for the corpus. */
export function renderContent(result: unknown): string {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const blocks = (result as Record<string, unknown>).content;
    if (Array.isArray(blocks)) {
      const parts: string[] = [];
      for (const block of blocks) {
        if (block !== null && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
          parts.push((block as Record<string, unknown>).text as string);
        }
      }
      if (parts.length > 0) return parts.join("\n");
    }
  }
  return pyDumps(result);
}
