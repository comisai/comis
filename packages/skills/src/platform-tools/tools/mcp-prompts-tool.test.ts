// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the GLOBAL prompts platform tools
 * (mcp-prompts-tool.ts): list_prompts + get_prompt.
 *
 * Covers:
 *  - fixed global names list_prompts / get_prompt
 *  - get_prompt parameters: required server + name, optional arguments record
 *  - execute delegates to listPromptsForServer / getPromptFromServer
 *  - an adapter err surfaces as an error-shaped result (details.success false)
 */

import { describe, it, expect } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  createListPromptsTool,
  createGetPromptTool,
} from "./mcp-prompts-tool.js";
import type {
  McpClientManager,
  McpConnection,
} from "../../skills/integrations/mcp-client/mcp-client-types.js";

function makeManager(conn: McpConnection | undefined): McpClientManager {
  return { getConnection: () => conn } as unknown as McpClientManager;
}

function makeConnection(client: Partial<Client>): McpConnection {
  return {
    name: "kb",
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

describe("createListPromptsTool / createGetPromptTool global prompts tools", () => {
  it("exposes the fixed global name list_prompts with a required server parameter", () => {
    const tool = createListPromptsTool(makeManager(undefined));
    expect(tool.name).toBe("list_prompts");
    const props = (tool.parameters as { properties?: Record<string, unknown>; required?: string[] });
    expect(props.properties).toHaveProperty("server");
    expect(props.required).toContain("server");
  });

  it("returns the prompt list as JSON text with details.success true", async () => {
    const conn = makeConnection({
      listPrompts: async () => ({ prompts: [{ name: "greet", description: "say hi" }] }),
    });
    const tool = createListPromptsTool(makeManager(conn));
    const result = await tool.execute("call-1", { server: "kb" } as never);
    expect(result.details).toMatchObject({ success: true });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("greet");
  });

  it("exposes get_prompt requiring server + name with an optional arguments record", () => {
    const tool = createGetPromptTool(makeManager(undefined));
    expect(tool.name).toBe("get_prompt");
    const props = (tool.parameters as { properties?: Record<string, unknown>; required?: string[] });
    expect(props.properties).toHaveProperty("server");
    expect(props.properties).toHaveProperty("name");
    expect(props.properties).toHaveProperty("arguments");
    expect(props.required).toContain("server");
    expect(props.required).toContain("name");
    expect(props.required).not.toContain("arguments");
  });

  it("delegates get_prompt execute to getPromptFromServer with name + arguments", async () => {
    const conn = makeConnection({
      getPrompt: async (req: { name: string; arguments?: Record<string, unknown> }) => ({
        description: `prompt:${req.name}`,
        messages: [{ role: "user", content: { type: "text", text: "hi" } }],
      }),
    });
    const tool = createGetPromptTool(makeManager(conn));
    const result = await tool.execute(
      "call-2",
      { server: "kb", name: "greet", arguments: { who: "world" } } as never,
    );
    expect(result.details).toMatchObject({ success: true });
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("prompt:greet");
  });

  it("surfaces an adapter not-connected err as an error-shaped result for prompts", async () => {
    const tool = createListPromptsTool(makeManager(undefined));
    const result = await tool.execute("call-3", { server: "missing" } as never);
    expect(result.details).toMatchObject({ success: false });
  });
});
