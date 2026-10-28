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

test("pendingMigrations from a partial prefix applies only the tail", () => {
  if (CONTROL_PLANE_MIGRATIONS.length < 2) {
    return; // meaningful only once the list has more than one migration
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

test("pendingMigrations refuses a non-prefix applied set", () => {
  // A hole below an applied version means broken schema history. With
  // only migration 1 in the list there IS no hole below anything, so
  // the case only exists once the list grows.
  if (CONTROL_PLANE_MIGRATIONS.length < 2) {
    return;
  }
  assert.throws(() => pendingMigrations(new Set([1, 3])), /not a prefix/);
});

test("schema columns carry no secret-bearing names", () => {
  // The #736 "do not persist" rule enforced against the DDL itself:
  // no column in any migration is a credential/secret-shaped name, so
  // the schema cannot even hold the material the contract forbids.
  const forbidden = /^(.*(secret|password|credential|bearer|authorization|api_?key|auth_?token).*|token|access_token|refresh_token)$/i;
  for (const migration of CONTROL_PLANE_MIGRATIONS) {
    for (const statement of migration.statements) {
      if (!statement.includes("CREATE TABLE")) continue;
      for (const line of statement.split("\n")) {
        const column = /^\s{2}([a-z_0-9]+)\s+(text|bigint|boolean|jsonb|integer)[\s,]*$/.exec(line);
        if (column === null) continue;
        assert.equal(
          forbidden.test(column[1]!),
          false,
          `forbidden secret-shaped column in schema: ${column[1]}`,
        );
      }
    }
  }
});
