// SPDX-License-Identifier: Apache-2.0
/**
 * SqliteSecretStore — SecretStorePort implementation with AES-256-GCM encrypted
 * BLOB storage in a dedicated SQLite database.
 *
 * Factory function pattern: opens `secrets.db`, initializes schema and canary,
 * prepares all SQL statements once, and returns a frozen SecretStorePort object.
 *
 * All secret values are encrypted before storage and decrypted on retrieval.
 * Ciphertext never leaves this adapter — callers provide and receive plaintext.
 *
 * Persists encrypted secrets across daemon restarts.
 */

import { err, tryCatch } from "@comis/shared";
import type { Result } from "@comis/shared";
import type {
  SecretStorePort,
  SecretMetadata,
  SecretsCrypto,
  EncryptedSecret,
} from "@comis/core";
import { initSecretSchema, validateCanary, CANARY_NAME } from "./secret-store-schema.js";
import { openSqliteDatabase, chmodDbFiles } from "./sqlite-adapter-base.js";

/**
 * Create a SqliteSecretStore bound to the given database path.
 *
 * Initialization sequence:
 * 1. Ensure parent directory exists with 0o700 permissions
 * 2. Open database with WAL mode and synchronous=NORMAL
 * 3. Set file permissions to 0o600 (owner-only read/write)
 * 4. Initialize schema (CREATE TABLE IF NOT EXISTS)
 * 5. Validate canary (master key mismatch detection)
 * 6. Second chmod pass (SQLite may create WAL/SHM during canary)
 * 7. Prepare all SQL statements once
 * 8. Return frozen SecretStorePort object
 *
 * @param dbPath - Absolute path to the secrets.db file
 * @param crypto - SecretsCrypto engine bound to the current master key
 * @returns SecretStorePort implementation
 * @throws Error if schema init, canary validation, or DB open fails
 */
export function createSqliteSecretStore(
  dbPath: string,
  crypto: SecretsCrypto,
): SecretStorePort {
  // Steps 1-5: Open database with standardized lifecycle (mkdir, pragmas, chmod, schema)
  const db = openSqliteDatabase({
    dbPath,
    initSchema: (d) => initSecretSchema(d),
  });

  // Step 6: Validate canary (may write on first open)
  validateCanary(db, crypto);

  // Step 7: Second chmod pass (WAL/SHM may have been created during canary INSERT)
  chmodDbFiles(dbPath, 0o600);

  // Step 8: Prepare all SQL statements once
  const upsertStmt = db.prepare(`
    INSERT INTO secrets (name, ciphertext, iv, auth_tag, salt, provider, description, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      salt = excluded.salt,
      provider = excluded.provider,
      description = excluded.description,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `);

  const getStmt = db.prepare(
    "SELECT ciphertext, iv, auth_tag, salt FROM secrets WHERE name = ?",
  );

  const getAllStmt = db.prepare(
    "SELECT name, ciphertext, iv, auth_tag, salt FROM secrets WHERE name != ?",
  );

  const existsStmt = db.prepare(
    "SELECT 1 FROM secrets WHERE name = ?",
  );

  const listStmt = db.prepare(
    "SELECT name, provider, description, expires_at, last_used_at, usage_count, created_at, updated_at FROM secrets WHERE name != ?",
  );

  const deleteStmt = db.prepare(
    "DELETE FROM secrets WHERE name = ?",
  );

  const recordUsageStmt = db.prepare(
    "UPDATE secrets SET usage_count = usage_count + 1, last_used_at = ? WHERE name = ?",
  );

  // Step 9: Return frozen SecretStorePort object
  const store: SecretStorePort = {
    set(
      name: string,
      plaintext: string,
      opts?: { provider?: string; description?: string; expiresAt?: number },
    ): Result<void, Error> {
      // Encrypt plaintext
      const encryptResult = crypto.encrypt(plaintext);
      if (!encryptResult.ok) {
        return err(encryptResult.error);
      }
      const encrypted = encryptResult.value;
      const now = Date.now();

      return tryCatch(() => {
        upsertStmt.run(
          name,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.salt,
          opts?.provider ?? null,
          opts?.description ?? null,
          opts?.expiresAt ?? null,
          now,
          now,
        );
      });
    },

    getDecrypted(name: string): Result<string | undefined, Error> {
      return tryCatch(() => {
        const row = getStmt.get(name) as
          | { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; salt: Buffer }
          | undefined;

        if (!row) {
          return undefined;
        }

        // Reconstruct EncryptedSecret from BLOB columns
        const encrypted: EncryptedSecret = {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.auth_tag,
          salt: row.salt,
        };

        const decryptResult = crypto.decrypt(encrypted);
        if (!decryptResult.ok) {
          throw decryptResult.error;
        }

        return decryptResult.value;
      });
    },

    decryptAll(): Result<Map<string, string>, Error> {
      return tryCatch(() => {
        const rows = getAllStmt.all(CANARY_NAME) as Array<{
          name: string;
          ciphertext: Buffer;
          iv: Buffer;
          auth_tag: Buffer;
          salt: Buffer;
        }>;

        const map = new Map<string, string>();

        for (const row of rows) {
          const encrypted: EncryptedSecret = {
            ciphertext: row.ciphertext,
            iv: row.iv,
            authTag: row.auth_tag,
            salt: row.salt,
          };

          const decryptResult = crypto.decrypt(encrypted);
          if (!decryptResult.ok) {
            throw decryptResult.error;
          }

          map.set(row.name, decryptResult.value);
        }

        return map;
      });
    },

    exists(name: string): boolean {
      const row = existsStmt.get(name);
      return row !== undefined;
    },

    list(): Result<SecretMetadata[], Error> {
      return tryCatch(() => {
        const rows = listStmt.all(CANARY_NAME) as Array<{
          name: string;
          provider: string | null;
          description: string | null;
          expires_at: number | null;
          last_used_at: number | null;
          usage_count: number;
          created_at: number;
          updated_at: number;
        }>;

        return rows.map((row) => ({
          name: row.name,
          provider: row.provider ?? undefined,
          description: row.description ?? undefined,
          expiresAt: row.expires_at ?? undefined,
          lastUsedAt: row.last_used_at ?? undefined,
          usageCount: row.usage_count,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      });
    },

    delete(name: string): Result<boolean, Error> {
      return tryCatch(() => {
        const result = deleteStmt.run(name);
        return result.changes > 0;
      });
    },

    recordUsage(name: string): void {
      const now = Date.now();
      recordUsageStmt.run(now, name);
    },

    close(): void {
      db.close();
    },
  };

  return Object.freeze(store);
}
