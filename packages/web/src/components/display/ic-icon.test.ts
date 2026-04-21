// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { IcIcon, iconNames } from "./ic-icon.js";

// Import side-effect to register custom element
import "./ic-icon.js";

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

describe("IcIcon", () => {
  it("renders an SVG element in shadow DOM", async () => {
    const el = await createElement<IcIcon>("ic-icon", { name: "dashboard" });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg).toBeTruthy();
  });

  it("SVG has correct viewBox '0 0 24 24'", async () => {
    const el = await createElement<IcIcon>("ic-icon", { name: "dashboard" });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("renders a path element for known icon name", async () => {
    const el = await createElement<IcIcon>("ic-icon", { name: "dashboard" });
    const path = el.shadowRoot?.querySelector("path");
    expect(path).toBeTruthy();
    expect(path?.getAttribute("d")).toBeTruthy();
  });

  it("renders nothing for unknown icon name", async () => {
    const el = await createElement<IcIcon>("ic-icon", {
      name: "nonexistent-icon-xyz",
    });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg).toBeFalsy();
  });

  it("size property sets SVG width and height", async () => {
    const el = await createElement<IcIcon>("ic-icon", {
      name: "chat",
      size: "32px",
    });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("32px");
    expect(svg?.getAttribute("height")).toBe("32px");
  });

  it("color property sets SVG fill", async () => {
    const el = await createElement<IcIcon>("ic-icon", {
      name: "chat",
      color: "red",
    });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("red");
  });

  it("has aria-hidden='true' when no label is set", async () => {
    const el = await createElement<IcIcon>("ic-icon", { name: "chat" });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("role")).toBe(false);
  });

  it("has role='img' and aria-label when label property is set", async () => {
    const el = await createElement<IcIcon>("ic-icon", {
      name: "check",
      label: "Success",
    });
    const svg = el.shadowRoot?.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Success");
    expect(svg?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("has at least 30 icon names in the icon map", () => {
    expect(iconNames.length).toBeGreaterThanOrEqual(30);
  });
});
