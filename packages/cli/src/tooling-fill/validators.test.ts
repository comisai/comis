// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for tooling-fill/validators.ts.
 *
 * Covers:
 * - TOOLFILL-7: PACKAGE_NAME_REGEX must match the SPEC literal
 *   /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/i exactly.
 * - validatePackageNames partitions into valid/dropped, dedupes, preserves
 *   original case, drops non-strings.
 * - TOOLFILL-5 / D-4: isStubValued returns true iff
 *   description ∈ {missing, "", "TODO"} AND replacesPackages ∈ {missing, []}.
 */

import { describe, it, expect } from "vitest";
import {
  PACKAGE_NAME_REGEX,
  validatePackageNames,
  isStubValued,
} from "./validators.js";

describe("PACKAGE_NAME_REGEX (TOOLFILL-7)", () => {
  it("matches the canonical npm/pip name shapes", () => {
    expect(PACKAGE_NAME_REGEX.test("yfinance")).toBe(true);
    expect(PACKAGE_NAME_REGEX.test("@scope/pkg")).toBe(true);
    expect(PACKAGE_NAME_REGEX.test("pandas-datareader")).toBe(true);
    expect(PACKAGE_NAME_REGEX.test("yfinance.cache")).toBe(true);
    expect(PACKAGE_NAME_REGEX.test("Pillow")).toBe(true);
  });

  it("rejects shell-injection-shaped and otherwise malformed names", () => {
    expect(PACKAGE_NAME_REGEX.test("; rm -rf /")).toBe(false);
    expect(PACKAGE_NAME_REGEX.test("eval()")).toBe(false);
    expect(PACKAGE_NAME_REGEX.test("package with spaces")).toBe(false);
    expect(PACKAGE_NAME_REGEX.test("")).toBe(false);
    expect(PACKAGE_NAME_REGEX.test("-leading-dash")).toBe(false);
    expect(PACKAGE_NAME_REGEX.test("@/no-name")).toBe(false);
  });
});

describe("validatePackageNames", () => {
  it("partitions valid and dropped names", () => {
    const result = validatePackageNames([
      "yfinance",
      "; rm -rf /",
      "@scope/p",
      "bad name",
    ]);
    expect(result.valid).toEqual(["yfinance", "@scope/p"]);
    expect(result.dropped).toEqual(["; rm -rf /", "bad name"]);
  });

  it("deduplicates valid names (first-occurrence-wins)", () => {
    const result = validatePackageNames(["a", "a", "b", "a"]);
    expect(result.valid).toEqual(["a", "b"]);
    expect(result.dropped).toEqual([]);
  });

  it("preserves original case (no normalization)", () => {
    const result = validatePackageNames(["YFinance", "Pillow"]);
    expect(result.valid).toEqual(["YFinance", "Pillow"]);
    expect(result.dropped).toEqual([]);
  });

  it("drops non-string inputs as a defense-in-depth measure", () => {
    const result = validatePackageNames([1, null, undefined, "yfinance"]);
    expect(result.valid).toEqual(["yfinance"]);
    // The non-string inputs are stringified so the operator can log them.
    expect(result.dropped).toEqual(["1", "null", "undefined"]);
  });

  it("returns empty arrays for empty input", () => {
    const result = validatePackageNames([]);
    expect(result.valid).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});

describe("isStubValued (TOOLFILL-5 / D-4)", () => {
  it("returns true for an empty hint object (both fields missing)", () => {
    expect(isStubValued({})).toBe(true);
  });

  it("returns true when only description='TODO' (replacesPackages missing)", () => {
    expect(isStubValued({ description: "TODO" })).toBe(true);
  });

  it("returns true for the canonical Phase 25 stub shape", () => {
    expect(
      isStubValued({ description: "TODO", replacesPackages: [] }),
    ).toBe(true);
  });

  it("returns true when description is the empty string and replaces is []", () => {
    expect(
      isStubValued({ description: "", replacesPackages: [] }),
    ).toBe(true);
  });

  it("returns false when description is operator-authored (non-stub)", () => {
    expect(
      isStubValued({
        description: "real description",
        replacesPackages: [],
      }),
    ).toBe(false);
  });

  it("returns false when replacesPackages is operator-authored (non-stub)", () => {
    expect(
      isStubValued({ description: "TODO", replacesPackages: ["a"] }),
    ).toBe(false);
  });

  it("returns false when both fields are operator-authored", () => {
    expect(
      isStubValued({
        description: "real",
        replacesPackages: ["a"],
      }),
    ).toBe(false);
  });
});
