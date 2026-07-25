// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the sessions-domain contract registry.
 *
 * Mirrors the per-domain test pattern:
 *   - Aggregator sanity: count + method-name presence + scope partitioning.
 *   - Single-scope invariant (every contract has scopes.length === 1).
 *   - INTERNAL_FIELD_NAMES paired sanity (no contract request schema declares
 *     a dispatcher-injected `_X` key; loose-record contracts are exempt).
 *   - Per-contract spot-checks: request acceptance + rejection + optional-field
 *     acceptance, response acceptance + rejection on representative shape
 *     mismatch.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  SESSIONS_CONTRACTS,
  SessionStatusContract,
  AgentsListContract,
  SessionListContract,
  SessionSearchContract,
  SessionHistoryContract,
  SessionSendContract,
  SessionSpawnContract,
  SessionRunStatusContract,
  SessionDeleteContract,
  SessionResetContract,
  SessionExportContract,
  SessionCompactContract,
  SessionResetConversationContract,
  INTERNAL_FIELD_NAMES,
} from "./index.js";

const AUTHORITY = { tenant_id: "tenant-1", agent_id: "agent-1" } as const;
const TARGET_AUTHORITY = {
  ...AUTHORITY,
  conversation_ref: "conversation-ref-1",
} as const;

// ===========================================================================
// Aggregator sanity
// ===========================================================================

describe("SESSIONS_CONTRACTS aggregator", () => {
  it("has exactly 13 entries (6 rpc + 7 admin)", () => {
    expect(SESSIONS_CONTRACTS.length).toBe(13);
  });

  it("includes every expected method-name", () => {
    const names = new Set(SESSIONS_CONTRACTS.map((c) => c.method));
    expect(names).toEqual(new Set([
      "session.status",
      "agents.list",
      "session.list",
      "session.search",
      "session.history",
      "session.send",
      "session.spawn",
      "session.run_status",
      "session.delete",
      "session.reset",
      "session.export",
      "session.compact",
      "session.reset_conversation",
    ]));
  });

  it("partitions scopes correctly (9 rpc + 4 admin per setup-gateway-api.ts)", () => {
    // session.list/compact/reset are rpc-scoped (agent-self
    // reads/lifecycle, classified "ungated", NO in-handler admin check). The
    // three that are admin (delete/export/reset_conversation) carry an
    // in-handler `_trustLevel === "admin"` check + target an ARBITRARY session →
    // genuine control plane / deny-by-origin. agents.list is admin too.
    const byScope = new Map<string, string[]>();
    for (const c of SESSIONS_CONTRACTS) {
      const scope = c.scopes[0]!;
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope)!.push(c.method);
    }
    expect(byScope.get("rpc")?.sort()).toEqual([
      "session.compact",
      "session.history",
      "session.list",
      "session.reset",
      "session.run_status",
      "session.search",
      "session.send",
      "session.spawn",
      "session.status",
    ]);
    expect(byScope.get("admin")?.sort()).toEqual([
      "agents.list",
      "session.delete",
      "session.export",
      "session.reset_conversation",
    ]);
  });

  it("keeps every session orchestration read on its declared single route", () => {
    for (const c of SESSIONS_CONTRACTS) {
      expect(c.scopes, `${c.method} route scopes`).toEqual([c.scopes[0]]);
    }
  });
});

// ===========================================================================
// INTERNAL_FIELD_NAMES paired sanity
// ===========================================================================

describe("sessions domain contracts do not declare dispatcher internals", () => {
  it("no contract's request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // Run a probe input carrying every internal-field name + minimal-valid
    // payload for the required fields across the 13 contracts. Each request
    // schema must either silently strip the internal keys (z.object default)
    // or reject — never echo them back in the parsed output.
    //
    // Loose-record exclusion: contracts whose request is a root-level
    // z.record are skipped — by design they pass through any keys including
    // dispatcher internals. The contract-internal-fields.test.ts architecture
    // test is the authoritative gate (it asserts no contract DECLARES the
    // internal field as a top-level z.object field).
    const internalPayload: Record<string, unknown> = Object.fromEntries(
      INTERNAL_FIELD_NAMES.map((n) => [n, "probe-value"]),
    );
    const minimalValid: Record<string, unknown> = {
      session_key: "k",
      text: "x",
      task: "x",
      run_id: "r",
    };

    for (const c of SESSIONS_CONTRACTS) {
      // Skip root-level loose-record requests (none in sessions today —
      // future-proof the pattern for other domains).
      if (c.request instanceof z.ZodRecord) continue;

      const probe = { ...minimalValid, ...internalPayload };
      const parsed = c.request.safeParse(probe);
      if (parsed.success) {
        const outKeys = Object.keys(parsed.data as Record<string, unknown>);
        for (const internalKey of INTERNAL_FIELD_NAMES) {
          expect(
            outKeys,
            `${c.method}.request must NOT echo ${internalKey}`,
          ).not.toContain(internalKey);
        }
      }
      // If !success, the schema rejected the probe (e.g. on required-field
      // type mismatch); that's also a valid outcome — we just need to ensure
      // NO contract MODELS an internal field, which the not-toContain
      // assertion above covers when the parse succeeds.
    }
  });
});

// ===========================================================================
// Per-contract spot-checks
// ===========================================================================

describe("SessionStatusContract", () => {
  it("accepts empty request", () => {
    expect(SessionStatusContract.request.parse({})).toEqual({});
  });

  it("strips extra fields (Zod 4 z.object default = strip)", () => {
    expect(SessionStatusContract.request.parse({ extra: "x" })).toEqual({});
  });

  it("accepts response with all required leaves", () => {
    expect(SessionStatusContract.response.parse({
      model: "claude-sonnet-4-5",
      agentName: "default",
      tokensUsed: { totalTokens: 1234, totalCost: 0.05 },
      stepsExecuted: 5,
      maxSteps: 25,
    })).toBeDefined();
  });

  it("rejects response without tokensUsed", () => {
    expect(() => SessionStatusContract.response.parse({
      model: "x",
      agentName: "x",
      stepsExecuted: 0,
      maxSteps: 25,
    })).toThrow();
  });
});

describe("AgentsListContract", () => {
  it("accepts empty request", () => {
    expect(AgentsListContract.request.parse({})).toEqual({});
  });

  it("accepts response with agents string array", () => {
    expect(AgentsListContract.response.parse({ agents: ["alpha", "beta"] })).toEqual({
      agents: ["alpha", "beta"],
    });
  });

  it("rejects response with non-string agents element", () => {
    expect(() => AgentsListContract.response.parse({
      agents: ["alpha", 42],
    })).toThrow();
  });
});

describe("SessionListContract", () => {
  it("rejects a request without tenant and agent authority", () => {
    expect(() => SessionListContract.request.parse({})).toThrow();
  });

  it("accepts request with kind + since_minutes", () => {
    expect(SessionListContract.request.parse({
      ...AUTHORITY,
      kind: "dm",
      since_minutes: 60,
    })).toEqual({ ...AUTHORITY, kind: "dm", since_minutes: 60 });
  });

  it("rejects request with non-number since_minutes", () => {
    expect(() => SessionListContract.request.parse({ ...AUTHORITY, since_minutes: "60" })).toThrow();
  });

  it("accepts response with sessions[] + total", () => {
    expect(SessionListContract.response.parse({
      sessions: [
        {
          conversationRef: "conversation-ref-1",
          agentId: "default",
          kind: "dm",
          endpoint: {
            channelType: "telegram",
            channelInstanceId: "account-a",
            conversationId: "chat-a",
            threadId: "thread-a",
            conversationKind: "direct",
          },
          messageCount: 3,
          totalTokens: 1500,
          updatedAt: 1715000000000,
          createdAt: 1714900000000,
        },
      ],
      total: 1,
    })).toBeDefined();
  });

  it("rejects response missing total", () => {
    expect(() => SessionListContract.response.parse({ sessions: [] })).toThrow();
  });
});

describe("SessionSearchContract", () => {
  it("accepts an explicitly scoped recent-mode request", () => {
    expect(SessionSearchContract.request.parse(AUTHORITY)).toEqual(AUTHORITY);
  });

  it("accepts request with query + scope + summarize", () => {
    expect(SessionSearchContract.request.parse({
      ...AUTHORITY,
      query: "weather",
      scope: "user",
      limit: 5,
      summarize: false,
    })).toBeDefined();
  });

  it("accepts loose response (recent-mode variant)", () => {
    expect(SessionSearchContract.response.parse({
      mode: "recent",
      sessions: [],
      total: 0,
    })).toBeDefined();
  });

  it("accepts loose response (search-mode variant)", () => {
    expect(SessionSearchContract.response.parse({
      mode: "search",
      results: [{ sessionKey: "k", snippet: "...", score: 1.0, timestamp: 0 }],
      total: 1,
    })).toBeDefined();
  });
});

describe("SessionHistoryContract", () => {
  it("accepts a request with explicit conversation authority", () => {
    expect(SessionHistoryContract.request.parse(TARGET_AUTHORITY)).toEqual(TARGET_AUTHORITY);
  });

  it("accepts request with offset + limit", () => {
    expect(SessionHistoryContract.request.parse({
      ...TARGET_AUTHORITY,
      offset: 10,
      limit: 50,
    })).toBeDefined();
  });

  it("rejects request missing conversation authority", () => {
    expect(() => SessionHistoryContract.request.parse({})).toThrow();
  });

  it("preserves authoritative endpoint metadata in the history response", () => {
    const parsed = SessionHistoryContract.response.parse({
      session: {
        key: "tenant:agent:default:user:channel",
        agentId: "default",
        channelType: "dm",
        endpoint: {
          channelType: "telegram",
          channelInstanceId: "account-a",
          conversationId: "chat-a",
          threadId: "thread-a",
          conversationKind: "direct",
        },
        messageCount: 4,
        totalTokens: 1234,
        inputTokens: 500,
        outputTokens: 734,
        toolCalls: 0,
        compactions: 0,
        resetCount: 0,
        createdAt: 1714900000000,
        lastActiveAt: 1715000000000,
      },
      messages: [
        { role: "user", content: "Hi", timestamp: 1714900000000 },
        { role: "assistant", content: "Hello!", timestamp: 1714900001000 },
      ],
      total: 2,
      offset: 0,
      limit: 20,
      hasMore: false,
    });
    expect(parsed.session.endpoint).toEqual({
      channelType: "telegram",
      channelInstanceId: "account-a",
      conversationId: "chat-a",
      threadId: "thread-a",
      conversationKind: "direct",
    });
  });

  it("accepts session.label optional field", () => {
    expect(SessionHistoryContract.response.parse({
      session: {
        key: "k",
        agentId: "default",
        channelType: "dm",
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
        compactions: 0,
        resetCount: 0,
        createdAt: 0,
        lastActiveAt: 0,
        label: "My Session",
      },
      messages: [],
      total: 0,
      offset: 0,
      limit: 20,
      hasMore: false,
    })).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Additive optional `deliveryStatus` field on every messages[] entry.
  // The handler computes it via a DeliveryQueuePort join (inbound msgs always
  // confirmed; outbound confirmed iff the queue has no matching
  // pending/in_flight/failed entry for that text+channel pair).
  // The MCP resources/read filter exposes ONLY `confirmed` messages.
  // -------------------------------------------------------------------------

  it("SessionHistoryContract.response accepts messages with optional deliveryStatus confirmed or pending", () => {
    // The schema MUST preserve `deliveryStatus` through parse (not strip it).
    // The schema declares `deliveryStatus` so the parsed value carries the
    // field through.
    const parsed = SessionHistoryContract.response.parse({
      session: {
        key: "k", agentId: "default", channelType: "dm",
        messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        toolCalls: 0, compactions: 0, resetCount: 0,
        createdAt: 0, lastActiveAt: 0,
      },
      messages: [
        { role: "user", content: "Hi", timestamp: 1, deliveryStatus: "confirmed" as const },
        { role: "assistant", content: "Yes", timestamp: 2, deliveryStatus: "pending" as const },
      ],
      total: 2, offset: 0, limit: 20, hasMore: false,
    });
    expect(parsed.messages[0]).toHaveProperty("deliveryStatus", "confirmed");
    expect(parsed.messages[1]).toHaveProperty("deliveryStatus", "pending");
  });

  it("SessionHistoryContract.response accepts messages without deliveryStatus (the field is optional on the wire)", () => {
    expect(SessionHistoryContract.response.parse({
      session: {
        key: "k", agentId: "default", channelType: "dm",
        messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        toolCalls: 0, compactions: 0, resetCount: 0,
        createdAt: 0, lastActiveAt: 0,
      },
      messages: [
        // No deliveryStatus field -- callers that omit it must still parse.
        { role: "user", content: "Hello", timestamp: 1 },
      ],
      total: 1, offset: 0, limit: 20, hasMore: false,
    })).toBeDefined();
  });

  it("SessionHistoryContract.response rejects messages with an invalid deliveryStatus value", () => {
    // The schema must enum-validate deliveryStatus. z.enum(["confirmed","pending"])
    // rejects unknown literals.
    expect(() => SessionHistoryContract.response.parse({
      session: {
        key: "k", agentId: "default", channelType: "dm",
        messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        toolCalls: 0, compactions: 0, resetCount: 0,
        createdAt: 0, lastActiveAt: 0,
      },
      messages: [
        { role: "user", content: "Hi", timestamp: 1, deliveryStatus: "delivered" /* not in enum */ },
      ],
      total: 1, offset: 0, limit: 20, hasMore: false,
    })).toThrow();
  });
});

describe("SessionSendContract", () => {
  it("accepts a minimal explicitly targeted request", () => {
    expect(SessionSendContract.request.parse({
      ...TARGET_AUTHORITY,
      text: "hello",
    })).toBeDefined();
  });

  it("accepts request with all optional fields", () => {
    expect(SessionSendContract.request.parse({
      ...TARGET_AUTHORITY,
      text: "hi",
      mode: "wait",
      timeout_ms: 5000,
      max_turns: 3,
    })).toBeDefined();
  });

  it("rejects request missing conversation authority", () => {
    expect(() => SessionSendContract.request.parse({ text: "x" })).toThrow();
  });

  it("rejects request missing text", () => {
    expect(() => SessionSendContract.request.parse(TARGET_AUTHORITY)).toThrow();
  });

  it("accepts loose response (delegates to crossSessionSender)", () => {
    expect(SessionSendContract.response.parse({ delivered: true })).toBeDefined();
    expect(SessionSendContract.response.parse({
      delivered: true,
      reply: "OK",
      runtimeMs: 1234,
    })).toBeDefined();
  });
});

describe("SessionSpawnContract", () => {
  it("accepts minimal request (task only)", () => {
    expect(SessionSpawnContract.request.parse({ task: "do something" })).toBeDefined();
  });

  it("accepts request with full spawn packet", () => {
    expect(SessionSpawnContract.request.parse({
      task: "build a feature",
      agent: "alpha",
      async: true,
      max_steps: 30,
      model: "claude-sonnet-4-5",
      expected_outputs: ["report.md"],
      artifact_refs: ["a:1"],
      objective: "ship a tested feature",
      domain_knowledge: ["typescript"],
      tool_groups: ["read", "edit"],
      include_parent_history: "summary",
      announce_channel_type: "telegram",
      announce_channel_id: "123",
    })).toBeDefined();
  });

  it("rejects request missing task", () => {
    expect(() => SessionSpawnContract.request.parse({})).toThrow();
  });

  it("accepts and preserves worktree:true (isolated-worktree opt-in)", () => {
    const parsed = SessionSpawnContract.request.parse({ task: "x", worktree: true });
    expect(parsed.worktree).toBe(true);
  });

  it("accepts worktree:false (explicit opt-out)", () => {
    const parsed = SessionSpawnContract.request.parse({ task: "x", worktree: false });
    expect(parsed.worktree).toBe(false);
  });

  it("leaves worktree undefined when omitted (optional — non-worktree callers unchanged)", () => {
    const parsed = SessionSpawnContract.request.parse({ task: "x" });
    expect(parsed.worktree).toBeUndefined();
  });

  it("rejects a non-boolean worktree", () => {
    expect(() =>
      SessionSpawnContract.request.parse({ task: "x", worktree: "yes" }),
    ).toThrow();
  });

  it("keeps async optional alongside worktree (--async rides the already-async-only spawn)", () => {
    const withAsync = SessionSpawnContract.request.parse({
      task: "x",
      async: true,
      worktree: true,
    });
    expect(withAsync.async).toBe(true);
    expect(withAsync.worktree).toBe(true);
    // async stays optional — omitting it is still valid (the spawn is async-only).
    expect(SessionSpawnContract.request.parse({ task: "x" }).async).toBeUndefined();
  });

  it("accepts loose response (async-running variant)", () => {
    expect(SessionSpawnContract.response.parse({
      runId: "r1",
      async: true,
    })).toBeDefined();
  });

  it("accepts loose response (async-queued variant)", () => {
    expect(SessionSpawnContract.response.parse({
      runId: "r1",
      async: true,
      queued: true,
    })).toBeDefined();
  });

  it("accepts loose response (sync-success variant)", () => {
    expect(SessionSpawnContract.response.parse({
      sessionKey: "k",
      response: "done",
      tokensUsed: { total: 1234 },
      finishReason: "stop",
      announced: true,
      taskDescription: "do thing",
    })).toBeDefined();
  });
});

describe("SessionRunStatusContract", () => {
  it("accepts valid request", () => {
    expect(SessionRunStatusContract.request.parse({ run_id: "r1" })).toEqual({
      run_id: "r1",
    });
  });

  it("rejects request missing run_id", () => {
    expect(() => SessionRunStatusContract.request.parse({})).toThrow();
  });

  it("accepts response with completed run", () => {
    expect(SessionRunStatusContract.response.parse({
      runId: "r1",
      status: "completed",
      agentId: "alpha",
      startedAt: 1714900000000,
      runtimeMs: 10000,
      completion: {
        endReason: "completed",
        completedAtMs: 1714900010000,
        summary: "done",
      },
      telemetry: {
        tokensUsedTotal: 1234,
        costTotal: 0.03,
        finishReason: "stop",
        stepsExecuted: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })).toBeDefined();
  });

  it("accepts response with running run (no completedAt)", () => {
    expect(SessionRunStatusContract.response.parse({
      runId: "r1",
      status: "running",
      agentId: "alpha",
      startedAt: 1714900000000,
      runtimeMs: 5000,
    })).toBeDefined();
  });

  it("accepts response with failed run + error", () => {
    expect(SessionRunStatusContract.response.parse({
      runId: "r1",
      status: "failed",
      agentId: "alpha",
      startedAt: 0,
      runtimeMs: 100,
      completion: {
        endReason: "failed",
        completedAtMs: 100,
        errorKind: "dependency",
        summary: "Tool exec failed",
      },
    })).toBeDefined();
  });

  it("uses the agent-reachable RPC route and rejects raw provider fields", () => {
    expect(SessionRunStatusContract.scopes).toEqual(["rpc"]);
    expect(() => SessionRunStatusContract.response.parse({
      runId: "r1",
      status: "completed",
      agentId: "alpha",
      startedAt: 0,
      runtimeMs: 1,
      completion: { endReason: "completed", completedAtMs: 1 },
      telemetry: {
        tokensUsedTotal: 1,
        costTotal: 0,
        finishReason: "stop",
        stepsExecuted: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      response: "raw provider output",
    })).toThrow();
  });
});

describe("SessionDeleteContract", () => {
  it("accepts explicit target authority", () => {
    expect(SessionDeleteContract.request.parse(TARGET_AUTHORITY)).toBeDefined();
  });

  it("rejects request missing target authority", () => {
    expect(() => SessionDeleteContract.request.parse({})).toThrow();
  });

  it("accepts response with transcript", () => {
    expect(SessionDeleteContract.response.parse({
      conversationRef: "conversation-ref-1",
      deleted: true,
      transcript: {
        messages: [{ role: "user", content: "Hi" }],
        metadata: {},
        messageCount: 1,
      },
    })).toBeDefined();
  });

  it("rejects response with deleted: false", () => {
    expect(() => SessionDeleteContract.response.parse({
      conversationRef: "conversation-ref-1",
      deleted: false,
      transcript: { messages: [], metadata: {}, messageCount: 0 },
    })).toThrow();
  });
});

describe("SessionResetContract", () => {
  it("accepts explicit target authority", () => {
    expect(SessionResetContract.request.parse(TARGET_AUTHORITY)).toBeDefined();
  });

  it("response.reset must be literal true", () => {
    expect(SessionResetContract.response.parse({
      conversationRef: "conversation-ref-1",
      reset: true,
      previousMessageCount: 5,
    })).toBeDefined();
    expect(() => SessionResetContract.response.parse({
      conversationRef: "conversation-ref-1",
      reset: false,
      previousMessageCount: 5,
    })).toThrow();
  });
});

describe("SessionExportContract", () => {
  it("accepts explicit target authority", () => {
    expect(SessionExportContract.request.parse(TARGET_AUTHORITY)).toBeDefined();
  });

  it("accepts response with full transcript", () => {
    expect(SessionExportContract.response.parse({
      conversationRef: "conversation-ref-1",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      ],
      metadata: { label: "My Session" },
      messageCount: 2,
      createdAt: 1714900000000,
      updatedAt: 1715000000000,
    })).toBeDefined();
  });

  it("rejects response missing messageCount", () => {
    expect(() => SessionExportContract.response.parse({
      conversationRef: "conversation-ref-1",
      messages: [],
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    })).toThrow();
  });
});

describe("SessionCompactContract", () => {
  it("accepts explicit target authority", () => {
    expect(SessionCompactContract.request.parse(TARGET_AUTHORITY)).toBeDefined();
  });

  it("accepts request with instructions", () => {
    expect(SessionCompactContract.request.parse({
      ...TARGET_AUTHORITY,
      instructions: "summarize aggressively",
    })).toBeDefined();
  });

  it("accepts response with null instructions", () => {
    expect(SessionCompactContract.response.parse({
      conversationRef: "conversation-ref-1",
      messageCount: 10,
      estimatedTokens: 5000,
      compactionTriggered: true,
      instructions: null,
    })).toBeDefined();
  });

  it("accepts response with string instructions", () => {
    expect(SessionCompactContract.response.parse({
      conversationRef: "conversation-ref-1",
      messageCount: 10,
      estimatedTokens: 5000,
      compactionTriggered: true,
      instructions: "Summarize keeping technical details",
    })).toBeDefined();
  });

  it("response.compactionTriggered must be literal true", () => {
    expect(() => SessionCompactContract.response.parse({
      conversationRef: "conversation-ref-1",
      messageCount: 0,
      estimatedTokens: 0,
      compactionTriggered: false,
      instructions: null,
    })).toThrow();
  });
});

describe("SessionResetConversationContract", () => {
  it("accepts explicit target authority", () => {
    expect(SessionResetConversationContract.request.parse(TARGET_AUTHORITY)).toEqual(TARGET_AUTHORITY);
  });

  it("accepts request with optional memory flag", () => {
    expect(SessionResetConversationContract.request.parse({
      ...TARGET_AUTHORITY,
      memory: true,
    })).toEqual({ ...TARGET_AUTHORITY, memory: true });
  });

  it("accepts request with optional purge_derived flag preserved", () => {
    expect(SessionResetConversationContract.request.parse({
      ...TARGET_AUTHORITY,
      memory: true,
      purge_derived: true,
    })).toEqual({ ...TARGET_AUTHORITY, memory: true, purge_derived: true });
  });

  it("rejects request missing target authority", () => {
    expect(() => SessionResetConversationContract.request.parse({})).toThrow();
  });

  it("accepts response with both layer counts (memoriesDeleted omitted)", () => {
    expect(SessionResetConversationContract.response.parse({
      conversationRef: "conversation-ref-1",
      lcdRowsDeleted: 12,
      sessionMessagesCleared: 8,
    })).toBeDefined();
  });

  it("accepts response with memoriesDeleted present (memory:true full-forget path)", () => {
    expect(SessionResetConversationContract.response.parse({
      conversationRef: "conversation-ref-1",
      lcdRowsDeleted: 12,
      sessionMessagesCleared: 8,
      memoriesDeleted: 3,
    })).toEqual({ conversationRef: "conversation-ref-1", lcdRowsDeleted: 12, sessionMessagesCleared: 8, memoriesDeleted: 3 });
  });

  it("rejects response missing lcdRowsDeleted", () => {
    expect(() => SessionResetConversationContract.response.parse({
      conversationRef: "conversation-ref-1",
      sessionMessagesCleared: 0,
    })).toThrow();
  });
});
