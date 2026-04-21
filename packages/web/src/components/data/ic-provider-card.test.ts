// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcProviderCard } from "./ic-provider-card.js";

// Side-effect registration
import "./ic-provider-card.js";

/** Helper to create and mount a provider card element. */
async function createElement(
  props?: Record<string, unknown>,
): Promise<IcProviderCard> {
  const el = document.createElement("ic-provider-card") as IcProviderCard;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcProviderCard", () => {
  it("renders provider name and type", async () => {
    const el = await createElement({ name: "Anthropic", type: "anthropic" });

    const name = el.shadowRoot?.querySelector(".name");
    expect(name).not.toBeNull();
    expect(name?.textContent?.trim()).toBe("Anthropic");

    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag).not.toBeNull();
    expect(tag?.textContent?.trim()).toBe("anthropic");
  });

  it("renders base URL or Default when empty", async () => {
    // With a URL
    const el = await createElement({ name: "test", type: "openai", baseUrl: "https://api.openai.com" });
    const urlRow = el.shadowRoot?.querySelector(".url-row");
    expect(urlRow?.textContent?.trim()).toBe("https://api.openai.com");

    // Without a URL -- shows "Default"
    el.baseUrl = "";
    await el.updateComplete;
    expect(urlRow?.textContent?.trim()).toBe("Default");
  });

  it("renders enabled status via connection dot", async () => {
    const el = await createElement({ name: "test", type: "test", enabled: true });

    const dot = el.shadowRoot?.querySelector("ic-connection-dot");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("status")).toBe("connected");

    // Change to disabled
    el.enabled = false;
    await el.updateComplete;
    expect(dot?.getAttribute("status")).toBe("disconnected");
  });

  it("fires test-connection event on test button click", async () => {
    const el = await createElement({ name: "test", type: "test" });
    const handler = vi.fn();
    el.addEventListener("test-connection", handler);

    const testBtn = el.shadowRoot?.querySelector(".btn-test") as HTMLButtonElement;
    expect(testBtn).not.toBeNull();
    testBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("shows loading spinner when testing=true", async () => {
    const el = await createElement({ name: "test", type: "test", testing: true });

    const spinner = el.shadowRoot?.querySelector(".spinner-inline");
    expect(spinner).not.toBeNull();

    const testBtn = el.shadowRoot?.querySelector(".btn-test") as HTMLButtonElement;
    expect(testBtn?.disabled).toBe(true);
  });

  it("renders test result when testResult is set", async () => {
    const el = await createElement({
      name: "test",
      type: "test",
      testResult: { status: "ok", modelsAvailable: 5, validatedModels: 3 },
    });

    const testResult = el.shadowRoot?.querySelector(".test-result");
    expect(testResult).not.toBeNull();

    const lines = testResult?.querySelectorAll(".test-result-line");
    expect(lines).not.toBeNull();
    expect(lines!.length).toBeGreaterThanOrEqual(2);

    const allText = testResult?.textContent ?? "";
    expect(allText).toContain("Connection OK");
    expect(allText).toContain("5");
    expect(allText).toContain("3");
  });

  it("fires edit-provider event on edit button click", async () => {
    const el = await createElement({ name: "test", type: "test" });
    const handler = vi.fn();
    el.addEventListener("edit-provider", handler);

    const editBtn = el.shadowRoot?.querySelector(".btn-edit") as HTMLButtonElement;
    expect(editBtn).not.toBeNull();
    editBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("fires toggle-provider event with boolean detail", async () => {
    const el = await createElement({ name: "test", type: "test", enabled: false });
    const handler = vi.fn();
    el.addEventListener("toggle-provider", handler);

    const checkbox = el.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();

    // Simulate checking
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
    expect((handler.mock.calls[0][0] as CustomEvent).detail).toBe(true);
  });

  it("hides test result when testResult is null", async () => {
    const el = await createElement({ name: "test", type: "test", testResult: null });
    const testResult = el.shadowRoot?.querySelector(".test-result");
    expect(testResult).toBeNull();
  });

  it("shows no spinner when testing=false", async () => {
    const el = await createElement({ name: "test", type: "test", testing: false });
    const spinner = el.shadowRoot?.querySelector(".spinner-inline");
    expect(spinner).toBeNull();

    const testBtn = el.shadowRoot?.querySelector(".btn-test") as HTMLButtonElement;
    expect(testBtn?.disabled).toBe(false);
    expect(testBtn?.textContent?.trim()).toBe("Test");
  });
});
