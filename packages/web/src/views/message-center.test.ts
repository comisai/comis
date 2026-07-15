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
    _capabilities: Record<string, unknown> | null;
    _botName: string;
    _chatList: Array<{ chatId: string; label: string }>;
    _selectedChatId: string;
    _autoSelectAttempted: boolean;
    _hasLoaded: boolean;
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
  document.body.innerHTML = "";
});

describe("IcMessageCenter breadcrumb navigation", () => {
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
    const chatA = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    const chatB = deferred<{ messages: Array<{ id: string; senderId: string; text: string; timestamp: number }>; channelId: string }>();
    const call = vi.fn((method: string, params?: Record<string, unknown>) => {
      if (method !== "message.fetch") {
        return Promise.reject(new Error(`Unexpected RPC method: ${method}`));
      }
      return params?.["channel_id"] === "chat-b" ? chatB.promise : chatA.promise;
    });
    const el = await createElement({ channelType: "telegram" });
    Object.assign(state(el), {
      _loadState: "loaded",
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

    let select = el.shadowRoot?.querySelector<HTMLSelectElement>("#chat-select");
    expect(select).not.toBeNull();
    select!.value = "chat-b";
    select!.dispatchEvent(new Event("change"));
    await el.updateComplete;
    select = el.shadowRoot?.querySelector<HTMLSelectElement>("#chat-select");
    select!.value = "chat-a";
    select!.dispatchEvent(new Event("change"));

    chatA.resolve({
      channelId: "chat-a",
      messages: [{ id: "new-a", senderId: "user_a", text: "new", timestamp: 2 }],
    });
    await chatA.promise;
    await Promise.resolve();
    chatB.resolve({
      channelId: "chat-b",
      messages: [{ id: "old-b", senderId: "user_a", text: "old", timestamp: 1 }],
    });
    await chatB.promise;
    for (let update = 0; update < 3; update += 1) {
      await Promise.resolve();
      await el.updateComplete;
    }

    expect(state(el)._selectedChatId).toBe("chat-a");
    expect(state(el)._messages.map((message) => message.id)).toEqual(["new-a"]);
  });
});
