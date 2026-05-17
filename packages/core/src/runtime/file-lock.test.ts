// SPDX-License-Identifier: Apache-2.0
/**
 * FileLockPort adapter tests — proper-lockfile-backed `createFileLock()`.
 *
 * Validates the contract surface declared at
 * packages/core/src/ports/file-lock.ts.
 *
 * Test names are binding contracts for the FileLockPort surface.
 *
 * @module
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createFileLock } from "./file-lock.js";
import type { FileLockPort } from "../ports/file-lock.js";

describe("FileLockPort contract — proper-lockfile factory (core/runtime)", () => {
  let testDir: string;
  let lockPath: string;
  let lock: FileLockPort;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-core-"));
    lockPath = path.join(testDir, "test.lock");
    fs.writeFileSync(lockPath, "");
    lock = createFileLock();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("acquire then release returns the lock to the unlocked state", async () => {
    const acq = await lock.acquire(lockPath);
    expect(acq.ok, "acquire should succeed").toBe(true);
    if (!acq.ok) return;

    expect(await lock.isLocked(lockPath), "lock is held after acquire").toBe(true);

    await acq.value(); // release
    expect(await lock.isLocked(lockPath), "lock is unlocked after release").toBe(false);
  });

  it("withLock runs the body once and releases on success", async () => {
    let callCount = 0;
    const result = await lock.withLock(lockPath, async () => {
      callCount += 1;
      expect(await lock.isLocked(lockPath), "lock held during body").toBe(true);
      return "value-from-body";
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("value-from-body");
    expect(callCount).toBe(1);
    expect(await lock.isLocked(lockPath), "lock released after success").toBe(false);
  });

  it("withLock releases the lock when the body throws", async () => {
    const result = await lock.withLock(lockPath, async () => {
      throw new Error("body failure");
    });
    expect(result.ok, "withLock returns err when body throws").toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("error");
      expect(result.error.message).toContain("body failure");
    }
    expect(await lock.isLocked(lockPath), "lock released even on throw").toBe(false);
  });

  it("isLocked behavior matches FileLockPort spec", async () => {
    expect(await lock.isLocked(lockPath), "initially unlocked").toBe(false);
    const acq = await lock.acquire(lockPath);
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    expect(await lock.isLocked(lockPath), "locked after acquire").toBe(true);
    await acq.value();
    expect(await lock.isLocked(lockPath), "unlocked after release").toBe(false);
  });

  it("acquire on a held lock returns err({ kind: 'locked' }) (ELOCKED retry exhaustion)", async () => {
    const first = await lock.acquire(lockPath, { retries: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await lock.acquire(lockPath, { retries: 0 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.kind).toBe("locked");
    }

    await first.value();
  });

  it("cleanupStaleLocks ignores fresh lock files (within maxAgeMs)", async () => {
    // Create a fresh `.lock` sentinel directly — proper-lockfile uses
    // mkdir/rmdir on `<lockPath>.lock`, but our cleanupStaleLocks scans
    // `*.lock` regular FILES under lockDir (per the cleanupStaleLocks
    // contract in core/src/ports/file-lock.ts: "Removes proper-lockfile
    // sentinels … older than maxAgeMs"). A freshly-created file MUST be
    // skipped regardless of whether it's actively locked.
    const freshFile = path.join(testDir, "fresh.lock");
    fs.writeFileSync(freshFile, "");
    const removed = await lock.cleanupStaleLocks(testDir, 60_000);
    expect(removed).toBe(0);
    expect(fs.existsSync(freshFile), "fresh file is not removed").toBe(true);
  });
});
