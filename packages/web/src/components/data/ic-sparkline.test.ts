import { describe, it, expect, afterEach } from "vitest";
import "./ic-sparkline.js";
import type { IcSparkline } from "./ic-sparkline.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcSparkline> {
  const el = document.createElement("ic-sparkline") as IcSparkline;
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

describe("IcSparkline", () => {
  it("renders nothing when data is empty", async () => {
    const el = await createElement({ data: [] });
    const svgEl = el.shadowRoot?.querySelector("svg");
    expect(svgEl).toBeNull();
  });

  it("renders a polyline when data is provided", async () => {
    const el = await createElement({ data: [10, 20, 15, 25, 18] });
    const polyline = el.shadowRoot?.querySelector("polyline");
    expect(polyline).not.toBeNull();
  });

  it("polyline has correct attributes (fill=none, stroke-width, linecap, linejoin)", async () => {
    const el = await createElement({ data: [5, 10, 8] });
    const polyline = el.shadowRoot?.querySelector("polyline");
    expect(polyline?.getAttribute("fill")).toBe("none");
    expect(polyline?.getAttribute("stroke-width")).toBe("1.5");
    expect(polyline?.getAttribute("stroke-linecap")).toBe("round");
    expect(polyline?.getAttribute("stroke-linejoin")).toBe("round");
  });

  it("polyline points are normalized within viewBox dimensions", async () => {
    const el = await createElement({ data: [0, 50, 100], width: 80, height: 24 });
    const polyline = el.shadowRoot?.querySelector("polyline");
    const points = polyline?.getAttribute("points") ?? "";
    // Points should contain valid numeric coordinates within viewBox
    const coords = points.split(" ").map((p) => p.split(",").map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(80);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(24);
    }
  });

  it("handles single data point by rendering a circle", async () => {
    const el = await createElement({ data: [42] });
    const circle = el.shadowRoot?.querySelector("circle");
    expect(circle).not.toBeNull();
    // No polyline for single point
    const polyline = el.shadowRoot?.querySelector("polyline");
    expect(polyline).toBeNull();
  });

  it("handles all-same values with a flat line", async () => {
    const el = await createElement({ data: [10, 10, 10, 10], height: 24 });
    const polyline = el.shadowRoot?.querySelector("polyline");
    const points = polyline?.getAttribute("points") ?? "";
    // All y-values should be the same (center)
    const yValues = points.split(" ").map((p) => Number(p.split(",")[1]));
    const allSame = yValues.every((y) => y === yValues[0]);
    expect(allSame).toBe(true);
    expect(yValues[0]).toBe(12); // height / 2
  });

  it("respects custom width, height, and color properties", async () => {
    const el = await createElement({
      data: [1, 2, 3],
      width: 120,
      height: 40,
      color: "red",
    });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 120 40");
    const polyline = el.shadowRoot?.querySelector("polyline");
    expect(polyline?.getAttribute("stroke")).toBe("red");
  });

  it("SVG element has correct viewBox attribute", async () => {
    const el = await createElement({ data: [1, 2], width: 80, height: 24 });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 80 24");
  });
});
