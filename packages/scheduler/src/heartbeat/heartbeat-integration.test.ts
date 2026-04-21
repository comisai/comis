// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat integration tests.
 *
 * Wire REAL subsystems (SystemEventQueue, DuplicateDetector, AgentHeartbeatSource,
 * PerAgentHeartbeatRunner) with mocks only at I/O boundaries (executor, channel adapter).
 *
 * These tests verify that heartbeat subsystems work together end-to-end:
 * - Runner ticks fire and reach the agent source
 * - Agent source builds prompts, calls executor, classifies responses
 * - Delivery bridge routes notifications through dedup to channel adapters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ok } from "@comis/shared";
import { createSystemEventQueue } from "../system-events/system-event-queue.js";
import { createAgentHeartbeatSource } from "./agent-heartbeat-source.js";
import type { AgentHeartbeatSourceDeps } from "./agent-heartbeat-source.js";
import { createDuplicateDetector } from "./duplicate-detector.js";
import { createPerAgentHeartbeatRunner } from "./per-agent-heartbeat-runner.js";
import type { HeartbeatAgentState } from "./per-agent-heartbeat-runner.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";
import type { DeliveryBridgeDeps } from "./delivery-bridge.js";
import { isInQuietHours } from "./quiet-hours.js";
import type { QuietHoursConfig } from "./quiet-hours.js";
import { shouldNotify, classifyHeartbeatResult } from "./relevance-filter.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeEventBus() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
}

function makeExecutor(response: string) {
  return {
    execute: vi.fn().mockResolvedValue({ response }),
  };
}

function makeAdapter() {
  return {
    sendMessage: vi.fn().mockResolvedValue(ok("msg-001")),
    getStatus: vi.fn().mockReturnValue({ connected: true }),
  };
}

function makeResolveModel() {
  return vi.fn().mockReturnValue({
    model: "anthropic:claude-haiku-4-5-20251001",
    timeoutMs: 60000,
    source: "family_default",
    cacheRetention: "none",
  });
}

function makeConfig(overrides?: Partial<EffectiveHeartbeatConfig>): EffectiveHeartbeatConfig {
  return {
    enabled: true,
    intervalMs: 100,
    showOk: false,
    showAlerts: true,
    target: {
      channelType: "discord",
      channelId: "ch-1",
      chatId: "chat-1",
    },
    ...overrides,
  };
}

function makeAgentState(
  agentId: string,
  intervalMs: number,
  overrides?: Partial<HeartbeatAgentState>,
): HeartbeatAgentState {
  return {
    agentId,
    config: makeConfig({ intervalMs }),
    lastRunMs: 0,
    nextDueMs: 0,
    consecutiveErrors: 0,
    backoffUntilMs: 0,
    tickStartedAtMs: 0,
    lastAlertMs: 0,
    lastErrorKind: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Integration: heartbeat subsystem wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Full heartbeat flow (runner -> agent source -> delivery)
  // -------------------------------------------------------------------------
  it("full flow — tick fires, executor called, response delivered to channel", async () => {
    let now = 1000;
    const logger = makeLogger();
    const eventBus = makeEventBus();
    const executor = makeExecutor("Alert: disk at 95%");
    const adapter = makeAdapter();
    const dedup = createDuplicateDetector({ nowMs: () => now });

    const queue = createSystemEventQueue({ logger, nowMs: () => now });

    const config = makeConfig({ intervalMs: 100 });

    const deliveryBridge: DeliveryBridgeDeps = {
      adaptersByType: new Map([["discord", adapter as any]]),
      duplicateDetector: dedup,
      eventBus,
      logger,
    };

    const sourceDeps: AgentHeartbeatSourceDeps = {
      getExecutor: vi.fn().mockReturnValue(executor),
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      getEffectiveConfig: vi.fn().mockReturnValue(config),
      getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
      resolveModel: makeResolveModel(),
      checkFileGate: vi.fn().mockResolvedValue(false), // non-empty
      systemEventQueue: queue,
      deliveryBridge,
      logger,
    };

    const source = createAgentHeartbeatSource(sourceDeps);

    const agents = new Map<string, HeartbeatAgentState>();
    agents.set("agent-1", makeAgentState("agent-1", 100));

    const runner = createPerAgentHeartbeatRunner({
      agents,
      eventBus,
      logger,
      onTick: source.onTick,
      nowMs: () => now,
    });

    runner.start();

    // Advance past the interval so the tick fires
    now += 100;
    await vi.advanceTimersByTimeAsync(100);

    // Flush fire-and-forget delivery microtasks
    await vi.advanceTimersByTimeAsync(0);

    // Assert executor was called
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Assert adapter received the message
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith("chat-1", "Alert: disk at 95%");

    runner.stop();
  });

  // -------------------------------------------------------------------------
  // Cron-triggered heartbeat flow
  // -------------------------------------------------------------------------
  it("cron events enqueued to system queue flow through agent source to delivery", async () => {
    let now = 1000;
    const logger = makeLogger();
    const eventBus = makeEventBus();
    const executor = makeExecutor("Backup completed successfully, all good");
    const adapter = makeAdapter();
    const dedup = createDuplicateDetector({ nowMs: () => now });

    const queue = createSystemEventQueue({ logger, nowMs: () => now });

    const config = makeConfig({ intervalMs: 60_000 });

    const deliveryBridge: DeliveryBridgeDeps = {
      adaptersByType: new Map([["discord", adapter as any]]),
      duplicateDetector: dedup,
      eventBus,
      logger,
    };

    const sourceDeps: AgentHeartbeatSourceDeps = {
      getExecutor: vi.fn().mockReturnValue(executor),
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      getEffectiveConfig: vi.fn().mockReturnValue(config),
      getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
      resolveModel: makeResolveModel(),
      checkFileGate: vi.fn().mockResolvedValue(true), // would skip if interval, but cron bypasses
      systemEventQueue: queue,
      deliveryBridge,
      logger,
    };

    const source = createAgentHeartbeatSource(sourceDeps);

    // Enqueue a cron event BEFORE calling onTick -- use the session key that
    // resolveHeartbeatSessionKey will produce for this agent+config
    const sessionKey = "default:heartbeat:chat-1";
    queue.enqueue("Backup completed", {
      contextKey: "cron:backup:summary",
      sessionKey,
    });

    // Call onTick directly -- no runner needed for this test
    await source.onTick("agent-1");

    // Assert executor was called (cron bypass means file gate is ignored)
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Verify the NormalizedMessage text includes the cron event content
    const callArgs = executor.execute.mock.calls[0]!;
    const msg = callArgs[0] as { text: string; metadata?: Record<string, unknown> };
    expect(msg.text).toContain("Backup completed");

    // Verify triggerKind is "cron" in the message metadata
    expect(msg.metadata?.triggerKind).toBe("cron");
  });

  // -------------------------------------------------------------------------
  // Empty HEARTBEAT.md skips LLM, non-empty triggers full turn
  // -------------------------------------------------------------------------
  it("empty HEARTBEAT.md skips LLM call, non-empty triggers full agent turn", async () => {
    const now = 1000;
    const logger = makeLogger();
    const eventBus = makeEventBus();
    const executor = makeExecutor("Some response");
    const dedup = createDuplicateDetector({ nowMs: () => now });
    const adapter = makeAdapter();

    const queue = createSystemEventQueue({ logger, nowMs: () => now });

    const config = makeConfig({ intervalMs: 60_000 });

    const deliveryBridge: DeliveryBridgeDeps = {
      adaptersByType: new Map([["discord", adapter as any]]),
      duplicateDetector: dedup,
      eventBus,
      logger,
    };

    // Case 1: File gate returns true (effectively empty) -> skip LLM
    const emptyGateSource = createAgentHeartbeatSource({
      getExecutor: vi.fn().mockReturnValue(executor),
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      getEffectiveConfig: vi.fn().mockReturnValue(config),
      getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
      resolveModel: makeResolveModel(),
      checkFileGate: vi.fn().mockResolvedValue(true), // empty
      systemEventQueue: queue,
      deliveryBridge,
      logger,
    });

    await emptyGateSource.onTick("agent-1");
    expect(executor.execute).not.toHaveBeenCalled();

    // Case 2: File gate returns false (non-empty) -> full agent turn
    const executor2 = makeExecutor("Alert: something happened");
    const nonEmptyGateSource = createAgentHeartbeatSource({
      getExecutor: vi.fn().mockReturnValue(executor2),
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      getEffectiveConfig: vi.fn().mockReturnValue(config),
      getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
      resolveModel: makeResolveModel(),
      checkFileGate: vi.fn().mockResolvedValue(false), // non-empty
      systemEventQueue: queue,
      deliveryBridge,
      logger,
    });

    await nonEmptyGateSource.onTick("agent-1");
    expect(executor2.execute).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Duplicate detection suppresses repeated deliveries
  // -------------------------------------------------------------------------
  it("duplicate detection suppresses repeated identical heartbeat deliveries", async () => {
    const now = 1000;
    const logger = makeLogger();
    const eventBus = makeEventBus();
    const executor = makeExecutor("Alert: disk at 95%");
    const adapter = makeAdapter();

    // Real duplicate detector -- the key integration point
    const dedup = createDuplicateDetector({ nowMs: () => now });

    const queue = createSystemEventQueue({ logger, nowMs: () => now });

    const config = makeConfig({ intervalMs: 60_000 });

    const deliveryBridge: DeliveryBridgeDeps = {
      adaptersByType: new Map([["discord", adapter as any]]),
      duplicateDetector: dedup,
      eventBus,
      logger,
    };

    const sourceDeps: AgentHeartbeatSourceDeps = {
      getExecutor: vi.fn().mockReturnValue(executor),
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      getEffectiveConfig: vi.fn().mockReturnValue(config),
      getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
      resolveModel: makeResolveModel(),
      checkFileGate: vi.fn().mockResolvedValue(false), // non-empty
      systemEventQueue: queue,
      deliveryBridge,
      logger,
    };

    const source = createAgentHeartbeatSource(sourceDeps);

    // First tick -- should deliver
    await source.onTick("agent-1");
    await vi.advanceTimersByTimeAsync(0); // flush fire-and-forget

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

    // Second tick with same response -- should be suppressed by dedup
    await source.onTick("agent-1");
    await vi.advanceTimersByTimeAsync(0);

    expect(executor.execute).toHaveBeenCalledTimes(2); // executor still called
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1); // but delivery suppressed
  });

  // -------------------------------------------------------------------------
  // Quiet hours suppress normal alerts, critical bypasses
  // -------------------------------------------------------------------------
  it("quiet hours suppress normal alerts but critical notifications bypass", () => {
    // Quiet hours is a standalone subsystem not wired into the delivery bridge
    // pipeline. Test it as a standalone integration of isInQuietHours +
    // shouldNotify + classifyHeartbeatResult working together.

    // Configure quiet hours: 22:00 - 07:00 UTC
    const quietConfig: QuietHoursConfig = {
      enabled: true,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    };

    // Set "now" to 23:00 UTC (within quiet hours)
    // 2026-01-15T23:00:00Z = 1736982000000
    const nowInQuiet = Date.UTC(2026, 0, 15, 23, 0, 0);

    // Verify we are in quiet hours
    expect(isInQuietHours(quietConfig, nowInQuiet)).toBe(true);

    // Normal alert text -- should be suppressed during quiet hours
    const normalText = "Alert: disk at 80% usage";
    const normalLevel = classifyHeartbeatResult(normalText);
    expect(normalLevel).toBe("alert");

    const normalNotify = shouldNotify({
      level: normalLevel,
      visibility: { showOk: false, showAlerts: true },
      isQuietHours: true,
      criticalBypass: true,
    });
    expect(normalNotify).toBe(false); // suppressed

    // Critical alert text -- should bypass quiet hours
    const criticalText = "CRITICAL: server unreachable";
    const criticalLevel = classifyHeartbeatResult(criticalText);
    expect(criticalLevel).toBe("critical");

    const criticalNotify = shouldNotify({
      level: criticalLevel,
      visibility: { showOk: false, showAlerts: true },
      isQuietHours: true,
      criticalBypass: true,
    });
    expect(criticalNotify).toBe(true); // bypasses quiet hours

    // Verify outside quiet hours both levels pass
    const nowOutsideQuiet = Date.UTC(2026, 0, 15, 12, 0, 0);
    expect(isInQuietHours(quietConfig, nowOutsideQuiet)).toBe(false);

    const normalOutsideNotify = shouldNotify({
      level: "alert",
      visibility: { showOk: false, showAlerts: true },
      isQuietHours: false,
      criticalBypass: true,
    });
    expect(normalOutsideNotify).toBe(true); // not suppressed outside quiet hours
  });

  // -------------------------------------------------------------------------
  // Per-agent independent intervals and delivery targets
  // -------------------------------------------------------------------------
  it("agents tick at independent intervals with different delivery targets", async () => {
    let now = 1000;
    const logger = makeLogger();
    const eventBus = makeEventBus();
    const dedup = createDuplicateDetector({ nowMs: () => now });

    const queue = createSystemEventQueue({ logger, nowMs: () => now });

    // Two adapters for different channel types
    const discordAdapter = makeAdapter();
    const telegramAdapter = makeAdapter();

    const deliveryBridge: DeliveryBridgeDeps = {
      adaptersByType: new Map([
        ["discord", discordAdapter as any],
        ["telegram", telegramAdapter as any],
      ]),
      duplicateDetector: dedup,
      eventBus,
      logger,
    };

    // Config per agent
    const fastConfig = makeConfig({
      intervalMs: 100,
      target: { channelType: "discord", channelId: "d1", chatId: "chat-d" },
    });
    const slowConfig = makeConfig({
      intervalMs: 300,
      target: { channelType: "telegram", channelId: "t1", chatId: "chat-t" },
    });

    // Different executors so we can track calls per agent
    const fastExecutor = makeExecutor("Fast agent alert");
    const slowExecutor = makeExecutor("Slow agent alert");

    const sourceDeps: AgentHeartbeatSourceDeps = {
      getExecutor: vi.fn().mockImplementation((agentId: string) =>
        agentId === "fast-agent" ? fastExecutor : slowExecutor,
      ),
      assembleToolsForAgent: vi.fn().mockResolvedValue([]),
      getEffectiveConfig: vi.fn().mockImplementation((agentId: string) =>
        agentId === "fast-agent" ? fastConfig : slowConfig,
      ),
      getAgentConfig: vi.fn().mockReturnValue({ model: "claude-sonnet", tenantId: "default" }),
      resolveModel: makeResolveModel(),
      checkFileGate: vi.fn().mockResolvedValue(false), // non-empty
      systemEventQueue: queue,
      deliveryBridge,
      logger,
    };

    const source = createAgentHeartbeatSource(sourceDeps);

    const agents = new Map<string, HeartbeatAgentState>();
    agents.set("fast-agent", makeAgentState("fast-agent", 100, {
      config: fastConfig,
    }));
    agents.set("slow-agent", makeAgentState("slow-agent", 300, {
      config: slowConfig,
    }));

    const runner = createPerAgentHeartbeatRunner({
      agents,
      eventBus,
      logger,
      onTick: source.onTick,
      nowMs: () => now,
    });

    runner.start();

    // After 100ms: fast-agent should tick, slow-agent should not
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0); // flush delivery

    expect(fastExecutor.execute).toHaveBeenCalledTimes(1);
    expect(slowExecutor.execute).toHaveBeenCalledTimes(0);
    expect(discordAdapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(discordAdapter.sendMessage).toHaveBeenCalledWith("chat-d", "Fast agent alert");
    expect(telegramAdapter.sendMessage).toHaveBeenCalledTimes(0);

    // After 200ms total: fast-agent ticks again (2 total), slow-agent still waiting
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(fastExecutor.execute).toHaveBeenCalledTimes(2);
    expect(slowExecutor.execute).toHaveBeenCalledTimes(0);

    // After 300ms total: fast-agent ticks (3 total), slow-agent ticks (1 total)
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(fastExecutor.execute).toHaveBeenCalledTimes(3);
    expect(slowExecutor.execute).toHaveBeenCalledTimes(1);
    expect(telegramAdapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegramAdapter.sendMessage).toHaveBeenCalledWith("chat-t", "Slow agent alert");

    // Verify each adapter only received messages for its target
    for (const call of discordAdapter.sendMessage.mock.calls) {
      expect(call[0]).toBe("chat-d");
    }
    for (const call of telegramAdapter.sendMessage.mock.calls) {
      expect(call[0]).toBe("chat-t");
    }

    runner.stop();
  });
});
