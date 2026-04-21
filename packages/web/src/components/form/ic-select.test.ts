// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSelect } from "./ic-select.js";

// Side-effect import to register custom element
import "./ic-select.js";

const OPTIONS = [
  { value: "full", label: "Full" },
  { value: "minimal", label: "Minimal" },
  { value: "coding", label: "Coding" },
];

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSelect> {
  const el = document.createElement("ic-select") as IcSelect;
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

describe("IcSelect", () => {
  it("renders label text", async () => {
    const el = await createElement({ label: "Profile", options: OPTIONS });
    const label = el.shadowRoot?.querySelector("label");
    expect(label).toBeTruthy();
    expect(label!.textContent).toContain("Profile");
  });

  it("renders select element with all options", async () => {
    const el = await createElement({ options: OPTIONS });
    const select = el.shadowRoot?.querySelector("select");
    expect(select).toBeTruthy();
    const opts = el.shadowRoot?.querySelectorAll("option");
    expect(opts?.length).toBe(3);
  });

  it("selected value reflects value property", async () => {
    const el = await createElement({ options: OPTIONS, value: "coding" });
    const select = el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    // The selected option should be coding
    const selectedOpt = el.shadowRoot?.querySelector("option[selected]") as HTMLOptionElement;
    expect(selectedOpt).toBeTruthy();
    expect(selectedOpt.value).toBe("coding");
  });

  it("dispatches change event on selection", async () => {
    const el = await createElement({ options: OPTIONS, value: "full" });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const select = el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    select.value = "minimal";
    select.dispatchEvent(new Event("change"));
    await (el as any).updateComplete;

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("minimal");
  });

  it("disabled state prevents interaction", async () => {
    const el = await createElement({ options: OPTIONS, disabled: true });
    const select = el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("has ARIA label association", async () => {
    const el = await createElement({ label: "Pick one", options: OPTIONS });
    const select = el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    expect(select.getAttribute("aria-label")).toBe("Pick one");
  });

  it("renders empty select with no options", async () => {
    const el = await createElement({ options: [] });
    const opts = el.shadowRoot?.querySelectorAll("option");
    expect(opts?.length).toBe(0);
  });

  it("updates when options property changes", async () => {
    const el = await createElement({ options: OPTIONS });
    let opts = el.shadowRoot?.querySelectorAll("option");
    expect(opts?.length).toBe(3);

    el.options = [{ value: "new", label: "New Option" }];
    await (el as any).updateComplete;
    opts = el.shadowRoot?.querySelectorAll("option");
    expect(opts?.length).toBe(1);
  });
});
