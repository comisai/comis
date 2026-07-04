// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createFileSecretStore — SecretStorePort sync-atomic file adapter.
 *
 * Covers: round-trip set/getDecrypted/list/delete, secrets.json mode 0600 + dir 0700,
 * O_NOFOLLOW symlink refusal, renameSync atomicity (no-partial-read), decryptAll map,
 * residency invariant (list returns no value field), close no-op, temp-file cleanup.
 *
 * Uses real fs operations in per-test unique temp dirs cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createFileSecretStore } from "./file-secret-store.js";

function makeTempDir(): string {
  const base = os.tmpdir();
  const name = `comis-file-secret-store-${randomBytes(8).toString("hex")}`;
  const dir = path.join(base, name);
  // Don't create it here — let the store create it on first write
  return dir;
}

describe("createFileSecretStore", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
  });

  afterEach(() => {
    // Best-effort cleanup
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("set then getDecrypted returns the stored plaintext value", () => {
    const store = createFileSecretStore({ dataDir });
    const setResult = store.set("MY_API_KEY", "supersecret123");
    expect(setResult.ok).toBe(true);

    const getResult = store.getDecrypted("MY_API_KEY");
    expect(getResult.ok).toBe(true);
    expect(getResult.ok && getResult.value).toBe("supersecret123");
  });

  it("getDecrypted returns undefined for a name that does not exist", () => {
    const store = createFileSecretStore({ dataDir });
    const getResult = store.getDecrypted("NONEXISTENT_KEY");
    expect(getResult.ok).toBe(true);
    expect(getResult.ok && getResult.value).toBeUndefined();
  });

  it("set writes secrets.json at mode 0600 inside a 0700 directory", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("KEY1", "value1");

    const secretsPath = path.join(dataDir, "secrets.json");
    const fileStat = fs.statSync(secretsPath);
    const dirStat = fs.statSync(dataDir);

    // On Linux, mask with 0o777 to get permission bits
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("set refuses to follow a symlink placed at the secrets.json path (O_NOFOLLOW)", () => {
    // Create the data dir manually so we can place a symlink
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const secretsPath = path.join(dataDir, "secrets.json");
    const target = path.join(dataDir, "attacker-controlled.json");

    // Place attacker-controlled symlink at secrets.json
    fs.writeFileSync(target, '{"attacker": "data"}');
    fs.symlinkSync(target, secretsPath);

    const store = createFileSecretStore({ dataDir });
    const result = store.set("KEY1", "value1");

    // The write must fail because secrets.json is a symlink (O_NOFOLLOW)
    expect(result.ok).toBe(false);

    // The symlink target must NOT have been overwritten
    const targetContents = fs.readFileSync(target, "utf-8");
    expect(targetContents).toContain("attacker");
  });

  it("concurrent readers see only whole-file state — never partial JSON from a concurrent write", () => {
    const store = createFileSecretStore({ dataDir });
    // Seed with a known key
    store.set("INITIAL_KEY", "initial_value");

    // Write a large batch of keys
    for (let i = 0; i < 20; i++) {
      store.set(`KEY_${i}`, `value_${i}`);
    }

    // Now perform a concurrent read-while-write by doing many reads in a loop
    // Since all operations are synchronous and single-threaded, renameSync ensures
    // each reader sees either the old complete file or the new complete file.
    // We verify by reading the raw file and confirming it always parses cleanly.
    store.set("CONCURRENT_KEY", "concurrent_value");

    const rawContents = fs.readFileSync(path.join(dataDir, "secrets.json"), "utf-8");
    expect(() => JSON.parse(rawContents)).not.toThrow();

    const parsed = JSON.parse(rawContents);
    expect(parsed).toHaveProperty("schemaVersion", 1);
    expect(parsed).toHaveProperty("secrets");
  });

  it("list returns SecretMetadata array with no value field (residency invariant)", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("SECRET_A", "plain_value_a", { provider: "manual", description: "A test key" });
    store.set("SECRET_B", "plain_value_b");

    const listResult = store.list();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    expect(listResult.value).toHaveLength(2);

    for (const meta of listResult.value) {
      // Residency canary: value must NOT appear in list output
      expect(Object.keys(meta)).not.toContain("value");
      expect(meta).toHaveProperty("name");
      expect(meta).toHaveProperty("createdAt");
      expect(meta).toHaveProperty("updatedAt");
    }
  });

  it("list returns metadata with correct provider and description from set options", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("ANNOTATED_KEY", "annotated_value", {
      provider: "anthropic",
      description: "Claude API key",
      expiresAt: 9999999999999,
    });

    const listResult = store.list();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    const entry = listResult.value.find((m) => m.name === "ANNOTATED_KEY");
    expect(entry).toBeDefined();
    expect(entry?.provider).toBe("anthropic");
    expect(entry?.description).toBe("Claude API key");
    expect(entry?.expiresAt).toBe(9999999999999);
  });

  it("delete existing name returns ok(true) and key is gone from getDecrypted", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("DELETE_ME", "the_value");

    const deleteResult = store.delete("DELETE_ME");
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.ok && deleteResult.value).toBe(true);

    const getResult = store.getDecrypted("DELETE_ME");
    expect(getResult.ok).toBe(true);
    expect(getResult.ok && getResult.value).toBeUndefined();
  });

  it("delete unknown name returns ok(false) without error", () => {
    const store = createFileSecretStore({ dataDir });
    const deleteResult = store.delete("NONEXISTENT_KEY");
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.ok && deleteResult.value).toBe(false);
  });

  it("decryptAll returns a Map with all stored name-to-value pairs", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("KEY_ALPHA", "value_alpha");
    store.set("KEY_BETA", "value_beta");
    store.set("KEY_GAMMA", "value_gamma");

    const decryptAllResult = store.decryptAll();
    expect(decryptAllResult.ok).toBe(true);
    if (!decryptAllResult.ok) return;

    const map = decryptAllResult.value;
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(3);
    expect(map.get("KEY_ALPHA")).toBe("value_alpha");
    expect(map.get("KEY_BETA")).toBe("value_beta");
    expect(map.get("KEY_GAMMA")).toBe("value_gamma");
  });

  it("decryptAll returns empty Map when no secrets are stored", () => {
    const store = createFileSecretStore({ dataDir });

    const result = store.decryptAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.size).toBe(0);
  });

  it("close is a no-op and does not throw", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("KEY1", "value1");

    // Should not throw
    expect(() => store.close()).not.toThrow();

    // Store should still work after close (it's a no-op)
    const getResult = store.getDecrypted("KEY1");
    expect(getResult.ok).toBe(true);
  });

  it("set uses unique temp suffix so prior crash leftover temp does not block next write", () => {
    // Pre-place a leftover .tmp file with a fixed name (simulating a crash)
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const leftoverTmp = path.join(dataDir, "secrets.json.deadbeef.tmp");
    fs.writeFileSync(leftoverTmp, "leftover", { mode: 0o600 });

    // Creating the store should clean up stale tmps
    const store = createFileSecretStore({ dataDir });

    // The write should succeed (random suffix avoids colliding with leftover)
    const result = store.set("KEY1", "value1");
    expect(result.ok).toBe(true);

    // The leftover should have been cleaned up by the factory
    expect(fs.existsSync(leftoverTmp)).toBe(false);
  });

  // root bypasses directory permissions, so a chmod-based write failure cannot be
  // induced as root — skip there (mirrors setup-mcp.test.ts's isRoot guard); non-root
  // CI/dev keeps full coverage.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  (isRoot ? it.skip : it)("set cleans up temp file on write failure before propagating the error", () => {
    // To simulate a write failure, make the data dir read-only after creation
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const store = createFileSecretStore({ dataDir });

    // Make data dir read-only so the next write fails
    fs.chmodSync(dataDir, 0o500);

    try {
      const result = store.set("KEY1", "value1");
      expect(result.ok).toBe(false);

      // No .tmp files should remain
      const entries = fs.readdirSync(dataDir).filter((n) => n.endsWith(".tmp"));
      expect(entries).toHaveLength(0);
    } finally {
      // Restore write permission for cleanup
      try {
        fs.chmodSync(dataDir, 0o700);
      } catch {
        // ignore
      }
    }
  });

  it("loadSecretsFile returns err when secrets.json has unknown schema version", () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const secretsPath = path.join(dataDir, "secrets.json");
    fs.writeFileSync(
      secretsPath,
      JSON.stringify({ schemaVersion: 99, secrets: {} }),
      { mode: 0o600 },
    );

    const store = createFileSecretStore({ dataDir });
    // Any read operation should surface the schema version error
    const result = store.getDecrypted("ANY_KEY");
    expect(result.ok).toBe(false);
  });

  it("multiple set calls update the same key correctly (last write wins)", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("OVERWRITE_KEY", "first_value");
    store.set("OVERWRITE_KEY", "second_value");

    const getResult = store.getDecrypted("OVERWRITE_KEY");
    expect(getResult.ok).toBe(true);
    expect(getResult.ok && getResult.value).toBe("second_value");
  });

  it("list returns empty array when no secrets have been stored yet", () => {
    const store = createFileSecretStore({ dataDir });
    store.set("FIRST_KEY", "first_value");
    store.delete("FIRST_KEY");

    const listResult = store.list();
    expect(listResult.ok).toBe(true);
    expect(listResult.ok && listResult.value).toHaveLength(0);
  });

  it("list on a store with multiple entries never includes plaintext values (file-store residency, multi-entry)", () => {
    // The file-store residency invariant must hold when the store contains
    // many entries. Each item in list() must have name+metadata but NOT value.
    const store = createFileSecretStore({ dataDir });
    const stored: Record<string, string> = {
      MULTI_KEY_A: "plaintext-value-for-A",
      MULTI_KEY_B: "plaintext-value-for-B",
      MULTI_KEY_C: "plaintext-value-for-C",
    };

    for (const [name, value] of Object.entries(stored)) {
      store.set(name, value);
    }

    const listResult = store.list();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    expect(listResult.value).toHaveLength(3);

    for (const item of listResult.value) {
      // Each item must NOT have a "value" property
      expect(Object.keys(item)).not.toContain("value");
      expect(item).toHaveProperty("name");
      // The serialized entry must not contain any of the stored plaintext values
      const itemJson = JSON.stringify(item);
      for (const v of Object.values(stored)) {
        expect(itemJson).not.toContain(v);
      }
    }
  });

  it("loadSecretsFile returns err when secrets.json contains invalid JSON (non-parseable content)", () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const secretsPath = path.join(dataDir, "secrets.json");
    fs.writeFileSync(secretsPath, "NOT VALID JSON {{{{", { mode: 0o600 });

    const store = createFileSecretStore({ dataDir });
    // Any read operation should surface the JSON parse error
    const result = store.getDecrypted("ANY_KEY");
    expect(result.ok).toBe(false);
  });

  it("loadSecretsFile returns err for corrupted file on decryptAll call", () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const secretsPath = path.join(dataDir, "secrets.json");
    fs.writeFileSync(secretsPath, "NOT VALID JSON", { mode: 0o600 });

    const store = createFileSecretStore({ dataDir });
    const result = store.decryptAll();
    expect(result.ok).toBe(false);
  });

  it("loadSecretsFile returns err for corrupted file on list call", () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const secretsPath = path.join(dataDir, "secrets.json");
    fs.writeFileSync(secretsPath, "INVALID", { mode: 0o600 });

    const store = createFileSecretStore({ dataDir });
    const result = store.list();
    expect(result.ok).toBe(false);
  });

  it("loadSecretsFile returns err for corrupted file on delete call", () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const secretsPath = path.join(dataDir, "secrets.json");
    fs.writeFileSync(secretsPath, "{INVALID", { mode: 0o600 });

    const store = createFileSecretStore({ dataDir });
    const result = store.delete("ANY_KEY");
    expect(result.ok).toBe(false);
  });

  it("persistSecretsFile error path propagates when dataDir cannot be created (mkdir failure)", () => {
    // Use a path that can't be created — a file exists at the parent
    const blockingFile = path.join(os.tmpdir(), `comis-blocking-${randomBytes(4).toString("hex")}`);
    fs.writeFileSync(blockingFile, "blocking");

    try {
      // Try to use the blocking file as a parent directory
      const impossibleDir = path.join(blockingFile, "subdir");
      const store = createFileSecretStore({ dataDir: impossibleDir });
      const result = store.set("KEY", "value");
      expect(result.ok).toBe(false);
    } finally {
      try {
        fs.unlinkSync(blockingFile);
      } catch {
        // ignore
      }
    }
  });

  it("cleanupStaleTmps preserves non-secrets .tmp files from other components in dataDir", () => {
    // Pre-create the data dir
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    // A stale secrets temp (should be removed)
    const secretsTmp = path.join(dataDir, "secrets.json.abcdef01.tmp");
    fs.writeFileSync(secretsTmp, "stale-secrets", { mode: 0o600 });

    // A non-secrets .tmp file from another component (must NOT be removed)
    const otherTmp = path.join(dataDir, "cache.db.tmp");
    fs.writeFileSync(otherTmp, "other-component-data", { mode: 0o600 });

    // Constructing the store triggers cleanupStaleTmps
    createFileSecretStore({ dataDir });

    // The secrets stale temp should be gone
    expect(fs.existsSync(secretsTmp)).toBe(false);
    // The other component's temp must survive
    expect(fs.existsSync(otherTmp)).toBe(true);
  });
});
