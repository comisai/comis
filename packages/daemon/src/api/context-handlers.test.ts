// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for createContextHandlers — the context.* operator-browse RPC handlers
 * (context.conversations + context.tree) backing the web Context DAG browser.
 *
 * Without this factory the view's untyped `.call()` requests hit UNREGISTERED
 * methods (every call returns -32601 and the view is dead). The handlers wire
 * conversations + tree against the LCD store, AGENT+TENANT scoped.
 */
import { describe, it, expect, vi } from "vitest";
import type {
  ComisLogger,
  ContextBrowsePort,
  ContextStorePort,
  LcdContextItem,
  LcdConversationPage,
  LcdSummary,
} from "@comis/core";
import { createConversationRef } from "@comis/core";
import { createContextHandlers } from "./context-handlers.js";
import type { ContextHandlerDeps } from "./context-handlers.js";

function conversationRef(conversationId: string, agentId = "agent_a") {
  const result = createConversationRef({
    tenantId: "tenant_a",
    agentId,
    partition: {
      kind: "endpoint-conversation",
      endpoint: {
        channelType: "gateway",
        channelInstanceId: "gateway-test",
        conversationId,
        conversationKind: "direct",
      },
    },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ComisLogger;
}

function makeSummary(overrides: Partial<LcdSummary>): LcdSummary {
  return {
    summaryId: "sum-1",
    conversationId: "conv-1",
    kind: "leaf",
    depth: 0,
    earliestAt: 1000,
    latestAt: 2000,
    descendantCount: 3,
    tokenCount: 42,
    content: "summary body text",
    fileIds: [],
    taint: false,
    fallback: false,
    createdAt: 1500,
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<ContextHandlerDeps>): ContextHandlerDeps {
  return {
    defaultAgentId: "default",
    tenantId: "tenant_a",
    logger: makeLogger(),
    ...overrides,
  } as ContextHandlerDeps;
}

describe("createContextHandlers", () => {
  describe("context.conversations", () => {
    it("returns the agent's conversations scoped by injected _agentId + deps.tenantId (not -32601)", async () => {
      const page: LcdConversationPage = {
        conversations: [
          { conversationRef: conversationRef("conv-2"), tenantId: "tenant_a", agentId: "agent_a", sessionKey: "conv-2", title: null, createdAt: 5000, updatedAt: 9000, messageCount: 4 },
          { conversationRef: conversationRef("conv-1"), tenantId: "tenant_a", agentId: "agent_a", sessionKey: "conv-1", title: null, createdAt: 1000, updatedAt: 2000, messageCount: 2 },
        ],
        total: 2,
      };
      const listConversations = vi.fn((): LcdConversationPage => page);
      const contextBrowse = { listConversations } as unknown as ContextBrowsePort;
      const deps = makeDeps({ contextBrowse });
      const handlers = createContextHandlers(deps);

      const result = (await handlers["context.conversations"]!({
        limit: 50,
        offset: 0,
        _agentId: "agent_a",
      })) as { conversations: Array<Record<string, unknown>>; total: number };

      // Scope: agent from _agentId, tenant from deps.tenantId — never caller-supplied.
      expect(listConversations).toHaveBeenCalledWith({ tenantId: "tenant_a", agentId: "agent_a" }, { limit: 50, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.conversations).toHaveLength(2);
      // snake_case wire keys matching the web DagConversation type.
      const c0 = result.conversations[0]!;
      expect(c0.conversation_ref).toBe(conversationRef("conv-2"));
      expect(c0.agent_id).toBe("agent_a");
      expect(c0.title).toBeNull();
      // created_at / updated_at are ISO strings derived from the epoch bounds.
      expect(typeof c0.created_at).toBe("string");
      expect(c0.created_at).toBe(new Date(5000).toISOString());
      expect(c0.message_count).toBe(4);
    });

    it("falls back to deps.defaultAgentId when no _agentId is injected", async () => {
      const listConversations = vi.fn((): LcdConversationPage => ({ conversations: [], total: 0 }));
      const contextBrowse = { listConversations } as unknown as ContextBrowsePort;
      const deps = makeDeps({ contextBrowse, defaultAgentId: "fallback-agent" });
      const handlers = createContextHandlers(deps);

      await handlers["context.conversations"]!({});

      expect(listConversations).toHaveBeenCalledWith({ tenantId: "tenant_a", agentId: "fallback-agent" }, { limit: 100, offset: 0 });
    });

    it("returns an empty page when the browse port is not wired", async () => {
      const deps = makeDeps({ contextBrowse: undefined });
      const handlers = createContextHandlers(deps);

      const result = (await handlers["context.conversations"]!({ _agentId: "agent_a" })) as { conversations: unknown[]; total: number };
      expect(result.conversations).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("context.tree", () => {
    it("resolves the DAG (summary nodes + raw-message count) for a conversation, agent-scoped (not -32601)", async () => {
      const leaf = makeSummary({ summaryId: "leaf-1", kind: "leaf", depth: 0, content: "leaf body" });
      const condensed = makeSummary({ summaryId: "cond-1", kind: "condensed", depth: 1, content: "condensed body" });
      const contextItems: LcdContextItem[] = [
        { ordinal: 0, refKind: "summary", refId: "cond-1" },
        { ordinal: 1, refKind: "message", refId: "msg-a" },
        { ordinal: 2, refKind: "message", refId: "msg-b" },
      ];
      const getSummaries = vi.fn((): LcdSummary[] => [leaf, condensed]);
      const getContextItems = vi.fn((): LcdContextItem[] => contextItems);
      const getSummaryChildren = vi.fn((_scope: unknown, parentId: string): LcdSummary[] =>
        parentId === "cond-1" ? [leaf] : [],
      );
      const lcdStore = { getSummaries, getContextItems, getSummaryChildren } as unknown as ContextStorePort;
      const deps = makeDeps({ lcdStore });
      const handlers = createContextHandlers(deps);

      const result = (await handlers["context.tree"]!({
        conversation_ref: conversationRef("conv-1"),
        _agentId: "agent_a",
      })) as { conversationRef: string; nodes: Array<Record<string, unknown>>; messageCount: number };

      // Agent+tenant scope passed to the store reads.
      expect(getSummaries).toHaveBeenCalledWith(expect.objectContaining({ conversationRef: conversationRef("conv-1"), agentId: "agent_a", tenantId: "tenant_a" }));
      expect(result.conversationRef).toBe(conversationRef("conv-1"));
      // Two summary nodes.
      expect(result.nodes).toHaveLength(2);
      // messageCount counts ONLY message-ref context_items (2 of 3).
      expect(result.messageCount).toBe(2);

      const condNode = result.nodes.find((n) => n.summaryId === "cond-1")!;
      expect(condNode.kind).toBe("condensed");
      expect(condNode.depth).toBe(1);
      expect(condNode.tokenCount).toBe(42);
      // Condensed node's childIds resolved via getSummaryChildren.
      expect(condNode.childIds).toEqual(["leaf-1"]);
      // contentPreview is surfaced (bounded) for the human operator view.
      expect(typeof condNode.contentPreview).toBe("string");
      expect(condNode.contentPreview).toContain("condensed body");
      // createdAt is an ISO string.
      expect(condNode.createdAt).toBe(new Date(1500).toISOString());

      // The leaf node is a child of cond-1, so its parentIds reflect the inverse edge.
      const leafNode = result.nodes.find((n) => n.summaryId === "leaf-1")!;
      expect(leafNode.parentIds).toEqual(["cond-1"]);
      expect(leafNode.childIds).toEqual([]);
    });

    it("caps the contentPreview length so a huge summary body cannot flood the response", async () => {
      const big = makeSummary({ summaryId: "leaf-big", content: "x".repeat(5000) });
      const lcdStore = {
        getSummaries: vi.fn((): LcdSummary[] => [big]),
        getContextItems: vi.fn((): LcdContextItem[] => []),
        getSummaryChildren: vi.fn((): LcdSummary[] => []),
      } as unknown as ContextStorePort;
      const deps = makeDeps({ lcdStore });
      const handlers = createContextHandlers(deps);

      const result = (await handlers["context.tree"]!({ conversation_ref: conversationRef("conv-1"), _agentId: "agent_a" })) as {
        nodes: Array<{ contentPreview: string }>;
      };
      expect(result.nodes[0]!.contentPreview.length).toBeLessThanOrEqual(280);
    });

    it("returns an empty tree when the LCD store is not wired", async () => {
      const deps = makeDeps({ lcdStore: undefined });
      const handlers = createContextHandlers(deps);

      const result = (await handlers["context.tree"]!({ conversation_ref: conversationRef("conv-1"), _agentId: "agent_a" })) as {
        conversationRef: string;
        nodes: unknown[];
        messageCount: number;
      };
      expect(result.conversationRef).toBe(conversationRef("conv-1"));
      expect(result.nodes).toEqual([]);
      expect(result.messageCount).toBe(0);
    });
  });
});
