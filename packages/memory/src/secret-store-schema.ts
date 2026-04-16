/**
 * Secret store SQLite schema DDL and canary-based master key validation.
 *
 * Provides the storage foundation for encrypted secrets: a `secrets` table
 * with BLOB columns for AES-256-GCM encrypted components, and a canary
 * mechanism to detect master key mismatches at store open time -- preventing
 * silent data corruption from a wrong key.
 *
 * The canary is a known plaintext string encrypted and stored on first
 * initialization. On subsequent opens, it is decrypted and compared to
 * the expected value. A mismatch means the master key is wrong.
 */

import type Database from "better-sqlite3";
import type { SecretsCrypto, EncryptedSecret } from "@comis/core";

/** Well-known canary row name -- excluded from list/decryptAll operations. */
export const CANARY_NAME = "__comis_canary__";

/** Canary plaintext value used for master key validation. */
const CANARY_PLAINTEXT = "comis-secrets-canary-v1";

/**
 * Create the `secrets` table if it does not already exist.
 *
 * The table stores encrypted secret components as BLOB columns alongside
 * metadata for auditing and lifecycle management. Safe to call multiple
 * times (idempotent via CREATE TABLE IF NOT EXISTS).
 *
 * Must be called before `validateCanary()`.
 *
 * @param db - An open better-sqlite3 Database instance
 */
export function initSecretSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      salt BLOB NOT NULL,
      provider TEXT,
      description TEXT,
      expires_at INTEGER,
      last_used_at INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/**
 * Validate the master key by encrypting/decrypting a canary entry.
 *
 * On first call (no canary row): encrypts a known plaintext and stores it.
 * On subsequent calls: decrypts the stored canary and verifies the value.
 *
 * Throws an Error containing "DECRYPTION_FAILED" if the master key does
 * not match the one used to create the canary -- this prevents silent
 * data corruption from attempting to decrypt secrets with the wrong key.
 *
 * @param db - Database with the `secrets` table already created
 * @param crypto - SecretsCrypto instance bound to the current master key
 * @throws Error with "DECRYPTION_FAILED" if master key mismatch detected
 */
export function validateCanary(db: Database.Database, crypto: SecretsCrypto): void {
  const row = db
    .prepare(
      "SELECT ciphertext, iv, auth_tag, salt FROM secrets WHERE name = ?",
    )
    .get(CANARY_NAME) as
    | { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; salt: Buffer }
    | undefined;

  if (!row) {
    // First initialization: encrypt and store the canary
    const result = crypto.encrypt(CANARY_PLAINTEXT);
    if (!result.ok) {
      throw new Error(
        `Failed to encrypt canary: ${result.error.message}`,
      );
    }
    const encrypted = result.value;
    const now = Date.now();

    db.prepare(
      `INSERT INTO secrets (name, ciphertext, iv, auth_tag, salt, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      CANARY_NAME,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.authTag,
      encrypted.salt,
      now,
      now,
    );
    return;
  }

  // Existing canary: reconstruct EncryptedSecret and decrypt
  const encrypted: EncryptedSecret = {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.auth_tag,
    salt: row.salt,
  };

  const decryptResult = crypto.decrypt(encrypted);

  if (!decryptResult.ok) {
    throw new Error(
      "DECRYPTION_FAILED: Master key does not match the one used to create this secret store",
    );
  }

  if (decryptResult.value !== CANARY_PLAINTEXT) {
    throw new Error(
      "DECRYPTION_FAILED: Canary value mismatch -- store may be corrupted",
    );
  }

  // Success: master key matches, canary validated
}
