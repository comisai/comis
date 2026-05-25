// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the GLOBAL resources platform tools (mcp-resources-tool.ts):
 * list_resources + read_resource.
 *
 * Covers:
 *  - factory `.name` is the GLOBAL fixed name (not per-server)
 *  - `parameters` carries a required `server` string
 *  - execute over a connected resources-capable server returns the resource
 *    list as JSON text + details.success === true
 *  - read_resource delegates to readResourceFromServer
 *  - an adapter err (server not connected) surfaces as an error-shaped result
 *    (details.success === false), NOT a throw
 */

import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createListResourcesTool,
  createReadResourceTool,
} from "./mcp-resources-tool.js";
import type {
  McpClientManager,
  McpConnection,
} from "../../skills/integrations/mcp-client/mcp-client-types.js";

function makeManager(conn: McpConnection | undefined): McpClientManager {
  return { getConnection: () => conn } as unknown as McpClientManager;
}

function makeConnection(client: Partial<Client>): McpConnection {
  return {
    name: "fs",
    client: client as unknown as Client,
    status: "connected",
    tools: [],
    lastHealthCheck: 0,
    reconnectAttempt: 0,
    maxReconnectAttempts: 5,
    generation: 0,
    // The adapters re-enforce the capability gate on the live connection,
    // so a connected server must advertise the capability.
    capabilities: { resources: {}, prompts: {} },
  };
}

describe("createListResourcesTool / createReadResourceTool global resources tools", () => {
  it("exposes the fixed global name list_resources with a required server parameter", () => {
    const tool = createListResourcesTool(makeManager(undefined));
    expect(tool.name).toBe("list_resources");
    const props = (tool.parameters as { properties?: Record<string, unknown>; required?: string[] });
    expect(props.properties).toHaveProperty("server");
    expect(props.required).toContain("server");
  });

  it("returns the resource list as JSON text with details.success true on the happy path", async () => {
    const conn = makeConnection({
      listResources: async () => ({ resources: [{ uri: "file://a", name: "a" }] }),
    });
    const tool = createListResourcesTool(makeManager(conn));
    const result = await tool.execute("call-1", { server: "fs" } as never);
    expect(result.details).toMatchObject({ success: true });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("file://a");
  });

  it("surfaces an adapter not-connected err as an error-shaped result, not a throw", async () => {
    const tool = createListResourcesTool(makeManager(undefined));
    const result = await tool.execute("call-2", { server: "missing" } as never);
    expect(result.details).toMatchObject({ success: false });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("not connected");
  });

  it("exposes read_resource and delegates execute to readResourceFromServer", async () => {
    const conn = makeConnection({
      readResource: async (req: { uri: string }) => ({
        contents: [{ uri: req.uri, text: "hello" }],
      }),
    });
    const tool = createReadResourceTool(makeManager(conn));
    expect(tool.name).toBe("read_resource");
    // Use a custom MCP scheme — file:/http:/https: are SSRF-blocked.
    const result = await tool.execute("call-3", { server: "fs", uri: "res://a" } as never);
    expect(result.details).toMatchObject({ success: true });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("hello");
  });
});
