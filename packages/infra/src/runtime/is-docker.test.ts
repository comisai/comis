// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `isDocker()` runtime probe.
 *
 * Mocks `node:fs.existsSync` so we can drive the three branches deterministically:
 * marker-file present, marker-file absent, and probe-throws (defensive path).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from "node:fs";
import { isDocker } from "./is-docker.js";

describe("isDocker()", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it("returns true when /.dockerenv exists", () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === "/.dockerenv");
    expect(isDocker()).toBe(true);
    expect(existsSync).toHaveBeenCalledWith("/.dockerenv");
  });

  it("returns false when /.dockerenv is absent", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(isDocker()).toBe(false);
  });

  it("returns false when the probe throws (defensive)", () => {
    vi.mocked(existsSync).mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(isDocker()).toBe(false);
  });
});
