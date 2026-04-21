// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";

// Import side-effect to register custom element
import "./context-dag-browser.js";
import type { IcContextDagBrowser } from "./context-dag-browser.js";

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

describe("IcContextDagBrowser", () => {
  it("is registered as a custom element", () => {
    expect(customElements.get("ic-context-dag-browser")).toBeDefined();
  });

  it("renders loading state when no rpcClient is set", async () => {
    const el = await createElement<IcContextDagBrowser>("ic-context-dag-browser");
    const loading = el.shadowRoot?.querySelector("ic-loading");
    expect(loading).toBeTruthy();
  });

  it("has shadow root", async () => {
    const el = await createElement<IcContextDagBrowser>("ic-context-dag-browser");
    expect(el.shadowRoot).toBeTruthy();
  });
});
