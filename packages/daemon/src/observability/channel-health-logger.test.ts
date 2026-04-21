// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setupChannelHealthLogging } from "./channel-health-logger.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

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
// Tests
// ---------------------------------------------------------------------------

describe("setupChannelHealthLogging", () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let logger: any;

  beforeEach(() => {
    eventBus = createMockEventBus();
    logger = createMockLogger();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setupChannelHealthLogging({ eventBus: eventBus as any, logger });
  });

  it("subscribes to channel:health_changed and channel:health_check", () => {
    const events = eventBus.registeredEvents();
    expect(events).toContain("channel:health_changed");
    expect(events).toContain("channel:health_check");
    expect(events).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // channel:health_changed -> WARN for problematic states
  // -------------------------------------------------------------------------

  describe("problematic state transitions (WARN)", () => {
    it("logs WARN with hint and errorKind when state changes to disconnected", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "telegram",
        previousState: "healthy",
        currentState: "disconnected",
        connectionMode: "polling",
        error: null,
        lastMessageAt: Date.now() - 30000,
        timestamp: Date.now(),
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields, msg] = logger.warn.mock.calls[0];
      expect(msg).toBe("Channel health degraded: %s -> %s");
      expect(fields).toMatchObject({
        channelType: "telegram",
        previousState: "healthy",
        currentState: "disconnected",
        connectionMode: "polling",
        hint: "Check adapter credentials and network connectivity",
        errorKind: "connection",
        module: "channel-health",
      });
    });

    it("logs WARN when state changes to errored with error message in hint", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "discord",
        previousState: "healthy",
        currentState: "errored",
        connectionMode: "socket",
        error: "WebSocket closed unexpectedly",
        lastMessageAt: null,
        timestamp: Date.now(),
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = logger.warn.mock.calls[0];
      expect(fields).toMatchObject({
        channelType: "discord",
        currentState: "errored",
        err: { message: "WebSocket closed unexpectedly" },
        hint: "Adapter reports error. Check adapter logs for root cause: WebSocket closed unexpectedly",
        errorKind: "adapter",
        module: "channel-health",
      });
    });

    it("logs WARN when state changes to stale", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "slack",
        previousState: "healthy",
        currentState: "stale",
        connectionMode: "socket",
        error: null,
        lastMessageAt: Date.now() - 600000,
        timestamp: Date.now(),
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = logger.warn.mock.calls[0];
      expect(fields).toMatchObject({
        channelType: "slack",
        currentState: "stale",
        hint: "No activity detected beyond stale threshold. Adapter may be silently disconnected",
        errorKind: "timeout",
        module: "channel-health",
      });
    });

    it("logs WARN when state changes to stuck", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "whatsapp",
        previousState: "healthy",
        currentState: "stuck",
        connectionMode: "webhook",
        error: null,
        lastMessageAt: Date.now() - 300000,
        timestamp: Date.now(),
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = logger.warn.mock.calls[0];
      expect(fields).toMatchObject({
        channelType: "whatsapp",
        currentState: "stuck",
        hint: "Active run exceeded stuck threshold. Check for hung agent execution",
        errorKind: "timeout",
        module: "channel-health",
      });
    });

    it("logs WARN when state changes to unknown", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "irc",
        previousState: "startup-grace",
        currentState: "unknown",
        connectionMode: "socket",
        error: null,
        lastMessageAt: null,
        timestamp: Date.now(),
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = logger.warn.mock.calls[0];
      expect(fields).toMatchObject({
        channelType: "irc",
        currentState: "unknown",
        hint: "getStatus() unavailable or failing. Adapter may not implement health reporting",
        errorKind: "internal",
        module: "channel-health",
      });
    });

    it("includes err object when error is provided", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "telegram",
        previousState: "healthy",
        currentState: "disconnected",
        connectionMode: "polling",
        error: "ETIMEOUT",
        lastMessageAt: null,
        timestamp: Date.now(),
      });

      const [fields] = logger.warn.mock.calls[0];
      expect(fields.err).toEqual({ message: "ETIMEOUT" });
    });

    it("omits err object when error is null", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "telegram",
        previousState: "healthy",
        currentState: "stale",
        connectionMode: "polling",
        error: null,
        lastMessageAt: null,
        timestamp: Date.now(),
      });

      const [fields] = logger.warn.mock.calls[0];
      expect(fields.err).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // channel:health_changed -> INFO for recovery/normal transitions
  // -------------------------------------------------------------------------

  describe("recovery/normal state transitions (INFO)", () => {
    it("logs INFO for recovery transition (disconnected -> healthy)", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "telegram",
        previousState: "disconnected",
        currentState: "healthy",
        connectionMode: "polling",
        error: null,
        lastMessageAt: Date.now(),
        timestamp: Date.now(),
      });

      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
      const [fields, msg] = logger.info.mock.calls[0];
      expect(msg).toBe("Channel health changed: %s -> %s");
      expect(fields).toMatchObject({
        channelType: "telegram",
        previousState: "disconnected",
        currentState: "healthy",
        connectionMode: "polling",
        module: "channel-health",
      });
    });

    it("logs INFO for normal transition (startup-grace -> healthy)", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "discord",
        previousState: "startup-grace",
        currentState: "healthy",
        connectionMode: "socket",
        error: null,
        lastMessageAt: null,
        timestamp: Date.now(),
      });

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [fields] = logger.info.mock.calls[0];
      expect(fields).toMatchObject({
        previousState: "startup-grace",
        currentState: "healthy",
        module: "channel-health",
      });
    });

    it("logs INFO for transition to idle", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "slack",
        previousState: "healthy",
        currentState: "idle",
        connectionMode: "socket",
        error: null,
        lastMessageAt: Date.now() - 60000,
        timestamp: Date.now(),
      });

      expect(logger.info).toHaveBeenCalledTimes(1);
      const [fields] = logger.info.mock.calls[0];
      expect(fields.currentState).toBe("idle");
    });

    it("does not include err or hint/errorKind for recovery transitions", () => {
      eventBus.emit("channel:health_changed", {
        channelType: "telegram",
        previousState: "stale",
        currentState: "healthy",
        connectionMode: "polling",
        error: null,
        lastMessageAt: Date.now(),
        timestamp: Date.now(),
      });

      const [fields] = logger.info.mock.calls[0];
      expect(fields).not.toHaveProperty("err");
      expect(fields).not.toHaveProperty("hint");
      expect(fields).not.toHaveProperty("errorKind");
    });
  });

  // -------------------------------------------------------------------------
  // channel:health_check -> DEBUG
  // -------------------------------------------------------------------------

  describe("health check probes (DEBUG)", () => {
    it("logs DEBUG for health_check events", () => {
      eventBus.emit("channel:health_check", {
        channelType: "telegram",
        state: "healthy",
        responseTimeMs: 12,
        timestamp: Date.now(),
      });

      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      const [fields, msg] = logger.debug.mock.calls[0];
      expect(msg).toBe("Health check: %s = %s");
      expect(fields).toMatchObject({
        channelType: "telegram",
        state: "healthy",
        responseTimeMs: 12,
        module: "channel-health",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting: logging rules compliance
  // -------------------------------------------------------------------------

  describe("logging rules compliance", () => {
    it("all WARN events include hint and errorKind (required on WARN)", () => {
      const problematicStates = ["disconnected", "errored", "stale", "stuck", "unknown"];
      for (const state of problematicStates) {
        eventBus.emit("channel:health_changed", {
          channelType: "test",
          previousState: "healthy",
          currentState: state,
          connectionMode: "socket",
          error: state === "errored" ? "some error" : null,
          lastMessageAt: null,
          timestamp: Date.now(),
        });
      }

      expect(logger.warn).toHaveBeenCalledTimes(5);
      for (const [fields] of logger.warn.mock.calls) {
        expect(fields).toHaveProperty("hint");
        expect(fields).toHaveProperty("errorKind");
      }
    });

    it("all log events include module: channel-health", () => {
      // WARN event
      eventBus.emit("channel:health_changed", {
        channelType: "t", previousState: "healthy", currentState: "disconnected",
        connectionMode: "socket", error: null, lastMessageAt: null, timestamp: 0,
      });
      // INFO event
      eventBus.emit("channel:health_changed", {
        channelType: "t", previousState: "disconnected", currentState: "healthy",
        connectionMode: "socket", error: null, lastMessageAt: null, timestamp: 0,
      });
      // DEBUG event
      eventBus.emit("channel:health_check", {
        channelType: "t", state: "healthy", responseTimeMs: 5, timestamp: 0,
      });

      expect(logger.warn.mock.calls[0][0].module).toBe("channel-health");
      expect(logger.info.mock.calls[0][0].module).toBe("channel-health");
      expect(logger.debug.mock.calls[0][0].module).toBe("channel-health");
    });
  });
});
