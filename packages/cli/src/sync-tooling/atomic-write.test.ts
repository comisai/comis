// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for atomicWriteFile — temp + fsync + rename + parent-dir-fsync pattern.
 *
 * Covers:
 *   - Test 1: Happy path (file written, mode 0o600, byte-equal contents)
 *   - Test 2: Temp file is removed on successful rename
 *   - Test 3: Parent directory fsync is called (>= 2 fsyncSync calls total)
 *   - Test 4: Pre-existing file is overwritten atomically
 *   - Test 5: Mode is 0o600
 *   - Test 6: Write failure surfaces as Result.err({ code: "WRITE_FAILED" })
 *   - Test 7: Rename failure surfaces as Result.err({ code: "RENAME_FAILED", tempPath, targetPath })
 *
 * ESM does not allow `vi.spyOn` on namespace exports of `node:fs`, so we
 * mock the module at module-load time with the real implementation and
 * then override individual functions per-test (failure injection).
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace node:fs with a wrapper that delegates to the real implementation
// by default. Per-test overrides flip individual functions to throw, which
// is the only ESM-friendly way to spy on `fs.writeSync` / `fs.renameSync` /
// `fs.fsyncSync` / `fs.openSync`.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    closeSync: vi.fn(actual.closeSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    mkdtempSync: actual.mkdtempSync,
    writeFileSync: actual.writeFileSync,
    readFileSync: actual.readFileSync,
    statSync: actual.statSync,
    existsSync: actual.existsSync,
    rmSync: actual.rmSync,
  };
});

const fs = await import("node:fs");
const os = await import("node:os");
const { join, dirname } = await import("node:path");
const { atomicWriteFile } = await import("./atomic-write.js");

describe("atomicWriteFile (real fs, per-test temp dir)", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Re-bind the mocked fs methods to call the real impls. We do this with
    // a fresh actual import each time so test ordering is irrelevant.
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync);

    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    tempDir = fs.mkdtempSync(join(os.tmpdir(), "sync-tooling-atomic-"));
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    configPath = join(tempDir, "config.yaml");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.clearAllMocks();
  });

  // Test 1 — Happy path
  it("writes the file and returns ok(undefined)", () => {
    const content = "key: value\n";
    const result = atomicWriteFile(configPath, content);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(content);
  });

  // Test 2 — Temp file removed on successful rename
  it("removes the .sync-tooling.tmp temp file on success", () => {
    const result = atomicWriteFile(configPath, "x: 1\n");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(configPath + ".sync-tooling.tmp")).toBe(false);
  });

  // Test 3 — Parent dir fsync is called (>= 2 fsyncSync, parent dir openSync)
  it("calls fsyncSync at least twice (file fd + parent dir fd)", () => {
    const result = atomicWriteFile(configPath, "a: 1\n");

    expect(result.ok).toBe(true);
    // At least 2 fsyncSync calls: the temp file fd and the parent dir fd.
    expect(vi.mocked(fs.fsyncSync).mock.calls.length).toBeGreaterThanOrEqual(2);
    // One openSync call must target the parent directory in read mode.
    const dirOpenCalls = vi
      .mocked(fs.openSync)
      .mock.calls.filter(
        (args) => args[0] === dirname(configPath) && args[1] === "r",
      );
    expect(dirOpenCalls.length).toBeGreaterThanOrEqual(1);
  });

  // Test 4 — Pre-existing file is overwritten atomically
  it("overwrites a pre-existing file with the new content", () => {
    fs.writeFileSync(configPath, "old: A\n", { mode: 0o600 });
    expect(fs.readFileSync(configPath, "utf-8")).toBe("old: A\n");

    const result = atomicWriteFile(configPath, "new: B\n");

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe("new: B\n");
    expect(fs.existsSync(configPath + ".sync-tooling.tmp")).toBe(false);
  });

  // Test 5 — Mode is 0o600
  it("creates the file with mode 0o600", () => {
    const result = atomicWriteFile(configPath, "k: v\n");

    expect(result.ok).toBe(true);
    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("atomicWriteFile (failure injection via mocked fs)", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Reset all mocks to delegate to real impls. Tests below override
    // a specific function with `mockImplementationOnce` to inject failure
    // for a single call.
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync);

    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    tempDir = fs.mkdtempSync(join(os.tmpdir(), "sync-tooling-atomic-fail-"));
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    configPath = join(tempDir, "config.yaml");
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.clearAllMocks();
  });

  // Test 6 — Write failure surfaces as Result.err({ code: "WRITE_FAILED" })
  it("returns err({ code: 'WRITE_FAILED' }) when fs.writeSync throws", () => {
    vi.mocked(fs.writeSync).mockImplementationOnce(() => {
      const e = new Error("EDQUOT") as Error & { code?: string };
      e.code = "EDQUOT";
      throw e;
    });

    const result = atomicWriteFile(configPath, "x: 1\n");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WRITE_FAILED");
      if (result.error.code === "WRITE_FAILED") {
        expect(result.error.path).toBe(configPath + ".sync-tooling.tmp");
        expect(result.error.cause).toContain("EDQUOT");
      }
    }
    // Target file must NOT exist (no partial write).
    expect(fs.existsSync(configPath)).toBe(false);
  });

  // Test 7 — Rename failure surfaces as RENAME_FAILED with tempPath + targetPath
  it("returns err({ code: 'RENAME_FAILED', tempPath, targetPath }) on EXDEV", () => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      const e = new Error("EXDEV") as Error & { code?: string };
      e.code = "EXDEV";
      throw e;
    });

    const result = atomicWriteFile(configPath, "x: 1\n");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RENAME_FAILED");
      if (result.error.code === "RENAME_FAILED") {
        expect(result.error.tempPath).toBe(configPath + ".sync-tooling.tmp");
        expect(result.error.targetPath).toBe(configPath);
        expect(result.error.cause).toContain("EXDEV");
      }
    }
  });
});
