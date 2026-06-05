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
  it("parseArgs([]) → { dry: false, mode: 'all', profile: undefined }", () => {
    const result = parseArgs([]);
    expect(result).toEqual({ dry: false, mode: "all", profile: undefined });
  });

  it("parseArgs(['--dry']) → { dry: true, mode: 'all', profile: undefined }", () => {
    const result = parseArgs(["--dry"]);
    expect(result).toEqual({ dry: true, mode: "all", profile: undefined });
  });

  it("parseArgs(['core']) → { dry: false, mode: 'core', profile: undefined }", () => {
    const result = parseArgs(["core"]);
    expect(result).toEqual({ dry: false, mode: "core", profile: undefined });
  });

  it("parseArgs(['cache', '--dry']) → { dry: true, mode: 'cache', profile: undefined }", () => {
    const result = parseArgs(["cache", "--dry"]);
    expect(result).toEqual({ dry: true, mode: "cache", profile: undefined });
  });

  // WR-02: --profile flag parsing
  it("parseArgs(['--profile', 'lean-cloud']) → profile: 'lean-cloud', mode: 'all'", () => {
    const result = parseArgs(["--profile", "lean-cloud"]);
    expect(result).toEqual({ dry: false, mode: "all", profile: "lean-cloud" });
  });

  it("parseArgs(['core', '--profile', 'privacy-device']) → mode: 'core', profile: 'privacy-device'", () => {
    const result = parseArgs(["core", "--profile", "privacy-device"]);
    expect(result).toEqual({ dry: false, mode: "core", profile: "privacy-device" });
  });

  it("parseArgs(['--dry', '--profile', 'default']) → dry: true, profile: 'default'", () => {
    const result = parseArgs(["--dry", "--profile", "default"]);
    expect(result).toEqual({ dry: true, mode: "all", profile: "default" });
  });

  it("profile value is not treated as a positional mode arg", () => {
    // 'lean-cloud' follows --profile — must not become the mode
    const result = parseArgs(["--profile", "lean-cloud"]);
    expect(result.mode).toBe("all");
    expect(result.profile).toBe("lean-cloud");
  });
});
