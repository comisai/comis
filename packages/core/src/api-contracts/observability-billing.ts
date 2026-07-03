// SPDX-License-Identifier: Apache-2.0
/**
 * The five `obs.billing.*` contracts (per-provider / per-agent / per-session /
 * total / 24h usage) + the billing-only `BillingSnapshot` response schema.
 * Extracted from `observability.ts` to keep that module under the file-size cap
 * (the same sibling-split pattern as incident-report.ts).
 *
 * Barrel-only: external consumers import these from `"@comis/core"`. The
 * `observability.ts` barrel re-exports every contract here (and the
 * `OBSERVABILITY_CONTRACTS` array pulls them in) so the public surface and the
 * registered RPC contract set are byte-identical — no wire-shape change.
 *
 * Handler: packages/daemon/src/api/obs-handlers.ts
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "./types.js";

// ---------------------------------------------------------------------------
// Shared sub-schemas — loose-record projection.
//
// `ObsRecord` / `ObsRecordArray` mirror the identically-named aliases in
// `observability.ts` (the file-header loose-record policy applies). They are
// declared locally here — rather than imported from the barrel — to keep this
// sibling self-contained and avoid a `observability ↔ observability-billing`
// import cycle (matching the self-contained `incident-report.ts` precedent).
// ---------------------------------------------------------------------------

/**
 * Loose-record escape hatch for arbitrary-shaped record payloads
 * (`z.record(z.string(), z.unknown())`). Mirrors `observability.ts#ObsRecord`.
 */
const ObsRecord = z.record(z.string(), z.unknown());

/**
 * Array-of-loose-records — used by handlers that return a bare array at the
 * response root (`obs.billing.usage24h`). Mirrors
 * `observability.ts#ObsRecordArray`.
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
 * Response: `BillingSnapshot & { budgetUsed?: { perExecution, perHour, perDay },
 * tools?: ToolCost[] }`. The handler spreads `merged` (a BillingSnapshot) then
 * adds an optional `budgetUsed` field — modeled as a loose record because
 * `perExecution`/`perHour`/`perDay` carry a nested `{ used, limit? }` shape — and
 * the optional `tools[]` per-tool even-split (`aggregateToolCostByAgent`;
 * present-only when non-empty), modeled as a loose-record array (the per-tool
 * `{ tool, cost, tokens, calls }` rows — content-free names + numbers).
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
    tools: ObsRecordArray.optional(),
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
