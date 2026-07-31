// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { WorkspacePolicySnapshot } from "@comis/core";
import {
  attachMcpOperatorPolicy,
  describeMcpOperatorPolicyProjection,
} from "./mcp-operator-policy.js";

function policy(content: string): WorkspacePolicySnapshot {
  return {
    agentId: "agent-1",
    sections: [{
      id: "workspace:tools",
      sourceKind: "operator",
      trust: "trusted",
      stability: "stable",
      content,
      contentHash: "a".repeat(64),
      maxChars: 20_000,
    }],
    combinedHash: "b".repeat(64),
  };
}

describe("attachMcpOperatorPolicy", () => {
  it("adds bounded immutable notes only to MCP management", () => {
    const notes = "connection notes ".repeat(400);
    const result = attachMcpOperatorPolicy([
      { name: "mcp_manage", description: "Manage MCP servers" },
      { name: "read", description: "Read files" },
    ], policy(notes));

    expect(result[0]?.description).toContain("Trusted operator policy");
    expect(result[0]?.description).toContain("Operator tool notes truncated");
    expect(result[0]?.description).not.toContain(notes);
    expect(result[1]?.description).toBe("Read files");
  });

  it("leaves tool descriptions unchanged without TOOLS policy", () => {
    const tools = [{ name: "mcp_manage", description: "Manage MCP servers" }];
    const result = attachMcpOperatorPolicy(tools, {
      agentId: "agent-1",
      sections: [],
      combinedHash: "b".repeat(64),
    });

    expect(result).toEqual(tools);
  });

  it("replaces a snapshotted projection with current turn policy", () => {
    const tools = [{ name: "mcp_manage", description: "Manage MCP servers" }];
    const first = attachMcpOperatorPolicy(tools, policy("old connection notes"));
    const second = attachMcpOperatorPolicy(first, policy("current connection notes"));

    expect(second[0]?.description).toContain("current connection notes");
    expect(second[0]?.description).not.toContain("old connection notes");
    expect(second[0]?.description?.match(/<operator-tools-policy>/gu)).toHaveLength(1);
  });

  it("removes a snapshotted projection when current policy is absent", () => {
    const tools = [{ name: "mcp_manage", description: "Manage MCP servers" }];
    const projected = attachMcpOperatorPolicy(tools, policy("connection notes"));
    const result = attachMcpOperatorPolicy(projected, {
      agentId: "agent-1",
      sections: [],
      combinedHash: "b".repeat(64),
    });

    expect(result).toEqual(tools);
  });

  it("describes the projection without retaining operator content", () => {
    const content = "exact connection notes";
    const report = describeMcpOperatorPolicyProjection(policy(content));

    expect(report).toEqual({
      toolName: "mcp_manage",
      sectionId: "workspace:tools",
      contentHash: "a".repeat(64),
      projectedChars: content.length,
    });
    expect(JSON.stringify(report)).not.toContain(content);
  });
});
