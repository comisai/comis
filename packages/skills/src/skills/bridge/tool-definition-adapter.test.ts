// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { agentToolToToolDefinition, agentToolsToToolDefinitions } from "./tool-definition-adapter.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockTool(overrides?: Partial<AgentTool<any>>): AgentTool<any> {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "A test tool for unit testing",
    parameters: Type.Object({
      query: Type.String(),
    }),
    execute: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      details: { ok: true },
    } satisfies AgentToolResult<unknown>),
    ...overrides,
  };
}

const fakeCtx = {} as ExtensionContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agentToolToToolDefinition", () => {
  it("preserves tool name, label, and description exactly", () => {
    const tool = createMockTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search through stored memories",
    });
    const def = agentToolToToolDefinition(tool);

    expect(def.name).toBe("memory_search");
    expect(def.label).toBe("Memory Search");
    expect(def.description).toBe("Search through stored memories");
  });

  it("preserves tool parameters schema", () => {
    const params = Type.Object({
      query: Type.String({ description: "Semantic search query" }),
      limit: Type.Optional(Type.Integer({ default: 10 })),
    });
    const tool = createMockTool({ parameters: params });
    const def = agentToolToToolDefinition(tool);

    expect(def.parameters).toBe(params);
  });

  it("forwards execute args to underlying AgentTool (toolCallId, params, signal, onUpdate)", async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: {},
    });
    const tool = createMockTool({ execute: mockExecute });
    const def = agentToolToToolDefinition(tool);

    const signal = new AbortController().signal;
    const onUpdate = vi.fn();
    const params = { query: "test" };

    await def.execute("call-123", params, signal, onUpdate, fakeCtx);

    expect(mockExecute).toHaveBeenCalledOnce();
    expect(mockExecute).toHaveBeenCalledWith("call-123", params, signal, onUpdate);
  });

  it("ignores ExtensionContext parameter", async () => {
    const mockExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: {},
    });
    const tool = createMockTool({ execute: mockExecute });
    const def = agentToolToToolDefinition(tool);

    // Call with different ExtensionContext values -- underlying tool should never see them
    await def.execute("call-1", {}, undefined, undefined, fakeCtx);
    await def.execute("call-2", {}, undefined, undefined, {} as ExtensionContext);

    // Both calls should forward without ctx
    for (const call of mockExecute.mock.calls) {
      expect(call.length).toBe(4); // toolCallId, params, signal, onUpdate -- no ctx
    }
  });

  it("returns AgentToolResult from underlying tool", async () => {
    const expectedResult: AgentToolResult<unknown> = {
      content: [{ type: "text", text: '{"found":5}' }],
      details: { found: 5 },
    };
    const tool = createMockTool({
      execute: vi.fn().mockResolvedValue(expectedResult),
    });
    const def = agentToolToToolDefinition(tool);

    const result = await def.execute("call-1", {}, undefined, undefined, fakeCtx);

    expect(result).toBe(expectedResult);
  });

  it("uses lean description when resolvedDescriptions provided", () => {
    const tool = createMockTool({
      name: "memory_search",
      description: "Search past conversations, preferences, and stored facts",
    });
    const resolved = { memory_search: "Search stored facts. For session history, use session_search." };
    const def = agentToolToToolDefinition(tool, resolved);

    expect(def.description).toBe("Search stored facts. For session history, use session_search.");
  });

  it("falls back to tool.description when resolvedDescriptions lacks entry", () => {
    const tool = createMockTool({
      name: "my_custom_tool",
      description: "Original description",
    });
    const resolved = { memory_search: "Lean memory search" };
    const def = agentToolToToolDefinition(tool, resolved);

    expect(def.description).toBe("Original description");
  });

  it("uses tool.description when resolvedDescriptions is undefined", () => {
    const tool = createMockTool({
      description: "A test tool for unit testing",
    });
    const def = agentToolToToolDefinition(tool);

    expect(def.description).toBe("A test tool for unit testing");
  });

  it("handles tools with no label (falls back to name)", () => {
    const tool = createMockTool({
      name: "web_fetch",
      label: undefined,
    });
    const def = agentToolToToolDefinition(tool);

    expect(def.label).toBe("web_fetch");
  });

  it("merges promptGuidelines into description", () => {
    const tool = createMockTool({
      name: "exec",
      description: "Execute a shell command.",
    }) as AgentTool<any> & { promptGuidelines: string[] };
    tool.promptGuidelines = ["Do X before Y.", "Prefer Z over W."];

    const def = agentToolToToolDefinition(tool);

    expect(def.description).toContain("Execute a shell command.");
    expect(def.description).toContain("Guidelines:");
    expect(def.description).toContain("- Do X before Y.");
    expect(def.description).toContain("- Prefer Z over W.");
  });

  it("merges guidelines even when resolvedDescriptions overrides", () => {
    const tool = createMockTool({
      name: "exec",
      description: "Original description.",
    }) as AgentTool<any> & { promptGuidelines: string[] };
    tool.promptGuidelines = ["Guideline A."];

    const resolved = { exec: "Lean exec description." };
    const def = agentToolToToolDefinition(tool, resolved);

    expect(def.description).toContain("Lean exec description.");
    expect(def.description).toContain("Guidelines:");
    expect(def.description).toContain("- Guideline A.");
    expect(def.description).not.toContain("Original description.");
  });

  it("handles tool without promptGuidelines", () => {
    const tool = createMockTool({
      description: "Plain tool without guidelines.",
    });
    const def = agentToolToToolDefinition(tool);

    expect(def.description).toBe("Plain tool without guidelines.");
    expect(def.description).not.toContain("Guidelines:");
  });

  it("handles empty promptGuidelines array", () => {
    const tool = createMockTool({
      description: "Tool with empty guidelines.",
    }) as AgentTool<any> & { promptGuidelines: string[] };
    tool.promptGuidelines = [];

    const def = agentToolToToolDefinition(tool);

    expect(def.description).toBe("Tool with empty guidelines.");
    expect(def.description).not.toContain("Guidelines:");
  });

  it("propagates errors from underlying tool execute", async () => {
    const tool = createMockTool({
      execute: vi.fn().mockRejectedValue(new Error("Network timeout")),
    });
    const def = agentToolToToolDefinition(tool);

    await expect(
      def.execute("call-err", {}, undefined, undefined, fakeCtx),
    ).rejects.toThrow("Network timeout");
  });
});

describe("agentToolsToToolDefinitions", () => {
  it("batch converts multiple tools", () => {
    const tools = [
      createMockTool({ name: "memory_search", label: "Memory Search" }),
      createMockTool({ name: "memory_store", label: "Memory Store" }),
      createMockTool({ name: "web_fetch", label: "Web Fetch" }),
    ];

    const defs = agentToolsToToolDefinitions(tools);

    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name)).toEqual(["memory_search", "memory_store", "web_fetch"]);
  });

  it("preserves empty array input", () => {
    const defs = agentToolsToToolDefinitions([]);

    expect(defs).toEqual([]);
  });

  it("applies resolvedDescriptions to batch conversion", () => {
    const tools = [
      createMockTool({ name: "memory_search", description: "Original A" }),
      createMockTool({ name: "web_fetch", description: "Original B" }),
    ];
    const resolved = { memory_search: "Lean memory search desc" };

    const defs = agentToolsToToolDefinitions(tools, resolved);

    expect(defs[0].description).toBe("Lean memory search desc");
    expect(defs[1].description).toBe("Original B"); // no override
  });
});
