import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { withSessionLock, cleanupStaleLocks } from "./session-write-lock.js";

describe("session-write-lock", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-lock-test-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("derives lock file path from session key hash (deterministic)", async () => {
    const sessionKey = "tenant:user:channel";
    let lockFileSeen = "";

    // Call withSessionLock and check the lock directory was created with a deterministic sentinel file
    await withSessionLock(testDir, sessionKey, () => {
      // During execution, look for sentinel files in lock dir (exclude .lock directories created by proper-lockfile)
      const files = fs.readdirSync(testDir).filter(
        (f) => f.endsWith(".lock") && fs.statSync(path.join(testDir, f)).isFile(),
      );
      expect(files.length).toBe(1);
      lockFileSeen = files[0];
      return "ok";
    });

    // Same key produces same path (deterministic)
    await withSessionLock(testDir, sessionKey, () => {
      const files = fs.readdirSync(testDir).filter(
        (f) => f.endsWith(".lock") && fs.statSync(path.join(testDir, f)).isFile(),
      );
      expect(files.length).toBe(1);
      expect(files[0]).toBe(lockFileSeen);
      return "ok";
    });
  });

  it("different session keys produce different lock paths", async () => {
    const seenFiles: string[] = [];

    await withSessionLock(testDir, "tenant:userA:channel", () => {
      const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".lock"));
      seenFiles.push(files[0]);
      return "ok";
    });

    await withSessionLock(testDir, "tenant:userB:channel", () => {
      const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".lock"));
      seenFiles.push(files[0]);
      return "ok";
    });

    expect(seenFiles[0]).not.toBe(seenFiles[1]);
  });

  it("same session key produces same lock path (serialization guaranteed)", async () => {
    const key = "tenant:user:channel";
    const seenFiles: string[] = [];

    for (let i = 0; i < 3; i++) {
      await withSessionLock(testDir, key, () => {
        const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".lock"));
        seenFiles.push(files[0]);
        return "ok";
      });
    }

    expect(seenFiles[0]).toBe(seenFiles[1]);
    expect(seenFiles[1]).toBe(seenFiles[2]);
  });

  it("withSessionLock calls fn and returns result", async () => {
    const result = await withSessionLock(testDir, "tenant:user:ch", () => 42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("withSessionLock creates lock dir if not exists", async () => {
    const nestedDir = path.join(testDir, "deep", "nested");
    expect(fs.existsSync(nestedDir)).toBe(false);

    const result = await withSessionLock(nestedDir, "tenant:user:ch", () => "ok");
    expect(result.ok).toBe(true);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  it("stale lock detection releases abandoned locks", async () => {
    const key = "tenant:user:ch";

    // First, run once to create the sentinel file
    await withSessionLock(testDir, key, () => "setup");

    // Find the sentinel file
    const lockFiles = fs.readdirSync(testDir).filter((f) => f.endsWith(".lock"));
    expect(lockFiles.length).toBe(1);
    const sentinelPath = path.join(testDir, lockFiles[0]);

    // Simulate a stale lock by creating the lock directory with old mtime
    const lockDir = `${sentinelPath}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, pastTime, pastTime);

    // With staleMs=2000, a 60s-old lock should be considered stale and recoverable
    const result = await withSessionLock(testDir, key, () => "recovered", {
      staleMs: 2000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("recovered");
    }
  });

  it("serializes concurrent access to the same session key", async () => {
    const key = "tenant:user:ch";
    const order: string[] = [];

    // First lock holds for a bit
    const first = withSessionLock(testDir, key, async () => {
      order.push("first-start");
      await new Promise((r) => setTimeout(r, 200));
      order.push("first-end");
      return "first";
    });

    // Give time for the first lock to acquire
    await new Promise((r) => setTimeout(r, 50));

    // Second lock should wait (retry) until first releases
    const second = withSessionLock(
      testDir,
      key,
      async () => {
        order.push("second-start");
        return "second";
      },
      { retries: 10, retryMinTimeout: 100 },
    );

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // First should complete before second starts
    expect(order.indexOf("first-end")).toBeLessThan(order.indexOf("second-start"));
  });

  describe("cleanupStaleLocks", () => {
    it("removes stale sentinel files older than maxAgeMs", async () => {
      // Create some sentinel files by locking different sessions
      await withSessionLock(testDir, "session-a", () => "ok");
      await withSessionLock(testDir, "session-b", () => "ok");
      await withSessionLock(testDir, "session-c", () => "ok");

      const sentinelsBefore = fs.readdirSync(testDir).filter(
        (f) => f.endsWith(".lock") && fs.statSync(path.join(testDir, f)).isFile(),
      );
      expect(sentinelsBefore.length).toBe(3);

      // Backdate all sentinels to 2 hours ago
      const pastTime = new Date(Date.now() - 7_200_000);
      for (const f of sentinelsBefore) {
        fs.utimesSync(path.join(testDir, f), pastTime, pastTime);
      }

      // Cleanup with 1-hour threshold should remove all 3
      const removed = await cleanupStaleLocks(testDir, 3_600_000);
      expect(removed).toBe(3);

      const sentinelsAfter = fs.readdirSync(testDir).filter(
        (f) => f.endsWith(".lock") && fs.statSync(path.join(testDir, f)).isFile(),
      );
      expect(sentinelsAfter.length).toBe(0);
    });

    it("skips sentinel files newer than maxAgeMs", async () => {
      await withSessionLock(testDir, "fresh-session", () => "ok");

      // Don't backdate — file is fresh
      const removed = await cleanupStaleLocks(testDir, 3_600_000);
      expect(removed).toBe(0);

      const sentinels = fs.readdirSync(testDir).filter(
        (f) => f.endsWith(".lock") && fs.statSync(path.join(testDir, f)).isFile(),
      );
      expect(sentinels.length).toBe(1);
    });

    it("returns 0 for non-existent directory", async () => {
      const removed = await cleanupStaleLocks(path.join(testDir, "nonexistent"));
      expect(removed).toBe(0);
    });

    it("skips currently-locked sentinels", async () => {
      let releaseHold: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });

      // Start a lock that will be held during cleanup
      const lockPromise = withSessionLock(testDir, "held-session", () => hold);

      // Wait for lock to acquire
      await new Promise((r) => setTimeout(r, 100));

      // Backdate the sentinel to make it eligible for cleanup
      const sentinels = fs.readdirSync(testDir).filter(
        (f) => f.endsWith(".lock") && fs.statSync(path.join(testDir, f)).isFile(),
      );
      expect(sentinels.length).toBe(1);
      const pastTime = new Date(Date.now() - 7_200_000);
      fs.utimesSync(path.join(testDir, sentinels[0]), pastTime, pastTime);

      // Cleanup should skip it because it's actively locked
      const removed = await cleanupStaleLocks(testDir, 3_600_000);
      expect(removed).toBe(0);

      // Clean up
      releaseHold();
      await lockPromise;
    });
  });

  it("returns err('locked') when lock cannot be acquired (no retries)", async () => {
    const key = "tenant:user:ch";

    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const first = withSessionLock(testDir, key, () => hold);

    // Wait for first lock to acquire
    await new Promise((r) => setTimeout(r, 100));

    // Second attempt with no retries should fail
    const second = await withSessionLock(testDir, key, async () => "nope", {
      retries: 0,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe("locked");
    }

    // Clean up
    releaseHold();
    await first;
  });
});
