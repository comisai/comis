// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

describe("schema introspection row validation", () => {
  it("parses the complete PRAGMA table_info row shape", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'x')");

    const rows = requireTableInfoRows(db.prepare("PRAGMA table_info(sample)").all(), "sample");

    expect(rows.map((row) => ({ name: row.name, pk: row.pk }))).toEqual([
      { name: "id", pk: 1 },
      { name: "label", pk: 0 },
    ]);
    db.close();
  });

  it("rejects malformed PRAGMA metadata at the schema-init boundary", () => {
    expect(() =>
      requireTableInfoRows(
        [{ cid: 0, name: 7, type: "TEXT", notnull: 0, dflt_value: null, pk: 0 }],
        "sample",
      ),
    ).toThrow("Schema inspection failed for sample at row[0].name");
  });
});
