import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupDeliveryQueueLogging } from "./delivery-queue-logger.js";

// ---------------------------------------------------------------------------
// Mock EventBus: capture .on() registrations and allow manual emit
// ---------------------------------------------------------------------------

type HandlerFn = (data: Record<string, unknown>) => void;

function createMockEventBus() {
  const handlers = new Map<string, HandlerFn[]>();

  return {
    on(event: string, handler: HandlerFn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    emit(event: string, data: Record<string, unknown>) {
      for (const h of handlers.get(event) ?? []) h(data);
    },
    registeredEvents(): string[] {
      return [...handlers.keys()];
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Logger: capture .info() and .warn() calls
// ---------------------------------------------------------------------------

function createMockChildLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info",
  };
}

function createMockLogger(childLogger: ReturnType<typeof createMockChildLogger>) {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnValue(childLogger),
    level: "info",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setupDeliveryQueueLogging", () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logger: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let childLog: any;

  beforeEach(() => {
    eventBus = createMockEventBus();
    childLog = createMockChildLogger();
    logger = createMockLogger(childLog);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setupDeliveryQueueLogging({ eventBus: eventBus as any, logger });
  });

  it("subscribes to all 7 delivery queue events", () => {
    const events = eventBus.registeredEvents();
    expect(events).toContain("delivery:enqueued");
    expect(events).toContain("delivery:acked");
    expect(events).toContain("delivery:nacked");
    expect(events).toContain("delivery:failed");
    expect(events).toContain("delivery:queue_drained");
    expect(events).toContain("delivery:hook_cancelled");
    expect(events).toContain("delivery:aborted");
    expect(events).toHaveLength(7);
  });

  // -------------------------------------------------------------------------
  // delivery:enqueued -> INFO
  // -------------------------------------------------------------------------

  describe("delivery:enqueued", () => {
    it("logs at INFO with canonical fields", () => {
      eventBus.emit("delivery:enqueued", {
        entryId: "entry-1",
        channelId: "ch-123",
        channelType: "telegram",
        origin: "agent-response",
        timestamp: Date.now(),
      });

      expect(childLog.info).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.info.mock.calls[0];
      expect(msg).toBe("Message enqueued for delivery");
      expect(fields).toMatchObject({
        entryId: "entry-1",
        channelType: "telegram",
        channelId: "ch-123",
        origin: "agent-response",
      });
    });
  });

  // -------------------------------------------------------------------------
  // delivery:acked -> INFO
  // -------------------------------------------------------------------------

  describe("delivery:acked", () => {
    it("logs at INFO with canonical fields including durationMs", () => {
      eventBus.emit("delivery:acked", {
        entryId: "entry-2",
        channelId: "ch-456",
        channelType: "discord",
        messageId: "msg-789",
        durationMs: 142,
        timestamp: Date.now(),
      });

      expect(childLog.info).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.info.mock.calls[0];
      expect(msg).toBe("Message delivered and acked");
      expect(fields).toMatchObject({
        entryId: "entry-2",
        channelType: "discord",
        channelId: "ch-456",
        messageId: "msg-789",
        durationMs: 142,
      });
    });
  });

  // -------------------------------------------------------------------------
  // delivery:nacked -> WARN with hint + errorKind
  // -------------------------------------------------------------------------

  describe("delivery:nacked", () => {
    it("logs at WARN with hint and errorKind", () => {
      const nextRetry = Date.now() + 5000;
      eventBus.emit("delivery:nacked", {
        entryId: "entry-3",
        channelId: "ch-100",
        channelType: "slack",
        error: "Request timeout",
        attemptCount: 2,
        nextRetryAt: nextRetry,
        timestamp: Date.now(),
      });

      expect(childLog.warn).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.warn.mock.calls[0];
      expect(msg).toBe("Message delivery failed, scheduled for retry");
      expect(fields).toMatchObject({
        entryId: "entry-3",
        channelType: "slack",
        channelId: "ch-100",
        err: "Request timeout",
        attemptCount: 2,
        nextRetryAt: nextRetry,
        hint: "Message will be retried on next drain cycle",
        errorKind: "transient",
      });
    });
  });

  // -------------------------------------------------------------------------
  // delivery:failed -> WARN with hint + errorKind
  // -------------------------------------------------------------------------

  describe("delivery:failed", () => {
    it("logs at WARN with hint and errorKind", () => {
      eventBus.emit("delivery:failed", {
        entryId: "entry-4",
        channelId: "ch-200",
        channelType: "telegram",
        error: "chat not found",
        reason: "permanent_error",
        timestamp: Date.now(),
      });

      expect(childLog.warn).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.warn.mock.calls[0];
      expect(msg).toBe("Message delivery permanently failed");
      expect(fields).toMatchObject({
        entryId: "entry-4",
        channelType: "telegram",
        channelId: "ch-200",
        err: "chat not found",
        reason: "permanent_error",
        hint: "Message permanently failed -- check channel configuration or error patterns",
        errorKind: "permanent",
      });
    });

    it("includes reason field for retries_exhausted", () => {
      eventBus.emit("delivery:failed", {
        entryId: "entry-5",
        channelId: "ch-300",
        channelType: "whatsapp",
        error: "Internal Server Error",
        reason: "retries_exhausted",
        timestamp: Date.now(),
      });

      const [fields] = childLog.warn.mock.calls[0];
      expect(fields.reason).toBe("retries_exhausted");
    });
  });

  // -------------------------------------------------------------------------
  // delivery:queue_drained -> INFO
  // -------------------------------------------------------------------------

  describe("delivery:queue_drained", () => {
    it("logs at INFO with drain statistics", () => {
      eventBus.emit("delivery:queue_drained", {
        entriesAttempted: 10,
        entriesDelivered: 8,
        entriesFailed: 2,
        durationMs: 3500,
        timestamp: Date.now(),
      });

      expect(childLog.info).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.info.mock.calls[0];
      expect(msg).toBe("Delivery queue startup drain complete");
      expect(fields).toMatchObject({
        entriesAttempted: 10,
        entriesDelivered: 8,
        entriesFailed: 2,
        durationMs: 3500,
      });
    });
  });

  // -------------------------------------------------------------------------
  // delivery:hook_cancelled -> INFO
  // -------------------------------------------------------------------------

  describe("delivery:hook_cancelled", () => {
    it("logs at INFO with canonical fields", () => {
      eventBus.emit("delivery:hook_cancelled", {
        channelId: "ch-500",
        channelType: "telegram",
        reason: "content_policy_violation",
        origin: "agent-response",
        timestamp: Date.now(),
      });

      expect(childLog.info).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.info.mock.calls[0];
      expect(msg).toBe("Delivery cancelled by before_delivery hook");
      expect(fields).toMatchObject({
        channelId: "ch-500",
        channelType: "telegram",
        reason: "content_policy_violation",
        origin: "agent-response",
      });
    });
  });

  // -------------------------------------------------------------------------
  // delivery:aborted -> INFO
  // -------------------------------------------------------------------------

  describe("delivery:aborted", () => {
    it("logs at INFO with chunksDelivered, totalChunks, durationMs, reason", () => {
      eventBus.emit("delivery:aborted", {
        channelId: "ch-600",
        channelType: "telegram",
        reason: "User sent /stop",
        chunksDelivered: 2,
        totalChunks: 5,
        durationMs: 1200,
        origin: "agent-response",
        timestamp: Date.now(),
      });

      expect(childLog.info).toHaveBeenCalledTimes(1);
      const [fields, msg] = childLog.info.mock.calls[0];
      expect(msg).toBe("Delivery aborted");
      expect(fields).toMatchObject({
        channelId: "ch-600",
        channelType: "telegram",
        reason: "User sent /stop",
        chunksDelivered: 2,
        totalChunks: 5,
        durationMs: 1200,
        origin: "agent-response",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: WARN events require hint and errorKind
  // -------------------------------------------------------------------------

  describe("logging rules compliance", () => {
    it("nack includes hint and errorKind (required on WARN)", () => {
      eventBus.emit("delivery:nacked", {
        entryId: "e", channelId: "c", channelType: "t",
        error: "timeout", attemptCount: 1, nextRetryAt: 0, timestamp: 0,
      });
      const [fields] = childLog.warn.mock.calls[0];
      expect(fields).toHaveProperty("hint");
      expect(fields).toHaveProperty("errorKind");
    });

    it("fail includes hint and errorKind (required on WARN)", () => {
      eventBus.emit("delivery:failed", {
        entryId: "e", channelId: "c", channelType: "t",
        error: "chat not found", reason: "permanent_error", timestamp: 0,
      });
      const [fields] = childLog.warn.mock.calls[0];
      expect(fields).toHaveProperty("hint");
      expect(fields).toHaveProperty("errorKind");
    });

    it("child logger is created with module: delivery-queue", () => {
      expect(logger.child).toHaveBeenCalledWith({ module: "delivery-queue" });
    });
  });
});
