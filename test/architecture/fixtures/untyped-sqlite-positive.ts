// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: POSITIVE — untyped-sqlite rule should flag every cast below.
 *
 * Walker assertion: ≥ 5 violations.
 */

interface TokenRow {
  id: string;
  count: number;
}

declare const db: {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
  };
};

// VIOLATION: .all(...) as Row[]
function v1() {
  return db.prepare("SELECT id, count FROM tokens").all() as TokenRow[];
}

// VIOLATION: .get(...) as Row
function v2() {
  return db.prepare("SELECT id, count FROM tokens WHERE id = ?").get("a") as TokenRow;
}

// VIOLATION: .get(...) as Row | undefined
function v3() {
  return db.prepare("SELECT id FROM tokens").get() as TokenRow | undefined;
}

// VIOLATION: nested cast (as unknown) as Row[]
function v4() {
  return (db.prepare("SELECT *").all() as unknown) as TokenRow[];
}

// VIOLATION: chained access then cast
function v5() {
  const stmt = db.prepare("SELECT *");
  return stmt.all() as TokenRow[];
}

// VIOLATION: multiline call and named cast
function v6() {
  return db
    .prepare("SELECT *")
    .all(
      "a",
    ) as TokenRow[];
}

// VIOLATION: inline object array cast
function v7() {
  return db.prepare("SELECT id FROM tokens").all() as { id: string }[];
}

// VIOLATION: multiline inline object cast
function v8() {
  return db
    .prepare("SELECT count FROM tokens")
    .get() as {
      count: number;
    };
}

// VIOLATION: Array<inline object> cast
function v9() {
  return db.prepare("SELECT id FROM tokens").all() as Array<{ id: string }>;
}
