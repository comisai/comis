import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ImsgNotification } from "./imessage-client.js";
import type { ImsgMessageParams } from "./message-mapper.js";

// Mock the imsg client to capture notification handlers and request calls
const mockOnNotification = vi.fn();
const mockRequest = vi.fn();
const mockStart = vi.fn();
const mockClose = vi.fn();

vi.mock("./imessage-client.js", () => ({
  createImsgClient: vi.fn(() => ({
    start: mockStart,
    close: mockClose,
    request: mockRequest,
    onNotification: mockOnNotification,
  })),
}));

// Mock the credential validator
const mockValidate = vi.fn();
vi.mock("./credential-validator.js", () => ({
  validateIMessageConnection: (...args: unknown[]) => mockValidate(...args),
}));

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createIMessageAdapter } from "./imessage-adapter.js";

describe("createIMessageAdapter", () => {
  const mockLogger = createMockLogger();

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockValidate.mockResolvedValue({
      ok: true,
      value: { platform: "macos", available: true },
    });
    mockStart.mockResolvedValue({ ok: true, value: undefined });
    mockClose.mockResolvedValue({ ok: true, value: undefined });
    mockRequest.mockResolvedValue({ ok: true, value: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("lifecycle", () => {
    it("creates adapter with pending channelId", () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      expect(adapter.channelId).toBe("imessage-pending");
      expect(adapter.channelType).toBe("imessage");
    });

    it("sets channelId from account on start", async () => {
      const adapter = createIMessageAdapter({
        logger: mockLogger,
        account: "user@apple.com",
      });

      await adapter.start();
      expect(adapter.channelId).toBe("imessage-user@apple.com");
    });

    it("uses default channelId when no account provided", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();
      expect(adapter.channelId).toBe("imessage-default");
    });

    it("stops gracefully", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();

      const result = await adapter.stop();
      expect(result.ok).toBe(true);
      expect(mockClose).toHaveBeenCalledOnce();
    });

    it("stop succeeds when not started", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const result = await adapter.stop();
      expect(result.ok).toBe(true);
    });
  });

  describe("receive path (onNotification)", () => {
    it("registers notification handler on start", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();

      // onNotification should have been called to register the handler
      expect(mockOnNotification).toHaveBeenCalledOnce();
      expect(typeof mockOnNotification.mock.calls[0][0]).toBe("function");
    });

    it("dispatches incoming messages to registered handlers", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const handler = vi.fn();
      adapter.onMessage(handler);

      await adapter.start();

      // Get the notification handler that was registered
      const notificationHandler = mockOnNotification.mock.calls[0][0] as (
        notification: ImsgNotification,
      ) => void;

      // Simulate an incoming message notification
      const messageParams: ImsgMessageParams = {
        chatId: "42",
        sender: "+15551234567",
        text: "Hello from iMessage",
        timestamp: 1700000000000,
        isGroup: false,
        isFromMe: false,
      };

      notificationHandler({
        method: "message",
        params: { message: messageParams },
      });

      // Handler should receive a NormalizedMessage
      expect(handler).toHaveBeenCalledOnce();
      const normalized = handler.mock.calls[0][0];
      expect(normalized.channelType).toBe("imessage");
      expect(normalized.senderId).toBe("+15551234567");
      expect(normalized.text).toBe("Hello from iMessage");
      expect(normalized.channelId).toBe("42");
    });

    it("skips messages from self (isFromMe)", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const handler = vi.fn();
      adapter.onMessage(handler);

      await adapter.start();

      const notificationHandler = mockOnNotification.mock.calls[0][0] as (
        notification: ImsgNotification,
      ) => void;

      notificationHandler({
        method: "message",
        params: {
          message: {
            chatId: "42",
            sender: "me@apple.com",
            text: "My own message",
            timestamp: 1700000000000,
            isFromMe: true,
          },
        },
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it("ignores non-message notifications", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const handler = vi.fn();
      adapter.onMessage(handler);

      await adapter.start();

      const notificationHandler = mockOnNotification.mock.calls[0][0] as (
        notification: ImsgNotification,
      ) => void;

      notificationHandler({
        method: "error",
        params: { code: 500, message: "something failed" },
      });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("send path (client.request)", () => {
    it("sends message via client.request('send')", async () => {
      mockRequest.mockResolvedValue({
        ok: true,
        value: { messageId: "msg-123" },
      });

      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();

      const result = await adapter.sendMessage("42", "Hello!");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("msg-123");
      }

      // Verify the send request was made correctly
      const sendCall = mockRequest.mock.calls.find(
        (call) => call[0] === "send",
      );
      expect(sendCall).toBeDefined();
      expect(sendCall![1]).toEqual({
        chat_id: "42",
        text: "Hello!",
      });
    });

    it("returns error when adapter not started", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const result = await adapter.sendMessage("42", "Hello!");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not started");
      }
    });

    it("handles send failure gracefully", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();

      // Override for the send call specifically
      mockRequest.mockResolvedValueOnce({
        ok: false,
        error: new Error("Network error"),
      });

      const result = await adapter.sendMessage("42", "Hello!");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send iMessage");
      }
    });
  });

  describe("unsupported operations", () => {
    it("returns error for editMessage", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const result = await adapter.editMessage("42", "msg-1", "Updated");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not supported");
      }
    });

    it("returns error for reactToMessage", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const result = await adapter.reactToMessage("42", "msg-1", "thumbsup");
      expect(result.ok).toBe(false);
    });

    it("returns error for deleteMessage", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      const result = await adapter.deleteMessage("42", "msg-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("not supported");
      }
    });

    it("returns ok with reason for sendTyping", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();
      const result = await adapter.platformAction("sendTyping", {});
      expect(result.ok).toBe(true);
    });

    it("returns error for unsupported platform action", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();
      const result = await adapter.platformAction("unknown_action", {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Unsupported action");
        expect(result.error.message).toContain("imessage");
      }
    });
  });

  describe("fetchMessages", () => {
    it("fetches message history via client.request", async () => {
      const adapter = createIMessageAdapter({ logger: mockLogger });
      await adapter.start();

      mockRequest.mockResolvedValueOnce({
        ok: true,
        value: {
          messages: [
            { id: 1, sender: "+15551234567", text: "Hello", timestamp: 1700000000000 },
            { id: 2, sender: "+15559876543", text: "Hi back", timestamp: 1700000001000 },
          ],
        },
      });

      const result = await adapter.fetchMessages("42", { limit: 10 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(2);
        expect(result.value[0].id).toBe("1");
        expect(result.value[0].senderId).toBe("+15551234567");
        expect(result.value[0].text).toBe("Hello");
      }
    });
  });
});
