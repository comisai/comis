import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Track event listeners registered on the IRC client
const eventListeners: Record<string, ((...args: any[]) => void)[]> = {};

const mockConnect = vi.fn();
const mockSay = vi.fn();
const mockJoin = vi.fn();
const mockPart = vi.fn();
const mockQuit = vi.fn();
const mockSetTopic = vi.fn();

vi.mock("irc-framework", () => {
  class MockClient {
    user = { nick: "comis" };

    connect = mockConnect;
    say = mockSay;
    join = mockJoin;
    part = mockPart;
    quit = mockQuit;
    setTopic = mockSetTopic;

    on(event: string, callback: (...args: any[]) => void): void {
      if (!eventListeners[event]) {
        eventListeners[event] = [];
      }
      eventListeners[event].push(callback);
    }
  }

  return { Client: MockClient };
});

vi.mock("./message-mapper.js", () => ({
  mapIrcToNormalized: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { mapIrcToNormalized } from "./message-mapper.js";
import { createIrcAdapter, type IrcAdapterDeps } from "./irc-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides?: Partial<IrcAdapterDeps>): IrcAdapterDeps {
  return {
    host: "irc.libera.chat",
    nick: "comis",
    logger: createMockLogger(),
    ...overrides,
  };
}

function makeNormalized(overrides?: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    channelId: "#comis",
    channelType: "irc" as const,
    senderId: "user1",
    text: "Hello from IRC",
    timestamp: Date.now(),
    attachments: [],
    metadata: { ircTarget: "#comis", ircIsDm: false },
    ...overrides,
  };
}

/** Emit a mock event on the IRC client */
function emitEvent(event: string, ...args: any[]): void {
  const listeners = eventListeners[event] ?? [];
  for (const listener of listeners) {
    listener(...args);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createIrcAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    // Clear event listeners between tests
    for (const key of Object.keys(eventListeners)) {
      delete eventListeners[key];
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // channelId and channelType
  // -------------------------------------------------------------------------

  describe("channelId", () => {
    it("starts as irc-{host}", () => {
      const adapter = createIrcAdapter(makeDeps());
      expect(adapter.channelId).toBe("irc-irc.libera.chat");
    });
  });

  describe("channelType", () => {
    it("returns 'irc'", () => {
      const adapter = createIrcAdapter(makeDeps());
      expect(adapter.channelType).toBe("irc");
    });
  });

  // -------------------------------------------------------------------------
  // start() -- connection lifecycle
  // -------------------------------------------------------------------------

  describe("start()", () => {
    it("calls bot.connect() with correct host, port, nick, tls params", async () => {
      const adapter = createIrcAdapter(makeDeps({ port: 6697, tls: true }));
      const startPromise = adapter.start();

      // Simulate successful registration
      emitEvent("registered", { nick: "comis" });
      const result = await startPromise;

      expect(result.ok).toBe(true);
      expect(mockConnect).toHaveBeenCalledWith({
        host: "irc.libera.chat",
        port: 6697,
        nick: "comis",
        tls: true,
      });
    });

    it("defaults to port 6697 with TLS true", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      await startPromise;

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ port: 6697, tls: true }),
      );
    });

    it("defaults to port 6667 with TLS false", async () => {
      const adapter = createIrcAdapter(makeDeps({ tls: false }));
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      await startPromise;

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ port: 6667, tls: false }),
      );
    });

    it("resolves ok and updates channelId on 'registered' event", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      const result = await startPromise;

      expect(result.ok).toBe(true);
      expect(adapter.channelId).toBe("irc-comis@irc.libera.chat");
    });

    it("sends NickServ IDENTIFY when nickservPassword provided", async () => {
      const adapter = createIrcAdapter(makeDeps({ nickservPassword: "secret123" }));
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      await startPromise;

      expect(mockSay).toHaveBeenCalledWith("NickServ", "IDENTIFY secret123");
    });

    it("does not send NickServ IDENTIFY when nickservPassword not provided", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      await startPromise;

      expect(mockSay).not.toHaveBeenCalledWith("NickServ", expect.any(String));
    });

    it("auto-joins configured channels on registration", async () => {
      const adapter = createIrcAdapter(makeDeps({ channels: ["#comis", "#general"] }));
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      await startPromise;

      expect(mockJoin).toHaveBeenCalledWith("#comis");
      expect(mockJoin).toHaveBeenCalledWith("#general");
      expect(mockJoin).toHaveBeenCalledTimes(2);
    });

    it("rejects with error on 'error' event before registration", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const startPromise = adapter.start();

      emitEvent("error", { message: "Connection refused" });
      const result = await startPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("IRC error: Connection refused");
      }
    });

    it("rejects with timeout after 30s", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const startPromise = adapter.start();

      // Advance time by 30 seconds
      vi.advanceTimersByTime(30_000);
      const result = await startPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("timed out");
      }
    });

    it("logs 'Adapter started' on successful registration", async () => {
      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      await startPromise;

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "irc" }),
        "Adapter started",
      );
    });

    it("only settles once even if multiple events fire", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const startPromise = adapter.start();

      emitEvent("registered", { nick: "comis" });
      // Second error event after registration should be ignored for settlement
      emitEvent("error", { message: "late error" });
      const result = await startPromise;

      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe("stop()", () => {
    it("calls bot.quit() with shutdown message and returns ok", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.stop();

      expect(result.ok).toBe(true);
      expect(mockQuit).toHaveBeenCalledWith("Comis shutting down");
    });

    it("returns err when bot.quit() throws", async () => {
      mockQuit.mockImplementation(() => {
        throw new Error("Socket already closed");
      });

      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.stop();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to stop IRC adapter");
        expect(result.error.message).toContain("Socket already closed");
      }
    });

    it("logs 'Adapter stopped' on success", async () => {
      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      await adapter.stop();

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ channelType: "irc" }),
        "Adapter stopped",
      );
    });
  });

  // -------------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------------

  describe("sendMessage", () => {
    it("sends a short message with bot.say() and returns ok('sent')", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.sendMessage("#comis", "Hello world");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe("sent");
      }
      expect(mockSay).toHaveBeenCalledWith("#comis", "Hello world");
      expect(mockSay).toHaveBeenCalledTimes(1);
    });

    it("splits long messages (>450 chars) into multiple chunks", async () => {
      // Create a message that exceeds 450 chars with word boundaries
      const words = Array.from({ length: 100 }, (_, i) => `word${i}`);
      const longMessage = words.join(" "); // ~700 chars

      const adapter = createIrcAdapter(makeDeps());
      const resultPromise = adapter.sendMessage("#comis", longMessage);

      // Advance timers for the flood delay between chunks
      await vi.advanceTimersByTimeAsync(2000);
      const result = await resultPromise;

      expect(result.ok).toBe(true);
      // Should have been called more than once
      expect(mockSay.mock.calls.length).toBeGreaterThan(1);

      // Each chunk should be at most 450 chars
      for (const call of mockSay.mock.calls) {
        expect(call[1].length).toBeLessThanOrEqual(450);
      }
    });

    it("returns err when bot.say() throws", async () => {
      mockSay.mockImplementation(() => {
        throw new Error("Not connected");
      });

      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.sendMessage("#comis", "Hello");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Failed to send IRC message");
        expect(result.error.message).toContain("Not connected");
      }
    });

    it("logs outbound message on success", async () => {
      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      await adapter.sendMessage("#comis", "Hello");

      expect(deps.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "irc",
          messageId: "sent",
          chatId: "#comis",
        }),
        "Outbound message",
      );
    });
  });

  // -------------------------------------------------------------------------
  // onMessage + privmsg dispatch
  // -------------------------------------------------------------------------

  describe("onMessage + privmsg dispatch", () => {
    it("dispatches NormalizedMessage to registered handler on privmsg event", async () => {
      const normalized = makeNormalized();
      vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

      const adapter = createIrcAdapter(makeDeps());
      const handler = vi.fn();
      adapter.onMessage(handler);

      // Start adapter to register privmsg listener
      const startPromise = adapter.start();
      emitEvent("registered", { nick: "comis" });
      await startPromise;

      // Simulate privmsg event
      emitEvent("privmsg", {
        target: "#comis",
        nick: "user1",
        message: "Hello from IRC",
      });

      // Allow Promise.resolve(handler(...)) to flush
      await vi.advanceTimersByTimeAsync(0);

      expect(mapIrcToNormalized).toHaveBeenCalledWith({
        target: "#comis",
        nick: "user1",
        message: "Hello from IRC",
        tags: undefined,
      });
      expect(handler).toHaveBeenCalledWith(normalized);
    });

    it("calls mapIrcToNormalized with correct event data including tags", async () => {
      const normalized = makeNormalized();
      vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

      const adapter = createIrcAdapter(makeDeps());
      adapter.onMessage(vi.fn());

      const startPromise = adapter.start();
      emitEvent("registered", { nick: "comis" });
      await startPromise;

      emitEvent("privmsg", {
        target: "#dev",
        nick: "alice",
        message: "tagged msg",
        tags: { msgid: "abc123", time: "2026-01-01T00:00:00Z" },
      });

      expect(mapIrcToNormalized).toHaveBeenCalledWith({
        target: "#dev",
        nick: "alice",
        message: "tagged msg",
        tags: { msgid: "abc123", time: "2026-01-01T00:00:00Z" },
      });
    });

    it("calls multiple registered handlers", async () => {
      const normalized = makeNormalized();
      vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

      const adapter = createIrcAdapter(makeDeps());
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      adapter.onMessage(handler1);
      adapter.onMessage(handler2);

      const startPromise = adapter.start();
      emitEvent("registered", { nick: "comis" });
      await startPromise;

      emitEvent("privmsg", {
        target: "#comis",
        nick: "user1",
        message: "Hello",
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(handler1).toHaveBeenCalledWith(normalized);
      expect(handler2).toHaveBeenCalledWith(normalized);
    });

    it("catches and logs handler errors without crashing", async () => {
      const normalized = makeNormalized();
      vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      adapter.onMessage(() => {
        throw new Error("Handler blew up");
      });

      const startPromise = adapter.start();
      emitEvent("registered", { nick: "comis" });
      await startPromise;

      // Should not throw
      emitEvent("privmsg", {
        target: "#comis",
        nick: "user1",
        message: "Hello",
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          nick: "user1",
          hint: "Check IRC message handler logic",
          errorKind: "internal",
        }),
        "IRC message handler error",
      );
    });

    it("catches and logs async handler rejection without crashing", async () => {
      const normalized = makeNormalized();
      vi.mocked(mapIrcToNormalized).mockReturnValue(normalized);

      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      adapter.onMessage(async () => {
        throw new Error("Async handler failed");
      });

      const startPromise = adapter.start();
      emitEvent("registered", { nick: "comis" });
      await startPromise;

      emitEvent("privmsg", {
        target: "#comis",
        nick: "bob",
        message: "test",
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(deps.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          nick: "bob",
          hint: "Check IRC message handler logic",
          errorKind: "internal",
        }),
        "IRC message handler error",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Unsupported operations
  // -------------------------------------------------------------------------

  describe("unsupported operations", () => {
    it("editMessage returns err with 'does not support' message", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.editMessage("#comis", "msg1", "Updated");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not support");
      }
    });

    it("reactToMessage returns err", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.reactToMessage("#comis", "msg1", "thumbsup");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not support");
      }
    });

    it("deleteMessage returns err", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.deleteMessage("#comis", "msg1");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not support");
      }
    });

    it("fetchMessages returns err", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.fetchMessages("#comis");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not support");
      }
    });

    it("sendAttachment returns err and logs warning", async () => {
      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      const result = await adapter.sendAttachment("#comis", {
        type: "image",
        url: "https://example.com/image.png",
      } as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("does not support attachments");
      }
      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          channelType: "irc",
          chatId: "#comis",
          hint: "IRC is a text-only protocol and does not support attachments",
          errorKind: "validation",
        }),
        "Send attachment failed",
      );
    });
  });

  // -------------------------------------------------------------------------
  // platformAction
  // -------------------------------------------------------------------------

  describe("platformAction", () => {
    it("'join' calls bot.join(channel) and returns ok", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.platformAction("join", { channel: "#newchannel" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ joined: true, channel: "#newchannel" });
      }
      expect(mockJoin).toHaveBeenCalledWith("#newchannel");
    });

    it("'part' calls bot.part(channel) and returns ok", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.platformAction("part", { channel: "#oldchannel" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ parted: true, channel: "#oldchannel" });
      }
      expect(mockPart).toHaveBeenCalledWith("#oldchannel");
    });

    it("'topic' calls bot.setTopic(channel, topic) and returns ok", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.platformAction("topic", {
        channel: "#comis",
        topic: "New topic here",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ topicSet: true, channel: "#comis" });
      }
      expect(mockSetTopic).toHaveBeenCalledWith("#comis", "New topic here");
    });

    it("'sendTyping' returns ok(undefined) as a no-op", async () => {
      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.platformAction("sendTyping", {});

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeUndefined();
      }
    });

    it("unknown action returns err with unsupported message", async () => {
      const deps = makeDeps();
      const adapter = createIrcAdapter(deps);
      const result = await adapter.platformAction("unknownAction", {});

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("Unsupported action: unknownAction on irc");
      }
    });

    it("action that throws returns err wrapping the error", async () => {
      mockJoin.mockImplementation(() => {
        throw new Error("Channel banned");
      });

      const adapter = createIrcAdapter(makeDeps());
      const result = await adapter.platformAction("join", { channel: "#banned" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe("IRC action 'join' failed: Channel banned");
      }
    });
  });
});
