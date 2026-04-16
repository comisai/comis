import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (vi.hoisted ensures these are available when vi.mock factories run)
// ---------------------------------------------------------------------------

const {
  mockPushMessage,
  mockShowLoadingAnimation,
  mockGetMessageContent,
  mockMapLineToNormalized,
  mockIsMessageEvent,
  mockBuildFlexMessage,
} = vi.hoisted(() => ({
  mockPushMessage: vi.fn(),
  mockShowLoadingAnimation: vi.fn(),
  mockGetMessageContent: vi.fn(),
  mockMapLineToNormalized: vi.fn(),
  mockIsMessageEvent: vi.fn(() => false),
  mockBuildFlexMessage: vi.fn(),
}));

vi.mock("@line/bot-sdk", () => {
  class MockMessagingApiClient {
    pushMessage = mockPushMessage;
    showLoadingAnimation = mockShowLoadingAnimation;
  }
  class MockMessagingApiBlobClient {
    getMessageContent = mockGetMessageContent;
  }
  return {
    messagingApi: {
      MessagingApiClient: MockMessagingApiClient,
      MessagingApiBlobClient: MockMessagingApiBlobClient,
    },
    webhook: {},
  };
});

vi.mock("./message-mapper.js", () => ({
  mapLineToNormalized: mockMapLineToNormalized,
  isMessageEvent: mockIsMessageEvent,
}));

vi.mock("./flex-builder.js", () => ({
  buildFlexMessage: mockBuildFlexMessage,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createLineAdapter, type LineAdapterDeps } from "./line-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<LineAdapterDeps>): LineAdapterDeps {
  return {
    channelAccessToken: "test-channel-access-token",
    channelSecret: "test-channel-secret",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(overrides?: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "U1234",
    channelType: "line" as const,
    senderId: "U5678",
    text: "Hello",
    timestamp: Date.now(),
    attachments: [],
    metadata: { lineReplyToken: "tok-1" },
    ...overrides,
  };
}

function makePushResponse(messageId = "msg-001") {
  return { sentMessages: [{ id: messageId }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLineAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // channelId and channelType
  // -----------------------------------------------------------------------

  describe("channelId and channelType", () => {
    it("has initial channelId of 'line-pending'", () => {
      const adapter = createLineAdapter(makeDeps());
      expect(adapter.channelId).toBe("line-pending");
    });

    it("has channelType of 'line'", () => {
      const adapter = createLineAdapter(makeDeps());
      expect(adapter.channelType).toBe("line");
    });
  });

  // -----------------------------------------------------------------------
  // start() -- credential validation
  // -----------------------------------------------------------------------

  describe("start()", () => {
    it("returns ok when valid token and secret provided", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.start();
      expect(result.ok).toBe(true);
    });

    it("returns err when channelAccessToken is empty string", async () => {
      const adapter = createLineAdapter(makeDeps({ channelAccessToken: "" }));
      const result = await adapter.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("must not be empty");
      }
    });

    it("returns err when channelSecret is empty/whitespace", async () => {
      const adapter = createLineAdapter(makeDeps({ channelSecret: "   " }));
      const result = await adapter.start();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("must not be empty");
      }
    });

    it("logs info on successful start", async () => {
      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      await adapter.start();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "line",
          mode: "webhook",
        }),
        "Adapter started",
      );
    });

    it("logs error on credential failure", async () => {
      const deps = makeDeps({ channelAccessToken: "" });
      const adapter = createLineAdapter(deps);
      await adapter.start();

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "line",
          errorKind: "auth",
          hint: expect.stringContaining("LINE_CHANNEL_ACCESS_TOKEN"),
        }),
        "Adapter start failed",
      );
    });
  });

  // -----------------------------------------------------------------------
  // stop()
  // -----------------------------------------------------------------------

  describe("stop()", () => {
    it("returns ok (LINE is stateless)", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.stop();
      expect(result.ok).toBe(true);
    });

    it("logs info on stop", async () => {
      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      await adapter.stop();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "line" }),
        "Adapter stopped",
      );
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage
  // -----------------------------------------------------------------------

  describe("sendMessage", () => {
    it("calls client.pushMessage with correct to and text message", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse("msg-100"));

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendMessage("U1234", "Hello LINE");

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [{ type: "text", text: "Hello LINE" }],
      });
    });

    it("returns ok with messageId from response", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse("msg-200"));

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.sendMessage("U1234", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("msg-200");
      }
    });

    it("returns ok('sent') when sentMessages is empty", async () => {
      mockPushMessage.mockResolvedValue({ sentMessages: [] });

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.sendMessage("U1234", "Hello");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("sent");
      }
    });

    it("returns err when pushMessage throws", async () => {
      mockPushMessage.mockRejectedValue(new Error("Rate limited"));

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.sendMessage("U1234", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send LINE message");
        expect(result.error.message).toContain("Rate limited");
      }
    });
  });

  // -----------------------------------------------------------------------
  // sendAttachment -- type mapping
  // -----------------------------------------------------------------------

  describe("sendAttachment", () => {
    it("image attachment: sends LINE image message", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendAttachment("U1234", {
        type: "image",
        url: "https://example.com/photo.jpg",
      });

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          {
            type: "image",
            originalContentUrl: "https://example.com/photo.jpg",
            previewImageUrl: "https://example.com/photo.jpg",
          },
        ],
      });
    });

    it("video attachment: sends LINE video message", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendAttachment("U1234", {
        type: "video",
        url: "https://example.com/clip.mp4",
      });

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          {
            type: "video",
            originalContentUrl: "https://example.com/clip.mp4",
            previewImageUrl: "https://example.com/clip.mp4",
          },
        ],
      });
    });

    it("audio attachment with voice note: sends audio with duration in ms", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendAttachment("U1234", {
        type: "audio",
        url: "https://example.com/voice.ogg",
        isVoiceNote: true,
        durationSecs: 5.5,
      });

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          {
            type: "audio",
            originalContentUrl: "https://example.com/voice.ogg",
            duration: 5500,
          },
        ],
      });
    });

    it("audio attachment without voice note: sends with duration 0", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendAttachment("U1234", {
        type: "audio",
        url: "https://example.com/audio.mp3",
      });

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          {
            type: "audio",
            originalContentUrl: "https://example.com/audio.mp3",
            duration: 0,
          },
        ],
      });
    });

    it("file/default attachment: sends as text message with URL", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendAttachment("U1234", {
        type: "file",
        url: "https://example.com/doc.pdf",
      });

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [{ type: "text", text: "https://example.com/doc.pdf" }],
      });
    });

    it("file with caption: sends as text message with caption + URL", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const adapter = createLineAdapter(makeDeps());
      await adapter.sendAttachment("U1234", {
        type: "file",
        url: "https://example.com/doc.pdf",
        caption: "Check this out",
      });

      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          { type: "text", text: "Check this out\nhttps://example.com/doc.pdf" },
        ],
      });
    });

    it("voice note: logs voice send started/complete bookend messages", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse());

      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      await adapter.sendAttachment("U1234", {
        type: "audio",
        url: "https://example.com/voice.ogg",
        isVoiceNote: true,
        durationSecs: 3,
      });

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "line",
          chatId: "U1234",
          durationMs: 3000,
        }),
        "Voice send started",
      );
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "line",
          chatId: "U1234",
        }),
        "Voice send complete",
      );
    });

    it("returns err when pushMessage throws", async () => {
      mockPushMessage.mockRejectedValue(new Error("Token expired"));

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.sendAttachment("U1234", {
        type: "image",
        url: "https://example.com/photo.jpg",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send LINE attachment");
      }
    });
  });

  // -----------------------------------------------------------------------
  // handleWebhookEvents -- event dispatch
  // -----------------------------------------------------------------------

  describe("handleWebhookEvents", () => {
    it("message event: calls mapLineToNormalized and dispatches to handlers", () => {
      mockIsMessageEvent.mockReturnValue(true);
      const normalized = makeNormalized();
      mockMapLineToNormalized.mockReturnValue(normalized);

      const adapter = createLineAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" }, source: { type: "user", userId: "U1" } } as any,
      ]);

      expect(mockMapLineToNormalized).toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("non-message event: logs debug, does not dispatch", () => {
      mockIsMessageEvent.mockReturnValue(false);

      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      const handler = vi.fn();
      adapter.onMessage(handler);

      adapter.handleWebhookEvents([{ type: "follow" } as any]);

      expect(handler).not.toHaveBeenCalled();
      expect(deps.logger.debug).toHaveBeenCalled();
    });

    it("null normalized message: logs debug, does not dispatch", () => {
      mockIsMessageEvent.mockReturnValue(true);
      mockMapLineToNormalized.mockReturnValue(null);

      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      const handler = vi.fn();
      adapter.onMessage(handler);

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
      ]);

      expect(handler).not.toHaveBeenCalled();
      expect(deps.logger.debug).toHaveBeenCalled();
    });

    it("multiple handlers all called for each message event", () => {
      mockIsMessageEvent.mockReturnValue(true);
      const normalized = makeNormalized();
      mockMapLineToNormalized.mockReturnValue(normalized);

      const adapter = createLineAdapter(makeDeps());
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.onMessage(handler1);
      adapter.onMessage(handler2);

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
      ]);

      expect(handler1).toHaveBeenCalledWith(normalized);
      expect(handler2).toHaveBeenCalledWith(normalized);
    });

    it("handler sync throw caught and logged", () => {
      mockIsMessageEvent.mockReturnValue(true);
      mockMapLineToNormalized.mockReturnValue(makeNormalized());

      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      adapter.onMessage(() => {
        throw new Error("Handler exploded");
      });

      // Should not throw
      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
      ]);

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Check LINE message handler logic",
          errorKind: "internal",
        }),
        "LINE message handler error",
      );
    });

    it("handler async rejection caught and logged", async () => {
      mockIsMessageEvent.mockReturnValue(true);
      mockMapLineToNormalized.mockReturnValue(makeNormalized());

      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      adapter.onMessage(async () => {
        throw new Error("Async handler failed");
      });

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
      ]);

      // Wait for async rejection handling
      await new Promise((r) => setTimeout(r, 20));

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Check LINE message handler logic",
          errorKind: "internal",
        }),
        "LINE message handler error",
      );
    });

    it("multiple events in batch: each processed independently", () => {
      mockIsMessageEvent.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(true);
      const norm1 = makeNormalized({ id: "id-1" });
      const norm2 = makeNormalized({ id: "id-2" });
      mockMapLineToNormalized.mockReturnValueOnce(norm1).mockReturnValueOnce(norm2);

      const adapter = createLineAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
        { type: "follow" } as any,
        { type: "message", message: { type: "text", id: "m2" } } as any,
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(norm1);
      expect(handler).toHaveBeenCalledWith(norm2);
    });
  });

  // -----------------------------------------------------------------------
  // Unsupported operations
  // -----------------------------------------------------------------------

  describe("unsupported operations", () => {
    it("editMessage returns err with 'does not support' message", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.editMessage("U1234", "msg-1", "new text");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not support");
      }
    });

    it("reactToMessage returns err", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.reactToMessage("U1234", "msg-1", "thumbs_up");

      expect(result.ok).toBe(false);
    });

    it("deleteMessage returns err", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.deleteMessage("U1234", "msg-1");

      expect(result.ok).toBe(false);
    });

    it("fetchMessages returns err", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.fetchMessages("U1234");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not supported on LINE");
      }
    });
  });

  // -----------------------------------------------------------------------
  // platformAction
  // -----------------------------------------------------------------------

  describe("platformAction", () => {
    it("sendFlex with container: calls pushMessage with flex message type", async () => {
      mockPushMessage.mockResolvedValue(makePushResponse("flex-1"));

      const container = { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } };
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.platformAction("sendFlex", {
        chatId: "U1234",
        altText: "Test flex",
        container,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ sent: true, messageId: "flex-1" });
      }
      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          {
            type: "flex",
            altText: "Test flex",
            contents: container,
          },
        ],
      });
    });

    it("sendFlex with template: calls buildFlexMessage then pushMessage", async () => {
      const builtContainer = { type: "bubble", body: { type: "box", layout: "vertical", contents: [] } };
      mockBuildFlexMessage.mockReturnValue(builtContainer);
      mockPushMessage.mockResolvedValue(makePushResponse("flex-2"));

      const template = { body: "Hello", altText: "Fallback" };
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.platformAction("sendFlex", {
        chatId: "U1234",
        template,
      });

      expect(mockBuildFlexMessage).toHaveBeenCalledWith(template);
      expect(result.ok).toBe(true);
      expect(mockPushMessage).toHaveBeenCalledWith({
        to: "U1234",
        messages: [
          {
            type: "flex",
            altText: "Flex Message",
            contents: builtContainer,
          },
        ],
      });
    });

    it("sendFlex missing both container and template: returns err", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.platformAction("sendFlex", { chatId: "U1234" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("requires 'container'");
      }
    });

    it("sendTyping: calls showLoadingAnimation and returns ok", async () => {
      mockShowLoadingAnimation.mockResolvedValue(undefined);

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.platformAction("sendTyping", { chatId: "U1234" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ typing: true });
      }
      expect(mockShowLoadingAnimation).toHaveBeenCalledWith({
        chatId: "U1234",
        loadingSeconds: 20,
      });
    });

    it("sendTyping when showLoadingAnimation throws: returns ok({typing: false})", async () => {
      mockShowLoadingAnimation.mockRejectedValue(new Error("Not supported"));

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.platformAction("sendTyping", { chatId: "U1234" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect((result.value as Record<string, unknown>).typing).toBe(false);
      }
    });

    it("richMenu: returns err directing to createRichMenuManager", async () => {
      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.platformAction("richMenu", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("createRichMenuManager");
      }
    });

    it("unknown action: returns err with unsupported message", async () => {
      const deps = makeDeps();
      const adapter = createLineAdapter(deps);
      const result = await adapter.platformAction("doesNotExist", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported action");
        expect(result.error.message).toContain("doesNotExist");
      }
    });
  });

  // -----------------------------------------------------------------------
  // getBlobContent
  // -----------------------------------------------------------------------

  describe("getBlobContent", () => {
    it("calls blobClient.getMessageContent and collects stream chunks into Buffer", async () => {
      const chunks = [Buffer.from("hello "), Buffer.from("world")];
      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
      mockGetMessageContent.mockResolvedValue(asyncIterable);

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.getBlobContent("msg-123");

      expect(mockGetMessageContent).toHaveBeenCalledWith("msg-123");
      expect(result.toString()).toBe("hello world");
    });

    it("handles non-Buffer chunks via Buffer.from conversion", async () => {
      const chunks = [new Uint8Array([72, 105])]; // "Hi"
      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          for (const c of chunks) yield c;
        },
      };
      mockGetMessageContent.mockResolvedValue(asyncIterable);

      const adapter = createLineAdapter(makeDeps());
      const result = await adapter.getBlobContent("msg-456");

      expect(result.toString()).toBe("Hi");
    });
  });

  // -----------------------------------------------------------------------
  // onMessage
  // -----------------------------------------------------------------------

  describe("onMessage", () => {
    it("registers handler in handlers array", () => {
      mockIsMessageEvent.mockReturnValue(true);
      mockMapLineToNormalized.mockReturnValue(makeNormalized());

      const adapter = createLineAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
      ]);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("multiple handlers can be registered", () => {
      mockIsMessageEvent.mockReturnValue(true);
      mockMapLineToNormalized.mockReturnValue(makeNormalized());

      const adapter = createLineAdapter(makeDeps());
      const h1 = vi.fn();
      const h2 = vi.fn();
      const h3 = vi.fn();
      adapter.onMessage(h1);
      adapter.onMessage(h2);
      adapter.onMessage(h3);

      adapter.handleWebhookEvents([
        { type: "message", message: { type: "text", id: "m1" } } as any,
      ]);

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
      expect(h3).toHaveBeenCalledTimes(1);
    });
  });
});
