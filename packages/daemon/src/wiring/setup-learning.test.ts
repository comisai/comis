// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for wireLearningOutcome() — the deterministic tool/pipeline outcome
 * observe/resolve subscriber (Verified Learning WS1, OUTCOME-03/07/08).
 *
 * The daemon is the ONLY place holding BOTH the bus AND the @comis/memory
 * OutcomeSignalPort adapter (the agent↛memory cut). This wiring subscribes to the
 * deterministic completion events and observes a tool/pipeline outcome, resolves
 * the fused verdict at trajectory completion, and emits learning:outcome_observed.
 *
 * Load-bearing assertions (drive a REAL TypedEventBus + a stub port):
 * - BYTE-IDENTITY: learningOutcomeEnabled => false → ZERO observe/resolve/emit
 * - tool:executed { success:false } → observe outcome "failure", source "tool",
 *   trajectoryId === traceId; { success:true } → "success"
 * - graph:completed { status:"completed" } → observe "success" + emit; { status:"failed" }
 *   → observe "failure" (SC#1: success ONLY on a clean DAG completion)
 * - the WRONG field (is_error) is NOT used; the REAL fields (success / status) are
 * - a resolve returning unknown does NOT increment the coverage `resolved` tally
 * - a failing observe (err) WARNs and does NOT throw out of the handler
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { TypedEventBus, runWithContext } from "@comis/core";
import { createSqliteLearnedSkillStore, initSchema } from "@comis/memory";
import type { EventMap, OutcomeObservation, ResolvedOutcome, LearningScope } from "@comis/core";
import type { UsefulnessScope, MemoryUsefulnessStore, UsefulnessSignal } from "@comis/core";
import type { LearnedSkillStorePort } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  wireLearningOutcome,
  failureCorroborated,
  CORROBORATION_MIN_INDEPENDENT,
} from "./setup-learning.js";

/**
 * A controllable MemoryUsefulnessStore stub. The daemon reward seam (RANK-01 /
 * FORGET-02) is the agent↛memory cut enforcement point: the daemon holds BOTH
 * the bus/`OutcomeSignalPort.resolve()` AND this injected `@comis/memory`
 * usefulness adapter. Exposes ONLY the three port methods (recordUsage /
 * readUsefulness / recordFailure) — there is NO proof/trust/pinned lookup, which
 * is the point (the resolve seam reads no per-memory proof_count/trust_level/
 * pinned; the eviction exemption is store-side, Plan 05).
 */
function mockUsefulnessStore() {
  const recordUsage = vi.fn(
    async (_used: string[], _ignored: string[], _scope: UsefulnessScope): Promise<Result<void, Error>> =>
      ok(undefined),
  );
  const recordFailure = vi.fn(
    async (_id: string, _scope: UsefulnessScope): Promise<Result<void, Error>> => ok(undefined),
  );
  const readUsefulness = vi.fn(
    async (): Promise<Result<Map<string, UsefulnessSignal>, Error>> => ok(new Map()),
  );
  const store: MemoryUsefulnessStore = { recordUsage, readUsefulness, recordFailure };
  return { store, recordUsage, recordFailure, readUsefulness };
}

const NOW = 1_700_000_000_000;
const TRACE = "trace-lo-001";
const AGENT = "agent-1";
const SESSION_KEY = "tenant-x:telegram:user-9";

/** A controllable OutcomeSignalPort stub. resolve defaults to a `success` verdict. */
function makeStubStore(resolveValue: ResolvedOutcome = baseVerdict()) {
  const observe = vi.fn(async (_obs: OutcomeObservation): Promise<Result<void, Error>> => ok(undefined));
  const resolve = vi.fn(
    async (_id: string, _scope: LearningScope): Promise<Result<ResolvedOutcome, Error>> => ok(resolveValue),
  );
  const prune = vi.fn(() => ({ changes: 0 }));
  return { store: { observe, resolve, prune }, observe, resolve, prune };
}

function baseVerdict(over?: Partial<ResolvedOutcome>): ResolvedOutcome {
  return {
    outcome: "success",
    confidence: 0.9,
    sources: ["pipeline"],
    recalledIds: [],
    usedSkillIds: [],
    ...over,
  };
}

/**
 * A controllable LearnedSkillStorePort stub for the SURFACE-04/05 promote/demote
 * loop. Exposes ONLY the promote/demote write methods the resolve seam calls (the
 * loop reads NO per-skill proof/trust — the threshold gate is store-side, Plan 02);
 * the read/admit/evict methods are present (the port shape) but unused by the seam.
 */
function mockLearnedSkillStore() {
  const promote = vi.fn(
    async (_id: string, _scope: LearningScope, _threshold: number): Promise<Result<void, Error>> => ok(undefined),
  );
  const demote = vi.fn(async (_id: string, _scope: LearningScope): Promise<Result<void, Error>> => ok(undefined));
  const store = {
    promote,
    demote,
    admit: vi.fn(async () => ok({ id: "x", admitted: true })),
    get: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    evict: vi.fn(async () => ok(undefined)),
  } as unknown as LearnedSkillStorePort;
  return { store, promote, demote };
}

function toolPayload(over?: Partial<EventMap["tool:executed"]>): EventMap["tool:executed"] {
  return {
    toolName: "web_search",
    durationMs: 12,
    success: true,
    timestamp: NOW,
    toolCallId: "call-1",
    traceId: TRACE,
    agentId: AGENT,
    sessionKey: SESSION_KEY,
    ...over,
  };
}

function graphPayload(over?: Partial<EventMap["graph:completed"]>): EventMap["graph:completed"] {
  return {
    graphId: "g-1",
    status: "completed",
    durationMs: 100,
    nodeCount: 2,
    nodesCompleted: 2,
    nodesFailed: 0,
    nodesSkipped: 0,
    timestamp: NOW,
    ...over,
  };
}

/** Run fn inside an ALS request context (graph events carry no scope on payload). */
function withCtx<T>(fn: () => T): T {
  return runWithContext(
    { tenantId: "tenant-x", agentId: AGENT, sessionKey: SESSION_KEY, traceId: TRACE } as never,
    fn,
  );
}

describe("wireLearningOutcome — tool/pipeline → observe/resolve → emit", () => {
  it("byte-identity: learningOutcomeEnabled => false → tool:executed triggers ZERO observe calls", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => false,
    });

    bus.emit("tool:executed", toolPayload({ success: false }));
    await Promise.resolve();

    expect(observe).not.toHaveBeenCalled();
  });

  it("byte-identity: disabled → graph:completed emits NOTHING and never resolves", async () => {
    const bus = new TypedEventBus();
    const { store, observe, resolve } = makeStubStore();
    const emitSpy = vi.spyOn(bus, "emit");
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => false,
    });

    withCtx(() => bus.emit("graph:completed", graphPayload()));
    await Promise.resolve();
    await Promise.resolve();

    expect(observe).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    // Only the graph:completed emit itself — never a learning:outcome_observed.
    const emittedNames = emitSpy.mock.calls.map((c) => c[0]);
    expect(emittedNames).not.toContain("learning:outcome_observed");
  });

  it("tool:executed { success:false } records a 'failure' tool outcome keyed by traceId", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    bus.emit("tool:executed", toolPayload({ success: false }));
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.outcome).toBe("failure");
    expect(obs.source).toBe("tool");
    expect(obs.trajectoryId).toBe(TRACE); // trajectory identity = traceId
    expect(obs.agentId).toBe(AGENT);
    expect(obs.observedAt).toBe(NOW);
  });

  it("tool:executed { success:true } records a 'success' tool outcome", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    bus.emit("tool:executed", toolPayload({ success: true }));
    await Promise.resolve();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].outcome).toBe("success");
  });

  it("graph:completed { status:'completed' } records 'success' AND emits learning:outcome_observed", async () => {
    const bus = new TypedEventBus();
    const { store, observe, resolve } = makeStubStore(baseVerdict({ outcome: "success" }));
    const emitSpy = vi.spyOn(bus, "emit");
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    withCtx(() => bus.emit("graph:completed", graphPayload({ status: "completed" })));
    // observe → resolve → emit is a chained fire-and-forget; flush microtasks.
    await flushMicrotasks();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].outcome).toBe("success");
    expect(observe.mock.calls[0]![0].source).toBe("pipeline");
    expect(resolve).toHaveBeenCalledTimes(1);
    const emitted = emitSpy.mock.calls.find((c) => c[0] === "learning:outcome_observed");
    expect(emitted, "learning:outcome_observed must be emitted").toBeDefined();
    const ev = emitted![1] as EventMap["learning:outcome_observed"];
    expect(ev.outcome).toBe("success");
    expect(ev.trajectoryId).toBe(TRACE);
    // counts/ids/closed-enums only — the payload carries no body/alpha/recalled ids.
    expect(Object.keys(ev).sort()).toEqual(
      ["agentId", "confidence", "outcome", "source", "timestamp", "trajectoryId", "traceId"].sort(),
    );
  });

  it("graph:completed { status:'failed' } records a 'failure' pipeline outcome (SC#1 clean-completion gate)", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore(baseVerdict({ outcome: "failure" }));
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    withCtx(() => bus.emit("graph:completed", graphPayload({ status: "failed", nodesFailed: 1 })));
    await flushMicrotasks();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].outcome).toBe("failure");
  });

  it("graph:completed { status:'cancelled' } records 'failure' (NOT success — only a clean completion is success)", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore(baseVerdict({ outcome: "failure" }));
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    withCtx(() =>
      bus.emit("graph:completed", graphPayload({ status: "cancelled", cancelReason: "timeout" })),
    );
    await flushMicrotasks();

    expect(observe.mock.calls[0]![0].outcome).toBe("failure");
  });

  it("a resolve returning 'unknown' does NOT increment the coverage 'resolved' tally (fail-closed) but still counts total", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore(baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }));
    const logger = createMockLogger();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger,
      learningOutcomeEnabled: () => true,
    });

    withCtx(() => bus.emit("graph:completed", graphPayload({ status: "completed" })));
    await flushMicrotasks();

    expect(resolve).toHaveBeenCalledTimes(1);
    // The INFO completion line is logged with the coverage gauge: total=1, resolved=0
    // (an unknown verdict is NOT counted as resolved — T-198-18).
    const infoCall = logger.info.mock.calls.find((c) => c[1] === "Outcome resolved for trajectory");
    expect(infoCall, "the resolve INFO line must be logged").toBeDefined();
    const fields = infoCall![0] as { totalCount: number; resolvedCount: number };
    expect(fields.totalCount).toBe(1);
    expect(fields.resolvedCount).toBe(0);
  });

  it("an 'unknown' verdict emits learning:outcome_observed but with outcome 'unknown' (visible, not counted)", async () => {
    const bus = new TypedEventBus();
    const { store } = makeStubStore(baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }));
    const emitSpy = vi.spyOn(bus, "emit");
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    withCtx(() => bus.emit("graph:completed", graphPayload({ status: "completed" })));
    await flushMicrotasks();

    const emitted = emitSpy.mock.calls.find((c) => c[0] === "learning:outcome_observed");
    expect(emitted).toBeDefined();
    expect((emitted![1] as EventMap["learning:outcome_observed"]).outcome).toBe("unknown");
    expect((emitted![1] as EventMap["learning:outcome_observed"]).source).toBe("pipeline"); // sources[] empty → default
  });

  it("is non-fatal: an observe that returns err WARNs and does not throw out of the handler", async () => {
    const bus = new TypedEventBus();
    const observe = vi.fn(async (): Promise<Result<void, Error>> => err(new Error("db locked")));
    const resolve = vi.fn(async () => ok(baseVerdict()));
    const prune = vi.fn(() => ({ changes: 0 }));
    const logger = createMockLogger();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: { observe, resolve, prune },
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger,
      learningOutcomeEnabled: () => true,
    });

    expect(() => bus.emit("tool:executed", toolPayload({ success: false }))).not.toThrow();
    await flushMicrotasks();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("is non-fatal: an observe that REJECTS does not throw out of the handler", async () => {
    const bus = new TypedEventBus();
    const observe = vi.fn(async (): Promise<Result<void, Error>> => {
      throw new Error("unexpected reject");
    });
    const resolve = vi.fn(async () => ok(baseVerdict()));
    const prune = vi.fn(() => ({ changes: 0 }));
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: { observe, resolve, prune },
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    expect(() => bus.emit("tool:executed", toolPayload({ success: false }))).not.toThrow();
    await flushMicrotasks();
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("graph:driver_lifecycle does NOT observe — graph:completed is the single pipeline signal (WR-02)", async () => {
    // In P0 the per-node driver lifecycle is NOT a trajectory-level signal: a
    // multi-node DAG emits graph:driver_lifecycle per node, which would flood the
    // ledger with O(nodes) same-tier `pipeline` rows and amplify the WR-01 fusion
    // non-determinism. Only graph:completed (gated on status==="completed") writes
    // the single trajectory-level pipeline outcome. A terminal driver phase must
    // therefore trigger ZERO observe calls.
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    withCtx(() =>
      bus.emit("graph:driver_lifecycle", {
        graphId: "g-1",
        nodeId: "node-a",
        typeId: "agent",
        phase: "completed",
      }),
    );
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });

  it("skips when no agentId is resolvable from the event OR the ambient context (cannot scope)", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    // No agentId on the payload AND no ALS context → cannot scope → skip (no throw).
    expect(() =>
      bus.emit("tool:executed", toolPayload({ agentId: undefined })),
    ).not.toThrow();
    await Promise.resolve();
    expect(observe).not.toHaveBeenCalled();
  });
});

/**
 * RANK-01 / FORGET-02 / FORGET-03 — the outcome→reward/failure write seam at
 * resolve() time, corroboration-gated.
 *
 * A memory in `verdict.recalledIds` of a SUCCESS trajectory accrues per-intent
 * positive reward (`recordUsage`); of a FAILURE/CORRECTED trajectory accrues
 * `failure_count` (`recordFailure`) — but ONLY after the anti-induced-eviction
 * corroboration gate: ≥2 INDEPENDENT failures (distinct sessions) OR 1
 * DETERMINISTIC (`tool`/`pipeline`) failure. A single low-trust/`external`
 * failure accrues NOTHING (Defer ≠ Retry — benign). Once the gate is met the
 * accrual is UNCONDITIONAL: the daemon reads NO per-memory proof/trust/pinned
 * (ResolvedOutcome carries none); the high-proof/system/pinned EVICTION exemption
 * lives store-side (Plan 05). All writes are fire-and-forget / non-fatal and gated
 * default-OFF on learningTuning/learningForgetting (byte-identical when disabled).
 */
describe("wireLearningOutcome — reward/failure write at resolve() (RANK-01/FORGET-02/FORGET-03)", () => {
  /** Build a wiring whose graph:completed resolve yields the given verdict, with the reward gates on. */
  function wireRewardSeam(
    verdict: ResolvedOutcome,
    opts?: {
      tuning?: boolean;
      forgetting?: boolean;
      usefulnessStore?: ReturnType<typeof mockUsefulnessStore>;
      logger?: ReturnType<typeof createMockLogger>;
    },
  ): {
    bus: TypedEventBus;
    us: ReturnType<typeof mockUsefulnessStore>;
    resolve: ReturnType<typeof makeStubStore>["resolve"];
  } {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore(verdict);
    const us = opts?.usefulnessStore ?? mockUsefulnessStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learningTuningEnabled: () => opts?.tuning ?? true,
      learningForgettingEnabled: () => opts?.forgetting ?? true,
      clock: createFakeClock(NOW),
      logger: opts?.logger ?? createMockLogger(),
      learningOutcomeEnabled: () => true,
    });
    return { bus, us, resolve };
  }

  /** Drive one graph:completed trajectory inside an ALS scope keyed by sessionKey. */
  async function driveTrajectory(bus: TypedEventBus, sessionKey: string, trace: string): Promise<void> {
    runWithContext(
      { tenantId: "tenant-x", agentId: AGENT, sessionKey, traceId: trace } as never,
      () => bus.emit("graph:completed", graphPayload({ status: "completed" })),
    );
    await flushMicrotasks();
  }

  it("SUCCESS verdict → recordUsage ONCE for all recalled ids (IN-01: batched into a single transaction)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["m1", "m2"] }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    // IN-01: the success reward is now ONE batched recordUsage(recalledIds, [], scope)
    // call (the store loops internally in one transaction) instead of O(recalledIds)
    // separate calls — the failure branch stays per-id (corroboration-gated).
    expect(us.recordUsage).toHaveBeenCalledTimes(1);
    const ids = us.recordUsage.mock.calls.map((c) => c[0]).flat();
    expect(ids.sort()).toEqual(["m1", "m2"]);
    // The reward write is scoped to the resolved (tenant, agent); intent omitted →
    // the global '' bucket (the verdict carries no intent; the bandit reads per-intent).
    const scope = us.recordUsage.mock.calls[0]![2];
    expect(scope.agentId).toBe(AGENT);
    expect(scope.tenantId).toBe("tenant-x");
    // No failure accrual on a success.
    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("FAILURE verdict with a DETERMINISTIC source (pipeline) → recordFailure once (1 deterministic satisfies the gate)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["pipeline"], recalledIds: ["m1"], confidence: 0.9 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).toHaveBeenCalledTimes(1);
    expect(us.recordFailure.mock.calls[0]![0]).toBe("m1");
    expect(us.recordUsage).not.toHaveBeenCalled();
  });

  it("CORRECTED verdict with a DETERMINISTIC source (tool) → recordFailure once (corrected = soft-failure)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "corrected", sources: ["tool"], recalledIds: ["m9"], confidence: 0.8 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).toHaveBeenCalledTimes(1);
    expect(us.recordFailure.mock.calls[0]![0]).toBe("m9");
  });

  // ---- FORGET-03 anti-induced-eviction corroboration gate (the SECURITY first-RED) ----

  it("FORGET-03: a single NON-deterministic (reaction-only) failure does NOT accrue failure_count (gate blocks)", async () => {
    // sources has NO 'tool'/'pipeline' → not deterministic; only ONE occurrence →
    // < 2 independent. The corroboration gate blocks any accrual (anti-cache-poisoning).
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["reaction"], recalledIds: ["m1"], confidence: 0.4 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("FORGET-03: a single low-confidence correction-only failure does NOT penalize (benign — Defer ≠ Retry)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "corrected", sources: ["correction"], recalledIds: ["m1"], confidence: 0.3 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("FORGET-03: ≥2 INDEPENDENT failures (distinct sessions) for the same memory → recordFailure fires on the 2nd", async () => {
    const us = mockUsefulnessStore();
    // Both verdicts are NON-deterministic (reaction-only) so ONLY the distinct-session
    // corroboration can satisfy the gate (not a deterministic shortcut).
    const { bus } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["reaction"], recalledIds: ["m1"], confidence: 0.5 }),
      { usefulnessStore: us },
    );

    // 1st failure from session A → below the gate (1 independent) → no accrual yet.
    await driveTrajectory(bus, "tenant-x:telegram:user-A", "trace-A");
    expect(us.recordFailure).not.toHaveBeenCalled();

    // 2nd failure from a DISTINCT session B → 2 independent → accrual fires.
    await driveTrajectory(bus, "tenant-x:telegram:user-B", "trace-B");
    expect(us.recordFailure).toHaveBeenCalledTimes(1);
    expect(us.recordFailure.mock.calls[0]![0]).toBe("m1");
  });

  it("FORGET-03: two failures from the SAME session do NOT corroborate (distinct-session count stays 1)", async () => {
    const us = mockUsefulnessStore();
    const { bus } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["reaction"], recalledIds: ["m1"], confidence: 0.5 }),
      { usefulnessStore: us },
    );

    // Same sessionKey twice → distinct-session set stays {A} → never reaches ≥2 → no accrual.
    await driveTrajectory(bus, "tenant-x:telegram:user-A", "trace-A1");
    await driveTrajectory(bus, "tenant-x:telegram:user-A", "trace-A2");
    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("accrual is UNCONDITIONAL once corroborated — the daemon issues NO proof/trust/pinned store read", async () => {
    // Once the gate passes (a deterministic failure), recordFailure fires for the
    // recalled id regardless of any proof/trust/pinned attribute. The mock store
    // exposes ONLY recordUsage/readUsefulness/recordFailure — there is NO proof-lookup
    // method to call, which is the point (ResolvedOutcome carries no proof/trust/pinned;
    // the eviction exemption is store-side, Plan 05). Assert recordFailure fires AND
    // the read path (readUsefulness) is NOT consulted at the resolve seam.
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["pipeline"], recalledIds: ["m1"], confidence: 0.9 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).toHaveBeenCalledTimes(1);
    // No proof/trust read: the seam never calls readUsefulness (the only read method).
    expect(us.readUsefulness).not.toHaveBeenCalled();
  });

  // ---- byte-identity + non-fatal ----

  it("byte-identity: learningTuning AND learningForgetting disabled → NEITHER recordUsage NOR recordFailure", async () => {
    const usSuccess = mockUsefulnessStore();
    const { bus: busS } = wireRewardSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["m1"] }),
      { tuning: false, forgetting: false, usefulnessStore: usSuccess },
    );
    await driveTrajectory(busS, SESSION_KEY, TRACE);
    expect(usSuccess.recordUsage).not.toHaveBeenCalled();

    const usFail = mockUsefulnessStore();
    const { bus: busF } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["pipeline"], recalledIds: ["m1"] }),
      { tuning: false, forgetting: false, usefulnessStore: usFail },
    );
    await driveTrajectory(busF, SESSION_KEY, TRACE);
    expect(usFail.recordFailure).not.toHaveBeenCalled();
  });

  it("the reward write is independently gated: tuning ON / forgetting OFF → success rewards, failure does NOT accrue", async () => {
    const usFail = mockUsefulnessStore();
    const { bus } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["pipeline"], recalledIds: ["m1"] }),
      { tuning: true, forgetting: false, usefulnessStore: usFail },
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);
    // forgetting OFF → no failure accrual even though the deterministic gate would pass.
    expect(usFail.recordFailure).not.toHaveBeenCalled();
  });

  it("an 'unknown' verdict writes NOTHING (no reward, no failure — fail-closed, OUTCOME-05)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "unknown", sources: [], recalledIds: ["m1"], confidence: 0 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);
    expect(us.recordUsage).not.toHaveBeenCalled();
    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("is non-fatal: a recordFailure that REJECTS logs a WARN with hint+errorKind and does not throw out of the handler", async () => {
    const us = mockUsefulnessStore();
    us.recordFailure.mockImplementationOnce(async () => {
      throw new Error("db locked");
    });
    const logger = createMockLogger();
    const { bus } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["pipeline"], recalledIds: ["m1"], confidence: 0.9 }),
      { usefulnessStore: us, logger },
    );

    await expect(driveTrajectory(bus, SESSION_KEY, TRACE)).resolves.toBeUndefined();
    expect(us.recordFailure).toHaveBeenCalledTimes(1);
    const warn = logger.warn.mock.calls.find(
      (c) => typeof (c[0] as { hint?: string }).hint === "string" && (c[0] as { errorKind?: string }).errorKind !== undefined,
    );
    expect(warn, "a failure write reject must WARN with hint+errorKind").toBeDefined();
  });

  it("is non-fatal: a recordUsage that returns err WARNs and does not throw", async () => {
    const us = mockUsefulnessStore();
    us.recordUsage.mockImplementationOnce(async () => err(new Error("db locked")));
    const logger = createMockLogger();
    const { bus } = wireRewardSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["m1"] }),
      { usefulnessStore: us, logger },
    );

    await expect(driveTrajectory(bus, SESSION_KEY, TRACE)).resolves.toBeUndefined();
    expect(us.recordUsage).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── WR-01: the FORGET-03 corroboration tally must be BOUNDED ──
//
// failureCorroborationTally is a Map<memoryId, Set<sessionId>> with no cap/TTL on
// HEAD — a long-running daemon with learningForgetting on and a steady stream of
// failing trajectories across many memories/sessions grows it without bound (a
// genuine leak; an adversary on rotating session keys can inflate it). Once the gate
// can be met (≥ CORROBORATION_MIN_INDEPENDENT distinct sessions) the exact count past
// that floor is irrelevant, so the inner Set must STOP growing there, and the outer
// Map must cap the number of tracked memoryIds (evict-oldest). RED on HEAD: the inner
// Set grows past the floor and the outer Map is unbounded.
describe("WR-01: failureCorroborated tally is bounded (no daemon-lifetime growth)", () => {
  it("stops growing the per-memory session Set once the corroboration floor is reachable", () => {
    const tally = new Map<string, Set<string>>();
    // Feed FAR more distinct sessions than the floor for one memory (non-deterministic
    // source so only the distinct-session corroboration matters).
    for (let i = 0; i < 1000; i++) {
      failureCorroborated("mem-hot", `session-${i}`, ["reaction"], tally);
    }
    const sessions = tally.get("mem-hot");
    expect(sessions).toBeDefined();
    // Past the floor the count is irrelevant → the Set must not accumulate all 1000.
    expect(sessions!.size).toBeLessThanOrEqual(CORROBORATION_MIN_INDEPENDENT);
    // …and it still corroborates (the gate decision is unaffected by the cap).
    expect(failureCorroborated("mem-hot", "session-final", ["reaction"], tally)).toBe(true);
  });

  it("caps the number of tracked memoryIds (outer Map evicts the oldest)", () => {
    const tally = new Map<string, Set<string>>();
    const maxTracked = 8; // small explicit cap for the test
    // Touch FAR more distinct memoryIds than the cap, one session each.
    for (let i = 0; i < 500; i++) {
      failureCorroborated(`mem-${i}`, "session-x", ["reaction"], tally, maxTracked);
    }
    // The Map is bounded by the cap — it never holds all 500 memoryIds.
    expect(tally.size).toBeLessThanOrEqual(maxTracked);
    // The MOST RECENT memoryId is retained (evict-oldest, not evict-newest).
    expect(tally.has("mem-499")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ATTR-02 (Plan 07): memory:skill_used → observe(usedSkillIds) DAEMON-SIDE.
// The agent EMITS the per-turn used-skill ids on memory:skill_used (Plan 03,
// mirroring memory:recall_used); the daemon SUBSCRIBES + threads usedSkillIds
// into an observe() call so the used_skill_ids COLUMN is written (the loop is no
// longer write-only). The agent never touches the store — closed graph.
// ---------------------------------------------------------------------------

function skillUsedPayload(over?: Partial<EventMap["memory:skill_used"]>): EventMap["memory:skill_used"] {
  return {
    agentId: AGENT,
    sessionKey: SESSION_KEY,
    traceId: TRACE,
    usedSkillIds: ["deploy"],
    usedCount: 1,
    timestamp: NOW,
    ...over,
  };
}

describe("wireLearningOutcome — memory:skill_used → observe(usedSkillIds) (ATTR-02 loop close)", () => {
  it("threads usedSkillIds into an observe() call so the used_skill_ids column is written", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    bus.emit("memory:skill_used", skillUsedPayload({ usedSkillIds: ["deploy", "backup"], usedCount: 2 }));
    await flushMicrotasks();

    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.usedSkillIds).toEqual(["deploy", "backup"]);
    expect(obs.trajectoryId).toBe(TRACE); // trajectory identity = traceId
    expect(obs.agentId).toBe(AGENT);
    expect(obs.observedAt).toBe(NOW);
  });

  it("byte-identity: learningOutcomeEnabled => false → memory:skill_used triggers ZERO observe calls", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => false,
    });

    bus.emit("memory:skill_used", skillUsedPayload());
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });

  it("an empty usedSkillIds carrier writes NOTHING (no attribution → no observe)", async () => {
    const bus = new TypedEventBus();
    const { store, observe } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    bus.emit("memory:skill_used", skillUsedPayload({ usedSkillIds: [], usedCount: 0 }));
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });
});

// ── SURFACE-04/05/06 + OBS-01: the promote/demote loop at the resolve seam ──
//
// On a graph:completed → resolve() carrying the ATTR-02 `usedSkillIds`, a `success`
// verdict PROMOTES each used skill (Plan 02's threshold-gated store call) and a
// corroborated `failure`/`corrected` verdict DEMOTES it ONLY when the decay-aware
// trend transitions to WEAKENING — so a single induced failure on a well-reused
// procedure does NOT archive it. The 2 emits are plain counts-only.
describe("wireLearningOutcome — learned-skill promote/demote at resolve() (SURFACE-04/05/06, OBS-01)", () => {
  /** Wire the seam with the learned-skill loop enabled and a controllable verdict. */
  function wireSkillSeam(
    verdict: ResolvedOutcome,
    opts?: {
      skillsEnabled?: boolean;
      promoteAt?: number;
      learnedSkillStore?: ReturnType<typeof mockLearnedSkillStore>;
      logger?: ReturnType<typeof createMockLogger>;
      bus?: TypedEventBus;
    },
  ): {
    bus: TypedEventBus;
    ls: ReturnType<typeof mockLearnedSkillStore>;
  } {
    const bus = opts?.bus ?? new TypedEventBus();
    const { store } = makeStubStore(verdict);
    const ls = opts?.learnedSkillStore ?? mockLearnedSkillStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learnedSkillStore: ls.store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      learningSkillsEnabled: () => opts?.skillsEnabled ?? true,
      learningSkillsPromoteAt: () => opts?.promoteAt ?? 3,
      clock: createFakeClock(NOW),
      logger: opts?.logger ?? createMockLogger(),
      learningOutcomeEnabled: () => true,
    });
    return { bus, ls };
  }

  async function drive(bus: TypedEventBus, sessionKey: string, trace: string): Promise<void> {
    runWithContext(
      { tenantId: "tenant-x", agentId: AGENT, sessionKey, traceId: trace } as never,
      () => bus.emit("graph:completed", graphPayload({ status: "completed" })),
    );
    await flushMicrotasks();
  }

  it("SURFACE-04: a success verdict promotes EACH attributed usedSkillId with the configured threshold", async () => {
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1", "s2"] }),
      { promoteAt: 3 },
    );
    await drive(bus, SESSION_KEY, TRACE);

    expect(ls.promote).toHaveBeenCalledTimes(2);
    const calls = ls.promote.mock.calls.map((c) => [c[0], c[2]]);
    expect(calls).toEqual([
      ["s1", 3],
      ["s2", 3],
    ]);
    // Scoped to the resolved (tenant, agent) — the SEC-01 isolation boundary.
    const scope = ls.promote.mock.calls[0]![1];
    expect(scope.tenantId).toBe("tenant-x");
    expect(scope.agentId).toBe(AGENT);
    expect(ls.demote).not.toHaveBeenCalled();
  });

  it("SURFACE-05: a DETERMINISTIC (tool) failure whose SUSTAINED trend reaches weakening demotes the skill", async () => {
    // A deterministic source satisfies the corroboration gate on the FIRST failure;
    // sustained failures drive the trend to weakening → demote fires.
    const ls = mockLearnedSkillStore();
    const bus = new TypedEventBus();
    const verdict = baseVerdict({ outcome: "failure", sources: ["tool"], usedSkillIds: ["s1"], confidence: 0.9 });
    wireSkillSeam(verdict, { learnedSkillStore: ls, bus });

    // The trend needs SUSTAINED corroborated failure to weaken — drive several
    // resolves; demote fires once the standing crosses the weakening band.
    for (let i = 0; i < 6; i++) await drive(bus, SESSION_KEY, `${TRACE}-${i}`);
    expect(ls.demote).toHaveBeenCalled();
    expect(ls.demote.mock.calls[0]![0]).toBe("s1");
    // demote scope is (tenant, agent).
    const scope = ls.demote.mock.calls[0]![1];
    expect(scope.tenantId).toBe("tenant-x");
    expect(scope.agentId).toBe(AGENT);
    expect(ls.promote).not.toHaveBeenCalled();
  });

  it("SURFACE-05 anti-induced-demotion (§12 first-RED): a SINGLE non-deterministic (reaction-only) failure does NOT demote (corroboration gate blocks)", async () => {
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "failure", sources: ["reaction"], usedSkillIds: ["s1"], confidence: 0.4 }),
    );
    await drive(bus, SESSION_KEY, TRACE);
    // Single, non-deterministic, one session → the corroboration gate blocks any
    // trend update → a correct procedure is NOT archived by one induced failure.
    expect(ls.demote).not.toHaveBeenCalled();
  });

  it("SURFACE-05 anti-induced-demotion: a corroborated failure whose trend is STILL STABLE does NOT demote (well-reused skill, one failure)", async () => {
    // A deterministic (corroborated) failure but only ONCE → the trend stays
    // stable/strengthening (a single failure against a neutral/strong standing) →
    // NO demote. Only SUSTAINED corroborated failure reaches weakening.
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "failure", sources: ["tool"], usedSkillIds: ["s1"], confidence: 0.9 }),
    );
    await drive(bus, SESSION_KEY, TRACE);
    expect(ls.demote).not.toHaveBeenCalled();
  });

  it("SURFACE-06: a promote emits learning:skill_promoted with plain emit, COUNTS ONLY (no body/id-list)", async () => {
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    const { ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1", "s2"] }),
      { bus },
    );
    await drive(bus, SESSION_KEY, TRACE);

    expect(ls.promote).toHaveBeenCalledTimes(2);
    const promoted = emitSpy.mock.calls.find((c) => c[0] === "learning:skill_promoted");
    expect(promoted, "a promote must emit learning:skill_promoted").toBeDefined();
    const payload = promoted![1] as { agentId: string; count: number; timestamp: number };
    expect(payload.count).toBe(2);
    expect(payload.agentId).toBe(AGENT);
    // Counts-only firewall: NO body/script/id-list field on the payload.
    expect(Object.keys(payload).sort()).toEqual(["agentId", "count", "timestamp"]);
  });

  it("SURFACE-06: a demote emits learning:skill_demoted with plain emit, COUNTS ONLY", async () => {
    const ls = mockLearnedSkillStore();
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    wireSkillSeam(
      baseVerdict({ outcome: "failure", sources: ["tool"], usedSkillIds: ["s1"], confidence: 0.9 }),
      { learnedSkillStore: ls, bus },
    );
    for (let i = 0; i < 6; i++) await drive(bus, SESSION_KEY, `${TRACE}-${i}`);

    const demoted = emitSpy.mock.calls.find((c) => c[0] === "learning:skill_demoted");
    expect(demoted, "a demote must emit learning:skill_demoted").toBeDefined();
    const payload = demoted![1] as { agentId: string; count: number; timestamp: number };
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(Object.keys(payload).sort()).toEqual(["agentId", "count", "timestamp"]);
  });

  it("byte-identity: learningSkills disabled (default) → a success/failure resolve calls NEITHER promote/demote NOR the 2 emits", async () => {
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    const { ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1"] }),
      { skillsEnabled: false, bus },
    );
    await drive(bus, SESSION_KEY, TRACE);
    expect(ls.promote).not.toHaveBeenCalled();
    expect(ls.demote).not.toHaveBeenCalled();
    expect(emitSpy.mock.calls.some((c) => c[0] === "learning:skill_promoted")).toBe(false);
    expect(emitSpy.mock.calls.some((c) => c[0] === "learning:skill_demoted")).toBe(false);
  });

  it("byte-identity: NO learnedSkillStore injected → the loop is a no-op (the field is optional; pre-Plan-05 callers stay byte-identical)", async () => {
    const bus = new TypedEventBus();
    const { store } = makeStubStore(baseVerdict({ outcome: "success", usedSkillIds: ["s1"] }));
    const emitSpy = vi.spyOn(bus, "emit");
    // No learnedSkillStore / learningSkillsEnabled / learningSkillsPromoteAt deps.
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });
    runWithContext(
      { tenantId: "tenant-x", agentId: AGENT, sessionKey: SESSION_KEY, traceId: TRACE } as never,
      () => bus.emit("graph:completed", graphPayload({ status: "completed" })),
    );
    await flushMicrotasks();
    expect(emitSpy.mock.calls.some((c) => c[0] === "learning:skill_promoted")).toBe(false);
  });

  it("OBS-01: a promote/demote logs one INFO completion line with durationMs (counts/ids only)", async () => {
    const logger = createMockLogger();
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1"] }),
      { logger },
    );
    await drive(bus, SESSION_KEY, TRACE);
    expect(ls.promote).toHaveBeenCalledTimes(1);
    const info = logger.info.mock.calls.find(
      (c) =>
        typeof (c[0] as { durationMs?: number }).durationMs === "number" &&
        (c[0] as { promoted?: number }).promoted !== undefined,
    );
    expect(info, "a promote/demote must log one INFO completion line with durationMs + promoted/demoted counts").toBeDefined();
    const fields = info![0] as { promoted: number; demoted: number; durationMs: number; agentId: string };
    expect(fields.promoted).toBe(1);
    expect(fields.agentId).toBe(AGENT);
  });

  it("is non-fatal: a promote that REJECTS WARNs (hint+errorKind) and does not throw out of the handler", async () => {
    const ls = mockLearnedSkillStore();
    ls.promote.mockImplementationOnce(async () => {
      throw new Error("db locked");
    });
    const logger = createMockLogger();
    const bus = new TypedEventBus();
    wireSkillSeam(baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1"] }), {
      learnedSkillStore: ls,
      logger,
      bus,
    });
    await expect(drive(bus, SESSION_KEY, TRACE)).resolves.toBeUndefined();
    const warn = logger.warn.mock.calls.find(
      (c) => typeof (c[0] as { hint?: string }).hint === "string" && (c[0] as { errorKind?: string }).errorKind !== undefined,
    );
    expect(warn, "a promote write reject must WARN with hint+errorKind").toBeDefined();
  });
});

// ── SURFACE-07 / SEC-01: 202 adds NO new mutating-execution path ──
//
// The safety the read-only learned-skill surface buys (T-202-16): a surfaced
// (possibly poisoned) procedure is untrusted INSTRUCTION TEXT — the agent READS it
// and performs each step via the EXISTING per-tool governance (applyToolPolicy + the
// tool-call ApprovalGate at run time, §I9). 202 is policy + wiring, NOT a new
// execution engine: the promote/demote loop only calls store transitions + emits; the
// surface only reads list()/materializes a read-only SKILL.md/renders XML. This guard
// asserts the 202 daemon files contain NO tool-execution / spawn / approval-bypass
// primitive (so a poisoned procedure cannot execute an action the agent is not already
// authorized for) AND write NO trust level other than the store-owned 'learned'
// (T-202-18 — promotion touches state/proof_count only; trust is structurally capped).
describe("SURFACE-07 / SEC-01: the 202 daemon files add no execution path + no trust escalation", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  /** The 202 daemon source files (the promote/demote loop + the trend + the read-only surface). */
  const FILES_202 = [
    join(HERE, "setup-learning.ts"),
    join(HERE, "setup-learning-skill-trend.ts"),
    join(HERE, "setup-agents", "learned-skill-surface.ts"),
  ];

  /** Strip line/block comments so a doc mention of a forbidden token is not a false positive. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  it("contains NO tool-execution / spawn / approval-bypass call (the agent performs steps via the existing tool path)", () => {
    // The forbidden execution/bypass primitives. The read-only surface MAY write a
    // SKILL.md (writeFileSync/mkdirSync — materialize is read-only CONTENT the read
    // tool opens, NOT execution); it MUST NOT spawn a process, execute a tool call,
    // or bypass the approval gate.
    const forbidden: RegExp[] = [
      /\bspawn\b/,
      /\bspawnSync\b/,
      /\bbuildSpawnCommand\b/,
      /\bexecFile\b/,
      /\bexecSync\b/,
      /child_process/,
      /\bexecuteToolCall\b/,
      /\bdispatchTool\b/,
      /\brunTool\b/,
      /\bApprovalGate\b/, // the loop/surface must not even touch the gate (no bypass surface)
      /\bbypassApproval\b/,
      /\bautoApprove\b/,
    ];
    for (const file of FILES_202) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const pat of forbidden) {
        expect(
          pat.test(src),
          `${file} must not reference ${pat} — 202 adds no execution path (the agent performs steps via the existing applyToolPolicy + ApprovalGate at run time)`,
        ).toBe(false);
      }
    }
  });

  it("writes NO trust level other than the store-owned 'learned' (promotion never raises trust — T-202-18)", () => {
    // No 202 daemon file touches trust_level/trustLevel at all (that is the store's
    // job, and the DB CHECK pins it to 'learned'). Assert there is no trust write of
    // any other literal here.
    for (const file of FILES_202) {
      const src = stripComments(readFileSync(file, "utf8"));
      // Any assignment/property of a trust field to a NON-'learned' literal is forbidden.
      const trustWrite = /trust(?:_level|Level)\s*[:=]\s*["']((?!learned)[a-z_]+)["']/i;
      const m = trustWrite.exec(src);
      expect(m, `${file} must not write a trust level other than 'learned' (found: ${m?.[0] ?? "none"})`).toBeNull();
    }
  });

  it("the promote/demote loop calls ONLY the store transition methods (promote/demote) — no other store mutation", () => {
    // The loop's only learnedSkillStore calls are promote()/demote() (the surface
    // calls list() for the read). Assert setup-learning.ts references promote/demote
    // but NOT admit/evict (which would be a different, un-governed lifecycle write).
    const src = stripComments(readFileSync(join(HERE, "setup-learning.ts"), "utf8"));
    expect(src).toMatch(/\.promote\(/);
    expect(src).toMatch(/\.demote\(/);
    // The resolve seam never admits or evicts a skill (those are the synthesis/forget
    // paths, not the reuse-outcome loop).
    expect(/learnedSkillStore[^;]*\.admit\(/.test(src)).toBe(false);
    expect(/learnedSkillStore[^;]*\.evict\(/.test(src)).toBe(false);
  });
});

// ── CR-01: the promote/demote loop must drive the REAL store end-to-end ──
//
// The loop iterates verdict.usedSkillIds — which carries skill NAMES (ATTR-01),
// not the store's hash `id`. The store keys lifecycle transitions on
// `learnedSkillId() = sha256(tenant+agent+name)` via `WHERE id = ?`. Passing a
// NAME as the `id` matches 0 rows, so promote/demote are silent no-ops AND the
// 0-row write is reported as success (the counters/telemetry then lie). These
// tests drive the FULL loop against a REAL @comis/memory store (not the vi.fn()
// stub that only records the string arg) and assert the actual row transitioned
// AND the emitted count matches the REAL number of transitions.
//
// RED on pre-patch HEAD: the loop calls store.promote("<name>", …) → 0 rows →
// the row stays `candidate` and learning:skill_promoted still emits count>0.
describe("CR-01: promote/demote drive the REAL learned-skill store via name→id (not name-as-id)", () => {
  const SKILL_TENANT = "tenant-x"; // must match the ALS tenant resolved from SESSION_KEY
  const SKILL_AGENT = AGENT;

  /** Build the wiring over a REAL store + a resolve verdict carrying skill NAMES. */
  function wireRealSkillSeam(
    db: import("better-sqlite3").Database,
    verdict: ResolvedOutcome,
    opts?: { promoteAt?: number; bus?: TypedEventBus; logger?: ReturnType<typeof createMockLogger> },
  ): { bus: TypedEventBus; store: ReturnType<typeof createSqliteLearnedSkillStore> } {
    const bus = opts?.bus ?? new TypedEventBus();
    const { store: outcomeStore } = makeStubStore(verdict);
    const skillStore = createSqliteLearnedSkillStore({ db });
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore,
      usefulnessStore: mockUsefulnessStore().store,
      learnedSkillStore: skillStore,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      learningSkillsEnabled: () => true,
      learningSkillsPromoteAt: () => opts?.promoteAt ?? 1,
      clock: createFakeClock(NOW),
      logger: opts?.logger ?? createMockLogger(),
      learningOutcomeEnabled: () => true,
    });
    return { bus, store: skillStore };
  }

  async function driveGraph(bus: TypedEventBus, trace: string): Promise<void> {
    runWithContext(
      { tenantId: SKILL_TENANT, agentId: SKILL_AGENT, sessionKey: SESSION_KEY, traceId: trace } as never,
      () => bus.emit("graph:completed", graphPayload({ status: "completed" })),
    );
    await flushMicrotasks();
  }

  let db: import("better-sqlite3").Database;
  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db, 384);
  });
  afterEach(() => {
    db.close();
  });

  it("a SUCCESS verdict whose usedSkillIds are admitted NAMES actually flips the real row candidate→active", async () => {
    const scope = { tenantId: SKILL_TENANT, agentId: SKILL_AGENT };
    const seed = createSqliteLearnedSkillStore({ db });
    const admitted = await seed.admit(
      {
        name: "deploy-the-thing",
        description: "deploy safely",
        body: "1. read 2. report",
        mutating: false,
        proofCount: 0,
        confidence: 0.8,
        sourceTrajIds: ["traj_1"],
        createdAt: NOW,
      },
      scope,
    );
    expect(admitted.ok).toBe(true);

    // The verdict carries the skill NAME (as ATTR-01 produces), threshold 1.
    const { bus, store } = wireRealSkillSeam(
      db,
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["deploy-the-thing"] }),
      { promoteAt: 1 },
    );
    await driveGraph(bus, TRACE);

    // The REAL row must have transitioned: a name-as-id promote would leave it candidate.
    const after = await store.get("deploy-the-thing", scope);
    expect(after.ok).toBe(true);
    expect(after.ok ? after.value?.state : undefined).toBe("active"); // RED on HEAD (stays candidate)
    expect(after.ok ? after.value?.proofCount : undefined).toBe(1);
  });

  it("a success verdict naming a SKILL THAT DOES NOT EXIST emits count 0 and no learning:skill_promoted (telemetry stops lying)", async () => {
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    // No admit → the name resolves to no row.
    wireRealSkillSeam(
      db,
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["ghost-skill"] }),
      { bus },
    );
    await driveGraph(bus, TRACE);

    // A 0-row promote must NOT emit a non-zero count (RED on HEAD: emits count 1).
    const promoted = emitSpy.mock.calls.find((c) => c[0] === "learning:skill_promoted");
    expect(promoted, "an unmatched name must not emit learning:skill_promoted").toBeUndefined();
  });
});

/** Flush enough microtask turns to settle the observe→resolve→emit chain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
