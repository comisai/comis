// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat RPC handler module.
 * Factory-pattern heartbeat handlers returning Record<string, RpcHandler>:
 *   heartbeat.states  — Per-agent heartbeat state DTO array
 *   heartbeat.get     — Read per-agent and effective heartbeat config
 *   heartbeat.update  — Patch heartbeat config with deep-merge and YAML persistence
 *   heartbeat.trigger — Invoke immediate heartbeat execution for an agent
 * @module
 */

import type { PerAgentConfig } from "@comis/core";
import { PerAgentHeartbeatConfigSchema, PerAgentSchedulerConfigSchema } from "@comis/core";
import type { PerAgentHeartbeatRunner } from "@comis/scheduler";
import { resolveEffectiveHeartbeatConfig } from "@comis/scheduler";
import { persistToConfig, type PersistToConfigDeps } from "./persist-to-config.js";
import type { RpcHandler } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for heartbeat RPC handler registration. */
export interface HeartbeatHandlerDeps {
  /** Per-agent heartbeat runner (optional -- returns empty when not configured). */
  perAgentRunner?: PerAgentHeartbeatRunner;
  /** Runtime agents map keyed by agent ID. */
  agents: Record<string, PerAgentConfig>;
  /** Optional persistence deps for writing changes to config.yaml. */
  persistDeps?: PersistToConfigDeps;
  /** Global scheduler.heartbeat defaults for effective config resolution. */
  globalHeartbeatConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Create heartbeat RPC handlers.
 * @param deps - Injected dependencies (perAgentRunner, agents, persistDeps, globalHeartbeatConfig)
 * @returns Record mapping method names to handler functions
 */
export function createHeartbeatHandlers(deps: HeartbeatHandlerDeps): Record<string, RpcHandler> {
  return {
    // -------------------------------------------------------------------------
    // heartbeat.states -- existing handler
    // -------------------------------------------------------------------------
    "heartbeat.states": async () => {
    if (!deps.perAgentRunner) {
      return { agents: [] };
    }

    const states = deps.perAgentRunner.getAgentStates();
    const agents: Array<{
      agentId: string;
      enabled: boolean;
      intervalMs: number;
      lastRunMs: number;
      nextDueMs: number;
      consecutiveErrors: number;
      backoffUntilMs: number;
      tickStartedAtMs: number;
      lastAlertMs: number;
      lastErrorKind: "transient" | "permanent" | null;
    }> = [];

    for (const state of states.values()) {
      agents.push({
        agentId: state.agentId,
        enabled: state.config.enabled,
        intervalMs: state.config.intervalMs,
        lastRunMs: state.lastRunMs,
        nextDueMs: state.nextDueMs,
        consecutiveErrors: state.consecutiveErrors,
        backoffUntilMs: state.backoffUntilMs,
        tickStartedAtMs: state.tickStartedAtMs,
        lastAlertMs: state.lastAlertMs,
        lastErrorKind: state.lastErrorKind,
      });
    }

    return { agents };
  },

  // -------------------------------------------------------------------------
  // heartbeat.get -- read per-agent and effective config
  // -------------------------------------------------------------------------
  "heartbeat.get": async (params) => {
    const agentId = (params?.agentId ?? params?._agentId) as string | undefined;
    if (!agentId) {
      throw new Error("Missing required parameter: agentId");
    }

    if (deps.agents[agentId] === undefined) {
      throw new Error(`Agent not found: ${agentId}`);
    }

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

    return { agentId, perAgent, effective };
  },

  // -------------------------------------------------------------------------
  // heartbeat.update -- patch heartbeat config with deep-merge + persistence
  // -------------------------------------------------------------------------
  "heartbeat.update": async (params) => {
    const trustLevel = params?._trustLevel as string | undefined;
    if (trustLevel !== "admin") {
      throw new Error("Admin access required for heartbeat configuration");
    }

    const agentId = (params?.agentId ?? params?._agentId) as string | undefined;
    if (!agentId) {
      throw new Error("Missing required parameter: agentId");
    }

    if (deps.agents[agentId] === undefined) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    // Build partial update from params (only include defined fields)
    const update: Record<string, unknown> = {};

    if (params.enabled !== undefined) update.enabled = params.enabled;
    if (params.intervalMs !== undefined) update.intervalMs = params.intervalMs;
    if (params.showOk !== undefined) update.showOk = params.showOk;
    if (params.showAlerts !== undefined) update.showAlerts = params.showAlerts;
    if (params.prompt !== undefined) update.prompt = params.prompt;
    if (params.model !== undefined) update.model = params.model;
    if (params.session !== undefined) update.session = params.session;
    if (params.allowDm !== undefined) update.allowDm = params.allowDm;
    if (params.lightContext !== undefined) update.lightContext = params.lightContext;
    if (params.ackMaxChars !== undefined) update.ackMaxChars = params.ackMaxChars;
    if (params.responsePrefix !== undefined) update.responsePrefix = params.responsePrefix;
    if (params.skipHeartbeatOnlyDelivery !== undefined) update.skipHeartbeatOnlyDelivery = params.skipHeartbeatOnlyDelivery;
    if (params.alertThreshold !== undefined) update.alertThreshold = params.alertThreshold;
    if (params.alertCooldownMs !== undefined) update.alertCooldownMs = params.alertCooldownMs;
    if (params.staleMs !== undefined) update.staleMs = params.staleMs;

    // Build target sub-object if any target fields provided
    const targetChannelType = params.targetChannelType as string | undefined;
    const targetChannelId = params.targetChannelId as string | undefined;
    const targetChatId = params.targetChatId as string | undefined;
    const targetIsDm = params.targetIsDm as boolean | undefined;
    if (targetChannelType !== undefined || targetChannelId !== undefined || targetChatId !== undefined || targetIsDm !== undefined) {
      const target: Record<string, unknown> = {};
      if (targetChannelType !== undefined) target.channelType = targetChannelType;
      if (targetChannelId !== undefined) target.channelId = targetChannelId;
      if (targetChatId !== undefined) target.chatId = targetChatId;
      if (targetIsDm !== undefined) target.isDm = targetIsDm;
      update.target = target;
    }

    // Deep-merge with existing per-agent heartbeat config
    const existing = deps.agents[agentId]?.scheduler?.heartbeat ?? {};
    const merged: Record<string, unknown> = { ...existing, ...update };

    // Deep-merge target sub-object separately
    if (update.target) {
      const existingTarget = (existing as Record<string, unknown>).target as Record<string, unknown> | undefined;
      merged.target = { ...existingTarget, ...update.target as Record<string, unknown> };
    }

    // Validate merged config against schema
    const validated = PerAgentHeartbeatConfigSchema.parse(merged);

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
        actingUser: (params._agentId as string | undefined),
        traceId: (params._traceId as string | undefined),
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

    return { agentId, config: validated, updated: true };
  },

  // -------------------------------------------------------------------------
  // heartbeat.trigger -- immediate heartbeat execution
  // -------------------------------------------------------------------------
  "heartbeat.trigger": async (params) => {
    const trustLevel = params?._trustLevel as string | undefined;
    if (trustLevel !== "admin") {
      throw new Error("Admin access required for heartbeat trigger");
    }

    const agentId = (params?.agentId ?? params?._agentId) as string | undefined;
    if (!agentId) {
      throw new Error("Missing required parameter: agentId");
    }

    if (!deps.perAgentRunner) {
      throw new Error("Heartbeat runner not available");
    }

    // Fire-and-forget: runAgentOnce triggers an immediate tick
    deps.perAgentRunner.runAgentOnce(agentId);

    return { agentId, triggered: true };
  },
  };
}
