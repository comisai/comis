// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Heartbeat RPC handler module.
 * Factory-pattern heartbeat handlers returning Record<string, RpcHandler>:
 *   heartbeat.states  — Per-agent heartbeat state DTO array
 *   heartbeat.get     — Read per-agent and effective heartbeat config
 *   heartbeat.update  — Patch heartbeat config with deep-merge and YAML persistence
 *   heartbeat.trigger — Invoke immediate heartbeat execution for an agent
 *
 * Handlers are registered via computed-property keys
 * `[<Contract>.method]:` so the bidirectional 1:1 architecture test
 * resolves them to the registry. Per-method pipeline: bespoke pre-Zod
 * guards FIRST (using rawParams reads — preserves user-friendly error
 * messages matching the existing handler-test assertions) →
 * stripInternalFields → request.parse → existing business logic →
 * dev-mode response.parse.
 *
 * @module
 */

import { AuthorizationError } from "./errors.js";
import {
  HeartbeatStatesContract,
  HeartbeatGetContract,
  HeartbeatUpdateContract,
  HeartbeatTriggerContract,
  PerAgentHeartbeatConfigSchema,
  PerAgentSchedulerConfigSchema,
  stripInternalFields,
  systemGetEnv,
} from "@comis/core";
import { resolveEffectiveHeartbeatConfig } from "@comis/scheduler";
import { persistToConfig } from "./shared/persist-to-config.js";
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

// Re-aliased from the cluster slice in api/types.ts. Single source of
// truth: OrchestratorApiDeps (shared with cron, graph, subagent handlers).
import type { OrchestratorApiDeps as HeartbeatHandlerDeps } from "./types.js";
export type { HeartbeatHandlerDeps };

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Create heartbeat RPC handlers.
 * @param deps - Injected coordinator, agents, persistence, and global heartbeat config
 * @returns Record mapping method names to handler functions
 */
export function createHeartbeatHandlers(deps: HeartbeatHandlerDeps): Record<string, RpcHandler> {
  return {
    // -------------------------------------------------------------------------
    // heartbeat.states -- existing handler
    // -------------------------------------------------------------------------
    [HeartbeatStatesContract.method]: async (rawParams) => {
      const userParams = stripInternalFields(rawParams);
      HeartbeatStatesContract.request.parse(userParams);

      const agents: Array<{
        agentId: string;
        enabled: boolean;
        intervalMs: number;
        nextDueAtMs: number | null;
      }> = [];

      for (const [agentId, config] of Object.entries(deps.agents)) {
        const effective = resolveEffectiveHeartbeatConfig(
          deps.globalHeartbeatConfig as Parameters<typeof resolveEffectiveHeartbeatConfig>[0],
          config.scheduler?.heartbeat,
        );
        const next = effective.enabled
          ? deps.heartbeatCoordinator?.getNextPeriodicPhaseMs(agentId)
          : undefined;
        agents.push({
          agentId,
          enabled: effective.enabled,
          intervalMs: effective.intervalMs,
          nextDueAtMs: next?.ok ? next.value : null,
        });
      }

      const result = { agents };
      if (IS_DEV) HeartbeatStatesContract.response.parse(result);
      return result;
    },

    // -------------------------------------------------------------------------
    // heartbeat.get — read per-agent and effective config
    // -------------------------------------------------------------------------
    [HeartbeatGetContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const agentId = (rawParams?.agentId ?? rawParams?._agentId) as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const userParams = stripInternalFields(rawParams);
      HeartbeatGetContract.request.parse(userParams);

      const perAgent = deps.agents[agentId]?.scheduler?.heartbeat ?? {};

      // Build effective config if global defaults are available
      let effective: Record<string, unknown> | undefined;
      if (deps.globalHeartbeatConfig) {
        try {
          const resolved = resolveEffectiveHeartbeatConfig(
            deps.globalHeartbeatConfig as Parameters<typeof resolveEffectiveHeartbeatConfig>[0],
            Object.keys(perAgent).length > 0 ? perAgent : undefined,
          );
          effective = resolved as unknown as Record<string, unknown>;
        } catch {
          // If global config is malformed, skip effective resolution
          effective = undefined;
        }
      }

      const result = { agentId, perAgent, effective };
      if (IS_DEV) HeartbeatGetContract.response.parse(result);
      return result;
    },

    // -------------------------------------------------------------------------
    // heartbeat.update -- patch heartbeat config with deep-merge + persistence
    // -------------------------------------------------------------------------
    [HeartbeatUpdateContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST (preserves user-friendly error messages).
      const trustLevel = rawParams?._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for heartbeat configuration");
      }

      const agentId = (rawParams?.agentId ?? rawParams?._agentId) as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      if (deps.agents[agentId] === undefined) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const userParams = stripInternalFields(rawParams);
      const params = HeartbeatUpdateContract.request.parse(userParams);

      // Build partial update from params (only include defined fields)
      const update: Record<string, unknown> = {};

      if (params.enabled !== undefined) update.enabled = params.enabled;
      if (params.intervalMs !== undefined) update.intervalMs = params.intervalMs;
      if (params.showOk !== undefined) update.showOk = params.showOk;
      if (params.showAlerts !== undefined) update.showAlerts = params.showAlerts;
      if (params.target !== undefined) update.target = params.target;
      if (params.prompt !== undefined) update.prompt = params.prompt;
      if (params.allowDm !== undefined) update.allowDm = params.allowDm;
      if (params.lightContext !== undefined) update.lightContext = params.lightContext;
      if (params.ackMaxChars !== undefined) update.ackMaxChars = params.ackMaxChars;
      if (params.responsePrefix !== undefined) update.responsePrefix = params.responsePrefix;
      if (params.alertThreshold !== undefined) update.alertThreshold = params.alertThreshold;
      if (params.alertCooldownMs !== undefined) update.alertCooldownMs = params.alertCooldownMs;
      if (params.staleMs !== undefined) update.staleMs = params.staleMs;

      // Deep-merge with existing per-agent heartbeat config
      const existing = deps.agents[agentId]?.scheduler?.heartbeat ?? {};
      const merged: Record<string, unknown> = { ...existing, ...update };

      // Validate merged config against schema
      const validated = PerAgentHeartbeatConfigSchema.parse(merged);
      const effective = resolveEffectiveHeartbeatConfig(
        deps.globalHeartbeatConfig as Parameters<typeof resolveEffectiveHeartbeatConfig>[0],
        validated,
      );
      if (!deps.heartbeatCoordinator || !deps.getAgentSchedulerSeed) {
        throw new Error("Heartbeat coordinator not available");
      }
      const seed = deps.getAgentSchedulerSeed(agentId);
      if (!seed.ok) throw new Error("Heartbeat scheduler seed not available");
      const configured = deps.heartbeatCoordinator.configurePeriodicHeartbeat({
        agentId,
        agentSchedulerSeed: seed.value,
        enabled: effective.enabled,
        intervalMs: effective.intervalMs,
      });
      if (!configured.ok) throw new Error("Heartbeat schedule update failed");

      // Apply in-memory: ensure scheduler config exists
      if (!deps.agents[agentId].scheduler) {
        deps.agents[agentId].scheduler = PerAgentSchedulerConfigSchema.parse({});
      }
      deps.agents[agentId].scheduler!.heartbeat = validated;

      // Persist to YAML config if deps available
      if (deps.persistDeps) {
        const persistResult = await persistToConfig(deps.persistDeps, {
          patch: { agents: { [agentId]: { scheduler: { heartbeat: validated as unknown as Record<string, unknown> } } } },
          actionType: "heartbeat.update",
          entityId: agentId,
          actingUser: (rawParams._agentId as string | undefined),
          traceId: (rawParams._traceId as string | undefined),
        });
        if (!persistResult.ok) {
          deps.persistDeps.logger.warn(
            {
              method: "heartbeat.update",
              agentId,
              err: persistResult.error,
              hint: "Heartbeat config updated in memory but YAML persistence failed",
              errorKind: "config" as const,
            },
            "Heartbeat config persistence failed",
          );
        }
      }

      const result = {
        agentId,
        config: validated as unknown as Record<string, unknown>,
        updated: true,
        nextDueAtMs: configured.value.nextDueAtMs,
      };
      if (IS_DEV) HeartbeatUpdateContract.response.parse(result);
      return result;
    },

    // -------------------------------------------------------------------------
    // heartbeat.trigger -- immediate heartbeat execution
    // -------------------------------------------------------------------------
    [HeartbeatTriggerContract.method]: async (rawParams) => {
      // Bespoke pre-Zod validation FIRST.
      const trustLevel = rawParams?._trustLevel as string | undefined;
      if (trustLevel !== "admin") {
        throw new AuthorizationError("Admin access required for heartbeat trigger");
      }

      const agentId = (rawParams?.agentId ?? rawParams?._agentId) as string | undefined;
      if (!agentId) {
        throw new Error("Missing required parameter: agentId");
      }

      const userParams = stripInternalFields(rawParams);
      HeartbeatTriggerContract.request.parse(userParams);
      if (deps.agents[agentId] === undefined) throw new Error(`Agent not found: ${agentId}`);
      if (!deps.heartbeatCoordinator) throw new Error("Heartbeat coordinator not available");
      const admitted = deps.heartbeatCoordinator.submitWake({
        target: { kind: "agent", agentId },
        reason: "manual",
        timing: { kind: "spacing_bypass", notBeforeMs: deps.schedulerNowMs() },
      });
      if (!admitted.ok) throw new Error(`Heartbeat admission failed: ${admitted.error.code}`);

      const result = { agentId, admission: admitted.value };
      if (IS_DEV) HeartbeatTriggerContract.response.parse(result);
      return result;
    },
  };
}
