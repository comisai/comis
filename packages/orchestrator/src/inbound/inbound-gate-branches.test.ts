// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for evaluateInboundGate (inbound-gate.ts).
 *
 * Targets uncovered branches: /send command override, /config command,
 * /stop command (with + without active session, abort error), reset trigger
 * gate, prompt skill match, command directives extraction, handleSlashCommand
 * handled vs. directive returns.
 *
 * Phase 40 / Plan 40-12 / COV-03 — orchestrator branches gap closure.
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
import { ok, err } from "@comis/shared";

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
    sendAttachment: vi.fn(async () => ok("att-1")),
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
  };
}

function makeDeps(overrides?: Partial<GateDeps>): GateDeps {
  const eventBus = {
    emit: vi.fn(() => true),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listenerCount: vi.fn(() => 0),
    setMaxListeners: vi.fn().mockReturnThis(),
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
    const eventBus = {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
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
    const eventBus = {
      emit: vi.fn(() => true),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      once: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
      listenerCount: vi.fn(() => 0),
      setMaxListeners: vi.fn().mockReturnThis(),
    };
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

  it("uses greetingGenerator output when generator returns ok result", async () => {
    const sessionManager = {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    };
    const greetingGenerator = {
      generate: vi.fn(async () => ok("Hello, fresh start!")),
    };
    const deps = makeDeps({
      sessionManager,
      greetingGenerator,
      getResetTriggers: () => ["reset"],
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "reset" });

    await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "Hello, fresh start!",
      expect.any(Object),
    );
  });

  it("falls back to default reset message when greetingGenerator errors", async () => {
    const sessionManager = {
      loadOrCreate: vi.fn(() => []),
      save: vi.fn(),
      isExpired: vi.fn(() => false),
      expire: vi.fn(() => true),
      cleanStale: vi.fn(() => 0),
    };
    const greetingGenerator = {
      generate: vi.fn(async () => err(new Error("LLM unavailable"))),
    };
    const deps = makeDeps({
      sessionManager,
      greetingGenerator,
      getResetTriggers: () => ["reset"],
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "reset" });

    await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(deps.deliveryService.deliverToChannel).toHaveBeenCalledWith(
      adapter,
      "chat-1",
      "Session reset.",
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// Prompt skill detection
// ---------------------------------------------------------------------------

describe("evaluateInboundGate prompt skill detection", () => {
  it("attaches promptSkillContent to metadata when matchPromptSkillCommand finds a registered skill", async () => {
    const loadPromptSkill = vi.fn(async () =>
      ok({
        content: "skill prompt content",
        allowedTools: ["search"],
        skillName: "summarize",
      }),
    );
    const getUserInvocableSkillNames = vi.fn(() => new Set(["summarize"]));
    const deps = makeDeps({
      loadPromptSkill,
      getUserInvocableSkillNames,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/skill:summarize the docs" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(loadPromptSkill).toHaveBeenCalled();
    expect(result.action).toBe("process");
    if (result.action === "process") {
      expect(result.processedMsg.metadata?.promptSkillContent).toBe(
        "skill prompt content",
      );
      expect(result.processedMsg.metadata?.promptSkillName).toBe("summarize");
    }
  });

  it("logs warning and continues when loadPromptSkill returns err", async () => {
    const loadPromptSkill = vi.fn(async () =>
      err(new Error("skill manifest missing")),
    );
    const getUserInvocableSkillNames = vi.fn(() => new Set(["summarize"]));
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
      loadPromptSkill,
      getUserInvocableSkillNames,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    const adapter = makeAdapter();
    const msg = makeMsg({ text: "/skill:summarize broken" });

    const result = await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "summarize",
        errorKind: "config",
      }),
      "Failed to load prompt skill",
    );
    expect(result.action).toBe("process");
  });

  it("does not match prompt skill when text starts with a system slash command", async () => {
    const loadPromptSkill = vi.fn();
    const getUserInvocableSkillNames = vi.fn(() => new Set(["stop"]));
    const deps = makeDeps({
      loadPromptSkill,
      getUserInvocableSkillNames,
    });
    const adapter = makeAdapter();
    // /stop is a system command — prompt skill matcher must skip it
    const msg = makeMsg({ text: "/stop" });

    await evaluateInboundGate(
      deps,
      adapter,
      msg,
      makeSessionKey(),
      "agent-1",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: () => undefined, set: vi.fn(), delete: vi.fn() } as any,
    );

    expect(loadPromptSkill).not.toHaveBeenCalled();
  });
});

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
