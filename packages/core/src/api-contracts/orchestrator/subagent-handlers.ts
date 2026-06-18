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
 * `subagent.steer` — Steer a running sub-agent. Flag-gated on
 * `security.agentToAgent.steerInject` (default false, STEER-01):
 *   - flag OFF (default): kill the current run and respawn with a new task
 *     (the historical behavior) → `{ status: "steered", oldRunId, newRunId }`.
 *   - flag ON: inject the message into the RUNNING child's live SDK session at
 *     its next step boundary (transcript + progress preserved, same runId; no
 *     kill, no respawn) → `{ status: "steered_inject", runId }`.
 * Rate-limited at 2s per target (shared across both branches).
 * Admin-scoped per setup-gateway-api.ts:207-209. Handler path:
 * subagent-handlers.ts (subagent.steer).
 *
 * Bespoke pre-Zod validation:
 *   - Missing `target` → `"Missing required parameter: target"`.
 *   - Missing `message` → `"Missing required parameter: message"`.
 *   - Rate-limit (< 2s since last steer to same target) → `"Rate limited: wait
 *     2s between steers to same target"`.
 *   - flag OFF: killRun !killed → throws; getRunStatus undefined after kill →
 *     `"Run details not found after kill: <id>"`.
 *   - flag ON: getRunStatus undefined → `"Unknown run ID: <id>"`; steerRun
 *     `!steered` → throws the steerRun error (e.g. no live session).
 *
 * Request: `{ target, message }`.
 * Response: discriminated union on `status` —
 *   `{ status: "steered", oldRunId, newRunId }` (kill+respawn) |
 *   `{ status: "steered_inject", runId }` (live inject).
 */
export const SubagentSteerContract = defineContract({
  method: "subagent.steer",
  request: z.object({
    target: z.string(),
    message: z.string(),
  }),
  response: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("steered"),
      oldRunId: z.string(),
      newRunId: z.string(),
    }),
    z.object({
      status: z.literal("steered_inject"),
      runId: z.string(),
    }),
  ]),
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
