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
import { TypedEventBus, formatSessionKey } from "@comis/core";
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

  it("WR-05: re-recording an existing key REFRESHES its recency so eviction drops the genuinely-oldest key (LRU invariant the O(1) eviction must preserve)", () => {
    const clock = createFakeClock(NOW);
    const map = createReactionTrajectoryMap(
      { clock, timers: createFakeTimers(NOW) },
      { maxEntries: 2 },
    );
    map.record("a", { traceId: "ta", tenantId: TENANT, agentId: AGENT, sessionId: "ta" });
    clock.advance(10);
    map.record("b", { traceId: "tb", tenantId: TENANT, agentId: AGENT, sessionId: "tb" });
    clock.advance(10);
    // Re-record "a" (the session map does this every turn for a live session) —
    // "a" is now the MOST-recent, "b" the oldest.
    map.record("a", { traceId: "ta2", tenantId: TENANT, agentId: AGENT, sessionId: "ta2" });
    clock.advance(10);
    // Over cap → evict the genuine oldest, which is now "b", NOT the refreshed "a".
    map.record("c", { traceId: "tc", tenantId: TENANT, agentId: AGENT, sessionId: "tc" });
    expect(map.lookup("b")).toBeUndefined(); // genuine oldest evicted
    expect(map.lookup("a")?.traceId).toBe("ta2"); // refreshed key survived (and kept its new value)
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

  it("WR-03: an EXTERNAL reactor's near-zero confidence is BELOW the write floor → NO ledger row written (skip)", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      resolveSenderTrust: () => "external",
    });
    wireLearningReactions(deps);

    // external → 0.6 * 0.05 = 0.03, below the min-confidence-to-write floor. The
    // reaction is inert (deterministic outranks it anyway), so rather than amplify
    // the append-only ledger with near-zero rows from untrusted senders, it is
    // skipped entirely — no observe, no row.
    bus.emit("channel:reaction_received", reactionPayload({ emoji: "👍", reactorId: "stranger" }));
    await flush();

    expect(observe).not.toHaveBeenCalled();
  });

  it("WR-03: a KNOWN reactor's confidence is ABOVE the write floor → the reaction IS observed (the floor only drops near-zero external)", async () => {
    const bus = new TypedEventBus();
    const map = createReactionTrajectoryMap({ clock: createFakeClock(NOW), timers: createFakeTimers(NOW) });
    map.record("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: AGENT, sessionId: "sess-1" });
    const { deps, observe } = makeDeps({
      eventBus: bus,
      reactionTrajectoryMap: map,
      resolveSenderTrust: () => "known",
    });
    wireLearningReactions(deps);

    // known → 0.6 * 0.4 = 0.24, comfortably above the floor → persisted.
    bus.emit("channel:reaction_received", reactionPayload({ emoji: "👍", reactorId: "regular" }));
    await flush();

    expect(observe).toHaveBeenCalledTimes(1);
    const obs = observe.mock.calls[0]![0];
    expect(obs.senderTrust).toBe("known");
    expect(obs.confidence).toBeCloseTo(0.24, 5);
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

  /** A single-agent turn-completion payload carrying the (agent, session, trajectory) scope. */
  function diagnosticPayload(
    over?: Partial<EventMap["diagnostic:message_processed"]>,
  ): EventMap["diagnostic:message_processed"] {
    return {
      messageId: "m1",
      channelId: "chat-1",
      channelType: "telegram",
      agentId: AGENT,
      sessionKey: formatSessionKey(sessionKey()),
      traceId: TRACE,
      receivedAt: NOW,
      executionDurationMs: 5,
      deliveryDurationMs: 0,
      totalDurationMs: 5,
      tokensUsed: 100,
      cost: 0,
      success: true,
      finishReason: "end_turn",
      timestamp: NOW,
      ...over,
    };
  }

  it("CR-02 first-GREEN end-to-end join: a SINGLE-AGENT turn completes (diagnostic:message_processed) → message:received(same key) observes a 'corrected' outcome against the prior trajectory", async () => {
    const bus = new TypedEventBus();
    const sk = sessionKey();
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

    // WRITER: a SINGLE-AGENT turn completes. diagnostic:message_processed fires
    // for every turn (not just DAG runs) and carries agentId/sessionKey/traceId
    // on its PAYLOAD — no ALS dependency (the emit runs outside the executor's
    // runWithContext). On the OLD graph:completed/ALS wiring this records NOTHING
    // for a single-agent turn, so the correction below is a no-op (RED).
    bus.emit("diagnostic:message_processed", diagnosticPayload());
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
    expect(obs.tenantId).toBe(TENANT); // tenant derived from the sessionKey's first segment
    expect(obs.agentId).toBe(AGENT); // the trajectory's OWN agent (from the diagnostic payload)
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

  it("CR-02 fail-closed: a diagnostic:message_processed with an EMPTY traceId records nothing → a later correction observes NOTHING (no mis-join)", async () => {
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

    // A turn-completion event carrying agentId/sessionKey but an EMPTY traceId
    // (cannot reliably identify the trajectory) → record NOTHING (fail-closed).
    bus.emit("diagnostic:message_processed", diagnosticPayload({ traceId: "" }));
    await flush();

    expect(recordSpy).not.toHaveBeenCalled(); // the writer skipped (no trajectory id to key on)

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
    const { store } = makeStubStore();
    return {
      config: {
        agents: over.agents ?? {},
        memory: { costFeatures: { enabled: over.costFeatures ?? true } },
        providers: { entries: {} },
      },
      secretManager: { get: (name: string): string | undefined => secrets[name] },
      eventBus: new TypedEventBus(),
      outcomeStore: store,
      logger: createMockLogger(),
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

  // -------------------------------------------------------------------------
  // H-1 (Phase 226): the master-kill-switch rename `memory.costFeatures.enabled`
  // → `memory.enabled` MUST NOT silently invert the gate. This reader once
  // declared a LOOSE local type `memory?: { costFeatures?: { enabled?: boolean } }`
  // gating on `memory?.costFeatures?.enabled !== false`. After the schema collapse
  // deletes `costFeatures`, a config with ONLY `memory.enabled:false` (the NEW
  // shape) would read `undefined !== false === true` → FORCE-ENABLED (the
  // kill-switch inverts), invisible to tsc. This pins the CORRECT post-rename
  // behavior (force-DISABLE) — RED against the pre-rename loose reader. The fix
  // re-points the local slice to the real MemoryConfig type AND this is the belt.
  // -------------------------------------------------------------------------
  it("H-1: memory.enabled:false (the renamed master kill-switch) force-DISABLES the reaction/outcome wiring for every agent", () => {
    const { store } = makeStubStore();
    const built = buildReactionWiringDeps(
      // The NEW shape: memory.enabled is the master gate; NO costFeatures key exists.
      {
        config: {
          agents: { a1: { learningOutcome: { enabled: true } } },
          memory: { enabled: false },
          providers: { entries: {} },
        },
        secretManager: { get: (): string | undefined => undefined },
        eventBus: new TypedEventBus(),
        outcomeStore: store,
        logger: createMockLogger(),
      } as never,
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    // The master kill-switch is OFF → the outcome gate must be closed for every agent.
    // (Pre-rename: reads costFeatures (absent) → undefined !== false === true → force-ENABLED → RED.)
    expect(built.deps.learningOutcomeEnabled("a1")).toBe(false);
    // And byte-identity: the outbound capture is off when the master switch is off.
    expect(built.recordOutboundMessage).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // FLAG-2 (group reaction-spoof): defaultTrustLevel is the CONVERSATION
  // PARTICIPANT's privilege, NOT a blanket grant to every unmapped group member.
  // The participant is the inbound sender (RequestContext.userId, threaded onto
  // OutboundTrajectoryEntry.participantId). An unmapped NON-participant group
  // member must resolve to "external" (inert) so a bystander cannot spoof the
  // reaction-learning signal by reacting to the bot's reply.
  // -------------------------------------------------------------------------

  it("FLAG-2: an unmapped reactor that IS the conversation participant inherits defaultTrustLevel", () => {
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            elevatedReply: { senderTrustMap: {}, defaultTrustLevel: "known" },
          },
        },
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    // reactor === participantId, unmapped → defaultTrustLevel ("known"), NOT external.
    expect(built.deps.resolveSenderTrust("a1", "participant-u1", "participant-u1")).toBe("known");
  });

  it("FLAG-2: an unmapped reactor that is NOT the participant resolves to external (a group bystander cannot inherit defaultTrustLevel)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            elevatedReply: { senderTrustMap: {}, defaultTrustLevel: "known" },
          },
        },
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    // reactor !== participantId, unmapped → external (NOT the participant's defaultTrustLevel).
    expect(built.deps.resolveSenderTrust("a1", "bystander-u2", "participant-u1")).toBe("external");
  });

  it("FLAG-2: an EXPLICITLY-mapped reactor keeps its mapped trust even when it is NOT the participant (the map is an intentional grant)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            elevatedReply: { senderTrustMap: { boss: "admin" }, defaultTrustLevel: "known" },
          },
        },
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    // A mapped reactor is an operator-intended grant — the participant gate never
    // demotes it (it short-circuits before the participant comparison).
    expect(built.deps.resolveSenderTrust("a1", "boss", "participant-u1")).toBe("admin");
  });

  it("FLAG-2 fail-safe: participantId undefined falls back to defaultTrustLevel for an unmapped reactor (legacy/unthreaded path keeps reaction-learning alive)", () => {
    const built = buildReactionWiringDeps(
      makeContainer({
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            elevatedReply: { senderTrustMap: {}, defaultTrustLevel: "known" },
          },
        },
      }),
      createFakeClock(NOW),
      createFakeTimers(NOW),
    );
    // No participant known (pre-threading / legacy capture) → preserve the CURRENT
    // behavior (defaultTrustLevel), never silently demote everyone to external.
    expect(built.deps.resolveSenderTrust("a1", "anyone", undefined)).toBe("known");
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

  it("WR-01: exposes destroyReactionWiring() that cancels EVERY timer of the reaction map, session map, and reaction rate limiter (shutdown leak fix)", () => {
    const clock = createFakeClock(NOW);
    const timers = createFakeTimers(NOW);
    const built = buildReactionWiringDeps(
      makeContainer({ agents: { a1: { learningOutcome: { enabled: true } } } }),
      clock,
      timers,
    );

    // Populate all three bounded-with-timers resources so each schedules a TTL
    // timer: the reaction trajectory map (via the capture callback), the session
    // trajectory map (via recordSessionTrajectory), and the reaction rate limiter.
    built.recordOutboundMessage!("msg-1", { traceId: TRACE, tenantId: TENANT, agentId: "a1", sessionId: TRACE });
    built.deps.recordSessionTrajectory!("sk-1", { traceId: TRACE, tenantId: TENANT, agentId: "a1", sessionId: "sk-1" });
    built.deps.reactionRateLimiter.record(TENANT, "reactor-1");

    // Before shutdown there are live (un-cancelled) timers.
    expect(timers.unrefRecord().some((e) => !e.cancelled)).toBe(true);

    // The result MUST surface a destroy closure (the type promised cleanup).
    expect(typeof built.destroyReactionWiring).toBe("function");
    built.destroyReactionWiring();

    // After shutdown EVERY scheduled timer is cancelled (no leaked unref'd timers
    // accumulating across SIGUSR2 hot-reload cycles).
    expect(timers.unrefRecord().every((e) => e.cancelled)).toBe(true);
  });

  it("WR-04: the DEDICATED reaction rate limiter caps a per-sender flood TIGHTLY (the Nth+ reaction in a window is skipped, not 9-through-then-skip)", async () => {
    // Drive the REAL reaction rate limiter (constructed inside buildReactionWiringDeps)
    // through the wired handler. A trusted sender clears the WR-03 write floor, so the
    // ONLY thing that should stop a flood is the per-sender rate cap.
    const observe = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const bus = new TypedEventBus();
    const container = {
      config: {
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            elevatedReply: { senderTrustMap: { flooder: "admin" }, defaultTrustLevel: "external" },
          },
        },
        memory: { costFeatures: { enabled: true } },
        providers: { entries: {} },
      },
      secretManager: { get: (): string | undefined => undefined },
      eventBus: bus,
      outcomeStore: { observe, resolve: vi.fn(), prune: vi.fn() },
      logger: createMockLogger(),
    } as never;
    const built = buildReactionWiringDeps(container, createFakeClock(NOW), createFakeTimers(NOW));
    // Seed the outbound trajectory so each reaction resolves (REACT-02).
    built.recordOutboundMessage!("msg-out-1", { traceId: TRACE, tenantId: TENANT, agentId: "a1", sessionId: "sess-1" });
    wireLearningReactions(built.deps);

    // Fire a burst of admin-trust 👍 reactions from ONE sender at the SAME messageId
    // within the window. A tight cap drops the flood well before 9 land.
    for (let i = 0; i < 9; i++) {
      bus.emit("channel:reaction_received", reactionPayload({ messageId: "msg-out-1", reactorId: "flooder", emoji: "👍" }));
    }
    await flush();

    // The effective per-sender allowance must be tight (≤ 4), NOT the old
    // 9-through-then-skip. Asserts the dedicated limiter's auditThreshold was lowered.
    expect(observe.mock.calls.length).toBeLessThanOrEqual(4);
    expect(observe.mock.calls.length).toBeGreaterThan(0); // the first few still land (the signal is real)
  });

  it("FLAG-2 end-to-end: a group BYSTANDER (unmapped, NOT the participant) reacting on the bot reply drives ZERO learning, while the PARTICIPANT's identical reaction IS observed", async () => {
    // Drive the REAL resolveSenderTrust closure (built inside buildReactionWiringDeps
    // off the agent's elevatedReply config) through the wired reaction handler. The
    // outbound trajectory carries participantId = the inbound sender (RequestContext.
    // userId). A bystander group member who is unmapped must NOT inherit
    // defaultTrustLevel — they resolve to "external" → near-zero confidence → below
    // the write floor → no observe, no ledger row (the spoof is inert). The genuine
    // conversation participant, identically unmapped, keeps defaultTrustLevel.
    const observe = vi.fn(async (): Promise<Result<void, Error>> => ok(undefined));
    const bus = new TypedEventBus();
    const container = {
      config: {
        agents: {
          a1: {
            learningOutcome: { enabled: true },
            // No explicit map entry for either reactor — both are "unmapped".
            // defaultTrustLevel is the PARTICIPANT's privilege, not a blanket grant.
            elevatedReply: { senderTrustMap: {}, defaultTrustLevel: "known" },
          },
        },
        memory: { costFeatures: { enabled: true } },
        providers: { entries: {} },
      },
      secretManager: { get: (): string | undefined => undefined },
      eventBus: bus,
      outcomeStore: { observe, resolve: vi.fn(), prune: vi.fn() },
      logger: createMockLogger(),
    } as never;
    const built = buildReactionWiringDeps(container, createFakeClock(NOW), createFakeTimers(NOW));
    // Bind the agent reply to its trajectory WITH the conversation participant
    // (the inbound sender) recorded — exactly what the delivery binding now threads.
    built.recordOutboundMessage!("msg-out-1", {
      traceId: TRACE,
      tenantId: TENANT,
      agentId: "a1",
      sessionId: "sess-1",
      participantId: "participant-u1",
    });
    wireLearningReactions(built.deps);

    // 1. A BYSTANDER (not the participant), unmapped → external → inert (no row).
    bus.emit("channel:reaction_received", reactionPayload({ messageId: "msg-out-1", reactorId: "bystander-u2", emoji: "👍" }));
    await flush();
    expect(observe).not.toHaveBeenCalled();

    // 2. The genuine PARTICIPANT, identically unmapped → defaultTrustLevel ("known")
    //    → above the floor → observed. The legit signal still flows.
    bus.emit("channel:reaction_received", reactionPayload({ messageId: "msg-out-1", reactorId: "participant-u1", emoji: "👍" }));
    await flush();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]![0].senderTrust).toBe("known");
  });
});
