import { describe, it, expect, afterEach } from "vitest";
import "./ic-trace-timeline.js";
import type { IcTraceTimeline } from "./ic-trace-timeline.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcTraceTimeline> {
  const el = document.createElement("ic-trace-timeline") as IcTraceTimeline;
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

describe("IcTraceTimeline", () => {
  it("renders empty state when steps array is empty", async () => {
    const el = await createElement();
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe("No trace steps available");
  });

  it("renders correct number of rows for given steps", async () => {
    const el = await createElement({
      steps: [
        { name: "receive", durationMs: 10, status: "ok", timestamp: 1000 },
        { name: "route", durationMs: 20, status: "ok", timestamp: 1010 },
        { name: "execute", durationMs: 50, status: "ok", timestamp: 1030 },
      ],
    });
    const rows = el.shadowRoot?.querySelectorAll(".step-row");
    expect(rows?.length).toBe(3);
  });

  it("formats duration as ms for values under 1000", async () => {
    const el = await createElement({
      steps: [
        { name: "receive", durationMs: 45, status: "ok", timestamp: 1000 },
      ],
    });
    const duration = el.shadowRoot?.querySelector(".duration");
    expect(duration?.textContent?.trim()).toBe("45ms");
  });

  it("formats duration as seconds for values >= 1000", async () => {
    const el = await createElement({
      steps: [
        { name: "execute", durationMs: 1200, status: "ok", timestamp: 1000 },
      ],
    });
    const duration = el.shadowRoot?.querySelector(".duration");
    expect(duration?.textContent?.trim()).toBe("1.2s");
  });

  it("error steps render with error color class", async () => {
    const el = await createElement({
      steps: [
        { name: "execute", durationMs: 500, status: "error", timestamp: 1000, error: "Timeout" },
      ],
    });
    const fill = el.shadowRoot?.querySelector(".fill--error");
    expect(fill).not.toBeNull();
  });

  it("error message text displayed for steps with error field", async () => {
    const el = await createElement({
      steps: [
        { name: "execute", durationMs: 500, status: "error", timestamp: 1000, error: "Connection timeout" },
      ],
    });
    const errorText = el.shadowRoot?.querySelector(".error-text");
    expect(errorText).not.toBeNull();
    expect(errorText?.textContent?.trim()).toBe("Connection timeout");
  });

  it("ok steps do not show error text", async () => {
    const el = await createElement({
      steps: [
        { name: "receive", durationMs: 10, status: "ok", timestamp: 1000 },
      ],
    });
    const errorText = el.shadowRoot?.querySelector(".error-text");
    expect(errorText).toBeNull();
  });

  it("bar widths are proportional to duration", async () => {
    const el = await createElement({
      steps: [
        { name: "a", durationMs: 25, status: "ok", timestamp: 1000 },
        { name: "b", durationMs: 75, status: "ok", timestamp: 1025 },
      ],
    });
    const fills = el.shadowRoot?.querySelectorAll(".fill");
    expect(fills?.length).toBe(2);
    // First bar: 25% width, 0% offset
    const styleA = fills?.[0]?.getAttribute("style") ?? "";
    expect(styleA).toContain("width: 25%");
    expect(styleA).toContain("left: 0%");
    // Second bar: 75% width, 25% offset
    const styleB = fills?.[1]?.getAttribute("style") ?? "";
    expect(styleB).toContain("width: 75%");
    expect(styleB).toContain("left: 25%");
  });

  it("total duration computed from steps if not provided", async () => {
    const el = await createElement({
      steps: [
        { name: "a", durationMs: 50, status: "ok", timestamp: 1000 },
        { name: "b", durationMs: 50, status: "ok", timestamp: 1050 },
      ],
    });
    // Each bar should be 50% wide since total is auto-computed as 100
    const fills = el.shadowRoot?.querySelectorAll(".fill");
    const styleA = fills?.[0]?.getAttribute("style") ?? "";
    expect(styleA).toContain("width: 50%");
  });

  it("uses explicit totalDurationMs when provided", async () => {
    const el = await createElement({
      steps: [
        { name: "a", durationMs: 25, status: "ok", timestamp: 1000 },
      ],
      totalDurationMs: 100,
    });
    // Bar should be 25% wide with explicit total of 100
    const fill = el.shadowRoot?.querySelector(".fill");
    const style = fill?.getAttribute("style") ?? "";
    expect(style).toContain("width: 25%");
  });

  it("component registers as custom element", () => {
    const ctor = customElements.get("ic-trace-timeline");
    expect(ctor).toBeDefined();
  });
});
