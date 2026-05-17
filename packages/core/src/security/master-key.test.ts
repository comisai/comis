// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the core master-key helpers extracted from CLI's
 * `secrets init` body.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { generateMasterKey, writeMasterKeyIfAbsent } from "./master-key.js";

describe("generateMasterKey", () => {
  it("returns a 64-character hex string (32 bytes encoded)", () => {
    const key = generateMasterKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value each call (non-deterministic)", () => {
    const a = generateMasterKey();
    const b = generateMasterKey();
    expect(a).not.toBe(b);
  });
});

describe("writeMasterKeyIfAbsent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "comis-master-key-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .env with SECRETS_MASTER_KEY=<64-char hex> + chmods file to 0o600 when no existing key", () => {
    const dataDir = resolve(tmpDir, "fresh-data-dir");
    const result = writeMasterKeyIfAbsent(dataDir);
    expect(result.written).toBe(true);
    expect(result.path).toBe(resolve(dataDir, ".env"));
    expect(existsSync(result.path)).toBe(true);

    const contents = readFileSync(result.path, "utf-8");
    expect(contents).toMatch(/SECRETS_MASTER_KEY=[0-9a-f]{64}/);

    // chmod check: 0o600 = owner-read+write only.
    const stats = statSync(result.path);
    // Mask permission bits (lower 9 bits of mode).
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("creates intermediate directories when dataDir does not exist", () => {
    const nested = resolve(tmpDir, "nested", "data");
    expect(existsSync(nested)).toBe(false);
    const result = writeMasterKeyIfAbsent(nested);
    expect(result.written).toBe(true);
    expect(existsSync(nested)).toBe(true);
    const dirStats = statSync(nested);
    // 0o700 = owner-rwx only.
    expect(dirStats.mode & 0o777).toBe(0o700);
  });

  it("is idempotent: returns { written: false } when SECRETS_MASTER_KEY already present in .env", () => {
    const dataDir = resolve(tmpDir, "preexisting");
    // First call writes:
    const first = writeMasterKeyIfAbsent(dataDir);
    expect(first.written).toBe(true);
    const initialContent = readFileSync(first.path, "utf-8");

    // Second call should refuse:
    const second = writeMasterKeyIfAbsent(dataDir);
    expect(second.written).toBe(false);
    expect(second.path).toBe(first.path);

    // File contents unchanged:
    const finalContent = readFileSync(second.path, "utf-8");
    expect(finalContent).toBe(initialContent);
  });
});
