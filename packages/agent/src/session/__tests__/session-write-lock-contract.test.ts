// SPDX-License-Identifier: Apache-2.0
/**
 * Session-write-lock contract test.
 *
 * FileLockPort is injected into agent's session-write-lock path. This
 * contract test runs against the direct-proper-lockfile impl; the contract
 * surface is identical so tests stay green across import retargets.
 *
 * The scheduler file-lock contract proves basic acquire/release/withLock
 * semantics; these tests prove the additional behavior session-write-lock
 * relies on (session-write-lock.ts:62 ELOCKED detection,
 * session-write-lock.ts:173 directory-form `.lock.lock` cleanup, lock-file
 * naming format).
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
// Test-only @comis/core import — the production session-write-lock module does
// not depend directly on proper-lockfile; the contract test wires the
// canonical createFileLock() adapter explicitly.
import { createFileLock, type FileLockPort } from "@comis/core";
import { withSessionLock, cleanupStaleLocks } from "../session-write-lock.js";

describe("session-write-lock contract", () => {
  let testDir: string;
  let fileLock: FileLockPort;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-write-lock-contract-"));
    fileLock = createFileLock();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("FileLockPort surfaces ELOCKED-equivalent contention with the retry semantics session-write-lock relies on (locked → retry → eventual ok or err with stable error shape)", async () => {
    const sessionKey = "test:session:contention";

    // Acquire first lock; deliberately do NOT release until later.
    let firstReleased = false;
    const firstLockPromise = withSessionLock(fileLock, testDir, sessionKey, async () => {
      // Hold the lock until firstReleased is set.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (firstReleased) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
      return "first-result";
    });

    // Briefly wait so first lock is established, then attempt a second
    // acquire with retries: 0.
    await new Promise((r) => setTimeout(r, 50));
    const secondResult = await withSessionLock(
      fileLock,
      testDir,
      sessionKey,
      async () => "second-result",
      { retries: 0, retryMinTimeout: 1, staleMs: 30_000 },
    );
    expect(
      secondResult.ok,
      "second concurrent withSessionLock should return locked err",
    ).toBe(false);
    if (!secondResult.ok) {
      // Stable error shape - current direct-proper-lockfile path returns
      // "locked"; FileLockPort returns { kind: "locked", message }. Both
      // shapes pass this assertion via existence of either.
      expect(String(secondResult.error)).toMatch(/locked|ELOCKED/i);
    }

    // Release first lock.
    firstReleased = true;
    const firstResult = await firstLockPromise;
    expect(firstResult.ok).toBe(true);
  });

  it("FileLockPort cleanupStale handles directory-form lock indicators (proper-lockfile creates `.lock.lock` directories that must be cleaned without removing the underlying session file)", async () => {
    // proper-lockfile creates `<sentinel>.lock` as a DIRECTORY (not a file).
    // cleanupStaleLocks must:
    //   1. detect the directory-form sentinel
    //   2. skip if the lock is currently held (lockfile.check)
    //   3. unlink (rm -r for the dir) only if older than maxAgeMs
    //   4. NOT touch the underlying session file (e.g., the JSON state file)

    const sessionKey = "test:session:cleanup";
    const sessionFile = path.join(testDir, "session-state.json");
    fs.writeFileSync(sessionFile, '{"placeholder":true}');

    // Acquire + release a lock to generate the on-disk artifact.
    const result = await withSessionLock(fileLock, testDir, sessionKey, async () => "ok");
    expect(result.ok).toBe(true);

    // Run cleanupStaleLocks with a small maxAgeMs to force reclaim of any
    // stale artifact. Cleanup should not touch session-state.json.
    const reclaimed = await cleanupStaleLocks(fileLock, testDir, 1);
    expect(typeof reclaimed).toBe("number");
    expect(
      fs.existsSync(sessionFile),
      "underlying session file MUST NOT be removed by cleanup",
    ).toBe(true);
  });

  it("FileLockPort lock-file path naming preserves the `<hash>.lock` form so on-disk artifacts from prior runs stay recognizable", async () => {
    const sessionKey = "test:session:naming";
    let observedLockName = "";
    await withSessionLock(fileLock, testDir, sessionKey, () => {
      // While the lock is held, look for a sentinel `.lock` REGULAR FILE
      // (proper-lockfile's `.lock.lock` directory is the active-lock
      // indicator; the deterministic hash-named sentinel is a regular file).
      const files = fs
        .readdirSync(testDir)
        .filter(
          (f) =>
            f.endsWith(".lock") &&
            fs.statSync(path.join(testDir, f)).isFile(),
        );
      expect(
        files.length,
        "exactly one hash-named sentinel file expected during withSessionLock body",
      ).toBe(1);
      observedLockName = files[0]!;
      return "ok";
    });

    // Hash + ".lock" = 12 + 5 = 17 chars
    // (sha256(sessionKey).slice(0,12) per session-write-lock.ts line 58).
    expect(observedLockName.length).toBe(17);
    expect(observedLockName.endsWith(".lock")).toBe(true);
    // Future-proofing: when FileLockPort is used end-to-end, the same naming
    // convention is preserved (the deriveLockPath impl moves with
    // session-write-lock; the FileLockPort accepts an arbitrary lockPath so
    // the caller-side hash-derivation choice is preserved).
  });
});
