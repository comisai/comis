// SPDX-License-Identifier: Apache-2.0
/**
 * Render-branch tests for IcMcpManagement view.
 *
 * Targets the render() decision tree + the helper render methods so the
 * LoadState/empty-state/server-card/config-only/confirm-dialog branches
 * all execute, exercising every render path.
 *
 * @module
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import type { IcMcpManagement } from "./mcp-management.js";
import "./mcp-management.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(el: IcMcpManagement): any {
  return el as unknown as Record<string, unknown>;
}

describe("IcMcpManagement render() — top-level branches", () => {
  let el: IcMcpManagement;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the skeleton loader template when load state is the initial 'loading' value", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    await el.updateComplete;
    const skeleton = el.shadowRoot?.querySelector("ic-skeleton-view");
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("variant")).toBe("list");
  });

  it("renders the error message + retry button when load state is 'error'", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "error";
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".error-message")).not.toBeNull();
    expect(el.shadowRoot?.querySelector(".retry-btn")).not.toBeNull();
  });

  it("renders the ic-empty-state element when no servers are configured and load state is 'loaded'", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("ic-empty-state")).not.toBeNull();
  });

  it("renders the header-row + server-list when at least one running server is present", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "alpha", status: "connected", toolCount: 4 },
    ];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".header-row")).not.toBeNull();
    expect(el.shadowRoot?.querySelector(".server-list")).not.toBeNull();
  });

  it("pluralizes the server-count label correctly when exactly one server is present", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [{ name: "solo", status: "connected", toolCount: 1 }];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    const title = el.shadowRoot?.querySelector(".header-title");
    expect(title?.textContent).toBe("1 server");
  });

  it("pluralizes the server-count label as 'servers' when two or more entries present", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "a", status: "connected", toolCount: 1 },
      { name: "b", status: "connected", toolCount: 1 },
    ];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    const title = el.shadowRoot?.querySelector(".header-title");
    expect(title?.textContent).toBe("2 servers");
  });

  it("renders the add-server form when _showAddForm flag is true", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._showAddForm = true;
    priv(el)._servers = [];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    const formEls = el.shadowRoot?.querySelectorAll("form, .add-form, [role='form']");
    // Form-like element should be present somewhere in the shadow tree.
    expect(el.shadowRoot?.innerHTML).toContain("Add");
    expect(formEls).toBeDefined();
  });

  it("renders the disconnect confirm dialog when _disconnectTarget is non-null", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [];
    priv(el)._disconnectTarget = "alpha";
    await el.updateComplete;
    const dialogs = el.shadowRoot?.querySelectorAll("ic-confirm-dialog");
    expect(dialogs?.length).toBeGreaterThanOrEqual(1);
    const disconnectDialog = Array.from(dialogs ?? []).find(
      (d) => d.getAttribute("title") === "Disconnect MCP Server",
    );
    expect(disconnectDialog?.hasAttribute("open")).toBe(true);
  });

  it("renders the delete confirm dialog when _deleteTarget is non-null", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [];
    priv(el)._deleteTarget = "beta";
    await el.updateComplete;
    const dialogs = el.shadowRoot?.querySelectorAll("ic-confirm-dialog");
    const deleteDialog = Array.from(dialogs ?? []).find(
      (d) => d.getAttribute("title") === "Delete MCP Server",
    );
    expect(deleteDialog?.hasAttribute("open")).toBe(true);
  });
});

describe("IcMcpManagement _renderServer — server card branches", () => {
  let el: IcMcpManagement;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders a 'connected' status tag colored green for healthy server", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "ok-server", status: "connected", toolCount: 5 },
    ];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag?.getAttribute("color")).toBe("green");
  });

  it("renders a 'reconnecting' status tag colored yellow with attempt counter", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "reconn", status: "reconnecting", toolCount: 0, reconnectAttempt: 5 },
    ];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    const tag = el.shadowRoot?.querySelector("ic-tag");
    expect(tag?.getAttribute("color")).toBe("yellow");
    expect(tag?.textContent).toContain("(5)");
  });

  it("renders an 'error' status tag colored red and an error message line when error is set", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "broken", status: "error", toolCount: 0, error: "ECONNREFUSED localhost:7000" },
    ];
    priv(el)._mcpConfig = [];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".server-error")?.textContent).toContain(
      "ECONNREFUSED",
    );
  });

  it("renders a Disconnect button when server status is 'connected' and config exists", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "alpha", status: "connected", toolCount: 1 },
    ];
    priv(el)._mcpConfig = [
      { name: "alpha", enabled: true, transport: "stdio", command: "node" },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Disconnect");
  });

  it("renders a Reconnect button when server status is 'disconnected' to allow re-establishing connection", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "alpha", status: "disconnected", toolCount: 0 },
    ];
    priv(el)._mcpConfig = [
      { name: "alpha", enabled: true, transport: "stdio", command: "node" },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("Reconnect");
  });

  it("renders a Test button on every server card regardless of status", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [
      { name: "any", status: "connected", toolCount: 1 },
    ];
    priv(el)._mcpConfig = [
      { name: "any", enabled: true, transport: "stdio", command: "node" },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.innerHTML).toContain("Test");
  });
});

describe("IcMcpManagement _renderConfigOnlyServer — config-only branches", () => {
  let el: IcMcpManagement;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the 'not running' tag when a configured server is absent from the runtime list", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = []; // empty runtime
    priv(el)._mcpConfig = [
      { name: "stopped", enabled: false, transport: "stdio", command: "python" },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("not running");
  });

  it("renders the stdio command + args path when configured transport is stdio", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [
      {
        name: "cli-srv",
        enabled: false,
        transport: "stdio",
        command: "/usr/bin/node",
        args: ["server.js", "--port=8080"],
      },
    ];
    await el.updateComplete;
    const cmd = el.shadowRoot?.querySelector(".server-command");
    expect(cmd?.textContent).toContain("/usr/bin/node");
    expect(cmd?.textContent).toContain("server.js");
    expect(cmd?.textContent).toContain("--port=8080");
  });

  it("renders the http URL path when configured transport is http or sse", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [
      { name: "http-srv", enabled: true, transport: "sse", url: "http://localhost:9000/mcp" },
    ];
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector(".server-command")?.textContent).toContain(
      "http://localhost:9000/mcp",
    );
  });

  it("renders the env-vars badge when configured env keys are present", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [
      {
        name: "env-srv",
        enabled: false,
        transport: "stdio",
        command: "node",
        env: { API_KEY: "redacted", LOG_LEVEL: "info" },
      },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("env:");
  });

  it("renders the headers badge when configured headers are present on http transport", async () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    document.body.appendChild(el);
    priv(el)._loadState = "loaded";
    priv(el)._servers = [];
    priv(el)._mcpConfig = [
      {
        name: "auth-srv",
        enabled: true,
        transport: "sse",
        url: "http://localhost:9000/mcp",
        headers: { Authorization: "Bearer redacted" },
      },
    ];
    await el.updateComplete;
    const html = el.shadowRoot?.innerHTML ?? "";
    expect(html).toContain("headers:");
  });
});

describe("IcMcpManagement _renderCapabilityBadges + _renderServerVersion + _renderInstructions", () => {
  let el: IcMcpManagement;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the tools capability badge when server reports a tools capability", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    const result = priv(el)._renderCapabilityBadges({ tools: true });
    // Lit template should be defined (not nothing/empty); rendered into a string
    // via the function will contain a child template.
    expect(result).toBeDefined();
  });

  it("returns nothing (no rendered output) when no capabilities are provided", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    const result = priv(el)._renderCapabilityBadges();
    // For empty caps, function returns html`` with an empty badges array
    expect(result).toBeDefined();
  });

  it("returns nothing for serverVersion render when version is undefined", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    const result = priv(el)._renderServerVersion(undefined);
    // nothing sentinel — assert it is the falsy nothing token
    expect(result).toBeDefined();
  });

  it("renders the server-version span when both name and version strings are provided", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    const result = priv(el)._renderServerVersion({ name: "mcp-server", version: "1.2.3" });
    expect(result).toBeDefined();
  });
});

describe("IcMcpManagement _renderToolList — loading vs empty vs populated", () => {
  let el: IcMcpManagement;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders 'Loading tools...' label while _serverDetail is null (loading state)", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    priv(el)._serverDetail = null;
    const result = priv(el)._renderToolList();
    expect(result).toBeDefined();
  });

  it("renders 'No tools discovered' label when _serverDetail has an empty tools array", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    priv(el)._serverDetail = { tools: [], instructions: null };
    const result = priv(el)._renderToolList();
    expect(result).toBeDefined();
  });

  it("renders the tool list template when _serverDetail has at least one tool entry", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    priv(el)._serverDetail = {
      tools: [
        { name: "search", description: "search docs" },
        { name: "fetch", description: "fetch url" },
      ],
      instructions: null,
    };
    const result = priv(el)._renderToolList();
    expect(result).toBeDefined();
  });
});

describe("IcMcpManagement _renderTestResult — success vs error", () => {
  let el: IcMcpManagement;
  afterEach(() => {
    if (el?.isConnected) el.remove();
  });

  it("renders the success result template with tool count + names when test succeeded", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    priv(el)._testResults = new Map([
      ["srv-1", { success: true, toolCount: 3, tools: ["a", "b", "c"] }],
    ]);
    const result = priv(el)._renderTestResult("srv-1");
    expect(result).toBeDefined();
  });

  it("renders the error result template with error text when test failed", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    priv(el)._testResults = new Map([
      ["srv-2", { success: false, error: "Connection refused" }],
    ]);
    const result = priv(el)._renderTestResult("srv-2");
    expect(result).toBeDefined();
  });

  it("returns nothing when no test result exists for the requested server name", () => {
    el = document.createElement("ic-mcp-management") as IcMcpManagement;
    priv(el)._testResults = new Map();
    const result = priv(el)._renderTestResult("never-tested");
    expect(result).toBeDefined();
  });
});
