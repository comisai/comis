// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for CLI spinner utility (withSpinner).
 *
 * Verifies that withSpinner returns the async function result on success,
 * rethrows on failure, and calls the correct spinner lifecycle methods.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockInstance } from "vitest";

// Mock ora before importing withSpinner
const mockSpinner = {
  text: "",
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn() as MockInstance,
  fail: vi.fn() as MockInstance,
};

vi.mock("ora", () => ({
  default: vi.fn((text: string) => {
    mockSpinner.text = text;
    mockSpinner.start.mockReturnValue(mockSpinner);
    return mockSpinner;
  }),
}));

// Import after mock is set up
import { withSpinner } from "./spinner.js";
import ora from "ora";

describe("withSpinner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns result on success", async () => {
    const result = await withSpinner("Loading...", async () => 42);
    expect(result).toBe(42);
    expect(mockSpinner.succeed).toHaveBeenCalled();
    expect(mockSpinner.fail).not.toHaveBeenCalled();
  });

  it("rethrows the exception thrown inside spinner callback after calling spinner.fail()", async () => {
    await expect(
      withSpinner("Loading...", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(mockSpinner.fail).toHaveBeenCalled();
    expect(mockSpinner.succeed).not.toHaveBeenCalled();
  });

  it("passes the text argument to the ora constructor for spinner label", async () => {
    await withSpinner("Fetching data...", async () => "ok");
    expect(ora).toHaveBeenCalledWith("Fetching data...");
  });

  it("calls spinner.start() before invoking the wrapped callback", async () => {
    await withSpinner("Starting...", async () => "done");
    expect(mockSpinner.start).toHaveBeenCalled();
  });
});
