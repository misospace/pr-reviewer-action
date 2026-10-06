/** Shared secret-redaction for v3 context producers (#675): a verbatim
 * TypeScript port of `scripts/redact.py`'s `redact_text`. The pr-thread and
 * related-code builders feed untrusted bodies and grep snippets through this
 * before anything reaches the corpus, exactly like their v2 counterparts.
 * The patterns, their application order, and the `[REDACTED]` marker are
 * contractual (redacted bytes stay byte-identical to v2), so this module must
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

// ---------------------------------------------------------------------------
// Source-safe redaction (#876)
// ---------------------------------------------------------------------------

/** Marker used for repository-source redaction. Deliberately distinct from
 * `[REDACTED]` (which reads as plausible removed prose) so it cannot be
 * mistaken for literal repository bytes: no TypeScript/Python/YAML file ever
 * legitimately contains this token, and the review system prompt states that
 * it is harness-inserted, never committed source. */
export const REDACTED_SOURCE = "⟦redacted:credential⟧";

// Applied to repository SOURCE content (file reads, grep matches, blame) —
// evidence the model must be able to trust structurally. Every rule below
// replaces ONLY the credential VALUE, never a key name, delimiter, quote, or
// surrounding punctuation: `apiKey: "hunter2hunter2",` must come out as
// `apiKey: "⟦redacted:credential⟧",`, not `⟦redacted:credential⟧,` (the
// #876 class again, just on the sanitizer's own output). A secret-named key
// assigned a code expression — an identifier, member access, call, template
// literal, or env lookup, e.g. `apiKey: config.apiKey,`, `token: opts.token`,
// `password=self.password`, `secret = getSecret()` — is never touched:
// replacing it would destroy code structure the model relies on to judge
// correctness (#876).
const SECRET_KEY_ALTERNATION = "api[_-]?key|token|password|secret|access[_-]?key|auth[_-]?token";

// Recognized CloudFormation-style YAML short-form tags. Deliberately a fixed
// whitelist, not "anything starting with `!`" (#876 review round 3): a real
// quoted literal can start with `!` (`password: "!hunter2hunter2"`), and an
// unrecognized/custom tag name is not assumed to be a reference either.
const REFERENCE_TAG_RE =
  /^!(Ref|Sub|GetAtt|ImportValue|Join|Select|FindInMap|Base64|Cidr|GetAZs|Split|If|Equals|Not|And|Or)(\s.*)?$/;

/** A value that is a REFERENCE to a secret, not the secret itself — env-var
 * interpolation (`${VAR}`, `$VAR`), a template placeholder (`{{ ... }}`), a
 * CloudFormation short-form tag (`!Ref`/`!Sub`/`!GetAtt`/...), a 1Password
 * reference (`op://...`), a Vault reference (`vault:...`), or an
 * already-encrypted SOPS/ansible-vault value (`ENC[...]`). These must never
 * be masked: they are not literal credential bytes, in code or config.
 *
 * `quoted` narrows two forms that are otherwise ambiguous with a real quoted
 * literal (#876 review round 3):
 *  - a YAML tag is only a reference when UNQUOTED — inside quotes it is
 *    string content, e.g. `password: "!hunter2hunter2"` must still mask;
 *  - a bare `$VAR` (no braces) is only a reference when UNQUOTED — a quoted
 *    `"$ecret123"` reads exactly like a real secret that happens to start
 *    with `$`, so it is never exempted. The braced `${VAR}` form is
 *    unambiguous either way (and only when the ENTIRE value is exactly that
 *    shape: `"prefix${VAR}suffix-realsecret"` still masks). */
function isReferenceValue(value: string, quoted: boolean): boolean {
  if (/^\$\{[^}]*\}$/.test(value)) return true;
  if (!quoted && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  if (/^\{\{.*\}\}$/.test(value)) return true;
  if (!quoted && REFERENCE_TAG_RE.test(value)) return true;
  if (/^op:\/\/\S*$/i.test(value)) return true;
  if (/^vault:\S*$/i.test(value)) return true;
  if (/^ENC\[[^\]]*\]$/.test(value)) return true;
  return false;
}

// config-like paths where an UNQUOTED scalar after a secret-named key is a
// literal value (YAML/.env/.ini/.cfg/.conf/.properties/.toml/.json,
// kubeconfig, Dockerfile ENV/ARG) — as opposed to code files, where an
// unquoted value is a code expression (#876).
const CONFIG_EXTENSION_RE = /\.(ya?ml|ini|cfg|conf|properties|toml|json)$/i;
const ENV_FILE_RE = /(?:^|[\\/])\.env(?:\..+)?$/i;
const DOCKERFILE_RE = /(?:^|[\\/])dockerfile(?:\..+)?$/i;
const KUBECONFIG_RE = /(?:^|[\\/])kubeconfig(?:\..+)?$/i;

function isConfigLikePath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return (
    CONFIG_EXTENSION_RE.test(filePath) ||
    ENV_FILE_RE.test(filePath) ||
    DOCKERFILE_RE.test(filePath) ||
    KUBECONFIG_RE.test(filePath)
  );
}

/** Source-safe counterpart to `redactText` (#876): masks only high-confidence
 * literal credential values, never generic identifier/property/assignment
 * syntax, and never a key name or delimiter — only the value itself is ever
 * replaced. Use this for repository source evidence (tool file reads, grep
 * matches, blame) where the model must be able to trust that what it sees is
 * byte-for-byte the committed source, modulo actual secret values. Untrusted
 * prose/log/web payloads keep using `redactText`.
 *
 * `filePath` (repo-relative, when known) selects the unquoted-literal rule:
 * config-like files (YAML/.env/.ini/.toml/.json/kubeconfig/Dockerfile) mask
 * an unquoted secret-named scalar as a literal; code files (and unknown
 * paths) never do, because there an unquoted value is a code expression. A
 * QUOTED literal is masked either way — quoting is a value-shape signal a
 * code expression never has. */
export function redactSourceText(text: string | null | undefined, filePath?: string | null): string {
  if (!text) return "";
  let redacted = text;

  // Bare token-shape secrets: the whole match IS the literal, nothing else
  // to preserve.
  redacted = redacted.replace(/ghp_[A-Za-z0-9]{30,}/g, REDACTED_SOURCE);
  redacted = redacted.replace(/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED_SOURCE);
  redacted = redacted.replace(/AKIA[0-9A-Z]{16}/g, REDACTED_SOURCE);
  redacted = redacted.replace(/sk-[A-Za-z0-9]{20,}/g, REDACTED_SOURCE);

  // Bearer / Basic auth headers: keep the scheme word, mask only the token.
  redacted = redacted.replace(
    /\b(Bearer|Basic)(\s+)([A-Za-z0-9._+/=-]{20,})/gi,
    (_m, scheme: string, ws: string) => `${scheme}${ws}${REDACTED_SOURCE}`,
  );

  // PEM private key blocks: keep the BEGIN/END lines, mask only the body.
  redacted = redacted.replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_m, begin: string, _body: string, end: string) => `${begin}\n${REDACTED_SOURCE}\n${end}`,
  );

  // Kubernetes / kubeconfig credential-bearing keys: keep the key and
  // separator, mask only the value. A tagged form (`!Ref X`, `!Sub ...`,
  // `!GetAtt ...`) is captured whole, to end of line, so it is judged (and,
  // being a reference, left alone) as ONE value rather than truncated at its
  // first space — `!Ref ClientKeyData` must never become `⟦…⟧ ClientKeyData`.
  redacted = redacted.replace(
    /(client-certificate-data|client-key-data|certificate-authority-data)(\s*:\s*)(![^\n]*|\S+)/gi,
    (m, key: string, sep: string, value: string) =>
      isReferenceValue(value.trim(), false) ? m : `${key}${sep}${REDACTED_SOURCE}`,
  );

  // A secret-named key assigned a QUOTED string literal: keep the key
  // (and, when present, matching quotes around it — `"token": "..."` in
  // JSON/YAML), separator, and value quotes; mask only the value. Requires
  // matching value quotes and no quote inside the value, so a code
  // expression (unquoted) never matches. A quoted reference (e.g.
  // `apiKey: "${API_KEY}"`) is left alone.
  redacted = redacted.replace(
    new RegExp(`(["'\`]?)(${SECRET_KEY_ALTERNATION})\\1(\\s*[:=]\\s*)(["'\`])([^"'\`]{8,})\\4`, "gi"),
    (m, keyQuote: string, key: string, sep: string, quote: string, value: string) =>
      isReferenceValue(value, true) ? m : `${keyQuote}${key}${keyQuote}${sep}${quote}${REDACTED_SOURCE}${quote}`,
  );

  // A secret-named key assigned an UNQUOTED scalar literal: config-file-only
  // (#876) — in a code file the same shape is a bare identifier/expression
  // (`apiKey: config.apiKey`), which must survive untouched. Same optional
  // matching-quote handling on the key as the quoted-value rule above (a
  // quoted JSON/YAML key can still carry an unquoted value, e.g.
  // `"token": hunter2hunter2`), and the same whole-value-to-end-of-line
  // capture for a tagged reference form.
  if (isConfigLikePath(filePath)) {
    redacted = redacted.replace(
      new RegExp(`(["'\`]?)(${SECRET_KEY_ALTERNATION})\\1(\\s*[:=]\\s*)(![^\\n#]*|[^\\s#'"]{8,})`, "gi"),
      (m, keyQuote: string, key: string, sep: string, value: string) =>
        isReferenceValue(value.trim(), false) ? m : `${keyQuote}${key}${keyQuote}${sep}${REDACTED_SOURCE}`,
    );
  }

  return redacted;
}

/** Marker used for known-secret masking (`maskKnownSecrets`/`maskDiagnostic`/
 * `describeTransportFailure`). Deliberately distinct from the heuristic
 * `[REDACTED]` marker and contains NO alphanumeric characters (#882): that
 * marker's own letters ("R", "E", "D", "A", "C", "T") collide with any
 * single-character configured secret equal to one of them, and every
 * replacement pass reintroduces the very character it was meant to remove,
 * so the "configured credential never appears in the output" invariant
 * could never be asserted for such a key. A marker built entirely from
 * non-alphanumeric characters cannot collide with an alphanumeric secret of
 * any length, closing that class of collision entirely.
 *
 * Documented residual edge, deliberately not special-cased: a configured
 * secret that is itself exactly one of this marker's own characters (`⟦`,
 * `•`, `⟧`) still collides the same way, since masking it necessarily
 * inserts a marker containing that same character. This is accepted as
 * pathological (an operator-configured secret equal to a lone decorative
 * bracket/bullet is not a realistic credential) rather than worth extra
 * masking logic. It never loops: each `maskKnownSecrets` call is a single
 * bounded pass over its input, so repeated calls (e.g. `maskDiagnostic`'s
 * documented second whole-string pass) nest the marker by exactly one level
 * per call rather than growing unboundedly. */
export const KNOWN_SECRET_REDACTED = "⟦•⟧";

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
      masked = masked.split(variant).join(KNOWN_SECRET_REDACTED);
    }
  }
  return masked;
}

/** Default length cap for `maskDiagnostic`, matching #862's
 * `describeTransportFailure` (300 chars). */
export const DIAGNOSTIC_MAX_CHARS = 300;

/**
 * #868/#862: the one shared recipe for turning an untrusted, model-derived
 * diagnostic string (a parse-failure message, an in-body error, a transport
 * detail, ...) into something safe to log or persist: mask the caller's
 * configured secret(s) first (on the full untruncated text, so a secret
 * split across the cap is never partially exposed), then `redactText`'s
 * pattern heuristics, then cap length, then — because a very short
 * configured key (down to one character; `ai-api-key` has no minimum) can
 * coincide with ordinary characters in whatever static prose the caller
 * wraps this text in — mask the caller's *final*, fully-assembled string
 * again. That last step is why every caller should build its full message
 * (static prefix included) and pass the WHOLE thing through `maskDiagnostic`
 * once, rather than only masking the untrusted substring before splicing it
 * in. Since #882, `KNOWN_SECRET_REDACTED` has no alphanumeric characters, so
 * this second pass can no longer reintroduce an alphanumeric secret it just
 * masked on the first pass; it now only re-masks characters that were
 * already in the static prose (never in the untrusted `text`), plus the
 * marker's own pathological edge documented on `KNOWN_SECRET_REDACTED`.
 */
export function maskDiagnostic(
  text: string,
  secrets: readonly (string | null | undefined)[] = [],
  maxChars: number = DIAGNOSTIC_MAX_CHARS,
): string {
  const withoutKnownSecrets = maskKnownSecrets(text, secrets);
  const redacted = redactText(withoutKnownSecrets);
  const points = Array.from(redacted);
  const capped = points.length > maxChars ? `${points.slice(0, maxChars).join("")}...[truncated]` : redacted;
  return maskKnownSecrets(capped, secrets);
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

/** Source-safe counterpart to `maskAndTruncate` (#876): same truncation
 * contract, but masks with `redactSourceText` so repository source content
 * (tool file reads, grep matches, blame) survives byte-for-byte apart from
 * actual credential values. */
export function maskAndTruncateSource(
  text: string | null | undefined,
  maxBytes: number,
  filePath?: string | null,
): { text: string; truncated: boolean } {
  const masked = redactSourceText(text, filePath);
  const raw = Buffer.from(masked, "utf8");
  if (raw.length <= maxBytes) {
    return { text: masked, truncated: false };
  }
  const clipped = raw.subarray(0, maxBytes).toString("utf8");
  return { text: clipped + "\n[truncated]", truncated: true };
}
