// SPDX-License-Identifier: Apache-2.0
/**
 * Regression: acquireDataDirLock must boot under Node's Permission Model.
 *
 * Under `node --permission` (the production systemd unit), fs.fsyncSync is
 * disabled and throws "fsync API is disabled when Permission Model is enabled."
 * Before the best-effort guard, the daemon FATAL-crashed at data-dir lock
 * acquisition on EVERY boot (observed on a production VPS, 2026-06-02).
 *
 * ESM forbids vi.spyOn on the node:fs namespace, so we mock the module at
 * load time (delegating to the real impl) and override fsyncSync per-test —
 * the same pattern used by atomic-write.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

const fs = await import("node:fs");
const os = await import("node:os");
const { join } = await import("node:path");
const { acquireDataDirLock, releaseDataDirLock } = await import("./data-dir-lock.js");

const permissionModelFsyncError = (): Error =>
  new Error("fsync API is disabled when Permission Model is enabled.");

describe("acquireDataDirLock under Node Permission Model (fsync disabled)", () => {
  let dataDir: string;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.fsyncSync).mockImplementation(actual.fsyncSync);
    dataDir = fs.mkdtempSync(join(os.tmpdir(), "data-dir-lock-perm-"));
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it("acquires the lock without throwing when fsync is refused by the permission model", () => {
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw permissionModelFsyncError();
    });

    expect(() => acquireDataDirLock(dataDir)).not.toThrow();

    // The lock file is still created — only the durability fsync was skipped.
    expect(fs.existsSync(join(dataDir, ".daemon.lock"))).toBe(true);
    releaseDataDirLock(dataDir);
  });

  it("still propagates a genuine fsync I/O error (EIO) — does not over-swallow", () => {
    vi.mocked(fs.fsyncSync).mockImplementation(() => {
      throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
    });

    expect(() => acquireDataDirLock(dataDir)).toThrowError(/EIO/);
  });
});
