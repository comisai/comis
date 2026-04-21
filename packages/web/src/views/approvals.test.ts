// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import type { IcApprovalsView } from "./approvals.js";

// Side-effect import to register custom element
import "./approvals.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function createElement(): Promise<IcApprovalsView> {
  const el = document.createElement("ic-approvals-view") as IcApprovalsView;
  document.body.appendChild(el);
  await (el as any).updateComplete;
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("IcApprovalsView", () => {
  it("renders redirect title", async () => {
    const el = await createElement();
    const title = el.shadowRoot?.querySelector(".redirect-title");
    expect(title).not.toBeNull();
    expect(title?.textContent).toContain("Approvals Moved");
  });

  it("renders redirect description pointing to Security view", async () => {
    const el = await createElement();
    const desc = el.shadowRoot?.querySelector(".redirect-desc");
    expect(desc).not.toBeNull();
    expect(desc?.textContent).toContain("Security view");
  });

  it("renders Go to Security button", async () => {
    const el = await createElement();
    const btn = el.shadowRoot?.querySelector(".redirect-btn");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("Go to Security");
  });

  it("button navigates to security hash", async () => {
    const el = await createElement();
    const btn = el.shadowRoot?.querySelector(".redirect-btn") as HTMLElement;
    btn.click();
    expect(window.location.hash).toBe("#security");
  });
});
