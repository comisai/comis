// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the offline-oauth-write helper.
 *
 * Exercises the daemon-free encrypted-store write path used by `comis init`
 * (and `comis auth login` offline) to seal OAuth profiles into secrets.db
 * when the daemon is not running.
 *
 * Uses a real temporary directory + real AES-256-GCM crypto to ensure the
 * round-trip (write → read) is correct without any mocking — mirrors
 * offline-secrets-write.test.ts.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { generateMasterKey } from "@comis/core";
import type { OAuthProfile } from "@comis/core";
import { offlineOAuthProfileSet } from "./offline-oauth-write.js";
import { setupSecrets } from "./setup-secrets.js";
import { openSqliteDatabase } from "./sqlite-adapter-base.js";
import { createOAuthProfileStoreEncrypted } from "./oauth-profile-store-encrypted.js";

// ---------------------------------------------------------------------------
// Test directory lifecycle
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function makeTmpDir(): { dataDir: string; envFilePath: string } {
  const id = crypto.randomUUID();
  const dataDir = path.join(os.tmpdir(), `comis-offline-oauth-test-${id}`);
  fs.mkdirSync(dataDir, { recursive: true });
  createdDirs.push(dataDir);
  return { dataDir, envFilePath: path.join(dataDir, ".env") };
}

function sampleProfile(): OAuthProfile {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:test@example.com",
    access: "acc_tok",
    refresh: "ref_tok",
    expires: Date.now() + 3_600_000,
    accountId: "acct_1",
    email: "test@example.com",
    displayName: "Test User",
    version: 1,
  };
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("offlineOAuthProfileSet", () => {
  it("returns err with actionable hint when SECRETS_MASTER_KEY is absent", async () => {
    const { dataDir, envFilePath } = makeTmpDir();
    // no .env file written → no SECRETS_MASTER_KEY anywhere

    const result = await offlineOAuthProfileSet({
      profile: sampleProfile(),
      dataDir,
      envFilePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/SECRETS_MASTER_KEY.*absent/i);
      expect(result.error.message).toMatch(/comis secrets init/i);
    }
  });

  it("seals an OAuth profile into encrypted secrets.db without a running daemon (round-trip)", async () => {
    const { dataDir, envFilePath } = makeTmpDir();

    // Write a real master key into the .env file.
    const masterKey = generateMasterKey();
    fs.writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, {
      mode: 0o600,
    });

    const profile = sampleProfile();
    const result = await offlineOAuthProfileSet({ profile, dataDir, envFilePath });
    expect(result.ok).toBe(true);

    // Open the encrypted OAuth store directly and verify the round-trip.
    const env: Record<string, string | undefined> = {
      SECRETS_MASTER_KEY: masterKey,
    };
    const setupResult = setupSecrets({ env, dataDir });
    expect(setupResult.ok).toBe(true);
    if (!setupResult.ok || setupResult.value === null) {
      throw new Error("setupSecrets returned null/err unexpectedly");
    }
    const { crypto: secretsCrypto, dbPath } = setupResult.value;
    const db = openSqliteDatabase({ dbPath });
    try {
      const store = createOAuthProfileStoreEncrypted(db, secretsCrypto);
      const got = await store.get(profile.profileId);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.value).toBeDefined();
        expect(got.value).toMatchObject({
          provider: profile.provider,
          profileId: profile.profileId,
          access: profile.access,
          refresh: profile.refresh,
          expires: profile.expires,
          accountId: profile.accountId,
          email: profile.email,
          displayName: profile.displayName,
          version: 1,
        });
      }
    } finally {
      db.close();
    }
  });
});
