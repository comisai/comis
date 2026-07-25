// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { createConversationRef, type ConversationScope, type SessionDetailedEntry } from "@comis/core";
import { ok } from "@comis/shared";
import { bindSessionListHandlers } from "./session-list.js";
import type { SessionHandlerDeps } from "./session-helpers.js";

function scope(agentId: string): ConversationScope {
  return {
    tenantId: "tenant_a",
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      principalId: `principal-${agentId}`,
      endpoint: {
        channelType: "telegram",
        channelInstanceId: `account-${agentId}`,
        conversationId: `conversation-${agentId}`,
        threadId: `thread-${agentId}`,
        conversationKind: "direct",
      },
    },
  };
}

function reference(conversationScope: ConversationScope) {
  const result = createConversationRef(conversationScope);
  if (!result.ok) throw result.error;
  return result.value;
}

function entry(agentId: string): SessionDetailedEntry {
  const conversationScope = scope(agentId);
  return {
    conversationRef: reference(conversationScope),
    conversationScope,
    agentId,
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    messageCount: 1,
  };
}

function makeDeps(): SessionHandlerDeps {
  const entries = [entry("agent_a"), entry("agent_b")];
  return {
    sessionStore: {
      listDetailed: (query: { tenantId: string; agentId: string }) => ok(entries.filter((candidate) =>
        candidate.conversationScope.tenantId === query.tenantId
        && candidate.conversationScope.agentId === query.agentId)),
      loadByRef: (query: { tenantId: string; agentId: string }, conversationRef: string) => {
        const found = entries.find((candidate) => candidate.conversationRef === conversationRef
          && candidate.agentId === query.agentId);
        return ok(found ? {
          conversationRef: found.conversationRef,
          conversationScope: found.conversationScope,
          messages: [{ role: "user", content: `marker for ${found.agentId}`, timestamp: 10 }],
          metadata: {},
          createdAt: found.createdAt,
          updatedAt: found.updatedAt,
        } : undefined);
      },
    },
    logger: {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis(),
    },
  } as unknown as SessionHandlerDeps;
}

describe("session list explicit authority", () => {
  it("lists only sessions inside the requested tenant and agent scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());
    const expectedScope = scope("agent_a");
    const result = await handlers["session.list"]!({ tenant_id: "tenant_a", agent_id: "agent_a" }) as {
      sessions: Array<{ conversationRef: string; agentId: string; endpoint?: unknown }>;
      total: number;
    };

    expect(result.sessions).toEqual([
      expect.objectContaining({
        conversationRef: reference(expectedScope),
        agentId: "agent_a",
        endpoint: expectedScope.partition.kind === "endpoint-conversation-principal"
          ? expectedScope.partition.endpoint
          : undefined,
      }),
    ]);
    expect(result.total).toBe(1);
  });

  it("searches only transcripts inside the requested authority scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());
    const result = await handlers["session.search"]!({
      tenant_id: "tenant_a",
      agent_id: "agent_a",
      query: "marker",
      summarize: false,
    }) as { results: Array<{ conversationRef: string; agentId: string }>; total: number };

    expect(result.results).toEqual([
      expect.objectContaining({ conversationRef: reference(scope("agent_a")), agentId: "agent_a" }),
    ]);
    expect(result.total).toBe(1);
  });

  it("rejects an agent-origin query for a different agent scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());

    await expect(handlers["session.list"]!({
      tenant_id: "tenant_a",
      agent_id: "agent_b",
      _agentId: "agent_a",
      _tenantId: "tenant_a",
    })).rejects.toThrow(/does not match the authenticated caller/i);
  });

  it("lets the authenticated control plane select an explicit agent scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());
    const result = await handlers["session.list"]!({ tenant_id: "tenant_a", agent_id: "agent_b" }) as {
      sessions: Array<{ agentId: string }>;
    };

    expect(result.sessions).toEqual([expect.objectContaining({ agentId: "agent_b" })]);
  });
});
