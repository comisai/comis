// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { IcChannelBadge } from "./channel-badge.js";

// Import side-effect to register custom element
import "./channel-badge.js";

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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcChannelBadge", () => {
  // --- Basic rendering ---

  it("renders with default properties", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge");
    expect(el.channelType).toBe("");
    expect(el.name).toBe("");
    expect(el.status).toBe("disconnected");
    expect(el.enabled).toBe(false);
    expect(el.uptime).toBe(0);
    expect(el.channelId).toBe("");
  });

  it("displays channel name from name property", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      name: "My Channel",
      channelType: "telegram",
    });
    const nameEl = el.shadowRoot?.querySelector(".channel-name");
    expect(nameEl?.textContent?.trim()).toBe("My Channel");
  });

  it("falls back to channelType when name is empty", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      channelType: "discord",
    });
    const nameEl = el.shadowRoot?.querySelector(".channel-name");
    expect(nameEl?.textContent?.trim()).toBe("discord");
  });

  // --- Status dot colors ---

  it("shows correct status dot color for connected", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      status: "connected",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-success)");
  });

  it("shows correct status dot color for disconnected", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      status: "disconnected",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-text-dim)");
  });

  it("shows correct status dot color for error", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      status: "error",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-error)");
  });

  // --- Disabled label ---

  it("shows '(off)' label when enabled is false", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      enabled: false,
    });
    const label = el.shadowRoot?.querySelector(".disabled-label");
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim()).toBe("(off)");
  });

  it("hides '(off)' label when enabled is true", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      enabled: true,
    });
    const label = el.shadowRoot?.querySelector(".disabled-label");
    expect(label).toBeNull();
  });

  // --- Platform icon ---

  it("renders ic-platform-icon instead of emoji", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      channelType: "telegram",
    });
    const platformIcon = el.shadowRoot?.querySelector("ic-platform-icon");
    expect(platformIcon).not.toBeNull();
    // No .channel-icon span with emoji
    const emojiSpan = el.shadowRoot?.querySelector(".channel-icon");
    expect(emojiSpan).toBeNull();
  });

  it("platform icon receives correct platform prop", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      channelType: "discord",
    });
    const platformIcon = el.shadowRoot?.querySelector("ic-platform-icon") as any;
    expect(platformIcon?.platform).toBe("discord");
  });

  // --- Uptime display ---

  it("renders uptime when > 0 and status is connected", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      uptime: 3600,
      status: "connected",
    });
    const uptimeEl = el.shadowRoot?.querySelector(".uptime");
    expect(uptimeEl).not.toBeNull();
    expect(uptimeEl?.textContent?.trim()).toBe("1h");
  });

  it("formats uptime correctly: 86400 -> '1d 0h'", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      uptime: 86400,
      status: "connected",
    });
    const uptimeEl = el.shadowRoot?.querySelector(".uptime");
    expect(uptimeEl?.textContent?.trim()).toBe("1d 0h");
  });

  it("formats uptime correctly: 300 -> '5m'", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      uptime: 300,
      status: "connected",
    });
    const uptimeEl = el.shadowRoot?.querySelector(".uptime");
    expect(uptimeEl?.textContent?.trim()).toBe("5m");
  });

  it("does NOT render uptime when status is disconnected", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      uptime: 3600,
      status: "disconnected",
    });
    const uptimeEl = el.shadowRoot?.querySelector(".uptime");
    expect(uptimeEl).toBeNull();
  });

  it("does NOT render uptime when uptime is 0", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      uptime: 0,
      status: "connected",
    });
    const uptimeEl = el.shadowRoot?.querySelector(".uptime");
    expect(uptimeEl).toBeNull();
  });

  // --- Navigate events ---

  it("dispatches 'navigate' CustomEvent on click with correct path", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      channelType: "telegram",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    const badge = el.shadowRoot?.querySelector(".badge") as HTMLElement;
    badge.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toBe("channels/telegram");
  });

  it("navigate event detail uses channelId when provided", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      channelType: "discord",
      channelId: "disc-01",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    el.shadowRoot?.querySelector<HTMLElement>(".badge")?.click();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(
      "channels/disc-01",
    );
  });

  // --- Accessibility ---

  it("badge has role='link' and tabindex='0'", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge");
    const badge = el.shadowRoot?.querySelector(".badge");
    expect(badge?.getAttribute("role")).toBe("link");
    expect(badge?.getAttribute("tabindex")).toBe("0");
  });

  it("Enter key triggers navigate event", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      channelType: "slack",
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);
    const badge = el.shadowRoot?.querySelector(".badge") as HTMLElement;
    badge.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });

  // --- Design token tests ---

  it("uses design token CSS variables in shadow DOM", async () => {
    const el = await createElement<IcChannelBadge>("ic-channel-badge", {
      status: "connected",
    });
    // Verify status dot uses design tokens via inline style attribute
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const dotStyle = dot?.getAttribute("style") ?? "";
    expect(dotStyle).toContain("var(--ic-");
  });
});
