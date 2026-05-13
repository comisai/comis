// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { parseComisCapabilityDefensively } from "./capability-parser.js";

function makeLogger() {
  return { warn: vi.fn() };
}

describe("parseComisCapabilityDefensively", () => {
  it("returns undefined silently when raw is undefined (no-op fast path)", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      undefined,
      "no-block-skill",
      logger,
    );
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns parsed shape for a valid capability block", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      {
        cluster: "data-fetching-financial",
        summary: "X",
        replacesPackages: ["a", "b"],
      },
      "valid-skill",
      logger,
    );
    expect(result).toEqual({
      cluster: "data-fetching-financial",
      summary: "X",
      replacesPackages: ["a", "b"],
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns parsed shape for empty input (defaults applied)", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively({}, "empty-skill", logger);
    expect(result?.cluster).toBeUndefined();
    expect(result?.summary).toBeUndefined();
    expect(result?.replacesPackages).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns undefined and logs WARN on a typo'd nested key", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      { replacePackages: ["x"] }, // typo -- missing 's'
      "typo-skill",
      logger,
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "config",
        skillName: "typo-skill",
        hint: expect.stringContaining("comis.capability"),
        issues: expect.any(Array),
      }),
      expect.stringContaining("Malformed comis.capability"),
    );
  });

  it("returns undefined and logs WARN on type mismatch", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      { cluster: 42 },
      "type-mismatch-skill",
      logger,
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
    const callArg = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg.errorKind).toBe("config");
    expect(callArg.skillName).toBe("type-mismatch-skill");
    expect(Array.isArray(callArg.issues)).toBe(true);
  });

  it("returns undefined and logs WARN on empty string violating min(1)", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      { cluster: "" },
      "empty-string-skill",
      logger,
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does NOT throw when logger is undefined (returns undefined silently)", () => {
    expect(() => {
      parseComisCapabilityDefensively({ cluster: 42 }, "no-logger", undefined);
    }).not.toThrow();
    const result = parseComisCapabilityDefensively(
      { cluster: 42 },
      "no-logger",
      undefined,
    );
    expect(result).toBeUndefined();
  });

  it("captures multiple issues in a single WARN log", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      { cluster: 42, summary: 99 },
      "multi-issue-skill",
      logger,
    );
    expect(result).toBeUndefined();
    const callArg = logger.warn.mock.calls[0][0] as Record<string, unknown>;
    const issues = callArg.issues as Array<{ path: string }>;
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("cluster");
    expect(paths).toContain("summary");
  });

  it("returns undefined for non-object input (string)", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(
      "not-an-object",
      "scalar-skill",
      logger,
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns undefined for null input + logs WARN (caller may pass nullish-coerced value)", () => {
    const logger = makeLogger();
    const result = parseComisCapabilityDefensively(null, "null-skill", logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
