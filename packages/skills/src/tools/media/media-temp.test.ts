// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMediaTempManager } from "./media-temp.js";
import type { MediaTempManager, MediaTempLogger } from "./media-temp.js";

let testBaseDir: string;
let manager: MediaTempManager;
let logger: MediaTempLogger;

function mockLogger(): MediaTempLogger {
  return {
    debug: vi.fn(),
    error: vi.fn(),
  };
}

beforeEach(async () => {
  testBaseDir = await fs.mkdtemp(os.tmpdir() + "/comis-test-");
  logger = mockLogger();
  manager = createMediaTempManager({ baseDir: testBaseDir, ttlMs: 1_800_000 }, logger);
});

afterEach(async () => {
  manager.stopCleanupInterval();
  await fs.rm(testBaseDir, { recursive: true, force: true });
});

describe("init", () => {
  it("creates managed directory with comis-media- prefix", async () => {
    const result = await manager.init();

    expect(result.ok).toBe(true);
    const dir = manager.getManagedDir();
    expect(dir).toBeDefined();
    expect(dir!).toContain("comis-media-");

    // Directory should actually exist on disk
    const stat = await fs.stat(dir!);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("createTempPath", () => {
  it("generates unique paths within managed dir", async () => {
    await manager.init();

    const path1 = manager.createTempPath(".ogg");
    const path2 = manager.createTempPath(".ogg");

    expect(path1).not.toBe(path2);
    expect(path1.startsWith(manager.getManagedDir()!)).toBe(true);
    expect(path2.startsWith(manager.getManagedDir()!)).toBe(true);
  });

  it("applies suffix correctly", async () => {
    await manager.init();

    const p = manager.createTempPath(".ogg");
    expect(p.endsWith(".ogg")).toBe(true);
  });

  it("throws when not initialized", () => {
    expect(() => manager.createTempPath(".ogg")).toThrow("not initialized");
  });
});

describe("cleanup", () => {
  it("removes files older than TTL", async () => {
    // Use a very short TTL
    const shortTtl = createMediaTempManager(
      { baseDir: testBaseDir, ttlMs: 100 },
      logger,
    );
    await shortTtl.init();

    const filePath = shortTtl.createTempPath(".tmp");
    await fs.writeFile(filePath, "stale-content");

    // Backdate the file mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 7_200_000);
    await fs.utimes(filePath, twoHoursAgo, twoHoursAgo);

    const result = await shortTtl.cleanup();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(1);

    // File should be gone
    await expect(fs.stat(filePath)).rejects.toThrow();

    shortTtl.stopCleanupInterval();
  });

  it("preserves files newer than TTL", async () => {
    await manager.init();

    const filePath = manager.createTempPath(".tmp");
    await fs.writeFile(filePath, "fresh-content");

    const result = await manager.cleanup();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);

    // File should still exist
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
  });

  it("returns ok(0) when not initialized", async () => {
    // Do not call init
    const result = await manager.cleanup();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);
  });

  it("returns ok(0) when managed dir is deleted (ENOENT)", async () => {
    const enoentLogger = mockLogger();
    const enoentManager = createMediaTempManager(
      { baseDir: testBaseDir, ttlMs: 1 },
      enoentLogger,
    );

    await enoentManager.init();
    const dir = enoentManager.getManagedDir()!;

    // Remove the managed dir entirely -- readdir gets ENOENT
    await fs.rm(dir, { recursive: true, force: true });

    const result = await enoentManager.cleanup();

    // ENOENT is graceful -- returns ok(0), no error log
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(0);
    expect(enoentLogger.error).not.toHaveBeenCalled();

    enoentManager.stopCleanupInterval();
  });

  it("logs at ERROR on filesystem failure", async () => {
    const errorLogger = mockLogger();
    const errorManager = createMediaTempManager(
      { baseDir: testBaseDir, ttlMs: 1 },
      errorLogger,
    );

    await errorManager.init();
    const dir = errorManager.getManagedDir()!;

    // Replace the managed directory with a file to cause ENOTDIR on readdir
    await fs.rm(dir, { recursive: true, force: true });
    await fs.writeFile(dir, "not-a-directory");

    const result = await errorManager.cleanup();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // logger.error should have been called with hint and errorKind
    expect(errorLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("cleanup failed"),
        errorKind: "resource",
      }),
      "Media temp cleanup failed",
    );

    // Clean up the file we created in place of the dir
    await fs.unlink(dir).catch(() => {});

    errorManager.stopCleanupInterval();
  });
});

describe("remove", () => {
  it("deletes a specific file", async () => {
    await manager.init();

    const filePath = manager.createTempPath(".ogg");
    await fs.writeFile(filePath, "audio-data");

    // Confirm it exists
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);

    const result = await manager.remove(filePath);
    expect(result.ok).toBe(true);

    // File should be gone
    await expect(fs.stat(filePath)).rejects.toThrow();
  });

  it("succeeds silently for nonexistent file", async () => {
    const result = await manager.remove("/tmp/does-not-exist-" + Date.now());
    expect(result.ok).toBe(true);
  });
});

describe("cleanup interval", () => {
  it("stopCleanupInterval stops the timer without errors", async () => {
    await manager.init();

    manager.startCleanupInterval();
    manager.stopCleanupInterval();

    // Calling stop again should be a no-op
    manager.stopCleanupInterval();
  });
});
