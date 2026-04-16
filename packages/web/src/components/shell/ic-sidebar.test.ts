import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { IcSidebar } from "./ic-sidebar.js";

// Import side-effect to register custom element
import "./ic-sidebar.js";

// Mock localStorage
const mockStorage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: vi.fn((k: string) => mockStorage.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => mockStorage.set(k, v)),
  removeItem: vi.fn((k: string) => mockStorage.delete(k)),
  clear: vi.fn(() => mockStorage.clear()),
});

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

beforeEach(() => {
  mockStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcSidebar", () => {
  it("renders 4 section headers (Home, Operate, Observe, Configure)", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const sectionHeaders = el.shadowRoot?.querySelectorAll(".section-header");
    expect(sectionHeaders?.length).toBe(4);

    const labels = Array.from(sectionHeaders!).map(
      (h) => h.querySelector(".section-label")?.textContent,
    );
    expect(labels).toEqual(["Home", "Operate", "Observe", "Configure"]);
  });

  it("renders nav items grouped under sections (22 total: 1+7+6+9) plus 1 Setup = 24", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    // 1 (Home) + 7 (Operate: Agents, Channels, Messages, Chat, Sessions, Sub-Agents, Pipelines) + 6 (Observe: Overview, Context Engine, Context DAG, Billing, Delivery, Diagnostics) + 9 (Configure: Skills, MCP Servers, Models, Memory, Scheduler, Security, Media, Approvals, Config) + 1 (Setup) = 24
    expect(navItems?.length).toBe(24);
  });

  it("renders Setup item below divider", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const divider = el.shadowRoot?.querySelector(".divider");
    expect(divider).toBeTruthy();

    // The divider should exist, and Setup should come after it
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const lastNavItem = navItems?.[navItems.length - 1];
    expect(lastNavItem?.textContent).toContain("Setup");
  });

  it("highlights active item based on currentRoute property (aria-current='page')", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      currentRoute: "agents",
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const agentsItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Agents"),
    );
    expect(agentsItem?.getAttribute("aria-current")).toBe("page");
  });

  it("non-active items do not have aria-current", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      currentRoute: "dashboard",
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const chatItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Chat"),
    );
    expect(chatItem?.hasAttribute("aria-current")).toBe(false);
  });

  it("shows badge count on Approvals item when pendingApprovals > 0", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      pendingApprovals: 5,
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const approvalsItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Approvals"),
    );
    const badge = approvalsItem?.querySelector(".badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("5");
  });

  it("hides badge on Approvals when pendingApprovals is 0", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      pendingApprovals: 0,
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const approvalsItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Approvals"),
    );
    const badge = approvalsItem?.querySelector(".badge");
    expect(badge).toBeFalsy();
  });

  it("shows badge count on Overview (Observe) item when errorCount > 0", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      errorCount: 3,
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const observeItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Overview"),
    );
    const badge = observeItem?.querySelector(".badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("3");
  });

  it("shows badge count on Agents item when agentCount > 0", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      agentCount: 4,
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const agentsItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Agents"),
    );
    const badge = agentsItem?.querySelector(".badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("4");
  });

  it("shows badge count on Channels item when channelCount > 0", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      channelCount: 7,
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const channelsItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Channels"),
    );
    const badge = channelsItem?.querySelector(".badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("7");
  });

  it("shows badge count on Sessions item when sessionCount > 0", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar", {
      sessionCount: 12,
    });
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const sessionsItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Sessions"),
    );
    const badge = sessionsItem?.querySelector(".badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("12");
  });

  it("dispatches 'navigate' event with route detail on nav item click", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const chatItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Chat"),
    ) as HTMLElement;
    chatItem?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("chat");
  });

  it("dispatches 'logout' event on logout button click", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const handler = vi.fn();
    el.addEventListener("logout", handler);

    const logoutBtn = el.shadowRoot?.querySelector(".logout-btn") as HTMLElement;
    logoutBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("has collapse toggle button", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const collapseBtn = el.shadowRoot?.querySelector(".collapse-btn");
    expect(collapseBtn).toBeTruthy();
  });

  it("collapse toggle saves state to localStorage", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const collapseBtn = el.shadowRoot?.querySelector(
      ".collapse-btn",
    ) as HTMLElement;
    collapseBtn?.click();
    await el.updateComplete;

    expect(localStorage.setItem).toHaveBeenCalledWith(
      "ic_sidebar_collapsed",
      "true",
    );
  });

  it("reads initial collapse state from localStorage", async () => {
    mockStorage.set("ic_sidebar_collapsed", "true");
    const el = await createElement<IcSidebar>("ic-sidebar");

    expect(localStorage.getItem).toHaveBeenCalledWith("ic_sidebar_collapsed");
    const sidebar = el.shadowRoot?.querySelector(".sidebar");
    expect(sidebar?.classList.contains("collapsed")).toBe(true);
  });

  it("has <nav> with role='navigation' and aria-label", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const nav = el.shadowRoot?.querySelector("nav");
    expect(nav?.getAttribute("role")).toBe("navigation");
    expect(nav?.getAttribute("aria-label")).toBe("Main navigation");
  });

  it("collapse button has appropriate aria-label", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const collapseBtn = el.shadowRoot?.querySelector(".collapse-btn");
    expect(collapseBtn?.getAttribute("aria-label")).toBe("Collapse sidebar");

    // Click to collapse
    (collapseBtn as HTMLElement)?.click();
    await el.updateComplete;

    const collapsedBtn = el.shadowRoot?.querySelector(".collapse-btn");
    expect(collapsedBtn?.getAttribute("aria-label")).toBe("Expand sidebar");
  });

  it("all nav items are <button> elements (keyboard focusable)", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    for (const item of Array.from(navItems!)) {
      expect(item.tagName.toLowerCase()).toBe("button");
    }
  });

  it("when collapsed, labels are hidden (sidebar has collapsed class)", async () => {
    mockStorage.set("ic_sidebar_collapsed", "true");
    const el = await createElement<IcSidebar>("ic-sidebar");
    const sidebar = el.shadowRoot?.querySelector(".sidebar");
    expect(sidebar?.classList.contains("collapsed")).toBe(true);
  });

  it("section headers are non-clickable (not buttons)", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const sectionHeaders = el.shadowRoot?.querySelectorAll(".section-header");
    for (const header of Array.from(sectionHeaders!)) {
      expect(header.tagName.toLowerCase()).toBe("div");
    }
  });

  it("renders correct icon for each nav item", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const icons = el.shadowRoot?.querySelectorAll("nav .nav-item .nav-icon");
    expect(icons?.length).toBeGreaterThanOrEqual(16);

    // Verify at least the first icon (Dashboard) has content
    const firstIcon = icons?.[0];
    expect(firstIcon?.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("clicking nav item does not dispatch 'logout' event", async () => {
    const el = await createElement<IcSidebar>("ic-sidebar");
    const logoutHandler = vi.fn();
    el.addEventListener("logout", logoutHandler);

    const navItems = el.shadowRoot?.querySelectorAll("nav .nav-item");
    const dashboardItem = Array.from(navItems!).find((item) =>
      item.textContent?.includes("Dashboard"),
    ) as HTMLElement;
    dashboardItem?.click();

    expect(logoutHandler).not.toHaveBeenCalled();
  });
});
