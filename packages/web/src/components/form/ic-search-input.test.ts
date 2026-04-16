import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { IcSearchInput } from "./ic-search-input.js";

// Import side-effect to register custom element
import "./ic-search-input.js";

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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("IcSearchInput", () => {
  it("renders an input element with searchbox role", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input");
    const input = el.shadowRoot?.querySelector("input");
    expect(input).toBeTruthy();
    expect(input?.getAttribute("role")).toBe("searchbox");
  });

  it("placeholder text is configurable", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      placeholder: "Filter agents...",
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.getAttribute("placeholder")).toBe("Filter agents...");
  });

  it("dispatches 'search' event after debounce delay (300ms default)", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input");
    const handler = vi.fn();
    el.addEventListener("search", handler);

    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    // Simulate typing
    input.value = "test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    // Not fired yet
    expect(handler).not.toHaveBeenCalled();

    // Advance past debounce
    vi.advanceTimersByTime(300);

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("test");
  });

  it("debounce resets on new input (no duplicate events)", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input");
    const handler = vi.fn();
    el.addEventListener("search", handler);

    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;

    // Type first character
    input.value = "a";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    vi.advanceTimersByTime(200);

    // Type second character before debounce fires
    input.value = "ab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    vi.advanceTimersByTime(200);

    // Should not have fired yet (200ms since last input)
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    // Now 300ms since last input - should fire once
    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("ab");
  });

  it("clear button appears when value is non-empty", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      value: "something",
    });
    const clearBtn = el.shadowRoot?.querySelector(".clear-btn") as HTMLElement;
    expect(clearBtn).toBeTruthy();
    expect(clearBtn.hidden).toBe(false);
  });

  it("clear button is hidden when value is empty", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      value: "",
    });
    const clearBtn = el.shadowRoot?.querySelector(".clear-btn") as HTMLElement;
    expect(clearBtn?.hidden).toBe(true);
  });

  it("clear button dispatches 'search' with empty string immediately", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      value: "something",
    });
    const handler = vi.fn();
    el.addEventListener("search", handler);

    const clearBtn = el.shadowRoot?.querySelector(".clear-btn") as HTMLElement;
    clearBtn.click();

    // Should fire immediately - no debounce
    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("");
  });

  it("Enter key dispatches 'search' immediately (no debounce)", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input");
    const handler = vi.fn();
    el.addEventListener("search", handler);

    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    input.value = "quick search";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    // Press Enter before debounce fires
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("quick search");
  });

  it("custom debounce delay is respected", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      debounce: 500,
    });
    const handler = vi.fn();
    el.addEventListener("search", handler);

    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    input.value = "slow";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await el.updateComplete;

    vi.advanceTimersByTime(300);
    expect(handler).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("input has aria-label='Search'", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input");
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.getAttribute("aria-label")).toBe("Search");
  });

  it("clear button has aria-label='Clear search'", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      value: "test",
    });
    const clearBtn = el.shadowRoot?.querySelector(".clear-btn");
    expect(clearBtn?.getAttribute("aria-label")).toBe("Clear search");
  });

  it("disabled state prevents input", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input", {
      disabled: true,
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.disabled).toBe(true);
  });

  it("search icon is visible", async () => {
    const el = await createElement<IcSearchInput>("ic-search-input");
    const icon = el.shadowRoot?.querySelector(".search-icon");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });
});
