import { describe, it, expect, afterEach, vi } from "vitest";
import { IcBreadcrumb } from "./ic-breadcrumb.js";

// Import side-effect to register custom element
import "./ic-breadcrumb.js";

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

describe("IcBreadcrumb", () => {
  it("renders breadcrumb items from items array", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [
        { label: "Dashboard", route: "dashboard" },
        { label: "Agents", route: "agents" },
        { label: "Agent Alpha" },
      ],
    });
    const listItems = el.shadowRoot?.querySelectorAll("li");
    expect(listItems?.length).toBe(3);
  });

  it("last item is not clickable (no link/button)", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [
        { label: "Home", route: "home" },
        { label: "Current Page" },
      ],
    });
    const listItems = el.shadowRoot?.querySelectorAll("li");
    const lastItem = listItems![listItems!.length - 1];
    const button = lastItem.querySelector("button");
    expect(button).toBeNull();
    const span = lastItem.querySelector(".current");
    expect(span).toBeTruthy();
  });

  it("last item has aria-current='page'", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [
        { label: "Home", route: "home" },
        { label: "Settings" },
      ],
    });
    const current = el.shadowRoot?.querySelector("[aria-current='page']");
    expect(current).toBeTruthy();
    expect(current?.textContent).toContain("Settings");
  });

  it("non-last items are clickable buttons", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [
        { label: "Dashboard", route: "dashboard" },
        { label: "Agents", route: "agents" },
        { label: "Detail" },
      ],
    });
    const buttons = el.shadowRoot?.querySelectorAll(".link");
    expect(buttons?.length).toBe(2);
  });

  it("clicking a non-last item dispatches 'navigate' with route", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [
        { label: "Dashboard", route: "dashboard" },
        { label: "Agents", route: "agents" },
        { label: "Detail" },
      ],
    });
    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const firstLink = el.shadowRoot?.querySelector(".link") as HTMLElement;
    firstLink?.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("dashboard");
  });

  it("has nav element with aria-label='Breadcrumb'", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [{ label: "Home" }],
    });
    const nav = el.shadowRoot?.querySelector("nav");
    expect(nav).toBeTruthy();
    expect(nav?.getAttribute("aria-label")).toBe("Breadcrumb");
  });

  it("items are separated by separator character", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [
        { label: "A", route: "a" },
        { label: "B", route: "b" },
        { label: "C" },
      ],
    });
    const separators = el.shadowRoot?.querySelectorAll(".separator");
    // 3 items = 2 separators (between items 1-2 and 2-3)
    expect(separators?.length).toBe(2);
  });

  it("single item renders as current page", async () => {
    const el = await createElement<IcBreadcrumb>("ic-breadcrumb", {
      items: [{ label: "Only Page" }],
    });
    const current = el.shadowRoot?.querySelector("[aria-current='page']");
    expect(current).toBeTruthy();
    expect(current?.textContent).toContain("Only Page");

    const buttons = el.shadowRoot?.querySelectorAll(".link");
    expect(buttons?.length).toBe(0);
  });
});
