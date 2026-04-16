import { describe, it, expect, afterEach } from "vitest";
import { IcConnectionDot } from "./ic-connection-dot.js";

// Import side-effect to register custom element
import "./ic-connection-dot.js";

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

describe("IcConnectionDot", () => {
  it("renders a dot element (span with border-radius)", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot");
    const dot = el.shadowRoot?.querySelector(".dot");
    expect(dot).toBeTruthy();
    expect(dot?.tagName.toLowerCase()).toBe("span");
  });

  it("connected status uses green color (var(--ic-success))", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "connected",
    });
    const dot = el.shadowRoot?.querySelector(".dot") as HTMLElement;
    expect(dot?.style.backgroundColor).toContain("var(--ic-success)");
  });

  it("reconnecting status uses green color (var(--ic-success)) via healthy alias", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "reconnecting",
    });
    const dot = el.shadowRoot?.querySelector(".dot") as HTMLElement;
    expect(dot?.style.backgroundColor).toContain("var(--ic-success)");
  });

  it("disconnected status uses dim color (var(--ic-text-dim))", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "disconnected",
    });
    const dot = el.shadowRoot?.querySelector(".dot") as HTMLElement;
    expect(dot?.style.backgroundColor).toContain("var(--ic-text-dim)");
  });

  it("unknown status uses dim color (var(--ic-text-dim))", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "unknown",
    });
    const dot = el.shadowRoot?.querySelector(".dot") as HTMLElement;
    expect(dot?.style.backgroundColor).toContain("var(--ic-text-dim)");
  });

  it("has role='status'", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot");
    const dot = el.shadowRoot?.querySelector("[role='status']");
    expect(dot).toBeTruthy();
  });

  it("has aria-label containing status text", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "connected",
    });
    const dot = el.shadowRoot?.querySelector(".dot");
    expect(dot?.getAttribute("aria-label")).toContain("Healthy");
  });

  it("size property changes dot dimensions", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      size: "12px",
    });
    const dot = el.shadowRoot?.querySelector(".dot") as HTMLElement;
    expect(dot?.style.width).toBe("12px");
    expect(dot?.style.height).toBe("12px");
  });

  it("showLabel displays label text by default (true)", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "connected",
    });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label).toBeTruthy();
    expect(label?.textContent?.trim()).toBe("Healthy");
  });

  it("showLabel hides label text when explicitly set to false", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "connected",
      showLabel: false,
    });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label).toBeFalsy();
  });

  it("renders a status icon for color-independent status", async () => {
    const el = await createElement<IcConnectionDot>("ic-connection-dot", {
      status: "connected",
    });
    const iconSpan = el.shadowRoot?.querySelector(".status-icon");
    expect(iconSpan).toBeTruthy();
    expect(iconSpan?.getAttribute("aria-hidden")).toBe("true");
  });
});
