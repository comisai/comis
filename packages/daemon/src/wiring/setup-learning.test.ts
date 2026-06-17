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
import { ok, err, type Result } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { wireLearningOutcome } from "./setup-learning.js";

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

/** Flush enough microtask turns to settle the observe→resolve→emit chain. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
