// SPDX-License-Identifier: Apache-2.0
/**
 * Encrypted SQLite-backed OAuthCredentialStorePort adapter.
 *
 * Mirrors credential-mapping-store's factory pattern (takes a pre-opened
 * Database instance, does NOT open its own). The lifecycle is owned by
 * the caller — we share the existing secrets.db connection to keep all
 * encrypted-at-rest data in one DB file (D-03).
 *
 * Per D-04, the entire OAuthProfile JSON payload is encrypted as one
 * AES-256-GCM blob per row. One ciphertext+iv+authTag+salt set per profile.
 * Atomic update — no half-rotated state where access changes but refresh
 * doesn't.
 *
 * Denormalized expires_at column stays in sync on every write (RESEARCH
 * landmine 8) so Phase 10 doctor can query expiring profiles without
 * decrypting any blob.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import { ok, err, fromPromise } from "@comis/shared";
import type { OAuthCredentialStorePort, OAuthProfile, SecretsCrypto } from "@comis/core";
import { validateProfileId } from "@comis/core";
import { initOAuthProfileSchema } from "./oauth-profile-schema.js";

const SCHEMA_VERSION = 1;

interface OAuthProfileRow {
  profile_id: string;
  provider: string;
  identity: string;
  credentials_ciphertext: Buffer;
  credentials_iv: Buffer;
  credentials_auth_tag: Buffer;
  credentials_salt: Buffer;
  expires_at: number;
  version: number;
  created_at: number;
  updated_at: number;
}

/**
 * Create an encrypted OAuthCredentialStorePort backed by a shared SQLite DB.
 *
 * The adapter does NOT own the db lifecycle — the caller supplies an
 * already-open Database (typically the secrets.db chain). Initializes its
 * own oauth_profiles table via initOAuthProfileSchema (idempotent).
 */
export function createOAuthProfileStoreEncrypted(
  db: Database.Database,
  crypto: SecretsCrypto,
): OAuthCredentialStorePort {
  initOAuthProfileSchema(db);

  const upsertStmt = db.prepare(`
    INSERT INTO oauth_profiles (
      profile_id, provider, identity,
      credentials_ciphertext, credentials_iv, credentials_auth_tag, credentials_salt,
      expires_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET
      provider = excluded.provider,
      identity = excluded.identity,
      credentials_ciphertext = excluded.credentials_ciphertext,
      credentials_iv = excluded.credentials_iv,
      credentials_auth_tag = excluded.credentials_auth_tag,
      credentials_salt = excluded.credentials_salt,
      expires_at = excluded.expires_at,
      version = excluded.version,
      updated_at = excluded.updated_at
  `);
  const getStmt = db.prepare("SELECT * FROM oauth_profiles WHERE profile_id = ?");
  const deleteStmt = db.prepare("DELETE FROM oauth_profiles WHERE profile_id = ?");
  const listAllStmt = db.prepare("SELECT * FROM oauth_profiles");
  const listByProviderStmt = db.prepare("SELECT * FROM oauth_profiles WHERE provider = ?");
  const existsStmt = db.prepare("SELECT 1 FROM oauth_profiles WHERE profile_id = ?");

  function rowToProfile(row: OAuthProfileRow): Result<OAuthProfile, Error> {
    if (row.version !== SCHEMA_VERSION) {
      return err(
        new Error(
          "OAuth profile store version mismatch: expected " +
            SCHEMA_VERSION +
            ", got " +
            String(row.version) +
            ". Hint: drop the oauth_profiles table and re-run `comis auth login` to recreate. Stored profiles for unknown schema versions cannot be migrated.",
        ),
      );
    }
    const decryptResult = crypto.decrypt({
      ciphertext: row.credentials_ciphertext,
      iv: row.credentials_iv,
      authTag: row.credentials_auth_tag,
      salt: row.credentials_salt,
    });
    if (!decryptResult.ok) return err(decryptResult.error);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decryptResult.value);
    } catch (e) {
      return err(new Error("OAuth profile decryption produced invalid JSON: " + String(e)));
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return err(new Error("OAuth profile decryption produced non-object payload"));
    }
    return ok(parsed as OAuthProfile);
  }

  const port: OAuthCredentialStorePort = {
    async get(profileId: string): Promise<Result<OAuthProfile | undefined, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      return fromPromise(
        (async () => {
          const row = getStmt.get(profileId) as OAuthProfileRow | undefined;
          if (!row) return undefined;
          const r = rowToProfile(row);
          if (!r.ok) throw r.error;
          return r.value;
        })(),
      );
    },

    async set(profileId: string, profile: OAuthProfile): Promise<Result<void, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      const fullProfile: OAuthProfile = { ...profile, profileId, version: SCHEMA_VERSION };
      const payload = JSON.stringify(fullProfile);
      const encryptResult = crypto.encrypt(payload);
      if (!encryptResult.ok) return err(encryptResult.error);
      const enc = encryptResult.value;
      const now = Date.now();
      return fromPromise(
        (async () => {
          upsertStmt.run(
            profileId,
            validation.value.provider,
            validation.value.identity,
            enc.ciphertext,
            enc.iv,
            enc.authTag,
            enc.salt,
            fullProfile.expires,
            SCHEMA_VERSION,
            now,
            now,
          );
        })(),
      );
    },

    async delete(profileId: string): Promise<Result<boolean, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      return fromPromise(
        (async () => {
          const result = deleteStmt.run(profileId);
          return result.changes > 0;
        })(),
      );
    },

    async list(filter?: { provider?: string }): Promise<Result<OAuthProfile[], Error>> {
      return fromPromise(
        (async () => {
          const rows = filter?.provider
            ? (listByProviderStmt.all(filter.provider) as OAuthProfileRow[])
            : (listAllStmt.all() as OAuthProfileRow[]);
          const profiles: OAuthProfile[] = [];
          for (const row of rows) {
            const r = rowToProfile(row);
            if (!r.ok) throw r.error;
            profiles.push(r.value);
          }
          return profiles;
        })(),
      );
    },

    async has(profileId: string): Promise<Result<boolean, Error>> {
      const validation = validateProfileId(profileId);
      if (!validation.ok) return err(validation.error);
      return fromPromise((async () => existsStmt.get(profileId) !== undefined)());
    },
  };
  return Object.freeze(port);
}
