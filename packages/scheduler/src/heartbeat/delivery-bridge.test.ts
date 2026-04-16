import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverHeartbeatNotification } from "./delivery-bridge.js";
import type {
  DeliveryBridgeDeps,
  DeliveryTarget,
} from "./delivery-bridge.js";
import type { HeartbeatNotification } from "./heartbeat-runner.js";
import { ok, err } from "@comis/shared";

// ---------------------------------------------------------------------------
// Helpers
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
  return { emit: vi.fn() } as unknown as DeliveryBridgeDeps["eventBus"];
}

function makeAdapter(overrides?: Record<string, unknown>) {
  return {
    channelId: "discord-1",
    channelType: "discord",
    sendMessage: vi.fn().mockResolvedValue(ok("msg-123")),
    getStatus: vi.fn().mockReturnValue({ connected: true, channelId: "discord-1", channelType: "discord" }),
    ...overrides,
  };
}

function makeDuplicateDetector(isDuplicate = false) {
  return {
    isDuplicate: vi.fn().mockReturnValue(isDuplicate),
    clear: vi.fn(),
  };
}

function makeTarget(overrides?: Partial<DeliveryTarget>): DeliveryTarget {
  return {
    channelType: "discord",
    channelId: "discord-1",
    chatId: "chat-123",
    ...overrides,
  };
}

function makeNotification(overrides?: Partial<HeartbeatNotification>): HeartbeatNotification {
  return {
    sourceId: "source-1",
    sourceName: "CPU Monitor",
    text: "CPU at 90%",
    level: "alert",
    timestamp: 1000,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<DeliveryBridgeDeps>): DeliveryBridgeDeps {
  const adapter = makeAdapter();
  return {
    adaptersByType: new Map([["discord", adapter as unknown as DeliveryBridgeDeps["adaptersByType"] extends ReadonlyMap<string, infer V> ? V : never]]),
    duplicateDetector: makeDuplicateDetector(),
    eventBus: makeEventBus(),
    logger: makeLogger(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverHeartbeatNotification", () => {
  let deps: DeliveryBridgeDeps;
  let target: DeliveryTarget;
  let notification: HeartbeatNotification;

  beforeEach(() => {
    deps = makeDeps();
    target = makeTarget();
    notification = makeNotification();
  });

  it("delivers successfully when all gates pass", async () => {
    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.messageId).toBe("msg-123");
    }

    // Verify adapter.sendMessage was called with chatId and text
    const adapter = deps.adaptersByType.get("discord")!;
    expect(adapter.sendMessage).toHaveBeenCalledWith("chat-123", "CPU at 90%");

    // Verify event emitted
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:heartbeat_delivered",
      expect.objectContaining({ outcome: "delivered" }),
    );

    // Verify info log
    expect(deps.logger.info).toHaveBeenCalled();
  });

  it("skips with reason 'no-adapter' when channelType not found", async () => {
    target = makeTarget({ channelType: "telegram" });

    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("no-adapter");
    }

    // Warn logged with hint and errorKind
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ hint: expect.any(String), errorKind: "config" }),
      expect.any(String),
    );
  });

  it("skips with reason 'channel-not-ready' when adapter reports disconnected", async () => {
    const adapter = makeAdapter({
      getStatus: vi.fn().mockReturnValue({ connected: false, channelId: "discord-1", channelType: "discord" }),
    });
    deps = makeDeps({
      adaptersByType: new Map([["discord", adapter as unknown as DeliveryBridgeDeps["adaptersByType"] extends ReadonlyMap<string, infer V> ? V : never]]),
    });

    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("channel-not-ready");
    }

    expect(deps.logger.debug).toHaveBeenCalled();
  });

  it("proceeds when adapter has no getStatus method (graceful fallback)", async () => {
    const adapter = makeAdapter({ getStatus: undefined });
    deps = makeDeps({
      adaptersByType: new Map([["discord", adapter as unknown as DeliveryBridgeDeps["adaptersByType"] extends ReadonlyMap<string, infer V> ? V : never]]),
    });

    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("delivered");
  });

  it("skips with 'visibility-filtered' when showOk=false for ok notification", async () => {
    notification = makeNotification({ level: "ok" });

    const result = await deliverHeartbeatNotification(deps, target, notification, {
      agentId: "agent-1",
      visibility: { showOk: false },
    });

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("visibility-filtered");
    }
  });

  it("skips with 'visibility-filtered' when showAlerts=false for alert notification", async () => {
    notification = makeNotification({ level: "alert" });

    const result = await deliverHeartbeatNotification(deps, target, notification, {
      agentId: "agent-1",
      visibility: { showAlerts: false },
    });

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("visibility-filtered");
    }
  });

  it("proceeds when no visibility config is provided (no filtering)", async () => {
    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("delivered");
  });

  it("skips with 'duplicate' when duplicateDetector reports duplicate", async () => {
    deps = makeDeps({
      duplicateDetector: makeDuplicateDetector(true),
    });

    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("duplicate");
    }
  });

  it("returns 'failed' when adapter.sendMessage returns err", async () => {
    const adapter = makeAdapter({
      sendMessage: vi.fn().mockResolvedValue(err(new Error("Connection reset"))),
    });
    deps = makeDeps({
      adaptersByType: new Map([["discord", adapter as unknown as DeliveryBridgeDeps["adaptersByType"] extends ReadonlyMap<string, infer V> ? V : never]]),
    });

    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("Connection reset");
    }

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:heartbeat_delivered",
      expect.objectContaining({ outcome: "failed" }),
    );
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it("skips with 'dm-blocked' when allowDm=false and isDm=true", async () => {
    const result = await deliverHeartbeatNotification(deps, target, notification, {
      agentId: "agent-1",
      allowDm: false,
      isDm: true,
    });

    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("dm-blocked");
    }
  });

  it("delivers when allowDm is undefined and isDm=true (default allows DMs)", async () => {
    const result = await deliverHeartbeatNotification(deps, target, notification, {
      agentId: "agent-1",
      isDm: true,
    });

    expect(result.status).toBe("delivered");
  });

  it("emits event with correct payload shape", async () => {
    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });
    expect(result.status).toBe("delivered");

    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:heartbeat_delivered",
      expect.objectContaining({
        agentId: "agent-1",
        channelType: "discord",
        channelId: "discord-1",
        chatId: "chat-123",
        level: "alert",
        outcome: "delivered",
        durationMs: expect.any(Number),
        timestamp: expect.any(Number),
      }),
    );
  });

  it("passes compound dedup key containing agentId and channel info", async () => {
    await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(deps.duplicateDetector.isDuplicate).toHaveBeenCalledWith(
      "agent-1:discord:chat-123",
      "CPU at 90%",
    );
  });

  // ---- Critical notification visibility ----

  it("proceeds to delivery for critical notification when showAlerts=false (visibility only filters 'alert')", async () => {
    notification = makeNotification({ level: "critical" as HeartbeatNotification["level"] });

    const result = await deliverHeartbeatNotification(deps, target, notification, {
      agentId: "agent-1",
      visibility: { showAlerts: false },
    });

    // "critical" is not "alert", so the visibility filter should NOT match.
    // The notification should proceed to delivery.
    expect(result.status).toBe("delivered");
  });

  it("defaults agentId to 'unknown' when options.agentId is not provided", async () => {
    const result = await deliverHeartbeatNotification(deps, target, notification);

    expect(result.status).toBe("delivered");

    // Verify the emitted event uses "unknown" as agentId
    expect(deps.eventBus.emit).toHaveBeenCalledWith(
      "scheduler:heartbeat_delivered",
      expect.objectContaining({ agentId: "unknown" }),
    );

    // Verify the dedup key uses "unknown"
    expect(deps.duplicateDetector.isDuplicate).toHaveBeenCalledWith(
      "unknown:discord:chat-123",
      "CPU at 90%",
    );
  });

  it("coerces non-Error sendResult.error to string", async () => {
    const adapter = makeAdapter({
      sendMessage: vi.fn().mockResolvedValue(err("string-error")),
    });
    deps = makeDeps({
      adaptersByType: new Map([["discord", adapter as unknown as DeliveryBridgeDeps["adaptersByType"] extends ReadonlyMap<string, infer V> ? V : never]]),
    });

    const result = await deliverHeartbeatNotification(deps, target, notification, { agentId: "agent-1" });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("string-error");
    }
  });
});
