// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcSecretInput } from "./ic-secret-input.js";

// Side-effect import to register custom element
import "./ic-secret-input.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSecretInput> {
  const el = document.createElement("ic-secret-input") as IcSecretInput;
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

describe("IcSecretInput", () => {
  it("renders the label text inside the IcSecretInput shadow-DOM label element", async () => {
    const el = await createElement({ label: "API Key" });
    const label = el.shadowRoot?.querySelector("label");
    expect(label).toBeTruthy();
    expect(label!.textContent).toContain("API Key");
  });

  it("input type is password by default", async () => {
    const el = await createElement({});
    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("toggle button reveals and hides value", async () => {
    const el = await createElement({});
    const toggleBtn = el.shadowRoot?.querySelector(".toggle-btn") as HTMLElement;
    let input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");

    toggleBtn.click();
    await (el as any).updateComplete;
    input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("text");

    toggleBtn.click();
    await (el as any).updateComplete;
    input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.type).toBe("password");
  });

  it("dispatches change event on input", async () => {
    const el = await createElement({});
    const handler = vi.fn();
    el.addEventListener("change", handler);

    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    input.value = "env:MY_SECRET";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe("env:MY_SECRET");
  });

  it("shows SecretRef format hint text (default mode — encrypted/file)", async () => {
    const el = await createElement({});  // default storageMode="encrypted"
    const hint = el.shadowRoot?.querySelector(".hint");
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain("env:VAR_NAME");
    expect(hint!.textContent).toContain("file:/path");
  });

  it("env storageMode shows env: and file: hint with env-mode framing (file: refs work in all modes)", async () => {
    const el = await createElement({ storageMode: "env" });
    const hint = el.shadowRoot?.querySelector(".hint");
    // env: refs are always shown
    expect(hint!.textContent).toContain("env:VAR_NAME");
    // file: refs work in all modes including env (resolveFileRef reads from disk,
    // independent of the credential storage backend) — the hint must show file: too
    expect(hint!.textContent).toContain("file:/path/to/secret");
    // explanatory suffix explains what env mode means (no writable store)
    expect(hint!.textContent).toContain("env mode");
    // must NOT falsely claim file: refs are unavailable — they resolve in every storage mode
    expect(hint!.textContent).not.toContain("file: refs not available");
  });

  it("file storageMode shows both env: and file: hint framing", async () => {
    const el = await createElement({ storageMode: "file" });
    const hint = el.shadowRoot?.querySelector(".hint");
    expect(hint!.textContent).toContain("env:VAR_NAME");
    expect(hint!.textContent).toContain("file:/path");
  });

  it("placeholder text shown", async () => {
    const el = await createElement({ placeholder: "Custom placeholder" });
    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.placeholder).toBe("Custom placeholder");
  });

  it("propagates disabled state to the underlying input element when disabled prop is true", async () => {
    const el = await createElement({ disabled: true });
    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("value property reflects in input", async () => {
    const el = await createElement({ value: "env:TEST_KEY" });
    const input = el.shadowRoot?.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("env:TEST_KEY");
  });
});
