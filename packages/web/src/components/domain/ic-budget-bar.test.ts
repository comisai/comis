import { describe, it, expect, afterEach } from "vitest";
import type { IcBudgetBar } from "./ic-budget-bar.js";

// Side-effect import to register custom element
import "./ic-budget-bar.js";

async function createElement<T extends HTMLElement>(
  tag: string,
  props?: Record<string, unknown>,
): Promise<T> {
  const el = document.createElement(tag) as T;
  if (props) {
    Object.assign(el, props);
  }
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("IcBudgetBar", () => {
  it("renders bar with correct percentage fill", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Per Day",
      used: 300000,
      total: 1000000,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill") as HTMLElement;
    expect(fill).toBeTruthy();
    expect(fill.style.width).toBe("30%");
  });

  it("shows label and formatted numbers (used / total)", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Per Hour",
      used: 500000,
      total: 1000000,
    });

    const label = el.shadowRoot?.querySelector(".label");
    expect(label?.textContent).toBe("Per Hour");

    const values = el.shadowRoot?.querySelector(".values");
    expect(values?.textContent).toContain("500,000");
    expect(values?.textContent).toContain("1,000,000");
    expect(values?.textContent).toContain("50%");
  });

  it("applies success color when below warn threshold", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Test",
      used: 100,
      total: 1000,
      warnThreshold: 70,
      dangerThreshold: 90,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill");
    expect(fill?.classList.contains("bar-fill--success")).toBe(true);
    expect(fill?.classList.contains("bar-fill--warning")).toBe(false);
    expect(fill?.classList.contains("bar-fill--danger")).toBe(false);
  });

  it("applies warning color when between warn and danger thresholds", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Test",
      used: 750,
      total: 1000,
      warnThreshold: 70,
      dangerThreshold: 90,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill");
    expect(fill?.classList.contains("bar-fill--warning")).toBe(true);
  });

  it("applies danger color when above danger threshold", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Test",
      used: 950,
      total: 1000,
      warnThreshold: 70,
      dangerThreshold: 90,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill");
    expect(fill?.classList.contains("bar-fill--danger")).toBe(true);
  });

  it("shows 'unlimited' when total is 0", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Per Day",
      used: 0,
      total: 0,
    });

    const unlimited = el.shadowRoot?.querySelector(".unlimited");
    expect(unlimited).toBeTruthy();
    expect(unlimited?.textContent).toBe("unlimited");

    // No bar track should be rendered
    const track = el.shadowRoot?.querySelector(".track");
    expect(track).toBeNull();
  });

  it("formats large numbers with commas", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Budget",
      used: 612000,
      total: 1000000,
    });

    const values = el.shadowRoot?.querySelector(".values");
    expect(values?.textContent).toContain("612,000");
    expect(values?.textContent).toContain("1,000,000");
  });

  it("respects custom threshold props", async () => {
    // With custom thresholds: warn at 50, danger at 80
    // 60% usage should be warning with custom thresholds
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Custom",
      used: 600,
      total: 1000,
      warnThreshold: 50,
      dangerThreshold: 80,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill");
    expect(fill?.classList.contains("bar-fill--warning")).toBe(true);
  });

  it("caps percentage at 100 when used exceeds total", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Over",
      used: 1500,
      total: 1000,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill") as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });

  it("renders at exactly warn threshold as warning", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Exact",
      used: 700,
      total: 1000,
      warnThreshold: 70,
      dangerThreshold: 90,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill");
    expect(fill?.classList.contains("bar-fill--warning")).toBe(true);
  });

  it("renders at exactly danger threshold as danger", async () => {
    const el = await createElement<IcBudgetBar>("ic-budget-bar", {
      label: "Exact",
      used: 900,
      total: 1000,
      warnThreshold: 70,
      dangerThreshold: 90,
    });

    const fill = el.shadowRoot?.querySelector(".bar-fill");
    expect(fill?.classList.contains("bar-fill--danger")).toBe(true);
  });
});
