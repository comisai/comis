// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for MCP-to-AgentTool bridge: tool conversion, execute delegation,
 * error handling, and JSON Schema to TypeBox conversion.
 */

import { ok, err } from "@comis/shared";
import { Type } from "typebox";
import { describe, it, expect, vi } from "vitest";
import type { McpToolDefinition, McpClientManager } from "../integrations/mcp-client.js";
import { mcpToolsToAgentTools, jsonSchemaToTypeBox, sanitizeMcpToolName, extractMcpServerName, classifyMcpErrorType } from "./mcp-tool-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides?: Partial<McpToolDefinition>): McpToolDefinition {
  return {
    name: "search",
    qualifiedName: "mcp:db-server/search",
    description: "Search the database",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    ...overrides,
  };
}

function makeCallTool(): McpClientManager["callTool"] {
  return vi.fn().mockResolvedValue(
    ok({
      content: [{ type: "text", text: "search result: found 3 items" }],
      isError: false,
    }),
  );
}

// ---------------------------------------------------------------------------
// jsonSchemaToTypeBox
// ---------------------------------------------------------------------------

describe("jsonSchemaToTypeBox", () => {
  it("converts string type", () => {
    const result = jsonSchemaToTypeBox({ type: "string" });
    expect((result as any).type).toBe("string");
  });

  it("converts number type", () => {
    const result = jsonSchemaToTypeBox({ type: "number" });
    expect((result as any).type).toBe("number");
  });

  it("converts integer type", () => {
    const result = jsonSchemaToTypeBox({ type: "integer" });
    expect((result as any).type).toBe("integer");
  });

  it("converts boolean type", () => {
    const result = jsonSchemaToTypeBox({ type: "boolean" });
    expect((result as any).type).toBe("boolean");
  });

  it("converts array type with items", () => {
    const result = jsonSchemaToTypeBox({
      type: "array",
      items: { type: "string" },
    });
    expect((result as any).type).toBe("array");
  });

  it("converts array type without items to Array<Any>", () => {
    const result = jsonSchemaToTypeBox({ type: "array" });
    expect((result as any).type).toBe("array");
  });

  it("converts object type with properties and required", () => {
    const result = jsonSchemaToTypeBox({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect((result as any).type).toBe("object");
    const props = (result as any).properties;
    expect(props.name.type).toBe("string");
    // name is required, so it appears in the required array
    expect((result as any).required).toContain("name");
    // age is optional (not in required array)
    expect(props.age.type).toBe("number");
    expect((result as any).required).not.toContain("age");
  });

  it("converts object type without properties to empty Object", () => {
    const result = jsonSchemaToTypeBox({ type: "object" });
    expect((result as any).type).toBe("object");
  });

  it("falls back to Any for unknown types", () => {
    const result = jsonSchemaToTypeBox({ type: "null" });
    // typebox 1.x Any produces an empty schema {}
    expect((result as any).type).toBeUndefined();
  });

  it("falls back to Any for missing type", () => {
    const result = jsonSchemaToTypeBox({});
    expect((result as any).type).toBeUndefined();
  });

  it("handles nested objects", () => {
    const result = jsonSchemaToTypeBox({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
          required: ["street"],
        },
      },
    });
    expect((result as any).type).toBe("object");
    const addressProp = (result as any).properties.address;
    // address is optional (no required array on outer schema)
    expect(addressProp.type).toBe("object");
    expect((result as any).required ?? []).not.toContain("address");
  });
});

// ---------------------------------------------------------------------------
// mcpToolsToAgentTools
// ---------------------------------------------------------------------------

describe("mcpToolsToAgentTools", () => {
  it("converts MCP tool with string params to AgentTool", () => {
    const tools = mcpToolsToAgentTools([makeTool()], makeCallTool());

    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe("mcp__db-server--search");
    expect(tool.label).toBe("search");
    expect(tool.description).toBe("Search the database");
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("sanitizes qualified name for LLM API compatibility", () => {
    const tools = mcpToolsToAgentTools(
      [makeTool({ qualifiedName: "mcp:my-server/custom-tool" })],
      makeCallTool(),
    );
    expect(tools[0].name).toBe("mcp__my-server--custom-tool");
  });

  it("uses default description when tool has none", () => {
    const tools = mcpToolsToAgentTools([makeTool({ description: undefined })], makeCallTool());
    expect(tools[0].description).toBe("MCP tool from db-server");
  });

  it("converts MCP tool with nested object params", () => {
    const tool = makeTool({
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              field: { type: "string" },
              value: { type: "number" },
            },
          },
        },
      },
    });

    const agentTools = mcpToolsToAgentTools([tool], makeCallTool());
    expect(agentTools).toHaveLength(1);
    expect((agentTools[0].parameters as any).type).toBe("object");
  });

  it("execute() calls through to McpClientManager.callTool", async () => {
    const callTool = makeCallTool();
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const agentTool = tools[0];

    const result = await agentTool.execute("call-1", { query: "test" });

    expect(callTool).toHaveBeenCalledWith("mcp:db-server/search", { query: "test" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "search result: found 3 items",
    );
    expect(result.details).toEqual({ success: true });
  });

  it("execute() handles callTool error gracefully", async () => {
    const callTool = vi.fn().mockResolvedValue(err(new Error("Server unreachable")));
    const tools = mcpToolsToAgentTools([makeTool()], callTool);

    const result = await tools[0].execute("call-1", { query: "test" });

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("MCP tool error");
    expect(text).toContain("Server unreachable");
    expect(result.details).toEqual({ success: false });
  });

  it("execute() handles MCP isError flag", async () => {
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: "Permission denied" }],
        isError: true,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);

    const result = await tools[0].execute("call-1", {});

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Permission denied");
    expect(result.details).toEqual({ success: false });
  });

  it("execute() returns fallback text when no text content", async () => {
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "image", data: "base64data", mimeType: "image/png" }],
        isError: false,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);

    const result = await tools[0].execute("call-1", {});

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("Tool returned no text content");
    expect(result.details).toEqual({ success: true });
  });

  it("execute() catches unexpected thrown errors from callTool", async () => {
    const callTool = vi.fn().mockRejectedValue(new Error("Connection destroyed"));
    const tools = mcpToolsToAgentTools([makeTool()], callTool);

    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("crashed unexpectedly");
    expect(text).toContain("Connection destroyed");
    expect(result.details).toEqual({ success: false });
  });

  it("converts multiple tools", () => {
    const tools = mcpToolsToAgentTools(
      [
        makeTool({ name: "search", qualifiedName: "mcp:srv/search" }),
        makeTool({ name: "insert", qualifiedName: "mcp:srv/insert" }),
        makeTool({ name: "delete", qualifiedName: "mcp:srv/delete" }),
      ],
      makeCallTool(),
    );

    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__srv--search",
      "mcp__srv--insert",
      "mcp__srv--delete",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Source-gate truncation
// ---------------------------------------------------------------------------

describe("mcpToolsToAgentTools source-gate truncation", () => {
  it("truncates text exceeding mcp_default maxChars (50K)", async () => {
    // Generate text larger than the 50K default
    const largeText = "x".repeat(60_000);
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: largeText }],
        isError: false,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    // Should be truncated to at most 50K chars with no trailing marker
    expect(text.length).toBeLessThan(60_000);
    expect(text).not.toContain("[MCP tool result truncated");
    expect(result.details).toEqual({ success: true });
  });

  it("passes through text under maxChars unchanged", async () => {
    const smallText = "search result: found 3 items";
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: smallText }],
        isError: false,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe(smallText);
    expect(text).not.toContain("[MCP tool result truncated");
  });

  it("does NOT truncate error results (isError: true)", async () => {
    const largeError = "E".repeat(60_000);
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: largeError }],
        isError: true,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", {});

    const text = (result.content[0] as { type: "text"; text: string }).text;
    // Error results pass through without truncation
    expect(text).toBe(largeError);
    expect(text).not.toContain("[MCP tool result truncated");
    expect(result.details).toEqual({ success: false });
  });

  it("custom toolSourceProfiles override the default maxChars", async () => {
    const mediumText = "z".repeat(25_000);
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: mediumText }],
        isError: false,
      }),
    );
    // Override the mcp__db-server--search tool to have a 20K char limit
    const tools = mcpToolsToAgentTools([makeTool()], callTool, {
      "mcp__db-server--search": { maxChars: 20_000 },
    });
    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).not.toContain("[MCP tool result truncated");
  });

  it("works correctly with no toolSourceProfiles argument (backward compatible)", async () => {
    const smallText = "hello world";
    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: smallText }],
        isError: false,
      }),
    );
    // No third argument -- should use mcp_default profile
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", {});

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe(smallText);
    expect(result.details).toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------------
// JSON-aware truncation in source-gate
// ---------------------------------------------------------------------------

describe("mcpToolsToAgentTools JSON-aware truncation in source-gate", () => {
  it("JSON array result truncated at structural boundary produces valid JSON", async () => {
    // Create a large JSON array exceeding default 50K maxChars
    const items = Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      ticker: `TICK${i}`,
      price: Math.random() * 1000,
      volume: Math.floor(Math.random() * 1e6),
      description: `Stock item ${i} with some data padding`,
    }));
    const largeJson = JSON.stringify(items);
    expect(largeJson.length).toBeGreaterThan(50_000);

    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: largeJson }],
        isError: false,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("[MCP tool result truncated");

    // The text IS the JSON now -- parse directly
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(1000);
    // Each element should be complete
    expect(parsed[0]).toHaveProperty("id");
    expect(parsed[0]).toHaveProperty("ticker");
  });

  it("JSON object result truncated at structural boundary produces valid JSON", async () => {
    // Create a large JSON object exceeding default 50K maxChars
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) {
      obj[`metric_${i}`] = {
        value: Math.random() * 100,
        label: `Metric ${i} ${"padding".repeat(10)}`,
        timestamp: Date.now(),
      };
    }
    const largeJson = JSON.stringify(obj);
    expect(largeJson.length).toBeGreaterThan(50_000);

    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: largeJson }],
        isError: false,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("[MCP tool result truncated");

    // The text IS the JSON now -- parse directly
    const parsed = JSON.parse(text);
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
    const keys = Object.keys(parsed);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.length).toBeLessThan(500);
  });

  it("non-JSON result still uses plain slice (backward compatible)", async () => {
    const largePlainText = "This is plain text output from an MCP tool. ".repeat(2000);
    expect(largePlainText.length).toBeGreaterThan(50_000);

    const callTool = vi.fn().mockResolvedValue(
      ok({
        content: [{ type: "text", text: largePlainText }],
        isError: false,
      }),
    );
    const tools = mcpToolsToAgentTools([makeTool()], callTool);
    const result = await tools[0].execute("call-1", { query: "test" });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).not.toContain("[MCP tool result truncated");

    // Plain slice: should be exactly maxChars long (50000) with no appended marker
    expect(text.length).toBe(50_000);
    expect(text).toBe(largePlainText.slice(0, 50_000));
  });
});

// ---------------------------------------------------------------------------
// sanitizeMcpToolName
// ---------------------------------------------------------------------------

describe("sanitizeMcpToolName", () => {
  it("replaces colon with double underscore and slash with double dash", () => {
    expect(sanitizeMcpToolName("mcp:context7/resolve-library-id")).toBe(
      "mcp__context7--resolve-library-id",
    );
  });

  it("handles multiple colons and slashes", () => {
    expect(sanitizeMcpToolName("mcp:srv:v2/ns/tool")).toBe("mcp__srv__v2--ns--tool");
  });

  it("passes through names with no special characters", () => {
    expect(sanitizeMcpToolName("simple_tool")).toBe("simple_tool");
  });

  it("produces names matching LLM API pattern", () => {
    const sanitized = sanitizeMcpToolName("mcp:my-server/my-tool");
    expect(sanitized).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });
});

// ---------------------------------------------------------------------------
// extractMcpServerName
// ---------------------------------------------------------------------------

describe("extractMcpServerName", () => {
  it("extracts server name from standard sanitized MCP tool name", () => {
    expect(extractMcpServerName("mcp__context7--resolve-library-id")).toBe("context7");
  });

  it("extracts server name when server name contains double underscores (colon replacement)", () => {
    expect(extractMcpServerName("mcp__srv__v2--ns--tool")).toBe("srv__v2");
  });

  it("extracts server name from minimal MCP tool name", () => {
    expect(extractMcpServerName("mcp__server--tool")).toBe("server");
  });

  it("returns undefined for non-MCP tool", () => {
    expect(extractMcpServerName("bash")).toBeUndefined();
  });

  it("returns undefined for malformed name with no separator", () => {
    expect(extractMcpServerName("mcp__")).toBeUndefined();
  });

  it("returns undefined for name with prefix but no double-dash separator", () => {
    expect(extractMcpServerName("mcp__server")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// classifyMcpErrorType
// ---------------------------------------------------------------------------

describe("classifyMcpErrorType", () => {
  it("classifies timeout errors", () => {
    expect(classifyMcpErrorType("Request timed out after 30s")).toBe("timeout");
  });

  it("classifies connection errors (not connected)", () => {
    expect(classifyMcpErrorType("Server not connected")).toBe("connection");
  });

  it("classifies connection errors (disconnected)", () => {
    expect(classifyMcpErrorType("Server disconnected")).toBe("connection");
  });

  it("classifies transport errors (crashed unexpectedly)", () => {
    expect(classifyMcpErrorType("Process crashed unexpectedly")).toBe("transport");
  });

  it("classifies tool_error from MCP tool error prefix", () => {
    expect(classifyMcpErrorType("MCP tool error: invalid input")).toBe("tool_error");
  });

  it("classifies tool_error from MCP tool returned an error", () => {
    expect(classifyMcpErrorType("MCP tool returned an error")).toBe("tool_error");
  });

  it("returns unknown for unrecognized error text", () => {
    expect(classifyMcpErrorType("Some unknown error")).toBe("unknown");
  });

  it("returns unknown for undefined error text", () => {
    expect(classifyMcpErrorType(undefined)).toBe("unknown");
  });
});
