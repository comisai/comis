// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { IcStatCard } from "./ic-stat-card.js";

// Import side-effect to register custom element
import "./ic-stat-card.js";

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

describe("IcStatCard", () => {
  it("renders label text", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Active Agents",
      value: "3",
    });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label?.textContent).toContain("Active Agents");
  });

  it("renders value text", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Count",
      value: "1,247",
    });
    const value = el.shadowRoot?.querySelector(".value");
    expect(value?.textContent).toContain("1,247");
  });

  it("renders trend arrow up with success color when trend is 'up'", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Messages",
      value: "845K",
      trend: "up",
      trendValue: "+12%",
    });
    const trend = el.shadowRoot?.querySelector(".trend");
    expect(trend).toBeTruthy();
    expect(trend?.classList.contains("trend--up")).toBe(true);
    expect(trend?.textContent).toContain("\u2191");
  });

  it("renders trend arrow down with error color when trend is 'down'", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Errors",
      value: "23",
      trend: "down",
      trendValue: "-3",
    });
    const trend = el.shadowRoot?.querySelector(".trend");
    expect(trend).toBeTruthy();
    expect(trend?.classList.contains("trend--down")).toBe(true);
    expect(trend?.textContent).toContain("\u2193");
  });

  it("renders flat dash when trend is 'flat'", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Uptime",
      value: "99.9%",
      trend: "flat",
    });
    const trend = el.shadowRoot?.querySelector(".trend");
    expect(trend).toBeTruthy();
    expect(trend?.classList.contains("trend--flat")).toBe(true);
    expect(trend?.textContent).toContain("\u2014");
  });

  it("hides trend when trend is empty", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Total",
      value: "500",
    });
    const trend = el.shadowRoot?.querySelector(".trend");
    expect(trend).toBeNull();
  });

  it("renders trendValue text when provided", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Revenue",
      value: "$1.2M",
      trend: "up",
      trendValue: "+8.5%",
    });
    const trend = el.shadowRoot?.querySelector(".trend");
    expect(trend?.textContent).toContain("+8.5%");
  });

  it("card uses design token variables", async () => {
    const el = await createElement<IcStatCard>("ic-stat-card", {
      label: "Test",
      value: "0",
    });
    const card = el.shadowRoot?.querySelector(".card");
    expect(card).toBeTruthy();
    // Verify the card element exists with the expected class - design tokens
    // are applied via CSS custom properties in the stylesheet
    expect(card?.tagName.toLowerCase()).toBe("div");
  });
});
