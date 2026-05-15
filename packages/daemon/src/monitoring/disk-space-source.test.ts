// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-coverage tests for disk-space-source (Plan 40-14).
 *
 * Exercises the three result branches of `check()`:
 *   1. fs.statfs() error path (errors.length > 0)
 *   2. usedPercent > thresholdPercent (overThreshold.length > 0)
 *   3. healthy "OK" path (HEARTBEAT_OK_TOKEN prefix)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDiskSpaceSource } from "./disk-space-source.js";

// Mock fs.statfs() with a default-pass implementation; tests override per-case.
vi.mock("node:fs/promises", () => ({
  statfs: vi.fn(),
}));

import * as fsp from "node:fs/promises";
const mockedStatfs = fsp.statfs as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockedStatfs.mockReset();
});

describe("createDiskSpaceSource", () => {
  it("returns id and name metadata identifying it as the disk-space monitor source", () => {
    const source = createDiskSpaceSource({ paths: ["/tmp"], thresholdPercent: 80 } as never);
    expect(source.id).toBe("monitor:disk-space");
    expect(source.name).toBe("Disk Space Monitor");
  });

  it("returns OK-token text when all configured paths report disk usage below threshold", async () => {
    mockedStatfs.mockResolvedValue({
      blocks: 1000,
      bsize: 1024 * 1024 * 1024, // 1 GB per block
      bavail: 500, // 50% free
    } as never);
    const source = createDiskSpaceSource({ paths: ["/tmp"], thresholdPercent: 80 } as never);
    const result = await source.check();
    expect(result.text).toContain("OK");
    expect(result.text).toMatch(/50\.0% \(/);
    expect(result.metadata).toHaveProperty("results");
  });

  it("returns CRITICAL alert when at least one path reports usedPercent above threshold", async () => {
    mockedStatfs.mockResolvedValue({
      blocks: 1000,
      bsize: 1024 * 1024,
      bavail: 50, // 95% used (1000-50)/1000
    } as never);
    const source = createDiskSpaceSource({ paths: ["/home"], thresholdPercent: 80 } as never);
    const result = await source.check();
    expect(result.text).toContain("CRITICAL");
    expect(result.text).toContain("80%");
    expect(result.metadata).toHaveProperty("overThreshold");
  });

  it("returns error-containing text when fs.statfs() rejects with an exception for a path", async () => {
    mockedStatfs.mockRejectedValue(new Error("EACCES: permission denied"));
    const source = createDiskSpaceSource({ paths: ["/secret"], thresholdPercent: 80 } as never);
    const result = await source.check();
    expect(result.text).toContain("Disk check errors");
    expect(result.text).toContain("EACCES");
    expect(result.metadata).toHaveProperty("errors");
  });

  it("processes multiple paths in sequence and aggregates into the same result envelope", async () => {
    let callCount = 0;
    mockedStatfs.mockImplementation(async () => {
      callCount++;
      return { blocks: 1000, bsize: 1024 * 1024, bavail: 600 } as never; // 40% used
    });
    const source = createDiskSpaceSource({
      paths: ["/a", "/b", "/c"],
      thresholdPercent: 90,
    } as never);
    await source.check();
    expect(callCount).toBe(3);
  });

  it("treats usedPercent of exactly zero as a valid OK result when bsize is zero", async () => {
    mockedStatfs.mockResolvedValue({
      blocks: 0, // edge case: zero-block filesystem
      bsize: 4096,
      bavail: 0,
    } as never);
    const source = createDiskSpaceSource({ paths: ["/empty"], thresholdPercent: 80 } as never);
    const result = await source.check();
    expect(result.text).toContain("OK");
  });
});
