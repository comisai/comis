// SPDX-License-Identifier: Apache-2.0
/**
 * @module file-mutation-queue.test
 * Tests for per-path file mutation serialization.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  withFileMutationQueue,
  _clearMutationQueuesForTest,
} from "./file-mutation-queue.js";

afterEach(() => {
  _clearMutationQueuesForTest();
});

describe("withFileMutationQueue", () => {
  it("serializes concurrent calls with the same path", async () => {
    const order: number[] = [];
    const path = "/tmp/test-serial-same-path.txt";

    const first = withFileMutationQueue(path, async () => {
      await delay(50);
      order.push(1);
      return "first";
    });

    const second = withFileMutationQueue(path, async () => {
      order.push(2);
      return "second";
    });

    const [r1, r2] = await Promise.all([first, second]);

    expect(order).toEqual([1, 2]);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
  });

  it("runs concurrent calls with different paths in parallel", async () => {
    const pathA = "/tmp/test-parallel-a.txt";
    const pathB = "/tmp/test-parallel-b.txt";

    const start = Date.now();

    const a = withFileMutationQueue(pathA, async () => {
      await delay(50);
      return "a";
    });

    const b = withFileMutationQueue(pathB, async () => {
      await delay(50);
      return "b";
    });

    const [rA, rB] = await Promise.all([a, b]);
    const elapsed = Date.now() - start;

    expect(rA).toBe("a");
    expect(rB).toBe("b");
    // Both should complete in ~50ms (parallel), not ~100ms (serial)
    expect(elapsed).toBeLessThan(90);
  });

  it("recovers after a failed write (second call still executes)", async () => {
    const path = "/tmp/test-error-recovery.txt";

    const first = withFileMutationQueue(path, async () => {
      throw new Error("write failed");
    });

    // First call should reject
    await expect(first).rejects.toThrow("write failed");

    // Second call to same path should still work
    const result = await withFileMutationQueue(path, async () => {
      return "recovered";
    });

    expect(result).toBe("recovered");
  });

  it("cleans up queue map entry after operation completes", async () => {
    const path = "/tmp/test-cleanup.txt";

    await withFileMutationQueue(path, async () => "done");

    // After completion, clearing should be a no-op (nothing to clear)
    // We verify cleanup indirectly: a new call should not wait for anything
    const start = Date.now();
    await withFileMutationQueue(path, async () => "second");
    const elapsed = Date.now() - start;

    // Should be nearly instant (no queuing)
    expect(elapsed).toBeLessThan(20);
  });

  it("works with non-existent file paths (uses raw path as key)", async () => {
    const path = "/nonexistent/path/to/file.txt";

    // Should not throw - uses raw path since realpath would fail
    const result = await withFileMutationQueue(path, async () => "ok");
    expect(result).toBe("ok");
  });

  it("_clearMutationQueuesForTest clears all entries", async () => {
    const pathA = "/tmp/test-clear-a.txt";
    const pathB = "/tmp/test-clear-b.txt";

    // Start two long-running operations
    const opA = withFileMutationQueue(pathA, async () => {
      await delay(100);
      return "a";
    });

    const opB = withFileMutationQueue(pathB, async () => {
      await delay(100);
      return "b";
    });

    // Clear while operations are in flight
    _clearMutationQueuesForTest();

    // Wait for operations to complete
    await Promise.all([opA, opB]);

    // After clearing + completion, new operations should not be queued behind old ones
    const start = Date.now();
    const result = await withFileMutationQueue(pathA, async () => "fresh");
    const elapsed = Date.now() - start;

    expect(result).toBe("fresh");
    expect(elapsed).toBeLessThan(20);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
