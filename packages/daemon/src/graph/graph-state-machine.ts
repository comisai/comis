/**
 * Synchronous graph execution state machine.
 * Manages node lifecycle transitions, barrier evaluation (dependency
 * readiness), and failure cascade propagation for DAG-based execution
 * graphs. All methods are synchronous -- zero async, zero await, zero
 * Promise -- to prevent barrier race conditions.
 * The state machine returns what nodes became ready or skipped; the
 * caller (GraphCoordinator) handles async spawning.
 * Supports three barrier modes per fan-in node:
 * - `all` (default): all deps must be completed
 * - `majority`: >50% of deps completed, all deps terminal
 * - `best-effort`: all deps terminal, at least 1 completed
 * Supports two failure policies at the graph level:
 * - `fail-fast` (default): any failed dep cascades skip to dependents
 * - `continue`: skip only if barrier can never be satisfied
 * @module
 */

import {
  type ValidatedGraph,
  type NodeStatus,
  type GraphStatus,
  type NodeExecutionState,
} from "@comis/core";
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Result of markNodeFailed: both skipped nodes (cascade) and nodes
 * that became ready (barrier satisfied by failure making all deps terminal).
 */
export interface FailureResult {
  skipped: string[];
  newlyReady: string[];
  retrying: string[];
}

/**
 * Snapshot of all graph execution state at a point in time.
 * The nodes Map is a clone -- mutations do not affect the state machine.
 */
export interface GraphExecutionSnapshot {
  graphStatus: GraphStatus;
  nodes: Map<string, NodeExecutionState>;
  executionOrder: string[];
  isTerminal: boolean;
}

/**
 * Synchronous state machine interface for graph execution.
 * All methods are synchronous. The caller handles async work (spawning
 * sub-agents, emitting events) based on return values.
 */
export interface GraphStateMachine {
  /** Transition a "ready" node to "running" with its sub-agent runId. */
  markNodeRunning(nodeId: string, runId: string): Result<void, string>;

  /** Transition a "running" node to "completed". Returns newly ready node IDs. */
  markNodeCompleted(nodeId: string, output?: string): Result<string[], string>;

  /** Transition a "running" node to "failed". Returns skipped and newly ready node IDs. */
  markNodeFailed(nodeId: string, error: string): Result<FailureResult, string>;

  /** Get current state of a specific node. */
  getNodeState(nodeId: string): NodeExecutionState | undefined;

  /** Get all node IDs currently in "ready" state. */
  getReadyNodes(): string[];

  /** Get the overall graph status computed from node states. */
  getGraphStatus(): GraphStatus;

  /** True when no nodes are pending, ready, or running. */
  isTerminal(): boolean;

  /** Get the topologically sorted execution order. */
  getExecutionOrder(): string[];

  /** Get a snapshot of all node states (cloned to prevent external mutation). */
  snapshot(): GraphExecutionSnapshot;

  /** Mark all pending/ready nodes as skipped. Returns their IDs. Does NOT affect running nodes. */
  cancel(): string[];
}

// ---------------------------------------------------------------------------
// Valid transition lookup
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  pending: ["ready", "skipped"],
  ready: ["running", "skipped"],
  running: ["completed", "failed"],
  completed: [],
  failed: [],
  skipped: [],
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a synchronous graph state machine from a validated graph.
 * Root nodes (no dependencies) start as "ready"; all others start as
 * "pending". The reverse adjacency map enables efficient barrier
 * evaluation and failure cascade propagation.
 * Follows the factory function pattern from createSubAgentRunner:
 * closure over internal mutable state, return typed interface.
 */
export function createGraphStateMachine(validated: ValidatedGraph): GraphStateMachine {
  // 1. Initialize node execution states
  const nodeStates = new Map<string, NodeExecutionState>();
  for (const node of validated.graph.nodes) {
    const isRoot = node.dependsOn.length === 0;
    nodeStates.set(node.nodeId, {
      nodeId: node.nodeId,
      status: isRoot ? "ready" : "pending",
      retryAttempt: 0,
      retriesRemaining: node.retries ?? 0,
    });
  }

  // 2. Build dependency lookup: nodeId -> dependsOn array
  const dependsOnMap = new Map<string, string[]>();
  for (const node of validated.graph.nodes) {
    dependsOnMap.set(node.nodeId, [...node.dependsOn]);
  }

  // 3. Build reverse adjacency: nodeId -> list of dependent nodeIds
  const dependentsMap = new Map<string, string[]>();
  for (const node of validated.graph.nodes) {
    dependentsMap.set(node.nodeId, []);
  }
  for (const node of validated.graph.nodes) {
    for (const dep of node.dependsOn) {
      dependentsMap.get(dep)!.push(node.nodeId);
    }
  }

  // 4. Extract barrier modes (per-node) and failure policy (graph-level)
  const onFailure = validated.graph.onFailure ?? "fail-fast";
  const barrierModeMap = new Map<string, string>();
  for (const node of validated.graph.nodes) {
    barrierModeMap.set(node.nodeId, node.barrierMode ?? "all");
  }

  // 5. Extract per-node retry counts
  const retriesMap = new Map<string, number>();
  for (const node of validated.graph.nodes) {
    retriesMap.set(node.nodeId, node.retries ?? 0);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function isValidTransition(from: NodeStatus, to: NodeStatus): boolean {
    return VALID_TRANSITIONS[from].includes(to);
  }

  function getState(nodeId: string): NodeExecutionState | undefined {
    return nodeStates.get(nodeId);
  }

  /**
   * Check if any dependency of a node is "failed" or "skipped".
   */
  function hasFailedOrSkippedDep(nodeId: string): boolean {
    const deps = dependsOnMap.get(nodeId) ?? [];
    for (const depId of deps) {
      const depState = nodeStates.get(depId);
      if (depState && (depState.status === "failed" || depState.status === "skipped")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Count completed and terminal dependencies for a node.
   */
  function countDepStates(nodeId: string): { completed: number; terminal: number; total: number } {
    const deps = dependsOnMap.get(nodeId) ?? [];
    let completed = 0;
    let terminal = 0;

    for (const depId of deps) {
      const depState = nodeStates.get(depId);
      if (!depState) continue;
      if (depState.status === "completed") {
        completed++;
        terminal++;
      } else if (depState.status === "failed" || depState.status === "skipped") {
        terminal++;
      }
    }

    return { completed, terminal, total: deps.length };
  }

  /**
   * Check if a node's barrier is satisfied given current dependency states.
   * Key constraint: ALL deps must be in a terminal state (completed/failed/skipped)
   * before any barrier mode fires. A best-effort node does NOT fire as soon as
   * 1 dep completes -- it waits for all deps to reach terminal.
   */
  function isBarrierSatisfied(nodeId: string, mode: string): boolean {
    const { completed, terminal, total } = countDepStates(nodeId);
    if (total === 0) return true; // root node

    switch (mode) {
      case "all":
        return completed === total;
      case "majority":
        return terminal === total && completed > total / 2;
      case "best-effort":
        return terminal === total && completed >= 1;
      default:
        return completed === total; // fallback to "all"
    }
  }

  /**
   * Check if a node's barrier can NEVER be satisfied given current and
   * potentially completable dependencies.
   * Used by continue-on-failure policy: a node is skipped only when its
   * barrier is provably unsatisfiable.
   */
  function isBarrierUnsatisfiable(nodeId: string, mode: string): boolean {
    const deps = dependsOnMap.get(nodeId) ?? [];
    let completed = 0;
    let canStillComplete = 0; // pending, ready, or running

    for (const depId of deps) {
      const depState = nodeStates.get(depId);
      if (!depState) continue;
      if (depState.status === "completed") {
        completed++;
      } else if (
        depState.status === "pending" ||
        depState.status === "ready" ||
        depState.status === "running"
      ) {
        canStillComplete++;
      }
    }

    const maxPossibleCompleted = completed + canStillComplete;

    switch (mode) {
      case "all":
        return maxPossibleCompleted < deps.length;
      case "majority":
        return maxPossibleCompleted <= deps.length / 2;
      case "best-effort":
        return maxPossibleCompleted === 0; // all deps failed/skipped
      default:
        return maxPossibleCompleted < deps.length; // fallback to "all"
    }
  }

  /**
   * Transitive failure cascade: BFS through all dependents, applying
   * skip logic based on the graph's failure policy and per-node barrier modes.
   * With fail-fast: any failed/skipped dep cascades to skip (original behavior).
   * With continue: only skip if barrier can never be satisfied; make ready if
   * barrier is currently satisfied.
   */
  function cascadeFailure(startNodeId: string): FailureResult {
    const skipped: string[] = [];
    const newlyReady: string[] = [];
    const queue = [...(dependentsMap.get(startNodeId) ?? [])];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const state = nodeStates.get(nodeId);
      if (!state) continue;

      // Only cascade to nodes that are still pending or ready
      if (state.status !== "pending" && state.status !== "ready") continue;

      const mode = barrierModeMap.get(nodeId) ?? "all";

      if (onFailure === "fail-fast") {
        // Original behavior: any failed/skipped dep -> skip
        if (hasFailedOrSkippedDep(nodeId)) {
          state.status = "skipped";
          state.completedAt = Date.now();
          skipped.push(nodeId);

          // Continue cascade to this node's dependents
          const nextDeps = dependentsMap.get(nodeId) ?? [];
          for (const next of nextDeps) {
            if (!visited.has(next)) {
              queue.push(next);
            }
          }
        }
      } else {
        // "continue" policy: check barrier satisfiability
        if (isBarrierUnsatisfiable(nodeId, mode)) {
          state.status = "skipped";
          state.completedAt = Date.now();
          skipped.push(nodeId);

          // Continue cascade to this node's dependents
          const nextDeps = dependentsMap.get(nodeId) ?? [];
          for (const next of nextDeps) {
            if (!visited.has(next)) {
              queue.push(next);
            }
          }
        } else if (isBarrierSatisfied(nodeId, mode)) {
          // All deps terminal and barrier met -> ready
          state.status = "ready";
          newlyReady.push(nodeId);
        }
        // else: some deps still running/pending, leave as pending
      }
    }

    return { skipped, newlyReady, retrying: [] };
  }

  /**
   * Evaluate barrier for all dependents of a trigger node: if a
   * dependent's barrier is satisfied, mark it "ready".
   * Uses per-node barrier mode instead of requiring all deps completed.
   */
  function evaluateBarriers(triggerNodeId: string): string[] {
    const newlyReady: string[] = [];
    const dependents = dependentsMap.get(triggerNodeId) ?? [];

    for (const depId of dependents) {
      const state = nodeStates.get(depId);
      if (!state || state.status !== "pending") continue;

      const mode = barrierModeMap.get(depId) ?? "all";
      if (isBarrierSatisfied(depId, mode)) {
        state.status = "ready";
        newlyReady.push(depId);
      }
    }

    return newlyReady;
  }

  /**
   * Compute overall graph status from node states.
   */
  function computeGraphStatus(): GraphStatus {
    let hasActive = false;
    let hasCompleted = false;

    for (const state of nodeStates.values()) {
      if (state.status === "pending" || state.status === "ready" || state.status === "running") {
        hasActive = true;
      }
      if (state.status === "completed") {
        hasCompleted = true;
      }
    }

    if (hasActive) return "running";
    // All terminal: check if any completed
    if (hasCompleted) return "completed";
    // All terminal, none completed (all failed + skipped)
    return "failed";
  }

  /**
   * Check if graph has reached terminal state: no pending, ready, or running nodes.
   */
  function computeIsTerminal(): boolean {
    for (const state of nodeStates.values()) {
      if (state.status === "pending" || state.status === "ready" || state.status === "running") {
        return false;
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function markNodeRunning(nodeId: string, runId: string): Result<void, string> {
    const state = getState(nodeId);
    if (!state) {
      return err(`Node "${nodeId}" not found`);
    }
    if (!isValidTransition(state.status, "running")) {
      return err(`Cannot transition node "${nodeId}" from "${state.status}" to "running"`);
    }
    state.status = "running";
    state.runId = runId;
    state.startedAt = Date.now();
    return ok(undefined);
  }

  function markNodeCompleted(nodeId: string, output?: string): Result<string[], string> {
    const state = getState(nodeId);
    if (!state) {
      return err(`Node "${nodeId}" not found`);
    }
    if (!isValidTransition(state.status, "completed")) {
      return err(`Cannot transition node "${nodeId}" from "${state.status}" to "completed"`);
    }
    state.status = "completed";
    state.output = output;
    state.completedAt = Date.now();

    // Evaluate barriers for dependents
    const newlyReady = evaluateBarriers(nodeId);
    return ok(newlyReady);
  }

  function markNodeFailed(nodeId: string, error: string): Result<FailureResult, string> {
    const state = getState(nodeId);
    if (!state) {
      return err(`Node "${nodeId}" not found`);
    }
    if (!isValidTransition(state.status, "failed")) {
      return err(`Cannot transition node "${nodeId}" from "${state.status}" to "failed"`);
    }

    // Check retry eligibility BEFORE setting failed
    const remaining = state.retriesRemaining ?? 0;
    if (remaining > 0) {
      // Transition back to ready instead of failed
      state.status = "ready";
      state.error = error;              // preserve last error for observability
      state.retryAttempt = (state.retryAttempt ?? 0) + 1;
      state.retriesRemaining = remaining - 1;
      state.runId = undefined;          // clear stale runId
      state.startedAt = undefined;      // reset timing for next attempt
      state.completedAt = undefined;
      // Do NOT cascade -- downstream nodes stay pending/ready
      return ok({ skipped: [], newlyReady: [], retrying: [nodeId] });
    }

    // Original path: no retries remaining, proceed with failure
    state.status = "failed";
    state.error = error;
    state.completedAt = Date.now();

    // Transitive failure cascade (returns both skipped and newlyReady)
    const cascadeResult = cascadeFailure(nodeId);

    // Also evaluate barriers for dependents of the failed node.
    // A failure makes a dep terminal, which can satisfy majority/best-effort
    // barriers for nodes not yet visited by cascade.
    const barrierReady = evaluateBarriers(nodeId);

    // Merge newlyReady arrays (dedup)
    const allNewlyReady = [...cascadeResult.newlyReady];
    const readySet = new Set(allNewlyReady);
    for (const id of barrierReady) {
      if (!readySet.has(id)) {
        allNewlyReady.push(id);
        readySet.add(id);
      }
    }

    return ok({ skipped: cascadeResult.skipped, newlyReady: allNewlyReady, retrying: [] });
  }

  function getNodeState(nodeId: string): NodeExecutionState | undefined {
    const state = getState(nodeId);
    if (!state) return undefined;
    return { ...state };
  }

  function getReadyNodes(): string[] {
    const ready: string[] = [];
    for (const state of nodeStates.values()) {
      if (state.status === "ready") {
        ready.push(state.nodeId);
      }
    }
    return ready;
  }

  function getGraphStatus(): GraphStatus {
    return computeGraphStatus();
  }

  function isTerminal(): boolean {
    return computeIsTerminal();
  }

  function getExecutionOrder(): string[] {
    return [...validated.executionOrder];
  }

  function snapshot(): GraphExecutionSnapshot {
    // Clone all node states to prevent external mutation
    const clonedNodes = new Map<string, NodeExecutionState>();
    for (const [id, state] of nodeStates) {
      clonedNodes.set(id, { ...state });
    }
    return {
      graphStatus: computeGraphStatus(),
      nodes: clonedNodes,
      executionOrder: [...validated.executionOrder],
      isTerminal: computeIsTerminal(),
    };
  }

  function cancel(): string[] {
    const cancelled: string[] = [];
    for (const state of nodeStates.values()) {
      if (state.status === "pending" || state.status === "ready") {
        state.status = "skipped";
        state.completedAt = Date.now();
        cancelled.push(state.nodeId);
      }
    }
    return cancelled;
  }

  return {
    markNodeRunning,
    markNodeCompleted,
    markNodeFailed,
    getNodeState,
    getReadyNodes,
    getGraphStatus,
    isTerminal,
    getExecutionOrder,
    snapshot,
    cancel,
  };
}
