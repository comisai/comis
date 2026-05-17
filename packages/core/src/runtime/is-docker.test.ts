// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `isDocker()` runtime probe with cgroup fallback.
 *
 * Mocks `node:fs.existsSync` AND `readFileSync` so we can drive both probe
 * branches deterministically:
 *
 *   1. Marker-file probe — Docker creates `/.dockerenv` at PID 1's filesystem
 *      root for standard images.
 *   2. Cgroup probe — fallback for rootless / minimal images that lack
 *      `/.dockerenv`. We match `\b(docker|containerd|kubepods)\b` against
 *      `/proc/1/cgroup` contents.
 *
 * Two-probe form: either probe returning a positive signal → `isDocker()`
 * returns true. Both negative or throwing → false.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("isDocker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns true when /.dockerenv exists", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: (p: string) => p === "/.dockerenv",
      readFileSync: () => "",
    }));
    const { isDocker } = await import("./is-docker.js");
    expect(isDocker()).toBe(true);
  });

  it("returns true when cgroup matches docker|containerd|kubepods", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: (p: string) =>
        p === "/proc/1/cgroup" ? "0::/docker/abc123" : "",
    }));
    const { isDocker } = await import("./is-docker.js");
    expect(isDocker()).toBe(true);
  });

  it("returns false when neither probe matches", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: () => "0::/user.slice/user-1000.slice",
    }));
    const { isDocker } = await import("./is-docker.js");
    expect(isDocker()).toBe(false);
  });

  it("returns false when both probes throw", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: () => {
        throw new Error("EACCES");
      },
      readFileSync: () => {
        throw new Error("ENOENT");
      },
    }));
    const { isDocker } = await import("./is-docker.js");
    expect(isDocker()).toBe(false);
  });
});
