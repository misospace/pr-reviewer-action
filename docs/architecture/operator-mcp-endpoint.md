# Operator read-only MCP endpoint (#1349)

Design of `src/operator-mcp/`: the small, read-only MCP surface Operator mode
exposes so coding agents can inspect the reviewer's normalized state across
supported forges without forge-specific scraping. Like the event/job (#728),
queue (#731), acquisition (#732), executor (#733), credential (#735),
durable-state (#736), and admin (#737) layers before it, this is **a library
with a pure dispatcher and an injected deps seam — the daemon supplies every
piece of state and every authorization decision; the library owns none of
the state itself**. The daemon composition (#1348) can wire it onto the same
admin listener; nothing in the Action runtime reads or serves it.

This is an integration/read surface, not another review engine and not an
agent that edits code.

## Mount strategy (normative)

The endpoint mounts on the admin listener (`src/admin/server.ts`) under
`POST /mcp` as a SEPARATE authenticated namespace, configured through
`AdminHostOptions.mcp`:

- **Token separation is structural, not a check.** The MCP surface carries
  its OWN scoped capability token; the admin authenticator never sees a
  `/mcp` request and the MCP authenticator never sees an `/admin/*`
  request. A leaked admin token grants no MCP access and vice versa.
- **Fail closed on an unconfigured mount:** a host built without an MCP
  token serves `/mcp` with the fixed 404 any unknown path gets — the
  surface is not part of that deployment, never open, and its existence is
  not advertised to an unauthenticated caller. (Admin's unconfigured state
  answers `503` because "degraded control plane" is a state an operator
  must see; an absent MCP surface is simply not there.)
- `GET /mcp` answers a fixed `405`: v1 speaks JSON-RPC over plain POST
  bodies, no SSE stream, no session store. The endpoint is stateless —
  every request is self-contained, so there is no session state to leak or
  hijack.

Webhook routes stay on their own public listener exactly as #737 requires;
the MCP mount does not change that boundary and is guarded by the same
independence tests.

## Authentication and authorization

- Every request requires `Authorization: Bearer <token>`, compared in
  constant time (`timingSafeEqual` over SHA-256 digests) — the same
  discipline as the admin token. An empty or whitespace-only token is a
  construction error.
- The token is the **scoped operator/user capability** from #737's model:
  operator-issued, never repository-supplied, never a forge credential.
- **Authorization is checked per repository on EVERY call.** A repository-
  addressed call (`list_findings`, the repository form of
  `get_review_policy`) consults the injected `authorize` seam BEFORE any
  state is read; a denial is a fixed tool-level error plus an audit record.
  Identity-addressed reads (`get_review` by run/job id, the run form of
  `get_review_policy`) carry no repository argument, so the SEAM owns their
  authorization: the reference adapter proves the run's repository from the
  queue snapshot and refuses when it cannot — **the identifier itself never
  grants permission**, and a run whose repository cannot be proven is
  unread.
- **Audit without token material.** Denied authorization emits
  `{ atMs, requestId, target: { kind: "repository", id }, outcome:
  "refused" }` through the injected audit seam. Authentication failures are
  counted (a dedicated counter), not audited per-request, so a flooding
  client cannot drive unbounded audit writes. No log line, audit record, or
  error body ever contains token material or request content.
- Metrics stay bounded-cardinality by construction:
  `pr_reviewer_admin_mcp_requests_total` (label `outcome`, fixed enum
  `ok`/`denied`/`invalid`/`error`/`too_large`) and
  `pr_reviewer_admin_mcp_auth_failures_total` (zero-label, pre-created so
  it stays recordable when the series cap is full).

## The v1 tool table (read-only by construction)

| Tool | Arguments | Returns |
|---|---|---|
| `get_review` | `run_id` XOR `job_id` | One normalized review: controller identity, lifecycle state, verdict, `review_result`, required checks, projected findings, publication status, and the queue-proven PR identity |
| `list_findings` | `platform` + `repository` (required), `severity`/`category`/`path` filters, `limit`, `cursor` | Findings across a repository's reviews under keyset pagination |
| `get_review_policy` | `platform` + `repository` XOR `run_id` | The effective config fingerprint, adoption epoch, enabled flag, and provenance of the trusted source |

Every tool name begins with a read verb (the same read-verb discipline the
repo's own MCP client enforces at `src/tools/mcp.ts`). There is deliberately
NO mutation tool: no enqueue, cancel, rereview, config write, or anything
that could move control-plane state. A write tool can only enter through a
future contract change, never through a caller's request.

Arguments are validated and REBUILT before they reach the seam: unknown
argument names are dropped, a present-but-invalid value invalidates the
whole call (a silently ignored filter would widen the result set the caller
believes it asked for), and every identifier is bounded, trimmed, and
control-char-free. `..` segments are refused in repository and path filters.

## Payload projection (what a review exposes)

The publication record's `resultPayload` is the canonical JSON encoding of
the worker's normalized review result. Its exact schema is worker-defined
(the #733 image contract names the artifact; the publisher validates only
canonical, secret-free JSON), so `parsePayloadProjection` is
ALLOWLIST-BASED and degrades gracefully:

- `verdict` is exposed only as one of `approve`/`request_changes`/
  `comment`/`blocked`; `review_result` only as `issues`/`partial`/
  `findings`/`clean`; required checks only as bounded check names (≤ 32).
- `findings` entries must be objects with string `path`/`severity`/
  `category` and an optional non-negative integer `line`; anything else is
  DROPPED, never normalized. At most `MAX_MCP_FINDINGS_PER_REVIEW` (200)
  findings are projected per review.
- Message text is untrusted model-authored content: it is bounded BEFORE
  redaction runs (`MAX_MCP_MESSAGE_CHARS`), control/format characters are
  stripped, and the shared redaction passes apply — the context redactor
  plus the credential-shape redactor shared with the admin surface
  (`src/context/secret-shape.ts`, one implementation, no vocabulary drift).

The published review body is the content the controller already wrote to
the forge; the projection narrows it to structure. What the surface NEVER
exposes: raw provider credentials, worker secrets, complete prompts or
corpora, arbitrary repository-file reads, or hidden chain-of-thought and
transcripts. Durable control-plane records cannot carry these (#736's
"do not persist" list), and the projection adds a second, independent
boundary in front of the one surface that reads them.

### Finding outcomes (#1027)

v1 findings carry `status: "open"` only. The #1027 outcome/usefulness
contract deliberately distinguishes usefulness, dismissal, resolution, and
human adjudication — the surface will not collapse them or guess a state
it cannot prove. Outcome filters and per-finding outcome states are
explicitly deferred until operator-mode outcome persistence lands (the
#1027 operator persistence boundary requires per-repository/forge/tenant
partitioning before ledgers can be merged).

## Limits

- **Request body cap** (default 64 KiB) → fixed `413`; an oversized body is
  discarded while streaming and never parsed.
- **Response cap** (default 256 KiB, serialized): a tool result that
  serializes larger is refused as a fixed JSON-RPC error `-32003
  "response too large"` — never truncated into a partial document, never
  silently clipped mid-finding.
- **Pagination**: `limit` is 1–100 (default 25); the cursor is an opaque,
  validated base64url keyset-plus-offset record (job id + finding offset).
  A cursor that does not decode, names an unknown job, or carries a
  negative offset yields an EMPTY page — a pagination boundary can never
  widen into an unfiltered read. The reference adapter scans at most 500
  queue jobs per call.
- No total-count field: a cross-PR count is unbounded work the endpoint
  refuses to do speculatively.

## Store-backed reference adapter

`buildStoreBackedMcpDeps({ controlPlane, queue })` composes the #736
control-plane store and the #731 queue snapshot into the deps seam:

- The queue snapshot supplies the forge identity join (`ReviewJob` carries
  platform/repository/PR number; the durable run record does not).
- The default `authorize` requires the repository to appear as an ADOPTED
  record for the platform in the control plane. `enabled` gates SCHEDULING,
  not read access — the adoption record is the operator's past decision,
  and its own metadata (including `enabled=false`) is exactly what a
  read-only policy surface may report.
- Throwing store reads degrade to absent data (not-found), never to
  permission; a thrown authorize is always a denial.

The adapter is a reference composition: a PostgreSQL backend should push
the joins into SQL rather than scan. It is also an honest statement of
scope — policy `configRef` stays empty rather than inventing a trusted
source it does not join (#727 owns that reference).

## Testing posture

- `tests-v3/mcp-jsonrpc.test.ts` — framing: parse errors, batch refusal,
  id-echo rules (a hostile object id becomes null, never echoed),
  protocol-version sanitization.
- `tests-v3/mcp-tools.test.ts` — the three tools over the store-backed
  adapter: validators (bounded ids, traversal refusals, limit/cursor
  grammar, exactly-one-id rules), allowlist projection (non-conforming
  findings dropped, message bound + redaction of credential shapes, control
  characters stripped, per-review cap), per-repository authorization on
  every call (including identity-addressed reads refusing unprovable
  repositories), keyset pagination with stale/corrupted cursors yielding
  empty pages, filters, audit-on-denial without token material, and fixed
  error messages that never leak exception text.
- `tests-v3/admin-metrics.test.ts` — the two new counters keep the
  bounded-cardinality discipline (pre-created auth-failure counter stays
  recordable when the cap is full; outcomes render through the fixed enum).
- `tests-v3/mcp-host.test.ts` — over real HTTP on an ephemeral port: the
  full MCP client flow (initialize → initialized → tools/list →
  tools/call), structural token separation BOTH ways, the unconfigured
  404, GET 405, content-type 415, body cap 413, garbage body -32700, batch
  -32600, unknown method -32601, unknown tool -32602, invalid arguments as
  a tool-level error, denial + audit over the wire, metrics counters
  observed through `GET /metrics`, the response-byte cap, and #252-style
  hostile inputs (traversal arguments, hostile ids) never echoing into
  responses.

## Out of scope

Wiring the host into the daemon composition (the admin listener itself is
not yet wired; the deployment composition owns it), SSE/streaming and
resource/prompt MCP capabilities, outcome/usefulness filters (#1027
operator persistence), any mutation tool (v1 and beyond until a contract
change says otherwise), and any UI (#742 consumes this surface).
