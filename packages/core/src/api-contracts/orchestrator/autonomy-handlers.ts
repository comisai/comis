// SPDX-License-Identifier: Apache-2.0
/**
 * Autonomy-handlers contract slice (213-03 — REVOKE-01/03).
 *
 * The two operator-facing live-control RPC methods of the bounded-autonomy
 * control plane:
 *   - `lease.revoke` — cooperative stop: revoke a capability lease by `leaseId`
 *     OR every lease of a spawn tree by `rootRunId`; the next RPC the bearer
 *     makes is then denied.
 *   - `run.kill` — hard stop: kill the whole spawn tree by `rootRunId` (abort
 *     each SDK session) AND revoke its leases.
 *
 * Both are `scopes:["admin"]`. That declaration is LOAD-BEARING: the admin set
 * is DERIVED from `scopes:["admin"]` contracts (rpc-dispatch.ts), so each method
 * lands in `ADMIN_METHODS` and the dispatch chokepoint's `assertNotAgentOrigin`
 * denies any agent-origin (`_agentId`-bearing) call automatically — the
 * deny-by-origin guarantee (REVOKE-01 "external to + non-bypassable by the
 * agent"), with NO manual `_agentId` check anywhere (a manual check would
 * drift). Mirrors `subagent-handlers.ts` (the admin-RPC contract template); the
 * daemon handlers driving the LeaseManager revoke fan-outs + the runner's
 * `killByRootRun` land in Plan 06.
 *
 * Spread order in `AUTONOMY_HANDLERS_CONTRACTS` matches the orchestrator
 * contracts array byte for byte to keep `contracts.generated.*` artifacts
 * byte-identical (the codegen re-sorts by method name; the slice order is
 * documentation).
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// --- autonomy-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// lease.revoke
// ---------------------------------------------------------------------------

/**
 * `lease.revoke` — Revoke a capability lease (cooperative stop). Admin-scoped
 * → deny-by-origin. Handler path: autonomy-handlers.ts (Plan 06).
 *
 * Request: `{ leaseId?, rootRunId? }` — one-of. `leaseId` revokes a single
 *   lease; `rootRunId` revokes every lease of that spawn tree (the handler
 *   enforces "exactly one" and rejects neither/both).
 * Response: `{ revoked }` — the count of leases revoked (non-negative; 0 when
 *   the selector matched nothing).
 */
export const LeaseRevokeContract = defineContract({
  method: "lease.revoke",
  request: z.object({
    leaseId: z.string().optional(),
    rootRunId: z.string().optional(),
  }),
  response: z.object({
    revoked: z.number().int().nonnegative(),
  }),
  scopes: ["admin"] as const, // → ADMIN_METHODS → deny-by-origin
});

// ---------------------------------------------------------------------------
// run.kill
// ---------------------------------------------------------------------------

/**
 * `run.kill` — Kill a whole spawn tree (hard stop). Admin-scoped →
 * deny-by-origin. Handler path: autonomy-handlers.ts (Plan 06). Drives the
 * runner's `killByRootRun` (abort every SDK session of the tree) AND
 * `leaseManager.revokeByRootRun` (revoke its leases).
 *
 * Request: `{ rootRunId }` — the root run identifying the tree.
 * Response: `{ killed }` — the count of runs killed (non-negative).
 */
export const RunKillContract = defineContract({
  method: "run.kill",
  request: z.object({
    rootRunId: z.string(),
  }),
  response: z.object({
    killed: z.number().int().nonnegative(),
  }),
  scopes: ["admin"] as const, // → ADMIN_METHODS → deny-by-origin
});

/**
 * autonomy-handlers slice (2 contracts — lease.revoke + run.kill). Spread
 * order matches the orchestrator contracts array byte for byte —
 * determinism-critical for codegen output stability.
 */
export const AUTONOMY_HANDLERS_CONTRACTS = [LeaseRevokeContract, RunKillContract] as const;
