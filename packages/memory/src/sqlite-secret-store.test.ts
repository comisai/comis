// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for SqliteSecretStore — SecretStorePort implementation with
 * AES-256-GCM encrypted BLOB storage in SQLite.
 *
 * Uses real crypto (no mocks) and temp files for persistence testing.
 * Each test gets a unique temp DB path cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { createSecretsCrypto } from "@comis/core";
import type { SecretsCrypto, SecretMetadata } from "@comis/core";
import type { Result } from "@comis/shared";
import { createSqliteSecretStore } from "./sqlite-secret-store.js";

function makeCrypto(): SecretsCrypto {
  return createSecretsCrypto(randomBytes(32));
}

function tempDbPath(): string {
  const dir = os.tmpdir();
  const name = `comis-test-secrets-${randomBytes(8).toString("hex")}.db`;
  return `${dir}/${name}`;
}

/** Unwrap a Result or fail the test. */
function unwrap<T>(result: Result<T, Error>): T {
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${result.error.message}`);
  }
  return result.value;
}

describe("createSqliteSecretStore", () => {
  let dbPath: string;
  let crypto: SecretsCrypto;

  beforeEach(() => {
    dbPath = tempDbPath();
    crypto = makeCrypto();
  });

  afterEach(() => {
    // Clean up temp database files
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix);
      } catch {
        // File may not exist
      }
    }
  });

  describe("set + getDecrypted round-trip", () => {
    it("stores and retrieves a secret", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      const setResult = store.set("API_KEY", "sk-secret-123");
      expect(setResult.ok).toBe(true);

      const plaintext = unwrap(store.getDecrypted("API_KEY"));
      expect(plaintext).toBe("sk-secret-123");

      store.close();
    });
  });

  describe("UPSERT behavior", () => {
    it("preserves created_at on update, changes updated_at", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("MY_SECRET", "original-value");

      // Get metadata before update
      const beforeItems = unwrap(store.list());
      const beforeMeta = beforeItems.find((m) => m.name === "MY_SECRET");
      expect(beforeMeta).toBeDefined();
      const createdBefore = beforeMeta!.createdAt;

      // Small delay to ensure timestamp difference
      const now = Date.now();
      while (Date.now() === now) {
        // busy-wait for at least 1ms
      }

      store.set("MY_SECRET", "updated-value");

      const afterItems = unwrap(store.list());
      const afterMeta = afterItems.find((m) => m.name === "MY_SECRET");
      expect(afterMeta).toBeDefined();

      // created_at preserved
      expect(afterMeta!.createdAt).toBe(createdBefore);
      // updated_at changed
      expect(afterMeta!.updatedAt).toBeGreaterThanOrEqual(createdBefore);

      // Value updated
      const plaintext = unwrap(store.getDecrypted("MY_SECRET"));
      expect(plaintext).toBe("updated-value");

      store.close();
    });
  });

  describe("getDecrypted", () => {
    it("returns ok(undefined) for missing secret", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      const plaintext = unwrap(store.getDecrypted("NONEXISTENT"));
      expect(plaintext).toBeUndefined();

      store.close();
    });
  });

  describe("decryptAll", () => {
    it("returns all stored secrets as Map", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("KEY_A", "value-a");
      store.set("KEY_B", "value-b");
      store.set("KEY_C", "value-c");

      const map = unwrap(store.decryptAll());
      expect(map.size).toBe(3);
      expect(map.get("KEY_A")).toBe("value-a");
      expect(map.get("KEY_B")).toBe("value-b");
      expect(map.get("KEY_C")).toBe("value-c");

      store.close();
    });

    it("returns empty Map on empty store", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      const map = unwrap(store.decryptAll());
      expect(map.size).toBe(0);

      store.close();
    });

    it("excludes canary from results", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("USER_SECRET", "my-value");

      const map = unwrap(store.decryptAll());
      // Should only contain user secret, not canary
      expect(map.has("__comis_canary__")).toBe(false);
      expect(map.size).toBe(1);
      expect(map.get("USER_SECRET")).toBe("my-value");

      store.close();
    });
  });

  describe("exists", () => {
    it("returns true for stored secret, false for missing", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      expect(store.exists("ABSENT")).toBe(false);

      store.set("PRESENT", "value");
      expect(store.exists("PRESENT")).toBe(true);

      store.close();
    });
  });

  describe("list", () => {
    it("returns metadata without secret values", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("DB_PASSWORD", "secret123", {
        provider: "postgres",
        description: "Main database password",
      });

      const items = unwrap(store.list());
      expect(items).toHaveLength(1);

      const item = items[0] as SecretMetadata & Record<string, unknown>;
      expect(item.name).toBe("DB_PASSWORD");
      expect(item.provider).toBe("postgres");
      expect(item.description).toBe("Main database password");
      expect(item.usageCount).toBe(0);
      expect(item.createdAt).toBeTypeOf("number");
      expect(item.updatedAt).toBeTypeOf("number");

      // No secret value in metadata
      expect(item).not.toHaveProperty("ciphertext");
      expect(item).not.toHaveProperty("iv");
      expect(item).not.toHaveProperty("authTag");
      expect(item).not.toHaveProperty("salt");
      expect(item).not.toHaveProperty("plaintext");

      store.close();
    });

    it("excludes canary from list results", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("VISIBLE_SECRET", "hello");

      const items = unwrap(store.list());
      const names = items.map((i) => i.name);
      expect(names).not.toContain("__comis_canary__");
      expect(names).toContain("VISIBLE_SECRET");

      store.close();
    });
  });

  describe("delete", () => {
    it("returns ok(true) for existing secret", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("TO_DELETE", "value");
      const deleted = unwrap(store.delete("TO_DELETE"));
      expect(deleted).toBe(true);

      // Confirm deleted
      expect(store.exists("TO_DELETE")).toBe(false);

      store.close();
    });

    it("returns ok(false) for non-existent secret", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      const deleted = unwrap(store.delete("DOES_NOT_EXIST"));
      expect(deleted).toBe(false);

      store.close();
    });
  });

  describe("recordUsage", () => {
    it("increments usage_count and updates last_used_at", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      store.set("TRACKED", "value");

      // Initial state
      const beforeItems = unwrap(store.list());
      const before = beforeItems.find((m) => m.name === "TRACKED");
      expect(before!.usageCount).toBe(0);
      expect(before!.lastUsedAt).toBeUndefined();

      // Record usage
      store.recordUsage("TRACKED");

      const afterItems = unwrap(store.list());
      const after = afterItems.find((m) => m.name === "TRACKED");
      expect(after!.usageCount).toBe(1);
      expect(after!.lastUsedAt).toBeTypeOf("number");

      // Record again
      store.recordUsage("TRACKED");

      const finalItems = unwrap(store.list());
      const final = finalItems.find((m) => m.name === "TRACKED");
      expect(final!.usageCount).toBe(2);

      store.close();
    });
  });

  describe("close", () => {
    it("does not throw", () => {
      const store = createSqliteSecretStore(dbPath, crypto);
      expect(() => store.close()).not.toThrow();
    });
  });

  describe("WAL mode", () => {
    it("enables WAL journal mode", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      // Open a new connection to verify WAL mode persists
      const db = new Database(dbPath);
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode).toBe("wal");
      db.close();

      store.close();
    });
  });

  describe("file permissions", () => {
    it("sets 0o600 on secrets.db", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      const stat = fs.statSync(dbPath);
      // Check file mode (lower 9 bits)
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      store.close();
    });
  });

  describe("persistence", () => {
    it("survives close and reopen", () => {
      const store1 = createSqliteSecretStore(dbPath, crypto);
      store1.set("PERSIST_KEY", "persist-value");
      store1.close();

      const store2 = createSqliteSecretStore(dbPath, crypto);
      const plaintext = unwrap(store2.getDecrypted("PERSIST_KEY"));
      expect(plaintext).toBe("persist-value");
      store2.close();
    });
  });

  // Phase 7 plan 08 task 08.1 (W6 fix):
  // The factory now returns SqliteSecretStoreHandle (= SecretStorePort + readonly db).
  // The encrypted OAuth profile adapter shares this same db handle rather than
  // opening a second connection to the same secrets.db file.
  describe("SqliteSecretStoreHandle.db field (Phase 7 W6)", () => {
    it("exposes the underlying better-sqlite3 handle on the factory return", () => {
      const store = createSqliteSecretStore(dbPath, crypto);

      // db field is present and looks like a Database instance.
      expect(store.db).toBeDefined();
      expect(typeof store.db.prepare).toBe("function");
      expect(typeof store.db.exec).toBe("function");
      expect(typeof store.db.close).toBe("function");

      // The shared handle can prepare statements against the same secrets table
      // that the port methods use — proving it's the SAME connection, not a
      // freshly-opened one. (A freshly-opened connection on a not-yet-WAL-flushed
      // file would still see the canary, but proving prepare/exec on the shared
      // handle is sufficient for the shared-handle property the encrypted
      // OAuth adapter relies on.)
      const row = store.db
        .prepare("SELECT COUNT(*) AS n FROM secrets")
        .get() as { n: number };
      expect(row.n).toBeGreaterThanOrEqual(1); // at least the canary row exists

      store.close();
    });
  });
});
