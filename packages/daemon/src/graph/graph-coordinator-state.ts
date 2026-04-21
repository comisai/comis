// SPDX-License-Identifier: Apache-2.0
/**
 * Shared state types for the decomposed graph coordinator modules.
 * Contains the mutable state interfaces that are passed as parameters
 * to the extracted module functions, replacing the closure-captured
 * variables from the original monolithic createGraphCoordinator.
 * @module
 */

import type { GraphStateMachine } from "./graph-state-machine.js";
import type {
  ValidatedGraph,
  SessionKey,
  TypedEventBus,
  NodeTypeDriver,
  NodeDriverContext,
  NormalizedMessage,
} from "@comis/core";
import type { AnnouncementBatcher } from "../announcement-batcher.js";

// ---------------------------------------------------------------------------
// Per-graph mutable state
// ---------------------------------------------------------------------------

/**
 * Per-graph run state. Tracks all mutable data for a single graph execution:
 * node mapping, timers, outputs, concurrency counters, driver states, etc.
 */
export interface GraphRunState {
  graphId: string;
  /** Trace ID shared by all sub-agent spawns within this graph run. */
  graphTraceId: string;
  graph: ValidatedGraph;
  stateMachine: GraphStateMachine;
  runIdToNode: Map<string, string>;    // runId -> nodeId
  nodeOutputs: Map<string, string | undefined>;  // nodeId -> output
  nodeTimers: Map<string, ReturnType<typeof setTimeout>>;
  retryTimers: Map<string, ReturnType<typeof setTimeout>>;
  graphTimer: ReturnType<typeof setTimeout> | undefined;
  startedAt: number;
  completedAt?: number;
  runningCount: number;
  callerSessionKey?: string;
  callerAgentId?: string;
  announceChannelType?: string;
  announceChannelId?: string;
  nodeProgress: boolean;
  skippedNodesEmitted: Set<string>;    // tracks nodes already emitted as skipped
  cumulativeTokens: number;
  cumulativeCost: number;
  cancelReason?: "timeout" | "budget" | "manual";
  /** Shared directory path for inter-node data sharing. */
  sharedDir: string;
  /** Active driver states keyed by nodeId. */
  driverStates: Map<string, DriverNodeState>;
  /** Maps runId to {nodeId, agentId} for driver turn completion routing. */
  driverRunIdMap: Map<string, { nodeId: string; agentId: string }>;
  /** EventBus handler references for wait_for_input cleanup. Key: nodeId. */
  waitHandlers: Map<string, (payload: { message: NormalizedMessage; sessionKey: SessionKey }) => void>;
  /** User response text for synthetic runIds from wait_for_input. Key: syntheticRunId. */
  syntheticRunResults: Map<string, string>;
  /** Per-node cache token data captured from completion events */
  nodeCacheData: Map<string, { cacheReadTokens: number; cacheWriteTokens: number }>;
  /** Promise resolving to sorted tool superset for cache prefix sharing. */
  toolSupersetPromise?: Promise<string[]>;
  /** Resolved tool superset names for graph sub-agent spawns. */
  graphToolNames?: string[];
  /** Full tool definitions from assembleToolsForAgent for prewarm API call.
   *  Stored separately from graphToolNames because prewarm needs description + inputSchema. */
  graphToolDefs?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Cleanup function for event-driven spawn gate listeners. */
  cacheWarmCleanup?: () => void;
  /** True when pre-warm API call successfully seeded the cache prefix. */
  cachePrewarmed?: boolean;
  /** Maximum chars for announcement text before truncation + button. Default: 3000. */
  maxAnnouncementChars?: number;
}

/** Per-node driver execution state. */
export interface DriverNodeState {
  driver: NodeTypeDriver;
  ctx: NodeDriverContext;
  currentRunId?: string;
  persistentSessionKey?: string;  // Stable session key for multi-round driver reuse
  /** Tool names discovered across driver rounds, carried forward to seed subsequent round spawns. */
  accumulatedDiscoveries?: string[];
  pendingParallel?: Map<string, { agentId: string; index: number; total: number }>;
  parallelCompleted?: number;
  parallelOutputs?: Array<{ agentId: string; output: string }>;
}

// ---------------------------------------------------------------------------
// Global coordinator mutable state
// ---------------------------------------------------------------------------

/**
 * Shared mutable state for the graph coordinator, passed to all extracted
 * module functions as the first parameter.
 */
export interface CoordinatorSharedState {
  graphs: Map<string, GraphRunState>;
  globalActiveSubAgents: number;
  spawnQueue: SpawnQueueEntry[];
}

/** Entry in the global spawn queue for concurrency gating. */
export interface SpawnQueueEntry {
  graphId: string;
  nodeId: string;
  execute: () => void;
}

// ---------------------------------------------------------------------------
// Coordinator deps (re-exported for module use)
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the graph coordinator factory.
 * Each extracted module receives a narrow subset via Pick<>.
 */
export interface GraphCoordinatorDeps {
  subAgentRunner: {
    spawn(params: {
      task: string;
      agentId: string;
      callerSessionKey?: string;
      callerAgentId?: string;
      model?: string;
      max_steps?: number;
      callerType?: "agent" | "graph";
      graphSharedDir?: string;
      graphTraceId?: string;
      graphId?: string;
      nodeId?: string;
      /** Sorted tool name superset for graph sub-agent cache prefix sharing. */
      graphToolNames?: string[];
      /** Reuse an existing session key for multi-round driver spawns. */
      reuseSessionKey?: string;
      /** Pre-discovered deferred tool names for sub-agent discovery tracker seeding. */
      discoveredDeferredTools?: string[];
      /** Graph node depth: 0 = root (dependsOn=[]), 1+ = downstream. */
      graphNodeDepth?: number;
      /** True when this graph node is a leaf (no other node depends on it).
       *  Leaf nodes use "short" cache retention — their prefix has no consumers. */
      isLeafNode?: boolean;
    }): string;
    killRun(runId: string): { killed: boolean; error?: string };
    getRunStatus(runId: string): { status: string; result?: { response: string }; error?: string; sessionKey?: string } | undefined;
  };
  eventBus: TypedEventBus;
  sendToChannel: (channelType: string, channelId: string, text: string, options?: { extra?: Record<string, unknown> }) => Promise<boolean>;
  announceToParent?: (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    text: string,
    channelType: string,
    channelId: string,
  ) => Promise<void>;
  tenantId: string;
  defaultAgentId: string;
  maxConcurrency?: number;       // default 4
  maxResultLength?: number;      // default 12000
  graphRetentionMs?: number;     // default 3_600_000 (1 hour)
  logger?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  /** Base data directory for graph-runs shared directories (e.g., ~/.comis). */
  dataDir: string;
  maxParallelSpawns?: number;    // default 10 -- per-node cap on spawn_all
  maxGlobalSubAgents?: number;   // default 20 -- cross-graph sub-agent cap
  /** Delay (ms) between concurrent sub-agent spawns in the same wave. */
  spawnStaggerMs?: number;
  /** Timeout (ms) waiting for cache write signal before fallback spawn. Default: 30000.
   *  Must exceed first-LLM-turn latency (Sonnet + extended thinking typically 15-25s). */
  cacheWriteTimeoutMs?: number;
  nodeTypeRegistry?: {
    get(typeId: string): NodeTypeDriver | undefined;
  };
  /** Optional announcement batcher for coalescing concurrent graph completion announcements. */
  batcher?: AnnouncementBatcher;
  /** Active run registry for parent-session-gone detection. */
  activeRunRegistry?: {
    has(sessionKey: string): boolean;
  };
  /** Assemble tools for an agent ID, returning objects with at least a `name` field.
   *  Used at graph start to compute the tool superset for cache prefix sharing.
   *  When `description` and `inputSchema` are included, they're passed to the prewarm call
   *  so the cache prefix matches what sub-agents will actually send to the API. */
  assembleToolsForAgent?: (agentId: string) => Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  /** Optional pre-warm configuration. When provided, a lightweight API call
   *  seeds the cache before graph nodes spawn. */
  preWarm?: {
    /** LLM provider (e.g., "anthropic"). Only Anthropic-family activates pre-warm. */
    provider: string;
    /** Model ID for the pre-warm call (typically the default agent's model). */
    modelId: string;
    /** API key for the provider. */
    apiKey: string;
    /** System prompt for the default agent. */
    systemPrompt: string;
    /** Full tool definitions for the default agent (with description + inputSchema). */
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  };
  /** Keep parent session lane alive during graph execution. Called on each node
   *  completion to prevent idle lane cleanup from reaping the parent before graph announcement. */
  touchParentSession?: (sessionKey: string) => void;
  /** Maximum chars for announcement text before truncation + Full Report button. Default: 3000. */
  maxAnnouncementChars?: number;
}

// ---------------------------------------------------------------------------
// Resolved config (computed from deps at factory creation time)
// ---------------------------------------------------------------------------

/** Resolved configuration values, computed once from deps defaults. */
export interface CoordinatorConfig {
  maxConcurrency: number;
  maxResultLength: number;
  graphRetentionMs: number;
  maxGlobalSubAgents: number;
  maxParallelSpawns: number;
  spawnStaggerMs: number;
  cacheWriteTimeoutMs: number;
  maxGraphs: number;
  sweepIntervalMs: number;
  maxAnnouncementChars: number;
}
