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
  MemoryEntityStore,
  MemoryTemporalStore,
  MemoryUsefulnessStore,
  UsefulnessSignal,
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
  usefulnessAlpha: 0.1,
};

function makeResult(
  id: string,
  opts: {
    trustLevel?: TrustLevel;
    createdAt?: number;
    base?: number;
    content?: string;
    occurredAt?: number;
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
    // The temporal lane seeds on entry.occurredAt — set it only when provided so the
    // no-seed gate (occurredAt absent on every top hit) is exercisable (Pitfall 6).
    ...(opts.occurredAt !== undefined ? { occurredAt: opts.occurredAt } : {}),
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

/**
 * A real SessionKey object (NOT the string-cast SESSION_KEY) so the entity-lane
 * scope (sessionKey.tenantId) is a meaningful value the lane call can be asserted on.
 */
const SESSION_KEY_OBJ = {
  tenantId: "tenant_x",
  userId: "user_a",
  channelId: "chat_1",
} as unknown as SessionKey;

/**
 * A controllable MemoryEntityStore stub. `associativeLane` returns a canned Result
 * and records every call (seedIds + scope + cap) so scope/lazy-call invariants are
 * assertable. `resolveAndLink` is the unused write-path half (recall never calls it).
 */
function fakeEntityStore(
  laneResult: Result<MemorySearchResult[], Error>,
): {
  store: MemoryEntityStore;
  calls: { seedIds: string[]; scope: { tenantId: string; agentId: string }; cap: number }[];
} {
  const calls: { seedIds: string[]; scope: { tenantId: string; agentId: string }; cap: number }[] = [];
  const store: MemoryEntityStore = {
    async resolveAndLink() {
      return ok("entity_id");
    },
    async associativeLane(seedIds, scope, cap) {
      calls.push({ seedIds, scope, cap });
      return laneResult;
    },
  };
  return { store, calls };
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

  it("TEMP-03 NON-DESTRUCTIVE: two CONFLICTING memories about the same subject BOTH survive recall (no write-time deletion of older facts)", async () => {
    // Distinct content (so the 200-char dedup fingerprint does NOT collapse them) but
    // contradictory about the same subject. Recall resolves contradictions at READ time
    // (the §7.3 guidance block, injected at prompt-assembly) — it NEVER deletes, supersedes,
    // or filters the older conflicting fact. Both ids must remain in the recall result.
    const input = [
      makeResult("m1", { content: "user_a owns a horse named Bella", createdAt: NOW - 30 * 86_400_000 }),
      makeResult("m2", { content: "user_a sold the horse last month", createdAt: NOW }),
    ];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig(),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    expect(ids).toContain("m1"); // older conflicting fact NOT dropped
    expect(ids).toContain("m2"); // newer fact present
    expect(got.value.length).toBe(2); // both live — non-destructive
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0.1, usefulnessAlpha: 0 },
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
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
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
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

describe("createMemoryRecall — entity associative lane (ENT-02/ENT-04)", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) is what orders the
  // output — the entity-lane RRF contribution is then the only thing under test.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const ENABLED_LANE = { enabled: true, seedCount: 5, perEntityCap: 200, weight: 1.0 };
  const DISABLED_LANE = { enabled: false, seedCount: 5, perEntityCap: 200, weight: 1.0 };

  /**
   * Reference: the pre-Phase-83 single-lane fused output (no entity lane) — exactly
   * what the disabled / no-seed / err paths must reproduce verbatim (ENT-04).
   */
  function singleLaneReference(input: MemorySearchResult[]): string[] {
    const fused = fuse([{ results: input, weight: 1.0 }]);
    const scored = score(fused, NEUTRAL, NOW);
    const allowed = new Set<TrustLevel>(["system", "learned"]);
    return deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map(
      (r) => r.entry.id,
    );
  }

  it("ENT-02: a shared-entity memory (from the lane, absent from search) OUTRANKS a non-sharing weak search hit after fusion", async () => {
    // Search lane: a strong seed + a WEAK non-sharing hit. Without the lane, single-lane
    // fuse is pass-through → order is [seed, nonSharing] and `shared` is absent entirely.
    const input = [
      makeResult("seed", { base: 0.9, trustLevel: "learned", createdAt: NOW }),
      makeResult("nonSharing", { base: 0.2, trustLevel: "learned", createdAt: NOW }),
    ];
    // The entity lane returns ONE shared-entity memory NOT in the search lane, rank-1.
    // Multi-lane RRF: shared = 1/(60+1) ties the seed and BEATS nonSharing = 1/(60+2).
    const { store, calls } = fakeEntityStore(
      ok([makeResult("shared", { base: 0.99, trustLevel: "learned", createdAt: NOW })]),
    );

    // Baseline (no lane) ranks nonSharing above shared (shared not present at all).
    const baselineIds = singleLaneReference(input);
    expect(baselineIds).toEqual(["seed", "nonSharing"]);
    expect(baselineIds).not.toContain("shared");

    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        entityStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, entityLane: ENABLED_LANE } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    // The lane flipped it in: shared is present AND outranks the non-sharing weak hit.
    expect(ids).toContain("shared");
    expect(ids.indexOf("shared")).toBeLessThan(ids.indexOf("nonSharing"));
    // Lane invoked once, lazily, with the seed ids (top seedCount), the recall scope, and cap.
    expect(calls.length).toBe(1);
    expect(calls[0]?.seedIds).toEqual(["seed", "nonSharing"]);
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
    expect(calls[0]?.cap).toBe(200);
  });

  it("ENT-02 seedCount: only the top `seedCount` search hits seed the lane", async () => {
    const input = [
      makeResult("s1", { base: 0.9 }),
      makeResult("s2", { base: 0.8 }),
      makeResult("s3", { base: 0.7 }),
    ];
    const { store, calls } = fakeEntityStore(ok([]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        entityStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        entityLane: { ...ENABLED_LANE, seedCount: 2 },
      } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(calls.length).toBe(1);
    // only the top 2 hits seed the lane
    expect(calls[0]?.seedIds).toEqual(["s1", "s2"]);
  });

  it("ENT-04 disabled: entityLane.enabled=false -> lane NOT called, output identical to single-lane fuse", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.4 }),
    ];
    // Lane would return a memory IF called — proving the disabled guard, not an empty lane.
    const { store, calls } = fakeEntityStore(ok([makeResult("shared", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        entityStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, entityLane: DISABLED_LANE } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0); // lane never invoked when disabled
    expect(got.value.map((r) => r.entry.id)).toEqual(singleLaneReference(input));
  });

  it("ENT-04 no entityStore: an undefined store -> no lane, output identical to single-lane fuse", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.4 }),
    ];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig({ scoring: NEUTRAL, entityLane: ENABLED_LANE } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(singleLaneReference(input));
  });

  it("ENT-04 no seeds: search returned nothing -> associativeLane NOT called (no empty-seed query)", async () => {
    const { store, calls } = fakeEntityStore(ok([makeResult("shared", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort([]),
        entityStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, entityLane: ENABLED_LANE } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0); // no seeds -> lane never invoked
    expect(got.value).toEqual([]);
  });

  it("ENT-04 empty lane: associativeLane returns ok([]) -> no 2nd lane pushed, output identical to single-lane fuse", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.4 }),
    ];
    const { store, calls } = fakeEntityStore(ok([])); // no shared entities
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        entityStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, entityLane: ENABLED_LANE } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(1); // lane WAS queried (seeds existed)
    // but it returned empty -> single-lane fuse, unchanged.
    expect(got.value.map((r) => r.entry.id)).toEqual(singleLaneReference(input));
  });

  it("ENT-04 err-fallback NON-FATAL: associativeLane err -> WARN(errorKind+hint) + fall back to search lane only (recall succeeds)", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.4 }),
    ];
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as unknown as ComisLogger;
    const { store } = fakeEntityStore(err(new Error("lane self-join exploded")));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        entityStore: store,
        clock: fixedClock,
        logger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, entityLane: ENABLED_LANE } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    // recall NEVER fails because the entity lane failed.
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // fell back to the search lane only -> single-lane fuse, unchanged.
    expect(got.value.map((r) => r.entry.id)).toEqual(singleLaneReference(input));
    // WARN with a structured errorKind + hint.
    expect(warn).toHaveBeenCalled();
    const warnArg = warn.mock.calls.find(
      (c) => typeof (c[0] as { errorKind?: string })?.errorKind === "string" && (c[0] as { hint?: string })?.hint,
    );
    expect(warnArg).toBeDefined();
  });
});

describe("createMemoryRecall — usefulness signal read-path (FEED-03)", () => {
  // Boosts neutralized EXCEPT usefulnessAlpha so the usefulness factor is the only thing
  // that can reorder the output — the read-path effect is then isolated.
  const USEFULNESS_ONLY = {
    recencyAlpha: 0,
    temporalAlpha: 0,
    proofAlpha: 0,
    trustAlpha: 0,
    usefulnessAlpha: 0.1,
  };
  const FLAG_ON = { enabled: true };
  const FLAG_OFF = { enabled: false };

  /**
   * A controllable MemoryUsefulnessStore stub. `readUsefulness` returns a canned Result and
   * records every call (ids + scope). `recordUsage` is the unused write-path half.
   */
  function fakeUsefulnessStore(readResult: Result<Map<string, UsefulnessSignal>, Error>): {
    store: MemoryUsefulnessStore;
    readUsefulness: ReturnType<typeof vi.fn>;
  } {
    const readUsefulness = vi.fn(async () => readResult);
    const store = {
      async recordUsage() {
        return ok(undefined);
      },
      readUsefulness,
    } as unknown as MemoryUsefulnessStore;
    return { store, readUsefulness };
  }

  it("flag ON + store present + results: readUsefulness called once with the ranked ids + (tenant, agent) scope", async () => {
    const input = [
      makeResult("m1", { base: 0.9, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.4, trustLevel: "learned", createdAt: NOW }),
    ];
    const { store, readUsefulness } = fakeUsefulnessStore(
      ok(new Map([["m1", { usedCount: 3, ignoredCount: 0 }]])),
    );
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: USEFULNESS_ONLY, feedback: FLAG_ON } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Read once, with the fused ranked ids and the recall scope.
    expect(readUsefulness).toHaveBeenCalledTimes(1);
    const [ids, scope] = readUsefulness.mock.calls[0] as [string[], { tenantId: string; agentId: string }];
    expect([...ids].sort()).toEqual(["m1", "m2"]);
    expect(scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
  });

  it("flag ON: a proven-useful memory ranks ABOVE its base-only position when relevance is close", async () => {
    // m2 has a marginally lower base than m1 but is proven-useful (used-rate 1.0); m1 is
    // recalled-but-ignored (used-rate 0.0). With only usefulnessAlpha live and a close base
    // gap, the usefulness factor flips m2 above m1.
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const { store } = fakeUsefulnessStore(
      ok(
        new Map<string, UsefulnessSignal>([
          ["m1", { usedCount: 0, ignoredCount: 5 }],
          ["m2", { usedCount: 5, ignoredCount: 0 }],
        ]),
      ),
    );
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: USEFULNESS_ONLY, feedback: FLAG_ON } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    expect(ids.indexOf("m2")).toBeLessThan(ids.indexOf("m1"));
  });

  it("flag OFF: readUsefulness NOT called; output byte-identical to the no-usefulness path", async () => {
    const input = [
      makeResult("m1", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    // If consulted, this map would flip m2 above m1 — proving the OFF guard, not an empty read.
    const { store, readUsefulness } = fakeUsefulnessStore(
      ok(new Map<string, UsefulnessSignal>([["m2", { usedCount: 9, ignoredCount: 0 }]])),
    );
    // Reference: the same pipeline with usefulnessAlpha live but NO signal (factor neutral).
    const fused = fuse([{ results: input, weight: 1.0 }]);
    const scored = score(fused, USEFULNESS_ONLY, NOW); // no usefulnessById -> neutral
    const allowed = new Set<TrustLevel>(["system", "learned"]);
    const expected = deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map(
      (r) => r.entry.id,
    );
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: USEFULNESS_ONLY, feedback: FLAG_OFF } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(readUsefulness).not.toHaveBeenCalled();
    expect(got.value.map((r) => r.entry.id)).toEqual(expected);
  });

  it("no usefulnessStore: an undefined store -> read obviously not done, neutral (no flip)", async () => {
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig({ scoring: USEFULNESS_ONLY, feedback: FLAG_ON } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // No store -> neutral factor -> base order preserved (m1 > m2).
    const ids = got.value.map((r) => r.entry.id);
    expect(ids).toEqual(["m1", "m2"]);
  });

  it("failed read NON-FATAL: readUsefulness err -> WARN(errorKind+hint) + rank WITHOUT the signal (recall succeeds)", async () => {
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as unknown as ComisLogger;
    // The store would flip m2 above m1 IF the read succeeded — but it errs.
    const { store } = fakeUsefulnessStore(err(new Error("usefulness read exploded")));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: USEFULNESS_ONLY, feedback: FLAG_ON } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    // recall NEVER fails because the usefulness read failed.
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Ranked WITHOUT the signal -> neutral -> base order preserved (m1 > m2).
    expect(got.value.map((r) => r.entry.id)).toEqual(["m1", "m2"]);
    // WARN with a structured errorKind + hint.
    expect(warn).toHaveBeenCalled();
    const warnArg = warn.mock.calls.find(
      (c) => typeof (c[0] as { errorKind?: string })?.errorKind === "string" && (c[0] as { hint?: string })?.hint,
    );
    expect(warnArg).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Plan 03 — recall-trace capture + memory:recalled/reranked emit + vec→FTS signal
// ---------------------------------------------------------------------------

/** A recording RecallTrace spy: captures every recordRecall payload. */
function recordingRecallTrace(): {
  recallTrace: { recordRecall: (r: Record<string, unknown>) => "queued" | "dropped" };
  records: Record<string, unknown>[];
} {
  const records: Record<string, unknown>[] = [];
  return {
    recallTrace: {
      recordRecall(r: Record<string, unknown>) {
        records.push(r);
        return "queued";
      },
    },
    records,
  };
}

/** A minimal eventBus spy capturing emit(event, payload) pairs. */
function recordingEventBus(): {
  eventBus: { emit: (event: string, payload: Record<string, unknown>) => void };
  emits: { event: string; payload: Record<string, unknown> }[];
} {
  const emits: { event: string; payload: Record<string, unknown> }[] = [];
  return {
    eventBus: {
      emit(event: string, payload: Record<string, unknown>) {
        emits.push({ event, payload });
      },
    },
    emits,
  };
}

/** Type-erasing deps builder so the test can inject recallTrace/eventBus before the type ships. */
function recallWithObs(
  deps: Record<string, unknown>,
  cfg: MemoryRecallConfig,
): ReturnType<typeof createMemoryRecall> {
  return createMemoryRecall(deps as unknown as Parameters<typeof createMemoryRecall>[0], cfg);
}

describe("createMemoryRecall — recall-trace capture (OBS-01)", () => {
  it("writes exactly ONE recordRecall per recall carrying lanes, fusedOrder, rerank.outcome, and ranked[] with id+reason+breakdown", async () => {
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", createdAt: NOW }),
      makeResult("b", { base: 0.6, trustLevel: "system", createdAt: NOW }),
    ];
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger, recallTrace },
      baseConfig(),
    );
    const got = await recall.recall("what is the plan", SESSION_KEY, "agent_z");
    expect(got.ok).toBe(true);
    // exactly one record per recall.
    expect(records.length).toBe(1);
    const rec = records[0] as {
      lanes?: { fts?: number; vector?: number; entity?: number };
      fusedOrder?: string[];
      rerank?: { outcome?: string };
      ranked?: Array<{ id?: string; reason?: string; breakdown?: { final?: number } }>;
      durationMs?: number;
    };
    // lanes carries per-lane candidate counts.
    expect(rec.lanes?.fts).toBe(2);
    expect(typeof rec.lanes?.vector).toBe("number");
    expect(rec.lanes?.entity).toBe(0);
    // fusedOrder is the post-fuse id order.
    expect(rec.fusedOrder).toEqual(["a", "b"]);
    // rerank outcome is a closed-union value (rerank off → fell_back).
    expect(["ran", "fell_back", "timed_out"]).toContain(rec.rerank?.outcome);
    // ranked[] explains each survivor with id + reason + breakdown.
    expect(rec.ranked?.length).toBeGreaterThan(0);
    for (const entry of rec.ranked ?? []) {
      expect(typeof entry.id).toBe("string");
      expect(["included", "trust_filtered", "deduped", "below_budget"]).toContain(entry.reason);
    }
    const included = (rec.ranked ?? []).filter((e) => e.reason === "included");
    expect(included.length).toBeGreaterThan(0);
    expect(typeof included[0]?.breakdown?.final).toBe("number");
    expect(typeof rec.durationMs).toBe("number");
  });

  it("DEFAULT-OFF: with recallTrace absent, recall output is byte-identical to today and no record is written (optional-dep no-op path)", async () => {
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", createdAt: NOW - 10 * 86_400_000 }),
      makeResult("b", { base: 0.6, trustLevel: "system", createdAt: NOW - 1 * 86_400_000 }),
      makeResult("c", { base: 0.3, trustLevel: "external", createdAt: NOW }),
    ];
    const cfg = baseConfig();
    // Reference = the documented default pipeline (unchanged from pre-Plan-03).
    const fused = fuse([{ results: input, weight: 1.0 }]);
    const scored = score(fused, cfg.scoring, NOW);
    const allowed = new Set<TrustLevel>(cfg.includeTrustLevels);
    const expected = deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map(
      (r) => r.entry.id,
    );
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      cfg,
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(expected);
  });

  it("records trust-filtered AND deduped memories in ranked[] with the correct exclude reason (the trace explains the exclusion)", async () => {
    const input = [
      makeResult("keep", { content: "alpha", base: 0.9, trustLevel: "system", createdAt: NOW }),
      makeResult("dropTrust", { content: "beta", base: 0.8, trustLevel: "external", createdAt: NOW }),
      makeResult("dupA", { content: "same body", base: 0.7, trustLevel: "system", createdAt: NOW - 86_400_000 }),
      makeResult("dupB", { content: "same body", base: 0.6, trustLevel: "system", createdAt: NOW }),
    ];
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger, recallTrace },
      baseConfig({ includeTrustLevels: ["system", "learned"] }),
    );
    await recall.recall("q", SESSION_KEY, "agent_z");
    const rec = records[0] as { ranked?: Array<{ id: string; reason: string }> };
    const byId = new Map((rec.ranked ?? []).map((e) => [e.id, e.reason]));
    // external memory excluded by the trust filter — present in the trace with the reason.
    expect(byId.get("dropTrust")).toBe("trust_filtered");
    // a near-duplicate is recorded with reason "deduped" (one of dupA/dupB is dropped).
    const dedupedReasons = (rec.ranked ?? []).filter((e) => e.reason === "deduped");
    expect(dedupedReasons.length).toBeGreaterThan(0);
  });

  it("records the query as a DIGEST (hex fingerprint), never the raw query text", async () => {
    const input = [makeResult("a", { base: 0.5 })];
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger, recallTrace },
      baseConfig(),
    );
    const rawQuery = "my secret query about project apollo";
    await recall.recall(rawQuery, SESSION_KEY, "agent_z");
    const rec = records[0] as { queryDigest?: string };
    expect(typeof rec.queryDigest).toBe("string");
    // the recorded value is NOT the raw query and looks like a hex digest.
    expect(rec.queryDigest).not.toBe(rawQuery);
    expect(rec.queryDigest).not.toContain("apollo");
    expect(rec.queryDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createMemoryRecall — memory:recalled / memory:reranked emit (OBS-04)", () => {
  it("emits memory:recalled once with a counts-only payload (no query text / memory body)", async () => {
    const input = [
      makeResult("a", { base: 0.9, content: "sensitive body text" }),
      makeResult("b", { base: 0.6 }),
    ];
    const { eventBus, emits } = recordingEventBus();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger, eventBus },
      baseConfig(),
    );
    await recall.recall("the raw query", SESSION_KEY, "agent_z");
    const recalled = emits.filter((e) => e.event === "memory:recalled");
    expect(recalled.length).toBe(1);
    const p = recalled[0]?.payload as Record<string, unknown>;
    expect(typeof p.ftsCandidates).toBe("number");
    expect(typeof p.vectorCandidates).toBe("number");
    expect(typeof p.entityCandidates).toBe("number");
    expect(typeof p.finalCount).toBe("number");
    expect(typeof p.rerankerAvailable).toBe("boolean");
    expect(typeof p.durationMs).toBe("number");
    expect(p.agentId).toBe("agent_z");
    // counts-only: no query text, no memory body anywhere in the payload.
    const serialized = JSON.stringify(p);
    expect(serialized).not.toContain("the raw query");
    expect(serialized).not.toContain("sensitive body text");
  });

  it("emits memory:reranked with timedOut/fellBack reflecting the outcome when reranking runs", async () => {
    const input = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.6 })];
    const { eventBus, emits } = recordingEventBus();
    // reranker returns err -> fellBack:true.
    const { port } = mockReranker({ rank: async () => err(new Error("ce down")) });
    const recall = recallWithObs(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: port,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
        eventBus,
      },
      baseConfig({ rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 } }),
    );
    await recall.recall("q", SESSION_KEY, "agent_z");
    const reranked = emits.filter((e) => e.event === "memory:reranked");
    expect(reranked.length).toBe(1);
    const p = reranked[0]?.payload as { fellBack?: boolean; timedOut?: boolean };
    expect(p.fellBack).toBe(true);
    expect(p.timedOut).toBe(false);
  });

  it("does NOT emit memory:reranked when reranking was never attempted (rerank off)", async () => {
    const input = [makeResult("a", { base: 0.9 })];
    const { eventBus, emits } = recordingEventBus();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger, eventBus },
      baseConfig(),
    );
    await recall.recall("q", SESSION_KEY, "agent_z");
    expect(emits.filter((e) => e.event === "memory:reranked").length).toBe(0);
    // but memory:recalled still fires once.
    expect(emits.filter((e) => e.event === "memory:recalled").length).toBe(1);
  });
});

describe("createMemoryRecall — vec→FTS-only degradation signal (OBS-03 gap)", () => {
  it("logs ONE WARN (errorKind dependency + hint) AND records a vec_unavailable degradation AND zero vectorCandidates when the vector lane cannot contribute", async () => {
    // A whitespace-only query cannot produce a vector embedding (the memory layer's
    // zero-length-embedding → FTS-only fallback). The recall layer surfaces this as the
    // operator-facing vec→FTS signal: one WARN + a degradations[] entry + zero vector
    // candidates in the recalled event. Candidates still exist (FTS matched).
    const input = [makeResult("a", { base: 0.9, createdAt: NOW }), makeResult("b", { base: 0.6, createdAt: NOW })];
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as unknown as ComisLogger;
    const { recallTrace, records } = recordingRecallTrace();
    const { eventBus, emits } = recordingEventBus();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger, recallTrace, eventBus },
      baseConfig(),
    );
    // whitespace-only query → no vector lane.
    const got = await recall.recall("   ", SESSION_KEY, "agent_z");
    expect(got.ok).toBe(true);
    // ONE WARN with the vec→FTS errorKind + hint.
    const warnArg = warn.mock.calls.find(
      (c) =>
        ((c[0] as { errorKind?: string })?.errorKind === "dependency" ||
          (c[0] as { errorKind?: string })?.errorKind === "precondition") &&
        /vector lane unavailable/i.test((c[0] as { hint?: string })?.hint ?? ""),
    );
    expect(warnArg).toBeDefined();
    // the trace's degradations[] carries the vec_unavailable kind.
    const rec = records[0] as {
      vectorLaneActive?: boolean;
      degradations?: Array<{ kind?: string; errorKind?: string; hint?: string }>;
    };
    expect(rec.vectorLaneActive).toBe(false);
    const vecDeg = (rec.degradations ?? []).find((d) => d.kind === "vec_unavailable");
    expect(vecDeg).toBeDefined();
    expect(typeof vecDeg?.errorKind).toBe("string");
    expect(typeof vecDeg?.hint).toBe("string");
    // memory:recalled carries zero vectorCandidates.
    const recalled = emits.find((e) => e.event === "memory:recalled");
    expect((recalled?.payload as { vectorCandidates?: number })?.vectorCandidates).toBe(0);
  });

  it("does NOT fire the vec→FTS WARN for a normal query (the signal is conservative, not per-recall noise)", async () => {
    const input = [makeResult("a", { base: 0.9 })];
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as unknown as ComisLogger;
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger, recallTrace },
      baseConfig(),
    );
    await recall.recall("a perfectly normal embeddable query", SESSION_KEY, "agent_z");
    const vecWarn = warn.mock.calls.find((c) =>
      /vector lane unavailable/i.test((c[0] as { hint?: string })?.hint ?? ""),
    );
    expect(vecWarn).toBeUndefined();
    const rec = records[0] as {
      vectorLaneActive?: boolean;
      lanes?: { vector?: number };
      degradations?: Array<{ kind?: string }>;
    };
    expect(rec.vectorLaneActive).toBe(true);
    expect((rec.degradations ?? []).some((d) => d.kind === "vec_unavailable")).toBe(false);
    // WR-04: even with the vector lane ACTIVE, lanes.vector is reported as 0 (honest) —
    // the MemoryPort fuses vec+fts internally, so the recall layer never sees a real
    // vector-candidate count and must NOT duplicate the FTS count into the vector lane.
    expect(rec.lanes?.vector).toBe(0);
  });

  it("records a recorder/emit failure NEVER aborts recall (non-fatal observability)", async () => {
    const input = [makeResult("a", { base: 0.9 })];
    const recall = recallWithObs(
      {
        memoryPort: fakeMemoryPort(input),
        clock: fixedClock,
        logger: noopLogger,
        recallTrace: {
          recordRecall() {
            throw new Error("recorder exploded");
          },
        },
        eventBus: {
          emit() {
            throw new Error("bus exploded");
          },
        },
      },
      baseConfig(),
    );
    const got = await recall.recall("q", SESSION_KEY, "agent_z");
    // recall succeeds despite the recorder + bus throwing — observability is non-fatal.
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(["a"]);
  });
});

// ── LANES-01: the 2-lane build from searchLanes ───────────────────────────
//
// When the injected MemoryPort exposes searchLanes, recall builds TWO lanes
// (fts + vector) from it, routes them through fuse() with the operator weights
// cfg.lanes.{fts,vector}.weight, re-applies minScore POST-fuse, and reports the
// TRUE per-lane counts (vectorCandidates = vectorLane.length, no longer 0). When
// searchLanes is ABSENT, recall falls back to the single-lane search() path
// verbatim (graceful degrade — the vectorCandidates-0 honest value).

/** A MemoryPort exposing BOTH search() and searchLanes(); records the opts it saw. */
function fakeLaneMemoryPort(
  lanes: { fts: MemorySearchResult[]; vector: MemorySearchResult[] },
  capture?: { laneOpts?: MemorySearchOptions; searchOpts?: MemorySearchOptions },
): MemoryPort {
  return {
    async search(_key: SessionKey, _query: string, opts?: MemorySearchOptions) {
      if (capture) capture.searchOpts = opts;
      // The single-lane fallback would return the fts lane (the merged list stand-in).
      return ok(lanes.fts);
    },
    async searchLanes(_key: SessionKey, _query: string, opts?: MemorySearchOptions) {
      if (capture) capture.laneOpts = opts;
      return ok(lanes);
    },
  } as unknown as MemoryPort;
}

describe("createMemoryRecall — two-lane build from searchLanes (LANES-01)", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) orders the output.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };

  /** Today's pre-fused order via computeRRF(fts,vec,1.0,1.5) (k=60). The parity reference. */
  function preFused(fts: string[], vector: string[], wFts = 1.0, wVec = 1.5): string[] {
    const k = 60;
    const merged = new Map<string, number>();
    fts.forEach((id, i) => merged.set(id, (merged.get(id) ?? 0) + wFts / (k + (i + 1))));
    vector.forEach((id, i) => merged.set(id, (merged.get(id) ?? 0) + wVec / (k + (i + 1))));
    return Array.from(merged.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }

  it("PARITY: default weights {fts:1.0,vector:1.5} reproduce today's pre-fused order byte-for-byte", async () => {
    // Lanes that DISAGREE so fusion is non-trivial: fts leads L1, vector leads L2.
    const fts = ["L1", "L2", "L3"].map((id) => makeResult(id, { base: 1 }));
    const vector = ["L2", "L1", "L4"].map((id) => makeResult(id, { base: 1 }));
    const port = fakeLaneMemoryPort({ fts, vector });
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(
      preFused(["L1", "L2", "L3"], ["L2", "L1", "L4"]),
    );
  });

  it("a TUNED weight reorders vs the parity defaults (the weights are LIVE)", async () => {
    // fts leads L1, vector leads L2. At parity {1.0,1.5} the vector lane wins (L2 first).
    // Tuning FTS to DOMINATE flips the leader to L1 — proving the weights flow through.
    const fts = ["L1", "L2"].map((id) => makeResult(id, { base: 1 }));
    const vector = ["L2", "L1"].map((id) => makeResult(id, { base: 1 }));
    const port = fakeLaneMemoryPort({ fts, vector });
    const parity = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const parityGot = await parity.recall("q", SESSION_KEY, "default");
    expect(parityGot.ok && parityGot.value[0]?.entry.id).toBe("L2"); // vector dominates at defaults
    const tuned = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { fts: { weight: 5.0 }, vector: { weight: 0.1 } } } as Partial<MemoryRecallConfig>),
    );
    const got = await tuned.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // FTS dominates → the FTS lane's rank-1 (L1) leads (DIFFERENT from the parity L2).
    expect(got.value[0]?.entry.id).toBe("L1");
  });

  it("does NOT pass minScore into searchLanes (the lanes are pre-filter)", async () => {
    const fts = [makeResult("a", { base: 1 })];
    const vector = [makeResult("b", { base: 1 })];
    const capture: { laneOpts?: MemorySearchOptions } = {};
    const port = fakeLaneMemoryPort({ fts, vector }, capture);
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, minScore: 0.5, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("q", SESSION_KEY, "default");
    expect(capture.laneOpts?.minScore).toBeUndefined();
  });

  it("re-applies minScore AFTER fuse() (a sub-minScore fused item is dropped)", async () => {
    // Two single-occurrence lane items. With weights 1.0/1.5 and k=60, the fused
    // normalized scores are below 0.5; a minScore of 0.5 must drop BOTH post-fuse.
    const fts = [makeResult("a", { base: 1 })];
    const vector = [makeResult("b", { base: 1 })];
    const port = fakeLaneMemoryPort({ fts, vector });
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, minScore: 0.9, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Both fused scores < 0.9 → dropped by the post-fuse minScore re-application.
    expect(got.value).toHaveLength(0);
  });

  it("FTS-only (empty vector lane) → DROP the empty lane → single-lane identity (FTS order/scores preserved)", async () => {
    // searchLanes returns a NON-empty fts lane + EMPTY vector lane. The recall layer
    // must DROP the empty lane so a lone FTS lane hits fuse()'s single-lane pass-through
    // (NOT the multi-lane rank-ramp). minScore low so nothing is filtered.
    const fts = [
      makeResult("f1", { base: 0.42, trustLevel: "learned", createdAt: NOW }),
      makeResult("f2", { base: 0.2, trustLevel: "learned", createdAt: NOW }),
    ];
    const port = fakeLaneMemoryPort({ fts, vector: [] });
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, minScore: 0, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Single-lane identity: exact FTS order AND the adapter scores preserved (NOT a rank-ramp).
    expect(got.value.map((r) => r.entry.id)).toEqual(["f1", "f2"]);
    expect(got.value[0]?.score).toBeCloseTo(0.42, 5);
    expect(got.value[1]?.score).toBeCloseTo(0.2, 5);
  });

  it("reports the TRUE vectorCandidates (= vectorLane.length, no longer 0) in the recall-trace", async () => {
    const fts = [makeResult("a", { base: 1 }), makeResult("b", { base: 1 })];
    const vector = [makeResult("b", { base: 1 }), makeResult("c", { base: 1 }), makeResult("d", { base: 1 })];
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      { memoryPort: fakeLaneMemoryPort({ fts, vector }), clock: fixedClock, logger: noopLogger, recallTrace },
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("q", SESSION_KEY, "agent_z");
    const rec = records[0] as { lanes?: { fts?: number; vector?: number } };
    expect(rec.lanes?.fts).toBe(2); // fts lane length
    expect(rec.lanes?.vector).toBe(3); // TRUE vector lane length (NOT 0)
  });

  it("emits memory:recalled with the TRUE vectorCandidates when searchLanes is used", async () => {
    const fts = [makeResult("a", { base: 1 })];
    const vector = [makeResult("b", { base: 1 }), makeResult("c", { base: 1 })];
    const { eventBus, emits } = recordingEventBus();
    const recall = recallWithObs(
      { memoryPort: fakeLaneMemoryPort({ fts, vector }), clock: fixedClock, logger: noopLogger, eventBus },
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("q", SESSION_KEY, "agent_z");
    const recalled = emits.find((e) => e.event === "memory:recalled");
    expect((recalled?.payload as { vectorCandidates?: number })?.vectorCandidates).toBe(2);
  });

  it("FALLBACK: a search-only MemoryPort (no searchLanes) behaves exactly as today (single-lane, vectorCandidates 0)", async () => {
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", createdAt: NOW }),
      makeResult("b", { base: 0.4, trustLevel: "learned", createdAt: NOW }),
    ];
    const capture: { opts?: MemorySearchOptions } = {};
    // fakeMemoryPort has NO searchLanes → the absent-method fallback path.
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      { memoryPort: fakeMemoryPort(input, capture), clock: fixedClock, logger: noopLogger, recallTrace },
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Single-lane order preserved + minScore was applied IN search() (passed through).
    expect(got.value.map((r) => r.entry.id)).toEqual(["a", "b"]);
    expect(capture.opts?.minScore).toBe(0.1);
    // The split is not observable on the fallback path → vectorCandidates honest 0.
    const rec = records[0] as { lanes?: { vector?: number } };
    expect(rec.lanes?.vector).toBe(0);
  });

  it("FALLBACK: minScore is NOT double-applied (search() applied it; the post-fuse re-application is gated to searchLanes)", async () => {
    // On the fallback path search() already filtered by minScore. The recall layer must
    // NOT re-apply minScore post-fuse (that would be a double filter). Model: search()
    // returns items whose adapter scores are ABOVE minScore but BELOW what a fresh fuse
    // rank-ramp would assign — proving no second minScore pass strips them.
    const input = [makeResult("a", { base: 0.15, trustLevel: "learned", createdAt: NOW })];
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig({ scoring: NEUTRAL, minScore: 0.1, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The 0.15-scored item (above 0.1, passed search()) survives — single-lane pass-through
    // preserves its 0.15 score and no post-fuse minScore strips it on the fallback path.
    expect(got.value.map((r) => r.entry.id)).toEqual(["a"]);
    expect(got.value[0]?.score).toBeCloseTo(0.15, 5);
  });
});

// ===========================================================================
// LANES-02: the temporal-spread lane — the 4th fused lane (default-OFF).
// ===========================================================================

/** Milliseconds per day — for authoring occurredAt offsets in the temporal tests. */
const TEMP_DAY = 86_400_000;

/**
 * A controllable MemoryTemporalStore stub. `spreadLane` returns a canned Result and
 * records every call (seedOccurredAts + scope + windowMs + cap) so the gate / scope /
 * not-called invariants are assertable. Mirrors {@link fakeEntityStore}.
 */
function fakeTemporalStore(laneResult: Result<MemorySearchResult[], Error>): {
  store: MemoryTemporalStore;
  calls: {
    seedOccurredAts: number[];
    scope: { tenantId: string; agentId: string };
    windowMs: number;
    cap: number;
  }[];
} {
  const calls: {
    seedOccurredAts: number[];
    scope: { tenantId: string; agentId: string };
    windowMs: number;
    cap: number;
  }[] = [];
  const store: MemoryTemporalStore = {
    async spreadLane(seedOccurredAts, scope, windowMs, cap) {
      calls.push({ seedOccurredAts, scope, windowMs, cap });
      return laneResult;
    },
  };
  return { store, calls };
}

describe("createMemoryRecall — temporal-spread lane (LANES-02)", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) orders the output —
  // the temporal-lane RRF contribution is then the only thing under test.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };
  const TEMPORAL_ON = { enabled: true, weight: 1.0, windowDays: 7 };
  const TEMPORAL_OFF = { enabled: false, weight: 1.0, windowDays: 7 };
  const SEED_T = 100 * TEMP_DAY;

  /**
   * The pre-temporal-lane fused output (fts + vector, no temporal lane) — exactly what
   * the default-OFF / no-seed / err paths must reproduce verbatim (the ENT-04 no-op).
   */
  function baseLaneReference(
    fts: MemorySearchResult[],
    vector: MemorySearchResult[],
  ): string[] {
    const lanes = [] as Parameters<typeof fuse>[0];
    if (fts.length > 0) lanes.push({ results: fts, weight: 1.0 });
    if (vector.length > 0) lanes.push({ results: vector, weight: 1.5 });
    const fused = fuse(lanes);
    const scored = score(fused, NEUTRAL, NOW);
    const allowed = new Set<TrustLevel>(["system", "learned"]);
    return deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map(
      (r) => r.entry.id,
    );
  }

  it("LANE ON: a near-seed memory (from the temporal store, absent from search) appears in the fused output + trace lanes.temporal counts it", async () => {
    // Base lanes: a strong seed carrying occurredAt + a WEAK non-temporal hit. Without the
    // temporal lane, fusion ranks [seed, weak] and `nearSeed` is absent entirely.
    const fts = [
      makeResult("seed", { base: 0.9, occurredAt: SEED_T }),
      makeResult("weak", { base: 0.2 }),
    ];
    // The temporal store returns ONE near-seed memory NOT in the base lanes, rank-1.
    const { store, calls } = fakeTemporalStore(
      ok([makeResult("nearSeed", { base: 0.99, occurredAt: SEED_T + 1 * TEMP_DAY })]),
    );
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        temporalStore: store,
        clock: fixedClock,
        logger: noopLogger,
        recallTrace,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: { ...PARITY_LANES, temporal: TEMPORAL_ON },
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    // The temporal lane flipped it in: nearSeed is present in the fused output.
    expect(ids).toContain("nearSeed");
    // Lane invoked once, lazily, with the seed times (only the hit carrying occurredAt),
    // the recall scope, windowMs = windowDays*DAY, and a cap.
    expect(calls.length).toBe(1);
    expect(calls[0]?.seedOccurredAts).toEqual([SEED_T]);
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
    expect(calls[0]?.windowMs).toBe(7 * TEMP_DAY);
    // The trace lanes cluster reports the temporal candidate count (= lane length).
    const rec = records[0] as { lanes?: { temporal?: number } };
    expect(rec.lanes?.temporal).toBe(1);
  });

  it("DEFAULT-OFF BYTE-IDENTITY: temporal.enabled=false → spreadLane NEVER called → output identical to the pre-temporal-lane fused path", async () => {
    const fts = [
      makeResult("a", { base: 0.9, occurredAt: SEED_T }),
      makeResult("b", { base: 0.4, occurredAt: SEED_T }),
    ];
    const vector = [makeResult("b", { base: 0.5 }), makeResult("c", { base: 0.3 })];
    // The store WOULD return a memory IF called — proving the disabled guard, not an empty lane.
    const { store, calls } = fakeTemporalStore(
      ok([makeResult("nearSeed", { base: 0.99, occurredAt: SEED_T + 1 * TEMP_DAY })]),
    );
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector }),
        temporalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: { ...PARITY_LANES, temporal: TEMPORAL_OFF },
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The load-bearing neutrality: spreadLane is NEVER called when off (the spy proves it).
    expect(calls.length).toBe(0);
    // Byte-identical to the pre-temporal-lane fused path (the ENT-04 no-op reused).
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
    expect(got.value.map((r) => r.entry.id)).not.toContain("nearSeed");
  });

  it("NO TEMPORAL CONFIG: an absent `lanes.temporal` → spreadLane NEVER called (byte-identical to before this plan)", async () => {
    const fts = [makeResult("a", { base: 0.9, occurredAt: SEED_T })];
    const { store, calls } = fakeTemporalStore(ok([makeResult("nearSeed", { base: 0.99, occurredAt: SEED_T })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        temporalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      // lanes carries ONLY fts/vector (the 95-01 shape) — no temporal sub-object.
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0);
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NO-SEED GATE: when the top base hits all LACK occurredAt → spreadLane NOT called (Pitfall 6 — no event time to spread from)", async () => {
    // None of the base hits carry occurredAt → seedTimes is empty → the lane is skipped
    // even though it is ENABLED.
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const { store, calls } = fakeTemporalStore(ok([makeResult("nearSeed", { base: 0.99, occurredAt: SEED_T })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        temporalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: { ...PARITY_LANES, temporal: TEMPORAL_ON },
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0); // no query when there are no seed times
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NO temporalStore: an undefined store → no temporal lane, output identical to the base lanes", async () => {
    const fts = [makeResult("a", { base: 0.9, occurredAt: SEED_T })];
    const recall = createMemoryRecall(
      { memoryPort: fakeLaneMemoryPort({ fts, vector: [] }), clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: { ...PARITY_LANES, temporal: TEMPORAL_ON },
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NON-FATAL: a spreadLane that returns err → recall WARNs and ranks WITHOUT the temporal lane (never fails)", async () => {
    const fts = [
      makeResult("a", { base: 0.9, occurredAt: SEED_T }),
      makeResult("b", { base: 0.4, occurredAt: SEED_T }),
    ];
    const warns: Record<string, unknown>[] = [];
    const capturingLogger = {
      ...noopLogger,
      warn: (obj: Record<string, unknown>) => {
        warns.push(obj);
      },
    } as unknown as ComisLogger;
    const { store } = fakeTemporalStore(err(new Error("temporal SQL exploded")));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        temporalStore: store,
        clock: fixedClock,
        logger: capturingLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: { ...PARITY_LANES, temporal: TEMPORAL_ON },
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    // The search/base lanes already succeeded — recall never fails because the temporal
    // lane failed; it WARNs and ranks WITHOUT the lane (the base order is preserved).
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
    const warn = warns.find((w) => typeof w.hint === "string" && /temporal/.test(String(w.hint)));
    expect(warn).toBeDefined();
    expect(warn?.errorKind).toBe("internal");
  });
});
