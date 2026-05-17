// SPDX-License-Identifier: Apache-2.0
/**
 * Subagent-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/subagent-handlers.ts` (3 methods —
 * subagent.*). Spread order in `SUBAGENT_HANDLERS_CONTRACTS` matches the
 * orchestrator contracts array byte for byte to keep
 * `contracts.generated.*` artifacts byte-identical.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// --- subagent-handlers.ts ---
// ===========================================================================

// ---------------------------------------------------------------------------
// subagent.list
// ---------------------------------------------------------------------------

/**
 * `subagent.list` — List sub-agent runs (filtered by recentMinutes). Admin-
 * scoped per setup-gateway-api.ts:207-209. Handler path:
 * subagent-handlers.ts:40-44.
 *
 * Request: `{ recentMinutes? }`. Defaults to 30.
 * Response: `{ runs, total }`. Each run is a loose-record (SubAgentRun shape
 *   varies — carries runId, agentId, task, state, spawn metadata).
 */
export const SubagentListContract = defineContract({
  method: "subagent.list",
  request: z.object({
    recentMinutes: z.number().optional(),
  }),
  response: z.object({
    runs: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.kill
// ---------------------------------------------------------------------------

/**
 * `subagent.kill` — Mark a running sub-agent run as failed. Admin-scoped per
 * setup-gateway-api.ts:207-209. Handler path: subagent-handlers.ts:46-55.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - killRun returns !killed → throws with the result's error message.
 *
 * Request: `{ target }`. `target` is the runId.
 * Response: `{ killed, runId }`.
 */
export const SubagentKillContract = defineContract({
  method: "subagent.kill",
  request: z.object({
    target: z.string(),
  }),
  response: z.object({
    killed: z.boolean(),
    runId: z.string(),
  }),
  scopes: ["admin"] as const,
});

// ---------------------------------------------------------------------------
// subagent.steer
// ---------------------------------------------------------------------------

/**
 * `subagent.steer` — Kill current run and respawn with a new task.
 * Rate-limited at 2s per target. Admin-scoped per setup-gateway-api.ts:207-209.
 * Handler path: subagent-handlers.ts:57-105.
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - Missing `message` → `"Missing required parameter: message"`.
 *   - Rate-limit (< 2s since last steer to same target) → `"Rate limited: wait
 *     2s between steers to same target"`.
 *   - killRun !killed → throws.
 *   - getRunStatus undefined after kill → `"Run details not found after kill: <id>"`.
 *
 * Request: `{ target, message }`.
 * Response: `{ status, oldRunId, newRunId }`. `status` is literal "steered".
 */
export const SubagentSteerContract = defineContract({
  method: "subagent.steer",
  request: z.object({
    target: z.string(),
    message: z.string(),
  }),
  response: z.object({
    status: z.literal("steered"),
    oldRunId: z.string(),
    newRunId: z.string(),
  }),
  scopes: ["admin"] as const,
});

/**
 * subagent-handlers slice (3 contracts — subagent.*). Spread order matches
 * the orchestrator contracts array byte for byte — determinism-critical
 * for codegen output stability.
 */
export const SUBAGENT_HANDLERS_CONTRACTS = [
  SubagentListContract,
  SubagentKillContract,
  SubagentSteerContract,
] as const;
