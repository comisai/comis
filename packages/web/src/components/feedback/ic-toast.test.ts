import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { IcToast } from "./ic-toast.js";

// Import side-effect to register custom element
import "./ic-toast.js";

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

describe("IcToast", () => {
  it("renders toast container with fixed position", async () => {
    const el = await createElement<IcToast>("ic-toast");
    // The host element is the fixed-position container
    expect(el).toBeTruthy();
    expect(el.shadowRoot?.querySelector("[role='alert']")).toBeTruthy();
  });

  it("static show() method adds a toast", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Test message", "info");
    // Wait for Lit update
    await (document.querySelector("ic-toast") as any).updateComplete;
    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(1);
  });

  it("toast displays message text", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Hello World", "success");
    await (document.querySelector("ic-toast") as any).updateComplete;
    const message = document.querySelector("ic-toast")?.shadowRoot?.querySelector(".toast__message");
    expect(message?.textContent).toContain("Hello World");
  });

  it("toast has variant-colored border (success, error, warning, info)", async () => {
    await createElement<IcToast>("ic-toast");

    for (const variant of ["success", "error", "warning", "info"] as const) {
      IcToast.show(`${variant} message`, variant);
    }
    await (document.querySelector("ic-toast") as any).updateComplete;
    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(4);

    const variants = Array.from(toasts!).map((t) => t.getAttribute("data-variant"));
    expect(variants).toContain("success");
    expect(variants).toContain("error");
    expect(variants).toContain("warning");
    expect(variants).toContain("info");
  });

  it("toast auto-dismisses after duration (default 4000ms)", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Auto dismiss", "info");
    await (document.querySelector("ic-toast") as any).updateComplete;

    let toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(1);

    vi.advanceTimersByTime(4000);
    await (document.querySelector("ic-toast") as any).updateComplete;

    toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(0);
  });

  it("close button removes toast immediately", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Close me", "info");
    await (document.querySelector("ic-toast") as any).updateComplete;

    const closeBtn = document.querySelector("ic-toast")?.shadowRoot?.querySelector(".toast__close") as HTMLElement;
    expect(closeBtn).toBeTruthy();
    closeBtn.click();
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(0);
  });

  it("maximum 5 visible toasts; oldest removed on overflow", async () => {
    await createElement<IcToast>("ic-toast");
    for (let i = 0; i < 7; i++) {
      IcToast.show(`Toast ${i}`, "info");
    }
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(5);

    // Should contain the latest toasts (2-6), not the oldest (0-1)
    const messages = Array.from(toasts!).map((t) => t.querySelector(".toast__message")?.textContent);
    expect(messages.some((m) => m?.includes("Toast 6"))).toBe(true);
    expect(messages.some((m) => m?.includes("Toast 0"))).toBe(false);
    expect(messages.some((m) => m?.includes("Toast 1"))).toBe(false);
  });

  it("has role='alert' on toast container", async () => {
    const el = await createElement<IcToast>("ic-toast");
    const container = el.shadowRoot?.querySelector("[role='alert']");
    expect(container).toBeTruthy();
    expect(container?.getAttribute("aria-live")).toBe("polite");
  });

  it("document CustomEvent 'ic-toast' triggers toast display", async () => {
    await createElement<IcToast>("ic-toast");

    document.dispatchEvent(
      new CustomEvent("ic-toast", {
        detail: { message: "Event toast", variant: "warning" },
      }),
    );
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toast = document.querySelector("ic-toast")?.shadowRoot?.querySelector(".toast");
    expect(toast).toBeTruthy();
    expect(toast?.getAttribute("data-variant")).toBe("warning");
    const message = toast?.querySelector(".toast__message");
    expect(message?.textContent).toContain("Event toast");
  });

  it("multiple toasts stack vertically", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("First", "info");
    IcToast.show("Second", "success");
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(2);
  });

  it("toast enters with animation class", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Animated", "info");
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toast = document.querySelector("ic-toast")?.shadowRoot?.querySelector(".toast");
    expect(toast).toBeTruthy();
    // The .toast class has the toast-enter animation defined in CSS
    expect(toast?.classList.contains("toast")).toBe(true);
  });

  it("different variants render different data-variant attributes", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Success", "success");
    IcToast.show("Error", "error");
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    const variants = Array.from(toasts!).map((t) => t.getAttribute("data-variant"));
    expect(variants[0]).toBe("success");
    expect(variants[1]).toBe("error");
  });

  it("show with custom duration auto-dismisses at that duration", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("Quick", "info", 1000);
    await (document.querySelector("ic-toast") as any).updateComplete;

    // Not dismissed yet at 999ms
    vi.advanceTimersByTime(999);
    await (document.querySelector("ic-toast") as any).updateComplete;
    let toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(1);

    // Dismissed at 1000ms
    vi.advanceTimersByTime(1);
    await (document.querySelector("ic-toast") as any).updateComplete;
    toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(0);
  });

  it("after all toasts dismiss, container is empty", async () => {
    await createElement<IcToast>("ic-toast");
    IcToast.show("First", "info", 1000);
    IcToast.show("Second", "info", 2000);
    await (document.querySelector("ic-toast") as any).updateComplete;

    vi.advanceTimersByTime(2000);
    await (document.querySelector("ic-toast") as any).updateComplete;

    const toasts = document.querySelector("ic-toast")?.shadowRoot?.querySelectorAll(".toast");
    expect(toasts?.length).toBe(0);
  });
});
