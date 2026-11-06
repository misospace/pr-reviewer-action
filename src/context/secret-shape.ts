/** Shared credential-shape redaction for external output boundaries.
 *
 * Extracted from the #737 admin route layer so every external surface (the
 * admin diagnostics/readiness projections and the #1349 operator MCP
 * projection) applies the SAME single redaction pass — a second hand-copied
 * vocabulary is exactly the drift class #1170 closed. Pattern matching is
 * defense in depth, not a secret oracle: the structural guarantee stays with
 * the surface that uses it (bearer protection, allowlisted projections), and
 * the daemon must still not feed secrets into a seam.
 */

import { SECRET_KEY_ALTERNATION } from "./redact.js";

/** Credential SHAPES. The leading guard allows a separator (`_`, `-`, `.`,
 * quotes) before the token but not a letter or digit, so `prefix_sk-…` is
 * caught while an ordinary word that merely contains `sk-` is not. */
export const SECRET_SHAPE = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+\S+|Basic\s+[A-Za-z0-9+/=]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

/** `key=value` / `key: value` credential assignments. The key vocabulary is
 * DERIVED from the canonical `SECRET_KEY_ALTERNATION` (src/context/redact.ts,
 * #1170) — the single source of truth behind every key-name rule in the
 * repository — plus admin-only names the canonical list does not carry
 * (`passwd`, `pwd`, `credential`, `authorization`; `access_token` /
 * `refresh_token` are already covered by the canonical `token` alternative).
 * A canonical credential key can never slip past this rule when it is added
 * to the canonical list. The value may be quoted: JSON-shaped exception and
 * DSN blobs quote theirs. */
export const CREDENTIAL_ASSIGNMENT = new RegExp(
  `((?:${SECRET_KEY_ALTERNATION}|passwd|pwd|credential|authorization)["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^"'\\s,;}]+)`,
  "gi",
);

/** URL userinfo: `scheme://user:pass@host`. The credential part may contain
 * `/` (base64) and the host may contain `@`, so the match runs to the LAST
 * `@` of the token. The scheme repetition is bounded so the pattern cannot
 * go quadratic on a long run of lowercase characters. */
export const USERINFO_URL = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s]+@/gi;

/** Replace credential-shaped substrings, credential assignments, and URL
 * userinfo. Pattern-based defense in depth, not a secret oracle. */
export function redactSecretShapes(value: string): string {
  return value.replace(SECRET_SHAPE, "[REDACTED]").replace(CREDENTIAL_ASSIGNMENT, "$1[REDACTED]").replace(USERINFO_URL, "$1[REDACTED]@");
}
