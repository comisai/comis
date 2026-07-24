// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/api-client.js";
import { createMockRpcClient } from "../../test-support/mock-rpc-client.js";
import {
  createLocalChatSession,
  filterChatSessions,
  loadChatAgents,
  loadChatBudget,
  loadChatHistory,
  loadChatSessions,
  resolveActiveSessionTarget,
  resolveTransportSessionKey,
  sendChatMessage,
  type ChatSessionInfo,
} from "./session-data.js";

function makeRpc() {
  return createMockRpcClient(undefined, {
    call: vi.fn(async (method: string) => {
      if (method === "config.read") return { config: { tenantId: "tenant-a" } };
      if (method === "agents.list") return { agents: ["agent-a"] };
      if (method === "session.list") {
        return {
          sessions: [{
            conversationRef: "conversation-a",
            agentId: "agent-a",
            kind: "dm",
            messageCount: 2,
            totalTokens: 10,
            updatedAt: 20,
            createdAt: 10,
          }],
          total: 1,
        };
      }
      if (method === "session.history") {
        return {
          session: { key: "tenant-a:agent:agent-a:user_a:web:chat-a" },
          messages: [
            { role: "user", content: "Hello", timestamp: 1 },
            { role: "assistant", content: "Done NO_REPLY", timestamp: 2 },
          ],
        };
      }
      if (method === "obs.context.pipeline") {
        return {
          snapshots: [{
            tokensLoaded: 60,
            tokensEvicted: 10,
            tokensMasked: 5,
            budgetUtilization: 0.75,
          }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }) as never,
  });
}

describe("chat session data", () => {
  it("loads direct-message sessions with explicit authority", async () => {
    const rpc = makeRpc();
    await expect(loadChatSessions(rpc, "agent-a")).resolves.toEqual([{
      key: "conversation-a",
      agentId: "agent-a",
      tenantId: "tenant-a",
      conversationRef: "conversation-a",
      channelType: "dm",
      messageCount: 2,
      lastActivity: 20,
    }]);
    expect(rpc.call).toHaveBeenCalledWith("session.list", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
      kind: "dm",
    });
  });

  it("loads history through the scoped conversation target", async () => {
    const rpc = makeRpc();
    const result = await loadChatHistory(rpc, {
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: "conversation-a",
    });
    expect(result.messages.map((message) => message.content)).toEqual(["Hello", "Done"]);
  });

  it("does not convert stored display identity into transport authority", () => {
    const sessions: ChatSessionInfo[] = [{
      key: "conversation-a",
      agentId: "agent-a",
      tenantId: "tenant-a",
      conversationRef: "conversation-a",
      channelType: "dm",
      messageCount: 2,
      lastActivity: 20,
    }];
    expect(resolveTransportSessionKey(sessions, "conversation-a"))
      .toBe("");
    expect(resolveActiveSessionTarget(sessions, "conversation-a")).toEqual({
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: "conversation-a",
    });
  });

  it("sends stored chat messages through explicit conversation authority", async () => {
    const rpc = makeRpc();
    (rpc.call as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ response: "Stored reply" });

    await expect(sendChatMessage(rpc, {
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: "conversation-a",
    }, "Continue")).resolves.toBe("Stored reply");
    expect(rpc.call).toHaveBeenLastCalledWith("session.send", {
      tenant_id: "tenant-a",
      agent_id: "agent-a",
      conversation_ref: "conversation-a",
      text: "Continue",
      mode: "wait",
    });
  });

  it("maps configured agents and supplies the empty deployment default", async () => {
    const populated = {
      getAgents: vi.fn().mockResolvedValue([
        { id: "agent-a", name: "Agent A", model: "model-a" },
      ]),
    } as unknown as ApiClient;
    const empty = {
      getAgents: vi.fn().mockResolvedValue([]),
    } as unknown as ApiClient;
    await expect(loadChatAgents(populated)).resolves.toEqual([
      { id: "agent-a", name: "Agent A", model: "model-a" },
    ]);
    await expect(loadChatAgents(empty)).resolves.toEqual([
      { id: "default", name: "Default", model: "unknown" },
    ]);
  });

  it("maps the latest context snapshot to budget segments", async () => {
    await expect(loadChatBudget(makeRpc(), "agent-a")).resolves.toEqual({
      segments: [
        { label: "Loaded", tokens: 60, color: "var(--ic-accent)" },
        { label: "Evicted", tokens: 10, color: "var(--ic-warning)" },
        { label: "Masked", tokens: 5, color: "var(--ic-text-dim)" },
        { label: "Available", tokens: 20, color: "var(--ic-surface-2)" },
      ],
      total: 80,
    });
  });

  it("creates and filters local web sessions without storage authority", () => {
    const local = createLocalChatSession("agent-a", 20);
    expect(local).toEqual(expect.objectContaining({
      agentId: "agent-a",
      channelType: "web",
      lastActivity: 20,
    }));
    expect(filterChatSessions([local], "agent-a")).toEqual([local]);
    expect(filterChatSessions([local], "missing")).toEqual([]);
  });
});
