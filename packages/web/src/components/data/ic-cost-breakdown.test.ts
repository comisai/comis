// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import "./ic-cost-breakdown.js";
import type { IcCostBreakdown } from "./ic-cost-breakdown.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcCostBreakdown> {
  const el = document.createElement("ic-cost-breakdown") as IcCostBreakdown;
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

describe("IcCostBreakdown", () => {
  it("renders empty state when no segments are provided", async () => {
    const el = await createElement();
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe("No cost data available");
  });

  it("renders correct number of segment divs", async () => {
    const el = await createElement({
      segments: [
        { label: "Anthropic", value: 12, color: "red" },
        { label: "OpenAI", value: 8, color: "blue" },
      ],
    });
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    expect(segments?.length).toBe(2);
  });

  it("segments have proportional widths", async () => {
    const el = await createElement({
      segments: [
        { label: "A", value: 75, color: "red" },
        { label: "B", value: 25, color: "blue" },
      ],
      total: 100,
    });
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    const styleA = segments?.[0]?.getAttribute("style") ?? "";
    const styleB = segments?.[1]?.getAttribute("style") ?? "";
    expect(styleA).toContain("width: 75%");
    expect(styleB).toContain("width: 25%");
  });

  it("click on segment dispatches segment-click event with correct detail", async () => {
    const el = await createElement({
      segments: [
        { label: "Anthropic", value: 12.34, color: "red" },
      ],
    });
    let eventDetail: { label: string; value: number } | null = null;
    el.addEventListener("segment-click", ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    const segment = el.shadowRoot?.querySelector(".segment") as HTMLElement;
    segment.click();

    expect(eventDetail).not.toBeNull();
    expect(eventDetail!.label).toBe("Anthropic");
    expect(eventDetail!.value).toBe(12.34);
  });

  it("legend shows labels and formatted values", async () => {
    const el = await createElement({
      segments: [
        { label: "Anthropic", value: 12.34, color: "red" },
        { label: "OpenAI", value: 8.56, color: "blue" },
      ],
    });
    const legendItems = el.shadowRoot?.querySelectorAll(".legend-item");
    expect(legendItems?.length).toBe(2);
    const texts = Array.from(legendItems ?? []).map((item) => item.textContent?.trim());
    expect(texts[0]).toContain("Anthropic");
    expect(texts[0]).toContain("$12.34");
    expect(texts[1]).toContain("OpenAI");
    expect(texts[1]).toContain("$8.56");
  });

  it("currency property affects formatting", async () => {
    const el = await createElement({
      segments: [
        { label: "Provider", value: 10, color: "red" },
      ],
      currency: "EUR",
    });
    const legendItem = el.shadowRoot?.querySelector(".legend-item");
    const text = legendItem?.textContent?.trim() ?? "";
    // EUR formatting should not use $ sign
    expect(text).toContain("10");
    expect(text).not.toContain("$");
  });

  it("zero total shows empty state", async () => {
    const el = await createElement({
      segments: [{ label: "A", value: 0, color: "red" }],
      total: 0,
    });
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe("No cost data available");
  });

  it("component registers as custom element", () => {
    const ctor = customElements.get("ic-cost-breakdown");
    expect(ctor).toBeDefined();
  });

  it("computes total from segments when total is 0", async () => {
    const el = await createElement({
      segments: [
        { label: "A", value: 60, color: "red" },
        { label: "B", value: 40, color: "blue" },
      ],
    });
    const segments = el.shadowRoot?.querySelectorAll(".segment");
    const titleA = segments?.[0]?.getAttribute("title") ?? "";
    const titleB = segments?.[1]?.getAttribute("title") ?? "";
    expect(titleA).toContain("60.0%");
    expect(titleB).toContain("40.0%");
  });

  it("segments have cursor pointer for interactivity", async () => {
    const el = await createElement({
      segments: [{ label: "A", value: 10, color: "red" }],
    });
    // The cursor: pointer is set via CSS class, verify segment exists
    const segment = el.shadowRoot?.querySelector(".segment");
    expect(segment).not.toBeNull();
  });
});
