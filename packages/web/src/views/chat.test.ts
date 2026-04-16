import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ApiClient } from "../api/api-client.js";
import "./chat.js";
import type { IcChat } from "./chat.js";

// Stub crypto.randomUUID before tests
let uuidCounter = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

// Stub sessionStorage
const mockStorage: Record<string, string> = {};
vi.stubGlobal("sessionStorage", {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
});

function createMockApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({}),
    chat: vi.fn().mockResolvedValue({ response: "test response" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ status: "ok", timestamp: new Date().toISOString() }),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteMemoryBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    exportMemory: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionDetail: vi.fn().mockResolvedValue({ session: {}, messages: [] }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    compactSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(""),
    resetSessionsBulk: vi.fn().mockResolvedValue({ reset: 0 }),
    exportSessionsBulk: vi.fn().mockResolvedValue(""),
    deleteSessionsBulk: vi.fn().mockResolvedValue({ deleted: 0 }),
    ...overrides,
  };
}

/** Type-safe access to private properties on the chat element. */
function priv(el: IcChat) {
  return el as unknown as {
    _messages: Array<{
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: number;
      error?: boolean;
    }>;
    _sending: boolean;
    _inputValue: string;
    _loadingHistory: boolean;
    _sessionId: string;
    apiClient: ApiClient | null;
    _sendMessage(): Promise<void>;
    _handleKeyDown(e: KeyboardEvent): void;
    _formatTime(timestamp: number): string;
    _loadHistory(): Promise<void>;
    _createMessage(role: "user" | "assistant", content: string, error?: boolean): {
      id: string;
      role: "user" | "assistant";
      content: string;
      timestamp: number;
      error?: boolean;
    };
    _resetInput(): void;
  };
}

describe("IcChat", () => {
  let el: IcChat;

  beforeEach(() => {
    uuidCounter = 0;
    // Clear mock storage
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key];
    }
    el = document.createElement("ic-chat") as IcChat;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("initial state", () => {
    it("starts with empty messages array", () => {
      expect(priv(el)._messages).toEqual([]);
    });

    it("starts with _sending=false", () => {
      expect(priv(el)._sending).toBe(false);
    });

    it("starts with empty input value", () => {
      expect(priv(el)._inputValue).toBe("");
    });

    it("has a session ID generated from crypto.randomUUID", () => {
      expect(priv(el)._sessionId).toMatch(/^test-uuid-/);
    });
  });

  describe("_loadHistory", () => {
    it("does nothing when apiClient is null", async () => {
      priv(el).apiClient = null;
      await priv(el)._loadHistory();
      expect(priv(el)._messages).toEqual([]);
    });

    it("loads chat history via apiClient.getChatHistory", async () => {
      const history = [
        { role: "user" as const, content: "hello", timestamp: 1000 },
        { role: "assistant" as const, content: "hi there", timestamp: 2000 },
      ];
      const mockClient = createMockApiClient({
        getChatHistory: vi.fn().mockResolvedValue(history),
      });
      priv(el).apiClient = mockClient;

      await priv(el)._loadHistory();

      expect(mockClient.getChatHistory).toHaveBeenCalledTimes(1);
      expect(priv(el)._messages).toHaveLength(2);
    });

    it("converts history messages to ChatMessage format with generated IDs", async () => {
      const history = [
        { role: "user" as const, content: "hello", timestamp: 1000 },
      ];
      const mockClient = createMockApiClient({
        getChatHistory: vi.fn().mockResolvedValue(history),
      });
      priv(el).apiClient = mockClient;

      await priv(el)._loadHistory();

      const msg = priv(el)._messages[0];
      expect(msg.id).toMatch(/^test-uuid-/);
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("hello");
      expect(msg.timestamp).toBe(1000);
    });

    it("sets _loadingHistory during API call", async () => {
      let resolveHistory: (value: unknown[]) => void;
      const historyPromise = new Promise<unknown[]>((resolve) => {
        resolveHistory = resolve;
      });
      const mockClient = createMockApiClient({
        getChatHistory: vi.fn().mockReturnValue(historyPromise),
      });
      priv(el).apiClient = mockClient;

      const loadPromise = priv(el)._loadHistory();
      expect(priv(el)._loadingHistory).toBe(true);

      resolveHistory!([]);
      await loadPromise;
      expect(priv(el)._loadingHistory).toBe(false);
    });

    it("silently handles history load failure", async () => {
      const mockClient = createMockApiClient({
        getChatHistory: vi.fn().mockRejectedValue(new Error("network error")),
      });
      priv(el).apiClient = mockClient;

      await priv(el)._loadHistory();

      expect(priv(el)._messages).toEqual([]);
      expect(priv(el)._loadingHistory).toBe(false);
    });
  });

  describe("_sendMessage", () => {
    it("does nothing when input is empty", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "";

      await priv(el)._sendMessage();

      expect(mockClient.chat).not.toHaveBeenCalled();
      expect(priv(el)._messages).toEqual([]);
    });

    it("does nothing when input is whitespace only", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "   ";

      await priv(el)._sendMessage();

      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it("does nothing when _sending is true", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "hello";
      priv(el)._sending = true;

      await priv(el)._sendMessage();

      expect(mockClient.chat).not.toHaveBeenCalled();
    });

    it("adds user message to _messages array", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello agent";

      await priv(el)._sendMessage();

      const userMsg = priv(el)._messages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      expect(userMsg!.content).toBe("Hello agent");
    });

    it("calls apiClient.chat with the message text", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello agent";

      await priv(el)._sendMessage();

      expect(mockClient.chat).toHaveBeenCalledWith("Hello agent");
    });

    it("adds assistant response to _messages after API call", async () => {
      const mockClient = createMockApiClient({
        chat: vi.fn().mockResolvedValue({ response: "I am the agent" }),
      });
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      await priv(el)._sendMessage();

      const assistantMsg = priv(el)._messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.content).toBe("I am the agent");
      expect(assistantMsg!.error).toBeUndefined();
    });

    it("adds error message on API failure with error=true", async () => {
      const mockClient = createMockApiClient({
        chat: vi.fn().mockRejectedValue(new Error("API down")),
      });
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      await priv(el)._sendMessage();

      const errorMsg = priv(el)._messages.find((m) => m.error === true);
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.role).toBe("assistant");
      // Non-server errors (not starting with "Request failed") are passed through
      expect(errorMsg!.content).toBe("API down");
    });

    it("shows generic message for server errors starting with 'Request failed'", async () => {
      const mockClient = createMockApiClient({
        chat: vi.fn().mockRejectedValue(new Error("Request failed (500): Internal server error")),
      });
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      await priv(el)._sendMessage();

      const errorMsg = priv(el)._messages.find((m) => m.error === true);
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.content).toBe("Unable to reach the agent. Please try again.");
      expect(errorMsg!.content).not.toContain("500");
      expect(errorMsg!.content).not.toContain("Internal server error");
    });

    it("adds generic error message when error is not an Error instance", async () => {
      const mockClient = createMockApiClient({
        chat: vi.fn().mockRejectedValue("string error"),
      });
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      await priv(el)._sendMessage();

      const errorMsg = priv(el)._messages.find((m) => m.error === true);
      expect(errorMsg).toBeDefined();
      expect(errorMsg!.content).toBe("Failed to get response from agent");
    });

    it("sets _sending=true during API call and false after", async () => {
      let resolveChat: (value: { response: string }) => void;
      const chatPromise = new Promise<{ response: string }>((resolve) => {
        resolveChat = resolve;
      });
      const mockClient = createMockApiClient({
        chat: vi.fn().mockReturnValue(chatPromise),
      });
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      const sendPromise = priv(el)._sendMessage();

      // After user message added but before chat resolves
      expect(priv(el)._sending).toBe(true);

      resolveChat!({ response: "hi" });
      await sendPromise;

      expect(priv(el)._sending).toBe(false);
    });

    it("clears _inputValue after sending", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      await priv(el)._sendMessage();

      expect(priv(el)._inputValue).toBe("");
    });

    it("updates session ID when response includes sessionId", async () => {
      const mockClient = createMockApiClient({
        chat: vi.fn().mockResolvedValue({ response: "hi", sessionId: "server-session-42" }),
      });
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      await priv(el)._sendMessage();

      expect(priv(el)._sessionId).toBe("server-session-42");
    });
  });

  describe("_handleKeyDown", () => {
    it("calls _sendMessage on Enter (without Shift)", async () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: false,
      });
      const preventSpy = vi.spyOn(event, "preventDefault");

      priv(el)._handleKeyDown(event);

      expect(preventSpy).toHaveBeenCalled();
    });

    it("does NOT call _sendMessage on Shift+Enter", () => {
      const mockClient = createMockApiClient();
      priv(el).apiClient = mockClient;
      priv(el)._inputValue = "Hello";

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
      });
      const preventSpy = vi.spyOn(event, "preventDefault");

      priv(el)._handleKeyDown(event);

      expect(preventSpy).not.toHaveBeenCalled();
    });

    it("does nothing for non-Enter keys", () => {
      const event = new KeyboardEvent("keydown", {
        key: "a",
        shiftKey: false,
      });
      const preventSpy = vi.spyOn(event, "preventDefault");

      priv(el)._handleKeyDown(event);

      expect(preventSpy).not.toHaveBeenCalled();
    });
  });

  describe("_createMessage", () => {
    it("creates a user message with generated ID and timestamp", () => {
      const msg = priv(el)._createMessage("user", "hello");
      expect(msg.id).toMatch(/^test-uuid-/);
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("hello");
      expect(msg.timestamp).toBeGreaterThan(0);
      expect(msg.error).toBeUndefined();
    });

    it("creates an error message when error flag is true", () => {
      const msg = priv(el)._createMessage("assistant", "oops", true);
      expect(msg.role).toBe("assistant");
      expect(msg.content).toBe("oops");
      expect(msg.error).toBe(true);
    });

    it("omits error property when error flag is falsy", () => {
      const msg = priv(el)._createMessage("assistant", "ok");
      expect("error" in msg).toBe(false);
    });
  });

  describe("_formatTime", () => {
    it("returns a time string in HH:MM format", () => {
      // Jan 1, 2026 12:30:00 UTC
      const timestamp = Date.UTC(2026, 0, 1, 12, 30, 0);
      const result = priv(el)._formatTime(timestamp);

      // The format depends on locale, but should contain digits and colon
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe("input constraints", () => {
    it("chat textarea has maxlength=10000 in rendered HTML", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      const textarea = el.shadowRoot?.querySelector(".chat-input") as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea!.getAttribute("maxlength")).toBe("10000");

      document.body.removeChild(el);
    });
  });

  describe("session management", () => {
    it("persists session ID to sessionStorage on connectedCallback", () => {
      document.body.appendChild(el);
      try {
        expect(sessionStorage.setItem).toHaveBeenCalledWith(
          "comis_chat_session",
          expect.stringMatching(/^test-uuid-/),
        );
      } finally {
        document.body.removeChild(el);
      }
    });
  });

  describe("DOM rendering", () => {
    afterEach(() => {
      if (el.isConnected) {
        document.body.removeChild(el);
      }
    });

    it("renders textarea for input and send button", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      const textarea = el.shadowRoot?.querySelector(".chat-input") as HTMLTextAreaElement | null;
      expect(textarea).not.toBeNull();
      expect(textarea!.placeholder).toContain("Type a message");

      const sendBtn = el.shadowRoot?.querySelector(".send-btn") as HTMLButtonElement | null;
      expect(sendBtn).not.toBeNull();
      expect(sendBtn!.textContent?.trim()).toBe("Send");
    });

    it("renders empty state when no messages", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      const emptyState = el.shadowRoot?.querySelector(".empty-state");
      expect(emptyState).not.toBeNull();
      expect(emptyState!.textContent).toContain("No messages yet");
    });

    it("renders message list with user and assistant messages", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      // Set messages via priv() and re-render
      priv(el)._messages = [
        { id: "m1", role: "user", content: "Hello agent", timestamp: Date.now() },
        { id: "m2", role: "assistant", content: "Hi there!", timestamp: Date.now() },
      ];
      await el.updateComplete;

      const messages = el.shadowRoot?.querySelectorAll(".message");
      expect(messages).not.toBeNull();
      expect(messages!.length).toBe(2);

      const userMsg = el.shadowRoot?.querySelector(".message-user .message-bubble");
      expect(userMsg).not.toBeNull();
      expect(userMsg!.textContent).toContain("Hello agent");

      const assistantMsg = el.shadowRoot?.querySelector(".message-assistant .message-bubble");
      expect(assistantMsg).not.toBeNull();
      expect(assistantMsg!.textContent).toContain("Hi there!");
    });

    it("renders streaming cursor when sending", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      priv(el)._sending = true;
      await el.updateComplete;

      const cursor = el.shadowRoot?.querySelector(".streaming-cursor");
      expect(cursor).not.toBeNull();
    });

    it("renders session badge with short session ID", async () => {
      document.body.appendChild(el);
      await el.updateComplete;

      const badge = el.shadowRoot?.querySelector(".session-badge");
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toContain("session:");
    });
  });
});
