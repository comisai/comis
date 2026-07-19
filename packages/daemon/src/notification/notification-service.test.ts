// SPDX-License-Identifier: Apache-2.0
/**
 * Notification service tests: full guard pipeline for proactive notifications.
 * Tests cover: config check, channel resolution, quiet hours with deferred scheduling,
 * rate limiting, deduplication, event emission, and delivery queue enqueue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConversationRef, TypedEventBus } from "@comis/core";
import { ok, err } from "@comis/shared";
import type { DeliveryQueuePort, DeliveryQueueEnqueueInput, NotificationConfig } from "@comis/core";
import type { QuietHoursConfig } from "@comis/scheduler";
import { createNotificationService as createRawNotificationService, resolveNotificationDestination } from "./notification-service.js";
import type { NotificationService, NotificationServiceDeps, NotifyUserOptions } from "./notification-service.js";
import type { ChannelResolverDeps } from "./channel-resolver.js";

function createMockDeliveryQueue(): DeliveryQueuePort {
  return {
    enqueue: vi.fn(async (_entry: DeliveryQueueEnqueueInput) => ok("entry-123")),
    enqueueInFlight: vi.fn(async (_entry: DeliveryQueueEnqueueInput) => ok("entry-123")),
    claim: vi.fn(async () => ok(true)),
    ack: vi.fn(async () => ok(undefined)),
    nack: vi.fn(async () => ok(undefined)),
    fail: vi.fn(async () => ok(undefined)),
    pendingEntries: vi.fn(async () => ok([])),
    unconfirmedEntries: vi.fn(async () => ok([])),
    pruneExpired: vi.fn(async () => ok(0)),
    statusCounts: vi.fn(async () =>
      ok({ pending: 0, inFlight: 0, failed: 0, delivered: 0, expired: 0 }),
    ),
    recoverInFlight: vi.fn(async () => ok(0)),
  };
}

function createDefaultDeps(overrides?: Partial<NotificationServiceDeps>): NotificationServiceDeps {
  const eventBus = new TypedEventBus();
  const defaultConfig: NotificationConfig = {
    enabled: true,
    maxPerHour: 30,
    dedupeWindowMs: 300_000,
    maxChainDepth: 0,
  };

  const channelResolverDeps: ChannelResolverDeps = {
    activeAdapterTypes: new Set(["telegram", "discord"]),
    getRecentSessionChannel: () => "chat-456",
    getMostRecentSession: () => ({ channelType: "telegram", channelId: "chat-456" }),
  };

  const quietHoursConfig: QuietHoursConfig = {
    enabled: false,
    start: "22:00",
    end: "07:00",
    timezone: "UTC",
  };

  return {
    eventBus,
    deliveryQueue: createMockDeliveryQueue(),
    quietHoursConfig,
    criticalBypass: true,
    notificationConfigs: new Map(),
    defaultConfig,
    channelResolverDeps,
    // The resolved adapter's instance id per channel type (ingress-consistent).
    resolveChannelInstanceId: (channelType: string) =>
      channelType === "telegram" ? "telegram-account"
      : channelType === "discord" ? "discord-account"
      : undefined,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    nowMs: () => 1_700_000_000_000,
    tenantId: "default",
    ...overrides,
  };
}

function createNotificationService(deps: NotificationServiceDeps): NotificationService {
  const service = createRawNotificationService(deps);
  return {
    // Delegate resolveDestination to the real service (it mints from deps.tenantId
    // + the resolution chain); only notifyUser is wrapped to auto-mint for the
    // existing enqueue-behavior tests below.
    ...service,
    notifyUser(opts: NotifyUserOptions) {
      const endpoint = {
        channelType: opts.channelType ?? "telegram",
        channelInstanceId: "notification-test",
        conversationId: opts.channelId ?? "chat-456",
        conversationKind: "direct" as const,
      };
      const conversationRef = createConversationRef({
        tenantId: "default",
        agentId: opts.agentId,
        partition: { kind: "endpoint-conversation", endpoint },
      });
      if (!conversationRef.ok) throw conversationRef.error;
      return service.notifyUser({
        authority: {
          tenantId: "default",
          agentId: opts.agentId,
          conversationRef: conversationRef.value,
        },
        destinationEndpoint: endpoint,
        ...opts,
      });
    },
  };
}

describe("NotificationService", () => {
  let deps: NotificationServiceDeps;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    deps = createDefaultDeps();
    emitSpy = vi.spyOn(deps.eventBus, "emit");
  });

  it("happy path: all guards pass, enqueue called, notification:enqueued emitted, returns ok with entry ID", async () => {
    const service = createNotificationService(deps);
    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "Hello!",
      channelType: "telegram",
      channelId: "chat-123",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("entry-123");
    }

    expect(deps.deliveryQueue.enqueue).toHaveBeenCalledOnce();
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:enqueued",
      expect.objectContaining({
        agentId: "agent-1",
        channelType: "telegram",
        channelId: "chat-123",
        priority: "normal",
        origin: "notification",
      }),
    );
  });

  it("refuses a resolved channel that differs from the bound destination endpoint", async () => {
    const service = createRawNotificationService(deps);
    const endpoint = {
      channelType: "telegram",
      channelInstanceId: "notification-test",
      conversationId: "chat-bound",
      conversationKind: "direct" as const,
    };
    const ref = createConversationRef({
      tenantId: "default",
      agentId: "agent-1",
      partition: { kind: "endpoint-conversation", endpoint },
    });
    if (!ref.ok) throw ref.error;

    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "must not cross routes",
      channelType: "discord",
      channelId: "chat-other",
      authority: { tenantId: "default", agentId: "agent-1", conversationRef: ref.value },
      destinationEndpoint: endpoint,
    });

    expect(result.ok).toBe(false);
    expect(deps.deliveryQueue.enqueue).not.toHaveBeenCalled();
  });

  it("channel resolution fails: returns err, notification:suppressed emitted with reason no_channel", async () => {
    deps = createDefaultDeps({
      channelResolverDeps: {
        activeAdapterTypes: new Set(),
        getRecentSessionChannel: () => undefined,
        getMostRecentSession: () => undefined,
      },
    });
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);
    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "Hello!",
    });

    expect(result.ok).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:suppressed",
      expect.objectContaining({
        agentId: "agent-1",
        reason: "no_channel",
      }),
    );
    // The error must name the resolution ladder it walked and the knob that
    // fixes it — not just the symptom.
    if (!result.ok) {
      expect(result.error.message).toContain("tried:");
      expect(result.error.message).toContain("recent_session");
      expect(result.error.message).toContain("notification.primaryChannel");
      expect(result.error.message).toContain("channel_type");
    }
  });

  it("quiet hours active + priority normal: suppressed event emitted, enqueue called with future scheduledAt", async () => {
    deps = createDefaultDeps({
      quietHoursConfig: {
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone: "UTC",
      },
      // Set clock to 23:00 UTC (within quiet hours 22:00-07:00)
      nowMs: () => {
        const d = new Date("2026-04-06T23:00:00Z");
        return d.getTime();
      },
    });
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);
    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "Hello!",
      channelType: "telegram",
      channelId: "chat-123",
    });

    // Should still enqueue (deferred)
    expect(result.ok).toBe(true);
    expect(deps.deliveryQueue.enqueue).toHaveBeenCalledOnce();

    // Verify scheduledAt is in the future (at quiet hours end)
    const enqueueCall = vi.mocked(deps.deliveryQueue.enqueue).mock.calls[0]![0];
    expect(enqueueCall.scheduledAt).toBeGreaterThan(new Date("2026-04-06T23:00:00Z").getTime());

    // Suppressed event emitted for quiet hours
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:suppressed",
      expect.objectContaining({
        agentId: "agent-1",
        reason: "quiet_hours",
      }),
    );
  });

  it("quiet hours active + priority critical + criticalBypass=true: bypasses quiet hours, enqueue immediately", async () => {
    deps = createDefaultDeps({
      quietHoursConfig: {
        enabled: true,
        start: "22:00",
        end: "07:00",
        timezone: "UTC",
      },
      criticalBypass: true,
      nowMs: () => new Date("2026-04-06T23:00:00Z").getTime(),
    });
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);
    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "CRITICAL!",
      priority: "critical",
      channelType: "telegram",
      channelId: "chat-123",
    });

    expect(result.ok).toBe(true);
    expect(deps.deliveryQueue.enqueue).toHaveBeenCalledOnce();

    // scheduledAt should equal nowMs (immediate delivery)
    const enqueueCall = vi.mocked(deps.deliveryQueue.enqueue).mock.calls[0]![0];
    expect(enqueueCall.scheduledAt).toBe(new Date("2026-04-06T23:00:00Z").getTime());

    // notification:enqueued emitted, NOT suppressed
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:enqueued",
      expect.objectContaining({ agentId: "agent-1", priority: "critical" }),
    );
    expect(emitSpy).not.toHaveBeenCalledWith(
      "notification:suppressed",
      expect.anything(),
    );
  });

  it("rate limit exceeded: returns err, notification:suppressed emitted with reason rate_limited", async () => {
    deps = createDefaultDeps({
      // Set maxPerHour to 1 so second call is rate-limited
    });
    deps.defaultConfig = { ...deps.defaultConfig, maxPerHour: 1 };
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);

    // First call consumes the rate limit
    await service.notifyUser({
      agentId: "agent-1",
      message: "First",
      channelType: "telegram",
      channelId: "chat-123",
    });

    // Second call should be rate-limited
    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "Second",
      channelType: "telegram",
      channelId: "chat-123",
    });

    expect(result.ok).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:suppressed",
      expect.objectContaining({
        agentId: "agent-1",
        reason: "rate_limited",
      }),
    );
  });

  it("duplicate message within window: returns err, notification:suppressed emitted with reason duplicate", async () => {
    deps = createDefaultDeps();
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);

    // First call succeeds
    await service.notifyUser({
      agentId: "agent-1",
      message: "Same message",
      channelType: "telegram",
      channelId: "chat-123",
    });

    // Second identical call is a duplicate
    const result = await service.notifyUser({
      agentId: "agent-1",
      message: "Same message",
      channelType: "telegram",
      channelId: "chat-123",
    });

    expect(result.ok).toBe(false);
    expect(emitSpy).toHaveBeenCalledWith(
      "notification:suppressed",
      expect.objectContaining({
        agentId: "agent-1",
        reason: "duplicate",
      }),
    );
  });

  it("dedup key includes agentId + channelType + channelId + message: same message to different channels is NOT duplicate", async () => {
    deps = createDefaultDeps();
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);

    // Send to telegram
    const result1 = await service.notifyUser({
      agentId: "agent-1",
      message: "Same message",
      channelType: "telegram",
      channelId: "chat-123",
    });
    expect(result1.ok).toBe(true);

    // Send same message to discord -- different channel, should NOT be duplicate
    const result2 = await service.notifyUser({
      agentId: "agent-1",
      message: "Same message",
      channelType: "discord",
      channelId: "dc-456",
    });
    expect(result2.ok).toBe(true);
    expect(deps.deliveryQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("notifyUser called with origin sets origin on DeliveryQueueEnqueueInput", async () => {
    deps = createDefaultDeps();
    const service = createNotificationService(deps);

    await service.notifyUser({
      agentId: "agent-1",
      message: "Hello!",
      channelType: "telegram",
      channelId: "chat-123",
      origin: "heartbeat",
    });

    const enqueueCall = vi.mocked(deps.deliveryQueue.enqueue).mock.calls[0]![0];
    expect(enqueueCall.origin).toBe("heartbeat");
  });

  it("maxChainDepth=0 marks notification origin in optionsJson for chain-depth guard", async () => {
    deps = createDefaultDeps();
    const service = createNotificationService(deps);

    await service.notifyUser({
      agentId: "agent-1",
      message: "Hello!",
      channelType: "telegram",
      channelId: "chat-123",
    });

    const enqueueCall = vi.mocked(deps.deliveryQueue.enqueue).mock.calls[0]![0];
    const opts = JSON.parse(enqueueCall.optionsJson) as { origin: string; chainDepth: number };
    expect(opts.origin).toBe("notification");
    expect(opts.chainDepth).toBe(0);
  });

  it("disabled=false (notification disabled for agent) returns err immediately", async () => {
    deps = createDefaultDeps({
      notificationConfigs: new Map([
        ["agent-disabled", { enabled: false, maxPerHour: 30, dedupeWindowMs: 300_000, maxChainDepth: 0 }],
      ]),
    });
    emitSpy = vi.spyOn(deps.eventBus, "emit");

    const service = createNotificationService(deps);
    const result = await service.notifyUser({
      agentId: "agent-disabled",
      message: "Hello!",
      channelType: "telegram",
      channelId: "chat-123",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("disabled");
    }
    // No enqueue, no events
    expect(deps.deliveryQueue.enqueue).not.toHaveBeenCalled();
  });
});

describe("resolveNotificationDestination — the mint helper", () => {
  function mintDeps(overrides?: Partial<NotificationServiceDeps>) {
    const d = createDefaultDeps(overrides);
    return {
      channelResolverDeps: d.channelResolverDeps,
      notificationConfigs: d.notificationConfigs,
      defaultConfig: d.defaultConfig,
      resolveChannelInstanceId: d.resolveChannelInstanceId,
    };
  }

  it("explicit channel: mints authority (tenant/agent) + a matching endpoint, deterministically", () => {
    const r = resolveNotificationDestination(mintDeps(), {
      tenantId: "default",
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chat-42",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.authority.tenantId).toBe("default");
    expect(r.value.authority.agentId).toBe("agent-1");
    // The endpoint mirrors the resolved channel — this is what notifyUser
    // cross-checks (channelType + conversationId) at send time.
    expect(r.value.destinationEndpoint.channelType).toBe("telegram");
    expect(r.value.destinationEndpoint.conversationId).toBe("chat-42");
    // channelInstanceId is the RESOLVED ADAPTER's instance id (ingress-consistent),
    // not the conversation id or a sentinel.
    expect(r.value.destinationEndpoint.channelInstanceId).toBe("telegram-account");
    // Deterministic per (tenant, agent, channelType, channelId) — never random.
    const again = resolveNotificationDestination(mintDeps(), {
      tenantId: "default",
      agentId: "agent-1",
      channelType: "telegram",
      channelId: "chat-42",
    });
    expect(again.ok && again.value.authority.conversationRef).toBe(r.value.authority.conversationRef);
  });

  it("primaryChannel fallback: resolves the agent's configured primary channel when none is passed", () => {
    const configs = new Map<string, NotificationConfig>([
      [
        "agent-1",
        {
          enabled: true,
          maxPerHour: 30,
          dedupeWindowMs: 300_000,
          maxChainDepth: 0,
          primaryChannel: { channelType: "discord", channelId: "guild-7" },
        },
      ],
    ]);
    const r = resolveNotificationDestination(mintDeps({ notificationConfigs: configs }), {
      tenantId: "default",
      agentId: "agent-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.destinationEndpoint.channelType).toBe("discord");
    expect(r.value.destinationEndpoint.conversationId).toBe("guild-7");
    expect(r.value.destinationEndpoint.channelInstanceId).toBe("discord-account");
  });

  it("no registered adapter: channelInstanceId falls back to the resolved channel id", () => {
    // "signal" has no adapter → resolveChannelInstanceId returns undefined.
    const r = resolveNotificationDestination(mintDeps(), {
      tenantId: "default",
      agentId: "agent-1",
      channelType: "signal",
      channelId: "sig-9",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.destinationEndpoint.channelInstanceId).toBe("sig-9");
    expect(r.value.destinationEndpoint.conversationId).toBe("sig-9");
  });

  it("no channel resolvable: propagates the resolver error verbatim", () => {
    const noChannel = {
      channelResolverDeps: {
        activeAdapterTypes: new Set<string>(),
        getRecentSessionChannel: () => undefined,
        getMostRecentSession: () => undefined,
      },
      notificationConfigs: new Map<string, NotificationConfig>(),
      defaultConfig: { enabled: true, maxPerHour: 30, dedupeWindowMs: 300_000, maxChainDepth: 0 } as NotificationConfig,
      resolveChannelInstanceId: () => undefined,
    };
    const r = resolveNotificationDestination(noChannel, { tenantId: "default", agentId: "agent-1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("No channel resolved");
  });
});

describe("notifyUser authority guard (unwrapped service)", () => {
  it("rejects a bare call with no authority (the invariant that keeps callers honest)", async () => {
    const service = createRawNotificationService(createDefaultDeps());
    const r = await service.notifyUser({
      agentId: "agent-1",
      message: "hi",
      channelType: "telegram",
      channelId: "chat-42",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("explicit matching authority");
  });

  it("rejects when authority.agentId does not match the notified agentId", async () => {
    const service = createRawNotificationService(createDefaultDeps());
    const dest = service.resolveDestination({ agentId: "agent-1", channelType: "telegram", channelId: "chat-42" });
    expect(dest.ok).toBe(true);
    if (!dest.ok) return;
    const r = await service.notifyUser({
      agentId: "different-agent",
      message: "hi",
      channelType: "telegram",
      channelId: "chat-42",
      authority: dest.value.authority,
      destinationEndpoint: dest.value.destinationEndpoint,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("explicit matching authority");
  });
});
