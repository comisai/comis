// SPDX-License-Identifier: Apache-2.0
/**
 * Branch-gap tests for createDiscordAdapter (discord-adapter.ts).
 *
 * Targets uncovered branches: editMessage/reactToMessage/removeReaction/
 * deleteMessage/fetchMessages/sendAttachment (incl. voice note dispatch),
 * apiRoot E2E seam, shardDisconnect/shardResume event handlers,
 * interactionCreate button flow + ack failure recovery, getStatus uptime.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventHandlers = new Map<string, (...args: any[]) => void>();
const mockLogin = vi.fn();
const mockDestroy = vi.fn();
const mockChannelsFetch = vi.fn();
let lastClientConfig: Record<string, unknown> | undefined;

vi.mock("discord.js", () => {
  class MockClient {
    channels = { fetch: mockChannelsFetch };
    guilds = { fetch: vi.fn() };
    user = { setPresence: vi.fn() };
    constructor(config: Record<string, unknown>) {
      lastClientConfig = config;
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      eventHandlers.set(event, handler);
      return this;
    }
    login = mockLogin;
    destroy = mockDestroy;
  }
  return {
    Client: MockClient,
    Events: {
      MessageCreate: "messageCreate",
      InteractionCreate: "interactionCreate",
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 4,
      DirectMessages: 8,
      GuildMessageReactions: 16,
      DirectMessageReactions: 32,
    },
    ChannelType: { GuildText: 0 },
    ActivityType: { Playing: 0 },
  };
});

vi.mock("./credential-validator.js", () => ({
  validateDiscordToken: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapDiscordToNormalized: vi.fn(),
}));

vi.mock("./format-discord.js", () => ({
  chunkDiscordText: vi.fn((text: string) => (text ? [text] : [])),
}));

vi.mock("./voice-sender.js", () => ({
  createDiscordVoiceSender: vi.fn(() => ({
    sendVoice: vi.fn(async () => ok("voice-msg-1")),
  })),
}));

import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateDiscordToken } from "./credential-validator.js";
import { createDiscordAdapter, type DiscordAdapterDeps } from "./discord-adapter.js";

function makeDeps(overrides?: Partial<DiscordAdapterDeps>): DiscordAdapterDeps {
  return {
    botToken: "discord-token",
    logger: createMockLogger(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  eventHandlers.clear();
  lastClientConfig = undefined;
  vi.mocked(validateDiscordToken).mockResolvedValue(
    ok({ id: "bot-123", username: "test_bot", discriminator: "0" }),
  );
  mockLogin.mockResolvedValue("token");
});

// ---------------------------------------------------------------------------
// apiRoot E2E seam
// ---------------------------------------------------------------------------

describe("createDiscordAdapter apiRoot seam", () => {
  it("constructs Client with rest.api override when apiRoot is set", async () => {
    createDiscordAdapter(makeDeps({ apiRoot: "http://127.0.0.1:54321" }));

    expect(lastClientConfig).toMatchObject({
      rest: { api: "http://127.0.0.1:54321" },
    });
  });

  it("omits rest config entirely when apiRoot is not set", async () => {
    createDiscordAdapter(makeDeps());

    expect(lastClientConfig).not.toHaveProperty("rest");
  });

  it("forwards apiRoot to validateDiscordToken", async () => {
    const adapter = createDiscordAdapter(
      makeDeps({ apiRoot: "http://127.0.0.1:54321" }),
    );
    await adapter.start();

    expect(validateDiscordToken).toHaveBeenCalledWith(
      "discord-token",
      "http://127.0.0.1:54321",
    );
  });
});

// ---------------------------------------------------------------------------
// shard lifecycle event handlers
// ---------------------------------------------------------------------------

describe("createDiscordAdapter shard lifecycle", () => {
  it("logs warn with attempt counter and shardId on shardDisconnect", async () => {
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    await adapter.start();

    const disconnectHandler = eventHandlers.get("shardDisconnect");
    expect(disconnectHandler).toBeDefined();
    disconnectHandler!({ code: 1006 }, 0);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "discord",
        attempt: 1,
        shardId: 0,
        code: 1006,
        errorKind: "network",
      }),
      "Reconnection attempt",
    );
  });

  it("increments attempt counter on each shardDisconnect", async () => {
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    await adapter.start();

    const disconnectHandler = eventHandlers.get("shardDisconnect");
    disconnectHandler!({ code: 1006 }, 0);
    disconnectHandler!({ code: 4014 }, 0);
    disconnectHandler!({ code: 1006 }, 0);

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3 }),
      "Reconnection attempt",
    );
  });

  it("resets attempt counter and logs connection resumed on shardResume", async () => {
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    await adapter.start();

    const disconnectHandler = eventHandlers.get("shardDisconnect");
    disconnectHandler!({ code: 1006 }, 0);
    disconnectHandler!({ code: 1006 }, 0);
    const resumeHandler = eventHandlers.get("shardResume");
    resumeHandler!(5, 0);

    // After resume, next disconnect should be attempt: 1
    disconnectHandler!({ code: 1006 }, 0);
    expect(deps.logger.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ attempt: 1 }),
      "Reconnection attempt",
    );
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: "discord", shardId: 0 }),
      "Connection resumed",
    );
  });
});

// ---------------------------------------------------------------------------
// InteractionCreate (button callback)
// ---------------------------------------------------------------------------

describe("createDiscordAdapter interactionCreate", () => {
  it("ignores non-button interactions", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const interactionHandler = eventHandlers.get("interactionCreate");
    await interactionHandler!({
      isButton: () => false,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("calls deferUpdate on button interactions before forwarding to handlers", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.start();

    const deferUpdate = vi.fn(async () => undefined);
    const interactionHandler = eventHandlers.get("interactionCreate");
    await interactionHandler!({
      isButton: () => true,
      deferUpdate,
      channelId: "C123",
      user: { id: "U1", username: "alice" },
      customId: "button-1",
      message: { id: "msg-1" },
    });

    expect(deferUpdate).toHaveBeenCalledOnce();

    // Wait for fire-and-forget handler dispatch
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "button-1",
        channelId: "C123",
        senderId: "U1",
        metadata: expect.objectContaining({
          isButtonCallback: true,
          callbackData: "button-1",
        }),
      }),
    );
  });

  it("logs warn when deferUpdate throws", async () => {
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    await adapter.start();

    const interactionHandler = eventHandlers.get("interactionCreate");
    await interactionHandler!({
      isButton: () => true,
      deferUpdate: async () => {
        throw new Error("ack-failed");
      },
      channelId: "C123",
      user: { id: "U1" },
      customId: "btn",
    });

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "discord",
        errorKind: "platform",
      }),
      "Interaction callback failed",
    );
  });
});

// ---------------------------------------------------------------------------
// editMessage / reactToMessage / removeReaction / deleteMessage / fetchMessages
// ---------------------------------------------------------------------------

describe("createDiscordAdapter editMessage", () => {
  it("edits an existing message using channel.messages.fetch + msg.edit", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const editFn = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => ({ edit: editFn }));
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: fetchFn },
    });

    const result = await adapter.editMessage("C123", "msg-1", "new text");

    expect(result.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("msg-1");
    expect(editFn).toHaveBeenCalledWith("new text");
  });

  it("truncates edited text to 2000 chars per Discord limit", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const editFn = vi.fn(async () => undefined);
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ edit: editFn })) },
    });

    await adapter.editMessage("C123", "msg-1", "x".repeat(2500));

    expect(editFn).toHaveBeenCalledWith("x".repeat(2000));
  });

  it("returns err when channel is not text-based", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({ isTextBased: () => false });

    const result = await adapter.editMessage("C123", "msg-1", "text");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not a text-based channel");
    }
  });

  it("returns err when channel fetch throws", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockRejectedValue(new Error("channel_not_found"));

    const result = await adapter.editMessage("C123", "msg-1", "text");

    expect(result.ok).toBe(false);
  });
});

describe("createDiscordAdapter reactToMessage", () => {
  it("fetches the message and calls msg.react with the emoji", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const reactFn = vi.fn(async () => undefined);
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ react: reactFn })) },
    });

    const result = await adapter.reactToMessage("C123", "msg-1", "🔥");

    expect(result.ok).toBe(true);
    expect(reactFn).toHaveBeenCalledWith("🔥");
  });

  it("returns err when channel is not text-based", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({ isTextBased: () => false });

    const result = await adapter.reactToMessage("C123", "msg-1", "🔥");

    expect(result.ok).toBe(false);
  });
});

describe("createDiscordAdapter removeReaction", () => {
  it("removes a reaction matching emoji name + own user id", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const removeFn = vi.fn(async () => undefined);
    const reactionCache = new Map<string, { users: { remove: typeof removeFn } }>();
    reactionCache.set("🔥", { users: { remove: removeFn } });
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async () => ({
          reactions: { cache: reactionCache },
        })),
      },
    });

    const result = await adapter.removeReaction("C123", "msg-1", "🔥");

    expect(result.ok).toBe(true);
    expect(removeFn).toHaveBeenCalled();
  });

  it("returns ok when reaction is not present (idempotent)", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async () => ({
          reactions: { cache: new Map() },
        })),
      },
    });

    const result = await adapter.removeReaction("C123", "msg-1", "🔥");

    expect(result.ok).toBe(true);
  });

  it("returns err when channel is not text-based", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({ isTextBased: () => false });

    const result = await adapter.removeReaction("C123", "msg-1", "🔥");

    expect(result.ok).toBe(false);
  });
});

describe("createDiscordAdapter deleteMessage", () => {
  it("calls msg.delete on the fetched message", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const deleteFn = vi.fn(async () => undefined);
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => ({ delete: deleteFn })) },
    });

    const result = await adapter.deleteMessage("C123", "msg-1");

    expect(result.ok).toBe(true);
    expect(deleteFn).toHaveBeenCalled();
  });

  it("returns err when channel is not text-based", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({ isTextBased: () => false });

    const result = await adapter.deleteMessage("C123", "msg-1");

    expect(result.ok).toBe(false);
  });
});

describe("createDiscordAdapter fetchMessages", () => {
  it("maps Discord message Map to FetchedMessage[] preserving order", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const messagesMap = new Map();
    messagesMap.set("m1", {
      id: "m1",
      author: { id: "u1" },
      content: "hello",
      createdTimestamp: 100,
    });
    messagesMap.set("m2", {
      id: "m2",
      author: { id: "u2" },
      content: "",
      createdTimestamp: 200,
    });
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: vi.fn(async () => messagesMap) },
    });

    const result = await adapter.fetchMessages("C123");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toMatchObject({ id: "m1", text: "hello" });
      expect(result.value[1]).toMatchObject({ id: "m2", text: "" });
    }
  });

  it("passes options.before through to Discord messages.fetch", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const fetchFn = vi.fn(async () => new Map());
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      messages: { fetch: fetchFn },
    });

    await adapter.fetchMessages("C123", { limit: 50, before: "m-before" });

    expect(fetchFn).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, before: "m-before" }),
    );
  });

  it("returns err when channel is not text-based", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({ isTextBased: () => false });

    const result = await adapter.fetchMessages("C123");

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendAttachment + voice path
// ---------------------------------------------------------------------------

describe("createDiscordAdapter sendAttachment", () => {
  it("delegates to voice sender for voice notes", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/voice.ogg",
      type: "audio",
      mimeType: "audio/ogg",
      isVoiceNote: true,
      durationSecs: 5,
      waveform: "wave-data",
    } as never);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("voice-msg-1");
    }
  });

  it("returns err when target channel is not text-based for regular attachment", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({ isTextBased: () => false });

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/img.png",
      type: "image",
      mimeType: "image/png",
      fileName: "img.png",
      caption: "look",
    } as never);

    expect(result.ok).toBe(false);
  });

  it("returns err and logs warning when channel.send throws for regular attachment", async () => {
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      send: vi.fn(async () => {
        throw new Error("upload_failed");
      }),
    });

    const result = await adapter.sendAttachment("C123", {
      url: "https://example.com/img.png",
      type: "image",
      mimeType: "image/png",
      fileName: "img.png",
    } as never);

    expect(result.ok).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: "discord",
        hint: expect.stringContaining("Attach Files"),
      }),
      "Send attachment failed",
    );
  });

  it("uses 'file' as fallback filename when attachment.fileName is missing", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    const sendFn = vi.fn(async () => ({ id: "m-att" }));
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      send: sendFn,
    });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/doc.pdf",
      type: "document",
      mimeType: "application/pdf",
    } as never);

    expect(sendFn).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ name: "file" })],
      }),
    );
  });

  it("keeps attachment captions and filenames out of outbound logs", async () => {
    const privateCaption = "PRIVATE-DISCORD-CAPTION-DO-NOT-LOG";
    const privateFileName = "PRIVATE-DISCORD-FILENAME-DO-NOT-LOG.xlsx";
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    await adapter.start();
    mockChannelsFetch.mockResolvedValue({
      isTextBased: () => true,
      send: vi.fn(async () => ({ id: "m-private" })),
    });

    await adapter.sendAttachment("C123", {
      url: "https://example.com/private-caption.xlsx",
      type: "file",
      fileName: privateFileName,
      caption: privateCaption,
    });
    await adapter.sendAttachment("C123", {
      url: "https://example.com/private-filename.xlsx",
      type: "file",
      fileName: privateFileName,
    });

    const serializedLogs = JSON.stringify([
      ...vi.mocked(deps.logger.debug).mock.calls,
      ...vi.mocked(deps.logger.info).mock.calls,
      ...vi.mocked(deps.logger.warn).mock.calls,
      ...vi.mocked(deps.logger.error).mock.calls,
    ]);
    expect(serializedLogs).not.toContain(privateCaption);
    expect(serializedLogs).not.toContain(privateFileName);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentType: "file",
        captionLength: privateCaption.length,
        hasFileName: true,
      }),
      "Outbound attachment",
    );
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("createDiscordAdapter getStatus", () => {
  it("reports uptime computed since startedAt after successful start", async () => {
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();
    // Allow a small interval so uptime > 0
    await new Promise((r) => setTimeout(r, 5));
    const status = adapter.getStatus();
    expect(status.connected).toBe(true);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.connectionMode).toBe("socket");
  });

  it("reports connected=false and uptime=undefined before start()", () => {
    const adapter = createDiscordAdapter(makeDeps());
    const status = adapter.getStatus();
    expect(status.connected).toBe(false);
    expect(status.uptime).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// stop() error path
// ---------------------------------------------------------------------------

describe("createDiscordAdapter stop()", () => {
  it("returns err when client.destroy() throws", async () => {
    mockDestroy.mockImplementation(() => {
      throw new Error("destroy-failed");
    });
    const adapter = createDiscordAdapter(makeDeps());
    await adapter.start();

    const result = await adapter.stop();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("destroy-failed");
    }
  });
});

// ---------------------------------------------------------------------------
// onMessage handler error recovery
// ---------------------------------------------------------------------------

describe("createDiscordAdapter onMessage error handling", () => {
  it("catches synchronous handler exceptions and logs error", async () => {
    const { mapDiscordToNormalized } = await import("./message-mapper.js");
    vi.mocked(mapDiscordToNormalized).mockReturnValue({
      id: "00000000-0000-0000-0000-000000000001",
      channelId: "C1",
      channelType: "discord",
      senderId: "u1",
      text: "hi",
      timestamp: 0,
      attachments: [],
      metadata: {},
    });
    const deps = makeDeps();
    const adapter = createDiscordAdapter(deps);
    adapter.onMessage(() => {
      throw new Error("sync-handler-throw");
    });
    await adapter.start();

    const messageCreateHandler = eventHandlers.get("messageCreate");
    messageCreateHandler!({
      id: "m1",
      author: { id: "u1", bot: false },
      channelId: "C1",
      channel: { type: 0, isThread: () => false },
      attachments: new Map(),
      stickers: new Map(),
      content: "hi",
      createdTimestamp: 0,
    });

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "internal",
      }),
      "Message handler error",
    );
  });
});
