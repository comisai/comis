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

  it("partitions scopes correctly (6 rpc + 7 admin per setup-gateway-api.ts)", () => {
    const byScope = new Map<string, string[]>();
    for (const c of SESSIONS_CONTRACTS) {
      const scope = c.scopes[0]!;
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope)!.push(c.method);
    }
    expect(byScope.get("rpc")?.sort()).toEqual([
      "session.history",
      "session.run_status",
      "session.search",
      "session.send",
      "session.spawn",
      "session.status",
    ]);
    expect(byScope.get("admin")?.sort()).toEqual([
      "agents.list",
      "session.compact",
      "session.delete",
      "session.export",
      "session.list",
      "session.reset",
      "session.reset_conversation",
    ]);
  });

  it("every contract has scopes.length === 1 (single-scope invariant)", () => {
    for (const c of SESSIONS_CONTRACTS) {
      expect(c.scopes.length, `${c.method} must have exactly one scope`).toBe(1);
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
  it("accepts empty request", () => {
    expect(SessionListContract.request.parse({})).toEqual({});
  });

  it("accepts request with kind + since_minutes", () => {
    expect(SessionListContract.request.parse({
      kind: "dm",
      since_minutes: 60,
    })).toEqual({ kind: "dm", since_minutes: 60 });
  });

  it("rejects request with non-number since_minutes", () => {
    expect(() => SessionListContract.request.parse({ since_minutes: "60" })).toThrow();
  });

  it("accepts response with sessions[] + total", () => {
    expect(SessionListContract.response.parse({
      sessions: [
        {
          sessionKey: "tenant:user:channel",
          agentId: "default",
          userId: "user1",
          channelId: "channel1",
          kind: "dm",
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
  it("accepts empty request (recent mode)", () => {
    expect(SessionSearchContract.request.parse({})).toEqual({});
  });

  it("accepts request with query + scope + summarize", () => {
    expect(SessionSearchContract.request.parse({
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
  it("accepts valid request with session_key only", () => {
    expect(SessionHistoryContract.request.parse({ session_key: "k" })).toEqual({
      session_key: "k",
    });
  });

  it("accepts request with offset + limit", () => {
    expect(SessionHistoryContract.request.parse({
      session_key: "k",
      offset: 10,
      limit: 50,
    })).toBeDefined();
  });

  it("rejects request missing session_key", () => {
    expect(() => SessionHistoryContract.request.parse({})).toThrow();
  });

  it("accepts response with full session + messages shape", () => {
    expect(SessionHistoryContract.response.parse({
      session: {
        key: "tenant:user:channel",
        agentId: "default",
        channelType: "dm",
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
    })).toBeDefined();
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

  it("SessionHistoryContract.response accepts messages without deliveryStatus (backward-compatible with callers that omit the field)", () => {
    expect(SessionHistoryContract.response.parse({
      session: {
        key: "k", agentId: "default", channelType: "dm",
        messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
        toolCalls: 0, compactions: 0, resetCount: 0,
        createdAt: 0, lastActiveAt: 0,
      },
      messages: [
        // No deliveryStatus field -- older callers that omit it continue to work.
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
  it("accepts minimal request", () => {
    expect(SessionSendContract.request.parse({
      session_key: "k",
      text: "hello",
    })).toBeDefined();
  });

  it("accepts request with all optional fields", () => {
    expect(SessionSendContract.request.parse({
      session_key: "k",
      text: "hi",
      mode: "wait",
      timeout_ms: 5000,
      max_turns: 3,
      agent_id: "alpha",
    })).toBeDefined();
  });

  it("rejects request missing session_key", () => {
    expect(() => SessionSendContract.request.parse({ text: "x" })).toThrow();
  });

  it("rejects request missing text", () => {
    expect(() => SessionSendContract.request.parse({ session_key: "k" })).toThrow();
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
      task: "do thing",
      sessionKey: "k",
      startedAt: 1714900000000,
      completedAt: 1714900010000,
      runtimeMs: 10000,
      response: "done",
      tokensUsed: { total: 1234 },
      cost: { input: 0.01, output: 0.02, total: 0.03 },
    })).toBeDefined();
  });

  it("accepts response with running run (no completedAt)", () => {
    expect(SessionRunStatusContract.response.parse({
      runId: "r1",
      status: "running",
      agentId: "alpha",
      task: "do thing",
      startedAt: 1714900000000,
      runtimeMs: 5000,
    })).toBeDefined();
  });

  it("accepts response with failed run + error", () => {
    expect(SessionRunStatusContract.response.parse({
      runId: "r1",
      status: "failed",
      agentId: "alpha",
      task: "do thing",
      startedAt: 0,
      runtimeMs: 100,
      error: "Tool exec failed",
    })).toBeDefined();
  });
});

describe("SessionDeleteContract", () => {
  it("accepts valid request", () => {
    expect(SessionDeleteContract.request.parse({ session_key: "k" })).toBeDefined();
  });

  it("rejects request missing session_key", () => {
    expect(() => SessionDeleteContract.request.parse({})).toThrow();
  });

  it("accepts response with transcript", () => {
    expect(SessionDeleteContract.response.parse({
      sessionKey: "k",
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
      sessionKey: "k",
      deleted: false,
      transcript: { messages: [], metadata: {}, messageCount: 0 },
    })).toThrow();
  });
});

describe("SessionResetContract", () => {
  it("accepts valid request", () => {
    expect(SessionResetContract.request.parse({ session_key: "k" })).toBeDefined();
  });

  it("response.reset must be literal true", () => {
    expect(SessionResetContract.response.parse({
      sessionKey: "k",
      reset: true,
      previousMessageCount: 5,
    })).toBeDefined();
    expect(() => SessionResetContract.response.parse({
      sessionKey: "k",
      reset: false,
      previousMessageCount: 5,
    })).toThrow();
  });
});

describe("SessionExportContract", () => {
  it("accepts valid request", () => {
    expect(SessionExportContract.request.parse({ session_key: "k" })).toBeDefined();
  });

  it("accepts response with full transcript", () => {
    expect(SessionExportContract.response.parse({
      sessionKey: "k",
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
      sessionKey: "k",
      messages: [],
      metadata: {},
      createdAt: 0,
      updatedAt: 0,
    })).toThrow();
  });
});

describe("SessionCompactContract", () => {
  it("accepts valid request", () => {
    expect(SessionCompactContract.request.parse({ session_key: "k" })).toBeDefined();
  });

  it("accepts request with instructions", () => {
    expect(SessionCompactContract.request.parse({
      session_key: "k",
      instructions: "summarize aggressively",
    })).toBeDefined();
  });

  it("accepts response with null instructions", () => {
    expect(SessionCompactContract.response.parse({
      sessionKey: "k",
      messageCount: 10,
      estimatedTokens: 5000,
      compactionTriggered: true,
      instructions: null,
    })).toBeDefined();
  });

  it("accepts response with string instructions", () => {
    expect(SessionCompactContract.response.parse({
      sessionKey: "k",
      messageCount: 10,
      estimatedTokens: 5000,
      compactionTriggered: true,
      instructions: "Summarize keeping technical details",
    })).toBeDefined();
  });

  it("response.compactionTriggered must be literal true", () => {
    expect(() => SessionCompactContract.response.parse({
      sessionKey: "k",
      messageCount: 0,
      estimatedTokens: 0,
      compactionTriggered: false,
      instructions: null,
    })).toThrow();
  });
});

describe("SessionResetConversationContract", () => {
  it("accepts valid request with session_key only", () => {
    expect(SessionResetConversationContract.request.parse({ session_key: "k" })).toEqual({
      session_key: "k",
    });
  });

  it("accepts request with optional memory flag", () => {
    expect(SessionResetConversationContract.request.parse({
      session_key: "k",
      memory: true,
    })).toEqual({ session_key: "k", memory: true });
  });

  it("rejects request missing session_key", () => {
    expect(() => SessionResetConversationContract.request.parse({})).toThrow();
  });

  it("accepts response with both layer counts (memoriesDeleted omitted)", () => {
    expect(SessionResetConversationContract.response.parse({
      sessionKey: "k",
      lcdRowsDeleted: 12,
      sessionMessagesCleared: 8,
    })).toBeDefined();
  });

  it("rejects response missing lcdRowsDeleted", () => {
    expect(() => SessionResetConversationContract.response.parse({
      sessionKey: "k",
      sessionMessagesCleared: 0,
    })).toThrow();
  });
});
