// X-Hub-Signature-256 is "sha256=" followed by the LOWERCASE HEX HMAC-SHA256 of
// the RAW webhook body — the #729 GitHub seam.
//
// Do NOT "unify" this with `signature.ts`. `X-Gitea-Signature` (Forgejo/Gitea,
// #730) is the bare lowercase hex digest and CORRECTLY REJECTS the `sha256=`
// form; this file CORRECTLY REJECTS the bare form. One accepts exactly what the
// other refuses, on purpose: an attacker who can present either header must not
// be able to have one seam accept the other seam's syntax.
//
// Fail closed, before any comparison:
// - an empty configured secret accepts nothing (even a header computed over the
//   empty secret);
// - the header must be a SINGLE string — an array/duplicate header value is
//   refused rather than "picked from", because a duplicate is ambiguous input,
//   not a value to choose between;
// - the `sha256=` prefix is required and must be exact, and the digest must be
//   exactly 64 LOWERCASE hex characters (missing prefix, uppercase hex, wrong
//   length, or any other prefix all fail before a comparison);
// - the constant-time compare (`timingSafeEqual`) runs only AFTER the two
//   digests are known to be the same length, so `timingSafeEqual` can never
//   throw on mismatched sizes.
//
// This is the verify-before-parse primitive: the HMAC covers the RAW bytes, so
// unauthenticated bytes never reach a JSON parser. The webhook handler itself
// is NOT in this file.
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const DIGEST_HEX_LENGTH = 64;

/** Exactly 64 lowercase hex characters. Uppercase hex fails: `String.toUpperCase`
 * is not a normalization GitHub performs, so accepting it would accept a value
 * the real webhook seam never emits. */
const DIGEST_HEX_RE = /^[0-9a-f]{64}$/;

export function computeGitHubWebhookSignature(secret: string, rawBody: Buffer | string): string {
  return `${SIGNATURE_PREFIX}${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifyGitHubWebhookSignature(
  secret: string,
  signatureHeader: string | string[] | undefined,
  rawBody: Buffer | string,
): boolean {
  if (secret === "") return false;
  if (typeof signatureHeader !== "string") return false;
  // The total length is checked alongside the regex because a JS `$` also
  // matches before a trailing newline, so `/^[0-9a-f]{64}$/` alone would accept
  // a header carrying one extra byte.
  if (signatureHeader.length !== SIGNATURE_PREFIX.length + DIGEST_HEX_LENGTH) return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);
  if (!DIGEST_HEX_RE.test(providedHex)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "hex");
  const provided = Buffer.from(providedHex, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}