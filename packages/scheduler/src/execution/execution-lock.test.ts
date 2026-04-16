import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withExecutionLock, isLocked } from "./execution-lock.js";

describe("execution-lock", () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-lock-test-"));
    lockPath = path.join(testDir, "test.lock");
    // Create the sentinel file that proper-lockfile locks against
    fs.writeFileSync(lockPath, "");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("acquires lock, runs function, releases lock -> returns ok(result)", async () => {
    const result = await withExecutionLock(lockPath, async () => 42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
    // Lock should be released after execution
    const locked = await isLocked(lockPath);
    expect(locked).toBe(false);
  });

  it("returns err('locked') when lock already held", async () => {
    // Hold a long-running lock
    let releaseBarrier: () => void = () => {};
    const longRunning = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const first = withExecutionLock(lockPath, () => longRunning);

    // Give the first lock time to acquire
    await new Promise((r) => setTimeout(r, 100));

    // Second attempt should be rejected immediately
    const second = await withExecutionLock(lockPath, async () => "nope");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe("locked");
    }

    // Clean up: release the first lock
    releaseBarrier();
    await first;
  });

  it("releases lock even when function throws (finally block)", async () => {
    // The error from fn propagates, but the lock is released in finally
    await expect(
      withExecutionLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Lock should still be released despite the throw
    const locked = await isLocked(lockPath);
    expect(locked).toBe(false);
  });

  it("creates lock directory if it doesn't exist", async () => {
    const nestedDir = path.join(testDir, "deep", "nested");
    const nestedLockPath = path.join(nestedDir, "job.lock");

    // Directory doesn't exist yet
    expect(fs.existsSync(nestedDir)).toBe(false);

    const result = await withExecutionLock(nestedLockPath, async () => "ok");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ok");
    }
    // Directory was created
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it("isLocked returns true when locked, false when not", async () => {
    // Not locked initially
    const before = await isLocked(lockPath);
    expect(before).toBe(false);

    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const lockPromise = withExecutionLock(lockPath, () => hold);

    // Give time for lock to acquire
    await new Promise((r) => setTimeout(r, 100));

    const during = await isLocked(lockPath);
    expect(during).toBe(true);

    releaseHold();
    await lockPromise;

    const after = await isLocked(lockPath);
    expect(after).toBe(false);
  });

  it("recovers stale lock", async () => {
    // Simulate a crashed process by manually creating a stale .lock directory
    // proper-lockfile uses mkdir for locking, so we create the lock dir with old mtime
    const lockDir = `${lockPath}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });

    // Set the mtime to far in the past (simulates a process that crashed)
    const pastTime = new Date(Date.now() - 30_000);
    fs.utimesSync(lockDir, pastTime, pastTime);

    // With stale=2000 (proper-lockfile minimum), a 30s-old lock is stale
    const result = await withExecutionLock(lockPath, async () => "recovered", {
      staleMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("recovered");
    }
  });
});
