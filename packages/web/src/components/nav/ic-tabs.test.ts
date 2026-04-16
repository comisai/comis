import { describe, it, expect, afterEach, vi } from "vitest";
import { IcTabs } from "./ic-tabs.js";

// Import side-effect to register custom element
import "./ic-tabs.js";

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

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "logs", label: "Logs" },
  { id: "config", label: "Config" },
];

describe("IcTabs", () => {
  it("renders tab buttons from tabs array", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });
    const buttons = el.shadowRoot?.querySelectorAll("[role='tab']");
    expect(buttons?.length).toBe(3);
  });

  it("active tab has aria-selected='true'", async () => {
    const el = await createElement<IcTabs>("ic-tabs", {
      tabs: TABS,
      activeTab: "logs",
    });
    const logTab = el.shadowRoot?.querySelector("#tab-logs");
    expect(logTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("inactive tabs have aria-selected='false'", async () => {
    const el = await createElement<IcTabs>("ic-tabs", {
      tabs: TABS,
      activeTab: "logs",
    });
    const overviewTab = el.shadowRoot?.querySelector("#tab-overview");
    const configTab = el.shadowRoot?.querySelector("#tab-config");
    expect(overviewTab?.getAttribute("aria-selected")).toBe("false");
    expect(configTab?.getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a tab dispatches 'tab-change' event with tab id", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });
    const handler = vi.fn();
    el.addEventListener("tab-change", handler);

    const logsTab = el.shadowRoot?.querySelector("#tab-logs") as HTMLElement;
    logsTab?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("logs");
  });

  it("clicking a tab changes activeTab", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });

    const logsTab = el.shadowRoot?.querySelector("#tab-logs") as HTMLElement;
    logsTab?.click();
    await el.updateComplete;

    expect(el.activeTab).toBe("logs");
    expect(logsTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("default activeTab is first tab's id", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });
    expect(el.activeTab).toBe("overview");
  });

  it("tab bar has role='tablist'", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });
    const tablist = el.shadowRoot?.querySelector("[role='tablist']");
    expect(tablist).toBeTruthy();
  });

  it("each tab button has role='tab'", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });
    const tabs = el.shadowRoot?.querySelectorAll("[role='tab']");
    expect(tabs?.length).toBe(3);
    tabs?.forEach((tab) => {
      expect(tab.getAttribute("role")).toBe("tab");
    });
  });

  it("tab panels have role='tabpanel'", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });
    const panels = el.shadowRoot?.querySelectorAll("[role='tabpanel']");
    expect(panels?.length).toBe(3);
  });

  it("active panel is visible, others are hidden", async () => {
    const el = await createElement<IcTabs>("ic-tabs", {
      tabs: TABS,
      activeTab: "logs",
    });
    const panels = el.shadowRoot?.querySelectorAll("[role='tabpanel']");

    const overviewPanel = el.shadowRoot?.querySelector("#panel-overview");
    const logsPanel = el.shadowRoot?.querySelector("#panel-logs");
    const configPanel = el.shadowRoot?.querySelector("#panel-config");

    expect(overviewPanel?.hasAttribute("hidden")).toBe(true);
    expect(logsPanel?.hasAttribute("hidden")).toBe(false);
    expect(configPanel?.hasAttribute("hidden")).toBe(true);
  });

  it("badge renders when tab has badge > 0", async () => {
    const tabsWithBadge = [
      { id: "overview", label: "Overview", badge: 5 },
      { id: "logs", label: "Logs" },
    ];
    const el = await createElement<IcTabs>("ic-tabs", { tabs: tabsWithBadge });
    const badge = el.shadowRoot?.querySelector(".badge");
    expect(badge).toBeTruthy();
    expect(badge?.textContent?.trim()).toBe("5");
  });

  it("badge hidden when badge is 0 or undefined", async () => {
    const tabsNoBadge = [
      { id: "overview", label: "Overview", badge: 0 },
      { id: "logs", label: "Logs" },
    ];
    const el = await createElement<IcTabs>("ic-tabs", { tabs: tabsNoBadge });
    const badges = el.shadowRoot?.querySelectorAll(".badge");
    expect(badges?.length).toBe(0);
  });

  it("left arrow key moves focus to previous tab", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });

    const logsTab = el.shadowRoot?.querySelector("#tab-logs") as HTMLElement;
    logsTab.focus();

    logsTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await el.updateComplete;

    expect(el.activeTab).toBe("overview");
  });

  it("right arrow key moves focus to next tab", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });

    const overviewTab = el.shadowRoot?.querySelector("#tab-overview") as HTMLElement;
    overviewTab.focus();

    overviewTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await el.updateComplete;

    expect(el.activeTab).toBe("logs");
  });

  it("Home key moves focus to first tab", async () => {
    const el = await createElement<IcTabs>("ic-tabs", {
      tabs: TABS,
      activeTab: "config",
    });

    const configTab = el.shadowRoot?.querySelector("#tab-config") as HTMLElement;
    configTab.focus();

    configTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await el.updateComplete;

    expect(el.activeTab).toBe("overview");
  });

  it("End key moves focus to last tab", async () => {
    const el = await createElement<IcTabs>("ic-tabs", { tabs: TABS });

    const overviewTab = el.shadowRoot?.querySelector("#tab-overview") as HTMLElement;
    overviewTab.focus();

    overviewTab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await el.updateComplete;

    expect(el.activeTab).toBe("config");
  });
});
