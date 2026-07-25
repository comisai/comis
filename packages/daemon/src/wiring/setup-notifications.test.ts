// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `setupNotifications` wiring factory.
 *
 * Asserts deterministic factory output, port-injection contract, and
 * downstream-service registration behavior. Every `it("...")` description
 * names a use case >=20 chars ending in a recognizable shape.
 *
 * @module
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { ok } from "@comis/shared";
import type {
  DeliveryQueuePort,
  DeliveryQueueEnqueueInput,
  DeliveryQueueEntry,
  DeliveryQueueStatusCounts,
  NotificationConfig,
  PerAgentConfig,
} from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createMockEventBus } from "../../../../test/support/mock-event-bus.js";
import { setupNotifications } from "./setup-notifications.js";

// ---------------------------------------------------------------------------
// Mock-builder factory for DeliveryQueuePort. Records every enqueue call so
// tests can assert deferred vs immediate scheduling (notification:enqueued
// + quiet_hours suppression).
// ---------------------------------------------------------------------------

interface MockDeliveryQueue extends DeliveryQueuePort {
  readonly enqueueCalls: DeliveryQueueEnqueueInput[];
}

function createMockDeliveryQueue(nextId = "delivery-entry-id"): MockDeliveryQueue {
  const enqueueCalls: DeliveryQueueEnqueueInput[] = [];
  return {
    enqueueCalls,
    enqueue: vi.fn(async (entry: DeliveryQueueEnqueueInput) => {
      enqueueCalls.push(entry);
      return ok(nextId);
    }),
    enqueueInFlight: vi.fn(async (entry: DeliveryQueueEnqueueInput) => {
      enqueueCalls.push(entry);
      return ok(nextId);
    }),
    claim: vi.fn(async () => ok(true)),
    ack: vi.fn(async () => ok(undefined)),
    nack: vi.fn(async () => ok(undefined)),
    fail: vi.fn(async () => ok(undefined)),
    pendingEntries: vi.fn(async () => ok([] as DeliveryQueueEntry[])),
    unconfirmedEntries: vi.fn(async () => ok([] as DeliveryQueueEntry[])),
    pruneExpired: vi.fn(async () => ok(0)),
    statusCounts: vi.fn(async () =>
      ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 } satisfies DeliveryQueueStatusCounts),
    ),
    recoverInFlight: vi.fn(async () => ok(0)),
  };
}

// ---------------------------------------------------------------------------
// PerAgentConfig fixture with notification slice. The factory only reads
// agentConfig.notification, so the rest of PerAgentConfig is irrelevant
// for these wiring-contract tests -- cast through unknown for an
// agent-shaped value.
// ---------------------------------------------------------------------------

function makeAgentWithNotification(notification: NotificationConfig): PerAgentConfig {
  return { notification } as unknown as PerAgentConfig;
}

function makeAgentWithoutNotification(): PerAgentConfig {
  return {} as unknown as PerAgentConfig;
}

function makeNotificationConfig(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
  return {
    enabled: true,
    maxPerHour: 30,
    dedupeWindowMs: 300_000,
    maxChainDepth: 0,
    ...overrides,
  };
}

function deliveryFields(agentId: string, channelId: string) {
  return {
    authority: {
      tenantId: "tenant-a",
      agentId,
      conversationRef: `cv_${"n".repeat(43)}` as never,
    },
    destinationEndpoint: {
      channelType: "discord",
      channelInstanceId: "discord-test",
      conversationId: channelId,
      conversationKind: "direct" as const,
    },
  };
}

// ---------------------------------------------------------------------------
// Build a deps object for `setupNotifications` with sensible test defaults.
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<Parameters<typeof setupNotifications>[0]> = {}): {
  deps: Parameters<typeof setupNotifications>[0];
  deliveryQueue: MockDeliveryQueue;
  eventBus: ReturnType<typeof createMockEventBus>;
} {
  const deliveryQueue = (overrides.deliveryQueue as MockDeliveryQueue | undefined) ?? createMockDeliveryQueue();
  const eventBus = (overrides.eventBus as ReturnType<typeof createMockEventBus> | undefined) ?? createMockEventBus();
  const deps: Parameters<typeof setupNotifications>[0] = {
    eventBus,
    deliveryQueue,
    agents: overrides.agents ?? {},
    quietHoursConfig: overrides.quietHoursConfig ?? {
      enabled: false,
      start: "22:00",
      end: "07:00",
      timezone: "UTC",
    },
    criticalBypass: overrides.criticalBypass ?? false,
    activeAdapterTypes: overrides.activeAdapterTypes ?? new Set<string>(["discord"]),
    tenantId: overrides.tenantId ?? "tenant-a",
    resolveChannelInstanceId: overrides.resolveChannelInstanceId ?? ((channelType: string) => `${channelType}-test`),
    logger: overrides.logger ?? createMockLogger(),
    ...overrides,
  };
  return { deps, deliveryQueue, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupNotifications -- daemon wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers SessionTracker as an ephemeral in-memory instance per daemon startup", () => {
    // Two factory calls must yield two DIFFERENT SessionTracker instances --
    // ephemeral state lives in-memory per startup, with no shared registry.
    const ctxA = setupNotifications(makeDeps().deps);
    const ctxB = setupNotifications(makeDeps().deps);

    expect(ctxA.sessionTracker).toBeDefined();
    expect(ctxB.sessionTracker).toBeDefined();
    expect(ctxA.sessionTracker).not.toBe(ctxB.sessionTracker);

    // Shape contract: recordActivity / getRecentForPlatform / getMostRecent.
    expect(typeof ctxA.sessionTracker.recordActivity).toBe("function");
    expect(typeof ctxA.sessionTracker.getRecentForPlatform).toBe("function");
    expect(typeof ctxA.sessionTracker.getMostRecent).toBe("function");

    // State isolation: writing into tracker A leaves tracker B empty.
    const endpoint = {
      channelType: "discord",
      channelInstanceId: "discord-test",
      conversationId: "discord-test-channel-A",
      conversationKind: "direct" as const,
    };
    ctxA.sessionTracker.recordActivity("agent-1", endpoint);
    expect(ctxA.sessionTracker.getRecentForPlatform("agent-1", "discord")).toEqual(endpoint);
    expect(ctxB.sessionTracker.getRecentForPlatform("agent-1", "discord")).toBeUndefined();
  });

  it("builds NotificationConfig map from PerAgentConfig.notification entries", async () => {
    // Two agents -- one with notification config (disabled), one without.
    // Behavior should differ at notifyUser time: the configured agent honors
    // its enabled=false (returns "Notifications disabled" error and never
    // enqueues); the un-configured agent falls back to defaultConfig
    // (enabled=true) and reaches enqueue.
    const disabledNotif = makeNotificationConfig({ enabled: false });
    const agents: Record<string, PerAgentConfig> = {
      "agent-disabled": makeAgentWithNotification(disabledNotif),
      "agent-default": makeAgentWithoutNotification(),
    };
    const { deps, deliveryQueue } = makeDeps({ agents });
    deps.activeAdapterTypes = new Set<string>(["discord"]);

    const ctx = setupNotifications(deps);
    // Seed a recent session for agent-default so the channel resolver has a
    // fallback target. agent-disabled never reaches resolution.
    ctx.sessionTracker.recordActivity("agent-default", {
      channelType: "discord",
      channelInstanceId: "discord-test",
      conversationId: "discord-test-channel-1",
      conversationKind: "direct",
    });

    const disabledResult = await ctx.notificationService.notifyUser({
      agentId: "agent-disabled",
      message: "should not deliver",
      channelType: "discord",
      channelId: "discord-test-channel-2",
      ...deliveryFields("agent-disabled", "discord-test-channel-2"),
    });
    const defaultResult = await ctx.notificationService.notifyUser({
      agentId: "agent-default",
      message: "should deliver",
      channelType: "discord",
      channelId: "discord-test-channel-3",
      ...deliveryFields("agent-default", "discord-test-channel-3"),
    });

    expect(disabledResult.ok).toBe(false);
    if (!disabledResult.ok) {
      expect(disabledResult.error.message).toMatch(/disabled/i);
    }
    expect(defaultResult.ok).toBe(true);
    expect(deliveryQueue.enqueueCalls).toHaveLength(1);
    expect(deliveryQueue.enqueueCalls[0]!.text).toBe("should deliver");
  });

  it("dispatch table routes notification events to the configured guard pipeline by notification kind", async () => {
    // The "dispatch table" surface of setupNotifications is the
    // NotificationService whose notifyUser() runs the full guard pipeline
    // (config -> channel -> quiet hours -> rate limit -> dedup -> enqueue)
    // and emits notification:enqueued on success. Assert that emit is
    // called with the canonical event names per pipeline outcome.
    const { deps, deliveryQueue, eventBus } = makeDeps();
    deps.activeAdapterTypes = new Set<string>(["discord"]);

    const ctx = setupNotifications(deps);
    const result = await ctx.notificationService.notifyUser({
      agentId: "agent-x",
      message: "hello world",
      priority: "normal",
      channelType: "discord",
      channelId: "discord-test-channel-1",
      ...deliveryFields("agent-x", "discord-test-channel-1"),
    });

    expect(result.ok).toBe(true);
    expect(deliveryQueue.enqueueCalls).toHaveLength(1);
    const emitMock = eventBus.emit as unknown as ReturnType<typeof vi.fn>;
    const enqueuedEmits = emitMock.mock.calls.filter(
      (c: unknown[]) => c[0] === "notification:enqueued",
    );
    expect(enqueuedEmits).toHaveLength(1);
    // Event payload must carry agentId + channel info so observability paths
    // can index by agent.
    const payload = enqueuedEmits[0]![1] as { agentId: string; channelType: string; channelId: string };
    expect(payload.agentId).toBe("agent-x");
    expect(payload.channelType).toBe("discord");
    expect(payload.channelId).toBe("discord-test-channel-1");
  });

  it("criticalBypass=true skips the quiet-hours filter for critical-priority events", async () => {
    // Pin Date.now to 02:00 UTC -- inside the quiet window 22:00-07:00 UTC.
    // With criticalBypass=true and priority=critical, the notification must
    // schedule for immediate delivery (scheduledAt === now), NOT deferred.
    // Date(2026, 4, 15, 02, 0, 0) UTC == epoch 1779120000000.
    const fixedUtcMs = Date.UTC(2026, 4, 15, 2, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(fixedUtcMs);

    const { deps, deliveryQueue, eventBus } = makeDeps({
      quietHoursConfig: {
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone: "UTC",
      },
      criticalBypass: true,
    });
    deps.activeAdapterTypes = new Set<string>(["discord"]);

    const ctx = setupNotifications(deps);
    const result = await ctx.notificationService.notifyUser({
      agentId: "agent-critical",
      message: "urgent",
      priority: "critical",
      channelType: "discord",
      channelId: "discord-test-channel-1",
      ...deliveryFields("agent-critical", "discord-test-channel-1"),
    });

    expect(result.ok).toBe(true);
    expect(deliveryQueue.enqueueCalls).toHaveLength(1);
    // criticalBypass: scheduledAt === now (not deferred to end-of-quiet).
    expect(deliveryQueue.enqueueCalls[0]!.scheduledAt).toBe(fixedUtcMs);
    // And no notification:suppressed/quiet_hours emit -- the filter was
    // bypassed entirely.
    const emitMock = eventBus.emit as unknown as ReturnType<typeof vi.fn>;
    const suppressedEmits = emitMock.mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "notification:suppressed" &&
        (c[1] as { reason?: string })?.reason === "quiet_hours",
    );
    expect(suppressedEmits).toHaveLength(0);
  });

  it("quietHoursConfig.timezone is applied when classifying current-time-in-quiet-window", async () => {
    // Pin Date.now to a fixed UTC instant where two different timezones
    // yield different quiet-window classifications.
    // 2026-05-15T03:00:00Z -- America/New_York (UTC-4 DST) = 23:00 (inside
    // quiet hours 22:00-07:00), Asia/Tokyo (UTC+9) = 12:00 (outside).
    const fixedUtcMs = Date.UTC(2026, 4, 15, 3, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(fixedUtcMs);

    const quietConfig = (timezone: string) =>
      ({
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone,
      });

    const setupForTz = (timezone: string) => {
      const { deps, deliveryQueue, eventBus } = makeDeps({
        quietHoursConfig: quietConfig(timezone),
        criticalBypass: false,
      });
      deps.activeAdapterTypes = new Set<string>(["discord"]);
      const ctx = setupNotifications(deps);
      return { ctx, deliveryQueue, eventBus };
    };

    const nyc = setupForTz("America/New_York");
    const tokyo = setupForTz("Asia/Tokyo");

    await nyc.ctx.notificationService.notifyUser({
      agentId: "agent-1",
      message: "evening msg",
      channelType: "discord",
      channelId: "discord-test-channel-1",
      ...deliveryFields("agent-1", "discord-test-channel-1"),
    });
    await tokyo.ctx.notificationService.notifyUser({
      agentId: "agent-1",
      message: "midday msg",
      channelType: "discord",
      channelId: "discord-test-channel-1",
      ...deliveryFields("agent-1", "discord-test-channel-1"),
    });

    // NYC at 23:00 -- inside the 22:00-07:00 window -> deferred to end-of-quiet.
    expect(nyc.deliveryQueue.enqueueCalls).toHaveLength(1);
    expect(nyc.deliveryQueue.enqueueCalls[0]!.scheduledAt).toBeGreaterThan(fixedUtcMs);

    // Tokyo at 12:00 -- outside the window -> immediate delivery.
    expect(tokyo.deliveryQueue.enqueueCalls).toHaveLength(1);
    expect(tokyo.deliveryQueue.enqueueCalls[0]!.scheduledAt).toBe(fixedUtcMs);
  });

  it("empty notification config produces a no-op dispatcher (no throws on dispatch)", async () => {
    // agents={} -- no per-agent notification configs at all. notifyUser
    // should fall back to defaultConfig (enabled=true, maxPerHour=30) and
    // not throw. This is the daemon-startup-with-no-agents-yet path.
    const { deps, deliveryQueue } = makeDeps({ agents: {} });
    deps.activeAdapterTypes = new Set<string>(["discord"]);

    const ctx = setupNotifications(deps);
    // Service surface contract: notifyUser exists and resolves to a Result.
    expect(typeof ctx.notificationService.notifyUser).toBe("function");

    // Calling without any channel hint should land on "no_channel" error
    // (rejected gracefully via the channel resolver) rather than throwing.
    const result = await ctx.notificationService.notifyUser({
      agentId: "unknown-agent",
      message: "hello",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either "no channel" (resolver fell through all 4 levels) or
      // "disabled" -- both are graceful refusals, not throws.
      expect(result.error.message.length).toBeGreaterThan(0);
    }
    expect(deliveryQueue.enqueueCalls).toHaveLength(0);
  });
});
