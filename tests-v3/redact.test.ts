import test from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_SECRET_REDACTED,
  REDACTED_SOURCE,
  containsKnownSecret,
  maskAndTruncateSource,
  maskDiagnostic,
  maskKnownSecrets,
  maskKnownSecretsDeep,
  redactDiffText,
  redactSourceText,
  redactSourceTextDetailed,
  redactText,
  createPrTextLineMasker,
  redactPrTextDeep,
  redactPrTextLines,
  redactTextDeep,
} from "../src/context/redact.js";
import { describeTransportFailure, TransportFailure } from "../src/transport/http.js";

// #876: repository SOURCE content (tool reads, grep matches, blame, related-code
// snippets) must survive structurally under redaction — every rule replaces
// ONLY the credential VALUE, never a key name, delimiter, quote, or other
// syntax. The heuristic `redactText` policy (untrusted prose/log/web
// payloads) is unchanged and still over-redacts these code shapes, which is
// exactly the #862/#876 false-positive this module fixes for source evidence.

test("#1015: detailed source redaction counts actual replacements only", () => {
  assert.equal(redactSourceTextDetailed('const label = "[REDACTED]";').redactionCount, 0);
  assert.equal(redactSourceTextDetailed(`const label = "${REDACTED_SOURCE}";`).redactionCount, 0);
  // The real PR #1012 canary is masked only in its secret-key form; a bare
  // non-secret-named identifier assignment (`const CANARY = "..."`) survives
  // by design (#1018), so it must not inflate the count.
  assert.equal(redactSourceTextDetailed('const CANARY = "s3cr3t-credential";').redactionCount, 0);
  const one = redactSourceTextDetailed('const config = { token: "Bearer s3cr3t-credential" };');
  assert.ok(one.redactionCount >= 1);
  const two = redactSourceTextDetailed('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 sk-abcdefghijklmnopqrstuvwxyz012345');
  assert.equal(two.redactionCount, 2);
  assert.equal(redactSourceText('apiKey: config.apiKey'), "apiKey: config.apiKey");
  assert.equal(redactSourceText('const token = "hunter2hunter2";'), `const token = "${REDACTED_SOURCE}";`);
});

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

// #999 fixtures mirror verified scanner/provider shapes. OpenAI body lengths
// remain loose (58–74 chars across observed gitleaks generations); the fixed
// marker, mixed case, and digits are the source-rule anchors.
const openAiBody = (length: number): string => {
  const marker = "T3BlbkFJ";
  const before = "aB3dE5".repeat(3);
  const after = "zY8xW7_6".repeat(20).slice(0, length - before.length - marker.length);
  return `${before}${marker}${after}`;
};
const base64urlBody = (length: number): string => "Ab3dEf6G".repeat(Math.ceil(length / 8)).slice(0, length);
const SVCACCT_KEY = `sk-svcacct-${openAiBody(58)}`;
const ADMIN_KEY = `sk-admin-${openAiBody(74)}`;
const NONE_KEY = `sk-None-${openAiBody(64)}`;
const anthropicBody = (first: "-" | "_"): string => `${first}${base64urlBody(92)}`;
const ANT_API03_KEY = `sk-ant-api03-${anthropicBody("-")}AA`;
const ANT_ADMIN01_KEY = `sk-ant-admin01-${anthropicBody("_")}AA`;
const ANT_OAT01_KEY = `sk-ant-oat01-${"Ab3dEf6G".repeat(5)}`;

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
    // #999: verified OpenAI prefixes stay safe without a marker; Anthropic
    // prefixes require their pinned token shape, and admin without `01` is prose.
    "sk-admin-configuration-reference",
    "sk-None-value-check",
    "sk-svcacct-deployment-runbook-notes",
    "sk-ant-oat01-configuration-reference",
    "sk-ant-admin01-configuration-reference",
    "sk-ant-admin-configuration-reference",
    "sk-Proj-configuration-reference",
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

test("#996 accepted boundary (false negative): a body whose first alphanumeric segment carries no digit or uppercase is not masked", () => {
  // The entropy scan covers the body's FIRST alphanumeric segment only.
  // Syntactically valid base64url — base64url does NOT guarantee an uppercase
  // or digit in any 20-character window — but practically unobserved in real
  // keys, so the miss is accepted rather than traded for the false positive a
  // looser rule would cost. It holds wherever the segment ends, and whatever
  // later segments contain.
  const lowercaseBody = `sk-or-v1-${"abcdef".repeat(11)}`;
  assert.equal(redactSourceText(lowercaseBody), lowercaseBody);
  assert.equal(redactSourceText(`sk-proj-${"a".repeat(20)}`), `sk-proj-${"a".repeat(20)}`);
  assert.equal(redactSourceText(`sk-proj-${"a".repeat(20)}-B`), `sk-proj-${"a".repeat(20)}-B`);
});

test("#996: the entropy character may sit anywhere in the body's first alphanumeric segment", () => {
  // Review round 5: `sk-proj-<20 lowercase>A` is masked, while the docs claimed
  // the accepted miss was "first 20 characters all lowercase" — the scan is not
  // bounded to 20 characters, so the docs were narrower than the regex. Pinned
  // here as a masking positive, with the boundary above restated to match.
  assert.equal(redactSourceText("sk-proj-aaaaaaaaaaaaaaaaaaaaA"), REDACTED_SOURCE);
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

// #999: Route B anchors OpenAI families on their shared scanner-verified
// marker; Route C pins Anthropic keys to provider/scanner body shapes.
test("#999: verified remaining OpenAI and Anthropic families mask only the token", () => {
  const openAiKeys = [SVCACCT_KEY, ADMIN_KEY, NONE_KEY];
  const anthropicKeys = [ANT_API03_KEY, ANT_ADMIN01_KEY, ANT_OAT01_KEY];
  for (const key of [...openAiKeys, ...anthropicKeys]) {
    assert.equal(redactSourceText(key), REDACTED_SOURCE, `expected ${key.slice(0, 24)}... to mask`);
    assert.equal(redactSourceText(key, "src/model/call.ts"), REDACTED_SOURCE);
  }

  for (const key of openAiKeys) {
    assert.equal(redactSourceText(`const k = "${key}";`), `const k = "${REDACTED_SOURCE}";`);
    assert.equal(redactSourceText(`API_KEY=${key}`), `API_KEY=${REDACTED_SOURCE}`);
  }
  for (const key of anthropicKeys) {
    assert.equal(redactSourceText(`{"apiKey": "${key}",}`), `{"apiKey": "${REDACTED_SOURCE}",}`);
    assert.equal(redactSourceText(`${key}\n`), `${REDACTED_SOURCE}\n`);
  }
});

test("#999: api03 shape pin closes the early-separator residual", () => {
  // The first body character is a legal base64url separator; #997's generic
  // run requires 20 adjacent alphanumerics directly after the family prefix.
  assert.equal(ANT_API03_KEY.slice("sk-ant-api03-".length, "sk-ant-api03-".length + 20).includes("-"), true);
  assert.equal(redactSourceText(ANT_API03_KEY), REDACTED_SOURCE);
});

test("#999: excluded or unverified families remain source text", () => {
  const survivors = [
    `sk-ant-api04-${anthropicBody("-")}AA`,
    `sk-ant-ort01-${base64urlBody(48)}`,
    `sk-ant-sid01-${base64urlBody(48)}`,
    "sk-service-configuration-reference",
  ];
  for (const value of survivors) {
    assert.equal(redactSourceText(value), value);
    assert.equal(redactSourceText(value, "src/model/call.ts"), value);
  }
});

test("#999: Anthropic pinned-shape floors are exact", () => {
  const adminPrefix = "sk-ant-admin01-";
  const oatPrefix = "sk-ant-oat01-";
  const shortAdmin = `${adminPrefix}${base64urlBody(92)}AA`;
  const exactAdmin = `${adminPrefix}${base64urlBody(93)}AA`;
  const shortOat = `${oatPrefix}${base64urlBody(39)}`;
  const exactOat = `${oatPrefix}${base64urlBody(40)}`;
  assert.equal(shortAdmin.slice(adminPrefix.length, -2).length, 92);
  assert.equal(exactAdmin.slice(adminPrefix.length, -2).length, 93);
  assert.equal(shortOat.slice(oatPrefix.length).length, 39);
  assert.equal(redactSourceText(shortAdmin), shortAdmin);
  assert.equal(redactSourceText(exactAdmin), REDACTED_SOURCE);
  assert.equal(redactSourceText(shortOat), shortOat);
  assert.equal(redactSourceText(exactOat), REDACTED_SOURCE);
});

test("#999: the Anthropic fixed shape is exact on the upper edge, not just the floor", () => {
  // `admin01` is not in #997's enumerated alternation, so these cases exercise
  // the shape pin alone. Exactly 93 base64url chars + `AA` IS the token; one
  // more base64url character means it is not this shape, and must survive whole
  // rather than being redacted through its first 95 body chars (a partial mask
  // would leave the tail behind).
  const adminPrefix = "sk-ant-admin01-";
  const exact = `${adminPrefix}${base64urlBody(93)}AA`;
  assert.equal(redactSourceText(exact), REDACTED_SOURCE);
  assert.equal(redactSourceText(`const k = "${exact}";`), `const k = "${REDACTED_SOURCE}";`);
  for (const longer of [`${exact}B`, `${exact}AAA`, `${exact}-tail`]) {
    assert.equal(redactSourceText(longer), longer, `expected ${longer.slice(-6)} to survive whole`);
  }
});

test("#999: marker near-misses and ordinary tokens survive", () => {
  const nearMiss = `sk-svcacct-T3BlbkFI${"Ab3dEf6G".repeat(5)}`;
  const bareMarker = "T3BlbkFJ";
  const ordinary = "sk-svcacct-deployment-runbook-notes";
  for (const value of [nearMiss, bareMarker, ordinary]) {
    assert.equal(redactSourceText(value), value);
  }
});

test("#999 adversarial: marker scanning stays bounded and misses markers past the prefix cap cleanly", () => {
  const size = 1_200_000;
  const matching = `sk-svcacct-${"a".repeat(120)}T3BlbkFJ${"b".repeat(size - 11 - 120 - 8)}`;
  // Avoid the preserved legacy bare rule, which intentionally sees the
  // `sk-<20+ alnum>` prefix shape before this newer scoped-family rule.
  const nonMatching = `sk-svcacct-${"a".repeat(2)}-${"b".repeat(size - 13)}`;
  // Unbounded pre-marker scanning took 4.3s / 17.6s / 70.2s at 90k / 180k /
  // 360k repeated-prefix chars (quadratic). At 120k, that regression fails in
  // about 8s; <1000ms is ~25x the measured bounded cost and avoids machine-speed
  // sensitivity. An unbounded trailing run adds no measurable cost.
  const repeatedPrefixes = "sk-".repeat(40_000);
  const markerBeyondBound = `sk-svcacct-${"a".repeat(300)}T3BlbkFJ${"b".repeat(40)}`;
  const started = process.hrtime.bigint();
  assert.equal(redactSourceText(matching), REDACTED_SOURCE, "a marker-bearing token is masked whole, tail included");
  assert.equal(redactSourceText(nonMatching), nonMatching);
  assert.equal(redactSourceText(repeatedPrefixes), repeatedPrefixes);
  assert.equal(redactSourceText(markerBeyondBound), markerBeyondBound, "a marker past the pre-marker cap is a clean miss");
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  assert.ok(elapsedMs < 1_000, `redaction adversarial cases took ${elapsedMs.toFixed(0)}ms`);
});

test("#999: marker-bearing tokens are masked whole while quotes survive", () => {
  const key = `sk-svcacct-${"a".repeat(20)}T3BlbkFJ${"b".repeat(400)}`;
  assert.equal(redactSourceText(key), REDACTED_SOURCE);
  assert.equal(redactSourceText(`const k = "${key}";`), `const k = "${REDACTED_SOURCE}";`);
});

test("#999: oat01 token boundary preserves the terminator and following source", () => {
  const key = `sk-ant-oat01-${"Ab3dEf6G".repeat(5)}`;
  const source = `${key}.XYZ more prose\nnext`;
  assert.equal(redactSourceText(source), `${REDACTED_SOURCE}.XYZ more prose\nnext`);
});

test("#999: masking is idempotent, preserves line shape, and reaches truncation helper", () => {
  const once = redactSourceText(`const k = "${SVCACCT_KEY}";\nAPI_KEY=${ANT_ADMIN01_KEY}`);
  assert.equal(redactSourceText(once), once, "the marker must never be re-matched");
  assert.equal(once.split("\n").length, 2);
  const snippet = `const k = "${ANT_OAT01_KEY}";\n`;
  assert.equal(redactSourceText(snippet).split("\n").length, snippet.split("\n").length);
  const truncated = maskAndTruncateSource(`token = "${ANT_OAT01_KEY}"`, 4096);
  assert.equal(truncated.truncated, false);
  assert.equal(truncated.text, `token = "${REDACTED_SOURCE}"`);
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

test("#1037: maskKnownSecretsDeep preserves JSON structure — keys, array order, numbers, nesting", () => {
  const body = JSON.parse('{"a":[1,"two",{"b":"three"}],"n":null,"f":1.5,"t":true}') as Record<string, unknown>;
  const masked = maskKnownSecretsDeep(body, []) as Record<string, unknown>;
  assert.equal(JSON.stringify(masked), JSON.stringify(body));
});

test("#1094: maskKnownSecretsDeep FAILS CLOSED at the depth cap — an escaped secret is not serialized back", () => {
  // #252 boundary: the hostile shape itself. A configured value carrying `"`
  // or `\` is JSON-ESCAPED inside the serialized subtree, so the earlier
  // serialize-then-mask fallback never matched the literal substring and
  // JSON-decoding the artifact recovered the secret. Both characters are fed
  // here; a benign stand-in would pass with that fallback in place.
  const QUOTED = 'gw-abc"def';
  const BACKSLASHED = "gw-abc\\def";
  let deep: Record<string, unknown> = { quote: QUOTED, slash: BACKSLASHED };
  // MAX_MASK_DEPTH is 32: nest well past it from the top-level body.
  for (let i = 0; i < 40; i++) deep = { nested: deep };
  const masked = maskKnownSecretsDeep(deep, [QUOTED, BACKSLASHED]) as unknown;
  const serialized = JSON.stringify(masked);
  for (const secret of [QUOTED, BACKSLASHED]) {
    assert.equal(serialized.includes(secret), false, `raw secret survived: ${serialized}`);
    assert.equal(serialized.includes(JSON.stringify(secret).slice(1, -1)), false, `escaped secret survived: ${serialized}`);
  }
  // Fail closed: the over-deep subtree is replaced by the marker, not walked.
  assert.ok(serialized.includes(KNOWN_SECRET_REDACTED), `expected the fail-closed marker: ${serialized}`);
  // Nothing below the cap changed behavior: a shallow body still masks per leaf
  // and preserves structure.
  const shallow = { a: [`x ${QUOTED}`, { b: QUOTED }], n: 1 };
  const shallowMasked = maskKnownSecretsDeep(shallow, [QUOTED, BACKSLASHED]) as Record<string, unknown>;
  assert.deepEqual(shallowMasked, { a: [`x ${KNOWN_SECRET_REDACTED}`, { b: KNOWN_SECRET_REDACTED }], n: 1 });
});

test("#252 boundary: maskKnownSecretsDeep fed a body with an OWN __proto__ key keeps it an own property and never touches Object.prototype", () => {
  // The hostile key ITSELF, not a benign stand-in: JSON.parse produces an own
  // `__proto__` data property, and a naive `out[key] = ...` rebuild invokes the
  // prototype setter instead — the key vanishes from the artifact and `out`'s
  // prototype becomes provider-controlled data.
  const CANARY = "gw-8f2a1c9d3b7e4a10";
  const body = JSON.parse(`{"__proto__":{"leak":"credential ${CANARY} rejected","keep":1},"safe":"value"}`);
  const masked = maskKnownSecretsDeep(body, [CANARY]) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(masked, "__proto__"), true, "the own key must survive the rebuild");
  assert.equal(Object.getPrototypeOf(masked), Object.prototype, "the prototype must stay the plain-object one");
  assert.equal((masked["__proto__"] as Record<string, unknown>).leak, `credential ${KNOWN_SECRET_REDACTED} rejected`);
  assert.equal((masked["__proto__"] as Record<string, unknown>).keep, 1);
  assert.equal(masked.safe, "value");
  // The serialized artifact keeps the key (still valid JSON, same shape).
  assert.match(JSON.stringify(masked), /"__proto__":\{"leak"/);
  assert.equal(JSON.stringify(masked).includes(CANARY), false);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "leak"), false, "no pollution escaped");
});

test("#1094: maskKnownSecretsDeep masks a canary appearing as an object KEY (raw and encoded variants), preserves distinctness, and stays valid JSON", () => {
  // The provider-controlled property NAME is an echo surface too: value-only
  // masking left `{ "error": { "<credential>": "rejected" } }` persisting the
  // credential in the key. Only secret-bearing keys change — benign keys stay
  // byte-for-byte.
  const CANARY = "gw-8f2a1c9d3b7e4a10";
  const raw = JSON.parse(`{"error":{"${CANARY}":"rejected","keep":1},"safe":"value"}`) as Record<string, unknown>;
  const maskedRaw = maskKnownSecretsDeep(raw, [CANARY]) as Record<string, unknown>;
  const error = maskedRaw.error as Record<string, unknown>;
  assert.equal(Object.hasOwn(error, CANARY), false, "the raw secret key must not survive");
  assert.equal(error[KNOWN_SECRET_REDACTED], "rejected");
  assert.equal(error.keep, 1, "sibling keys and values are untouched");
  assert.equal(maskedRaw.safe, "value");
  // The serialized artifact is still valid JSON and round-trips exactly.
  const serializedRaw = JSON.stringify(maskedRaw);
  assert.equal(serializedRaw.includes(CANARY), false, serializedRaw);
  assert.ok(serializedRaw.includes(KNOWN_SECRET_REDACTED), serializedRaw);
  assert.deepEqual(JSON.parse(serializedRaw), maskedRaw);

  // Encoded variants are masked in keys too. The shared CANARY has no
  // URL-significant characters (its encoded form IS itself), so the
  // URL-encoded case uses a secret that actually encodes differently, and the
  // base64 case uses the CANARY's own base64 form.
  const spaced = "tok a&b";
  const urlEncoded = encodeURIComponent(spaced);
  const base64 = Buffer.from(CANARY, "utf8").toString("base64");
  const encodedBody = { error: { [urlEncoded]: "rejected", [base64]: "also rejected", untouched: 1 } };
  const maskedEncoded = maskKnownSecretsDeep(encodedBody, [spaced, CANARY]) as Record<string, unknown>;
  const errorEncoded = maskedEncoded.error as Record<string, unknown>;
  assert.equal(Object.hasOwn(errorEncoded, urlEncoded), false);
  assert.equal(Object.hasOwn(errorEncoded, base64), false);
  assert.equal(errorEncoded[KNOWN_SECRET_REDACTED], "also rejected", "distinct masked keys collide deterministically on the marker");
  assert.equal(errorEncoded.untouched, 1);
  const serializedEncoded = JSON.stringify(maskedEncoded);
  assert.equal(serializedEncoded.includes(urlEncoded), false, serializedEncoded);
  assert.equal(serializedEncoded.includes(base64), false, serializedEncoded);
  assert.deepEqual(JSON.parse(serializedEncoded), maskedEncoded);

  // Distinctness is preserved deterministically: the marker splices into the
  // surviving key material, so two different secret-bearing keys stay
  // distinguishable and a benign key is never merged with a masked one.
  const distinct = maskKnownSecretsDeep(
    { [`a${CANARY}`]: 1, [`${CANARY}a`]: 2, plain: 3 },
    [CANARY],
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(distinct).sort(), [`a${KNOWN_SECRET_REDACTED}`, KNOWN_SECRET_REDACTED + "a", "plain"].sort());
  assert.deepEqual(distinct, { [`a${KNOWN_SECRET_REDACTED}`]: 1, [`${KNOWN_SECRET_REDACTED}a`]: 2, plain: 3 });
});

test("#1149: redactTextDeep masks BOTH the configured exact values AND the generic credential shapes, preserving structure", () => {
  // Two disjoint redaction layers over a raw provider body:
  //  - CONFIGURED (maskKnownSecrets): a lane credential the run knows about,
  //    matched with no framing at all;
  //  - PROVIDER-AUTHORED (redactText): a credential the run never configured,
  //    caught only by SHAPE (`api_key=…`, `Bearer …`, `sk-…`).
  // `maskKnownSecretsDeep` alone covered only the first, which is how an
  // unknown `api_key=<value>` reached the persisted artifacts.
  const CONFIGURED = "gw-8f2a1c9d3b7e4a10";
  const PROVIDER = "provider-only-secret-123456";
  const body = JSON.parse(`{
    "model": "scorer-model",
    "choices": [{ "message": { "content": "api_key=${PROVIDER}", "role": "assistant" } }],
    "debug": { "echo": "Bearer providerbearerabcdefghijklmnop", "openai_like": "sk-providerabcdefghijklmnop", "plain": "nothing here" },
    "n": 7, "f": 1.5, "t": true, "nil": null
  }`) as Record<string, unknown>;
  const masked = redactTextDeep(body, [CONFIGURED]) as Record<string, unknown>;

  const serialized = JSON.stringify(masked);
  for (const shaped of [PROVIDER, "providerbearerabcdefghijklmnop", "sk-providerabcdefghijklmnop"]) {
    assert.equal(serialized.includes(shaped), false, `generic-shaped credential survived: ${shaped}`);
  }
  assert.ok(serialized.includes("[REDACTED]"), "the generic layer's own marker must be present");

  // Structure survives byte-for-byte apart from the masked leaves: same keys,
  // same array order, same numbers/booleans/null, still valid JSON.
  assert.equal(masked.model, "scorer-model");
  const choices = masked.choices as Array<Record<string, unknown>>;
  const message = choices[0]!.message as Record<string, unknown>;
  assert.equal(message.role, "assistant");
  assert.equal(message.content, "[REDACTED]");
  assert.deepEqual(masked.n, 7);
  assert.equal(masked.f, 1.5);
  assert.equal(masked.t, true);
  assert.equal(masked.nil, null);
  assert.deepEqual(JSON.parse(serialized), masked);
  // A leaf with nothing to mask is untouched — no blanket over-redaction.
  assert.equal((masked.debug as Record<string, unknown>).plain, "nothing here");

  // The CONFIGURED half still fires unconditionally, without any framing.
  const configuredOnly = redactTextDeep({ echo: `credential ${CONFIGURED} rejected` }, [CONFIGURED]) as Record<string, unknown>;
  assert.equal(configuredOnly.echo, `credential ${KNOWN_SECRET_REDACTED} rejected`);

  // Keys are leaves too: a secret in the provider-controlled property NAME is
  // masked in the key AND in the value, and the entry stays an own property.
  const keyed = redactTextDeep(JSON.parse(`{"api_key=${PROVIDER}": "rejected", "keep": 1}`), []) as Record<string, unknown>;
  assert.deepEqual(Object.keys(keyed).sort(), ["[REDACTED]", "keep"]);
  assert.equal(keyed["[REDACTED]"], "rejected");
  assert.equal(keyed.keep, 1);
});

test("#1149: redactTextDeep inherits maskKnownSecretsDeep's depth cutoff (fails closed) and its hostile-`__proto__` safety", () => {
  // MAX_MASK_DEPTH in src/context/redact.ts. That module keeps its internals
  // private (the constant is not exported), so it is restated here rather than
  // imported — if the cap moves, the two level assertions below are what must
  // move with it.
  const CAP = 32;

  // The cutoff itself, NOT leaf masking. The deepest leaf here is a NUMBER,
  // which `redactTextDeep` passes through untouched at every depth below the
  // cap, so a marker here can only have come from the cutoff. A string-leaf
  // stand-in cannot discriminate: leaf masking turns it into the marker
  // anyway, which is why this half used to pass with the cap raised to 1000.
  let overDeep: Record<string, unknown> = { deepLeaf: 7 };
  for (let i = 0; i < CAP + 8; i++) overDeep = { nested: overDeep };
  const capped = redactTextDeep(overDeep, []) as Record<string, unknown>;
  const cappedJson = JSON.stringify(capped);
  assert.ok(cappedJson.includes(KNOWN_SECRET_REDACTED), `expected the fail-closed marker: ${cappedJson}`);
  assert.equal(cappedJson.includes("deepLeaf"), false, "the over-deep subtree must be replaced, not walked — its number leaf would have survived the walk untouched");
  // It bottoms out AT the cutoff, not somewhere above or below it.
  let cursor: unknown = capped;
  let levels = 0;
  while (cursor !== null && typeof cursor === "object") {
    cursor = (cursor as Record<string, unknown>).nested;
    levels += 1;
  }
  assert.equal(levels, CAP, "the walk must descend exactly MAX_MASK_DEPTH levels before the cutoff fires");
  assert.equal(cursor, KNOWN_SECRET_REDACTED, "the over-deep subtree must be replaced by the marker itself");

  // Control: the same non-string leaf, comfortably under the cap, is walked
  // through and survives byte-for-byte while a shaped string beside it is still
  // masked leaf-wise.
  let underCap: Record<string, unknown> = { deepLeaf: 7, shaped: "api_key=provider-only-secret-123456" };
  for (let i = 0; i < CAP - 8; i++) underCap = { nested: underCap };
  const walked = redactTextDeep(underCap, []) as Record<string, unknown>;
  const deepest = (() => { let node: Record<string, unknown> = walked; while (node.nested !== undefined) node = node.nested as Record<string, unknown>; return node; })();
  assert.deepEqual(deepest, { deepLeaf: 7, shaped: "[REDACTED]" }, "a subtree under the cap must be walked through, with leaves masked in place");
  assert.equal(JSON.stringify(walked).includes(KNOWN_SECRET_REDACTED), false, "the cutoff must not fire below the cap");

  // The hostile key ITSELF, not a benign stand-in: an own `__proto__` data
  // property stays an own data property and never reaches a prototype setter.
  const CANARY = "gw-8f2a1c9d3b7e4a10";
  const hostile = JSON.parse(`{"__proto__":{"leak":"credential ${CANARY} rejected","shaped":"api_key=provider-only-secret-123456","keep":1},"safe":"value"}`);
  const out = redactTextDeep(hostile, [CANARY]) as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(out, "__proto__"), true, "the own key must survive the rebuild");
  assert.equal(Object.getPrototypeOf(out), Object.prototype, "the prototype must stay the plain-object one");
  const protoEntry = out["__proto__"] as Record<string, unknown>;
  assert.equal(protoEntry.leak, `credential ${KNOWN_SECRET_REDACTED} rejected`);
  assert.equal(protoEntry.shaped, "[REDACTED]");
  assert.equal(protoEntry.keep, 1);
  assert.equal(out.safe, "value");
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "leak"), false, "no pollution escaped");
});

test("#1094: containsKnownSecret detects raw, URL-encoded, and base64 variants — the same set maskKnownSecrets replaces", () => {
  const secret = "gw-8f2a1c9d3b7e4a10";
  const secrets = [secret];
  assert.equal(containsKnownSecret(`gateway audit ${secret} ok`, secrets), true, "raw");
  assert.equal(containsKnownSecret(`gateway audit ${encodeURIComponent(secret)} ok`, secrets), true, "url-encoded");
  assert.equal(containsKnownSecret(`gateway audit ${Buffer.from(secret, "utf8").toString("base64")} ok`, secrets), true, "base64");
  assert.equal(containsKnownSecret(secret.repeat(2), secrets), true, "repeated");
  assert.equal(containsKnownSecret("no credential anywhere in here", secrets), false, "no false positive");
  // Empty/absent secrets and empty text never match.
  assert.equal(containsKnownSecret(secret, []), false);
  assert.equal(containsKnownSecret(secret, ["", null, undefined]), false);
  assert.equal(containsKnownSecret("", secrets), false);
  // Consistency contract above the floor: anything the masker would replace
  // is detected, and the masker only replaces what is detected.
  const text = `echo ${secret} and ${encodeURIComponent(secret)}`;
  assert.equal(maskKnownSecrets(text, secrets) !== text, true);
  assert.equal(containsKnownSecret(maskKnownSecrets(text, secrets), secrets), false, "masked output is clean");
});

test("#252 boundary: containsKnownSecret's content floor and variant set, fed the marker character itself", () => {
  // The documented floor: a sub-8-character configured value is
  // prose-indistinguishable ("k" masks every k in "Looks fine.") and is
  // handled by the masking surfaces instead — the CONTENT gate refuses only
  // credential-shaped values, exactly where redactText's generic heuristic
  // draws its own `{8,}` line. The sub-floor RAW form is excluded, but its
  // ENCODED forms stay in: a short value with URL-significant characters is
  // distinctive once encoded, and an encoded echo is a real reflection.
  assert.equal(containsKnownSecret("value 7 and more", ["7"]), false, "raw below the floor");
  assert.equal(containsKnownSecret("Lo k fine", ["k"]), false, "raw below the floor");
  assert.equal(containsKnownSecret("a b&c prose", ["a b&c"]), false, "raw below the floor");
  assert.equal(containsKnownSecret("echo a%20b%26c here", ["a b&c"]), true, "url-encoded sub-floor variant");
  assert.equal(containsKnownSecret(`echo ${Buffer.from("a b&c", "utf8").toString("base64")} here`, ["a b&c"]), true, "base64 sub-floor variant");
  assert.equal(containsKnownSecret("value 12345678 embedded", ["12345678"]), true, "at the floor");
  assert.equal(containsKnownSecret("value 1234567 embedded", ["1234567"]), false, "raw one under the floor");
  assert.equal(containsKnownSecret("value 1234567%20x embedded", ["1234567 "]), true, "encoded one under the floor");
  // Long secrets match in every variant, including the marker's own characters.
  const long = "gw-8f2a1c9d3b7e4a10";
  assert.equal(containsKnownSecret("⟦•⟧ residue", ["⟦"]), false, "below the floor");
  assert.equal(containsKnownSecret(`x ${long} y`, [long]), true);
  assert.equal(containsKnownSecret("clean text", ["⟦•⟧"]), false);
});

// #1154: the structural counterpart of redactText, for JSON-shaped
// PR-authored bodies (pr-object.json, the raw platform file list) on their
// way into persisted artifacts. Values masked per string LEAF (serialized-JSON
// redaction misses the quoted-key form); keys, array order, numbers, and
// structural tokens survive byte-for-byte.
test("#1154: redactPrTextDeep masks string leaves and preserves JSON shape", () => {
  const raw = {
    title: "add db config",
    body: "sets api_key = supersecretvalue1 in config",
    nested: { patch: "Bearer abcdefghijklmnopqrst", keep: 42, list: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456", null, true] },
  };
  const out = redactPrTextDeep(raw) as Record<string, unknown>;
  assert.equal(out.title, "add db config");
  // The generic layer replaces the whole `key=value` framing, not just the
  // value (that values-only rule is redactSourceText's).
  assert.equal(out.body, "sets [REDACTED] in config");
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.patch, "[REDACTED]");
  assert.equal(nested.keep, 42);
  const list = nested.list as unknown[];
  assert.equal(list[0], "[REDACTED]");
  assert.equal(list[1], null);
  assert.equal(list[2], true);
});

test("#1154: redactPrTextDeep leaves keys untouched — structural identity survives", () => {
  // A key that itself carries a token shape (an sk- prefixed login, a
  // filename-like key) is structural data downstream consumers match on;
  // only VALUES are masked.
  const raw = { "sk-prod-service-account-1": "token=hunter2hunter2", filename: "docs/sk-proj-notes-file.txt" };
  const out = redactPrTextDeep(raw) as Record<string, unknown>;
  assert.ok(Object.prototype.hasOwnProperty.call(out, "sk-prod-service-account-1"), "key survives");
  assert.equal(out.filename, "docs/sk-proj-notes-file.txt");
  assert.equal(out["sk-prod-service-account-1"], "[REDACTED]");
});

test("#1154: redactPrTextDeep defines a hostile own __proto__ key without prototype pollution", () => {
  const raw = JSON.parse('{"__proto__": {"polluted": "api_key=supersecretvalue1"}, "body": "ok"}') as Record<string, unknown>;
  const out = redactPrTextDeep(raw) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object prototype unpolluted");
  const own = Object.getOwnPropertyDescriptor(out, "__proto__");
  assert.ok(own, "own __proto__ data property defined");
  const proto = own!.value as Record<string, unknown>;
  assert.equal(proto.polluted, "[REDACTED]");
  assert.equal(out.body, "ok");
});

test("#1154: redactPrTextDeep fails closed at the recursion cap", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 40; i += 1) deep = [deep];
  const out = redactPrTextDeep(deep);
  // The cap replaces the whole subtree beyond MAX_MASK_DEPTH with the
  // marker; the outer levels remain arrays.
  let level: unknown = out;
  let depth = 0;
  while (Array.isArray(level)) {
    level = level[0];
    depth += 1;
  }
  assert.ok(depth < 40, "subtree beyond the cap is not walked");
  assert.equal(level, "[REDACTED]");
});

// #1154 review round: the flat pass must never run on a diff — multi-line
// maskers collapse lines and shift inline-finding anchors. redactDiffText
// masks per line, preserving count, prefixes, and headers.
test("#1154: redactDiffText preserves line count, prefixes, and headers", () => {
  const diff = [
    "diff --git a/app.yml b/app.yml",
    "index 111..222 100644",
    "--- a/app.yml",
    "+++ b/app.yml",
    "@@ -1,4 +1,5 @@",
    " existing: line",
    "+password: hunter2hunter2",
    "-token: zm9vymfyymf6",
    "\\ No newline at end of file",
    "+final",
  ].join("\n");
  const out = redactDiffText(diff);
  const inLines = diff.split("\n");
  const outLines = out.split("\n");
  assert.equal(outLines.length, inLines.length, "line count preserved");
  for (let i = 0; i < inLines.length; i += 1) {
    assert.equal(outLines[i]!.charAt(0), inLines[i]!.charAt(0), `line ${i} prefix preserved`);
  }
  assert.equal(outLines[0], inLines[0], "diff --git header verbatim");
  assert.equal(outLines[2], inLines[2], "--- header verbatim");
  assert.equal(outLines[3], inLines[3], "+++ header verbatim");
  assert.equal(outLines[4], inLines[4], "@@ hunk header verbatim");
  assert.equal(outLines[8], inLines[8], "\\ No newline marker verbatim");
  assert.equal(outLines[6], "+[REDACTED]", "same-line key: value on an added line is masked");
  assert.equal(outLines[7], "-[REDACTED]", "same-line key: value on a removed line is masked");
});

test("#1154: redactDiffText masks a SPLIT-line secret and still cannot span a line break", () => {
  // The flat redactText turns `password:\n  value` into ONE line (the
  // kubeconfig masker's \\s* eats the newline), shifting every later diff
  // line. The line-wise pass must keep every line AND close the split-line
  // form the per-line maskers cannot see: a bare key line opens a run, and
  // every indented continuation after it is masked.
  const diff = [
    "+password:",
    "+  hunter2hunter2hunter2",
    "+  ordinary indented prose, not a credential",
    "+plain unindented line",
    "+def main():",
    "+    return 1",
  ].join("\n");
  const out = redactDiffText(diff);
  const outLines = out.split("\n");
  assert.equal(outLines.length, 6, "no line collapse");
  assert.equal(outLines[0], "+password:", "the key name survives; a bare key line carries no value to mask");
  assert.equal(outLines[1], "+  [REDACTED]", "the split-line value is masked, diff prefix and indentation kept");
  // Accepted over-redaction class: an indented run after a bare secret key is
  // masked even when it is not a credential. Distinguishing "data" from
  // "structure" is a reading this module must not do on untrusted input, and
  // over-redaction is its stated preference over a leaked credential (#1154).
  assert.equal(outLines[2], "+  [REDACTED]", "an indented non-credential continuation is masked too");
  assert.equal(outLines[3], "+plain unindented line", "a line that does not start with whitespace terminates the run");
  assert.equal(outLines[4], "+def main():");
  assert.equal(outLines[5], "+    return 1", "lines after the run are untouched");
});

test("#1154: a bare secret key line on a CONTEXT line opens the same run", () => {
  const diff = [
    "diff --git a/app.yml b/app.yml",
    "index 111..222 100644",
    "@@ -1,2 +1,4 @@",
    " password:",
    "   hunter2hunter2hunter2",
    " plain",
  ].join("\n");
  assert.equal(
    redactDiffText(diff),
    [
      "diff --git a/app.yml b/app.yml",
      "index 111..222 100644",
      "@@ -1,2 +1,4 @@",
      " password:",
      "   [REDACTED]",
      " plain",
    ].join("\n"),
    "the run opens from a context line; headers stay verbatim and the unindented tail ends the run",
  );
});

test("#1154: redactPrTextLines preserves line count and line breaks the flat pass destroys", () => {
  const body = "Deployment notes:\npassword:\n  hunter2hunter2hunter2\nend";
  // The premise of the seam, pinned: the flat pass collapses the pair into one
  // line, because its key/value maskers span the break.
  assert.equal(redactText(body).split("\n").length, 3, "the flat pass collapses the split-line credential");
  const out = redactPrTextLines(body);
  assert.equal(out.split("\n").length, 4, "line count survives");
  assert.equal(out, "Deployment notes:\npassword:\n  [REDACTED]\nend");
  // Multi-line prose with no credential is byte-identical, breaks included.
  const prose = "first line\n\n  indented second line\nthird: line\n";
  assert.equal(redactPrTextLines(prose), prose);
  assert.equal(redactPrTextLines(prose).split("\n").length, prose.split("\n").length);
  // Idempotent, and the shared core keeps the diff pass idempotent too (#252).
  assert.equal(redactPrTextLines(out), out);
  assert.equal(redactPrTextLines(redactPrTextLines(body)), out);
  assert.equal(redactPrTextLines(null), "");
  assert.equal(redactPrTextLines(undefined), "");
  assert.equal(redactPrTextLines(""), "");
});

test("#1154: a multi-line PR body leaf keeps its structure inside redactPrTextDeep", () => {
  const raw = { body: "notes\npassword:\n  hunter2hunter2hunter2\nend", keep: 1 };
  const out = redactPrTextDeep(raw) as Record<string, unknown>;
  assert.equal(out.body, "notes\npassword:\n  [REDACTED]\nend", "line structure survives the structural pass");
  assert.equal(out.keep, 1);
});

test("#1154: redactDiffText treats a literal [REDACTED] as inert and is idempotent", () => {
  // #252 boundary rule: feed the sanitizer's OWN marker through the sanitizer.
  // Anchor extraction compares a redacted diff against a redacted checkout
  // byte-for-byte, so the marker has to be stable: a masker that matched
  // `[REDACTED]` itself would rewrite it, and a rewritten marker would stop
  // comparing equal to the same marker on the other side.
  const diff = [
    "+[REDACTED]",
    " [REDACTED]",
    "-[REDACTED]",
    "+token: [REDACTED]",
    "+password: hunter2hunter2",
  ].join("\n");
  const out = redactDiffText(diff);
  assert.equal(out.split("\n")[0], "+[REDACTED]", "a literal marker added line is untouched");
  assert.equal(out.split("\n")[1], " [REDACTED]", "a literal marker context line is untouched");
  assert.equal(out.split("\n")[2], "-[REDACTED]", "a literal marker removed line is untouched");
  // A marker sitting as the VALUE of a secret-named key is re-masked whole
  // (`token: [REDACTED]` → `[REDACTED]`), losing the key name. That is the
  // module's documented over-redaction preference, and it is STABLE: the
  // result is itself an inert marker, so the pass converges rather than
  // nesting. Pinned here so a future masker that grew the marker would fail
  // this instead of silently breaking anchor comparison.
  assert.equal(out.split("\n")[3], "+[REDACTED]", "an already-masked value is not double-wrapped");
  assert.equal(out.split("\n")[4], "+[REDACTED]", "a real secret beside it still masks (key included)");
  assert.equal(redactDiffText(out), out, "redactDiffText is idempotent");
});

test("#1154 review: the continuation path is marker-inert and convergent", () => {
  // #252 boundary rule applied to the NEW rule: feed the sanitizer's own
  // marker through the continuation path. A bare key line followed by an
  // already-masked value must converge to itself (never nest, never grow) —
  // the change-anchor seam compares both sides of an exact-byte match, so a
  // marker that changed shape on the second pass would break every anchor
  // for an artifact persisted twice.
  const once = redactDiffText("+password:\n+  [REDACTED]");
  assert.equal(once, "+password:\n+  [REDACTED]", "an already-masked continuation is untouched");
  assert.equal(redactDiffText(once), once, "the continuation path converges");
  assert.equal(redactPrTextLines(redactPrTextLines("password:\n  [REDACTED]")), "password:\n  [REDACTED]");
  // A literal marker with NO bare key line above it is inert on every prefix.
  for (const line of ["+[REDACTED]", " [REDACTED]", "-[REDACTED]", "[REDACTED]"]) {
    assert.equal(redactPrTextLines(line), line, `a bare marker line is inert: ${line}`);
  }
  // And a masked value under a secret-named JSON key converges too.
  assert.deepEqual(redactPrTextDeep({ password: "[REDACTED]" }), { password: "[REDACTED]" });
});

test("#1154: redactPrTextDeep masks a secret-named key's subtree — the quoted-key hole is closed", () => {
  // Per-leaf pattern masking never sees the key and the value together, so
  // `{"password":"opaque-value"}` leaked both. A secret-named key now masks
  // every string leaf under it, in every shape.
  const raw = {
    password: "opaque-value",
    username: "opaque-value",
    nested: { apiKey: { list: ["first-value", "second-value"], count: 2 } },
    arr: [{ token: "inside-array" }],
  };
  const out = redactPrTextDeep(raw) as Record<string, unknown>;
  assert.equal(out.password, "[REDACTED]", "the opaque value under a credential-named key is masked");
  assert.ok(Object.prototype.hasOwnProperty.call(out, "password"), "the key survives — keys are structural identity");
  assert.equal(out.username, "opaque-value", "a non-credential key's value is untouched");
  const nested = out.nested as { apiKey: { list: string[]; count: number } };
  assert.deepEqual(nested.apiKey.list, ["[REDACTED]", "[REDACTED]"], "array leaves under a secret key are masked");
  assert.equal(nested.apiKey.count, 2, "number leaves are never masked — JSON types survive");
  const arr = out.arr as Array<{ token: string }>;
  assert.equal(arr[0]!.token, "[REDACTED]", "a secret-named key inside an array element is masked too");
});

test("#1154: the key-name rule is the shared unanchored vocabulary, and only the name selects it", () => {
  const out = redactPrTextDeep({
    client_secret: "opaque-value",
    refresh_token: "opaque-value",
    dbPassword: "opaque-value",
    secretAccessKey: "opaque-value",
    apiKey: "opaque-value",
    filename: "src/app.py",
    login: "octocat",
  }) as Record<string, unknown>;
  for (const key of ["client_secret", "refresh_token", "dbPassword", "secretAccessKey", "apiKey"]) {
    assert.equal(out[key], "[REDACTED]", `${key} is secret-named`);
  }
  assert.equal(out.filename, "src/app.py", "an ordinary key is not swept in");
  assert.equal(out.login, "octocat");
  assert.deepEqual(Object.keys(out), [
    "client_secret",
    "refresh_token",
    "dbPassword",
    "secretAccessKey",
    "apiKey",
    "filename",
    "login",
  ], "key order and names survive");
});

test("#1154: reference values under a secret-named key are exempt, non-strings never masked", () => {
  const raw = {
    password: "${API_KEY}",
    token: "{{ secret }}",
    apiKey: "!Ref MySecret",
    auth_token: "op://vault/item",
    access_key: "ENC[hunter2hunter2]",
    client_secret: "opaque-literal-value",
    numbers: { password: 42, token: true, apiKey: null },
  };
  const out = redactPrTextDeep(raw) as Record<string, unknown>;
  // A reference POINTS at a credential; masking it would destroy the config
  // without removing a secret (`isReferenceValue`, the #876 rule).
  assert.equal(out.password, "${API_KEY}");
  assert.equal(out.token, "{{ secret }}");
  assert.equal(out.apiKey, "!Ref MySecret");
  assert.equal(out.auth_token, "op://vault/item");
  assert.equal(out.access_key, "ENC[hunter2hunter2]");
  // The same key name with a literal value still masks.
  assert.equal(out.client_secret, "[REDACTED]");
  // Types survive: a number/boolean/null leaf is never a credential.
  assert.deepEqual(out.numbers, { password: 42, token: true, apiKey: null });
});

test("#1154: the key-name rule is idempotent and still fails closed at the depth cap", () => {
  const raw = { password: "opaque-value", body: "sets api_key=supersecretvalue1 here", nested: { token: ["a", 1] } };
  const once = redactPrTextDeep(raw) as Record<string, unknown>;
  assert.deepEqual(redactPrTextDeep(once), once, "a second pass changes nothing");
  // Depth cap is unchanged for the key-name path: a deep subtree under a
  // secret-named key is replaced by the marker, never serialized back.
  let deep: unknown = "opaque-leaf-value";
  for (let i = 0; i < 40; i += 1) deep = { password: deep };
  let level: unknown = redactPrTextDeep(deep);
  let walked = 0;
  while (level !== null && typeof level === "object" && !Array.isArray(level)) {
    const next = (level as Record<string, unknown>).password;
    if (next === undefined) break;
    level = next;
    walked += 1;
  }
  assert.ok(walked < 40, "the subtree beyond the cap is not walked");
  assert.equal(level, "[REDACTED]");
});

test("#1154: redactPrTextDeep depth cap holds for object nesting and is idempotent", () => {
  let deep: Record<string, unknown> = { leaf: "api_key=supersecretvalue1" };
  for (let i = 0; i < 40; i += 1) deep = { nested: deep };
  const out = redactPrTextDeep(deep);
  let level: unknown = out;
  let depth = 0;
  // No `!== undefined` clause: `typeof level === "object"` already excludes
  // undefined, so the extra comparison is unreachable (CodeQL: comparison
  // between inconvertible types).
  while (level !== null && typeof level === "object" && !Array.isArray(level)) {
    const next = (level as Record<string, unknown>).nested;
    if (next === undefined) break;
    level = next;
    depth += 1;
  }
  assert.ok(depth < 40, "object subtree beyond the cap is not walked");
  assert.equal(level, "[REDACTED]");
  // Idempotence: re-redacting an already-redacted artifact (cache re-read,
  // publish-boundary second pass) is a no-op on the masked shapes.
  const once = redactPrTextDeep({ body: "sets api_key=supersecretvalue1 here", keep: 1 }) as Record<string, unknown>;
  const twice = redactPrTextDeep(once) as Record<string, unknown>;
  assert.deepEqual(twice, once, "second pass changes nothing");
  assert.deepEqual(redactPrTextDeep(null), null);
  assert.deepEqual(redactPrTextDeep(undefined), undefined);
  assert.equal(redactPrTextDeep(42), 42);
});

// ---------------------------------------------------------------------------
// #1154 review round 2
// ---------------------------------------------------------------------------

test("#1154 r2: a secret moved onto the line below its key masks the VALUE, not the function", () => {
  // The regression the greedy rule shipped: a PR that moves a hardcoded secret
  // onto the line below its key had every following statement of the same
  // function rewritten to [REDACTED] in pr.diff, the corpus and the recorded
  // model request. A continuation is the value OF its key; a same-indent line
  // is a sibling.
  const diff = [
    " def connect(self):",
    "-            password: hunter2hunter2",
    "+            password:",
    "+                hunter2hunter2hunter2",
    "+            port=5432,",
    "+        )",
    "+        result = db.query(q)",
  ].join("\n");
  const out = redactDiffText(diff);
  assert.equal(out.split("\n").length, diff.split("\n").length, "no line costs");
  const lines = out.split("\n");
  assert.equal(lines[1], "-            [REDACTED]", "the removed credential still masks (own side)");
  assert.equal(lines[2], "+            password:");
  assert.equal(lines[3], "+                [REDACTED]", "the moved value is masked");
  assert.equal(lines[4], "+            port=5432,", "a sibling at the key's own indent survives");
  assert.equal(lines[5], "+        )");
  assert.equal(lines[6], "+        result = db.query(q)", "the rest of the block survives");
});

test("#1154 r2: the run is bounded by the key's own indentation", () => {
  // A deeper-indented sibling that is not a credential is still masked — the
  // over-redaction that SURVIVES the bound, and stays documented rather than
  // "fixed" (narrowing it means reading untrusted input as data vs structure).
  assert.equal(
    redactPrTextLines("password:\n  not-a-credential\nend"),
    "password:\n  [REDACTED]\nend",
  );
  // A blank content line closes the run.
  assert.equal(
    redactPrTextLines("password:\n  secret-value\n\n  after the break"),
    "password:\n  [REDACTED]\n\n  after the break",
  );
  // Shallower indentation closes it too.
  assert.equal(
    redactPrTextLines("    password:\n        secret-value\n  after"),
    "    password:\n        [REDACTED]\n  after",
  );
  // The bound is measured from the key line's own indent, not from zero.
  assert.equal(
    redactDiffText("+        password:\n+            secret-value\n+        next: 1"),
    "+        password:\n+            [REDACTED]\n+        next: 1",
  );
});

test("#1154 r2: the two sides of a diff keep independent runs", () => {
  // A key line on the removed side must not colour the lines the change
  // produces, and vice versa.
  assert.equal(
    redactDiffText([
      "-password:",
      "-  hunter2hunter2hunter2",
      "+  ordinary added line",
      "+    deeper added line",
      " context line",
    ].join("\n")),
    [
      "-password:",
      "-  [REDACTED]",
      "+  ordinary added line",
      "+    deeper added line",
      " context line",
    ].join("\n"),
  );
  assert.equal(
    redactDiffText([
      "+password:",
      "+  hunter2hunter2hunter2",
      "-  removed line at the same indent",
    ].join("\n")),
    [
      "+password:",
      "+  [REDACTED]",
      "-  removed line at the same indent",
    ].join("\n"),
  );
  // A header closes both runs at the file boundary.
  assert.equal(
    redactDiffText([
      "-password:",
      "--- a/app.yml",
      "+++ b/app.yml",
      "+  value that is not a continuation",
    ].join("\n")),
    [
      "-password:",
      "--- a/app.yml",
      "+++ b/app.yml",
      "+  value that is not a continuation",
    ].join("\n"),
  );
});

test("#1154 r2: a YAML block scalar opens the run; a code expression does not", () => {
  // A PEM key is embedded in YAML this way, and the same-line masker cannot
  // help: it rewrites `password: |` itself, so the key text no longer reaches
  // the predicate and the block below it used to persist verbatim.
  assert.equal(
    redactPrTextLines([
      "password: |",
      "  -----BEGIN RSA PRIVATE KEY-----",
      "  MIIEowIBAAKCAQEA0000",
      "  -----END RSA PRIVATE KEY-----",
      "port: 5432",
    ].join("\n")),
    [
      "[REDACTED]",
      "  [REDACTED]",
      "  [REDACTED]",
      "  [REDACTED]",
      "port: 5432",
    ].join("\n"),
  );
  // Folded scalars, indentation indicators and chomping are the same rule.
  assert.equal(
    redactPrTextLines([
      "secret: >-",
      "  folded body",
      "token: |2-",
      "  deep body",
      "api_key: |+",
      "  kept body",
      "port: 1",
    ].join("\n")),
    [
      "secret: >-",
      "  [REDACTED]",
      "token: |2-",
      "  [REDACTED]",
      "api_key: |+",
      "  [REDACTED]",
      "port: 1",
    ].join("\n"),
  );
  // The other direction: a secret-named key assigned a CODE EXPRESSION is not
  // a block scalar and must not open a run, or every following indented line
  // of the function would be masked.
  assert.equal(
    redactPrTextLines([
      "def f():",
      "    password = self.password",
      "        self.uses(password)",
      "    return 1",
    ].join("\n")),
    [
      "def f():",
      // The flat pass still rewrites the assignment itself (long-standing
      // `redactText` behavior on prose); what matters here is that it did NOT
      // open a run.
      "    [REDACTED]",
      "        self.uses(password)",
      "    return 1",
    ].join("\n"),
  );
  // Pinned boundary, not an endorsement: `client_key` carries no vocabulary
  // alternative (the key-name list is frozen), so it opens no run. Recorded
  // here so a future vocabulary change is a visible decision, not a drift.
  assert.equal(
    redactPrTextLines("client_key: |\n  -----BEGIN CERTIFICATE-----\n  MIIB"),
    "client_key: |\n  -----BEGIN CERTIFICATE-----\n  MIIB",
  );
});

test("#1154 r2: the two-state diff masker is marker-inert, convergent and idempotent", () => {
  // #252 boundary rule for the split state: feed the sanitizer's OWN marker
  // through both sides. The change-anchor seam compares the two sides byte
  // for byte, so neither may reshape a marker on a second pass.
  const diff = [
    "-password:",
    "-  [REDACTED]",
    "+password:",
    "+  [REDACTED]",
    "+    [REDACTED]",
    " context: [REDACTED]",
  ].join("\n");
  const once = redactDiffText(diff);
  assert.equal(once, diff, "already-masked continuations are inert on both sides");
  assert.equal(redactDiffText(once), once, "the two-state masker converges");
  // The per-side masker agrees with the whole-text pass on a one-sided input,
  // which is what the checkout mirroring relies on.
  const body = "def f():\n    password:\n        secret-value\n    return 1";
  const masker = createPrTextLineMasker();
  assert.equal(
    body.split("\n").map((line) => masker.maskLine(line)).join("\n"),
    redactPrTextLines(body),
  );
  assert.equal(redactPrTextLines(redactPrTextLines(body)), redactPrTextLines(body));
});
