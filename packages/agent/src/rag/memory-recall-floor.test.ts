// SPDX-License-Identifier: Apache-2.0
/**
 * EXACT-numbers tests for the Memory Relevance Floor — the base-score floor
 * gate in the recall pipeline.
 *
 * Contract:
 *   CASE A: base=0.12, boosted_final≈0.20, floor=0.3 → DROPPED (base < floor; boost irrelevant)
 *   CASE B: base=0.40, boosted_final≈0.50, floor=0.3 → SURVIVES (base >= floor)
 *   CASE C: base=0.20, floor=0 → SURVIVES (no floor configured — default behavior unchanged)
 *   CASE D: base=0.30, floor=0.3 → SURVIVES (boundary inclusive: base === floor → include)
 *
 * Filter position: AFTER scoreWithBreakdown() (step 4), BEFORE trust-filter (step 5).
 * Must use breakdownById.get(id)?.base — NOT r.score (which is the boosted value).
 */

import type {
  MemoryPort,
  MemorySearchResult,
  TrustLevel,
  TimerPort,
  TimerHandle,
  ClockPort,
  ComisLogger,
  SessionKey,
} from "@comis/core";
import { ok } from "@comis/shared";
import { describe, it, expect } from "vitest";
import { createMemoryRecall, passesBaseFloor, type MemoryRecallConfig } from "./memory-recall.js";
import type { ScoreBreakdown } from "./score.js";

/** A full breakdown with a chosen base (the other factors are neutral 1.0). */
function breakdownWithBase(base: number): ScoreBreakdown {
  return {
    base,
    recency: 1,
    temporal: 1,
    proof: 1,
    trust: 1,
    usefulness: 1,
    forget: 1,
    final: base,
  } as ScoreBreakdown;
}

const NOW = 1_700_000_000_000;
const SESSION_KEY = "telegram:chat_1:user_a" as unknown as SessionKey;

const DEFAULT_ALPHAS = {
  recencyAlpha: 0.2,
  temporalAlpha: 0.2,
  proofAlpha: 0.1,
  trustAlpha: 0.1,
  usefulnessAlpha: 0.1,
};

const fixedClock: ClockPort = { now: () => NOW } as unknown as ClockPort;

const noopLogger: ComisLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => noopLogger,
} as unknown as ComisLogger;

function fakeTimers(): { port: TimerPort } {
  const port: TimerPort = {
    setTimeout(_cb: () => void): TimerHandle {
      return { cancelled: false, cancel: () => {}, unref: () => {} };
    },
    setInterval(): TimerHandle {
      return { cancelled: false, cancel: () => {}, unref: () => {} };
    },
  };
  return { port };
}

function makeResult(
  id: string,
  opts: {
    trustLevel?: TrustLevel;
    createdAt?: number;
    base?: number;
    content?: string;
  } = {},
): MemorySearchResult {
  const entry: Record<string, unknown> = {
    id,
    tenantId: "default",
    agentId: "default",
    userId: "user_a",
    content: opts.content ?? `content for ${id}`,
    trustLevel: opts.trustLevel ?? "learned",
    source: { who: "agent" },
    tags: [],
    createdAt: opts.createdAt ?? NOW,
  };
  return {
    entry: entry as unknown as MemorySearchResult["entry"],
    score: opts.base ?? 0.5,
  };
}

function fakeMemoryPort(results: MemorySearchResult[]): MemoryPort {
  return {
    async search(_key: SessionKey, _query: string) {
      return ok(results);
    },
  } as unknown as MemoryPort;
}

function baseConfig(overrides: Partial<MemoryRecallConfig> = {}): MemoryRecallConfig {
  return {
    maxResults: 5,
    minScore: 0,
    includeTrustLevels: ["system", "learned"],
    rerank: { mode: "off", maxCandidates: 40, minResults: 1, timeoutMs: 800 },
    scoring: DEFAULT_ALPHAS,
    ...overrides,
  };
}

describe("Memory Relevance Floor — exact-numbers base-score gate", () => {
  // CASE A: base=0.12, floor=0.3 → DROPPED
  // Even though boosts may push the final score above 0.3, the base is below the floor.
  // The floor gates on breakdown.base (pre-boost), NOT on r.score (boosted).
  it("CASE A: base=0.12, floor=0.3 → memory DROPPED (base < floor; boost cannot resurrect)", async () => {
    const input = [
      // base=0.12 — below floor=0.3; should be dropped regardless of boosts
      makeResult("low-base", { base: 0.12, trustLevel: "learned", createdAt: NOW }),
      // base=0.50 — above floor=0.3; should survive as the only result
      makeResult("high-base", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const cfg = baseConfig({
      baseFloor: 0.3,
    } as any);

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: undefined,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      cfg,
    );
    const result = await recall.recall("q", SESSION_KEY, "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).not.toContain("low-base");
    expect(ids).toContain("high-base");
  });

  // CASE B: base=0.40, floor=0.3 → SURVIVES
  it("CASE B: base=0.40, floor=0.3 → memory SURVIVES (base >= floor)", async () => {
    const input = [
      makeResult("above-floor", { base: 0.4, trustLevel: "learned", createdAt: NOW }),
    ];
    const cfg = baseConfig({
      baseFloor: 0.3,
    } as any);

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: undefined,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      cfg,
    );
    const result = await recall.recall("q", SESSION_KEY, "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).toContain("above-floor");
  });

  // CASE C: base=0.20, floor=0 (default) → SURVIVES (no floor = all memories pass)
  it("CASE C: base=0.20, floor=0 (default) → SURVIVES (no floor — default behavior unchanged)", async () => {
    const input = [
      makeResult("no-floor-mem", { base: 0.2, trustLevel: "learned", createdAt: NOW }),
    ];
    // No baseFloor set → default=0 → no filtering
    const cfg = baseConfig();

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: undefined,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      cfg,
    );
    const result = await recall.recall("q", SESSION_KEY, "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).toContain("no-floor-mem");
  });

  // CASE D: base=0.30, floor=0.3 → SURVIVES (boundary inclusive: base === floor → include)
  it("CASE D: base=0.30, floor=0.3 → SURVIVES (boundary: base === floor is inclusive)", async () => {
    const input = [
      makeResult("at-floor", { base: 0.3, trustLevel: "learned", createdAt: NOW }),
    ];
    const cfg = baseConfig({
      baseFloor: 0.3,
    } as any);

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: undefined,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      cfg,
    );
    const result = await recall.recall("q", SESSION_KEY, "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).toContain("at-floor");
  });

  // All 4 cases together: A dropped, B/C/D survive
  it("COMBINED: A(0.12,drop), B(0.40,keep), D(0.30,keep) with floor=0.3", async () => {
    const input = [
      makeResult("case-a", { base: 0.12, trustLevel: "learned", createdAt: NOW }),
      makeResult("case-b", { base: 0.4, trustLevel: "learned", createdAt: NOW }),
      makeResult("case-d", { base: 0.3, trustLevel: "learned", createdAt: NOW }),
    ];
    const cfg = baseConfig({
      baseFloor: 0.3,
    } as any);

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: undefined,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      cfg,
    );
    const result = await recall.recall("q", SESSION_KEY, "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).not.toContain("case-a");   // DROPPED (0.12 < 0.3)
    expect(ids).toContain("case-b");        // SURVIVES (0.40 >= 0.3)
    expect(ids).toContain("case-d");        // SURVIVES (0.30 === 0.3 inclusive)
  });

  // The base-floor decision is FAIL-CLOSED on a missing breakdown.
  // A fallback to `(r.score ?? 0) >= floor` would, on the
  // rerank-applied path, compare the floor against the cross-encoder
  // probability (a different, typically HIGHER scale than breakdown.base) —
  // letting a low-base poisoned memory with an inflated CE score survive the
  // exact filter meant to drop it. A memory with no recorded base is a
  // hard drop (this is a security gate).
  describe("passesBaseFloor is fail-closed on a missing breakdown", () => {
    it("DROPS a memory with NO breakdown (undefined) — cannot be proven above the floor", () => {
      // A score fallback would KEEP this if its (CE-inflated) r.score
      // were >= floor. The gate takes no score fallback at all.
      expect(passesBaseFloor(undefined, 0.3)).toBe(false);
    });

    it("KEEPS a memory whose recorded base is >= floor (boundary inclusive)", () => {
      expect(passesBaseFloor(breakdownWithBase(0.4), 0.3)).toBe(true);
      expect(passesBaseFloor(breakdownWithBase(0.3), 0.3)).toBe(true);
    });

    it("DROPS a memory whose recorded base is < floor, regardless of any boosted final", () => {
      const bd = breakdownWithBase(0.12);
      // Even if the boosted/CE final were inflated above the floor, the gate
      // reads breakdown.base only.
      (bd as { final: number }).final = 0.9;
      expect(passesBaseFloor(bd, 0.3)).toBe(false);
    });
  });

  // The unconfigured-baseFloor fail-open under the arbiter.
  //
  // The hazard: memory-recall.ts gates the filter on `cfg.baseFloor > 0`, so an
  // UNCONFIGURED floor (resolved to 0) silently SKIPS the filter. When the unified
  // arbiter is active (relevanceFirst), it ranks LTM T3/T4 against history — a sub-floor
  // poisoned memory must NOT survive just because the deployment never set a floor
  // (an arbiter that ranks LTM against history needs the floor enforced).
  //
  // Fail-closed scope = ARBITER-ACTIVE (relevanceFirst), NOT global: frontier/mid
  // (recency-first, arbiter off) keep the `> 0` skip → that path is byte-identical.
  describe("unconfigured baseFloor is fail-closed UNDER the arbiter (relevanceFirst)", () => {
    it("relevanceFirst + unconfigured floor (0) DROPS a sub-floor poisoned memory", async () => {
      // base=0.10 < class default 0.15. cfg.baseFloor is 0 (unconfigured — the deployment
      // never set rag.baseFloor). Without the fail-closed resolution the `> 0` gate would
      // skip the filter and the poisoned memory would SURVIVE. With it, relevanceFirst
      // resolves the unconfigured floor to the class default (0.15) and the filter runs
      // → the memory is DROPPED.
      const input = [
        makeResult("poison-low-base", { base: 0.1, trustLevel: "learned", createdAt: NOW }),
        makeResult("legit-high-base", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
      ];
      const cfg = baseConfig({
        baseFloor: 0, // unconfigured — the fail-open trigger
        relevanceFirst: true, // the unified arbiter is active (small/nano)
      } as unknown as Partial<MemoryRecallConfig>);

      const recall = createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          reranker: undefined,
          timers: fakeTimers().port,
          clock: fixedClock,
          logger: noopLogger,
        },
        cfg,
      );
      const result = await recall.recall("q", SESSION_KEY, "default");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.map((r) => r.entry.id);
      // The poisoned sub-floor memory must NOT survive under the active arbiter.
      expect(ids).not.toContain("poison-low-base");
      expect(ids).toContain("legit-high-base");
    });

    it("FRONTIER byte-identical: relevanceFirst OFF + unconfigured floor (0) keeps the sub-floor memory (no filter — recency-first path unchanged)", async () => {
      // The SAME fixture as the drop test above, but relevanceFirst=false (frontier/mid,
      // arbiter off). The unconfigured-floor resolution stays 0 → the `> 0` skip holds →
      // the filter does NOT run → the memory survives. This pins the scope decision: the
      // fail-closed branch is arbiter-scoped, so frontier/mid take the unchanged path.
      const input = [
        makeResult("low-base-kept", { base: 0.1, trustLevel: "learned", createdAt: NOW }),
        makeResult("high-base-kept", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
      ];
      const cfg = baseConfig({
        baseFloor: 0,
        relevanceFirst: false, // arbiter OFF (frontier/mid)
      } as unknown as Partial<MemoryRecallConfig>);

      const recall = createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          reranker: undefined,
          timers: fakeTimers().port,
          clock: fixedClock,
          logger: noopLogger,
        },
        cfg,
      );
      const result = await recall.recall("q", SESSION_KEY, "default");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.map((r) => r.entry.id);
      // Recency-first path unchanged: no floor enforced → BOTH memories survive.
      expect(ids).toContain("low-base-kept");
      expect(ids).toContain("high-base-kept");
    });

    it("EXPLICIT floor still wins under relevanceFirst: an explicit 0.3 drops base=0.2 (operator value > class default)", async () => {
      // The arbiter-active default (0.15) must NEVER override an explicit operator floor.
      const input = [
        makeResult("below-explicit", { base: 0.2, trustLevel: "learned", createdAt: NOW }),
        makeResult("above-explicit", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
      ];
      const cfg = baseConfig({
        baseFloor: 0.3, // explicit operator floor
        relevanceFirst: true,
      } as unknown as Partial<MemoryRecallConfig>);

      const recall = createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          reranker: undefined,
          timers: fakeTimers().port,
          clock: fixedClock,
          logger: noopLogger,
        },
        cfg,
      );
      const result = await recall.recall("q", SESSION_KEY, "default");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.map((r) => r.entry.id);
      expect(ids).not.toContain("below-explicit"); // 0.2 < 0.3 explicit
      expect(ids).toContain("above-explicit");
    });
  });

  // Verify that the filter uses breakdown.base (pre-boost), NOT the boosted r.score.
  // A memory with base=0.12 could get a boosted score above 0.3 (e.g., via recency),
  // but it should still be DROPPED because the floor gates on the RAW base.
  it("floor gates on pre-boost base, NOT on boosted r.score (boost cannot resurrect low-base)", async () => {
    // base=0.12, recent (NOW), so recency factor = 1 + 0.2*(1.0-0.5) = 1.1
    // boosted ≈ 0.12 * 1.1 = 0.132 (still < 0.3, so this test is mainly documenting behavior)
    // In any case, the filter must use breakdown.base (0.12), not r.score (which is 0.12 initially
    // but becomes 0.132 after scoring). Either way, 0.12 < 0.3 → DROPPED.
    const input = [
      makeResult("low-base-fresh", { base: 0.12, trustLevel: "learned", createdAt: NOW }),
    ];
    const cfg = baseConfig({
      baseFloor: 0.3,
    } as any);

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: undefined,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      cfg,
    );
    const result = await recall.recall("q", SESSION_KEY, "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should be empty — low-base memory dropped by floor
    expect(result.value).toHaveLength(0);
  });
});
