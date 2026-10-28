/** Control-plane migration policy (#736): the pure planner's
 * fail-closed rules and the schema's secret-free surface — the checks
 * that run WITHOUT a database. The database-backed migration runs are
 * in state-postgres.test.ts (DSN-gated). */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTROL_PLANE_MIGRATIONS,
  pendingMigrations,
} from "../src/state/index.js";

test("migration list is contiguous from 1", () => {
  assert.ok(CONTROL_PLANE_MIGRATIONS.length >= 1);
  CONTROL_PLANE_MIGRATIONS.forEach((migration, index) => {
    assert.equal(migration.version, index + 1);
    assert.ok(migration.statements.length >= 1);
    for (const statement of migration.statements) {
      assert.equal(typeof statement, "string");
      assert.ok(statement.trim().length > 0);
    }
  });
});

test("pendingMigrations from empty applies every migration in order", () => {
  const pending = pendingMigrations(new Set());
  assert.deepEqual(
    pending.map((m) => m.version),
    CONTROL_PLANE_MIGRATIONS.map((m) => m.version),
  );
});

test("pendingMigrations from current is empty", () => {
  const all = new Set(CONTROL_PLANE_MIGRATIONS.map((m) => m.version));
  assert.deepEqual(pendingMigrations(all), []);
});

test("pendingMigrations from a partial prefix applies only the tail", (t) => {
  if (CONTROL_PLANE_MIGRATIONS.length < 2) {
    // Meaningful only once the list has more than one migration.
    t.skip("migration list has a single entry: no partial prefix exists yet");
    return;
  }
  assert.deepEqual(
    pendingMigrations(new Set([1])).map((m) => m.version),
    CONTROL_PLANE_MIGRATIONS.map((m) => m.version).filter((v) => v > 1),
  );
});

test("pendingMigrations refuses a database ahead of this build", () => {
  assert.throws(() => pendingMigrations(new Set([999])), /ahead of this build/);
  assert.throws(
    () => pendingMigrations(new Set([CONTROL_PLANE_MIGRATIONS.length + 1])),
    /ahead of this build/,
  );
});

test("pendingMigrations refuses a non-prefix applied set", (t) => {
  // A hole below an applied version means broken schema history. The
  // example needs at least THREE versions: with fewer, {1, 3} is
  // "ahead of this build" instead of a hole at 2.
  if (CONTROL_PLANE_MIGRATIONS.length < 3) {
    t.skip("migration list shorter than three: no hole example exists yet");
    return;
  }
  assert.throws(() => pendingMigrations(new Set([1, 3])), /not a prefix/);
});

const COLUMN_FORBIDDEN_PATTERN = /^(.*(secret|password|credential|bearer|authorization|api_?key|auth_?token).*|token|access_token|refresh_token)$/i;
const COLUMN_CONSTRAINT_KEYWORDS = new Set([
  "primary", "unique", "check", "foreign", "constraint", "exclude",
]);

/** Extract column names from one CREATE TABLE statement: any line
 * whose first token is followed by a type token. Constraint lines
 * (PRIMARY KEY / CHECK / ...) are skipped by keyword. Deliberately
 * type-agnostic (any column definition shape counts) so a new column
 * type cannot silently drop a column out of the scan. */
function columnNamesOf(statement: string): string[] {
  const names: string[] = [];
  for (const line of statement.split("\n")) {
    const match = /^\s+([a-z_0-9]+)\s+(\w+)/.exec(line);
    if (match === null) continue;
    if (COLUMN_CONSTRAINT_KEYWORDS.has(match[2]!.toLowerCase())) continue;
    names.push(match[1]!);
  }
  return names;
}

test("schema columns carry no secret-bearing names", () => {
  // The #736 "do not persist" rule enforced against the DDL itself:
  // no column in any migration is a credential/secret-shaped name, so
  // the schema cannot even hold the material the contract forbids.
  for (const migration of CONTROL_PLANE_MIGRATIONS) {
    for (const statement of migration.statements) {
      if (!statement.includes("CREATE TABLE")) continue;
      for (const name of columnNamesOf(statement)) {
        assert.equal(
          COLUMN_FORBIDDEN_PATTERN.test(name),
          false,
          `forbidden secret-shaped column in schema: ${name}`,
        );
      }
    }
  }
});

test("the column scan flags a secret-shaped column when one appears", () => {
  // Adversarial-boundary rule: the scan is fed the boundary token
  // itself. A synthetic migration statement carrying api_key/token
  // columns MUST be flagged — a scan that passes hostile input would
  // be a scan that passes nothing.
  const hostile = `CREATE TABLE cp_hostile (
  ok_column text NOT NULL,
  api_key text NOT NULL,
  model_token bigint NOT NULL,
  PRIMARY KEY (ok_column),
  CHECK (length(api_key) = 0)
)`;
  const names = columnNamesOf(hostile);
  assert.ok(names.includes("api_key"));
  assert.ok(names.includes("model_token"));
  assert.ok(names.includes("ok_column"));
  // Constraint lines (PRIMARY KEY / CHECK) introduce no column names:
  // neither the leading keyword nor the referenced identifier inside
  // the parens reads as a column.
  assert.ok(!names.includes("primary"));
  assert.ok(!names.includes("check"));
  assert.ok(!names.includes("length"));
  assert.equal(names.some((name) => COLUMN_FORBIDDEN_PATTERN.test(name)), true);
});
