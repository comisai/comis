import { describe, it, expect, afterEach } from "vitest";
import "./ic-metric-gauge.js";
import type { IcMetricGauge } from "./ic-metric-gauge.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcMetricGauge> {
  const el = document.createElement("ic-metric-gauge") as IcMetricGauge;
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

describe("IcMetricGauge", () => {
  it("renders with default properties (0%)", async () => {
    const el = await createElement();
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg).not.toBeNull();
    const valueText = el.shadowRoot?.querySelector(".value-text");
    expect(valueText?.textContent?.trim()).toBe("0%");
  });

  it("displays the clamped percentage value", async () => {
    const el = await createElement({ value: 72 });
    const valueText = el.shadowRoot?.querySelector(".value-text");
    expect(valueText?.textContent?.trim()).toBe("72%");
  });

  it("clamps values above 100 to 100", async () => {
    const el = await createElement({ value: 150 });
    const valueText = el.shadowRoot?.querySelector(".value-text");
    expect(valueText?.textContent?.trim()).toBe("100%");
  });

  it("clamps negative values to 0", async () => {
    const el = await createElement({ value: -10 });
    const valueText = el.shadowRoot?.querySelector(".value-text");
    expect(valueText?.textContent?.trim()).toBe("0%");
  });

  it("renders two SVG circle elements (background + value arc)", async () => {
    const el = await createElement({ value: 50 });
    const circles = el.shadowRoot?.querySelectorAll("circle");
    expect(circles?.length).toBe(2);
  });

  it("renders SVG with correct viewBox and preserveAspectRatio", async () => {
    const el = await createElement({ value: 50 });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 100 100");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
  });

  it("renders label when provided", async () => {
    const el = await createElement({ value: 50, label: "Cache Hit" });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim()).toBe("Cache Hit");
  });

  it("does not render label when empty", async () => {
    const el = await createElement({ value: 50 });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label).toBeNull();
  });

  it("renders trend indicator", async () => {
    const el = await createElement({ value: 50, trend: 1 });
    const trendEl = el.shadowRoot?.querySelector(".trend-up");
    expect(trendEl).not.toBeNull();
    expect(trendEl?.textContent?.trim()).toBe("\u2191"); // up arrow
  });

  it("renders down trend indicator", async () => {
    const el = await createElement({ value: 50, trend: -1 });
    const trendEl = el.shadowRoot?.querySelector(".trend-down");
    expect(trendEl).not.toBeNull();
    expect(trendEl?.textContent?.trim()).toBe("\u2193"); // down arrow
  });

  it("renders flat trend indicator", async () => {
    const el = await createElement({ value: 50, trend: 0 });
    const trendEl = el.shadowRoot?.querySelector(".trend-flat");
    expect(trendEl).not.toBeNull();
    expect(trendEl?.textContent?.trim()).toBe("\u2014"); // em dash
  });

  it("reflects size attribute", async () => {
    const el = await createElement({ value: 50, size: "lg" });
    expect(el.getAttribute("size")).toBe("lg");
  });

  it("updates rendering when value property changes", async () => {
    const el = await createElement({ value: 30 });
    const valueText1 = el.shadowRoot?.querySelector(".value-text");
    expect(valueText1?.textContent?.trim()).toBe("30%");

    el.value = 85;
    await el.updateComplete;
    const valueText2 = el.shadowRoot?.querySelector(".value-text");
    expect(valueText2?.textContent?.trim()).toBe("85%");
  });
});
