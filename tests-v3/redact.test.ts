import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_SECRET_REDACTED,
  REDACTED_SOURCE,
  maskAndTruncateSource,
  maskDiagnostic,
  maskKnownSecrets,
  redactSourceText,
  redactText,
} from "../src/context/redact.js";
import { describeTransportFailure, TransportFailure } from "../src/transport/http.js";

// #876: repository SOURCE content (tool reads, grep matches, blame, related-code
// snippets) must survive structurally under redaction — every rule replaces
// ONLY the credential VALUE, never a key name, delimiter, quote, or other
// syntax. The heuristic `redactText` policy (untrusted prose/log/web
// payloads) is unchanged and still over-redacts these code shapes, which is
// exactly the #862/#876 false-positive this module fixes for source evidence.

test("#876: code-expression secret-named assignments survive redactSourceText byte-for-byte", () => {
  const lines = [
    "apiKey: config.apiKey,",
    "      apiKey: profile.apiKey,",
    "token: opts.token",
    "password=self.password",
    "secret = getSecret()",
    "accessKey: creds.accessKey,",
  ];
  for (const line of lines) {
    assert.equal(redactSourceText(line), line, `expected ${JSON.stringify(line)} to survive unchanged`);
    // Same result in a code file (unquoted = expression there too).
    assert.equal(redactSourceText(line, "src/model/auth.ts"), line);
  }
});

test("#876: redactText (the heuristic prose/log policy) still over-redacts the same code shapes", () => {
  // Documents the bug this module fixes: the ORIGINAL heuristic masker is
  // still appropriate for untrusted prose/logs, but it is not source-safe —
  // callers reading repository source must use redactSourceText instead.
  assert.equal(redactText("apiKey: config.apiKey,"), "[REDACTED]");
  assert.equal(redactText("token: opts.token"), "[REDACTED]");
});

test("#989: masks OpenAI-style provider keys without matching hyphenated prose", () => {
  const keys = [
    "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    "sk-or-v1-abcdef0123456789abcdef0123456789",
  ];
  for (const key of keys) {
    const result = redactText(`credential ${key}`);
    assert.ok(result.includes("[REDACTED]"), `expected marker for ${key}`);
    assert.ok(!result.includes(key), `raw key survived: ${result}`);
  }

  const ordinaryProse = [
    "the task-runner-with-a-long-name ran",
    "risk-assessment-of-the-change",
  ];
  for (const prose of ordinaryProse) {
    assert.equal(redactText(prose), prose, "a letter before `sk-` means mid-word prose, not a key");
  }

  const key = keys[0]!;
  for (const framed of [`key=${key}`, `"${key}"`, `${key}\nnext line`]) {
    const result = redactText(framed);
    assert.ok(!result.includes(key), `raw key survived framing: ${result}`);
    assert.ok(result.includes("[REDACTED]"));
  }
  // A separator immediately before the key must still mask it. This is why the
  // rule uses a lookbehind rather than `\b`: `_` is a word character, so `\b`
  // would let a key written straight after one through.
  for (const separator of ["_", "-", ":", "/", "|", "(", "["]) {
    const framed = `${separator}${key}`;
    assert.ok(!redactText(framed).includes(key), `raw key survived after ${JSON.stringify(separator)}`);
  }
  // `_` is in the body charset, so a trailing one is absorbed into the mask —
  // harmless over-redaction, and the key itself is gone.
  assert.equal(redactText(`_${key}_`), "_[REDACTED]", "underscore emphasis around a key must still mask it");
  assert.equal(redactText("api_key=zzzzzzzzzzzz"), "[REDACTED]");

  const masked = redactText(`token ${key}`);
  assert.equal(redactText(masked), masked, "redaction should be idempotent for masked provider keys");
});

test("#876 maintainer-review: only the VALUE is replaced — key, delimiter, quotes, and trailing punctuation survive", () => {
  assert.equal(redactSourceText('apiKey: "hunter2hunter2",'), `apiKey: "${REDACTED_SOURCE}",`);
  assert.match(redactSourceText('apiKey: "hunter2hunter2",'), /^apiKey: "⟦redacted:credential⟧",$/);
  assert.equal(redactSourceText("password: 'hunter2hunter2hunter2'"), `password: '${REDACTED_SOURCE}'`);
  assert.equal(
    redactSourceText('client-key-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t'),
    `client-key-data: ${REDACTED_SOURCE}`,
  );
  assert.equal(
    redactSourceText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"),
    `Authorization: Bearer ${REDACTED_SOURCE}`,
  );
});

test("#876: PEM private key blocks keep the BEGIN/END lines, mask only the body", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\nMORE_KEY_BYTES_HERE\n-----END RSA PRIVATE KEY-----";
  const result = redactSourceText(pem);
  assert.match(result, /^-----BEGIN RSA PRIVATE KEY-----\n/);
  assert.match(result, /\n-----END RSA PRIVATE KEY-----$/);
  assert.ok(result.includes(REDACTED_SOURCE));
  assert.ok(!result.includes("MIIBOgIBAAJBAK"));
});

test("#876: bare token-shape secrets (no key to preserve) still replace the whole literal", () => {
  assert.equal(redactSourceText("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), REDACTED_SOURCE);
  assert.equal(redactSourceText("github_pat_abcdefghijklmnopqrstuvwxyz0123456789"), REDACTED_SOURCE);
  assert.equal(redactSourceText("AKIAABCDEFGHIJKLMNOP"), REDACTED_SOURCE);
  assert.equal(redactSourceText("sk-abcdefghijklmnopqrstuvwxyz"), REDACTED_SOURCE);
});

// #996: the dashed `sk-` families (`sk-proj-…`, `sk-ant-api03-…`,
// `sk-or-v1-…`) are the same class of provider key as the bare form, but the
// old `sk-[A-Za-z0-9]{20,}` stopped at the first `-` and let all three through
// in source evidence. The fix keeps the rule source-safe rather than copying
// the prose rule: a body must still contain a long UNBROKEN alphanumeric run,
// which is what distinguishes a key body from the kebab-case identifiers,
// paths and CSS classes that `-`/`_` in the prose rule's body would swallow.

const PROJ_KEY = "sk-proj-T3BlbkFJ9abcdefghijklmnopqrstuvwxyz012345";
const ANT_KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
const OR_KEY = `sk-or-v1-${"0123456789abcdef".repeat(4)}`;

test("#996: every named sk- family is masked in source evidence, and only the token changes", () => {
  assert.equal(redactSourceText(PROJ_KEY), REDACTED_SOURCE);
  assert.equal(redactSourceText(ANT_KEY), REDACTED_SOURCE);
  assert.equal(redactSourceText(OR_KEY), REDACTED_SOURCE);

  // The marker is the ONLY change — quote, separator, comma and terminator
  // survive, exactly as the source redactor's contract requires.
  assert.equal(redactSourceText(`const k = "${PROJ_KEY}";`), `const k = "${REDACTED_SOURCE}";`);
  assert.equal(redactSourceText(`{"apiKey": "${PROJ_KEY}",}`), `{"apiKey": "${REDACTED_SOURCE}",}`);
  assert.equal(redactSourceText(`API_KEY=${ANT_KEY}`), `API_KEY=${REDACTED_SOURCE}`);
  assert.equal(redactSourceText(`${PROJ_KEY}\n`), `${REDACTED_SOURCE}\n`);
  // Path-independent, like the other bare-token shapes.
  assert.equal(redactSourceText(PROJ_KEY, "src/model/call.ts"), REDACTED_SOURCE);
});

test("#996 adversarial: the sk- rule must not eat ordinary kebab-case source", () => {
  // Every one of these has the shape a naive `sk-[A-Za-z0-9_-]{16,}` body
  // would mask, which is why the rule keeps the long-unbroken-run requirement.
  const survivors = [
    "docs/sk-deployment-runbook-notes",
    "sk-button-primary-large",
    "src/sk-configuration-reference.ts",
    'class="sk-card-with-title-and-actions"',
    "--sk-skip-verification-notes",
    "x-sk-tracker-component-v2",
    // A dashed family prefix with a too-short body is not a key.
    "sk-ant-api03-abc",
    // `sk-` preceded by a letter is the hyphenated-prose guard (the existing
    // `risk-`/`disk-` class): the anchor rejects these outright.
    "risk-assessment-of-the-change",
    "disk-usage-report-for-the-cluster",
    "// the task-runner-with-a-long-name helper",
    // Review round: a dashed prefix we do NOT issue is not a key. A generic
    // `sk-<seg>-` allowance masked this path, so the families are enumerated.
    "docs/sk-deployment-internationalization-notes",
    "sk-deployment-abcdefghijklmnopqrstuvwxyz012345",
    // Review round 2: a real family PREFIX alone must still not be enough —
    // the body has to carry the long unbroken run that separates a key from a
    // path or a class. Every segment here is a short word, so none qualifies.
    "docs/sk-proj-deployment-runbook-notes",
    "sk-proj-card-with-title-and-actions",
    "docs/sk-or-v1-migration-and-release-notes",
    "sk-ant-api03-configuration-reference",
    // Review round 3: containing a 20-character word is not enough either —
    // the run must sit directly after the family prefix, or a path with one
    // long English word is a key.
    "docs/sk-proj-card-internationalization-notes",
    "sk-ant-api03-card-internationalization-notes",
    // Review round 4: `internationalization` is itself exactly 20 lowercase
    // characters, so the run must also carry a digit or uppercase — a
    // high-confidence signal, not a guarantee. English words have neither;
    // real base64url bodies almost always do, and the lowercase-body miss is
    // the accepted residual for the ones that do not.
    "docs/sk-proj-internationalization-notes",
    "sk-proj-internationalization-notes",
  ];
  for (const line of survivors) {
    assert.equal(redactSourceText(line), line, `expected ${JSON.stringify(line)} to survive`);
    assert.equal(redactSourceText(line, "src/x.ts"), line);
  }
});

test("#996 adversarial: the legacy bare floor is exact — 19 characters survive, 20 mask", () => {
  assert.equal(redactSourceText(`sk-${"a".repeat(19)}`), `sk-${"a".repeat(19)}`);
  assert.equal(redactSourceText(`sk-${"a".repeat(20)}`), REDACTED_SOURCE);
});

test("#996 adversarial: a family body needs BOTH 20 characters and entropy — neither alone is enough", () => {
  // Length without entropy survives (the accepted false negative below).
  assert.equal(redactSourceText(`sk-proj-${"a".repeat(20)}`), `sk-proj-${"a".repeat(20)}`);
  assert.equal(redactSourceText(`sk-ant-api03-${"a".repeat(20)}`), `sk-ant-api03-${"a".repeat(20)}`);
  assert.equal(redactSourceText(`sk-or-v1-${"a".repeat(20)}`), `sk-or-v1-${"a".repeat(20)}`);
  // Entropy without length survives.
  assert.equal(redactSourceText(`sk-proj-${"a".repeat(18)}A`), `sk-proj-${"a".repeat(18)}A`);
  // Both together mask.
  assert.equal(redactSourceText(`sk-proj-0${"a".repeat(19)}`), REDACTED_SOURCE);
  assert.equal(redactSourceText(`sk-proj-${"a".repeat(19)}A`), REDACTED_SOURCE);
  assert.equal(redactSourceText(`sk-ant-api03-${"0".repeat(20)}`), REDACTED_SOURCE);
});

test("#996 adversarial: a body containing the separator charset is masked whole, with no tail left behind", () => {
  const dashedBody = `sk-ant-api03-${"abc123".repeat(8)}-tail-seg`;
  const masked = redactSourceText(dashedBody);
  assert.equal(masked, REDACTED_SOURCE);
  assert.ok(!masked.includes("tail-seg"), `key tail leaked: ${masked}`);

  // An uppercase/underscore-bearing base64url body (`-`/`_` are legal in it).
  const underscored = `sk-or-v1-${"aB3dE5".repeat(6)}_more_body`;
  assert.ok(!redactSourceText(underscored).includes("more_body"));
});

// #996 (acceptance as amended by review): the sk- family rule is a
// HIGH-CONFIDENCE HEURISTIC with explicitly bounded tradeoffs, not a
// classifier. No shape-only rule can both mask every real family body and
// spare every kebab token that begins with a family prefix —
// `sk-proj-internationalization2024-notes` is a path and
// `sk-proj-<24-char base64url body>` is a key, and they differ only in whether
// the segment is an English word. The three tests below pin the accepted
// boundaries; pre-#997 left all three classes alone.

test("#996 accepted boundary (false negative): a body whose first 20 characters are all lowercase is not masked", () => {
  // Syntactically valid base64url — base64url does NOT guarantee an uppercase
  // or digit in any 20-character window — but practically unobserved in real
  // keys, so the miss is accepted rather than traded for the false positive a
  // looser rule would cost.
  const lowercaseBody = `sk-or-v1-${"abcdef".repeat(11)}`;
  assert.equal(redactSourceText(lowercaseBody), lowercaseBody);
  assert.equal(redactSourceText(`sk-proj-${"a".repeat(20)}`), `sk-proj-${"a".repeat(20)}`);
});

test("#996 accepted boundary (false negative): a separator inside the body's first 20 characters is left alone", () => {
  // Hunting the run anywhere in the body covers this shape — an earlier
  // revision of this rule did mask it — but the same relaxation also masked
  // `docs/sk-proj-card-internationalization-notes`, so the miss is accepted.
  const dashEarly = `sk-proj-ab-${"abcdefghijklmnopqrstuvwxyz012345"}`;
  assert.equal(redactSourceText(dashEarly), dashEarly);
});

test("#996 accepted boundary (false positive): a 20+ character kebab segment carrying a digit is masked", () => {
  // `internationalization2024` satisfies the entropy heuristic, so this path is
  // masked where pre-#997 leaves it alone. Closing this class needs parsing
  // words — the framing/context signal deliberately out of scope; #996's
  // acceptance is amended to accept it in exchange for covering the families.
  assert.equal(
    redactSourceText("docs/sk-proj-internationalization2024-notes"),
    `docs/${REDACTED_SOURCE}`,
  );
  assert.equal(redactSourceText("sk-proj-internationalization2024-notes"), REDACTED_SOURCE);
});

test("#996 adversarial: masking is idempotent and the marker is never re-matched", () => {
  const once = redactSourceText(`key=${PROJ_KEY}`);
  assert.equal(once, `key=${REDACTED_SOURCE}`);
  assert.equal(redactSourceText(once), once);
});

test("#996: line shape is preserved — redaction never adds or removes lines", () => {
  const snippet = ["{", `  "apiKey": "${PROJ_KEY}",`, `  "nested": {"k": "${ANT_KEY}"}`, "}"].join("\n");
  const out = redactSourceText(snippet, "config.json");
  assert.equal(out.split("\n").length, snippet.split("\n").length);
  assert.equal(out, ["{", `  "apiKey": "${REDACTED_SOURCE}",`, `  "nested": {"k": "${REDACTED_SOURCE}"}`, "}"].join("\n"));
});

test("#996: maskAndTruncateSource inherits the dashed-family masking", () => {
  const result = maskAndTruncateSource(`token = "${PROJ_KEY}"`, 4096);
  assert.equal(result.truncated, false);
  assert.equal(result.text, `token = "${REDACTED_SOURCE}"`);
  // The config-file unquoted-literal path masks it too.
  assert.equal(redactSourceText(`token: ${PROJ_KEY}`, "config/values.yaml"), `token: ${REDACTED_SOURCE}`);
});

test("#876: the source-safe marker is distinct from the heuristic [REDACTED] marker", () => {
  assert.notEqual(REDACTED_SOURCE, "[REDACTED]");
  assert.doesNotMatch(REDACTED_SOURCE, /\[REDACTED\]/);
});

test("#876 maintainer-review: unquoted secret-named literals are masked in config-like files", () => {
  const yamlLine = "token: hunter2hunter2";
  assert.equal(redactSourceText(yamlLine, "config/values.yaml"), `token: ${REDACTED_SOURCE}`);
  assert.equal(redactSourceText("password: correcthorsebattery", "app.ini"), `password: ${REDACTED_SOURCE}`);
  assert.equal(redactSourceText("password: correcthorsebattery", ".env"), `password: ${REDACTED_SOURCE}`);
  assert.equal(redactSourceText("API_KEY=abc123def456", ".env.production"), `API_KEY=${REDACTED_SOURCE}`);
  assert.equal(redactSourceText("ARG API_KEY=abc123def456", "Dockerfile"), `ARG API_KEY=${REDACTED_SOURCE}`);
  assert.equal(redactSourceText("secret: hunter2hunter2", "kubeconfig"), `secret: ${REDACTED_SOURCE}`);
  assert.equal(redactSourceText("apiKey: abc123def456", "app.properties"), `apiKey: ${REDACTED_SOURCE}`);
});

test("#876 maintainer-review: the SAME unquoted literal in a code (or unknown) file is left alone", () => {
  assert.equal(redactSourceText("token: hunter2hunter2"), "token: hunter2hunter2");
  assert.equal(redactSourceText("token: hunter2hunter2", "src/config.ts"), "token: hunter2hunter2");
  assert.equal(redactSourceText("token: hunter2hunter2", "unknown-file"), "token: hunter2hunter2");
});

test("#876 maintainer-review: reference values are never masked, quoted or not", () => {
  const referenceLines = [
    ["password: ${DB_PASSWORD}", "values.yaml"],
    ["password: $DB_PASSWORD", "values.yaml"],
    ["apiKey: {{.Values.apiKey}}", "values.yaml"],
    ["apiKey: op://vault/item/api-key", "values.yaml"],
    ["password: vault:secret/data/app#password", "values.yaml"],
    ["password: ENC[AES256_GCM,data:abcd,iv:abcd,tag:abcd]", "secrets.yaml"],
  ] as const;
  for (const [line, path] of referenceLines) {
    assert.equal(redactSourceText(line, path), line, `expected reference ${JSON.stringify(line)} to survive`);
  }
  // Quoted references are also left alone (both code and config).
  assert.equal(redactSourceText('apiKey: "${API_KEY}"', "values.yaml"), 'apiKey: "${API_KEY}"');
  assert.equal(redactSourceText('apiKey: "${API_KEY}"'), 'apiKey: "${API_KEY}"');
});

test("#876 maintainer-review: secretKeyRef/valueFrom YAML structure is never touched", () => {
  const block = [
    "env:",
    "  - name: API_KEY",
    "    valueFrom:",
    "      secretKeyRef:",
    "        name: my-secret",
    "        key: password",
  ].join("\n");
  assert.equal(redactSourceText(block, "deployment.yaml"), block);
});

test("#876 maintainer-review round 2: quoted JSON/YAML keys are masked — key quotes, colon, value quotes, and surrounding punctuation survive", () => {
  assert.equal(redactSourceText('{"token": "hunter2hunter2"}', "config.json"), `{"token": "${REDACTED_SOURCE}"}`);
  assert.equal(redactSourceText('{"token":"hunter2hunter2"}', "config.json"), `{"token":"${REDACTED_SOURCE}"}`);
  assert.equal(redactSourceText('{"apiKey": "hunter2hunter2"}', "config.json"), `{"apiKey": "${REDACTED_SOURCE}"}`);
  // Quoted-value masking is universal (not path-gated) — same result in an
  // unknown/code path.
  assert.equal(redactSourceText('{"token": "hunter2hunter2"}'), `{"token": "${REDACTED_SOURCE}"}`);

  // Pretty-printed multi-line JSON: only the value line changes.
  const pretty = ["{", '  "apiKey": "hunter2hunter2",', '  "baseUrl": "https://example.com"', "}"].join("\n");
  const expected = ["{", `  "apiKey": "${REDACTED_SOURCE}",`, '  "baseUrl": "https://example.com"', "}"].join("\n");
  assert.equal(redactSourceText(pretty, "config.json"), expected);

  // YAML with a quoted key and an unquoted literal value (config-only).
  assert.equal(redactSourceText('"password": correcthorsebattery', "values.yaml"), `"password": ${REDACTED_SOURCE}`);
  // Same shape in code (or unknown path) is left alone.
  assert.equal(redactSourceText('"password": correcthorsebattery', "src/x.ts"), '"password": correcthorsebattery');
});

test("#876 maintainer-review round 2: kubeconfig masker respects reference values and whole-line tagged forms", () => {
  // A reference must never be masked, even for the kubeconfig-specific rule.
  assert.equal(
    redactSourceText("client-key-data: ${CLIENT_KEY_DATA}", "kubeconfig"),
    "client-key-data: ${CLIENT_KEY_DATA}",
  );
  // A CloudFormation-style tag is captured as ONE value to end of line, not
  // truncated at its first space — must never become
  // `client-key-data: ⟦redacted:credential⟧ ClientKeyData`.
  assert.equal(
    redactSourceText("client-key-data: !Ref ClientKeyData", "kubeconfig"),
    "client-key-data: !Ref ClientKeyData",
  );
  assert.equal(
    redactSourceText("client-certificate-data: !Sub '${ClientCertData}'", "kubeconfig"),
    "client-certificate-data: !Sub '${ClientCertData}'",
  );
  // A real base64 literal is still masked, key and separator kept.
  assert.equal(
    redactSourceText("client-key-data: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t", "kubeconfig"),
    `client-key-data: ${REDACTED_SOURCE}`,
  );
});

test("#876 maintainer-review round 2: the generic unquoted-config rule also treats a tagged reference as one whole-line value", () => {
  assert.equal(redactSourceText("token: !Ref TokenParam", "values.yaml"), "token: !Ref TokenParam");
  assert.equal(redactSourceText("apiKey: !GetAtt MyStack.ApiKey", "values.yaml"), "apiKey: !GetAtt MyStack.ApiKey");
});

test("#876 maintainer-review round 3: a quoted value starting with `!` is a real literal, not a tag — mask it", () => {
  assert.equal(redactSourceText('password: "!hunter2hunter2"', "values.yaml"), `password: "${REDACTED_SOURCE}"`);
  assert.equal(redactSourceText("password: '!hunter2hunter2'", "src/x.ts"), `password: '${REDACTED_SOURCE}'`);
});

test("#876 maintainer-review round 3: a quoted bare $VAR-shaped literal is masked; a quoted braced ${VAR} reference survives only when it is the WHOLE value", () => {
  // "$ecret123" is shaped exactly like a bare env-var reference, but a
  // QUOTED bare $VAR is never exempted — only the braced form is unambiguous
  // enough to trust inside quotes.
  assert.equal(redactSourceText('password: "$ecret123"', "values.yaml"), `password: "${REDACTED_SOURCE}"`);
  // A prefix/suffix around a braced reference is not "the entire value is
  // exactly the reference form" — still a real secret, still masked.
  assert.equal(
    redactSourceText('password: "prefix${VAR}suffix-realsecret"', "values.yaml"),
    `password: "${REDACTED_SOURCE}"`,
  );
  // The whole quoted value being exactly `${VAR}` still survives.
  assert.equal(redactSourceText('apiKey: "${API_KEY}"', "values.yaml"), 'apiKey: "${API_KEY}"');
});

test("#876 maintainer-review round 3: only the recognized CloudFormation-tag whitelist counts as a reference, unquoted only", () => {
  const positives: ReadonlyArray<[string, string]> = [
    ["client-key-data: !Ref ClientKeyData", "kubeconfig"],
    ["client-certificate-data: !Sub '${ClientCertData}'", "kubeconfig"],
    ["apiKey: !GetAtt MyStack.ApiKey", "values.yaml"],
    ["apiKey: op://vault/item/api-key", "values.yaml"],
  ];
  for (const [line, path] of positives) {
    assert.equal(redactSourceText(line, path), line, `expected ${JSON.stringify(line)} to survive`);
  }
  // Env-var forms remain references, unquoted.
  assert.equal(redactSourceText("password: ${DB_PASSWORD}", "values.yaml"), "password: ${DB_PASSWORD}");
  assert.equal(redactSourceText("password: $DB_PASSWORD", "values.yaml"), "password: $DB_PASSWORD");
  // A Helm-style template with internal spaces survives quoted (captured
  // whole) and unquoted (never captured at all — the value-capture regex
  // requires an unbroken run of non-whitespace characters).
  assert.equal(redactSourceText('apiKey: "{{ .Values.x }}"', "values.yaml"), 'apiKey: "{{ .Values.x }}"');
  assert.equal(redactSourceText("apiKey: {{ .Values.x }}", "values.yaml"), "apiKey: {{ .Values.x }}");
});

test("#876: maskAndTruncateSource masks then truncates, same contract as maskAndTruncate", () => {
  const result = maskAndTruncateSource("apiKey: config.apiKey, ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", 12);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "apiKey: conf\n[truncated]");
});

test("#876: PR #862 regression shape — a full property block survives", () => {
  const snippet = [
    "  const config = {",
    "    apiKey: profile.apiKey,",
    "    baseUrl: profile.baseUrl,",
    "  };",
  ].join("\n");
  assert.equal(redactSourceText(snippet, "src/model/call.ts"), snippet);
});

// #882: a one-character (or other short) configured key equal to a letter of
// the known-secret marker's OWN text ("R", "E", "D", "A", "C", "T", case-
// sensitive) used to survive every masking pass, because each pass's freshly
// inserted `[REDACTED]` reintroduced the very letter it just removed. The
// marker used for known-secret masking (`KNOWN_SECRET_REDACTED`) now
// contains no alphanumeric characters, so this can no longer happen for any
// alphanumeric key. These tests exercise all three call sites that apply it
// (`maskKnownSecrets` directly, `maskDiagnostic`, and
// `describeTransportFailure`) with keys drawn from the old marker's letters,
// plus a two-character key, and confirm the heuristic `[REDACTED]` marker
// (used only by `redactText`, unrelated to this bug) is untouched.

test("#882: maskKnownSecrets fully removes configured keys 'E', 'R', 'A', 'ED'", () => {
  for (const key of ["E", "R", "A", "ED"]) {
    const masked = maskKnownSecrets(`credential ${key} rejected`, [key]);
    assert.ok(!masked.includes(key), `key ${JSON.stringify(key)} survived: ${masked}`);
    assert.equal(masked, `credential ${KNOWN_SECRET_REDACTED} rejected`);
  }
});

test("#882: maskDiagnostic fully removes configured keys 'E', 'R', 'A', 'ED', leaving redactText's own [REDACTED] marker unaffected", () => {
  for (const key of ["E", "R", "A", "ED"]) {
    const result = maskDiagnostic(`token: ${key} leaked`, [key]);
    assert.ok(!result.includes(key), `key ${JSON.stringify(key)} survived: ${result}`);
    assert.ok(result.includes(KNOWN_SECRET_REDACTED), `expected the known-secret marker in: ${result}`);
  }
  // redactText's heuristic marker is a separate, unrelated string and is
  // still produced by maskDiagnostic for text that matches its patterns.
  assert.equal(maskDiagnostic("apiKey: config.apiKey,"), "[REDACTED]");
});

test("#882: describeTransportFailure fully removes configured keys 'E', 'R', 'A', 'ED'", () => {
  for (const key of ["E", "R", "A", "ED"]) {
    const failure = new TransportFailure("http_status", "model endpoint returned HTTP 500", {
      status: 500,
      body: `credential ${key} rejected`,
    });
    const detail = describeTransportFailure(failure, { secrets: [key] });
    assert.ok(!detail.includes(key), `key ${JSON.stringify(key)} survived: ${detail}`);
    assert.ok(detail.includes(KNOWN_SECRET_REDACTED), `expected the known-secret marker in: ${detail}`);
  }
});
