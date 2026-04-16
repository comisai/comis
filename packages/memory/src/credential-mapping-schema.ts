/**
 * Credential mapping SQLite schema DDL.
 *
 * Creates the `credential_mappings` table that stores credential-to-injection
 * bindings. The table has a foreign key to `secrets(name)` with ON DELETE CASCADE
 * so that deleting a secret automatically removes its credential mappings.
 *
 * IMPORTANT: The `secrets` table must exist before calling `initCredentialMappingSchema`.
 * The caller (createCredentialMappingStore or bootstrap) must ensure `initSecretSchema()`
 * has been called first.
 */

import type Database from "better-sqlite3";

/**
 * Create the `credential_mappings` table if it does not already exist.
 *
 * Includes:
 * - CHECK constraint on injection_type (four valid values)
 * - Foreign key to secrets(name) with ON DELETE CASCADE
 * - Indexes on secret_name and tool_name for efficient lookups
 *
 * Safe to call multiple times (idempotent via IF NOT EXISTS).
 *
 * @param db - An open better-sqlite3 Database instance (with secrets table already created)
 */
export function initCredentialMappingSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credential_mappings (
      id              TEXT PRIMARY KEY,
      secret_name     TEXT NOT NULL REFERENCES secrets(name) ON DELETE CASCADE,
      injection_type  TEXT NOT NULL CHECK(injection_type IN (
        'bearer_header', 'custom_header', 'query_param', 'basic_auth'
      )),
      injection_key   TEXT,
      url_pattern     TEXT NOT NULL,
      tool_name       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cred_map_secret ON credential_mappings(secret_name);
    CREATE INDEX IF NOT EXISTS idx_cred_map_tool ON credential_mappings(tool_name);
  `);
}
