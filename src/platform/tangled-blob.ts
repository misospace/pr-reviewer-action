import { PlatformRequestError, requestBytes, requestJson, type FetchLike } from "./http.js";
import { isPublicAddress } from "./ip-policy.js";
import {
  resolvePublicAddresses,
  safeFetchLike,
  systemResolver,
  type AddressPolicy,
  type Resolver,
} from "./safe-fetch.js";

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
 * Credential policy (pinned): the PDS origin is author-selected metadata, so
 * NO credential is ever sent to an author-resolved origin. Both the DID
 * document request and the getBlob request are unauthenticated public reads
 * (auth: none); there is no token option anywhere on this module's API.
 *
 * SSRF policy (pinned): every network hop whose HOST comes from untrusted
 * (pull-author-controlled) metadata — (a) the did:web DID-document host and
 * (b) the resolved PDS serviceEndpoint host, for BOTH the did:plc and the
 * did:web paths — must resolve to PUBLIC addresses only, checked with
 * `resolvePublicAddresses` + `isPublicAddress` from the shared SSRF
 * infrastructure (`safe-fetch.ts` / `ip-policy.ts`) before any connection is
 * opened (a failed gate is a typed `pds-resolution-failed`; IP-literal hosts
 * are validated directly, no DNS). When no `fetchImpl` is injected, the
 * default transport for these requests is `safeFetchLike` from
 * `safe-fetch.ts`: the connection is pinned to the validated addresses at
 * the socket level (no DNS-rebinding window) and redirects are never
 * followed. Per hop the host is resolved twice deliberately, as defense in
 * depth: the explicit gate fails closed with a typed error before any
 * connect, and `safeFetchLike`'s pinned re-resolution closes the rebinding
 * window at connect time.
 *
 * The did:plc DID-document request itself goes to the constant,
 * operator-known origin `https://plc.directory` — a trusted platform
 * service, not author-controlled metadata — so no address gate applies to
 * that hop (the DID string is still strictly validated below against path
 * smuggling). It rides on the same `safeFetchLike` default transport as an
 * extra layer (pinned public-only resolution, no redirect following).
 *
 * The resolved PDS endpoint must be `https:` — plaintext `http` is refused
 * unconditionally. There is no loopback exception: a local test instance is
 * reachable through the test-only `resolver`/`addressPolicy` seams with an
 * `https` endpoint.
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
 * - the resolved PDS endpoint must be https, and its host must resolve to
 *   public addresses only;
 * - DID document responses are capped at `MAX_DID_DOCUMENT_BYTES` (1 MiB)
 *   by the default transport.
 *
 * Raw AT-Protocol wire shapes (DID documents, `getBlob` responses) stay
 * behind this boundary: callers only ever see a PDS endpoint string or the
 * raw blob bytes — never the wire objects.
 *
 * No new npm dependencies: this module is the stdlib `URL` parser plus the
 * shared `requestJson`/`requestBytes` transport and the shared
 * `safe-fetch.ts` SSRF infrastructure.
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

/** Cap for a DID document response: 1 MiB. A real document is small;
 * anything larger is not a document and is refused by the default
 * transport before it can be parsed. Kind-label divergence (both fail
 * closed): on the DEFAULT `safeFetchLike` transport the cap is enforced at
 * the socket level, so an oversize document surfaces as a transport-level
 * refusal mapped to "pds-resolution-failed", not the "too-large" kind. */
export const MAX_DID_DOCUMENT_BYTES = 1024 * 1024;

export interface BlobFetchOptions {
  fetchImpl?: FetchLike | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  /** Test seam only; production uses `systemResolver`. */
  resolver?: Resolver | undefined;
  /** Test seam only; production uses `isPublicAddress`. */
  addressPolicy?: AddressPolicy | undefined;
}

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
 * metadata: no credential is ever sent. The document must be a JSON object
 * whose `id` exactly matches the requested DID, carry a `service` array,
 * and include an `#atproto_pds` entry (falling back to an
 * `AtprotoPersonalDataServer` type entry) whose `serviceEndpoint` is an
 * https URL. The did:web document host and the PDS endpoint host both come
 * from author-controlled metadata and must resolve to public addresses only
 * (SSRF gate; IP literals are validated directly, no DNS). The did:plc
 * document hop is exempt: it always goes to the constant operator-known
 * origin `https://plc.directory`. Every other outcome (gate failure,
 * transport failure, HTTP error, invalid JSON, mismatched id, missing or
 * invalid service) is a "pds-resolution-failed".
 *
 * `resolver`/`addressPolicy` are test seams only; production resolves with
 * `systemResolver` + `isPublicAddress`.
 */
export async function resolveAuthorPdsEndpoint(
  did: string,
  options?: {
    fetchImpl?: FetchLike | undefined;
    timeoutMs?: number | undefined;
    /** Test seam only; production uses `systemResolver`. */
    resolver?: Resolver | undefined;
    /** Test seam only; production uses `isPublicAddress`. */
    addressPolicy?: AddressPolicy | undefined;
  } | undefined,
): Promise<string> {
  const resolver = options?.resolver ?? systemResolver;
  const policy = options?.addressPolicy ?? isPublicAddress;
  const { method, methodSpecificId } = parseDid(did);
  let docUrl: string;
  if (method === "plc") {
    // No address gate for this hop: the URL is built from the constant,
    // operator-known origin PLC_DIRECTORY_URL — a trusted platform service
    // that never points at author-controlled metadata. (The DID string is
    // already strictly validated by parseDid against path smuggling.)
    docUrl = `${PLC_DIRECTORY_URL}/${did}`;
  } else {
    const hostWithPort = didWebHost(did, methodSpecificId);
    docUrl = `https://${hostWithPort}/.well-known/did.json`;
  }
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
  // SSRF gate: the did:web document host is author-controlled metadata. It
  // must resolve to public addresses only before any connection is opened;
  // IP-literal hosts are validated directly (no DNS). The did:plc hop is
  // exempt (constant operator-known origin, see above).
  if (method === "web") {
    // The gate host is the hostname part of the `host[:port]`
    // method-specific id, exactly the form didWebHost validated above.
    const colon = methodSpecificId.indexOf(":");
    const docHost = colon === -1 ? methodSpecificId : methodSpecificId.slice(0, colon);
    if (await resolvePublicAddresses(docHost, resolver, policy) === null) {
      throw new TangledBlobError(
        "pds-resolution-failed",
        `DID document host ${docHost} for ${did} does not resolve to public addresses only`,
      );
    }
  }
  // Default transport (no injected fetchImpl): the shared SSRF-safe fetch —
  // pinned to the validated addresses (no rebinding window), public-only,
  // no redirect following, body capped at MAX_DID_DOCUMENT_BYTES.
  const docFetch: FetchLike =
    options?.fetchImpl ??
    safeFetchLike({
      resolver,
      addressPolicy: policy,
      timeoutMs: options?.timeoutMs,
      maxBytes: MAX_DID_DOCUMENT_BYTES,
    });
  let result: { status: number; data: unknown };
  try {
    result = await requestJson(docUrl, {
      allowedOrigin: target.origin,
      fetchImpl: docFetch,
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
  // No loopback exception: the PDS origin is author-controlled, so plaintext
  // http is refused unconditionally.
  if (parsed.protocol !== "https:") {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `PDS endpoint for ${did} must be https (plaintext http is refused: the PDS origin is author-controlled)`,
    );
  }
  // SSRF gate: the PDS endpoint host is author-controlled metadata. Every
  // resolved address must be public before we will connect to it; IP
  // literals are validated directly (no DNS).
  const pdsHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (await resolvePublicAddresses(pdsHost, resolver, policy) === null) {
    throw new TangledBlobError(
      "pds-resolution-failed",
      `PDS endpoint host ${pdsHost} for ${did} does not resolve to public addresses only`,
    );
  }
  return endpoint.replace(/\/+$/, "");
}

/**
 * Fetch the pull round's blob by CID from the pull author's PDS
 * (read-only: `GET <pds>/xrpc/com.atproto.sync.getBlob?did=<did>&cid=<cid>`).
 *
 * The author's PDS is resolved first via `resolveAuthorPdsEndpoint` (which
 * gates both the did:web document host and the PDS endpoint host to public
 * addresses only). The request is unauthenticated: the PDS origin is
 * author-resolved metadata, so no credential is ever sent to it — the only
 * requests this module makes are with auth: none. The body is read through
 * the shared transport's hard byte cap (`options.maxBytes`, default
 * `MAX_PATCH_BLOB_BYTES`); when no `fetchImpl` is injected the default
 * transport is `safeFetchLike` (pinned public-only DNS, no redirect
 * following). A 2xx zero-byte body is a "read-failed" empty-blob error,
 * never a success.
 *
 * Kind-label divergence for the byte cap (both fail closed): on the DEFAULT
 * `safeFetchLike` transport the cap is enforced at the socket level, so an
 * over-cap blob surfaces as a transport-level refusal mapped to
 * "read-failed"; the "too-large" kind comes from `requestBytes`' own cap
 * check and is reachable via the injected-`fetchImpl` path.
 *
 * `resolver`/`addressPolicy` are test seams only; production resolves with
 * `systemResolver` + `isPublicAddress`.
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
  // Test seams only; production uses the system resolver + public-only policy.
  const resolver = options?.resolver ?? systemResolver;
  const policy = options?.addressPolicy ?? isPublicAddress;
  const pds = await resolveAuthorPdsEndpoint(did, {
    fetchImpl: options?.fetchImpl,
    timeoutMs: options?.timeoutMs,
    resolver,
    addressPolicy: policy,
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
  // The PDS origin is author-selected metadata: an unauthenticated public
  // read. No Authorization header is sent to it — and the options no longer
  // carry a token that could be. Default transport (no injected fetchImpl):
  // pinned public-only DNS, no redirect following, capped at maxBytes.
  const blobFetch: FetchLike =
    options?.fetchImpl ??
    safeFetchLike({
      resolver,
      addressPolicy: policy,
      timeoutMs: options?.timeoutMs,
      maxBytes,
    });
  let result: { status: number; bytes: Uint8Array };
  try {
    result = await requestBytes(target.toString(), {
      allowedOrigin: pdsUrl.origin,
      fetchImpl: blobFetch,
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
