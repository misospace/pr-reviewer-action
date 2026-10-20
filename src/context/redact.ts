/** Shared secret-redaction for v3 context producers (#675).
 * TypeScript is now the sole authoritative implementation; the v2 Python
 * original is gone, so there is no Python side to stay in lockstep with. The
 * `[REDACTED]` marker and pattern application order remain the contract callers
 * rely on, and new patterns may be added here directly. The pr-thread and
 * related-code builders feed untrusted bodies and grep snippets through this
 * before anything reaches the corpus. This is a normalization seam, not a
 * security-policy one: no network, no process, no policy decisions. */

import { committedSourceProvenance, sanitizedSourceProvenance } from "./evidence-provenance.js";

const REDACTED = "[REDACTED]";

// In application order. Each pattern replaces every occurrence; later
// patterns see the already-redacted text.
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
  // OpenAI-style provider keys (`sk-`, `sk-proj-`, `sk-ant-…`, `sk-or-v1-…`).
  // The lookbehind rejects a preceding letter or digit, so the rule cannot
  // match inside ordinary hyphenated prose (`task-runner-with-a-long-name`) or
  // a longer identifier. It is deliberately NOT `\b`: `_` is a word character,
  // so `\b` would skip a key written straight after one — e.g. the underscore
  // emphasis a model reaches for when quoting a key, `_sk-…`.
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  // Kubernetes / kubeconfig credentials (credential-bearing keys only — the
  // old (server|username|...) form destroyed ordinary `server:` YAML context)
  /(password|client-certificate-data|client-key-data|certificate-authority-data|bearer[_-]?token)\s*:\s*\S+/gi,
];

// Secret key-name vocabulary: ONE alternation behind every key-name rule in
// this module — the PR-artifact rules here (#1154) and the source-safe rules
// further down (#876). A single source of truth is load-bearing: a name one
// rule protects and another silently forgets is an unmasked credential nobody
// notices.
const SECRET_KEY_ALTERNATION = "api[_-]?key|token|password|secret|access[_-]?key|auth[_-]?token";

/** Unanchored, case-insensitive key-NAME test (#1154), over that vocabulary:
 * the alternative may sit anywhere in the name, so `client_secret`,
 * `refresh_token`, `dbPassword`, `secretAccessKey` and `apiKey` all match
 * while a name carrying none of them (`filename`, `login`,
 * `sk-prod-service-account-1`) does not. Deliberately NOT `\b`-anchored on
 * either edge: both ends of these names are ordinary identifier characters
 * (`camelCase`, `snake_case`), and an anchored test would exempt exactly the
 * compound names most likely to hold a credential. */
const SECRET_KEY_NAME_RE = new RegExp(SECRET_KEY_ALTERNATION, "i");

function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAME_RE.test(key);
}

/** Return *text* with credential-like values replaced by `[REDACTED]`.
 * Best-effort heuristic redaction for untrusted prose and logs. */
export function redactText(text: string | null | undefined): string {
  if (!text) return "";
  let redacted = text;
  for (const pattern of MASKERS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Line-preserving PR-artifact core (#1154)
// ---------------------------------------------------------------------------

// Identifier characters that may flank a matched alternative inside a key
// NAME, so the whole-content test below accepts `dbPassword` and
// `client_secret` as well as `password` and `secret`.
const KEY_NAME_FLANK = "[A-Za-z0-9_.-]*";

/** A BARE secret key line: the line's whole content is a secret key name,
 * a `:` or `=` separator, and NOTHING else — no value (`password:`,
 * `"token":`, `api_key =`, `  client_secret:`) — optionally followed by a YAML
 * block-scalar indicator (`password: |`, `token: >-`, `api_key: |2`).
 *
 * The block-scalar form is in the SAME rule rather than left to the patterns
 * because a PEM key or certificate is embedded in YAML exactly this way, and
 * the kubeconfig masker does not close it: `password: |` is itself a
 * `key:\s*\S+` match, so that masker rewrites the KEY LINE to `[REDACTED]` and
 * the literal key text no longer reaches this predicate — leaving the block
 * below it verbatim. Bounded deliberately: only a leading indicator character
 * followed by indicator characters (indentation digits and/or chomping) is
 * accepted. It is NOT generalized to "any remainder", because
 * `password = self.password` and `token: opts.token` are code expressions
 * whose following lines must survive untouched. */
const BARE_SECRET_KEY_LINE_RE = new RegExp(
  `^\\s*["'\`]?\\s*${KEY_NAME_FLANK}(?:${SECRET_KEY_ALTERNATION})${KEY_NAME_FLANK}\\s*["'\`]?\\s*[:=]\\s*(?:[|>][-+0-9]*)?\\s*$`,
  "i",
);

function isBareSecretKeyLine(content: string): boolean {
  return BARE_SECRET_KEY_LINE_RE.test(content);
}

/** Cross-line state for the continuation rule. `keyIndent` is the bare key
 * line's OWN indentation width: a continuation is the VALUE of that key, so
 * it is indented strictly deeper than the line that introduced it. Anything at
 * the key's own indent (or shallower) is a sibling — the next statement, the
 * next mapping key, the next call argument — and closes the run. */
interface ContinuationState {
  open: boolean;
  keyIndent: number;
}

function indentOf(content: string): number {
  return /^\s*/.exec(content)?.[0].length ?? 0;
}

/** The line-preserving masking core shared by `redactPrTextLines` and
 * `redactDiffText` (#1154).
 *
 * The flat pass must NEVER run on text whose line structure is load-bearing:
 * several maskers span line breaks (`\s*` matches `\n`), so a multi-line match
 * collapses two lines into one and silently shifts every later line number —
 * inline findings then anchor to the wrong line, and a PR body loses its
 * formatting on the way into `pr.json`/`pr-body.txt`. Here each line is masked
 * INDEPENDENTLY and the per-line result is joined back with `\n`, so line
 * count, order and every line break survive byte-for-byte.
 *
 * Split-line secrets (#1154): a same-line `key: value` is caught by the flat
 * patterns, but a YAML-style credential — a bare key line whose value is a
 * line below it — is not, because every key/value masker is a single-line
 * shape and the cross-line match that would catch it is exactly the collapse
 * this core exists to prevent. So a bare secret key line OPENS a run, and
 * every following line indented STRICTLY deeper than the key line, with
 * non-empty content, has its trimmed content replaced with `[REDACTED]`,
 * keeping its leading indentation. The run terminates at a blank content
 * line, at a line that is not indented deeper than the key, or at end of
 * input.
 *
 * The indentation bound is what keeps the rule usable on real code. Without
 * it, a PR that MOVES a hardcoded secret onto the line below its key destroyed
 * every following statement of the same function — `port=5432,`, the closing
 * `)`, the next call — in the persisted diff, the corpus, and the recorded
 * model request. A continuation is the value OF its key; a same-indent line is
 * a sibling and is not.
 *
 * Accepted over-redaction class, documented rather than "fixed": a
 * DEEPER-indented block after a bare secret key is masked even when it is not
 * a credential — a nested mapping's other keys, a block scalar's own body, a
 * multi-line argument list under a `token:` key. The pattern layer's stated
 * preference applies unchanged: over-redaction beats a leaked credential
 * (#1154). Narrowing further would mean guessing whether an indented line is
 * "data" or "structure", the reading a mask must not do on untrusted input.
 *
 * No diff-header test belongs here. Every unified-diff header shape starts
 * with a non-whitespace character, so a header can never satisfy this rule's
 * deeper-indent requirement, and `redactDiffText` handles its own headers
 * before a line reaches this function. A header test here was dead code.
 *
 * True residuals, all consequences of the preference above rather than gaps in
 * it: a DEEPER-indented non-credential block is masked; a diff judges each of
 * its two sides with its OWN state (see `redactDiffText`), so a run opened on
 * one side never colours the other; and a key name outside the frozen
 * vocabulary (`client_key`, `private_key` — neither carries an alternative in
 * `SECRET_KEY_ALTERNATION`) opens no run at all, so a block scalar under one of
 * those names survives while the same document under `password:` does not.
 *
 * The rule's own bound leaves two more shapes unmasked, and the bound is
 * deliberate (generalizing it to "any remainder" would swallow the code block
 * under `password = self.password`): a key line carrying a TRAILING TOKEN the
 * patterns already consume is rewritten to `[REDACTED]` by those patterns, so
 * the literal key text never reaches this predicate and the indented value
 * below it survives — `password: # db credential` and `password: "` (an
 * unterminated quote in a malformed diff) are the two reachable forms. Both
 * are the same cost as the vocabulary gap above, accepted rather than closed,
 * because closing them means reading past the separator on untrusted input. */
function maskContentLine(content: string, state: ContinuationState): string {
  if (isBareSecretKeyLine(content)) {
    state.open = true;
    state.keyIndent = indentOf(content);
    return redactText(content);
  }
  if (state.open) {
    const indent = indentOf(content);
    if (indent > state.keyIndent && content.trim() !== "") return `${content.slice(0, indent)}${REDACTED}`;
    state.open = false;
  }
  return redactText(content);
}

/** Stateful, content-line-at-a-time view of the masking core (#1154).
 *
 * Exported so a caller that must normalize ONE side of a comparison using the
 * other side's decisions can do it without restating the rules: the
 * change-anchor seam runs one such masker over the diff's new-side stream and
 * another over the head-checkout lines that stream covers, so the two sides
 * agree by construction instead of by coincidence. Lines must be fed in the
 * order they appear — the continuation state carries across calls and is
 * never reset — so a caller MUST feed every intervening line, not a filtered
 * subset. */
export interface PrTextLineMasker {
  /** Mask one line's content (no diff prefix); state carries across calls. */
  maskLine(content: string): string;
  /** End any open continuation run — the same transition `redactDiffText`
   * performs for a line that is not diff content (a hunk header, a file
   * header, `\ No newline`, malformed junk). Named so a caller replaying the
   * diff's decisions — the change-anchor mirror — calls the identical thing
   * instead of passing an empty line and hoping it reads as one. */
  reset(): void;
}

export function createPrTextLineMasker(): PrTextLineMasker {
  const state: ContinuationState = { open: false, keyIndent: 0 };
  return {
    maskLine(content: string): string {
      return maskContentLine(content, state);
    },
    reset(): void {
      state.open = false;
      state.keyIndent = 0;
    },
  };
}

/** Line-preserving pass for PR-authored multi-line text (#1154): splits on
 * `\n`, masks each line through the shared core, and joins with `\n`, so line
 * count, order and every line break survive. This is the seam for text whose
 * LINE STRUCTURE is part of its meaning — a PR body, a `patch` leaf, a
 * head-checkout file — where the flat `redactText` pass would collapse
 * `password:\n<value>` into one line and destroy the structure. It applies the
 * same rules as `redactDiffText` (shared core, including the split-line
 * continuation rule), minus the diff prefix/header handling a unified diff
 * needs, and it sees ONE stream where a diff sees two.
 *
 * Idempotent by construction, and required to stay so (#252): re-persisting an
 * already-redacted artifact must be a no-op. A literal `[REDACTED]` line with
 * no bare key line above it is untouched, and `password:` followed by
 * `  [REDACTED]` converges to itself. */
export function redactPrTextLines(text: string | null | undefined): string {
  if (!text) return "";
  const masker = createPrTextLineMasker();
  return text.split("\n").map((line) => masker.maskLine(line)).join("\n");
}

/** Line-wise counterpart to `redactText` for unified diffs (#1154). Delegates
 * per-line masking to the shared core and owns only what is diff-specific: the
 * `+`/`-`/space prefix is preserved and masked content follows it. Non-content
 * lines that carry PATHS — `diff --git`, `--- a/…`/`+++ b/…`, `rename from/to`,
 * `copy from/to`, and `Binary files … differ` — are masked through a fresh
 * line masker: a credential-shaped token in a path segment is a credential the
 * PR authored into the diff, and the review round on this PR established that
 * leaving those headers verbatim diverges the artifact family (structured
 * filename fields are already redacted by `redactPrTextDeep`). Ordinary paths
 * are untouched — the masker rewrites only credential shapes — and line count,
 * prefixes, `a/`/`b/` structure and quotes all survive, so `parseDiff` still
 * reads every header. The checkout/anchor seam keeps the RAW path for its
 * disk reads (`FileState.rawPath`, extracted from the unredacted diff and
 * never persisted); the sanitized path is what the artifacts record.
 * (`--- `/`+++ ` are distinguished from a `-`/`+` content line by their full
 * three-character prefix; a deleted line whose own content begins `-- ` is
 * indistinguishable and accepted as pathologically unlikely — it is masked by
 * the header rule instead of the content rule, which differs only in which
 * side's continuation state is skipped.)
 *
 * Structure-only metadata (`index`, `@@`, file-mode lines, `\ No newline`,
 * similarity indices, `GIT binary patch`) stays verbatim and still RESETS both
 * continuation runs.
 *
 * TWO independent continuation states, one per side of the change. Each side
 * reconstructs its OWN file and is judged only by that file's lines: the NEW
 * side is driven by context (` `) and added (`+`) lines, the REMOVED side by
 * context (` `) and removed (`-`) lines. A context line advances both and
 * emits the NEW-side result; a header or any other line resets both. Without
 * that split a key line on one side opened a run that swallowed the other
 * side's ordinary lines: a PR that deletes a secret had its entire replacement
 * block rewritten to `[REDACTED]`, and a run opened by a removed line masked
 * added lines that were never its values. A removed line is still masked —
 * it is PR-authored content that persists in `pr.diff` — just by its own
 * side's decisions. Header masking shares NONE of that state: each path
 * header gets its own masker, so a credential-named path cannot open a run
 * that reaches the file's content lines.
 *
 * Because the core never lets a mask span a line break, line count, prefixes
 * and hunk structure survive byte-for-byte: inline findings still anchor to
 * the same line numbers the forge's raw diff defines. Bare token shapes
 * (`sk-`, `ghp_`, `AKIA`, `Bearer …`), same-line `key: value` forms, YAML
 * block scalars, and the split-line `key:`/indented-value form are all masked;
 * see {@link maskContentLine} for the continuation rule and its documented
 * over-redaction class. */
/** Unified-diff metadata lines that carry a PATH segment (#1154). These are
 * masked for credential shapes rather than returned verbatim; every other
 * non-content line stays verbatim and only resets the continuation runs. */
function isPathBearingDiffHeader(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("Binary files ")
  );
}

export function redactDiffText(diff: string | null | undefined): string {
  if (!diff) return "";
  const nextSide = createPrTextLineMasker();
  const removedSide = createPrTextLineMasker();
  return diff.split("\n").map((line) => {
    if (isPathBearingDiffHeader(line)) {
      // Headers are structure, not content: both runs end at a file boundary.
      // The path segments themselves are still PR-authored, so their
      // credential shapes are masked through a masker that shares no state
      // with either content side.
      nextSide.reset();
      removedSide.reset();
      return redactPrTextLines(line);
    }
    const prefix = line.charAt(0);
    if (prefix === " " || prefix === "+") {
      // An added line belongs to the result file only. A CONTEXT line is fed
      // to the removed side as well (it is in the pre-image too), but only
      // the new-side result is emitted, since that is the file the reviewer
      // reads.
      if (prefix === " ") removedSide.maskLine(line.slice(1));
      return prefix + nextSide.maskLine(line.slice(1));
    }
    if (prefix === "-") {
      // Fed to the removed side only. Its own result IS emitted (the line is
      // still PR-authored content that persists in `pr.diff` and reaches the
      // corpus), but the side is its own: a run opened here must never colour
      // a line the change produces.
      return "-" + removedSide.maskLine(line.slice(1));
    }
    nextSide.reset();
    removedSide.reset();
    return line;
  }).join("\n");
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
// correctness (#876). The key-name vocabulary itself
// (`SECRET_KEY_ALTERNATION`) is declared with the PR-artifact core at the top
// of this module: both rule families match the SAME names, so a name the
// source-safe masker protects cannot drift out of the PR-artifact rules.

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
 * code expression never has.
 *
 * Marker contract (#1016): the rules below write credentials INTO the
 * `REDACTED_SOURCE` marker, never OUT of it. A `⟦redacted:credential⟧`
 * substring that is already present in the source (legitimately committed
 * text, or any byte sequence that happens to match the marker) is preserved
 * verbatim — the masker only uses the marker as a replacement target, never
 * as an input pattern. The blocker-verification boundary at
 * `src/enforcement/blocker-verification.ts` relies on this: a finding that
 * cites the literal marker must observe the same marker in the exact-head
 * read for the positive (`marker-present`) path to fire, and a future
 * masker change that redacted the marker out of committed source would
 * silently flip that path to `refuted`. `tests-v3/source-verifier.test.ts`
 * pins the positive path; do not change this contract without updating
 * both the test and the boundary. */
export interface RedactSourceResult { text: string; redactionCount: number; }

function replaceAndCount(
  text: string,
  pattern: RegExp,
  replacement: string | ((...args: any[]) => string),
): RedactSourceResult {
  let redactionCount = 0;
  const result = text.replace(pattern, (...args: any[]) => {
    const match = args[0] as string;
    const replaced = typeof replacement === "string" ? replacement : replacement(...args);
    if (replaced !== match) redactionCount += 1;
    return replaced;
  });
  return { text: result, redactionCount };
}

export function redactSourceText(text: string | null | undefined, filePath?: string | null): string {
  return redactSourceTextDetailed(text, filePath).text;
}

export function redactSourceTextDetailed(text: string | null | undefined, filePath?: string | null): RedactSourceResult {
  if (!text) return { text: "", redactionCount: 0 };
  let redacted = text;
  let redactionCount = 0;
  const replace = (pattern: RegExp, replacement: string | ((...args: any[]) => string)) => {
    const result = replaceAndCount(redacted, pattern, replacement);
    redacted = result.text;
    redactionCount += result.redactionCount;
  };

  // Bare token-shape secrets: the whole match IS the literal, nothing else
  // to preserve.
  replace(/ghp_[A-Za-z0-9]{30,}/g, REDACTED_SOURCE);
  replace(/github_pat_[A-Za-z0-9_]{20,}/g, REDACTED_SOURCE);
  replace(/AKIA[0-9A-Z]{16}/g, REDACTED_SOURCE);
  // OpenAI-style `sk-` legacy bare shape (`sk-<20+ alnum>`), retained exactly
  // as it was. Its one ambiguity — a kebab token whose leading word is 20+
  // characters (`sk-internationalization-notes`) is masked — is pre-existing
  // and irreducible without weakening the pin, and over-redaction is the
  // module's stated preference over a leaked credential.
  replace(/sk-[A-Za-z0-9]{20,}/g, REDACTED_SOURCE);

  // The dash-separated families (#996), ENUMERATED, with the body's first
  // segment required to be an alphanumeric run of at least 20 characters that
  // carries at least one DIGIT or UPPERCASE character — and that entropy
  // character may sit ANYWHERE in the segment, not only within its first 20
  // characters: the scan covers the whole first alphanumeric segment, so
  // `sk-proj-<20 lowercase><uppercase>` is masked.
  //
  // This is a HIGH-CONFIDENCE HEURISTIC with explicitly bounded tradeoffs, not
  // a classifier. No shape-only rule can both mask every real family body and
  // spare every kebab token that begins with a family prefix, because the two
  // are the same token shape: `sk-proj-internationalization2024-notes` is a
  // path, `sk-proj-<24-char base64url body>` is a key, and they differ only in
  // whether the segment is an English word. Each part below exists because its
  // absence let ordinary source through as a key:
  //  - the prefix is closed to families a provider actually issues (a generic
  //    `sk-<seg>-` chain ate `docs/sk-deployment-internationalization-notes`);
  //  - the run must be the body's FIRST segment, because a token that merely
  //    CONTAINS a long word is still a path
  //    (`docs/sk-proj-card-internationalization-notes`);
  //  - the run must carry a digit or uppercase, because `internationalization`
  //    is itself 20 lowercase characters
  //    (`docs/sk-proj-internationalization-notes`).
  //
  // The entropy test is base64url-INFORMED, not base64url-correct: base64url
  // does NOT guarantee an uppercase letter or digit in a body, or in any
  // window of one. A first alphanumeric segment that carries neither is
  // vanishingly unlikely in a real key body, so that miss is accepted rather
  // than traded for the false positive a longer or looser rule would cost. The
  // trailing `[A-Za-z0-9_-]*` still
  // consumes the rest of a `-`/`_`-bearing body, so a real key is masked as ONE
  // literal. `ant-api03` is version-bearing: a future `apiNN` bump is a
  // one-line change here.
  //
  // Accepted boundaries, each pinned by test in `tests-v3/redact.test.ts`:
  //  - FALSE NEGATIVE — a real body whose FIRST alphanumeric segment carries
  //    no digit or uppercase is not masked, wherever that segment ends
  //    (`sk-or-v1-<all-letter hex>`, or `sk-proj-<20 lowercase>-<entropy in a
  //    later segment>`). Syntactically valid base64url; practically unobserved
  //    in real keys.
  //  - FALSE NEGATIVE — a real body carrying `-`/`_` inside its first 20
  //    characters (`sk-proj-ab-<40 alnum>`) is not masked; covering it needs
  //    the run hunted anywhere in the body, which reopens the path above.
  //  - FALSE POSITIVE — a kebab token whose segment after the family prefix is
  //    20+ characters AND carries a digit or uppercase
  //    (`docs/sk-proj-internationalization2024-notes`) is masked. Closing this
  //    needs parsing words — the framing/context signal deliberately kept out
  //    of scope; #996's acceptance is amended to accept it instead.
  // Pre-#997 left all three classes alone; the amended #996 acceptance trades
  // them for covering the three families.
  replace(
    /(?<![A-Za-z0-9])sk-(?:proj|ant-api03|or-v1)-(?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{20,}[A-Za-z0-9_-]*/g,
    REDACTED_SOURCE,
  );

  /* #999: close verified OpenAI/Anthropic families without broadening #997's
   * generic family heuristic. OpenAI keys (legacy plus `proj`, `svcacct`,
   * `admin`, and niche `None`) carry the fixed `T3BlbkFJ` fragment: gitleaks
   * and TruffleHog keyword-anchor on it, and OpenAI docs cover project and
   * service-account shapes. `admin` is detector-backed; `None` is community-
   * only (OpenAI forum thread 879912), so this anchored rule avoids making
   * either prefix alone a reason to redact. The marker makes ordinary path,
   * class, or identifier over-redaction structurally impossible. The pre-marker
   * `{0,256}` bound is load-bearing: without it, marker-free repeated `sk-`
   * input is quadratic (4.3s / 17.6s / 70.2s at 90k / 180k / 360k characters);
   * the bounded rule takes ~0.4s at 1.2M characters. The trailing run is
   * deliberately unbounded, like #997's, so a real key is masked whole. A
   * marker more than 256 characters into a token is not reached at all: this is
   * an accepted clean miss, never a partial mask. Observed bodies are 58–148
   * characters total, with the marker roughly 20–80 characters in, so 256
   * gives >2x headroom.
   *
   * Anthropic's `api03` and `admin01` rules pin gitleaks/TruffleHog and provider-
   * documented shapes: exactly 93 base64url characters plus `AA`. `AA` ends
   * the token, so the trailing guard keeps the shape exact on the upper edge:
   * a longer base64url token survives whole rather than being redacted through
   * its first 95 body characters (which would leave the tail behind). The `oat01`
   * rule follows provider docs and gitleaks PR #2159: a base64url OAuth access
   * token with at least 40 characters. For real keys, these shape pins cover a
   * superset of #997's generic first-run heuristic matches. The pin's
   * contribution is #997's documented early-separator miss: a `-`/`_` inside
   * the body's first 20 characters, which #997's `[A-Za-z0-9]{20,}` cannot
   * cross. If an api03 body's first 20 characters are unbroken alphanumerics,
   * #997 already matches it and the pin is a no-op. #997's two `sk-` rules
   * remain byte-identical as required by this issue. `ant-api03` is
   * version-bearing: a future `apiNN` bump is a one-line edit.
   *
   * Deliberate exclusions and evidence tiers: `sk-ant-api04-` is unverifiable
   * (CSDN/JP blog noise only; absent from Anthropic docs, gitleaks, TruffleHog,
   * and GitHub secret-scanning patterns); `sk-ant-ort01-` (OAuth refresh) and
   * `sk-ant-sid01-` (Claude.ai session) are real but excluded pending the same
   * provider-doc or published-scanner evidence bar. `sk-service-` is only a
   * TruffleHog regex alias with no OpenAI source. No capitalized-prefix rule is
   * added for `sk-Proj-`, but the marker rule is prefix-agnostic: a
   * `sk-Proj-…T3BlbkFJ…` token is still masked because the marker, not the
   * prefix, is the discriminator. The surviving
   * `sk-Proj-configuration-reference` kebab case is pinned by test. Keep
   * `sk-ant-admin-` (without `01`) out of the rules; tests pin it as a survivor.
   *
   * Accepted shape residual: an `oat01` token followed by 40+ characters of
   * hyphenated kebab text is indistinguishable from a body and will be masked.
   * A token ends at the first character outside the base64url charset; that
   * character and everything after it are preserved (`sk-ant-oat01-<40>.XYZ`
   * becomes `⟦redacted:credential⟧.XYZ`). This is the same boundary contract
   * followed by every bare-token rule (`ghp_`, `AKIA`, `sk-`), not a partial
   * leak: a base64url body cannot contain `.`, whitespace, or quotes. The
   * api03/admin01 shape is exact on both edges: a token continuing past `AA`
   * with further base64url characters is not that shape and survives whole,
   * since matching it partially would leak the tail. */
  replace(
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{0,256}T3BlbkFJ[A-Za-z0-9_-]*/g,
    REDACTED_SOURCE,
  );
  replace(
    /(?<![A-Za-z0-9])sk-ant-(?:api03|admin01)-[A-Za-z0-9_-]{93}AA(?![A-Za-z0-9_-])/g,
    REDACTED_SOURCE,
  );
  replace(
    /(?<![A-Za-z0-9])sk-ant-oat01-[A-Za-z0-9_-]{40,}/g,
    REDACTED_SOURCE,
  );

  // Bearer / Basic auth headers: keep the scheme word, mask only the token.
  replace(
    /\b(Bearer|Basic)(\s+)([A-Za-z0-9._+/=-]{20,})/gi,
    (_m, scheme: string, ws: string) => `${scheme}${ws}${REDACTED_SOURCE}`,
  );

  // PEM private key blocks: keep the BEGIN/END lines, mask only the body.
  replace(
    /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g,
    (_m, begin: string, _body: string, end: string) => `${begin}\n${REDACTED_SOURCE}\n${end}`,
  );

  // Kubernetes / kubeconfig credential-bearing keys: keep the key and
  // separator, mask only the value. A tagged form (`!Ref X`, `!Sub ...`,
  // `!GetAtt ...`) is captured whole, to end of line, so it is judged (and,
  // being a reference, left alone) as ONE value rather than truncated at its
  // first space — `!Ref ClientKeyData` must never become `⟦…⟧ ClientKeyData`.
  replace(
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
  replace(
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
    replace(
      new RegExp(`(["'\`]?)(${SECRET_KEY_ALTERNATION})\\1(\\s*[:=]\\s*)(![^\\n#]*|[^\\s#'"]{8,})`, "gi"),
      (m, keyQuote: string, key: string, sep: string, value: string) =>
        isReferenceValue(value.trim(), false) ? m : `${keyQuote}${key}${keyQuote}${sep}${REDACTED_SOURCE}`,
    );
  }

  return { text: redacted, redactionCount };
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
 * pattern-based heuristics (see the module doc) — a known
 * exact secret must be nuked unconditionally, even when it doesn't happen to
 * match any heuristic pattern (e.g. a short or oddly-shaped opaque key
 * echoed bare in a provider's error body, with no `key=`/`Bearer `/etc.
 * framing).
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

/**
 * #1094 review round 3 (blocker): the fail-closed counterpart of
 * `maskKnownSecrets`. Answers exactly one question — does `text` contain any
 * of the configured secrets the CONTENT gate covers? — and shares the
 * masker's variant set (raw, URL-encoded, base64), but NOT its any-length
 * rule: the deliberate floor below is exactly where the two mechanisms
 * disagree, and the masking surfaces (not this gate) carry the any-length
 * guarantee.
 *
 * Why detection instead of masking: `maskKnownSecrets` splices its marker into
 * provider-controlled free text, which is correct for a diagnostic string but
 * WRONG for the completion content that becomes the published verdict —
 * masking there corrupts verdict fields for any short-but-legal configured key
 * (`review_mar⟦•⟧down` → unparseable). The content surfaces therefore refuse
 * the response instead: a caller that detects a configured credential in
 * content it is about to accept, persist, or publish FAILS CLOSED (drops the
 * response, surfaces a masked error) rather than publishing the secret or
 * masking it into a corrupted artifact.
 *
 * Deliberate floor (#1094 review round 3): only secrets whose RAW configured
 * value is at least `MIN_KNOWN_SECRET_CONTENT_LEN` characters participate in
 * the CONTENT gate. Below that floor a configured value is indistinguishable
 * from ordinary prose — a one-character key masks every `k` in `Looks fine.`
 * — and refusing every review that mentions it would make the action
 * unusable, so refusal cannot be the policy there. Such short values keep
 * their full coverage on every NON-content surface (per-leaf
 * `maskKnownSecrets`/`maskKnownSecretsDeep` masking of response bodies,
 * diagnostics, and the envelope projection), which is where their reflection
 * realistically lands; the same 8-character floor is the one `redactText`'s
 * generic `key=value` heuristic already uses. A value at or above the floor
 * is checked in ALL its variants (raw, URL-encoded, base64), with no
 * false-positive leniency — the masker's any-length rule still governs every
 * masking surface, so the two mechanisms disagree only where they must.
 * A sub-floor secret's NON-raw variants are still checked: a short value
 * containing URL-significant characters (`a b&c` → `a%20b%26c`) is
 * distinctive rather than prose-indistinguishable in encoded form, so an
 * encoded echo is refused while the raw false-positive class is not
 * reintroduced. */
export const MIN_KNOWN_SECRET_CONTENT_LEN = 8;

export function containsKnownSecret(text: string, secrets: readonly (string | null | undefined)[] = []): boolean {
  for (const secret of secrets) {
    if (!secret) continue;
    const belowFloor = secret.length < MIN_KNOWN_SECRET_CONTENT_LEN;
    // Below the floor the RAW form is excluded (prose-indistinguishable);
    // the encoded forms stay in — see the doc above. An encoded variant that
    // EQUALS the raw form (every URL-safe sub-floor value encodes to itself:
    // "k" → "k", "7" → "7") is the raw form and is excluded with it, or the
    // floor would be silently void for exactly the values it exists for.
    const variants: string[] = belowFloor ? [] : [secret];
    try {
      const encoded = encodeURIComponent(secret);
      if (!belowFloor || encoded !== secret) variants.push(encoded);
    } catch {
      // Malformed surrogate pairs etc.: the raw variant is still checked.
    }
    try {
      const b64 = Buffer.from(secret, "utf8").toString("base64");
      if (!belowFloor || b64 !== secret) variants.push(b64);
    } catch {
      // Unreachable in practice (Buffer.from/toString don't throw here).
    }
    for (const variant of variants) {
      if (variant !== "" && text.includes(variant)) return true;
    }
  }
  return false;
}

/** Structural counterpart to `redactText`, for a JSON-shaped PR-authored
 * body on its way into a persisted artifact (#1154). `redactText` applied to
 * serialized JSON misses the quoted-key form (`"api_key": "…"` — the quote
 * between key and separator blocks the broad `key=value` masker), so
 * PR-authored JSON artifacts are redacted per string LEAF instead, before
 * serialization. Recursion mechanics mirror `maskKnownSecretsDeep` (below):
 * arrays mapped, objects rebuilt with `Object.fromEntries`
 * (CreateDataPropertyOrThrow, never `out[key] = ...`, so an own `__proto__`
 * key from JSON.parse cannot invoke the prototype setter), depth capped at
 * `MAX_MASK_DEPTH` with a fail-closed `"[REDACTED]"` replacement.
 *
 * Leaves are masked by `redactPrTextLines`, not the flat pass (#1154): a PR
 * body or a `patch` leaf is multi-line text whose line structure is part of
 * what the reviewer reads, and the flat pass's newline-spanning maskers would
 * collapse `password:\n<value>` into one line inside `pr-object.json` /
 * `pr-files.raw.json`. The split-line continuation rule comes with it.
 *
 * Key-name-aware leaves (#1154): a secret-named property is masked on the KEY
 * NAME, because the patterns alone only ever see a leaf in isolation —
 * `{"password":"opaque-value"}` has no `key=value` shape in either half, so
 * value-only masking passed both the key and the credential through. When an
 * object entry's key is secret-named, EVERY string leaf in that subtree (the
 * direct value and anything nested below it, through objects and arrays) is
 * replaced with `[REDACTED]`, since a credential-shaped key can hold a
 * credential under any shape — a string, a list of credentials, a nested
 * object of them. Only two things survive: a REFERENCE value
 * (`isReferenceValue` — `${VAR}`, `{{ … }}`, `!Ref …`, `op://…`, `vault:…`,
 * `ENC[…]`), which is a pointer to a secret rather than the secret, and
 * every NON-string leaf, so JSON shape and value types survive byte-for-byte
 * and the artifact stays as parseable as it arrived.
 *
 * Deliberately VALUES-only, unlike `maskKnownSecretsDeep`'s key masking:
 * PR-authored JSON keys are forge API field names and identity strings
 * (`login`, `filename`, `title`) — structural data downstream consumers
 * match on — not credential echo surfaces; masking keys would corrupt file
 * lists and author identity for an `sk-`-shaped login or path, the same
 * accepted false-positive class the pattern layer already documents for
 * values. The key name is what SELECTS the rule here, never what it rewrites.
 * The generic layer's documented false-positive class applies
 * unchanged here: a fixture value that happens to be credential-shaped is
 * masked too — over-redaction is the module's stated preference over a
 * leaked credential (#1154).
 *
 * Distinct from the `redactTextDeep(value, secrets)` sibling introduced by
 * the provider-body routing (#1149/#1153): that one composes configured-key
 * masking with the patterns and masks own KEYS too (provider-controlled
 * metadata names are echo surfaces); this one is patterns-only and
 * values-only, because PR-authored keys are forge structural identity
 * (logins, filenames) that downstream consumers match on.
 *
 * `keyNames` (default `true`) is the one knob: set it false for a STRUCTURED
 * projection whose key names are part of the contract rather than an echo
 * surface — the model's own verdict content (`src/tools/harness.ts`), where a
 * secret-named CATEGORY (`secret_handling_changes` is a real classification
 * category) carries a label or a boolean the reviewer must read, and masking
 * it would rewrite the verdict. The key-name rule is then off and leaves get
 * the pattern-only redaction this function always applied. PR artifacts keep
 * the default: their keys are forge field names, and a credential-shaped key
 * there really can name a credential value.
 *
 * Idempotent, and required to stay so (#252): a re-read of an already-redacted
 * artifact is a no-op, and `[REDACTED]` under a secret-named key re-masks to
 * the same marker rather than nesting. */
export function redactPrTextDeep(
  value: unknown,
  depth = 0,
  secretKey = false,
  keyNames = true,
): unknown {
  if (typeof value === "string") {
    if (!secretKey || !keyNames) return redactPrTextLines(value);
    return isReferenceValue(value, false) ? value : REDACTED;
  }
  if (depth >= MAX_MASK_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactPrTextDeep(item, depth + 1, secretKey, keyNames));
  if (typeof value === "object" && value !== null) {
    // `Object.fromEntries`, never `out[key] = ...`: the same prototype-setter
    // rule as `maskKnownSecretsDeep` — a hostile PR body can carry an own
    // `__proto__` key through the forge API's JSON, and a plain assignment
    // would invoke the prototype setter instead of defining the key.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactPrTextDeep(item, depth + 1, secretKey || (keyNames && isSecretKeyName(key)), keyNames),
      ]),
    );
  }
  return value;
}

/** Structural counterpart to `maskKnownSecrets`, for a JSON-shaped provider
 * body on its way into a persisted artifact (#1037). Same masking, applied
 * per string LEAF — and, since the #1094 review round 3 key-echo fix, to
 * every own object KEY as well: array order, numbers, and every structural
 * token survive byte-for-byte, so a masked artifact is still valid JSON with
 * the same shape (the marker contains no character JSON requires escaping).
 * Key masking exists because provider-controlled property NAMES are an echo
 * surface too — `{ "error": { "<credential>": "rejected" } }` used to persist
 * the credential in the key while value-only masking cleaned every leaf —
 * so each own key goes through `maskKnownSecrets` (raw, URL-encoded, and
 * base64 variants, any length) before the entry is built. Benign keys pass
 * through unchanged: masking is a pure substring replacement that touches a
 * key only when a configured value occurs in it, so distinct benign keys
 * stay distinct and only secret-bearing keys change. A known collision is
 * accepted: two distinct secret-bearing keys can collapse onto the same
 * masked name (`Object.fromEntries` keeps the last), losing one diagnostic
 * entry — a shape cost, never a leak, and the alternative (indexing or
 * escaping) would fabricate provider-invisible structure. Masking the
 * serialized
 * text instead would be wrong twice over — a configured header value carrying
 * `"` or `\` is JSON-escaped in the artifact, so an exact-substring pass over
 * the serialized bytes would miss it entirely, and a match on a structural
 * token (`": "`) would corrupt the document.
 *
 * `depth` is an internal recursion bound that keeps a pathologically nested
 * body from blowing the stack. At the cap the subtree FAILS CLOSED: it is
 * replaced by `KNOWN_SECRET_REDACTED` rather than serialized. Serializing it
 * and masking the result — the earlier form — was wrong for the same reason
 * above: `JSON.stringify` escapes `"` and `\`, so a configured value carrying
 * either (`gw-abc"def`) came out as `gw-abc\"def`, the literal substring never
 * matched, and JSON-decoding the artifact recovered the secret. It also had
 * the flat-text pass's second hazard — a short configured key can match a
 * structural token of the serialization and corrupt the document — and its
 * cyclic `catch` returned the subtree RAW, unmasked, which is precisely the
 * fail-open this module must never take. Losing a >32-level subtree's contents
 * from one diagnostic artifact is an acceptable cost next to any of those.
 */
const MAX_MASK_DEPTH = 32;

export function maskKnownSecretsDeep(value: unknown, secrets: readonly (string | null | undefined)[] = [], depth = 0): unknown {
  if (typeof value === "string") return maskKnownSecrets(value, secrets);
  if (depth >= MAX_MASK_DEPTH) return KNOWN_SECRET_REDACTED;
  if (Array.isArray(value)) return value.map((item) => maskKnownSecretsDeep(item, secrets, depth + 1));
  if (typeof value === "object" && value !== null) {
    // `Object.fromEntries` (CreateDataPropertyOrThrow), NOT `out[key] = ...`:
    // a hostile provider body can carry an OWN `__proto__` key (JSON.parse
    // produces exactly that), and a plain assignment onto a fresh object
    // invokes the prototype setter instead of defining the key — the key
    // would silently vanish from the artifact and `out`'s prototype would
    // become provider-controlled data. fromEntries defines it as an own data
    // property, so the documented key-preservation rule holds.
    // Masking the key above does NOT change this property-definition
    // mechanism: what reaches fromEntries is just a (possibly rewritten)
    // STRING, and fromEntries defines whatever string it is given as an own
    // data property. A key that survives masking unchanged (benign, or an
    // own `__proto__` no secret matches) lands exactly as before; a key the
    // masker rewrote is a different property NAME that is defined the same
    // way — it can never turn into a prototype-setter invocation, and a
    // rewritten `__proto__` is simply an innocently named own property.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [maskKnownSecrets(key, secrets), maskKnownSecretsDeep(item, secrets, depth + 1)]),
    );
  }
  return value;
}

/**
 * #1140 review, applied by #1149: `maskKnownSecretsDeep` plus `redactText`'s
 * generic pattern rules, per string leaf AND per own object key.
 * `maskKnownSecretsDeep` masks only the operator's CONFIGURED credential
 * values, so a provider-authored credential the run never configured —
 * `api_key=provider-only-secret-…`, a bare `Bearer …`, an `sk-…` token — rode
 * verbatim into the confidence diagnostic request/response artifacts (#1140)
 * and into the main review's persisted `ai-response.<tier>.json` and
 * `specialist-<role>.response.json` raw bodies (#1149). Those artifacts are raw
 * provider bodies: exactly the surface where an unknown, provider-invented key
 * is most likely to be echoed back, and exactly the surface that is persisted
 * and shipped as a job artifact. The review's own CONTENT surfaces are not the
 * counter-example: `ai-output.json` is deliberately left unmasked so a short
 * configured key cannot corrupt the published verdict, and completion content
 * REFUSES rather than masks (`containsKnownSecret`) — but the raw JSON bodies
 * on their way to disk went through the configured-value layer alone, which
 * left a gap between what the review says it redacts and what it writes.
 *
 * Every safety property of `maskKnownSecretsDeep` is inherited unchanged:
 * masking happens BEFORE any serialization/truncation (so no variant is split
 * across a boundary), the same `MAX_MASK_DEPTH` cutoff FAILS CLOSED to
 * `KNOWN_SECRET_REDACTED`, arrays map element-wise, non-string/non-object
 * leaves (numbers, booleans, null) pass through untouched, and the rebuild
 * goes through `Object.fromEntries` so a hostile own `__proto__` key is
 * defined as a data property rather than invoking the prototype setter —
 * masking a KEY only rewrites the string that `fromEntries` defines, so it can
 * never become a setter invocation. The only difference is the leaf
 * function: `redactText(maskKnownSecrets(leaf, secrets))`, so a configured
 * value is still nuked unconditionally first and the generic heuristics run on
 * what is left.
 *
 * The `redactText` half is deliberately a superset of "never leaks": it can
 * redact a shaped value that is genuinely not a secret (a config-ish
 * `apiKey: config.apiKey`), which is why this is for diagnostic artifacts and
 * not for completion content (see `containsKnownSecret` for that surface).
 *
 * That half also rewrites the KEY with the same generic rules, so any two
 * credential-shaped keys collapse onto the one `[REDACTED]` literal
 * (`{"api_key=aaa…":1,"api_key=bbb…":2}` becomes a single entry) — the same
 * accepted-collision class `maskKnownSecretsDeep` documents above for its
 * configured keys, and more reachable here because the generic rules fire on
 * shape alone. The cost is bounded to losing diagnostic shape in these
 * artifacts, never a leak: masking only ever rewrites a key toward the marker,
 * so a collapsed pair hides an already-redacted name rather than exposing
 * anything, and `fromEntries` keeping the last entry cannot resurrect one.
 */
export function redactTextDeep(value: unknown, secrets: readonly (string | null | undefined)[] = [], depth = 0): unknown {
  if (typeof value === "string") return redactText(maskKnownSecrets(value, secrets));
  if (depth >= MAX_MASK_DEPTH) return KNOWN_SECRET_REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactTextDeep(item, secrets, depth + 1));
  if (typeof value === "object" && value !== null) {
    // Same construction, and the same reason, as `maskKnownSecretsDeep`
    // above: `Object.fromEntries` (CreateDataPropertyOrThrow), NOT
    // `out[key] = ...`, so a hostile own `__proto__` key cannot invoke the
    // prototype setter. Masking the key does not change that mechanism —
    // what reaches `fromEntries` is just a (possibly rewritten) string.
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(maskKnownSecrets(key, secrets)),
        redactTextDeep(item, secrets, depth + 1),
      ]),
    );
  }
  return value;
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
 * Originally ported from v2's `mask_and_truncate`: redact secrets, then
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
export interface MaskSourceResult { text: string; truncated: boolean; redactionCount: number; }

export function maskAndTruncateSource(
  text: string | null | undefined,
  maxBytes: number,
  filePath?: string | null,
): { text: string; truncated: boolean } {
  const { text: masked, truncated } = maskAndTruncateSourceDetailed(text, maxBytes, filePath);
  return { text: masked, truncated };
}

export function maskAndTruncateSourceDetailed(
  text: string | null | undefined,
  maxBytes: number,
  filePath?: string | null,
): MaskSourceResult {
  const result = redactSourceTextDetailed(text, filePath);
  const raw = Buffer.from(result.text, "utf8");
  if (raw.length <= maxBytes) {
    return { ...result, truncated: false };
  }
  const clipped = raw.subarray(0, maxBytes).toString("utf8");
  return { ...result, text: clipped + "\n[truncated]", truncated: true };
}

export function sourceEvidence(
  text: string | null | undefined,
  filePath: string | null | undefined,
  file: string | null,
  revision: string | null,
): { text: string; provenance: import("./evidence-provenance.js").EvidenceProvenance } {
  const result = redactSourceTextDetailed(text, filePath);
  const provenance = result.redactionCount > 0
    ? sanitizedSourceProvenance(result.redactionCount, file, revision)
    : committedSourceProvenance(file, revision);
  return { text: result.text, provenance };
}
