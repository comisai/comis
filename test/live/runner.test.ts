// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for runner.ts — parseArgs helper + sweep dispatch contract.
 * Stage-A TDD: all tests fail until runner.ts is created (RED phase).
 * No real provider calls — zero cost tier.
 *
 * @module
 */

import { vi, describe, it, expect } from "vitest";
import { parseArgs } from "./runner.js";

// Module-level mocks (hoisted by Vitest) — must be present before runner.ts
// imports these modules so the sweep dispatch tests can assert on them.
vi.mock("./sweep/sweep.js", () => ({
  runSweep: vi.fn(),
  parseProbeFilter: vi.fn(() => []),
}));
vi.mock("./sweep/gap-report.js", () => ({
  writeGapReport: vi.fn(() => "benchmarks/live/run-123"),
}));

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

  it("parseArgs(['channels']) → { dry: false, mode: 'channels', profile: undefined }", () => {
    const result = parseArgs(["channels"]);
    expect(result).toEqual({ dry: false, mode: "channels", profile: undefined });
  });

  it("parseArgs(['plat']) → { dry: false, mode: 'plat', profile: undefined }", () => {
    const result = parseArgs(["plat"]);
    expect(result).toEqual({ dry: false, mode: "plat", profile: undefined });
  });

  it("parseArgs(['journeys']) → { dry: false, mode: 'journeys', profile: undefined }", () => {
    const result = parseArgs(["journeys"]);
    expect(result).toEqual({ dry: false, mode: "journeys", profile: undefined });
  });

  it("parseArgs(['journeys', '--dry']) → { dry: true, mode: 'journeys', profile: undefined }", () => {
    const result = parseArgs(["journeys", "--dry"]);
    expect(result).toEqual({ dry: true, mode: "journeys", profile: undefined });
  });

  // WR-02: --profile flag parsing
  it("returns profile:'lean-cloud' and mode:'all' when given ['--profile','lean-cloud']", () => {
    const result = parseArgs(["--profile", "lean-cloud"]);
    expect(result).toEqual({ dry: false, mode: "all", profile: "lean-cloud" });
  });

  it("returns mode:'core' and profile:'privacy-device' when given ['core','--profile','privacy-device']", () => {
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

// ---------------------------------------------------------------------------
// runner sweep dispatch contract — Task 1-RED (Phase 135-04)
//
// These tests confirm the structural contract for the sweep mode:
// 1. parseArgs recognises "sweep" as a valid mode (already works)
// 2. The sweep-branch symbols (runSweep, writeGapReport) are importable
//    from the paths that runner.ts will use after Task 1-GREEN
// 3. parseArgs(['sweep', '--dry']) yields dry:true + mode:'sweep'
//
// RED state: runner.ts has no `mode === "sweep"` branch yet.
// The dynamic-import tests pass because Plans 02+03 already created the
// modules. The key RED confirmation is grep returning 0 for "mode === \"sweep\""
// in runner.ts (verified by the plan before this describe block is committed).
// ---------------------------------------------------------------------------

describe("runner sweep dispatch contract", () => {
  it("returns mode:'sweep' when given ['sweep']", () => {
    const result = parseArgs(["sweep"]);
    expect(result.mode).toBe("sweep");
  });

  it("returns mode:'sweep' and dry:true when given ['sweep','--dry']", () => {
    const result = parseArgs(["sweep", "--dry"]);
    expect(result).toEqual({ dry: true, mode: "sweep", profile: undefined });
  });

  it("runSweep is importable from ./sweep/sweep.js and is a function", async () => {
    const { runSweep } = await import("./sweep/sweep.js");
    expect(typeof runSweep).toBe("function");
  });

  it("parseProbeFilter is importable from ./sweep/sweep.js and is a function", async () => {
    const { parseProbeFilter } = await import("./sweep/sweep.js");
    expect(typeof parseProbeFilter).toBe("function");
  });

  it("writeGapReport is importable from ./sweep/gap-report.js and is a function", async () => {
    const { writeGapReport } = await import("./sweep/gap-report.js");
    expect(typeof writeGapReport).toBe("function");
  });
});
