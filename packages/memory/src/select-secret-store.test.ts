// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for selectSecretStore — discriminated SecretStore factory.
 *
 * Covers: file-mode dispatch, env-mode dispatch (read-only adapter),
 * encrypted-mode dispatch (setupSecrets delegation), and all env-mode
 * adapter behaviors (set/delete rejection, name-scoped list/decryptAll,
 * getDecrypted, close no-op).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { selectSecretStore } from "./select-secret-store.js";
import type { SelectedSecretStore } from "./select-secret-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const base = os.tmpdir();
  const name = `comis-select-secret-store-${randomBytes(8).toString("hex")}`;
  return path.join(base, name);
}

function unwrapOk<T>(result: { ok: boolean; value?: T; error?: Error }): T {
  if (!result.ok) {
    throw new Error(
      `Expected ok result, got error: ${String(result.error?.message ?? "unknown")}`,
    );
  }
  return result.value as T;
}

// ---------------------------------------------------------------------------
// file mode dispatch
// ---------------------------------------------------------------------------

describe("selectSecretStore — file mode", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("selectSecretStore with mode file returns ok with kind file", () => {
    const result = selectSecretStore({
      mode: "file",
      dataDir,
      env: {},
    });

    expect(result.ok).toBe(true);
    const selected = unwrapOk(result);
    expect(selected.kind).toBe("file");
  });

  it("selectSecretStore file mode returns a working SecretStorePort adapter", () => {
    const result = selectSecretStore({
      mode: "file",
      dataDir,
      env: {},
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "file" }>;
    expect(selected.secretStore).toBeDefined();

    // Basic round-trip via the returned adapter
    const setResult = selected.secretStore.set("FILE_KEY", "file_value");
    expect(setResult.ok).toBe(true);

    const getResult = selected.secretStore.getDecrypted("FILE_KEY");
    expect(getResult.ok).toBe(true);
    expect(getResult.ok && getResult.value).toBe("file_value");
  });
});

// ---------------------------------------------------------------------------
// env mode dispatch + read-only adapter behaviors
// ---------------------------------------------------------------------------

describe("selectSecretStore — env mode", () => {
  it("selectSecretStore with mode env returns ok with kind env", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused-env-mode",
      env: { MY_SECRET: "secret_value" },
      sensitiveNames: new Set(["MY_SECRET"]),
    });

    expect(result.ok).toBe(true);
    const selected = unwrapOk(result);
    expect(selected.kind).toBe("env");
  });

  it("env-mode set returns err containing 'read-only' and 'security.storage'", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: {},
      sensitiveNames: new Set(),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const setResult = selected.secretStore.set("ANY_KEY", "any_value");

    expect(setResult.ok).toBe(false);
    expect(!setResult.ok && setResult.error.message).toContain("read-only");
    expect(!setResult.ok && setResult.error.message).toContain("security.storage");
  });

  it("env-mode delete returns err containing 'read-only'", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: {},
      sensitiveNames: new Set(),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const deleteResult = selected.secretStore.delete("ANY_KEY");

    expect(deleteResult.ok).toBe(false);
    expect(!deleteResult.ok && deleteResult.error.message).toContain("read-only");
  });

  it("env-mode getDecrypted returns the snapshotted value for a sensitive name", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: { ANTHROPIC_API_KEY: "sk-test-12345", OTHER_VAR: "other_value" },
      sensitiveNames: new Set(["ANTHROPIC_API_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const getResult = selected.secretStore.getDecrypted("ANTHROPIC_API_KEY");

    expect(getResult.ok).toBe(true);
    expect(getResult.ok && getResult.value).toBe("sk-test-12345");
  });

  it("env-mode getDecrypted returns undefined for name not in sensitiveNames", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: { PATH: "/usr/bin:/usr/local/bin", HOME: "/home/user" },
      sensitiveNames: new Set(["ANTHROPIC_API_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    // PATH is not in sensitiveNames — should not be accessible
    const pathResult = selected.secretStore.getDecrypted("PATH");
    expect(pathResult.ok).toBe(true);
    expect(pathResult.ok && pathResult.value).toBeUndefined();
  });

  it("env-mode list returns only names from sensitiveNames set that exist in snapshot", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: {
        ANTHROPIC_API_KEY: "sk-test-12345",
        TELEGRAM_BOT_TOKEN: "bot-token-xyz",
        PATH: "/usr/bin",
        HOME: "/home/user",
      },
      sensitiveNames: new Set(["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const listResult = selected.secretStore.list();

    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const names = listResult.value.map((m) => m.name);
    // Only names in both sensitiveNames AND env should appear
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(names).toContain("TELEGRAM_BOT_TOKEN");
    // OPENAI_API_KEY is in sensitiveNames but not in env — should not appear
    expect(names).not.toContain("OPENAI_API_KEY");
  });

  it("env-mode list does NOT include PATH or HOME (not in sensitiveNames set)", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: {
        PATH: "/usr/bin:/usr/local/bin",
        HOME: "/home/user",
        ANTHROPIC_API_KEY: "sk-test-key",
      },
      sensitiveNames: new Set(["ANTHROPIC_API_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const listResult = selected.secretStore.list();

    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const names = listResult.value.map((m) => m.name);
    expect(names).not.toContain("PATH");
    expect(names).not.toContain("HOME");
  });

  it("env-mode decryptAll returns only name-scoped entries from sensitiveNames", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: {
        ANTHROPIC_API_KEY: "sk-test-key",
        PATH: "/usr/bin",
        HOME: "/home/user",
        UNRELATED_VAR: "unrelated",
      },
      sensitiveNames: new Set(["ANTHROPIC_API_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const decryptAllResult = selected.secretStore.decryptAll();

    expect(decryptAllResult.ok).toBe(true);
    if (!decryptAllResult.ok) return;

    const map = decryptAllResult.value;
    expect(map).toBeInstanceOf(Map);
    expect(map.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(map.get("ANTHROPIC_API_KEY")).toBe("sk-test-key");
    // Must NOT include unscoped env vars
    expect(map.has("PATH")).toBe(false);
    expect(map.has("HOME")).toBe(false);
    expect(map.has("UNRELATED_VAR")).toBe(false);
  });

  it("env-mode close is a no-op and does not throw", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: { MY_KEY: "my_value" },
      sensitiveNames: new Set(["MY_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    expect(() => selected.secretStore.close()).not.toThrow();
  });

  it("env-mode list returns empty array when no sensitiveNames match snapshot", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: { PATH: "/usr/bin" },
      sensitiveNames: new Set(["ANTHROPIC_API_KEY"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const listResult = selected.secretStore.list();

    expect(listResult.ok).toBe(true);
    expect(listResult.ok && listResult.value).toHaveLength(0);
  });

  it("env-mode list does not include value field in SecretMetadata (residency invariant)", () => {
    const result = selectSecretStore({
      mode: "env",
      dataDir: "/tmp/unused",
      env: { MY_SECRET: "super_secret_value" },
      sensitiveNames: new Set(["MY_SECRET"]),
    });

    const selected = unwrapOk(result) as Extract<SelectedSecretStore, { kind: "env" }>;
    const listResult = selected.secretStore.list();

    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    for (const meta of listResult.value) {
      expect(Object.keys(meta)).not.toContain("value");
    }
  });
});

// ---------------------------------------------------------------------------
// encrypted mode dispatch
// ---------------------------------------------------------------------------

describe("selectSecretStore — encrypted mode", () => {
  it("selectSecretStore encrypted mode returns err when SECRETS_MASTER_KEY is absent (ok(null) from setupSecrets)", () => {
    const result = selectSecretStore({
      mode: "encrypted",
      dataDir: "/tmp/unused-encrypted",
      env: {}, // No SECRETS_MASTER_KEY
    });

    // setupSecrets returns ok(null) when key is absent → selectSecretStore returns err
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("SECRETS_MASTER_KEY");
  });

  it("selectSecretStore encrypted mode returns err when SECRETS_MASTER_KEY is invalid (setupSecrets returns err)", () => {
    const result = selectSecretStore({
      mode: "encrypted",
      dataDir: "/tmp/unused-encrypted",
      env: { SECRETS_MASTER_KEY: "not-a-valid-hex-key-short" }, // Present but invalid
    });

    // setupSecrets returns err(Error) for invalid key → selectSecretStore propagates
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("SECRETS_MASTER_KEY");
  });

  it("selectSecretStore encrypted mode succeeds when valid SECRETS_MASTER_KEY is provided", () => {
    const validKey = randomBytes(32).toString("hex"); // 64-char hex key
    const tmpDir = path.join(os.tmpdir(), `comis-enc-test-${randomBytes(8).toString("hex")}`);

    try {
      const result = selectSecretStore({
        mode: "encrypted",
        dataDir: tmpDir,
        env: { SECRETS_MASTER_KEY: validKey },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const selected = result.value;
      expect(selected.kind).toBe("encrypted");
      if (selected.kind === "encrypted") {
        expect(selected.secretStore).toBeDefined();
        expect(selected.secretsDb).toBeDefined();
        expect(selected.secretsCrypto).toBeDefined();
        // Close the db to release file handles
        selected.secretStore.close();
      }
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
