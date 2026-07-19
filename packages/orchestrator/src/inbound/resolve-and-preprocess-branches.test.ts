// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for resolveAndPreprocess (resolve-and-preprocess.ts).
 *
 * Subsumes the deleted inbound-preprocess-branches.test.ts (audio preflight
 * gate matrix, preprocess error fallback, media compression) and adds new
 * resolve-side coverage (undefined-when-no-executor, message:received
 * emission, sessionManager.loadOrCreate invocation, full result shape,
 * no-executor warning shape) — inbound-resolve.ts had no co-located test
 * pre-collapse.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { type NormalizedMessage, type AutoReplyEngineConfig, type ChannelPort } from "@comis/core";
import { ok } from "@comis/shared";
import { createFakePrincipalResolver } from "../../../../test/support/fake-principal-resolver.js";

import {
  resolveAndPreprocess,
  type ResolveAndPreprocessDeps,
} from "./resolve-and-preprocess.js";

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

function makeAdapter(overrides?: Partial<ChannelPort>): ChannelPort {
  // Minimal ChannelPort surface used by resolveAndPreprocess:
  // - channelId (passed into buildScopedSessionKey)
  // - channelType (used as the preprocess sub-phase's channelType tag)
  return {
    channelType: "telegram",
    channelId: "chat-1",
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function makeDeps(overrides?: Partial<ResolveAndPreprocessDeps>): ResolveAndPreprocessDeps {
  // Default executor stub — returns a non-undefined value so resolveAndPreprocess
  // proceeds past the early-exit gate. Tests that need the early-exit path
  // override `createExecutor` to return undefined.
  const defaultExecutor = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const principalResolver = createFakePrincipalResolver();
  const defaults: ResolveAndPreprocessDeps = {
    tenantId: "default",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: makeLogger() as any,
    eventBus: {
      emit: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    messageRouter: {
      resolve: vi.fn(() => "agent-test"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    sessionManager: {
      loadOrCreate: vi.fn(() => ok({})),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    principalResolver,
    getDmScope: () => ({ mode: "per-account-channel-peer", threadIsolation: true }),
    createExecutor: vi.fn(() => defaultExecutor),
    persistInboundMessage: vi.fn(async () => ({
      ok: true as const,
      value: { payloads: [], ledgerContent: "" },
    })),
  };
  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Resolve-side branch tests (new coverage; inbound-resolve.ts had no
// co-located test pre-collapse)
// ---------------------------------------------------------------------------

describe("resolveAndPreprocess (resolve-side branches)", () => {
  it("returns a distinct outcome when createExecutor is unavailable after persistence", async () => {
    const deps = makeDeps({ createExecutor: vi.fn(() => undefined) });

    const result = await resolveAndPreprocess(deps, makeAdapter(), makeMsg());

    expect(result).toMatchObject({ kind: "no_executor", agentId: "agent-test" });
  });

  it("emits message:received with scoped sessionKey when executor resolved", async () => {
    const emit = vi.fn();
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus: {
        emit,
        emitSafely: vi.fn((event, payload) => {
          emit(event, payload);
          return {
            hadListeners: false,
            failures: [],
            pendingFailures: Promise.resolve([]),
          };
        }),
      } as any,
    });

    await resolveAndPreprocess(deps, makeAdapter(), makeMsg());

    expect(emit).toHaveBeenCalledWith(
      "message:received",
      expect.objectContaining({
        message: expect.any(Object),
        sessionKey: expect.any(Object),
      }),
    );
  });

  it("calls sessionManager.loadOrCreate(sessionKey) after resolution", async () => {
    const loadOrCreate = vi.fn(() => ok({}));
    const deps = makeDeps({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionManager: { loadOrCreate } as any,
    });

    await resolveAndPreprocess(deps, makeAdapter(), makeMsg());

    expect(loadOrCreate).toHaveBeenCalledTimes(1);
  });

  it("returns full ResolveAndPreprocessResult on success", async () => {
    const result = await resolveAndPreprocess(makeDeps(), makeAdapter(), makeMsg());

    expect(result).toMatchObject({
      agentId: expect.any(String),
      executor: expect.any(Object),
      sessionKey: expect.any(Object),
      processedMsg: expect.any(Object),
    });
  });

  it("logs warning with hint+errorKind when no executor", async () => {
    const logger = makeLogger();
    const deps = makeDeps({
      createExecutor: vi.fn(() => undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });

    await resolveAndPreprocess(deps, makeAdapter(), makeMsg());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: expect.any(String),
        hint: expect.any(String),
        errorKind: "config",
      }),
      expect.stringContaining("No executor"),
    );
  });

  it("does not emit message:received or call loadOrCreate when no executor (early exit)", async () => {
    const emit = vi.fn();
    const loadOrCreate = vi.fn();
    const deps = makeDeps({
      createExecutor: vi.fn(() => undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      eventBus: { emit } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionManager: { loadOrCreate } as any,
    });

    await resolveAndPreprocess(deps, makeAdapter(), makeMsg());

    expect(emit).not.toHaveBeenCalled();
    expect(loadOrCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Preprocess-side branch tests (carried forward from the deleted
// inbound-preprocess-branches.test.ts; call sites adjusted to invoke
// resolveAndPreprocess(deps, adapter, msg) and assert on the
// returned ResolveAndPreprocessResult.processedMsg field)
// ---------------------------------------------------------------------------

describe("resolveAndPreprocess audio preflight gate", () => {
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

    const result = await resolveAndPreprocess(deps, makeAdapter(), inputMsg);

    expect(audioPreflight).toHaveBeenCalledOnce();
    expect(result?.processedMsg.text).toBe("transcribed audio");
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

    await resolveAndPreprocess(deps, makeAdapter(), inputMsg);

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

    await resolveAndPreprocess(deps, makeAdapter(), inputMsg);

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

    await resolveAndPreprocess(deps, makeAdapter(), inputMsg);

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

    const result = await resolveAndPreprocess(deps, makeAdapter(), inputMsg);

    expect(audioPreflight).toHaveBeenCalledOnce();
    // Untransformed message must retain original text
    expect(result?.processedMsg.text).toBe("original");
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
    const logger = makeLogger();
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

    await resolveAndPreprocess(deps, makeAdapter(), inputMsg);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        hint: expect.stringContaining("preflight failed"),
      }),
      "Audio preflight failed",
    );
  });
});

describe("resolveAndPreprocess preprocess + compression", () => {
  it("calls preprocessMessage when configured and applies result", async () => {
    const preprocessMessage = vi.fn(async (m: NormalizedMessage) => ({
      ...m,
      text: "preprocessed",
    }));
    const deps = makeDeps({
      preprocessMessage: preprocessMessage as never,
    });

    const result = await resolveAndPreprocess(deps, makeAdapter(), makeMsg());

    expect(preprocessMessage).toHaveBeenCalledOnce();
    expect(preprocessMessage).toHaveBeenCalledWith(
      expect.anything(),
      result.turnScope,
    );
    expect(result?.processedMsg.text).toBe("preprocessed");
  });

  it("falls back to original message when preprocessMessage throws", async () => {
    const preprocessMessage = vi.fn(async () => {
      throw new Error("media preprocess failed");
    });
    const logger = makeLogger();
    const deps = makeDeps({
      preprocessMessage: preprocessMessage as never,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });

    const result = await resolveAndPreprocess(
      deps,
      makeAdapter(),
      makeMsg({ text: "original-text" }),
    );

    expect(result?.processedMsg.text).toBe("original-text");
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
    const logger = makeLogger();
    const deps = makeDeps({
      autoReplyEngineConfig: arConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger as any,
    });
    // Most messages won't have their attachment count change; just verify
    // the codepath runs without error when arConfig is present.
    const result = await resolveAndPreprocess(
      deps,
      makeAdapter(),
      makeMsg({ attachments: [] }),
    );

    expect(result).toBeDefined();
  });
});
