// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { lookbackWindowExceededHint } from "./cache-break-hints.js";

describe("lookbackWindowExceededHint", () => {
  // Live incident (comis-moshe 2026-07-26): FOUR `lookback_window_exceeded`
  // breaks in one 27-minute session, priced at $1.17–$1.33 each ($5.16 of the
  // session's $8.59 cache waste) — every one of them logged
  // "Multi-zone breakpoints mitigate this. No action needed."
  it("never claims the break is costless or needs no action", () => {
    const hint = lookbackWindowExceededHint(79);
    expect(hint).not.toMatch(/no action needed/i);
    expect(hint).not.toMatch(/mitigate this\.?\s*$/i);
  });

  it("names the knob(s) an operator can actually turn", () => {
    const hint = lookbackWindowExceededHint(79);
    expect(hint).toContain("contextEngine.contextThreshold");
    expect(hint).toContain("contextEngine.freshTailTurns");
  });

  it("names where the priced impact of THIS break is recorded", () => {
    const hint = lookbackWindowExceededHint(79);
    expect(hint).toContain("cache-breaks/");
    expect(hint).toContain("estimatedCostUsd");
    expect(hint).toContain("system-health");
  });

  it("states the BLOCK-count cause with the observed count (why compaction cannot help)", () => {
    expect(lookbackWindowExceededHint(79)).toContain("79 blocks");
    expect(lookbackWindowExceededHint(79)).toMatch(/block count/i);
  });

  it("degrades honestly when the detector could not count blocks", () => {
    const hint = lookbackWindowExceededHint(undefined);
    expect(hint).toContain("the conversation");
    expect(hint).not.toContain("undefined");
  });
});
