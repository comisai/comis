// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for offline-secrets-write helpers.
 *
 * These tests exercise the daemon-free encrypted-store write path used by
 * `comis secrets set/import/list` when the daemon is not running.
 *
 * Uses a real temporary directory + real AES-256-GCM crypto to ensure
 * the round-trip (write → read) is correct without any mocking.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { generateMasterKey } from "@comis/core";
import { offlineSecretGet, offlineSecretSet, offlineSecretsList } from "./offline-secrets-write.js";
import { setupSecrets } from "./setup-secrets.js";
import { createSqliteSecretStore } from "./sqlite-secret-store.js";

// ---------------------------------------------------------------------------
// Test directory lifecycle
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function makeTmpDir(): { dataDir: string; envFilePath: string } {
  const id = crypto.randomUUID();
  const dataDir = path.join(os.tmpdir(), `comis-offline-test-${id}`);
  fs.mkdirSync(dataDir, { recursive: true });
  createdDirs.push(dataDir);
  return { dataDir, envFilePath: path.join(dataDir, ".env") };
}

afterEach(() => {
  // Clean up all tmp dirs created in this test file
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

describe("offlineSecretSet", () => {
  it("returns err with actionable hint when SECRETS_MASTER_KEY is absent in env and .env file", async () => {
    const { dataDir, envFilePath } = makeTmpDir();
    // no .env file written → no SECRETS_MASTER_KEY anywhere

    const result = offlineSecretSet({
      name: "TELEGRAM_BOT_TOKEN",
      value: "test-token-value",
      dataDir,
      envFilePath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/SECRETS_MASTER_KEY.*absent/i);
      expect(result.error.message).toMatch(/comis secrets init/i);
    }
  });

  it("stores an encrypted secret to secrets.db without a running daemon", async () => {
    const { dataDir, envFilePath } = makeTmpDir();

    // Write a real master key into the .env file
    const masterKey = generateMasterKey();
    fs.writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, {
      mode: 0o600,
    });

    const result = offlineSecretSet({
      name: "TELEGRAM_BOT_TOKEN",
      value: "real-encrypted-value",
      dataDir,
      envFilePath,
    });

    expect(result.ok).toBe(true);

    // Open the store directly and verify round-trip
    const env: Record<string, string | undefined> = {
      SECRETS_MASTER_KEY: masterKey,
    };
    const setupResult = setupSecrets({ env, dataDir });
    expect(setupResult.ok).toBe(true);
    if (!setupResult.ok || setupResult.value === null) {
      throw new Error("setupSecrets returned null/err unexpectedly");
    }
    const { crypto: secretsCrypto, dbPath } = setupResult.value;
    const store = createSqliteSecretStore(dbPath, secretsCrypto);
    try {
      const getResult = store.getDecrypted("TELEGRAM_BOT_TOKEN");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe("real-encrypted-value");
      }
    } finally {
      store.close();
    }
  });

  it("is idempotent: calling twice with same name overwrites value", async () => {
    const { dataDir, envFilePath } = makeTmpDir();

    const masterKey = generateMasterKey();
    fs.writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, {
      mode: 0o600,
    });

    const first = offlineSecretSet({
      name: "OPENAI_API_KEY",
      value: "first-value",
      dataDir,
      envFilePath,
    });
    expect(first.ok).toBe(true);

    const second = offlineSecretSet({
      name: "OPENAI_API_KEY",
      value: "second-value",
      dataDir,
      envFilePath,
    });
    expect(second.ok).toBe(true);

    // Retrieve and expect second value
    const env: Record<string, string | undefined> = {
      SECRETS_MASTER_KEY: masterKey,
    };
    const setupResult = setupSecrets({ env, dataDir });
    expect(setupResult.ok).toBe(true);
    if (!setupResult.ok || setupResult.value === null) {
      throw new Error("setupSecrets returned null/err unexpectedly");
    }
    const { crypto: secretsCrypto, dbPath } = setupResult.value;
    const store = createSqliteSecretStore(dbPath, secretsCrypto);
    try {
      const getResult = store.getDecrypted("OPENAI_API_KEY");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).toBe("second-value");
      }
    } finally {
      store.close();
    }
  });
});

describe("offlineSecretsList", () => {
  it("returns metadata for secrets stored via offlineSecretSet", async () => {
    const { dataDir, envFilePath } = makeTmpDir();

    const masterKey = generateMasterKey();
    fs.writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, {
      mode: 0o600,
    });

    // Store two secrets
    const r1 = offlineSecretSet({
      name: "TELEGRAM_BOT_TOKEN",
      value: "tok-1",
      dataDir,
      envFilePath,
    });
    expect(r1.ok).toBe(true);

    const r2 = offlineSecretSet({
      name: "OPENAI_API_KEY",
      value: "sk-1",
      dataDir,
      envFilePath,
    });
    expect(r2.ok).toBe(true);

    const listResult = offlineSecretsList({ dataDir, envFilePath });
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const names = listResult.value.map((s) => s.name);
      expect(names).toContain("TELEGRAM_BOT_TOKEN");
      expect(names).toContain("OPENAI_API_KEY");
      // All entries must have a createdAt timestamp
      for (const entry of listResult.value) {
        expect(typeof entry.createdAt).toBe("number");
        expect(entry.createdAt).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// offlineSecretGet — the daemon-free read that breaks the gateway-token
// chicken-and-egg (`secrets get COMIS_GATEWAY_TOKEN` needed the daemon RPC,
// which needed the token).
// ---------------------------------------------------------------------------

describe("offlineSecretGet", () => {
  it("round-trips a value written by offlineSecretSet without a daemon", () => {
    const { dataDir, envFilePath } = makeTmpDir();
    const masterKey = generateMasterKey();
    fs.writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });

    const setResult = offlineSecretSet({ name: "GATEWAY_TOKEN_TEST", value: "test-key", dataDir, envFilePath });
    expect(setResult.ok).toBe(true);

    const got = offlineSecretGet({ name: "GATEWAY_TOKEN_TEST", dataDir, envFilePath });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBe("test-key");
  });

  it("returns ok(undefined) for a name that is not in the store", () => {
    const { dataDir, envFilePath } = makeTmpDir();
    const masterKey = generateMasterKey();
    fs.writeFileSync(envFilePath, `SECRETS_MASTER_KEY=${masterKey}\n`, { mode: 0o600 });
    // Seed the store so the db exists.
    offlineSecretSet({ name: "OTHER", value: "test-key", dataDir, envFilePath });

    const got = offlineSecretGet({ name: "MISSING_NAME", dataDir, envFilePath });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toBeUndefined();
  });

  it("errs with the init guidance when SECRETS_MASTER_KEY is absent", () => {
    const { dataDir, envFilePath } = makeTmpDir();
    fs.writeFileSync(envFilePath, "", { mode: 0o600 });

    const got = offlineSecretGet({ name: "ANYTHING", dataDir, envFilePath });
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.message).toContain("SECRETS_MASTER_KEY");
  });
});
