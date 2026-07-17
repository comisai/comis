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

import type Database from "better-sqlite3";
import { z } from "zod";
import { err, ok, tryCatch } from "@comis/shared";
import type { Result } from "@comis/shared";
import type {
  SecretStorePort,
  SecretMetadata,
  SecretsCrypto,
  EncryptedSecret,
} from "@comis/core";
import {
  initSecretSchema,
  validateCanary,
  CANARY_NAME,
  EncryptedSecretProjectionSchema,
} from "./secret-store-schema.js";
import { openSqliteDatabase, chmodDbFiles } from "./sqlite-adapter-base.js";
import { systemNowMs } from "@comis/core";
import { createRowMapper } from "./row-mapper.js";

// Anonymous-projection mappers.
// decryptAll: returns all encrypted-secret rows (name + 4 BLOB columns).
const decryptAllRowMapper = createRowMapper(
  z.strictObject({
    name: z.string(),
    ciphertext: z.instanceof(Buffer),
    iv: z.instanceof(Buffer),
    auth_tag: z.instanceof(Buffer),
    salt: z.instanceof(Buffer),
  }),
);
const encryptedSecretProjectionMapper = createRowMapper(EncryptedSecretProjectionSchema);
// list: returns secret metadata rows.
const secretListRowMapper = createRowMapper(
  z.strictObject({
    name: z.string(),
    provider: z.string().nullable(),
    description: z.string().nullable(),
    expires_at: z.number().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
  }),
);

/**
 * Concrete return type of createSqliteSecretStore.
 *
 * Implements SecretStorePort and additionally exposes the underlying
 * better-sqlite3 handle for adapters that need to share the same
 * connection (e.g., the encrypted OAuth profile store).
 *
 * The `db` field is intentionally additive — `SecretStorePort` itself is
 * unchanged and remains the canonical port boundary. Consumers that only
 * need port-level operations should accept `SecretStorePort`, not
 * `SqliteSecretStoreHandle`.
 */
export interface SqliteSecretStoreHandle extends SecretStorePort {
  /**
   * Underlying better-sqlite3 handle.
   *
   * Use for sharing the connection with sibling tables in the same DB
   * file (e.g., `oauth_profiles` alongside `secrets`). Eliminates the
   * dual-handle hazard (close-order, schema-init double-execution,
   * prepared-statement cache fragmentation) that two separate handles
   * to the same WAL-mode SQLite file would introduce.
   */
  readonly db: Database.Database;
}

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
 * 8. Return frozen SqliteSecretStoreHandle (SecretStorePort + db field)
 *
 * @param dbPath - Absolute path to the secrets.db file
 * @param crypto - SecretsCrypto engine bound to the current master key
 * @returns SqliteSecretStoreHandle — a SecretStorePort that also exposes
 *          the underlying better-sqlite3 handle on `.db`
 * @throws Error if schema init, canary validation, or DB open fails
 */
export function createSqliteSecretStore(
  dbPath: string,
  crypto: SecretsCrypto,
): SqliteSecretStoreHandle {
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

  const listStmt = db.prepare(
    "SELECT name, provider, description, expires_at, created_at, updated_at FROM secrets WHERE name != ?",
  );

  const deleteStmt = db.prepare(
    "DELETE FROM secrets WHERE name = ?",
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
      const now = systemNowMs();

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
      const readResult = tryCatch(() => getStmt.get(name));
      if (!readResult.ok) return readResult;

      const parsed = encryptedSecretProjectionMapper.parseOptionalRow(readResult.value);
      if (!parsed.ok) return err(new Error(`Row validation failed at ${parsed.error.path}`));
      const row = parsed.value;
      if (!row) return ok(undefined);

      const encrypted: EncryptedSecret = {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        salt: row.salt,
      };
      return crypto.decrypt(encrypted);
    },

    decryptAll(): Result<Map<string, string>, Error> {
      const parsed = decryptAllRowMapper.parseRows(getAllStmt.all(CANARY_NAME));
      if (!parsed.ok) {
        return err(new Error(`Row validation failed: ${parsed.error.message}`));
      }
      return tryCatch(() => {
        const rows = parsed.value;

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

    list(): Result<SecretMetadata[], Error> {
      const parsed = secretListRowMapper.parseRows(listStmt.all(CANARY_NAME));
      if (!parsed.ok) {
        return err(new Error(`Row validation failed: ${parsed.error.message}`));
      }
      return tryCatch(() => {
        const rows = parsed.value;

        return rows.map((row) => ({
          name: row.name,
          provider: row.provider ?? undefined,
          description: row.description ?? undefined,
          expiresAt: row.expires_at ?? undefined,
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

    close(): void {
      db.close();
    },
  };

  // Expose the underlying db handle on the factory return so the encrypted
  // OAuth profile adapter (oauth-profile-store-encrypted) can share this same
  // connection rather than opening a second handle to the same secrets.db
  // file. The SecretStorePort surface itself is unchanged — consumers that
  // only need port-level operations should accept SecretStorePort, not
  // SqliteSecretStoreHandle.
  const handle: SqliteSecretStoreHandle = { ...store, db };
  return Object.freeze(handle);
}
