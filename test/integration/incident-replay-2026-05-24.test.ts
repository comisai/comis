// SPDX-License-Identifier: Apache-2.0
/**
 * 2026-05-24 Duplicate-Adapter Incident Replay
 *
 * Synthesizes the duplicate-adapter wiring that caused the 2026-05-24
 * Telegram regression at the orchestrator layer (no full daemon spin-up).
 * Proves the bug is now visible at all three independent layers:
 *
 *   Layer 1 (boot):   emitStartupInvariants fires WARN with errorKind:"config"
 *                     when rawHandlerCounts["telegram"] === 2.
 *   Layer 2 (message): createDedupDetector fires dedup:duplicate_inbound event
 *                      with deltaMs ≈ 1 (controlled clock) when the same
 *                      messageId arrives twice.
 *   Layer 3 (queue):   queue:enqueued fires twice with the same messageId when
 *                      a duplicate message is not suppressed (dedup does NOT
 *                      suppress — processing continues).
 *
 * Construction approach:
 *   - Mirror channel-resilience.test.ts import block + EchoChannelAdapter setup
 *   - createChannelManager with SAME adapter in both deps.adapters AND
 *     channelRegistry to reproduce pre-fix wiring (rawHandlerCounts → 2)
 *   - createDedupDetector with injectable clock for deterministic deltaMs
 *   - processInboundMessage wired with real createCommandQueue so queue:enqueued
 *     events are real (dedup does NOT suppress, both messages hit the queue)
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { EchoChannelAdapter } from "@comis/channels";
import {
  createChannelManager,
  type ChannelManagerDeps,
  createDedupDetector,
  processInboundMessage,
  type InboundPipelineDeps,
  createCommandQueue,
} from "@comis/orchestrator";
import { TypedEventBus, QueueConfigSchema } from "@comis/core";
import type { NormalizedMessage, ChannelPort } from "@comis/core";
import { ok } from "@comis/shared";
import { emitStartupInvariants } from "@comis/daemon";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: overrides?.id ?? randomUUID(),
    channelId: overrides?.channelId ?? "tg-chat-12345",
    channelType: overrides?.channelType ?? "telegram",
    senderId: overrides?.senderId ?? "user-42",
    text: overrides?.text ?? "Hello from Telegram",
    timestamp: overrides?.timestamp ?? Date.now(),
    attachments: overrides?.attachments ?? [],
    metadata: overrides?.metadata ?? {},
  };
}

/** Minimal ChannelPort stub (not an EchoChannelAdapter — no handlers to register). */
function makeAdapterStub(channelType = "telegram"): ChannelPort {
  return {
    channelId: "tg-chat-12345",
    channelType,
    start: async () => ok(undefined),
    stop: async () => ok(undefined),
    onMessage: () => {},
    sendMessage: async () => ok("sent"),
    editMessage: async () => ok(undefined),
    reactToMessage: async () => ok(undefined),
    deleteMessage: async () => ok(undefined),
    fetchMessages: async () => ok([]),
    sendAttachment: async () => ok("attach"),
    platformAction: async () => ok({}),
  };
}

// ---------------------------------------------------------------------------
// LAYER 1: Boot WARN — duplicate-adapter wiring surfaced before traffic
// ---------------------------------------------------------------------------

describe("2026-05-24 duplicate-adapter incident replay — Layer 1 (boot WARN)", () => {
  it("emitStartupInvariants emits WARN with errorKind:config when rawHandlerCounts shows telegram:2", async () => {
    // Reproduce the pre-fix wiring: same EchoChannelAdapter passed in both
    // deps.adapters and channelRegistry.getChannelPlugins(). channelManager
    // deduplicates silently for same-instance (rawHandlerCounts captures the
    // pre-dedup count = 2).
    const adapter = new EchoChannelAdapter({
      channelId: "tg-test",
      channelType: "telegram",
    });

    const eventBus = new TypedEventBus();
    const logger = makeLogger();

    // channelRegistry stub whose getChannelPlugins returns the same adapter
    const channelRegistryStub = {
      getChannelPlugins: () => [{ adapter, channelType: "telegram" }],
      get: () => undefined,
    };

    // Minimal delivery service stub
    const deliveryService = {
      deliverToChannel: vi.fn(async () => ok({ ok: true, messageId: "m1" }) as any),
      drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
    } as ChannelManagerDeps["deliveryService"];

    const deps: ChannelManagerDeps = {
      eventBus,
      messageRouter: { resolve: vi.fn(() => "default") } as any,
      sessionManager: {
        loadOrCreate: vi.fn(() => []),
        save: vi.fn(),
        expire: vi.fn(),
      } as any,
      createExecutor: vi.fn(() => undefined) as any,
      // Pre-fix wiring: adapter in both adapters list AND channelRegistry
      adapters: [adapter],
      channelRegistry: channelRegistryStub as any,
      logger,
      deliveryService,
      processInboundMessage: vi.fn(async () => {}) as ChannelManagerDeps["processInboundMessage"],
    };

    const cm = createChannelManager(deps);
    await cm.startAll();

    // Confirm rawHandlerCounts shows 2 (regression wiring) while activeCount = 1 (deduped)
    const rawCounts = cm.getRawHandlerCounts();
    expect(rawCounts.get("telegram")).toBe(2);
    expect(cm.activeCount).toBe(1);

    // Call emitStartupInvariants with a capturing mock logger
    const invariantLogger = makeLogger();
    emitStartupInvariants({
      logger: invariantLogger as any,
      adaptersByType: new Map([["telegram", adapter]]),
      rawHandlerCounts: rawCounts,
      channelPlugins: new Map([["telegram", {}]]),
      pluginRegistry: { count: () => 0 },
      mcpClientManager: { getTools: () => [] },
      agentsConfig: { default: {} },
      depSlotConsistency: { adaptersList: true, channelRegistry: true },
    });

    // --- Layer 1 assertion: INFO record carries handlersPerAdapter:{telegram:2} ---
    expect(invariantLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        handlersPerAdapter: { telegram: 2 },
      }),
      "daemon:startup_invariants",
    );

    // --- Layer 1 assertion: WARN with errorKind:config and duplicate-adapter hint ---
    const warnCalls = invariantLogger.warn.mock.calls;
    const duplicateHandlerWarn = warnCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)["channelType"] === "telegram" &&
        (call[0] as Record<string, unknown>)["errorKind"] === "config",
    );
    expect(duplicateHandlerWarn).toBeDefined();
    expect(duplicateHandlerWarn![0]).toMatchObject({
      channelType: "telegram",
      errorKind: "config",
      hint: "Duplicate adapter registration detected; see AGENTS.md §6.1",
    });

    await cm.stopAll();
  });
});

// ---------------------------------------------------------------------------
// LAYER 2: Dedup event fires with deltaMs:1 on second arrival
// ---------------------------------------------------------------------------

describe("2026-05-24 duplicate-adapter incident replay — Layer 2 (dedup event)", () => {
  it("dedup:duplicate_inbound fires once with deltaMs:1 and WARN errorKind:internal when same messageId arrives twice", async () => {
    // Controlled clock: first call = 1000 ms, second (duplicate check) = 1001 ms
    let nowVal = 1000;
    const dedupDetector = createDedupDetector({ now: () => nowVal++ });

    const eventBus = new TypedEventBus();
    const logger = makeLogger();

    // Collect dedup:duplicate_inbound events
    const dedupEvents: Array<Record<string, unknown>> = [];
    eventBus.on("dedup:duplicate_inbound", (ev) => {
      dedupEvents.push(ev as Record<string, unknown>);
    });

    // Build minimal InboundPipelineDeps that hits the dedup check and exits early
    // after (messageRouter returns undefined → no executor → early return at Phase 1).
    // The dedup check in Phase 0 still fires before Phase 1 returns.
    const minimalDeps: InboundPipelineDeps = {
      eventBus,
      logger: logger as any,
      messageRouter: { resolve: vi.fn(() => undefined) } as any,
      sessionManager: {
        loadOrCreate: vi.fn(() => []),
        save: vi.fn(),
        isExpired: vi.fn(() => false),
        expire: vi.fn(() => true),
        cleanStale: vi.fn(() => 0),
      } as any,
      createExecutor: vi.fn(() => undefined) as any,
      deliveryService: {
        deliverToChannel: vi.fn(async () => ok({ ok: true, messageId: "m1" }) as any),
        drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
      } as any,
      dedupDetector,
    };

    const adapter = makeAdapterStub("telegram");

    const sharedMsgId = randomUUID();
    const msg1 = makeMessage({ id: sharedMsgId });
    const msg2 = makeMessage({ id: sharedMsgId }); // same id — duplicate

    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    // First call at nowVal=1000: recorded (not duplicate)
    await processInboundMessage(minimalDeps, adapter, msg1, new Set(), sendOverrides);
    // Second call at nowVal=1001: duplicate — fires dedup:duplicate_inbound
    await processInboundMessage(minimalDeps, adapter, msg2, new Set(), sendOverrides);

    // --- Layer 2 assertion: dedup event fired exactly once ---
    expect(dedupEvents).toHaveLength(1);
    expect(dedupEvents[0]).toMatchObject({
      messageId: sharedMsgId,
      channelType: "telegram",
      deltaMs: 1,
      source: "pipeline",
    });

    // --- Layer 2 assertion: WARN with errorKind:internal ---
    const warnCalls = logger.warn.mock.calls;
    const dedupWarn = warnCalls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)["errorKind"] === "internal" &&
        (call[0] as Record<string, unknown>)["messageId"] === sharedMsgId,
    );
    expect(dedupWarn).toBeDefined();
    expect(dedupWarn![0]).toMatchObject({
      messageId: sharedMsgId,
      channelType: "telegram",
      deltaMs: 1,
      hint: "Same messageId processed twice; check channel adapter handler list and queue mode",
      errorKind: "internal",
    });
  });
});

// ---------------------------------------------------------------------------
// LAYER 3: queue:enqueued fires twice — dedup does NOT suppress
// ---------------------------------------------------------------------------

describe("2026-05-24 duplicate-adapter incident replay — Layer 3 (queue double-enqueue)", () => {
  it("queue:enqueued fires twice with same channelType when duplicate message is NOT suppressed", async () => {
    // The dedup detector logs + emits but does NOT return early — processing continues
    // for BOTH messages. Both reach the commandQueue and emit queue:enqueued.
    const eventBus = new TypedEventBus();
    const logger = makeLogger();

    const sharedMsgId = randomUUID();

    // Collect queue:enqueued events
    const queueEvents: Array<Record<string, unknown>> = [];
    eventBus.on("queue:enqueued", (ev) => {
      queueEvents.push(ev as Record<string, unknown>);
    });

    // Dedup detector — will log + emit but NOT suppress
    let nowVal = 1000;
    const dedupDetector = createDedupDetector({ now: () => nowVal++ });

    // Real commandQueue wired to the shared eventBus — it emits queue:enqueued
    const queueConfig = QueueConfigSchema.parse({ cleanupIdleMs: 60_000 });
    const commandQueue = createCommandQueue({ eventBus, config: queueConfig, logger: logger as any });

    // Minimal executor stub: returns a valid ExecutionResult so Phase 1 succeeds
    const executorStub = {
      execute: vi.fn(async () => ({
        response: "echo response",
        sessionKey: { tenantId: "t", userId: "u", channelId: "c" },
        tokensUsed: { input: 1, output: 1, total: 2 },
        cost: { total: 0 },
        stepsExecuted: 0,
        finishReason: "stop",
        toolCalls: [],
        traceId: randomUUID(),
      })),
    };

    const pipelineDeps: InboundPipelineDeps = {
      eventBus,
      logger: logger as any,
      messageRouter: { resolve: vi.fn(() => "default") } as any,
      sessionManager: {
        loadOrCreate: vi.fn(() => []),
        save: vi.fn(),
        isExpired: vi.fn(() => false),
        expire: vi.fn(() => true),
        cleanStale: vi.fn(() => 0),
      } as any,
      createExecutor: vi.fn(() => executorStub) as any,
      commandQueue,
      deliveryService: {
        deliverToChannel: vi.fn(async () => ok({ ok: true, messageId: "m1" }) as any),
        drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
      } as any,
      dedupDetector,
    };

    const adapter = makeAdapterStub("telegram");

    const msg1 = makeMessage({ id: sharedMsgId });
    const msg2 = makeMessage({ id: sharedMsgId }); // same id — duplicate, NOT suppressed

    const sendOverrides = { get: () => undefined, set: () => {}, delete: () => {} } as any;

    // Inject both messages — dedup fires WARN + event on msg2 but does NOT block enqueue
    await processInboundMessage(pipelineDeps, adapter, msg1, new Set(), sendOverrides);
    await processInboundMessage(pipelineDeps, adapter, msg2, new Set(), sendOverrides);

    // --- Layer 3 assertion: queue:enqueued fired twice ---
    // Both messages arrive at the queue because dedup does NOT suppress.
    expect(queueEvents).toHaveLength(2);
    for (const ev of queueEvents) {
      expect(ev["channelType"]).toBe("telegram");
    }

    // Confirm dedup:duplicate_inbound was emitted (layers 2+3 on same bus)
    const dedupWarnCalls = logger.warn.mock.calls;
    const hasDedupWarn = dedupWarnCalls.some(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        (call[0] as Record<string, unknown>)["errorKind"] === "internal" &&
        (call[0] as Record<string, unknown>)["messageId"] === sharedMsgId,
    );
    expect(hasDedupWarn).toBe(true);
  });
});
