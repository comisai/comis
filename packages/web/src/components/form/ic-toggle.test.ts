// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcToggle } from "./ic-toggle.js";

// Side-effect import to register custom element
import "./ic-toggle.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcToggle> {
  const el = document.createElement("ic-toggle") as IcToggle;
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

describe("IcToggle", () => {
  it("renders label text", async () => {
    const el = await createElement({ label: "Enable feature" });
    const label = el.shadowRoot?.querySelector(".toggle-label");
    expect(label).toBeTruthy();
    expect(label!.textContent).toContain("Enable feature");
  });

  it("checked state shows data-checked attribute on track", async () => {
    const el = await createElement({ checked: true });
    const track = el.shadowRoot?.querySelector(".track");
    expect(track?.hasAttribute("data-checked")).toBe(true);
  });

  it("unchecked state does not show data-checked", async () => {
    const el = await createElement({ checked: false });
    const track = el.shadowRoot?.querySelector(".track");
    expect(track?.hasAttribute("data-checked")).toBe(false);
  });

  it("click toggles and dispatches change event", async () => {
    const el = await createElement({ checked: false });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const track = el.shadowRoot?.querySelector(".track") as HTMLElement;
    track.click();
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(true);
    expect(el.checked).toBe(true);
  });

  it("keyboard Space toggles", async () => {
    const el = await createElement({ checked: false });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const track = el.shadowRoot?.querySelector(".track") as HTMLElement;
    track.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(true);
  });

  it("disabled prevents toggle", async () => {
    const el = await createElement({ checked: false, disabled: true });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const track = el.shadowRoot?.querySelector(".track") as HTMLElement;
    track.click();
    await (el as any).updateComplete;

    expect(handler).not.toHaveBeenCalled();
    expect(el.checked).toBe(false);
  });

  it("has ARIA role=switch and aria-checked reflects state", async () => {
    const el = await createElement({ checked: true });
    const track = el.shadowRoot?.querySelector(".track") as HTMLElement;
    expect(track.getAttribute("role")).toBe("switch");
    expect(track.getAttribute("aria-checked")).toBe("true");

    el.checked = false;
    await (el as any).updateComplete;
    expect(track.getAttribute("aria-checked")).toBe("false");
  });

  it("change event detail is boolean", async () => {
    const el = await createElement({ checked: true });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const track = el.shadowRoot?.querySelector(".track") as HTMLElement;
    track.click();
    await (el as any).updateComplete;

    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(typeof detail).toBe("boolean");
    expect(detail).toBe(false);
  });
});
