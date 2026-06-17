// SPDX-License-Identifier: Apache-2.0
//
// Unit suite for runOnlineTuning: the OFFLINE, DETERMINISTIC, KEYLESS tuned-alpha
// bandit job. The job is gate + read + aggregate +
// pure-step + write — the PURE computeTunedAlphas it calls is TDD'd separately
// (tuned-alpha-update.test.ts), so here we cover the orchestration: default-OFF →
// no read/write; enabled + a positive FEED signal → one clamped upsert + updated:true;
// a readUsefulness failure → non-fatal updated:false; the emitted event carries COUNTS
// ONLY (no alpha values, no FEED content). A fixed injected clock — no wall-clock reads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TunedAlphaVector } from "@comis/core";
import {
  runOnlineTuning,
  type MemoryOnlineTuningDeps,
  type OnlineTuningFeedEntry,
} from "./online-tuning-job.js";

/** Fixed reference clock — every time read in the job resolves deterministically. */
const NOW = 1_700_000_000_000;

/** The static rag.scoring baseline (the four non-trust alphas) the bandit starts from. */
const BASELINE = { recencyAlpha: 0.2, temporalAlpha: 0.2, proofAlpha: 0.1, usefulnessAlpha: 0.1 };

/** A minimal in-memory TunedAlphaStore double recording the upserted vector. */
function makeStore(seed?: TunedAlphaVector) {
  let stored: TunedAlphaVector | undefined = seed;
  const upsert = vi.fn(async (vector: TunedAlphaVector) => {
    stored = vector;
    return ok(undefined) as Result<void, Error>;
  });
  const read = vi.fn(async () => ok(stored) as Result<TunedAlphaVector | undefined, Error>);
  return { upsert, read, get stored() { return stored; } };
}

function makeLogger(): MemoryOnlineTuningDeps["logger"] {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  logger.child = vi.fn(() => logger);
  return logger as MemoryOnlineTuningDeps["logger"];
}

function makeDeps(overrides: Partial<MemoryOnlineTuningDeps> = {}): MemoryOnlineTuningDeps {
  const store = makeStore();
  return {
    agentId: "test-agent",
    tenantId: "default",
    config: { enabled: true, maxSourceMemories: 200 },
    tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
    readUsefulness: async () => ok(new Map<string, OnlineTuningFeedEntry>()),
    configScoring: { ...BASELINE },
    clock: { now: () => NOW } as MemoryOnlineTuningDeps["clock"],
    logger: makeLogger(),
    eventBus: { emit: vi.fn() },
    ...overrides,
  };
}

describe("runOnlineTuning — default-OFF gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads nothing, writes nothing, returns updated:false when disabled", async () => {
    const store = makeStore();
    const readUsefulness = vi.fn(async () => ok(new Map<string, OnlineTuningFeedEntry>()));
    const deps = makeDeps({
      config: { enabled: false },
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness,
    });

    const result = await runOnlineTuning(deps);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ updated: false, clampHits: 0, signalCount: 0 });
    // The default-OFF cost gate: NO FEED read, NO store read, NO upsert.
    expect(readUsefulness).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("still emits a counts-only event when disabled (clean no-op run)", async () => {
    const emit = vi.fn();
    const deps = makeDeps({ config: { enabled: false }, eventBus: { emit } });
    await runOnlineTuning(deps);
    expect(emit).toHaveBeenCalledWith("memory:online_tuning_applied", expect.objectContaining({ updated: false }));
  });
});

describe("runOnlineTuning — enabled + a positive FEED signal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts ONE clamped vector and returns updated:true; usefulnessAlpha rises from the baseline", async () => {
    const store = makeStore();
    // A net-USED signal (used >> ignored) → a positive used-RATE centered above 0.5
    // → a positive usefulness gradient → usefulnessAlpha nudged UP from 0.1.
    const feed = new Map<string, OnlineTuningFeedEntry>([
      ["m1", { usedCount: 9, ignoredCount: 1 }],
      ["m2", { usedCount: 8, ignoredCount: 2 }],
    ]);
    const deps = makeDeps({
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });

    const result = await runOnlineTuning(deps);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.updated).toBe(true);
    expect(result.ok && result.value.signalCount).toBe(2);
    expect(store.upsert).toHaveBeenCalledTimes(1);

    // The upserted vector: usefulnessAlpha rose (net-used), the other three unchanged,
    // and EVERY alpha is clamped to [0, 1] (Pitfall 2).
    const v = store.stored!;
    expect(v.usefulnessAlpha).toBeGreaterThan(BASELINE.usefulnessAlpha);
    expect(v.recencyAlpha).toBe(BASELINE.recencyAlpha);
    expect(v.temporalAlpha).toBe(BASELINE.temporalAlpha);
    expect(v.proofAlpha).toBe(BASELINE.proofAlpha);
    for (const a of [v.recencyAlpha, v.temporalAlpha, v.proofAlpha, v.usefulnessAlpha]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
    // The upsert scope carries the injected clock (no wall-clock).
    expect(store.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: "default", agentId: "test-agent", now: NOW }),
    );
  });

  it("a net-IGNORED signal nudges usefulnessAlpha DOWN (directional, clamped)", async () => {
    const store = makeStore();
    const feed = new Map<string, OnlineTuningFeedEntry>([
      ["m1", { usedCount: 1, ignoredCount: 9 }],
      ["m2", { usedCount: 0, ignoredCount: 10 }],
    ]);
    const deps = makeDeps({
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    expect(store.stored!.usefulnessAlpha).toBeLessThan(BASELINE.usefulnessAlpha);
    expect(store.stored!.usefulnessAlpha).toBeGreaterThanOrEqual(0);
  });

  it("a neutral / empty FEED signal is a no-op step (next === baseline; recall unchanged)", async () => {
    const store = makeStore();
    const feed = new Map<string, OnlineTuningFeedEntry>([
      ["m1", { usedCount: 0, ignoredCount: 0 }], // never recalled — no signal
    ]);
    const deps = makeDeps({
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    // Still upserts (idempotent), but the vector equals the baseline (no nudge).
    expect(store.stored).toEqual(BASELINE);
  });

  it("starts from the EXISTING tuned vector when a row is present (not the config baseline)", async () => {
    const seed: TunedAlphaVector = { recencyAlpha: 0.5, temporalAlpha: 0.5, proofAlpha: 0.5, usefulnessAlpha: 0.5 };
    const store = makeStore(seed);
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 10, ignoredCount: 0 }]]);
    const deps = makeDeps({
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    // Nudged from 0.5 (the existing row), NOT from 0.1 (the config baseline).
    expect(store.stored!.usefulnessAlpha).toBeGreaterThan(0.5);
    expect(store.read).toHaveBeenCalledWith({ tenantId: "default", agentId: "test-agent" });
  });
});

describe("runOnlineTuning — non-fatal failure paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a FEED-read failure is non-fatal: WARN + updated:false, NO upsert", async () => {
    const store = makeStore();
    const logger = makeLogger();
    const deps = makeDeps({
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => err(new Error("feed db locked")) as Result<Map<string, OnlineTuningFeedEntry>, Error>,
      logger,
    });
    const result = await runOnlineTuning(deps);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.updated).toBe(false);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a rejecting store upsert is non-fatal: WARN + updated:false (the ranker keeps its weights)", async () => {
    const store = makeStore();
    store.upsert.mockResolvedValueOnce(err(new Error("upsert rejected")) as Result<void, Error>);
    const logger = makeLogger();
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 5, ignoredCount: 0 }]]);
    const deps = makeDeps({
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
      logger,
    });
    const result = await runOnlineTuning(deps);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.updated).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("runOnlineTuning — counts-only event + KEYLESS/deterministic source belts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the emitted event carries COUNTS ONLY — no alpha values, no FEED content", async () => {
    const emit = vi.fn();
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 7, ignoredCount: 3 }]]);
    const deps = makeDeps({ readUsefulness: async () => ok(feed), eventBus: { emit } });
    await runOnlineTuning(deps);

    expect(emit).toHaveBeenCalledWith("memory:online_tuning_applied", expect.objectContaining({
      agentId: "test-agent",
      updated: true,
      signalCount: 1,
      durationMs: expect.any(Number),
      timestamp: NOW,
    }));
    // Grep the captured payload: NO alpha-named field, NO memory id, NO content.
    const payload = (emit.mock.calls.find((c) => c[0] === "memory:online_tuning_applied")![1]) as Record<string, unknown>;
    const keys = Object.keys(payload);
    for (const k of keys) {
      expect(k).not.toMatch(/alpha/i); // no recencyAlpha / usefulnessAlpha etc.
    }
    expect(keys).not.toContain("m1"); // no memory id
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("m1"); // no FEED content/id anywhere in the payload
  });

  it("source is KEYLESS + deterministic + agent↛memory-cut (grep-0 belt)", () => {
    const src = readFileSync(fileURLToPath(new URL("./online-tuning-job.ts", import.meta.url)), "utf8");
    // KEYLESS: no model resolution, no API key, no secret manager, no offline build seam, no LLM client.
    expect(src).not.toMatch(/resolveOperationModel|secretManager|completeSimple|@earendil-works\/pi-ai/);
    expect(src).not.toMatch(/apiKey/);
    expect(src).not.toMatch(/\.build\(/);
    // DETERMINISTIC + no globals: no wall-clock, no RNG, no env read (the injected clock only).
    expect(src).not.toMatch(/Date\.now|new Date|Math\.random|process\.env/);
    // The agent↛memory cut: the job imports @comis/core TYPES, never the memory package.
    expect(src).not.toMatch(/@comis\/memory/);
    // Trust-freeze (the OD2 ship-gate): the literal trust-weight field name is never written.
    expect(src).not.toMatch(/trustAlpha|trustGradient/);
  });

  it("the emit is a PLAIN eventBus.emit (NOT optional-chained) so EMIT_REGEX + the type system see it", () => {
    const src = readFileSync(fileURLToPath(new URL("./online-tuning-job.ts", import.meta.url)), "utf8");
    // RANK-06: the promoted emit. The `?.`-chained form evades the EMIT_REGEX arch gate
    // (/eventBus\.emit\(/) AND the type system + trajectory — the plain form is mandatory.
    expect(src).toMatch(/eventBus\.emit\(\s*"memory:online_tuning_applied"/);
    expect(src).not.toMatch(/eventBus\?\.emit\(/);
  });
});

// ---------------------------------------------------------------------------
// RANK-02/03 (v2.26 WS3, Phase 200 Plan 06): per-intent runs + bandit/nudge
// selection by config.learner + the per-intent emit dim, all via the PLAIN typed emit.
// ---------------------------------------------------------------------------
describe("runOnlineTuning — RANK-02 per-intent dimension", () => {
  beforeEach(() => vi.clearAllMocks());

  it("threads the per-intent bucket into BOTH the read and the upsert scope", async () => {
    const store = makeStore();
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 9, ignoredCount: 1 }]]);
    const deps = makeDeps({
      config: { enabled: true, intent: "temporal" },
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    // The read + the upsert both carry intent (the per-(tenant, agent, intent) bucket).
    expect(store.read).toHaveBeenCalledWith({ tenantId: "default", agentId: "test-agent", intent: "temporal" });
    expect(store.upsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: "default", agentId: "test-agent", intent: "temporal", now: NOW }),
    );
  });

  it("omitted intent resolves the GLOBAL '' bucket (byte-identical to the pre-intent read/upsert)", async () => {
    const store = makeStore();
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 9, ignoredCount: 1 }]]);
    const deps = makeDeps({
      config: { enabled: true }, // no intent
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    // No intent on the scope → the adapter resolves '' (the global bucket).
    expect(store.read).toHaveBeenCalledWith({ tenantId: "default", agentId: "test-agent" });
  });

  it("the plain typed emit carries the per-intent dim (counts only — no alpha)", async () => {
    const emit = vi.fn();
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 7, ignoredCount: 3 }]]);
    const deps = makeDeps({
      config: { enabled: true, intent: "temporal" },
      readUsefulness: async () => ok(feed),
      eventBus: { emit },
    });
    await runOnlineTuning(deps);
    expect(emit).toHaveBeenCalledWith("memory:online_tuning_applied", expect.objectContaining({
      intent: "temporal",
      updated: true,
    }));
    const payload = (emit.mock.calls.find((c) => c[0] === "memory:online_tuning_applied")![1]) as Record<string, unknown>;
    for (const k of Object.keys(payload)) expect(k).not.toMatch(/alpha/i);
  });
});

describe("runOnlineTuning — RANK-03 bandit vs nudge selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("learner:'bandit' moves the FULL vector — recency/temporal/proof MOVE (not just usefulness) on a net-used feed", async () => {
    const store = makeStore();
    // A strong net-USED signal: positive reward mean → every axis nudged UP by the bandit
    // (the reward mean rides every exploit term — the recency/temporal/proof axes, hardcoded-0
    // gradient under the nudge, become learnable; the RANK-04 keystone mechanism).
    const feed = new Map<string, OnlineTuningFeedEntry>([
      ["m1", { usedCount: 10, ignoredCount: 0 }],
      ["m2", { usedCount: 9, ignoredCount: 1 }],
    ]);
    const deps = makeDeps({
      config: { enabled: true, learner: "bandit", exploration: 0.1 },
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    const v = store.stored!;
    // The bandit moves ALL FOUR (the net-used reward + UCB bonus ride every axis), UNLIKE the nudge.
    expect(v.recencyAlpha).toBeGreaterThan(BASELINE.recencyAlpha);
    expect(v.temporalAlpha).toBeGreaterThan(BASELINE.temporalAlpha);
    expect(v.proofAlpha).toBeGreaterThan(BASELINE.proofAlpha);
    expect(v.usefulnessAlpha).toBeGreaterThan(BASELINE.usefulnessAlpha);
    for (const a of [v.recencyAlpha, v.temporalAlpha, v.proofAlpha, v.usefulnessAlpha]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it("learner:'nudge' moves ONLY usefulness (the recency/temporal/proof gradients stay 0) — the conservative fallback", async () => {
    const store = makeStore();
    const feed = new Map<string, OnlineTuningFeedEntry>([["m1", { usedCount: 9, ignoredCount: 1 }]]);
    const deps = makeDeps({
      config: { enabled: true, learner: "nudge" },
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    const v = store.stored!;
    expect(v.usefulnessAlpha).toBeGreaterThan(BASELINE.usefulnessAlpha);
    // The nudge leaves the other three UNTOUCHED (their gradient is 0 under the bare used-rate feed).
    expect(v.recencyAlpha).toBe(BASELINE.recencyAlpha);
    expect(v.temporalAlpha).toBe(BASELINE.temporalAlpha);
    expect(v.proofAlpha).toBe(BASELINE.proofAlpha);
  });

  it("bandit on a net-FAILURE (negative reward) feed nudges DOWN (reward sign correct), clamped to [0,1]", async () => {
    const seed: TunedAlphaVector = { recencyAlpha: 0.5, temporalAlpha: 0.5, proofAlpha: 0.5, usefulnessAlpha: 0.5 };
    const store = makeStore(seed);
    // A net-IGNORED feed → negative reward mean → the bandit pushes axes DOWN from 0.5.
    const feed = new Map<string, OnlineTuningFeedEntry>([
      ["m1", { usedCount: 0, ignoredCount: 10 }],
      ["m2", { usedCount: 1, ignoredCount: 9 }],
    ]);
    const deps = makeDeps({
      config: { enabled: true, learner: "bandit", exploration: 0 }, // exploration 0 isolates the reward sign
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      readUsefulness: async () => ok(feed),
    });
    await runOnlineTuning(deps);
    const v = store.stored!;
    expect(v.usefulnessAlpha).toBeLessThan(0.5);
    for (const a of [v.recencyAlpha, v.temporalAlpha, v.proofAlpha, v.usefulnessAlpha]) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it("byte-identity: disabled run still hits the plain emit + returns ok with no upsert (per-intent dim included)", async () => {
    const emit = vi.fn();
    const store = makeStore();
    const deps = makeDeps({
      config: { enabled: false, learner: "bandit", intent: "temporal" },
      tunedAlphaStore: store as unknown as MemoryOnlineTuningDeps["tunedAlphaStore"],
      eventBus: { emit },
    });
    const result = await runOnlineTuning(deps);
    expect(result.ok && result.value.updated).toBe(false);
    expect(store.upsert).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith("memory:online_tuning_applied", expect.objectContaining({ updated: false, intent: "temporal" }));
  });
});
