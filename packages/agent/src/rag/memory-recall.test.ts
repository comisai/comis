// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createMemoryRecall — the single recall orchestrator composing
 * search -> fuse -> rerank -> score -> trust-filter -> dedup (RANK-01/03/06/07/08).
 *
 * Load-bearing RED-first assertions:
 * - DEFAULT-OFF CHARACTERIZATION (no-regression pin): with rerank.enabled=false,
 *   recall yields the SAME order as the documented inline reference computation
 *   (single-lane fuse = identity -> score boosts -> trust-filter -> dedup).
 * - Trust filter: results whose trustLevel ∉ includeTrustLevels are dropped.
 * - Dedup: two same-content entries collapse to one.
 * - Graceful degrade (RANK-03): reranker.isAvailable()===false -> fused order, ok, non-empty.
 * - Rerank applied (RANK-01): a mock reranker inverting fused order -> top result is the
 *   highest-CE-scored candidate.
 * - Timeout fallback (RANK-08): a never-resolving rank + fake TimerPort firing the
 *   deadline -> fused order + WARN errorKind:"timeout".
 * - Trust tie-break (RANK-06): at equal reranked relevance, system outranks learned/external.
 * - Cap: maxCandidates=2 with 5 candidates -> exactly 2 docs reach reranker.rank; tail keeps
 *   fused order.
 *
 * `nowMs` is injected via deps.clock.now(); the timeout uses deps.timers (TimerPort),
 * never the global setTimeout.
 */

import type {
  MemoryPort,
  MemorySearchResult,
  MemorySearchOptions,
  RerankerPort,
  SessionKey,
  TrustLevel,
  TimerPort,
  TimerHandle,
  ClockPort,
  ComisLogger,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { fuse } from "./fuse.js";
import { score, type ScoringAlphas } from "./score.js";
import { deduplicateResults } from "./rag-retriever.js";
import { createMemoryRecall, type MemoryRecallConfig } from "./memory-recall.js";

const NOW = 1_700_000_000_000;
const SESSION_KEY = "telegram:chat_1:user_a" as unknown as SessionKey;

const DEFAULT_ALPHAS: ScoringAlphas = {
  recencyAlpha: 0.2,
  temporalAlpha: 0.2,
  proofAlpha: 0.1,
  trustAlpha: 0.1,
};

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

/** A MemoryPort whose search() returns a fixed result set; records the options it saw. */
function fakeMemoryPort(
  results: MemorySearchResult[],
  capture?: { opts?: MemorySearchOptions },
): MemoryPort {
  return {
    async search(_key: SessionKey, _query: string, opts?: MemorySearchOptions) {
      if (capture) capture.opts = opts;
      return ok(results);
    },
  } as unknown as MemoryPort;
}

/** A MemoryPort whose search() returns an err. */
function failingMemoryPort(): MemoryPort {
  return {
    async search() {
      return err(new Error("search exploded"));
    },
  } as unknown as MemoryPort;
}

/** Controllable reranker mock. */
function mockReranker(opts: {
  available?: boolean;
  rank?: (query: string, docs: string[]) => Promise<Result<number[], Error>>;
}): { port: RerankerPort; calls: { docs: string[] }[] } {
  const calls: { docs: string[] }[] = [];
  const port: RerankerPort = {
    isAvailable: () => opts.available ?? true,
    async rank(query: string, docs: string[]) {
      calls.push({ docs });
      if (opts.rank) return opts.rank(query, docs);
      // default: identity scores descending so order is unchanged
      return ok(docs.map((_d, i) => 1 - i * 0.01));
    },
  };
  return { port, calls };
}

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

/**
 * A controllable fake TimerPort. setTimeout records the callback; the test fires
 * pending timers manually so the deadline is deterministic (no real time passes).
 */
function fakeTimers(): { port: TimerPort; fireAll: () => void; pending: number } {
  const cbs: Array<() => void> = [];
  const port: TimerPort = {
    setTimeout(cb: () => void): TimerHandle {
      const idx = cbs.push(cb) - 1;
      return {
        cancelled: false,
        cancel: () => {
          cbs[idx] = () => {};
        },
        unref: () => {},
      };
    },
    setInterval(): TimerHandle {
      return { cancelled: false, cancel: () => {}, unref: () => {} };
    },
  };
  return {
    port,
    fireAll: () => {
      for (const cb of cbs.slice()) cb();
    },
    get pending() {
      return cbs.length;
    },
  };
}

function baseConfig(overrides: Partial<MemoryRecallConfig> = {}): MemoryRecallConfig {
  return {
    maxResults: 5,
    minScore: 0.1,
    includeTrustLevels: ["system", "learned"],
    rerank: { enabled: false, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
    scoring: DEFAULT_ALPHAS,
    ...overrides,
  };
}

describe("createMemoryRecall — orchestrator composition", () => {
  it("DEFAULT-OFF CHARACTERIZATION: rerank off yields the documented inline order (single-lane fuse + score + trust-filter + dedup). Intended (boosts now applied), NOT a regression.", async () => {
    // Representative input: mixed trust, varied recency, distinct content.
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", createdAt: NOW - 10 * 86_400_000 }),
      makeResult("b", { base: 0.6, trustLevel: "system", createdAt: NOW - 1 * 86_400_000 }),
      makeResult("c", { base: 0.3, trustLevel: "external", createdAt: NOW }),
    ];
    const cfg = baseConfig();

    // Reference computation = exactly the documented pipeline with rerank off:
    //   single-lane fuse (identity-by-rank) -> score(boosts) -> trust-filter -> dedup.
    const fused = fuse([{ results: input, weight: 1.0 }]);
    const scored = score(fused, cfg.scoring, NOW);
    const allowed = new Set<TrustLevel>(cfg.includeTrustLevels);
    const filtered = scored.filter((r) => allowed.has(r.entry.trustLevel));
    const expected = deduplicateResults(filtered).map((r) => r.entry.id);

    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: undefined, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      cfg,
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(expected);
    // external (c) excluded by includeTrustLevels default; a + b survive.
    expect(got.value.map((r) => r.entry.id)).not.toContain("c");
  });

  it("ME-01: a weak top hit (adapter score < 0.7) stays below the inline gate on the default path (single-lane fuse pass-through, not rank-ramped to ≈1.0)", async () => {
    // Pre-fix, single-lane fuse rebuilt the score from rank → the top hit became
    // ≈1.0 and (after the default 0.2 recency / 0.1 trust boosts) sat WELL above the
    // injector's 0.7 inlineMinScore, force-promoting a genuinely weak hit to inline
    // injection. Post-fix the adapter score (0.42) passes through; the only boost on
    // a same-`createdAt` learned hit is recency = 1 + 0.2*(1.0-0.5) = 1.1, so the
    // boosted top score is 0.42*1.1 ≈ 0.462 — still below 0.7, i.e. NOT inlined.
    const input = [
      makeResult("weakTop", { base: 0.42, trustLevel: "learned", createdAt: NOW }),
      makeResult("weaker", { base: 0.2, trustLevel: "learned", createdAt: NOW }),
    ];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig(),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const topScore = got.value[0]?.score ?? 0;
    // The recall output feeds createHybridMemoryInjector (inlineMinScore=0.7);
    // a sub-0.7 top score means the hit goes to the system prompt, NOT inline.
    expect(topScore).toBeLessThan(0.7);
    expect(topScore).toBeCloseTo(0.42 * 1.1, 6);
  });

  it("propagates a search error (early-return) without throwing", async () => {
    const recall = createMemoryRecall(
      { memoryPort: failingMemoryPort(), clock: fixedClock, logger: noopLogger },
      baseConfig(),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(false);
  });

  it("trust filter: drops results outside includeTrustLevels", async () => {
    const input = [
      makeResult("sys", { trustLevel: "system" }),
      makeResult("ext", { trustLevel: "external" }),
    ];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig({ includeTrustLevels: ["system"] }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    expect(ids).toContain("sys");
    expect(ids).not.toContain("ext");
  });

  it("dedup: two same-content entries collapse to one result", async () => {
    const input = [
      makeResult("dup1", { content: "identical body", createdAt: NOW - 86_400_000 }),
      makeResult("dup2", { content: "identical body", createdAt: NOW }),
    ];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig(),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.length).toBe(1);
  });

  it("RANK-03 graceful degrade: reranker isAvailable()===false -> fused order, ok, non-empty (no error)", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.6 }),
      makeResult("c", { base: 0.3 }),
    ];
    const { port, calls } = mockReranker({ available: false });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      baseConfig({ rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 } }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.length).toBe(3);
    // reranker never invoked because isAvailable() is false
    expect(calls.length).toBe(0);
    // fused order preserved (a > b > c by base score)
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
  });

  it("RANK-01 rerank applied: a reranker INVERTING fused order makes the last fused candidate the top result", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.6 }),
      makeResult("c", { base: 0.3 }),
    ];
    // Invert: give the LAST doc the highest CE score.
    const { port, calls } = mockReranker({
      rank: async (_q, docs) => ok(docs.map((_d, i) => i)), // ascending: last doc wins
    });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      // turn trust/recency boosts off so the CE inversion is unambiguous
      baseConfig({
        rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(1);
    // fused order was [a,b,c]; CE inverted -> c first.
    expect(got.value[0]?.entry.id).toBe("c");
  });

  it("RANK-08 timeout fallback: a never-resolving rank + fired deadline -> fused order + WARN errorKind:timeout", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.6 }),
    ];
    const timers = fakeTimers();
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as unknown as ComisLogger;
    // rank never resolves -> the timeout must win.
    const { port } = mockReranker({ rank: () => new Promise<Result<number[], Error>>(() => {}) });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: timers.port, clock: fixedClock, logger },
      baseConfig({
        rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 50 },
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      }),
    );
    const promise = recall.recall("q", SESSION_KEY);
    // let the rank() promise register, then fire the deadline.
    await Promise.resolve();
    expect(timers.pending).toBeGreaterThan(0);
    timers.fireAll();
    const got = await promise;
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // fused order preserved on timeout
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b"]);
    // WARN with errorKind:"timeout"
    expect(warn).toHaveBeenCalled();
    const warnArg = warn.mock.calls.find((c) => (c[0] as { errorKind?: string })?.errorKind === "timeout");
    expect(warnArg).toBeDefined();
  });

  it("RANK-06 trust tie-break: at EQUAL reranked relevance, system outranks learned/external", async () => {
    const input = [
      makeResult("learned", { trustLevel: "learned", base: 0.5 }),
      makeResult("system", { trustLevel: "system", base: 0.5 }),
    ];
    // reranker returns IDENTICAL scores -> score()'s trust tie-break decides.
    const { port } = mockReranker({ rank: async (_q, docs) => ok(docs.map(() => 0.5)) });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      baseConfig({
        includeTrustLevels: ["system", "learned"],
        rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        // recency neutral (equal createdAt); trust boost on so system wins.
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0.1 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value[0]?.entry.id).toBe("system");
  });

  it("cap: maxCandidates=2 with 5 candidates sends exactly 2 docs to reranker.rank; tail keeps fused order", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.8 }),
      makeResult("c", { base: 0.7 }),
      makeResult("d", { base: 0.6 }),
      makeResult("e", { base: 0.5 }),
    ];
    const { port, calls } = mockReranker({
      // keep pool order (identity scores descending)
      rank: async (_q, docs) => ok(docs.map((_d, i) => 1 - i * 0.01)),
    });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      baseConfig({
        rerank: { enabled: true, maxCandidates: 2, minResults: 1, timeoutMs: 800 },
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // exactly maxCandidates docs were reranked
    expect(calls.length).toBe(1);
    expect(calls[0]?.docs.length).toBe(2);
    // tail (c,d,e) keeps fused order after the reranked pool (a,b)
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("HI-01 scale-mismatch: a LOW absolute CE pool score still precedes the higher-fused-score tail (no global re-sort across scales)", async () => {
    // 5 candidates, pool=top-2. The reranker scores the pool with LOW absolute CE
    // probabilities ([0.3, 0.2]) — BELOW the tail's fused-by-rank scores (rank 3/4/5 at
    // k=60 ≈ 0.968/0.953/0.938). Pre-fix, the orchestrator concatenated the CE-scored
    // pool with the RRF-scored tail and ran a GLOBAL score() re-sort, so the tail
    // (≈0.95+) leapfrogged the reranked pool (≤0.3) — silently undoing the rerank.
    // The reranked pool MUST still occupy the head: the cross-encoder judged a/b the
    // most relevant of the pool, and the contract is pool-before-tail, always.
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.8 }),
      makeResult("c", { base: 0.7 }),
      makeResult("d", { base: 0.6 }),
      makeResult("e", { base: 0.5 }),
    ];
    const { port, calls } = mockReranker({
      // LOW absolute CE scores for the pool (below the tail's fused-rank scores).
      rank: async (_q, docs) => ok(docs.map((_d, i) => (i === 0 ? 0.3 : 0.2))),
    });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      baseConfig({
        rerank: { enabled: true, maxCandidates: 2, minResults: 1, timeoutMs: 800 },
        // boosts off so the pool-before-tail partition is the only thing under test.
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(1);
    // The reranked pool (a,b — by CE score 0.3 > 0.2) precedes the fused tail (c,d,e).
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("LO-01: when deps.timers is undefined, rerank is SKIPPED entirely (degrade to fused order; reranker.rank is never called → no unbounded hang)", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.6 }),
      makeResult("c", { base: 0.3 }),
    ];
    // A reranker that would HANG forever if invoked. With no timers there is no
    // deadline, so invoking it would block recall indefinitely (RANK-08 cannot
    // fire). The fix is to skip rerank when timers is absent, NOT to await an
    // unbounded rank(). The hang is proven impossible by asserting rank is never
    // called AND that recall resolves to fused order.
    const { port, calls } = mockReranker({
      rank: () => new Promise<Result<number[], Error>>(() => {}), // never resolves
    });
    const recall = createMemoryRecall(
      // NOTE: timers omitted entirely.
      { memoryPort: fakeMemoryPort(input), reranker: port, clock: fixedClock, logger: noopLogger },
      baseConfig({
        rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // rerank skipped — the hanging rank() was never invoked.
    expect(calls.length).toBe(0);
    // degraded to fused order.
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
  });

  it("LO-02: equal CE scores inside the reranked pool keep a deterministic (original pool index) order", async () => {
    // All pool docs share the SAME CE score and the SAME trust level, so neither the
    // CE-primary key nor score()'s trust tie-break can decide their relative order.
    // Without an explicit secondary key the order is left to sort happenstance; the
    // fix pins it to the original pool (fused) index, so the output equals the input
    // order [a,b,c] deterministically.
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", createdAt: NOW }),
      makeResult("b", { base: 0.8, trustLevel: "learned", createdAt: NOW }),
      makeResult("c", { base: 0.7, trustLevel: "learned", createdAt: NOW }),
    ];
    const { port } = mockReranker({
      // identical CE score for every pool doc
      rank: async (_q, docs) => ok(docs.map(() => 0.5)),
    });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      baseConfig({
        rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        // boosts off → boosted score is exactly the CE score, so the ONLY thing that
        // can order the equal-CE/equal-trust pool is the explicit index tie-break.
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b", "c"]);
  });

  it("overfetch: with rerank ENABLED, search limit = max(maxResults, maxCandidates)", async () => {
    const capture: { opts?: MemorySearchOptions } = {};
    const input = [makeResult("a")];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input, capture), reranker: mockReranker({}).port, timers: fakeTimers().port, clock: fixedClock, logger: noopLogger },
      baseConfig({ maxResults: 5, rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 } }),
    );
    await recall.recall("q", SESSION_KEY);
    expect(capture.opts?.limit).toBe(40);
  });

  it("overfetch: with rerank OFF, search limit = maxResults (default pool size unchanged)", async () => {
    const capture: { opts?: MemorySearchOptions } = {};
    const input = [makeResult("a")];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input, capture), clock: fixedClock, logger: noopLogger },
      baseConfig({ maxResults: 5 }),
    );
    await recall.recall("q", SESSION_KEY);
    expect(capture.opts?.limit).toBe(5);
  });
});
