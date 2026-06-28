// SPDX-License-Identifier: Apache-2.0
/**
 * Observability-domain RPC contracts. All 26 methods are admin-scoped.
 *
 * Groups and method names:
 *   Diagnostics (1): obs.diagnostics
 *   Billing (5):     obs.billing.{byProvider,byAgent,bySession,total,usage24h}
 *   Audit (1):       obs.audit.query  (read surface onto obs_audit_events — AUDIT-05,
 *                    Phase 176; contract + wire schema in `audit-query.ts`)
 *   Channels (3):    obs.channels.{all,stale,get}
 *   Delivery (2):    obs.delivery.{recent,stats}
 *   Context (2):     obs.context.{pipeline,dag}  (gateway-scope gate only)
 *   Cache (3):       agent.cacheStats, obs.getCacheStats, memory.embeddingCache
 *   Reset (2):       obs.reset, obs.reset.table
 *   SystemPrompt (2):obs.systemPromptReport.{latest,list}
 *   Trace (3):       obs.trace.{export,search,tail}
 *   Explain (1):     obs.explain  (IncidentReport assembler — Phase 153;
 *                    contract + wire schema in sibling `incident-report.ts`)
 *   Fleet (1):       obs.fleet.health  (cross-session FleetHealthReport — v2.15
 *                    Phase 161; contract + wire schema in `fleet-health-report.ts`)
 *
 * Dispatch: the non-Trace methods are web-SPA only (packages/web/src/views/),
 * handled by packages/daemon/src/api/obs-handlers.ts; the Trace group is also
 * CLI-accessible (packages/cli/src/commands/trace.ts), handled by obs-trace.ts.
 *
 * Loose-record use: response shapes with deeply nested/optional fields use
 * `z.record(z.string(), z.unknown())`; the handler test suite is the
 * authoritative shape validator. Two in-handler-admin-check exceptions —
 * `obs.context.pipeline` / `obs.context.dag` rely solely on the gateway-router
 * scope gate; all others add a redundant defense-in-depth `_trustLevel` check.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";
// obs.explain contract surface (IncidentReport wire schema + shape types + the
// contract) lives in the sibling `incident-report.ts` (file-size split). Import
// for the OBSERVABILITY_CONTRACTS array below; re-export so the `@comis/core`
// public surface + registered RPC set are unchanged.
import { ObsExplainContract } from "./incident-report.js";
export { ObsExplainContract, IncidentReportSchema, IncidentContextBudgetSchema, IncidentPromptTimeoutSchema } from "./incident-report.js";
export type { IncidentReport, IncidentFailure, IncidentSignals, IncidentContextBudget, IncidentPromptTimeout } from "./incident-report.js";
// The `obs.fleet.health` contract + wire schema (v2.15 R2, Phase 161) live in the
// sibling `fleet-health-report.ts` (file-size split, mirroring incident-report.ts
// which holds BOTH IncidentReportSchema + ObsExplainContract). Import the contract
// for the OBSERVABILITY_CONTRACTS array below; re-export the contract + schema so
// the `@comis/core` public surface + the registered RPC set carry them.
import { ObsFleetHealthContract } from "./fleet-health-report.js";
export { ObsFleetHealthContract, FleetHealthReportSchema } from "./fleet-health-report.js";
export type { FleetHealthReport } from "./fleet-health-report.js";
// The `obs.audit.query` contract + wire schema (AUDIT-05, Phase 176 Plan 05) live
// in the sibling `audit-query.ts` (the read surface onto the now-durable
// obs_audit_events table). Import for the OBSERVABILITY_CONTRACTS array below;
// re-export the contract + schema so the `@comis/core` public surface + the
// registered RPC set carry them (the ObsFleetHealthContract precedent).
import { ObsAuditQueryContract } from "./audit-query.js";
export { ObsAuditQueryContract } from "./audit-query.js";
export type { AuditEventRowWire, AuditQueryResponse } from "./audit-query.js";
// The five obs.billing.* contracts (+ their BillingSnapshot response schema)
// live in the sibling `observability-billing.ts` (file-size split). Import for
// the OBSERVABILITY_CONTRACTS array below; re-export so the `@comis/core`
// public surface + registered RPC set are unchanged (wire-identical).
import {
  ObsBillingByAgentContract,
  ObsBillingByProviderContract,
  ObsBillingBySessionContract,
  ObsBillingTotalContract,
  ObsBillingUsage24hContract,
} from "./observability-billing.js";
export {
  ObsBillingByAgentContract,
  ObsBillingByProviderContract,
  ObsBillingBySessionContract,
  ObsBillingTotalContract,
  ObsBillingUsage24hContract,
} from "./observability-billing.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas — loose-record projection.
// ---------------------------------------------------------------------------

/**
 * Loose-tree row schema for DiagnosticEvent, DeliveryContext,
 * ChannelActivity, ProviderBilling, PipelineSnapshot, and
 * DagCompactionSnapshot. Each of these handler-returned row shapes
 * has 8+ fields (some optional, some `Record<string, unknown>`), so
 * modeling tightly would require pinning every sub-shape's wire
 * format and breaking the contract on every minor handler addition.
 *
 * `z.record(z.string(), z.unknown())` is the documented escape hatch
 * for arbitrary-shaped record payloads. The handler's TypeScript
 * types remain authoritative — the contract is type narrowing +
 * defense-in-depth + a dev-mode response.parse() gate that catches
 * the "field with wrong primitive type" class of regressions.
 */
const ObsRecord = z.record(z.string(), z.unknown());

/**
 * Array-of-loose-records — used by handlers that return a bare array
 * at the response root (`obs.billing.usage24h`, `obs.context.pipeline`,
 * `obs.context.dag`).
 */
const ObsRecordArray = z.array(z.record(z.string(), z.unknown()));

/**
 * Rows-deleted summary used by `obs.reset` and `obs.reset.table`
 * (handler:602, 615-616, 646-651).
 */
const ResetRowsDeletedSchema = z.object({
  tokenUsage: z.number(),
  delivery: z.number(),
  diagnostics: z.number(),
  channels: z.number(),
});

/**
 * Diagnostic-event category enum (mirrors
 * `packages/daemon/src/observability/diagnostic-collector.ts:48`).
 */
const DiagnosticCategorySchema = z.enum(["usage", "webhook", "message", "session"]);

// ---------------------------------------------------------------------------
// obs.diagnostics
// ---------------------------------------------------------------------------

/**
 * `obs.diagnostics` — Query diagnostic events by category / time /
 * limit. rpc-scoped, NOT admin (see the `scopes` note below): there is no
 * in-handler admin gate, so an agent's `obs_query` can self-diagnose its own
 * sessions. Read-only, scrubbed digests on a single-tenant daemon.
 *
 * Request: `{ category?, limit?, sinceMs? }`. `category` is one of
 * `usage` / `webhook` / `message` / `session`; `limit` defaults to
 * 50 (handler:87, 107); `sinceMs` is the duration-ago window (the
 * handler converts via `Date.now() - sinceMs` for the SQLite query).
 *
 * Response: `{ events, counts }` where `events` is a merged array
 * of DiagnosticEvent-shaped rows (loose-modeled) sorted by
 * `timestamp` desc, and `counts` is a `Record<category, number>`
 * snapshot returned by `diagnosticCollector.getCounts()`.
 */
export const ObsDiagnosticsContract = defineContract({
  method: "obs.diagnostics",
  request: z.object({
    category: DiagnosticCategorySchema.optional(),
    limit: z.number().optional(),
    sinceMs: z.number().optional(),
  }),
  response: z.object({
    events: ObsRecordArray,
    counts: ObsRecord,
  }),
  // OBS-SELF-DEAD (30uc-20260624 UC-14): rpc, NOT admin — same as obs.explain. obs_query's
  // self-observability path reads diagnostics for the agent's own sessions; read-only +
  // scrubbed digests, single-tenant daemon. ["admin"] put it in the deny-by-origin set and
  // killed the agent's self-diagnose. MD-02 re-scope class.
  scopes: ["rpc"] as const,
});

// ---------------------------------------------------------------------------
// obs.billing.{byProvider,byAgent,bySession,total,usage24h} + BillingSnapshot
// live in the sibling `observability-billing.ts` (file-size split). They are
// imported + re-exported at the top of this module and registered into
// OBSERVABILITY_CONTRACTS below — wire-identical, no shape change.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// obs.channels.all
// ---------------------------------------------------------------------------

/**
 * `obs.channels.all` — All tracked channel activity (in-memory
 * authoritative + SQLite historical). Admin-only (in-handler gate;
 * handler:343).
 *
 * Request: `{}`.
 *
 * Response: `{ channels: ChannelActivity[] }`. Each row carries
 * `{ channelId, channelType, lastActiveAt, messagesSent,
 *   messagesReceived }` — modeled loose (uniform with the other
 * channel shapes).
 */
export const ObsChannelsAllContract = defineContract({
  method: "obs.channels.all",
  request: z.object({}),
  response: z.object({
    channels: ObsRecordArray,
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.channels.stale
// ---------------------------------------------------------------------------

/**
 * `obs.channels.stale` — Channels inactive beyond `thresholdMs`
 * (default 5 minutes — handler:379). Admin-only (in-handler gate;
 * handler:376).
 *
 * Request: `{ thresholdMs? }`.
 *
 * Response: `{ stale: ChannelActivity[] }` (handler:380).
 */
export const ObsChannelsStaleContract = defineContract({
  method: "obs.channels.stale",
  request: z.object({
    thresholdMs: z.number().optional(),
  }),
  response: z.object({
    stale: ObsRecordArray,
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.channels.get
// ---------------------------------------------------------------------------

/**
 * `obs.channels.get` — Single channel activity lookup. Admin-only
 * (in-handler gate; handler:388). `channelId` required (handler:392
 * throws `"Invalid request: channelId parameter is required"`).
 *
 * Request: `{ channelId }`.
 *
 * Response: `{ channel: ChannelActivity | null }` (handler:393). The
 * `null` branch fires when no channel matches the id. Modeled via
 * `z.nullable(z.record(...))` (both nullable + record are in the
 * 12-shape allowlist).
 */
export const ObsChannelsGetContract = defineContract({
  method: "obs.channels.get",
  request: z.object({
    channelId: z.string().min(1),
  }),
  response: z.object({
    channel: z.nullable(ObsRecord),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.delivery.recent
// ---------------------------------------------------------------------------

/**
 * `obs.delivery.recent` — Recent delivery records (merged historical
 * SQLite + in-memory, sorted by `deliveredAt` desc). Admin-only
 * (in-handler gate; handler:401).
 *
 * Request: `{ sinceMs?, limit?, channelId? }`. `limit` defaults to
 * 50 (handler:418, 445); `channelId` filters historical rows
 * (handler:438-440).
 *
 * Response: `{ deliveries: DeliveryContext[] }` (handler:447). Each
 * row carries 11+ fields including a nested `steps` array and
 * `metadata` record — modeled loose.
 */
export const ObsDeliveryRecentContract = defineContract({
  method: "obs.delivery.recent",
  request: z.object({
    sinceMs: z.number().optional(),
    limit: z.number().optional(),
    channelId: z.string().optional(),
  }),
  response: z.object({
    deliveries: ObsRecordArray,
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.delivery.stats
// ---------------------------------------------------------------------------

/**
 * `obs.delivery.stats` — Delivery statistics summary (merged
 * SQLite + in-memory). Admin-only (in-handler gate; handler:455).
 *
 * Request: `{}`.
 *
 * Response: `{ total, successes, failures, avgLatencyMs }`
 * (handler:467-478). The handler computes weighted-average latency
 * across the two sources.
 */
export const ObsDeliveryStatsContract = defineContract({
  method: "obs.delivery.stats",
  request: z.object({}),
  response: z.object({
    total: z.number(),
    successes: z.number(),
    failures: z.number(),
    avgLatencyMs: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.context.pipeline
// ---------------------------------------------------------------------------

/**
 * `obs.context.pipeline` — Context engine pipeline snapshots
 * (PipelineSnapshot ring buffer). Admin scope at the gateway router
 * — handler body has NO in-handler `_trustLevel` check (the gateway
 * router's `registerRpcPassthrough(..., "admin")` registration is
 * the sole gate). The contract scope reflects the gateway-level
 * gate; the bidirectional 1:1 architecture test is
 * registration-plane-agnostic.
 *
 * Request: `{ agentId?, limit? }`.
 *
 * Response: Bare array of PipelineSnapshot rows (handler:487).
 * Returns `[]` when `contextPipelineCollector` is undefined
 * (handler:487 nullish-coalesce). PipelineSnapshot has 14+ fields
 * including nested `layers` array + `evictionCategories` record —
 * modeled loose.
 */
export const ObsContextPipelineContract = defineContract({
  method: "obs.context.pipeline",
  request: z.object({
    agentId: z.string().optional(),
    limit: z.number().optional(),
  }),
  response: ObsRecordArray,
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.context.dag
// ---------------------------------------------------------------------------

/**
 * `obs.context.dag` — Context engine DAG compaction snapshots
 * (DagCompactionSnapshot ring buffer). Admin scope at the gateway
 * router — same no-in-handler-check exception as
 * `obs.context.pipeline`.
 *
 * Request: `{ agentId?, limit? }`.
 *
 * Response: Bare array of DagCompactionSnapshot rows (handler:496).
 * Returns `[]` when `contextPipelineCollector` is undefined.
 * DagCompactionSnapshot has 8 fields — modeled loose.
 */
export const ObsContextDagContract = defineContract({
  method: "obs.context.dag",
  request: z.object({
    agentId: z.string().optional(),
    limit: z.number().optional(),
  }),
  response: ObsRecordArray,
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// agent.cacheStats
// ---------------------------------------------------------------------------

/**
 * `agent.cacheStats` — Per-provider cache hit rate + cumulative
 * savings (SQLite aggregation). Admin-only (in-handler gate;
 * handler:504).
 *
 * Request: `{ sinceMs? }`.
 *
 * Response: `{ providers, totalCacheSaved }`. Each row in `providers`
 * carries `{ provider, model, callCount, totalCost, totalCacheSaved,
 *   cacheHitRate }` (handler:516-525) — modeled loose.
 * `totalCacheSaved` is the sum across all rows (handler:527).
 *
 * Returns `{ providers: [], totalCacheSaved: 0 }` when `obsStore`
 * is undefined (handler:509).
 */
export const AgentCacheStatsContract = defineContract({
  method: "agent.cacheStats",
  request: z.object({
    sinceMs: z.number().optional(),
  }),
  response: z.object({
    providers: ObsRecordArray,
    totalCacheSaved: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.getCacheStats
// ---------------------------------------------------------------------------

/**
 * `obs.getCacheStats` — In-memory cache hit rate + effectiveness
 * (delegates to `tokenTracker`). Admin-only (in-handler gate;
 * handler:537).
 *
 * Request: `{}`.
 *
 * Response: `{ cacheHitRate, cacheEffectiveness }` (handler:543-546).
 * Returns `{ cacheHitRate: 0, cacheEffectiveness: 0 }` when
 * `tokenTracker` is undefined (handler:540).
 */
export const ObsGetCacheStatsContract = defineContract({
  method: "obs.getCacheStats",
  request: z.object({}),
  response: z.object({
    cacheHitRate: z.number(),
    cacheEffectiveness: z.number(),
  }),
  scopes: ["admin"] as const,
});

/** `obs.cacheStats.window` — durable cache stats from
 *  `obs_token_usage`. Admin-only. CacheStatsWindow SSOT lives in
 *  `@comis/observability`. Tenant deferred (no `tenant_id`). */
export const ObsCacheStatsWindowContract = defineContract({
  method: "obs.cacheStats.window",
  request: z.object({
    sinceMs: z.number().int().nonnegative(), untilMs: z.number().int().nonnegative().optional(),
    agent: z.string().min(1).optional(), provider: z.string().min(1).optional(),
  }),
  response: z.object({ window: ObsRecord }),
  scopes: ["admin"] as const,
});

/** `obs.cacheBreaks.byReason` — cache-break rate by reason + the $-lost SUM
 *  (WEBUI-02, 179-04). Admin-only. The rows are `{reason, count, estCostUsd}[]`
 *  GROUP BY'd server-side over the existing `category:'cache_break'` diagnostics
 *  index — content-free (a closed reason label + two numbers). The Cache Health
 *  view consumes it. Rides the loose ObsRecordArray (bundle-size budget). */
export const ObsCacheBreaksByReasonContract = defineContract({
  method: "obs.cacheBreaks.byReason",
  request: z.object({
    since: z.number().int().nonnegative().optional(),
    until: z.number().int().nonnegative().optional(),
  }),
  response: z.object({ rows: ObsRecordArray }),
  scopes: ["admin"] as const,
});

/** `obs.spend.snapshot` — the LIVE per-agent/tenant/global spend the kill-switch
 *  sees (WEBUI-02, 179-04; locked A1 — the live accumulator, NOT the lagging SQL).
 *  Admin-only. The snapshot carries the per-scope spend + the configured ceilings →
 *  headroom + a three-state pricing-coverage count. Content-free (dollar counts +
 *  scope enums + pricing-state counts). The Spend & Governance view consumes it.
 *  Empty request, so the contract-handler-parity gate trivially passes. */
export const ObsSpendSnapshotContract = defineContract({
  method: "obs.spend.snapshot",
  request: z.object({}),
  response: z.object({ snapshot: ObsRecord }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// memory.embeddingCache
// ---------------------------------------------------------------------------

/**
 * `memory.embeddingCache` — Embedding cache status (enabled flag +
 * L1 stats + L2 placeholder + circuit-breaker state). Admin-only
 * (in-handler gate; handler:554).
 *
 * Request: `{}`.
 *
 * Response: `{ enabled, l1?, l2?, provider?, vecAvailable, circuitBreaker }`.
 *   - `enabled: false` shape (handler:557-562): `{ enabled: false,
 *     vecAvailable, circuitBreaker }`.
 *   - `enabled: true` shape (handler:566-580): `{ enabled: true,
 *     l1: { entries, maxEntries, hitRate, hits, misses }, l2: null,
 *     provider, vecAvailable, circuitBreaker: { state } }`.
 *
 * The `circuitBreaker.state` field is a string union
 * (`"closed" | "open" | "halfOpen" | "unknown"` — handler:559-562,
 * 577-579 mirrors the CircuitState enum from @comis/agent). Modeled
 * as `z.string()` here because the `"unknown"` branch is a literal
 * the handler emits when no circuit-breaker callback is wired
 * (handler:561, 579) — narrower modeling via `z.enum` would also
 * work but `z.string()` keeps the contract surface stable if a
 * future circuit-breaker variant adds a new state.
 *
 * Both shapes share `enabled` / `vecAvailable` / `circuitBreaker` as
 * required; `l1` / `l2` / `provider` are optional (present only on
 * the `enabled: true` branch). Modeled as a single z.object with
 * the optional-field projection rather than a discriminated union —
 * z.union IS in the 12-shape allowlist but would force every
 * consumer to discriminate on `enabled` which is over-engineering
 * for a status RPC.
 */
export const MemoryEmbeddingCacheContract = defineContract({
  method: "memory.embeddingCache",
  request: z.object({}),
  response: z.object({
    enabled: z.boolean(),
    l1: ObsRecord.optional(),
    l2: z.nullable(ObsRecord).optional(),
    provider: z.string().optional(),
    vecAvailable: z.boolean(),
    circuitBreaker: z.object({
      state: z.string(),
    }),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.reset
// ---------------------------------------------------------------------------

/**
 * `obs.reset` — Clear all observability data (in-memory + SQLite).
 * Admin-only (in-handler gate; handler:588). Emits
 * `observability:reset` event with `table: "all"` (handler:608-613).
 *
 * Request: `{}`.
 *
 * Response: `{ reset: true, rowsDeleted }` where `rowsDeleted` is
 * `{ tokenUsage, delivery, diagnostics, channels }` (handler:602,
 * 615). When `obsStore` is undefined, `rowsDeleted` is all-zeros
 * (handler:602 default).
 */
export const ObsResetContract = defineContract({
  method: "obs.reset",
  request: z.object({}),
  response: z.object({
    reset: z.literal(true),
    rowsDeleted: ResetRowsDeletedSchema,
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.reset.table
// ---------------------------------------------------------------------------

/**
 * `obs.reset.table` — Clear a specific observability table
 * (in-memory + SQLite). Admin-only (in-handler gate; handler:623).
 * The handler validates `table` against an explicit allowlist
 * (`["token_usage", "delivery", "diagnostics", "channels"]` —
 * handler:626) and throws `"Invalid table: ${table}. Valid: …"`
 * otherwise (handler:628). The contract mirrors that allowlist via
 * `z.enum`.
 *
 * Request: `{ table }`.
 *
 * Response: `{ reset: true, table, rowsDeleted }` (handler:655).
 * `rowsDeleted` is the number of rows removed from the SQLite table
 * (or 0 when `obsStore` is undefined — handler:638).
 */
export const ObsResetTableContract = defineContract({
  method: "obs.reset.table",
  request: z.object({
    table: z.enum(["token_usage", "delivery", "diagnostics", "channels"]),
  }),
  response: z.object({
    reset: z.literal(true),
    table: z.string(),
    rowsDeleted: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.systemPromptReport.latest
// ---------------------------------------------------------------------------

/**
 * `obs.systemPromptReport.latest` — Latest SystemPromptReport for a
 * given (agentId, sessionId) tuple. Admin-only (in-handler gate per
 * the existing house pattern).
 *
 * Request: `{ agentId, sessionId, runId? }`. The optional `runId`
 * narrows further to the most-recent report for that turn.
 *
 * Response: `{ report: SystemPromptReport | null }`. Null when no
 * report is persisted for the tuple. SystemPromptReport is modeled
 * loose (`z.record(z.string(), z.unknown())`) — same approach as the
 * 18 other obs.* contracts here. The authoritative shape lives at
 * `@comis/observability#SystemPromptReportSchema` (Zod) and
 * `@comis/observability#SystemPromptReport` (Type); the CLI/web
 * consumers narrow against those at the surface layer.
 *
 * Loose-modeling rationale (matches the file-header policy at line
 * 55-67): SystemPromptReport carries 8+ top-level fields, several
 * optional nested objects, and `injectedWorkspaceFiles[]` /
 * `tools.entries[]` / `skills.entries[]` arrays of nested records.
 * Modeling tightly here would duplicate the SSOT in
 * @comis/observability and break on every minor field addition; the
 * record schema preserves dev-mode runtime safety + handler
 * type-narrowing without creating a @comis/core → @comis/observability
 * dependency.
 */
export const ObsSystemPromptReportLatestContract = defineContract({
  method: "obs.systemPromptReport.latest",
  request: z.object({
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().optional(),
  }),
  response: z.object({
    report: z.nullable(ObsRecord),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.systemPromptReport.list
// ---------------------------------------------------------------------------

/**
 * `obs.systemPromptReport.list` — N most-recent SystemPromptReports
 * for a session. Admin-only.
 *
 * Request: `{ sessionId, limit? }`. `limit` defaults to 10 and is
 * capped at 100 to keep response size bounded.
 *
 * Response: `{ reports: SystemPromptReport[] }` (loose-modeled per
 * the same rationale as `latest`).
 */
export const ObsSystemPromptReportListContract = defineContract({
  method: "obs.systemPromptReport.list",
  request: z.object({
    sessionId: z.string().min(1),
    /** Default 10, max 100 (enforced at the handler). Contracts use the
     *  12-shape allowlist; `.default()` is not in it, so the default
     *  lives in the handler body. */
    limit: z.number().int().positive().max(100).optional(),
  }),
  response: z.object({
    reports: ObsRecordArray,
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.trace.export / obs.trace.search / obs.trace.tail
// Handler: packages/daemon/src/api/obs-handlers/obs-trace.ts
// CLI:     packages/cli/src/commands/trace.ts
// ---------------------------------------------------------------------------

/** Export a full session trace bundle. `sessionId` is required (min 1). */
export const ObsTraceExportContract = defineContract({
  method: "obs.trace.export",
  request: z.object({
    sessionId: z.string().min(1),
  }),
  response: z.object({
    bundlePath: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * Search trace rows by messageId / traceId / chatId / since / where.
 * All request fields are optional; `limit` max 1000.
 */
export const ObsTraceSearchContract = defineContract({
  method: "obs.trace.search",
  request: z.object({
    messageId: z.string().optional(),
    traceId: z.string().optional(),
    chatId: z.string().optional(),
    since: z.string().optional(),
    where: z.string().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    // D9: admin opt-in to include synthetic/test sessions (excluded by default).
    includeSynthetic: z.boolean().optional(),
  }),
  response: z.object({
    rows: ObsRecordArray,
  }),
  scopes: ["admin"] as const,
});

/**
 * Poll for live trace events on a chat. `chatId` required (min 1).
 * `limit` max 100. True WebSocket streaming deferred to v2.
 */
export const ObsTraceTailContract = defineContract({
  method: "obs.trace.tail",
  request: z.object({
    chatId: z.string().min(1),
    sinceMs: z.number().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  response: z.object({
    events: ObsRecordArray,
    nextSinceMs: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// Domain array — registered into API_CONTRACTS_ORDERED in index.ts.
// ---------------------------------------------------------------------------

/**
 * Observability contract array. Registered into
 * `API_CONTRACTS_ORDERED` by
 * `packages/core/src/api-contracts/index.ts`.
 *
 * Order: alphabetical by method name. The bidirectional 1:1
 * architecture test treats this array as an unordered set, so
 * ordering is documentation-only.
 */
export const OBSERVABILITY_CONTRACTS = [
  AgentCacheStatsContract,
  MemoryEmbeddingCacheContract,
  ObsBillingByAgentContract,
  ObsBillingByProviderContract,
  ObsBillingBySessionContract,
  ObsBillingTotalContract,
  ObsBillingUsage24hContract,
  ObsAuditQueryContract,
  ObsCacheBreaksByReasonContract,
  ObsCacheStatsWindowContract,
  ObsChannelsAllContract,
  ObsChannelsGetContract,
  ObsChannelsStaleContract,
  ObsContextDagContract,
  ObsContextPipelineContract,
  ObsDeliveryRecentContract,
  ObsDeliveryStatsContract,
  ObsDiagnosticsContract,
  ObsExplainContract,
  ObsFleetHealthContract,
  ObsGetCacheStatsContract,
  ObsResetContract,
  ObsResetTableContract,
  ObsSpendSnapshotContract,
  ObsSystemPromptReportLatestContract,
  ObsSystemPromptReportListContract,
  ObsTraceExportContract,
  ObsTraceSearchContract,
  ObsTraceTailContract,
] as const;
