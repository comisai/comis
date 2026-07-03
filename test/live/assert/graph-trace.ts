// SPDX-License-Identifier: Apache-2.0
/**
 * Graph-trace asserter — typed helpers for the ORCH test suite.
 *
 * Provides structural asserters over captured EventBus event arrays for the
 * real graph lifecycle events emitted by events-agent.ts:
 *
 *   graph:node_updated  — node status transitions (running/completed/failed/skipped)
 *   graph:started       — graph execution begins
 *   graph:completed     — graph execution finishes (completed/failed/cancelled)
 *
 * Key asserters:
 *
 *   assertDependencyOrder — verifies topological execution order of nodes
 *   assertConcurrencyCapHolds — verifies max parallel nodes never exceeds the cap
 *   assertFailureCascade — verifies downstream nodes are skipped/failed after upstream failure
 *   assertGraphCompleted — verifies graph:completed event exists and returns its payload
 *
 * All asserters take Array<{name: string; payload: unknown}> — the same shape
 * as conversation.ts capturedEvents(). Defensive null/undefined checks prevent
 * asserter crashes on unexpected payload shapes (T-141-01-C mitigation).
 *
 * Mirrors the structure and error-message style of test/live/assert/cache-trace.ts.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** NodeStatus values as declared in events-agent.ts */
type NodeStatus = "running" | "completed" | "failed" | "skipped";

/** graph:node_updated payload shape (events-agent.ts lines 383-392) */
interface NodeUpdatedPayload {
  graphId: string;
  nodeId: string;
  status: NodeStatus;
  previousStatus?: NodeStatus;
  durationMs?: number;
  error?: string;
  timestamp: number;
}

/** graph:completed payload shape (events-agent.ts lines 394-411) */
interface GraphCompletedPayload {
  graphId: string;
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  nodeCount: number;
  nodesCompleted: number;
  nodesFailed: number;
  nodesSkipped: number;
  cancelReason?: "timeout" | "budget" | "manual";
  timestamp: number;
  graphCacheReadTokens?: number;
  graphCacheWriteTokens?: number;
  graphCacheEffectiveness?: number;
  nodeEffectiveness?: Record<string, number>;
}

/** Captured event from the EventBus. */
type CapturedEvent = { name: string; payload: unknown };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Safely cast an event payload to NodeUpdatedPayload.
 * Returns null when the payload is missing required fields
 * (T-141-01-C: defensive check before field traversal).
 */
function asNodeUpdatedPayload(payload: unknown): NodeUpdatedPayload | null {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (
    typeof p["graphId"] !== "string" ||
    typeof p["nodeId"] !== "string" ||
    typeof p["status"] !== "string" ||
    typeof p["timestamp"] !== "number"
  ) {
    return null;
  }
  return p as unknown as NodeUpdatedPayload;
}

/**
 * Safely cast an event payload to GraphCompletedPayload.
 * Returns null when required fields are missing.
 */
function asGraphCompletedPayload(payload: unknown): GraphCompletedPayload | null {
  if (payload === null || payload === undefined || typeof payload !== "object") {
    return null;
  }
  const p = payload as Record<string, unknown>;
  if (typeof p["graphId"] !== "string" || typeof p["status"] !== "string") {
    return null;
  }
  return p as unknown as GraphCompletedPayload;
}

/**
 * Extract graph:node_updated events sorted by timestamp ascending.
 */
function nodeUpdatedEvents(events: CapturedEvent[]): NodeUpdatedPayload[] {
  const result: NodeUpdatedPayload[] = [];
  for (const e of events) {
    if (e.name !== "graph:node_updated") continue;
    const p = asNodeUpdatedPayload(e.payload);
    if (p !== null) result.push(p);
  }
  result.sort((a, b) => a.timestamp - b.timestamp);
  return result;
}

// ---------------------------------------------------------------------------
// Asserter: assertDependencyOrder
// ---------------------------------------------------------------------------

/**
 * Assert that nodes started in the topological order declared by orderedNodeIds.
 *
 * Filters graph:node_updated events with status==="running" and builds a
 * startOrder array. For each consecutive pair in orderedNodeIds, verifies
 * that pair[0] appears before pair[1] in startOrder.
 *
 * @param events         - Array of captured EventBus events ({name, payload}).
 * @param orderedNodeIds - Expected topological order (e.g. ["A", "B", "C"]).
 * @param graphId        - Optional graphId to scope events; when provided, only
 *                         events where payload.graphId === graphId are considered.
 *                         When omitted, all graph:node_updated events are used.
 *                         Prevents cross-graph pollution in multi-graph scenarios.
 * @throws Error when any node starts before its declared predecessor.
 */
export function assertDependencyOrder(
  events: CapturedEvent[],
  orderedNodeIds: string[],
  graphId?: string,
): void {
  const runningEvents = nodeUpdatedEvents(events).filter(
    (p) => p.status === "running" && (graphId === undefined || p.graphId === graphId),
  );

  const startOrder = runningEvents.map((p) => p.nodeId);

  for (let i = 0; i < orderedNodeIds.length - 1; i++) {
    const predecessor = orderedNodeIds[i]!;
    const successor = orderedNodeIds[i + 1]!;

    const predecessorIdx = startOrder.indexOf(predecessor);
    const successorIdx = startOrder.indexOf(successor);

    if (predecessorIdx === -1 && successorIdx === -1) {
      // Neither node ran — skip pair (not a violation)
      continue;
    }

    if (predecessorIdx === -1) {
      throw new Error(
        `assertDependencyOrder: predecessor "${predecessor}" never started — ` +
          `expected it to start before "${successor}"; ` +
          `actual startOrder=${JSON.stringify(startOrder)}.`,
      );
    }

    if (successorIdx === -1) {
      // Successor never started — not a violation of order
      continue;
    }

    if (predecessorIdx >= successorIdx) {
      throw new Error(
        `assertDependencyOrder: "${successor}" started before its dependency "${predecessor}" — ` +
          `expected startOrder index of "${predecessor}" (${predecessorIdx}) < "${successor}" (${successorIdx}); ` +
          `actual startOrder=${JSON.stringify(startOrder)}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Asserter: assertConcurrencyCapHolds
// ---------------------------------------------------------------------------

/**
 * Assert that the number of simultaneously running nodes never exceeds cap.
 *
 * Walks graph:node_updated events in timestamp order, tracking an active set.
 * Adds nodeId when status==="running", removes on completed/failed/skipped.
 * After each event, checks activeSet.size against cap.
 *
 * @param events  - Array of captured EventBus events ({name, payload}).
 * @param cap     - Maximum allowed simultaneous running nodes.
 * @param graphId - Optional graphId to scope events; when provided, only
 *                  events where payload.graphId === graphId are considered.
 *                  When omitted, all graph:node_updated events are used.
 *                  Prevents cross-graph pollution in multi-graph scenarios.
 * @throws Error when activeSet.size exceeds cap after any event.
 */
export function assertConcurrencyCapHolds(
  events: CapturedEvent[],
  cap: number,
  graphId?: string,
): void {
  const updatedEvents = nodeUpdatedEvents(events).filter(
    (p) => graphId === undefined || p.graphId === graphId,
  );
  const activeSet = new Set<string>();

  for (const p of updatedEvents) {
    if (p.status === "running") {
      activeSet.add(p.nodeId);
    } else if (
      p.status === "completed" ||
      p.status === "failed" ||
      p.status === "skipped"
    ) {
      activeSet.delete(p.nodeId);
    }

    if (activeSet.size > cap) {
      throw new Error(
        `assertConcurrencyCapHolds: ${activeSet.size} nodes running simultaneously exceeds cap=${cap} — ` +
          `active nodes at violation: ${JSON.stringify([...activeSet])}; ` +
          `event that triggered: nodeId="${p.nodeId}" status="${p.status}".`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Asserter: assertFailureCascade
// ---------------------------------------------------------------------------

/**
 * Assert that after a node fails, all expected downstream nodes appear as
 * skipped or failed in the event stream.
 *
 * Verifies failedNodeId appears as "failed". Then for each expectedDownstreamSkipped
 * nodeId, verifies it appears as "skipped" or "failed". Throws a descriptive
 * Error listing any missing downstream nodes.
 *
 * @param events                  - Array of captured EventBus events ({name, payload}).
 * @param failedNodeId            - The node that should appear as "failed".
 * @param expectedDownstreamSkipped - Downstream nodes expected to appear as skipped/failed.
 * @throws Error when failedNodeId is not failed, or when any downstream node is absent.
 */
export function assertFailureCascade(
  events: CapturedEvent[],
  failedNodeId: string,
  expectedDownstreamSkipped: string[],
): void {
  const updatedEvents = nodeUpdatedEvents(events);

  // Verify the root failure
  const failedEvent = updatedEvents.find(
    (p) => p.nodeId === failedNodeId && p.status === "failed",
  );
  if (failedEvent === undefined) {
    throw new Error(
      `assertFailureCascade: node "${failedNodeId}" did not appear as "failed" in events — ` +
        `cannot verify cascade; expected a graph:node_updated with status="failed" for this node.`,
    );
  }

  // Verify each expected downstream appears as skipped or failed
  const missing: string[] = [];
  for (const downstreamId of expectedDownstreamSkipped) {
    const downstreamEvent = updatedEvents.find(
      (p) =>
        p.nodeId === downstreamId &&
        (p.status === "skipped" || p.status === "failed"),
    );
    if (downstreamEvent === undefined) {
      missing.push(downstreamId);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `assertFailureCascade: downstream nodes not found as skipped/failed after "${failedNodeId}" failed — ` +
        `missing nodes: ${JSON.stringify(missing)}; ` +
        `expected downstream: ${JSON.stringify(expectedDownstreamSkipped)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asserter: assertGraphCompleted
// ---------------------------------------------------------------------------

/**
 * Assert that a graph:completed event exists for graphId and return its payload.
 *
 * Finds the graph:completed event where payload.graphId === graphId.
 * Throws a descriptive Error if not found.
 *
 * @param events  - Array of captured EventBus events ({name, payload}).
 * @param graphId - The graph ID to look for in graph:completed events.
 * @returns The graph:completed payload.
 * @throws Error when no graph:completed event exists for the given graphId.
 */
export function assertGraphCompleted(
  events: CapturedEvent[],
  graphId: string,
): GraphCompletedPayload {
  for (const e of events) {
    if (e.name !== "graph:completed") continue;
    const p = asGraphCompletedPayload(e.payload);
    if (p !== null && p.graphId === graphId) {
      return p;
    }
  }

  throw new Error(
    `assertGraphCompleted: no graph:completed event found for graphId="${graphId}" — ` +
      `expected a graph:completed event with this graphId in ${events.length} events; ` +
      `actual event names: ${JSON.stringify([...new Set(events.map((e) => e.name))].sort())}.`,
  );
}
