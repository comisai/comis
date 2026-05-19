// SPDX-License-Identifier: Apache-2.0
/**
 * Plan 46-02 (CACHE-OBS-03): `parseSince` regression suite.
 *
 * Six cases cover the four supported window shorthands plus the two
 * primary failure modes (bare integer, zero). The regex is bounded
 * (max 5 digits + single unit) — see `parse-since.ts` — so the
 * ReDoS surface is closed at the schema level (RESEARCH §"Security
 * Domain" ReDoS row).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { parseSince } from "./parse-since.js";

describe("parseSince", () => {
  it("parses 1h as 3_600_000 ms", () => {
    expect(parseSince("1h")).toBe(60 * 60 * 1000);
  });

  it("parses 24h as 86_400_000 ms", () => {
    expect(parseSince("24h")).toBe(24 * 60 * 60 * 1000);
  });

  it("parses 7d as 604_800_000 ms", () => {
    expect(parseSince("7d")).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("parses 30d as 2_592_000_000 ms", () => {
    expect(parseSince("30d")).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("rejects bare integer with no unit", () => {
    expect(() => parseSince("24")).toThrow(/Invalid --since value/);
  });

  it("rejects negative or zero values", () => {
    expect(() => parseSince("0h")).toThrow(/Invalid --since value/);
  });
});
