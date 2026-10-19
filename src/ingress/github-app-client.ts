// GitHub App capability client for the post-v3 self-hosted ingress (#729): the
// read AND write seam for one App installation.
//
// THE POINT OF THIS MODULE: every forge read and write goes through the
// configured forge CAPABILITY, not a forge-specific CLI. The App credential
// LIFECYCLE cannot be owned by `gh` (or `gj`, or any forge CLI): a CLI can
// *carry* a supplied token (`GH_TOKEN` accepts even a minted installation
// token), but it cannot mint the App RS256 JWT from the private key, run the
// installation-token mint/refresh lifecycle, or keep the credential scoped to
// exactly the repository each call names. The minting authority lives in the
// controller process, so the App path gets its own client, and there is
// deliberately NO `child_process` import, no `gh`/`gj`/`forge` invocation, and no
// shell-out of any kind anywhere in this file: every request is issued through
// `platform/http.ts`'s `requestJson`, pinned to the validated API origin, with a
// short-lived repository-scoped installation token in the Authorization header.
//
// Security invariants (same discipline as `api-client.ts`, #730):
// - the credential is resolved per call through `GitHubAppAuthenticator` and
//   scoped to exactly the repository the call names, so no token is ever minted
//   (or reused) across repositories;
// - the credential travels ONLY as `Authorization: Bearer <token>` — never in a
//   URL, query string, or request body;
// - every URL is repo-scoped through `repoScopedUrl` (the ONE repo-ref
//   validator), so a traversal repo ref or a hostile sha/context/id cannot
//   escape `/repos/<owner>/<name>`;
// - non-2xx and transport failures map to FIXED, credential-free error strings.
//   A hostile or reflecting server that echoes the token back in a body cannot
//   get it out through a returned error.
//
// PUBLICATION IDEMPOTENCY (#729): `upsertIssueComment` locates the existing
// managed comment by its marker and PATCHes it; it only POSTs when no managed
// comment exists. A retry after a partial publication failure therefore
// converges on ONE comment instead of duplicating the managed output.
//
// OWNED OUTPUT ONLY (#729: "own-comment/review identity cannot be spoofed by PR
// author"): the marker is body content, and body content is forgeable — the PR
// author can post the marker themselves. So a located marker comment is only a
// PATCH candidate when the PROVEN App identity authored it (the same
// proven-owner rule `src/platform/publish-api.ts` applies, over the same
// `owner-identity.ts` matcher); an unprovable identity, or a marker comment this
// seam does not own, fails closed instead of overwriting a foreign comment or
// duplicating the managed output beside it.
import { PlatformRequestError, requestJson, type FetchLike, type RequestOptions } from "../platform/http.js";
import { ownerMatchesIdentity, type TrustedOwnerIdentity } from "../platform/owner-identity.js";
import { repoScopedUrl } from "../platform/repo-ref.js";
import { requireCapability } from "./capabilities.js";
import { GitHubAppAuthenticator, isValidInstallationId } from "./github-app-auth.js";
import type { ReadResult } from "./api-client.js";

/** The write-side result. Same discipline as the shared `ReadResult<T>` in
 * `api-client.ts` — `ok` discriminates, and the error text is a fixed,
 * credential-free string. */
export type WriteResult =
  | { readonly ok: true; readonly created: boolean; readonly id: number | null }
  | { readonly ok: false; readonly error: string };

export interface GitHubAppCapabilityClientOptions {
  /** API base (`https://api.github.com`, or a GHE `<host>/api/v3`). Validated
   * by the authenticator's constructor before any credential is bound. */
  readonly apiBaseUrl: string;
  readonly appId: string;
  readonly privateKeyPem: string;
  /** The installation whose credentials this client uses for every call. */
  readonly installationId: string;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly now?: (() => number) | undefined;
}

/** Bounded pagination for the open-PR reconciliation listing. Mirrors
 * `api-client.ts`: a short page ends the walk, exhausting the bound FAILS
 * instead of silently truncating. */
const PR_PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Bounded pagination when locating the managed comment. */
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 10;

/** GitHub's own comment body ceiling; anything larger is refused rather than
 * posted and rejected. */
const MAX_COMMENT_BYTES = 65_536;
const MAX_MARKER_CHARS = 512;
const MAX_CONTEXT_CHARS = 100;
const MAX_REQUEST_BYTES = 262_144;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** Same, but permitting the horizontal-tab and line-break bytes a markdown body
 * legitimately carries. Bodies are JSON-encoded, so a line break there cannot
 * inject anything; single-line fields (marker, context, path) keep the stricter
 * `CONTROL_RE`. */
const BODY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Commit sha shape used in a URL path: hex only, so a sha can never carry a
 * path separator or query marker. */
const SHA_RE = /^[0-9a-f]{7,64}$/i;
const COMMIT_STATES: ReadonlySet<string> = new Set(["error", "failure", "pending", "success"]);
const REVIEW_EVENTS: ReadonlySet<string> = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
const CHECK_RUN_STATUSES: ReadonlySet<string> = new Set(["queued", "in_progress", "completed"]);
const CHECK_RUN_CONCLUSIONS: ReadonlySet<string> = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "success",
  "skipped",
  "stale",
  "timed_out",
]);

/** A review payload: the pinned `commitId`, an optional `event`, an optional
 * `body`, and an optional list of inline `comments`. Kept as an explicit shape
 * (rather than `unknown`) so the written body is built by this module from
 * typed values only. */
export interface ReviewPayload {
  /** The exact head SHA the review was computed against, transmitted as the
   * endpoint's `commit_id`. REQUIRED, not defaulted: GitHub's create-review
   * endpoint falls back to the PR's CURRENT head when `commit_id` is absent,
   * so an unpinned review could publish an APPROVE/REQUEST_CHANGES computed
   * for one commit onto a newer, never-reviewed head. Pinning is enforced
   * here; the future publisher must still re-check the exact PR head just
   * before publication. */
  readonly commitId: string;
  readonly event?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | undefined;
  readonly body?: string | undefined;
  readonly comments?: readonly ReviewCommentPayload[] | undefined;
}

export interface ReviewCommentPayload {
  readonly path: string;
  readonly body: string;
  readonly line?: number | undefined;
  readonly side?: "LEFT" | "RIGHT" | undefined;
}

/** A check-run payload (`POST /repos/{owner}/{repo}/check-runs`). */
export interface CheckRunPayload {
  readonly name: string;
  readonly headSha: string;
  readonly status: "queued" | "in_progress" | "completed";
  readonly conclusion?: string | undefined;
  readonly detailsUrl?: string | undefined;
}

interface SendSpec {
  readonly repo: string;
  readonly method: string;
  readonly url: string | null;
  readonly body?: string | undefined;
}

type SendResult =
  | { readonly ok: true; readonly status: number; readonly data: unknown }
  | { readonly ok: false; readonly error: string };

/**
 * One installation's read+write capability over the GitHub REST API.
 *
 * Holds no credential: each call asks the authenticator for a live, repo-scoped
 * installation token and throws it away with the request. There is no
 * process-level state to leak, and no second store of secret material.
 */
export class GitHubAppCapabilityClient {
  readonly authenticator: GitHubAppAuthenticator;
  readonly installationId: string;
  readonly apiBase: string;
  readonly origin: string;

  #timeoutMs: number | undefined;
  #fetchImpl: FetchLike | undefined;

  constructor(opts: GitHubAppCapabilityClientOptions) {
    // The authenticator validates the API base FIRST (origin binding before any
    // credential is bound); the client then reuses that one validated origin
    // instead of validating the URL a second time.
    this.authenticator = new GitHubAppAuthenticator({
      apiBaseUrl: opts.apiBaseUrl,
      appId: opts.appId,
      privateKeyPem: opts.privateKeyPem,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    });
    this.apiBase = this.authenticator.apiBase;
    this.origin = this.authenticator.origin;
    if (!isValidInstallationId(opts.installationId)) {
      throw new Error("invalid GitHub App installation id");
    }
    this.installationId = opts.installationId;
    this.#timeoutMs = opts.timeoutMs;
    this.#fetchImpl = opts.fetchImpl;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * List the repository's open pull requests, walking bounded pages.
   *
   * Fails LOUDLY when the page bound is exhausted: a silently truncated list
   * would make reconciliation believe a repository has fewer open PRs than it
   * does, which is the same class of bug as a missed webhook.
   */
  async listOpenPullRequests(repo: string): Promise<ReadResult<unknown[]>> {
    const combined: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = repoScopedUrl(
        this.apiBase,
        repo,
        "/pulls",
        `?state=open&per_page=${PR_PAGE_SIZE}&page=${page}`,
      );
      const result = await this.#read("list open pull requests", {
        repo,
        method: "GET",
        url,
      });
      if (result.ok === false) return result;
      if (!Array.isArray(result.data)) return { ok: false, error: "unexpected response" };
      combined.push(...(result.data as unknown[]));
      if (result.data.length < PR_PAGE_SIZE) return { ok: true, data: combined };
    }
    return { ok: false, error: "open pull request list exceeded reconciliation bound" };
  }

  /** Fetch a single pull request by number. The number is validated as a
   * positive safe integer before it can reach a URL path. */
  async getPullRequest(repo: string, prNumber: number): Promise<ReadResult<unknown>> {
    if (!isPrNumber(prNumber)) return { ok: false, error: "invalid PR number" };
    return this.#read("get pull request", {
      repo,
      method: "GET",
      url: repoScopedUrl(this.apiBase, repo, "/pulls", `/${prNumber}`),
    });
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Create or update the managed (sticky) review comment.
   *
   * IDEMPOTENCY: the existing managed comment is located by `marker` — the same
   * marker identity the production publisher uses — and PATCHed, but only when
   * the proven App identity authored it (see `#findManagedComment`). A POST
   * happens only when no managed comment exists, so retrying after a partial
   * publication failure converges on one comment instead of duplicating the
   * managed output. An author-posted marker is never overwritten: that fails
   * closed instead.
   *
   * The body MUST carry the marker. A comment published without one cannot be
   * located by the next run, so every publication would duplicate — the caller
   * cannot opt out of the idempotency contract this method advertises.
   */
  async upsertIssueComment(repo: string, prNumber: number, marker: string, body: string): Promise<WriteResult> {
    if (!isPrNumber(prNumber)) return { ok: false, error: "invalid PR number" };
    if (!isUsableMarker(marker)) return { ok: false, error: "invalid comment marker" };
    if (typeof body !== "string" || body.trim() === "" || Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
      return { ok: false, error: "invalid comment body" };
    }
    if (!body.includes(marker)) {
      return { ok: false, error: "comment body does not carry the managed marker" };
    }

    const existing = await this.#findManagedComment(repo, prNumber, marker);
    if (!existing.ok) return existing;
    if (existing.commentId !== null) {
      const url = repoScopedUrl(this.apiBase, repo, "/issues/comments", `/${existing.commentId}`);
      return this.#write("update managed comment", {
        repo,
        method: "PATCH",
        url,
        body: JSON.stringify({ body }),
      });
    }
    const url = repoScopedUrl(this.apiBase, repo, "/issues", `/${prNumber}/comments`);
    return this.#write("create managed comment", {
      repo,
      method: "POST",
      url,
      body: JSON.stringify({ body }),
    });
  }

  /** Publish a native review on a pull request.
   *
   * The payload's `commitId` is REQUIRED and transmitted as `commit_id`: the
   * review is bound to the exact head SHA it was computed for, so a PR that
   * moved between review computation and submission cannot receive a verdict
   * computed for an older commit (GitHub otherwise defaults to the CURRENT
   * head). An omitted, malformed, or hostile SHA fails closed with no POST —
   * the future publisher must additionally re-check the exact PR head just
   * before publication. */
  async createReview(repo: string, prNumber: number, payload: ReviewPayload): Promise<WriteResult> {
    if (!isPrNumber(prNumber)) return { ok: false, error: "invalid PR number" };
    const encoded = encodeReviewPayload(payload);
    if (typeof encoded !== "string") return { ok: false, error: "invalid review payload" };
    return this.#write("create review", {
      repo,
      method: "POST",
      url: repoScopedUrl(this.apiBase, repo, "/pulls", `/${prNumber}/reviews`),
      body: encoded,
    });
  }

  /** Create a commit status on `headSha`. */
  async createCommitStatus(
    repo: string,
    headSha: string,
    state: string,
    context: string,
  ): Promise<WriteResult> {
    if (!SHA_RE.test(headSha)) return { ok: false, error: "invalid commit sha" };
    if (!COMMIT_STATES.has(state)) return { ok: false, error: "invalid commit state" };
    if (!isBoundedText(context, MAX_CONTEXT_CHARS)) return { ok: false, error: "invalid status context" };
    return this.#write("create commit status", {
      repo,
      method: "POST",
      url: repoScopedUrl(this.apiBase, repo, "/statuses", `/${headSha.toLowerCase()}`),
      // `context` travels in the JSON body only — never in the URL.
      body: JSON.stringify({ state, context }),
    });
  }

  /**
   * Create a check run. Gated through `requireCapability("github", "checkRuns")`
   * so the capability matrix stays the single declaration of what the platform
   * supports; a refused capability is reported before any network call and never
   * as a forge failure.
   */
  async createCheckRun(repo: string, payload: CheckRunPayload): Promise<WriteResult> {
    const capability = requireCapability("github", "checkRuns");
    if (capability.ok === false) return { ok: false, error: capability.degradation };
    const encoded = encodeCheckRunPayload(payload);
    if (typeof encoded !== "string") return { ok: false, error: "invalid check run payload" };
    return this.#write("create check run", {
      repo,
      method: "POST",
      url: repoScopedUrl(this.apiBase, repo, "/check-runs"),
      body: encoded,
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Locate the newest managed comment carrying `marker`, bounded to
   * MAX_COMMENT_PAGES pages. Returns `{ ok: true, commentId: null }` when no
   * managed comment exists (the create path). A list failure is propagated so a
   * failed lookup can never be mistaken for "no comment exists" — that would
   * turn a read failure into a duplicate POST.
   *
   * OWNERSHIP IS PROVEN, NOT ASSUMED (#729: "own-comment/review identity cannot
   * be spoofed by PR author"). A marker is forgeable — the PR author can post the
   * marker in their own comment — so a located marker comment is only a PATCH
   * candidate when the proven App identity authored it. Three outcomes:
   * - identity unprovable → FAIL CLOSED: no PATCH and no POST, because we cannot
   *   tell our comment from the author's and a wrong choice either overwrites
   *   someone else's text or duplicates the managed output;
   * - a proven-owned match → PATCH it;
   * - marker matches that are foreign-authored or carry no forge-reported author
   *   → FAIL CLOSED rather than POST a second managed comment beside them.
   */
  async #findManagedComment(
    repo: string,
    prNumber: number,
    marker: string,
  ): Promise<{ readonly ok: true; readonly commentId: number | null } | { readonly ok: false; readonly error: string }> {
    let identity: TrustedOwnerIdentity;
    try {
      const login = await this.authenticator.appIdentity();
      // Same rule as the production publisher: an unproven identity is not
      // treated as trusted.
      if (login === null) return { ok: false, error: "managed comment owner could not be verified" };
      identity = { kind: "login", login };
    } catch {
      return { ok: false, error: "managed comment owner could not be verified" };
    }

    let best: { readonly id: number; readonly updatedAt: string } | null = null;
    let foreignMarker = false;
    let exhausted = false;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const url = repoScopedUrl(
        this.apiBase,
        repo,
        "/issues",
        `/${prNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
      );
      const result = await this.#read("list issue comments", { repo, method: "GET", url });
      if (result.ok === false) return result;
      if (!Array.isArray(result.data)) return { ok: false, error: "unexpected response" };
      for (const entry of result.data as readonly unknown[]) {
        if (typeof entry !== "object" || entry === null) continue;
        const comment = entry as {
          readonly id?: unknown;
          readonly body?: unknown;
          readonly updated_at?: unknown;
          readonly user?: { readonly login?: unknown; readonly id?: unknown } | null;
        };
        if (typeof comment.body !== "string" || !comment.body.includes(marker)) continue;
        if (typeof comment.id !== "number" || !Number.isSafeInteger(comment.id)) continue;
        // A marker comment this seam does not own is recorded as a blocker. When
        // a proven-owned match is ALSO present, the owned one remains the patch
        // target — a foreign marker alongside it does not suppress a legitimate
        // update (that would hand the PR author a way to freeze the managed
        // comment permanently). The blocker only applies when no owned match
        // exists, which is exactly the `best === null` case below.
        if (!ownerMatchesIdentity(comment.user, identity)) {
          foreignMarker = true;
          continue;
        }
        const updatedAt = typeof comment.updated_at === "string" ? comment.updated_at : "";
        if (best === null || updatedAt > best.updatedAt) best = { id: comment.id, updatedAt };
      }
      if (result.data.length < COMMENT_PAGE_SIZE) {
        exhausted = false;
        break;
      }
      exhausted = true;
    }
    // Loud failure, never a silent "not found": exhausting the page bound means
    // the managed comment may sit on a page this loop never fetched, and
    // reporting "absent" would turn the bound into a DUPLICATE managed comment —
    // the one outcome the idempotency contract exists to prevent. GitHub returns
    // issue comments oldest-first, so the comment we just published is the one on
    // the last page, i.e. precisely the one truncation hides.
    if (exhausted) {
      return { ok: false, error: "managed comment lookup exceeded paging bound" };
    }
    if (best === null && foreignMarker) {
      return { ok: false, error: "managed comment ownership is unknown" };
    }
    return { ok: true, commentId: best === null ? null : best.id };
  }

  /** Resolve a live, repo-scoped installation token and issue the request. The
   * only place the Authorization header is built. */
  async #send(spec: SendSpec): Promise<SendResult> {
    if (spec.url === null) return { ok: false, error: "invalid repository" };
    let token: string;
    try {
      const auth = await this.authenticator.installationToken(this.installationId, {
        // Scope the credential to exactly the repository this call touches.
        repositories: [spec.repo],
      });
      if (auth.ok === false) return { ok: false, error: auth.reason };
      token = auth.data.token;
    } catch {
      return { ok: false, error: "github app authentication failed" };
    }

    const requestOptions: RequestOptions = {
      method: spec.method,
      token: `Bearer ${token}`,
      allowedOrigin: this.origin,
    };
    if (spec.body !== undefined) requestOptions.body = spec.body;
    if (this.#timeoutMs !== undefined) requestOptions.timeoutMs = this.#timeoutMs;
    if (this.#fetchImpl !== undefined) requestOptions.fetchImpl = this.#fetchImpl;

    try {
      const { status, data } = await requestJson(spec.url, requestOptions);
      return { ok: true, status, data };
    } catch (error) {
      // FIXED string only: the thrown message can carry transport internals, and
      // a hostile response must never be able to place bytes in a returned error.
      if (error instanceof PlatformRequestError) return { ok: false, error: "github app request failed" };
      return { ok: false, error: "github app request failed" };
    }
  }

  async #read(label: string, spec: SendSpec): Promise<ReadResult<unknown>> {
    const sent = await this.#send(spec);
    if (sent.ok === false) return sent;
    if (sent.status < 200 || sent.status >= 300) {
      return { ok: false, error: `${label} returned ${sent.status}` };
    }
    return { ok: true, data: sent.data };
  }

  async #write(label: string, spec: SendSpec): Promise<WriteResult> {
    const sent = await this.#send(spec);
    if (sent.ok === false) return sent;
    if (sent.status < 200 || sent.status >= 300) {
      return { ok: false, error: `${label} returned ${sent.status}` };
    }
    return { ok: true, created: spec.method === "POST", id: idOf(sent.data) };
  }
}

// ── payload validation ──────────────────────────────────────────────────────

function isPrNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isBoundedText(value: string, maxChars: number): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= maxChars &&
    !CONTROL_RE.test(value)
  );
}

/** Byte-bounded variant, for every value whose limit is a WIRE ceiling rather
 * than a field-length bound. Comment/review bodies are limited in bytes
 * everywhere (GitHub's own comment limit, `MAX_REQUEST_BYTES`), so bounding a
 * body in characters would let a multi-byte payload through at several times
 * the intended size.
 *
 * Bodies permit newline and tab — a markdown review comment is multi-line by
 * definition, and the body is JSON-encoded, so a newline inside it cannot inject
 * a header or a second request. Every other C0/DEL byte is still refused. */
function isBoundedBytes(value: string, maxBytes: number): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !BODY_CONTROL_RE.test(value)
  );
}

function isUsableMarker(marker: string): boolean {
  return isBoundedText(marker, MAX_MARKER_CHARS);
}

/** Serialize a review payload from typed values, or return null when any field
 * is out of bounds. The body is built HERE, so no caller string ever becomes a
 * URL or an unvalidated request body. */
function encodeReviewPayload(payload: ReviewPayload): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  // `commit_id` pinning is a hard contract, not a default: without it GitHub
  // would attach the review to whatever head the PR has at submission time.
  // Same shape the URL path uses for shas (hex only, 7-64 chars), so a hostile
  // or absent SHA is rejected before anything is built.
  if (typeof payload.commitId !== "string" || !SHA_RE.test(payload.commitId)) return null;
  const event = payload.event ?? "COMMENT";
  if (!REVIEW_EVENTS.has(event)) return null;
  const body: Record<string, unknown> = { event, commit_id: payload.commitId };
  if (payload.body !== undefined) {
    if (!isBoundedBytes(payload.body, MAX_COMMENT_BYTES)) return null;
    body.body = payload.body;
  }
  if (payload.comments !== undefined) {
    if (!Array.isArray(payload.comments)) return null;
    const comments: Record<string, unknown>[] = [];
    for (const comment of payload.comments as readonly ReviewCommentPayload[]) {
      if (typeof comment !== "object" || comment === null) return null;
      if (!isBoundedText(comment.path, 1024) || !isBoundedBytes(comment.body, MAX_COMMENT_BYTES)) return null;
      const entry: Record<string, unknown> = { path: comment.path, body: comment.body };
      if (comment.line !== undefined) {
        if (!isPrNumber(comment.line)) return null;
        entry.line = comment.line;
      }
      if (comment.side !== undefined) {
        if (comment.side !== "LEFT" && comment.side !== "RIGHT") return null;
        entry.side = comment.side;
      }
      comments.push(entry);
    }
    if (comments.length > 50) return null;
    body.comments = comments;
  }
  return boundedJson(body);
}

function encodeCheckRunPayload(payload: CheckRunPayload): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  if (!isBoundedText(payload.name, MAX_CONTEXT_CHARS)) return null;
  if (typeof payload.headSha !== "string" || !SHA_RE.test(payload.headSha)) return null;
  if (!CHECK_RUN_STATUSES.has(payload.status)) return null;
  if (payload.conclusion !== undefined && !CHECK_RUN_CONCLUSIONS.has(payload.conclusion)) return null;
  if (payload.status === "completed" && payload.conclusion === undefined) return null;
  if (payload.detailsUrl !== undefined && (!isBoundedText(payload.detailsUrl, 2048) || !/^https:\/\//.test(payload.detailsUrl))) {
    return null;
  }
  const body: Record<string, unknown> = {
    name: payload.name,
    head_sha: payload.headSha.toLowerCase(),
    status: payload.status,
  };
  if (payload.conclusion !== undefined) body.conclusion = payload.conclusion;
  if (payload.detailsUrl !== undefined) body.details_url = payload.detailsUrl;
  return boundedJson(body);
}

/** JSON-encode with a hard byte ceiling, so no caller-supplied payload can grow
 * an unbounded request body. Returns null when the payload cannot be encoded. */
function boundedJson(value: unknown): string | null {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) return null;
  return encoded;
}

/** The numeric id of a created/updated resource, or null when the response
 * carries no usable id (the write still succeeded). */
function idOf(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const id = (data as { readonly id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}