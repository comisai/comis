// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import {
  listSessionsAcrossAgents,
  resolveSessionAuthorities,
  resolveSessionTarget,
} from "./session-scope.js";

function makeRpc() {
  return createMockRpcClient(undefined, {
    call: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "config.read") return { config: { tenantId: "tenant-a" } };
      if (method === "agents.list") return { agents: ["agent-a", "agent-b"] };
      if (method === "session.list") {
        const agentId = String(params?.["agent_id"]);
        return {
          sessions: [{
            conversationRef: `cv-${agentId}`,
            agentId,
            kind: "dm",
            messageCount: 1,
            totalTokens: 10,
            updatedAt: 20,
            createdAt: 10,
          }],
          total: 1,
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }) as never,
  });
}

describe("session scope resolution", () => {
  it("resolves one explicit tenant and agent authority per configured agent", async () => {
    await expect(resolveSessionAuthorities(makeRpc())).resolves.toEqual([
      { tenantId: "tenant-a", agentId: "agent-a" },
      { tenantId: "tenant-a", agentId: "agent-b" },
    ]);
  });

  it("lists every configured agent with contract-valid authority", async () => {
    const rpc = makeRpc();
    const sessions = await listSessionsAcrossAgents(rpc, { kind: "dm" });

    expect(rpc.call).toHaveBeenCalledWith("session.list", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
      kind: "dm",
    });
    expect(rpc.call).toHaveBeenCalledWith("session.list", {
      tenant_id: "tenant-a",
      agent_id: "agent-b",
      kind: "dm",
    });
    expect(sessions.map((session) => session.conversationRef)).toEqual([
      "cv-agent-a",
      "cv-agent-b",
    ]);
  });

  it("resolves a conversation reference to its exact storage authority", async () => {
    await expect(resolveSessionTarget(makeRpc(), "cv-agent-b")).resolves.toEqual({
      tenantId: "tenant-a",
      agentId: "agent-b",
      conversationRef: "cv-agent-b",
    });
  });
});
