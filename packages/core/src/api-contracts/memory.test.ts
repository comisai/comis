// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the memory + context domain contracts.
 *
 * Covers the 15 contracts spanning the two daemon handler-factory files
 * that share the `MemoryApiDeps` cluster slice:
 *   - memory-handlers.ts (8 methods)
 *   - context-handlers.ts (7 methods)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  MemorySearchFilesContract,
  MemoryGetFileContract,
  MemoryStoreContract,
  MemoryStatsContract,
  MemoryBrowseContract,
  MemoryDeleteContract,
  MemoryFlushContract,
  MemoryExportContract,
  ContextSearchContract,
  ContextInspectContract,
  ContextRecallContract,
  ContextExpandContract,
  ContextConversationsContract,
  ContextTreeContract,
  ContextSearchByConversationContract,
  MEMORY_CONTRACTS,
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
  MEMORY_DIAGNOSTIC_CONTRACTS,
} from "./memory.js";
import { INTERNAL_FIELD_NAMES } from "./internals.js";

describe("memory + context domain contracts", () => {
  // -------------------------------------------------------------------------
  // Aggregator sanity
  // -------------------------------------------------------------------------

  it("MEMORY_CONTRACTS has exactly 19 entries (8 memory + 4 OBS-06 diagnostics + 7 context)", () => {
    // Plan 05 closed the cross-wave seam: the 4 MEMORY_DIAGNOSTIC_CONTRACTS are
    // now spread in (8 + 4 + 7 = 19), in the same wave that landed their daemon
    // handlers, so the registry ↔ handler set stays 1:1.
    expect(MEMORY_CONTRACTS.length).toBe(19);
  });

  it("MEMORY_CONTRACTS method names cover every handler-factory method", () => {
    const methods = new Set(MEMORY_CONTRACTS.map((c) => c.method));
    // memory-handlers.ts (8):
    expect(methods.has("memory.search_files")).toBe(true);
    expect(methods.has("memory.get_file")).toBe(true);
    expect(methods.has("memory.store")).toBe(true);
    expect(methods.has("memory.stats")).toBe(true);
    expect(methods.has("memory.browse")).toBe(true);
    expect(methods.has("memory.delete")).toBe(true);
    expect(methods.has("memory.flush")).toBe(true);
    expect(methods.has("memory.export")).toBe(true);
    // context-handlers.ts (7):
    expect(methods.has("context.search")).toBe(true);
    expect(methods.has("context.inspect")).toBe(true);
    expect(methods.has("context.recall")).toBe(true);
    expect(methods.has("context.expand")).toBe(true);
    expect(methods.has("context.conversations")).toBe(true);
    expect(methods.has("context.tree")).toBe(true);
    expect(methods.has("context.searchByConversation")).toBe(true);
  });

  it("scope assignments mirror setup-gateway-api.ts registrations", () => {
    // memory-handlers.ts scopes
    expect(MemorySearchFilesContract.scopes).toEqual(["rpc"]);
    expect(MemoryGetFileContract.scopes).toEqual(["rpc"]);
    expect(MemoryStoreContract.scopes).toEqual(["admin"]);
    expect(MemoryStatsContract.scopes).toEqual(["admin"]);
    expect(MemoryBrowseContract.scopes).toEqual(["admin"]);
    expect(MemoryDeleteContract.scopes).toEqual(["admin"]);
    expect(MemoryFlushContract.scopes).toEqual(["admin"]);
    expect(MemoryExportContract.scopes).toEqual(["admin"]);
    // context-handlers.ts scopes
    expect(ContextSearchContract.scopes).toEqual(["rpc"]);
    expect(ContextInspectContract.scopes).toEqual(["rpc"]);
    expect(ContextRecallContract.scopes).toEqual(["rpc"]);
    expect(ContextExpandContract.scopes).toEqual(["rpc"]);
    expect(ContextConversationsContract.scopes).toEqual(["admin"]);
    expect(ContextTreeContract.scopes).toEqual(["admin"]);
    expect(ContextSearchByConversationContract.scopes).toEqual(["admin"]);
  });

  // -------------------------------------------------------------------------
  // INTERNAL_FIELD_NAMES paired sanity
  // -------------------------------------------------------------------------

  it("no contract request schema declares any INTERNAL_FIELD_NAMES key", () => {
    // The 15 internal `_X` field names (e.g. `_callerSessionKey`, `_trustLevel`)
    // are dispatcher-injected and MUST be stripped via `stripInternalFields()`
    // BEFORE contract.request.parse(). They MUST NOT appear as keys in any
    // request schema's top-level shape.
    const internalSet = new Set(INTERNAL_FIELD_NAMES);
    for (const contract of MEMORY_CONTRACTS) {
      const shape = (contract.request as unknown as { shape?: Record<string, unknown> }).shape;
      if (!shape) continue;
      for (const key of Object.keys(shape)) {
        expect(
          internalSet.has(key),
          `${contract.method}: request schema must not declare internal field "${key}"`,
        ).toBe(false);
      }
    }
  });

  // -------------------------------------------------------------------------
  // memory.search_files
  // -------------------------------------------------------------------------

  it("memory.search_files: request requires query", () => {
    expect(() => MemorySearchFilesContract.request.parse({})).toThrow();
  });

  it("memory.search_files: request accepts query + optional limit", () => {
    expect(() =>
      MemorySearchFilesContract.request.parse({ query: "alpha" }),
    ).not.toThrow();
    expect(() =>
      MemorySearchFilesContract.request.parse({ query: "alpha", limit: 5 }),
    ).not.toThrow();
  });

  it("memory.search_files: response requires results[] of typed rows", () => {
    expect(() =>
      MemorySearchFilesContract.response.parse({
        results: [
          {
            id: "mem-1",
            content: "preview",
            score: 0.42,
            tags: ["topic-a"],
            createdAt: 1_700_000_000_000,
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      MemorySearchFilesContract.response.parse({ results: [{ id: "mem-1" }] }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.get_file
  // -------------------------------------------------------------------------

  it("memory.get_file: request requires path", () => {
    expect(() => MemoryGetFileContract.request.parse({})).toThrow();
  });

  it("memory.get_file: request accepts path + optional line range", () => {
    expect(() =>
      MemoryGetFileContract.request.parse({ path: "notes.md" }),
    ).not.toThrow();
    expect(() =>
      MemoryGetFileContract.request.parse({
        path: "notes.md",
        startLine: 10,
        endLine: 50,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.store
  // -------------------------------------------------------------------------

  it("memory.store: request requires non-empty content", () => {
    expect(() => MemoryStoreContract.request.parse({})).toThrow();
    expect(() => MemoryStoreContract.request.parse({ content: "" })).toThrow();
  });

  it("memory.store: request accepts content + optional tags + trustLevel", () => {
    expect(() =>
      MemoryStoreContract.request.parse({ content: "hello" }),
    ).not.toThrow();
    expect(() =>
      MemoryStoreContract.request.parse({
        content: "hello",
        tags: ["topic-a"],
        trustLevel: "external",
      }),
    ).not.toThrow();
  });

  it("memory.store: response shape requires literal stored:true + id", () => {
    expect(() =>
      MemoryStoreContract.response.parse({ stored: true, id: "uuid-1" }),
    ).not.toThrow();
    expect(() =>
      MemoryStoreContract.response.parse({ stored: false, id: "uuid-1" }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.stats
  // -------------------------------------------------------------------------

  it("memory.stats: request accepts empty + tenant_id + agent_id", () => {
    expect(() => MemoryStatsContract.request.parse({})).not.toThrow();
    expect(() =>
      MemoryStatsContract.request.parse({ tenant_id: "t1", agent_id: "a1" }),
    ).not.toThrow();
  });

  it("memory.stats: response is a loose record", () => {
    expect(() =>
      MemoryStatsContract.response.parse({
        totalEntries: 42,
        byType: { episodic: 20 },
        dbSizeBytes: 1024,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.browse
  // -------------------------------------------------------------------------

  it("memory.browse: response requires entries[], total, offset, limit, hasMore", () => {
    expect(() =>
      MemoryBrowseContract.response.parse({
        entries: [{ id: "mem-1", content: "preview" }],
        total: 1,
        offset: 0,
        limit: 20,
        hasMore: false,
      }),
    ).not.toThrow();
    expect(() =>
      MemoryBrowseContract.response.parse({
        entries: [],
        total: 0,
        offset: 0,
        // missing hasMore
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.delete
  // -------------------------------------------------------------------------

  it("memory.delete: request requires non-empty ids array", () => {
    expect(() => MemoryDeleteContract.request.parse({})).toThrow();
    expect(() => MemoryDeleteContract.request.parse({ ids: [] })).toThrow();
  });

  it("memory.delete: request accepts ids + optional tenant_id", () => {
    expect(() =>
      MemoryDeleteContract.request.parse({ ids: ["mem-1"] }),
    ).not.toThrow();
    expect(() =>
      MemoryDeleteContract.request.parse({ ids: ["mem-1"], tenant_id: "t1" }),
    ).not.toThrow();
  });

  it("memory.delete: response shape carries deleted/failed/total counters", () => {
    expect(() =>
      MemoryDeleteContract.response.parse({ deleted: 2, failed: 1, total: 3 }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.flush
  // -------------------------------------------------------------------------

  it("memory.flush: response carries flushed:true + entriesRemoved + scope", () => {
    expect(() =>
      MemoryFlushContract.response.parse({
        flushed: true,
        entriesRemoved: 5,
        scope: { tenantId: "t1", agentId: null },
      }),
    ).not.toThrow();
    expect(() =>
      MemoryFlushContract.response.parse({
        flushed: true,
        entriesRemoved: 5,
        scope: { tenantId: "t1", agentId: "a1" },
      }),
    ).not.toThrow();
  });

  it("memory.flush: response rejects flushed:false (literal true)", () => {
    expect(() =>
      MemoryFlushContract.response.parse({
        flushed: false,
        entriesRemoved: 0,
        scope: { tenantId: "t1", agentId: null },
      }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.export
  // -------------------------------------------------------------------------

  it("memory.export: response carries entries[], total, offset, limit", () => {
    expect(() =>
      MemoryExportContract.response.parse({
        entries: [{ id: "mem-1", content: "full content" }],
        total: 1,
        offset: 0,
        limit: 1000,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.search
  // -------------------------------------------------------------------------

  it("context.search: request requires query", () => {
    expect(() => ContextSearchContract.request.parse({})).toThrow();
  });

  it("context.search: request accepts mode + scope + limit (enum-bounded)", () => {
    expect(() =>
      ContextSearchContract.request.parse({
        query: "alpha",
        mode: "fts",
        scope: "both",
        limit: 20,
      }),
    ).not.toThrow();
    expect(() =>
      ContextSearchContract.request.parse({
        query: "alpha",
        mode: "regex",
        scope: "messages",
      }),
    ).not.toThrow();
    expect(() =>
      ContextSearchContract.request.parse({
        query: "alpha",
        mode: "unknown",
      }),
    ).toThrow();
  });

  it("context.search: response requires results[] + total", () => {
    expect(() =>
      ContextSearchContract.response.parse({
        results: [
          { id: "42", content: "msg", type: "message", rank: 0.1 },
          { id: "sum_1", content: "summary", type: "summary" },
        ],
        total: 2,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.inspect
  // -------------------------------------------------------------------------

  it("context.inspect: request requires non-empty id", () => {
    expect(() => ContextInspectContract.request.parse({})).toThrow();
    expect(() => ContextInspectContract.request.parse({ id: "" })).toThrow();
  });

  it("context.inspect: response is a loose record", () => {
    expect(() =>
      ContextInspectContract.response.parse({
        type: "summary",
        summaryId: "sum_1",
        content: "...",
        depth: 0,
        kind: "leaf",
        tokenCount: 100,
        descendantCount: 0,
        parentIds: [],
        childIds: [],
        sourceMessageCount: 5,
      }),
    ).not.toThrow();
    expect(() =>
      ContextInspectContract.response.parse({
        type: "file",
        fileId: "file_1",
        content: "file contents",
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.recall
  // -------------------------------------------------------------------------

  it("context.recall: request requires prompt", () => {
    expect(() => ContextRecallContract.request.parse({})).toThrow();
    expect(() => ContextRecallContract.request.parse({ prompt: "" })).toThrow();
  });

  it("context.recall: response carries answer + citations + optional grantId/tokens", () => {
    expect(() =>
      ContextRecallContract.response.parse({
        answer: "Here is the summary.",
        citations: ["sum_1"],
        grantId: "grant_abc",
        tokensConsumed: 150,
      }),
    ).not.toThrow();
    expect(() =>
      ContextRecallContract.response.parse({
        answer: "No relevant summaries found.",
        citations: [],
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.expand
  // -------------------------------------------------------------------------

  it("context.expand: request requires both grant_id and summary_id", () => {
    expect(() => ContextExpandContract.request.parse({})).toThrow();
    expect(() =>
      ContextExpandContract.request.parse({ grant_id: "g1" }),
    ).toThrow();
    expect(() =>
      ContextExpandContract.request.parse({ summary_id: "s1" }),
    ).toThrow();
    expect(() =>
      ContextExpandContract.request.parse({
        grant_id: "g1",
        summary_id: "s1",
      }),
    ).not.toThrow();
  });

  it("context.expand: response children[] discriminated by type enum", () => {
    expect(() =>
      ContextExpandContract.response.parse({
        summaryId: "sum_1",
        depth: 1,
        kind: "leaf",
        children: [
          { type: "message", id: 42, content: "msg", tokenCount: 25 },
          { type: "summary", id: "sum_2", content: "sub", tokenCount: 75 },
        ],
        tokensExpanded: 100,
        tokenBudgetRemaining: 900,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.conversations
  // -------------------------------------------------------------------------

  it("context.conversations: request accepts empty + limit + offset", () => {
    expect(() =>
      ContextConversationsContract.request.parse({}),
    ).not.toThrow();
    expect(() =>
      ContextConversationsContract.request.parse({ limit: 25, offset: 0 }),
    ).not.toThrow();
  });

  it("context.conversations: response carries conversations[] + total", () => {
    expect(() =>
      ContextConversationsContract.response.parse({
        conversations: [
          {
            conversation_id: "conv-1",
            tenant_id: "t1",
            session_key: "s1",
            created_at: "2026-05-13T00:00:00Z",
          },
        ],
        total: 1,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.tree
  // -------------------------------------------------------------------------

  it("context.tree: request requires conversation_id", () => {
    expect(() => ContextTreeContract.request.parse({})).toThrow();
    expect(() =>
      ContextTreeContract.request.parse({ conversation_id: "" }),
    ).toThrow();
  });

  it("context.tree: response carries conversationId + nodes[] + messageCount", () => {
    expect(() =>
      ContextTreeContract.response.parse({
        conversationId: "conv-1",
        nodes: [
          {
            summaryId: "sum_1",
            kind: "leaf",
            depth: 0,
            tokenCount: 100,
            contentPreview: "preview",
            childIds: [],
            parentIds: ["sum_root"],
            createdAt: "2026-05-13T00:00:00Z",
          },
        ],
        messageCount: 42,
      }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // context.searchByConversation
  // -------------------------------------------------------------------------

  it("context.searchByConversation: request requires both conversation_id + query", () => {
    expect(() =>
      ContextSearchByConversationContract.request.parse({}),
    ).toThrow();
    expect(() =>
      ContextSearchByConversationContract.request.parse({
        conversation_id: "conv-1",
      }),
    ).toThrow();
    expect(() =>
      ContextSearchByConversationContract.request.parse({
        query: "alpha",
      }),
    ).toThrow();
    expect(() =>
      ContextSearchByConversationContract.request.parse({
        conversation_id: "conv-1",
        query: "alpha",
      }),
    ).not.toThrow();
  });

  it("context.searchByConversation: response carries results[] (message|summary)", () => {
    expect(() =>
      ContextSearchByConversationContract.response.parse({
        results: [
          { id: "42", type: "message", content: "msg", rank: 0.1 },
          { id: "sum_1", type: "summary", content: "summary" },
        ],
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Phase 86 (OBS-06) — admin-scoped memory diagnostic RPC contracts.
//
// Interface-first: these four contracts ship here so Plan 05 (daemon handlers
// + CLI) has the request/response shapes in hand. They are grouped in their
// OWN `MEMORY_DIAGNOSTIC_CONTRACTS` array and are deliberately NOT yet folded
// into `MEMORY_CONTRACTS` (the registry that feeds `API_CONTRACTS`): the
// bidirectional 1:1 + contract-handler-parity architecture tests require every
// API_CONTRACTS entry to have a MIGRATED daemon handler, so registering them
// before Plan 05's handlers exist would RED-gate the whole repo between waves.
// Plan 05 spreads MEMORY_DIAGNOSTIC_CONTRACTS into MEMORY_CONTRACTS in the same
// diff that lands the handlers — keeping the registry↔handler set 1:1 at all
// times. See the SUMMARY "Cross-wave seam" note.
// ===========================================================================

describe("memory diagnostic contracts (OBS-06) — admin-scoped", () => {
  it("MEMORY_DIAGNOSTIC_CONTRACTS has exactly 4 entries, all admin-scoped", () => {
    expect(MEMORY_DIAGNOSTIC_CONTRACTS.length).toBe(4);
    for (const c of MEMORY_DIAGNOSTIC_CONTRACTS) {
      expect(c.scopes, `${c.method} must be admin-gated`).toEqual(["admin"]);
    }
  });

  it("the 4 diagnostic contracts are now IN MEMORY_CONTRACTS (cross-wave seam closed in Plan 05)", () => {
    // Plan 05 spread ...MEMORY_DIAGNOSTIC_CONTRACTS into MEMORY_CONTRACTS in the
    // SAME diff that landed the daemon handlers (and removed the
    // @contract-deferred-handler annotations), so each is now registered and
    // the contract-handler-parity + bidirectional gates pass with 1:1 parity.
    const registered = new Set(MEMORY_CONTRACTS.map((c) => c.method));
    for (const method of [
      "memory.recall_trace",
      "memory.observations",
      "memory.entities",
      "memory.recall_stats",
    ]) {
      expect(
        registered.has(method),
        `${method} must be IN MEMORY_CONTRACTS now that Plan 05 landed its handler`,
      ).toBe(true);
    }
  });

  it("no diagnostic contract request schema declares any INTERNAL_FIELD_NAMES key", () => {
    const internalSet = new Set(INTERNAL_FIELD_NAMES);
    for (const contract of MEMORY_DIAGNOSTIC_CONTRACTS) {
      const shape = (contract.request as unknown as { shape?: Record<string, unknown> }).shape;
      if (!shape) continue;
      for (const key of Object.keys(shape)) {
        expect(
          internalSet.has(key),
          `${contract.method}: request must not declare internal field "${key}"`,
        ).toBe(false);
      }
    }
  });

  // -------------------------------------------------------------------------
  // memory.recall_trace
  // -------------------------------------------------------------------------

  it("memory.recall_trace: method + admin scope", () => {
    expect(MemoryRecallTraceContract.method).toBe("memory.recall_trace");
    expect(MemoryRecallTraceContract.scopes).toEqual(["admin"]);
  });

  it("memory.recall_trace: request accepts session_key OR trace_id plus optional scoping (at-least-one enforced in handler)", () => {
    // Both modelled optional (the "at least one" rule is enforced in the
    // Plan 05 handler, mirroring obs.trace.search's messageId/traceId pattern).
    expect(() =>
      MemoryRecallTraceContract.request.parse({ session_key: "t1:u1:c1" }),
    ).not.toThrow();
    expect(() =>
      MemoryRecallTraceContract.request.parse({ trace_id: "trace-1" }),
    ).not.toThrow();
    expect(() =>
      MemoryRecallTraceContract.request.parse({
        trace_id: "trace-1",
        tenant_id: "t1",
        agent_id: "a1",
        limit: 25,
      }),
    ).not.toThrow();
    // An empty object parses (the handler raises the at-least-one error).
    expect(() => MemoryRecallTraceContract.request.parse({})).not.toThrow();
  });

  it("memory.recall_trace: rejects a non-integer, negative, or oversized limit (WR-05 bounded limit)", () => {
    // WR-05: the diagnostic `limit` must be a positive integer with a sane cap
    // (defense-in-depth — a malformed bound used to flow straight into the
    // file scan / `LIMIT ?`). A small positive integer still parses.
    expect(() =>
      MemoryRecallTraceContract.request.parse({ trace_id: "t", limit: 50 }),
    ).not.toThrow();
    // Non-integer is rejected at parse time.
    expect(() =>
      MemoryRecallTraceContract.request.parse({ trace_id: "t", limit: 3.5 }),
    ).toThrow();
    // Negative / zero is rejected.
    expect(() =>
      MemoryRecallTraceContract.request.parse({ trace_id: "t", limit: -1 }),
    ).toThrow();
    expect(() =>
      MemoryRecallTraceContract.request.parse({ trace_id: "t", limit: 0 }),
    ).toThrow();
    // Oversized (beyond the cap) is rejected.
    expect(() =>
      MemoryRecallTraceContract.request.parse({ trace_id: "t", limit: 1_000_000_000 }),
    ).toThrow();
  });

  it("memory.observations / memory.entities: reject a non-integer or oversized limit (WR-05 bounded limit)", () => {
    // The two SQL-backed diagnostics thread `limit` straight into `LIMIT ?`,
    // so the same positive-integer-with-cap fence applies to them.
    expect(() =>
      MemoryObservationsContract.request.parse({ limit: 3.5 }),
    ).toThrow();
    expect(() =>
      MemoryObservationsContract.request.parse({ limit: 1_000_000_000 }),
    ).toThrow();
    expect(() =>
      MemoryEntitiesContract.request.parse({ limit: -5 }),
    ).toThrow();
    expect(() =>
      MemoryEntitiesContract.request.parse({ limit: 1_000_000_000 }),
    ).toThrow();
  });

  it("memory.recall_trace: response carries records[] of loose forward-compat JSONL rows", () => {
    expect(() =>
      MemoryRecallTraceContract.response.parse({
        records: [
          { schemaVersion: 1, traceId: "t", lanes: { fts: 3 } },
          { schemaVersion: 1, traceId: "t", rerank: { fellBack: false } },
        ],
      }),
    ).not.toThrow();
    expect(() => MemoryRecallTraceContract.response.parse({ records: [] })).not.toThrow();
    expect(() => MemoryRecallTraceContract.response.parse({})).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.observations
  // -------------------------------------------------------------------------

  it("memory.observations: method + admin scope + optional scoping request", () => {
    expect(MemoryObservationsContract.method).toBe("memory.observations");
    expect(MemoryObservationsContract.scopes).toEqual(["admin"]);
    expect(() => MemoryObservationsContract.request.parse({})).not.toThrow();
    expect(() =>
      MemoryObservationsContract.request.parse({ tenant_id: "t1", agent_id: "a1", limit: 10 }),
    ).not.toThrow();
  });

  it("memory.observations: response observations[] carries provenance preview fields", () => {
    expect(() =>
      MemoryObservationsContract.response.parse({
        observations: [
          {
            id: "obs-1",
            content: "preview",
            proofCount: 3,
            sourceIds: ["mem-1", "mem-2"],
            confidence: 0.8,
            consolidatedAt: 1_700_000_000_000,
            createdAt: 1_700_000_000_000,
          },
          // optional provenance fields may be absent
          { id: "obs-2", content: "preview2", createdAt: 1_700_000_000_001 },
        ],
      }),
    ).not.toThrow();
    // id + content + createdAt are required.
    expect(() =>
      MemoryObservationsContract.response.parse({ observations: [{ id: "obs-1" }] }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.entities
  // -------------------------------------------------------------------------

  it("memory.entities: method + admin scope + optional scoping request", () => {
    expect(MemoryEntitiesContract.method).toBe("memory.entities");
    expect(MemoryEntitiesContract.scopes).toEqual(["admin"]);
    expect(() => MemoryEntitiesContract.request.parse({})).not.toThrow();
    expect(() =>
      MemoryEntitiesContract.request.parse({ tenant_id: "t1", agent_id: "a1", limit: 50 }),
    ).not.toThrow();
  });

  it("memory.entities: response entities[] carries id, name, mentionCount + optional firstSeen/lastSeen", () => {
    expect(() =>
      MemoryEntitiesContract.response.parse({
        entities: [
          { id: "ent-1", name: "alice", mentionCount: 7, firstSeen: 1, lastSeen: 2 },
          { id: "ent-2", name: "bob", mentionCount: 1 },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      MemoryEntitiesContract.response.parse({ entities: [{ id: "ent-1", name: "x" }] }),
    ).toThrow();
  });

  // -------------------------------------------------------------------------
  // memory.recall_stats
  // -------------------------------------------------------------------------

  it("memory.recall_stats: method + admin scope + optional scoping request", () => {
    expect(MemoryRecallStatsContract.method).toBe("memory.recall_stats");
    expect(MemoryRecallStatsContract.scopes).toEqual(["admin"]);
    expect(() => MemoryRecallStatsContract.request.parse({})).not.toThrow();
    expect(() =>
      MemoryRecallStatsContract.request.parse({ tenant_id: "t1", agent_id: "a1" }),
    ).not.toThrow();
  });

  it("returns a recall_stats response mirroring RecallCountersSnapshot with derived rerankFallbackRate and recallHitRate", () => {
    expect(() =>
      MemoryRecallStatsContract.response.parse({
        laneUsage: { fts: 100, vector: 80, entity: 20 },
        rerankRuns: 50,
        rerankFallbacks: 5,
        consolidationClusters: 12,
        observationsCreated: 30,
        recalls: 60,
        recallsWithHits: 48,
        rerankFallbackRate: 0.1,
        recallHitRate: 0.8,
      }),
    ).not.toThrow();
    // laneUsage and the derived rates are required.
    expect(() =>
      MemoryRecallStatsContract.response.parse({
        rerankRuns: 0,
        rerankFallbacks: 0,
        consolidationClusters: 0,
        observationsCreated: 0,
        recalls: 0,
        recallsWithHits: 0,
        rerankFallbackRate: 0,
        recallHitRate: 0,
      }),
    ).toThrow();
  });
});
