// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
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
  };
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
    expect(state(el)).toMatchObject({
      _loadState: "idle",
      _messages: [],
      _effectiveChannel: "",
      _capabilities: null,
      _botName: "",
      _chatList: [],
      _selectedChatId: "",
      _autoSelectAttempted: false,
    });
  });
});
