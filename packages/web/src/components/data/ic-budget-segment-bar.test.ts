// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import "./ic-budget-segment-bar.js";
import type { IcBudgetSegmentBar } from "./ic-budget-segment-bar.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcBudgetSegmentBar> {
  const el = document.createElement("ic-budget-segment-bar") as IcBudgetSegmentBar;
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

describe("IcBudgetSegmentBar", () => {
  it("renders empty state when no segments are provided", async () => {
    const el = await createElement();
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe("No budget data");
  });

  it("renders empty state when total is 0 and segments are empty", async () => {
    const el = await createElement({ segments: [], total: 0 });
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
  });

  it("renders segments when data is provided", async () => {
    const el = await createElement({
      segments: [
        { label: "System", tokens: 2000, color: "red" },
        { label: "Memory", tokens: 1000, color: "blue" },
      ],
    });
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    expect(segments?.length).toBe(2);
  });

  it("has role=img and aria-label on bar container", async () => {
    const el = await createElement({
      segments: [{ label: "System", tokens: 1000, color: "red" }],
    });
    const bar = el.shadowRoot?.querySelector("[role='img']");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-label")).toBe("Token budget breakdown");
  });

  it("renders legend items matching segment count", async () => {
    const segments = [
      { label: "System", tokens: 2000, color: "red" },
      { label: "Memory", tokens: 1000, color: "blue" },
      { label: "Tools", tokens: 500, color: "green" },
    ];
    const el = await createElement({ segments });
    const legendItems = el.shadowRoot?.querySelectorAll(".legend-item");
    expect(legendItems?.length).toBe(3);
  });

  it("legend items contain segment labels", async () => {
    const el = await createElement({
      segments: [
        { label: "System", tokens: 2000, color: "red" },
        { label: "Memory", tokens: 1000, color: "blue" },
      ],
    });
    const legendItems = el.shadowRoot?.querySelectorAll(".legend-item");
    const labels = Array.from(legendItems ?? []).map((item) => item.textContent?.trim());
    expect(labels).toContain("System");
    expect(labels).toContain("Memory");
  });

  it("segments have title tooltips with token info", async () => {
    const el = await createElement({
      segments: [{ label: "System", tokens: 3000, color: "red" }],
      total: 3000,
    });
    const segment = el.shadowRoot?.querySelector(".segment");
    const title = segment?.getAttribute("title") ?? "";
    expect(title).toContain("System");
    expect(title).toContain("3,000");
    expect(title).toContain("100.0%");
  });

  it("uses explicit total when provided", async () => {
    const el = await createElement({
      segments: [{ label: "Used", tokens: 500, color: "red" }],
      total: 2000,
    });
    const segment = el.shadowRoot?.querySelector(".segment");
    const title = segment?.getAttribute("title") ?? "";
    expect(title).toContain("25.0%");
  });

  it("computes total from segments when total is 0", async () => {
    const el = await createElement({
      segments: [
        { label: "A", tokens: 600, color: "red" },
        { label: "B", tokens: 400, color: "blue" },
      ],
    });
    // A should be 60%, B should be 40%
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    const titleA = segments?.[0]?.getAttribute("title") ?? "";
    const titleB = segments?.[1]?.getAttribute("title") ?? "";
    expect(titleA).toContain("60.0%");
    expect(titleB).toContain("40.0%");
  });

  it("updates rendering when segments property changes", async () => {
    const el = await createElement({
      segments: [{ label: "A", tokens: 100, color: "red" }],
    });
    expect(el.shadowRoot?.querySelectorAll(".segment").length).toBe(1);

    el.segments = [
      { label: "A", tokens: 100, color: "red" },
      { label: "B", tokens: 200, color: "blue" },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelectorAll(".segment").length).toBe(2);
  });
});
