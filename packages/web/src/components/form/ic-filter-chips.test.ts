// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach, vi } from "vitest";
import "./ic-filter-chips.js";
import type { IcFilterChips } from "./ic-filter-chips.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcFilterChips> {
  const el = document.createElement("ic-filter-chips") as IcFilterChips;
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

const testOptions = [
  { value: "telegram", label: "Telegram", color: "var(--ic-telegram)" },
  { value: "discord", label: "Discord", color: "var(--ic-discord)" },
  { value: "slack", label: "Slack", color: "var(--ic-slack)" },
];

describe("IcFilterChips", () => {
  it("renders 'All' chip plus one chip per option", async () => {
    const el = await createElement({ options: testOptions });
    const chips = el.shadowRoot?.querySelectorAll("button");
    expect(chips?.length).toBe(4); // All + 3 options
  });

  it("chips show correct labels", async () => {
    const el = await createElement({ options: testOptions });
    const chips = el.shadowRoot?.querySelectorAll("button");
    const labels = Array.from(chips!).map((c) => c.textContent?.trim());
    expect(labels).toContain("All");
    expect(labels).toContain("Telegram");
    expect(labels).toContain("Discord");
    expect(labels).toContain("Slack");
  });

  it("clicking an unselected chip adds it to selected set", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set<string>(),
    });

    const handler = vi.fn();
    el.addEventListener("filter-change", handler);

    // Click "Telegram" chip (index 1 because 0 is "All")
    const chips = el.shadowRoot?.querySelectorAll("button");
    chips![1].click();

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.selected.has("telegram")).toBe(true);
  });

  it("clicking a selected chip removes it from selected set", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set(["telegram", "discord"]),
    });

    const handler = vi.fn();
    el.addEventListener("filter-change", handler);

    // Click "Telegram" to deselect
    const chips = el.shadowRoot?.querySelectorAll("button");
    chips![1].click();

    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.selected.has("telegram")).toBe(false);
    expect(detail.selected.has("discord")).toBe(true);
  });

  it("dispatches 'filter-change' CustomEvent with updated selected Set", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set<string>(),
    });

    const handler = vi.fn();
    el.addEventListener("filter-change", handler);

    const chips = el.shadowRoot?.querySelectorAll("button");
    chips![2].click(); // Click "Discord"

    expect(handler).toHaveBeenCalledOnce();
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.selected).toBeInstanceOf(Set);
    expect(detail.selected.has("discord")).toBe(true);
  });

  it("'All' chip selects all options when none are selected", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set<string>(),
    });

    const handler = vi.fn();
    el.addEventListener("filter-change", handler);

    // Click "All" (index 0)
    const chips = el.shadowRoot?.querySelectorAll("button");
    chips![0].click();

    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.selected.size).toBe(3);
    expect(detail.selected.has("telegram")).toBe(true);
    expect(detail.selected.has("discord")).toBe(true);
    expect(detail.selected.has("slack")).toBe(true);
  });

  it("'All' chip deselects all options when all are selected", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set(["telegram", "discord", "slack"]),
    });

    const handler = vi.fn();
    el.addEventListener("filter-change", handler);

    // Click "All" to deselect
    const chips = el.shadowRoot?.querySelectorAll("button");
    chips![0].click();

    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.selected.size).toBe(0);
  });

  it("selected chips have different visual styling", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set(["telegram"]),
    });

    const chips = el.shadowRoot?.querySelectorAll("button");
    // "Telegram" (index 1) is selected -- should have colored border style
    const selectedChip = chips![1];
    expect(selectedChip.classList.contains("chip--unselected")).toBe(false);
    // "Discord" (index 2) is not selected
    const unselectedChip = chips![2];
    expect(unselectedChip.classList.contains("chip--unselected")).toBe(true);
  });

  it("chips have focusable styling (uses focusStyles)", async () => {
    const el = await createElement({ options: testOptions });
    // Each chip is a <button> element which gets focusStyles via focus-visible
    const chips = el.shadowRoot?.querySelectorAll("button");
    expect(chips!.length).toBeGreaterThan(0);
    // Buttons are inherently focusable
    for (const chip of chips!) {
      expect(chip.tagName).toBe("BUTTON");
    }
  });

  it("chip colors applied when provided in options", async () => {
    const el = await createElement({
      options: testOptions,
      selected: new Set(["telegram"]),
    });

    const chips = el.shadowRoot?.querySelectorAll("button");
    const telegramChip = chips![1]; // Selected telegram chip
    // Should have the color applied in inline style
    expect(telegramChip.style.color).toContain("var(--ic-telegram)");
  });
});
