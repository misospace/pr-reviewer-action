/** Shared secret-redaction for v3 context producers (#675): a verbatim
 * TypeScript port of `scripts/redact.py`'s `redact_text`. The pr-thread and
 * related-code builders feed untrusted bodies and grep snippets through this
 * before anything reaches the corpus, exactly like their v2 counterparts.
 * The patterns, their application order, and the `[REDACTED]` marker are
 * contractual (v2/v3 parity compares the redacted bytes), so this module must
 * stay in lockstep with the Python original — it is a normalization seam, not
 * a security-policy one: no network, no process, no policy decisions. */

const REDACTED = "[REDACTED]";

// In application order (same as scripts/redact.py). Each pattern replaces
// every occurrence; later patterns see the already-redacted text.
const MASKERS: readonly RegExp[] = [
  // GitHub personal access tokens (classic & fine-grained)
  /ghp_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Bearer / Basic auth headers and inline tokens
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi,
  /Basic\s+[A-Za-z0-9+/=]{20,}/gi,
  // Generic key=value / key: value patterns (logs, env dumps, configs)
  /(api[_-]?key|token|password|secret|access[_-]?key|auth[_-]?token)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
  // AWS-style access keys
  /AKIA[0-9A-Z]{16}/g,
  // Kubernetes / kubeconfig credentials (credential-bearing keys only — the
  // old (server|username|...) form destroyed ordinary `server:` YAML context)
  /(password|client-certificate-data|client-key-data|certificate-authority-data|bearer[_-]?token)\s*:\s*\S+/gi,
];

/** Return *text* with credential-like values replaced by `[REDACTED]`.
 * Best-effort heuristic redaction, exactly like the Python original. */
export function redactText(text: string | null | undefined): string {
  if (!text) return "";
  let redacted = text;
  for (const pattern of MASKERS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

/**
 * #846/security-review: mask every literal occurrence of a caller-supplied
 * secret (an operator's configured model API key), plus its URL-encoded and
 * base64 forms. This is deliberately separate from `redactText`'s
 * pattern-based heuristics (parity-locked, see the module doc) — a known
 * exact secret must be nuked unconditionally, even when it doesn't happen to
 * match any heuristic pattern (e.g. an opaque key like `sk-...` echoed bare
 * in a provider's error body, with no `key=`/`Bearer `/etc. framing).
 * Case-sensitive substring replacement; every non-empty secret is masked
 * regardless of length — `ai-api-key` has no configured minimum, a
 * one-character local key is plausible, and over-redaction in a diagnostic
 * string is an acceptable cost next to leaking a credential. Only an empty
 * string (nothing to mask) is skipped; the same rule applies to each
 * variant (a variant is skipped only if it comes out empty). Callers must
 * run this BEFORE any truncation, so a partial secret split across a
 * truncation boundary is never left exposed.
 */
export function maskKnownSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let masked = text;
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = new Set<string>([secret]);
    try {
      variants.add(encodeURIComponent(secret));
    } catch {
      // Malformed surrogate pairs etc.: skip the URL-encoded variant.
    }
    try {
      variants.add(Buffer.from(secret, "utf8").toString("base64"));
    } catch {
      // Unreachable in practice (Buffer.from/toString don't throw here),
      // kept for symmetry with the encodeURIComponent guard above.
    }
    for (const variant of variants) {
      if (variant === "") continue;
      masked = masked.split(variant).join(REDACTED);
    }
  }
  return masked;
}

/**
 * Port of `scripts/redact.py`'s `mask_and_truncate`: redact secrets, then
 * truncate to *maxBytes* UTF-8 bytes with a visible `\n[truncated]` marker.
 * Truncation happens after masking so the byte length reflects the redacted
 * content. The tool-executor layer applies this to every tool result before
 * it reaches the conversation or the corpus, mirroring the v2 call sites.
 */
export function maskAndTruncate(
  text: string | null | undefined,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const masked = redactText(text);
  const raw = Buffer.from(masked, "utf8");
  if (raw.length <= maxBytes) {
    return { text: masked, truncated: false };
  }
  const clipped = raw.subarray(0, maxBytes).toString("utf8");
  return { text: clipped + "\n[truncated]", truncated: true };
}
