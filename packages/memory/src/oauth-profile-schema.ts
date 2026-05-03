// SPDX-License-Identifier: Apache-2.0
import type Database from "better-sqlite3";

/**
 * Create the oauth_profiles table and supporting index.
 *
 * Schema per CONTEXT.md D-03. Single ciphertext+iv+auth_tag+salt per row
 * (D-04: entire OAuthProfile JSON encrypted as one blob — no half-rotated
 * state).
 *
 * Denormalized expires_at column lets Phase 10 doctor query expiring
 * profiles via SELECT profile_id FROM oauth_profiles WHERE provider = ?
 * AND expires_at < ? without decrypting any blob (D-03 rationale).
 *
 * No FK to secrets table — OAuth profiles are independent from named
 * secrets. Index on provider supports list({ provider }) filtering.
 *
 * Idempotent via IF NOT EXISTS — safe to call multiple times.
 */
export function initOAuthProfileSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_profiles (
      profile_id              TEXT PRIMARY KEY,
      provider                TEXT NOT NULL,
      identity                TEXT NOT NULL,
      credentials_ciphertext  BLOB NOT NULL,
      credentials_iv          BLOB NOT NULL,
      credentials_auth_tag    BLOB NOT NULL,
      credentials_salt        BLOB NOT NULL,
      expires_at              INTEGER NOT NULL,
      version                 INTEGER NOT NULL DEFAULT 1,
      created_at              INTEGER NOT NULL,
      updated_at              INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_profiles_provider ON oauth_profiles(provider);
  `);
}
