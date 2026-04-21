// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import type { IcSubagentsView } from "./subagents.js";

// Side-effect import to register custom element
import "./subagents.js";

describe("IcSubagentsView", () => {
  let el: IcSubagentsView;

  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("is defined as a custom element", () => {
    const ctor = customElements.get("ic-subagents-view");
    expect(ctor).toBeDefined();
  });

  it("renders with loading state initially when no rpcClient", () => {
    el = document.createElement("ic-subagents-view") as IcSubagentsView;
    document.body.appendChild(el);

    expect(el).toBeDefined();
    expect(el.tagName.toLowerCase()).toBe("ic-subagents-view");
    expect(el.rpcClient).toBeNull();
  });
});
