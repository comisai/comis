import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcCommandPalette } from "./ic-command-palette.js";

// Import side-effect to register custom element
import "./ic-command-palette.js";

// Register ic-icon stub to avoid missing element warnings
if (!customElements.get("ic-icon")) {
  customElements.define(
    "ic-icon",
    class extends HTMLElement {
      static get observedAttributes() { return ["name", "size", "color"]; }
    },
  );
}

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

describe("IcCommandPalette", () => {
  it("renders when open=true", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const backdrop = el.shadowRoot?.querySelector(".backdrop");
    expect(backdrop).toBeTruthy();
  });

  it("does not render when open=false", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: false,
    });
    const backdrop = el.shadowRoot?.querySelector(".backdrop");
    expect(backdrop).toBeNull();
  });

  it("has role=combobox on the search input", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const input = el.shadowRoot?.querySelector('[role="combobox"]');
    expect(input).toBeTruthy();
  });

  it("has role=listbox on the results container", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });
    const listbox = el.shadowRoot?.querySelector('[role="listbox"]');
    expect(listbox).toBeTruthy();
  });

  it("filters results based on input", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    // Type in search
    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    if (input) {
      input.value = "Dashboard";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await (el as any).updateComplete;

    const options = el.shadowRoot?.querySelectorAll('[role="option"]');
    // Should have at least the Dashboard result
    expect(options?.length).toBeGreaterThan(0);
    const labels = Array.from(options!).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Dashboard"))).toBe(true);
  });

  it("arrow keys change activeIndex", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");

    // Press ArrowDown
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await (el as any).updateComplete;

    // Check that first result is selected
    const firstOption = el.shadowRoot?.querySelector("#result-0");
    expect(firstOption?.getAttribute("aria-selected")).toBe("true");
  });

  it("Enter dispatches navigate event for view items", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    const handler = vi.fn();
    el.addEventListener("navigate", handler);

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");

    // Move to first result
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await (el as any).updateComplete;

    // Press Enter
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalled();
  });

  it("Escape dispatches close event", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
    });

    const handler = vi.fn();
    el.addEventListener("close", handler);

    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalled();
  });

  it("shows agent items when agents are provided", async () => {
    const el = await createElement<IcCommandPalette>("ic-command-palette", {
      open: true,
      agents: [{ id: "test-agent", name: "Test Agent" }],
    });

    // Search for the agent
    const input = el.shadowRoot?.querySelector<HTMLInputElement>(".search-input");
    if (input) {
      input.value = "Test Agent";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await (el as any).updateComplete;

    const options = el.shadowRoot?.querySelectorAll('[role="option"]');
    const labels = Array.from(options!).map((o) => o.textContent);
    expect(labels.some((l) => l?.includes("Test Agent"))).toBe(true);
  });
});
