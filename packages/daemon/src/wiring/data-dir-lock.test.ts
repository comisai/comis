// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for data-dir singleton lock (D14).
 * Covers: acquire/conflict/stale-recovery/release behaviors.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { acquireDataDirLock, releaseDataDirLock } from "./data-dir-lock.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "data-dir-lock-test-"));
}

describe("acquireDataDirLock", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDir();
  });

  afterEach(() => {
    // best-effort cleanup
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it("creates .daemon.lock containing process.pid on empty data dir", () => {
    acquireDataDirLock(dataDir);
    const lockPath = path.join(dataDir, ".daemon.lock");
    expect(fs.existsSync(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  it("throws with 'Another daemon instance' message when lock held by a live PID", () => {
    // Write a lock file with current PID (which is definitely alive)
    const lockPath = path.join(dataDir, ".daemon.lock");
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

    expect(() => acquireDataDirLock(dataDir)).toThrowError("Another daemon instance");
  });

  it("error message contains the conflicting PID for operator diagnosis", () => {
    const lockPath = path.join(dataDir, ".daemon.lock");
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });

    let caughtMessage = "";
    try {
      acquireDataDirLock(dataDir);
    } catch (e) {
      caughtMessage = (e as Error).message;
    }

    expect(caughtMessage).toContain(String(process.pid));
  });

  it("recovers from stale lock when PID is dead (ESRCH) by unlinking and re-acquiring", () => {
    const lockPath = path.join(dataDir, ".daemon.lock");
    const deadPid = 99999;
    fs.writeFileSync(lockPath, String(deadPid), { mode: 0o600 });

    // Simulate process.kill throwing ESRCH (dead process)
    vi.spyOn(process, "kill").mockImplementation((_pid: number, _signal?: number | string) => {
      const err = Object.assign(new Error("ESRCH: no such process"), { code: "ESRCH" });
      throw err;
    });

    // Should not throw — stale lock is recovered
    expect(() => acquireDataDirLock(dataDir)).not.toThrow();

    // The lock file should now contain the current PID
    const newContent = fs.readFileSync(lockPath, "utf-8").trim();
    expect(newContent).toBe(String(process.pid));
  });

  it("treats lock held by EPERM process as live and throws conflict error", () => {
    const lockPath = path.join(dataDir, ".daemon.lock");
    const somePid = 12345;
    fs.writeFileSync(lockPath, String(somePid), { mode: 0o600 });

    // Simulate process.kill throwing EPERM (process exists but we lack permission)
    vi.spyOn(process, "kill").mockImplementation((_pid: number, _signal?: number | string) => {
      const err = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      throw err;
    });

    expect(() => acquireDataDirLock(dataDir)).toThrowError("Another daemon instance");
  });
});

describe("releaseDataDirLock", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTmpDir();
  });

  afterEach(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("removes .daemon.lock file after release", () => {
    acquireDataDirLock(dataDir);
    const lockPath = path.join(dataDir, ".daemon.lock");
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseDataDirLock(dataDir);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("is safe to call when .daemon.lock does not exist (no throw on double-release)", () => {
    // No lock acquired — should not throw
    expect(() => releaseDataDirLock(dataDir)).not.toThrow();
  });

  it("allows subsequent acquireDataDirLock to succeed after release", () => {
    acquireDataDirLock(dataDir);
    releaseDataDirLock(dataDir);

    // Should succeed — lock was released
    expect(() => acquireDataDirLock(dataDir)).not.toThrow();
    const lockPath = path.join(dataDir, ".daemon.lock");
    expect(fs.readFileSync(lockPath, "utf-8").trim()).toBe(String(process.pid));
  });
});
