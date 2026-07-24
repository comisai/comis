// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../api/rpc-client.js";
import type { ConnectionStatus } from "../api/types/index.js";
import type { IcBreadcrumb } from "../components/nav/ic-breadcrumb.js";
import type { IcMessageCenter } from "./message-center.js";
import "./message-center.js";

async function createElement(
  props: Partial<IcMessageCenter> = {},
): Promise<IcMessageCenter> {
  const el = document.createElement("ic-message-center") as IcMessageCenter;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  await el.updateComplete;
  return el;
}

function state(el: IcMessageCenter) {
  return el as unknown as {
    _loadState: "idle" | "loading" | "loaded" | "error";
    _messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>;
    _messagesAreActionable: boolean;
    _effectiveChannel: string;
    _channelIsRunning: boolean;
    _channelList: Array<{ channelType: string; status: string }>;
    _capabilities: Record<string, unknown> | null;
    _botName: string;
    _chatList: Array<{ chatId: string; label: string }>;
    _selectedChatId: string;
    _autoSelectAttempted: boolean;
    _hasLoaded: boolean;
    _actionResult: string;
    _actionPending: boolean;
    _platformActionPending: boolean;
    _sendText: string;
    _deleteTargetId: string;
    _selectedMessageId: string;
    _refetchMessages(): Promise<void>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createStatusRpcClient(
  call: unknown,
  initialStatus: ConnectionStatus,
) {
  let status = initialStatus;
  const handlers = new Set<(nextStatus: ConnectionStatus) => void>();
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    call,
    onStatusChange(handler: (nextStatus: ConnectionStatus) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onNotification: vi.fn(() => () => {}),
    get status() {
      return status;
    },
  } as unknown as RpcClient;

  return {
    client,
    setStatus(nextStatus: ConnectionStatus) {
      status = nextStatus;
      for (const handler of handlers) handler(nextStatus);
    },
    listenerCount() {
      return handlers.size;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("IcMessageCenter", () => {
  it("forwards breadcrumb navigation to the app router", async () => {
    const el = await createElement({ channelType: "telegram" });
    const navigate = vi.fn();
    el.addEventListener("navigate", navigate);

    const breadcrumb = el.shadowRoot?.querySelector<IcBreadcrumb>("ic-breadcrumb");
    expect(breadcrumb).not.toBeNull();
    await breadcrumb!.updateComplete;

    const links = Array.from(
      breadcrumb!.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.link") ?? [],
    );
    expect(links.map((link) => link.textContent?.trim())).toEqual(["Channels", "telegram"]);

    for (const link of links) link.click();

    expect(navigate).toHaveBeenCalledTimes(2);
    expect(
      navigate.mock.calls.map(([event]) => (event as CustomEvent<string>).detail),
    ).toEqual(["channels", "channels/telegram"]);
  });

  it("omits an empty channel breadcrumb destination", async () => {
    const el = await createElement();
    const breadcrumb = el.shadowRoot?.querySelector<IcBreadcrumb>("ic-breadcrumb");
    expect(breadcrumb).not.toBeNull();
    await breadcrumb!.updateComplete;

    expect(breadcrumb!.items).toEqual([
      { label: "Channels", route: "channels" },
      { label: "Messages" },
    ]);
    expect(
      Array.from(
        breadcrumb!.shadowRoot?.querySelectorAll<HTMLButtonElement>("button.link") ?? [],
      ).map((link) => link.textContent?.trim()),
    ).toEqual(["Channels"]);
  });

  it("clears the breadcrumb when the route drops its channel", async () => {
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-old", senderId: "user_a", text: "old", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { fetchHistory: true },
      _botName: "old-bot",
      _chatList: [{ chatId: "chat-old", label: "Old chat" }],
      _selectedChatId: "chat-old",
      _autoSelectAttempted: true,
    });

    el.channelType = "";
    await el.updateComplete;
    await el.updateComplete;

    const breadcrumb = el.shadowRoot?.querySelector<IcBreadcrumb>("ic-breadcrumb");
    expect(breadcrumb).not.toBeNull();
    expect(breadcrumb!.items).toEqual([
      { label: "Channels", route: "channels" },
      { label: "Messages" },
    ]);
    const current = state(el);
    expect(current._loadState).toBe("idle");
    expect(current._messages).toEqual([]);
    expect(current._effectiveChannel).toBe("");
    expect(current._capabilities).toBeNull();
    expect(current._botName).toBe("");
    expect(current._chatList).toEqual([]);
    expect(current._selectedChatId).toBe("");
    expect(current._autoSelectAttempted).toBe(false);
  });

  it("ignores channel data resolved after the route drops its channel", async () => {
    const channelList = deferred<{ channels: []; total: number }>();
    const capabilities = deferred<{ channelType: string; features: { fetchHistory: boolean } }>();
    const channelConfig = deferred<{ botName: string }>();
    const call = vi.fn((method: string) => {
      switch (method) {
        case "channels.list": return channelList.promise;
        case "channels.capabilities": return capabilities.promise;
        case "channels.get": return channelConfig.promise;
        case "obs.channels.all": return Promise.resolve({ channels: [] });
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list": return Promise.resolve({ sessions: [], total: 0 });
        default: return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const rpcClient = createStatusRpcClient(call, "connected").client;
    const el = await createElement({ channelType: "telegram", rpcClient });

    el.channelType = "";
    await el.updateComplete;
    channelList.resolve({ channels: [], total: 0 });
    capabilities.resolve({ channelType: "telegram", features: { fetchHistory: false } });
    channelConfig.resolve({ botName: "old-bot" });
    await Promise.all([channelList.promise, capabilities.promise, channelConfig.promise]);
    for (let update = 0; update < 4; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    const current = state(el);
    expect(current._messages).toEqual([]);
    expect(current._effectiveChannel).toBe("");
    expect(current._capabilities).toBeNull();
    expect(current._botName).toBe("");
    expect(current._chatList).toEqual([]);
    expect(current._selectedChatId).toBe("");
  });

  it("keeps messages from the latest chat selection", async () => {
    const oldChatA = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    const chatB = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    const newChatA = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    let chatACalls = 0;
    const call = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method !== "message.fetch") {
        return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
      if (params?.["channel_id"] === "chat-a") {
        chatACalls += 1;
        return chatACalls === 1 ? oldChatA.promise : newChatA.promise;
      }
      return chatB.promise;
    });
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _capabilities: { fetchHistory: true },
      _chatList: [
        { chatId: "chat-a", label: "Chat A" },
        { chatId: "chat-b", label: "Chat B" },
      ],
      _selectedChatId: "chat-a",
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const current = state(el);
    const oldChatARequest = current._refetchMessages();
    current._selectedChatId = "chat-b";
    const chatBRequest = current._refetchMessages();
    current._selectedChatId = "chat-a";
    const newChatARequest = current._refetchMessages();

    newChatA.resolve({
      channelId: "chat-a",
      messages: [{ id: "new-a", senderId: "user_a", text: "new", timestamp: 3 }],
    });
    await newChatARequest;
    chatB.resolve({
      channelId: "chat-b",
      messages: [{ id: "old-b", senderId: "user_a", text: "old", timestamp: 2 }],
    });
    await chatBRequest;
    oldChatA.resolve({
      channelId: "chat-a",
      messages: [{ id: "old-a", senderId: "user_a", text: "old", timestamp: 1 }],
    });
    await oldChatARequest;

    expect(call.mock.calls.map(([, params]) => params?.["channel_id"]))
      .toEqual(["chat-a", "chat-b", "chat-a"]);
    expect(current._selectedChatId).toBe("chat-a");
    expect(current._messages.map((message) => message.id)).toEqual(["new-a"]);
  });

  it("invalidates an in-flight message request when newer fetches cannot start", async () => {
    const oldChatA = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    const call = vi.fn(() => oldChatA.promise);
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _capabilities: { fetchHistory: true },
      _selectedChatId: "chat-a",
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;
    const oldRequest = current._refetchMessages();

    el.rpcClient = null;
    await el.updateComplete;
    current._selectedChatId = "chat-b";
    await current._refetchMessages();
    current._selectedChatId = "chat-a";
    await current._refetchMessages();
    oldChatA.resolve({
      channelId: "chat-a",
      messages: [{ id: "old-a", senderId: "user_a", text: "old", timestamp: 1 }],
    });
    await oldRequest;

    expect(current._messages).toEqual([]);
  });

  it("keeps stored session history read-only without platform message identifiers", async () => {
    const call = vi.fn((method: string) => {
      switch (method) {
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list":
          return Promise.resolve({
            sessions: [{
              conversationRef: "conversation-a",
              agentId: "agent-a",
              kind: "dm",
              messageCount: 1,
              totalTokens: 2,
              updatedAt: 1,
              createdAt: 1,
            }],
            total: 1,
          });
        case "session.history":
          return Promise.resolve({
            session: {
              key: "tenant-a:agent:agent-a:user_a:telegram:chat-1",
              agentId: "agent-a",
              channelType: "dm",
              endpoint: {
                channelType: "telegram",
                channelInstanceId: "telegram-account",
                conversationId: "chat-1",
                conversationKind: "direct",
              },
              messageCount: 1,
              totalTokens: 2,
              inputTokens: 1,
              outputTokens: 1,
              toolCalls: 0,
              compactions: 0,
              resetCount: 0,
              createdAt: 1,
              lastActiveAt: 1,
            },
            messages: [{ role: "user", content: "stored message", timestamp: 1 }],
            total: 1,
          });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _capabilities: {
        fetchHistory: false,
        editMessages: true,
        deleteMessages: true,
        reactions: true,
      },
      _selectedChatId: "chat-1",
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;
    await current._refetchMessages();
    await el.updateComplete;

    expect(call).toHaveBeenCalledWith("session.list", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
    });
    expect(call).toHaveBeenCalledWith("session.history", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
      conversation_ref: "conversation-a",
      limit: 50,
    });

    const messageRow = el.shadowRoot?.querySelector<HTMLElement>(".msg-row");
    expect(messageRow).not.toBeNull();
    messageRow!.click();
    await el.updateComplete;

    expect(current._selectedMessageId).toBe("");
    expect(el.shadowRoot?.querySelectorAll(".msg-action-btn")).toHaveLength(0);
    const pinButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".platform-actions button") ?? [],
    ).find((button) => button.textContent?.trim() === "Pin Message");
    expect(pinButton).toBeDefined();
    expect(pinButton!.disabled).toBe(true);
  });

  it("discards an action result after the route changes channel", async () => {
    const action = deferred<string>();
    const call = vi.fn((method: string) => {
      if (method === "telegram.action") return action.promise;
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const actionButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-buttons button") ?? [],
    ).find((button) => button.title === "Chat Info");
    expect(actionButton).toBeDefined();
    actionButton!.click();
    expect(call).toHaveBeenCalledWith("telegram.action", {
      action: "chat_info",
      chat_id: "telegram",
    });

    el.channelType = "discord";
    await el.updateComplete;
    action.resolve("telegram-result");
    await action.promise;
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(state(el)._actionResult).toBe("");
  });

  it("does not let an old delete completion mutate the new channel", async () => {
    const deletion = deferred<{ ok: boolean }>();
    const call = vi.fn((method: string) => {
      if (method === "message.delete") return deletion.promise;
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-old", senderId: "user_a", text: "old", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { deleteMessages: true },
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const deleteButton = el.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Delete"]');
    expect(deleteButton).not.toBeNull();
    deleteButton!.click();
    await el.updateComplete;
    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog).not.toBeNull();
    dialog!.dispatchEvent(new CustomEvent("confirm"));
    expect(call).toHaveBeenCalledWith("message.delete", {
      channel_type: "telegram",
      channel_id: "telegram",
      message_id: "message-old",
    });

    el.rpcClient = null;
    el.channelType = "discord";
    await el.updateComplete;
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-new", senderId: "user_a", text: "new", timestamp: 2 }],
      _messagesAreActionable: true,
      _deleteTargetId: "message-new",
    });
    el.requestUpdate();
    await el.updateComplete;
    deletion.resolve({ ok: true });
    await deletion.promise;
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(current._messages.map((message) => message.id)).toEqual(["message-new"]);
    expect(current._deleteTargetId).toBe("message-new");
  });

  it("dispatches a confirmed message action only once while it is pending", async () => {
    const deletion = deferred<{ ok: boolean }>();
    const call = vi.fn(() => deletion.promise);
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-1", senderId: "user_a", text: "hello", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { deleteMessages: true, reactions: true },
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    el.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Delete"]')?.click();
    await el.updateComplete;
    const dialog = el.shadowRoot?.querySelector("ic-confirm-dialog");
    expect(dialog).not.toBeNull();
    dialog!.dispatchEvent(new CustomEvent("confirm"));
    dialog!.dispatchEvent(new CustomEvent("confirm"));
    await el.updateComplete;

    expect(call).toHaveBeenCalledTimes(1);
    const rowActionButtons = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".msg-action-btn") ?? [],
    );
    expect(rowActionButtons.length).toBeGreaterThan(0);
    expect(rowActionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("clears the selected platform target after deleting that message", async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true }));
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-1", senderId: "user_a", text: "hello", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { deleteMessages: true },
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    el.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Delete"]')?.click();
    await el.updateComplete;
    el.shadowRoot?.querySelector("ic-confirm-dialog")?.dispatchEvent(new CustomEvent("confirm"));
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(current._messages).toEqual([]);
    expect(current._selectedMessageId).toBe("");
    const pinButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".platform-actions button") ?? [],
    ).find((button) => button.textContent?.trim() === "Pin Message");
    expect(pinButton).toBeDefined();
    expect(pinButton!.disabled).toBe(true);
  });

  it("clears a platform target missing from refreshed native history", async () => {
    const call = vi.fn((method: string) => {
      if (method === "message.fetch") {
        return Promise.resolve({
          channelId: "chat-a",
          messages: [{ id: "message-new", senderId: "user_a", text: "new", timestamp: 2 }],
        });
      }
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-old", senderId: "user_a", text: "old", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { fetchHistory: true },
      _selectedChatId: "chat-a",
      _selectedMessageId: "message-old",
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    await current._refetchMessages();
    await el.updateComplete;

    expect(current._messages.map((message) => message.id)).toEqual(["message-new"]);
    expect(current._selectedMessageId).toBe("");
    const pinButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".platform-actions button") ?? [],
    ).find((button) => button.textContent?.trim() === "Pin Message");
    expect(pinButton).toBeDefined();
    expect(pinButton!.disabled).toBe(true);
  });

  it("does not overlap platform and message mutation actions", async () => {
    const platformAction = deferred<string>();
    const call = vi.fn((method: string) => {
      if (method === "telegram.action") return platformAction.promise;
      if (method === "message.delete") return Promise.resolve({ ok: true });
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-1", senderId: "user_a", text: "hello", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { deleteMessages: true },
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const chatInfoButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".platform-actions button") ?? [],
    ).find((button) => button.textContent?.trim() === "Chat Info");
    expect(chatInfoButton).toBeDefined();
    chatInfoButton!.click();
    await el.updateComplete;

    const deleteButton = el.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Delete"]');
    expect(deleteButton).not.toBeNull();
    deleteButton!.click();
    await el.updateComplete;
    el.shadowRoot?.querySelector("ic-confirm-dialog")?.dispatchEvent(new CustomEvent("confirm"));
    await Promise.resolve();

    expect(call.mock.calls.map(([method]) => method)).toEqual(["telegram.action"]);
    expect(deleteButton!.disabled).toBe(true);
  });

  it("sends a reaction with the selected message target", async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true }));
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-1", senderId: "user_a", text: "hello", timestamp: 1 }],
      _messagesAreActionable: true,
      _capabilities: { reactions: true },
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const reactButton = el.shadowRoot?.querySelector<HTMLButtonElement>('button[title="React"]');
    expect(reactButton).not.toBeNull();
    reactButton!.click();
    await el.updateComplete;
    const emojiButton = el.shadowRoot?.querySelector<HTMLButtonElement>(".emoji-btn");
    expect(emojiButton).not.toBeNull();
    const emoji = emojiButton!.title;
    emojiButton!.click();
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(call).toHaveBeenCalledWith("message.react", {
      channel_type: "telegram",
      channel_id: "telegram",
      message_id: "message-1",
      emoji,
    });
  });

  it("hides message actions when no channel is running", async () => {
    const call = vi.fn((method: string) => {
      if (method === "channels.list") {
        return Promise.resolve({
          channels: [{ channelType: "telegram", status: "stopped" }],
          total: 1,
        });
      }
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({
      rpcClient: createStatusRpcClient(call, "connected").client,
    });
    for (let update = 0; update < 4; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState?.getAttribute("message")).toBe("No running channels");
    expect(el.shadowRoot?.querySelector(".send-input")).toBeNull();
    expect(el.shadowRoot?.querySelector(".platform-actions")).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("loads chats once when a running channel is auto-selected", async () => {
    const call = vi.fn((method: string) => {
      switch (method) {
        case "channels.list":
          return Promise.resolve({
            channels: [{ channelType: "telegram", status: "running" }],
            total: 1,
          });
        case "channels.capabilities":
          return Promise.resolve({ channelType: "telegram", features: { fetchHistory: false } });
        case "channels.get":
          return Promise.resolve({ botName: "test-bot" });
        case "obs.channels.all":
          return Promise.resolve({ channels: [] });
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list":
          return Promise.resolve({ sessions: [], total: 0 });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const rpc = createStatusRpcClient(call, "connected");
    const el = await createElement({ rpcClient: rpc.client });
    for (let update = 0; update < 6; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(call.mock.calls.filter(([method]) => method === "obs.channels.all")).toHaveLength(1);
  });

  it("hides message actions for an explicitly stopped channel", async () => {
    const call = vi.fn((method: string) => {
      switch (method) {
        case "channels.list":
          return Promise.resolve({
            channels: [{ channelType: "telegram", status: "stopped" }],
            total: 1,
          });
        case "channels.capabilities":
          return Promise.resolve({ channelType: "telegram", features: { fetchHistory: false } });
        case "channels.get":
          return Promise.resolve({ botName: "test-bot" });
        case "obs.channels.all":
          return Promise.resolve({ channels: [] });
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list":
          return Promise.resolve({ sessions: [], total: 0 });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const el = await createElement({
      channelType: "telegram",
      rpcClient: createStatusRpcClient(call, "connected").client,
    });
    for (let update = 0; update < 5; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    const emptyState = el.shadowRoot?.querySelector("ic-empty-state");
    expect(emptyState?.getAttribute("message")).toBe("Channel is not running");
    expect(el.shadowRoot?.querySelector(".send-input")).toBeNull();
    expect(el.shadowRoot?.querySelector(".platform-actions")).toBeNull();
    expect(el.shadowRoot?.querySelector<HTMLOptionElement>('option[value="telegram"]')?.disabled)
      .toBe(true);
  });

  it("waits for the RPC connection before loading an explicit channel route", async () => {
    const call = vi.fn((method: string) => {
      switch (method) {
        case "channels.list":
          return Promise.resolve({
            channels: [{ channelType: "telegram", status: "running" }],
            total: 1,
          });
        case "channels.capabilities":
          return Promise.resolve({ channelType: "telegram", features: { fetchHistory: false } });
        case "channels.get":
          return Promise.resolve({ botName: "test-bot" });
        case "obs.channels.all":
          return Promise.resolve({ channels: [] });
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list":
          return Promise.resolve({ sessions: [], total: 0 });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const rpc = createStatusRpcClient(call, "reconnecting");
    const el = await createElement({ channelType: "telegram", rpcClient: rpc.client });

    expect(call).not.toHaveBeenCalled();
    rpc.setStatus("connected");
    await vi.waitFor(() => expect(state(el)._loadState).toBe("loaded"));
    await el.updateComplete;

    expect(call).toHaveBeenCalledWith("channels.list");
    expect(state(el)._channelIsRunning).toBe(true);
    expect(el.shadowRoot?.querySelector(".send-input")).not.toBeNull();
  });

  it("shows a terminal RPC disconnect without an inert retry control", async () => {
    const call = vi.fn(() => Promise.reject(new Error("not connected")));
    const rpc = createStatusRpcClient(call, "disconnected");
    const el = await createElement({ channelType: "telegram", rpcClient: rpc.client });

    expect(state(el)._loadState).toBe("error");
    expect(el.shadowRoot?.textContent).toContain("RPC connection failed");
    expect(el.shadowRoot?.querySelector(".retry-btn")).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it("shows a retryable error when the channel list request fails", async () => {
    let listAttempts = 0;
    const call = vi.fn((method: string) => {
      switch (method) {
        case "channels.list":
          listAttempts += 1;
          return listAttempts === 1
            ? Promise.reject(new Error("list unavailable"))
            : Promise.resolve({
                channels: [{ channelType: "telegram", status: "running" }],
                total: 1,
              });
        case "channels.capabilities":
          return Promise.resolve({ channelType: "telegram", features: { fetchHistory: false } });
        case "channels.get":
          return Promise.resolve({ botName: "test-bot" });
        case "obs.channels.all":
          return Promise.resolve({ channels: [] });
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list":
          return Promise.resolve({ sessions: [], total: 0 });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const rpc = createStatusRpcClient(call, "connected");
    const el = await createElement({ channelType: "telegram", rpcClient: rpc.client });
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(state(el)._loadState).toBe("error");
    const retry = el.shadowRoot?.querySelector<HTMLButtonElement>(".retry-btn");
    expect(retry).not.toBeNull();
    retry!.click();
    for (let update = 0; update < 5; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(listAttempts).toBe(2);
    expect(state(el)._channelIsRunning).toBe(true);
  });

  it("retries channel discovery when the bare messages route fails", async () => {
    let listAttempts = 0;
    const call = vi.fn((method: string) => {
      switch (method) {
        case "channels.list":
          listAttempts += 1;
          return listAttempts === 1
            ? Promise.reject(new Error("list unavailable"))
            : Promise.resolve({
                channels: [{ channelType: "telegram", status: "running" }],
                total: 1,
              });
        case "channels.capabilities":
          return Promise.resolve({ channelType: "telegram", features: { fetchHistory: false } });
        case "channels.get":
          return Promise.resolve({ botName: "test-bot" });
        case "obs.channels.all":
          return Promise.resolve({ channels: [] });
        case "config.read": return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
        case "agents.list": return Promise.resolve({ agents: ["agent-a"] });
        case "session.list":
          return Promise.resolve({ sessions: [], total: 0 });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const rpc = createStatusRpcClient(call, "connected");
    const el = await createElement({ rpcClient: rpc.client });
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(state(el)._loadState).toBe("error");
    el.shadowRoot?.querySelector<HTMLButtonElement>(".retry-btn")?.click();
    for (let update = 0; update < 6; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(listAttempts).toBe(3);
    expect(state(el)._effectiveChannel).toBe("telegram");
    expect(state(el)._channelIsRunning).toBe(true);
  });

  it("clears channel options when the RPC client is replaced", async () => {
    const firstCall = vi.fn((method: string) => {
      if (method === "channels.list") {
        return Promise.resolve({
          channels: [{ channelType: "telegram", status: "stopped" }],
          total: 1,
        });
      }
      return Promise.resolve({});
    });
    const firstRpc = createStatusRpcClient(firstCall, "connected");
    const el = await createElement({ channelType: "telegram", rpcClient: firstRpc.client });
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect(state(el)._channelList).toHaveLength(1);

    const replacementRpc = createStatusRpcClient(vi.fn(() => Promise.resolve({})), "disconnected");
    el.rpcClient = replacementRpc.client;
    await el.updateComplete;

    expect(state(el)._channelList).toEqual([]);
  });

  it("releases a pending action when the RPC client is replaced", async () => {
    const send = deferred<{ ok: boolean }>();
    const firstCall = vi.fn(() => send.promise);
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(firstCall, "connected").client;
    await el.updateComplete;

    const input = el.shadowRoot?.querySelector<HTMLTextAreaElement>(".send-input");
    const sendButton = el.shadowRoot?.querySelector<HTMLButtonElement>(".send-form .btn-primary");
    expect(input).not.toBeNull();
    expect(sendButton).not.toBeNull();
    input!.value = "hello";
    input!.dispatchEvent(new Event("input"));
    await el.updateComplete;
    el.shadowRoot?.querySelector<HTMLButtonElement>(".send-form .btn-primary")?.click();
    await el.updateComplete;
    el.shadowRoot?.querySelector("ic-confirm-dialog")?.dispatchEvent(new CustomEvent("confirm"));
    expect(firstCall).toHaveBeenCalledWith("message.send", {
      channel_type: "telegram",
      channel_id: "telegram",
      text: "hello",
    });
    expect(state(el)._actionPending).toBe(true);

    el.rpcClient = createStatusRpcClient(
      vi.fn(() => Promise.reject(new Error("not connected"))),
      "disconnected",
    ).client;
    await el.updateComplete;
    send.resolve({ ok: true });
    await send.promise;
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(state(el)._actionPending).toBe(false);
    expect(state(el)._sendText).toBe("");
  });

  it("discards a message response from a replaced RPC client", async () => {
    const fetch = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _capabilities: { fetchHistory: true },
      _selectedChatId: "chat-a",
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(vi.fn(() => fetch.promise), "connected").client;
    await el.updateComplete;
    const oldRequest = current._refetchMessages();

    el.rpcClient = createStatusRpcClient(
      vi.fn(() => Promise.reject(new Error("not connected"))),
      "disconnected",
    ).client;
    await el.updateComplete;
    fetch.resolve({
      channelId: "chat-a",
      messages: [{ id: "old-client", senderId: "user_a", text: "old", timestamp: 1 }],
    });
    await oldRequest;

    expect(current._messages).toEqual([]);
  });

  it("restarts channel auto-selection with a replacement RPC client", async () => {
    const firstRpc = createStatusRpcClient(
      vi.fn(() => Promise.reject(new Error("not connected"))),
      "reconnecting",
    );
    const secondCall = vi.fn(() => Promise.resolve({ channels: [], total: 0 }));
    const secondRpc = createStatusRpcClient(secondCall, "connected");
    const el = await createElement({ rpcClient: firstRpc.client });

    el.rpcClient = secondRpc.client;
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;

    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledWith("channels.list");
  });

  it("rebinds RPC status changes when the same view is reattached", async () => {
    const call = vi.fn(() => Promise.resolve({ channels: [], total: 0 }));
    const rpc = createStatusRpcClient(call, "reconnecting");
    const el = await createElement({ rpcClient: rpc.client });
    expect(rpc.listenerCount()).toBe(1);

    document.body.removeChild(el);
    expect(rpc.listenerCount()).toBe(0);
    document.body.appendChild(el);
    await el.updateComplete;

    expect(rpc.listenerCount()).toBe(1);
    rpc.setStatus("connected");
    await Promise.resolve();
    await el.updateComplete;
    expect(call).toHaveBeenCalledWith("channels.list");
  });

  it("invalidates a pending message action when the view detaches", async () => {
    const send = deferred<{ ok: boolean }>();
    const methods: string[] = [];
    const call = vi.fn((method: string) => {
      methods.push(method);
      if (method === "message.send") return send.promise;
      if (method === "config.read") return Promise.resolve({ config: { tenantId: "tenant-a" }, sections: [] });
      if (method === "agents.list") return Promise.resolve({ agents: ["agent-a"] });
      if (method === "session.list") return Promise.resolve({ sessions: [], total: 0 });
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const input = el.shadowRoot?.querySelector<HTMLTextAreaElement>(".send-input");
    input!.value = "hello";
    input!.dispatchEvent(new Event("input"));
    await el.updateComplete;
    el.shadowRoot?.querySelector<HTMLButtonElement>(".send-form .btn-primary")?.click();
    await el.updateComplete;
    el.shadowRoot?.querySelector("ic-confirm-dialog")?.dispatchEvent(new CustomEvent("confirm"));
    expect(state(el)._actionPending).toBe(true);

    document.body.removeChild(el);
    send.resolve({ ok: true });
    await send.promise;
    await Promise.resolve();

    expect(methods).toEqual(["message.send"]);
    expect(state(el)._actionPending).toBe(false);
  });

  it("discards an explicit channel load that finishes after detachment", async () => {
    const list = deferred<{ channels: Array<{ channelType: string; status: string }> }>();
    const capabilities = deferred<{ channelType: string; features: Record<string, boolean> }>();
    const config = deferred<Record<string, unknown>>();
    const call = vi.fn((method: string) => {
      if (method === "channels.list") return list.promise;
      if (method === "channels.capabilities") return capabilities.promise;
      if (method === "channels.get") return config.promise;
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const rpc = createStatusRpcClient(call, "connected");
    const el = await createElement({ channelType: "telegram", rpcClient: rpc.client });
    expect(call).toHaveBeenCalledTimes(3);

    document.body.removeChild(el);
    list.resolve({ channels: [{ channelType: "telegram", status: "stopped" }] });
    capabilities.resolve({ channelType: "telegram", features: {} });
    config.resolve({ botName: "test-bot" });
    await Promise.all([list.promise, capabilities.promise, config.promise]);
    await Promise.resolve();

    expect(state(el)._hasLoaded).toBe(false);
    expect(state(el)._loadState).toBe("idle");
  });

  it("keeps the mutation lock when a chat change is requested", async () => {
    const action = deferred<string>();
    const call = vi.fn((method: string) => {
      if (method === "telegram.action") return action.promise;
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _chatList: [
        { chatId: "chat-a", label: "Chat A" },
        { chatId: "chat-b", label: "Chat B" },
      ],
      _selectedChatId: "chat-a",
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    await el.updateComplete;

    const chatInfoButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".platform-actions button") ?? [],
    ).find((button) => button.textContent?.trim() === "Chat Info");
    chatInfoButton!.click();
    await el.updateComplete;
    expect(current._platformActionPending).toBe(true);

    const chatSelect = el.shadowRoot?.querySelector<HTMLSelectElement>("#chat-select");
    expect(chatSelect!.disabled).toBe(true);
    chatSelect!.value = "chat-b";
    chatSelect!.dispatchEvent(new Event("change"));

    expect(current._selectedChatId).toBe("chat-a");
    expect(current._platformActionPending).toBe(true);
    action.resolve("done");
    await action.promise;
  });

  it("keeps the mutation lock when a channel change is requested", async () => {
    const action = deferred<string>();
    const call = vi.fn((method: string) => {
      if (method === "telegram.action") return action.promise;
      return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
    });
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _channelList: [
        { channelType: "telegram", status: "running" },
        { channelType: "discord", status: "running" },
      ],
      _hasLoaded: true,
    });
    el.rpcClient = createStatusRpcClient(call, "connected").client;
    const navigate = vi.fn();
    el.addEventListener("navigate", navigate);
    await el.updateComplete;

    const chatInfoButton = Array.from(
      el.shadowRoot?.querySelectorAll<HTMLButtonElement>(".platform-actions button") ?? [],
    ).find((button) => button.textContent?.trim() === "Chat Info");
    chatInfoButton!.click();
    await el.updateComplete;
    expect(current._platformActionPending).toBe(true);

    const channelSelect = el.shadowRoot?.querySelector<HTMLSelectElement>("#channel-select");
    expect(channelSelect!.disabled).toBe(true);
    channelSelect!.value = "discord";
    channelSelect!.dispatchEvent(new Event("change"));

    expect(navigate).not.toHaveBeenCalled();
    expect(current._platformActionPending).toBe(true);
    action.resolve("done");
    await action.promise;
  });

  it("does not subscribe a replacement RPC client while detached", async () => {
    const firstRpc = createStatusRpcClient(vi.fn(), "reconnecting");
    const secondRpc = createStatusRpcClient(vi.fn(), "reconnecting");
    const el = await createElement({ rpcClient: firstRpc.client });

    document.body.removeChild(el);
    el.rpcClient = secondRpc.client;
    await el.updateComplete;

    expect(firstRpc.listenerCount()).toBe(0);
    expect(secondRpc.listenerCount()).toBe(0);
  });

  it("loads once when an RPC replacement is queued across reattachment", async () => {
    const firstRpc = createStatusRpcClient(vi.fn(), "reconnecting");
    const secondCall = vi.fn(() => Promise.resolve({ channels: [], total: 0 }));
    const secondRpc = createStatusRpcClient(secondCall, "connected");
    const el = await createElement({ rpcClient: firstRpc.client });

    document.body.removeChild(el);
    el.rpcClient = secondRpc.client;
    document.body.appendChild(el);
    for (let update = 0; update < 4; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(secondRpc.listenerCount()).toBe(1);
    expect(secondCall.mock.calls.filter(([method]) => method === "channels.list")).toHaveLength(1);
  });

  it("unsubscribes from RPC status changes after disconnect", async () => {
    const call = vi.fn(() => Promise.reject(new Error("not connected")));
    const rpc = createStatusRpcClient(call, "reconnecting");
    const el = await createElement({ rpcClient: rpc.client });
    expect(rpc.listenerCount()).toBe(1);

    document.body.removeChild(el);
    rpc.setStatus("connected");
    await Promise.resolve();

    expect(rpc.listenerCount()).toBe(0);
    expect(call).not.toHaveBeenCalled();
  });
});
