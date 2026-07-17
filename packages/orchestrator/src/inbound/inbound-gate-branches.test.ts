// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for evaluateInboundGate (inbound-gate.ts).
 *
 * Targets uncovered branches: /send command override, /config command,
 * /stop command (with + without active session, abort error), reset trigger
 * gate, prompt skill match, command directives extraction, handleSlashCommand
 * handled vs. directive returns.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ChannelPort,
  NormalizedMessage,
  SessionKey,
  DeliveryService,
} from "@comis/core";
import { TypedEventBus } from "@comis/core";
import { ok } from "@comis/shared";

import { evaluateInboundGate } from "./inbound-gate.js";
import type { GateDeps } from "./inbound-gate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(channelType = "telegram"): ChannelPort {
  return {
    channelId: "adapter-1",
    channelType,
    start: vi.fn(async () => ok(undefined)),
    stop: vi.fn(async () => ok(undefined)),
    sendMessage: vi.fn(async () => ok("msg-r1")),
    editMessage: vi.fn(async () => ok(undefined)),
    onMessage: vi.fn(),
    reactToMessage: vi.fn(async () => ok(undefined)),
    removeReaction: vi.fn(async () => ok(undefined)),
    deleteMessage: vi.fn(async () => ok(undefined)),
    fetchMessages: vi.fn(async () => ok([])),
    sendAttachment: vi.fn(async () => ok({ kind: "tracked" as const, messageId: "att-1" })),
    platformAction: vi.fn(async () => ok(undefined)),
  };
}

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { telegramMessageId: "42", telegramChatType: "private" },
    ...overrides,
  };
}

function makeSessionKey(): SessionKey {
  return {
    tenantId: "default",
    userId: "user-1",
    channelId: "chat-1",
    peerId: "user-1",
  };
}

function makeFakeDeliveryService(): DeliveryService {
  return {
    deliverToChannel: vi.fn(async () =>
      ok({
        ok: true,
        totalChunks: 1,
        deliveredChunks: 1,
        failedChunks: 0,
        chunks: [],
        totalChars: 0,
      }),
    ),
    // DeliveryService provides drainInFlight(). Default fake returns empty
    // drain telemetry; tests that exercise drain semantics override this field.
    drainInFlight: vi.fn(async () => ({ drained: 0, remaining: 0, durationMs: 0 })),
  };
}

function createMockEventBus() {
  const emit = vi.fn(() => true);
  return {
    emit,
    emitSafely: vi.fn((event: string, payload: unknown) => {
      emit(event, payload);
      return { hadListeners: false, failures: [], pendingFailures: Promise.resolve([]) };
    }),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
  };
}

function makeDeps(overrides?: Partial<GateDeps>): GateDeps {
  const eventBus = createMockEventBus();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventBus: eventBus as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: logger as any,
    sessionManager: {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    },
    deliveryService: makeFakeDeliveryService(),
    ...overrides,
  } as GateDeps;
}

// ---------------------------------------------------------------------------
// /send command override
// ---------------------------------------------------------------------------

describe("evaluateInboundGate /send command", () => {
  it("sets per-session send override when issued by the session owner", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/send on" });
    const overrides = new Map<string, "on" | "off" | "inherit">();
    const sendOverrides = {
      get: (k: string) => overrides.get(k),
      set: (k: string, v: "on" | "off" | "inherit") => overrides.set(k, v),
      delete: (k: string) => {
        overrides.delete(k);
      },
    };

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendOverrides as any,
    );

    expect(result.action).toBe("handled");
    expect([...overrides.values()]).toContain("on");
  });

  it("keeps the send override and acknowledgement when its observer throws", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("sendpolicy:override_changed", () => {
      throw new Error("private send policy subscriber content");
    });
    eventBus.on("sendpolicy:override_changed", laterObserver);
    const deps = makeDeps({ eventBus });
    const overrides = new Map<string, "on" | "off" | "inherit">();
    const result = await evaluateInboundGate(
      deps,
      makeAdapter(),
      makeMsg({ text: "/send on" }),
      makeSessionKey(),
      "agent-1",
      {
        get: (key: string) => overrides.get(key),
        set: (key: string, value: "on" | "off" | "inherit") => overrides.set(key, value),
        delete: (key: string) => overrides.delete(key),
      },
    );

    expect(result.action).toBe("handled");
    expect([...overrides.values()]).toEqual(["on"]);
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      expect.anything(),
      "chat-1",
      "Send policy override set to: on",
      expect.any(Object),
    );
    expect(laterObserver).toHaveBeenCalledOnce();
  });

  it("refuses /send override when sender is not the session owner", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    // senderId differs from sessionKey.userId
    const msg = makeMsg({ text: "/send off", senderId: "other-user" });
    const sendOverrides = {
      get: () => undefined,
      set: vi.fn(),
      delete: vi.fn(),
    };

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendOverrides as any,
    );

    expect(result.action).toBe("handled");
    expect(sendOverrides.set).not.toHaveBeenCalled();
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      expect.stringContaining("Only the session owner"),
      expect.any(Object),
    );
  });

  it("ignores /send command with invalid argument and passes through to process", async () => {
    const deps = makeDeps();
    const adapter = makeAdapter();
    // Invalid arg "maybe" — not on/off/inherit
    const msg = makeMsg({ text: "/send maybe" });
    const sendOverrides = {
      get: () => undefined,
      set: vi.fn(),
      delete: vi.fn(),
    };

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendOverrides as any,
    );

    // The /send literal still matches but invalid arg means no handling
    expect(result.action).toBe("process");
  });
});

// ---------------------------------------------------------------------------
// /config command
// ---------------------------------------------------------------------------

describe("evaluateInboundGate /config command interception", () => {
  it("delivers /config response and returns handled when handleConfigCommand returns a string", async () => {
    const handleConfigCommand = vi.fn(async () => "config view response");
    const deps = makeDeps({ handleConfigCommand });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/config view" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("handled");
    expect(handleConfigCommand).toHaveBeenCalled();
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "config view response",
    );
  });

  it("falls through when handleConfigCommand returns undefined for unrecognized config args", async () => {
    const handleConfigCommand = vi.fn(async () => undefined);
    const deps = makeDeps({ handleConfigCommand });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/config unknown" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(handleConfigCommand).toHaveBeenCalled();
    // Falls through — /stop and other gates don't match either
    expect(result.action).toBe("process");
  });
});

// ---------------------------------------------------------------------------
// /stop command interception
// ---------------------------------------------------------------------------

describe("evaluateInboundGate /stop command interception", () => {
  it("aborts active session and emits execution:aborted when resolver finds session", async () => {
    const abort = vi.fn(async () => undefined);
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => ({
        isStreaming: () => true,
        isCompacting: () => false,
        steer: vi.fn(),
        followUp: vi.fn(),
        abort,
      })),
    };
    const eventBus = createMockEventBus();
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionResolver: sessionResolver as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus: eventBus as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/stop" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("handled");
    expect(abort).toHaveBeenCalledOnce();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "execution:aborted",
      expect.objectContaining({ reason: "user_stop" }),
    );
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "Execution stopped.",
      expect.any(Object),
    );
  });

  it("reports no active execution when /stop is issued with no matching session", async () => {
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => null),
    };
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionResolver: sessionResolver as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/stop" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("handled");
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "No active execution to stop.",
      expect.any(Object),
    );
  });

  it("reports the successful stop and reaches later observers when abort observers throw or reject", async () => {
    const abort = vi.fn(async () => undefined);
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("execution:aborted", () => {
      throw new Error("private sync abort subscriber content");
    });
    eventBus.on("execution:aborted", async () => {
      throw new Error("private async abort subscriber content");
    });
    eventBus.on("execution:aborted", laterObserver);
    const deps = makeDeps({
      eventBus,
      sessionResolver: {
        resolveActiveSession: () => ({
          isStreaming: () => true,
          isCompacting: () => false,
          steer: vi.fn(),
          followUp: vi.fn(),
          abort,
        }),
      } as never,
    });
    const adapter = makeAdapter();

    const result = await evaluateInboundGate(
      deps,
      adapter,
      makeMsg({ text: "/stop" }),
      makeSessionKey(),
      "agent-1",
      { get: () => undefined, set: vi.fn(), delete: vi.fn() },
    );

    expect(result.action).toBe("handled");
    expect(abort).toHaveBeenCalledOnce();
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "Execution stopped.",
      expect.any(Object),
    );
    expect(deps.deliveryService.deliverToChannel).not.toHaveBeenCalledWith(
      adapter,
      "chat-1",
      expect.stringContaining("Could not stop"),
      expect.any(Object),
    );
    expect(laterObserver).toHaveBeenCalledOnce();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("reports could-not-stop and logs warn when abort throws", async () => {
    const abort = vi.fn(async () => {
      throw new Error("abort-failed");
    });
    const sessionResolver = {
      resolveActiveSession: vi.fn(() => ({
        isStreaming: () => false,
        isCompacting: () => false,
        steer: vi.fn(),
        followUp: vi.fn(),
        abort,
      })),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionResolver: sessionResolver as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/stop" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("handled");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("Abort call failed"),
      }),
      "Stop command abort failed",
    );
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      expect.stringContaining("Could not stop execution"),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// Reset trigger phrase
// ---------------------------------------------------------------------------

describe("evaluateInboundGate reset trigger phrase gate", () => {
  it("expires session and emits session:expired when reset phrase matches", async () => {
    const sessionManager = {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    };
    const eventBus = createMockEventBus();
    const deps = makeDeps({
      sessionManager,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus: eventBus as any,
      getResetTriggers: () => ["reset"],
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "reset" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("handled");
    expect(sessionManager.expire).toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "session:expired",
      expect.objectContaining({ reason: "auto-reset:trigger-phrase" }),
    );
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "Session reset.",
      expect.any(Object),
    );
  });

  it("keeps the expired session and reset acknowledgement when its observer throws", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    eventBus.on("session:expired", () => {
      throw new Error("private reset subscriber content");
    });
    eventBus.on("session:expired", laterObserver);
    const sessionManager = {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    };
    const deps = makeDeps({
      eventBus,
      sessionManager,
      getResetTriggers: () => ["reset"],
    });
    const adapter = makeAdapter();

    const result = await evaluateInboundGate(
      deps,
      adapter,
      makeMsg({ text: "reset" }),
      makeSessionKey(),
      "agent-1",
      { get: () => undefined, set: vi.fn(), delete: vi.fn() },
    );

    expect(result.action).toBe("handled");
    expect(sessionManager.expire).toHaveBeenCalledOnce();
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "Session reset.",
      expect.any(Object),
    );
    expect(laterObserver).toHaveBeenCalledOnce();
  });

  // greetingGenerator-based tests deleted: the greetingGenerator deps slot was
  // removed; the reset path now always sends static "Session reset."
  // (production absent-mode).
});

// "evaluateInboundGate prompt skill detection" describe block deleted:
// loadPromptSkill + getUserInvocableSkillNames deps slots removed; skill
// commands now pass through as plain text to the agent.

// ---------------------------------------------------------------------------
// handleSlashCommand directive branch
// ---------------------------------------------------------------------------

describe("evaluateInboundGate handleSlashCommand directives", () => {
  it("returns handled and delivers response when handleSlashCommand reports handled=true", async () => {
    const handleSlashCommand = vi.fn(async () => ({
      handled: true,
      response: "the response",
    }));
    const deps = makeDeps({ handleSlashCommand });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/foobar" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("handled");
    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "the response",
      expect.any(Object),
    );
  });

  it("attaches directives metadata and passes process action when slash command returns handled=false with directives", async () => {
    const handleSlashCommand = vi.fn(async () => ({
      handled: false,
      directives: { mode: "verbose" },
      cleanedText: "cleaned-text",
    }));
    const deps = makeDeps({ handleSlashCommand });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/mode verbose" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("process");
    if (result.action === "process") {
      expect(result.directives).toEqual({ mode: "verbose" });
      expect(result.processedMsg.text).toBe("cleaned-text");
    }
  });

  it("preserves message when slash command returns no directives and no response", async () => {
    const handleSlashCommand = vi.fn(async () => ({
      handled: false,
    }));
    const deps = makeDeps({ handleSlashCommand });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/unknown" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(result.action).toBe("process");
    if (result.action === "process") {
      expect(result.processedMsg.text).toBe("/unknown");
    }
  });
});
