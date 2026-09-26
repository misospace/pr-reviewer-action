/**
 * Read-only tool executors — the v3 port of `pr_reviewer/tool_executors.py`
 * plus the platform guards it imports from `pr_reviewer/platform.py` (#678).
 *
 * Security policy is default-deny and fails closed:
 *  - every filesystem path is resolved through `resolveWorkspacePath`
 *    (null-byte reject, symlink-collapsing realpath, containment, sensitive
 *    names, GH deny substrings) before any access;
 *  - `runCommand` executes ONLY the fixed argv catalog — the model supplies a
 *    catalog name, never shell text, and no shell is ever involved;
 *  - `ghApi`/`repoContents` enforce the endpoint allowlist (repo-key,
 *    root-prefix, dot-segment, deny-substring) before any request;
 *  - `webFetch` allows only http(s) on exactly-allowlisted hosts and
 *    re-validates every redirect hop;
 *  - `webSearch` sends only the query to the operator-configured endpoint and
 *    strips non-http(s) result URLs;
 *  - every result passes secret redaction + byte caps (`maskAndTruncate`)
 *    before it can reach the conversation or corpus.
 *
 * Network I/O is injected (`ToolDeps`) so the executors are deterministic and
 * testable; the production wiring binds the platform adapter. Subprocesses run
 * through the typed runtime seam (`runProcess`), never a shell.
 */
import fs from "node:fs";
import path from "node:path";
import { maskAndTruncate } from "../context/redact.js";
import { USER_AGENT } from "../platform/user-agent.js";
import { runProcess, type ProcessResult } from "../runtime/subprocess.js";
import { pyDumpsCompact } from "../model/conversation.js";

export const GH_DENY_SUBSTRINGS = [
  "/actions/secrets",
  "/dependabot/secrets",
  "/environments/",
  "/dispatches",
] as const;

/** Port of platform.SENSITIVE_PATH_RE (case-insensitive). */
export const SENSITIVE_PATH_RE =
  /(^|\/)(\.env(\.|$)|id_rsa(\.|$)|id_dsa(\.|$)|credentials(\.|$)|secret(s)?(\.|$)|.*\.pem$|.*\.key$|\.netrc(\.|$)|\.npmrc(\.|$)|\.gitconfig(\.|$)|\.git-credentials(\.|$)|\.docker\/config\.json(\.|$)|\.kube\/(config|.*\.conf)(\.|$)|.*service-account.*\.json$|.*-key\.json$|\.htpasswd(\.|$))/i;

export const GH_API_ALLOWED_PREFIXES = ["/repos/"] as const;
export const GH_API_ROOT_PREFIXES = ["/issues/", "/search/", "/releases/", "/git/"] as const;
/** platform.GH_SAFE_PATH_RE. Query-confusion characters are deliberately IN
 * the set (a red-team PR probes `search/code?q=...`-shaped endpoints). */
const GH_SAFE_PATH_RE = /^[A-Za-z0-9._~/%?&=:+,-]+$/;
const REPO_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** platform._REPO_CONTENTS_PATH_RE (fullmatch). */
const REPO_CONTENTS_PATH_RE = /^[A-Za-z0-9._~!$'()*+,;=@%/-]+$/;
const REPO_CONTENTS_BLOB_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPO_CONTENTS_MAX_BYTES = 12000;
const REPO_CONTENTS_DEFAULT_MAX_ENTRIES = 200;
const REPO_CONTENTS_MAX_ENTRIES = 500;

/**
 * The tool harness executes same-repo code, so command execution must not be
 * model-controlled shell text. Commands stay named, argv-only definitions.
 */
export const ALLOWED_COMMANDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  git_status_short: ["git", "status", "--short"],
  git_diff_stat: ["git", "diff", "--stat", "HEAD"],
  git_diff_name_only: ["git", "diff", "--name-only", "HEAD"],
});

export function commandCatalogMarkdown(): string {
  return Object.keys(ALLOWED_COMMANDS).sort().join(", ");
}

export const FIND_FILES_DEFAULT_MAX = 100;
export const FIND_FILES_MAX_CAP = 300;
export const GIT_GREP_DEFAULT_MAX_RESULTS = 60;
export const GIT_GREP_MAX_RESULTS_LIMIT = 200;

export type NetworkResponse = { status: number; headers?: Record<string, string>; body: string; url?: string };
export type GhGetResponse = { status: number; body: string };

/**
 * Injected I/O seams. `ghGet` performs one authenticated platform GET and
 * returns the raw status+body (it may throw on transport failure; a timeout
 * throw carries `name === "AbortError"`). `fetch` serves web_fetch/web_search.
 */
export type ToolDeps = {
  env: NodeJS.ProcessEnv;
  fetch?: (url: string, init: { headers: Record<string, string>; timeoutMs: number; method?: string; body?: string; redirect?: "manual" }) => Promise<NetworkResponse>;
  ghGet?: (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<GhGetResponse>;
  runProcess?: (options: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>;
};

export type ToolContext = {
  workspaceRoot: string;
  allowedGhRepos?: readonly string[];
  currentRepo?: string;
  allowedHosts?: readonly string[];
  maxResponseBytes?: number;
  requestTimeout?: number;
  searchUrl?: string;
  maxSearchResults?: number;
  deps: ToolDeps;
};

type Obj = Record<string, any>;

const defaultFetch: NonNullable<ToolDeps["fetch"]> = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: init.redirect ?? "follow",
      signal: controller.signal,
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
      url: response.url,
    };
  } finally {
    clearTimeout(timer);
  }
};

const toText = (buf: Buffer): string => buf.toString("utf8");

const processOutput = async (ctx: ToolContext, argv: readonly string[], timeout: number): Promise<ProcessResult> => {
  const options = {
    file: argv[0]!,
    args: argv.slice(1),
    cwd: ctx.workspaceRoot,
    env: ctx.deps.env,
    timeoutMs: timeout * 1000,
  };
  if (ctx.deps.runProcess) return ctx.deps.runProcess(options);
  return runProcess(options).result;
};

const processError = (r: ProcessResult, timeout: number, label: string): string | null => {
  if (r.status === "timeout") return `${label} timed out after ${timeout}s`;
  if (r.status === "spawn_error") return r.launchError ?? `${label} failed to start`;
  if (r.exitCode !== 0) return `${label} failed: ${toText(r.stderr).trim()}`;
  return null;
};

/** Python `_opt_int`: coerce an optional tool arg to int, tolerating model
 * string forms; None/malformed → null. */
export function optInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value.trim() : String(value);
  if (!/^[+-]?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

const inside = (resolved: string, root: string): boolean => {
  const rel = path.relative(root, resolved);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
};

/**
 * Port of `_resolve_workspace_path`: resolve a workspace-relative path with
 * traversal/symlink/sensitive guards. The symlink-collapsing realpath runs
 * BEFORE the containment check, so a symlink inside the workspace pointing
 * outside is normalized to its real target and rejected. Containment uses a
 * path-relative check, never a string prefix (sibling directories whose names
 * share a prefix must not pass).
 */
export function resolveWorkspacePath(input: string, workspaceRoot: string): { path: string | null; error: string | null } {
  // Reject embedded null bytes before touching the filesystem: a NUL can
  // truncate the path at the C layer of an underlying syscall.
  if (input.includes("\0")) return { path: null, error: "Null byte in path" };
  let root: string;
  let resolved: string;
  try {
    root = fs.realpathSync(path.resolve(workspaceRoot));
    resolved = fs.realpathSync(path.resolve(root, input));
  } catch {
    return { path: null, error: `Cannot resolve path: ${input}` };
  }
  if (!inside(resolved, root)) return { path: null, error: "Path escapes workspace root" };
  if (SENSITIVE_PATH_RE.test(resolved)) {
    return { path: null, error: `Sensitive file blocked: ${path.basename(resolved)}` };
  }
  for (const deny of GH_DENY_SUBSTRINGS) {
    if (resolved.includes(deny)) return { path: null, error: `Path denied: ${deny}` };
  }
  return { path: resolved, error: null };
}

export function normalizeHost(host: string): string {
  return (host || "").trim().toLowerCase();
}

/** Exact-match host allowlist; "*" is an allow-all wildcard. No suffix
 * confusion (`github.com.evil.example` never matches `github.com`) and no
 * userinfo confusion (the URL parser, not the allowlist, decides the host). */
export function allowlistedHost(host: string, allowlist: readonly string[] = []): boolean {
  const candidate = normalizeHost(host);
  for (const item of allowlist) {
    const norm = normalizeHost(item);
    if (norm === "*" || candidate === norm) return true;
  }
  return false;
}

function repoIsAllowed(repo: string, allowedRepos: readonly string[] | undefined, currentRepo: string): boolean {
  return (
    repo === currentRepo ||
    (allowedRepos ?? []).includes("*") ||
    (allowedRepos ?? []).includes(repo)
  );
}

/**
 * Port of `platform._validate_endpoint`: the security decision for both
 * backends. Order matters (pinned by tests): character set → shape →
 * dot-segments → root-level allowlist (repo check bypassed) → repo allowlist
 * → /repos/ prefix → deny substrings.
 */
export function validateEndpoint(
  endpoint: string,
  allowedRepos: readonly string[] = [],
  currentRepo = "",
): { full_path?: string; repo_key?: string; error?: string } {
  if (!GH_SAFE_PATH_RE.test(endpoint || "")) {
    return { error: "Endpoint contains disallowed characters" };
  }
  const parts = (endpoint || "").replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 1 || (parts.length === 1 && parts[0] === "")) {
    return { error: "Invalid endpoint format: expected a non-empty path" };
  }
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      return { error: `Dot-segment not allowed in path: ${part || "(empty)"}` };
    }
  }
  const isRootLevel = (GH_API_ROOT_PREFIXES as readonly string[]).includes(`/${parts[0]}/`);
  if (isRootLevel) {
    const full = `/${parts.join("/")}`;
    const lower = full.toLowerCase();
    for (const deny of GH_DENY_SUBSTRINGS) {
      if (lower.includes(deny)) return { error: `Path segment denied: ${deny}` };
    }
    return { full_path: full, repo_key: "" };
  }
  if (parts.length < 2) {
    return { error: "Invalid endpoint format: expected owner/repo/..." };
  }
  const repoKey = parts[0] === "repos" && parts.length >= 3 ? `${parts[1]}/${parts[2]}` : `${parts[0]}/${parts[1]}`;
  if (!repoIsAllowed(repoKey, allowedRepos, currentRepo)) {
    return { error: `Repo not allowed: ${repoKey}` };
  }
  const full = parts[0] === "repos" ? `/${parts.join("/")}` : `/repos/${parts.join("/")}`;
  if (!(GH_API_ALLOWED_PREFIXES as readonly string[]).some((prefix) => full.startsWith(prefix))) {
    return { error: `Endpoint prefix not allowed: ${full}` };
  }
  const lower = full.toLowerCase();
  for (const deny of GH_DENY_SUBSTRINGS) {
    if (lower.includes(deny)) return { error: `Path segment denied: ${deny}` };
  }
  return { full_path: full, repo_key: repoKey };
}

export const _validate_endpoint = validateEndpoint;

function ghHeaders(ctx: ToolContext): Record<string, string> | { error: string } {
  const token = ctx.deps.env.GH_TOKEN || ctx.deps.env.GITHUB_TOKEN || "";
  if (!token) return { error: "Missing GH_TOKEN" };
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": USER_AGENT,
  };
}

/** Standard HTTP reason phrases — the full `http.client.responses` table
 * urllib's `exc.reason` draws from. */
function httpReason(status: number): string {
  const reasons: Record<number, string> = {
    100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
    200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
    204: "No Content", 205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
    208: "Already Reported", 226: "IM Used",
    300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other",
    304: "Not Modified", 305: "Use Proxy", 307: "Temporary Redirect", 308: "Permanent Redirect",
    400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable",
    407: "Proxy Authentication Required", 408: "Request Timeout", 409: "Conflict",
    410: "Gone", 411: "Length Required", 412: "Precondition Failed",
    413: "Request Entity Too Large", 414: "Request URI Too Long",
    415: "Unsupported Media Type", 416: "Requested Range Not Satisfiable",
    417: "Expectation Failed", 418: "I'm a Teapot", 421: "Misdirected Request",
    422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency",
    425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required",
    429: "Too Many Requests", 431: "Request Header Fields Too Large",
    451: "Unavailable For Legal Reasons",
    500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
    503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
    506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected",
    509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required",
  };
  return reasons[status] ?? "Error";
}

async function ghGet(ctx: ToolContext, url: string): Promise<{ status: number; body: string }> {
  if (!ctx.deps.ghGet) throw new Error("platform transport not configured");
  const headers = ghHeaders(ctx);
  if ("error" in headers) throw new Error(headers.error);
  return ctx.deps.ghGet(url, headers, (ctx.requestTimeout ?? 25) * 1000);
}

export async function ghApi(endpoint: string, ctx: ToolContext): Promise<Obj> {
  const v = validateEndpoint(endpoint, ctx.allowedGhRepos, ctx.currentRepo);
  if (v.error) return { error: v.error };
  try {
    const res = await ghGet(ctx, `https://api.github.com${v.full_path}`);
    if (res.status >= 400) {
      return { error: `GitHub API error: ${res.status} ${httpReason(res.status)}` };
    }
    return { data: JSON.parse(res.body) };
  } catch (exc) {
    if (exc instanceof Error && exc.message === "Missing GH_TOKEN") return { error: exc.message };
    const err = exc as Error;
    if (err?.name === "AbortError") return { error: `GitHub API timed out after ${ctx.requestTimeout ?? 25}s` };
    return { error: err?.message ?? String(exc) };
  }
}

/** Port of `platform._validate_repo_contents` + `_repo_contents_github`. */
export async function repoContents(
  repoArg: unknown,
  inputPath: unknown,
  ref: unknown,
  ctx: ToolContext,
  maxEntries: number = REPO_CONTENTS_DEFAULT_MAX_ENTRIES,
): Promise<Obj> {
  if (typeof repoArg !== "string") return { error: "Invalid repo: expected owner/name" };
  if (/[\0\n\r#\\`]/.test(repoArg)) return { error: "Invalid repo: expected owner/name" };
  const repo = repoArg.trim().replace(/^\/+|\/+$/g, "");
  if (!REPO_NAME_RE.test(repo)) return { error: "Invalid repo: expected owner/name" };
  if (!repoIsAllowed(repo, ctx.allowedGhRepos, ctx.currentRepo ?? "")) {
    return { error: `Repo not allowed: ${repo}` };
  }
  for (const [label, value] of [["path", inputPath], ["ref", ref]] as const) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || !REPO_CONTENTS_PATH_RE.test(value)) {
      return { error: `Invalid ${label}` };
    }
    if (value.replace(/^\/+|\/+$/g, "").split("/").some((p) => p === "" || p === "." || p === "..")) {
      return { error: `Invalid ${label}: dot-segment or empty segment` };
    }
    if (label === "path" && SENSITIVE_PATH_RE.test(value)) {
      return { error: "Sensitive path blocked" };
    }
  }
  const path_ = typeof inputPath === "string" ? inputPath.replace(/^\/+|\/+$/g, "") : "";
  const ref_ = typeof ref === "string" && ref ? ref.trim() : null;

  const cap = Math.max(1, Math.min(optInt(maxEntries) ?? REPO_CONTENTS_DEFAULT_MAX_ENTRIES, REPO_CONTENTS_MAX_ENTRIES));
  const timeoutSec = ctx.requestTimeout ?? 25;

  const contentsUrl = (p: string, r: string | null): string => {
    const encodedRepo = repo.split("/").map((part) => encodeURIComponent(part)).join("/");
    const encodedPath = p ? p.split("/").map((part) => encodeURIComponent(part)).join("/") : "";
    let url = `https://api.github.com/repos/${encodedRepo}/contents/${encodedPath}`.replace(/\/+$/, "");
    if (r !== null) url += `?ref=${encodeURIComponent(r)}`;
    return url;
  };

  // File preflight: find the parent directory listing and locate the entry so
  // a file read goes through the blob endpoint (directory listings never
  // return file bytes).
  let expectedType = "dir";
  let blobSha: string | null = null;
  if (path_) {
    const idx = path_.lastIndexOf("/");
    const parentPath = idx > 0 ? path_.slice(0, idx) : "";
    const basename = idx > 0 ? path_.slice(idx + 1) : path_;
    let parentData: unknown;
    try {
      const res = await ghGet(ctx, contentsUrl(parentPath, ref_));
      if (res.status >= 400) throw new Error("preflight status");
      parentData = JSON.parse(res.body);
    } catch {
      return { error: "Repository contents file preflight failed" };
    }
    if (!Array.isArray(parentData)) return { error: "Repository contents file preflight failed" };
    const matches = parentData.filter(
      (item) => item !== null && typeof item === "object" && (item as Obj).name === basename,
    );
    if (matches.length !== 1) return { error: "Repository contents file preflight failed" };
    const entry = matches[0] as Obj;
    expectedType = entry.type;
    if (expectedType === "file") {
      blobSha = entry.sha;
      if (typeof blobSha !== "string" || !REPO_CONTENTS_BLOB_SHA_RE.test(blobSha)) {
        return { error: "Repository contents file preflight failed" };
      }
    } else if (expectedType !== "dir") {
      return { error: "Repository contents file preflight failed" };
    }
  }

  const encodedRepo = repo.split("/").map((part) => encodeURIComponent(part)).join("/");
  const url = blobSha
    ? `https://api.github.com/repos/${encodedRepo}/git/blobs/${blobSha}`
    : contentsUrl(path_, ref_);
  let data: unknown;
  try {
    const res = await ghGet(ctx, url);
    if (res.status >= 400) {
      return { error: `GitHub contents API error: ${res.status} ${httpReason(res.status)}` };
    }
    data = JSON.parse(res.body);
  } catch (exc) {
    const err = exc as Error;
    if (err?.name === "AbortError") {
      return { error: `GitHub contents API timed out after ${timeoutSec}s` };
    }
    return { error: err?.message ?? String(exc) };
  }

  if (Array.isArray(data)) {
    if (expectedType !== "dir") return { error: "Repository contents file preflight failed" };
    const entries = data
      .filter((item) => item !== null && typeof item === "object" && ["file", "dir", "symlink", "submodule"].includes((item as Obj).type))
      .map((item: Obj) => ({
        path: item.path ?? "",
        type: item.type === "dir" ? "directory" : item.type,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const truncated = entries.length > cap;
    return { repo, path: path_, type: "directory", entries: entries.slice(0, cap), truncated };
  }
  if (data === null || typeof data !== "object") {
    return { error: "GitHub contents API returned an unexpected response" };
  }
  const payload = data as Obj;
  if (expectedType !== "file" || payload.encoding !== "base64") {
    return { error: "Repository contents file preflight failed" };
  }
  const rawContent = payload.content;
  if (payload.encoding !== "base64" || typeof rawContent !== "string") {
    return { repo, path: path_, type: "file", error: "Binary or unavailable file content" };
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(rawContent, "base64");
  } catch {
    return { repo, path: path_, type: "file", error: "Invalid file content encoding" };
  }
  if (decoded.includes(0)) {
    return { repo, path: path_, type: "file", binary: true, truncated: false };
  }
  const text = decoded.toString("utf8");
  // Round-trip check: invalid UTF-8 survives a Buffer round-trip with
  // replacement chars, which Python's strict decode would have rejected.
  if (Buffer.from(text, "utf8").toString("base64") !== decoded.toString("base64")) {
    return { repo, path: path_, type: "file", binary: true, truncated: false };
  }
  const encoded = Buffer.from(text, "utf8");
  const truncated = encoded.length > REPO_CONTENTS_MAX_BYTES;
  const content = truncated ? encoded.subarray(0, REPO_CONTENTS_MAX_BYTES).toString("utf8") : text;
  return { repo, path: path_, type: "file", content, truncated };
}

export async function readFile(input: string, ctx: ToolContext, offset?: number | null, limit?: number | null): Promise<Obj> {
  const guarded = resolveWorkspacePath(input, ctx.workspaceRoot);
  if (guarded.error) return { error: guarded.error };
  let content: string;
  try {
    content = fs.readFileSync(guarded.path!, "utf8");
  } catch (e) {
    return { error: String(e) };
  }
  if (offset == null && limit == null) {
    return { content: codepointSlice(content, 12000) };
  }
  const lines = splitKeepEnds(content);
  const start = Math.max((offset || 1) - 1, 0);
  const end = limit != null ? start + limit : lines.length;
  const window = lines.slice(start, end).join("");
  return {
    content: codepointSlice(window, 12000),
    range: { offset: start + 1, lines: end - start, total_lines: lines.length },
  };
}

/** Python `str[:n]` slices by codepoints; JS slices by UTF-16 units. Slice by
 * codepoint so astral characters count once, matching the v2 cap. */
function codepointSlice(text: string, n: number): string {
  if (text.length <= n) return text;
  return Array.from(text).slice(0, n).join("");
}

/** Python `str.splitlines(keepends=True)` for the line-window read. Splits on
 * \n, \r\n, \r (the terminators that matter for source files) and keeps them. */
function splitKeepEnds(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") continue; // \r\n terminates at the \n
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** fnmatch.fnmatchcase equivalent for the two match targets (relative POSIX
 * path and basename): `*` and `?` wildcards, `[seq]` classes, no shell. */
function fnmatchCase(name: string, pattern: string): boolean {
  let rx = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") rx += "[^/]*";
    else if (ch === "?") rx += "[^/]";
    else if (ch === "[") {
      // Translate a [...] class; an unterminated `[` is a literal.
      let j = i + 1;
      let cls = "";
      if (pattern[j] === "!" || pattern[j] === "^") {
        cls += "^";
        j++;
      }
      let closed = false;
      for (; j < pattern.length; j++) {
        if (pattern[j] === "]") {
          closed = true;
          break;
        }
        cls += (pattern[j] ?? "").replace(/[\\\]]/g, "\\$&");
      }
      if (!closed) {
        rx += "\\[";
        continue;
      }
      rx += `[${cls}]`;
      i = j;
    } else rx += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${rx}$`).test(name);
  } catch {
    return false;
  }
}

export function findFiles(pattern: string, ctx: ToolContext, scope = ".", maxResults: unknown = FIND_FILES_DEFAULT_MAX): Obj {
  if (!pattern || typeof pattern !== "string") return { error: "Missing 'pattern' argument" };
  const guarded = resolveWorkspacePath(scope, ctx.workspaceRoot);
  if (guarded.error) return { error: guarded.error };
  const scopePath = guarded.path!;
  if (!fs.statSync(scopePath).isDirectory()) {
    return { error: `Path is not a directory: ${scope}` };
  }
  const root = fs.realpathSync(ctx.workspaceRoot);
  if (path.relative(root, scopePath).split(path.sep).includes(".git")) {
    return { error: "Path inside .git is not searchable" };
  }
  // Clamp the model-supplied cap into the safe range; a malformed value falls
  // back to the default, never widening the cap.
  const rawCap = optInt(maxResults) ?? FIND_FILES_DEFAULT_MAX;
  const cap = Math.max(1, Math.min(rawCap, FIND_FILES_MAX_CAP));
  const matches: string[] = [];
  const walk = (dir: string) => {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirEntries) {
      if (ent.name === ".git") continue; // never descend into .git
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // followlinks=False equivalent: symlinked dirs are never descended.
        if (ent.isSymbolicLink()) continue;
        walk(abs);
      } else if (ent.isFile() && !ent.isSymbolicLink()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (fnmatchCase(rel, pattern) || fnmatchCase(ent.name, pattern)) matches.push(rel);
      }
    }
  };
  walk(scopePath);
  // Sort BEFORE applying the cap so the returned window is the lexicographic
  // head of ALL matches — identical on every run.
  matches.sort();
  const files = matches.slice(0, cap);
  return { files, total: files.length, truncated: matches.length > cap };
}

export function listTree(input: unknown, ctx: ToolContext, depthValue: unknown = 2, maxValue: unknown = 200): Obj {
  const relPath = typeof input === "string" && input ? input : ".";
  const guarded = resolveWorkspacePath(relPath, ctx.workspaceRoot);
  if (guarded.error) return { error: guarded.error };
  const resolved = guarded.path!;
  const root = fs.realpathSync(ctx.workspaceRoot);
  if (!fs.existsSync(resolved)) return { error: `Path not found: ${relPath}` };
  if (path.relative(root, resolved).split(path.sep).includes(".git")) {
    return { error: "Path inside .git is not listable" };
  }
  const depth = Math.max(1, Math.min(optInt(depthValue) ?? 2, 4));
  const cap = Math.max(1, Math.min(optInt(maxValue) ?? 200, 500));
  if (!fs.statSync(resolved).isDirectory()) {
    // A file is a valid single-row listing, consistent with read_file.
    return {
      entries: [{ path: path.relative(root, resolved).split(path.sep).join("/"), type: "file" }],
      total: 1,
      truncated: false,
    };
  }
  const entries: Obj[] = [];
  let truncated = false;
  const relOf = (dir: string): string =>
    dir === resolved ? "." : path.relative(root, dir).split(path.sep).join("/");
  const walk = (dir: string, level: number) => {
    if (level > depth) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    for (const child of children) {
      if (entries.length >= cap) {
        truncated = true;
        return;
      }
      if (child.name === ".git") continue;
      if (child.isSymbolicLink()) continue; // never followed or listed
      const abs = path.join(dir, child.name);
      const isDir = child.isDirectory();
      entries.push({ path: relOf(abs), type: isDir ? "dir" : "file" });
      if (isDir) walk(abs, level + 1);
    }
  };
  walk(resolved, 1);
  return { entries, total: entries.length, truncated };
}

/** Turn a resolved path into a git pathspec: repo-relative when possible. */
function grepPathspec(resolved: string, workspaceRoot: string): string {
  const root = fs.realpathSync(workspaceRoot);
  const rel = path.relative(root, resolved).split(path.sep).join("/");
  return rel || ".";
}

/** Consume a raw `git grep -z` stream into match records (port of
 * `_parse_grep_z_records`). A text record is `path\0lineno\0content\n`; a
 * binary match carries no NUL; malformed trailing output is kept as a
 * binary-style record so the redaction pass fails closed. */
export function parseGrepZRecords(stdout: string): Array<{ kind: "text"; path: string; lineno: string; content: string } | { kind: "binary"; line: string }> {
  const records: Array<{ kind: "text"; path: string; lineno: string; content: string } | { kind: "binary"; line: string }> = [];
  const n = stdout.length;
  let i = 0;
  while (i < n) {
    if (stdout.startsWith("Binary file ", i)) {
      const newline = stdout.indexOf("\n", i);
      const binaryLine = stdout.slice(i, newline === -1 ? n : newline);
      if (/^Binary file (.*) matches$/.test(binaryLine)) {
        records.push({ kind: "binary", line: binaryLine });
        i = newline === -1 ? n : newline + 1;
        continue;
      }
    }
    const nul1 = stdout.indexOf("\0", i);
    const nul2 = nul1 !== -1 ? stdout.indexOf("\0", nul1 + 1) : -1;
    if (nul2 === -1) {
      const newline = stdout.indexOf("\n", i);
      records.push({ kind: "binary", line: stdout.slice(i, newline === -1 ? n : newline) });
      i = newline === -1 ? n : newline + 1;
      continue;
    }
    let newline = stdout.indexOf("\n", nul2 + 1);
    if (newline === -1) newline = n;
    records.push({
      kind: "text",
      path: stdout.slice(i, nul1),
      lineno: stdout.slice(nul1 + 1, nul2),
      content: stdout.slice(nul2 + 1, newline),
    });
    i = newline + 1;
  }
  return records;
}

/** Re-check every match's own path against the same sensitive-path policy:
 * the resolver only guards the scope the model asked for, so a broad scope
 * can still match a tracked `.env`/`.pem` descendant. */
export function redactGrepRecord(
  rec: { kind: "text"; path: string; lineno: string; content: string } | { kind: "binary"; line: string },
  workspaceRoot: string,
): string {
  if (rec.kind === "binary") {
    const m = /^Binary file (.*) matches$/.exec(rec.line);
    if (m && resolveWorkspacePath(m[1]!, workspaceRoot).error) {
      return "[redacted: sensitive path]";
    }
    return rec.line;
  }
  const err = resolveWorkspacePath(rec.path, workspaceRoot).error;
  if (err === null) return `${rec.path}:${rec.lineno}:${rec.content}`;
  return `${rec.path}:${rec.lineno}:[redacted: sensitive path]`;
}

export async function gitGrep(pattern: string, ctx: ToolContext, scope?: unknown, maxResults: unknown = GIT_GREP_DEFAULT_MAX_RESULTS): Promise<Obj> {
  const cap = clampGrepMaxResults(maxResults);
  const argv = ["git", "grep", "-n", "-z", "--", pattern];
  if (scope === null || scope === undefined) {
    // No explicit path: preserve the historical whole-worktree invocation
    // byte-for-byte (single `--` before the pattern, `.` pathspec).
    argv.push(".");
  } else {
    const text = String(scope).trim();
    if (!text) {
      // A model-emitted blank path means "whole worktree".
      argv.push(".");
    } else {
      const guarded = resolveWorkspacePath(text, ctx.workspaceRoot);
      if (guarded.error) return { error: guarded.error };
      argv.push("--", grepPathspec(guarded.path!, ctx.workspaceRoot));
    }
  }
  const timeout = ctx.requestTimeout ?? 15;
  const r = await processOutput(ctx, argv, timeout);
  if (r.status === "timeout") return { error: `git grep timed out after ${timeout}s` };
  if (r.status === "spawn_error") return { error: r.launchError ?? "git grep failed to start" };
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    return { error: `git grep failed: ${toText(r.stderr).trim()}` };
  }
  // Parse all raw -z records before applying max_results: a path may contain
  // a newline, so line-splitting first could break a record before redaction.
  const records = parseGrepZRecords(toText(r.stdout));
  const matches = records.map((rec) => redactGrepRecord(rec, ctx.workspaceRoot));
  return { matches: matches.slice(0, cap) };
}

export function clampGrepMaxResults(value: unknown, defaultValue = GIT_GREP_DEFAULT_MAX_RESULTS): number {
  const n = optInt(value);
  if (n === null) return defaultValue;
  return Math.max(1, Math.min(n, GIT_GREP_MAX_RESULTS_LIMIT));
}

export async function gitLog(scope: string, ctx: ToolContext, maxCount = 20): Promise<Obj> {
  const argv = ["git", "log", `-n${maxCount}`, "--no-color", "--date=short", "--pretty=format:%h %ad %an %s"];
  if (scope) {
    const guarded = resolveWorkspacePath(scope, ctx.workspaceRoot);
    if (guarded.error) return { error: guarded.error };
    argv.push("--", guarded.path!);
  }
  const t = ctx.requestTimeout ?? 15;
  const r = await processOutput(ctx, argv, t);
  const error = processError(r, t, "git log");
  if (error) return { error };
  return { log: toText(r.stdout).trim().split(/\r?\n/).slice(0, maxCount) };
}

export async function gitBlame(input: string, ctx: ToolContext, start?: number | null, end?: number | null): Promise<Obj> {
  const guarded = resolveWorkspacePath(input, ctx.workspaceRoot);
  if (guarded.error) return { error: guarded.error };
  const argv = ["git", "blame", "-w"];
  if (start != null && end != null) {
    // Python int() coercion: a non-integer range is a clean error, not NaN.
    if (!Number.isInteger(Number(start)) || !Number.isInteger(Number(end))) {
      return { error: `invalid literal for int() with base 10: '${String(start)}'` };
    }
    argv.push("-L", `${Number(start)},${Number(end)}`);
  }
  argv.push("--", guarded.path!);
  const t = ctx.requestTimeout ?? 15;
  const r = await processOutput(ctx, argv, t);
  const error = processError(r, t, "git blame");
  if (error) return { error };
  return { blame: toText(r.stdout) };
}

export async function webFetch(url: string, ctx: ToolContext): Promise<Obj> {
  let current = url;
  const allowed = ctx.allowedHosts ?? [];
  const fetcher = ctx.deps.fetch ?? defaultFetch;
  for (let hop = 0; hop <= 10; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { error: `URL scheme '' is not allowed; only http and https are permitted` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `URL scheme '${parsed.protocol.replace(":", "")}' is not allowed; only http and https are permitted` };
    }
    const host = parsed.hostname.toLowerCase();
    if (!allowlistedHost(host, allowed)) {
      return {
        error: hop > 0 ? `Redirect to disallowed host: ${host}` : `Host not allowlisted: ${host}`,
      };
    }
    let res: NetworkResponse;
    try {
      res = await fetcher(current, {
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: (ctx.requestTimeout ?? 25) * 1000,
        redirect: "manual",
      });
    } catch (e) {
      return { error: String(e) };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop === 10) return { error: "Too many redirects" };
      const location = res.headers?.location ?? res.headers?.Location;
      if (!location) return { error: "Redirect response missing Location" };
      current = new URL(location, current).toString();
      continue;
    }
    // urllib semantics: a non-2xx FINAL response raises HTTPError, so its body
    // never becomes tool evidence. Non-redirect 3xx (e.g. 304) fails the same
    // way — only a 2xx body is content.
    if (res.status < 200 || res.status > 299) {
      return { error: `HTTP Error ${res.status}: ${httpReason(res.status)}` };
    }
    // Node's text() decoding replaces invalid sequences, matching v2's
    // errors="replace" decode.
    return { content: codepointSlice(res.body, 10000) };
  }
  return { error: "Too many redirects" };
}

export async function webSearch(query: string, ctx: ToolContext): Promise<Obj> {
  if (!ctx.searchUrl) return { error: "Search is not configured (no search_url)." };
  // v2 appends `q` + `format=json` with urlencode (application/x-www-form-urlencoded);
  // the separator mirrors urlparse(search_url).query: "&" when a query exists.
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("format", "json");
  const existingQuery = ctx.searchUrl.split("?")[1] ?? "";
  const sep = existingQuery ? "&" : "?";
  const full = `${ctx.searchUrl}${sep}${params.toString()}`;
  let data: Obj;
  try {
    const res = await (ctx.deps.fetch ?? defaultFetch)(full, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      timeoutMs: (ctx.requestTimeout ?? 20) * 1000,
    });
    // urllib semantics: a non-2xx response raises HTTPError before any body
    // parsing — a valid JSON error body is still an error, never evidence.
    if (res.status < 200 || res.status > 299) {
      return { error: `HTTP Error ${res.status}: ${httpReason(res.status)}` };
    }
    data = JSON.parse(res.body);
  } catch (e) {
    return { error: String(e) };
  }
  const results: Obj[] = [];
  for (const item of ((data.results ?? []) as unknown[]).slice(0, ctx.maxSearchResults ?? 5)) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Obj;
    let resultUrl = String(record.url ?? "");
    // Strip non-http(s) result URLs to prevent LFI/SSRF via search results.
    try {
      const parsedUrl = new URL(resultUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") resultUrl = "";
    } catch {
      // Unparseable URL: scheme unknown — keep as-is (v2 keeps it too).
    }
    results.push({
      title: codepointSlice(String(record.title ?? ""), 300),
      url: resultUrl,
      snippet: codepointSlice(String(record.content ?? ""), 500),
    });
  }
  return { results };
}

export async function runCommand(command: string, ctx: ToolContext): Promise<Obj> {
  const name = (command || "").trim();
  const argv = ALLOWED_COMMANDS[name];
  if (!argv) {
    return {
      error: `Command not allowlisted. Use one of: ${commandCatalogMarkdown()}`,
    };
  }
  const t = ctx.requestTimeout ?? 30;
  const r = await processOutput(ctx, argv, t);
  if (r.status === "timeout") {
    return {
      error: `Command timed out after ${t}s`,
      stdout: maskAndTruncate(toText(r.stdout).trim(), Number.MAX_SAFE_INTEGER).text,
      stderr: maskAndTruncate(toText(r.stderr).trim(), Number.MAX_SAFE_INTEGER).text,
      command: name,
    };
  }
  if (r.status === "spawn_error") return { error: r.launchError ?? "Command failed to start", command: name };
  return {
    stdout: maskAndTruncate(toText(r.stdout).trim(), Number.MAX_SAFE_INTEGER).text,
    stderr: maskAndTruncate(toText(r.stderr).trim(), Number.MAX_SAFE_INTEGER).text,
    exit_code: r.exitCode,
    command: name,
  };
}

/** Compact Python-JSON serialization with ensure_ascii=True — what
 * `json.dumps(data, separators=(",", ":"))` produces for the gh_api response
 * payload (the model re-prefills tool results every round, so compactness is
 * the point; ensure_ascii matches v2 byte-for-byte). */
const pyCompactJson = pyDumpsCompact;

/**
 * Execute a single tool request and return the result dict — the port of
 * `execute_tool_request`. Every tool result passes redaction + byte caps
 * before it reaches the loop or corpus; executor-level errors become
 * `{"status": "error", "result": {"error": ...}}`, never an exception.
 */
export async function executeToolRequest(tool: string, args: Obj, ctx: ToolContext): Promise<Obj> {
  const toolResult: Obj = { tool, status: "error", result: {} };
  const cap = ctx.maxResponseBytes ?? 12000;
  const bounded = (s: string, n = cap) => maskAndTruncate(s, n).text;
  try {
    let result: Obj;
    switch (tool) {
      case "read_file": {
        const p = args.path ?? "";
        if (!p) throw new Error("Missing 'path' argument");
        const res = await readFile(p, ctx, optInt(args.offset), optInt(args.limit));
        if (res.error) throw new Error(res.error);
        const text = bounded(maskAndTruncate(res.content, Number.MAX_SAFE_INTEGER).text);
        const payload: Obj = { content: text };
        if (res.range) payload.range = res.range;
        result = payload;
        break;
      }
      case "find_files": {
        const pattern = args.pattern ?? "";
        if (!pattern) throw new Error("Missing 'pattern' argument");
        const rawMax = args.max_results;
        const maxResults = rawMax === null || rawMax === undefined ? FIND_FILES_DEFAULT_MAX : optInt(rawMax);
        const res = findFiles(pattern, ctx, args.path || ".", maxResults);
        if (res.error) throw new Error(res.error);
        result = { files: res.files, total: res.total, truncated: res.truncated };
        break;
      }
      case "list_tree": {
        const res = listTree(args.path || ".", ctx, optInt(args.depth), optInt(args.max_entries));
        if (res.error) throw new Error(res.error);
        // Byte cap applied at row boundaries: measure each serialized row and
        // never split an entry at a byte cut. A single oversized entry yields
        // an empty array with truncated=true.
        const entries: Obj[] = res.entries;
        const kept: Obj[] = [];
        let truncated: boolean = res.truncated;
        if (cap > 0) {
          let arrayBytes = 2; // the `[]` brackets
          for (const e of entries) {
            const rowBytes = Buffer.byteLength(pyCompactJson(e), "utf8");
            const added = rowBytes + (kept.length > 0 ? 1 : 0);
            if (arrayBytes + added > cap) {
              truncated = true;
              break;
            }
            kept.push(e);
            arrayBytes += added;
          }
        }
        result = { entries: kept, total: kept.length, truncated };
        break;
      }
      case "git_log": {
        const maxCount = Math.max(1, Math.min(optInt(args.max_count) || 20, 100));
        const res = await gitLog(args.path || "", ctx, maxCount);
        if (res.error) throw new Error(res.error);
        result = { log: bounded(res.log.join("\n")) };
        break;
      }
      case "git_blame": {
        const p = args.path ?? "";
        if (!p) throw new Error("Missing 'path' argument");
        const res = await gitBlame(p, ctx, optInt(args.start), optInt(args.end));
        if (res.error) throw new Error(res.error);
        result = { blame: bounded(res.blame) };
        break;
      }
      case "git_grep": {
        const pattern = args.pattern ?? "";
        if (!pattern) throw new Error("Missing 'pattern' argument");
        const maxResults = clampGrepMaxResults(args.max_results);
        const res = await gitGrep(pattern, ctx, args.path, maxResults);
        if (res.error) throw new Error(res.error);
        const joined = maskAndTruncate(res.matches.join("\n"), cap);
        result = { matches: joined.text.split(/\r?\n/), truncated: joined.truncated };
        break;
      }
      case "repo_contents": {
        const repo = args.repo ?? "";
        if (!repo) throw new Error("Missing 'repo' argument");
        const rawMaxEntries = args.max_entries;
        const maxEntries = rawMaxEntries === null || rawMaxEntries === undefined ? REPO_CONTENTS_DEFAULT_MAX_ENTRIES : optInt(rawMaxEntries) ?? REPO_CONTENTS_DEFAULT_MAX_ENTRIES;
        const res = await repoContents(repo, args.path ?? "", args.ref, ctx, maxEntries);
        if (res.error) throw new Error(res.error);
        if (res.type === "file" && "content" in res) {
          const clipped = maskAndTruncate(res.content, Math.min(cap, 12000));
          result = { ...res, content: clipped.text, truncated: (res.truncated ?? false) || clipped.truncated };
        } else if (res.type === "directory" && cap > 0) {
          const entries: Obj[] = res.entries;
          const kept: Obj[] = [];
          let used = 2;
          for (const entry of entries) {
            const rowBytes = Buffer.byteLength(pyCompactJson(entry), "utf8");
            const added = rowBytes + (kept.length > 0 ? 1 : 0);
            if (used + added > cap) break;
            kept.push(entry);
            used += added;
          }
          result = { ...res, entries: kept, truncated: (res.truncated ?? false) || kept.length < entries.length };
        } else {
          result = res;
        }
        break;
      }
      case "gh_api": {
        const endpoint = args.endpoint ?? "";
        if (!endpoint) throw new Error("Missing 'endpoint' argument");
        const res = await ghApi(endpoint, ctx);
        if (res.error) throw new Error(res.error);
        const data = res.data;
        let text = "";
        if (data !== null && typeof data === "object") {
          text = pyCompactJson(data).slice(0, cap);
        }
        result = { response: text };
        break;
      }
      case "web_fetch": {
        const url = args.url ?? "";
        if (!url) throw new Error("Missing 'url' argument");
        const res = await webFetch(url, ctx);
        if (res.error) throw new Error(res.error);
        result = { content: bounded(res.content) };
        break;
      }
      case "web_search": {
        const query = args.query ?? "";
        if (!query) throw new Error("Missing 'query' argument");
        const res = await webSearch(query, ctx);
        if (res.error) throw new Error(res.error);
        result = { results: bounded(pyCompactJson(res.results)) };
        break;
      }
      case "run_command": {
        const command = args.command ?? "";
        if (!command) throw new Error("Missing 'command' argument");
        const res = await runCommand(command, ctx);
        if (res.error) throw new Error(res.error);
        result = {
          stdout: bounded(res.stdout),
          stderr: bounded(res.stderr),
          exit_code: res.exit_code,
          command: res.command,
        };
        break;
      }
      default:
        throw new Error(`Unknown tool: ${tool}`);
    }
    toolResult.status = "ok";
    toolResult.result = result;
  } catch (e) {
    toolResult.result = { error: e instanceof Error ? e.message : String(e) };
  }
  return toolResult;
}

export async function executeToolRequests(requests: Array<{ tool: string; args: Obj }>, ctx: ToolContext): Promise<Obj[]> {
  return Promise.all(requests.map(({ tool, args }) => executeToolRequest(tool, args, ctx)));
}
