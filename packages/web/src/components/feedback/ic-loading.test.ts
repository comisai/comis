// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { IcLoading } from "./ic-loading.js";

// Import side-effect to register custom element
import "./ic-loading.js";

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

describe("IcLoading", () => {
  it("spinner mode renders a spinning element", async () => {
    const el = await createElement<IcLoading>("ic-loading", {
      mode: "spinner",
    });
    const spinner = el.shadowRoot?.querySelector(".spinner");
    expect(spinner).toBeTruthy();
  });

  it("skeleton mode renders line elements", async () => {
    const el = await createElement<IcLoading>("ic-loading", {
      mode: "skeleton",
    });
    const lines = el.shadowRoot?.querySelectorAll(".skeleton-line");
    expect(lines?.length).toBeGreaterThan(0);
  });

  it("default mode is spinner", async () => {
    const el = await createElement<IcLoading>("ic-loading");
    const spinner = el.shadowRoot?.querySelector(".spinner");
    expect(spinner).toBeTruthy();
    const skeleton = el.shadowRoot?.querySelector(".skeleton-container");
    expect(skeleton).toBeFalsy();
  });

  it("lines property controls number of skeleton bars (default 3)", async () => {
    const el = await createElement<IcLoading>("ic-loading", {
      mode: "skeleton",
    });
    const lines = el.shadowRoot?.querySelectorAll(".skeleton-line");
    expect(lines?.length).toBe(3);
  });

  it("lines property controls number of skeleton bars (custom)", async () => {
    const el = await createElement<IcLoading>("ic-loading", {
      mode: "skeleton",
      lines: 5,
    });
    const lines = el.shadowRoot?.querySelectorAll(".skeleton-line");
    expect(lines?.length).toBe(5);
  });

  it('size "sm" renders 16px spinner', async () => {
    const el = await createElement<IcLoading>("ic-loading", { size: "sm" });
    const spinner = el.shadowRoot?.querySelector(".spinner") as HTMLElement;
    expect(spinner?.style.width).toBe("16px");
    expect(spinner?.style.height).toBe("16px");
  });

  it('size "md" renders 24px spinner (default)', async () => {
    const el = await createElement<IcLoading>("ic-loading");
    const spinner = el.shadowRoot?.querySelector(".spinner") as HTMLElement;
    expect(spinner?.style.width).toBe("24px");
    expect(spinner?.style.height).toBe("24px");
  });

  it("has role='status'", async () => {
    const el = await createElement<IcLoading>("ic-loading");
    const status = el.shadowRoot?.querySelector("[role='status']");
    expect(status).toBeTruthy();
  });

  it("has aria-label='Loading'", async () => {
    const el = await createElement<IcLoading>("ic-loading");
    const status = el.shadowRoot?.querySelector("[aria-label='Loading']");
    expect(status).toBeTruthy();
  });
});
