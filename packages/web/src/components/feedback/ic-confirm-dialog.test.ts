import { describe, it, expect, afterEach, vi } from "vitest";
import { IcConfirmDialog } from "./ic-confirm-dialog.js";

// Import side-effect to register custom element
import "./ic-confirm-dialog.js";

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

describe("IcConfirmDialog", () => {
  it("dialog is hidden when open is false", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: false,
      message: "Are you sure?",
    });
    const backdrop = el.shadowRoot?.querySelector(".backdrop");
    expect(backdrop).toBeNull();
  });

  it("dialog is visible when open is true", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Are you sure?",
    });
    const backdrop = el.shadowRoot?.querySelector(".backdrop");
    expect(backdrop).toBeTruthy();
  });

  it("renders title text", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      title: "Delete Agent",
      message: "This will remove the agent.",
    });
    const title = el.shadowRoot?.querySelector(".title");
    expect(title?.textContent).toContain("Delete Agent");
  });

  it("renders message text", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Are you sure you want to proceed?",
    });
    const message = el.shadowRoot?.querySelector(".message");
    expect(message?.textContent).toContain("Are you sure you want to proceed?");
  });

  it("renders confirm button with confirmLabel text", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Confirm?",
      confirmLabel: "Yes, Delete",
    });
    const confirmBtn = el.shadowRoot?.querySelector(".confirm-btn");
    expect(confirmBtn?.textContent?.trim()).toContain("Yes, Delete");
  });

  it("renders cancel button with cancelLabel text", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Confirm?",
      cancelLabel: "No, Keep",
    });
    const cancelBtn = el.shadowRoot?.querySelector(".cancel-btn");
    expect(cancelBtn?.textContent?.trim()).toContain("No, Keep");
  });

  it("fires 'confirm' event when confirm button clicked", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Confirm?",
    });
    const handler = vi.fn();
    el.addEventListener("confirm", handler);

    const confirmBtn = el.shadowRoot?.querySelector(".confirm-btn") as HTMLElement;
    confirmBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("fires 'cancel' event when cancel button clicked", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Cancel?",
    });
    const handler = vi.fn();
    el.addEventListener("cancel", handler);

    const cancelBtn = el.shadowRoot?.querySelector(".cancel-btn") as HTMLElement;
    cancelBtn?.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("fires 'cancel' event on Escape key press", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Press Escape",
    });
    const handler = vi.fn();
    el.addEventListener("cancel", handler);

    const backdrop = el.shadowRoot?.querySelector(".backdrop") as HTMLElement;
    backdrop?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("fires 'cancel' event on backdrop click", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Click backdrop",
    });
    const handler = vi.fn();
    el.addEventListener("cancel", handler);

    const backdrop = el.shadowRoot?.querySelector(".backdrop") as HTMLElement;
    // Click the backdrop element directly
    backdrop?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(handler).toHaveBeenCalledOnce();
  });

  it("danger variant makes confirm button red", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Danger!",
      variant: "danger",
    });
    const confirmBtn = el.shadowRoot?.querySelector(".confirm-btn");
    expect(confirmBtn?.classList.contains("confirm-btn--danger")).toBe(true);
  });

  it("has role='dialog' and aria-modal='true'", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "ARIA check",
    });
    const dialog = el.shadowRoot?.querySelector("[role='dialog']");
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
  });

  it("focus moves into dialog when opened", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      message: "Focus test",
    });
    // Wait for the focus to be set asynchronously
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));

    const cancelBtn = el.shadowRoot?.querySelector(".cancel-btn");
    expect(el.shadowRoot?.activeElement).toBe(cancelBtn);
  });

  it("has aria-labelledby pointing to title element", async () => {
    const el = await createElement<IcConfirmDialog>("ic-confirm-dialog", {
      open: true,
      title: "Test Title",
      message: "Label test",
    });
    const dialog = el.shadowRoot?.querySelector("[role='dialog']");
    const labelledBy = dialog?.getAttribute("aria-labelledby");
    expect(labelledBy).toBe("dialog-title");

    const title = el.shadowRoot?.getElementById("dialog-title");
    expect(title).toBeTruthy();
    expect(title?.textContent).toContain("Test Title");
  });
});
