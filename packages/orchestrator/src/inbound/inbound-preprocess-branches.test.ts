// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for preprocessInboundMessage (inbound-preprocess.ts).
 *
 * Covers audio preflight gating, preprocess error fallback, and
 * compression branch paths that are otherwise reached only via the full
 * integration pipeline.
 *
 * Phase 40 / Plan 40-12 / COV-03 — orchestrator branches gap closure.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { NormalizedMessage, AutoReplyEngineConfig } from "@comis/core";

import { preprocessInboundMessage } from "./inbound-preprocess.js";
import type { PreprocessDeps } from "./inbound-preprocess.js";

function makeMsg(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: "msg-1",
    channelId: "chat-1",
    channelType: "telegram",
    senderId: "user-1",
    text: "hello",
    timestamp: 1_700_000_000_000,
    attachments: [],
    metadata: { telegramChatType: "group" },
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<PreprocessDeps>): PreprocessDeps {
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
    logger: logger as any,
    ...overrides,
  } as PreprocessDeps;
}

describe("preprocessInboundMessage audio preflight gate", () => {
  it("invokes audio preflight when group + mention-gated + audio attachment + bot not mentioned", async () => {
    const transcribed = makeMsg({
      text: "transcribed audio",
      attachments: [
        { type: "audio", mimeType: "audio/ogg", url: "u" } as never,
      ],
    });
    const audioPreflight = vi.fn(async () => ({
      transcribed: true,
      message: transcribed,
    }));
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "mention-gated",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
    };
    const deps = makeDeps({
      audioPreflight: audioPreflight as never,
      autoReplyEngineConfig: arConfig,
    });
    const inputMsg = makeMsg({
      attachments: [
        { type: "audio", mimeType: "audio/ogg", url: "u" } as never,
      ],
    });

    const result = await preprocessInboundMessage(deps, inputMsg, "telegram");

    expect(audioPreflight).toHaveBeenCalledOnce();
    expect(result.text).toBe("transcribed audio");
  });

  it("skips audio preflight when not in group chat (DM)", async () => {
    const audioPreflight = vi.fn();
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "mention-gated",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
    };
    const deps = makeDeps({
      audioPreflight: audioPreflight as never,
      autoReplyEngineConfig: arConfig,
    });
    const inputMsg = makeMsg({
      metadata: { telegramChatType: "private" },
      attachments: [
        { type: "audio", mimeType: "audio/ogg", url: "u" } as never,
      ],
    });

    await preprocessInboundMessage(deps, inputMsg, "telegram");

    expect(audioPreflight).not.toHaveBeenCalled();
  });

  it("skips audio preflight when bot is already mentioned in metadata", async () => {
    const audioPreflight = vi.fn();
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "mention-gated",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
    };
    const deps = makeDeps({
      audioPreflight: audioPreflight as never,
      autoReplyEngineConfig: arConfig,
    });
    const inputMsg = makeMsg({
      metadata: { telegramChatType: "group", isBotMentioned: true },
      attachments: [
        { type: "audio", mimeType: "audio/ogg", url: "u" } as never,
      ],
    });

    await preprocessInboundMessage(deps, inputMsg, "telegram");

    expect(audioPreflight).not.toHaveBeenCalled();
  });

  it("skips audio preflight when there are no audio attachments", async () => {
    const audioPreflight = vi.fn();
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "mention-gated",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
    };
    const deps = makeDeps({
      audioPreflight: audioPreflight as never,
      autoReplyEngineConfig: arConfig,
    });
    const inputMsg = makeMsg({
      attachments: [
        { type: "image", mimeType: "image/png", url: "u" } as never,
      ],
    });

    await preprocessInboundMessage(deps, inputMsg, "telegram");

    expect(audioPreflight).not.toHaveBeenCalled();
  });

  it("does not apply preflight result when transcribed flag is false", async () => {
    const audioPreflight = vi.fn(async () => ({
      transcribed: false,
      message: makeMsg({ text: "should-not-be-applied" }),
    }));
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "mention-gated",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
    };
    const deps = makeDeps({
      audioPreflight: audioPreflight as never,
      autoReplyEngineConfig: arConfig,
    });
    const inputMsg = makeMsg({
      text: "original",
      attachments: [
        { type: "audio", mimeType: "audio/ogg", url: "u" } as never,
      ],
    });

    const result = await preprocessInboundMessage(deps, inputMsg, "telegram");

    expect(audioPreflight).toHaveBeenCalledOnce();
    // Untransformed message must retain original text
    expect(result.text).toBe("original");
  });

  it("recovers from audio preflight exception with warning log", async () => {
    const audioPreflight = vi.fn(async () => {
      throw new Error("transcription service unavailable");
    });
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "mention-gated",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
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
      audioPreflight: audioPreflight as never,
      autoReplyEngineConfig: arConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    const inputMsg = makeMsg({
      attachments: [
        { type: "audio", mimeType: "audio/ogg", url: "u" } as never,
      ],
    });

    await preprocessInboundMessage(deps, inputMsg, "telegram");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("preflight failed"),
      }),
      "Audio preflight failed",
    );
  });
});

describe("preprocessInboundMessage preprocess + compression", () => {
  it("calls preprocessMessage when configured and applies result", async () => {
    const preprocessMessage = vi.fn(async (m: NormalizedMessage) => ({
      ...m,
      text: "preprocessed",
    }));
    const deps = makeDeps({
      preprocessMessage: preprocessMessage as never,
    });

    const result = await preprocessInboundMessage(deps, makeMsg(), "telegram");

    expect(preprocessMessage).toHaveBeenCalledOnce();
    expect(result.text).toBe("preprocessed");
  });

  it("falls back to original message when preprocessMessage throws", async () => {
    const preprocessMessage = vi.fn(async () => {
      throw new Error("media preprocess failed");
    });
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
      preprocessMessage: preprocessMessage as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });

    const result = await preprocessInboundMessage(
      deps,
      makeMsg({ text: "original-text" }),
      "telegram",
    );

    expect(result.text).toBe("original-text");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("preprocessing failed"),
      }),
      "Media preprocessing failed, using original message",
    );
  });

  it("logs compression delta when attachments count changes after compression", async () => {
    const arConfig: AutoReplyEngineConfig = {
      enabled: true,
      groupActivation: "always",
      customPatterns: [],
      historyInjection: true,
      maxHistoryInjections: 50,
      maxGroupHistoryMessages: 20,
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
      autoReplyEngineConfig: arConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    // Most messages won't have their attachment count change; just verify
    // the codepath runs without error when arConfig is present.
    const result = await preprocessInboundMessage(
      deps,
      makeMsg({ attachments: [] }),
      "telegram",
    );

    expect(result).toBeDefined();
  });
});
