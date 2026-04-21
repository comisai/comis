// SPDX-License-Identifier: Apache-2.0
/**
 * Lifecycle hooks for subagent spawn preparation and completion.
 *
 * Provides two best-effort hooks:
 * - `prepareSpawn()`: Creates a disk directory for the subagent run, emits
 *   a spawn-prepared event, and returns a rollback handle for cleanup.
 * - `onEnded()`: Emits a lifecycle-ended event with end reason, runtime,
 *   tokens, cost, and condensation level. Supplements (does not replace)
 *   the inline condensation/casting/announcement pipeline.
 *
 * Both hooks use belt defense: internal try/catch so they never throw
 * to the caller. Failures are logged as WARN and the spawn proceeds.
 *
 * @module
 */

import type { ContextEngineConfig, SubagentContextConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for the lifecycle hooks factory. */
export interface LifecycleHooksDeps {
  /** Structurally typed Pino-compatible logger. */
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  /** Structurally typed event bus. */
  eventBus: {
    emit(event: string, data: unknown): void;
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create lifecycle hooks for subagent spawn preparation and completion.
 *
 * The returned object provides `prepareSpawn` and `onEnded` methods,
 * both of which are best-effort (never throw to caller).
 */
export function createLifecycleHooks(deps: LifecycleHooksDeps) {
  return {
    /**
     * Prepare a disk directory for the subagent run and emit a spawn-prepared event.
     *
     * Returns a rollback handle for cleaning up the directory on spawn failure,
     * or `undefined` if preparation fails (belt defense).
     */
    async prepareSpawn(params: {
      runId: string;
      parentSessionKey: string;
      childSessionKey: string;
      agentId: string;
      task: string;
      depth: number;
      maxDepth: number;
    }): Promise<{ rollback: () => Promise<void> } | undefined> {
      try {
        // No directory pre-creation: result-condenser (success) and persistFailureRecord
        // (failure) each create their own directories on write. Pre-creating here produced
        // orphan directories on the success path (different naming convention) and the
        // rollback deleted failure records on the failure path.

        // Emit spawn-prepared event
        deps.eventBus.emit("session:sub_agent_spawn_prepared", {
          runId: params.runId,
          parentSessionKey: params.parentSessionKey,
          agentId: params.agentId,
          task: params.task,
          depth: params.depth,
          maxDepth: params.maxDepth,
          artifactCount: 0,
          timestamp: Date.now(),
        });

        deps.logger.info(
          { runId: params.runId, agentId: params.agentId, depth: params.depth, packetSize: params.task.length },
          "Subagent spawn prepared",
        );

        return undefined;
      } catch (hookErr) {
        // Belt defense: never throw to caller
        deps.logger.warn(
          {
            runId: params.runId,
            err: hookErr,
            hint: "prepareSubagentSpawn hook internal error",
            errorKind: "internal",
          },
          "Lifecycle hook: prepareSpawn internal error",
        );
        return undefined;
      }
    },

    /**
     * Emit a lifecycle-ended event after the subagent execution completes.
     *
     * This hook only emits events -- it does NOT run condensation, casting,
     * or injection. Those remain inline in sub-agent-runner.ts (
     * supplements, does not replace).
     */
    async onEnded(params: {
      runId: string;
      agentId: string;
      parentSessionKey: string;
      childSessionKey: string;
      endReason: "completed" | "failed" | "killed" | "watchdog_timeout" | "ghost_sweep";
      condensedResult?: { level: 1 | 2 | 3; condensedTokens?: number };
      runtimeMs: number;
      tokensUsed: number;
      cost: number;
    }): Promise<void> {
      try {
        deps.eventBus.emit("session:sub_agent_lifecycle_ended", {
          runId: params.runId,
          agentId: params.agentId,
          parentSessionKey: params.parentSessionKey,
          endReason: params.endReason,
          durationMs: params.runtimeMs,
          tokensUsed: params.tokensUsed,
          cost: params.cost,
          condensationLevel: params.condensedResult?.level,
          timestamp: Date.now(),
        });

        deps.logger.info(
          { runId: params.runId, agentId: params.agentId, endReason: params.endReason, durationMs: params.runtimeMs, condensedTokens: params.condensedResult?.condensedTokens ?? 0 },
          "Subagent lifecycle ended",
        );
      } catch (hookErr) {
        // Belt defense: never throw to caller
        deps.logger.warn(
          {
            runId: params.runId,
            err: hookErr,
            hint: "onSubagentEnded hook internal error",
            errorKind: "internal",
          },
          "Lifecycle hook: onEnded internal error",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Config inheritance (standalone pure function, not inside the factory)
// ---------------------------------------------------------------------------

/**
 * Derive a subagent context engine config from parent config + subagent overrides.
 * Derive context engine config for a subagent from the parent's config.
 * Subagent inherits parent pipeline settings via spread copy (parent not mutated).
 *
 * Config inheritance.
 *
 * NOTE: autoCompactThreshold (0.95) is NOT mapped here. Its relationship to the
 * context engine's COMPACTION_TRIGGER_PERCENT constant is unclear.
 */
export function deriveSubagentContextEngineConfig(
  parentConfig: ContextEngineConfig,
  _subagentConfig: SubagentContextConfig,
): ContextEngineConfig {
  return { ...parentConfig };
}
