// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for Discord adapter runWithContext wrap.
 *
 * Asserts that both the MessageCreate and InteractionCreate handlers stamp
 * msg.metadata.traceId and run handlers inside runWithContext so the traceId
 * propagates via AsyncLocalStorage.
 *
 * @module
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------

const eventHandlers = new Map<string, (...args: any[]) => void>();

const mockLogin = vi.fn();
const mockDestroy = vi.fn();

vi.mock("discord.js", () => {
  class MockClient {
    channels = { fetch: vi.fn() };
    guilds = { fetch: vi.fn() };
    user = { setPresence: vi.fn() };

    on(event: string, handler: (...args: any[]) => void) {
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
    ChannelType: {
      GuildText: 0,
      GuildVoice: 2,
      GuildCategory: 4,
      GuildAnnouncement: 5,
    },
    ActivityType: {
      Playing: 0,
      Watching: 3,
      Listening: 2,
      Competing: 5,
    },
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok } from "@comis/shared";
import { tryGetContext } from "@comis/core";
import type { NormalizedMessage } from "@comis/core";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { validateDiscordToken } from "./credential-validator.js";
import { createDiscordAdapter, type DiscordAdapterDeps } from "./discord-adapter.js";
import { mapDiscordToNormalized } from "./message-mapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<DiscordAdapterDeps>): DiscordAdapterDeps {
  return {
    botToken: "discord-bot-token",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeDiscordMessage(overrides: Record<string, unknown> = {}): any {
  return {
    id: "msg-42",
    channelId: "channel-123",
    content: "Hello",
    createdTimestamp: Date.now(),
    guildId: null,
    author: { id: "user-1", bot: false },
    channel: { type: 0, isThread: () => false, id: "channel-123" },
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

function makeNormalized(): NormalizedMessage {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "channel-123",
    channelType: "discord",
    senderId: "user-1",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: {},
  };
}

function makeInteraction(overrides: Record<string, unknown> = {}): any {
  return {
    isButton: () => true,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    customId: "btn-action",
    channelId: "channel-123",
    user: { id: "user-1", username: "alice" },
    message: { id: "msg-99" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discord-adapter -- MessageCreate + InteractionCreate runWithContext wrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    vi.mocked(validateDiscordToken).mockResolvedValue(
      ok({ id: "123", username: "test_bot", discriminator: "0" }),
    );
    mockLogin.mockResolvedValue("token");
  });

  describe("MessageCreate handler", () => {
    it("stamps normalized.metadata.traceId before dispatching to handlers", async () => {
      let captured: NormalizedMessage | undefined;
      const normalized = makeNormalized();
      vi.mocked(mapDiscordToNormalized).mockReturnValue(normalized);

      const adapter = createDiscordAdapter(makeDeps());
      adapter.onMessage(async (m) => { captured = m; });
      await adapter.start();

      const messageCreateHandler = eventHandlers.get("messageCreate");
      expect(messageCreateHandler).toBeDefined();
      messageCreateHandler!(makeDiscordMessage());

      await new Promise((r) => setTimeout(r, 10));

      expect(typeof captured?.metadata.traceId).toBe("string");
      expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
    });

    it("runs handlers inside runWithContext({ traceId, channelType: \"discord\" })", async () => {
      let ctxTraceId: string | undefined;
      let ctxChannelType: string | undefined;
      let ctxTrustLevel: string | undefined;
      let stampedTraceId: string | undefined;
      const normalized = makeNormalized();
      vi.mocked(mapDiscordToNormalized).mockReturnValue(normalized);

      const adapter = createDiscordAdapter(makeDeps());
      adapter.onMessage(async (m) => {
        const ctx = tryGetContext();
        ctxTraceId = ctx?.traceId;
        ctxChannelType = ctx?.channelType;
        ctxTrustLevel = ctx?.trustLevel;
        stampedTraceId = m.metadata.traceId;
      });
      await adapter.start();

      const messageCreateHandler = eventHandlers.get("messageCreate");
      messageCreateHandler!(makeDiscordMessage());

      await new Promise((r) => setTimeout(r, 10));

      expect(ctxTraceId).toBeDefined();
      expect(ctxTraceId).toBe(stampedTraceId);
      expect(ctxChannelType).toBe("discord");
      expect(ctxTrustLevel).toBe("user");
    });
  });

  describe("InteractionCreate handler", () => {
    it("stamps normalized.metadata.traceId for button interaction", async () => {
      let captured: NormalizedMessage | undefined;

      const adapter = createDiscordAdapter(makeDeps());
      adapter.onMessage(async (m) => { captured = m; });
      await adapter.start();

      const interactionCreateHandler = eventHandlers.get("interactionCreate");
      expect(interactionCreateHandler).toBeDefined();
      await interactionCreateHandler!(makeInteraction());

      await new Promise((r) => setTimeout(r, 10));

      expect(typeof captured?.metadata.traceId).toBe("string");
      expect(captured?.metadata.traceId).toMatch(/^[0-9a-f]{8}-/i);
    });

    it("runs handlers inside runWithContext({ traceId, channelType: \"discord\" }) for interactions", async () => {
      let ctxTraceId: string | undefined;
      let ctxChannelType: string | undefined;
      let ctxTrustLevel: string | undefined;
      let stampedTraceId: string | undefined;

      const adapter = createDiscordAdapter(makeDeps());
      adapter.onMessage(async (m) => {
        const ctx = tryGetContext();
        ctxTraceId = ctx?.traceId;
        ctxChannelType = ctx?.channelType;
        ctxTrustLevel = ctx?.trustLevel;
        stampedTraceId = m.metadata.traceId;
      });
      await adapter.start();

      const interactionCreateHandler = eventHandlers.get("interactionCreate");
      await interactionCreateHandler!(makeInteraction());

      await new Promise((r) => setTimeout(r, 10));

      expect(ctxTraceId).toBeDefined();
      expect(ctxTraceId).toBe(stampedTraceId);
      expect(ctxChannelType).toBe("discord");
      expect(ctxTrustLevel).toBe("user");
    });
  });
});
