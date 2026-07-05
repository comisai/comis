// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for mergeSessionStats — SDK session-stats delegation helper.
 *
 * Scope contract (the reconciliation fix): `result.tokensUsed` is the
 * PER-EXECUTION total the bridge accumulated (matching `result.cost`, which is
 * also per-execution). The SDK's `getSessionStats()` is CUMULATIVE across every
 * execution on the persisted session, so it must NOT overwrite the
 * per-execution field — it populates the separate `sessionTokensUsed`. Writing
 * the cumulative value onto `tokensUsed` made the per-execution `Execution
 * complete` log line and the per-delivery obs row report a session-cumulative
 * token total next to a per-execution cost (observed live: a 4-execution
 * session's rows showed monotonic 26k→109k→264k→297k tokens against
 * non-monotonic per-execution costs), and made cross-session-sender's
 * per-turn `+= tokensUsed.total` double-count.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { mergeSessionStats } from "./session-stats.js";

describe("mergeSessionStats", () => {
  it("leaves the per-execution tokensUsed intact and records the SDK cumulative on sessionTokensUsed", () => {
    const result: {
      tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
      cost: { total: number; cacheSaved: number };
      sessionTokensUsed?: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
    } = {
      tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    // SDK cumulative (this execution + all prior on the session).
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280, cacheRead: 30, cacheWrite: 10 },
    }));
    // Per-execution stays the bridge value (scope-consistent with cost).
    expect(result.tokensUsed).toEqual({ input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 });
    // Cumulative rides the distinct session field.
    expect(result.sessionTokensUsed).toEqual({ input: 200, output: 80, total: 280, cacheRead: 30, cacheWrite: 10 });
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

  it("handles missing getSessionStats gracefully (no sessionTokensUsed written)", () => {
    const result: {
      tokensUsed: { input: number; output: number; total: number };
      cost: { total: number; cacheSaved: number };
      sessionTokensUsed?: unknown;
    } = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, undefined);
    expect(result.tokensUsed.input).toBe(100);
    expect(result.sessionTokensUsed).toBeUndefined();
  });

  it("handles getSessionStats throwing gracefully", () => {
    const result = {
      tokensUsed: { input: 100, output: 50, total: 150 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => { throw new Error("boom"); });
    expect(result.tokensUsed.input).toBe(100);
  });

  it("falls back to the per-execution cacheRead/cacheWrite on sessionTokensUsed when SDK omits them", () => {
    const result: {
      tokensUsed: { input: number; output: number; total: number; cacheRead?: number; cacheWrite?: number };
      cost: { total: number; cacheSaved: number };
      sessionTokensUsed?: { cacheRead?: number; cacheWrite?: number };
    } = {
      tokensUsed: { input: 100, output: 50, total: 150, cacheRead: 10, cacheWrite: 5 },
      cost: { total: 0.01, cacheSaved: 0 },
    };
    mergeSessionStats(result, () => ({
      tokens: { input: 200, output: 80, total: 280 },
    }));
    expect(result.sessionTokensUsed?.cacheRead).toBe(10);
    expect(result.sessionTokensUsed?.cacheWrite).toBe(5);
  });
});
