// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for atomicWriteFile — temp + fsync + rename + parent-dir-fsync pattern.
 *
 * Covers:
 *   - Happy path (file written, mode 0o600, byte-equal contents)
 *   - Temp file is removed on successful rename
 *   - Parent directory fsync is called (>= 2 fsyncSync calls total)
 *   - Pre-existing file is overwritten atomically
 *   - Mode is 0o600
 *   - Write failure surfaces as Result.err({ code: "WRITE_FAILED" })
 *   - Rename failure surfaces as Result.err({ code: "RENAME_FAILED", tempPath, targetPath })
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
    statSync: vi.fn(actual.statSync),
    chownSync: vi.fn(actual.chownSync),
    mkdtempSync: actual.mkdtempSync,
    writeFileSync: actual.writeFileSync,
    readFileSync: actual.readFileSync,
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
    vi.mocked(fs.statSync).mockImplementation(actual.statSync);
    vi.mocked(fs.chownSync).mockImplementation(actual.chownSync);

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

  // Happy path
  it("writes the file and returns ok(undefined)", () => {
    const content = "key: value\n";
    const result = atomicWriteFile(configPath, content);

    expect(result.ok).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(content);
  });

  // Temp file removed on successful rename
  it("removes the .sync-tooling.tmp temp file on success", () => {
    const result = atomicWriteFile(configPath, "x: 1\n");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(configPath + ".sync-tooling.tmp")).toBe(false);
  });

  // Parent dir fsync is called (>= 2 fsyncSync, parent dir openSync)
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

  // Pre-existing file is overwritten atomically
  it("overwrites a pre-existing file with the new content", () => {
    fs.writeFileSync(configPath, "old: A\n", { mode: 0o600 });
    expect(fs.readFileSync(configPath, "utf-8")).toBe("old: A\n");

    const result = atomicWriteFile(configPath, "new: B\n");

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe("new: B\n");
    expect(fs.existsSync(configPath + ".sync-tooling.tmp")).toBe(false);
  });

  // Mode is 0o600
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
    vi.mocked(fs.statSync).mockImplementation(actual.statSync);
    vi.mocked(fs.chownSync).mockImplementation(actual.chownSync);

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

  // Write failure surfaces as Result.err({ code: "WRITE_FAILED" })
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

  // Rename failure surfaces as RENAME_FAILED with tempPath + targetPath
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

  // -- Ownership preservation across the rename --------------------------

  // When the original file's uid:gid differs from what the rename
  // produces, chownSync is called with the captured uid:gid to restore the
  // original ownership. Mocks statSync to return a fake "original" uid, then
  // verifies chownSync was invoked with that uid.
  it("preserves original uid:gid via chownSync when rename produces a different owner", () => {
    // Seed a real file so the orchestrator's pre-write statSync sees something.
    fs.writeFileSync(configPath, "old: content\n");
    const realUid = fs.statSync(configPath).uid;
    const realGid = fs.statSync(configPath).gid;

    // First statSync call (pre-write capture) returns a fake
    // "original owner" uid:gid different from current process. Second
    // statSync call (post-rename verification) returns the
    // current-process uid so the orchestrator decides chown is needed.
    let statCallNo = 0;
    vi.mocked(fs.statSync).mockImplementation(((path: fs.PathLike) => {
      statCallNo++;
      if (statCallNo === 1) {
        // Pre-write: pretend the file was owned by uid 9999 / gid 9998
        return { uid: 9999, gid: 9998, mode: 0o600 } as fs.Stats;
      }
      // Post-rename: the current process owns the new file
      return { uid: realUid, gid: realGid, mode: 0o600 } as fs.Stats;
    }) as typeof fs.statSync);

    // Chown gets called but we don't actually want to invoke it (would
    // fail without CAP_CHOWN). Stub to a no-op.
    vi.mocked(fs.chownSync).mockImplementation(() => undefined);

    const result = atomicWriteFile(configPath, "new: content\n");

    expect(result.ok).toBe(true);
    expect(fs.chownSync).toHaveBeenCalledTimes(1);
    expect(fs.chownSync).toHaveBeenCalledWith(configPath, 9999, 9998);
  });

  // When the original file did not exist (first-time write),
  // statSync throws ENOENT and chownSync is NOT called. The caller's
  // uid:gid is the new file's owner, which is the correct behavior.
  it("does NOT chown when the target file did not exist before the write", () => {
    // configPath doesn't exist (per beforeEach). statSync will throw.
    // We let the real implementation handle it.
    const result = atomicWriteFile(configPath, "first: write\n");

    expect(result.ok).toBe(true);
    // chownSync should not have been called since there was no original
    // ownership to preserve.
    expect(fs.chownSync).not.toHaveBeenCalled();
  });

  // When chown fails (caller lacks CAP_CHOWN, or original
  // owner doesn't exist on the system), the write returns CHOWN_FAILED
  // with the captured uid:gid and the cause. The new content IS on disk
  // (the rename already succeeded) but ownership is wrong — caller is
  // responsible for surfacing this.
  it("returns err({ code: 'CHOWN_FAILED' }) when chownSync throws (e.g. EPERM)", () => {
    // Same setup as the chown-preservation test — fake original ownership.
    fs.writeFileSync(configPath, "old: content\n");
    const realUid = fs.statSync(configPath).uid;
    const realGid = fs.statSync(configPath).gid;

    let statCallNo = 0;
    vi.mocked(fs.statSync).mockImplementation(((_path: fs.PathLike) => {
      statCallNo++;
      if (statCallNo === 1) {
        return { uid: 9999, gid: 9998, mode: 0o600 } as fs.Stats;
      }
      return { uid: realUid, gid: realGid, mode: 0o600 } as fs.Stats;
    }) as typeof fs.statSync);

    vi.mocked(fs.chownSync).mockImplementationOnce(() => {
      const e = new Error("EPERM: operation not permitted") as Error & { code?: string };
      e.code = "EPERM";
      throw e;
    });

    const result = atomicWriteFile(configPath, "new: content\n");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CHOWN_FAILED");
      if (result.error.code === "CHOWN_FAILED") {
        expect(result.error.targetPath).toBe(configPath);
        expect(result.error.uid).toBe(9999);
        expect(result.error.gid).toBe(9998);
        expect(result.error.cause).toContain("EPERM");
      }
    }
    // The new content IS on disk (rename succeeded before chown was attempted)
    // — caller's responsibility to surface CHOWN_FAILED to the operator.
    expect(fs.readFileSync(configPath, "utf-8")).toBe("new: content\n");
  });
});

describe("atomicWriteFile under Node Permission Model (fsync disabled)", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementation(actual.openSync);
    vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    vi.mocked(fs.closeSync).mockImplementation(actual.closeSync);
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
    vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync);
    vi.mocked(fs.statSync).mockImplementation(actual.statSync);
    vi.mocked(fs.chownSync).mockImplementation(actual.chownSync);

    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    tempDir = fs.mkdtempSync(join(os.tmpdir(), "sync-tooling-perm-"));
    // eslint-disable-next-line no-restricted-syntax -- test code: path.join inside test, not src
    configPath = join(tempDir, "config.yaml");
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns ok and writes the file when fsync is refused by the permission model", () => {
    // Node --permission disables fs.fsyncSync; the write must still succeed.
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw new Error("fsync API is disabled when Permission Model is enabled.");
    });

    const result = atomicWriteFile(configPath, "hello: world\n");

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toBe("hello: world\n");
  });

  it("still returns WRITE_FAILED on a genuine fsync I/O error (EIO)", () => {
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    });

    const result = atomicWriteFile(configPath, "x");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("WRITE_FAILED");
  });
});
