// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the reaction + correction outcome wiring (Verified Learning WS1,
 * Phase 199, REACT-02/03/04 + CORRECT-01) co-located in setup-learning-reactions.ts.
 *
 * Three units under test:
 *  1. createReactionTrajectoryMap — the bounded in-memory `messageId -> trajectory
 *     scope` map (TTL + maxEntries) captured ONLY at the agent-authored outbound
 *     ack. Look-up of an unknown messageId is undefined (fail-closed input).
 *  2. wireLearningReactions — `channel:reaction_received` -> map lookup -> reactionMap
 *     -> trust-scaled confidence -> per-sender rate-limit -> observe source:"reaction".
 *     A reaction on a user message (unmapped messageId) records NOTHING (REACT-02
 *     keystone). An external reactor yields near-zero confidence (REACT-03/04).
 *  3. wireLearningCorrection — `graph:completed` (ALS sessionKey) records the prior
 *     trajectory; a follow-up `message:received` with the SAME sessionKey + a
 *     correction text -> detector -> observe source:"correction" against that prior
 *     trajectory (the WARNING-2 end-to-end join). A graph:completed with NO ALS
 *     sessionKey records nothing -> a later correction fails-closed (no mis-join).
 */

import { describe, it, expect, vi } from "vitest";
import { TypedEventBus, runWithContext, formatSessionKey } from "@comis/core";
import type {
  EventMap,
  OutcomeObservation,
  ResolvedOutcome,
  LearningScope,
  SessionKey,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import {
  createReactionTrajectoryMap,
  wireLearningReactions,
  wireLearningCorrection,
  buildReactionWiringDeps,
  type LearningReactionsWiringDeps,
} from "./setup-learning-reactions.js";
import type { CorrectionVerdict } from "@comis/agent";

const NOW = 1_700_000_000_000;
const TENANT = "tenant-x";
const AGENT = "agent-1";
const TRACE = "trace-react-001";

/** A controllable OutcomeSignalPort stub capturing observe() calls. */
function makeStubStore() {
  const observe = vi.fn(async (_obs: OutcomeObservation): Promise<Result<void, Error>> => ok(undefined));
  const resolve = vi.fn(
    async (_id: string, _scope: LearningScope): Promise<Result<ResolvedOutcome, Error>> =>
      ok({ outcome: "unknown", confidence: 0, sources: [], recalledIds: [], usedSkillIds: [] }),
  );
  const prune = vi.fn(() => ({ changes: 0 }));
  return { store: { observe, resolve, prune }, observe };
}

/** A fake per-sender rate limiter that never trips unless configured to. */
function makeFakeRateLimiter(level: "none" | "warn" | "audit" = "none") {
  return {
    record: vi.fn(() => ({ thresholdCrossed: false, count: 1, level })),
    getCount: vi.fn(() => 0),
    destroy: vi.fn(),
  };
}

/** Default reaction/correction wiring deps; override per test. */
function makeDeps(over: Partial<LearningReactionsWiringDeps> = {}): {
  deps: LearningReactionsWiringDeps;
  observe: ReturnType<typeof makeStubStore>["observe"];
} {
  const { store, observe } = makeStubStore();
  const clock = createFakeClock(NOW);
  const timers = createFakeTimers(NOW);
  const reactionTrajectoryMap = over.reactionTrajectoryMap ?? createReactionTrajectoryMap({ clock, timers });
  const deps: LearningReactionsWiringDeps = {
    eventBus: over.eventBus ?? new TypedEventBus(),
    outcomeStore: over.outcomeStore ?? store,
    clock,
    logger: createMockLogger(),
    learningOutcomeEnabled: over.learningOutcomeEnabled ?? ((): boolean => true),
    reactionTrajectoryMap,
    reactionRateLimiter: over.reactionRateLimiter ?? makeFakeRateLimiter(),
    reactionMap: over.reactionMap ?? { success: ["👍", "✅"], failure: ["👎", "❌"] },
    resolveSenderTrust: over.resolveSenderTrust ?? ((): string => "admin"),
    correctionDetector: over.correctionDetector,
    correctionEnabled: over.correctionEnabled ?? ((): boolean => true),
    recordSessionTrajectory: over.recordSessionTrajectory,
    lastTrajectoryForSession: over.lastTrajectoryForSession,
    ...over,
  };
  return { deps, observe };
}

function reactionPayload(
  over?: Partial<EventMap["channel:reaction_received"]>,
): EventMap["channel:reaction_received"] {
  return {
    messageId: "msg-out-1",
    reactorId: "user-9",
    emoji: "👍",
    channelType: "telegram",
    channelId: "chat-1",
    timestamp: NOW,
    ...over,
  };
}

function sessionKey(over?: Partial<SessionKey>): SessionKey {
  return { tenantId: TENANT, userId: "user-9", channelId: "chat-1", ...over };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ===========================================================================
// 1. createReactionTrajectoryMap — bounded TTL map
// ===========================================================================

describe("createReactionTrajectoryMap — bounded outbound trajectory map", () => {
  it("records and looks up an outbound trajectory scope by messageId", () => {
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: TRACE });
    expect(map.lookup("msg-1")).toEqual({ traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: TRACE });
  });

  it("returns undefined for an unknown messageId (fail-closed input)", () => {
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    expect(map.lookup("never-recorded")).toBeUndefined();
  });

  it("evicts the OLDEST entry past maxEntries (bounded, no unbounded growth)", () => {
    const map = createReactionTrajectoryMap(
      { clock: createFakeClock(NOW), timers: createFakeTimers(NOW) },
      { maxEntries: 2 },
    );
    map.record("a", { traceId: "ta", tenantId: TENANT, agentId: AGENT, sessionId: "ta" });
    map.record("b", { traceId: "tb", tenantId: TENANT, agentId: AGENT, sessionId: "tb" });
    map.record("c", { traceId: "tc", tenantId: TENANT, agentId: AGENT, sessionId: "tc" }); // over cap → evict "a"
    expect(map.lookup("a")).toBeUndefined();
    expect(map.lookup("b")).toBeDefined();
    expect(map.lookup("c")).toBeDefined();
  });

  it("a TTL timer deletes an entry after entryTtlMs (timer is unref'd, no process pin)", () => {
    const timers = createFakeTimers(NOW);
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers }, { entryTtlMs: 1_000 });
    map.record("ttl-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: TRACE });
    expect(map.lookup("ttl-1")).toBeDefined();
    // Every scheduled timer must be unref'd so it never pins the daemon process.
    expect(timers.unrefRecord().every((e) => e.unrefCalled)).toBe(true);
    timers.advance(1_001); // fire the TTL deletion
    expect(map.lookup("ttl-1")).toBeUndefined();
  });

  it("destroy() cancels all timers and clears the map", () => {
    const timers = createFakeTimers(NOW);
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers });
    map.record("x", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: TRACE });
    map.destroy();
    expect(map.lookup("x")).toBeUndefined();
  });
});

// ===========================================================================
// 2. wireLearningReactions — channel:reaction_received → observe source:"reaction"
// ===========================================================================

describe("wireLearningReactions — reaction → trust-scaled observe (REACT-02/03/04)", () => {
  it("REACT-02 keystone: a reaction on a USER message (unmapped messageId) records NOTHING (fail-closed)", async () => {
    const bus = new TypedEventBus();
    const { deps, observe } = makeDeps({ eventBus: bus });
    wireLearningReactions(deps);

    // No map entry for this messageId (a user message Comis never sent) → SKIP.
    bus.emit("channel:reaction_received", reactionPayload({ messageId: "user-authored-msg" }));
    await flush();

    expect(observe).not.toHaveBeenCalled();
  });

  it("a 👍 on a mapped messageId from an ADMIN reactor observes a high-confidence success against the right trajectory", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      resolveSenderTrust: () => "admin",
    });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload({ emoji: "👍", reactorId: "boss" }));
    await flush();

    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.outcome).toBe("success");
    expect(obs.source).toBe("reaction");
    expect(obs.trajectoryId).toBe(TRACE);
    expect(obs.tenantId).toBe(TENANT);
    expect(obs.agentId).toBe(AGENT);
    expect(obs.senderTrust).toBe("admin");
    expect(obs.confidence).toBeGreaterThan(0.3); // admin → strong weight
    expect(obs.observedAt).toBe(NOW);
  });

  it("a 👎/❌ maps to a 'failure' outcome", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({ eventBus: bus, reactionTrajectoryMap: map });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload({ emoji: "❌" }));
    await flush();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].outcome).toBe("failure");
  });

  it("REACT-03/04: an EXTERNAL reactor observes a near-zero confidence", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      resolveSenderTrust: () => "external",
    });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload({ emoji: "👍", reactorId: "stranger" }));
    await flush();

    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.senderTrust).toBe("external");
    expect(obs.confidence).toBeLessThan(0.1); // near-zero for an external reactor (spoof-resistant)
  });

  it("an UNMAPPED emoji (not in reactionMap) records NOTHING (skip)", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({ eventBus: bus, reactionTrajectoryMap: map });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload({ emoji: "🤷" }));
    await flush();

    expect(observe).not.toHaveBeenCalled();
  });

  it("a Slack SHORT-NAME emoji (thumbsup) maps to success without forcing operators to add short names", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({ eventBus: bus, reactionTrajectoryMap: map });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload({ emoji: "thumbsup" }));
    await flush();

    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].outcome).toBe("success");
  });

  it("byte-identity: learningOutcomeEnabled=false → ZERO observe even on a mapped reaction", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      learningOutcomeEnabled: () => false,
    });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload());
    await flush();

    expect(observe).not.toHaveBeenCalled();
  });

  it("REACT-03 anti-flood: past the per-sender audit rate limit the reaction is SKIPPED", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      reactionRateLimiter: makeFakeRateLimiter("audit"),
    });
    wireLearningReactions(deps);

    bus.emit("channel:reaction_received", reactionPayload());
    await flush();

    expect(observe).not.toHaveBeenCalled();
  });

  it("is non-fatal: an observe that REJECTS does not throw out of the bus handler", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const observe = vi.fn(async (): Promise<Result<void, Error>> => {
      throw new Error("db locked");
    });
    const { deps } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      outcomeStore: { observe, resolve: vi.fn(), prune: vi.fn() } as never,
    });
    wireLearningReactions(deps);

    expect(() => bus.emit("channel:reaction_received", reactionPayload())).not.toThrow();
    await flush();
    expect(observe).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3. wireLearningCorrection — message:received → observe source:"correction"
// ===========================================================================

describe("wireLearningCorrection — correction → prior-trajectory observe (CORRECT-01, WARNING-2 join)", () => {
  /** A shared bounded session→trajectory map so the writer + reader use one instance. */
  function makeSessionMap() {
    const inner = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    return {
      recordSessionTrajectory: (sk: string, scope: { traceId: string; tenantId: string; agentId: string; sessionId: string }): void =>
        inner.record(sk, scope),
      lastTrajectoryForSession: (sk: string) => inner.lookup(sk),
    };
  }

  /** Seed a prior trajectory under a session key with the default scope. */
  function seedPrior(map: ReturnType<typeof makeSessionMap>, sk: string, traceId = TRACE): void {
    map.recordSessionTrajectory(sk, { traceId, tenantId: TENANT, agentId: AGENT, sessionId: sk });
  }

  it("first-GREEN end-to-end join: graph:completed(ALS sessionKey) → message:received(same key) observes a 'corrected' outcome against the prior trajectory", async () => {
    const bus = new TypedEventBus();
    const sk = sessionKey();
    const skStr = formatSessionKey(sk);
    const sessionMap = makeSessionMap();
    const detector = vi.fn(
      async (_turn: string): Promise<CorrectionVerdict> => ({
        isCorrection: true,
        confidence: 0.9,
        cappedConfidence: 0.6,
        outcome: "corrected",
        source: "correction",
      }),
    );
    const { deps, observe } = makeDeps({
      eventBus: bus,
      correctionDetector: detector,
      ...sessionMap,
    });
    wireLearningCorrection(deps);

    // WRITER: a graph completes INSIDE the ALS scope (sessionKey = formatSessionKey(...)).
    runWithContext(
      { tenantId: TENANT, agentId: AGENT, sessionKey: skStr, traceId: TRACE } as never,
      () => bus.emit("graph:completed", { graphId: "g-1", status: "completed", durationMs: 10, nodeCount: 1, nodesCompleted: 1, nodesFailed: 0, nodesSkipped: 0, timestamp: NOW } as never),
    );
    await flush();

    // READER: a follow-up correction turn for the SAME session.
    bus.emit("message:received", {
      message: { id: "m2", channelId: "chat-1", channelType: "telegram", senderId: "user-9", text: "no, do X instead", timestamp: NOW, metadata: {} } as never,
      sessionKey: sk,
    });
    await flush();

    expect(detector).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.outcome).toBe("corrected");
    expect(obs.source).toBe("correction");
    expect(obs.trajectoryId).toBe(TRACE); // the prior trajectory recorded under the SAME sessionKey
    expect(obs.confidence).toBe(0.6); // the capped reward
  });

  it("detector returns isCorrection:false → NO observe", async () => {
    const bus = new TypedEventBus();
    const sk = sessionKey();
    const sessionMap = makeSessionMap();
    seedPrior(sessionMap, formatSessionKey(sk));
    const detector = vi.fn(
      async (): Promise<CorrectionVerdict> => ({ isCorrection: false, confidence: 0.1, cappedConfidence: 0.1, outcome: "corrected", source: "correction" }),
    );
    const { deps, observe } = makeDeps({ eventBus: bus, correctionDetector: detector, ...sessionMap });
    wireLearningCorrection(deps);

    bus.emit("message:received", {
      message: { id: "m2", channelId: "chat-1", channelType: "telegram", senderId: "user-9", text: "thanks!", timestamp: NOW, metadata: {} } as never,
      sessionKey: sk,
    });
    await flush();

    expect(detector).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
  });

  it("no prior trajectory for the session (message:received whose sessionKey was never recorded) → NO observe (fail-closed)", async () => {
    const bus = new TypedEventBus();
    const sessionMap = makeSessionMap(); // nothing recorded
    const detector = vi.fn(async (): Promise<CorrectionVerdict> => ({ isCorrection: true, confidence: 0.9, cappedConfidence: 0.6, outcome: "corrected", source: "correction" }));
    const { deps, observe } = makeDeps({ eventBus: bus, correctionDetector: detector, ...sessionMap });
    wireLearningCorrection(deps);

    bus.emit("message:received", {
      message: { id: "m2", channelId: "chat-1", channelType: "telegram", senderId: "user-9", text: "no, do X", timestamp: NOW, metadata: {} } as never,
      sessionKey: sessionKey(),
    });
    await flush();

    // No prior trajectory → the detector is never even consulted; nothing observed.
    expect(observe).not.toHaveBeenCalled();
    expect(detector).not.toHaveBeenCalled();
  });

  it("WARNING-2 negative: a graph:completed with NO ALS sessionKey records nothing → a later correction observes NOTHING (no mis-join to the trajectory-id fallback)", async () => {
    const bus = new TypedEventBus();
    const recordSpy = vi.fn();
    const sessionMap = makeSessionMap();
    const detector = vi.fn(async (): Promise<CorrectionVerdict> => ({ isCorrection: true, confidence: 0.9, cappedConfidence: 0.6, outcome: "corrected", source: "correction" }));
    const { deps, observe } = makeDeps({
      eventBus: bus,
      correctionDetector: detector,
      recordSessionTrajectory: (sk, t) => {
        recordSpy(sk, t);
        sessionMap.recordSessionTrajectory(sk, t);
      },
      lastTrajectoryForSession: sessionMap.lastTrajectoryForSession,
    });
    wireLearningCorrection(deps);

    // graph completes with agentId/traceId in ALS but NO sessionKey → record NOTHING.
    runWithContext(
      { tenantId: TENANT, agentId: AGENT, traceId: TRACE } as never,
      () => bus.emit("graph:completed", { graphId: "g-1", status: "completed", durationMs: 10, nodeCount: 1, nodesCompleted: 1, nodesFailed: 0, nodesSkipped: 0, timestamp: NOW } as never),
    );
    await flush();

    expect(recordSpy).not.toHaveBeenCalled(); // the writer skipped (no sessionKey to key on)

    // A later correction for that session → no prior trajectory → fail-closed.
    bus.emit("message:received", {
      message: { id: "m2", channelId: "chat-1", channelType: "telegram", senderId: "user-9", text: "no, undo that", timestamp: NOW, metadata: {} } as never,
      sessionKey: sessionKey(),
    });
    await flush();

    expect(observe).not.toHaveBeenCalled();
  });

  it("byte-identity: correctionEnabled=false → ZERO detector calls", async () => {
    const bus = new TypedEventBus();
    const sk = sessionKey();
    const sessionMap = makeSessionMap();
    seedPrior(sessionMap, formatSessionKey(sk));
    const detector = vi.fn(async (): Promise<CorrectionVerdict> => ({ isCorrection: true, confidence: 0.9, cappedConfidence: 0.6, outcome: "corrected", source: "correction" }));
    const { deps, observe } = makeDeps({
      eventBus: bus,
      correctionDetector: detector,
      correctionEnabled: () => false,
      ...sessionMap,
    });
    wireLearningCorrection(deps);

    bus.emit("message:received", {
      message: { id: "m2", channelId: "chat-1", channelType: "telegram", senderId: "user-9", text: "no, do X", timestamp: NOW, metadata: {} } as never,
      sessionKey: sk,
    });
    await flush();

    expect(detector).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("a detector that returns undefined (non-fatal) → NO observe, no throw", async () => {
    const bus = new TypedEventBus();
    const sk = sessionKey();
    const sessionMap = makeSessionMap();
    seedPrior(sessionMap, formatSessionKey(sk));
    const detector = vi.fn(async (): Promise<CorrectionVerdict | undefined> => undefined);
    const { deps, observe } = makeDeps({ eventBus: bus, correctionDetector: detector, ...sessionMap });
    wireLearningCorrection(deps);

    expect(() =>
      bus.emit("message:received", {
        message: { id: "m2", channelId: "chat-1", channelType: "telegram", senderId: "user-9", text: "no, do X", timestamp: NOW, metadata: {} } as never,
        sessionKey: sk,
      }),
    ).not.toThrow();
    await flush();

    expect(detector).toHaveBeenCalledTimes(1);
    expect(observe).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. buildReactionWiringDeps — daemon composition (construct map/limiter/detector + gate)
// ===========================================================================

describe("buildReactionWiringDeps — daemon construction behind the byte-identity gate", () => {
  function makeContainer(over: { agents?: Record<string, unknown>; costFeatures?: boolean; secrets?: Record<string, string> } = {}) {
    const secrets = over.secrets ?? {};
    return {
      config: {
        agents: over.agents ?? {},
        memory: { costFeatures: { enabled: over.costFeatures ?? true } },
        providers: { entries: {} },
      },
      secretManager: { get: (name: string): string | undefined => secrets[name] },
    } as never;
  }

  it("byte-identity: NO agent has learningOutcome.enabled → recordOutboundMessage is undefined (the drain does zero extra work)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: false } } } }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(built.recordOutboundMessage).toBeUndefined();
  });

  it("an agent with learningOutcome.enabled → recordOutboundMessage is a function that records into the trajectory map", () => {
    const built = buildReactionWiringDeps(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true } } } }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(typeof built.recordOutboundMessage).toBe("function");
    built.recordOutboundMessage!("msg-1", { traceId: TRACE, tenantId: TENANT, agentId: "a1", sessionId: TRACE });
    expect(built.deps.reactionTrajectoryMap.lookup("msg-1")).toEqual({ traceId: TRACE, tenantId: TENANT, agentId: "a1", sessionId: TRACE });
  });

  it("the learningOutcomeEnabled gate force-disables on the master cost switch (costFeatures.enabled=false)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true } } }, costFeatures: false }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(built.deps.learningOutcomeEnabled("a1")).toBe(false); // master switch off → gate closed
    expect(built.recordOutboundMessage).toBeUndefined(); // and the capture is off
  });

  it("resolveSenderTrust reads senderTrustMap[reactorId] ?? defaultTrustLevel (RAW channel-sender string, default external)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            elevatedReply: { senderTrustMap: { boss: "admin" }, defaultTrustLevel: "external" },
          },
        },
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(built.deps.resolveSenderTrust("a1", "boss")).toBe("admin"); // mapped
    expect(built.deps.resolveSenderTrust("a1", "stranger")).toBe("external"); // default
  });

  it("the correction detector is UNDEFINED when no agent has correction.enabled (no LLM construction)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true, correction: { enabled: false } } } } }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(built.deps.correctionDetector).toBeUndefined();
  });

  it("the correction detector is UNDEFINED when correction.enabled but the cheap-model API key is missing (Defer != Retry)", () => {
    // anthropic (non-keyless) with no ANTHROPIC_API_KEY in secrets → no key → undefined detector.
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, correction: { enabled: true } } } },
        secrets: {},
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(built.deps.correctionDetector).toBeUndefined();
  });

  it("the correction detector is BUILT when correction.enabled AND a cheap-model API key resolves", () => {
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: { a1: { provider: "anthropic", learningOutcome: { enabled: true, correction: { enabled: true } } } },
        secrets: { ANTHROPIC_API_KEY: "sk-test-key" },
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    expect(typeof built.deps.correctionDetector).toBe("function");
    expect(built.deps.correctionEnabled("a1")).toBe(true);
  });
});
