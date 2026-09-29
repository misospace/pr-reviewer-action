import type { ResolvedPlatform } from "./resolve.js";

/**
 * Tangled/Spindle runtime support (#583): resolution-only until the backend
 * tickets (#564 children) land. This module owns the Tangled boundary: the
 * fail-loud guard every adapter-construction site runs, and the Spindle
 * runtime-context normalization later tickets will consume.
 *
 * The context port mirrors `pr_reviewer/tangled_context.py` semantics:
 * environment-driven, stdlib-only, never reads GitHub event JSON, never
 * makes network calls. `TANGLED_REPO_DID` is the repository *owner's* DID
 * (required); the repository DID arrives separately as
 * `TANGLED_REPO_REPO_DID`. `TANGLED_REPO_KNOT` is a bare knot hostname
 * (Spindle's runtime contract — not a URL; the fictional
 * `TANGLED_KNOT_URL` is deliberately not read), and `TANGLED_BOBBIN_URL` is
 * configuration only: an absolute http(s) URL, plaintext http accepted for
 * loopback hosts so local test instances work.
 *
 * URL parsing uses WHATWG `URL` rather than `urllib.parse.urlsplit`: for
 * every shape the tests pin the outcomes agree, and the two parsers differ
 * only on exotic inputs (IPv4 shorthand like `http://127.1`, which WHATWG
 * canonicalizes to a loopback address and the Python regex rejects).
 */

export const TANGLED_NOT_IMPLEMENTED = "the 'tangled' platform backend is not implemented yet (#583)";

export class TangledNotImplementedError extends Error {
  constructor() {
    super(TANGLED_NOT_IMPLEMENTED);
    this.name = "TangledNotImplementedError";
  }
}

/** Guard for every adapter-construction boundary: a resolved `tangled`
 * platform must fail loudly instead of silently driving the GitHub or
 * Forgejo adapters. v2 mirrors this in `pr_reviewer/platform.py`
 * (`TANGLED_NOT_IMPLEMENTED`) and `scripts/platform_api.sh`
 * (`_platform_tangled_guard`); until a Tangled backend lands, no code path
 * may construct a GitHub URL, GitHubAdapter, ForgejoAdapter, or either
 * publish API for a Tangled-resolved environment. The assertion narrows the
 * platform to the implemented backends after the call, so a `tangled`
 * identity cannot reach adapter construction anywhere without the guard. */
export function requireImplementedBackend(
  platform: ResolvedPlatform,
): asserts platform is Exclude<ResolvedPlatform, "tangled"> {
  if (platform === "tangled") throw new TangledNotImplementedError();
}

/** Plaintext http is accepted for these hosts only (local test instances). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Bare-hostname shape (lowercase input): no scheme, path, port,
 * credentials, or empty labels. Mirrors `tangled_context._HOSTNAME_RE`. */
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/** The Spindle runtime context, normalized from the TANGLED_* environment.
 * Optional fields are `undefined` when unset (or set to whitespace). */
export interface TangledContext {
  /** Required: the repository owner's DID (`TANGLED_REPO_DID`). */
  ownerDid: string;
  /** The repository DID (`TANGLED_REPO_REPO_DID`), optional. */
  repoDid: string | undefined;
  repoName: string | undefined;
  sourceBranch: string | undefined;
  targetBranch: string | undefined;
  sourceSha: string | undefined;
  /** Bare knot hostname (`TANGLED_REPO_KNOT`), stored verbatim. */
  knotHost: string | undefined;
  /** Bobbin base URL (`TANGLED_BOBBIN_URL`), configuration only. */
  bobbinUrl: string | undefined;
}

function validateUrlField(name: string, value: string): void {
  // The `http(s)://` literal prefix keeps the WHATWG parser from
  // "helpfully" completing scheme-relative shapes the Python oracle
  // rejects (`http:/foo`, `http:localhost:3000`).
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${name} must be an http(s) URL`);
  }
  // An empty authority after the literal scheme is the Python oracle's
  // "absolute ... with a host" failure; WHATWG folds it into the parse
  // error, so it is checked before parsing.
  if (/^https?:\/\/([/?#]|$)/i.test(value)) {
    throw new Error(`${name} must be an absolute http(s) URL with a host`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid http(s) URL`);
  }
  // WHATWG wraps IPv6 literals in brackets; the loopback set uses the bare
  // form. Parser boundaries (malformed IPv6, empty hosts) fail above or
  // here with the field named, never with the bare parser message.
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (hostname === "") {
    throw new Error(`${name} must be an absolute http(s) URL with a host`);
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`${name} must be an https URL; plaintext http is accepted for loopback hosts only`);
  }
  if (!LOOPBACK_HOSTS.has(hostname) && !HOSTNAME_RE.test(hostname)) {
    throw new Error(`${name} has an invalid hostname`);
  }
}

function validateHostField(name: string, value: string): void {
  const lowered = value.toLowerCase();
  if (!LOOPBACK_HOSTS.has(lowered) && !HOSTNAME_RE.test(lowered)) {
    throw new Error(`${name} must be a valid hostname`);
  }
}

/** Build a TangledContext from the runtime environment (or any
 * string-keyed mapping, so tests inject fixtures). Values are trimmed; an
 * empty value is absent. Throws when the required `TANGLED_REPO_DID`
 * (repository owner DID) is missing and when a supplied knot host or
 * Bobbin URL fails validation — the error names the offending variable. */
export function tangledContextFromEnv(env: Record<string, string | undefined>): TangledContext {
  const get = (name: string): string | undefined => {
    const value = (env[name] ?? "").trim();
    return value === "" ? undefined : value;
  };
  const ownerDid = get("TANGLED_REPO_DID");
  if (ownerDid === undefined) {
    throw new Error("platform 'tangled' requires TANGLED_REPO_DID (Tangled repository owner DID) to be set");
  }
  const knotHost = get("TANGLED_REPO_KNOT");
  if (knotHost !== undefined) validateHostField("TANGLED_REPO_KNOT", knotHost);
  const bobbinUrl = get("TANGLED_BOBBIN_URL");
  if (bobbinUrl !== undefined) validateUrlField("TANGLED_BOBBIN_URL", bobbinUrl);
  return {
    ownerDid,
    repoDid: get("TANGLED_REPO_REPO_DID"),
    repoName: get("TANGLED_REPO_NAME"),
    sourceBranch: get("TANGLED_PR_SOURCE_BRANCH"),
    targetBranch: get("TANGLED_PR_TARGET_BRANCH"),
    sourceSha: get("TANGLED_PR_SOURCE_SHA"),
    knotHost,
    bobbinUrl,
  };
}
