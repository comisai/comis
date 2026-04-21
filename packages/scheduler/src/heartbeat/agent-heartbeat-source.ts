// SPDX-License-Identifier: Apache-2.0
/**
 * AgentHeartbeatSource: Factory that creates the onTick callback for
 * PerAgentHeartbeatRunner, bridging heartbeat timers to the full
 * agent executor.
 *
 * Execution flow per tick:
 * 1. Resolve effective config and agent config
 * 2. Resolve session key and format it
 * 3. Peek system events to determine trigger kind
 * 4. File gate check (interval triggers only)
 * 5. Queue-busy check (skip if session already active)
 * 6. Assemble tools for agent
 * 7. Drain events and build prompt
 * 8. Create synthetic NormalizedMessage
 * 9. Execute via injected executor (wrapped in runWithContext)
 * 10. Deliver response via delivery bridge (fire-and-forget)
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import type { SessionKey, NormalizedMessage } from "@comis/core";
import { formatSessionKey, runWithContext } from "@comis/core";
import type { SchedulerLogger } from "../shared-types.js";
import type { SystemEventQueue } from "../system-events/system-event-queue.js";
import type { EffectiveHeartbeatConfig } from "./heartbeat-config.js";
import type { DeliveryBridgeDeps, DeliveryTarget, DeliveryOptions } from "./delivery-bridge.js";
import type { HeartbeatNotification } from "./heartbeat-runner.js";
import { deliverHeartbeatNotification } from "./delivery-bridge.js";
import { shouldBypassFileGates } from "./file-gate.js";
import type { HeartbeatMemoryStats } from "./prompt-builder.js";
import { resolveHeartbeatTriggerKind, buildHeartbeatPrompt } from "./prompt-builder.js";
import { processHeartbeatResponse } from "./response-processor.js";
import type { HeartbeatResponseOutcome } from "./response-processor.js";
import { classifyHeartbeatResult } from "./relevance-filter.js";

// ---------------------------------------------------------------------------
// Types for injected dependencies (scheduler cannot import agent)
// ---------------------------------------------------------------------------

/** Minimal executor interface for heartbeat -- 5-param subset of AgentExecutor. */
interface HeartbeatExecutor {
  execute(
    msg: NormalizedMessage,
    sessionKey: SessionKey,
    tools?: unknown[],
    agentId?: string,
    overrides?: {
      model?: string;
      operationType?: string;
      promptTimeout?: { promptTimeoutMs?: number; retryPromptTimeoutMs?: number };
      cacheRetention?: string;
    },
  ): Promise<{ response: string }>;
}

/** Minimal ActiveRunRegistry -- only needs has() for queue-busy check. */
interface HeartbeatActiveRunRegistry {
  has(sessionKey: string): boolean;
}

/** Injected session side-effects for heartbeat response processing. */
export interface HeartbeatSessionOps {
  /** Remove the last user+assistant turn from session transcript. */
  pruneLastTurn(sessionKey: string): Promise<void>;
  /** Restore session updatedAt to its pre-tick value. */
  preserveUpdatedAt(sessionKey: string, originalUpdatedAt: number): Promise<void>;
  /** Store last heartbeat text+timestamp per session for duplicate detection. */
  storeLastHeartbeat(sessionKey: string, text: string, sentAt: number): void;
  /** Retrieve last heartbeat text+timestamp for a session. */
  getLastHeartbeat(sessionKey: string): { text: string; sentAt: number } | undefined;
}

/** Dependencies for the AgentHeartbeatSource factory. */
export interface AgentHeartbeatSourceDeps {
  /** Get the executor for a given agent. */
  getExecutor: (agentId: string) => HeartbeatExecutor;
  /** Assemble all configured tools for an agent. */
  assembleToolsForAgent: (agentId: string) => Promise<unknown[]>;
  /** Get the resolved heartbeat config for an agent. */
  getEffectiveConfig: (agentId: string) => EffectiveHeartbeatConfig;
  /** Get agent-level config (model, tenantId). */
  getAgentConfig: (agentId: string) => { model: string; tenantId: string };
  /** Returns true if HEARTBEAT.md is effectively empty (should skip LLM). */
  checkFileGate: (agentId: string) => Promise<boolean>;
  /** Session-scoped system event queue. */
  systemEventQueue: SystemEventQueue;
  /** Delivery bridge dependencies for routing notifications. */
  deliveryBridge: DeliveryBridgeDeps;
  /** Optional ActiveRunRegistry for queue-busy detection. */
  activeRunRegistry?: HeartbeatActiveRunRegistry;
  /** Optional session operations for response processing side-effects. */
  sessionOps?: HeartbeatSessionOps;
  /** Optional: fetch memory stats for an agent (for heartbeat prompt injection). */
  getMemoryStats?: (agentId: string, tenantId: string) => HeartbeatMemoryStats | undefined;
  /** Logger instance. */
  logger: SchedulerLogger;
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Three-tier model resolution for heartbeat execution.
 *
 * Priority: per-agent heartbeat model > global heartbeat model > agent default model.
 *
 * Currently HeartbeatConfigSchema has no `model` field at the global level,
 * so `globalHeartbeatModel` is always `undefined`. The three-tier signature
 * future-proofs for when it's added.
 */
export function resolveHeartbeatModel(
  perAgentHeartbeatModel: string | undefined,
  globalHeartbeatModel: string | undefined,
  agentDefaultModel: string,
): string {
  return perAgentHeartbeatModel ?? globalHeartbeatModel ?? agentDefaultModel;
}

/**
 * Check if a session is actively running an agent turn.
 *
 * Returns false when no ActiveRunRegistry is provided (heartbeat
 * operates in isolation without collision detection).
 */
export function isQueueBusy(
  activeRunRegistry: HeartbeatActiveRunRegistry | undefined,
  sessionKey: string,
): boolean {
  if (!activeRunRegistry) return false;
  return activeRunRegistry.has(sessionKey);
}

/**
 * Resolve the SessionKey for a heartbeat tick.
 *
 * When a delivery target is configured, uses the target's chatId as channelId
 * and config.session as userId. Falls back to synthetic heartbeat identifiers.
 */
export function resolveHeartbeatSessionKey(
  agentId: string,
  config: EffectiveHeartbeatConfig,
  tenantId: string,
): SessionKey {
  if (config.target) {
    return {
      tenantId,
      userId: config.session ?? "heartbeat",
      channelId: config.target.chatId,
    };
  }
  return {
    tenantId,
    userId: "heartbeat",
    channelId: `heartbeat-${agentId}`,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an AgentHeartbeatSource that produces the `onTick` callback
 * consumed by PerAgentHeartbeatRunner.
 */
export function createAgentHeartbeatSource(
  deps: AgentHeartbeatSourceDeps,
): { onTick: (agentId: string) => Promise<void> } {
  const { logger } = deps;

  async function onTick(agentId: string): Promise<void> {
    try {
      // 1. Resolve configs
      const config = deps.getEffectiveConfig(agentId);
      const agentConfig = deps.getAgentConfig(agentId);

      // 2. Resolve session key
      const sessionKey = resolveHeartbeatSessionKey(agentId, config, agentConfig.tenantId);
      const formattedKey = formatSessionKey(sessionKey);

      // 3. Peek events and resolve trigger kind
      const events = deps.systemEventQueue.peek(formattedKey);
      const trigger = resolveHeartbeatTriggerKind(events);

      // 4. File gate check for interval triggers
      if (trigger === "interval" && !shouldBypassFileGates(trigger)) {
        const isEmpty = await deps.checkFileGate(agentId);
        if (isEmpty) {
          logger.debug(
            { agentId, trigger },
            "Heartbeat skipped: HEARTBEAT.md effectively empty",
          );
          return;
        }
      }

      // 5. Queue-busy check
      if (isQueueBusy(deps.activeRunRegistry, formattedKey)) {
        logger.debug(
          { agentId, formattedKey },
          "Heartbeat skipped: session queue busy",
        );
        return;
      }

      // 6. Assemble tools
      const tools = await deps.assembleToolsForAgent(agentId);

      // 6.5 Fetch memory stats for conditional prompt injection
      let memoryStats: HeartbeatMemoryStats | undefined;
      if (deps.getMemoryStats) {
        try {
          memoryStats = deps.getMemoryStats(agentId, agentConfig.tenantId);
        } catch (e) {
          logger.debug({ err: e, agentId }, "Failed to fetch memory stats for heartbeat");
        }
      }

      // 7. Drain events and build prompt
      const drainedEvents = deps.systemEventQueue.drain(formattedKey);
      const promptText = buildHeartbeatPrompt(trigger, drainedEvents, config, memoryStats);

      // 8. Create synthetic NormalizedMessage
      const msg: NormalizedMessage = {
        id: `heartbeat-${randomUUID()}`,
        channelId: sessionKey.channelId,
        channelType: config.target?.channelType ?? "heartbeat",
        senderId: "system",
        text: promptText,
        timestamp: Date.now(),
        attachments: [],
        metadata: {
          trigger: "heartbeat",
          isScheduled: true,
          triggerKind: trigger,
          agentId,
          lightContext: config.lightContext ?? false,
        },
      };

      // 9. Resolve model (for logging)
      const model = resolveHeartbeatModel(
        undefined, // per-agent heartbeat model removed in Phase 2
        undefined, // global heartbeat model not yet in schema
        agentConfig.model,
      );

      logger.info(
        { agentId, trigger, model, channelType: msg.channelType },
        "Heartbeat run starting",
      );

      // 10. Execute via injected executor (wrapped in runWithContext)
      const executor = deps.getExecutor(agentId);
      const result = await runWithContext(
        {
          traceId: randomUUID(),
          tenantId: sessionKey.tenantId,
          userId: sessionKey.userId,
          sessionKey: formattedKey,
          startedAt: Date.now(),
          trustLevel: "user",
          channelType: msg.channelType,
        },
        () => executor.execute(msg, sessionKey, tools, agentId,
          {
            model,
            operationType: "heartbeat",
          }),
      );

      logger.info(
        { agentId, trigger, durationMs: Date.now() - msg.timestamp },
        "Heartbeat run complete",
      );

      // 10.5 Response processing: classify and decide delivery vs suppression
      const hasMedia = /^MEDIA:/m.test(result.response ?? "");
      const outcome: HeartbeatResponseOutcome = processHeartbeatResponse({
        responseText: result.response,
        hasMedia,
        ackMaxChars: config.ackMaxChars ?? 300,
        responsePrefix: config.responsePrefix,
      });

      if (outcome.kind === "heartbeat_ok") {
        logger.debug(
          { agentId, reason: outcome.reason },
          "Heartbeat response classified as OK, suppressing delivery",
        );
        // Prune last turn from transcript
        if (deps.sessionOps) {
          await deps.sessionOps.pruneLastTurn(formattedKey);
        }
        // Store last heartbeat for dedup
        if (deps.sessionOps) {
          deps.sessionOps.storeLastHeartbeat(formattedKey, outcome.cleanedText, Date.now());
        }
        return;
      }

      // outcome.kind === "deliver"
      logger.debug(
        { agentId, textLength: outcome.text.length },
        "Heartbeat response classified for delivery",
      );

      // Store last heartbeat for dedup
      if (deps.sessionOps) {
        deps.sessionOps.storeLastHeartbeat(formattedKey, outcome.text, Date.now());
      }

      // 11. Deliver response via delivery bridge (fire-and-forget)
      if (config.target && outcome.text) {
        const deliveryTarget: DeliveryTarget = {
          channelType: config.target.channelType,
          channelId: config.target.channelId,
          chatId: config.target.chatId,
        };
        const level = classifyHeartbeatResult(result.response ?? "");
        const notification: HeartbeatNotification = {
          sourceId: agentId,
          sourceName: "heartbeat",
          text: outcome.text,
          level,
          timestamp: Date.now(),
        };
        const deliveryOpts: DeliveryOptions = {
          agentId,
          isDm: config.target.isDm,
          allowDm: config.allowDm,
        };

        deliverHeartbeatNotification(deps.deliveryBridge, deliveryTarget, notification, deliveryOpts)
          .catch((e: unknown) => {
            logger.warn(
              {
                err: e,
                agentId,
                hint: "Check delivery bridge configuration and channel adapter connectivity",
                errorKind: "internal" as const,
              },
              "Heartbeat delivery failed",
            );
          });
      }
    } catch (err: unknown) {
      logger.warn(
        {
          err,
          agentId,
          hint: "Check heartbeat source configuration and executor health",
          errorKind: "internal" as const,
        },
        "Heartbeat execution failed",
      );
    }
  }

  return { onTick };
}
