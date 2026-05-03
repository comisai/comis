// SPDX-License-Identifier: Apache-2.0
/**
 * RED baseline (Phase 7 SPEC R3) — encrypted SQLite adapter tests for
 * `OAuthCredentialStorePort`.
 *
 * The source modules do not yet exist:
 *   - `./oauth-profile-store-encrypted.js`  (plan 06)
 *   - `./oauth-profile-schema.js`            (plan 06)
 *
 * The file is committed FAILING-TO-COMPILE on purpose. Plan 06 turns
 * these tests green.
 *
 * Coverage groups:
 *   1. Schema + factory
 *   2. Round-trip encryption (CRUD)
 *   3. Plaintext NOT on disk (T-OAUTH-DISK-EXFIL mitigation)
 *   4. Denormalized expires_at stays in sync (RESEARCH §4 landmine #8)
 *   5. Restart-survives-set
 *   6. Profile-ID validation passthrough
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type { Result } from "@comis/shared";
import type { OAuthProfile, SecretsCrypto } from "@comis/core";
import { createSecretsCrypto } from "@comis/core";
import { initSecretSchema } from "./secret-store-schema.js";
import { createSqliteSecretStore } from "./sqlite-secret-store.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { createOAuthProfileStoreEncrypted } from "./oauth-profile-store-encrypted.js";
import { initOAuthProfileSchema } from "./oauth-profile-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap a Result or fail the test with a useful message. */
function unwrap<T>(result: Result<T, Error>): T {
  if (!result.ok) {
    throw new Error(`Expected ok result, got error: ${result.error.message}`);
  }
  return result.value;
}

function makeCrypto(): SecretsCrypto {
  return createSecretsCrypto(randomBytes(32));
}

function makeProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:user_a@example.com",
    access: "access-token-xyz",
    refresh: "refresh-token-abc",
    expires: Date.now() + 3600_000,
    version: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory SQLite for groups 1, 2, 4, 6 (schema/CRUD/denorm/validation)
// ---------------------------------------------------------------------------

describe("createOAuthProfileStoreEncrypted", () => {
  // -------------------------------------------------------------------------
  // Group 1 — Schema + factory
  // -------------------------------------------------------------------------

  describe("schema + factory", () => {
    let db: Database.Database;

    beforeEach(() => {
      db = new Database(":memory:");
      initSecretSchema(db);
    });

    afterEach(() => {
      db.close();
    });

    // Test 1.1
    it("initOAuthProfileSchema is idempotent", () => {
      expect(() => {
        initOAuthProfileSchema(db);
        initOAuthProfileSchema(db);
      }).not.toThrow();
    });

    // Test 1.2
    it("initOAuthProfileSchema creates the oauth_profiles table", () => {
      initOAuthProfileSchema(db);
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_profiles'")
        .get() as { name: string } | undefined;
      expect(row).toEqual({ name: "oauth_profiles" });
    });

    // Test 1.3
    it("initOAuthProfileSchema creates idx_oauth_profiles_provider", () => {
      initOAuthProfileSchema(db);
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_oauth_profiles_provider'",
        )
        .get() as { name: string } | undefined;
      expect(row).toEqual({ name: "idx_oauth_profiles_provider" });
    });

    // Test 1.4
    it("createOAuthProfileStoreEncrypted returns a frozen object", () => {
      initOAuthProfileSchema(db);
      const store = createOAuthProfileStoreEncrypted(db, makeCrypto());
      expect(Object.isFrozen(store)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Group 2 — Round-trip encryption (CRUD)
  // -------------------------------------------------------------------------

  describe("round-trip encryption (CRUD)", () => {
    let db: Database.Database;
    let crypto: SecretsCrypto;

    beforeEach(() => {
      db = new Database(":memory:");
      initSecretSchema(db);
      initOAuthProfileSchema(db);
      crypto = makeCrypto();
    });

    afterEach(() => {
      db.close();
    });

    // Test 2.1
    it("set + get returns the same profile (deep-equal)", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const profile = makeProfile();
      unwrap(await store.set("openai-codex:user_a@example.com", profile));
      const loaded = unwrap(await store.get("openai-codex:user_a@example.com"));
      expect(loaded).toEqual(profile);
    });

    // Test 2.2
    it("get(unknownId) returns ok(undefined)", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const result = unwrap(await store.get("openai-codex:nonexistent@example.com"));
      expect(result).toBeUndefined();
    });

    // Test 2.3
    it("re-set overwrites (UPSERT semantics)", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile({ access: "v1" })));
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile({ access: "v2" })));
      const loaded = unwrap(await store.get("openai-codex:user_a@example.com"));
      expect(loaded?.access).toBe("v2");
    });

    // Test 2.4
    it("list returns all and list({ provider }) filters", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      unwrap(
        await store.set(
          "anthropic:user_b@example.com",
          makeProfile({
            provider: "anthropic",
            profileId: "anthropic:user_b@example.com",
          }),
        ),
      );
      const all = unwrap(await store.list());
      expect(all).toHaveLength(2);
      const onlyCodex = unwrap(await store.list({ provider: "openai-codex" }));
      expect(onlyCodex).toHaveLength(1);
    });

    // Test 2.5
    it("delete returns ok(true) when present, ok(false) when not", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const removed = unwrap(await store.delete("openai-codex:user_a@example.com"));
      expect(removed).toBe(true);
      const removedAgain = unwrap(await store.delete("openai-codex:user_a@example.com"));
      expect(removedAgain).toBe(false);
    });

    // Test 2.6
    it("has reflects set/delete state correctly", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const before = unwrap(await store.has("openai-codex:user_a@example.com"));
      expect(before).toBe(false);
      unwrap(await store.set("openai-codex:user_a@example.com", makeProfile()));
      const afterSet = unwrap(await store.has("openai-codex:user_a@example.com"));
      expect(afterSet).toBe(true);
      unwrap(await store.delete("openai-codex:user_a@example.com"));
      const afterDelete = unwrap(await store.has("openai-codex:user_a@example.com"));
      expect(afterDelete).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Group 3 — Plaintext NOT on disk (T-OAUTH-DISK-EXFIL mitigation)
  // -------------------------------------------------------------------------

  describe("plaintext NOT on disk (T-OAUTH-DISK-EXFIL)", () => {
    let tmp: string;
    let dbPath: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-encrypted-"));
      dbPath = path.join(tmp, "secrets.db");
    });

    afterEach(() => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    // Test 3.1 — access token canary
    it("PLAINTEXT_CANARY_TOKEN_ access-token substring is NOT present in raw DB file", async () => {
      const crypto = makeCrypto();
      const db = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      // Bind canary via SqliteSecretStore so the secrets table is initialized.
      createSqliteSecretStore(dbPath, crypto);
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const profile = makeProfile({ access: "PLAINTEXT_CANARY_TOKEN_8f3d2a1c" });
      unwrap(await store.set("openai-codex:user_a@example.com", profile));
      db.close();

      const raw = fs.readFileSync(dbPath);
      expect(raw.indexOf(Buffer.from("PLAINTEXT_CANARY_TOKEN_8f3d2a1c"))).toBe(-1);
    });

    // Test 3.2 — refresh token canary
    it("PLAINTEXT_REFRESH_CANARY_ refresh-token substring is NOT present in raw DB file", async () => {
      const crypto = makeCrypto();
      const db = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      createSqliteSecretStore(dbPath, crypto);
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const profile = makeProfile({ refresh: "PLAINTEXT_REFRESH_CANARY_a1b2c3d4" });
      unwrap(await store.set("openai-codex:user_a@example.com", profile));
      db.close();

      const raw = fs.readFileSync(dbPath);
      expect(raw.indexOf(Buffer.from("PLAINTEXT_REFRESH_CANARY_a1b2c3d4"))).toBe(-1);
    });

    // Test 3.3 — email canary
    it("EMAIL_PLAINTEXT_CANARY_ email substring is NOT present in raw DB file", async () => {
      const crypto = makeCrypto();
      const db = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      createSqliteSecretStore(dbPath, crypto);
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const profile = makeProfile({
        email: "EMAIL_PLAINTEXT_CANARY_q9r8s7t6@example.invalid",
      });
      unwrap(await store.set("openai-codex:user_a@example.com", profile));
      db.close();

      const raw = fs.readFileSync(dbPath);
      expect(raw.indexOf(Buffer.from("EMAIL_PLAINTEXT_CANARY_q9r8s7t6@example.invalid"))).toBe(-1);
    });
  });

  // -------------------------------------------------------------------------
  // Group 4 — Denormalized expires_at stays in sync (RESEARCH §4 landmine #8)
  // -------------------------------------------------------------------------

  describe("denormalized expires_at stays in sync", () => {
    let db: Database.Database;
    let crypto: SecretsCrypto;

    beforeEach(() => {
      db = new Database(":memory:");
      initSecretSchema(db);
      initOAuthProfileSchema(db);
      crypto = makeCrypto();
    });

    afterEach(() => {
      db.close();
    });

    // Test 4.1
    it("after set, raw expires_at column matches the profile's expires field", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      unwrap(
        await store.set(
          "openai-codex:user_a@example.com",
          makeProfile({ expires: 1714680000_000 }),
        ),
      );
      const row = db
        .prepare("SELECT expires_at FROM oauth_profiles WHERE profile_id = ?")
        .get("openai-codex:user_a@example.com") as { expires_at: number } | undefined;
      expect(row?.expires_at).toBe(1714680000_000);
    });

    // Test 4.2
    it("after re-set with a different expires, the raw column updates (not stale)", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      unwrap(
        await store.set(
          "openai-codex:user_a@example.com",
          makeProfile({ expires: 1714680000_000 }),
        ),
      );
      unwrap(
        await store.set(
          "openai-codex:user_a@example.com",
          makeProfile({ expires: 1900000000_000 }),
        ),
      );
      const row = db
        .prepare("SELECT expires_at FROM oauth_profiles WHERE profile_id = ?")
        .get("openai-codex:user_a@example.com") as { expires_at: number } | undefined;
      expect(row?.expires_at).toBe(1900000000_000);
    });

    // Test 4.3
    it("provider index supports SELECT WHERE provider AND expires_at < ? without decryption", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      unwrap(
        await store.set(
          "openai-codex:user_a@example.com",
          makeProfile({ expires: 1700000000_000 }),
        ),
      );
      unwrap(
        await store.set(
          "openai-codex:user_b@example.com",
          makeProfile({
            profileId: "openai-codex:user_b@example.com",
            expires: 2_000_000_000_000,
          }),
        ),
      );
      const cutoff = 1800000000_000;
      const rows = db
        .prepare(
          "SELECT profile_id FROM oauth_profiles WHERE provider = ? AND expires_at < ?",
        )
        .all("openai-codex", cutoff) as Array<{ profile_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].profile_id).toBe("openai-codex:user_a@example.com");
    });
  });

  // -------------------------------------------------------------------------
  // Group 5 — Restart-survives-set (SPEC R3 acceptance)
  // -------------------------------------------------------------------------

  describe("restart-survives-set", () => {
    let tmp: string;
    let dbPath: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-restart-"));
      dbPath = path.join(tmp, "secrets.db");
    });

    afterEach(() => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    // Test 5.1
    it("write in instance 1, close DB, reopen + read in instance 2 (same crypto) returns identical profile", async () => {
      const crypto = makeCrypto();
      const db1 = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      const store1 = createOAuthProfileStoreEncrypted(db1, crypto);
      const profile = makeProfile({ access: "persisted-access-xyz" });
      unwrap(await store1.set("openai-codex:user_a@example.com", profile));
      db1.close();

      const db2 = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      const store2 = createOAuthProfileStoreEncrypted(db2, crypto);
      const loaded = unwrap(await store2.get("openai-codex:user_a@example.com"));
      db2.close();
      expect(loaded).toEqual(profile);
    });

    // Test 5.2 — different crypto (new master key) → decryption fails
    it("reopen with a DIFFERENT crypto returns err (decryption fails / auth-tag mismatch)", async () => {
      const crypto1 = makeCrypto();
      const db1 = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      const store1 = createOAuthProfileStoreEncrypted(db1, crypto1);
      unwrap(await store1.set("openai-codex:user_a@example.com", makeProfile()));
      db1.close();

      const crypto2 = makeCrypto(); // different master key
      const db2 = openSqliteDatabase({
        dbPath,
        initSchema: (d) => {
          initSecretSchema(d);
          initOAuthProfileSchema(d);
        },
      });
      const store2 = createOAuthProfileStoreEncrypted(db2, crypto2);
      const result = await store2.get("openai-codex:user_a@example.com");
      db2.close();
      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Group 6 — Profile-ID validation passthrough
  // -------------------------------------------------------------------------

  describe("profile-ID validation passthrough", () => {
    let db: Database.Database;
    let crypto: SecretsCrypto;

    beforeEach(() => {
      db = new Database(":memory:");
      initSecretSchema(db);
      initOAuthProfileSchema(db);
      crypto = makeCrypto();
    });

    afterEach(() => {
      db.close();
    });

    // Test 6.1
    it("set('invalid-no-colon', profile) returns err with 'Invalid profile ID'", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const result = await store.set(
        "invalid-no-colon",
        makeProfile({ profileId: "invalid-no-colon" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Invalid profile ID");
    });

    // Test 6.2
    it("get('invalid-no-colon') returns err with 'Invalid profile ID'", async () => {
      const store = createOAuthProfileStoreEncrypted(db, crypto);
      const result = await store.get("invalid-no-colon");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Invalid profile ID");
    });
  });
});
