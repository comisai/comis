import { describe, it, expect, afterEach } from "vitest";
import "./ic-progress-bar.js";
import type { IcProgressBar } from "./ic-progress-bar.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcProgressBar> {
  const el = document.createElement("ic-progress-bar") as IcProgressBar;
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

describe("IcProgressBar", () => {
  it("renders with default properties (0%)", async () => {
    const el = await createElement();
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill?.style.width).toBe("0%");
  });

  it("fill width matches value percentage", async () => {
    const el = await createElement({ value: 65 });
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill?.style.width).toBe("65%");
  });

  it("caps fill at 100% for values > 100", async () => {
    const el = await createElement({ value: 150 });
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill?.style.width).toBe("100%");
  });

  it("shows percentage text when showPercent is true", async () => {
    const el = await createElement({ value: 42, showPercent: true });
    const percent = el.shadowRoot?.querySelector(".percent");
    expect(percent).not.toBeNull();
    expect(percent?.textContent?.trim()).toBe("42%");
  });

  it("hides percentage text when showPercent is false", async () => {
    const el = await createElement({ value: 42, showPercent: false });
    const percent = el.shadowRoot?.querySelector(".percent");
    expect(percent).toBeNull();
  });

  it("uses green color when value < green threshold", async () => {
    const el = await createElement({ value: 50, thresholds: { green: 80, yellow: 90 } });
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill?.style.backgroundColor).toBe("var(--ic-success)");
  });

  it("uses yellow color when value between green and yellow thresholds", async () => {
    const el = await createElement({ value: 85, thresholds: { green: 80, yellow: 90 } });
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill?.style.backgroundColor).toBe("var(--ic-warning)");
  });

  it("uses red color when value >= yellow threshold", async () => {
    const el = await createElement({ value: 95, thresholds: { green: 80, yellow: 90 } });
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill?.style.backgroundColor).toBe("var(--ic-error)");
  });

  it("renders label when provided", async () => {
    const el = await createElement({ value: 50, label: "Memory Usage" });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim()).toBe("Memory Usage");
  });

  it("does not render label when not provided", async () => {
    const el = await createElement({ value: 50 });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label).toBeNull();
  });

  it("has role=progressbar and aria-valuenow", async () => {
    const el = await createElement({ value: 73 });
    const bar = el.shadowRoot?.querySelector("[role='progressbar']");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-valuenow")).toBe("73");
    expect(bar?.getAttribute("aria-valuemin")).toBe("0");
    expect(bar?.getAttribute("aria-valuemax")).toBe("100");
  });

  it("respects custom thresholds", async () => {
    // With custom thresholds: green < 50, yellow < 70
    const el = await createElement({ value: 55, thresholds: { green: 50, yellow: 70 } });
    const fill = el.shadowRoot?.querySelector(".fill") as HTMLElement | null;
    expect(fill?.style.backgroundColor).toBe("var(--ic-warning)");
  });
});
