// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-process FileLockPort contract test - OAuth lock failure mode.
 *
 * Exercises the third consumer of FileLockPort: a daemon crash mid-refresh
 * leaves a stale lock on disk; the next process must reclaim it after
 * proper-lockfile's `stale: <ms>` timeout.
 *
 * Pattern: spawn a Node child process that acquires the lock then exits
 * abruptly (process.exit(1)) without releasing. The parent then attempts
 * re-acquisition; with stale: <small> the second attempt succeeds.
 *
 * Exercises FileLockPort against direct-proper-lockfile usage in
 * agent/src/model/oauth-{credential-store-file,token-manager}.ts.
 *
 * Test home rationale: packages/agent/src/oauth/ does NOT exist. OAuth
 * lock call sites live at:
 *   - packages/agent/src/model/oauth-credential-store-file.ts (set + delete)
 *   - packages/agent/src/model/oauth-token-manager.ts (refreshUnderLock)
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Spawn a Node child process that acquires the lock then exits without
 * releasing. The child uses `node -e <inline-script>` to keep the test
 * self-contained (no companion .js file needed).
 */
function spawnLockHolder(args: {
  lockPath: string;
  holdMs: number;
  staleMs?: number;
}): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const childScript = `
      const lockfile = require('proper-lockfile');
      const fs = require('fs');
      try { fs.writeFileSync(${JSON.stringify(args.lockPath)}, ''); } catch (e) {}
      lockfile.lock(${JSON.stringify(args.lockPath)}, { stale: ${args.staleMs ?? 5000} })
        .then(() => setTimeout(() => process.exit(1), ${args.holdMs}))
        .catch((e) => { process.stderr.write(String(e)); process.exit(2); });
    `;
    const child = spawn("node", ["-e", childScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (b: Buffer | string) => {
      stderr += typeof b === "string" ? b : b.toString("utf8");
    });
    child.on("close", (code) =>
      resolve({ exitCode: code ?? -1, stderr }),
    );
  });
}

describe("OAuth FileLockPort contract — cross-process stale-lock recovery", () => {
  let testDir: string;
  let lockPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(path.join(os.tmpdir(), "oauth-lock-contract-"));
    // OAuth lock paths use profile-id-derived names: e.g.,
    // `auth-refresh__openai-codex__user_a_at_example.com.lock`.
    lockPath = path.join(testDir, "openai-codex_user_a.lock");
    writeFileSync(lockPath, "");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("after process crash mid-refresh (lock held + exit without release), next process reclaims after stale timeout", async () => {
    // Step 1: child acquires + exits without releasing (simulates daemon
    // crash mid-refresh).
    const child = await spawnLockHolder({ lockPath, holdMs: 50, staleMs: 1000 });
    expect(
      child.exitCode,
      "child intentionally exits with code 1 to simulate crash",
    ).toBe(1);

    // Step 2: parent waits past the stale timeout, then attempts
    // re-acquisition. Use proper-lockfile directly (matches today's agent
    // OAuth call-site impl).
    const lockfile = await import("proper-lockfile");

    // Wait for stale timeout to elapse.
    await new Promise((r) => setTimeout(r, 1500));

    // Re-acquire with same staleMs; proper-lockfile reclaims the stale lock.
    const release = await lockfile.lock(lockPath, {
      stale: 1000,
      retries: { retries: 5, minTimeout: 200 },
    });
    expect(typeof release).toBe("function");
    await release();
  }, 15_000);

  it("per-profile-ID isolation: concurrent locks on different profile IDs proceed in parallel; same profile ID serializes", async () => {
    const lockPathA = path.join(testDir, "profile-a.lock");
    const lockPathB = path.join(testDir, "profile-b.lock");
    writeFileSync(lockPathA, "");
    writeFileSync(lockPathB, "");

    const lockfile = await import("proper-lockfile");

    // Different profile IDs proceed in parallel.
    const [releaseA, releaseB] = await Promise.all([
      lockfile.lock(lockPathA, { stale: 5000 }),
      lockfile.lock(lockPathB, { stale: 5000 }),
    ]);
    expect(typeof releaseA).toBe("function");
    expect(typeof releaseB).toBe("function");
    await releaseA();
    await releaseB();

    // Same profile ID serializes.
    const release1 = await lockfile.lock(lockPathA, { stale: 5000 });
    let secondAcquired = false;
    const second = lockfile
      .lock(lockPathA, { stale: 5000, retries: { retries: 0 } })
      .then(() => {
        secondAcquired = true;
      })
      .catch(() => {
        /* expected: ELOCKED */
      });
    await second;
    expect(
      secondAcquired,
      "second concurrent acquire on same profile ID must NOT succeed without retries",
    ).toBe(false);
    await release1();
  });

  it("idempotent release: double-release does not throw", async () => {
    // The agent call sites tolerate double-release via the finally{} swallow
    // pattern at session-write-lock.ts:127-131. The FileLockPort.release
    // contract promises ok(undefined) for already-released paths. This test
    // documents that proper-lockfile's RAW double-unlock throws, AND that the
    // FileLockPort's release() (createFileLock from @comis/core) absorbs it
    // idempotently.

    const lockfile = await import("proper-lockfile");
    const { createFileLock } = await import("@comis/core");

    // Sub-case 1: Raw proper-lockfile double-unlock throws.
    const release = await lockfile.lock(lockPath, { stale: 5000 });
    await release();
    let rawThrew = false;
    try {
      await release();
    } catch {
      rawThrew = true;
    }
    expect(
      rawThrew,
      "raw proper-lockfile double-release throws (current agent direct-proper-lockfile behavior)",
    ).toBe(true);

    // Sub-case 2: FileLockPort.release() is idempotent (the port wraps the
    // throw and returns ok(undefined)).
    const port = createFileLock();
    const acq = await port.acquire(lockPath, { staleMs: 5000 });
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const release2 = acq.value;
    await release2();
    // Now ask the port to release again (lock is no longer held).
    const second = await port.release(lockPath);
    expect(
      second.ok,
      "FileLockPort.release MUST be idempotent (double-release returns ok(undefined))",
    ).toBe(true);
  });
});
