// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test — bridge-layer per-server tool filtering.
 *
 * Proves `mcpToolsToAgentTools`'s optional 6th `serverFiltersFn` parameter
 * end-to-end against the @comis/skills barrel (via dist/): the per-server
 * allowlist/blocklist runs BEFORE the `.map()`, so a filtered tool never
 * receives an AgentTool wrapper and never enters the agent's tool registry.
 * Verifies success criterion "a 20-tool server shrinks to 1 with
 * toolAllowlist" and the four allowlist/blocklist precedence cases.
 *
 * In-process (no daemon): `mcpToolsToAgentTools` is a pure transformer. The
 * `callTool` delegate is never invoked (filtering happens at construction).
 *
 * Integration tests import from `dist/` — requires `pnpm build` first. The
 * vitest workspace alias `@comis/skills` resolves to
 * `packages/skills/dist/skills/index.js`.
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { mcpToolsToAgentTools } from "@comis/skills";
import type { McpToolDefinition } from "@comis/skills";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three tools on a "stocks" server (allowlist/blocklist canonical set). */
const stocksTools: McpToolDefinition[] = [
  {
    name: "get_price",
    qualifiedName: "mcp:stocks/get_price",
    description: "Get stock price",
    inputSchema: { type: "object" },
  },
  {
    name: "buy",
    qualifiedName: "mcp:stocks/buy",
    description: "Buy stock",
    inputSchema: { type: "object" },
  },
  {
    name: "sell",
    qualifiedName: "mcp:stocks/sell",
    description: "Sell stock",
    inputSchema: { type: "object" },
  },
];

/** A 20-tool server (criterion 2: allowlist shrinks to exactly 1). */
function makeTwentyToolServer(): McpToolDefinition[] {
  return Array.from({ length: 20 }, (_, i) => {
    const name = i === 0 ? "get_price" : `tool_${i}`;
    return {
      name,
      qualifiedName: `mcp:stocks/${name}`,
      description: `Tool ${name}`,
      inputSchema: { type: "object" },
    } satisfies McpToolDefinition;
  });
}

/** The callTool delegate — never called by the filter path; a typed stub. */
const callTool = vi.fn();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bridge-layer tool filtering (mcpToolsToAgentTools serverFiltersFn)", () => {
  it("allowlist surfaces only the listed tool name", () => {
    const filters = vi.fn(() => ({ allowlist: ["get_price"] }));
    const agentTools = mcpToolsToAgentTools(
      stocksTools,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    expect(agentTools).toHaveLength(1);
    // AgentTool.label carries the original (unqualified) MCP tool name.
    expect(agentTools[0]!.label).toBe("get_price");
    // The blocked tools are absent from the constructed registry entirely.
    expect(agentTools.map((t) => t.label)).not.toContain("buy");
    expect(agentTools.map((t) => t.label)).not.toContain("sell");
    // serverFiltersFn is consulted with the parsed server name.
    expect(filters).toHaveBeenCalledWith("stocks");
    // The delegate is NOT invoked at construction time.
    expect(callTool).not.toHaveBeenCalled();
  });

  it("blocklist removes the listed tool name; others pass", () => {
    const filters = vi.fn(() => ({ blocklist: ["buy"] }));
    const agentTools = mcpToolsToAgentTools(
      stocksTools,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    expect(agentTools).toHaveLength(2);
    expect(agentTools.map((t) => t.label)).toEqual(
      expect.arrayContaining(["get_price", "sell"]),
    );
    expect(agentTools.map((t) => t.label)).not.toContain("buy");
  });

  it("allowlist + blocklist overlap: blocklist still wins for names on both", () => {
    const filters = vi.fn(() => ({ allowlist: ["get_price", "buy"], blocklist: ["buy"] }));
    const agentTools = mcpToolsToAgentTools(
      stocksTools,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    expect(agentTools).toHaveLength(1);
    expect(agentTools[0]!.label).toBe("get_price");
  });

  it("undefined filters: all tools pass through unchanged", () => {
    const filters = vi.fn(() => undefined);
    const agentTools = mcpToolsToAgentTools(
      stocksTools,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    expect(agentTools).toHaveLength(3);
  });

  it("empty allowlist is a no-op (not deny-all): all tools pass", () => {
    const filters = vi.fn(() => ({ allowlist: [] as string[] }));
    const agentTools = mcpToolsToAgentTools(
      stocksTools,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    expect(agentTools).toHaveLength(3);
  });

  it("no serverFiltersFn passed: all tools pass (filter step short-circuits)", () => {
    const agentTools = mcpToolsToAgentTools(stocksTools, callTool);
    expect(agentTools).toHaveLength(3);
  });

  it("a 20-tool server shrinks to exactly 1 with toolAllowlist:[get_price]", () => {
    const twenty = makeTwentyToolServer();
    expect(twenty).toHaveLength(20);
    const filters = vi.fn(() => ({ allowlist: ["get_price"] }));
    const agentTools = mcpToolsToAgentTools(
      twenty,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    expect(agentTools).toHaveLength(1);
    expect(agentTools[0]!.label).toBe("get_price");
  });

  it("per-server scoping: filters keyed by server name only affect that server's tools", () => {
    const multiServer: McpToolDefinition[] = [
      ...stocksTools,
      {
        name: "search",
        qualifiedName: "mcp:weather/search",
        description: "Weather search",
        inputSchema: { type: "object" },
      },
    ];
    // Allowlist applies to "stocks" only; "weather" returns no filter.
    const filters = vi.fn((server: string) =>
      server === "stocks" ? { allowlist: ["get_price"] } : undefined,
    );
    const agentTools = mcpToolsToAgentTools(
      multiServer,
      callTool,
      undefined,
      undefined,
      undefined,
      filters,
    );
    // stocks → 1 (get_price); weather → 1 (search, unfiltered) ⇒ 2 total.
    expect(agentTools).toHaveLength(2);
    expect(agentTools.map((t) => t.label)).toEqual(
      expect.arrayContaining(["get_price", "search"]),
    );
  });
});
