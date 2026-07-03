// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
/**
 * Fixture: NEGATIVE — untyped-sqlite rule MUST classify every site below as clean.
 *
 * Walker assertion: 0 violations.
 */

interface TokenRow {
  id: string;
  count: number;
}

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
interface RowMapper<T> {
  parseRows(raw: unknown): Result<T[], Error>;
  parseOptionalRow(raw: unknown): Result<T | undefined, Error>;
}

declare const db: {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown;
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
  };
};
declare const tokenMapper: RowMapper<TokenRow>;

// CLEAN: mapper.parseRows wrapping .all()
function c1() {
  return tokenMapper.parseRows(db.prepare("SELECT *").all());
}

// CLEAN: mapper.parseOptionalRow wrapping .get()
function c2() {
  return tokenMapper.parseOptionalRow(db.prepare("SELECT * WHERE id = ?").get("a"));
}

// CLEAN: .run(...) (mutation — never has a cast)
function c3() {
  db.prepare("INSERT INTO tokens (id, count) VALUES (?, ?)").run("a", 1);
}

// CLEAN: string literal containing the forbidden pattern
const docs = "Don't: stmt.all() as Foo[]";

// CLEAN: comment containing the forbidden pattern
// We migrated stmt.all() as Foo[] to mapper.parseRows(stmt.all()).
function c4() {}
