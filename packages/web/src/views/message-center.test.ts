// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../api/rpc-client.js";
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
    _effectiveChannel: string;
    _channelIsRunning: boolean;
    _capabilities: Record<string, unknown> | null;
    _botName: string;
    _chatList: Array<{ chatId: string; label: string }>;
    _selectedChatId: string;
    _autoSelectAttempted: boolean;
    _hasLoaded: boolean;
    _actionResult: string;
    _actionPending: boolean;
    _sendText: string;
    _deleteTargetId: string;
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
        case "session.list": return Promise.resolve({ sessions: [] });
        default: return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const rpcClient = { status: "connected", call } as unknown as RpcClient;
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
    el.rpcClient = { status: "connected", call } as unknown as RpcClient;
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
    el.rpcClient = { status: "connected", call } as unknown as RpcClient;
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
    el.rpcClient = { status: "connected", call } as unknown as RpcClient;
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
      _capabilities: { deleteMessages: true },
      _hasLoaded: true,
    });
    el.rpcClient = { status: "connected", call } as unknown as RpcClient;
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

  it("sends a reaction with the selected message target", async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true }));
    const el = await createElement({ channelType: "telegram" });
    const current = state(el);
    Object.assign(current, {
      _loadState: "loaded",
      _channelIsRunning: true,
      _messages: [{ id: "message-1", senderId: "user_a", text: "hello", timestamp: 1 }],
      _capabilities: { reactions: true },
      _hasLoaded: true,
    });
    el.rpcClient = { status: "connected", call } as unknown as RpcClient;
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
      rpcClient: { status: "connected", call } as unknown as RpcClient,
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
        case "session.list":
          return Promise.resolve({ sessions: [] });
        default:
          return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
    });
    const el = await createElement({
      channelType: "telegram",
      rpcClient: { status: "connected", call } as unknown as RpcClient,
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

  it("releases a pending action when the RPC client is replaced", async () => {
    const send = deferred<{ ok: boolean }>();
    const firstCall = vi.fn(() => send.promise);
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
      _channelIsRunning: true,
      _hasLoaded: true,
    });
    el.rpcClient = { status: "connected", call: firstCall } as unknown as RpcClient;
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

    el.rpcClient = {
      status: "disconnected",
      call: vi.fn(() => Promise.reject(new Error("not connected"))),
    } as unknown as RpcClient;
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
    el.rpcClient = {
      status: "connected",
      call: vi.fn(() => fetch.promise),
    } as unknown as RpcClient;
    await el.updateComplete;
    const oldRequest = current._refetchMessages();

    el.rpcClient = {
      status: "disconnected",
      call: vi.fn(() => Promise.reject(new Error("not connected"))),
    } as unknown as RpcClient;
    await el.updateComplete;
    fetch.resolve({
      channelId: "chat-a",
      messages: [{ id: "old-client", senderId: "user_a", text: "old", timestamp: 1 }],
    });
    await oldRequest;

    expect(current._messages).toEqual([]);
  });

  it("restarts channel auto-selection with a replacement RPC client", async () => {
    vi.useFakeTimers();
    const firstClient = {
      status: "connecting",
      call: vi.fn(() => Promise.reject(new Error("not connected"))),
    };
    const secondCall = vi.fn(() => Promise.resolve({ channels: [], total: 0 }));
    const el = await createElement({ rpcClient: firstClient as unknown as RpcClient });

    el.rpcClient = { status: "connected", call: secondCall } as unknown as RpcClient;
    await el.updateComplete;
    await Promise.resolve();
    firstClient.status = "disconnected";
    await vi.advanceTimersByTimeAsync(100);
    await el.updateComplete;

    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledWith("channels.list");
  });

  it("stops channel auto-selection polling after disconnect", async () => {
    vi.useFakeTimers();
    const el = await createElement({
      rpcClient: {
        status: "connecting",
        call: vi.fn(() => Promise.reject(new Error("not connected"))),
      } as unknown as RpcClient,
    });

    document.body.removeChild(el);
    await vi.advanceTimersByTimeAsync(300);

    expect(vi.getTimerCount()).toBe(0);
  });
});
