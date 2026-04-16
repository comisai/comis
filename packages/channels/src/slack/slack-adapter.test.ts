import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track event/action handlers registered on the Bolt App
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const eventHandlers = new Map<string, (...args: any[]) => void>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let actionHandler: ((...args: any[]) => void) | null = null;

const mockAppStart = vi.fn();
const mockAppStop = vi.fn();
const mockPostMessage = vi.fn();
const mockChatUpdate = vi.fn();
const mockChatDelete = vi.fn();
const mockPinsAdd = vi.fn();
const mockPinsRemove = vi.fn();
const mockConversationsSetTopic = vi.fn();
const mockConversationsSetPurpose = vi.fn();
const mockConversationsArchive = vi.fn();
const mockConversationsUnarchive = vi.fn();
const mockConversationsCreate = vi.fn();
const mockConversationsInvite = vi.fn();
const mockConversationsKick = vi.fn();
const mockConversationsInfo = vi.fn();
const mockConversationsMembers = vi.fn();
const mockConversationsHistory = vi.fn();
const mockBookmarksAdd = vi.fn();
const mockReactionsAdd = vi.fn();
const mockFilesUploadV2 = vi.fn();

vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(function (config: Record<string, unknown>) {
    return {
      _config: config,
      event(name: string, handler: (...args: unknown[]) => void) {
        eventHandlers.set(name, handler);
      },
      action(_pattern: unknown, handler: (...args: unknown[]) => void) {
        actionHandler = handler;
      },
      start: mockAppStart,
      stop: mockAppStop,
      client: {
        chat: {
          postMessage: mockPostMessage,
          update: mockChatUpdate,
          delete: mockChatDelete,
        },
        pins: {
          add: mockPinsAdd,
          remove: mockPinsRemove,
        },
        conversations: {
          setTopic: mockConversationsSetTopic,
          setPurpose: mockConversationsSetPurpose,
          archive: mockConversationsArchive,
          unarchive: mockConversationsUnarchive,
          create: mockConversationsCreate,
          invite: mockConversationsInvite,
          kick: mockConversationsKick,
          info: mockConversationsInfo,
          members: mockConversationsMembers,
          history: mockConversationsHistory,
        },
        bookmarks: {
          add: mockBookmarksAdd,
        },
        reactions: {
          add: mockReactionsAdd,
        },
        files: {
          uploadV2: mockFilesUploadV2,
        },
      },
    };
  }),
}));

vi.mock("./credential-validator.js", () => ({
  validateSlackCredentials: vi.fn(),
}));

vi.mock("./message-mapper.js", () => ({
  mapSlackToNormalized: vi.fn(),
}));

// format-slack.js no longer exports markdownToSlackMrkdwn (deleted in 498-01).
// Adapter is now a passthrough -- text arrives pre-formatted from the pipeline.

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ok, err } from "@comis/shared";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { App } from "@slack/bolt";
import { validateSlackCredentials } from "./credential-validator.js";
import { mapSlackToNormalized } from "./message-mapper.js";
import { createSlackAdapter, type SlackAdapterDeps } from "./slack-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<SlackAdapterDeps>): SlackAdapterDeps {
  return {
    botToken: "xoxb-test-token",
    mode: "socket",
    appToken: "xapp-1-test-token",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeSlackEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "message",
    channel: "C123ABC",
    user: "U456DEF",
    text: "Hello world",
    ts: "1700000000.123456",
    ...overrides,
  };
}

function makeNormalized() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "C123ABC",
    channelType: "slack" as const,
    senderId: "U456DEF",
    text: "Hello world",
    timestamp: 1700000000000,
    attachments: [],
    metadata: { slackTs: "1700000000.123456" },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSlackAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    actionHandler = null;
    mockAppStart.mockResolvedValue(undefined);
    mockAppStop.mockResolvedValue(undefined);
  });

  describe("channelType", () => {
    it("returns 'slack'", () => {
      const adapter = createSlackAdapter(makeDeps());
      expect(adapter.channelType).toBe("slack");
    });
  });

  describe("channelId", () => {
    it("starts as 'slack-pending'", () => {
      const adapter = createSlackAdapter(makeDeps());
      expect(adapter.channelId).toBe("slack-pending");
    });
  });

  describe("start()", () => {
    it("validates credentials and returns ok on valid credentials", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U123", teamId: "T456", botId: "B789" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      const result = await adapter.start();

      expect(result.ok).toBe(true);
      expect(validateSlackCredentials).toHaveBeenCalledWith({
        botToken: "xoxb-test-token",
        mode: "socket",
        appToken: "xapp-1-test-token",
        signingSecret: undefined,
      });
    });

    it("returns err on invalid credentials and logs Adapter start failed", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        err(new Error("Socket Mode requires appToken")),
      );

      const deps = makeDeps();
      const adapter = createSlackAdapter(deps);
      const result = await adapter.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Socket Mode requires appToken");
      }
      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "slack",
          hint: expect.stringContaining("SLACK_APP_TOKEN"),
          errorKind: "auth",
        }),
        "Adapter start failed",
      );
    });

    it("sets channelId from bot info", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U111", teamId: "T222", botId: "B333" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();

      expect(adapter.channelId).toBe("slack-T222-U111");
    });

    it("creates Bolt App with socketMode: true for socket mode", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const deps = makeDeps({ mode: "socket", appToken: "xapp-1-token" });
      const adapter = createSlackAdapter(deps);
      await adapter.start();

      expect(App).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        appToken: "xapp-1-token",
        socketMode: true,
      });
    });

    it("creates Bolt App with signingSecret for HTTP mode", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const deps = makeDeps({
        mode: "http",
        signingSecret: "test-secret",
        appToken: undefined,
      });
      const adapter = createSlackAdapter(deps);
      await adapter.start();

      expect(App).toHaveBeenCalledWith({
        token: "xoxb-test-token",
        signingSecret: "test-secret",
      });
    });

    it("logs standardized 'Adapter started' on success", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const deps = makeDeps();
      const adapter = createSlackAdapter(deps);
      await adapter.start();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "slack",
          mode: "socket",
        }),
        "Adapter started",
      );
    });

    it("calls app.start()", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();

      expect(mockAppStart).toHaveBeenCalled();
    });
  });

  describe("onMessage", () => {
    it("dispatches normalized messages to registered handlers", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U_BOT", teamId: "T1", botId: "B_BOT" }),
      );
      const normalized = makeNormalized();
      vi.mocked(mapSlackToNormalized).mockReturnValue(normalized);

      const adapter = createSlackAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      // Simulate Slack message event
      const messageHandler = eventHandlers.get("message");
      expect(messageHandler).toBeDefined();
      await messageHandler!({ event: makeSlackEvent() });

      // Wait for fire-and-forget
      await new Promise((r) => setTimeout(r, 10));

      expect(mapSlackToNormalized).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("filters out bot's own messages (matching bot_id)", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U_BOT", teamId: "T1", botId: "B_OWN" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      await messageHandler!({ event: makeSlackEvent({ bot_id: "B_OWN" }) });

      await new Promise((r) => setTimeout(r, 10));

      expect(mapSlackToNormalized).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("allows messages from other bots (different bot_id)", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U_BOT", teamId: "T1", botId: "B_OWN" }),
      );
      vi.mocked(mapSlackToNormalized).mockReturnValue(makeNormalized());

      const adapter = createSlackAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      await messageHandler!({ event: makeSlackEvent({ bot_id: "B_OTHER" }) });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalled();
    });

    it("filters messages from own user ID", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U_BOT", teamId: "T1", botId: "B_OWN" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      await messageHandler!({ event: makeSlackEvent({ user: "U_BOT" }) });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler).not.toHaveBeenCalled();
    });

    it("calls multiple handlers for each message", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U_BOT", teamId: "T1", botId: "B_BOT" }),
      );
      vi.mocked(mapSlackToNormalized).mockReturnValue(makeNormalized());

      const adapter = createSlackAdapter(makeDeps());
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.onMessage(handler1);
      adapter.onMessage(handler2);
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      await messageHandler!({ event: makeSlackEvent() });

      await new Promise((r) => setTimeout(r, 10));

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("logs error when handler throws (fire-and-forget)", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U_BOT", teamId: "T1", botId: "B_BOT" }),
      );
      vi.mocked(mapSlackToNormalized).mockReturnValue(makeNormalized());

      const deps = makeDeps();
      const adapter = createSlackAdapter(deps);
      adapter.onMessage(() => {
        throw new Error("Handler failed");
      });
      await adapter.start();

      const messageHandler = eventHandlers.get("message");
      await messageHandler!({ event: makeSlackEvent() });

      await new Promise((r) => setTimeout(r, 10));

      expect(deps.logger.error).toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("passes text through as-is (pre-formatted mrkdwn from pipeline)", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockPostMessage.mockResolvedValue({ ok: true, ts: "1700000001.000000" });

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.sendMessage("C123", "*already mrkdwn* text");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("1700000001.000000");
      }
      // Adapter should NOT convert -- text arrives pre-formatted
      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: "C123",
        text: "*already mrkdwn* text",
      });
    });

    it("passes thread_ts from replyTo option", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockPostMessage.mockResolvedValue({ ok: true, ts: "1700000002.000000" });

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      await adapter.sendMessage("C123", "Reply text", {
        replyTo: "1699999999.000000",
      });

      expect(mockPostMessage).toHaveBeenCalledWith({
        channel: "C123",
        text: "Reply text",
        thread_ts: "1699999999.000000",
      });
    });

    it("returns err on API failure", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockPostMessage.mockRejectedValue(new Error("channel_not_found"));

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.sendMessage("bad-channel", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send Slack message");
      }
    });
  });

  describe("editMessage", () => {
    it("calls chat.update with text as-is (passthrough, pre-formatted by RPC handler)", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockChatUpdate.mockResolvedValue({ ok: true });

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.editMessage("C123", "1700000001.000000", "*pre-formatted* mrkdwn");

      expect(result.ok).toBe(true);
      // Adapter should NOT convert -- text arrives pre-formatted from RPC handler
      expect(mockChatUpdate).toHaveBeenCalledWith({
        channel: "C123",
        ts: "1700000001.000000",
        text: "*pre-formatted* mrkdwn",
      });
    });

    it("returns err on API failure", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockChatUpdate.mockRejectedValue(new Error("message_not_found"));

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.editMessage("C123", "bad-ts", "text");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to edit Slack message");
      }
    });
  });

  describe("platformAction", () => {
    it("channel_info returns channel details", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockConversationsInfo.mockResolvedValue({
        channel: {
          id: "C123",
          name: "general",
          topic: { value: "General discussion" },
          purpose: { value: "A place for general chat" },
          is_archived: false,
          num_members: 10,
        },
      });

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.platformAction("channel_info", { channel_id: "C123" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          id: "C123",
          name: "general",
          topic: "General discussion",
          purpose: "A place for general chat",
          isArchived: false,
          memberCount: 10,
        });
      }
    });

    it("pin calls pins.add via SDK", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockPinsAdd.mockResolvedValue({ ok: true });

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.platformAction("pin", {
        channel_id: "C123",
        message_id: "1700000001.000000",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ pinned: true });
      }
      expect(mockPinsAdd).toHaveBeenCalledWith({
        channel: "C123",
        timestamp: "1700000001.000000",
      });
    });

    it("unsupported action returns error", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.platformAction("does_not_exist", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Unsupported action: does_not_exist on slack");
      }
    });

    it("SDK error returns descriptive failure", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockConversationsInfo.mockRejectedValue(new Error("channel_not_found"));

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.platformAction("channel_info", { channel_id: "bad" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(
          "Slack action 'channel_info' failed: channel_not_found",
        );
      }
    });
  });

  describe("stop()", () => {
    it("calls app.stop()", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.stop();

      expect(result.ok).toBe(true);
      expect(mockAppStop).toHaveBeenCalled();
    });

    it("logs standardized 'Adapter stopped' on success", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );

      const deps = makeDeps();
      const adapter = createSlackAdapter(deps);
      await adapter.start();
      await adapter.stop();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "slack" }),
        "Adapter stopped",
      );
    });

    it("returns ok when app was never started", async () => {
      const adapter = createSlackAdapter(makeDeps());
      const result = await adapter.stop();

      expect(result.ok).toBe(true);
    });

    it("returns err when stop throws", async () => {
      vi.mocked(validateSlackCredentials).mockResolvedValue(
        ok({ userId: "U1", teamId: "T1", botId: "B1" }),
      );
      mockAppStop.mockRejectedValue(new Error("stop failed"));

      const adapter = createSlackAdapter(makeDeps());
      await adapter.start();
      const result = await adapter.stop();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to stop Slack adapter");
      }
    });
  });
});
