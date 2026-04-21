// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcJsonEditor } from "./ic-json-editor.js";

// Side-effect import to register custom element
import "./ic-json-editor.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcJsonEditor> {
  const el = document.createElement("ic-json-editor") as IcJsonEditor;
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

describe("IcJsonEditor", () => {
  it("renders label", async () => {
    const el = await createElement({ label: "Permissions" });
    const label = el.shadowRoot?.querySelector(".editor-label");
    expect(label).toBeTruthy();
    expect(label!.textContent).toContain("Permissions");
  });

  it("displays existing key-value pairs", async () => {
    const el = await createElement({ value: { read: "allow", write: "deny" } });
    const keys = el.shadowRoot?.querySelectorAll(".pair-key");
    const values = el.shadowRoot?.querySelectorAll(".pair-value");
    expect(keys?.length).toBe(2);
    expect(values?.length).toBe(2);
    expect(keys![0].textContent).toContain("read");
    expect(values![0].textContent).toContain("allow");
  });

  it("each pair has remove button", async () => {
    const el = await createElement({ value: { a: "1", b: "2" } });
    const removeBtns = el.shadowRoot?.querySelectorAll(".remove-btn");
    expect(removeBtns?.length).toBe(2);
  });

  it("remove dispatches change without removed pair", async () => {
    const el = await createElement({ value: { a: "1", b: "2" } });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const removeBtns = el.shadowRoot?.querySelectorAll(".remove-btn");
    (removeBtns![0] as HTMLElement).click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail as Record<string, string>;
    expect(detail).toEqual({ b: "2" });
  });

  it("add row has key input, value input, and add button", async () => {
    const el = await createElement({});
    const addInputs = el.shadowRoot?.querySelectorAll(".add-input");
    const addBtn = el.shadowRoot?.querySelector(".add-btn");
    expect(addInputs?.length).toBe(2);
    expect(addBtn).toBeTruthy();
  });

  it("add dispatches change with new pair", async () => {
    const el = await createElement({ value: { existing: "val" } });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const addInputs = el.shadowRoot?.querySelectorAll(".add-input") as NodeListOf<HTMLInputElement>;
    // Set key
    addInputs[0].value = "newKey";
    addInputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    // Set value
    addInputs[1].value = "newVal";
    addInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    await (el as any).updateComplete;

    const addBtn = el.shadowRoot?.querySelector(".add-btn") as HTMLElement;
    addBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual({
      existing: "val",
      newKey: "newVal",
    });
  });

  it("empty key prevents add and shows error", async () => {
    const el = await createElement({ value: {} });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const addBtn = el.shadowRoot?.querySelector(".add-btn") as HTMLElement;
    addBtn.click();
    await (el as any).updateComplete;

    expect(handler).not.toHaveBeenCalled();
    const error = el.shadowRoot?.querySelector(".error-text");
    expect(error).toBeTruthy();
    expect(error!.textContent).toContain("empty");
  });

  it("duplicate key shows error", async () => {
    const el = await createElement({ value: { dup: "val" } });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const addInputs = el.shadowRoot?.querySelectorAll(".add-input") as NodeListOf<HTMLInputElement>;
    addInputs[0].value = "dup";
    addInputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    addInputs[1].value = "other";
    addInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    await (el as any).updateComplete;

    const addBtn = el.shadowRoot?.querySelector(".add-btn") as HTMLElement;
    addBtn.click();
    await (el as any).updateComplete;

    expect(handler).not.toHaveBeenCalled();
    const error = el.shadowRoot?.querySelector(".error-text");
    expect(error).toBeTruthy();
    expect(error!.textContent).toContain("already exists");
  });

  it("change event detail is Record<string, string>", async () => {
    const el = await createElement({ value: { x: "1" } });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const removeBtns = el.shadowRoot?.querySelectorAll(".remove-btn");
    (removeBtns![0] as HTMLElement).click();

    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(typeof detail).toBe("object");
    expect(detail).toEqual({});
  });

  it("renders empty state with no initial value", async () => {
    const el = await createElement({ value: {} });
    const pairs = el.shadowRoot?.querySelectorAll(".pair-row");
    expect(pairs?.length).toBe(0);
  });
});
