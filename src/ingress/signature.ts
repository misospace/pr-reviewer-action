// X-Gitea-Signature is the lowercase-hex HMAC-SHA256 of the raw webhook body.
// Fail closed: an empty configured secret accepts nothing, and duplicate-header
// arrays and the GitHub "sha256=" form are rejected before any comparison.
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEX = /^[0-9a-f]{64}$/;

export function computeForgejoWebhookSignature(secret: string, rawBody: Buffer | string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyForgejoWebhookSignature(secret: string, signatureHeader: string | string[] | undefined, rawBody: Buffer | string): boolean {
  if (secret === "") return false;
  if (typeof signatureHeader !== "string" || !SIGNATURE_HEX.test(signatureHeader)) return false;
  const expected = Buffer.from(computeForgejoWebhookSignature(secret, rawBody), "hex");
  const provided = Buffer.from(signatureHeader, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
