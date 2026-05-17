// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for mergeSessionStats — SDK session-stats delegation helper.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { mergeSessionStats } from "./session-stats.js";

describe("mergeSessionStats", () => {
  it("overrides token totals from SDK stats", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280, cacheRead: 30, cacheWrite: 10 },
    }));
    expect(result.tokensUsed).toEqual({ input: 200, output: 80, total: 280, cacheRead: 30, cacheWrite: 10 });
  });

  it("preserves cost from bridge (not SDK)", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.05, cacheSaved: 0.01 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280 },
    }));
    expect(result.cost).toEqual({ total: 0.05, cacheSaved: 0.01 });
  });

  it("handles missing getSessionStats gracefully", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, undefined);
    expect(result.tokensUsed.input).toBe(100);
  });

  it("handles getSessionStats throwing gracefully", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => { throw new Error("boom"); });
    expect(result.tokensUsed.input).toBe(100);
  });

  it("uses bridge cacheRead/cacheWrite when SDK values are undefined", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280 },
    }));
    expect(result.tokensUsed.cacheRead).toBe(10);
    expect(result.tokensUsed.cacheWrite).toBe(5);
  });
});
