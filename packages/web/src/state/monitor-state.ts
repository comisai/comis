/**
 * Reactive state manager for the execution monitor with polling.
 *
 * Follows the same subscribe/getSnapshot pattern as graph-builder-state.ts.
 * Encapsulates graph.status RPC polling, data transformation (merging node
 * definitions with runtime status), elapsed time tracking, and reactive
 * notification for Lit components.
 *
 * No undo/redo -- this is a read-only view of execution state.
 */

import type {
  PipelineNode,
  PipelineEdge,
  MonitorNodeState,
  MonitorSnapshot,
} from "../api/types/index.js";
import type { RpcClient } from "../api/rpc-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Public interface for the monitor state manager */
export interface MonitorState {
  /** Subscribe to any state change. Returns an unsubscribe function. */
  subscribe(handler: () => void): () => void;
  /** Return a frozen snapshot of the current state. */
  getSnapshot(): MonitorSnapshot;
  /** Select a node by ID (or null to clear). */
  selectNode(nodeId: string | null): void;
  /** Start polling graph.status for the given graph. */
  startPolling(
    rpcClient: RpcClient,
    graphId: string,
    nodeDefinitions: PipelineNode[],
    edges: PipelineEdge[],
  ): void;
  /** Stop polling but preserve the last snapshot. */
  stopPolling(): void;
  /** Clear all timers and resources. */
  destroy(): void;
  /** Apply an SSE event to update state incrementally (no RPC needed). */
  applyEvent(type: "graph:started" | "graph:node_updated" | "graph:completed", payload: unknown): void;
  /** Suspend polling (called when SSE connection is active). */
  suspendPolling(): void;
  /** Resume polling with an immediate recovery poll (called when SSE disconnects). */
  resumePolling(): void;
}

/** Response shape from graph.status RPC */
interface GraphStatusResponse {
  readonly graphId: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly isTerminal: boolean;
  readonly executionOrder: string[];
  readonly nodes: Record<
    string,
    {
      readonly status: string;
      readonly runId?: string;
      readonly output?: string;
      readonly error?: string;
      readonly startedAt?: number;
      readonly completedAt?: number;
      readonly durationMs?: number;
      readonly retryAttempt?: number;
      readonly retriesRemaining?: number;
    }
  >;
  readonly stats: {
    readonly total: number;
    readonly completed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly running: number;
    readonly pending: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Polling interval in milliseconds */
const POLL_INTERVAL_MS = 2000;

/** Elapsed timer interval in milliseconds (smooth UI countdown) */
const ELAPSED_INTERVAL_MS = 1000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Re-export MonitorSnapshot for convenience */
export type { MonitorSnapshot };

/**
 * Create a reactive monitor state store with polling support.
 *
 * @returns A MonitorState instance for execution monitoring
 */
export function createMonitorState(): MonitorState {
  // Mutable internal state
  let graphId = "";
  let graphStatus: MonitorSnapshot["graphStatus"] = "running";
  let isTerminal = false;
  let nodes: MonitorNodeState[] = [];
  let storedEdges: PipelineEdge[] = [];
  let executionOrder: string[] = [];
  let stats: MonitorSnapshot["stats"] = {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    running: 0,
    pending: 0,
  };
  let elapsedMs = 0;
  let selectedNodeId: string | null = null;
  let loading = true;
  let error: string | null = null;

  // Timer references
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  // Elapsed tracking reference
  let startedAt: number | null = null;

  // Node definitions from caller (for merging with runtime status)
  let nodeDefinitions: PipelineNode[] = [];

  // Stored RPC client for resumePolling recovery poll
  let storedRpcClient: RpcClient | null = null;

  // Subscribers
  const subscribers = new Set<() => void>();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function notifyAll(): void {
    for (const handler of subscribers) {
      handler();
    }
  }

  /** Merge node definitions with runtime status from RPC response */
  function mergeNodes(
    defs: PipelineNode[],
    runtimeNodes: GraphStatusResponse["nodes"],
  ): MonitorNodeState[] {
    return defs.map((def) => {
      const runtime = runtimeNodes[def.id];
      return {
        id: def.id,
        task: def.task,
        agentId: def.agentId,
        modelId: def.modelId,
        status: (runtime?.status as MonitorNodeState["status"]) ?? "pending",
        runId: runtime?.runId,
        output: runtime?.output,
        error: runtime?.error,
        startedAt: runtime?.startedAt,
        completedAt: runtime?.completedAt,
        durationMs: runtime?.durationMs,
        retryAttempt: runtime?.retryAttempt,
        retriesRemaining: runtime?.retriesRemaining,
        dependsOn: def.dependsOn,
        position: { x: def.position.x, y: def.position.y },
      };
    });
  }

  /** Process a successful poll response */
  function handlePollResponse(response: GraphStatusResponse): void {
    graphId = response.graphId;
    graphStatus = response.status;
    isTerminal = response.isTerminal;
    executionOrder = response.executionOrder;
    stats = response.stats;
    nodes = mergeNodes(nodeDefinitions, response.nodes);
    loading = false;
    error = null;

    // Start elapsed timer on first running response
    if (startedAt === null && response.status === "running") {
      startedAt = Date.now();
      elapsedMs = 0;
      startElapsedTimer();
    }

    // Stop timers on terminal
    if (isTerminal) {
      clearPollTimer();
      clearElapsedTimer();
    }

    notifyAll();
  }

  /** Process a poll error */
  function handlePollError(err: unknown): void {
    error = err instanceof Error ? err.message : String(err);
    loading = false;
    notifyAll();
  }

  /** Perform a single poll */
  async function poll(rpcClient: RpcClient, gId: string): Promise<void> {
    try {
      const response = await rpcClient.call<GraphStatusResponse>(
        "graph.status",
        { graphId: gId },
      );
      handlePollResponse(response);
    } catch (err) {
      handlePollError(err);
    }
  }

  function clearPollTimer(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function clearElapsedTimer(): void {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function startElapsedTimer(): void {
    clearElapsedTimer();
    elapsedTimer = setInterval(() => {
      if (startedAt !== null) {
        elapsedMs = Date.now() - startedAt;
        notifyAll();
      }
    }, ELAPSED_INTERVAL_MS);
  }

  /** Recalculate stats by counting node statuses (used by applyEvent) */
  function recalcStats(): void {
    let completed = 0, failed = 0, skipped = 0, running = 0, pending = 0;
    for (const node of nodes) {
      switch (node.status) {
        case "completed": completed++; break;
        case "failed": failed++; break;
        case "skipped": skipped++; break;
        case "running": running++; break;
        default: pending++; break;
      }
    }
    stats = { total: nodes.length, completed, failed, skipped, running, pending };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    subscribe(handler: () => void): () => void {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    getSnapshot(): MonitorSnapshot {
      return Object.freeze({
        graphId,
        graphStatus,
        isTerminal,
        nodes: [...nodes],
        edges: [...storedEdges],
        executionOrder: [...executionOrder],
        stats: { ...stats },
        elapsedMs,
        selectedNodeId,
        loading,
        error,
      });
    },

    selectNode(nodeId: string | null): void {
      selectedNodeId = nodeId;
      notifyAll();
    },

    startPolling(
      rpcClient: RpcClient,
      gId: string,
      defs: PipelineNode[],
      edges: PipelineEdge[],
    ): void {
      // Clear any existing timers (prevents stacked intervals)
      clearPollTimer();
      clearElapsedTimer();

      // Store RPC client for resumePolling recovery poll
      storedRpcClient = rpcClient;

      // Reset state for new polling session
      graphId = gId;
      nodeDefinitions = defs;
      storedEdges = edges;
      startedAt = null;
      isTerminal = false;

      // Immediate first poll
      poll(rpcClient, gId);

      // Then poll every 2s
      pollTimer = setInterval(() => {
        poll(rpcClient, gId);
      }, POLL_INTERVAL_MS);
    },

    stopPolling(): void {
      clearPollTimer();
      clearElapsedTimer();
    },

    destroy(): void {
      clearPollTimer();
      clearElapsedTimer();
      subscribers.clear();
    },

    applyEvent(
      type: "graph:started" | "graph:node_updated" | "graph:completed",
      payload: unknown,
    ): void {
      if (type === "graph:node_updated") {
        const p = payload as {
          graphId: string;
          nodeId: string;
          status: string;
          durationMs?: number;
          error?: string;
          timestamp: number;
        };
        if (p.graphId !== graphId) return;

        const idx = nodes.findIndex((n) => n.id === p.nodeId);
        if (idx >= 0) {
          const existing = nodes[idx];
          nodes[idx] = {
            ...existing,
            status: p.status as MonitorNodeState["status"],
            durationMs: p.durationMs ?? existing.durationMs,
            error: p.error ?? existing.error,
            startedAt:
              p.status === "running" && existing.startedAt == null
                ? p.timestamp
                : existing.startedAt,
            completedAt:
              p.status === "completed" || p.status === "failed"
                ? p.timestamp
                : existing.completedAt,
          };
          recalcStats();
          notifyAll();
        }
      } else if (type === "graph:completed") {
        const p = payload as {
          graphId: string;
          status: string;
          durationMs: number;
          nodeCount: number;
          nodesCompleted: number;
          nodesFailed: number;
          nodesSkipped: number;
          timestamp: number;
        };
        if (p.graphId !== graphId) return;

        graphStatus = p.status as MonitorSnapshot["graphStatus"];
        isTerminal = true;
        stats = {
          total: p.nodeCount,
          completed: p.nodesCompleted,
          failed: p.nodesFailed,
          skipped: p.nodesSkipped,
          running: 0,
          pending: 0,
        };
        clearPollTimer();
        clearElapsedTimer();
        loading = false;
        error = null;
        notifyAll();
      } else if (type === "graph:started") {
        const p = payload as {
          graphId: string;
          nodeCount: number;
          timestamp: number;
        };
        if (p.graphId !== graphId) return;

        if (startedAt === null) {
          startedAt = Date.now();
          elapsedMs = 0;
          startElapsedTimer();
        }
        notifyAll();
      }
    },

    suspendPolling(): void {
      clearPollTimer();
    },

    resumePolling(): void {
      if (isTerminal) return;
      if (!storedRpcClient) return;

      // Immediate recovery poll
      poll(storedRpcClient, graphId);

      // Restart the interval
      clearPollTimer();
      pollTimer = setInterval(() => {
        poll(storedRpcClient!, graphId);
      }, POLL_INTERVAL_MS);
    },
  };
}
