// SPDX-License-Identifier: Apache-2.0
/**
 * Heartbeat wiring: creates PerAgentHeartbeatRunner with AgentHeartbeatSource
 * as its onTick callback for LLM-driven per-agent heartbeat turns.
 * Extracted from daemon.ts step 6.7.0.0 to isolate per-agent heartbeat
 * initialization from the main wiring sequence.
 * Agent Heartbeat Source
 * @module
 */

import { readFile } from "node:fs/promises";
import type { AppContainer, ChannelPort } from "@comis/core";
import { safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { isHeartbeatContentEffectivelyEmpty } from "@comis/agent";
import {
  resolveEffectiveHeartbeatConfig,
  createAgentHeartbeatSource,
  createPerAgentHeartbeatRunner,
  createDuplicateDetector,

  type PerAgentHeartbeatRunner,
  type HeartbeatAgentState,
  type HeartbeatMemoryStats,
  type DuplicateDetector,
  type SystemEventQueue,
} from "@comis/scheduler";
import { applyToolPolicy } from "@comis/skills";

// ---------------------------------------------------------------------------
// Local type aliases (avoid importing from agent to prevent circular deps)
// ---------------------------------------------------------------------------

/** Minimal ActiveRunRegistry -- only needs has() for queue-busy check. */
interface HeartbeatActiveRunRegistry {
  has(sessionKey: string): boolean;
}

/** 8-param executor interface matching AgentExecutor.execute (used in deps map). */
interface InnerExecutor {
  execute(
    msg: unknown,
    sessionKey: unknown,
    tools?: unknown[],
    onDelta?: unknown,
    agentId?: string,
    directives?: unknown,
    prevTimestamp?: number,
    overrides?: unknown,
  ): Promise<{ response: string }>;
}

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for per-agent heartbeat setup. */
export interface HeartbeatSetupDeps {
  /** Bootstrap output (config.agents, config.scheduler, eventBus). */
  container: AppContainer;
  /** Per-agent executors map (8-param AgentExecutor instances). */
  executors: Map<string, InnerExecutor>;
  /** Tool pipeline assembler for an agent. */
  assembleToolsForAgent: (agentId: string) => Promise<unknown[]>;
  /** Per-agent workspace directories. */
  workspaceDirs: Map<string, string>;
  /** Active run registry for queue-busy detection (optional). */
  activeRunRegistry?: HeartbeatActiveRunRegistry;
  /** Duplicate detector shared between global and per-agent heartbeat delivery. */
  duplicateDetector?: DuplicateDetector;
  /** Channel adapters for heartbeat delivery (optional). */
  adaptersByType?: ReadonlyMap<string, ChannelPort>;
  /** System event queue for trigger resolution. */
  systemEventQueue: SystemEventQueue;
  /** Memory API for fetching memory stats (optional, for heartbeat prompt injection). */
  memoryApi?: { stats: (tenantId?: string, agentId?: string) => { totalEntries: number; oldestCreatedAt: number | null } };
  /** Module-bound logger for scheduler subsystem. */
  schedulerLogger: ComisLogger;
}

/** All services produced by the per-agent heartbeat setup phase. */
export interface HeartbeatSetupResult {
  /** Per-agent heartbeat runner for shutdown cleanup (optional). */
  perAgentRunner?: PerAgentHeartbeatRunner;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create per-agent heartbeat runner with AgentHeartbeatSource as its
 * onTick callback for LLM-driven heartbeat turns.
 * Synchronous agent filtering, async file gate closure. Returns the
 * runner handle for shutdown registration.
 * @param deps - Per-agent heartbeat dependencies
 */
export function setupHeartbeat(deps: HeartbeatSetupDeps): HeartbeatSetupResult {
  const {
    container,
    executors,
    assembleToolsForAgent,
    workspaceDirs,
    activeRunRegistry,
    duplicateDetector,
    adaptersByType,
    systemEventQueue,
    memoryApi,
    schedulerLogger,
  } = deps;

  const agents = container.config.agents;
  const globalHeartbeat = container.config.scheduler.heartbeat;

  // 1. Build per-agent state map (only heartbeat-enabled agents)
  const agentStates = new Map<string, HeartbeatAgentState>();

  for (const [agentId, agentConfig] of Object.entries(agents)) {
    const effectiveConfig = resolveEffectiveHeartbeatConfig(
      globalHeartbeat,
      agentConfig.scheduler?.heartbeat,
    );

    if (!effectiveConfig.enabled) {
      continue;
    }

    agentStates.set(agentId, {
      agentId,
      config: effectiveConfig,
      lastRunMs: 0,
      nextDueMs: 0,
      consecutiveErrors: 0,
      backoffUntilMs: 0,
      tickStartedAtMs: 0,
      lastAlertMs: 0,
      lastErrorKind: null,
    });
  }

  // 2. No agents have heartbeat enabled -> nothing to wire
  if (agentStates.size === 0) {
    return { perAgentRunner: undefined };
  }

  // 3. File gate closure: check HEARTBEAT.md content for empty-file gate
  async function checkFileGate(agentId: string): Promise<boolean> {
    const workspaceDir = workspaceDirs.get(agentId);
    if (!workspaceDir) return false; // no workspace = don't skip
    try {
      const filePath = safePath(workspaceDir, "HEARTBEAT.md");
      const content = await readFile(filePath, "utf-8");
      return isHeartbeatContentEffectivelyEmpty(content);
    } catch {
      return false; // missing file = don't skip
    }
  }

  // 3.5 Memory stats getter for heartbeat prompt injection
  const getMemoryStats = memoryApi
    ? (agentId: string, tenantId: string): HeartbeatMemoryStats | undefined => {
        const stats = memoryApi.stats(tenantId, agentId);
        if (stats.totalEntries === 0 || stats.oldestCreatedAt === null) return undefined;
        const ageDays = Math.floor((Date.now() - stats.oldestCreatedAt) / 86_400_000);
        return { totalEntries: stats.totalEntries, oldestEntryAgeDays: ageDays };
      }
    : undefined;

  // 4. Build AgentHeartbeatSource dependencies
  const source = createAgentHeartbeatSource({
    getExecutor: (agentId: string) => {
      const inner = executors.get(agentId)!;
      return {
        execute: (msg: unknown, sessionKey: unknown, tools?: unknown[],
                  hbAgentId?: string, overrides?: Record<string, unknown>) =>
          inner.execute(msg, sessionKey, tools,
            undefined, hbAgentId, undefined, undefined, overrides),
      };
    },
    assembleToolsForAgent,
    getEffectiveConfig: (agentId: string) =>
      resolveEffectiveHeartbeatConfig(
        globalHeartbeat,
        agents[agentId]!.scheduler?.heartbeat,
      ),
    getAgentConfig: (agentId: string) => ({
      model: agents[agentId]!.model,
      tenantId: container.config.tenantId,
      toolPolicy: agents[agentId]!.skills?.toolPolicy,
    }),
    checkFileGate,
    systemEventQueue,
    deliveryBridge: {
      adaptersByType: adaptersByType ?? new Map(),
      duplicateDetector: duplicateDetector ?? createDuplicateDetector(),
      eventBus: container.eventBus,
      logger: schedulerLogger,
    },
    activeRunRegistry,
    getMemoryStats,
    // Inject applyToolPolicy so scheduler can filter without taking a direct
    // dependency on @comis/skills. Type-erased `unknown[]` at the boundary is
    // safe: the filter reads only the `.name` field from each tool, and
    // scheduler never inspects tool contents beyond passing them through.
    applyToolPolicyFilter: (allTools, policy) => {
      const { tools, filtered } = applyToolPolicy(
        allTools as Parameters<typeof applyToolPolicy>[0],
        policy,
      );
      return { tools, filtered };
    },
    logger: schedulerLogger,
  });

  // 5. Create and start the per-agent runner
  const runner = createPerAgentHeartbeatRunner({
    agents: agentStates,
    eventBus: container.eventBus,
    logger: schedulerLogger,
    onTick: source.onTick,
  });

  runner.start();

  schedulerLogger.info(
    { agentCount: agentStates.size },
    "Per-agent heartbeat runner started",
  );

  return { perAgentRunner: runner };
}
