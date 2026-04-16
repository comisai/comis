/**
 * Subagent RPC handler module.
 * Handles sub-agent lifecycle management RPC methods:
 *   subagent.list, subagent.kill, subagent.steer
 * List returns filtered runs from SubAgentRunner. Kill marks a running
 * run as failed. Steer kills the current run and respawns with a new task,
 * rate-limited at 2s per target.
 * @module
 */

import type { createSubAgentRunner } from "../sub-agent-runner.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by subagent RPC handlers. */
export interface SubagentHandlerDeps {
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
  defaultAgentId: string;
  tenantId: string;
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
}

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
    "subagent.list": async (params) => {
      const recentMinutes = (params.recentMinutes as number | undefined) ?? 30;
      const runs = deps.subAgentRunner.listRuns(recentMinutes);
      return { runs, total: runs.length };
    },

    "subagent.kill": async (params) => {
      const target = params.target as string;
      if (!target) throw new Error("Missing required parameter: target");

      const result = deps.subAgentRunner.killRun(target);
      if (!result.killed) {
        throw new Error(result.error!);
      }
      return { killed: true, runId: target };
    },

    "subagent.steer": async (params) => {
      const target = params.target as string;
      const message = params.message as string;
      if (!target) throw new Error("Missing required parameter: target");
      if (!message) throw new Error("Missing required parameter: message");

      // Rate limit: 2s between steers to same target
      const lastSteer = steerTimestamps.get(target);
      if (lastSteer && Date.now() - lastSteer < 2000) {
        throw new Error("Rate limited: wait 2s between steers to same target");
      }
      steerTimestamps.set(target, Date.now());

      // Prune stale entries older than 1 hour to prevent unbounded growth
      const ONE_HOUR = 60 * 60 * 1000;
      const now = Date.now();
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

      // Respawn with new task
      const newRunId = deps.subAgentRunner.spawn({
        task: message,
        agentId: run.agentId,
        callerSessionKey: params._callerSessionKey as string | undefined,
        callerAgentId: params._agentId as string | undefined,
      });

      deps.logger?.info(
        { oldRunId: target, newRunId, agentId: run.agentId },
        "Sub-agent steered to new task",
      );

      return { status: "steered", oldRunId: target, newRunId };
    },
  };
}
