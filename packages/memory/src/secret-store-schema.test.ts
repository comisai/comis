/**
 * Tests for secret store schema DDL and canary validation.
 *
 * Uses in-memory SQLite databases and real crypto from @comis/core
 * to validate schema creation and master key mismatch detection.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { createSecretsCrypto } from "@comis/core";
import {
  initSecretSchema,
  validateCanary,
  CANARY_NAME,
} from "./secret-store-schema.js";

function makeCrypto() {
  const key = randomBytes(32);
  return createSecretsCrypto(key);
}

describe("initSecretSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("creates secrets table with expected columns", () => {
    initSecretSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(secrets)")
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;

    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("name");
    expect(columnNames).toContain("ciphertext");
    expect(columnNames).toContain("iv");
    expect(columnNames).toContain("auth_tag");
    expect(columnNames).toContain("salt");
    expect(columnNames).toContain("provider");
    expect(columnNames).toContain("description");
    expect(columnNames).toContain("expires_at");
    expect(columnNames).toContain("last_used_at");
    expect(columnNames).toContain("usage_count");
    expect(columnNames).toContain("created_at");
    expect(columnNames).toContain("updated_at");

    // Should have exactly 12 columns
    expect(columns).toHaveLength(12);

    // Verify BLOB types for encrypted fields
    const blobColumns = columns.filter((c) => c.type === "BLOB");
    expect(blobColumns.map((c) => c.name).sort()).toEqual(
      ["auth_tag", "ciphertext", "iv", "salt"],
    );

    // Verify name is primary key
    const pkColumn = columns.find((c) => c.pk === 1);
    expect(pkColumn?.name).toBe("name");
  });

  it("is idempotent (safe to call multiple times)", () => {
    initSecretSchema(db);
    initSecretSchema(db);

    const columns = db
      .prepare("PRAGMA table_info(secrets)")
      .all() as Array<{ name: string }>;
    expect(columns).toHaveLength(12);
  });
});

describe("validateCanary", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSecretSchema(db);
  });

  it("creates canary row on fresh database", () => {
    const crypto = makeCrypto();
    validateCanary(db, crypto);

    const row = db
      .prepare("SELECT name FROM secrets WHERE name = ?")
      .get(CANARY_NAME) as { name: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.name).toBe(CANARY_NAME);
  });

  it("succeeds silently on existing database with correct key", () => {
    const crypto = makeCrypto();

    // First call: creates canary
    validateCanary(db, crypto);

    // Second call: validates canary (should not throw)
    expect(() => validateCanary(db, crypto)).not.toThrow();
  });

  it("throws DECRYPTION_FAILED with wrong master key", () => {
    const crypto1 = makeCrypto();
    const crypto2 = makeCrypto();

    // Create canary with key 1
    validateCanary(db, crypto1);

    // Validate with key 2 -- should fail
    expect(() => validateCanary(db, crypto2)).toThrow(/DECRYPTION_FAILED/);
  });

  it("exports CANARY_NAME for downstream exclusion", () => {
    expect(CANARY_NAME).toBe("__comis_canary__");
  });
});
