// SPDX-License-Identifier: Apache-2.0
/**
 * Memory diagnostics RPC contracts.
 *
 * Four admin-scoped diagnostic contracts: recall-trace inspect, observation
 * provenance, entity graph, and recall stats. Extracted from
 * `memory.ts` (the `memory + context` domain file) purely to keep that file
 * under the 800-line architecture cap (file-size.test.ts) — they remain part
 * of the memory domain and are re-exported from `memory.ts`, so every existing
 * `from "./memory.js"` import (and the api-contracts barrel) still resolves.
 *
 * These are grouped in their OWN `MEMORY_DIAGNOSTIC_CONTRACTS` array below and
 * spread into `MEMORY_CONTRACTS` (which feeds `API_CONTRACTS` via index.ts).
 * The `api-contracts-bidirectional.test.ts` + `contract-handler-parity.test.ts`
 * gates require every `API_CONTRACTS` entry to have a daemon handler registered
 * under a `[Contract.method]:` computed key — the four handlers live in
 * `packages/daemon/src/api/memory-handlers.ts`, so a contract added here must
 * land in the same diff as its handler to keep the registry↔handler set 1:1.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// memory.recall_trace
// ---------------------------------------------------------------------------

/**
 * `memory.recall_trace` — read recall-trace JSONL records for one recall,
 * keyed by `session_key` OR `trace_id` (admin-only). Models the obs-trace
 * file-reading handler (`bindObsTraceHandlers`): the handler reads
 * the `diagnostics.recallTrace` artifact (LRU + day-bounded scan) and returns
 * the matching records.
 *
 * Request: both `session_key` and `trace_id` are modelled OPTIONAL; the
 * handler enforces the "at least one required" rule (mirroring
 * `obs.trace.search`'s messageId/traceId pattern) and applies the `limit`
 * default. `tenant_id` / `agent_id` are the scope dimensions the handler
 * threads into the file/row filter.
 *
 * Response: `{ records: Record<string, unknown>[] }` — LOOSE on purpose. The
 * recall-trace JSONL rows are schema-versioned + forward-compat; pinning them
 * in the contract would couple the wire shape to the recorder's evolving
 * record format across daemon restarts.
 */
export const MemoryRecallTraceContract = defineContract({
  method: "memory.recall_trace",
  request: z.object({
    session_key: z.string().optional(),
    trace_id: z.string().optional(),
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
    // Bound the limit at parse time — positive integer with a sane cap.
    // An unbounded/negative/fractional limit would otherwise flow straight
    // into the file-scan guard (`records.length >= limit`), so reject
    // malformed bounds here (defense-in-depth + clearer UX), consistent with
    // Comis's other `.int().positive()` contracts.
    limit: z.number().int().positive().max(1000).optional(),
  }),
  response: z.object({
    records: z.array(z.record(z.string(), z.unknown())),
    // A bare `{records: []}` when the recorder is simply disabled
    // (diagnostics.recallTrace.enabled defaults false) would be a silent
    // empty in the very tool that exists to diagnose recall. tracingEnabled
    // reports the recorder gate; hint (only when records is empty) says WHY
    // it is empty and which knob enables it.
    tracingEnabled: z.boolean().optional(),
    hint: z.string().optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.observations
// ---------------------------------------------------------------------------

/**
 * `memory.observations` — list consolidation observations with their
 * provenance (admin-only). The handler reuses the existing
 * `MemoryConsolidationStore.listObservations` SQL-scoped read.
 *
 * Request: `{ tenant_id, agent_id, limit? }` — the scope dimensions the
 * handler threads; `limit` default applied in the handler.
 *
 * Response: `observations[]` with `id`, a truncated `content` PREVIEW (the
 * handler truncates), and the provenance fields read off `MemoryEntry`:
 * `proofCount?`, `sourceIds?`, `confidence?`, `consolidatedAt?`. `createdAt`
 * is always present.
 */
export const MemoryObservationsContract = defineContract({
  method: "memory.observations",
  request: z.object({
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
    // Bound the limit at parse time — it flows straight into `LIMIT ?`.
    limit: z.number().int().positive().max(1000).optional(),
  }),
  response: z.object({
    observations: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        proofCount: z.number().optional(),
        sourceIds: z.array(z.string()).optional(),
        confidence: z.number().optional(),
        consolidatedAt: z.number().optional(),
        createdAt: z.number(),
      }),
    ),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.entities
// ---------------------------------------------------------------------------

/**
 * `memory.entities` — list the entity graph for the scope, ordered
 * most-mentioned-first (admin-only). The handler calls the
 * `MemoryEntityStore.listEntities(agentId, tenantId, limit)` scoped read
 * (defined in `ports/memory-entity-store.ts`).
 *
 * Request: `{ tenant_id, agent_id, limit? }` — scope dimensions + bound.
 *
 * Response: `entities[]` mirroring `EntityRow` — `id`, `name`,
 * `mentionCount`, optional `firstSeen` / `lastSeen` (epoch ms).
 */
export const MemoryEntitiesContract = defineContract({
  method: "memory.entities",
  request: z.object({
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
    // Bound the limit at parse time — it flows straight into `LIMIT ?`.
    limit: z.number().int().positive().max(1000).optional(),
  }),
  response: z.object({
    entities: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        mentionCount: z.number(),
        firstSeen: z.number().optional(),
        lastSeen: z.number().optional(),
      }),
    ),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.recall_stats
// ---------------------------------------------------------------------------

/**
 * `memory.recall_stats` — return the in-process recall counters
 * (admin-only). The handler returns `createRecallCounters().
 * snapshot()` (the `@comis/observability` registry) plus the
 * two derived rates. Counters reset on process restart (documented).
 *
 * Request: `{ tenant_id, agent_id }` — explicit operator authority for the
 * diagnostic request. The counters are process-global, so the current handler
 * validates but does not filter by this scope.
 *
 * Response: the `RecallCountersSnapshot` fields (`laneUsage{fts,vector,
 * entity}`, `rerankRuns`, `rerankFallbacks`, `consolidationClusters`,
 * `observationsCreated`, `recalls`, `recallsWithHits`) PLUS the derived
 * `rerankFallbackRate` (= rerankFallbacks/rerankRuns) and `recallHitRate`
 * (= recallsWithHits/recalls). The handler guards the divide-by-zero on a
 * fresh process.
 */
export const MemoryRecallStatsContract = defineContract({
  method: "memory.recall_stats",
  request: z.object({
    tenant_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  response: z.object({
    laneUsage: z.object({
      fts: z.number(),
      vector: z.number(),
      entity: z.number(),
    }),
    rerankRuns: z.number(),
    rerankFallbacks: z.number(),
    consolidationClusters: z.number(),
    observationsCreated: z.number(),
    recalls: z.number(),
    recallsWithHits: z.number(),
    rerankFallbackRate: z.number(),
    recallHitRate: z.number(),
  }),
  scopes: ["admin"] as const,
});

/**
 * Admin-scoped diagnostic contracts, folded into `MEMORY_CONTRACTS`
 * (`...MEMORY_DIAGNOSTIC_CONTRACTS`). Every entry must have a matching daemon
 * handler — see the registry↔handler note at the top of this file.
 */
export const MEMORY_DIAGNOSTIC_CONTRACTS = [
  MemoryRecallTraceContract,
  MemoryObservationsContract,
  MemoryEntitiesContract,
  MemoryRecallStatsContract,
] as const;
