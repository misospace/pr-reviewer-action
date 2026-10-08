import type { FetchLike } from "./http.js";
import { fetchAtprotoBlob, type BlobFetchOptions } from "./tangled-blob.js";
import {
  decodeTangledPatchBlob,
  normalizeGitFormatPatch,
  selectLatestPullRound,
  type TangledNormalizedPatch,
  type TangledPullRound,
} from "./tangled-patch.js";
import type { TangledPullIdentity } from "./tangled-bobbin.js";

/**
 * Tangled pull round diff (#586) — the thin orchestrator that turns a
 * resolved canonical Tangled pull identity into the reviewable
 * diff/files.
 *
 * This is the network-completing half of the #586 work. `tangled-bobbin.ts`
 * (#584) already resolved the pull record into a `TangledPullIdentity`
 * (URI + record + author DID), and `tangled-patch.ts` owns the pure decode
 * steps. This module wires the two together and performs the only I/O in
 * the chain, in this order:
 *
 *   1. selectLatestPullRound(identity.record) — pure and deterministic;
 *      an unusable record (no rounds / malformed last round) is a
 *      "no-round"/"invalid-round" TangledPatchError THROWN BEFORE ANY
 *      NETWORK CALL;
 *   2. bytes = (options.fetchBlob ?? fetchAtprotoBlob)(
 *        identity.authorDid, round.blobCid, { fetchImpl, token, timeoutMs })
 *      — the round's gzipped patch blob, read from the pull AUTHOR's PDS
 *      via the public `com.atproto.sync.getBlob` XRPC surface (the PDS is
 *      resolved first from the author's public DID document);
 *   3. patchText = decodeTangledPatchBlob(bytes) — the gzip + size-cap +
 *      UTF-8/BOM handling all lives there;
 *   4. normalized = normalizeGitFormatPatch(patchText) — the mail-envelope
 *      grammar → { diff, files, headSha };
 *   5. return { diff, files, headSha, round }.
 *
 * Trust posture: strictly read-only. Nothing here publishes, updates, or
 * deletes; the DID document request is unauthenticated public metadata, and
 * a caller-supplied token travels only as the Authorization header bound
 * to the validated PDS origin (never in the URL, argv, or diagnostics).
 * The record, blob bytes, and patch text are UNTRUSTED data: they are
 * decoded and parsed, never executed or followed as instructions.
 *
 * Failure model: no empty-success path. Every failure propagates as the
 * typed error of the step that produced it — "no-round"/"invalid-round"
 * (before the network), "undecodable-blob"/"patch-too-large" (blob
 * decode), "malformed-patch"/"empty-patch" (normalization), or
 * TangledBlobError (DID/PDS resolution, blob read, over-cap body). Nothing
 * is caught-and-emptied into a fake successful diff.
 *
 * `options.fetchBlob` is a test seam only: it replaces `fetchAtprotoBlob`
 * with an injected byte provider so tests never need a PDS. Production
 * callers leave it unset and take the real two-hop PDS path.
 *
 * Pipeline wiring is deliberately absent: `tangled.ts`'
 * `requireImplementedBackend` guard stays in force, and no review-pipeline
 * code path may call this for a `tangled`-resolved environment until the
 * later #564 tickets connect it.
 */

export interface TangledRoundDiffOptions {
  fetchImpl?: FetchLike | undefined;
  token?: string | undefined;
  timeoutMs?: number | undefined;
  /** Test seam; defaults to fetchAtprotoBlob from ./tangled-blob.js */
  fetchBlob?:
    | ((did: string, cid: string, options?: BlobFetchOptions) => Promise<Uint8Array>)
    | undefined;
}

export interface TangledPullRoundDiff extends TangledNormalizedPatch {
  round: TangledPullRound;
}

export async function fetchTangledPullRoundDiff(
  identity: TangledPullIdentity,
  options?: TangledRoundDiffOptions | undefined,
): Promise<TangledPullRoundDiff> {
  // Step 1: deterministic round selection, before any network call.
  const round = selectLatestPullRound(identity.record);
  // Step 2: the only I/O in the chain.
  const fetchBlob = options?.fetchBlob ?? fetchAtprotoBlob;
  const bytes = await fetchBlob(identity.authorDid, round.blobCid, {
    fetchImpl: options?.fetchImpl,
    token: options?.token,
    timeoutMs: options?.timeoutMs,
  });
  // Step 3: gunzip + caps + UTF-8 live in decodeTangledPatchBlob.
  const patchText = decodeTangledPatchBlob(bytes);
  // Step 4: mail-envelope normalization lives in normalizeGitFormatPatch.
  const normalized = normalizeGitFormatPatch(patchText);
  // Step 5: a successful result always carries a real diff — every
  // empty/malformed case already threw in steps 1-4.
  return {
    diff: normalized.diff,
    files: normalized.files,
    headSha: normalized.headSha,
    round,
  };
}
