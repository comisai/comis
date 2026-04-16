import { describe, it, expect, afterEach } from "vitest";
import "./ic-layer-waterfall.js";
import type { IcLayerWaterfall } from "./ic-layer-waterfall.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcLayerWaterfall> {
  const el = document.createElement("ic-layer-waterfall") as IcLayerWaterfall;
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

describe("IcLayerWaterfall", () => {
  it("renders empty state when no layers are provided", async () => {
    const el = await createElement();
    const empty = el.shadowRoot?.querySelector(".empty");
    expect(empty).not.toBeNull();
    expect(empty?.textContent?.trim()).toBe("No layer data");
  });

  it("renders rows matching layer count", async () => {
    const el = await createElement({
      layers: [
        { name: "system-prompt", durationMs: 10, messagesIn: 0, messagesOut: 3 },
        { name: "memory-inject", durationMs: 45, messagesIn: 3, messagesOut: 8 },
        { name: "thinking-cleaner", durationMs: 5, messagesIn: 8, messagesOut: 7 },
      ],
    });
    const rows = el.shadowRoot?.querySelectorAll(".row");
    expect(rows?.length).toBe(3);
  });

  it("formats layer names: replaces hyphens and capitalizes", async () => {
    const el = await createElement({
      layers: [
        { name: "thinking-cleaner", durationMs: 10, messagesIn: 1, messagesOut: 1 },
      ],
    });
    const nameEl = el.shadowRoot?.querySelector(".layer-name");
    expect(nameEl?.textContent?.trim()).toBe("Thinking cleaner");
  });

  it("shows duration labels in ms", async () => {
    const el = await createElement({
      layers: [
        { name: "system", durationMs: 42, messagesIn: 0, messagesOut: 1 },
      ],
    });
    const duration = el.shadowRoot?.querySelector(".duration");
    expect(duration?.textContent?.trim()).toBe("42ms");
  });

  it("renders bar fill elements within tracks", async () => {
    const el = await createElement({
      layers: [
        { name: "a", durationMs: 10, messagesIn: 0, messagesOut: 1 },
        { name: "b", durationMs: 20, messagesIn: 1, messagesOut: 2 },
      ],
    });
    const fills = el.shadowRoot?.querySelectorAll(".fill");
    expect(fills?.length).toBe(2);
  });

  it("bar fills have title tooltips with message counts", async () => {
    const el = await createElement({
      layers: [
        { name: "memory-inject", durationMs: 45, messagesIn: 3, messagesOut: 8 },
      ],
    });
    const fill = el.shadowRoot?.querySelector(".fill");
    const title = fill?.getAttribute("title") ?? "";
    expect(title).toContain("memory-inject");
    expect(title).toContain("45ms");
    expect(title).toContain("3 -> 8 messages");
  });

  it("updates rendering when layers property changes", async () => {
    const el = await createElement({
      layers: [{ name: "a", durationMs: 10, messagesIn: 0, messagesOut: 1 }],
    });
    expect(el.shadowRoot?.querySelectorAll(".row").length).toBe(1);

    el.layers = [
      { name: "a", durationMs: 10, messagesIn: 0, messagesOut: 1 },
      { name: "b", durationMs: 20, messagesIn: 1, messagesOut: 2 },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelectorAll(".row").length).toBe(2);
  });

  it("uses explicit totalDurationMs when provided", async () => {
    const el = await createElement({
      layers: [
        { name: "a", durationMs: 10, messagesIn: 0, messagesOut: 1 },
      ],
      totalDurationMs: 100,
    });
    // The fill should have title with "10ms" and the bar should exist
    const fill = el.shadowRoot?.querySelector(".fill");
    expect(fill).not.toBeNull();
    expect(fill?.getAttribute("title")).toContain("10ms");
  });
});
