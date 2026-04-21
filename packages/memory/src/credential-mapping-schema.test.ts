// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for credential mapping schema DDL.
 *
 * Uses in-memory SQLite databases with the secrets table as a prerequisite
 * (credential_mappings has a foreign key to secrets(name)).
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSecretSchema } from "./secret-store-schema.js";
import { initCredentialMappingSchema } from "./credential-mapping-schema.js";

describe("initCredentialMappingSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // Prerequisite: secrets table must exist for the foreign key
    initSecretSchema(db);
  });

  it("creates credential_mappings table with expected columns", () => {
    initCredentialMappingSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(credential_mappings)")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("id");
    expect(columnNames).toContain("secret_name");
    expect(columnNames).toContain("injection_type");
    expect(columnNames).toContain("injection_key");
    expect(columnNames).toContain("url_pattern");
    expect(columnNames).toContain("tool_name");

    // Should have exactly 6 columns
    expect(columns).toHaveLength(6);

    // Verify id is primary key
    const pkColumn = columns.find((c) => c.pk === 1);
    expect(pkColumn?.name).toBe("id");

    // Verify NOT NULL constraints
    const notNullColumns = columns.filter((c) => c.notnull === 1).map((c) => c.name);
    expect(notNullColumns).toContain("secret_name");
    expect(notNullColumns).toContain("injection_type");
    expect(notNullColumns).toContain("url_pattern");
  });

  it("is idempotent (safe to call multiple times)", () => {
    initCredentialMappingSchema(db);
    initCredentialMappingSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(credential_mappings)")
      .all() as Array<{ name: string }>;
    expect(columns).toHaveLength(6);
  });

  it("rejects invalid injection_type via CHECK constraint", () => {
    initCredentialMappingSchema(db);

    // Insert a valid secret first (foreign key prerequisite)
    db.prepare(
      "INSERT INTO secrets (name, ciphertext, iv, auth_tag, salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("test-secret", Buffer.from("c"), Buffer.from("i"), Buffer.from("a"), Buffer.from("s"), Date.now(), Date.now());

    expect(() => {
      db.prepare(
        "INSERT INTO credential_mappings (id, secret_name, injection_type, url_pattern) VALUES (?, ?, ?, ?)",
      ).run("map-1", "test-secret", "invalid", "https://api.example.com/*");
    }).toThrow(/CHECK/);
  });

  it("rejects foreign key violation (non-existent secret)", () => {
    initCredentialMappingSchema(db);

    expect(() => {
      db.prepare(
        "INSERT INTO credential_mappings (id, secret_name, injection_type, url_pattern) VALUES (?, ?, ?, ?)",
      ).run("map-1", "nonexistent-secret", "bearer_header", "https://api.example.com/*");
    }).toThrow(/FOREIGN KEY/);
  });

  it("creates indexes on secret_name and tool_name", () => {
    initCredentialMappingSchema(db);

    const indexes = db
      .prepare("PRAGMA index_list(credential_mappings)")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_cred_map_secret");
    expect(indexNames).toContain("idx_cred_map_tool");
  });
});
