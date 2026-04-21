// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import "./ic-time-range-picker.js";
import type { IcTimeRangePicker } from "./ic-time-range-picker.js";

async function createElement(
  props?: Record<string, unknown>,
): Promise<IcTimeRangePicker> {
  const el = document.createElement("ic-time-range-picker") as IcTimeRangePicker;
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

describe("IcTimeRangePicker", () => {
  it("renders 4 preset buttons by default", async () => {
    const el = await createElement();
    const buttons = el.shadowRoot?.querySelectorAll(".preset");
    expect(buttons?.length).toBe(4);
  });

  it("active preset has accent styling", async () => {
    const el = await createElement({ selected: "7d" });
    const buttons = el.shadowRoot?.querySelectorAll(".preset");
    const labels = Array.from(buttons ?? []).map((b) => ({
      text: b.textContent?.trim(),
      active: b.classList.contains("preset--active"),
    }));
    const active = labels.find((l) => l.active);
    expect(active?.text).toBe("7d");
  });

  it("click preset dispatches time-range-change with correct sinceMs", async () => {
    const el = await createElement();
    let eventDetail: { sinceMs: number; label: string } | null = null;
    el.addEventListener("time-range-change", ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    // Click "30d" button
    const buttons = el.shadowRoot?.querySelectorAll(".preset");
    const btn30d = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "30d",
    ) as HTMLElement;
    btn30d.click();
    await el.updateComplete;

    expect(eventDetail).not.toBeNull();
    expect(eventDetail!.sinceMs).toBe(2_592_000_000);
    expect(eventDetail!.label).toBe("30d");
  });

  it("Today preset dispatches sinceMs of 86_400_000", async () => {
    const el = await createElement();
    let eventDetail: { sinceMs: number; label: string } | null = null;
    el.addEventListener("time-range-change", ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    const buttons = el.shadowRoot?.querySelectorAll(".preset");
    const btnToday = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Today",
    ) as HTMLElement;
    btnToday.click();
    await el.updateComplete;

    expect(eventDetail!.sinceMs).toBe(86_400_000);
    expect(eventDetail!.label).toBe("Today");
  });

  it("7d preset dispatches sinceMs of 604_800_000", async () => {
    const el = await createElement();
    let eventDetail: { sinceMs: number; label: string } | null = null;
    el.addEventListener("time-range-change", ((e: CustomEvent) => {
      eventDetail = e.detail;
    }) as EventListener);

    const buttons = el.shadowRoot?.querySelectorAll(".preset");
    const btn7d = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "7d",
    ) as HTMLElement;
    btn7d.click();
    await el.updateComplete;

    expect(eventDetail!.sinceMs).toBe(604_800_000);
    expect(eventDetail!.label).toBe("7d");
  });

  it("Custom selection shows date inputs", async () => {
    const el = await createElement({ selected: "Custom" });
    const dateInputs = el.shadowRoot?.querySelectorAll('input[type="date"]');
    expect(dateInputs?.length).toBe(2);
  });

  it("non-Custom selection does not show date inputs", async () => {
    const el = await createElement({ selected: "7d" });
    const dateInputs = el.shadowRoot?.querySelectorAll('input[type="date"]');
    expect(dateInputs?.length ?? 0).toBe(0);
  });

  it("component registers as custom element", () => {
    const ctor = customElements.get("ic-time-range-picker");
    expect(ctor).toBeDefined();
  });

  it("default selected is 7d", async () => {
    const el = await createElement();
    expect(el.selected).toBe("7d");
  });

  it("clicking Custom does not dispatch event until dates are provided", async () => {
    const el = await createElement();
    let eventFired = false;
    el.addEventListener("time-range-change", () => {
      eventFired = true;
    });

    const buttons = el.shadowRoot?.querySelectorAll(".preset");
    const btnCustom = Array.from(buttons ?? []).find(
      (b) => b.textContent?.trim() === "Custom",
    ) as HTMLElement;
    btnCustom.click();
    await el.updateComplete;

    // Custom click should not fire event (no dates yet)
    expect(eventFired).toBe(false);
    // But Custom should now be selected
    expect(el.selected).toBe("Custom");
  });
});
