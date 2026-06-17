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

import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, runWithContext } from "@comis/core";
import type { EventMap, OutcomeObservation, ResolvedOutcome, LearningScope } from "@comis/core";
import type { UsefulnessScope, MemoryUsefulnessStore, UsefulnessSignal } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { wireLearningOutcome } from "./setup-learning.js";

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

  it("SUCCESS verdict → recordUsage once per recalled id (outcome-attributed positive reward)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["m1", "m2"] }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordUsage).toHaveBeenCalledTimes(2);
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

/** Flush enough microtask turns to settle the observe→resolve→emit chain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
