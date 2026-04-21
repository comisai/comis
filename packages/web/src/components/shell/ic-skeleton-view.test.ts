// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import type { IcSkeletonView } from "./ic-skeleton-view.js";

// Import side-effect to register custom element
import "./ic-skeleton-view.js";

// Register ic-loading stub if not already registered
if (!customElements.get("ic-loading")) {
  customElements.define(
    "ic-loading",
    class extends HTMLElement {
      static get observedAttributes() { return ["mode", "lines", "size"]; }
    },
  );
}

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

describe("IcSkeletonView", () => {
  it("renders dashboard variant", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "dashboard",
    });
    const container = el.shadowRoot?.querySelector('[role="status"]');
    expect(container).toBeTruthy();
    expect(container?.getAttribute("aria-label")).toBe("Loading content");
  });

  it("renders list variant", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "list",
    });
    const container = el.shadowRoot?.querySelector('[role="status"]');
    expect(container).toBeTruthy();
    // List variant has search bar skeleton
    const search = el.shadowRoot?.querySelector(".skeleton-search");
    expect(search).toBeTruthy();
  });

  it("renders detail variant", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "detail",
    });
    const container = el.shadowRoot?.querySelector('[role="status"]');
    expect(container).toBeTruthy();
    // Detail has two-column layout
    const twoCol = el.shadowRoot?.querySelector(".skeleton-two-col");
    expect(twoCol).toBeTruthy();
  });

  it("renders table variant", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "table",
    });
    const container = el.shadowRoot?.querySelector('[role="status"]');
    expect(container).toBeTruthy();
    // Table has rows
    const rows = el.shadowRoot?.querySelectorAll(".skeleton-row");
    expect(rows!.length).toBeGreaterThan(0);
  });

  it("renders editor variant", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "editor",
    });
    const container = el.shadowRoot?.querySelector('[role="status"]');
    expect(container).toBeTruthy();
    const editorBlock = el.shadowRoot?.querySelector(".skeleton-editor-block");
    expect(editorBlock).toBeTruthy();
  });

  it("has role=status for accessibility", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "dashboard",
    });
    const status = el.shadowRoot?.querySelector('[role="status"]');
    expect(status).toBeTruthy();
  });

  it("has aria-label for accessibility", async () => {
    const el = await createElement<IcSkeletonView>("ic-skeleton-view", {
      variant: "dashboard",
    });
    const container = el.shadowRoot?.querySelector('[aria-label="Loading content"]');
    expect(container).toBeTruthy();
  });
});
