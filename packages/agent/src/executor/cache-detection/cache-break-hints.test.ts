// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { lookbackWindowExceededHint } from "./cache-break-hints.js";
import type { BreakpointBudget } from "./cache-state-types.js";

const observedBudget: BreakpointBudget = {
  total: 3,
  system: 1,
  tool: 0,
  message: 1,
  sdkAuto: 1,
  messagePositions: [40],
  sdkAutoPosition: 63,
  messageContentBlocks: 64,
  tailGapBlocks: 23,
};

describe("lookbackWindowExceededHint", () => {
  it("never claims the break is costless or needs no action", () => {
    const hint = lookbackWindowExceededHint(observedBudget);
    expect(hint).not.toMatch(/no action needed/i);
    expect(hint).not.toMatch(/mitigate this\.?\s*$/i);
  });

  it("names the observed marker positions and provider window", () => {
    const hint = lookbackWindowExceededHint(observedBudget);
    expect(hint).toContain("23 content blocks");
    expect(hint).toContain("Comis positions [40]");
    expect(hint).toContain("SDK position 63");
    expect(hint).toContain("provider window of 20");
  });

  it("names where the priced impact of THIS break is recorded", () => {
    const hint = lookbackWindowExceededHint(observedBudget);
    expect(hint).toContain("cache-breaks/");
    expect(hint).toContain("estimatedCostUsd");
    expect(hint).toContain("comis explain");
  });

  it("provides separate actions for tool-heavy turns and missing recent markers", () => {
    const hint = lookbackWindowExceededHint(observedBudget);
    expect(hint).toContain("reduce its tool round-trips");
    expect(hint).toContain("investigate cache breakpoint placement");
  });

  it("degrades honestly when the detector could not observe marker topology", () => {
    const hint = lookbackWindowExceededHint(undefined);
    expect(hint).toContain("unavailable number");
    expect(hint).not.toContain("undefined");
  });
});
