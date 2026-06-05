// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for runner.ts — parseArgs helper.
 * Stage-A TDD: all tests fail until runner.ts is created (RED phase).
 * No real provider calls — zero cost tier.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { parseArgs } from "./runner.js";

describe("parseArgs", () => {
  it("parseArgs([]) → { dry: false, mode: 'all' }", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ dry: false, mode: "all" });
  });

  it("parseArgs(['--dry']) → { dry: true, mode: 'all' }", () => {
    const result = parseArgs(["--dry"]);
    expect(result).toEqual({ dry: true, mode: "all" });
  });

  it("parseArgs(['core']) → { dry: false, mode: 'core' }", () => {
    const result = parseArgs(["core"]);
    expect(result).toEqual({ dry: false, mode: "core" });
  });

  it("parseArgs(['cache', '--dry']) → { dry: true, mode: 'cache' }", () => {
    const result = parseArgs(["cache", "--dry"]);
    expect(result).toEqual({ dry: true, mode: "cache" });
  });
});
