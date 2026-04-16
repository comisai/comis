import { describe, it, expect, afterEach } from "vitest";
import type { IcMcpManagement } from "./mcp-management.js";

// Side-effect import to register custom element
import "./mcp-management.js";

describe("IcMcpManagement", () => {
  let el: IcMcpManagement;

  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("is defined as a custom element", () => {
    const ctor = customElements.get("ic-mcp-management");
    expect(ctor).toBeDefined();
  });

  it("renders with loading state initially when no rpcClient", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);

    expect(el).toBeDefined();
    expect(el.tagName.toLowerCase()).toBe("ic-mcp-management");
    expect(el.rpcClient).toBeNull();
  });

  it("renders reconnecting status with attempt counter", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);

    // Force into loaded state with reconnecting server
    (el as any)._loadState = "loaded";
    (el as any)._servers = [{
      name: "test-server",
      status: "reconnecting",
      toolCount: 5,
      reconnectAttempt: 3,
    }];
    await el.updateComplete;

    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag?.textContent?.trim()).toContain("reconnecting (3)");
    expect(tag?.getAttribute("color")).toBe("yellow");
  });

  it("renders error status with error details", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);

    (el as any)._loadState = "loaded";
    (el as any)._servers = [{
      name: "test-server",
      status: "error",
      toolCount: 0,
      error: "Connection refused: ECONNREFUSED",
    }];
    await el.updateComplete;

    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag?.getAttribute("color")).toBe("red");

    const errorSpan = el.shadowRoot?.querySelector(".server-error");
    expect(errorSpan?.textContent).toContain("Connection refused: ECONNREFUSED");
  });

  it("does not render error details when status is error but no error message", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);

    (el as any)._loadState = "loaded";
    (el as any)._servers = [{
      name: "test-server",
      status: "error",
      toolCount: 0,
    }];
    await el.updateComplete;

    const errorSpan = el.shadowRoot?.querySelector(".server-error");
    expect(errorSpan).toBeNull();
  });
});
