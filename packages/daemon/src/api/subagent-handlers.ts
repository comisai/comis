// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321 (Phase 41 TS-HYG-07; per 41-03-SUMMARY.md Decision 2).
/**
 * Subagent RPC handler module.
 * Handles sub-agent lifecycle management RPC methods:
 *   subagent.list, subagent.kill, subagent.steer
 * List returns filtered runs from SubAgentRunner. Kill marks a running
 * run as failed. Steer kills the current run and respawns with a new task,
 * rate-limited at 2s per target.
 *
 * Phase 35 Wave C plan 35-18: refactored to computed-property keys
 * `[<Contract>.method]:` so the bidirectional 1:1 architecture test
 * resolves them to the registry. Per-method pipeline: bespoke pre-Zod
 * guards FIRST (using rawParams reads — preserves user-friendly error
 * messages matching the existing handler-test assertions) →
 * stripInternalFields → request.parse → existing business logic
 * UNCHANGED → dev-mode response.parse (D-10).
 *
 * @module
 */

import {
  SubagentListContract,
  SubagentKillContract,
  SubagentSteerContract,
  stripInternalFields,
  systemGetEnv,
  systemNowMs,
} from "@comis/core";

import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Dev-mode response parse helper (D-10)
// ---------------------------------------------------------------------------

/**
 * Run `contract.response.parse(result)` only when NODE_ENV !== "production".
 * Daemon side is the trust boundary; in production the trust check is
 * the in-handler logic, not the contract parse.
 */
const IS_DEV = systemGetEnv("NODE_ENV") !== "production";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-aliased from the cluster slice in api/types.ts (Plan 34-08a).
// Single source of truth: OrchestratorApiDeps (shared with cron, graph,
// heartbeat handlers). DAEMON-API-03 Option A retarget — handler bodies and
// call sites unchanged.
import type { OrchestratorApiDeps as SubagentHandlerDeps } from "./types.js";
export type { SubagentHandlerDeps };

// ---------------------------------------------------------------------------
// Rate-limit state for steer
// ---------------------------------------------------------------------------

const steerTimestamps = new Map<string, number>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a record of subagent RPC handlers bound to the given deps.
 */
export function createSubagentHandlers(deps: SubagentHandlerDeps): Record<string, RpcHandler> {
  return {
    [SubagentListContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      const params = SubagentListContract.request.parse(userParams);

      const recentMinutes = params.recentMinutes ?? 30;
      const runs = deps.subAgentRunner.listRuns(recentMinutes);
      const result = { runs, total: runs.length };
      if (IS_DEV) SubagentListContract.response.parse(result);
      return result;
    },

    [SubagentKillContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST (preserves user-friendly error messages).
      const target = rawParams.target as string | undefined;
      if (!target) throw new Error("Missing required parameter: target");

      const userParams = stripInternalFields(rawParams);
      SubagentKillContract.request.parse(userParams);

      const killResult = deps.subAgentRunner.killRun(target);
      if (!killResult.killed) {
        throw new Error(killResult.error!);
      }
      const result = { killed: true, runId: target };
      if (IS_DEV) SubagentKillContract.response.parse(result);
      return result;
    },

    [SubagentSteerContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST (preserves user-friendly error messages).
      const target = rawParams.target as string | undefined;
      const message = rawParams.message as string | undefined;
      if (!target) throw new Error("Missing required parameter: target");
      if (!message) throw new Error("Missing required parameter: message");

      const userParams = stripInternalFields(rawParams);
      SubagentSteerContract.request.parse(userParams);

      // Rate limit: 2s between steers to same target
      const lastSteer = steerTimestamps.get(target);
      if (lastSteer && systemNowMs() - lastSteer < 2000) {
        throw new Error("Rate limited: wait 2s between steers to same target");
      }
      steerTimestamps.set(target, systemNowMs());

      // Prune stale entries older than 1 hour to prevent unbounded growth
      const ONE_HOUR = 60 * 60 * 1000;
      const now = systemNowMs();
      for (const [key, ts] of steerTimestamps) {
        if (now - ts > ONE_HOUR) {
          steerTimestamps.delete(key);
        }
      }

      // Kill the current run
      const killResult = deps.subAgentRunner.killRun(target);
      if (!killResult.killed) {
        throw new Error(killResult.error!);
      }

      // Get the killed run's details for respawn
      const run = deps.subAgentRunner.getRunStatus(target);
      if (!run) {
        throw new Error(`Run details not found after kill: ${target}`);
      }

      // Respawn with new task — reads internal fields directly off rawParams.
      const newRunId = deps.subAgentRunner.spawn({
        task: message,
        agentId: run.agentId,
        callerSessionKey: rawParams._callerSessionKey as string | undefined,
        callerAgentId: rawParams._agentId as string | undefined,
      });

      deps.logger?.info(
        { oldRunId: target, newRunId, agentId: run.agentId },
        "Sub-agent steered to new task",
      );

      const result = { status: "steered" as const, oldRunId: target, newRunId };
      if (IS_DEV) SubagentSteerContract.response.parse(result);
      return result;
    },
  };
}
