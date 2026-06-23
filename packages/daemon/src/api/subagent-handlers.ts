// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Subagent RPC handler module.
 *
 * Handles sub-agent lifecycle management RPC methods:
 *   subagent.list, subagent.kill, subagent.steer
 *
 * List returns filtered runs from SubAgentRunner. Kill marks a running
 * run as failed. Steer is flag-gated on security.agentToAgent.steerInject
 * (STEER-01): OFF (default) → kill+respawn with a new task (status "steered");
 * ON → inject the message into the running child's live session at its next
 * step boundary (no kill/respawn, same runId, status "steered_inject").
 * Rate-limited at 2s per target (shared across both branches).
 *
 * Per-method pipeline: bespoke pre-Zod guards FIRST (using rawParams reads
 * — preserves user-friendly error messages matching the existing
 * handler-test assertions) → stripInternalFields → request.parse →
 * business logic → dev-mode response.parse.
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
// Dev-mode response parse helper
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

// Re-aliased from the cluster slice in api/types.ts.
// Single source of truth: OrchestratorApiDeps (shared with cron, graph,
// heartbeat handlers).
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

      // STEER-01: flag-gated branch. Flag ON → inject into the live child (no
      // kill, no respawn — transcript + progress preserved, same runId). Flag
      // OFF (default) → the historical kill+respawn, BYTE-IDENTICAL. The 2s
      // rate-limit above is shared by both branches.
      if (deps.securityConfig.agentToAgent?.steerInject) {
        const run = deps.subAgentRunner.getRunStatus(target);
        if (!run) {
          throw new Error(`Unknown run ID: ${target}`);
        }
        // WR-02: mirror killRun's status guard (sub-agent-runner.ts:1910-1912).
        // getRunStatus returns a run for ANY status still inside the retention
        // window; a steer aimed at a completed/failed/queued run has no live
        // handle, so fail fast with an actionable status-named error instead of
        // proceeding to the generic "No live session" throw from steerRun.
        if (run.status !== "running") {
          throw new Error(
            `Run ${target} is not running (status: ${run.status}) — cannot steer; use kill+respawn instead.`,
          );
        }
        const steerResult = await deps.subAgentRunner.steerRun(target, message);
        if (!steerResult.steered) {
          // WR-03 (§2.7): the inject-failure branch is a path an operator must
          // diagnose. Log a WARN with an actionable hint + errorKind before the
          // throw (which the @allow-throw dispatcher converts to a JSON-RPC
          // error) — never the steer message body. The success branch already
          // logs INFO + emits subagent:steered; this gives the failure branch
          // the matching observability so `comis explain` / daemon.log can
          // distinguish a no-live-handle miss from a finished run.
          deps.logger?.warn(
            {
              runId: target,
              agentId: run.agentId,
              hint: "Steer could not reach a live child session; the run may have finished or its SDK handle was not registered under the resolved key — verify with subagent.list, or use kill+respawn",
              errorKind: "precondition" as const,
            },
            "Sub-agent steer inject failed (no live session)",
          );
          throw new Error(steerResult.error!);
        }
        // Counts/ids/mode only — NEVER the steer message body (AGENTS.md §2.7).
        deps.eventBus?.emit("subagent:steered", {
          runId: target,
          agentId: run.agentId,
          mode: steerResult.mode!,
          timestamp: systemNowMs(),
        });
        deps.logger?.info(
          { runId: target, agentId: run.agentId, mode: steerResult.mode },
          "Sub-agent steered (inject) at next step boundary",
        );
        const injectResult = { status: "steered_inject" as const, runId: target };
        if (IS_DEV) SubagentSteerContract.response.parse(injectResult);
        return injectResult;
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
      // Phase 213 CR-01: the respawn must stay in the KILLED run's spawn tree, so
      // inherit its rootRunId (+ the authorizing parentLeaseId). Without this the
      // steer-respawn minted a fresh root → a later run.kill {rootRunId} of the
      // original tree would miss the steered continuation (a survivor — REVOKE-03).
      const newRunId = deps.subAgentRunner.spawn({
        task: message,
        agentId: run.agentId,
        callerSessionKey: rawParams._callerSessionKey as string | undefined,
        callerAgentId: rawParams._agentId as string | undefined,
        ...(run.rootRunId !== undefined ? { rootRunId: run.rootRunId } : {}),
        ...(run.parentLeaseId !== undefined ? { parentLeaseId: run.parentLeaseId } : {}),
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
