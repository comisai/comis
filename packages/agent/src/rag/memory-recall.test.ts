// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createMemoryRecall — the single recall orchestrator composing
 * search -> fuse -> rerank -> score -> trust-filter -> dedup.
 *
 * Load-bearing RED-first assertions:
 * - DEFAULT-OFF CHARACTERIZATION (no-regression pin): with rerank.enabled=false,
 *   recall yields the SAME order as the documented inline reference computation
 *   (single-lane fuse = identity -> score boosts -> trust-filter -> dedup).
 * - Trust filter: results whose trustLevel ∉ includeTrustLevels are dropped.
 * - Dedup: two same-content entries collapse to one.
 * - Graceful degrade: reranker.isAvailable()===false -> fused order, ok, non-empty.
 * - Rerank applied: a mock reranker inverting fused order -> top result is the
 *   highest-CE-scored candidate.
 * - Timeout fallback: a never-resolving rank + fake TimerPort firing the
 *   deadline -> fused order + WARN errorKind:"timeout".
 * - Trust tie-break: at equal reranked relevance, system outranks learned/external.
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
  MemoryCausalStore,
  MemoryEmbeddingStore,
  MemoryUsefulnessStore,
  UsefulnessSignal,
  RerankerPort,
  SessionKey,
  TrustLevel,
  TimerPort,
  TimerHandle,
  ClockPort,
  ComisLogger,
  TripleStorePort,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import { fuse } from "./fuse.js";
import { score, type ScoringAlphas } from "./score.js";
import { deduplicateResults } from "./rag-retriever.js";
import { createMemoryRecall, type MemoryRecallConfig } from "./memory-recall.js";
import { appendCausalLane } from "./recall-causal-lane.js";
import { expandSynonyms, parseTemporalRange } from "./query-understanding.js";
import type { FusionLane } from "./fuse.js";
// DIST-03 live-path integration (Task 3): the CONCRETE @comis/memory adapters,
// imported as a devDependency in the TEST only (the agent↛memory cut forbids this
// in src/, NOT in .test.ts — verified by architecture.test.ts excludeFileSuffixes).
import Database from "better-sqlite3";
import { initSchema, createLcdStore, buildProvenanceReadStore } from "@comis/memory";

// The binding constraint — the recall hot path is deterministic +
// LLM-FREE. memory-recall.ts must NEVER reach the query-time LLM surface. We mock the
// pi-ai call surface as spies; the `llm-free` describe at the foot of this file runs a
// FULL recall and asserts neither spy was ever called. The mock is file-wide (vi.mock is
// hoisted) but harmless to every other test here: memory-recall.ts does not import pi-ai,
// so the spies simply stay at zero — which is exactly the property under assertion.
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: vi.fn(() => ({ id: "mock-model" })),
  completeSimple: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }] })),
}));
import { completeSimple, getModel } from "@earendil-works/pi-ai";

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
    /** Entry tags. Default []; set e.g. ["lcd_distilled", "depth:1"] for the
     *  DIST-03 provenance down-weighting pass fixtures. */
    tags?: string[];
    /** source.sessionKey — the conversation a memory was written from. Used by the
     *  DIST-03 post-fusion provenance pass to find same-conversation paired rows. */
    sessionKey?: string;
  } = {},
): MemorySearchResult {
  const entry: Record<string, unknown> = {
    id,
    tenantId: "default",
    agentId: "default",
    userId: "user_a",
    content: opts.content ?? `content for ${id}`,
    trustLevel: opts.trustLevel ?? "learned",
    source: opts.sessionKey !== undefined ? { who: "agent", sessionKey: opts.sessionKey } : { who: "agent" },
    tags: opts.tags ?? [],
    createdAt: opts.createdAt ?? NOW,
    // The temporal lane seeds on entry.occurredAt — set it only when provided so the
    // no-seed gate (occurredAt absent on every top hit) is exercisable.
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

  it("a weak top hit (adapter score < 0.7) stays below the inline gate on the default path (single-lane fuse pass-through, not rank-ramped to ≈1.0)", async () => {
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

  it("NON-DESTRUCTIVE: two CONFLICTING memories about the same subject BOTH survive recall (no write-time deletion of older facts)", async () => {
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

  it("graceful degrade: reranker isAvailable()===false -> fused order, ok, non-empty (no error)", async () => {
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

  it("rerank applied: a reranker INVERTING fused order makes the last fused candidate the top result", async () => {
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

  it("timeout fallback: a never-resolving rank + fired deadline -> fused order + WARN errorKind:timeout", async () => {
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

  it("rerank fallback (dependency): the WARN carries the underlying reranker err so the outage is diagnosable (§2.7)", async () => {
    // A memory-pressured host surfaced this: the reranker returns an err Result
    // (not a timeout) and the fallback WARN logged only errorKind+hint, DROPPING
    // the underlying cause — so a real reranker outage is undiagnosable from logs.
    const input = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.6 })];
    const warn = vi.fn();
    const logger = { ...noopLogger, warn } as unknown as ComisLogger;
    const { port } = mockReranker({ rank: async () => err(new Error("reranker boom")) });
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), reranker: port, timers: fakeTimers().port, clock: fixedClock, logger },
      baseConfig({
        rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 },
        scoring: { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 },
      }),
    );
    const got = await recall.recall("q", SESSION_KEY);
    expect(got.ok).toBe(true); // recall still returns (graceful fusion fallback)
    const warnArg = warn.mock.calls.find((c) => (c[0] as { errorKind?: string })?.errorKind === "dependency");
    expect(warnArg).toBeDefined();
    const loggedErr = (warnArg![0] as { err?: unknown }).err;
    expect(loggedErr).toBeDefined(); // RED pre-fix: the dependency branch dropped scored.error
    expect(String((loggedErr as Error)?.message ?? loggedErr)).toContain("reranker boom");
  });

  it("trust tie-break: at EQUAL reranked relevance, system outranks learned/external", async () => {
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

  it("scale-mismatch: a LOW absolute CE pool score still precedes the higher-fused-score tail (no global re-sort across scales)", async () => {
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

  it("when deps.timers is undefined, rerank is SKIPPED entirely (degrade to fused order; reranker.rank is never called → no unbounded hang)", async () => {
    const input = [
      makeResult("a", { base: 0.9 }),
      makeResult("b", { base: 0.6 }),
      makeResult("c", { base: 0.3 }),
    ];
    // A reranker that would HANG forever if invoked. With no timers there is no
    // deadline, so invoking it would block recall indefinitely (the rerank
    // timeout cannot fire). The fix is to skip rerank when timers is absent, NOT to await an
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

  it("equal CE scores inside the reranked pool keep a deterministic (original pool index) order", async () => {
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

describe("createMemoryRecall — entity associative lane", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) is what orders the
  // output — the entity-lane RRF contribution is then the only thing under test.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const ENABLED_LANE = { enabled: true, seedCount: 5, perEntityCap: 200, weight: 1.0 };
  const DISABLED_LANE = { enabled: false, seedCount: 5, perEntityCap: 200, weight: 1.0 };

  /**
   * Reference: the pre-entity-lane single-lane fused output (no entity lane) — exactly
   * what the disabled / no-seed / err paths must reproduce verbatim.
   */
  function singleLaneReference(input: MemorySearchResult[]): string[] {
    const fused = fuse([{ results: input, weight: 1.0 }]);
    const scored = score(fused, NEUTRAL, NOW);
    const allowed = new Set<TrustLevel>(["system", "learned"]);
    return deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map(
      (r) => r.entry.id,
    );
  }

  it("a shared-entity memory (from the lane, absent from search) OUTRANKS a non-sharing weak search hit after fusion", async () => {
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

  it("seedCount: only the top `seedCount` search hits seed the lane", async () => {
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

  it("disabled: entityLane.enabled=false -> lane NOT called, output identical to single-lane fuse", async () => {
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

  it("no entityStore: an undefined store -> no lane, output identical to single-lane fuse", async () => {
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

  it("no seeds: search returned nothing -> associativeLane NOT called (no empty-seed query)", async () => {
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

  it("empty lane: associativeLane returns ok([]) -> no 2nd lane pushed, output identical to single-lane fuse", async () => {
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

  it("err-fallback NON-FATAL: associativeLane err -> WARN(errorKind+hint) + fall back to search lane only (recall succeeds)", async () => {
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

describe("createMemoryRecall — usefulness signal read-path", () => {
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
// Recall passes the ALREADY-computed deterministic
// classifyIntent into readUsefulness so the per-intent usefulness bucket drives the
// order. The binding constraint: this stays LLM-FREE (the `intent` const at
// memory-recall.ts:91 is the SAME pure classify already done for lane reweighting —
// NO second classify, NO model call on the read path). Absence of a per-intent row
// degrades to the global bucket then to the shipped neutral 1.0 factor; feedback OFF
// skips the read entirely (read-spy = 0 + byte-identical).
// ---------------------------------------------------------------------------
describe("createMemoryRecall — per-intent usefulness read", () => {
  // Only usefulnessAlpha is live so the usefulness factor is the SOLE reorder lever.
  const USEFULNESS_ONLY = {
    recencyAlpha: 0,
    temporalAlpha: 0,
    proofAlpha: 0,
    trustAlpha: 0,
    usefulnessAlpha: 0.1,
  };
  const FLAG_ON = { enabled: true };
  const FLAG_OFF = { enabled: false };
  // intentReweight toggles whether recall classifies the query at all (memory-recall.ts:91).
  const QU_INTENT_ON = { intentReweight: true, synonyms: false, temporalParse: false };
  const QU_INTENT_OFF = { intentReweight: false, synonyms: false, temporalParse: false };

  /**
   * An intent-AWARE usefulness store stub. `readUsefulness` records every (ids, scope) it
   * receives — so the test can assert `scope.intent` — AND returns a DIFFERENT signal map
   * per requested intent bucket (so a per-intent bucket can drive a different order than the
   * global bucket). When the requested intent has no entry in `byIntent`, it falls back to
   * `byIntent[""]` (the global bucket) — mirroring the adapter's degrade-to-global.
   */
  function fakeIntentUsefulnessStore(byIntent: Record<string, Map<string, UsefulnessSignal>>): {
    store: MemoryUsefulnessStore;
    readUsefulness: ReturnType<typeof vi.fn>;
    scopes: Array<{ tenantId: string; agentId: string; intent?: string }>;
  } {
    const scopes: Array<{ tenantId: string; agentId: string; intent?: string }> = [];
    const readUsefulness = vi.fn(
      async (_ids: string[], scope: { tenantId: string; agentId: string; intent?: string }) => {
        scopes.push(scope);
        const bucket = scope.intent !== undefined ? scope.intent : "";
        const map = byIntent[bucket] ?? byIntent[""] ?? new Map<string, UsefulnessSignal>();
        return ok(map);
      },
    );
    const store = {
      async recordUsage() {
        return ok(undefined);
      },
      readUsefulness,
    } as unknown as MemoryUsefulnessStore;
    return { store, readUsefulness, scopes };
  }

  it("PER-INTENT DRIVES ORDER: the classified intent reaches scope.intent and the per-intent bucket reorders vs the global bucket", async () => {
    // m1 leads on base; m2 is proven-useful ONLY under the "temporal" bucket (global bucket
    // ignores it). A "temporal"-classified query (intentReweight ON) fetches the temporal
    // bucket → m2's used-rate 1.0 flips it above m1. The scope MUST carry intent="temporal".
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const { store, scopes } = fakeIntentUsefulnessStore({
      // Global bucket: m2 is recalled-but-ignored (would NOT flip).
      "": new Map<string, UsefulnessSignal>([["m2", { usedCount: 0, ignoredCount: 5 }]]),
      // temporal bucket: m2 is proven-useful (flips it above m1).
      temporal: new Map<string, UsefulnessSignal>([["m2", { usedCount: 5, ignoredCount: 0 }]]),
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: USEFULNESS_ONLY,
        feedback: FLAG_ON,
        queryUnderstanding: QU_INTENT_ON,
      } as Partial<MemoryRecallConfig>),
    );
    // "when did the deploy happen" → classifyIntent → "temporal".
    const got = await recall.recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The deterministic classified intent reached the read scope.
    expect(scopes[0]?.intent).toBe("temporal");
    // The per-intent bucket reordered the output — m2 (proven-useful for temporal) leads.
    const ids = got.value.map((r) => r.entry.id);
    expect(ids.indexOf("m2")).toBeLessThan(ids.indexOf("m1"));
  });

  it("PER-INTENT vs OFF: the SAME query+store yields a DIFFERENT order with intentReweight ON vs OFF (the per-intent lift is real, not the global bucket)", async () => {
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const byIntent = {
      "": new Map<string, UsefulnessSignal>([["m2", { usedCount: 0, ignoredCount: 5 }]]),
      temporal: new Map<string, UsefulnessSignal>([["m2", { usedCount: 5, ignoredCount: 0 }]]),
    };
    const makeRecall = (qu: typeof QU_INTENT_ON) => {
      const { store } = fakeIntentUsefulnessStore({
        "": new Map(byIntent[""]),
        temporal: new Map(byIntent.temporal),
      });
      return createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          usefulnessStore: store,
          clock: fixedClock,
          logger: noopLogger,
        } as unknown as Parameters<typeof createMemoryRecall>[0],
        baseConfig({
          scoring: USEFULNESS_ONLY,
          feedback: FLAG_ON,
          queryUnderstanding: qu,
        } as Partial<MemoryRecallConfig>),
      );
    };
    const on = await makeRecall(QU_INTENT_ON).recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    const off = await makeRecall(QU_INTENT_OFF).recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    expect(on.ok && off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    const onIds = on.value.map((r) => r.entry.id);
    const offIds = off.value.map((r) => r.entry.id);
    // ON reads the temporal bucket (m2 proven-useful → m2 first); OFF reads the global
    // bucket (m2 ignored → base order m1 first). The per-intent read CHANGES the order.
    expect(onIds).not.toEqual(offIds);
    expect(onIds.indexOf("m2")).toBeLessThan(onIds.indexOf("m1"));
    expect(offIds.indexOf("m1")).toBeLessThan(offIds.indexOf("m2"));
  });

  it("INTENT OFF: with intentReweight off the read scope OMITS intent (the adapter reads the global bucket → byte-identical to the prior default behaviour)", async () => {
    const input = [makeResult("m1", { base: 0.5, trustLevel: "learned", createdAt: NOW })];
    const { store, scopes } = fakeIntentUsefulnessStore({
      "": new Map<string, UsefulnessSignal>(),
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: USEFULNESS_ONLY,
        feedback: FLAG_ON,
        queryUnderstanding: QU_INTENT_OFF,
      } as Partial<MemoryRecallConfig>),
    );
    // A temporal-shaped query, but intentReweight is OFF → intent stays undefined → omitted.
    const got = await recall.recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The read still ran (feedback ON) but the scope carries NO intent → global bucket.
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).not.toHaveProperty("intent");
  });

  it("DEGRADE-TO-GLOBAL: a per-intent bucket with NO entry for an id → recall does not crash; the id falls to neutral (base order preserved)", async () => {
    // The store returns an EMPTY map for the requested intent (no per-intent row, no global
    // row) → usefulnessNorm(undefined) → 0.5 → factor 1.0. Recall must succeed with base order.
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const { store, scopes } = fakeIntentUsefulnessStore({
      // Only an empty global bucket — the temporal request degrades to it (still empty).
      "": new Map<string, UsefulnessSignal>(),
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: USEFULNESS_ONLY,
        feedback: FLAG_ON,
        queryUnderstanding: QU_INTENT_ON,
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // intent reached the scope (temporal) but the empty map → neutral → base order kept.
    expect(scopes[0]?.intent).toBe("temporal");
    expect(got.value.map((r) => r.entry.id)).toEqual(["m1", "m2"]);
  });

  it("DEFAULT-OFF SPY=0 + BYTE-IDENTITY: feedback OFF → readUsefulness called 0 times even with a flipping per-intent bucket + intentReweight ON (mirror the readEmbeddingsCalls===0 guard)", async () => {
    const input = [
      makeResult("m1", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    // A temporal bucket that WOULD flip m2 above m1 if the read ran — proving the OFF skip,
    // not an empty read.
    const { store, readUsefulness } = fakeIntentUsefulnessStore({
      temporal: new Map<string, UsefulnessSignal>([["m2", { usedCount: 9, ignoredCount: 0 }]]),
    });
    // Reference: the same pipeline with NO signal (factor neutral) → base order.
    const fused = fuse([{ results: input, weight: 1.0 }]);
    const scored = score(fused, USEFULNESS_ONLY, NOW);
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
      baseConfig({
        scoring: USEFULNESS_ONLY,
        feedback: FLAG_OFF,
        queryUnderstanding: QU_INTENT_ON,
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The binding default-OFF guarantee: the read NEVER ran (spy = 0) …
    expect(readUsefulness).not.toHaveBeenCalled();
    // … and the order is byte-identical to the no-signal reference.
    expect(got.value.map((r) => r.entry.id)).toEqual(expected);
  });

  it("LLM-FREE: a recall run (feedback ON + intentReweight ON, the per-intent read path) makes NO query-time model call", async () => {
    vi.mocked(completeSimple).mockClear();
    vi.mocked(getModel).mockClear();
    const input = [
      makeResult("m1", { base: 0.51, trustLevel: "learned", createdAt: NOW }),
      makeResult("m2", { base: 0.5, trustLevel: "learned", createdAt: NOW }),
    ];
    const { store } = fakeIntentUsefulnessStore({
      "": new Map<string, UsefulnessSignal>(),
      temporal: new Map<string, UsefulnessSignal>([["m2", { usedCount: 5, ignoredCount: 0 }]]),
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        usefulnessStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: USEFULNESS_ONLY,
        feedback: FLAG_ON,
        queryUnderstanding: QU_INTENT_ON,
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("when did the deploy happen", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    // The intent is classifyIntent (pure) — the per-intent read touched NO model surface.
    expect(completeSimple).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Recall-trace capture + memory:recalled/reranked emit + vec→FTS signal
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

describe("createMemoryRecall — recall-trace capture", () => {
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

describe("createMemoryRecall — memory:recalled / memory:reranked emit", () => {
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

describe("createMemoryRecall — vec→FTS-only degradation signal", () => {
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
    // Even with the vector lane ACTIVE, lanes.vector is reported as 0 (honest) —
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

// ── The 2-lane build from searchLanes ───────────────────────────
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

describe("createMemoryRecall — two-lane build from searchLanes", () => {
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

  it("FULL-SET PARITY: at DEFAULT config the returned SET (count + ids + order) equals the maxResults-capped search() result, not just its head ordering", async () => {
    // Load-bearing: the prior search() → hybridSearch() sliced the FTS+vector fused
    // union to options.limit (= maxResults) BEFORE returning (hybrid-search.ts:374), so
    // recall() returned AT MOST maxResults entries. The lane-split unfuse moved the fusion
    // into fuse() but DROPPED that cap — searchLanes returns both lanes un-truncated, the
    // distinct union can exceed maxResults, and finalRanked was never re-capped (the only
    // slice(0,maxResults) is trace-only). prompt-assembly feeds the full uncapped set to
    // an injector that caps by CHARACTERS, not count → more memories injected than before.
    //
    // This pins the FULL returned set (count AND ids AND order) to the prior behavior:
    //   prior = preFused(fts, vector).slice(0, maxResults)
    // RED on the un-capped code (returns the full 7-id union); GREEN once the FTS+vector
    // base is capped to maxResults before scoring (mirroring hybridSearch's slice).
    const ftsIds = ["L1", "L2", "L3", "L4", "L5"];
    const vecIds = ["L2", "L1", "L4", "L6", "L7"];
    const fts = ftsIds.map((id) => makeResult(id, { base: 1 }));
    const vector = vecIds.map((id) => makeResult(id, { base: 1 }));
    const port = fakeLaneMemoryPort({ fts, vector });
    const MAX = 3;
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      // minScore 0 isolates the COUNT cap from the minScore filter: every fused id clears
      // 0, so the ONLY thing that can trim the 7-id union to 3 is the maxResults cap.
      baseConfig({ scoring: NEUTRAL, minScore: 0, maxResults: MAX, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // prior baseline: hybridSearch fused then sliced to limit=maxResults.
    const v26Capped = preFused(ftsIds, vecIds).slice(0, MAX);
    expect(v26Capped).toHaveLength(MAX); // sanity: the union really exceeds maxResults
    // FULL set: count AND ids AND order — NOT a slice(0, oldOrder.length) of a longer list.
    expect(got.value).toHaveLength(MAX);
    expect(got.value.map((r) => r.entry.id)).toEqual(v26Capped);
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
// The temporal-spread lane — the 4th fused lane (default-OFF).
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

describe("createMemoryRecall — temporal-spread lane", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) orders the output —
  // the temporal-lane RRF contribution is then the only thing under test.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };
  const TEMPORAL_ON = { enabled: true, weight: 1.0, windowDays: 7 };
  const TEMPORAL_OFF = { enabled: false, weight: 1.0, windowDays: 7 };
  const SEED_T = 100 * TEMP_DAY;

  /**
   * The pre-temporal-lane fused output (fts + vector, no temporal lane) — exactly what
   * the default-OFF / no-seed / err paths must reproduce verbatim (the entity-lane no-op).
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

  it("I1: the memory:recalled `lanes` count INCLUDES the temporal lane when it contributes (no off-by-one under-report)", async () => {
    // I1 (observability): the counts-only memory:recalled event's `lanes` summed fts+vector+
    // entity but OMITTED temporal, so an active+contributing temporal lane was under-reported
    // by one (the rich recall-trace record DID count lanes.temporal, so the two diverged).
    // FTS-only base (1 lane) + a contributing temporal lane (1 lane) → 2 active lanes.
    // RED on the pre-fix laneCount (emits 1, temporal omitted); GREEN once temporal is added.
    const fts = [makeResult("seed", { base: 0.9, occurredAt: SEED_T })];
    const { store } = fakeTemporalStore(
      ok([makeResult("nearSeed", { base: 0.99, occurredAt: SEED_T + 1 * TEMP_DAY })]),
    );
    const { eventBus, emits } = recordingEventBus();
    const recall = recallWithObs(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        temporalStore: store,
        clock: fixedClock,
        logger: noopLogger,
        eventBus,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: { ...PARITY_LANES, temporal: TEMPORAL_ON },
      } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    const recalled = emits.find((e) => e.event === "memory:recalled");
    // 2 active lanes: fts (1) + temporal (1). The pre-fix code emitted 1 (temporal omitted).
    expect((recalled?.payload as { lanes?: number })?.lanes).toBe(2);
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
    // Byte-identical to the pre-temporal-lane fused path (the entity-lane no-op reused).
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
    expect(got.value.map((r) => r.entry.id)).not.toContain("nearSeed");
  });

  it("NO TEMPORAL CONFIG: an absent `lanes.temporal` → spreadLane NEVER called (byte-identical to before the temporal lane)", async () => {
    const fts = [makeResult("a", { base: 0.9, occurredAt: SEED_T })];
    const { store, calls } = fakeTemporalStore(ok([makeResult("nearSeed", { base: 0.99, occurredAt: SEED_T })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        temporalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      // lanes carries ONLY fts/vector (the base shape) — no temporal sub-object.
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0);
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NO-SEED GATE: when the top base hits all LACK occurredAt → spreadLane NOT called (no event time to spread from)", async () => {
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

// ===========================================================================
// Causal lane — the 5th fused lane, APPENDED after the temporal
// lane. Mirrors the temporal-spread block above tier-for-tier: a causal store
// stub + the LANE-ON lift / DEFAULT-OFF byte-identity (the spy proves ZERO
// calls) / EMPTY-lane neutral / NO-store / NON-FATAL invariants.
// ===========================================================================

/**
 * A controllable MemoryCausalStore stub. `causalLane` returns a canned Result and records
 * every call (seedMemoryIds + scope + cap) so the gate / scope / not-called invariants are
 * assertable. `linkCausal` is the unused write-path half (recall never calls it). Mirrors
 * {@link fakeTemporalStore}.
 */
function fakeCausalStore(laneResult: Result<MemorySearchResult[], Error>): {
  store: MemoryCausalStore;
  calls: { seedMemoryIds: string[]; scope: { tenantId: string; agentId: string }; cap: number }[];
} {
  const calls: { seedMemoryIds: string[]; scope: { tenantId: string; agentId: string }; cap: number }[] = [];
  const store: MemoryCausalStore = {
    async linkCausal() {
      return ok(0);
    },
    async causalLane(seedMemoryIds, scope, cap) {
      calls.push({ seedMemoryIds, scope, cap });
      return laneResult;
    },
  };
  return { store, calls };
}

describe("createMemoryRecall — causal lane", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) orders the output — the
  // causal-lane RRF contribution is then the only thing under test.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };
  const CAUSAL_ON = { enabled: true, weight: 1.0 };
  const CAUSAL_OFF = { enabled: false, weight: 1.0 };

  /**
   * The pre-causal-lane fused output (fts + vector, no causal lane) — exactly what the
   * default-OFF / empty / err paths must reproduce verbatim (the entity-lane no-op).
   */
  function baseLaneReference(fts: MemorySearchResult[], vector: MemorySearchResult[]): string[] {
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

  it("LANE ON: a causally-linked memory (from the causal store, absent from search) appears in the fused output + trace lanes.causal counts it", async () => {
    // Base lanes: a strong seed + a WEAK non-causal hit. Without the causal lane, fusion ranks
    // [seed, weak] and `linked` is absent entirely.
    const fts = [makeResult("seed", { base: 0.9 }), makeResult("weak", { base: 0.2 })];
    // The causal store returns ONE causally-linked memory NOT in the base lanes, rank-1.
    const { store, calls } = fakeCausalStore(ok([makeResult("linked", { base: 0.99 })]));
    const { recallTrace, records } = recordingRecallTrace();
    const recall = recallWithObs(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        causalStore: store,
        clock: fixedClock,
        logger: noopLogger,
        recallTrace,
      },
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, causal: CAUSAL_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    // The causal lane flipped it in: linked is present in the fused output.
    expect(ids).toContain("linked");
    // Lane invoked once, lazily, with the seed ids, the recall scope, and the maxResults cap.
    expect(calls.length).toBe(1);
    expect(calls[0]?.seedMemoryIds).toContain("seed");
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
    expect(calls[0]?.cap).toBe(5); // baseConfig.maxResults
    // The trace lanes cluster reports the causal candidate count (= lane length).
    const rec = records[0] as { lanes?: { causal?: number } };
    expect(rec.lanes?.causal).toBe(1);
  });

  it("DEFAULT-OFF BYTE-IDENTITY: causal.enabled=false → causalLane NEVER called → output identical to the pre-causal-lane fused path", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const vector = [makeResult("b", { base: 0.5 }), makeResult("c", { base: 0.3 })];
    // The store WOULD return a memory IF called — proving the disabled guard, not an empty lane.
    const { store, calls } = fakeCausalStore(ok([makeResult("linked", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector }),
        causalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, causal: CAUSAL_OFF } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The load-bearing neutrality: causalLane is NEVER called when off (the spy proves it).
    expect(calls.length).toBe(0);
    // Byte-identical to the pre-causal-lane fused path (the entity-lane no-op reused).
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
    expect(got.value.map((r) => r.entry.id)).not.toContain("linked");
  });

  it("NO CAUSAL CONFIG: an absent `lanes.causal` → causalLane NEVER called (byte-identical to before the causal lane)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const { store, calls } = fakeCausalStore(ok([makeResult("linked", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        causalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      // lanes carries ONLY fts/vector — no causal sub-object.
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0);
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("EMPTY-LANE NEUTRAL: an injected store whose causalLane returns ok([]) pushes nothing → output unchanged (the entity-lane no-op)", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const { store, calls } = fakeCausalStore(ok([]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        causalStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, causal: CAUSAL_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The lane WAS queried (enabled + seeds present) but returned empty → fuse() unchanged.
    expect(calls.length).toBe(1);
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NO causalStore: an undefined store → no causal lane, output identical to the base lanes", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const recall = createMemoryRecall(
      { memoryPort: fakeLaneMemoryPort({ fts, vector: [] }), clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, causal: CAUSAL_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NON-FATAL: a causalLane that returns err → recall WARNs and ranks WITHOUT the causal lane (never fails)", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const warns: Record<string, unknown>[] = [];
    const capturingLogger = {
      ...noopLogger,
      warn: (obj: Record<string, unknown>) => {
        warns.push(obj);
      },
    } as unknown as ComisLogger;
    const { store } = fakeCausalStore(err(new Error("causal SQL exploded")));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        causalStore: store,
        clock: fixedClock,
        logger: capturingLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, causal: CAUSAL_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    // The search/base lanes already succeeded — recall never fails because the causal lane
    // failed; it WARNs and ranks WITHOUT the lane (the base order is preserved).
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
    const warn = warns.find((w) => typeof w.hint === "string" && /causal/.test(String(w.hint)));
    expect(warn).toBeDefined();
    expect(warn?.errorKind).toBe("internal");
  });
});

// Direct unit coverage of appendCausalLane (the extracted helper). The recall-pipeline tests
// above exercise the err / empty / push paths through createMemoryRecall; this covers the
// helper's defensive empty-seedIds early-return, which the call site (which gates on a non-empty
// seedPool → non-empty seedIds) cannot reach — keeping every helper branch covered.
describe("appendCausalLane (the extracted 5th-lane helper)", () => {
  function causalStoreReturning(r: Result<MemorySearchResult[], Error>): MemoryCausalStore {
    return {
      async linkCausal() {
        return ok(0);
      },
      async causalLane() {
        return r;
      },
    };
  }

  it("returns 0 and pushes nothing when seedIds is empty (the defensive early-return)", async () => {
    const lanes: FusionLane[] = [{ results: [makeResult("base")], weight: 1.0 }];
    let called = false;
    const store: MemoryCausalStore = {
      async linkCausal() {
        return ok(0);
      },
      async causalLane() {
        called = true;
        return ok([]);
      },
    };
    const count = await appendCausalLane(lanes, store, 1.0, 5, [], SESSION_KEY_OBJ, "agent_y", noopLogger);
    expect(count).toBe(0);
    expect(called).toBe(false); // never queried with no seeds
    expect(lanes.length).toBe(1); // unchanged
  });

  it("pushes the lane + returns the count on a non-empty result", async () => {
    const lanes: FusionLane[] = [{ results: [makeResult("base")], weight: 1.0 }];
    const store = causalStoreReturning(ok([makeResult("linked1"), makeResult("linked2")]));
    const count = await appendCausalLane(lanes, store, 2.0, 5, ["seed"], SESSION_KEY_OBJ, "agent_y", noopLogger);
    expect(count).toBe(2);
    expect(lanes.length).toBe(2);
    expect(lanes[1]?.weight).toBe(2.0);
  });
});

// ===========================================================================
// Graph-spread lane — the 6th fused lane, APPENDED after the causal
// lane (fts, vector, entity, temporal, causal, graphSpread). Mirrors the causal
// block tier-for-tier: a triple-store stub + the LANE-ON lift / DEFAULT-OFF
// byte-identity (the spy proves ZERO calls) / NO-CONFIG / EMPTY-lane neutral /
// NO-store / NON-FATAL invariants. The seeds are the top base hits' CONTENT
// (subject strings), per the interfaces gate.
// ===========================================================================

/**
 * A controllable TripleStorePort stub. `spreadLane` returns a canned Result and records
 * every call (seedSubjects + scope + maxDepth + fanOut + cap) so the gate / scope /
 * not-called invariants are assertable. The write/asOf/currentTruth methods are the
 * unused halves (recall only calls spreadLane). Mirrors {@link fakeCausalStore}.
 */
function fakeTripleStore(laneResult: Result<MemorySearchResult[], Error>): {
  store: TripleStorePort;
  calls: {
    seedSubjects: string[];
    scope: { tenantId: string; agentId: string };
    maxDepth: number;
    fanOut: number;
    cap: number;
  }[];
} {
  const calls: {
    seedSubjects: string[];
    scope: { tenantId: string; agentId: string };
    maxDepth: number;
    fanOut: number;
    cap: number;
  }[] = [];
  const store: TripleStorePort = {
    async upsertTriple() {
      return ok(undefined);
    },
    async asOf() {
      return ok([]);
    },
    async currentTruth() {
      return ok([]);
    },
    async spreadLane(seedSubjects, scope, maxDepth, fanOut, cap) {
      calls.push({ seedSubjects, scope, maxDepth, fanOut, cap });
      return laneResult;
    },
  };
  return { store, calls };
}

describe("createMemoryRecall — graph-spread lane", () => {
  // Boosts neutralized so the FUSION verdict (not score() boosts) orders the output — the
  // graph-spread RRF contribution is then the only thing under test.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };
  const GS_ON = { enabled: true, weight: 1.0, maxDepth: 2, fanOut: 8 };
  const GS_OFF = { enabled: false, weight: 1.0, maxDepth: 2, fanOut: 8 };

  /** The pre-graphSpread fused output (fts + vector, no spread lane) — the no-op reproduces this verbatim. */
  function baseLaneReference(fts: MemorySearchResult[], vector: MemorySearchResult[]): string[] {
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

  it("LANE ON: a structurally-linked memory (from the triple store, absent from search) appears in the fused output + carries the seeds/scope/caps", async () => {
    const fts = [makeResult("seed", { base: 0.9 }), makeResult("weak", { base: 0.2 })];
    const { store, calls } = fakeTripleStore(ok([makeResult("spread", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        tripleStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, graphSpread: GS_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toContain("spread");
    // Lane invoked once, lazily; seeds = top hits' CONTENT; scope = recall scope; caps from config.
    expect(calls.length).toBe(1);
    expect(calls[0]?.seedSubjects).toContain("content for seed");
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
    expect(calls[0]?.maxDepth).toBe(2);
    expect(calls[0]?.fanOut).toBe(8);
    expect(calls[0]?.cap).toBe(5); // baseConfig.maxResults
  });

  it("DEFAULT-OFF BYTE-IDENTITY: graphSpread.enabled=false → spreadLane NEVER called → output identical to the pre-graphSpread fused path", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const vector = [makeResult("b", { base: 0.5 }), makeResult("c", { base: 0.3 })];
    const { store, calls } = fakeTripleStore(ok([makeResult("spread", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector }),
        tripleStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, graphSpread: GS_OFF } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0); // the spy proves the off path never queries
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
    expect(got.value.map((r) => r.entry.id)).not.toContain("spread");
  });

  it("NO graphSpread CONFIG: an absent lanes.graphSpread → spreadLane NEVER called (byte-identical to before this plan)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const { store, calls } = fakeTripleStore(ok([makeResult("spread", { base: 0.99 })]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        tripleStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0);
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("EMPTY-LANE NEUTRAL: an injected store whose spreadLane returns ok([]) pushes nothing → output unchanged (the entity-lane no-op)", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const { store, calls } = fakeTripleStore(ok([]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        tripleStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, graphSpread: GS_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(1); // queried (enabled + seeds) but empty
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NO tripleStore: an undefined store → no graph-spread lane, output identical to the base lanes", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const recall = createMemoryRecall(
      { memoryPort: fakeLaneMemoryPort({ fts, vector: [] }), clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, graphSpread: GS_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("NON-FATAL: a spreadLane that returns err → recall WARNs and ranks WITHOUT the graph-spread lane (never fails)", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const warns: Record<string, unknown>[] = [];
    const capturingLogger = {
      ...noopLogger,
      warn: (obj: Record<string, unknown>) => {
        warns.push(obj);
      },
    } as unknown as ComisLogger;
    const { store } = fakeTripleStore(err(new Error("spread CTE exploded")));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        tripleStore: store,
        clock: fixedClock,
        logger: capturingLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: { ...PARITY_LANES, graphSpread: GS_ON } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
    const warn = warns.find((w) => typeof w.hint === "string" && /graph[- ]?spread/i.test(String(w.hint)));
    expect(warn).toBeDefined();
    expect(warn?.errorKind).toBe("internal");
  });
});

// ── Query-understanding wiring (intent reweight + synonyms + NL range) ──
//
// Three thin gated call-sites in createMemoryRecall, all DEFAULT-OFF byte-identical:
//   intent reweight  — classifyIntent(query) once; intentMultiplier(intent, lane)
//                      multiplies each lane's FusionLane weight (1.0 when off/factual).
//   synonym          — expandSynonyms(query) replaces the search query string (whole-query).
//   NL temporal      — parseTemporalRange(query, deps.clock.now()) → occurredAtRange on
//                      the search options (no temporal-lane double-apply).
//
// The spy on fakeLaneMemoryPort records the (query, options) the search received, so the off-path
// proof is: ORIGINAL query + NO occurredAtRange + the fused ids === baseLaneReference (mirror :2109).
describe("createMemoryRecall — query understanding", () => {
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };
  const QU_OFF = { intentReweight: false, synonyms: false, temporalParse: false };

  /** The pre-IQ fused output (fts + vector, no reweight/expansion/range) — byte-identity reference. */
  function baseLaneReference(fts: MemorySearchResult[], vector: MemorySearchResult[]): string[] {
    const lanes = [] as Parameters<typeof fuse>[0];
    if (fts.length > 0) lanes.push({ results: fts, weight: 1.0 });
    if (vector.length > 0) lanes.push({ results: vector, weight: 1.5 });
    const scored = score(fuse(lanes), NEUTRAL, NOW);
    const allowed = new Set<TrustLevel>(["system", "learned"]);
    return deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map((r) => r.entry.id);
  }

  /** A temporal-spread store stub recording its calls (mirror fakeTripleStore). */
  function fakeTemporalStore(
    laneResult: Result<MemorySearchResult[], Error>,
  ): { store: MemoryTemporalStore; calls: number } {
    let calls = 0;
    const store = {
      async spreadLane() {
        calls += 1;
        return laneResult;
      },
    } as unknown as MemoryTemporalStore;
    return {
      store,
      get calls() {
        return calls;
      },
    };
  }

  it("DEFAULT-OFF BYTE-IDENTITY: queryUnderstanding all-false → search gets the ORIGINAL query + NO occurredAtRange + output === baseLaneReference", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const vector = [makeResult("b", { base: 0.5 }), makeResult("c", { base: 0.3 })];
    const capture: { laneOpts?: MemorySearchOptions; searchOpts?: MemorySearchOptions } = {};
    const port = fakeLaneMemoryPort({ fts, vector }, capture);
    // Record the EXACT query string the searchLanes call received.
    let seenQuery: string | undefined;
    const recordingPort = {
      ...port,
      async searchLanes(key: SessionKey, q: string, opts?: MemorySearchOptions) {
        seenQuery = q;
        capture.laneOpts = opts;
        return ok({ fts, vector });
      },
    } as unknown as MemoryPort;
    const recall = createMemoryRecall(
      { memoryPort: recordingPort, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, queryUnderstanding: QU_OFF } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("vps config db status", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // OFF ⇒ the search receives the ORIGINAL query (no synonym expansion) …
    expect(seenQuery).toBe("vps config db status");
    // … the options carry NO occurredAtRange (no temporal parse) …
    expect(capture.laneOpts?.occurredAtRange).toBeUndefined();
    // … and the fused output is byte-identical to the pre-IQ path (unmultiplied weights).
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
  });

  it("NO queryUnderstanding CONFIG: an absent queryUnderstanding → original query + no range (byte-identical)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const capture: { laneOpts?: MemorySearchOptions } = {};
    let seenQuery: string | undefined;
    const recordingPort = {
      async search() {
        return ok(fts);
      },
      async searchLanes(_key: SessionKey, q: string, opts?: MemorySearchOptions) {
        seenQuery = q;
        capture.laneOpts = opts;
        return ok({ fts, vector: [] });
      },
    } as unknown as MemoryPort;
    const recall = createMemoryRecall(
      { memoryPort: recordingPort, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("auth flow", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(seenQuery).toBe("auth flow");
    expect(capture.laneOpts?.occurredAtRange).toBeUndefined();
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("INTENT-ON LIFT: a temporal-intent query with intentReweight=true up-weights the temporal lane so a temporal-lane candidate outranks where it didn't with reweight off (RED on pre-wiring)", async () => {
    // A temporal-intent query ("when …") → classifyIntent → "temporal" → intentMultiplier
    // ×1.5 on the temporal lane. The base lane has ONE strong fts hit; the temporal lane
    // contributes a candidate at rank 1. With NO reweight the base hit leads; with the ×1.5
    // temporal-lane weight the temporal candidate's RRF contribution overtakes it.
    const fts = [makeResult("base_top", { base: 1 }), makeResult("base_mid", { base: 1 })];
    // The seed needs an occurredAt so the temporal lane fires (seed on event time).
    const ftsSeeded = [
      makeResult("base_top", { base: 1, occurredAt: NOW }),
      makeResult("base_mid", { base: 1, occurredAt: NOW }),
    ];
    void fts;
    const temporalLaneHit = [makeResult("temporal_cand", { base: 1 })];
    const TL = { enabled: true, weight: 1.0, windowDays: 7 };
    const makeRecall = (qu: { intentReweight: boolean; synonyms: boolean; temporalParse: boolean }) => {
      const { store } = fakeTemporalStore(ok(temporalLaneHit));
      return createMemoryRecall(
        {
          memoryPort: fakeLaneMemoryPort({ fts: ftsSeeded, vector: [] }),
          temporalStore: store,
          clock: fixedClock,
          logger: noopLogger,
        } as unknown as Parameters<typeof createMemoryRecall>[0],
        baseConfig({
          scoring: NEUTRAL,
          lanes: { ...PARITY_LANES, temporal: TL },
          queryUnderstanding: qu,
        } as Partial<MemoryRecallConfig>),
      );
    };
    const off = await makeRecall(QU_OFF).recall("when did the base happen", SESSION_KEY_OBJ, "agent_y");
    const on = await makeRecall({ intentReweight: true, synonyms: false, temporalParse: false }).recall(
      "when did the base happen",
      SESSION_KEY_OBJ,
      "agent_y",
    );
    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    const offOrder = off.value.map((r) => r.entry.id);
    const onOrder = on.value.map((r) => r.entry.id);
    // The reweight CHANGES the fused order — the temporal candidate climbs vs the off baseline.
    expect(onOrder).not.toEqual(offOrder);
    const offRank = offOrder.indexOf("temporal_cand");
    const onRank = onOrder.indexOf("temporal_cand");
    expect(onRank).toBeLessThan(offRank); // strictly promoted by the ×1.5 temporal-lane weight
  });

  it("INTENT-OFF FACTUAL: a factual query (no markers) → multiplier 1.0 everywhere even with intentReweight=true → byte-identical to off", async () => {
    // "what is the database name" classifies factual → every lane multiplier is 1.0, so even
    // with intentReweight ON the fused order equals baseLaneReference (the neutral-intent proof).
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const vector = [makeResult("b", { base: 0.5 }), makeResult("c", { base: 0.3 })];
    const recall = createMemoryRecall(
      { memoryPort: fakeLaneMemoryPort({ fts, vector }), clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        queryUnderstanding: { intentReweight: true, synonyms: false, temporalParse: false },
      } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("the project name", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
  });

  it("SYNONYM-ON: synonyms=true → the search receives expandSynonyms(query) (≠ the original for a mapped term)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    let seenQuery: string | undefined;
    const recordingPort = {
      async search() {
        return ok(fts);
      },
      async searchLanes(_key: SessionKey, q: string) {
        seenQuery = q;
        return ok({ fts, vector: [] });
      },
    } as unknown as MemoryPort;
    const recall = createMemoryRecall(
      { memoryPort: recordingPort, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        queryUnderstanding: { intentReweight: false, synonyms: true, temporalParse: false },
      } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("vps", SESSION_KEY_OBJ, "agent_y");
    expect(seenQuery).toBe(expandSynonyms("vps"));
    expect(seenQuery).not.toBe("vps"); // the expansion genuinely changed the query
    expect(seenQuery).toContain("virtual"); // the mapped expansion is present
  });

  it("RANGE-ON: temporalParse=true + 'last week' → the search options carry the parsed occurredAtRange (from the fixedClock)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const capture: { laneOpts?: MemorySearchOptions } = {};
    const recordingPort = {
      async search() {
        return ok(fts);
      },
      async searchLanes(_key: SessionKey, _q: string, opts?: MemorySearchOptions) {
        capture.laneOpts = opts;
        return ok({ fts, vector: [] });
      },
    } as unknown as MemoryPort;
    const recall = createMemoryRecall(
      { memoryPort: recordingPort, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        queryUnderstanding: { intentReweight: false, synonyms: false, temporalParse: true },
      } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("what happened last week", SESSION_KEY_OBJ, "agent_y");
    // The range is computed from deps.clock.now() (= NOW), NEVER Date.now().
    expect(capture.laneOpts?.occurredAtRange).toEqual(parseTemporalRange("what happened last week", NOW));
  });

  it("RANGE-ON UNPARSEABLE: temporalParse=true but no time expression → NO occurredAtRange (byte-identity)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    const capture: { laneOpts?: MemorySearchOptions } = {};
    const recordingPort = {
      async search() {
        return ok(fts);
      },
      async searchLanes(_key: SessionKey, _q: string, opts?: MemorySearchOptions) {
        capture.laneOpts = opts;
        return ok({ fts, vector: [] });
      },
    } as unknown as MemoryPort;
    const recall = createMemoryRecall(
      { memoryPort: recordingPort, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        queryUnderstanding: { intentReweight: false, synonyms: false, temporalParse: true },
      } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("what is the database name", SESSION_KEY_OBJ, "agent_y");
    expect(capture.laneOpts?.occurredAtRange).toBeUndefined();
  });

  it("SYNONYM-OFF byte-identity: synonyms=false → the search receives the ORIGINAL (even for a mapped term)", async () => {
    const fts = [makeResult("a", { base: 0.9 })];
    let seenQuery: string | undefined;
    const recordingPort = {
      async search() {
        return ok(fts);
      },
      async searchLanes(_key: SessionKey, q: string) {
        seenQuery = q;
        return ok({ fts, vector: [] });
      },
    } as unknown as MemoryPort;
    const recall = createMemoryRecall(
      { memoryPort: recordingPort, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, queryUnderstanding: QU_OFF } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("vps", SESSION_KEY_OBJ, "agent_y");
    expect(seenQuery).toBe("vps"); // unexpanded — the mapped term is NOT expanded when off
  });
});

// ── MMR diversity re-rank slot (gated, scoped, non-fatal) ──────────────
//
// A gated scoped embedding read + mmrRerank, placed AFTER the trust-filter and BEFORE dedup
// (diversify EXACTLY the set that will be injected). DEFAULT-OFF byte-identity is the
// load-bearing discipline: with mmr.enabled=false / no embeddingStore / <2 candidates, the block
// is SKIPPED — readEmbeddings is NEVER called (the spy proves it) and `ranked` is unchanged.
describe("createMemoryRecall — MMR diversity re-rank", () => {
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };

  /** A segregated embedding store stub: canned id→vector Map, records every readEmbeddings call. */
  function fakeEmbeddingStore(embeddingsById: Map<string, number[]>): {
    store: MemoryEmbeddingStore;
    calls: { ids: string[]; scope: { tenantId: string; agentId: string } }[];
  } {
    const calls: { ids: string[]; scope: { tenantId: string; agentId: string } }[] = [];
    const store = {
      async readEmbeddings(ids: string[], scope: { tenantId: string; agentId: string }) {
        calls.push({ ids, scope });
        return ok(embeddingsById as ReadonlyMap<string, number[]>);
      },
    } as unknown as MemoryEmbeddingStore;
    return { store, calls };
  }

  /** An embedding store whose read fails (the non-fatal degrade fixture). */
  function failingEmbeddingStore(): { store: MemoryEmbeddingStore; calls: number } {
    let calls = 0;
    const store = {
      async readEmbeddings() {
        calls += 1;
        return err(new Error("vec read exploded"));
      },
    } as unknown as MemoryEmbeddingStore;
    return {
      store,
      get calls() {
        return calls;
      },
    };
  }

  /** The pre-MMR fused output (fts + vector, no MMR) — the off-path/λ=1 byte-identity reference. */
  function baseLaneReference(fts: MemorySearchResult[], vector: MemorySearchResult[]): string[] {
    const lanes = [] as Parameters<typeof fuse>[0];
    if (fts.length > 0) lanes.push({ results: fts, weight: 1.0 });
    if (vector.length > 0) lanes.push({ results: vector, weight: 1.5 });
    const scored = score(fuse(lanes), NEUTRAL, NOW);
    const allowed = new Set<TrustLevel>(["system", "learned"]);
    return deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel))).map((r) => r.entry.id);
  }

  it("DEFAULT-OFF BYTE-IDENTITY: mmr.enabled=false → readEmbeddings NEVER called → output === baseLaneReference", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const vector = [makeResult("b", { base: 0.5 }), makeResult("c", { base: 0.3 })];
    const { store, calls } = fakeEmbeddingStore(
      new Map([
        ["a", [1, 0]],
        ["b", [1, 0]],
        ["c", [0, 1]],
      ]),
    );
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector }),
        embeddingStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, mmr: { enabled: false, lambda: 0.7 } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0); // THE load-bearing proof: off path never reads
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, vector));
  });

  it("NO mmr CONFIG: an absent cfg.mmr → readEmbeddings NEVER called (byte-identical to before this plan)", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const { store, calls } = fakeEmbeddingStore(new Map([["a", [1, 0]], ["b", [0, 1]]]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        embeddingStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0);
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, []));
  });

  it("λ=1 NEUTRAL: mmr.enabled=true, lambda=1 → readEmbeddings IS called but the order is UNCHANGED (mmrRerank λ=1 identity)", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 }), makeResult("c", { base: 0.2 })];
    const { store, calls } = fakeEmbeddingStore(
      new Map([
        ["a", [1, 0]],
        ["b", [1, 0]],
        ["c", [0, 1]],
      ]),
    );
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        embeddingStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, mmr: { enabled: true, lambda: 1 } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(1); // ON ⇒ the read happens …
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, [])); // … but λ=1 is identity
  });

  it("<2 CANDIDATES GUARD: a single-candidate recall with mmr.enabled=true → ranked.length<2 → readEmbeddings NEVER called", async () => {
    const fts = [makeResult("only", { base: 0.9 })];
    const { store, calls } = fakeEmbeddingStore(new Map([["only", [1, 0]]]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        embeddingStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, mmr: { enabled: true, lambda: 0.5 } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(calls.length).toBe(0); // the <2 guard short-circuits before the read
    expect(got.value.map((r) => r.entry.id)).toEqual(["only"]);
  });

  it("MMR-ON DIVERSITY LIFT: an orthogonal candidate is promoted ahead of a near-duplicate vs the OFF order (RED on pre-wiring)", async () => {
    // Single FTS lane (pass-through preserves the base scores as rel). A and B are near-duplicate-
    // embedded (cos≈1), C is orthogonal (cos 0). With λ=0.5: round 1 picks A (highest rel); round 2
    // B = 0.5·relB − 0.5·1 (penalized to A), C = 0.5·relC − 0.5·0 (no penalty) → C overtakes B.
    const fts = [
      makeResult("A", { base: 0.9, trustLevel: "learned" }),
      makeResult("B", { base: 0.85, trustLevel: "learned" }),
      makeResult("C", { base: 0.8, trustLevel: "learned" }),
    ];
    const embeddings = new Map<string, number[]>([
      ["A", [1, 0]],
      ["B", [1, 0]], // identical to A → cos 1 (near-duplicate)
      ["C", [0, 1]], // orthogonal to A → cos 0 (diverse)
    ]);
    const offRecall = createMemoryRecall(
      { memoryPort: fakeLaneMemoryPort({ fts, vector: [] }), clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, minScore: 0, lanes: PARITY_LANES } as Partial<MemoryRecallConfig>),
    );
    const off = await offRecall.recall("q", SESSION_KEY_OBJ, "agent_y");
    const { store } = fakeEmbeddingStore(embeddings);
    const onRecall = createMemoryRecall(
      { memoryPort: fakeLaneMemoryPort({ fts, vector: [] }), embeddingStore: store, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, minScore: 0, lanes: PARITY_LANES, mmr: { enabled: true, lambda: 0.5 } } as Partial<MemoryRecallConfig>),
    );
    const on = await onRecall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(off.ok && on.ok).toBe(true);
    if (!off.ok || !on.ok) return;
    const offOrder = off.value.map((r) => r.entry.id);
    const onOrder = on.value.map((r) => r.entry.id);
    expect(offOrder).toEqual(["A", "B", "C"]); // relevance order (no diversity)
    expect(onOrder).toEqual(["A", "C", "B"]); // MMR promotes the orthogonal C ahead of the near-dup B
    expect(onOrder).not.toEqual(offOrder); // the reorder is real (RED on pre-wiring)
  });

  it("SCOPE: the recorded readEmbeddings call's scope === {tenantId: SESSION_KEY_OBJ.tenantId, agentId: <recall agentId>}", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 })];
    const { store, calls } = fakeEmbeddingStore(new Map([["a", [1, 0]], ["b", [0, 1]]]));
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        embeddingStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, mmr: { enabled: true, lambda: 0.5 } } as Partial<MemoryRecallConfig>),
    );
    await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(calls.length).toBe(1);
    // The load-bearing scope derivation: tenant from the session key, agent from the recall arg.
    expect(calls[0]?.scope).toEqual({ tenantId: "tenant_x", agentId: "agent_y" });
    // The read is of the POST-trust-filter candidate ids (both survive the learned/system filter).
    expect(calls[0]?.ids.sort()).toEqual(["a", "b"]);
  });

  it("NON-FATAL: a readEmbeddings that returns err → recall returns ok with the pre-MMR order + a WARN was logged", async () => {
    const fts = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.4 }), makeResult("c", { base: 0.2 })];
    const warns: Record<string, unknown>[] = [];
    const capturingLogger = {
      ...noopLogger,
      warn: (obj: Record<string, unknown>) => {
        warns.push(obj);
      },
    } as unknown as ComisLogger;
    const failing = failingEmbeddingStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        embeddingStore: failing.store,
        clock: fixedClock,
        logger: capturingLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, lanes: PARITY_LANES, mmr: { enabled: true, lambda: 0.5 } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true); // recall NEVER fails because the embedding read failed
    if (!got.ok) return;
    expect(failing.calls).toBe(1); // the read was attempted (live getter, read post-recall) …
    expect(got.value.map((r) => r.entry.id)).toEqual(baseLaneReference(fts, [])); // … and we ranked WITHOUT MMR
    const warn = warns.find((w) => typeof w.hint === "string" && /mmr|diversity/i.test(String(w.hint)));
    expect(warn).toBeDefined();
    expect(warn?.errorKind).toBe("internal");
  });

  it("PLACEMENT: MMR re-orders ONLY the post-trust-filter survivors (an excluded candidate is never re-surfaced)", async () => {
    // An "external" candidate is dropped by the trust filter BEFORE MMR. Even though it would be
    // maximally diverse (orthogonal embedding), MMR can never re-surface it — by placement.
    const fts = [
      makeResult("A", { base: 0.9, trustLevel: "learned" }),
      makeResult("B", { base: 0.85, trustLevel: "learned" }),
      makeResult("EXT", { base: 0.99, trustLevel: "external" }), // dropped by the trust filter
    ];
    const embeddings = new Map<string, number[]>([
      ["A", [1, 0]],
      ["B", [1, 0]],
      ["EXT", [0, 1]],
    ]);
    const { store, calls } = fakeEmbeddingStore(embeddings);
    const recall = createMemoryRecall(
      {
        memoryPort: fakeLaneMemoryPort({ fts, vector: [] }),
        embeddingStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: NEUTRAL, minScore: 0, lanes: PARITY_LANES, mmr: { enabled: true, lambda: 0.5 } } as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.map((r) => r.entry.id)).not.toContain("EXT"); // never re-surfaced
    // The read saw ONLY the post-trust-filter ids (EXT was already excluded — security boundary).
    expect(calls[0]?.ids).not.toContain("EXT");
  });
});

// ---------------------------------------------------------------------------
// Recall stays LLM-FREE (the binding constraint)
// ---------------------------------------------------------------------------

describe("llm-free", () => {
  it("a full recall run makes NO query-time model call (createMemoryRecall never reaches pi-ai)", async () => {
    // The dialectic's memory.ask is the ONE allowed query-time LLM surface and it lives
    // in the daemon handler AFTER recall — NOT inside createMemoryRecall. This regression
    // lock proves recall itself is deterministic + LLM-free: run the full pipeline over a
    // realistic fixture (mixed trust, dedup, a reranker, a fake timer) and assert neither
    // pi-ai entrypoint was ever called.
    vi.mocked(completeSimple).mockClear();
    vi.mocked(getModel).mockClear();

    const input = [
      makeResult("sys", { base: 0.9, trustLevel: "system", createdAt: NOW }),
      makeResult("lrn", { base: 0.6, trustLevel: "learned", createdAt: NOW - 86_400_000 }),
      makeResult("dup", { base: 0.5, trustLevel: "learned", content: "content for lrn" }),
      makeResult("ext", { base: 0.3, trustLevel: "external", createdAt: NOW }),
    ];
    const { port: rerankerPort } = mockReranker({ available: true });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        reranker: rerankerPort,
        timers: fakeTimers().port,
        clock: fixedClock,
        logger: noopLogger,
      },
      baseConfig({ rerank: { enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 } }),
    );

    const got = await recall.recall("what is the timezone", SESSION_KEY, "default");
    expect(got.ok).toBe(true);

    // The binding constraint: recall touched NO model surface.
    expect(completeSimple).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pinned-first recall lane (SC1 + SC2-cap + SC4-mmr)
//
// DEFAULT-OFF: with pinnedStore absent or pinned.enabled=false, the pinned lane
// is never executed — the recall pipeline is byte-identical to pre-pinning.
// When enabled, the Step-0 lane fetches pinned entries and prepends them to the
// final result AFTER the fused/mmr/dedup pipeline, bounded by maxPinnedInjection.
// ---------------------------------------------------------------------------

import type { MemoryPinnedStore } from "@comis/core";

describe("createMemoryRecall — pinned-first lane (SC1 + SC2-cap + SC4-mmr)", () => {
  /** Minimal MemoryPinnedStore stub returning a canned pinned result list. */
  function createMockPinnedStore(
    pinnedEntries: Array<{ id: string; content: string; score: number }>,
  ): MemoryPinnedStore {
    return {
      async pin() {
        return ok(true);
      },
      async unpin() {
        return ok(true);
      },
      async listPinned(_scope: { tenantId: string; agentId: string }, limit: number) {
        const capped = pinnedEntries.slice(0, limit);
        return ok(
          capped.map((e) => ({
            entry: {
              id: e.id,
              tenantId: "tenant_x",
              agentId: "default",
              userId: "user_a",
              content: e.content,
              trustLevel: "system" as const,
              source: { who: "agent" },
              tags: [],
              createdAt: NOW,
            } as unknown as MemorySearchResult["entry"],
            score: e.score,
          })),
        );
      },
    };
  }

  const NEUTRAL_SCORING: ScoringAlphas = {
    recencyAlpha: 0,
    temporalAlpha: 0,
    proofAlpha: 0,
    trustAlpha: 0,
    usefulnessAlpha: 0,
  };

  it("returns a pinned entry first even when its fused score ranks below top-K", async () => {
    // SC1: the pinned-first lane ensures pinned entries are returned at the head of
    // the result regardless of their fused relevance score.
    // Pre-patch (no lane): pinnedId is ABSENT from recall → test FAILS.
    // Post-patch (Step-0 lane): pinnedId is result[0] → test PASSES.
    const pinnedId = "pinned-low-score-001";
    const mockPinnedStore = createMockPinnedStore([
      { id: pinnedId, content: "standing instruction: always use metric units", score: 1.0 },
    ]);
    const nonPinnedResults = [
      makeResult("high-a", { base: 0.95 }),
      makeResult("high-b", { base: 0.90 }),
      makeResult("high-c", { base: 0.85 }),
      makeResult("high-d", { base: 0.80 }),
      makeResult("high-e", { base: 0.75 }),
    ];
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(nonPinnedResults),
        pinnedStore: mockPinnedStore,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL_SCORING,
        pinned: { enabled: true, maxPinnedInjection: 5 },
      }),
    );
    const result = await recall.recall("some query returning high-score non-pinned entries", SESSION_KEY_OBJ, "default");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).toContain(pinnedId);
    expect(result.value[0].entry.id).toBe(pinnedId); // pinned is FIRST
  });

  it("maxPinnedInjection cap limits injected pins when count exceeds the configured cap", async () => {
    // SC2-cap: listPinned is called with limit=maxPinnedInjection; only cap entries injected.
    // Pre-patch (no lane): all 10 would be absent → test FAILS on count.
    // Post-patch: exactly 5 pinned entries in result (cap=5 out of 10 available).
    const tenEntries = Array.from({ length: 10 }, (_, i) => ({
      id: `pin-${i}`,
      content: `pinned content ${i}`,
      score: 1.0,
    }));
    const mockPinnedStore = createMockPinnedStore(tenEntries);
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort([]),
        pinnedStore: mockPinnedStore,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL_SCORING,
        pinned: { enabled: true, maxPinnedInjection: 5 },
      }),
    );
    const result = await recall.recall("query", SESSION_KEY_OBJ, "default");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the first 5 of 10 pinned entries should be injected (cap enforced via limit param)
    const pinnedInResult = result.value.filter((r) => r.entry.id.startsWith("pin-"));
    expect(pinnedInResult).toHaveLength(5);
  });

  it("pinned IDs are excluded from MMR candidates preventing double injection in results", async () => {
    // SC4-mmr: a pinned entry that also ranks highly in fused results must appear
    // exactly once (as the prepended pin), never twice.
    // Pre-patch (no dedup): overlap-001 appears in both fused ranked and prepended → twice.
    // Post-patch (Step 5b-pre filter): overlap-001 filtered from ranked before MMR → once.
    const overlapId = "overlap-001";
    const mockPinnedStore = createMockPinnedStore([
      { id: overlapId, content: "pinned and high-ranked entry", score: 1.0 },
    ]);
    // The fused recall also returns overlap-001 (high score 0.9)
    const fusedResults = [
      makeResult(overlapId, { base: 0.9, content: "pinned and high-ranked entry" }),
      makeResult("other-a", { base: 0.7 }),
      makeResult("other-b", { base: 0.5 }),
    ];
    // Use a simple embedding store for MMR so we can test the dedup path
    const embeddingsMap = new Map<string, number[]>([
      [overlapId, [1, 0, 0]],
      ["other-a", [0, 1, 0]],
      ["other-b", [0, 0, 1]],
    ]);
    const fakeEmbStore = {
      async readEmbeddings(ids: string[]) {
        return ok(embeddingsMap as ReadonlyMap<string, number[]>);
      },
    };
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(fusedResults),
        pinnedStore: mockPinnedStore,
        embeddingStore: fakeEmbStore,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL_SCORING,
        pinned: { enabled: true, maxPinnedInjection: 5 },
        mmr: { enabled: true, lambda: 0.5 },
      }),
    );
    const result = await recall.recall("overlapping query", SESSION_KEY_OBJ, "default");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    // overlap-001 must appear exactly once (as pinned — not duplicated by fused)
    const overlapCount = ids.filter((id) => id === overlapId).length;
    expect(overlapCount).toBe(1);
    // It should be the first result (pinned = prepended)
    expect(ids[0]).toBe(overlapId);
  });

  it("pinned lane is DEFAULT-OFF: absent pinnedStore leaves recall byte-identical to pre-pinning", async () => {
    // Safety gate: without pinnedStore the pipeline is completely unchanged.
    const input = [makeResult("a", { base: 0.9 }), makeResult("b", { base: 0.6 })];
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        // NO pinnedStore injected
        clock: fixedClock,
        logger: noopLogger,
      },
      baseConfig({ scoring: NEUTRAL_SCORING }),
    );
    const result = await recall.recall("q", SESSION_KEY, "default");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.entry.id)).toEqual(["a", "b"]);
  });

  it("CR-04: pinned entry with a disallowed trustLevel is filtered out before prepend", async () => {
    // CR-04: pinned entries bypass the trust filter. A pinned entry whose trustLevel
    // is NOT in cfg.includeTrustLevels must be excluded from finalRanked.
    // Pre-patch: the entry is prepended unconditionally → it appears in results.
    // Post-patch: filtered → it does NOT appear in results.
    const disallowedPinnedId = "pinned-external-001";
    const disallowedTrustStore: MemoryPinnedStore = {
      async pin() { return ok(true); },
      async unpin() { return ok(true); },
      async listPinned(_scope, _limit) {
        return ok([
          {
            entry: {
              id: disallowedPinnedId,
              tenantId: "t",
              agentId: "default",
              userId: "u",
              content: "disallowed pinned content",
              trustLevel: "external" as const,
              source: { who: "agent" },
              tags: [],
              createdAt: NOW,
            } as unknown as MemorySearchResult["entry"],
            score: 1.0,
          },
        ]);
      },
    };
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort([]),
        pinnedStore: disallowedTrustStore,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL_SCORING,
        // Only "learned" and "system" are allowed — "external" is NOT.
        includeTrustLevels: ["learned", "system"],
        pinned: { enabled: true, maxPinnedInjection: 5 },
      }),
    );
    const result = await recall.recall("query", SESSION_KEY_OBJ, "default");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.map((r) => r.entry.id);
    expect(ids).not.toContain(disallowedPinnedId); // external-trust pinned entry must be filtered
  });

  it("WR-03: pinned lane WARN log on failure includes durationMs", async () => {
    // WR-03: the WARN emitted when listPinned fails must include durationMs per AGENTS.md §2.7.
    // Pre-patch: the WARN omits durationMs.
    // Post-patch: durationMs is present.
    const warnMock = vi.fn();
    const failingPinnedStore: MemoryPinnedStore = {
      async pin() { return ok(true); },
      async unpin() { return ok(true); },
      async listPinned() {
        return { ok: false, error: new Error("simulated listPinned failure") } as Awaited<ReturnType<MemoryPinnedStore["listPinned"]>>;
      },
    };
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort([]),
        pinnedStore: failingPinnedStore,
        clock: fixedClock,
        logger: { info: vi.fn(), warn: warnMock, debug: vi.fn() },
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL_SCORING,
        pinned: { enabled: true, maxPinnedInjection: 5 },
      }),
    );
    await recall.recall("query", SESSION_KEY_OBJ, "default");
    expect(warnMock).toHaveBeenCalledOnce();
    const warnPayload = warnMock.mock.calls[0][0] as Record<string, unknown>;
    expect(warnPayload).toHaveProperty("durationMs"); // AGENTS.md §2.7 requirement
    expect(typeof warnPayload.durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// DIST-03 POST-FUSION PROVENANCE DOWN-WEIGHTING PASS
//
// When a distilled summary (tag "lcd_distilled") is in the ranked set, the
// recall pipeline down-weights same-conversation paired memories whose covered
// range overlaps (score × 0.5, NEVER delete). The pass runs AFTER mmrRerank and
// BEFORE captureRecallObservability, is guarded by `deps.provenanceStore != null`,
// is NON-FATAL (a provenance failure never affects recall results), and is
// BYTE-IDENTICAL when provenanceStore is absent / no lcd_distilled result.
//
// W6 INVARIANT: the distilled summary itself (and any OTHER lcd_distilled entry)
// is NEVER down-weighted — the predicate is fully parenthesized
// (candidate.id !== summary.id AND !candidateIsDistilled, candidateIsDistilled a
// separate boolean) so the &&/|| precedence trap cannot down-weight the summary.
// ---------------------------------------------------------------------------

/**
 * A controllable LcdProvenanceReadStore spy. `getProvenanceForSummary` returns a
 * canned row set keyed by summaryId and records every (scope, summaryId) call so
 * the load-bearing call-site (the pass actually queries the port) is assertable.
 */
function fakeProvenanceStore(
  rowsBySummaryId: Record<
    string,
    Array<{ provenanceId: string; memoryId: string; sourceSessionKey: string; supersededBy: string | null }>
  > = {},
  opts: { throwOnCall?: boolean } = {},
): {
  store: { getProvenanceForSummary: (scope: unknown, summaryId: string) => unknown };
  calls: Array<{ scope: { tenantId: string; agentId: string; conversationId?: string; sessionKey?: string }; summaryId: string }>;
} {
  const calls: Array<{ scope: { tenantId: string; agentId: string; conversationId?: string; sessionKey?: string }; summaryId: string }> = [];
  const store = {
    getProvenanceForSummary(scope: unknown, summaryId: string) {
      calls.push({ scope: scope as { tenantId: string; agentId: string; conversationId?: string; sessionKey?: string }, summaryId });
      if (opts.throwOnCall) throw new Error("provenance store exploded");
      return rowsBySummaryId[summaryId] ?? [];
    },
  };
  return { store, calls };
}

/** Neutral scoring so the ONLY observable score delta in these tests is the pass's ×0.5. */
const DIST_NEUTRAL_SCORING: ScoringAlphas = {
  recencyAlpha: 0,
  temporalAlpha: 0,
  proofAlpha: 0,
  trustAlpha: 0,
  usefulnessAlpha: 0,
};

describe("createMemoryRecall — DIST-03 provenance down-weighting", () => {
  // The two stable strings the fixtures share.
  const CONV_SESSION = "telegram:chat_1:user_a"; // the distilled summary's source.sessionKey

  it("down-weights a same-session paired memory (score × 0.5) when a lcd_distilled result is selected, never deleting it", async () => {
    // The distilled summary + a paired conversation memory from the SAME session,
    // plus an unrelated memory from a DIFFERENT session that must NOT be touched.
    const input = [
      makeResult("distilled", {
        base: 0.9,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1"],
        sessionKey: CONV_SESSION,
      }),
      makeResult("paired", {
        base: 0.8,
        trustLevel: "learned",
        tags: ["conversation", "paired"],
        sessionKey: CONV_SESSION,
      }),
      makeResult("other-session", {
        base: 0.7,
        trustLevel: "learned",
        tags: ["conversation", "paired"],
        sessionKey: "telegram:chat_9:user_z",
      }),
    ];
    const { store } = fakeProvenanceStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
    // The paired same-session memory survives (NOT deleted) but is down-weighted.
    expect(byId.has("paired")).toBe(true);
    const pairedScore = byId.get("paired")!;
    // The other-session memory keeps its score (≈0.7 base, neutral scoring → unchanged).
    const otherScore = byId.get("other-session")!;
    expect(pairedScore).toBeLessThan(otherScore);
    // The distilled summary itself is never down-weighted (W6).
    const distilledScore = byId.get("distilled")!;
    expect(distilledScore).toBeGreaterThan(pairedScore);
  });

  it("CR-01: a down-weighted paired memory MOVES BELOW a non-downweighted peer it previously outranked (the demotion changes RANK, not just score)", async () => {
    // The headline BLOCKER: applyProvenanceDownweighting multiplied `score` by 0.5
    // but PRESERVED array position, and nothing downstream re-sorts (deduplicateResults
    // preserves order; the hybrid injector consumes in order). So the demotion was a
    // functional no-op for RANKING. This test asserts ORDER, not score.
    //
    // RED on pre-patch code: `paired` (base 0.8) enters ABOVE `peer` (base 0.6) in the
    // fused/scored order. The pass halves paired → 0.4 (< peer's 0.6) but leaves it in
    // slot 0. Pre-patch: got.value order is still [distilled, paired, peer] → the
    // assertion `idx(paired) > idx(peer)` FAILS. GREEN (re-sort by descending score):
    // the order becomes [distilled, peer, paired] → paired sinks below peer.
    const input = [
      makeResult("distilled", {
        base: 0.9,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1"],
        sessionKey: CONV_SESSION,
      }),
      makeResult("paired", {
        base: 0.8, // OUTRANKS peer pre-pass (0.8 > 0.6); ×0.5 → 0.4 (< 0.6) post-pass
        trustLevel: "learned",
        tags: ["conversation", "paired"],
        sessionKey: CONV_SESSION, // same session as the distilled summary → down-weighted
      }),
      makeResult("peer", {
        base: 0.6, // a non-downweighted peer from a DIFFERENT session
        trustLevel: "learned",
        tags: ["conversation"],
        sessionKey: "telegram:chat_OTHER:user_z",
      }),
    ];
    const { store } = fakeProvenanceStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const order = got.value.map((r) => r.entry.id);
    const idxPaired = order.indexOf("paired");
    const idxPeer = order.indexOf("peer");
    // Both survive (down-weight never deletes).
    expect(idxPaired).toBeGreaterThanOrEqual(0);
    expect(idxPeer).toBeGreaterThanOrEqual(0);
    // The CONTRACT: the demoted paired row now ranks BELOW the peer it previously
    // outranked — the demotion is observable in ORDER (not merely the score value).
    expect(idxPaired).toBeGreaterThan(idxPeer);
    // Sanity: the down-weighted score really is below the peer's (the cause of the move).
    const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
    expect(byId.get("paired")!).toBeLessThan(byId.get("peer")!);
  });

  it("CR-01 STABLE re-sort: ties between two down-weighted rows preserve their relative input order (index tiebreaker)", async () => {
    // Two same-session paired rows with EQUAL base → both ×0.5 → equal score. The
    // re-sort MUST be STABLE: `pairedA` (input slot 1) stays ahead of `pairedB`
    // (input slot 2). A non-stable sort could swap them. They both sink below the
    // higher-scored peer, but keep their mutual order.
    const input = [
      makeResult("distilled", { base: 0.95, trustLevel: "learned", tags: ["lcd_distilled", "depth:1"], sessionKey: CONV_SESSION }),
      makeResult("pairedA", { base: 0.8, trustLevel: "learned", tags: ["paired"], sessionKey: CONV_SESSION }),
      makeResult("pairedB", { base: 0.8, trustLevel: "learned", tags: ["paired"], sessionKey: CONV_SESSION }),
    ];
    const { store } = fakeProvenanceStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const order = got.value.map((r) => r.entry.id);
    // Stable: pairedA precedes pairedB (their equal scores resolve to input order).
    expect(order.indexOf("pairedA")).toBeLessThan(order.indexOf("pairedB"));
  });

  it("IN-03: branch (2) does NOT over-demote a legitimately-distinct same-session memory once the precise summary:<id> tag is present", async () => {
    // The IN-03 over-reach: when CR-01 makes the pass effective, the SESSION-HEURISTIC
    // branch (2) — which down-weights EVERY non-distilled candidate sharing the
    // summary's sessionKey — suppresses same-session memories the precise provenance
    // branch (1) never linked. Once 173-04 stamps the summary:<id> tag, branch (1) is
    // the primary selector; branch (2) must be GATED OFF so a distinct same-session
    // row keeps its rank.
    //
    // RED on pre-patch code (branch 2 always runs): `distinct` shares CONV_SESSION but
    // is NOT in the provenance row set, so the heuristic down-weights it anyway →
    // demoted below `peer`. GREEN (branch 2 gated behind absence of a usable
    // summary:<id> tag): the precise branch links only `linked`; `distinct` keeps its
    // score and stays ABOVE peer.
    const SUMMARY_ID = "sum-in03";
    const input = [
      makeResult("distilled", {
        base: 0.95,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1", `summary:${SUMMARY_ID}`],
        sessionKey: CONV_SESSION,
      }),
      makeResult("linked", {
        base: 0.8, // the genuinely-subsumed paired row (in the provenance set)
        trustLevel: "learned",
        tags: ["paired"],
        sessionKey: CONV_SESSION,
      }),
      makeResult("distinct", {
        base: 0.7, // shares the session but is NOT in the provenance set — must NOT demote
        trustLevel: "learned",
        tags: ["conversation"],
        sessionKey: CONV_SESSION,
      }),
      makeResult("peer", {
        base: 0.6, // a different-session peer `distinct` outranks pre-pass
        trustLevel: "learned",
        tags: ["conversation"],
        sessionKey: "telegram:chat_OTHER:user_z",
      }),
    ];
    const { store } = fakeProvenanceStore({
      [SUMMARY_ID]: [{ provenanceId: "p1", memoryId: "linked", sourceSessionKey: CONV_SESSION, supersededBy: null }],
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
    const order = got.value.map((r) => r.entry.id);
    // The genuinely-linked row IS demoted (precise branch 1 fired) → below peer.
    expect(byId.get("linked")!).toBeLessThan(byId.get("peer")!);
    expect(order.indexOf("linked")).toBeGreaterThan(order.indexOf("peer"));
    // The legitimately-distinct same-session row is NOT demoted → keeps its rank ABOVE peer.
    expect(byId.get("distinct")!).toBeCloseTo(0.7, 10);
    expect(order.indexOf("distinct")).toBeLessThan(order.indexOf("peer"));
  });

  it("IN-03: with NO usable summary:<id> tag, the session heuristic (branch 2) STILL fires (fallback preserved)", async () => {
    // The complement of the test above: when the distilled summary carries NO precise
    // summary:<id> tag, branch (1) cannot select anything, so branch (2) must remain the
    // fallback selector — a same-session paired row is still demoted. This pins that the
    // IN-03 gate scopes branch (2) to the no-precise-tag case rather than removing it.
    const input = [
      makeResult("distilled", { base: 0.95, trustLevel: "learned", tags: ["lcd_distilled", "depth:1"], sessionKey: CONV_SESSION }),
      makeResult("paired", { base: 0.8, trustLevel: "learned", tags: ["paired"], sessionKey: CONV_SESSION }),
      makeResult("peer", { base: 0.6, trustLevel: "learned", tags: ["conversation"], sessionKey: "telegram:chat_OTHER:user_z" }),
    ];
    const { store } = fakeProvenanceStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const order = got.value.map((r) => r.entry.id);
    // Fallback heuristic fired: the same-session paired row sank below the peer.
    expect(order.indexOf("paired")).toBeGreaterThan(order.indexOf("peer"));
  });

  it("W6 PRECEDENCE: the distilled summary itself is NEVER down-weighted even when it is the only same-session entry besides another lcd_distilled row", async () => {
    // Two lcd_distilled summaries from the same session: NEITHER may be down-weighted.
    // The buggy `a && b || c` predicate would down-weight one distilled entry; the
    // correct fully-parenthesized predicate leaves BOTH untouched.
    const input = [
      makeResult("d1", { base: 0.9, trustLevel: "learned", tags: ["lcd_distilled", "depth:2"], sessionKey: CONV_SESSION }),
      makeResult("d2", { base: 0.85, trustLevel: "learned", tags: ["lcd_distilled", "depth:1"], sessionKey: CONV_SESSION }),
    ];
    const referenceById = new Map(
      // Reference scores with NO provenance pass (the pass must leave distilled rows alone).
      (await runReference(input)).map((r) => [r.entry.id, r.score ?? 1]),
    );
    const { store } = fakeProvenanceStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
    // Both distilled rows keep their reference (un-down-weighted) score.
    expect(byId.get("d1")).toBeCloseTo(referenceById.get("d1")!, 10);
    expect(byId.get("d2")).toBeCloseTo(referenceById.get("d2")!, 10);
  });

  it("LOAD-BEARING getProvenanceForSummary: a provenance-linked memoryId is down-weighted and the port is queried with the (tenant, agent) scope", async () => {
    // The distilled summary carries a summary:<id> tag; the provenance store maps
    // that summaryId → a paired memoryId. The pass MUST query the port and
    // down-weight the EXACT returned memoryId.
    const SUMMARY_ID = "sum-abc";
    const input = [
      makeResult("distilled", {
        base: 0.9,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1", `summary:${SUMMARY_ID}`],
        sessionKey: CONV_SESSION,
      }),
      makeResult("prov-paired", {
        base: 0.8,
        trustLevel: "learned",
        tags: ["conversation", "paired"],
        // Deliberately a DIFFERENT sessionKey so ONLY the provenance row (not the
        // session heuristic) can select it — proves getProvenanceForSummary is load-bearing.
        sessionKey: "telegram:chat_other:user_a",
      }),
    ];
    const referenceById = new Map((await runReference(input)).map((r) => [r.entry.id, r.score ?? 1]));
    const { store, calls } = fakeProvenanceStore({
      [SUMMARY_ID]: [
        { provenanceId: "p1", memoryId: "prov-paired", sourceSessionKey: CONV_SESSION, supersededBy: null },
      ],
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // The port was queried for the distilled summary's id, scoped to (tenant, agent).
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.summaryId === SUMMARY_ID)).toBe(true);
    const scopedCall = calls.find((c) => c.summaryId === SUMMARY_ID)!;
    expect(scopedCall.scope.tenantId).toBe("tenant_x"); // SESSION_KEY_OBJ.tenantId
    expect(scopedCall.scope.agentId).toBe("agent_y");
    // The provenance-linked memory was down-weighted below its reference score.
    const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
    expect(byId.get("prov-paired")!).toBeLessThan(referenceById.get("prov-paired")!);
  });

  it("IN-02: the provenance scope carries the FORMATTED sessionKey (formatSessionKey), never String(sessionKey) → \"[object Object]\"", async () => {
    // RED on pre-patch code: the scope built at the call site uses
    // `String(sessionKey)` → "[object Object]" (harmless only while the pass was
    // dormant; poisons ContextStoreScope.sessionKey the instant it activates).
    // Phase 173 replaces it with formatSessionKey(sessionKey).
    const SUMMARY_ID = "sum-in02";
    const input = [
      makeResult("distilled", {
        base: 0.9,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1", `summary:${SUMMARY_ID}`],
        sessionKey: CONV_SESSION,
      }),
    ];
    const { store, calls } = fakeProvenanceStore({
      [SUMMARY_ID]: [{ provenanceId: "p", memoryId: "m", sourceSessionKey: CONV_SESSION, supersededBy: null }],
    });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_y");
    expect(got.ok).toBe(true);
    const scopedCall = calls.find((c) => c.summaryId === SUMMARY_ID)!;
    expect(scopedCall).toBeDefined();
    // formatSessionKey(SESSION_KEY_OBJ) === "tenant_x:user_a:chat_1" (NOT "[object Object]").
    expect(scopedCall.scope.sessionKey).toBe("tenant_x:user_a:chat_1");
    expect(scopedCall.scope.sessionKey).not.toBe("[object Object]");
  });

  it("DEFAULT-OFF BYTE-IDENTITY: with provenanceStore ABSENT, recall output is byte-identical to today even when a lcd_distilled result is present", async () => {
    const input = [
      makeResult("distilled", { base: 0.9, trustLevel: "learned", tags: ["lcd_distilled", "depth:1"], sessionKey: CONV_SESSION }),
      makeResult("paired", { base: 0.8, trustLevel: "learned", tags: ["paired"], sessionKey: CONV_SESSION }),
    ];
    const expected = (await runReference(input)).map((r) => ({ id: r.entry.id, score: r.score ?? 1 }));
    // No provenanceStore injected.
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const actual = got.value.map((r) => ({ id: r.entry.id, score: r.score ?? 1 }));
    expect(actual).toEqual(expected);
  });

  it("NO-OP when NO lcd_distilled result is present: provenanceStore is NEVER queried and output is byte-identical", async () => {
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", tags: ["paired"], sessionKey: CONV_SESSION }),
      makeResult("b", { base: 0.8, trustLevel: "learned", tags: ["conversation"], sessionKey: CONV_SESSION }),
    ];
    const expected = (await runReference(input)).map((r) => ({ id: r.entry.id, score: r.score ?? 1 }));
    const { store, calls } = fakeProvenanceStore();
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: noopLogger,
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Fast-path: no lcd_distilled entry → getProvenanceForSummary never called.
    expect(calls.length).toBe(0);
    const actual = got.value.map((r) => ({ id: r.entry.id, score: r.score ?? 1 }));
    expect(actual).toEqual(expected);
  });

  it("NON-FATAL: a provenanceStore that throws does NOT fail recall — results are returned unchanged with a WARN", async () => {
    const input = [
      // The summary:<id> tag makes the pass invoke getProvenanceForSummary (which throws here).
      makeResult("distilled", { base: 0.9, trustLevel: "learned", tags: ["lcd_distilled", "depth:1", "summary:sum-throw"], sessionKey: CONV_SESSION }),
      makeResult("paired", { base: 0.8, trustLevel: "learned", tags: ["paired"], sessionKey: CONV_SESSION }),
    ];
    const warnMock = vi.fn();
    const { store } = fakeProvenanceStore({}, { throwOnCall: true });
    const recall = createMemoryRecall(
      {
        memoryPort: fakeMemoryPort(input),
        provenanceStore: store,
        clock: fixedClock,
        logger: { info: vi.fn(), warn: warnMock, debug: vi.fn(), error: vi.fn() },
      } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
    );
    const got = await recall.recall("q", SESSION_KEY_OBJ, "default");
    // Recall STILL succeeds (non-fatal pass).
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.length).toBe(2);
    // The failure was logged with an errorKind + hint (§2.7).
    expect(warnMock).toHaveBeenCalled();
    const payload = warnMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toHaveProperty("errorKind");
    expect(payload).toHaveProperty("hint");
  });
});

// ── DIST-03 LIVE-PATH integration: the CONCRETE adapter end-to-end ───────────
//
// The DIST-03 carry-in's central risk is "built-but-not-wired" — the milestone's
// #1 recurring failure class. The fake-store tests above prove the pass LOGIC; this
// block proves the WHOLE chain fires on the LIVE recall path with the REAL
// @comis/memory adapter (buildProvenanceReadStore from Task 1) + the REAL provenance
// write (appendProvenance) + the stamped summary:<id> tag: a distilled summary in the
// ranked set → its provenance-linked paired row gets ×0.5; and it is a byte-identical
// no-op when no provenance/distilled entry is present (the absent path preserved).
describe("createMemoryRecall — DIST-03 live-path integration (concrete LcdProvenanceReadStore)", () => {
  const SUMMARY_ID = "sum-live-1";
  const PAIRED_ID = "mem-paired-live";

  /** A real SQLite db with the LCD schema + a seeded memories row + a provenance row
   *  (via the production write path appendProvenance), scoped to SESSION_KEY_OBJ's
   *  (tenantId) + the agentId the recall is invoked with. */
  function seedLiveProvenanceDb(tenantId: string, agentId: string): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initSchema(db, 1536); // runs ensureLcdTables (lcd_memory_provenance DDL)
    // The provenance row FKs memory_id → memories(id), so seed a real memories row.
    db.prepare(
      "INSERT INTO memories (id, tenant_id, agent_id, user_id, content, trust_level, memory_type, source_who, source_session_key, tags, created_at)" +
        " VALUES (?, ?, ?, 'user_a', 'paired content', 'learned', 'episodic', 'agent', 'sess-live', '[]', 1)",
    ).run(PAIRED_ID, tenantId, agentId);
    const store = createLcdStore(db);
    store.appendProvenance!({
      provenanceId: "prov-live-1",
      memoryId: PAIRED_ID,
      summaryId: SUMMARY_ID,
      sourceSessionKey: "sess-live",
      conversationId: "conv-live",
      agentId,
      tenantId,
      createdAt: 1,
    });
    return db;
  }

  it("FIRES on the live recall path: the provenance-linked paired row is down-weighted ×0.5 (present, NOT deleted) via the concrete adapter + stamped tag", async () => {
    // The distilled summary carries the summary:<id> tag; the paired memory has a
    // DIFFERENT sessionKey so ONLY the precise getProvenanceForSummary branch (not the
    // session heuristic) can select it — proving the LIVE read is load-bearing.
    const input = [
      makeResult("distilled", {
        base: 0.9,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1", `summary:${SUMMARY_ID}`],
        sessionKey: "telegram:chat_summary:user_a",
      }),
      makeResult(PAIRED_ID, {
        base: 0.8,
        trustLevel: "learned",
        tags: ["conversation", "paired"],
        sessionKey: "telegram:chat_DIFFERENT:user_a",
      }),
    ];
    const referenceById = new Map((await runReference(input)).map((r) => [r.entry.id, r.score ?? 1]));

    const db = seedLiveProvenanceDb("tenant_x", "agent_live"); // tenant_x = SESSION_KEY_OBJ.tenantId
    try {
      const provenanceStore = buildProvenanceReadStore(db); // the CONCRETE Task-1 adapter
      const recall = createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          provenanceStore,
          clock: fixedClock,
          logger: noopLogger,
        } as unknown as Parameters<typeof createMemoryRecall>[0],
        baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
      );
      const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_live");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
      // The paired row SURVIVES (down-weight never deletes) but is demoted to ×0.5.
      expect(byId.has(PAIRED_ID)).toBe(true);
      expect(byId.get(PAIRED_ID)!).toBeCloseTo(referenceById.get(PAIRED_ID)! * 0.5, 10);
    } finally {
      db.close();
    }
  });

  it("R4 fail-closed on the live path: a CROSS-AGENT recall does NOT down-weight (the concrete adapter returns zero rows for the wrong agent)", async () => {
    // The provenance row is written under agent_live; recall as agent_OTHER must get
    // ZERO rows from getProvenanceForSummary → no down-weight (R4 fail-closed end-to-end).
    const input = [
      makeResult("distilled", {
        base: 0.9,
        trustLevel: "learned",
        tags: ["lcd_distilled", "depth:1", `summary:${SUMMARY_ID}`],
        sessionKey: "telegram:chat_summary:user_a",
      }),
      makeResult(PAIRED_ID, {
        base: 0.8,
        trustLevel: "learned",
        tags: ["conversation", "paired"],
        sessionKey: "telegram:chat_DIFFERENT:user_a",
      }),
    ];
    const referenceById = new Map((await runReference(input)).map((r) => [r.entry.id, r.score ?? 1]));

    const db = seedLiveProvenanceDb("tenant_x", "agent_live");
    try {
      const provenanceStore = buildProvenanceReadStore(db);
      const recall = createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          provenanceStore,
          clock: fixedClock,
          logger: noopLogger,
        } as unknown as Parameters<typeof createMemoryRecall>[0],
        baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
      );
      // Recall as a DIFFERENT agent — the precise branch reads zero rows; the paired row's
      // sessionKey also differs from the distilled summary's, so the heuristic can't fire.
      const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_OTHER");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const byId = new Map(got.value.map((r) => [r.entry.id, r.score ?? 1]));
      expect(byId.get(PAIRED_ID)!).toBeCloseTo(referenceById.get(PAIRED_ID)!, 10); // unchanged
    } finally {
      db.close();
    }
  });

  it("BYTE-IDENTICAL no-op when no provenance/distilled entry is present (live adapter still constructed)", async () => {
    // A live adapter is wired, but NO ranked entry carries the lcd_distilled tag → the
    // pass fast-paths (getProvenanceForSummary never called) and output is byte-identical.
    const input = [
      makeResult("a", { base: 0.9, trustLevel: "learned", tags: ["conversation"], sessionKey: "telegram:chat_1:user_a" }),
      makeResult(PAIRED_ID, { base: 0.8, trustLevel: "learned", tags: ["conversation"], sessionKey: "telegram:chat_1:user_a" }),
    ];
    const expected = (await runReference(input)).map((r) => ({ id: r.entry.id, score: r.score ?? 1 }));

    const db = seedLiveProvenanceDb("tenant_x", "agent_live");
    try {
      const provenanceStore = buildProvenanceReadStore(db);
      const recall = createMemoryRecall(
        {
          memoryPort: fakeMemoryPort(input),
          provenanceStore,
          clock: fixedClock,
          logger: noopLogger,
        } as unknown as Parameters<typeof createMemoryRecall>[0],
        baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] }),
      );
      const got = await recall.recall("q", SESSION_KEY_OBJ, "agent_live");
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const actual = got.value.map((r) => ({ id: r.entry.id, score: r.score ?? 1 }));
      expect(actual).toEqual(expected); // byte-identical to the no-pass reference
    } finally {
      db.close();
    }
  });
});

// ── RETR-04: security gates upstream of fusion (bypass-attempt) ──────────────
//
// The unified arbiter (Plan 03) ranks LTM T3/T4 candidates against history by FUSED
// rank. RETR-04 requires that a trust-excluded or sub-floor candidate can NEVER be
// resurrected by a high fused rank. These tests construct a malicious candidate at
// rank-1 in BOTH lanes (the HIGHEST possible RRF fused rank) and assert it is still
// dropped — proving the trust filter runs UPSTREAM of fuse() (no resurrection route)
// and the baseFloor is fail-closed under the arbiter (design §17 S6, Pitfall 2).
describe("createMemoryRecall — RETR-04: security gates upstream of fusion (bypass-attempt)", () => {
  // Boosts neutralized so FUSION rank (not score() boosts) is the only ordering signal —
  // the malicious candidate's rank-1-in-both-lanes gives it the top fused score.
  const NEUTRAL = { recencyAlpha: 0, temporalAlpha: 0, proofAlpha: 0, trustAlpha: 0, usefulnessAlpha: 0 };
  const PARITY_LANES = { fts: { weight: 1.0 }, vector: { weight: 1.5 } };

  it("BYPASS-ATTEMPT (trust): an external-trust candidate at rank-1 in BOTH lanes is NEVER in the result (high fused rank cannot resurrect a trust-excluded memory)", async () => {
    // EVIL is rank-1 in fts AND vector → the maximal RRF fused score. If the trust filter
    // ran only DOWNSTREAM of an arbiter that fused across corpora, a high fused rank could
    // surface it. The trust filter is upstream of the recall fuse, so EVIL never survives.
    const fts = [
      makeResult("EVIL", { base: 1, trustLevel: "external" }), // rank 1 fts
      makeResult("good1", { base: 1, trustLevel: "learned" }),
    ];
    const vector = [
      makeResult("EVIL", { base: 1, trustLevel: "external" }), // rank 1 vector too → max fused
      makeResult("good2", { base: 1, trustLevel: "system" }),
    ];
    const port = fakeLaneMemoryPort({ fts, vector });
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        minScore: 0,
        includeTrustLevels: ["system", "learned"], // external excluded
        relevanceFirst: true,
      } as unknown as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    expect(ids).not.toContain("EVIL"); // trust-excluded — un-resurrectable by fused rank
    expect(ids).toContain("good1");
    expect(ids).toContain("good2");
  });

  it("BYPASS-ATTEMPT (baseFloor): a sub-floor candidate at rank-1 in BOTH lanes is NEVER in the result under relevanceFirst (high fused rank cannot resurrect a floor-dropped memory)", async () => {
    // POISON has base=0.10 (< class default 0.15) but is rank-1 in both lanes (max fused
    // rank). cfg.baseFloor is 0 (unconfigured) — under relevanceFirst the floor is enforced
    // at the class default, so POISON is dropped despite its top fused rank.
    const fts = [
      makeResult("POISON", { base: 0.1, trustLevel: "learned" }), // sub-floor, rank 1 fts
      makeResult("clean1", { base: 0.8, trustLevel: "learned" }),
    ];
    const vector = [
      makeResult("POISON", { base: 0.1, trustLevel: "learned" }), // rank 1 vector → max fused
      makeResult("clean2", { base: 0.8, trustLevel: "system" }),
    ];
    const port = fakeLaneMemoryPort({ fts, vector });
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        minScore: 0,
        baseFloor: 0, // unconfigured — WR-02 fail-open trigger
        relevanceFirst: true, // arbiter active → floor enforced at the class default
      } as unknown as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    expect(ids).not.toContain("POISON"); // sub-floor — un-resurrectable by fused rank
    expect(ids).toContain("clean1");
    expect(ids).toContain("clean2");
  });

  it("DEFENSE-IN-DEPTH: the downstream trust filter still drops an external candidate even on the recency-first path (gates retained, not removed)", async () => {
    // relevanceFirst=false (frontier/mid). The upstream trust pre-filter and the downstream
    // trust filter BOTH run; the external candidate is dropped by the retained gates — proving
    // the upstream addition did not remove the existing defense-in-depth.
    const fts = [
      makeResult("ext", { base: 1, trustLevel: "external" }),
      makeResult("keep", { base: 1, trustLevel: "learned" }),
    ];
    const vector = [makeResult("keep", { base: 1, trustLevel: "learned" })];
    const port = fakeLaneMemoryPort({ fts, vector });
    const recall = createMemoryRecall(
      { memoryPort: port, clock: fixedClock, logger: noopLogger } as unknown as Parameters<typeof createMemoryRecall>[0],
      baseConfig({
        scoring: NEUTRAL,
        lanes: PARITY_LANES,
        minScore: 0,
        includeTrustLevels: ["system", "learned"],
        relevanceFirst: false,
      } as unknown as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const ids = got.value.map((r) => r.entry.id);
    expect(ids).not.toContain("ext");
    expect(ids).toContain("keep");
  });

  it("FRONTIER byte-identical: the new pre-filter is a NO-OP for an all-allowed corpus (deep-equal to the pre-patch reference)", async () => {
    // No trust-excluded, no sub-floor candidate, relevanceFirst=false. The reorder/new
    // pre-filter must not change the result vs the documented reference pipeline.
    const input = [
      makeResult("f1", { base: 0.9, trustLevel: "learned", createdAt: NOW - 5 * 86_400_000 }),
      makeResult("f2", { base: 0.6, trustLevel: "system", createdAt: NOW - 1 * 86_400_000 }),
      makeResult("f3", { base: 0.4, trustLevel: "learned", createdAt: NOW }),
    ];
    const reference = await runReference(input);
    const recall = createMemoryRecall(
      { memoryPort: fakeMemoryPort(input), clock: fixedClock, logger: noopLogger },
      baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"], relevanceFirst: false } as unknown as Partial<MemoryRecallConfig>),
    );
    const got = await recall.recall("q", SESSION_KEY, "default");
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    // Deep-equal the full result (ids + order) to the pre-patch reference — the gate is
    // that the new code is a no-op for frontier/mid, not that it happens to reorder the same.
    expect(got.value.map((r) => r.entry.id)).toEqual(reference.map((r) => r.entry.id));
  });
});

/**
 * The documented default recall pipeline WITHOUT the provenance pass, used as the
 * byte-identity / un-down-weighted reference. Mirrors the reference computation in
 * the recall-trace DEFAULT-OFF test (fuse → score → trust-filter → dedup), with
 * DIST_NEUTRAL_SCORING so the only score deltas a test can observe are the pass's ×0.5.
 */
async function runReference(input: MemorySearchResult[]): Promise<MemorySearchResult[]> {
  const cfg = baseConfig({ scoring: DIST_NEUTRAL_SCORING, includeTrustLevels: ["system", "learned"] });
  const fused = fuse([{ results: input, weight: 1.0 }]);
  const scored = score(fused, cfg.scoring, NOW);
  const allowed = new Set<TrustLevel>(cfg.includeTrustLevels);
  return deduplicateResults(scored.filter((r) => allowed.has(r.entry.trustLevel)));
}
