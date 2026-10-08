import { PlatformRequestError, requestBytes, requestJson, type FetchLike } from "./http.js";

/**
 * Read-only AT-Protocol blob client for Tangled pull rounds (#586).
 *
 * Tangled pull rounds reference gzipped git-format-patch blobs that live in
 * the pull AUTHOR's PDS (not in Bobbin). This module is the read path for
 * those blobs: it resolves the author's PDS endpoint from the author's
 * public DID document, then fetches the blob by CID over the PDS's public
 * `com.atproto.sync.getBlob` XRPC surface. Nothing here publishes, updates,
 * or deletes anything — every request is a read-only GET.
 *
 * Credential policy: the DID document is public metadata and its request
 * is NEVER authenticated. The `getBlob` request MAY carry a caller-supplied
 * token, only as the Authorization header bound to the validated PDS origin
 * (via `requestBytes`'s `allowedOrigin`), never in the URL, argv, or
 * diagnostics.
 *
 * Credential boundary (pinned): the resolved PDS endpoint is author-resolved
 * metadata. `https` endpoints keep the token; a plaintext `http` endpoint —
 * accepted here only for loopback hosts — is public by construction, so the
 * token is dropped silently before the request and never delivered over an
 * unencrypted channel. Public blob reads are unauthenticated.
 *
 * DID resolution is deliberately narrow and fails closed:
 * - `did:plc` resolves through the PLC directory (`https://plc.directory/<did>`);
 * - `did:web` resolves through the host's `.well-known/did.json`
 *   (`https://<host>[:port]/.well-known/did.json`); an explicit port is
 *   allowed, embedded path characters are not;
 * - the accepted DID subset is exactly `did:plc` / `did:web`, with no `/`,
 *   `?`, `#`, `%`, `\`, or whitespace in the method-specific id; spec-legal
 *   percent-encoded did:web ports (`did:web:example.com%3A8443`) are
 *   deliberately rejected fail-closed, while a plain `host:port` id is
 *   accepted;
 * - every other DID method is rejected as "invalid-did";
 * - a DID document whose `id` does not exactly match the requested DID is
 *   corrupt or hostile and is rejected, never trusted;
 * - the resolved PDS endpoint must be `https`, with plaintext `http`
 *   accepted for loopback hosts only (mirroring `tangled.ts`).
 *
 * Raw AT-Protocol wire shapes (DID documents, `getBlob` responses) stay
 * behind this boundary: callers only ever see a PDS endpoint string or the
 * raw blob bytes — never the wire objects.
 *
 * No new npm dependencies: this module is the stdlib `URL` parser plus the
 * shared `requestJson`/`requestBytes` transport.
 */

export type TangledBlobFailure =
  | "invalid-did"
  | "invalid-cid"
  | "pds-resolution-failed"
  | "read-failed"
  | "too-large";

export class TangledBlobError extends Error {
  readonly kind: TangledBlobFailure;

  constructor(kind: TangledBlobFailure, message: string) {
    super(message);
    this.name = "TangledBlobError";
    this.kind = kind;
  }
}

export const PLC_DIRECTORY_URL = "https://plc.directory";

/** Cap for a pull round's gzipped patch blob: 16 MiB. */
export const MAX_PATCH_BLOB_BYTES = 16 * 1024 * 1024;

export interface BlobFetchOptions {
  fetchImpl?: FetchLike | undefined;
  /** Optional PDS credential; Authorization header only, bound to the resolved PDS origin. */
  token?: string | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

/** Plaintext http is accepted for these hosts only (local test instances).
 * Mirrors `tangled.ts`'s loopback policy. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// The method-specific id is non-empty and must contain none of /, ?, #, %,
// backslash, or whitespace — exactly the characters that let a DID smuggle a
// path/query/fragment past the `did:method:` prefix (e.g.
// `did:plc:abc/../admin` reaching `https://plc.directory/admin`). Fail
// closed before any URL is built.
const DID_RE = /^did:(plc|web):([^\/?#%\\\s]+)$/;

const WEB_HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The `#atproto_pds` service entry in a DID document. */
const PDS_SERVICE_ID = "#atproto_pds";
const PDS_SERVICE_TYPE = "AtprotoPersonalDataServer";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Split a DID into method + method-specific-id. Every malformation is a
 * "invalid-did" whose message names the offending method when there is one. */
function parseDid(did: string): { method: "plc" | "web"; methodSpecificId: string } {
  const match = DID_RE.exec(did);
  if (match !== null) {
    return { method: match[1] as "plc" | "web", methodSpecificId: match[2]! };
  }
  const method =
    did.startsWith("did:") && did.indexOf(":", 4) !== -1 ? did.slice(4, did.indexOf(":", 4)) : undefined;
  if (method === "plc" || method === "web") {
    const id = did.slice(did.indexOf(":", 4) + 1);
    if (id === "") {
      throw new TangledBlobError("invalid-did", `DID has an empty method-specific id: ${did}`);
    }
    throw new TangledBlobError(
      "invalid-did",
      `DID method-specific id must not contain /, ?, #, %, \\, or whitespace: ${did}`,
    );
  }
  if (method !== undefined) {
    throw new TangledBlobError(
      "invalid-did",
      `unsupported DID method '${method}' (only did:plc and did:web are resolvable): ${did}`,
    );
  }
  throw new TangledBlobError("invalid-did", `invalid DID (expected did:plc:<id> or did:web:<host>): ${did}`);
}

/** A did:web method-specific-id is `host[:port]`: a hostname or IPv4
 * literal (octets <= 255), an optional port in 1..65535, and nothing else
 * (no embedded path, query, or fragment characters). All-numeric hosts that
 * are not a 4-octet IPv4 literal are rejected too, so a numeric label can
 * never masquerade as a hostname. Fail closed on anything else. */
function didWebHost(did: string, methodSpecificId: string): string {
  const colon = methodSpecificId.indexOf(":");
  const host = colon === -1 ? methodSpecificId : methodSpecificId.slice(0, colon);
  const port = colon === -1 ? undefined : methodSpecificId.slice(colon + 1);
  if (host === "") {
    throw new TangledBlobError("invalid-did", `invalid did:web DID (empty host): ${did}`);
  }
  const allNumeric = /^\d+(?:\.\d+)*$/.test(host);
  const hostOk =
    isIPv4Literal(host) ||
    (!allNumeric && host.split(".").every((label) => label !== "" && WEB_HOST_LABEL_RE.test(label)));
  if (!hostOk) {
    throw new TangledBlobError("invalid-did", `invalid did:web host (only hostnames and IPv4 literals are supported): ${did}`);
  }
  if (port !== undefined && !validDidWebPort(port)) {
    throw new TangledBlobError("invalid-did", `invalid did:web port (must be an integer in 1-65535): ${did}`);
  }
  return port === undefined ? host : `${host}:${port}`;
}

/** IPv4 literal with every octet <= 255 (e.g. `999.999.999.999` fails). */
function isIPv4Literal(host: string): boolean {
  const match = IPV4_RE.exec(host);
  if (match === null) return false;
  return [match[1], match[2], match[3], match[4]].every((octet) => Number(octet) <= 255);
}

/** Port in 1..65535: decimal digits only, no leading zeros, in range. */
function validDidWebPort(port: string): boolean {
  if (!/^[1-9]\d{0,4}$/.test(port)) return false;
  return Number(port) <= 65535;
}

/**
 * Resolve the author's PDS endpoint from their DID document.
 *
 * `did:plc` resolves through the PLC directory; `did:web` through the host's
 * `.well-known/did.json`. The DID document request is unauthenticated public
 * metadata: no token is ever sent. The document must be a JSON object whose
 * `id` exactly matches the requested DID, carry a `service` array, and
 * include an `#atproto_pds` entry (falling back to an
 * `AtprotoPersonalDataServer` type entry) whose `serviceEndpoint` is an
 * https URL — or http for a loopback host. Every other outcome (transport
 * failure, HTTP error, invalid JSON, mismatched id, missing or invalid
 * service) is a "pds-resolution-failed".
 */
export async function resolveAuthorPdsEndpoint(
  did: string,
  options?: { fetchImpl?: FetchLike | undefined; timeoutMs?: number | undefined } | undefined,
): Promise<string> {
  const { method, methodSpecificId } = parseDid(did);
  const docUrl =
    method === "plc"
      ? `${PLC_DIRECTORY_URL}/${did}`
      : `https://${didWebHost(did, methodSpecificId)}/.well-known/did.json`;
  let target: URL;
  try {
    target = new URL(docUrl);
  } catch (error) {
    // Defense in depth: the strict validation above should already have
    // rejected this, but anything the URL parser still refuses is a typed
    // resolution failure, never a raw TypeError.
    throw new TangledBlobError(
      "pds-resolution-failed",
      `DID document resolution failed for ${did}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let result: { status: number; data: unknown };
  try {
    result = await requestJson(target.toString(), {
      allowedOrigin: target.origin,
      fetchImpl: options?.fetchImpl,
      timeoutMs: options?.timeoutMs,
    });
  } catch (error) {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `DID document resolution failed for ${did}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `DID document lookup for ${did} returned HTTP ${result.status}`,
    );
  }
  const doc = asRecord(result.data);
  if (doc === undefined) {
    throw new TangledBlobError("pds-resolution-failed", `DID document for ${did} is not a JSON object`);
  }
  // A mismatched id means the document is corrupt or hostile (e.g. a
  // directory that served someone else's document); never trust it.
  if (doc.id !== did) {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `DID document served for ${did} does not match the requested DID`,
    );
  }
  const services = doc.service;
  if (!Array.isArray(services)) {
    throw new TangledBlobError("pds-resolution-failed", `DID document for ${did} has no service array`);
  }
  let service: Record<string, unknown> | undefined;
  for (const entry of services) {
    const record = asRecord(entry);
    if (record !== undefined && record.id === PDS_SERVICE_ID) {
      service = record;
      break;
    }
  }
  if (service === undefined) {
    for (const entry of services) {
      const record = asRecord(entry);
      if (record !== undefined && record.type === PDS_SERVICE_TYPE) {
        service = record;
        break;
      }
    }
  }
  if (service === undefined) {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `DID document for ${did} has no ${PDS_SERVICE_ID}/${PDS_SERVICE_TYPE} service entry`,
    );
  }
  const endpoint = typeof service.serviceEndpoint === "string" ? service.serviceEndpoint : undefined;
  if (endpoint === undefined || endpoint.trim() === "") {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `DID document for ${did} has a service entry without a usable serviceEndpoint`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TangledBlobError("pds-resolution-failed", `DID document for ${did} has a malformed PDS serviceEndpoint`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `PDS endpoint for ${did} must be an http(s) URL`,
    );
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `PDS endpoint for ${did} must be https (plaintext http is accepted for loopback hosts only)`,
    );
  }
  return endpoint.replace(/\/+$/, "");
}

/**
 * Fetch the pull round's blob by CID from the pull author's PDS
 * (read-only: `GET <pds>/xrpc/com.atproto.sync.getBlob?did=<did>&cid=<cid>`).
 *
 * The author's PDS is resolved first via `resolveAuthorPdsEndpoint`. The
 * request carries the token (if any) only as the Authorization header bound
 * to the resolved PDS origin, and the body is read through the shared
 * transport's hard byte cap (`options.maxBytes`, default
 * `MAX_PATCH_BLOB_BYTES`). The token never appears in the URL or in any
 * error message; messages may include the did, cid, and HTTP status.
 *
 * Credential boundary: the PDS endpoint is author-resolved. When it is
 * plaintext `http` (accepted only for loopback hosts), the token is dropped
 * silently — public blob reads are unauthenticated and a credential is never
 * delivered over an unencrypted channel. `https` keeps the token. A 2xx
 * zero-byte body is a "read-failed" empty-blob error, never a success.
 */
export async function fetchAtprotoBlob(
  did: string,
  cid: string,
  options?: BlobFetchOptions | undefined,
): Promise<Uint8Array> {
  parseDid(did);
  // A CID is an alphanumeric multibase string; anything with separators,
  // whitespace, or other characters is a malformation, not a (possibly
  // confusing) CID, so fail closed before any network call.
  if (!/^[A-Za-z0-9]+$/.test(cid)) {
    throw new TangledBlobError("invalid-cid", `invalid CID (expected an alphanumeric string): ${JSON.stringify(cid)}`);
  }
  const maxBytes = options?.maxBytes ?? MAX_PATCH_BLOB_BYTES;
  const pds = await resolveAuthorPdsEndpoint(did, {
    fetchImpl: options?.fetchImpl,
    timeoutMs: options?.timeoutMs,
  });
  let pdsUrl: URL;
  try {
    pdsUrl = new URL(pds);
  } catch {
    throw new TangledBlobError("pds-resolution-failed", `PDS endpoint for ${did} is not a valid URL`);
  }
  const target = new URL(`${pdsUrl.origin}/xrpc/com.atproto.sync.getBlob`);
  target.searchParams.set("did", did);
  target.searchParams.set("cid", cid);
  // Credential boundary: a plaintext http PDS endpoint (loopback-only) is
  // public — the token is dropped silently and never travels over http.
  const token = pdsUrl.protocol === "http:" ? undefined : options?.token;
  let result: { status: number; bytes: Uint8Array };
  try {
    result = await requestBytes(target.toString(), {
      allowedOrigin: pdsUrl.origin,
      fetchImpl: options?.fetchImpl,
      token,
      timeoutMs: options?.timeoutMs,
      accept: "application/octet-stream",
      maxBytes,
    });
  } catch (error) {
    if (error instanceof TangledBlobError) throw error;
    if (error instanceof PlatformRequestError) {
      if (error.kind === "too-large") {
        throw new TangledBlobError(
          "too-large",
          `blob ${cid} from the ${did} PDS exceeds the ${maxBytes}-byte cap`,
        );
      }
      // redirect-blocked / origin-mismatch / transport: the blob could not
      // be read, and none of these may be retried or worked around.
      throw new TangledBlobError("read-failed", `AT-Protocol blob read failed: ${error.message}`);
    }
    throw new TangledBlobError(
      "read-failed",
      `AT-Protocol blob read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.status === 404) {
    throw new TangledBlobError("read-failed", `blob not found: ${cid} (HTTP 404)`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new TangledBlobError("read-failed", `getBlob for ${cid} returned HTTP ${result.status}`);
  }
  if (result.bytes.byteLength === 0) {
    // No zero-byte success at the fetch boundary: an empty body means the
    // blob did not actually come back.
    throw new TangledBlobError("read-failed", `getBlob for ${cid} returned an empty blob (0 bytes)`);
  }
  return result.bytes;
}
