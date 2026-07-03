// SPDX-License-Identifier: Apache-2.0
/**
 * Per-server tool filtering at the bridge layer.
 *
 * Verifies that `mcpToolsToAgentTools`'s optional `serverFiltersFn` 6th
 * parameter applies an allowlist/blocklist BEFORE the `.map()` so filtered
 * tools never receive an AgentTool wrapper (never enter the agent registry).
 *
 * Semantics under test:
 * - allowlist (non-empty): only listed tool names survive.
 * - blocklist: listed tool names are removed.
 * - both + overlap: blocklist wins (a name on both lists is filtered out).
 * - undefined serverFiltersFn / no arg: all tools pass (back-compat).
 * - empty allowlist `[]`: no-op (not deny-all).
 */

import { ok } from "@comis/shared";
import { describe, it, expect, vi } from "vitest";
import type { McpToolDefinition, McpClientManager } from "../integrations/mcp-client/index.js";
import { mcpToolsToAgentTools } from "./mcp-tool-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): McpToolDefinition {
  return {
    name,
    qualifiedName: `mcp:stocks/${name}`,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
  };
}

function makeCallTool(): McpClientManager["callTool"] {
  return vi.fn().mockResolvedValue(
    ok({ content: [{ type: "text", text: "ok" }], isError: false }),
  );
}

/** The three-tool stocks server used across the filtering cases. */
function threeTools(): McpToolDefinition[] {
  return [makeTool("get_price"), makeTool("buy"), makeTool("sell")];
}

// `label` carries the bare tool name (bridge sets label: tool.name).
function labels(tools: ReturnType<typeof mcpToolsToAgentTools>): string[] {
  return tools.map((t) => t.label).filter((l): l is string => typeof l === "string");
}

// ---------------------------------------------------------------------------
// serverFiltersFn behavior
// ---------------------------------------------------------------------------

describe("mcpToolsToAgentTools — per-server tool filtering", () => {
  it("allowlist: surfaces ONLY the allowlisted tool", () => {
    const tools = mcpToolsToAgentTools(
      threeTools(),
      makeCallTool(),
      undefined,
      undefined,
      undefined,
      () => ({ allowlist: ["get_price"] }),
    );
    expect(tools).toHaveLength(1);
    expect(labels(tools)).toEqual(["get_price"]);
  });

  it("blocklist: removes the blocklisted tool; others pass", () => {
    const tools = mcpToolsToAgentTools(
      threeTools(),
      makeCallTool(),
      undefined,
      undefined,
      undefined,
      () => ({ blocklist: ["buy"] }),
    );
    expect(tools).toHaveLength(2);
    expect(labels(tools)).toEqual(["get_price", "sell"]);
  });

  it("both lists overlap: a name on both lists is filtered out (blocklist wins)", () => {
    const tools = mcpToolsToAgentTools(
      threeTools(),
      makeCallTool(),
      undefined,
      undefined,
      undefined,
      () => ({ allowlist: ["get_price", "buy"], blocklist: ["buy"] }),
    );
    expect(tools).toHaveLength(1);
    expect(labels(tools)).toEqual(["get_price"]);
  });

  it("undefined serverFiltersFn: all tools pass", () => {
    const tools = mcpToolsToAgentTools(
      threeTools(),
      makeCallTool(),
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(tools).toHaveLength(3);
  });

  it("empty allowlist: no-op, not deny-all", () => {
    const tools = mcpToolsToAgentTools(
      threeTools(),
      makeCallTool(),
      undefined,
      undefined,
      undefined,
      () => ({ allowlist: [] }),
    );
    expect(tools).toHaveLength(3);
  });

  it("5-arg call with no serverFiltersFn: back-compat, all tools pass", () => {
    const tools = mcpToolsToAgentTools(
      threeTools(),
      makeCallTool(),
      undefined,
      undefined,
      undefined,
    );
    expect(tools).toHaveLength(3);
  });

  it("filter resolves the server name from the qualified name (per-server lookup)", () => {
    const seen: string[] = [];
    const tools = mcpToolsToAgentTools(
      [makeTool("get_price")],
      makeCallTool(),
      undefined,
      undefined,
      undefined,
      (serverName: string) => {
        seen.push(serverName);
        return undefined;
      },
    );
    expect(seen).toEqual(["stocks"]);
    expect(tools).toHaveLength(1);
  });
});
