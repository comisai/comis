// SPDX-License-Identifier: Apache-2.0
/**
 * Sub-agent runner module.
 * Manages async sub-agent spawning with:
 * - Non-blocking spawn returning runId immediately
 * - Allowlist enforcement for agent IDs
 * - Auto-archive of completed sessions after retention period
 * - Stats line in announcements (runtime, tokens, cost, session key)
 * - Graceful shutdown with active run draining
 * Extracted from daemon.ts inline session.spawn handler for testability.
 * @module
 */

import {
  formatSessionKey,
  parseFormattedSessionKey,
  runWithContext,
  type SessionKey,
  type TypedEventBus,
  type AgentToAgentConfig,
  type DeliveryOrigin,
} from "@comis/core";
import { suppressError } from "@comis/shared";
import { sanitizeAssistantResponse } from "@comis/agent";
import { randomUUID } from "node:crypto";
import type { AnnouncementBatcher } from "./announcement-batcher.js";
import type { AnnouncementDeadLetterQueue } from "./announcement-dead-letter.js";
import {
  classifyAbortReason,
  buildAnnouncementMessage,
  deliverAnnouncement,
  deliverFailureNotification,
  validateOutputs,
  sweepResultFiles,
  persistFailureRecord,
  type AbortClassification,
  type ValidationResult,
} from "./sub-agent-result-processor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard timeout for announceToParent calls at all call sites (300 seconds / 5 minutes).
 *  Parent agents may call slow tools (image generation at 120s, web search, etc.)
 *  in response to announcements. 30s caused premature fallback + duplicate delivery. */
export const ANNOUNCE_PARENT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SubAgentRun {
  runId: string;
  status: "running" | "completed" | "failed" | "queued";
  agentId: string;
  task: string;
  sessionKey: string;
  startedAt: number;
  completedAt?: number;
  /** Timestamp when this run was placed in the spawn queue. */
  queuedAt?: number;
  result?: {
    response: string;
    tokensUsed: { total: number; cacheRead?: number; cacheWrite?: number };
    cost: { total: number; cacheSaved?: number };
    finishReason: string;
    stepsExecuted: number;
  };
  error?: string;
  /** Originating channel context from the spawning request */
  requesterOrigin?: DeliveryOrigin;
  /** Spawn depth in the chain (0 = first child, 1 = grandchild, etc.). */
  depth: number;
  /** Session key of the caller agent, used for active children counting. */
  callerSessionKey?: string;
  /** Announce channel type for failure notifications (stored at spawn for ghost sweep access). */
  announceChannelType?: string;
  /** Announce channel ID for failure notifications (stored at spawn for ghost sweep access). */
  announceChannelId?: string;
  /** Graph ID for kill cascade routing. */
  graphId?: string;
  /** Graph node ID for kill cascade routing. */
  nodeId?: string;
  /** Abort/cleanup group key. Graph spawns: `graph:${graphId}`. Regular: callerSessionKey. */
  abortGroup?: string;
}

/** Minimal pino-compatible logger for sub-agent runner diagnostics. */
export interface SubAgentRunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface SubAgentRunnerDeps {
  sessionStore: {
    save(key: SessionKey, messages: unknown[], metadata: Record<string, unknown>): void;
    delete(key: SessionKey): void;
  };
  executeAgent: (
    agentId: string,
    sessionKey: SessionKey,
    task: string,
    maxSteps?: number,
    callerAgentId?: string,
    overrides?: { graphId?: string; nodeId?: string; reuseSessionKey?: string; graphNodeDepth?: number },
  ) => Promise<{
    response: string;
    tokensUsed: { total: number; cacheRead?: number; cacheWrite?: number };
    cost: { total: number; cacheSaved?: number };
    finishReason: string;
    stepsExecuted: number;
    toolCallHistory?: string[];
    errorContext?: {
      errorType: string;
      retryable: boolean;
      originalError?: string;
      failingTool?: string;
    };
  }>;
  sendToChannel: (channelType: string, channelId: string, text: string, options?: { threadId?: string }) => Promise<boolean>;
  /** Optional callback to inject announcement into parent session for agent rewriting.
   *  When provided, used instead of sendToChannel for completion announcements.
   *  Falls back to sendToChannel if not provided or if call fails. */
  announceToParent?: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    text: string,
    channelType: string,
    channelId: string,
  ) => Promise<void>;
  eventBus: TypedEventBus;
  config: AgentToAgentConfig;
  tenantId: string;
  /** Optional structured logger for lifecycle diagnostics. */
  logger?: SubAgentRunnerLogger;
  /** Optional memory adapter for persisting sub-agent completion summaries. */
  memoryAdapter?: {
    store(entry: {
      id: string;
      tenantId: string;
      agentId: string;
      userId: string;
      content: string;
      trustLevel: "system" | "learned" | "external";
      source: { who: string; channel?: string; sessionKey?: string };
      tags: string[];
      createdAt: number;
      sourceType?: "system" | "conversation" | "tool" | "web" | "api" | "unknown";
    }): Promise<{ ok: boolean }>;
  };
  /** Optional announcement batcher for coalescing near-simultaneous completions. */
  batcher?: AnnouncementBatcher;
  /** Optional dead-letter queue for persisting failed announcement deliveries */
  deadLetterQueue?: AnnouncementDeadLetterQueue;
  /** Optional active run registry for aborting in-flight SDK sessions on kill. */
  activeRunRegistry?: {
    get(sessionKey: string): { abort(): Promise<void> } | undefined;
  };
  /** Optional result condenser for compressing subagent output */
  resultCondenser?: {
    condense(params: {
      fullResult: string;
      task: string;
      runId: string;
      sessionKey: string;
      agentId: string;
      model?: unknown;
      apiKey?: string;
      // Enriched metadata for offline analysis (Findings 17, 20)
      parentTraceId?: string;
      graphId?: string;
      nodeId?: string;
      activeToolNames?: string[];
      deferredCount?: number;
      toolCallHistory?: string[];
      guidesDelivered?: string[];
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens: number; costUsd: number; cacheReadTokens?: number; cacheWriteTokens?: number; cacheSavedUsd?: number; cacheEffectiveness?: number };
      // Error context for non-successful executions
      errorContext?: { errorType: string; retryable: boolean; originalError?: string; failingTool?: string };
    }): Promise<{
      level: 1 | 2 | 3;
      result: { taskComplete: boolean; summary: string; conclusions: string[]; filePaths?: string[]; actionableItems?: string[]; errors?: string[]; keyData?: Record<string, unknown>; confidence?: number };
      originalTokens: number;
      condensedTokens: number;
      compressionRatio: number;
      diskPath: string;
    }>;
  };
  /** Model object for result condensation (resolved by daemon wiring). */
  condenserModel?: unknown;
  /** API key for result condensation model. */
  condenserApiKey?: string;
  /** Optional narrative caster for tagging condensed results */
  narrativeCaster?: {
    cast(params: {
      condensedResult: {
        level: 1 | 2 | 3;
        result: { taskComplete: boolean; summary: string; conclusions: string[]; filePaths?: string[]; actionableItems?: string[]; errors?: string[]; keyData?: Record<string, unknown>; confidence?: number };
        originalTokens: number;
        condensedTokens: number;
        compressionRatio: number;
        diskPath: string;
      };
      task: string;
      label?: string;
      runtimeMs: number;
      stepsExecuted: number;
      tokensUsed: number;
      cost: number;
      sessionKey: string;
    }): string;
  };
  /** Base data directory for locating subagent-results (e.g., ~/.comis). Optional for backward compat. */
  dataDir?: string;
  /** Optional lifecycle hooks for spawn preparation and completion */
  lifecycleHooks?: {
    prepareSpawn(params: {
      runId: string;
      parentSessionKey: string;
      childSessionKey: string;
      agentId: string;
      task: string;
      depth: number;
      maxDepth: number;
    }): Promise<{ rollback: () => Promise<void> } | undefined>;
    onEnded(params: {
      runId: string;
      agentId: string;
      parentSessionKey: string;
      childSessionKey: string;
      endReason: "completed" | "failed" | "killed" | "watchdog_timeout" | "ghost_sweep";
      condensedResult?: { level: 1 | 2 | 3; condensedTokens?: number };
      runtimeMs: number;
      tokensUsed: number;
      cost: number;
    }): Promise<void>;
  };
}

export interface SpawnParams {
  task: string;
  agentId: string;
  callerSessionKey?: string;
  callerAgentId?: string;
  announceChannelType?: string;
  announceChannelId?: string;
  model?: string;
  max_steps?: number;
  expected_outputs?: string[];
  /** Originating channel context for default announcement routing */
  requesterOrigin?: DeliveryOrigin;
  /** Current spawn depth in the chain (0 = top-level agent spawning its first child). */
  depth?: number;
  /** Maximum allowed spawn depth from config. */
  maxDepth?: number;
  /** Caller type for GraphCoordinator bypass of children limit. */
  callerType?: "agent" | "graph";
  /** File paths for the sub-agent to reference. */
  artifactRefs?: string[];
  /** Objective statement that survives context compaction. */
  objective?: string;
  /** Domain knowledge entries for the sub-agent. */
  domainKnowledge?: string[];
  /** Tool group names for sub-agent tool filtering. */
  toolGroups?: string[];
  /** Parent context inclusion mode. */
  includeParentHistory?: "none" | "summary";
  /** Shared directory path for graph pipeline inter-node data sharing */
  graphSharedDir?: string;
  /** Graph-level trace ID for correlated logging across all nodes in a graph run. */
  graphTraceId?: string;
  /** Graph ID for sub-agent log correlation and result metadata */
  graphId?: string;
  /** Graph node ID for sub-agent log correlation and result metadata */
  nodeId?: string;
  /** Discovered deferred tool names inherited from parent agent. */
  discoveredDeferredTools?: string[];
  /** Sorted tool name superset for graph sub-agent cache prefix sharing. */
  graphToolNames?: string[];
  /** Reuse an existing session key for multi-round driver spawns. */
  reuseSessionKey?: string;
  /** Graph node depth: 0 = root node (dependsOn=[]), 1+ = downstream.
   *  Used for depth-aware cache retention in setup-cross-session. */
  graphNodeDepth?: number;
  /** True when this graph node is a leaf (no other node depends on it).
   *  Leaf nodes use "short" (5m) cache retention instead of the 1h default
   *  because their cache prefix has no downstream consumers. */
  isLeafNode?: boolean;
}

// Re-export extracted result processor types and functions for backward compatibility
export { classifyAbortReason, buildAnnouncementMessage, deliverFailureNotification, sweepResultFiles, persistFailureRecord, validateOutputs } from "./sub-agent-result-processor.js";
export type { AbortClassification, ValidationResult } from "./sub-agent-result-processor.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSubAgentRunner(deps: SubAgentRunnerDeps) {
  const runs = new Map<string, SubAgentRun>();
  const activePromises = new Set<Promise<void>>();

  // Late-binding ref for graph coordinator (created after sub-agent runner in daemon.ts)
  let graphCoordinatorRef: { notifyNodeFailed(graphId: string, nodeId: string, runId: string, error: string): void } | undefined;

  // -------------------------------------------------------------------------
  // Queue data structure for spawn queuing
  // -------------------------------------------------------------------------

  interface QueuedSpawn {
    runId: string;
    params: SpawnParams;
    queuedAt: number;
  }
  /** FIFO queue per caller session key. */
  const spawnQueue = new Map<string, QueuedSpawn[]>();

  /**
   * Count active (running) children spawned by a specific caller session.
   * Used to enforce maxChildrenPerAgent.
   */
  function countActiveChildren(callerSessionKey: string | undefined): number {
    if (!callerSessionKey) return 0;
    let count = 0;
    for (const run of runs.values()) {
      if (run.status === "running" && run.callerSessionKey === callerSessionKey) {
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Proxy typing stop helper (avoids repeating guard+emit in 5 paths)
  // -------------------------------------------------------------------------

  function emitProxyStop(
    run: SubAgentRun,
    runId: string,
    reason: "completed" | "failed" | "killed" | "ghost_sweep" | "watchdog_timeout",
  ): void {
    if (!run.announceChannelType || !run.announceChannelId) return;
    deps.eventBus.emit("typing:proxy_stop", {
      runId,
      channelType: run.announceChannelType,
      channelId: run.announceChannelId,
      reason,
      durationMs: (run.completedAt ?? Date.now()) - run.startedAt,
      timestamp: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Auto-archive sweep (every 5 minutes)
  // -------------------------------------------------------------------------

  const SWEEP_INTERVAL_MS = 300_000;
  const MAX_RUNS = 1000;

  const sweepInterval = setInterval(() => {
    const now = Date.now();
    const retentionMs = deps.config.subAgentRetentionMs;

    for (const [runId, run] of runs) {
      if (
        (run.status === "completed" || run.status === "failed") &&
        run.completedAt !== undefined &&
        now - run.completedAt > retentionMs
      ) {
        // Parse session key back to components for deletion
        const parts = run.sessionKey.split(":");
        if (parts.length >= 3) {
          const sessionKey: SessionKey = {
            tenantId: parts[0]!,
            userId: parts[1]!,
            channelId: parts[2]!,
          };
          deps.sessionStore.delete(sessionKey);
        }

        deps.eventBus.emit("session:sub_agent_archived", {
          runId,
          sessionKey: run.sessionKey,
          ageMs: now - run.completedAt,
          timestamp: now,
        });

        deps.logger?.debug({ runId, ageMs: now - run.completedAt }, "Sub-agent run auto-archived");
        runs.delete(runId);
      }
    }

    // Size cap: prune oldest completed runs if over limit
    if (runs.size > MAX_RUNS) {
      const completedRuns = [...runs.entries()]
        .filter(([, r]) => r.status === "completed" || r.status === "failed")
        .sort((a, b) => (a[1].completedAt ?? 0) - (b[1].completedAt ?? 0));

      const toRemove = runs.size - MAX_RUNS;
      for (let i = 0; i < toRemove && i < completedRuns.length; i++) {
        runs.delete(completedRuns[i]![0]);
      }
    }

    // Queue timeout sweep -- fail queued spawns that exceeded queueTimeoutMs
    const queueTimeoutMs = deps.config.subagentContext?.queueTimeoutMs ?? 120_000;
    for (const [callerKey, queue] of spawnQueue) {
      const timedOut: string[] = [];
      for (let i = queue.length - 1; i >= 0; i--) {
        const entry = queue[i]!;
        if (now - entry.queuedAt > queueTimeoutMs) {
          queue.splice(i, 1);
          timedOut.push(entry.runId);

          const run = runs.get(entry.runId);
          if (run && run.status === "queued") {
            run.status = "failed";
            run.error = `Queue timeout: waited ${queueTimeoutMs}ms for an execution slot`;
            run.completedAt = now;

            deps.eventBus.emit("session:sub_agent_spawn_rejected", {
              parentSessionKey: callerKey,
              agentId: run.agentId,
              task: run.task,
              reason: "queue_timeout",
              currentDepth: run.depth,
              maxDepth: 0,
              currentChildren: 0,
              maxChildren: 0,
              timestamp: now,
            });

            deps.logger?.warn({
              runId: entry.runId,
              agentId: run.agentId,
              parentSessionKey: callerKey,
              queueTimeoutMs,
              hint: "Queued spawn timed out; increase queueTimeoutMs or reduce concurrent spawns",
              errorKind: "resource",
            }, "Queued spawn timed out");
          }
        }
      }
      if (queue.length === 0) {
        spawnQueue.delete(callerKey);
      }
    }

    // Disk sweep for expired result files
    if (deps.dataDir) {
      const resultRetentionMs = deps.config.subagentContext?.resultRetentionMs ?? 86_400_000;
      suppressError(
        sweepResultFiles(deps.dataDir, resultRetentionMs, deps.logger ?? undefined),
        "result-file-sweep",
      );
    }

    // Ghost run sweep -- defense-in-depth for stuck runs
    const ghostGraceMs = (deps.config.subagentContext?.maxRunTimeoutMs ?? 600_000) + 120_000;
    for (const [runId, run] of runs) {
      if (run.status !== "running") continue;

      const runningDurationMs = now - run.startedAt;
      if (runningDurationMs <= ghostGraceMs) continue;

      deps.logger?.error({
        runId, agentId: run.agentId,
        runtimeMs: runningDurationMs,
        graceMs: ghostGraceMs,
        hint: "Run stuck in 'running' past grace period; force-failing as ghost run",
        errorKind: "timeout",
      }, "Ghost run detected and force-failed");

      run.status = "failed";
      run.completedAt = now;
      run.error = `Ghost run: stuck in 'running' for ${(runningDurationMs / 1000).toFixed(0)}s (grace: ${(ghostGraceMs / 1000).toFixed(0)}s)`;

      // Persist failure record
      if (deps.dataDir) {
        suppressError(
          persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: run.sessionKey,
            runId,
            task: run.task,
            error: run.error,
            endReason: "ghost_sweep",
            runtimeMs: runningDurationMs,
          }, deps.logger),
          "ghost-sweep-failure-record",
        );
      }

      // Abort SDK session (best-effort)
      if (deps.activeRunRegistry) {
        const handle = deps.activeRunRegistry.get(run.sessionKey);
        if (handle) {
          // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
          handle.abort().catch(() => { /* best-effort */ });
        }
      }

      // Emit completion event
      deps.eventBus.emit("session:sub_agent_completed", {
        runId, agentId: run.agentId, success: false,
        runtimeMs: runningDurationMs, tokensUsed: 0, cost: 0, timestamp: now,
      });

      // Stop proxy typing on ghost sweep
      emitProxyStop(run, runId, "ghost_sweep");

      // Deliver failure notification using stored announce channel
      if (run.announceChannelType && run.announceChannelId) {
        deliverFailureNotification({
          channelType: run.announceChannelType,
          channelId: run.announceChannelId,
          task: run.task,
          runtimeMs: runningDurationMs,
          runId,
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        }, deps).catch(() => { /* deliverFailureNotification already handles errors internally */ });
      }

      // Lifecycle hook (fire-and-forget)
      if (deps.lifecycleHooks) {
        deps.lifecycleHooks.onEnded({
          runId,
          agentId: run.agentId,
          parentSessionKey: run.callerSessionKey ?? "unknown",
          childSessionKey: run.sessionKey,
          endReason: "ghost_sweep",
          runtimeMs: runningDurationMs,
          tokensUsed: 0,
          cost: 0,
        }).catch((hookErr) => {
          deps.logger?.warn({
            runId, err: hookErr,
            hint: "onSubagentEnded hook failed in ghost sweep path",
            errorKind: "internal",
          }, "Lifecycle hook onEnded failed");
        });
      }
    }

    // Dead-letter queue periodic drain
    if (deps.deadLetterQueue) {
      suppressError(
        deps.deadLetterQueue.drain(deps.sendToChannel),
        "dead-letter-sweep-drain",
      );
    }
  }, SWEEP_INTERVAL_MS);

  sweepInterval.unref();

  // Event-driven DLQ drain on provider recovery
  if (deps.deadLetterQueue) {
    deps.eventBus.on("provider:recovered", () => {
      suppressError(
        deps.deadLetterQueue!.drain(deps.sendToChannel),
        "dead-letter-recovery-drain",
      );
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function spawn(params: SpawnParams): string {
    // 0. Resolve depth and config values for limit enforcement
    const currentDepth = params.depth ?? 0;
    const maxDepth = params.maxDepth ?? deps.config.subagentContext?.maxSpawnDepth ?? 3;
    const isGraphSpawn = params.callerType === "graph";

    // Depth check (applies to ALL spawns including graph)
    if (currentDepth >= maxDepth) {
      deps.eventBus.emit("session:sub_agent_spawn_rejected", {
        parentSessionKey: params.callerSessionKey ?? "unknown",
        agentId: params.agentId,
        task: params.task,
        reason: "depth_exceeded",
        currentDepth,
        maxDepth,
        currentChildren: 0,
        maxChildren: 0,
        timestamp: Date.now(),
      });
      deps.logger?.warn({
        agentId: params.agentId,
        parentSessionKey: params.callerSessionKey ?? "unknown",
        reason: "depth_exceeded",
        currentDepth,
        maxDepth,
        hint: "Spawn rejected: depth limit exceeded; reduce spawn nesting or increase maxSpawnDepth config",
        errorKind: "resource",
      }, "Subagent spawn rejected");
      throw new Error(
        `Spawn rejected: depth limit exceeded (current: ${currentDepth}, max: ${maxDepth}). This sub-agent cannot spawn further children at this nesting level.`,
      );
    }

    // Children check (bypassed for graph spawns)
    if (!isGraphSpawn && params.callerSessionKey) {
      const maxChildren = deps.config.subagentContext?.maxChildrenPerAgent ?? 5;
      const activeChildren = countActiveChildren(params.callerSessionKey);
      if (activeChildren >= maxChildren) {
        const maxQueuedPerAgent = deps.config.subagentContext?.maxQueuedPerAgent ?? 10;

        // maxQueuedPerAgent === 0 means queuing is disabled -- preserve old throw behavior
        if (maxQueuedPerAgent === 0) {
          deps.eventBus.emit("session:sub_agent_spawn_rejected", {
            parentSessionKey: params.callerSessionKey,
            agentId: params.agentId,
            task: params.task,
            reason: "children_exceeded",
            currentDepth,
            maxDepth,
            currentChildren: activeChildren,
            maxChildren,
            timestamp: Date.now(),
          });
          deps.logger?.warn({
            agentId: params.agentId,
            parentSessionKey: params.callerSessionKey,
            reason: "children_exceeded",
            activeChildren,
            maxChildren,
            hint: "Spawn rejected: active children limit exceeded; wait for existing sub-agents to complete",
            errorKind: "resource",
          }, "Subagent spawn rejected");
          throw new Error(
            `Spawn rejected: active children limit exceeded (current: ${activeChildren}, max: ${maxChildren}). Wait for existing sub-agents to complete before spawning more.`,
          );
        }

        // Check queue capacity
        const queueSize = spawnQueue.get(params.callerSessionKey)?.length ?? 0;
        if (queueSize >= maxQueuedPerAgent) {
          deps.eventBus.emit("session:sub_agent_spawn_rejected", {
            parentSessionKey: params.callerSessionKey,
            agentId: params.agentId,
            task: params.task,
            reason: "queue_full",
            currentDepth,
            maxDepth,
            currentChildren: activeChildren,
            maxChildren,
            timestamp: Date.now(),
          });
          deps.logger?.warn({
            agentId: params.agentId,
            parentSessionKey: params.callerSessionKey,
            reason: "queue_full",
            activeChildren,
            maxChildren,
            queueSize,
            maxQueuedPerAgent,
            hint: "Spawn rejected: queue full; wait for queued or active sub-agents to complete",
            errorKind: "resource",
          }, "Subagent spawn rejected");
          throw new Error(
            `Spawn rejected: queue full (queued: ${queueSize}, max: ${maxQueuedPerAgent}). Wait for existing sub-agents to complete before spawning more.`,
          );
        }

        // Queue the spawn
        const queuedRunId = randomUUID();
        const now = Date.now();
        const queuedRun: SubAgentRun = {
          runId: queuedRunId,
          status: "queued",
          agentId: params.agentId,
          task: params.task,
          sessionKey: "",
          startedAt: 0,
          queuedAt: now,
          requesterOrigin: params.requesterOrigin,
          depth: currentDepth,
          callerSessionKey: params.callerSessionKey,
          announceChannelType: params.announceChannelType,
          announceChannelId: params.announceChannelId,
          graphId: params.graphId,
          nodeId: params.nodeId,
          abortGroup: params.callerType === "graph" && params.graphId
            ? `graph:${params.graphId}`
            : params.callerSessionKey,
        };
        runs.set(queuedRunId, queuedRun);

        const callerQueue = spawnQueue.get(params.callerSessionKey) ?? [];
        callerQueue.push({ runId: queuedRunId, params, queuedAt: now });
        spawnQueue.set(params.callerSessionKey, callerQueue);

        deps.eventBus.emit("session:sub_agent_spawn_queued", {
          runId: queuedRunId,
          parentSessionKey: params.callerSessionKey,
          agentId: params.agentId,
          task: params.task,
          queuePosition: callerQueue.length,
          activeChildren,
          maxChildren,
          timestamp: now,
        });

        deps.logger?.debug({
          runId: queuedRunId,
          agentId: params.agentId,
          parentSessionKey: params.callerSessionKey,
          queuePosition: callerQueue.length,
          activeChildren,
          maxChildren,
        }, "Sub-agent spawn queued");

        return queuedRunId;
      }
    }

    // 1. Allowlist check
    if (
      deps.config.allowAgents.length > 0 &&
      !deps.config.allowAgents.includes(params.agentId)
    ) {
      throw new Error(
        `Agent "${params.callerAgentId}" is not allowed to spawn "${params.agentId}". Allowed: ${deps.config.allowAgents.join(", ")}`,
      );
    }

    // Normal (non-queued) path: create run and start execution
    const runId = randomUUID();
    const run: SubAgentRun = {
      runId, status: "running", agentId: params.agentId,
      task: params.task, sessionKey: "", startedAt: Date.now(),
      requesterOrigin: params.requesterOrigin,
      depth: currentDepth,
      callerSessionKey: params.callerSessionKey,
      announceChannelType: params.announceChannelType,
      announceChannelId: params.announceChannelId,
      graphId: params.graphId,
      nodeId: params.nodeId,
      abortGroup: params.callerType === "graph" && params.graphId
        ? `graph:${params.graphId}`
        : params.callerSessionKey,
    };
    runs.set(runId, run);

    startExecution(runId, run, params, currentDepth, maxDepth);

    // 6. Return runId immediately (non-blocking)
    return runId;
  }

  /**
   * Start execution for a run: create session, emit events, launch async execution.
   * Called for both normal spawns and promoted queued spawns.
   */
  function startExecution(
    runId: string,
    run: SubAgentRun,
    params: SpawnParams,
    currentDepth: number,
    maxDepth: number,
  ): void {
    // Create sub-agent session
    let subSessionKey: SessionKey;
    let formattedKey: string;

    if (params.reuseSessionKey) {
      // Reuse existing persistent session -- skip session creation.
      // The session already has prior round conversation history on disk.
      const parsed = parseFormattedSessionKey(params.reuseSessionKey);
      if (!parsed) {
        deps.logger?.error(
          { runId, reuseSessionKey: params.reuseSessionKey, hint: "Invalid reuseSessionKey format, falling back to new session", errorKind: "validation" },
          "Failed to parse reuseSessionKey",
        );
        // Fall through to normal session creation
        subSessionKey = { tenantId: deps.tenantId, userId: `sub-agent-${runId}`, channelId: `sub-agent:${runId}` };
        formattedKey = formatSessionKey(subSessionKey);
        deps.sessionStore.save(subSessionKey, [], {
          parentSessionKey: params.callerSessionKey,
          spawnedByAgent: params.callerAgentId,
          spawnedAt: Date.now(),
          taskDescription: params.task,
          runId,
          modelOverride: params.model,
          spawnDepth: currentDepth + 1,
          maxSpawnDepth: maxDepth,
          artifactRefs: params.artifactRefs ?? [],
          objective: params.objective ?? "",
          domainKnowledge: params.domainKnowledge ?? [],
          toolGroups: params.toolGroups ?? [],
          includeParentHistory: params.includeParentHistory ?? "none",
          graphSharedDir: params.graphSharedDir ?? "",
          discoveredDeferredTools: params.discoveredDeferredTools ?? [],
          graphToolNames: params.graphToolNames ?? [],
          graphNodeDepth: params.graphNodeDepth,
          isLeafNode: params.isLeafNode ?? false,
        });
      } else {
        formattedKey = params.reuseSessionKey;
        subSessionKey = { tenantId: parsed.tenantId, userId: parsed.userId, channelId: parsed.channelId };
        deps.logger?.info(
          { runId, reuseSessionKey: params.reuseSessionKey, agentId: params.agentId },
          "Reusing persistent session for multi-round driver",
        );
        // Do NOT call sessionStore.save -- session already exists with prior messages
      }
    } else {
      // Normal path: create new session
      subSessionKey = { tenantId: deps.tenantId, userId: `sub-agent-${runId}`, channelId: `sub-agent:${runId}` };
      formattedKey = formatSessionKey(subSessionKey);
      deps.sessionStore.save(subSessionKey, [], {
        parentSessionKey: params.callerSessionKey,
        spawnedByAgent: params.callerAgentId,
        spawnedAt: Date.now(),
        taskDescription: params.task,
        runId,
        modelOverride: params.model,
        spawnDepth: currentDepth + 1,
        maxSpawnDepth: maxDepth,
        artifactRefs: params.artifactRefs ?? [],
        objective: params.objective ?? "",
        domainKnowledge: params.domainKnowledge ?? [],
        toolGroups: params.toolGroups ?? [],
        includeParentHistory: params.includeParentHistory ?? "none",
        graphSharedDir: params.graphSharedDir ?? "",
        discoveredDeferredTools: params.discoveredDeferredTools ?? [],
        graphToolNames: params.graphToolNames ?? [],
        graphNodeDepth: params.graphNodeDepth,
        isLeafNode: params.isLeafNode ?? false,
      });
    }

    // Update run with session info and running status
    run.sessionKey = formattedKey;
    run.status = "running";
    run.startedAt = Date.now();

    deps.logger?.info({
      runId, agentId: params.agentId,
      callerAgentId: params.callerAgentId ?? "unknown",
      parentSessionKey: params.callerSessionKey ?? "unknown",
      task: params.task.slice(0, 200),
      maxSteps: params.max_steps ?? deps.config.subAgentMaxSteps,
      toolProfile: deps.config.subAgentToolGroups,
    }, "Sub-agent spawn initiated");

    // Emit spawn event
    deps.eventBus.emit("session:sub_agent_spawned", {
      runId, parentSessionKey: params.callerSessionKey ?? "unknown",
      agentId: params.agentId, task: params.task, timestamp: Date.now(),
    });

    // Async execution
    const execPromise = (async () => {
      // Lifecycle hook - prepareSpawn
      let rollbackHandle: { rollback: () => Promise<void> } | undefined;
      if (deps.lifecycleHooks) {
        try {
          rollbackHandle = await deps.lifecycleHooks.prepareSpawn({
            runId,
            parentSessionKey: params.callerSessionKey ?? "unknown",
            childSessionKey: formattedKey,
            agentId: params.agentId,
            task: params.task,
            depth: currentDepth,
            maxDepth,
          });
        } catch (hookErr) {
          deps.logger?.warn({
            runId, err: hookErr,
            hint: "prepareSubagentSpawn hook failed; proceeding with legacy spawn",
            errorKind: "internal",
          }, "Lifecycle hook prepareSpawn failed");
        }
      }

      // Hoist traceId for availability in catch block (failure record correlation)
      const traceId = params.graphTraceId ?? randomUUID();

      try {
        deps.logger?.info({
          runId, agentId: params.agentId,
          ...(params.graphId ? { graphId: params.graphId } : {}),
          ...(params.nodeId ? { nodeId: params.nodeId } : {}),
        }, "Sub-agent execution started");
        const parsed = parseFormattedSessionKey(formattedKey);

        // Propagate delivery origin into ALS so sub-agent tool calls
        // (e.g. pipeline execute -> graph.execute RPC) include announce channel fields.
        // Without this, setup-tools.ts cannot inject _callerChannelType/_callerChannelId.
        const subDeliveryOrigin = run.announceChannelType && run.announceChannelId
          ? {
              channelType: run.announceChannelType,
              channelId: run.announceChannelId,
              userId: parsed?.userId ?? "sub-agent",
              tenantId: parsed?.tenantId ?? deps.tenantId,
            }
          : undefined;

        const result = await runWithContext(
          {
            traceId,
            tenantId: parsed?.tenantId ?? deps.tenantId,
            userId: parsed?.userId ?? "sub-agent",
            sessionKey: formattedKey,
            startedAt: Date.now(),
            trustLevel: "admin",
            // Propagate channel context for downstream tool RPC injection
            ...(run.announceChannelType && { channelType: run.announceChannelType }),
            ...(subDeliveryOrigin && { deliveryOrigin: subDeliveryOrigin }),
          },
          () => deps.executeAgent(
            params.agentId, subSessionKey, params.task, params.max_steps, params.callerAgentId,
            params.graphId && params.nodeId
              ? { graphId: params.graphId, nodeId: params.nodeId, reuseSessionKey: params.reuseSessionKey, graphNodeDepth: params.graphNodeDepth }
              : params.reuseSessionKey
                ? { reuseSessionKey: params.reuseSessionKey }
                : undefined,
          ),
        );

        // Guard: if already killed, skip completion logic
        if (run.status === "failed") return;

        const completedAt = Date.now();
        run.status = "completed";
        run.completedAt = completedAt;
        run.result = result;

        // Populate run.error for non-successful completions so graph coordinator
        // and downstream consumers see a meaningful error instead of "Unknown error".
        if (result.finishReason !== "stop" && result.finishReason !== "end_turn") {
          run.error = result.errorContext?.originalError
            ?? `Execution completed with finishReason: ${result.finishReason}`;
        }

        // Warn on empty response — may indicate prompt or context issues
        if (!result.response || result.response.trim().length === 0) {
          deps.logger?.warn({
            runId, agentId: params.agentId, finishReason: result.finishReason,
            hint: "Sub-agent returned empty response; check task prompt clarity and model context limits",
            errorKind: "internal",
          }, "Sub-agent produced empty output");
        }

        const runtimeMs = completedAt - run.startedAt;

        // Compute cache effectiveness before condense() for disk persistence.
        // Formula: cacheRead/(cacheRead+cacheWrite), 0 when no cache activity.
        const cacheRead = result.tokensUsed.cacheRead ?? 0;
        const cacheWrite = result.tokensUsed.cacheWrite ?? 0;
        const cacheable = cacheRead + cacheWrite;
        const cacheEffectiveness = cacheable > 0 ? cacheRead / cacheable : 0;

        // Result condensation pipeline
        let condensedResult: { level: 1 | 2 | 3; result: { taskComplete: boolean; summary: string; conclusions: string[]; filePaths?: string[] }; originalTokens: number; condensedTokens: number; compressionRatio: number; diskPath: string } | undefined;
        if (deps.resultCondenser) {
          try {
            condensedResult = await deps.resultCondenser.condense({
              fullResult: result.response,
              task: params.task,
              runId,
              sessionKey: formattedKey,
              agentId: params.agentId,
              model: deps.condenserModel,
              apiKey: deps.condenserApiKey,
              // Parent trace correlation for cross-session diagnostics
              parentTraceId: traceId,
              // Graph context propagation (graphId/nodeId now available via SpawnParams)
              graphId: params.graphId,
              nodeId: params.nodeId,
              // Token/cost usage breakdown; cache fields for post-mortem analysis
              usage: {
                totalTokens: result.tokensUsed.total,
                costUsd: result.cost.total,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                cacheSavedUsd: result.cost.cacheSaved ?? 0,
                cacheEffectiveness: Number(cacheEffectiveness.toFixed(3)),
              },
              // Error context for non-successful executions
              errorContext: result.errorContext,
              // Tool metadata plumbed from executor via bridge
              toolCallHistory: result.toolCallHistory,
            });

            deps.eventBus.emit("session:sub_agent_result_condensed", {
              runId,
              agentId: params.agentId,
              level: condensedResult.level,
              originalTokens: condensedResult.originalTokens,
              condensedTokens: condensedResult.condensedTokens,
              compressionRatio: condensedResult.compressionRatio,
              taskComplete: condensedResult.result.taskComplete,
              diskPath: condensedResult.diskPath,
              timestamp: Date.now(),
            });

            deps.logger?.debug({
              runId, agentId: params.agentId,
              level: condensedResult.level,
              originalTokens: condensedResult.originalTokens,
              condensedTokens: condensedResult.condensedTokens,
              compressionRatio: condensedResult.compressionRatio,
            }, "Result condensation completed");
          } catch (condensErr) {
            deps.logger?.warn({
              runId, err: condensErr,
              hint: "Result condensation failed; using raw response for announcement",
              errorKind: "internal",
            }, "ResultCondenser failed");
          }
        }

        // Emit completion event
        const isSuccess = result.finishReason === "stop" || result.finishReason === "end_turn";
        deps.eventBus.emit("session:sub_agent_completed", {
          runId, agentId: params.agentId, success: isSuccess,
          runtimeMs, tokensUsed: result.tokensUsed.total,
          cost: result.cost.total, timestamp: completedAt,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        });

        // Post-execution output validation (best-effort, never blocks)
        let validationResults: ValidationResult[] | undefined;
        if (params.expected_outputs && params.expected_outputs.length > 0) {
          try {
            validationResults = await validateOutputs(params.expected_outputs);
            const missing = validationResults.filter((v) => !v.exists);
            if (missing.length > 0) {
              deps.logger?.warn({
                runId,
                missingFiles: missing.map((v) => v.path),
                hint: "Sub-agent did not produce all expected output files; check task description clarity",
                errorKind: "validation",
              }, "Sub-agent output validation: missing files");
            }
          } catch (validationErr) {
            deps.logger?.warn({
              runId,
              err: validationErr,
              hint: "Output validation failed unexpectedly; announcement will proceed without validation data",
              errorKind: "internal",
            }, "Sub-agent output validation error");
          }
        }

        // Classify abort if finishReason is abnormal (not stop/end_turn)
        let abortClassification: AbortClassification | undefined;
        if (result.finishReason !== "stop" && result.finishReason !== "end_turn") {
          try {
            abortClassification = classifyAbortReason(result.finishReason);
          } catch { /* classification must never block */ }
        }

        // WARN log for abort events
        if (abortClassification) {
          deps.logger?.warn({
            runId, agentId: params.agentId,
            abortReason: abortClassification.category,
            abortSeverity: abortClassification.severity,
            hint: abortClassification.hint,
            errorKind: "resource",
            finishReason: result.finishReason,
            // Include error context when available for root-cause investigation
            ...(result.errorContext?.errorType && { errorType: result.errorContext.errorType }),
            ...(result.errorContext?.originalError && { errorDetail: result.errorContext.originalError }),
          }, "Sub-agent aborted");
        }

        // Enriched INFO log (after validation so filesCreated is available)
        deps.logger?.info({
          runId, agentId: params.agentId, success: isSuccess, durationMs: runtimeMs,
          finishReason: result.finishReason,
          stepsExecuted: result.stepsExecuted,
          stepCount: result.stepsExecuted,
          tokensUsed: result.tokensUsed.total, cost: result.cost.total,
          responseLength: result.response.length,
          filesCreated: validationResults?.filter((v) => v.exists).length ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
          cacheEffectiveness: Number(cacheEffectiveness.toFixed(3)),
          ...(params.graphId ? { graphId: params.graphId } : {}),
          ...(params.nodeId ? { nodeId: params.nodeId } : {}),
        }, "Sub-agent execution completed");

        // Persist completion summary to memory for cross-session recall
        if (deps.memoryAdapter) {
          try {
            let status: string;
            if (abortClassification) {
              status = `Halted (${abortClassification.category})`;
            } else if (result.finishReason === "error" && result.errorContext) {
              const retryHint = result.errorContext.retryable ? ", retryable" : "";
              const toolHint = result.errorContext.failingTool ? ` on ${result.errorContext.failingTool}` : "";
              status = `Halted (${result.errorContext.errorType}${toolHint}${retryHint})`;
            } else if (result.finishReason === "error") {
              status = "Halted (error)";
            } else {
              status = "Success";
            }
            const taskSnippet = params.task.length > 500
              ? params.task.slice(0, 497) + "..."
              : params.task;
            const sanitizedResponse = sanitizeAssistantResponse(result.response);
            const resultSnippet = sanitizedResponse.length > 500
              ? sanitizedResponse.slice(0, 497) + "..."
              : sanitizedResponse;
            const content = [
              `Sub-agent task ${status === "Success" ? "completed" : "halted"}.`,
              `Task: ${taskSnippet}`,
              `Status: ${status}`,
              resultSnippet ? `Result: ${resultSnippet}` : null,
              `Runtime: ${(runtimeMs / 1000).toFixed(1)}s | Steps: ${result.stepsExecuted} | Cost: $${result.cost.total.toFixed(4)}`,
              `Session: ${formattedKey}`,
            ].filter(Boolean).join("\n");

            await deps.memoryAdapter.store({
              id: randomUUID(),
              tenantId: deps.tenantId,
              agentId: params.agentId,
              userId: "system",
              content,
              trustLevel: "system",
              source: { who: "sub-agent-runner", sessionKey: formattedKey },
              tags: ["sub-agent-result", "task-completion", ...(abortClassification ? ["aborted"] : [])],
              createdAt: Date.now(),
              sourceType: "tool",
            });

            deps.logger?.debug({ runId, agentId: params.agentId }, "Sub-agent completion persisted to memory");
          } catch (memErr) {
            deps.logger?.warn({
              runId, err: memErr,
              hint: "Failed to persist sub-agent completion to memory; cross-session recall may be incomplete",
              errorKind: "internal",
            }, "Sub-agent memory persistence failed");
          }
        }

        // Route provider_degraded to failure notification path
        // When isDegraded() skips the LLM call, executor returns empty response with
        // finishReason "provider_degraded". Route to deliverFailureNotification instead
        // of deliverAnnouncement to avoid sending an empty/malformed success message.
        if (result.finishReason === "provider_degraded") {
          if (params.announceChannelType && params.announceChannelId) {
            await deliverFailureNotification({
              channelType: params.announceChannelType,
              channelId: params.announceChannelId,
              task: params.task,
              runtimeMs,
              runId,
            }, deps);
          }
        } else if (params.announceChannelType && params.announceChannelId) {
          // Announce with stats
          if (!result.response.includes("ANNOUNCE_SKIP")) {
            // Use NarrativeCaster for tagged result announcement.
            // Skip NarrativeCaster for error results — buildAnnouncementMessage
            // enriches the status label with errorContext (e.g., "Halted (PromptTimeout, retryable)")
            // which the NarrativeCaster would lose.
            let announcementText: string;
            if (condensedResult && deps.narrativeCaster && result.finishReason !== "error") {
              announcementText = deps.narrativeCaster.cast({
                condensedResult,
                task: params.task,
                runtimeMs,
                stepsExecuted: result.stepsExecuted,
                tokensUsed: result.tokensUsed.total,
                cost: result.cost.total,
                sessionKey: formattedKey,
              });
            } else {
              // Legacy fallback: no condenser or no caster
              announcementText = buildAnnouncementMessage({
                task: params.task,
                status: "completed",
                response: condensedResult
                  ? `${condensedResult.result.summary}\n\nFull result: ${condensedResult.diskPath}`
                  : sanitizeAssistantResponse(result.response),
                runtimeMs,
                stepsExecuted: result.stepsExecuted,
                tokensUsed: result.tokensUsed.total,
                cost: result.cost.total,
                finishReason: result.finishReason,
                sessionKey: formattedKey,
                validation: validationResults,
                abort: abortClassification,
                errorContext: result.errorContext,
              });
            }
            await deliverAnnouncement({
              announcementText,
              announceChannelType: params.announceChannelType,
              announceChannelId: params.announceChannelId,
              callerAgentId: params.callerAgentId,
              callerSessionKey: params.callerSessionKey,
              runId,
            }, deps);
          }
        } else {
          // Log explicit reason when announcement cannot be routed
          deps.logger?.debug({
            runId,
            suppressAnnounceReason: params.requesterOrigin ? "no_channel_params" : "no_origin",
            hasOrigin: !!params.requesterOrigin,
          }, "Sub-agent announcement skipped: no announce channel");
        }

        // Safety-net proxy stop — announceToParent's own finally block handles
        // the announcement-scoped typing. This catches edge cases where announcement was skipped.
        emitProxyStop(run, runId, "completed");

        // Lifecycle hook - onEnded (success path, after condensation/casting/announcement)
        if (deps.lifecycleHooks) {
          try {
            await deps.lifecycleHooks.onEnded({
              runId,
              agentId: params.agentId,
              parentSessionKey: params.callerSessionKey ?? "unknown",
              childSessionKey: formattedKey,
              endReason: "completed",
              condensedResult: condensedResult ? { level: condensedResult.level, condensedTokens: condensedResult.condensedTokens } : undefined,
              runtimeMs,
              tokensUsed: result.tokensUsed.total,
              cost: result.cost.total,
            });
          } catch (hookErr) {
            deps.logger?.warn({
              runId, err: hookErr,
              hint: "onSubagentEnded hook failed; result already delivered",
              errorKind: "internal",
            }, "Lifecycle hook onEnded failed");
          }
        }
      } catch (error: unknown) {
        // Guard: if already killed, skip error handling logic
        if (run.status === "failed") return;

        const completedAt = Date.now();
        run.status = "failed";
        run.completedAt = completedAt;
        const errorMessage = error instanceof Error ? error.message : String(error);
        run.error = errorMessage;

        const runtimeMs = completedAt - run.startedAt;

        deps.logger?.error({
          runId,
          durationMs: runtimeMs,
          err: error,
          hint: "Sub-agent execution failed; check agent config, model availability, and API key",
          errorKind: "internal",
        }, "Sub-agent execution failed");

        // Persist failure record BEFORE rollback deletes the directory
        if (deps.dataDir) {
          await persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: formattedKey,
            runId,
            task: params.task,
            error: errorMessage,
            endReason: "failed",
            runtimeMs,
            // Parent trace correlation for failure records
            parentTraceId: traceId,
          }, deps.logger);
        }

        // Rollback disk directory on spawn failure
        if (rollbackHandle) {
          try { await rollbackHandle.rollback(); } catch { /* swallow -- rollback has its own WARN logging */ }
        }

        // Classify abort from error context
        let abortClassification: AbortClassification | undefined;
        try {
          const errorCause = error instanceof Error && error.cause
            ? (error.cause instanceof Error ? error.cause.message : String(error.cause))
            : undefined;
          abortClassification = classifyAbortReason("error", errorMessage, errorCause);
        } catch { /* classification must never block */ }

        // WARN log for abort classification in error path
        if (abortClassification) {
          deps.logger?.warn({
            runId, agentId: params.agentId,
            abortReason: abortClassification.category,
            abortSeverity: abortClassification.severity,
            hint: abortClassification.hint,
            errorKind: "resource",
            // Include actual error type for root-cause investigation (not just "unknown")
            ...(error instanceof Error && { errorType: error.constructor.name }),
            ...(error instanceof Error && error.message && { errorDetail: error.message }),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          }, "Sub-agent aborted");
        }

        // Emit failure event
        deps.eventBus.emit("session:sub_agent_completed", {
          runId, agentId: params.agentId, success: false,
          runtimeMs, tokensUsed: 0, cost: 0, timestamp: completedAt,
        });

        // Stop proxy typing before failure notification
        emitProxyStop(run, runId, "failed");

        // Announce failure to channel -- LLM-free direct send
        if (params.announceChannelType && params.announceChannelId) {
          await deliverFailureNotification({
            channelType: params.announceChannelType,
            channelId: params.announceChannelId,
            task: params.task,
            runtimeMs,
            runId,
          }, deps);
        } else {
          // Log explicit reason when failure announcement cannot be routed
          deps.logger?.debug({
            runId,
            suppressAnnounceReason: params.requesterOrigin ? "no_channel_params" : "no_origin",
            hasOrigin: !!params.requesterOrigin,
          }, "Sub-agent failure announcement skipped: no announce channel");
        }

        // Lifecycle hook - onEnded (failure path)
        if (deps.lifecycleHooks) {
          try {
            await deps.lifecycleHooks.onEnded({
              runId,
              agentId: params.agentId,
              parentSessionKey: params.callerSessionKey ?? "unknown",
              childSessionKey: formattedKey,
              endReason: "failed",
              runtimeMs,
              tokensUsed: 0,
              cost: 0,
            });
          } catch (hookErr) {
            deps.logger?.warn({
              runId, err: hookErr,
              hint: "onSubagentEnded hook failed in error path",
              errorKind: "internal",
            }, "Lifecycle hook onEnded failed");
          }
        }
      }
    })();

    // Per-run watchdog timer
    const subagentCtx = deps.config.subagentContext;
    const perStepMs = subagentCtx?.perStepTimeoutMs ?? 60_000;
    const maxRunMs = subagentCtx?.maxRunTimeoutMs ?? 600_000;
    const runTimeoutMs = params.max_steps
      ? Math.min(params.max_steps * perStepMs, maxRunMs)
      : maxRunMs;

    const watchdogTimer = setTimeout(() => {
      // Guard: if already completed/failed/killed, skip
      if (run.status !== "running") return;

      const completedAt = Date.now();
      const runtimeMs = completedAt - run.startedAt;

      run.status = "failed";
      run.completedAt = completedAt;
      run.error = `Execution timeout: exceeded ${runTimeoutMs}ms wall-clock limit`;

      deps.logger?.error({
        runId, agentId: run.agentId,
        runtimeMs, timeoutMs: runTimeoutMs,
        hint: "Sub-agent watchdog timeout; increase maxRunTimeoutMs or perStepTimeoutMs if tasks legitimately need more time",
        errorKind: "timeout",
      }, "Sub-agent watchdog timeout");

      // Persist failure record (fire-and-forget)
      if (deps.dataDir) {
        suppressError(
          persistFailureRecord({
            dataDir: deps.dataDir,
            sessionKey: run.sessionKey,
            runId,
            task: run.task,
            error: run.error,
            endReason: "watchdog_timeout",
            runtimeMs,
          }, deps.logger),
          "watchdog-failure-record",
        );
      }

      // Abort SDK session (keyed by sessionKey, NOT runId)
      if (deps.activeRunRegistry) {
        const handle = deps.activeRunRegistry.get(run.sessionKey);
        if (handle) {
          handle.abort().catch((abortErr: unknown) => {
            deps.logger?.debug({ runId, err: abortErr }, "Watchdog SDK abort best-effort failed");
          });
        }
      }

      // Emit completion event
      deps.eventBus.emit("session:sub_agent_completed", {
        runId, agentId: run.agentId, success: false,
        runtimeMs, tokensUsed: 0, cost: 0, timestamp: completedAt,
      });

      // Stop proxy typing on watchdog timeout
      emitProxyStop(run, runId, "watchdog_timeout");

      // Deliver failure notification (LLM-free)
      if (params.announceChannelType && params.announceChannelId) {
        deliverFailureNotification({
          channelType: params.announceChannelType,
          channelId: params.announceChannelId,
          task: params.task,
          runtimeMs,
          runId,
        // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
        }, deps).catch(() => { /* deliverFailureNotification already handles errors internally */ });
      }

      // Lifecycle hook (fire-and-forget)
      if (deps.lifecycleHooks) {
        deps.lifecycleHooks.onEnded({
          runId,
          agentId: run.agentId,
          parentSessionKey: run.callerSessionKey ?? "unknown",
          childSessionKey: run.sessionKey,
          endReason: "watchdog_timeout",
          runtimeMs,
          tokensUsed: 0,
          cost: 0,
        }).catch((hookErr) => {
          deps.logger?.warn({
            runId, err: hookErr,
            hint: "onSubagentEnded hook failed in watchdog path",
            errorKind: "internal",
          }, "Lifecycle hook onEnded failed");
        });
      }
    }, runTimeoutMs);

    // Clear watchdog on normal completion/failure
    execPromise.finally(() => clearTimeout(watchdogTimer));

    activePromises.add(execPromise);
    execPromise.finally(() => {
      activePromises.delete(execPromise);
      // Drain queue when a slot opens (use abortGroup for graph-scoped draining)
      const drainKey = run.abortGroup ?? run.callerSessionKey;
      if (drainKey) {
        drainQueue(drainKey);
      }
    });
  }

  /**
   * Promote queued spawns to running when active children count drops below limit.
   * Called from the .finally() of each execution promise.
   */
  function drainQueue(callerSessionKey: string): void {
    const queue = spawnQueue.get(callerSessionKey);
    if (!queue || queue.length === 0) {
      spawnQueue.delete(callerSessionKey);
      return;
    }

    const maxChildren = deps.config.subagentContext?.maxChildrenPerAgent ?? 5;
    let activeChildren = countActiveChildren(callerSessionKey);

    while (activeChildren < maxChildren && queue.length > 0) {
      const next = queue.shift()!;
      const run = runs.get(next.runId);
      if (!run || run.status !== "queued") continue;

      const currentDepth = next.params.depth ?? 0;
      const maxDepth = next.params.maxDepth ?? deps.config.subagentContext?.maxSpawnDepth ?? 3;

      startExecution(next.runId, run, next.params, currentDepth, maxDepth);
      activeChildren++;
    }

    if (queue.length === 0) {
      spawnQueue.delete(callerSessionKey);
    }
  }

  function getRunStatus(runId: string): SubAgentRun | undefined {
    return runs.get(runId);
  }

  /**
   * List tracked sub-agent runs, optionally filtered by recency.
   * @param recentMinutes - Only include runs started within the last N minutes.
   *   If undefined or 0, all runs are returned.
   * @returns Shallow copies of matching runs sorted by startedAt descending.
   */
  function listRuns(recentMinutes?: number): SubAgentRun[] {
    const cutoff = recentMinutes && recentMinutes > 0
      ? Date.now() - recentMinutes * 60_000
      : 0;

    return [...runs.values()]
      .filter((r) => (r.startedAt || r.queuedAt || 0) >= cutoff)
      .sort((a, b) => (b.startedAt || b.queuedAt || 0) - (a.startedAt || a.queuedAt || 0))
      .map((r) => ({ ...r }));
  }

  /**
   * Kill a running sub-agent by marking it as failed.
   * The in-flight executeAgent promise will eventually complete (or error)
   * and find the run already marked -- it skips its completion logic.
   * @param runId - The run ID to kill
   * @returns Result indicating success or failure with error message
   */
  function killRun(runId: string): { killed: boolean; error?: string } {
    const run = runs.get(runId);
    if (!run) {
      return { killed: false, error: `Unknown run ID: ${runId}` };
    }
    if (run.status !== "running" && run.status !== "queued") {
      return { killed: false, error: `Run ${runId} is not running (status: ${run.status})` };
    }

    run.status = "failed";
    run.completedAt = Date.now();
    run.error = "Killed by parent agent";

    // Persist failure record for killed runs (fire-and-forget, belt-defense)
    if (deps.dataDir) {
      suppressError(
        persistFailureRecord({
          dataDir: deps.dataDir,
          sessionKey: run.sessionKey,
          runId,
          task: run.task,
          error: run.error!,
          endReason: "killed",
          runtimeMs: run.completedAt! - run.startedAt,
        }, deps.logger),
        "kill-failure-record",
      );
    }

    // Abort the in-flight SDK session to stop LLM API calls (best-effort)
    if (deps.activeRunRegistry) {
      const handle = deps.activeRunRegistry.get(run.sessionKey);
      if (handle) {
        handle.abort().catch((abortErr: unknown) => {
          deps.logger?.debug(
            { runId, err: abortErr },
            "Sub-agent SDK abort best-effort failed",
          );
        });
      }
    }

    // For graph-owned runs, use direct notification to graph coordinator
    // (bypasses event bus which may have detached listener during session cleanup).
    // CRITICAL: Do NOT emit session:sub_agent_completed AND call notifyNodeFailed --
    // both paths call handleSubAgentCompleted synchronously, causing runningCount to go to -1.
    if (run.graphId && run.nodeId && graphCoordinatorRef) {
      graphCoordinatorRef.notifyNodeFailed(run.graphId, run.nodeId, runId, run.error!);
    } else {
      // Non-graph runs: use existing event bus path
      deps.eventBus.emit("session:sub_agent_completed", {
        runId,
        agentId: run.agentId,
        success: false,
        runtimeMs: run.completedAt! - run.startedAt,
        tokensUsed: 0,
        cost: 0,
        timestamp: run.completedAt!,
      });
    }

    // Stop proxy typing on kill
    emitProxyStop(run, runId, "killed");

    deps.logger?.info({
      runId, agentId: run.agentId,
      durationMs: run.completedAt! - run.startedAt,
      task: run.task.slice(0, 200),
    }, "Sub-agent run killed by parent");

    // Lifecycle hook - onEnded (kill path, fire-and-forget)
    if (deps.lifecycleHooks) {
      deps.lifecycleHooks.onEnded({
        runId,
        agentId: run.agentId,
        parentSessionKey: run.callerSessionKey ?? "unknown",
        childSessionKey: run.sessionKey,
        endReason: "killed",
        runtimeMs: run.completedAt! - run.startedAt,
        tokensUsed: 0,
        cost: 0,
      }).catch((hookErr) => {
        deps.logger?.warn({
          runId, err: hookErr,
          hint: "onSubagentEnded hook failed in kill path",
          errorKind: "internal",
        }, "Lifecycle hook onEnded failed");
      });
    }

    return { killed: true };
  }

  async function shutdown(): Promise<void> {
    clearInterval(sweepInterval);

    // Flush any batched announcements before draining active runs
    if (deps.batcher) {
      await deps.batcher.shutdown();
    }

    // Drain dead-letter queue before shutdown
    if (deps.deadLetterQueue) {
      try {
        await deps.deadLetterQueue.drain(deps.sendToChannel);
      } catch {
        // Best-effort drain on shutdown
      }
    }

    if (activePromises.size === 0) return;

    // Wait for all active runs with a 30-second timeout
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 30_000);
      timer.unref();
    });

    await Promise.race([
      Promise.allSettled([...activePromises]),
      timeout,
    ]);
  }

  /** Late-bind graph coordinator for direct kill cascade notification. */
  function setGraphCoordinator(gc: { notifyNodeFailed(graphId: string, nodeId: string, runId: string, error: string): void }): void {
    graphCoordinatorRef = gc;
  }

  return { spawn, getRunStatus, listRuns, killRun, shutdown, setGraphCoordinator };
}
