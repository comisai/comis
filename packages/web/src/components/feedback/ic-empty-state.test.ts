import { describe, it, expect, afterEach } from "vitest";
import { IcEmptyState } from "./ic-empty-state.js";

// Import side-effect to register custom element
import "./ic-empty-state.js";

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

describe("IcEmptyState", () => {
  it("renders message text", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state");
    const message = el.shadowRoot?.querySelector(".message");
    expect(message).toBeTruthy();
    expect(message?.textContent).toBeTruthy();
  });

  it('default message is "No items to display"', async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state");
    const message = el.shadowRoot?.querySelector(".message");
    expect(message?.textContent).toBe("No items to display");
  });

  it("custom message overrides default", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state", {
      message: "No agents found",
    });
    const message = el.shadowRoot?.querySelector(".message");
    expect(message?.textContent).toBe("No agents found");
  });

  it("renders description when provided", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state", {
      description: "Try adding a new agent.",
    });
    const desc = el.shadowRoot?.querySelector(".description");
    expect(desc).toBeTruthy();
    expect(desc?.textContent).toBe("Try adding a new agent.");
  });

  it("hides description when empty", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state");
    const desc = el.shadowRoot?.querySelector(".description");
    expect(desc).toBeFalsy();
  });

  it("renders ic-icon when icon property is set", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state", {
      icon: "search",
    });
    const iconArea = el.shadowRoot?.querySelector(".icon-area");
    expect(iconArea).toBeTruthy();
    const icon = iconArea?.querySelector("ic-icon");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("name")).toBe("search");
  });

  it("hides icon area when icon property is empty", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state");
    const iconArea = el.shadowRoot?.querySelector(".icon-area");
    expect(iconArea).toBeFalsy();
  });

  it("has slot for action content", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state");
    const slot = el.shadowRoot?.querySelector("slot");
    expect(slot).toBeTruthy();
  });

  it("content is centered", async () => {
    const el = await createElement<IcEmptyState>("ic-empty-state");
    const container = el.shadowRoot?.querySelector(".container");
    expect(container).toBeTruthy();
    // The container has display: flex, flex-direction: column, align-items: center
    // which is defined in CSS. We check the class exists.
  });
});
