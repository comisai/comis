// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the memory domain contracts.
 *
 * Covers the memory-handlers.ts contracts (8 methods) + the 4 admin-scoped
 * diagnostic contracts that share the `MemoryApiDeps` cluster slice.
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
  MemoryAskContract,
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

  it("MEMORY_CONTRACTS has exactly 17 entries (9 memory + 2 portability + 2 pinning + 4 diagnostics)", () => {
    // The portability (export/import), pinning (pin/unpin), diagnostic, and
    // memory.ask contracts are spread in alongside the core memory-handlers.ts
    // contracts; every entry has a matching daemon handler, so the registry ↔
    // handler set stays 1:1.
    expect(MEMORY_CONTRACTS.length).toBe(17);
  });

  it("MEMORY_CONTRACTS method names cover every handler-factory method", () => {
    const methods = new Set(MEMORY_CONTRACTS.map((c) => c.method));
    // memory-handlers.ts (9):
    expect(methods.has("memory.search_files")).toBe(true);
    expect(methods.has("memory.ask")).toBe(true);
    expect(methods.has("memory.get_file")).toBe(true);
    expect(methods.has("memory.store")).toBe(true);
    expect(methods.has("memory.stats")).toBe(true);
    expect(methods.has("memory.browse")).toBe(true);
    expect(methods.has("memory.delete")).toBe(true);
    expect(methods.has("memory.flush")).toBe(true);
    expect(methods.has("memory.export")).toBe(true);
    // No context.* RPC methods exist in the memory domain (context expansion
    // is served by LCD tools, not RPC contracts).
    expect(methods.has("context.search")).toBe(false);
    expect(methods.has("context.recall")).toBe(false);
  });

  it("scope assignments mirror setup-gateway-api.ts registrations", () => {
    // memory-handlers.ts scopes
    expect(MemorySearchFilesContract.scopes).toEqual(["rpc"]);
    expect(MemoryGetFileContract.scopes).toEqual(["rpc"]);
    // memory.store is rpc-scoped (agent-reachable; the memory_store tool).
    expect(MemoryStoreContract.scopes).toEqual(["rpc"]);
    expect(MemoryStatsContract.scopes).toEqual(["admin"]);
    expect(MemoryBrowseContract.scopes).toEqual(["admin"]);
    expect(MemoryDeleteContract.scopes).toEqual(["admin"]);
    expect(MemoryFlushContract.scopes).toEqual(["admin"]);
    expect(MemoryExportContract.scopes).toEqual(["admin"]);
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

});

// ===========================================================================
// Admin-scoped memory diagnostic RPC contracts.
//
// The four diagnostic contracts are grouped in their OWN
// `MEMORY_DIAGNOSTIC_CONTRACTS` array and spread into `MEMORY_CONTRACTS`
// (the registry that feeds `API_CONTRACTS`); each has a matching daemon
// handler, which the bidirectional 1:1 + contract-handler-parity
// architecture tests require of every API_CONTRACTS entry.
// ===========================================================================

describe("memory diagnostic contracts — admin-scoped", () => {
  it("MEMORY_DIAGNOSTIC_CONTRACTS has exactly 4 entries, all admin-scoped", () => {
    expect(MEMORY_DIAGNOSTIC_CONTRACTS.length).toBe(4);
    for (const c of MEMORY_DIAGNOSTIC_CONTRACTS) {
      expect(c.scopes, `${c.method} must be admin-gated`).toEqual(["admin"]);
    }
  });

  it("the 4 diagnostic contracts are registered in MEMORY_CONTRACTS", () => {
    // ...MEMORY_DIAGNOSTIC_CONTRACTS is spread into MEMORY_CONTRACTS; each has
    // a daemon handler, so the contract-handler-parity + bidirectional gates
    // pass with 1:1 parity.
    const registered = new Set(MEMORY_CONTRACTS.map((c) => c.method));
    for (const method of [
      "memory.recall_trace",
      "memory.observations",
      "memory.entities",
      "memory.recall_stats",
    ]) {
      expect(
        registered.has(method),
        `${method} must be IN MEMORY_CONTRACTS (its daemon handler exists)`,
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
    // handler, mirroring obs.trace.search's messageId/traceId pattern).
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

  it("memory.recall_trace: rejects a non-integer, negative, or oversized limit (bounded limit)", () => {
    // The diagnostic `limit` must be a positive integer with a sane cap
    // (defense-in-depth — a malformed bound would otherwise flow straight
    // into the file scan / `LIMIT ?`). A small positive integer still parses.
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

  it("memory.observations / memory.entities: reject a non-integer or oversized limit (bounded limit)", () => {
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

// ===========================================================================
// memory.ask — the dialectic grounded-Q&A contract.
//
// The contract is spread into `MEMORY_CONTRACTS` and has a matching
// `[MemoryAskContract.method]:` daemon handler in memory-handlers.ts, so the
// registry ↔ handler set stays 1:1 (the contract-handler-parity +
// bidirectional 1:1 gates require this of every registered contract).
// ===========================================================================

describe("memory.ask dialectic contract", () => {
  it("method is memory.ask, scoped rpc", () => {
    expect(MemoryAskContract.method).toBe("memory.ask");
    expect(MemoryAskContract.scopes).toEqual(["rpc"]);
  });

  it("request requires a question (parsing {} throws)", () => {
    expect(() => MemoryAskContract.request.parse({ question: "x" })).not.toThrow();
    expect(() => MemoryAskContract.request.parse({})).toThrow();
  });

  it("request accepts an optional numeric limit", () => {
    expect(() => MemoryAskContract.request.parse({ question: "x", limit: 5 })).not.toThrow();
  });

  it("response carries { answer, citations: string[], abstained } — abstained is required", () => {
    expect(() =>
      MemoryAskContract.response.parse({ answer: "a", citations: ["id1"], abstained: false }),
    ).not.toThrow();
    // abstention is an explicit, required boolean — never inferred from an
    // empty answer string. A response MISSING `abstained` throws.
    expect(() =>
      MemoryAskContract.response.parse({ answer: "a", citations: ["id1"] }),
    ).toThrow();
  });

  it("response accepts the abstain sentinel { answer:'', citations:[], abstained:true }", () => {
    expect(() =>
      MemoryAskContract.response.parse({ answer: "", citations: [], abstained: true }),
    ).not.toThrow();
  });

  it("memory.ask is registered in MEMORY_CONTRACTS alongside its daemon handler", () => {
    // MemoryAskContract is spread into MEMORY_CONTRACTS and has a matching
    // `[MemoryAskContract.method]:` daemon handler, which the bidirectional
    // 1:1 + contract-handler-parity gates require.
    const registered = new Set(MEMORY_CONTRACTS.map((c) => c.method));
    expect(registered.has("memory.ask")).toBe(true);
  });
});
