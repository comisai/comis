// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import "./ic-eviction-chart.js";
import type { IcEvictionChart } from "./ic-eviction-chart.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcEvictionChart> {
  const el = document.createElement("ic-eviction-chart") as IcEvictionChart;
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

describe("IcEvictionChart", () => {
  it("renders empty state when no categories provided", async () => {
    const el = await createElement();
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe("No evictions");
  });

  it("renders empty state when all counts are 0", async () => {
    const el = await createElement({
      categories: { file_read: 0, exec: 0 },
    });
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
  });

  it("renders segments for non-zero categories", async () => {
    const el = await createElement({
      categories: { file_read: 12, exec: 5, web: 3 },
    });
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    expect(segments?.length).toBe(3);
  });

  it("shows total count label above bar", async () => {
    const el = await createElement({
      categories: { file_read: 10, exec: 5 },
    });
    const totalLabel = el.shadowRoot?.querySelector(".total-label");
    expect(totalLabel?.textContent?.trim()).toBe("15 evictions");
  });

  it("uses singular 'eviction' for count of 1", async () => {
    const el = await createElement({
      categories: { error: 1 },
    });
    const totalLabel = el.shadowRoot?.querySelector(".total-label");
    expect(totalLabel?.textContent?.trim()).toBe("1 eviction");
  });

  it("has role=img and aria-label on bar container", async () => {
    const el = await createElement({
      categories: { file_read: 5 },
    });
    const bar = el.shadowRoot?.querySelector("[role='img']");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-label")).toBe("Eviction breakdown");
  });

  it("renders legend by default", async () => {
    const el = await createElement({
      categories: { file_read: 5, exec: 3 },
    });
    const legend = el.shadowRoot?.querySelector(".legend");
    expect(legend).not.toBeNull();
    const legendItems = el.shadowRoot?.querySelectorAll(".legend-item");
    expect(legendItems?.length).toBe(2);
  });

  it("hides legend when show-legend is false", async () => {
    const el = await createElement({
      categories: { file_read: 5 },
      showLegend: false,
    });
    const legend = el.shadowRoot?.querySelector(".legend");
    expect(legend).toBeNull();
  });

  it("segments have title tooltips with count and percentage", async () => {
    const el = await createElement({
      categories: { file_read: 10 },
    });
    const segment = el.shadowRoot?.querySelector(".segment");
    const title = segment?.getAttribute("title") ?? "";
    expect(title).toContain("file_read");
    expect(title).toContain("10 evictions");
    expect(title).toContain("100.0%");
  });

  it("updates rendering when categories property changes", async () => {
    const el = await createElement({
      categories: { file_read: 5 },
    });
    expect(el.shadowRoot?.querySelectorAll(".segment").length).toBe(1);

    el.categories = { file_read: 5, exec: 3, web: 2 };
    await el.updateComplete;
    expect(el.shadowRoot?.querySelectorAll(".segment").length).toBe(3);
  });

  it("filters out zero-count categories from rendering", async () => {
    const el = await createElement({
      categories: { file_read: 10, exec: 0, web: 5 },
    });
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    expect(segments?.length).toBe(2); // file_read and web only
  });

  it("legend items contain category names", async () => {
    const el = await createElement({
      categories: { file_read: 5, error: 2 },
    });
    const legendItems = el.shadowRoot?.querySelectorAll(".legend-item");
    const names = Array.from(legendItems ?? []).map((item) => item.textContent?.trim());
    expect(names).toContain("file_read");
    expect(names).toContain("error");
  });
});
