// SPDX-License-Identifier: Apache-2.0
/**
 * Observability-domain RPC contracts. Mirrors
 * `packages/daemon/src/api/obs-handlers.ts`.
 *
 * The obs-handlers.ts factory exposes 18 admin-scoped methods. Every
 * method is gated by `registerRpcPassthrough(..., "admin")` in
 * `packages/daemon/src/wiring/setup-gateway-api.ts`, so every contract
 * carries `scopes: ["admin"] as const`. Most methods additionally
 * perform an in-handler `_trustLevel === "admin"` check for defense in
 * depth; two methods (`obs.context.pipeline` + `obs.context.dag`) rely
 * SOLELY on the gateway-router scope gate (no in-handler check —
 * handler bodies pass through directly to the context-pipeline
 * collector).
 *
 * The 18 methods (alphabetical within sub-group):
 *
 *   Diagnostics (1):
 *   - `obs.diagnostics` (admin) — Query diagnostic events by
 *     category / time / limit. Returns `{ events, counts }` where
 *     `events` is a merged array (in-memory + SQLite) of
 *     DiagnosticEvent objects (loose-modeled).
 *
 *   Billing (5):
 *   - `obs.billing.byProvider` (admin) — `{ providers: ProviderBilling[] }`.
 *   - `obs.billing.byAgent`    (admin) — BillingSnapshot + optional
 *     `budgetUsed` wrapper.
 *   - `obs.billing.bySession`  (admin) — BillingSnapshot.
 *   - `obs.billing.total`      (admin) — BillingSnapshot.
 *   - `obs.billing.usage24h`   (admin) — Array of `{ hour, tokens }`
 *     (TokenUsagePoint[]).
 *
 *   Channels (3):
 *   - `obs.channels.all`   (admin) — `{ channels: ChannelActivity[] }`.
 *   - `obs.channels.stale` (admin) — `{ stale: ChannelActivity[] }`.
 *   - `obs.channels.get`   (admin) — `{ channel: ChannelActivity | null }`.
 *
 *   Delivery (2):
 *   - `obs.delivery.recent` (admin) — `{ deliveries: DeliveryContext[] }`.
 *   - `obs.delivery.stats`  (admin) — `{ total, successes, failures, avgLatencyMs }`.
 *
 *   Context (2 — NO in-handler admin check; gateway scope gate is sole gate):
 *   - `obs.context.pipeline` (admin) — Array of PipelineSnapshot.
 *   - `obs.context.dag`      (admin) — Array of DagCompactionSnapshot.
 *
 *   Cache (3):
 *   - `agent.cacheStats`     (admin) — `{ providers, totalCacheSaved }`.
 *   - `obs.getCacheStats`    (admin) — `{ cacheHitRate, cacheEffectiveness }`.
 *   - `memory.embeddingCache` (admin) — Enabled-flag + L1 stats + circuit-breaker state.
 *
 *   Reset (2):
 *   - `obs.reset`        (admin) — `{ reset: true, rowsDeleted }`.
 *   - `obs.reset.table`  (admin) — `{ reset: true, table, rowsDeleted }`.
 *
 * **Loose-record use.** Many response shapes (DiagnosticEvent,
 * DeliveryContext, ChannelActivity, ProviderBilling, PipelineSnapshot,
 * DagCompactionSnapshot) carry deeply nested fields, optional members,
 * and `Record<string, unknown>` sub-fields (e.g.,
 * `DiagnosticEvent.data`, `DeliveryContext.metadata`,
 * `PipelineSnapshot.evictionCategories`). Modelling them tighter would
 * require pinning every sub-shape's wire format. The escape hatch is
 * `z.record(z.string(), z.unknown())` (and
 * `z.array(z.record(z.string(), z.unknown()))` for array-valued
 * payloads). All wire-observable shapes pass through this projection
 * cleanly because the handler's TypeScript types are structurally
 * record-shaped at every nested level. The handler's existing test
 * suite (61 tests in obs-handlers.test.ts) remains the authoritative
 * shape validator.
 *
 * **CLI exemption (web-SPA only — verified via empty grep).** The CLI
 * has ZERO `client.call("obs.*"|"agent.cacheStats"|"memory.embeddingCache", ...)`
 * sites — confirmed by:
 *   ```
 *   grep -rln 'client\.call("obs\.\|client\.call("agent\.cacheStats\|client\.call("memory\.embeddingCache' packages/cli/src/
 *   ```
 *   (returns empty)
 *
 * The 18 observability methods are dispatched ONLY from the web SPA
 * (`packages/web/src/views/`) where the contract registry is consumed
 * via the codegen-generated artifact (packages/web/src/api/
 * contracts.generated.ts). The CLI doctor probes consume the
 * OAuthCredentialStorePort directly (NOT via obs.*) — see
 * `packages/cli/src/doctor/checks/oauth-health.ts` which has zero
 * obs/agent/memory RPC calls.
 *
 * **Two in-handler-admin-check exceptions (`obs.context.*`).** Both
 * `obs.context.pipeline` and `obs.context.dag` lack an explicit
 * `if (_trustLevel !== "admin") throw …` check in the handler body.
 * They rely on the gateway router's `registerRpcPassthrough(..., "admin")`
 * registration as the sole trust gate. The contract `scopes: ["admin"]`
 * is consistent with the gateway-side gate; the test suite deliberately
 * calls these handlers without `_trustLevel` and expects success —
 * preserving this contract makes the contract layer
 * registration-plane-agnostic.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

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
 * Shared BillingSnapshot shape (mirrors
 * `packages/daemon/src/observability/billing-estimator.ts` lines
 * 15-21). Plain numerics — safe to model tightly.
 */
const BillingSnapshotSchema = z.object({
  totalCost: z.number(),
  totalTokens: z.number(),
  callCount: z.number(),
  totalCacheSaved: z.number().optional(),
});

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
 * limit. Admin-only (in-handler `_trustLevel === "admin"` gate;
 * obs-handlers.ts:66-69).
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
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.billing.byProvider
// ---------------------------------------------------------------------------

/**
 * `obs.billing.byProvider` — Per-provider billing breakdown (sorted
 * by `totalCost` desc — handler:183). Admin-only (in-handler gate;
 * handler:117).
 *
 * Request: `{ sinceMs? }`.
 *
 * Response: `{ providers: ProviderBilling[] }`. Each row carries
 * `{ provider, totalCost, totalTokens, callCount, totalCacheSaved?,
 *   models: Array<{ model, cost, tokens, calls }> }` — modeled loose
 * (nested model array would otherwise require tight pinning).
 */
export const ObsBillingByProviderContract = defineContract({
  method: "obs.billing.byProvider",
  request: z.object({
    sinceMs: z.number().optional(),
  }),
  response: z.object({
    providers: ObsRecordArray,
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.billing.byAgent
// ---------------------------------------------------------------------------

/**
 * `obs.billing.byAgent` — Billing snapshot for a specific agent +
 * optional budgetUsed wrapper. Admin-only (in-handler gate;
 * handler:192). The `agentId` parameter is required and the handler
 * throws `"Invalid request: agentId parameter is required"`
 * (handler:194) when absent — the contract uses `z.string().min(1)`
 * to mirror that gate.
 *
 * Request: `{ agentId, sinceMs? }`.
 *
 * Response: `BillingSnapshot & { budgetUsed?: { perExecution, perHour, perDay } }`
 * (handler:232-241). The handler spreads `merged` (a BillingSnapshot)
 * then adds an optional `budgetUsed` field — modeled as a loose
 * record because `perExecution`/`perHour`/`perDay` carry a nested
 * `{ used, limit? }` shape.
 */
export const ObsBillingByAgentContract = defineContract({
  method: "obs.billing.byAgent",
  request: z.object({
    agentId: z.string().min(1),
    sinceMs: z.number().optional(),
  }),
  response: z.object({
    totalCost: z.number(),
    totalTokens: z.number(),
    callCount: z.number(),
    totalCacheSaved: z.number().optional(),
    budgetUsed: ObsRecord.optional(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.billing.bySession
// ---------------------------------------------------------------------------

/**
 * `obs.billing.bySession` — Billing snapshot for a specific session.
 * Admin-only (in-handler gate; handler:249). `sessionKey` required
 * (handler:251).
 *
 * Request: `{ sessionKey, sinceMs? }`.
 *
 * Response: BillingSnapshot directly (no wrapper) — handler:261-266.
 */
export const ObsBillingBySessionContract = defineContract({
  method: "obs.billing.bySession",
  request: z.object({
    sessionKey: z.string().min(1),
    sinceMs: z.number().optional(),
  }),
  response: BillingSnapshotSchema,
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.billing.total
// ---------------------------------------------------------------------------

/**
 * `obs.billing.total` — Overall billing totals. Admin-only
 * (in-handler gate; handler:274).
 *
 * Request: `{ sinceMs? }`.
 *
 * Response: BillingSnapshot directly (handler:301-306). Includes
 * `totalCacheSaved` aggregation.
 */
export const ObsBillingTotalContract = defineContract({
  method: "obs.billing.total",
  request: z.object({
    sinceMs: z.number().optional(),
  }),
  response: BillingSnapshotSchema,
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// obs.billing.usage24h
// ---------------------------------------------------------------------------

/**
 * `obs.billing.usage24h` — Token usage aggregated by hour-of-day for
 * the last 24 hours. Admin-only (in-handler gate; handler:314).
 *
 * Request: `{}` (no parameters — the 24-hour window is hardcoded
 * inside billingEstimator.usage24h() — billing-estimator.ts).
 *
 * Response: Array of `{ hour, tokens }` (TokenUsagePoint[]) — the
 * handler returns the bare array (handler:335). Modeled as
 * `z.array(z.record(z.string(), z.unknown()))` per the
 * array-of-loose-records pattern.
 *
 * Note: at the contract level the bare array-of-records is the
 * response root. `z.array` IS in the 12-shape allowlist; root-level
 * non-object responses are permitted.
 */
export const ObsBillingUsage24hContract = defineContract({
  method: "obs.billing.usage24h",
  request: z.object({}),
  response: ObsRecordArray,
  scopes: ["admin"] as const,
});

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
// obs.systemPromptReport.latest (Plan 45-04)
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
// obs.systemPromptReport.list (Plan 45-04)
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
  ObsChannelsAllContract,
  ObsChannelsGetContract,
  ObsChannelsStaleContract,
  ObsContextDagContract,
  ObsContextPipelineContract,
  ObsDeliveryRecentContract,
  ObsDeliveryStatsContract,
  ObsDiagnosticsContract,
  ObsGetCacheStatsContract,
  ObsResetContract,
  ObsResetTableContract,
  ObsSystemPromptReportLatestContract,
  ObsSystemPromptReportListContract,
] as const;
