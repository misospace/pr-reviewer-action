/** Provider-key isolation at the gateway's worker-facing boundary (#765).
 *
 * The gateway resolves the provider credential controller-side and hands the
 * provider's answer back to the controller (and, through it, the worker). A
 * provider — or a hostile endpoint posing as one — can quote the credential
 * it was given straight back into its own answer ("your Authorization header
 * was `Bearer <key>`"), so three surfaces can carry the key out of the
 * gateway: the RAW provider body, the COMPLETION content, and a TRANSPORT
 * FAILURE body (the preserved non-2xx body). The gateway is the boundary
 * that resolved the key, so it is the boundary that closes those three
 * paths — the caller cannot be expected to know what the provider echoes.
 *
 * Two rules, mirroring the repo's existing content/diagnostic split:
 *
 * - DIAGNOSTIC surfaces (the raw provider body, a transport failure's body
 *   and message) are MASKED. `redactTextDeep` is the #1149 composition: the
 *   configured values first (`maskKnownSecrets`, unconditional, any length),
 *   then the generic credential-shape heuristics (`redactText`). Masking
 *   never changes the call's outcome and never fails the call.
 * - CONTENT surfaces (the normalized response) REFUSE rather than mask: a
 *   response carrying the credential is dropped whole
 *   (`containsKnownSecret`, the #1094 rule) rather than corrupted by a
 *   marker spliced into verdict fields — masking a verdict is worse than
 *   refusing it. The scan is leaf-wise over the WHOLE response (every
 *   provider-authored string: `id`, `model`, `finishReason`, the
 *   completion text, every tool call, the error payload), because every
 *   one of them is an echo surface, and a credential carrying a
 *   JSON-escaped character survives neither a raw search nor a
 *   stringify-and-search.
 *
 * The one asymmetry between the two halves is the repo's own (#1094):
 * detection uses `containsKnownSecret`'s 8-character floor, below which a
 * raw value is prose-indistinguishable (masking it in a verdict would
 * corrupt the verdict, and refusing on it would refuse ordinary prose),
 * while the diagnostic surfaces mask at ANY length. So a credential of
 * fewer than eight characters is masked out of the raw body and the
 * failure body but may survive in a response — exactly the trade-off
 * direct mode's content surfaces already make.
 *
 * Nothing here is provider-specific, and nothing here re-implements the
 * masking machinery: the seams (`maskKnownSecrets`, `redactText`,
 * `redactTextDeep`, `containsKnownSecret`) are the repo's existing ones, so
 * gateway mode and direct mode mask the same bytes.
 */
import { containsKnownSecret, maskKnownSecrets, redactText, redactTextDeep } from "../context/redact.js";
import { TransportFailure } from "../transport/http.js";
import { callKnownSecrets } from "../transport/headers.js";
import type { NormalizedModelResponse } from "../model/types.js";

/** The secret list one gateway call masks against: the resolved provider
 * credential plus the VALUES of the operator's extra headers (header values
 * routinely carry proxy/gateway tokens). The transport owns the base list
 * (`callKnownSecrets`), so gateway mode and direct mode mask the same
 * bytes instead of each call site re-deriving its own. */
export type GatewayCallSecrets = readonly (string | null | undefined)[];

/** The secret list for one call: the transport's own list (the credential
 * plus the extra-header values) PLUS each value's JSON-escaped spelling.
 *
 * The escaped spelling is added here because a provider that echoes the
 * credential inside a JSON string writes it ESCAPED (`sk-a\"b`), and
 * neither the raw value nor the seams' URL-encoded and base64 variants
 * match that spelling — so without it an escaped echo would survive both
 * the gate and the mask. The seam itself is unchanged: this is just more
 * strings in the same list. */
export function gatewayCallSecrets(
  apiKey: string,
  extraHeaders?: Readonly<Record<string, string>>,
): GatewayCallSecrets {
  const extended = new Set<string>();
  for (const secret of callKnownSecrets(apiKey, extraHeaders)) {
    if (typeof secret !== "string" || secret === "") continue;
    extended.add(secret);
    const escaped = jsonEscaped(secret);
    if (escaped !== secret) extended.add(escaped);
  }
  return [...extended];
}

/** A string's JSON-escaped inner spelling (`sk-a\"b`), or the value
 * itself when it needs no escaping. */
function jsonEscaped(value: string): string {
  try {
    return JSON.stringify(value).slice(1, -1);
  } catch {
    return value;
  }
}

/** Mask the raw provider body: the surface a provider most plausibly echoes
 * its request headers into. Masked, never refused — the raw body is a
 * diagnostic artifact, not review content. */
export function maskProviderBody(raw: unknown, secrets: GatewayCallSecrets): unknown {
  return redactTextDeep(raw, secrets);
}

/** Does the normalized response carry a known secret? The content gate:
 * a response that quotes the credential fails the whole call rather than
 * publishing (or masking into a corrupted verdict) the key.
 *
 * The scan is LEAF-WISE over the WHOLE response, not over `content` alone
 * and not over one JSON stringification: every provider-authored string
 * the gateway hands back is a candidate echo surface — `id`, `model`,
 * `finishReason`, the completion text, every tool call, the error payload
 * — and a credential containing a JSON-escaped character (`"`, `\`, a
 * control character) survives neither a raw search nor a
 * stringify-and-search in its escaped spelling. Leaf-wise, the credential
 * is found in whatever spelling the provider wrote it. */
export function responseCarriesKnownSecret(
  response: NormalizedModelResponse,
  secrets: GatewayCallSecrets,
): boolean {
  return carriesKnownSecret(response, secrets, 0);
}

/** The scan's depth bound. A response nested deeper than this FAILS CLOSED
 * (the gate fires, the call is refused) rather than being scanned
 * partially — a hostile payload must not be able to hide behind depth
 * (the same fail-closed posture as `maskKnownSecretsDeep`'s depth cap). */
const MAX_SCAN_DEPTH = 32;

/** Leaf-wise secret detection over an unknown value: every string leaf AND
 * every own key is checked (both are provider-authored text). */
function carriesKnownSecret(value: unknown, secrets: GatewayCallSecrets, depth: number): boolean {
  if (typeof value === "string") return containsKnownSecret(value, secrets);
  if (depth >= MAX_SCAN_DEPTH) return true;
  if (Array.isArray(value)) return value.some((item) => carriesKnownSecret(item, secrets, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => containsKnownSecret(key, secrets) || carriesKnownSecret(item, secrets, depth + 1),
    );
  }
  return false;
}

/** Mask a transport failure before it leaves the gateway: the preserved
 * non-2xx body is provider-authored text and can quote the request headers
 * straight back. The typed shape (kind, status, byte counters, retry hint,
 * and the original `cause` chain) is preserved exactly — only the free
 * text is masked. */
export function maskTransportFailure(failure: TransportFailure, secrets: GatewayCallSecrets): TransportFailure {
  const message = redactText(maskKnownSecrets(failure.message, secrets));
  const body = failure.body !== undefined ? redactText(maskKnownSecrets(failure.body, secrets)) : undefined;
  return new TransportFailure(failure.kind, message, {
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(failure.maxResponseBytes !== undefined ? { maxResponseBytes: failure.maxResponseBytes } : {}),
    ...(failure.bytesReceived !== undefined ? { bytesReceived: failure.bytesReceived } : {}),
    ...(failure.retryAfterSec !== undefined ? { retryAfterSec: failure.retryAfterSec } : {}),
    ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
  });
}
