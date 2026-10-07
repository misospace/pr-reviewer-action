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
