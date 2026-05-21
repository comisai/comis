// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for graph-helpers.ts — focused on transformNodes() field forwarding.
 *
 * These tests exist as a regression guard against the dropped-mcpServers bug
 * (yfinance trace, plan 260520-e9x): the daemon RPC pipeline.execute path
 * runs every node through transformNodes() before parseExecutionGraph(), and
 * any field NOT explicitly forwarded here is silently lost. The pipeline
 * tool already emits mcpServers as a camelCase field; the only thing
 * dropping it was the missing conditional spread inside transformNodes.
 *
 * The four cases below pin the contract for both LLM-emitted snake_case
 * (mcp_servers) and graph.load camelCase (mcpServers) inputs, the
 * absent-key case (downstream Zod default applies), and a full mapping
 * regression guard that every other existing field still flows through.
 *
 * @module
 */

import { describe, it, expect } from "vitest";

import { transformNodes } from "./graph-helpers.js";

describe("transformNodes", () => {
  it("forwards mcp_servers snake_case input as mcpServers", () => {
    const result = transformNodes([
      { node_id: "x", task: "t", mcp_servers: ["yfinance"] },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.mcpServers).toEqual(["yfinance"]);
  });

  it("forwards mcpServers camelCase input unchanged through transformer", () => {
    const result = transformNodes([
      { nodeId: "x", task: "t", mcpServers: ["yfinance"] },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.mcpServers).toEqual(["yfinance"]);
  });

  it("omits mcpServers key entirely when neither input variant is present", () => {
    const result = transformNodes([
      { node_id: "x", task: "t" },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect("mcpServers" in node).toBe(false);
  });

  it("preserves every existing snake_case to camelCase field mapping", () => {
    const result = transformNodes([
      {
        node_id: "x",
        task: "t",
        agent: "agent-id",
        model: "claude-sonnet-4-5-20250929",
        depends_on: ["a", "b"],
        timeout_ms: 30000,
        max_steps: 50,
        barrier_mode: "any",
        retries: 2,
        context_mode: "graph",
        type_id: "approval-gate",
        type_config: { mode: "noop" },
      },
    ]);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.nodeId).toBe("x");
    expect(node.task).toBe("t");
    expect(node.agentId).toBe("agent-id");
    expect(node.model).toBe("claude-sonnet-4-5-20250929");
    expect(node.dependsOn).toEqual(["a", "b"]);
    expect(node.timeoutMs).toBe(30000);
    expect(node.maxSteps).toBe(50);
    expect(node.barrierMode).toBe("any");
    expect(node.retries).toBe(2);
    expect(node.contextMode).toBe("graph");
    expect(node.typeId).toBe("approval-gate");
    expect(node.typeConfig).toEqual({ mode: "noop" });
  });
});
