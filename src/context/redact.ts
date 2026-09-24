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
