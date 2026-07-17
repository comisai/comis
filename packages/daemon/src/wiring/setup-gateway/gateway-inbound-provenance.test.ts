// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  TypedEventBus,
  type ComisLogger,
  type NormalizedMessage,
  type SessionKey,
} from "@comis/core";
import { persistGatewayInboundMessage } from "./gateway-inbound-provenance.js";

const message: NormalizedMessage = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "gateway-channel",
  channelType: "gateway",
  senderId: "user_a",
  text: "user-authored text",
  timestamp: 1_700_000_000_000,
  attachments: [],
  metadata: {},
};

const sessionKey: SessionKey = {
  tenantId: "tenant-a",
  userId: "user_a",
  channelId: "gateway-channel",
};

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

describe("persistGatewayInboundMessage subscriber isolation", () => {
  it("keeps a successful durable commit authoritative and reaches later reception observers", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("message:received", () => {
      throw new Error("private gateway body from subscriber");
    });
    eventBus.on("message:received", laterObserver);
    const logger = makeLogger();

    const result = await persistGatewayInboundMessage({
      agentId: "default",
      defaultAgentId: "default",
      message,
      sessionKey,
      recordedAt: message.timestamp,
      sessionAdapters: new Map([["default", {
        destroySession: vi.fn(async () => undefined),
        getSessionStats: vi.fn(() => undefined),
        persistInboundMessage: vi.fn(async () => ({
          ok: true as const,
          value: { payloads: [], ledgerContent: "" },
        })),
      }]]),
      eventBus,
      logger,
    });

    expect(result.ok).toBe(true);
    expect(laterObserver).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private gateway body");
  });

  it("preserves the original persistence error while terminal and error fan-outs reach later observers", async () => {
    const credential = `xoxb-${"p".repeat(32)}`;
    const persistenceError = new Error(`authoritative persistence failure ${credential}`);
    const eventBus = new TypedEventBus();
    const laterTerminalObserver = vi.fn();
    const laterErrorObserver = vi.fn();
    eventBus.on("message:terminal", () => {
      throw new Error("private terminal subscriber payload");
    });
    eventBus.on("message:terminal", laterTerminalObserver);
    eventBus.on("system:error", () => {
      throw new Error("private system subscriber payload");
    });
    eventBus.on("system:error", laterErrorObserver);
    const logger = makeLogger();

    const result = await persistGatewayInboundMessage({
      agentId: "default",
      defaultAgentId: "default",
      message,
      sessionKey,
      recordedAt: message.timestamp,
      sessionAdapters: new Map([["default", {
        destroySession: vi.fn(async () => undefined),
        getSessionStats: vi.fn(() => undefined),
        persistInboundMessage: vi.fn(async () => ({
          ok: false as const,
          error: { error: persistenceError, errorKind: "resource" as const },
        })),
      }]]),
      eventBus,
      logger,
    });

    expect(result).toEqual({
      ok: false,
      error: { error: persistenceError, errorKind: "resource" },
    });
    expect(laterTerminalObserver).toHaveBeenCalledOnce();
    expect(laterErrorObserver).toHaveBeenCalledOnce();
    const warningLogs = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(warningLogs).not.toContain("private terminal subscriber payload");
    expect(warningLogs).not.toContain("private system subscriber payload");
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(credential);
  });
});
