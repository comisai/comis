// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for shared types and constants in safe-path-wrapper.
 *
 * Covers: LazyPaths, resolvePaths, SafePathLogger, PROTECTED_WORKSPACE_FILES.
 */

import { describe, it, expect } from "vitest";
import {
  resolvePaths,
  PROTECTED_WORKSPACE_FILES,
  type LazyPaths,
  type SafePathLogger,
} from "./safe-path-wrapper.js";

describe("resolvePaths", () => {
  it("returns empty array for undefined input", () => {
    expect(resolvePaths(undefined)).toEqual([]);
  });

  it("returns empty array for null-ish input", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolvePaths(null as any)).toEqual([]);
  });

  it("returns static string array as-is", () => {
    const paths: LazyPaths = ["a", "b"];
    expect(resolvePaths(paths)).toEqual(["a", "b"]);
  });

  it("invokes callback and returns result for lazy paths", () => {
    const paths: LazyPaths = () => ["lazy"];
    expect(resolvePaths(paths)).toEqual(["lazy"]);
  });

  it("returns empty array for empty static array", () => {
    expect(resolvePaths([])).toEqual([]);
  });

  it("returns empty array for callback returning empty array", () => {
    expect(resolvePaths(() => [])).toEqual([]);
  });
});

describe("PROTECTED_WORKSPACE_FILES", () => {
  it("has 2 entries", () => {
    expect(PROTECTED_WORKSPACE_FILES.size).toBe(2);
  });

  it("maps AGENTS.md to ROLE.md", () => {
    expect(PROTECTED_WORKSPACE_FILES.get("AGENTS.md")).toBe("ROLE.md");
  });

  it("maps SOUL.md to ROLE.md", () => {
    expect(PROTECTED_WORKSPACE_FILES.get("SOUL.md")).toBe("ROLE.md");
  });
});

describe("SafePathLogger type", () => {
  it("accepts an object with warn and optional debug methods", () => {
    // Type assertion -- confirms SafePathLogger interface exports correctly
    const logger: SafePathLogger = {
      warn: (_obj: Record<string, unknown>, _msg: string) => {},
      debug: (_obj: Record<string, unknown>, _msg: string) => {},
    };
    expect(logger.warn).toBeDefined();
    expect(logger.debug).toBeDefined();
  });

  it("accepts an object with warn only (debug is optional)", () => {
    const logger: SafePathLogger = {
      warn: (_obj: Record<string, unknown>, _msg: string) => {},
    };
    expect(logger.warn).toBeDefined();
    expect(logger.debug).toBeUndefined();
  });
});
