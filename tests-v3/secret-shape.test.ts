/** Direct table-driven coverage of the shared credential-shape redaction seam
 * (#1570): each SECRET_SHAPE alternative, the derived CREDENTIAL_ASSIGNMENT
 * key vocabulary, USERINFO_URL, and composition through redactSecretShapes. */
import test from "node:test";
import assert from "node:assert/strict";
import { SECRET_SHAPE, CREDENTIAL_ASSIGNMENT, USERINFO_URL, redactSecretShapes } from "../src/context/secret-shape.js";

// Apply each pattern with the same replacement the seam uses. String.replace
// with a /g regex always scans from index 0, so the exported globals'
// lastIndex state cannot skew these assertions.
const shapes = (value: string): string => value.replace(SECRET_SHAPE, "[REDACTED]");
const assignments = (value: string): string => value.replace(CREDENTIAL_ASSIGNMENT, "$1[REDACTED]");
const userinfo = (value: string): string => value.replace(USERINFO_URL, "$1[REDACTED]@");

test("SECRET_SHAPE redacts every declared credential shape", () => {
  const cases: [string, string][] = [
    // openai-style sk- token
    ["sk-abcdefghijklmnop", "[REDACTED]"],
    // github classic + fine-grained tokens
    ["ghp_ABCDEFGHIJKLMNOPQRSTUV", "[REDACTED]"],
    ["github_pat_ABCDEFGHIJKLMNOPQRST", "[REDACTED]"],
    // gitlab personal access token
    ["glpat-abcdefghijklmnop", "[REDACTED]"],
    // slack-style xox[baprs]- token
    ["xoxb-0123456789", "[REDACTED]"],
    // AWS access key id
    ["AKIAIOSFODNN7EXAMPLE", "[REDACTED]"],
    // google api key
    ["AIzaSyA1234567890abcdefghij_-kl", "[REDACTED]"],
    // bearer / basic authorization values
    ["Bearer abcdef.ghijkl-mnop", "[REDACTED]"],
    ["Basic dXNlcjpwYXNz", "[REDACTED]"],
    // JWT-style eyJ header.payload.signature
    ["eyJabcdefgh.ijklmnopq.stuvwxyz012", "[REDACTED]"],
    // embedded in prose: only the token is replaced
    ["token was sk-abcdefghijklmnop in logs", "token was [REDACTED] in logs"],
  ];
  for (const [input, expected] of cases) assert.equal(shapes(input), expected, input);
});

test("SECRET_SHAPE leading guard blocks letters and digits but allows separators", () => {
  // Ordinary word merely containing "sk-": guarded by the preceding letter.
  assert.equal(shapes("risk-123456789012"), "risk-123456789012");
  assert.equal(shapes("flask-abcdefghijklmnop"), "flask-abcdefghijklmnop");
  assert.equal(shapes("2sk-abcdefghijklmnop"), "2sk-abcdefghijklmnop");
  // A separator before the token is allowed, so compound spellings fire.
  assert.equal(shapes("prefix_sk-abcdefghijklmnop"), "prefix_[REDACTED]");
});

test("CREDENTIAL_ASSIGNMENT redacts unquoted, double-quoted, and single-quoted values", () => {
  const cases: [string, string][] = [
    ["api_key=abc123def456", "api_key=[REDACTED]"],
    ['password: "hunter2 hunter3"', "password: [REDACTED]"],
    ["token='super secret'", "token=[REDACTED]"],
    // quoted values keep escaped quotes inside the matched span
    ['secret: "a\\"b c"', "secret: [REDACTED]"],
    // unquoted values stop at structural delimiters
    ["{token: abc123def}", "{token: [REDACTED]}"],
    // an ordinary key is untouched
    ["username=alice", "username=alice"],
  ];
  for (const [input, expected] of cases) assert.equal(assignments(input), expected, input);
});

test("CREDENTIAL_ASSIGNMENT key vocabulary derives SECRET_KEY_ALTERNATION names plus admin-only names", () => {
  const keys = [
    "api_key", "api-key", "apikey", "token", "password", "secret", "access_key", "accesskey",
    "auth_token", "private_key", "privateKey", "client_key",
    "passwd", "pwd", "credential", "authorization",
  ];
  for (const key of keys) {
    for (const sep of ["=", ":"]) {
      const input = `${key}${sep}sup3rsecretvalue`;
      assert.equal(assignments(input), `${key}${sep}[REDACTED]`, input);
    }
  }
});

test("USERINFO_URL redacts credentials in URLs and leaves clean URLs alone", () => {
  assert.equal(
    userinfo("postgres://deploy:hunter2@db.example.test:5432/prod"),
    "postgres://[REDACTED]@db.example.test:5432/prod",
  );
  // base64-style credential containing '/' still matches
  assert.equal(
    userinfo("https://user:a/b+c=@registry.example.test/v2"),
    "https://[REDACTED]@registry.example.test/v2",
  );
  // no userinfo, no '@', no redaction
  assert.equal(userinfo("https://example.test/path?query=1"), "https://example.test/path?query=1");
});

test("redactSecretShapes composes all three patterns in one pass", () => {
  const input = 'failure for https://deploy:hunter2@ci.example.test/api (api_key: "CI deploy token", fallback AKIAIOSFODNN7EXAMPLE)';
  const output = redactSecretShapes(input);
  assert.equal(output, "failure for https://[REDACTED]@ci.example.test/api (api_key: [REDACTED], fallback [REDACTED])");
  for (const leaked of ["hunter2", "CI deploy token", "AKIAIOSFODNN7EXAMPLE"]) {
    assert.ok(!output.includes(leaked), `leaked ${leaked}`);
  }
});
