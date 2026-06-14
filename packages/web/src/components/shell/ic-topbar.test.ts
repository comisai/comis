// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import { IcTopbar } from "./ic-topbar.js";

// Import side-effect to register custom element
import "./ic-topbar.js";

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

describe("IcTopbar", () => {
  it("renders connection status dot", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const dot = el.shadowRoot?.querySelector(".connection-dot");
    expect(dot).toBeTruthy();
  });

  it("dot is green when connectionStatus is 'connected'", async () => {
    const el = await createElement<IcTopbar>("ic-topbar", {
      connectionStatus: "connected",
    });
    const dot = el.shadowRoot?.querySelector(".connection-dot");
    expect(dot?.classList.contains("connected")).toBe(true);
  });

  it("dot is yellow when connectionStatus is 'reconnecting'", async () => {
    const el = await createElement<IcTopbar>("ic-topbar", {
      connectionStatus: "reconnecting",
    });
    const dot = el.shadowRoot?.querySelector(".connection-dot");
    expect(dot?.classList.contains("reconnecting")).toBe(true);
  });

  it("dot is red when connectionStatus is 'disconnected'", async () => {
    const el = await createElement<IcTopbar>("ic-topbar", {
      connectionStatus: "disconnected",
    });
    const dot = el.shadowRoot?.querySelector(".connection-dot");
    expect(dot?.classList.contains("disconnected")).toBe(true);
  });

  it("shows notification count badge when notificationCount > 0", async () => {
    const el = await createElement<IcTopbar>("ic-topbar", {
      notificationCount: 7,
    });
    const badge = el.shadowRoot?.querySelector(".bell-badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("7");
  });

  it("hides notification badge when notificationCount is 0", async () => {
    const el = await createElement<IcTopbar>("ic-topbar", {
      notificationCount: 0,
    });
    const badge = el.shadowRoot?.querySelector(".bell-badge");
    expect(badge).toBeFalsy();
  });

  it("has complementary ARIA landmark (role='complementary')", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const aside = el.shadowRoot?.querySelector("[role='complementary']");
    expect(aside).toBeTruthy();
  });

  it("complementary region has aria-label='System status'", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const aside = el.shadowRoot?.querySelector("[role='complementary']");
    expect(aside?.getAttribute("aria-label")).toBe("System status");
  });

  it("connection status region has aria-live='polite'", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const liveRegion = el.shadowRoot?.querySelector("[aria-live='polite']");
    expect(liveRegion).toBeTruthy();
  });

  it("dispatches 'toggle-sidebar' event on hamburger click", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const handler = vi.fn();
    el.addEventListener("toggle-sidebar", handler);

    const hamburger = el.shadowRoot?.querySelector(
      ".hamburger",
    ) as HTMLElement;
    hamburger?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("navigates to the security pending-approvals queue when the bell is clicked (P7)", async () => {
    // P7: the notification bell was a dead button (no handler). It must take the
    // operator to where pending approvals are actioned — the Security view's
    // *pending-approvals* tab, not the default Security Events tab. The bell's
    // badge counts pending approvals, so the deep-link must select that tab.
    const el = await createElement<IcTopbar>("ic-topbar", { notificationCount: 3 });
    const handler = vi.fn();
    el.addEventListener("navigate", handler as EventListener);

    const bell = el.shadowRoot?.querySelector(".bell-btn") as HTMLElement;
    expect(bell).toBeTruthy();
    bell.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0]![0] as CustomEvent<string>).detail).toBe("security?tab=pending");
  });

  it("dispatches 'logout' event from user menu logout action", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const handler = vi.fn();
    el.addEventListener("logout", handler);

    // Open the user menu
    const avatarBtn = el.shadowRoot?.querySelector(
      ".avatar-btn",
    ) as HTMLElement;
    avatarBtn?.click();
    await el.updateComplete;

    // Click logout in dropdown
    const logoutAction = el.shadowRoot?.querySelector(
      ".dropdown-action",
    ) as HTMLElement;
    logoutAction?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("shows brand text 'Comis'", async () => {
    const el = await createElement<IcTopbar>("ic-topbar");
    const brandImg = el.shadowRoot?.querySelector(".brand img.brand-icon") as HTMLImageElement;
    expect(brandImg?.alt).toBe("Comis");
  });
});
