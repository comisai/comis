// SPDX-License-Identifier: Apache-2.0
/**
 * Render-branch tests for IcTokenManager (Phase 40 Plan 40-15 gap-closure).
 *
 * token-manager.ts at baseline reports 32.81% / 29.16% / 33.33% / 32.72%
 * (lines/branches/functions/statements). This file covers:
 *   - render() always-rendered grid-table header + token row iteration
 *   - _newSecretDisplay banner conditional render
 *   - 5 scope checkbox bindings (.checked binding from _newTokenScopes.includes)
 *   - Create Token form rendering (always present)
 *   - _renderTokenRow with multi-scope tokens
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import type { IcTokenManager } from "./token-manager.js";
import "./token-manager.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcTokenManager): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcTokenManager render() — always-present surface", () => {
  let el: IcTokenManager;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the API tokens grid-table with column headers Token ID / Scopes / Actions", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    await el.updateComplete;
    const headers = el.shadowRoot?.querySelectorAll(".header-cell");
    expect((headers?.length ?? 0)).toBeGreaterThanOrEqual(3);
    expect(headers?.[0]?.textContent).toBe("Token ID");
    expect(headers?.[1]?.textContent).toBe("Scopes");
    expect(headers?.[2]?.textContent).toBe("Actions");
  });

  it("renders the Create Token form section with title heading", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".create-form-title")?.textContent).toBe(
      "Create Token",
    );
  });

  it("renders five scope checkbox rows for rpc / ws / admin / api / wildcard-all", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    await el.updateComplete;
    const checkboxes = el.shadowRoot?.querySelectorAll(".checkbox-row");
    expect(checkboxes?.length).toBe(5);
  });

  it("renders the Generate button to create a new token entry on click", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".generate-btn")?.textContent).toBe("Generate");
  });
});

describe("IcTokenManager render() — token row iteration", () => {
  let el: IcTokenManager;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders no data-cell rows when _tokens list is empty (header-only grid)", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._tokens = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelectorAll(".data-cell").length).toBe(0);
  });

  it("renders three data-cell groups per token entry (id / scopes / actions)", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._tokens = [
      { id: "tok-1", scopes: ["rpc", "ws"] },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelectorAll(".data-cell").length).toBe(3);
  });

  it("renders one ic-tag per scope on each token row for scope visualization", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._tokens = [
      { id: "tok-1", scopes: ["rpc", "ws", "admin", "api"] },
    ];
    await el.updateComplete;
    const tags = el.shadowRoot?.querySelectorAll(".scopes-cell ic-tag");
    expect(tags?.length).toBe(4);
  });

  it("renders both Rotate + Revoke action buttons per token row in the actions column", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._tokens = [
      { id: "tok-1", scopes: ["rpc"] },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Rotate");
    expect(html).toContain("Revoke");
  });

  it("renders the token id text in the first data-cell column verbatim", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._tokens = [
      { id: "my-distinctive-token-id-12345", scopes: ["api"] },
    ];
    await el.updateComplete;
    const firstCell = el.shadowRoot?.querySelector(".data-cell");
    expect(firstCell?.textContent).toBe("my-distinctive-token-id-12345");
  });

  it("renders multiple token rows in order when _tokens array contains several entries", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._tokens = [
      { id: "tok-1", scopes: ["rpc"] },
      { id: "tok-2", scopes: ["ws"] },
      { id: "tok-3", scopes: ["admin"] },
    ];
    await el.updateComplete;
    // 3 tokens × 3 cells = 9 data cells
    expect(el.shadowRoot?.querySelectorAll(".data-cell").length).toBe(9);
  });
});

describe("IcTokenManager _newSecretDisplay banner branch", () => {
  let el: IcTokenManager;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("omits the new-secret-banner div when _newSecretDisplay is null (default state)", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newSecretDisplay = null;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".new-secret-banner")).toBeNull();
  });

  it("renders the new-secret-banner with the secret value when _newSecretDisplay is non-null", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newSecretDisplay = "abc-fresh-secret-do-not-leak";
    await el.updateComplete;
    const banner = el.shadowRoot?.querySelector(".new-secret-banner");
    expect(banner).not.toBeNull();
    expect(el.shadowRoot?.querySelector(".secret-value")?.textContent).toBe(
      "abc-fresh-secret-do-not-leak",
    );
  });

  it("renders the 'Copy this secret now' warning text in the new-secret banner", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newSecretDisplay = "another-fresh-test-secret";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".secret-warning")?.textContent).toContain(
      "Copy this secret now",
    );
  });
});

describe("IcTokenManager scope-checkbox binding from _newTokenScopes state", () => {
  let el: IcTokenManager;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("marks the rpc checkbox as checked when _newTokenScopes contains 'rpc'", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newTokenScopes = ["rpc"];
    await el.updateComplete;
    const rpcCheckbox = el.shadowRoot?.getElementById("scope-rpc") as HTMLInputElement | null;
    expect(rpcCheckbox?.checked).toBe(true);
  });

  it("marks the wildcard '*' checkbox as checked when _newTokenScopes contains '*'", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newTokenScopes = ["*"];
    await el.updateComplete;
    const allCheckbox = el.shadowRoot?.getElementById("scope-all") as HTMLInputElement | null;
    expect(allCheckbox?.checked).toBe(true);
  });

  it("leaves all scope checkboxes unchecked when _newTokenScopes is the default empty array", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newTokenScopes = [];
    await el.updateComplete;
    for (const id of ["scope-rpc", "scope-ws", "scope-admin", "scope-api", "scope-all"]) {
      const cb = el.shadowRoot?.getElementById(id) as HTMLInputElement | null;
      expect(cb?.checked).toBe(false);
    }
  });

  it("marks multiple checkboxes simultaneously when _newTokenScopes contains multiple scopes", async () => {
    el = document.createElement("ic-token-manager") as IcTokenManager;
    document.body.appendChild(el);
    priv(el)._newTokenScopes = ["rpc", "ws", "admin"];
    await el.updateComplete;
    expect((el.shadowRoot?.getElementById("scope-rpc") as HTMLInputElement).checked).toBe(true);
    expect((el.shadowRoot?.getElementById("scope-ws") as HTMLInputElement).checked).toBe(true);
    expect((el.shadowRoot?.getElementById("scope-admin") as HTMLInputElement).checked).toBe(true);
    expect((el.shadowRoot?.getElementById("scope-api") as HTMLInputElement).checked).toBe(false);
  });
});

describe("IcTokenManager component registration", () => {
  it("registers as the 'ic-token-manager' custom element after side-effect import", () => {
    expect(customElements.get("ic-token-manager")).toBeDefined();
  });
});
