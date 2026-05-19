// SPDX-License-Identifier: Apache-2.0
/**
 * `CacheStatsWindow` Type ⇄ schema sync invariant.
 *
 * Four cases:
 *   1. `expectTypeOf` proves the inferred type of `CacheStatsWindowSchema`
 *      equals the exported `CacheStatsWindow` type (compile-time).
 *   2. Schema accepts a minimal zero-totals window.
 *   3. Schema rejects negative token counts.
 *   4. Schema accepts breakdowns with provider+model composite key.
 *
 * Mirrors `system-prompt-report/types.test.ts`.
 *
 * @module
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { z } from "zod";
import {
  CacheStatsWindowSchema,
  type CacheStatsWindow,
} from "./types.js";

describe("CacheStatsWindow — type ⇄ schema sync invariant", () => {
  it("CacheStatsWindow Type is identical to z.infer<typeof CacheStatsWindowSchema>", () => {
    type Inferred = z.infer<typeof CacheStatsWindowSchema>;
    expectTypeOf<Inferred>().toEqualTypeOf<CacheStatsWindow>();
  });

  it("schema accepts a minimal window with zero totals", () => {
    const w = CacheStatsWindowSchema.parse({
      sinceMs: 1_700_000_000_000,
      untilMs: 1_700_000_086_400,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      nonCachedInputTokens: 0,
      outputTokens: 0,
      turns: 0,
      cacheHitRate: 0,
      cacheWriteRate: 0,
      byProvider: [],
      byModel: [],
      byAgent: [],
    });
    expect(w.turns).toBe(0);
    expect(w.cacheHitRate).toBe(0);
  });

  it("schema rejects negative token counts", () => {
    expect(() =>
      CacheStatsWindowSchema.parse({
        sinceMs: 0,
        untilMs: 0,
        cacheReadTokens: -1,
        cacheCreationTokens: 0,
        nonCachedInputTokens: 0,
        outputTokens: 0,
        turns: 0,
        cacheHitRate: 0,
        cacheWriteRate: 0,
        byProvider: [],
        byModel: [],
        byAgent: [],
      }),
    ).toThrow();
  });

  it("schema accepts breakdowns with provider+model composite key", () => {
    const w = CacheStatsWindowSchema.parse({
      sinceMs: 0,
      untilMs: 0,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      nonCachedInputTokens: 25,
      outputTokens: 10,
      turns: 1,
      cacheHitRate: 0.57,
      cacheWriteRate: 0.28,
      byProvider: [
        {
          provider: "anthropic",
          cacheReadTokens: 100,
          cacheCreationTokens: 50,
          nonCachedInputTokens: 25,
          outputTokens: 10,
          turns: 1,
          cacheHitRate: 0.57,
          cacheWriteRate: 0.28,
        },
      ],
      byModel: [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          cacheReadTokens: 100,
          cacheCreationTokens: 50,
          nonCachedInputTokens: 25,
          outputTokens: 10,
          turns: 1,
          cacheHitRate: 0.57,
          cacheWriteRate: 0.28,
        },
      ],
      byAgent: [
        {
          agentId: "agent-1",
          cacheReadTokens: 100,
          cacheCreationTokens: 50,
          nonCachedInputTokens: 25,
          outputTokens: 10,
          turns: 1,
          cacheHitRate: 0.57,
          cacheWriteRate: 0.28,
        },
      ],
    });
    expect(w.byProvider[0]?.provider).toBe("anthropic");
    expect(w.byModel[0]?.model).toBe("claude-sonnet-4-5");
    expect(w.byAgent[0]?.agentId).toBe("agent-1");
  });
});
