import { describe, it, expect, afterEach, vi } from "vitest";
import { IcNavBar } from "./nav-bar.js";

// Import side-effect to register custom element
import "./nav-bar.js";

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

describe("IcNavBar", () => {
  it("renders three navigation links (Dashboard, Chat, Memory)", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar");
    const links = el.shadowRoot?.querySelectorAll(".nav-link");
    expect(links?.length).toBe(3);

    const texts = Array.from(links!).map((l) => l.textContent ?? "");
    expect(texts.some((t) => t.includes("Dashboard"))).toBe(true);
    expect(texts.some((t) => t.includes("Chat"))).toBe(true);
    expect(texts.some((t) => t.includes("Memory"))).toBe(true);
  });

  it("highlights active link based on currentRoute property", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar", {
      currentRoute: "chat",
    });
    const links = el.shadowRoot?.querySelectorAll(".nav-link");
    const chatLink = Array.from(links!).find((l) =>
      l.textContent?.trim().includes("Chat"),
    );
    expect(chatLink?.hasAttribute("data-active")).toBe(true);

    const dashboardLink = Array.from(links!).find((l) =>
      l.textContent?.trim().includes("Dashboard"),
    );
    expect(dashboardLink?.hasAttribute("data-active")).toBe(false);
  });

  it("dispatches 'navigate' CustomEvent with route detail on nav link click", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar");
    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const links = el.shadowRoot?.querySelectorAll(".nav-link");
    const chatLink = Array.from(links!).find((l) =>
      l.textContent?.trim().includes("Chat"),
    ) as HTMLElement;
    chatLink?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("chat");
  });

  it("dispatches 'logout' CustomEvent when disconnect button is clicked", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar");
    const handler = vi.fn();
    el.addEventListener("logout", handler);

    const logoutBtn = el.shadowRoot?.querySelector(".logout-btn") as HTMLElement;
    logoutBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("shows brand name 'Comis'", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar");
    const brand = el.shadowRoot?.querySelector(".brand");
    expect(brand?.textContent).toContain("Comis");
  });

  it("shows 'Connected' status label", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar");
    const label = el.shadowRoot?.querySelector(".status-label");
    expect(label?.textContent?.trim()).toBe("Connected");
  });

  it("defaults to 'dashboard' route", async () => {
    const el = await createElement<IcNavBar>("ic-nav-bar");
    expect(el.currentRoute).toBe("dashboard");

    const links = el.shadowRoot?.querySelectorAll(".nav-link");
    const dashboardLink = Array.from(links!).find((l) =>
      l.textContent?.trim().includes("Dashboard"),
    );
    expect(dashboardLink?.hasAttribute("data-active")).toBe(true);
  });
});
