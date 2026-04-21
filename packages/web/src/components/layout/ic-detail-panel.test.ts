// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcDetailPanel } from "./ic-detail-panel.js";

// Import side-effect to register custom element
import "./ic-detail-panel.js";

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

describe("IcDetailPanel", () => {
  it("panel is hidden when open is false", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel");
    const overlay = el.shadowRoot?.querySelector(".overlay");
    const panel = el.shadowRoot?.querySelector(".panel");
    expect(overlay).toBeNull();
    expect(panel).toBeNull();
  });

  it("panel is visible when open is true", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const overlay = el.shadowRoot?.querySelector(".overlay");
    const panel = el.shadowRoot?.querySelector(".panel");
    expect(overlay).toBeTruthy();
    expect(panel).toBeTruthy();
  });

  it("renders panelTitle text in header", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
      panelTitle: "Memory Detail",
    });
    const title = el.shadowRoot?.querySelector(".panel-title");
    expect(title?.textContent?.trim()).toBe("Memory Detail");
  });

  it("close button is present", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const closeBtn = el.shadowRoot?.querySelector(".close-btn");
    expect(closeBtn).toBeTruthy();
  });

  it("clicking close button dispatches close event", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const handler = vi.fn();
    el.addEventListener("close", handler);

    const closeBtn = el.shadowRoot?.querySelector(".close-btn") as HTMLElement;
    closeBtn.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("clicking overlay backdrop dispatches close event", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const handler = vi.fn();
    el.addEventListener("close", handler);

    const overlay = el.shadowRoot?.querySelector(".overlay") as HTMLElement;
    overlay.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("Escape key dispatches close event when open", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const handler = vi.fn();
    el.addEventListener("close", handler);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("has role=complementary", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const panel = el.shadowRoot?.querySelector(".panel");
    expect(panel?.getAttribute("role")).toBe("complementary");
  });

  it("has aria-label matching panelTitle", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
      panelTitle: "Session Detail",
    });
    const panel = el.shadowRoot?.querySelector(".panel");
    expect(panel?.getAttribute("aria-label")).toBe("Session Detail");
  });

  it("slot content renders in panel body", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const slotContent = document.createElement("p");
    slotContent.textContent = "Test content";
    el.appendChild(slotContent);
    await el.updateComplete;

    const body = el.shadowRoot?.querySelector(".panel-body");
    expect(body).toBeTruthy();
    const slot = body?.querySelector("slot:not([name])");
    expect(slot).toBeTruthy();
  });

  it("footer slot renders in panel footer area", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
    });
    const footerContent = document.createElement("div");
    footerContent.slot = "footer";
    footerContent.textContent = "Footer buttons";
    el.appendChild(footerContent);
    await el.updateComplete;

    const footer = el.shadowRoot?.querySelector(".panel-footer");
    expect(footer).toBeTruthy();
    const footerSlot = footer?.querySelector('slot[name="footer"]');
    expect(footerSlot).toBeTruthy();
  });

  it("custom width property is applied to panel", async () => {
    const el = await createElement<IcDetailPanel>("ic-detail-panel", {
      open: true,
      width: "400px",
    });
    const panel = el.shadowRoot?.querySelector(".panel") as HTMLElement;
    expect(panel?.style.width).toBe("400px");
  });
});
