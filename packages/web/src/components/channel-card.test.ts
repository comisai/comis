// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { IcChannelCard } from "./channel-card.js";

// Import side-effect to register custom element
import "./channel-card.js";

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

describe("IcChannelCard", () => {
  // --- Basic rendering ---

  it("renders with default properties", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card");
    expect(el.channelType).toBe("");
    expect(el.name).toBe("");
    expect(el.status).toBe("disconnected");
    expect(el.enabled).toBe(false);
    expect(el.isStale).toBe(false);
    expect(el.messageCount).toBe(0);
    expect(el.uptime).toBe(0);
    expect(el.lastActivity).toBe(0);
  });

  it("displays channel name from name property", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      name: "My Channel",
      channelType: "telegram",
    });
    const nameEl = el.shadowRoot?.querySelector(".channel-name");
    expect(nameEl?.textContent?.trim()).toBe("My Channel");
  });

  it("falls back to channelType when name is empty", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      channelType: "discord",
    });
    const nameEl = el.shadowRoot?.querySelector(".channel-name");
    expect(nameEl?.textContent?.trim()).toBe("discord");
  });

  it("renders platform icon with correct platform", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      channelType: "telegram",
    });
    const icon = el.shadowRoot?.querySelector("ic-platform-icon") as any;
    expect(icon).toBeTruthy();
    expect(icon?.platform).toBe("telegram");
  });

  // --- Status dot colors ---

  it("shows green status dot for connected", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "connected",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-success)");
  });

  it("shows gray status dot for disconnected", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "disconnected",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-text-dim)");
  });

  it("shows red status dot for error", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "error",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-error)");
  });

  it("shows yellow status dot when stale", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "connected",
      isStale: true,
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-warning)");
  });

  // --- Metrics ---

  it("renders message count", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      messageCount: 1234,
    });
    const labels = el.shadowRoot?.querySelectorAll(".metric-label");
    const values = el.shadowRoot?.querySelectorAll(".metric-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).toContain("Messages");
    const msgIdx = labelTexts.indexOf("Messages");
    expect(values?.[msgIdx]?.textContent?.trim()).toBe("1,234");
  });

  it("renders uptime when connected and > 0", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "connected",
      uptime: 3600,
    });
    const labels = el.shadowRoot?.querySelectorAll(".metric-label");
    const values = el.shadowRoot?.querySelectorAll(".metric-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).toContain("Uptime");
    const uptimeIdx = labelTexts.indexOf("Uptime");
    expect(values?.[uptimeIdx]?.textContent?.trim()).toBe("1h");
  });

  it("does NOT render uptime when disconnected", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "disconnected",
      uptime: 3600,
    });
    const labels = el.shadowRoot?.querySelectorAll(".metric-label");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    expect(labelTexts).not.toContain("Uptime");
  });

  it("formats uptime correctly: 86400 -> '1d 0h'", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "connected",
      uptime: 86400,
    });
    const labels = el.shadowRoot?.querySelectorAll(".metric-label");
    const values = el.shadowRoot?.querySelectorAll(".metric-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    const uptimeIdx = labelTexts.indexOf("Uptime");
    expect(values?.[uptimeIdx]?.textContent?.trim()).toBe("1d 0h");
  });

  it("formats uptime correctly: 300 -> '5m'", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "connected",
      uptime: 300,
    });
    const labels = el.shadowRoot?.querySelectorAll(".metric-label");
    const values = el.shadowRoot?.querySelectorAll(".metric-value");
    const labelTexts = Array.from(labels ?? []).map((l) => l.textContent?.trim());
    const uptimeIdx = labelTexts.indexOf("Uptime");
    expect(values?.[uptimeIdx]?.textContent?.trim()).toBe("5m");
  });

  // --- Stale warning ---

  it("shows stale warning when isStale and lastActivity > 0", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      isStale: true,
      lastActivity: Date.now() - 3600000, // 1 hour ago
    });
    const warning = el.shadowRoot?.querySelector(".stale-warning");
    expect(warning).toBeTruthy();
    expect(warning?.textContent?.trim()).toContain("Last seen");
    expect(warning?.textContent?.trim()).toContain("ago");
  });

  it("does NOT show stale warning when isStale is false", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      isStale: false,
      lastActivity: Date.now() - 3600000,
    });
    const warning = el.shadowRoot?.querySelector(".stale-warning");
    expect(warning).toBeNull();
  });

  // --- Action buttons: disabled state ---

  it("shows 'Enable' button when disabled", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      enabled: false,
    });
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const labels = Array.from(buttons ?? []).map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Enable"]);
  });

  it("shows 'Configure' and 'Restart' buttons when enabled", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      enabled: true,
    });
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const labels = Array.from(buttons ?? []).map((b) => b.textContent?.trim());
    expect(labels).toContain("Configure");
    expect(labels).toContain("Restart");
  });

  // --- Action events ---

  it("enable button dispatches channel-action with action='enable'", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      channelType: "telegram",
      enabled: false,
    });
    const handler = vi.fn();
    el.addEventListener("channel-action", handler);
    const btn = el.shadowRoot?.querySelector(".action-btn") as HTMLElement;
    btn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "enable", channelType: "telegram" });
  });

  it("configure button dispatches channel-action with action='configure'", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      channelType: "discord",
      enabled: true,
    });
    const handler = vi.fn();
    el.addEventListener("channel-action", handler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const configBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Configure",
    ) as HTMLElement;
    configBtn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "configure", channelType: "discord" });
  });

  it("restart button dispatches channel-action with action='restart'", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      channelType: "slack",
      enabled: true,
    });
    const handler = vi.fn();
    el.addEventListener("channel-action", handler);
    const buttons = el.shadowRoot?.querySelectorAll(".action-btn");
    const restartBtn = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Restart",
    ) as HTMLElement;
    restartBtn?.click();
    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ action: "restart", channelType: "slack" });
  });

  // --- Design tokens ---

  it("status dot uses design token CSS variables", async () => {
    const el = await createElement<IcChannelCard>("ic-channel-card", {
      status: "connected",
    });
    const dot = el.shadowRoot?.querySelector(".status-dot") as HTMLElement;
    const style = dot?.getAttribute("style") ?? "";
    expect(style).toContain("var(--ic-");
  });
});
