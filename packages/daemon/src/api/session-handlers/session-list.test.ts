// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  createConversationRef,
  messageToParts,
  type ConversationScope,
  type SessionDetailedEntry,
} from "@comis/core";
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

function subagentScope(agentId: string, runId: string): ConversationScope {
  return {
    tenantId: "tenant_a",
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      principalId: "principal-agent_a",
      endpoint: {
        channelType: "sub-agent",
        channelInstanceId: "runtime",
        conversationId: runId,
        conversationKind: "direct",
      },
    },
  };
}

function sharedScope(agentId: string, conversationId: string): ConversationScope {
  return {
    tenantId: "tenant_a",
    agentId,
    partition: {
      kind: "endpoint-conversation-principal",
      principalId: `principal-${agentId}`,
      endpoint: {
        channelType: "telegram",
        channelInstanceId: `account-${agentId}`,
        conversationId,
        threadId: "thread-shared",
        conversationKind: "shared",
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
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
      audit: vi.fn(), child: vi.fn().mockReturnThis(),
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

  it("lists an authority-scoped LCD conversation when the session table is empty", async () => {
    const conversationScope = scope("agent_a");
    const conversationRef = reference(conversationScope);
    const listConversations = vi.fn().mockReturnValue({
      conversations: [{
        conversationRef,
        tenantId: "tenant_a",
        agentId: "agent_a",
        sessionKey: "tenant_a:agent:agent_a:principal-agent_a:telegram",
        title: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_010_000,
        messageCount: 4,
      }],
      total: 1,
    });
    const deps = {
      ...makeDeps(),
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok([])),
        loadByRef: vi.fn().mockReturnValue(ok(undefined)),
      },
      contextBrowse: { listConversations },
    } as unknown as SessionHandlerDeps;
    const handlers = bindSessionListHandlers(deps);

    const result = await handlers["session.list"]!({
      tenant_id: "tenant_a",
      agent_id: "agent_a",
    }) as {
      sessions: Array<{
        conversationRef: string;
        agentId: string;
        kind: string;
        messageCount: number;
        updatedAt: number;
      }>;
      total: number;
    };

    expect(listConversations).toHaveBeenCalledWith(
      { tenantId: "tenant_a", agentId: "agent_a" },
      { limit: 200, offset: 0 },
    );
    expect(result).toEqual({
      sessions: [{
        conversationRef,
        agentId: "agent_a",
        kind: "dm",
        messageCount: 4,
        totalTokens: 2_000,
        updatedAt: 1_700_000_010_000,
        createdAt: 1_700_000_000_000,
      }],
      total: 1,
    });
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

  it("searches lossless LCD history when the session metadata row has no messages", async () => {
    const conversationScope = scope("agent_a");
    const conversationRef = reference(conversationScope);
    const getMessages = vi.fn().mockReturnValue([{
      id: "lcd-message-1",
      conversationRef,
      seq: 0,
      role: "user",
      tokenCount: 12,
      createdAt: 1_700_000_000_500,
      parts: messageToParts({
        role: "user",
        content: "Please confirm whether Friday at 6 still works.",
        timestamp: 1_700_000_000_500,
      }),
    }]);
    const deps = {
      ...makeDeps(),
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok([entry("agent_a")])),
        loadByRef: vi.fn().mockReturnValue(ok({
          conversationRef,
          conversationScope,
          messages: [],
          metadata: {},
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_001_000,
        })),
      },
      lcdStore: { getMessages },
    } as unknown as SessionHandlerDeps;
    const handlers = bindSessionListHandlers(deps);

    const result = await handlers["session.search"]!({
      tenant_id: "tenant_a",
      agent_id: "agent_a",
      query: "friday at 6",
      scope: "user",
      summarize: false,
    }) as { results: Array<{ snippet: string }>; total: number };

    expect(result.total).toBe(1);
    expect(result.results[0]?.snippet).toContain("Friday at 6");
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({
      conversationRef,
      tenantId: "tenant_a",
      agentId: "agent_a",
    }));
  });

  it("derives a model search scope from authenticated caller authority", async () => {
    const callerScope = scope("agent_a");
    const handlers = bindSessionListHandlers(makeDeps());

    const result = await handlers["session.search"]!({
      query: "marker",
      summarize: false,
      _agentId: "agent_a",
      _tenantId: "tenant_a",
      _callerConversationScope: callerScope,
    }) as { results: Array<{ conversationRef: string }>; total: number };

    expect(result.total).toBe(1);
    expect(result.results[0]?.conversationRef).toBe(reference(callerScope));
  });

  it("rejects an agent-origin query for a different agent scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());

    await expect(handlers["session.list"]!({
      tenant_id: "tenant_a",
      agent_id: "agent_b",
      _agentId: "agent_a",
      _tenantId: "tenant_a",
      _callerConversationScope: scope("agent_a"),
    })).rejects.toThrow(/does not match the authenticated caller/i);
  });

  it("filters same-agent sibling sessions from a sub-agent list and content search", async () => {
    const callerScope = subagentScope("agent_a", "caller-run");
    const siblingScope = subagentScope("agent_a", "sibling-run");
    const entries: SessionDetailedEntry[] = [
      {
        ...entry("agent_a"),
        conversationRef: reference(callerScope),
        conversationScope: callerScope,
        metadata: { runId: "caller-run" },
      },
      {
        ...entry("agent_a"),
        conversationRef: reference(siblingScope),
        conversationScope: siblingScope,
        metadata: { runId: "sibling-run" },
      },
    ];
    const deps = {
      ...makeDeps(),
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok(entries)),
        loadByRef: vi.fn((
          _query: { tenantId: string; agentId: string },
          conversationRef: string,
        ) => ok({
          conversationRef,
          conversationScope: conversationRef === reference(callerScope) ? callerScope : siblingScope,
          messages: [{
            role: "user",
            content: conversationRef === reference(callerScope)
              ? "caller-visible-marker"
              : "sibling-private-marker",
            timestamp: 10,
          }],
          metadata: {},
          createdAt: 1,
          updatedAt: 2,
        })),
      },
    } as unknown as SessionHandlerDeps;
    const handlers = bindSessionListHandlers(deps);
    const authority = {
      tenant_id: "tenant_a",
      agent_id: "agent_a",
      _agentId: "agent_a",
      _tenantId: "tenant_a",
      _callerConversationScope: callerScope,
    };

    const listed = await handlers["session.list"]!(authority) as {
      sessions: Array<{ conversationRef: string }>;
      total: number;
    };
    const searched = await handlers["session.search"]!({
      ...authority,
      query: "sibling-private-marker",
      summarize: false,
    }) as { results: unknown[]; total: number };

    expect(listed.sessions.map((session) => session.conversationRef)).toEqual([
      reference(callerScope),
    ]);
    expect(listed.total).toBe(1);
    expect(searched).toEqual({ mode: "search", results: [], total: 0 });
  });

  it("limits a model-origin list and content search to the caller conversation and its delegated children", async () => {
    const callerScope = scope("agent_a");
    const groupScope = sharedScope("agent_a", "shared-conversation");
    const childScope = subagentScope("agent_a", "delegated-child");
    const entries: SessionDetailedEntry[] = [
      {
        ...entry("agent_a"),
        conversationRef: reference(callerScope),
        conversationScope: callerScope,
      },
      {
        ...entry("agent_a"),
        conversationRef: reference(groupScope),
        conversationScope: groupScope,
      },
      {
        ...entry("agent_a"),
        conversationRef: reference(childScope),
        conversationScope: childScope,
        metadata: {
          parentConversationRef: reference(callerScope),
          spawnedByAgent: "agent_a",
        },
      },
    ];
    const deps = {
      ...makeDeps(),
      sessionStore: {
        listDetailed: vi.fn().mockReturnValue(ok(entries)),
        loadByRef: vi.fn((
          _query: { tenantId: string; agentId: string },
          conversationRef: string,
        ) => {
          const found = entries.find((candidate) => candidate.conversationRef === conversationRef);
          return ok(found === undefined ? undefined : {
            conversationRef: found.conversationRef,
            conversationScope: found.conversationScope,
            messages: [{
              role: "user",
              content: found.conversationRef === reference(groupScope)
                ? "shared-private-marker"
                : "caller-visible-marker",
              timestamp: 10,
            }],
            metadata: found.metadata,
            createdAt: found.createdAt,
            updatedAt: found.updatedAt,
          });
        }),
      },
    } as unknown as SessionHandlerDeps;
    const handlers = bindSessionListHandlers(deps);
    const authority = {
      tenant_id: "tenant_a",
      agent_id: "agent_a",
      _agentId: "agent_a",
      _tenantId: "tenant_a",
      _callerConversationScope: callerScope,
    };

    const listed = await handlers["session.list"]!(authority) as {
      sessions: Array<{ conversationRef: string }>;
      total: number;
    };
    const searched = await handlers["session.search"]!({
      ...authority,
      query: "shared-private-marker",
      summarize: false,
    }) as { results: unknown[]; total: number };

    expect(listed.sessions.map((session) => session.conversationRef)).toEqual(
      expect.arrayContaining([reference(childScope), reference(callerScope)]),
    );
    expect(listed.total).toBe(2);
    expect(searched).toEqual({ mode: "search", results: [], total: 0 });
  });

  it("rejects a model-origin query without an exact caller conversation scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());

    await expect(handlers["session.list"]!({
      tenant_id: "tenant_a",
      agent_id: "agent_a",
      _agentId: "agent_a",
      _tenantId: "tenant_a",
    })).rejects.toThrow(/session query access denied/i);
  });

  it("lets the authenticated control plane select an explicit agent scope", async () => {
    const handlers = bindSessionListHandlers(makeDeps());
    const result = await handlers["session.list"]!({ tenant_id: "tenant_a", agent_id: "agent_b" }) as {
      sessions: Array<{ agentId: string }>;
    };

    expect(result.sessions).toEqual([expect.objectContaining({ agentId: "agent_b" })]);
  });
});
