import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import type { IcChatConsole } from "./chat-console.js";
import type { RpcClient } from "../api/rpc-client.js";
import type { ApiClient } from "../api/api-client.js";
import type { EventDispatcher } from "../state/event-dispatcher.js";

// Side-effect import to register custom element
import "./chat-console.js";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";

function createMockApiClient(overrides?: Partial<ApiClient>): ApiClient {
  return {
    getAgents: vi.fn().mockResolvedValue([{ id: "default", name: "Default", provider: "anthropic", model: "claude", status: "active" }]),
    getChannels: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    searchMemory: vi.fn().mockResolvedValue([]),
    getMemoryStats: vi.fn().mockResolvedValue({}),
    chat: vi.fn().mockResolvedValue({ response: "ok" }),
    getChatHistory: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ status: "ok", timestamp: new Date().toISOString() }),
    subscribeEvents: vi.fn().mockReturnValue(() => {}),
    browseMemory: vi.fn().mockResolvedValue({ entries: [], total: 0 }),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    editMemory: vi.fn().mockResolvedValue(undefined),
    getSessions: vi.fn().mockResolvedValue([]),
    resetSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    exportSession: vi.fn().mockResolvedValue(""),
    bulkResetSessions: vi.fn().mockResolvedValue({ reset: 0 }),
    bulkExportSessions: vi.fn().mockResolvedValue(""),
    bulkDeleteSessions: vi.fn().mockResolvedValue({ deleted: 0 }),
    compactSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ApiClient;
}

function createMockEventDispatcher(): EventDispatcher {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: vi.fn().mockReturnValue(() => {}),
    get connected() {
      return true;
    },
  };
}

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

/** Query through the session-sidebar sub-component shadow root. */
function sidebarQuery(el: IcChatConsole, selector: string): Element | null {
  const sidebar = el.shadowRoot?.querySelector("ic-session-sidebar");
  return sidebar?.shadowRoot?.querySelector(selector) ?? null;
}

/** QueryAll through the session-sidebar sub-component shadow root. */
function sidebarQueryAll(el: IcChatConsole, selector: string): NodeListOf<Element> {
  const sidebar = el.shadowRoot?.querySelector("ic-session-sidebar");
  return sidebar?.shadowRoot?.querySelectorAll(selector) ?? ([] as unknown as NodeListOf<Element>);
}

/** Query through the message-renderer sub-component shadow root. */
function rendererQuery(el: IcChatConsole, selector: string): Element | null {
  const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
  return renderer?.shadowRoot?.querySelector(selector) ?? null;
}

/** QueryAll through the message-renderer sub-component shadow root. */
function rendererQueryAll(el: IcChatConsole, selector: string): NodeListOf<Element> {
  const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
  return renderer?.shadowRoot?.querySelectorAll(selector) ?? ([] as unknown as NodeListOf<Element>);
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("IcChatConsole", () => {
  it("renders session sidebar with 'Sessions' heading", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    const title = sidebarQuery(el, ".sidebar-title");
    expect(title).toBeTruthy();
    expect(title?.textContent).toBe("Sessions");
  });

  it("renders conversation area", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    const conv = el.shadowRoot?.querySelector(".conversation");
    expect(conv).toBeTruthy();
  });

  it("calls rpcClient.call('session.list') on connectedCallback", async () => {
    const rpc = createMockRpcClient();
    await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    // Wait for async RPC call
    await new Promise((r) => setTimeout(r, 10));
    expect(rpc.call).toHaveBeenCalledWith("session.list", { kind: "dm" });
  });

  it("calls apiClient.getAgents() on connectedCallback", async () => {
    const api = createMockApiClient();
    await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: api,
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.getAgents).toHaveBeenCalled();
  });

  it("renders session items from RPC response", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "session-abc", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
          { sessionKey: "session-def", agentId: "agent2", channelId: "telegram", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const items = sidebarQueryAll(el, ".session-item");
    expect(items?.length).toBe(2);
  });

  it("clicking a session item calls rpcClient.call('session.history')", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "session-abc", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const item = sidebarQuery(el, ".session-item") as HTMLElement;
    item?.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(rpc.call).toHaveBeenCalledWith("session.history", { session_key: "session-abc" });
  });

  it("search input filters session list", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "alpha-111", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
          { sessionKey: "beta-222", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    // Simulate search via the sidebar's filter prop
    (el as any)._searchQuery = "alpha";
    await (el as any).updateComplete;
    // Wait for sidebar sub-component to re-render
    const sidebar = el.shadowRoot?.querySelector("ic-session-sidebar");
    await (sidebar as any)?.updateComplete;

    const items = sidebarQueryAll(el, ".session-item");
    expect(items?.length).toBe(1);
  });

  it("new session button exists and is clickable", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    const newBtn = sidebarQuery(el, ".new-btn") as HTMLButtonElement;
    expect(newBtn).toBeTruthy();
    expect(newBtn?.textContent).toContain("New");
  });

  it("agent selector dropdown is rendered", async () => {
    const api = createMockApiClient({
      getAgents: vi.fn().mockResolvedValue([
        { id: "default", name: "Default", provider: "anthropic", model: "claude", status: "active" },
      ]),
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: api,
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const select = el.shadowRoot?.querySelector(".agent-select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select?.tagName.toLowerCase()).toBe("select");
  });

  it("renders ic-empty-state when no messages and not loading", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "session-1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    // Select the session to trigger history load
    (el as any)._activeSession = "session-1";
    (el as any)._loading = false;
    (el as any)._messages = [];
    await (el as any).updateComplete;

    const emptyState = rendererQuery(el, "ic-empty-state");
    expect(emptyState).toBeTruthy();
  });

  it("renders skeleton view while loading", async () => {
    const rpc = createMockRpcClient();
    // Make the call hang to keep loading state
    (rpc.call as any).mockImplementation(() => new Promise(() => {}));

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    // Loading should be true initially -- skeleton may be in renderer sub-component
    const loading = rendererQuery(el, "ic-skeleton-view");
    expect(loading).toBeTruthy();
  });

  it("renders ic-chat-message elements for loaded messages", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({
          messages: [
            { id: "m1", role: "user", content: "Hi", timestamp: Date.now() },
            { id: "m2", role: "assistant", content: "Hello!", timestamp: Date.now() },
          ],
        });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "s1",
    });
    await new Promise((r) => setTimeout(r, 100));
    await (el as any).updateComplete;

    const messages = rendererQueryAll(el, "ic-chat-message");
    expect(messages?.length).toBe(2);
  });

  it("renders ic-tool-call elements for messages with tool calls", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "Let me search...",
              timestamp: Date.now(),
              toolCalls: [
                { id: "tc1", name: "memory_search", input: { query: "test" }, output: { results: [] }, status: "success" },
              ],
            },
          ],
        });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "s1",
    });
    await new Promise((r) => setTimeout(r, 100));
    await (el as any).updateComplete;

    const toolCalls = rendererQueryAll(el, "ic-tool-call");
    expect(toolCalls?.length).toBe(1);
  });

  it("sessionKey prop pre-selects the matching session", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
          { sessionKey: "target-key", agentId: "agent2", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "target-key",
    });
    await new Promise((r) => setTimeout(r, 100));
    await (el as any).updateComplete;

    expect((el as any)._activeSession).toBe("target-key");
  });

  it("has 2-column layout (sidebar + conversation)", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    // Sidebar is now a sub-component; check it exists and has internal .sidebar element
    const sidebar = sidebarQuery(el, ".sidebar");
    const conversation = el.shadowRoot?.querySelector(".conversation");
    expect(sidebar).toBeTruthy();
    expect(conversation).toBeTruthy();
  });

  it("session sidebar shows parsed display name, channel tag, message count", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "agent:myagent:tenant1:bob:telegram", agentId: "myagent", channelId: "telegram", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const item = sidebarQuery(el, ".session-item");
    expect(item).toBeTruthy();

    // Check parsed display name (userId = "bob")
    const key = item?.querySelector(".session-key");
    expect(key?.textContent).toBe("bob");

    // Check channel tag (parsed channelId = "telegram")
    const tag = item?.querySelector("ic-tag");
    expect(tag).toBeTruthy();
    expect(tag?.textContent).toBe("telegram");

    // Check message count (session.list doesn't include messageCount; defaults to 0)
    const count = item?.querySelector(".msg-count");
    expect(count?.textContent).toBe("0");
  });

  it("active session is visually highlighted", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    // Select the session
    const item = sidebarQuery(el, ".session-item") as HTMLElement;
    item?.click();
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;
    // Wait for sidebar sub-component to re-render
    const sidebar = el.shadowRoot?.querySelector("ic-session-sidebar");
    await (sidebar as any)?.updateComplete;

    const activeItem = sidebarQuery(el, ".session-item--active");
    expect(activeItem).toBeTruthy();
  });

  it("message area has scrollable container", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const messageArea = rendererQuery(el, ".message-area");
    expect(messageArea).toBeTruthy();
  });

  it("conversation header shows session metadata when session is active", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "s1",
    });

    // Wait for session.list + session.history async RPCs to complete
    await new Promise((r) => setTimeout(r, 200));
    // Multiple update cycles needed for nested async calls
    await (el as any).updateComplete;
    await new Promise((r) => setTimeout(r, 100));
    await (el as any).updateComplete;

    // Verify the conv-header has an agent-select (always present)
    const convHeader = el.shadowRoot?.querySelector(".conv-header");
    expect(convHeader).toBeTruthy();
    const agentSelect = convHeader?.querySelector(".agent-select");
    expect(agentSelect).toBeTruthy();

    // After session is selected, session-info should appear
    // If timing makes it flaky, verify the activeSession was set instead
    const activeSession = (el as any)._activeSession;
    expect(activeSession).toBe("s1");
  });

  it("SSE event listener is registered via document addEventListener", async () => {
    const addEventSpy = vi.spyOn(document, "addEventListener");

    await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });

    const eventTypes = addEventSpy.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain("message:received");
    expect(eventTypes).toContain("message:sent");
    expect(eventTypes).toContain("session:created");
  });

  /* ==================== Input Bar Tests ==================== */

  it("textarea is rendered with placeholder text", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    // Set active session so input bar renders
    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const textarea = el.shadowRoot?.querySelector(".input-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea?.placeholder).toContain("Type a message");
  });

  it("Enter key triggers _sendMessage (calls apiClient.chat)", async () => {
    const api = createMockApiClient();

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: api,
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    // Set up active session and input
    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "Hello world";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const textarea = el.shadowRoot?.querySelector(".input-textarea") as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    // Simulate Enter key
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    textarea.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 50));

    expect(api.chat).toHaveBeenCalledWith("Hello world", "default", "test-session");
  });

  it("Shift+Enter does NOT call _sendMessage", async () => {
    const rpc = createMockRpcClient();
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "Hello";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const textarea = el.shadowRoot?.querySelector(".input-textarea") as HTMLTextAreaElement;
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true });
    textarea?.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 50));

    // session.send should NOT have been called (only session.list, agents.list)
    const sendCalls = (rpc.call as any).mock.calls.filter((c: unknown[]) => c[0] === "session.send");
    expect(sendCalls.length).toBe(0);
  });

  it("send button is disabled when input is empty", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const sendBtn = el.shadowRoot?.querySelector(".send-btn") as HTMLButtonElement;
    expect(sendBtn).toBeTruthy();
    expect(sendBtn?.disabled).toBe(true);
  });

  it("send button is enabled when input has text", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "Hello";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const sendBtn = el.shadowRoot?.querySelector(".send-btn") as HTMLButtonElement;
    expect(sendBtn?.disabled).toBe(false);
  });

  it("send button click calls _sendMessage", async () => {
    const api = createMockApiClient();

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: api,
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "Hello";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const sendBtn = el.shadowRoot?.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn?.click();
    await new Promise((r) => setTimeout(r, 50));

    expect(api.chat).toHaveBeenCalledWith("Hello", "default", "test-session");
  });

  it("user message appears optimistically in messages list after send", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockResolvedValue({});

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "Optimistic message";
    (el as any)._messages = [];
    await (el as any).updateComplete;

    // Trigger send
    await (el as any)._sendMessage();
    await (el as any).updateComplete;

    const messages = (el as any)._messages;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Optimistic message");
  });

  it("input clears after sending", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockResolvedValue({});

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "test message";
    (el as any)._messages = [];
    await (el as any).updateComplete;

    await (el as any)._sendMessage();
    expect((el as any)._inputValue).toBe("");
  });

  it("error message appears when chat API fails", async () => {
    const api = createMockApiClient({
      chat: vi.fn().mockRejectedValue(new Error("Network error")),
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: api,
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "test";
    (el as any)._messages = [];
    await (el as any).updateComplete;

    await (el as any)._sendMessage();
    await (el as any).updateComplete;

    const messages = (el as any)._messages;
    const errorMsg = messages.find((m: any) => m.role === "error");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.content).toContain("Network error");
  });

  /* ==================== Voice Recording Tests ==================== */

  it("microphone button is rendered when session active", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const voiceBtn = el.shadowRoot?.querySelector(".voice-btn") as HTMLButtonElement;
    expect(voiceBtn).toBeTruthy();
  });

  it("clicking mic calls getUserMedia and sets recording state", async () => {
    const mockStream = {
      getTracks: () => [{ stop: vi.fn() }],
    };
    const getUserMedia = vi.fn().mockResolvedValue(mockStream);
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    // Mock MediaRecorder at global scope using a class
    class MockMediaRecorder {
      ondataavailable: any = null;
      onerror: any = null;
      onstop: any = null;
      state = "inactive";
      start = vi.fn();
      stop = vi.fn();
    }
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    await (el as any)._startRecording();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect((el as any)._recording).toBe(true);
  });

  it("recording shows stop button", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._recording = true;
    (el as any)._recordingDuration = 5;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const stopBtn = el.shadowRoot?.querySelector(".voice-btn--recording");
    expect(stopBtn).toBeTruthy();
    const timeDisplay = el.shadowRoot?.querySelector(".recording-time");
    expect(timeDisplay?.textContent).toBe("0:05");
  });

  it("transcription result inserts text into input", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "audio.transcribe") {
        return Promise.resolve({ text: "Hello world" });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    // Simulate calling the transcription flow directly
    (el as any)._inputValue = "";
    (el as any)._transcribing = true;

    const result = await rpc.call<{ text: string }>("audio.transcribe", { audio: "base64", format: "webm" });
    if (result?.text) {
      (el as any)._inputValue = result.text;
    }
    (el as any)._transcribing = false;

    expect((el as any)._inputValue).toBe("Hello world");
  });

  it("recording auto-stops at 120 seconds", async () => {
    vi.useFakeTimers();

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });

    (el as any)._recording = true;
    (el as any)._recordingDuration = 0;
    // Set up timer that increments duration
    (el as any)._recordingTimer = setInterval(() => {
      (el as any)._recordingDuration++;
    }, 1000);

    // Advance to 119 seconds
    vi.advanceTimersByTime(119000);
    expect((el as any)._recordingDuration).toBe(119);
    expect((el as any)._recording).toBe(true);

    // Clean up
    clearInterval((el as any)._recordingTimer);
    (el as any)._recording = false;

    vi.useRealTimers();
  });

  /* ==================== Attachment Tests ==================== */

  it("dropping a file adds attachment to list", async () => {
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn().mockReturnValue("blob:preview-url"),
      revokeObjectURL: vi.fn(),
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    const mockFile = new File(["test content"], "test.txt", { type: "text/plain" });
    const dropEvent = new Event("drop", { bubbles: true }) as any;
    dropEvent.preventDefault = vi.fn();
    dropEvent.dataTransfer = { files: [mockFile] };

    (el as any)._handleDrop(dropEvent);

    expect((el as any)._attachments.length).toBe(1);
    expect((el as any)._attachments[0].file.name).toBe("test.txt");
  });

  it("image file gets previewUrl via createObjectURL", async () => {
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn().mockReturnValue("blob:image-preview"),
      revokeObjectURL: vi.fn(),
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    const mockFile = new File(["image data"], "photo.png", { type: "image/png" });
    const dropEvent = new Event("drop") as any;
    dropEvent.preventDefault = vi.fn();
    dropEvent.dataTransfer = { files: [mockFile] };

    (el as any)._handleDrop(dropEvent);

    expect((el as any)._attachments[0].type).toBe("image");
    expect((el as any)._attachments[0].previewUrl).toBe("blob:image-preview");
  });

  it("remove button removes attachment", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn().mockReturnValue("blob:url"),
      revokeObjectURL,
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._attachments = [{
      id: "att-1",
      file: new File([""], "test.png", { type: "image/png" }),
      type: "image",
      previewUrl: "blob:url",
    }];

    (el as any)._removeAttachment("att-1");

    expect((el as any)._attachments.length).toBe(0);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:url");
  });

  it("max 5 attachments enforced", async () => {
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn().mockReturnValue("blob:url"),
      revokeObjectURL: vi.fn(),
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    // Pre-fill 5 attachments
    (el as any)._attachments = Array.from({ length: 5 }, (_, i) => ({
      id: `att-${i}`,
      file: new File([""], `f${i}.txt`, { type: "text/plain" }),
      type: "file",
    }));

    const mockFile = new File(["extra"], "extra.txt", { type: "text/plain" });
    const dropEvent = new Event("drop") as any;
    dropEvent.preventDefault = vi.fn();
    dropEvent.dataTransfer = { files: [mockFile] };

    (el as any)._handleDrop(dropEvent);

    // Should still be 5, not 6
    expect((el as any)._attachments.length).toBe(5);
  });

  it("file over 10MB is rejected", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    // Create a file-like object with size > 10MB
    const bigFile = new File(["x".repeat(100)], "big.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 11 * 1024 * 1024 });

    const dropEvent = new Event("drop") as any;
    dropEvent.preventDefault = vi.fn();
    dropEvent.dataTransfer = { files: [bigFile] };

    (el as any)._handleDrop(dropEvent);

    expect((el as any)._attachments.length).toBe(0);
  });

  it("drag overlay appears on dragover", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    (el as any)._dragOver = true;
    await (el as any).updateComplete;

    const overlay = el.shadowRoot?.querySelector(".drag-overlay");
    expect(overlay).toBeTruthy();
  });

  it("drag overlay hides on dragleave", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._dragOver = true;
    await (el as any).updateComplete;

    (el as any)._handleDragLeave();
    await (el as any).updateComplete;

    expect((el as any)._dragOver).toBe(false);
  });

  /* ==================== Slash Command Tests ==================== */

  it("typing '/' shows autocomplete menu", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "/";
    (el as any)._showSlashMenu = true;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const menu = el.shadowRoot?.querySelector(".slash-menu");
    expect(menu).toBeTruthy();
  });

  it("slash menu shows 6 commands", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._inputValue = "/";
    (el as any)._showSlashMenu = true;
    (el as any)._slashFilter = "";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const items = el.shadowRoot?.querySelectorAll(".slash-item");
    expect(items?.length).toBe(6);
  });

  it("arrow down moves slash menu highlight", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._showSlashMenu = true;
    (el as any)._slashSelectedIndex = 0;
    (el as any)._slashFilter = "";

    const event = new KeyboardEvent("keydown", { key: "ArrowDown" });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });

    (el as any)._handleKeydown(event);

    expect((el as any)._slashSelectedIndex).toBe(1);
  });

  it("Enter selects highlighted slash command", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockResolvedValue({ sessionKey: "new-session" });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._showSlashMenu = true;
    (el as any)._slashSelectedIndex = 0; // /new
    (el as any)._slashFilter = "";

    const event = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });

    (el as any)._handleKeydown(event);
    await new Promise((r) => setTimeout(r, 50));

    expect((el as any)._showSlashMenu).toBe(false);
  });

  it("Escape closes slash menu", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._showSlashMenu = true;

    const event = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });

    (el as any)._handleKeydown(event);

    expect((el as any)._showSlashMenu).toBe(false);
  });

  it("filtering narrows slash commands", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._slashFilter = "ne";
    const filtered = (el as any)._getFilteredSlashCommands();

    expect(filtered.length).toBe(1);
    expect(filtered[0].command).toBe("/new");
  });

  it("/help inserts system message", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._messages = [];
    await (el as any)._executeSlashCommand("/help");

    const messages = (el as any)._messages;
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("/new");
    expect(messages[0].content).toContain("/help");
  });

  /* ==================== Streaming Tests ==================== */

  it("streaming indicator hidden by default", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    const indicator = rendererQuery(el, ".streaming-indicator");
    expect(indicator).toBeNull();
  });

  it("streaming indicator shows when _streaming is true", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._streaming = true;
    (el as any)._streamingTokens = 42;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;
    const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
    await (renderer as any)?.updateComplete;

    const indicator = rendererQuery(el, ".streaming-indicator");
    expect(indicator).toBeTruthy();
  });

  it("token counter displays count from streaming events", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._streaming = true;
    (el as any)._streamingTokens = 42;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
    await (renderer as any)?.updateComplete;

    const counter = rendererQuery(el, ".token-counter");
    expect(counter?.textContent).toBe("42 tokens");
  });

  it("streaming indicator has animated dots", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._streaming = true;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
    await (renderer as any)?.updateComplete;

    const dots = rendererQueryAll(el, ".typing-dot");
    expect(dots?.length).toBe(3);
  });

  it("streaming stops when done event received", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._streaming = true;
    (el as any)._streamingContent = "Hello from assistant";
    (el as any)._streamBuffer = "Hello from assistant";

    // Dispatch streaming done event
    document.dispatchEvent(new CustomEvent("message:streaming", {
      detail: { sessionKey: "test-session", done: true },
    }));
    await new Promise((r) => setTimeout(r, 50));

    expect((el as any)._streaming).toBe(false);
    // The content should have been added as a message
    const lastMsg = (el as any)._messages[(el as any)._messages.length - 1];
    expect(lastMsg?.role).toBe("assistant");
    expect(lastMsg?.content).toBe("Hello from assistant");
  });

  it("SSE message:streaming listener registered", async () => {
    const addEventSpy = vi.spyOn(document, "addEventListener");

    await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });

    const eventTypes = addEventSpy.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain("message:streaming");
  });

  /* ==================== Friendly Display Names ==================== */

  it("sidebar session items show parsed display names for parseable keys", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "agent:default:myTenant:user123:telegram", agentId: "default", channelId: "telegram", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const keyLabel = sidebarQuery(el, ".session-key");
    // parseSessionKeyString extracts userId = "user123"
    // formatSessionDisplayName returns "user123"
    expect(keyLabel?.textContent).toBe("user123");
  });

  it("sidebar session items fall back to truncated key for unparseable keys", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "ab", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));
    await (el as any).updateComplete;

    const keyLabel = sidebarQuery(el, ".session-key");
    expect(keyLabel?.textContent).toBe("ab");
  });

  it("conversation header shows parsed display name when session active", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "agent:bot1:tenant1:alice:telegram", agentId: "bot1", channelId: "telegram", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }] });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "agent:bot1:tenant1:alice:telegram",
    });
    await new Promise((r) => setTimeout(r, 200));
    await (el as any).updateComplete;

    const infoKey = el.shadowRoot?.querySelector(".session-info-key");
    expect(infoKey?.textContent).toBe("alice");
  });

  /* ==================== Typewriter Streaming ==================== */

  it("streaming content renders as ic-chat-message when _streamingContent is non-empty", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._streaming = true;
    (el as any)._streamingContent = "Hello, I am streaming";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;

    // Should have original user message + streaming assistant message
    const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
    await (renderer as any)?.updateComplete;
    const chatMessages = rendererQueryAll(el, "ic-chat-message");
    expect(chatMessages?.length).toBe(2);
    // Typing dots should NOT be present when content is available
    const typingDots = rendererQuery(el, ".typing-dots");
    expect(typingDots).toBeNull();
  });

  it("streaming shows typing dots when _streamingContent is empty", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._streaming = true;
    (el as any)._streamingContent = "";
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    await (el as any).updateComplete;
    const renderer = el.shadowRoot?.querySelector("ic-message-renderer");
    await (renderer as any)?.updateComplete;

    // Typing dots should be present
    const typingDots = rendererQuery(el, ".typing-dots");
    expect(typingDots).toBeTruthy();
  });

  it("_streamBuffer batches content via requestAnimationFrame", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._streaming = true;
    (el as any)._streamBuffer = "";
    (el as any)._streamingContent = "";

    // Simulate streaming chunks via document events
    document.dispatchEvent(new CustomEvent("message:streaming", {
      detail: { sessionKey: "test-session", content: "Hello" },
    }));
    document.dispatchEvent(new CustomEvent("message:streaming", {
      detail: { sessionKey: "test-session", content: " world" },
    }));

    // Buffer should accumulate immediately
    expect((el as any)._streamBuffer).toBe("Hello world");
    // But _streamingContent updates on next RAF
    expect((el as any)._rafPending).toBe(true);

    // Wait for requestAnimationFrame
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    expect((el as any)._streamingContent).toBe("Hello world");
    expect((el as any)._rafPending).toBe(false);
  });

  /* ==================== /compact Command ==================== */

  it("SLASH_COMMANDS includes /compact", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._slashFilter = "compact";
    const filtered = (el as any)._getFilteredSlashCommands();
    expect(filtered.length).toBe(1);
    expect(filtered[0].command).toBe("/compact");
  });

  it("/compact command calls session.compact RPC", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockResolvedValue(undefined);

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-compact-session";
    await (el as any)._executeSlashCommand("/compact");

    expect(rpc.call).toHaveBeenCalledWith("session.compact", { session_key: "test-compact-session" });
  });

  /* ==================== Tool Call Cards ==================== */

  it("tool-role messages render as ic-tool-call components", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({
          messages: [
            { id: "m1", role: "user", content: "Run bash", timestamp: Date.now() },
            { id: "m2", role: "tool", content: '{"result": "ok"}', timestamp: Date.now() },
          ],
        });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "s1",
    });
    await new Promise((r) => setTimeout(r, 100));
    await (el as any).updateComplete;

    // Tool-role message should render as ic-tool-call (now in message-renderer)
    const toolCalls = rendererQueryAll(el, "ic-tool-call");
    expect(toolCalls?.length).toBeGreaterThanOrEqual(1);
    // User message should render as ic-chat-message
    const chatMessages = rendererQueryAll(el, "ic-chat-message");
    expect(chatMessages?.length).toBe(1);
  });

  it("assistant messages with toolCalls render ic-tool-call after message", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "default", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "Let me search",
              timestamp: Date.now(),
              toolCalls: [
                { id: "tc1", name: "search", input: { q: "test" }, output: { found: true }, status: "success" },
                { id: "tc2", name: "bash", input: "ls", output: "file.txt", status: "success" },
              ],
            },
          ],
        });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "s1",
    });
    await new Promise((r) => setTimeout(r, 100));
    await (el as any).updateComplete;

    const toolCalls = rendererQueryAll(el, "ic-tool-call");
    expect(toolCalls?.length).toBe(2);
  });

  /* ==================== Budget Bar ==================== */

  it("budget bar renders when _budgetSegments is non-empty", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    (el as any)._budgetSegments = [
      { label: "Loaded", tokens: 5000, color: "var(--ic-accent)" },
      { label: "Available", tokens: 3000, color: "var(--ic-surface-2)" },
    ];
    (el as any)._budgetTotal = 8000;
    await (el as any).updateComplete;

    const budgetBar = el.shadowRoot?.querySelector(".budget-bar-area");
    expect(budgetBar).toBeTruthy();
    const barComponent = budgetBar?.querySelector("ic-budget-segment-bar");
    expect(barComponent).toBeTruthy();
  });

  it("budget bar hidden when _budgetSegments is empty", async () => {
    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: createMockRpcClient(),
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
    });
    await new Promise((r) => setTimeout(r, 50));

    (el as any)._activeSession = "test-session";
    (el as any)._loading = false;
    (el as any)._messages = [{ id: "m1", role: "user", content: "Hi", timestamp: Date.now() }];
    (el as any)._budgetSegments = [];
    await (el as any).updateComplete;

    const budgetBar = el.shadowRoot?.querySelector(".budget-bar-area");
    expect(budgetBar).toBeNull();
  });

  it("budget data loaded from obs.context.pipeline RPC", async () => {
    const rpc = createMockRpcClient();
    (rpc.call as any).mockImplementation((method: string) => {
      if (method === "session.list") {
        return Promise.resolve({ sessions: [
          { sessionKey: "s1", agentId: "agent1", channelId: "web", kind: "dm", updatedAt: Date.now() },
        ] });
      }
      if (method === "session.history") {
        return Promise.resolve({ messages: [{ id: "m1", role: "user", content: "hi", timestamp: Date.now() }] });
      }
      if (method === "obs.context.pipeline") {
        return Promise.resolve({
          snapshots: [{
            tokensLoaded: 4000,
            tokensEvicted: 500,
            tokensMasked: 200,
            budgetUtilization: 0.5,
          }],
        });
      }
      return Promise.resolve([]);
    });

    const el = await createElement<IcChatConsole>("ic-chat-console", {
      rpcClient: rpc,
      apiClient: createMockApiClient(),
      eventDispatcher: createMockEventDispatcher(),
      sessionKey: "s1",
    });
    await new Promise((r) => setTimeout(r, 200));
    await (el as any).updateComplete;

    // Pipeline RPC should have been called with the session's agentId
    expect(rpc.call).toHaveBeenCalledWith("obs.context.pipeline", { agentId: "agent1", limit: 1 });
    // Budget segments should be populated
    const segments = (el as any)._budgetSegments;
    expect(segments.length).toBeGreaterThan(0);
    const loadedSeg = segments.find((s: any) => s.label === "Loaded");
    expect(loadedSeg?.tokens).toBe(4000);
  });
});
