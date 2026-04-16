import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcArrayEditor } from "./ic-array-editor.js";

// Side-effect import to register custom element
import "./ic-array-editor.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcArrayEditor> {
  const el = document.createElement("ic-array-editor") as IcArrayEditor;
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

describe("IcArrayEditor", () => {
  it("renders label", async () => {
    const el = await createElement({ label: "Origins" });
    const label = el.shadowRoot?.querySelector(".editor-label");
    expect(label).toBeTruthy();
    expect(label!.textContent).toContain("Origins");
  });

  it("displays existing items", async () => {
    const el = await createElement({ items: ["http://localhost", "https://example.com"] });
    const items = el.shadowRoot?.querySelectorAll(".item-text");
    expect(items?.length).toBe(2);
    expect(items![0].textContent).toContain("http://localhost");
    expect(items![1].textContent).toContain("https://example.com");
  });

  it("each item has remove button", async () => {
    const el = await createElement({ items: ["a", "b", "c"] });
    const removeBtns = el.shadowRoot?.querySelectorAll(".remove-btn");
    expect(removeBtns?.length).toBe(3);
  });

  it("remove dispatches change without removed item", async () => {
    const el = await createElement({ items: ["a", "b", "c"] });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const removeBtns = el.shadowRoot?.querySelectorAll(".remove-btn");
    (removeBtns![1] as HTMLElement).click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual(["a", "c"]);
  });

  it("add input and button are present", async () => {
    const el = await createElement({});
    const input = el.shadowRoot?.querySelector(".add-input");
    const btn = el.shadowRoot?.querySelector(".add-btn");
    expect(input).toBeTruthy();
    expect(btn).toBeTruthy();
  });

  it("add button dispatches change with new item appended", async () => {
    const el = await createElement({ items: ["existing"] });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    // Set the internal input value
    const input = el.shadowRoot?.querySelector(".add-input") as HTMLInputElement;
    input.value = "new-item";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await (el as any).updateComplete;

    const addBtn = el.shadowRoot?.querySelector(".add-btn") as HTMLElement;
    addBtn.click();

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual(["existing", "new-item"]);
  });

  it("Enter key in input adds item", async () => {
    const el = await createElement({ items: [] });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const input = el.shadowRoot?.querySelector(".add-input") as HTMLInputElement;
    input.value = "enter-item";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await (el as any).updateComplete;

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toEqual(["enter-item"]);
  });

  it("empty input does not add", async () => {
    const el = await createElement({ items: ["a"] });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const addBtn = el.shadowRoot?.querySelector(".add-btn") as HTMLElement;
    addBtn.click();

    expect(handler).not.toHaveBeenCalled();
  });

  it("placeholder text shown", async () => {
    const el = await createElement({ placeholder: "Add origin..." });
    const input = el.shadowRoot?.querySelector(".add-input") as HTMLInputElement;
    expect(input.placeholder).toBe("Add origin...");
  });

  it("change event detail is string[]", async () => {
    const el = await createElement({ items: ["x"] });
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const removeBtns = el.shadowRoot?.querySelectorAll(".remove-btn");
    (removeBtns![0] as HTMLElement).click();

    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(Array.isArray(detail)).toBe(true);
  });
});
