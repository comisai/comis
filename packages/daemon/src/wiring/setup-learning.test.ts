// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for wireLearningOutcome() — the deterministic tool/pipeline outcome
 * observe/resolve subscriber.
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
 *   → observe "failure" (success ONLY on a clean DAG completion)
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
import { createSqliteMentalModelStore, initSchema } from "@comis/memory";
import type { EventMap, OutcomeObservation, ResolvedOutcome, LearningScope } from "@comis/core";
import type { UsefulnessScope, MemoryUsefulnessStore, UsefulnessSignal } from "@comis/core";
import type { MentalModelStorePort } from "@comis/core";
import { ok, err, type Result } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  wireLearningOutcome,
  failureCorroborated,
  CORROBORATION_MIN_INDEPENDENT,
} from "./setup-learning.js";

/**
 * A controllable MemoryUsefulnessStore stub. The daemon reward seam is the
 * agent↛memory cut enforcement point: the daemon holds BOTH
 * the bus/`OutcomeSignalPort.resolve()` AND this injected `@comis/memory`
 * usefulness adapter. Exposes ONLY the three port methods (recordUsage /
 * readUsefulness / recordFailure) — there is NO proof/trust/pinned lookup, which
 * is the point (the resolve seam reads no per-memory proof_count/trust_level/
 * pinned; the eviction exemption is store-side).
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
 * A controllable MentalModelStorePort stub for the promote/demote
 * loop. Exposes ONLY the promote/demote write methods the resolve seam calls (the
 * loop reads NO per-skill proof/trust — the threshold gate is store-side);
 * the read/admit/evict methods are present (the port shape) but unused by the seam.
 */
function mockLearnedSkillStore(opts?: { promoteChanged?: boolean; demoteChanged?: boolean }) {
  // The resolve seam calls the NAME-keyed promoteByName/demoteByName (the
  // carrier holds skill NAMES, not the hash id). Default `changed: true` (a real row
  // moved) so the existing promote/demote assertions hold; a test can force
  // `changed: false` to assert the 0-row path does NOT count/emit.
  const promoteByName = vi.fn(
    async (_name: string, _scope: LearningScope, _threshold: number): Promise<Result<{ changed: boolean }, Error>> =>
      ok({ changed: opts?.promoteChanged ?? true }),
  );
  const demoteByName = vi.fn(
    async (_name: string, _scope: LearningScope): Promise<Result<{ changed: boolean }, Error>> =>
      ok({ changed: opts?.demoteChanged ?? true }),
  );
  const store = {
    promoteByName,
    demoteByName,
    promote: vi.fn(async (): Promise<Result<void, Error>> => ok(undefined)),
    demote: vi.fn(async (): Promise<Result<void, Error>> => ok(undefined)),
    admit: vi.fn(async () => ok({ id: "x", admitted: true })),
    get: vi.fn(async () => ok(undefined)),
    list: vi.fn(async () => ok([])),
    evict: vi.fn(async () => ok(undefined)),
  } as unknown as MentalModelStorePort;
  return { store, promoteByName, demoteByName };
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

  it("graph:completed { status:'failed' } records a 'failure' pipeline outcome (clean-completion gate)", async () => {
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

  it("graph:driver_lifecycle does NOT observe — graph:completed is the single pipeline signal", async () => {
    // The per-node driver lifecycle is NOT a trajectory-level signal: a
    // multi-node DAG emits graph:driver_lifecycle per node, which would flood the
    // ledger with O(nodes) same-tier `pipeline` rows and amplify the fusion
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
 * The outcome→reward/failure write seam at resolve() time, corroboration-gated.
 *
 * A memory in `verdict.recalledIds` of a SUCCESS trajectory accrues per-intent
 * positive reward (`recordUsage`); of a FAILURE/CORRECTED trajectory accrues
 * `failure_count` (`recordFailure`) — but ONLY after the anti-induced-eviction
 * corroboration gate: ≥2 INDEPENDENT failures (distinct sessions) OR 1
 * DETERMINISTIC (`tool`/`pipeline`) failure. A single low-trust/`external`
 * failure accrues NOTHING (Defer ≠ Retry — benign). Once the gate is met the
 * accrual is UNCONDITIONAL: the daemon reads NO per-memory proof/trust/pinned
 * (ResolvedOutcome carries none); the high-proof/system/pinned EVICTION exemption
 * lives store-side. All writes are fire-and-forget / non-fatal and gated
 * default-OFF on learningTuning/learningForgetting (byte-identical when disabled).
 */
describe("wireLearningOutcome — reward/failure write at resolve()", () => {
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

  it("SUCCESS verdict → recordUsage ONCE for all recalled ids (batched into a single transaction)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["m1", "m2"] }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    // The success reward is ONE batched recordUsage(recalledIds, [], scope)
    // call (the store loops internally in one transaction) instead of O(recalledIds)
    // separate calls — the failure branch stays per-id (corroboration-gated).
    expect(us.recordUsage).toHaveBeenCalledTimes(1);
    const ids = us.recordUsage.mock.calls.map((c) => c[0]).flat();
    expect(ids.sort()).toEqual(["m1", "m2"]);
    // The reward write is scoped to the resolved (tenant, agent); intent omitted →
    // the global '' bucket (the verdict carries no intent).
    const scope = us.recordUsage.mock.calls[0]![2];
    expect(scope.agentId).toBe(AGENT);
    expect(scope.tenantId).toBe("tenant-x");
    // No failure accrual on a success.
    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("the recordUsage/recordFailure reward write fires independently of the recall bandit", async () => {
    // There is no UCB recall bandit (no learner/perIntent/exploration sub-fields,
    // no per-intent apply, no __ONLINE_TUNING__ cron), but learningTuning.enabled +
    // the reward write it gates DO exist. This pins that contract: with learningTuning.enabled ON, a
    // SUCCESS still rewards (recordUsage) and a FAILURE still accrues failure_count (recordFailure).
    const success = wireRewardSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["k1"] }),
    );
    await driveTrajectory(success.bus, SESSION_KEY, TRACE);
    expect(success.us.recordUsage, "success reward still fires without the recall bandit").toHaveBeenCalledTimes(1);

    const failure = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["pipeline"], recalledIds: ["k1"] }),
    );
    await driveTrajectory(failure.bus, SESSION_KEY, TRACE);
    expect(failure.us.recordFailure, "failure_count accrual still fires without the recall bandit").toHaveBeenCalled();
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

  // ---- anti-induced-eviction corroboration gate ----

  it("a single NON-deterministic (reaction-only) failure does NOT accrue failure_count (gate blocks)", async () => {
    // sources has NO 'tool'/'pipeline' → not deterministic; only ONE occurrence →
    // < 2 independent. The corroboration gate blocks any accrual (anti-cache-poisoning).
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "failure", sources: ["reaction"], recalledIds: ["m1"], confidence: 0.4 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("a single low-confidence correction-only failure does NOT penalize (benign — Defer ≠ Retry)", async () => {
    const { bus, us } = wireRewardSeam(
      baseVerdict({ outcome: "corrected", sources: ["correction"], recalledIds: ["m1"], confidence: 0.3 }),
    );
    await driveTrajectory(bus, SESSION_KEY, TRACE);

    expect(us.recordFailure).not.toHaveBeenCalled();
  });

  it("≥2 INDEPENDENT failures (distinct sessions) for the same memory → recordFailure fires on the 2nd", async () => {
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

  it("two failures from the SAME session do NOT corroborate (distinct-session count stays 1)", async () => {
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
    // the eviction exemption is store-side). Assert recordFailure fires AND
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

  it("an 'unknown' verdict writes NOTHING (no reward, no failure — fail-closed)", async () => {
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

// ── the corroboration tally must be BOUNDED ──
//
// failureCorroborationTally is a Map<memoryId, Set<sessionId>>; without a cap/TTL
// a long-running daemon with learningForgetting on and a steady stream of
// failing trajectories across many memories/sessions grows it without bound (a
// genuine leak; an adversary on rotating session keys can inflate it). Once the gate
// can be met (≥ CORROBORATION_MIN_INDEPENDENT distinct sessions) the exact count past
// that floor is irrelevant, so the inner Set must STOP growing there, and the outer
// Map must cap the number of tracked memoryIds (evict-oldest).
describe("failureCorroborated tally is bounded (no daemon-lifetime growth)", () => {
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
// memory:skill_used → observe(usedSkillIds) DAEMON-SIDE.
// The agent EMITS the per-turn used-skill ids on memory:skill_used
// (mirroring memory:recall_used); the daemon SUBSCRIBES + threads usedSkillIds
// into an observe() call so the used_skill_ids COLUMN is written. The agent
// never touches the store — closed graph.
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

describe("wireLearningOutcome — memory:skill_used → observe(usedSkillIds)", () => {
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

// The outcome-gated recall reward depends on the recalled+used ids reaching the
// outcome ledger: the executor emits memory:recall_used with them, but unless the
// daemon observes them onto the ledger, verdict.recalledIds stays empty and the
// resolve's recordUsage/recordFailure (failure_count) never fire. Mirror the skill
// carrier: a neutral carrier row writes the recalled_ids column.
describe("wireLearningOutcome — memory:recall_used → observe(recalledIds)", () => {
  function recallUsedPayload(over?: { usedIds?: string[]; agentId?: string }) {
    return {
      agentId: over?.agentId ?? AGENT,
      sessionKey: SESSION_KEY,
      traceId: TRACE,
      usedIds: over?.usedIds ?? ["mem-a", "mem-b"],
      ignoredIds: [] as string[],
      usedCount: (over?.usedIds ?? ["mem-a", "mem-b"]).length,
      ignoredCount: 0,
      timestamp: NOW,
    };
  }

  it("threads the recalled+used ids into an observe() call so the recalled_ids column is written", async () => {
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

    bus.emit("memory:recall_used", recallUsedPayload({ usedIds: ["mem-a", "mem-b"] }));
    await flushMicrotasks();

    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.recalledIds).toEqual(["mem-a", "mem-b"]);
    expect(obs.outcome).toBe("unknown"); // a pure attribution carrier — never wins fusion
    expect(obs.trajectoryId).toBe(TRACE);
    expect(obs.agentId).toBe(AGENT);
  });

  it("byte-identity: learningOutcomeEnabled => false → memory:recall_used triggers ZERO observe calls", async () => {
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

    bus.emit("memory:recall_used", recallUsedPayload());
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });

  it("an empty usedIds recall carrier writes NOTHING (no attribution → no observe)", async () => {
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

    bus.emit("memory:recall_used", recallUsedPayload({ usedIds: [] }));
    await flushMicrotasks();

    expect(observe).not.toHaveBeenCalled();
  });
});

// ── the promote/demote loop at the resolve seam ──
//
// On a graph:completed → resolve() carrying the `usedSkillIds`, a `success`
// verdict PROMOTES each used skill (a threshold-gated store call) and a
// corroborated `failure`/`corrected` verdict DEMOTES it ONLY when the decay-aware
// trend transitions to WEAKENING — so a single induced failure on a well-reused
// procedure does NOT archive it. The 2 emits are plain counts-only.
describe("wireLearningOutcome — learned-skill promote/demote at resolve()", () => {
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

  it("a success verdict promotes EACH attributed usedSkillId (by NAME) with the configured threshold", async () => {
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1", "s2"] }),
      { promoteAt: 3 },
    );
    await drive(bus, SESSION_KEY, TRACE);

    // The seam calls the NAME-keyed promoteByName (the carrier holds NAMES).
    expect(ls.promoteByName).toHaveBeenCalledTimes(2);
    const calls = ls.promoteByName.mock.calls.map((c) => [c[0], c[2]]);
    expect(calls).toEqual([
      ["s1", 3],
      ["s2", 3],
    ]);
    // Scoped to the resolved (tenant, agent) — the isolation boundary.
    const scope = ls.promoteByName.mock.calls[0]![1];
    expect(scope.tenantId).toBe("tenant-x");
    expect(scope.agentId).toBe(AGENT);
    expect(ls.demoteByName).not.toHaveBeenCalled();
  });

  it("a promote that changes NO row (changed=false) does NOT count or emit learning:skill_promoted", async () => {
    const ls = mockLearnedSkillStore({ promoteChanged: false });
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    wireSkillSeam(baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1"] }), {
      learnedSkillStore: ls,
      bus,
    });
    await drive(bus, SESSION_KEY, TRACE);
    // promoteByName WAS called, but it matched 0 rows → the telemetry must not lie.
    expect(ls.promoteByName).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls.some((c) => c[0] === "learning:skill_promoted")).toBe(false);
  });

  it("a DETERMINISTIC (tool) failure whose SUSTAINED trend reaches weakening demotes the skill", async () => {
    // A deterministic source satisfies the corroboration gate on the FIRST failure;
    // sustained failures drive the trend to weakening → demote fires.
    const ls = mockLearnedSkillStore();
    const bus = new TypedEventBus();
    const verdict = baseVerdict({ outcome: "failure", sources: ["tool"], usedSkillIds: ["s1"], confidence: 0.9 });
    wireSkillSeam(verdict, { learnedSkillStore: ls, bus });

    // The trend needs SUSTAINED corroborated failure to weaken — drive several
    // resolves; demote fires once the standing crosses the weakening band.
    for (let i = 0; i < 6; i++) await drive(bus, SESSION_KEY, `${TRACE}-${i}`);
    expect(ls.demoteByName).toHaveBeenCalled();
    expect(ls.demoteByName.mock.calls[0]![0]).toBe("s1");
    // demote scope is (tenant, agent).
    const scope = ls.demoteByName.mock.calls[0]![1];
    expect(scope.tenantId).toBe("tenant-x");
    expect(scope.agentId).toBe(AGENT);
    expect(ls.promoteByName).not.toHaveBeenCalled();
  });

  it("anti-induced-demotion: a SINGLE non-deterministic (reaction-only) failure does NOT demote (corroboration gate blocks)", async () => {
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "failure", sources: ["reaction"], usedSkillIds: ["s1"], confidence: 0.4 }),
    );
    await drive(bus, SESSION_KEY, TRACE);
    // Single, non-deterministic, one session → the corroboration gate blocks any
    // trend update → a correct procedure is NOT archived by one induced failure.
    expect(ls.demoteByName).not.toHaveBeenCalled();
  });

  it("anti-induced-demotion: a corroborated failure whose trend is STILL STABLE does NOT demote (well-reused skill, one failure)", async () => {
    // A deterministic (corroborated) failure but only ONCE → the trend stays
    // stable/strengthening (a single failure against a neutral/strong standing) →
    // NO demote. Only SUSTAINED corroborated failure reaches weakening.
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "failure", sources: ["tool"], usedSkillIds: ["s1"], confidence: 0.9 }),
    );
    await drive(bus, SESSION_KEY, TRACE);
    expect(ls.demoteByName).not.toHaveBeenCalled();
  });

  it("cross-tenant isolation: tenant A's sustained failures for a skill NAME do NOT drive tenant B's same-named skill toward demotion", async () => {
    // The corroboration tally + trend tracker are in-process daemon-lifetime maps;
    // keying them on the BARE skill name aliases two (tenant, agent) scopes that each
    // surface a skill literally named "deploy" — so A's failures could weaken B's
    // standing and demote B's skill. With scope-qualified keys (tenant+agent+name)
    // the two are independent. With a bare-name key, B would demote on its FIRST failure
    // (inheriting A's weakening trend).
    const ls = mockLearnedSkillStore();
    const bus = new TypedEventBus();
    const { store: outcomeStore } = makeStubStore(
      baseVerdict({ outcome: "failure", sources: ["tool"], usedSkillIds: ["deploy"], confidence: 0.9 }),
    );
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore,
      usefulnessStore: mockUsefulnessStore().store,
      learnedSkillStore: ls.store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      learningSkillsEnabled: () => true,
      learningSkillsPromoteAt: () => 3,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    // Drive a sustained corroborated failure history for "deploy" under TENANT A so
    // A's trend reaches weakening and A's skill demotes.
    for (let i = 0; i < 6; i++) {
      runWithContext(
        { tenantId: "tenant-A", agentId: AGENT, sessionKey: `tenant-A:tg:u${i}`, traceId: `tA-${i}` } as never,
        () => bus.emit("graph:completed", graphPayload({ status: "completed" })),
      );
      await flushMicrotasks();
    }
    const demotesUnderA = ls.demoteByName.mock.calls.filter((c) => c[1].tenantId === "tenant-A").length;
    expect(demotesUnderA).toBeGreaterThanOrEqual(1); // A's own sustained failures DID weaken A

    // Now a SINGLE failure for the same skill NAME under TENANT B. With independent
    // (scope-qualified) gauges, B's standing is fresh → still stable → NO demote for B.
    runWithContext(
      { tenantId: "tenant-B", agentId: AGENT, sessionKey: "tenant-B:tg:u0", traceId: "tB-0" } as never,
      () => bus.emit("graph:completed", graphPayload({ status: "completed" })),
    );
    await flushMicrotasks();

    const demotesUnderB = ls.demoteByName.mock.calls.filter((c) => c[1].tenantId === "tenant-B").length;
    expect(demotesUnderB).toBe(0); // B's skill is NOT demoted by A's history (independent state)
  });

  it("a promote emits learning:skill_promoted with plain emit, COUNTS ONLY (no body/id-list)", async () => {
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    const { ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1", "s2"] }),
      { bus },
    );
    await drive(bus, SESSION_KEY, TRACE);

    expect(ls.promoteByName).toHaveBeenCalledTimes(2);
    const promoted = emitSpy.mock.calls.find((c) => c[0] === "learning:skill_promoted");
    expect(promoted, "a promote must emit learning:skill_promoted").toBeDefined();
    const payload = promoted![1] as { agentId: string; count: number; timestamp: number };
    expect(payload.count).toBe(2);
    expect(payload.agentId).toBe(AGENT);
    // Counts-only firewall: NO body/script/id-list field on the payload.
    expect(Object.keys(payload).sort()).toEqual(["agentId", "count", "timestamp"]);
  });

  it("a demote emits learning:skill_demoted with the NAME + trigger trajectory (content-free ids, no body)", async () => {
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
    const payload = demoted![1] as { agentId: string; count: number; demotedSkillNames?: string[]; triggerTrajectoryId?: string; timestamp: number };
    expect(payload.count).toBeGreaterThanOrEqual(1);
    // The demoted skill NAME + the trigger trajectory id ride alongside the count.
    expect(payload.demotedSkillNames).toContain("s1");
    expect(typeof payload.triggerTrajectoryId).toBe("string");
    // Still content-free: ONLY ids/counts/trajectory-id cross — never a body/script/description.
    expect(Object.keys(payload).sort()).toEqual(["agentId", "count", "demotedSkillNames", "timestamp", "triggerTrajectoryId"]);
  });

  it("byte-identity: learningSkills disabled (default) → a success/failure resolve calls NEITHER promote/demote NOR the 2 emits", async () => {
    const bus = new TypedEventBus();
    const emitSpy = vi.spyOn(bus, "emit");
    const { ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1"] }),
      { skillsEnabled: false, bus },
    );
    await drive(bus, SESSION_KEY, TRACE);
    expect(ls.promoteByName).not.toHaveBeenCalled();
    expect(ls.demoteByName).not.toHaveBeenCalled();
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

  it("a promote/demote logs one INFO completion line with durationMs (counts/ids only)", async () => {
    const logger = createMockLogger();
    const { bus, ls } = wireSkillSeam(
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["s1"] }),
      { logger },
    );
    await drive(bus, SESSION_KEY, TRACE);
    expect(ls.promoteByName).toHaveBeenCalledTimes(1);
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
    ls.promoteByName.mockImplementationOnce(async () => {
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

// ── a SINGLE-AGENT turn must resolve too ──
//
// The resolve loop (resolve → reward → forget-accrual → skill promote/demote) must NOT
// fire ONLY inside the `graph:completed` handler — which the graph coordinator emits ONLY
// for named-graph/DAG runs, NEVER the common single-agent conversational turn. If it did,
// a single-agent turn would WRITE `outcome_events` rows (tool:executed +
// memory:skill_used, keyed on traceId) that are NEVER resolved → never rewarded,
// never accrued failure_count, never promote/demote'd. Like the correction writer, key
// the resolve off the per-turn `diagnostic:message_processed` PAYLOAD (which carries
// agentId/sessionKey/traceId and fires for single-agent turns too — execution-pipeline.ts),
// NOT the ALS.
describe("wireLearningOutcome — SINGLE-AGENT turn resolve via diagnostic:message_processed", () => {
  function diagnosticPayload(
    over?: Partial<EventMap["diagnostic:message_processed"]>,
  ): EventMap["diagnostic:message_processed"] {
    return {
      messageId: "msg-1",
      channelId: "chan-1",
      channelType: "telegram",
      agentId: AGENT,
      sessionKey: SESSION_KEY,
      traceId: TRACE,
      receivedAt: NOW,
      executionDurationMs: 10,
      deliveryDurationMs: 0,
      totalDurationMs: 10,
      tokensUsed: 5,
      cost: 0,
      success: true,
      finishReason: "stop",
      timestamp: NOW,
      ...over,
    };
  }

  it("a single-agent turn (diagnostic:message_processed, NO graph:completed) resolves AND runs the reward + promote consumer", async () => {
    const bus = new TypedEventBus();
    // The fused verdict carries a recalled id (RANK reward) AND a used skill (SURFACE
    // promote) — the downstream consumer chain must run for BOTH on a single-agent turn.
    const { store, observe, resolve } = makeStubStore(
      baseVerdict({ outcome: "success", sources: ["tool"], recalledIds: ["m1"], usedSkillIds: ["s1"] }),
    );
    const us = mockUsefulnessStore();
    const ls = mockLearnedSkillStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learnedSkillStore: ls.store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      learningSkillsEnabled: () => true,
      learningSkillsPromoteAt: () => 1,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    // The single-agent turn first writes the deterministic rows (tool success + the
    // skill-use attribution) keyed on traceId — exactly the writes resolve() must find.
    bus.emit("tool:executed", toolPayload({ success: true }));
    bus.emit("memory:skill_used", skillUsedPayload({ usedSkillIds: ["s1"], usedCount: 1 }));
    await flushMicrotasks();
    expect(observe).toHaveBeenCalled(); // the rows were written

    // …then the per-turn completion event fires (NO graph:completed for a single-agent
    // turn). The resolve keys off this PAYLOAD, so a single-agent turn resolves too.
    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    // resolve() fired keyed on the SAME traceId the rows were written under.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]![0]).toBe(TRACE);
    const resScope = resolve.mock.calls[0]![1];
    expect(resScope.agentId).toBe(AGENT);
    expect(resScope.tenantId).toBe("tenant-x"); // derived from SESSION_KEY's first segment

    // The downstream consumer ran: RANK reward for the recalled id …
    expect(us.recordUsage).toHaveBeenCalledTimes(1);
    expect(us.recordUsage.mock.calls[0]![0]).toEqual(["m1"]);
    // … AND the SURFACE promote for the attributed skill (by NAME).
    expect(ls.promoteByName).toHaveBeenCalledTimes(1);
    expect(ls.promoteByName.mock.calls[0]![0]).toBe("s1");
  });

  it("byte-identity: learningOutcomeEnabled => false → diagnostic:message_processed resolves NOTHING", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore();
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

    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    expect(resolve).not.toHaveBeenCalled();
  });

  it("skips when the diagnostic payload carries no traceId (cannot key the resolve → fail-closed)", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore();
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

    // No traceId on the payload AND the emit is OUTSIDE any ALS scope (mirrors the real
    // emit site) → no trajectory identity → skip, never a wrong-trajectory resolve.
    bus.emit("diagnostic:message_processed", diagnosticPayload({ traceId: undefined }));
    await flushMicrotasks();

    expect(resolve).not.toHaveBeenCalled();
  });

  // ── idempotency: a DAG turn fires BOTH events for one trajectory ──
  //
  // resolve() is a PURE read+fusion (no "resolved" column / no row-state mutation —
  // sqlite-outcome-store.ts), so a second resolve for the same trajectory returns the
  // SAME verdict and would re-run the whole reward/promote chain. A DAG turn fires BOTH
  // graph:completed AND diagnostic:message_processed (executeAndDeliver emits the
  // diagnostic at the end; the graph coordinator emits graph:completed during the run),
  // so the loop MUST resolve/reward/promote a given trajectory exactly ONCE.
  it("a DAG turn firing BOTH graph:completed AND diagnostic:message_processed resolves/rewards/promotes exactly once", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore(
      baseVerdict({ outcome: "success", sources: ["pipeline"], recalledIds: ["m1"], usedSkillIds: ["s1"] }),
    );
    const us = mockUsefulnessStore();
    const ls = mockLearnedSkillStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learnedSkillStore: ls.store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      learningSkillsEnabled: () => true,
      learningSkillsPromoteAt: () => 1,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    // BOTH events fire for the SAME trajectory (traceId === TRACE). graph:completed
    // recovers the scope from ALS; diagnostic:message_processed keys off its payload.
    withCtx(() => bus.emit("graph:completed", graphPayload({ status: "completed" })));
    await flushMicrotasks();
    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    // Exactly ONE resolve + ONE reward + ONE promote for the trajectory (no double-run).
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(us.recordUsage).toHaveBeenCalledTimes(1);
    expect(ls.promoteByName).toHaveBeenCalledTimes(1);
  });

  it("the dedup is PER-TRAJECTORY: two DISTINCT single-agent turns each resolve once", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore(
      baseVerdict({ outcome: "success", sources: ["tool"], recalledIds: ["m1"] }),
    );
    const us = mockUsefulnessStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    bus.emit("diagnostic:message_processed", diagnosticPayload({ traceId: "trace-A", sessionKey: "tenant-x:tg:uA" }));
    await flushMicrotasks();
    bus.emit("diagnostic:message_processed", diagnosticPayload({ traceId: "trace-B", sessionKey: "tenant-x:tg:uB" }));
    await flushMicrotasks();

    // Distinct trajectories → the dedup does NOT collapse them; each resolves once.
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls.map((c) => c[0]).sort()).toEqual(["trace-A", "trace-B"]);
    expect(us.recordUsage).toHaveBeenCalledTimes(2);
  });

  it("is non-fatal: a diagnostic-triggered resolve that REJECTS does not throw out of the handler", async () => {
    const bus = new TypedEventBus();
    const observe = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const resolve = vi.fn(async () => {
      throw new Error("db locked");
    });
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

    expect(() => bus.emit("diagnostic:message_processed", diagnosticPayload())).not.toThrow();
    await flushMicrotasks();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── the learned-skill surface adds NO new mutating-execution path ──
//
// The safety the read-only learned-skill surface buys: a surfaced
// (possibly poisoned) procedure is untrusted INSTRUCTION TEXT — the agent READS it
// and performs each step via the EXISTING per-tool governance (applyToolPolicy + the
// tool-call ApprovalGate at run time). This layer is policy + wiring, NOT a new
// execution engine: the promote/demote loop only calls store transitions + emits; the
// surface only reads list()/materializes a read-only SKILL.md/renders XML. This guard
// asserts the learned-skill daemon files contain NO tool-execution / spawn / approval-bypass
// primitive (so a poisoned procedure cannot execute an action the agent is not already
// authorized for) AND write NO trust level other than the store-owned 'learned'
// (promotion touches state/proof_count only; trust is structurally capped).
describe("the learned-skill daemon files add no execution path + no trust escalation", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  /** The learned-skill daemon source files (the promote/demote loop + the trend + the read-only surface).
   *  The promote/demote loop body lives in setup-learning-skill-transitions.ts (extracted from
   *  setup-learning.ts to stay under the 800-line cap); both are guarded. */
  const FILES_202 = [
    join(HERE, "setup-learning.ts"),
    join(HERE, "setup-learning-skill-transitions.ts"),
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
          `${file} must not reference ${pat} — this layer adds no execution path (the agent performs steps via the existing applyToolPolicy + ApprovalGate at run time)`,
        ).toBe(false);
      }
    }
  });

  it("writes NO trust level other than the store-owned 'learned' (promotion never raises trust)", () => {
    // No learned-skill daemon file touches trust_level/trustLevel at all (that is the store's
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

  it("the promote/demote loop calls ONLY the store transition methods (promoteByName/demoteByName) — no other store mutation", () => {
    // The loop's only learnedSkillStore calls are the NAME-keyed
    // promoteByName()/demoteByName() (the carrier holds skill NAMES; the store
    // resolves name→id internally). The surface calls list() for the read. The loop body
    // lives in setup-learning-skill-transitions.ts (extracted from setup-learning.ts);
    // assert it references promote/demote (by name) but NOT admit/evict (which would be a
    // different, un-governed lifecycle write).
    const src = stripComments(readFileSync(join(HERE, "setup-learning-skill-transitions.ts"), "utf8"));
    expect(src).toMatch(/\.promoteByName\(/);
    expect(src).toMatch(/\.demoteByName\(/);
    // The resolve seam never admits or evicts a skill (those are the synthesis/forget
    // paths, not the reuse-outcome loop) — guard BOTH the loop body and its parent.
    const parent = stripComments(readFileSync(join(HERE, "setup-learning.ts"), "utf8"));
    for (const s of [src, parent]) {
      expect(/(?:learnedSkillStore|skillStore)[^;]*\.admit\(/.test(s)).toBe(false);
      expect(/(?:learnedSkillStore|skillStore)[^;]*\.evict\(/.test(s)).toBe(false);
    }
  });
});

// ── the promote/demote loop must drive the REAL store end-to-end ──
//
// The loop iterates verdict.usedSkillIds — which carries skill NAMES,
// not the store's hash `id`. The store keys lifecycle transitions on
// `learnedSkillId() = sha256(tenant+agent+name)` via `WHERE id = ?`. Passing a
// NAME as the `id` matches 0 rows, so promote/demote are silent no-ops AND the
// 0-row write is reported as success (the counters/telemetry then lie). These
// tests drive the FULL loop against a REAL @comis/memory store (not the vi.fn()
// stub that only records the string arg) and assert the actual row transitioned
// AND the emitted count matches the REAL number of transitions.
describe("promote/demote drive the REAL learned-skill store via name→id (not name-as-id)", () => {
  const SKILL_TENANT = "tenant-x"; // must match the ALS tenant resolved from SESSION_KEY
  const SKILL_AGENT = AGENT;

  /** Build the wiring over a REAL store + a resolve verdict carrying skill NAMES. */
  function wireRealSkillSeam(
    db: import("better-sqlite3").Database,
    verdict: ResolvedOutcome,
    opts?: { promoteAt?: number; bus?: TypedEventBus; logger?: ReturnType<typeof createMockLogger> },
  ): { bus: TypedEventBus; store: ReturnType<typeof createSqliteMentalModelStore> } {
    const bus = opts?.bus ?? new TypedEventBus();
    const { store: outcomeStore } = makeStubStore(verdict);
    const skillStore = createSqliteMentalModelStore({ db });
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

  /**
   * Drive the graph then DETERMINISTICALLY wait for the REAL store row to reach the
   * predicate. The skill promote/demote loop (applySkillOutcomeTransitions) is
   * fire-and-forget from the resolve `.then` and AWAITs a SQLite write, so a fixed
   * microtask-flush count is timing-fragile under coverage instrumentation (the
   * symptom the full `pnpm test:coverage` caught). Polling the observable store
   * state removes that fragility — it asserts the END STATE, not a flush count.
   */
  async function driveGraphThenAwait(
    bus: TypedEventBus,
    store: ReturnType<typeof createSqliteMentalModelStore>,
    name: string,
    scope: { tenantId: string; agentId: string },
    until: (s: { state: string; proofCount: number } | undefined) => boolean,
  ): Promise<void> {
    await driveGraph(bus, TRACE);
    for (let i = 0; i < 50; i++) {
      const r = await store.get(name, scope);
      const row = r.ok && r.value ? { state: r.value.state, proofCount: r.value.proofCount } : undefined;
      if (until(row)) return;
      await flushMicrotasks();
    }
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
    const seed = createSqliteMentalModelStore({ db });
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

    // The verdict carries the skill NAME. Threshold 1 so a single
    // success from proofCount=0 CROSSES the proof bar (0 + 1 >= 1) → candidate→active,
    // isolating the name→id resolution from a multi-call proof ladder.
    const { bus, store } = wireRealSkillSeam(
      db,
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["deploy-the-thing"] }),
      { promoteAt: 1 },
    );
    // Deterministically wait for the REAL row to flip (the loop is fire-and-forget +
    // awaits a SQLite write — a fixed flush count is fragile under coverage).
    await driveGraphThenAwait(bus, store, "deploy-the-thing", scope, (s) => s?.state === "active");

    // The REAL row transitioned: a name-as-id promote would leave it candidate at proof 0.
    const after = await store.get("deploy-the-thing", scope);
    expect(after.ok).toBe(true);
    expect(after.ok ? after.value?.state : undefined).toBe("active"); // a name-as-id promote would leave it candidate
    // proof_count actually incremented → the row was FOUND by name→id (not a 0-row no-op).
    expect(after.ok ? after.value?.proofCount : undefined).toBe(1);
  });

  it("a SUCCESS verdict below the proof bar bumps proof_count but the REAL row stays candidate (name→id found the row; proof gate holds)", async () => {
    // A second positive case that proves name→id resolution found the row WITHOUT
    // crossing the threshold: admit at proofCount 0, threshold 3 → one success bumps
    // proof_count to 1 (the row WAS found + reinforced) but 0+1 >= 3 is false → still
    // candidate. This isolates "the row was located by name" from "it was activated".
    const scope = { tenantId: SKILL_TENANT, agentId: SKILL_AGENT };
    const seed = createSqliteMentalModelStore({ db });
    await seed.admit(
      { name: "below-bar", description: "d", body: "b", mutating: false, proofCount: 0, confidence: 0.8, sourceTrajIds: ["t"], createdAt: NOW },
      scope,
    );
    const { bus, store } = wireRealSkillSeam(
      db,
      baseVerdict({ outcome: "success", sources: ["pipeline"], usedSkillIds: ["below-bar"] }),
      { promoteAt: 3 },
    );
    // Wait until the proof_count actually bumps (the observable proof the row was found).
    await driveGraphThenAwait(bus, store, "below-bar", scope, (s) => (s?.proofCount ?? 0) >= 1);

    const after = await store.get("below-bar", scope);
    expect(after.ok ? after.value?.proofCount : undefined).toBe(1); // reinforced (found by name→id)
    expect(after.ok ? after.value?.state : undefined).toBe("candidate"); // but proof bar (3) not crossed
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
    // Deterministically wait for the resolve chain to FINISH (learning:outcome_observed
    // is emitted at the end of the resolve .then), so a missing learning:skill_promoted
    // is a true negative — not a "not yet". Then drain the parallel fire-and-forget skill
    // loop so its (absent) emit would have landed.
    const emitted = (name: string): boolean => emitSpy.mock.calls.some((c) => c[0] === name);
    for (let i = 0; i < 50 && !emitted("learning:outcome_observed"); i++) await flushMicrotasks();
    await flushMicrotasks();

    expect(emitted("learning:outcome_observed"), "the resolve must have completed").toBe(true);
    // A 0-row promoteByName must NOT emit a non-zero count.
    expect(emitted("learning:skill_promoted"), "an unmatched name must not emit learning:skill_promoted").toBe(false);
  });
});

// ── the LLM outcome-judge fallback for a CONVERSATIONAL turn ──
//
// A conversational turn (no tool/pipeline signal) resolves to `unknown` and would
// otherwise derive NO learning. When the judge is enabled (default-on, opt-out) the
// daemon runs ONE cheap-model pass over the turn transcript, observes a `source:"judge"`
// row (reward CODE-capped ≤ 0.7), RE-RESOLVES, and uses the upgraded verdict for the
// consume chain. The deterministic tool/pipeline tier ALWAYS out-ranks the judge at
// fusion, so the judge runs ONLY on `unknown` (resolved turns skip it — bounds cost).
describe("wireLearningOutcome — LLM outcome-judge fallback on an unknown conversational turn", () => {
  function diagnosticPayload(
    over?: Partial<EventMap["diagnostic:message_processed"]>,
  ): EventMap["diagnostic:message_processed"] {
    return {
      messageId: "msg-1",
      channelId: "chan-1",
      channelType: "telegram",
      agentId: AGENT,
      sessionKey: SESSION_KEY,
      traceId: TRACE,
      receivedAt: NOW,
      executionDurationMs: 10,
      deliveryDurationMs: 0,
      totalDurationMs: 10,
      tokensUsed: 5,
      cost: 0,
      success: true,
      finishReason: "stop",
      timestamp: NOW,
      ...over,
    };
  }

  /**
   * A two-phase OutcomeSignalPort stub: resolve() returns the DETERMINISTIC verdict until
   * a `source:"judge"` row is observed, then returns the UPGRADED verdict (mirrors the
   * real adapter, where resolve() is a pure re-fusion that now sees the judge row).
   */
  function makeUpgradingStore(deterministic: ResolvedOutcome, upgraded: ResolvedOutcome) {
    let judgeObserved = false;
    const observe = vi.fn(async (obs: OutcomeObservation): Promise<Result<void, Error>> => {
      if (obs.source === "judge") judgeObserved = true;
      return ok(undefined);
    });
    const resolve = vi.fn(
      async (): Promise<Result<ResolvedOutcome, Error>> => ok(judgeObserved ? upgraded : deterministic),
    );
    const prune = vi.fn(() => ({ changes: 0 }));
    return { store: { observe, resolve, prune }, observe, resolve };
  }

  it("an UNKNOWN conversational turn + a judge `success` → observes a source:'judge' row (capped) and the consumed verdict becomes success", async () => {
    const bus = new TypedEventBus();
    const { store, observe, resolve } = makeUpgradingStore(
      baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }),
      baseVerdict({ outcome: "success", confidence: 0.7, sources: ["judge"], recalledIds: ["m1"] }),
    );
    const us = mockUsefulnessStore();
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    const readTurnTranscript = vi.fn(() => "user: please summarize\nassistant: here is the summary");
    const emitSpy = vi.spyOn(bus, "emit");
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
      outcomeJudge,
      learningOutcomeJudgeEnabled: () => true,
      readTurnTranscript,
    });

    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    // The judge ran over the transcript and a source:"judge" row was observed (capped reward).
    expect(readTurnTranscript).toHaveBeenCalledTimes(1);
    expect(outcomeJudge).toHaveBeenCalledTimes(1);
    expect(outcomeJudge.mock.calls[0]![0]).toContain("summarize");
    const judgeObs = observe.mock.calls.map((c) => c[0]).find((o) => o.source === "judge");
    expect(judgeObs, "a source:'judge' observation must be written").toBeDefined();
    expect(judgeObs!.outcome).toBe("success");
    expect(judgeObs!.confidence).toBe(0.7); // the CODE-capped reward, never the raw self-report
    expect(judgeObs!.trajectoryId).toBe(TRACE);
    expect(judgeObs!.agentId).toBe(AGENT);

    // resolve() ran TWICE — the initial unknown resolve, then the re-resolve after the judge row.
    expect(resolve).toHaveBeenCalledTimes(2);

    // The CONSUMED verdict is the upgraded `success` → the reward for the recalled id fired.
    expect(us.recordUsage).toHaveBeenCalledTimes(1);
    expect(us.recordUsage.mock.calls[0]![0]).toEqual(["m1"]);

    // The emitted learning:outcome_observed reflects the upgraded verdict.
    const emitted = emitSpy.mock.calls.find((c) => c[0] === "learning:outcome_observed");
    expect(emitted).toBeDefined();
    expect((emitted![1] as EventMap["learning:outcome_observed"]).outcome).toBe("success");
  });

  it("byte-identity: learningOutcomeJudgeEnabled => false → NO judge call, verdict stays unknown, no judge row", async () => {
    const bus = new TypedEventBus();
    const { store, observe, resolve } = makeUpgradingStore(
      baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }),
      baseVerdict({ outcome: "success", confidence: 0.7, sources: ["judge"] }),
    );
    const us = mockUsefulnessStore();
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    const readTurnTranscript = vi.fn(() => "user: hi\nassistant: hello");
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
      outcomeJudge,
      learningOutcomeJudgeEnabled: () => false, // judge OFF for this agent
      readTurnTranscript,
    });

    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(readTurnTranscript).not.toHaveBeenCalled();
    expect(observe.mock.calls.some((c) => c[0].source === "judge")).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(1); // only the initial resolve — no re-resolve
    expect(us.recordUsage).not.toHaveBeenCalled(); // verdict stayed unknown → no reward
  });

  it("byte-identity: outcomeJudge absent (pre-judge caller) → an unknown turn stays unknown", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeUpgradingStore(
      baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }),
      baseVerdict({ outcome: "success", confidence: 0.7, sources: ["judge"] }),
    );
    const us = mockUsefulnessStore();
    // NO outcomeJudge / learningOutcomeJudgeEnabled / readTurnTranscript deps.
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: us.store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
    });

    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    expect(resolve).toHaveBeenCalledTimes(1); // no re-resolve
    expect(us.recordUsage).not.toHaveBeenCalled();
  });

  it("a DETERMINISTIC success verdict does NOT call the judge (only unknown triggers it — bounds cost)", async () => {
    const bus = new TypedEventBus();
    // resolve already yields a deterministic success — the judge must never run.
    const { store } = makeStubStore(baseVerdict({ outcome: "success", sources: ["tool"], recalledIds: ["m1"] }));
    const outcomeJudge = vi.fn(async () => ({ outcome: "failure" as const, cappedConfidence: 0.7 }));
    const readTurnTranscript = vi.fn(() => "user: do x\nassistant: done");
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
      outcomeJudge,
      learningOutcomeJudgeEnabled: () => true,
      readTurnTranscript,
    });

    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(readTurnTranscript).not.toHaveBeenCalled();
  });

  it("is non-fatal: a judge that THROWS keeps the unknown verdict and does not throw out of the handler", async () => {
    const bus = new TypedEventBus();
    const { store, observe, resolve } = makeUpgradingStore(
      baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }),
      baseVerdict({ outcome: "success", confidence: 0.7, sources: ["judge"] }),
    );
    const logger = createMockLogger();
    const outcomeJudge = vi.fn(async () => {
      throw new Error("model resolution failed");
    });
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => true,
      learningForgettingEnabled: () => true,
      clock: createFakeClock(NOW),
      logger,
      learningOutcomeEnabled: () => true,
      outcomeJudge,
      learningOutcomeJudgeEnabled: () => true,
      readTurnTranscript: () => "user: x\nassistant: y",
    });

    expect(() => bus.emit("diagnostic:message_processed", diagnosticPayload())).not.toThrow();
    await flushMicrotasks();

    expect(outcomeJudge).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls.some((c) => c[0].source === "judge")).toBe(false); // no row written
    expect(resolve).toHaveBeenCalledTimes(1); // no re-resolve
    const warn = logger.warn.mock.calls.find(
      (c) =>
        typeof (c[0] as { hint?: string }).hint === "string" &&
        (c[0] as { errorKind?: string }).errorKind !== undefined,
    );
    expect(warn, "a judge throw must WARN with hint+errorKind").toBeDefined();
  });

  it("an empty transcript → the judge never runs (no content to score), verdict stays unknown", async () => {
    const bus = new TypedEventBus();
    const { store, resolve } = makeUpgradingStore(
      baseVerdict({ outcome: "unknown", confidence: 0, sources: [] }),
      baseVerdict({ outcome: "success", confidence: 0.7, sources: ["judge"] }),
    );
    const outcomeJudge = vi.fn(async () => ({ outcome: "success" as const, cappedConfidence: 0.7 }));
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
      outcomeJudge,
      learningOutcomeJudgeEnabled: () => true,
      readTurnTranscript: () => "", // empty transcript
    });

    bus.emit("diagnostic:message_processed", diagnosticPayload());
    await flushMicrotasks();

    expect(outcomeJudge).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

/** Flush enough microtask turns to settle the observe→resolve→emit chain. The skill
 *  promote/demote loop (applySkillOutcomeTransitions) AWAITS each name-keyed store
 *  transition to read rows-changed, so a multi-skill verdict adds several extra
 *  microtask hops before the emit/log — flush generously so the settle is deterministic. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("wireLearningOutcome — surface refresh on doc ADMISSION", () => {
  // A reflection run that admits a candidate must refresh the per-agent surface NOW.
  // Otherwise the candidate stays invisible until the next boot, and promotion is
  // USE-gated (needs it surfaced first) — a second-order deadlock the post-promote
  // refresh can never break. `reflect:admitted.count` IS the admitted count.
  function wire(refresh: (agentId: string) => void): TypedEventBus {
    const bus = new TypedEventBus();
    const { store } = makeStubStore();
    wireLearningOutcome({
      eventBus: bus,
      outcomeStore: store,
      usefulnessStore: mockUsefulnessStore().store,
      learnedSkillStore: mockLearnedSkillStore().store,
      learningTuningEnabled: () => false,
      learningForgettingEnabled: () => false,
      learningSkillsEnabled: () => true,
      learningSkillsPromoteAt: () => 3,
      clock: createFakeClock(NOW),
      logger: createMockLogger(),
      learningOutcomeEnabled: () => true,
      refreshLearnedSkillSurface: refresh,
    });
    return bus;
  }

  it("refreshes the per-agent surface when a reflection run ADMITTED >=1 doc", () => {
    const refresh = vi.fn();
    wire(refresh).emit("reflect:admitted", { agentId: "agent-9", count: 1, timestamp: NOW });
    expect(refresh).toHaveBeenCalledWith("agent-9");
  });

  it("does NOT refresh when a reflection run admitted 0 docs (nothing new to surface)", () => {
    const refresh = vi.fn();
    wire(refresh).emit("reflect:admitted", { agentId: "agent-9", count: 0, timestamp: NOW });
    expect(refresh).not.toHaveBeenCalled();
  });
});

// Correction-driven demote: a user CORRECTION of a prior verdict must DEMOTE the learned skill that
// produced it. The correction reader emits `learning:correction_observed` for the PRIOR trajectory;
// wireLearningOutcome re-resolves it and runs the GATED skill-transition with a `corrected` verdict
// (the resolve seam already dedup-consumed the trajectory, so this is the ONLY path that can demote
// it). Reuses the SAME corroboration tally + decay-aware trend (anti-flap).
describe("wireLearningOutcome — learning:correction_observed → demote the corrected skill", () => {
  function wireCorrection(over?: {
    resolveValue?: ResolvedOutcome;
    learnedSkillStore?: MentalModelStorePort;
    learningSkillsEnabled?: (id: string) => boolean;
  }) {
    const bus = new TypedEventBus();
    const { store, resolve } = makeStubStore(over?.resolveValue ?? baseVerdict({ usedSkillIds: ["skill-ttp"] }));
    const skills = mockLearnedSkillStore();
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
      learnedSkillStore: over?.learnedSkillStore ?? skills.store,
      learningSkillsEnabled: over?.learningSkillsEnabled ?? (() => true),
      learningSkillsPromoteAt: () => 3,
    });
    const corr = (sessionId: string) =>
      bus.emit("learning:correction_observed", {
        agentId: AGENT,
        tenantId: "tenant-x",
        sessionId,
        trajectoryId: TRACE,
        confidence: 0.6,
        timestamp: NOW,
      });
    return { bus, resolve, demoteByName: skills.demoteByName, corr, logger };
  }

  it("resolves the PRIOR trajectory to recover its credited skills (the listener runs)", async () => {
    const { resolve, corr } = wireCorrection();
    corr("sess-A");
    await flushMicrotasks();
    expect(resolve).toHaveBeenCalledWith(TRACE, { tenantId: "tenant-x", agentId: AGENT });
  });

  it("SUSTAINED corroborated corrections DEMOTE the skill, but ≤1 corroborated does NOT (anti-flap belt)", async () => {
    const { corr, demoteByName } = wireCorrection();
    // corr 1 (sess-A): 1 session — corroboration not yet met → no trend fold, no demote.
    corr("sess-A");
    await flushMicrotasks();
    // corr 2 (sess-B): 2nd distinct session → corroborated, 1st failure folds → trend still "stable".
    corr("sess-B");
    await flushMicrotasks();
    expect(demoteByName, "a single corroborated correction must NOT stale a well-reused skill (anti-induced-demotion)").not.toHaveBeenCalled();
    // corr 3 (sess-C): sustained corroborated failure → trend reaches "weakening" → DEMOTE (active/candidate→stale).
    corr("sess-C");
    await flushMicrotasks();
    expect(demoteByName).toHaveBeenCalled();
    expect(demoteByName.mock.calls[0]![0]).toBe("skill-ttp");
  });

  it("byte-identity: learningSkillsEnabled=false → never resolves / never demotes", async () => {
    const { resolve, demoteByName, corr } = wireCorrection({ learningSkillsEnabled: () => false });
    corr("sess-A");
    corr("sess-B");
    corr("sess-C");
    await flushMicrotasks();
    expect(resolve).not.toHaveBeenCalled();
    expect(demoteByName).not.toHaveBeenCalled();
  });

  it("no credited skill on the corrected turn → nothing to demote (fail-closed)", async () => {
    const { demoteByName, corr } = wireCorrection({ resolveValue: baseVerdict({ usedSkillIds: [] }) });
    corr("sess-A");
    corr("sess-B");
    corr("sess-C");
    await flushMicrotasks();
    expect(demoteByName).not.toHaveBeenCalled();
  });

  // The correction→demote re-resolve path is otherwise SILENT until the 3rd corroborated correction
  // actually demotes — so a single real correction can't be confirmed live. One INFO line per
  // correction that credited ≥1 skill (counts/ids only) makes the path greppable in one look: "did
  // the correction listener re-resolve + feed the gate?".
  it("emits a counts-only INFO line when a correction credits ≥1 skill (the path is observable)", async () => {
    const { corr, logger } = wireCorrection();
    corr("sess-A");
    await flushMicrotasks();
    const infoCalls = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const driftLine = infoCalls.find((c) => (c[0] as { step?: string })?.step === "correction-demote-reresolve");
    expect(driftLine, "a credited correction must log the re-resolve at INFO").toBeDefined();
    const fields = driftLine![0] as { creditedSkillCount?: number; trajectoryId?: string; agentId?: string };
    expect(fields.creditedSkillCount).toBe(1);
    expect(fields.trajectoryId).toBe(TRACE);
    expect(fields.agentId).toBe(AGENT);
    // Counts/ids only — never a procedure body or the skill content (the §2.7 logging firewall).
    expect(JSON.stringify(driftLine)).not.toContain("skill-ttp"); // the id is not logged as content; count is
  });

  it("does NOT log the re-resolve line when no skill was credited (no noise on non-skill corrections)", async () => {
    const { corr, logger } = wireCorrection({ resolveValue: baseVerdict({ usedSkillIds: [] }) });
    corr("sess-A");
    await flushMicrotasks();
    const infoCalls = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const driftLine = infoCalls.find((c) => (c[0] as { step?: string })?.step === "correction-demote-reresolve");
    expect(driftLine).toBeUndefined();
  });
});
