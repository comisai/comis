import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcFormField } from "./ic-form-field.js";

// Import side-effect to register custom element
import "./ic-form-field.js";

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

describe("IcFormField", () => {
  it("renders label text", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Email Address",
    });
    const label = el.shadowRoot?.querySelector("label");
    expect(label?.textContent).toContain("Email Address");
  });

  it("renders input element with correct type", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Email",
      type: "email",
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input).toBeTruthy();
    expect(input?.type).toBe("email");
  });

  it("renders placeholder text", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Name",
      placeholder: "Enter your name",
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.placeholder).toBe("Enter your name");
  });

  it("value property sets input value", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Name",
      value: "Alice",
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.value).toBe("Alice");
  });

  it("typing in input dispatches field-change event with new value", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Name",
    });
    const handler = vi.fn();
    el.addEventListener("field-change", handler);

    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    input.value = "Bob";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("Bob");
  });

  it("error message hidden when error is empty", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Name",
      error: "",
    });
    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeNull();
  });

  it("error message shown when error is non-empty", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Email",
      error: "Invalid email format",
    });
    const errorMsg = el.shadowRoot?.querySelector(".error-message");
    expect(errorMsg).toBeTruthy();
    expect(errorMsg?.textContent?.trim()).toBe("Invalid email format");
  });

  it("input has aria-invalid=true when error is present", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Email",
      error: "Required",
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
  });

  it("required field shows asterisk indicator", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Name",
      required: true,
    });
    const asterisk = el.shadowRoot?.querySelector(".required-indicator");
    expect(asterisk).toBeTruthy();
    expect(asterisk?.textContent).toContain("*");
  });

  it("disabled state disables the input", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Name",
      disabled: true,
    });
    const input = el.shadowRoot?.querySelector("input");
    expect(input?.disabled).toBe(true);
  });

  it("select type renders a select element with options", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Type",
      type: "select",
      options: [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
      ],
    });
    const select = el.shadowRoot?.querySelector("select");
    expect(select).toBeTruthy();

    const options = el.shadowRoot?.querySelectorAll("option");
    expect(options?.length).toBe(2);
    expect(options![0].textContent?.trim()).toBe("Option A");
    expect(options![1].textContent?.trim()).toBe("Option B");
  });

  it("changing select dispatches field-change event", async () => {
    const el = await createElement<IcFormField>("ic-form-field", {
      label: "Type",
      type: "select",
      options: [
        { value: "a", label: "Option A" },
        { value: "b", label: "Option B" },
      ],
    });
    const handler = vi.fn();
    el.addEventListener("field-change", handler);

    const select = el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("b");
  });
});
