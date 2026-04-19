/**
 * Node lifecycle management for graph coordinator.
 * Handles spawning nodes (regular and driver-typed), ready-node iteration
 * with cache-prefix stagger, node failure with retry/skip/cascade semantics,
 * and sub-agent completion processing.
 * @module
 */

import {
  type GraphNode,
  type NodeTypeDriver,
  type NodeDriverContext,
  safePath,
} from "@comis/core";
import { tryCatch } from "@comis/shared";
import { sanitizeAssistantResponse } from "@comis/agent";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { interpolateTaskText, buildContextEnvelope } from "./template-interpolation.js";
import { gatedSpawn } from "./graph-concurrency.js";
import type {
  CoordinatorSharedState,
  GraphCoordinatorDeps,
  GraphRunState,
  CoordinatorConfig,
} from "./graph-coordinator-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect degenerate output: a short response that merely references a file
 * the agent wrote to sharedDir. Replace with the file's actual content.
 * Best-effort -- returns original output on any failure.
 */
export function resolveFileReferenceOutput(output: string, sharedDir: string): string {
  if (output.length >= 200) return output;
  const fileRef = output.match(/[\w-]+\.md/);
  if (!fileRef) return output;
  // Skip the auto-persisted nodeId-output.md files (those are written BY the coordinator)
  if (fileRef[0].endsWith("-output.md")) return output;
  try {
    const candidatePath = join(sharedDir, fileRef[0]);
    if (!existsSync(candidatePath)) return output;
    const fileContent = readFileSync(candidatePath, "utf8");
    return fileContent.length > output.length ? fileContent : output;
  } catch {
    return output;
  }
}

/**
 * Exponential retry backoff: 1s, 2s, 4s, 8s, ... capped at 30s.
 */
export function computeRetryBackoff(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
}

/**
 * Detect whether a killed sub-agent produced meaningful output before death.
 * Checks two conditions (either is sufficient):
 * 1. Captured output is substantial (>500 chars) -- the agent wrote a response
 * 2. Files matching the nodeId prefix exist in sharedDir (excluding the
 *    auto-persisted {nodeId}-output.md which is written by the coordinator,
 *    not the sub-agent)
 * Returns false on any filesystem error to avoid breaking graph execution.
 * @param nodeId - The graph node identifier to check
 * @param sharedDir - Path to the graph run's shared directory
 * @param capturedOutput - The sub-agent's captured response text (if any)
 * @returns true if meaningful output was detected
 */
export function detectPartialCompletion(
  nodeId: string,
  sharedDir: string,
  capturedOutput: string | undefined,
): boolean {
  // Condition 1: substantial captured output
  if (capturedOutput !== undefined && capturedOutput.length > 500) {
    return true;
  }

  // Condition 2: nodeId-prefixed files in sharedDir (excluding coordinator file)
  try {
    if (!existsSync(sharedDir)) return false;
    const files = readdirSync(sharedDir);
    const coordinatorFile = `${nodeId}-output.md`;
    for (const file of files) {
      if (typeof file !== "string") continue;
      if (!file.startsWith(nodeId)) continue;
      if (file === coordinatorFile) continue;
      // Found a nodeId-prefixed file that isn't the coordinator's auto-persist
      return true;
    }
  } catch {
    // Filesystem errors should not break graph execution
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Node failure handling
// ---------------------------------------------------------------------------

/**
 * Mark a node as failed and handle retrying, skip cascade, and newly-ready
 * nodes. Preserves the exact fatal vs retryable error semantics from the
 * original monolithic coordinator.
 * CRITICAL: The branching logic based on GraphStateMachine.markNodeFailed()
 * return value must be preserved exactly:
 * - result.value.retrying === true: schedule retry with backoff timer
 * - result.value.skipped array: log skipped dependent nodes
 * - result.value.newlyReady array: spawn newly-unblocked nodes
 * - Fatal error path: mark dependents as skipped, check for graph completion
 */
export function markNodeFailed(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "eventBus" | "logger">,
  gs: GraphRunState,
  nodeId: string,
  error: string,
  callbacks: {
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphCompletion: (gs: GraphRunState) => void;
  },
): void {
  const result = gs.stateMachine.markNodeFailed(nodeId, error);
  deps.eventBus.emit("graph:node_updated", {
    graphId: gs.graphId,
    nodeId,
    status: "failed" as const,
    error,
    timestamp: Date.now(),
  });
  deps.logger?.debug(
    { graphId: gs.graphId, nodeId, error },
    "Node failed",
  );

  // Handle retrying nodes
  if (result.ok && result.value.retrying.length > 0) {
    for (const retryNodeId of result.value.retrying) {
      const retryNodeState = gs.stateMachine.getNodeState(retryNodeId);
      const attempt = retryNodeState?.retryAttempt ?? 1;
      const backoffMs = computeRetryBackoff(attempt);
      deps.eventBus.emit("graph:node_updated", {
        graphId: gs.graphId,
        nodeId: retryNodeId,
        status: "ready" as const,
        timestamp: Date.now(),
      });
      const retryTimer = setTimeout(() => {
        if (gs.stateMachine.isTerminal()) return;
        const currentState = gs.stateMachine.getNodeState(retryNodeId);
        if (!currentState || currentState.status !== "ready") return;
        gs.retryTimers.delete(retryNodeId);
        callbacks.spawnReadyNodes(gs);
      }, backoffMs);
      if (typeof retryTimer === "object" && "unref" in retryTimer) {
        retryTimer.unref();
      }
      gs.retryTimers.set(retryNodeId, retryTimer);
    }
  } else if (result.ok) {
    for (const skippedId of result.value.skipped) {
      if (!gs.skippedNodesEmitted.has(skippedId)) {
        gs.skippedNodesEmitted.add(skippedId);
        deps.eventBus.emit("graph:node_updated", {
          graphId: gs.graphId,
          nodeId: skippedId,
          status: "skipped" as const,
          timestamp: Date.now(),
        });
      }
    }
    if (result.value.newlyReady.length > 0) {
      queueMicrotask(() => callbacks.spawnReadyNodes(gs));
    }
  }

  if (gs.stateMachine.isTerminal()) {
    callbacks.handleGraphCompletion(gs);
  }
}

// ---------------------------------------------------------------------------
// Node spawning
// ---------------------------------------------------------------------------

/**
 * Spawn a single graph node. Routes to driver-based execution for typed
 * nodes, or regular sub-agent spawn for standard nodes.
 */
export function spawnNode(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "defaultAgentId" | "nodeTypeRegistry">,
  config: Pick<CoordinatorConfig, "maxResultLength" | "maxGlobalSubAgents">,
  gs: GraphRunState,
  nodeId: string,
  callbacks: {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => void;
    startDriverNode: (gs: GraphRunState, nodeId: string, node: GraphNode, driver: NodeTypeDriver, envelopedTask: string) => void;
    spawnReadyNodes: (gs: GraphRunState) => void;
  },
): void {
  // Find the node definition
  const node = gs.graph.graph.nodes.find((n) => n.nodeId === nodeId);
  if (!node) {
    deps.logger?.error({ graphId: gs.graphId, nodeId, hint: "Graph node ID mismatch; check graph definition", errorKind: "internal" }, "Graph node definition not found");
    return;
  }

  // Interpolate task text with upstream outputs (dependsOn-based templates)
  const interpolatedTask = interpolateTaskText(
    node.task,
    node.dependsOn,
    gs.nodeOutputs,
    config.maxResultLength,
    gs.sharedDir,
    node.contextMode,
  );

  // Compute which upstream deps failed/were skipped for degradation notice
  const failedUpstream: string[] = [];
  const skippedUpstream: string[] = [];
  for (const depId of node.dependsOn) {
    const depState = gs.stateMachine.getNodeState(depId);
    if (depState?.status === "failed") failedUpstream.push(depId);
    else if (depState?.status === "skipped") skippedUpstream.push(depId);
  }

  // Wrap with context envelope (auto-inject graph context + upstream outputs)
  const envelopedTask = buildContextEnvelope({
    graphLabel: gs.graph.graph.label,
    nodeId,
    task: interpolatedTask,
    originalTask: node.task,
    dependsOn: node.dependsOn,
    nodeOutputs: gs.nodeOutputs,
    totalNodeCount: gs.graph.graph.nodes.length,
    maxResultLength: config.maxResultLength,
    sharedDir: gs.sharedDir,
    contextMode: node.contextMode,
    failedUpstream,
    skippedUpstream,
  });

  // Resolve mcpServers to discovered tool names from graph tool superset
  let nodeDiscoveredTools: string[] | undefined;
  const nodeMcpServers = node.mcpServers ?? [];
  if (nodeMcpServers.length > 0 && gs.graphToolNames) {
    const prefixes = nodeMcpServers.map(s => `mcp__${s}--`);
    nodeDiscoveredTools = gs.graphToolNames.filter(t =>
      prefixes.some(p => t.startsWith(p))
    );
    if (nodeDiscoveredTools.length > 0) {
      deps.logger?.debug(
        { graphId: gs.graphId, nodeId, mcpServers: nodeMcpServers, preSeeded: nodeDiscoveredTools.length },
        "Pre-seeding MCP tool discoveries for graph node",
      );
    }
  }

  // Driver dispatch: route typed nodes to driver-based execution
  const registry = deps.nodeTypeRegistry;
  if (node.typeId) {
    if (!registry) {
      callbacks.markNodeFailed(gs, nodeId, "Node has typeId but no nodeTypeRegistry configured");
      return;
    }
    const driver = registry.get(node.typeId);
    if (!driver) {
      callbacks.markNodeFailed(gs, nodeId, `Unknown node type: ${node.typeId}`);
      return;
    }
    callbacks.startDriverNode(gs, nodeId, node, driver, envelopedTask);
    return;
  }

  // On retry spawn, reuse the aborted attempt's sessionKey so Anthropic cache
  // can amortize across the failure boundary (priorSessionKey is set by
  // graph-state-machine markNodeFailed on retry-eligible failures).
  const nodeStateForRetry = gs.stateMachine.getNodeState(nodeId);
  const reuseSessionKeyOnRetry = nodeStateForRetry?.priorSessionKey;

  // Regular node spawn wrapped in gatedSpawn for global concurrency
  gatedSpawn(state, deps, config, gs, nodeId, () => {
    const runId = deps.subAgentRunner.spawn({
      task: envelopedTask,
      agentId: node.agentId ?? deps.defaultAgentId,
      model: node.model,
      max_steps: node.maxSteps,
      callerSessionKey: gs.callerSessionKey,
      callerAgentId: gs.callerAgentId,
      callerType: "graph",
      graphSharedDir: gs.sharedDir,
      graphTraceId: gs.graphTraceId,
      graphId: gs.graphId,
      nodeId,
      // Root nodes (dependsOn=[]) = 0, downstream nodes = 1+.
      // Used for depth-aware cache retention in setup-cross-session.
      graphNodeDepth: node.dependsOn.length === 0 ? 0 : 1,
      // Leaf: no other graph node depends on this one. Leaf nodes write
      // 5m cache instead of 1h because their prefix has no consumers —
      // see resolveGraphCacheRetention() for rationale.
      isLeafNode: !gs.graph.graph.nodes.some((n) => n.dependsOn.includes(nodeId)),
      ...(reuseSessionKeyOnRetry ? { reuseSessionKey: reuseSessionKeyOnRetry } : {}),
      ...(nodeDiscoveredTools && nodeDiscoveredTools.length > 0 && { discoveredDeferredTools: nodeDiscoveredTools }),
    });

    gs.runIdToNode.set(runId, nodeId);

    const runResult = gs.stateMachine.markNodeRunning(nodeId, runId);
    if (!runResult.ok) {
      deps.logger?.warn(
        { graphId: gs.graphId, nodeId, error: runResult.error, hint: "Node may have been concurrently updated", errorKind: "internal" },
        "Graph node state transition to running failed",
      );
    } else {
      deps.eventBus.emit("graph:node_updated", {
        graphId: gs.graphId,
        nodeId,
        status: "running" as const,
        timestamp: Date.now(),
      });
    }

    gs.runningCount++;

    if (node.timeoutMs !== undefined && node.timeoutMs > 0) {
      const timer = setTimeout(() => {
        const nodeState = gs.stateMachine.getNodeState(nodeId);
        if (nodeState && nodeState.status === "running") {
          deps.subAgentRunner.killRun(runId);
        }
      }, node.timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      gs.nodeTimers.set(nodeId, timer);
    }

    deps.logger?.debug(
      { graphId: gs.graphId, nodeId, runId },
      "Graph node spawned",
    );
  });
}

/**
 * Iterate ready nodes and spawn them. Uses event-driven spawn gate
 * instead of fixed setTimeout stagger. First node spawns immediately; remaining
 * nodes wait for cache:graph_prefix_written signal or timeout fallback.
 */
export function spawnReadyNodes(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "logger" | "subAgentRunner" | "eventBus" | "defaultAgentId" | "nodeTypeRegistry">,
  config: Pick<CoordinatorConfig, "maxConcurrency" | "maxResultLength" | "maxGlobalSubAgents" | "spawnStaggerMs" | "cacheWriteTimeoutMs">,
  gs: GraphRunState,
  callbacks: {
    spawnNode: (gs: GraphRunState, nodeId: string) => void;
  },
): void {
  const readyNodes = gs.stateMachine.getReadyNodes();
  const SPAWN_STAGGER_MS = config.spawnStaggerMs;

  // Collect spawnable nodes (respecting concurrency and ghost spawn guards)
  const toSpawn: string[] = [];
  for (const nodeId of readyNodes) {
    if (gs.runningCount + toSpawn.length >= config.maxConcurrency) break;
    // Ghost spawn guard: skip nodes that already have a pending gatedSpawn entry
    if (state.spawnQueue.some((e) => e.graphId === gs.graphId && e.nodeId === nodeId)) {
      continue;
    }
    toSpawn.push(nodeId);
  }

  if (toSpawn.length === 0) return;

  // Single node or stagger disabled: spawn all immediately
  if (toSpawn.length <= 1 || SPAWN_STAGGER_MS <= 0) {
    for (const nodeId of toSpawn) {
      callbacks.spawnNode(gs, nodeId);
    }
    return;
  }

  // If pre-warm succeeded, cache is already seeded -- no stagger needed.
  // All nodes can share the warm cache prefix immediately.
  if (gs.cachePrewarmed) {
    for (const nodeId of toSpawn) {
      callbacks.spawnNode(gs, nodeId);
    }
    deps.logger?.debug(
      { graphId: gs.graphId, nodeCount: toSpawn.length },
      "Pre-warmed graph, spawning all nodes immediately",
    );
    return;
  }

  // Event-driven spawn gate for remaining nodes.
  // First node spawns immediately, subsequent nodes staggered to share cache prefix.
  // (Previous TOOL_HEAVY_THRESHOLD bypass removed -- it incorrectly skipped stagger
  // for prompt-tool-heavy graphs where stagger still saves cold writes.)
  for (let i = 0; i < toSpawn.length; i++) {
    const nodeId = toSpawn[i]!;
    if (i === 0) {
      callbacks.spawnNode(gs, nodeId);
    } else {
      const delayMs = i * SPAWN_STAGGER_MS;
      const capturedNodeId = nodeId;
      const capturedGs = gs;
      deps.logger?.debug(
        { graphId: gs.graphId, nodeId: capturedNodeId, delayMs, staggerIndex: i },
        "Sub-agent spawn staggered for cache prefix sharing",
      );
      setTimeout(() => {
        // Guard against graph completion during stagger delay
        if (capturedGs.completedAt !== undefined) return;
        // Guard against node already running or completed
        const nodeState = capturedGs.stateMachine.getNodeState(capturedNodeId);
        if (!nodeState || nodeState.status !== "ready") return;
        callbacks.spawnNode(capturedGs, capturedNodeId);
      }, delayMs);
    }
  }
}

/**
 * Initialize and start a driver-typed node. Validates typeConfig, creates
 * driver context, transitions to running state, and executes the initial
 * driver action.
 */
export function startDriverNode(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "eventBus" | "logger" | "defaultAgentId">,
  gs: GraphRunState,
  nodeId: string,
  node: GraphNode,
  driver: NodeTypeDriver,
  envelopedTask: string,
  callbacks: {
    markNodeFailed: (gs: GraphRunState, nodeId: string, error: string) => void;
    executeDriverAction: (gs: GraphRunState, nodeId: string, action: import("@comis/core").NodeDriverAction) => void;
    handleDriverTimeout: (gs: GraphRunState, nodeId: string) => void;
  },
): void {
  // 1. Validate typeConfig against driver's configSchema
  const configResult = driver.configSchema.safeParse(node.typeConfig ?? {});
  if (!configResult.success) {
    const errorMsg = `Invalid typeConfig for ${driver.typeId}: ${configResult.error.message}`;
    deps.logger?.warn(
      { graphId: gs.graphId, nodeId, typeId: driver.typeId, hint: "typeConfig validation failed", errorKind: "validation" },
      errorMsg,
    );
    callbacks.markNodeFailed(gs, nodeId, errorMsg);
    return;
  }

  // 2. Create closure-based driver state
  let driverState: unknown = undefined;
  const ctx: NodeDriverContext = {
    nodeId,
    task: envelopedTask,
    typeConfig: configResult.data as Record<string, unknown>,
    sharedDir: gs.sharedDir,
    graphLabel: gs.graph.graph.label,
    defaultAgentId: deps.defaultAgentId,
    typeName: driver.typeId,
    getState: <T = unknown>() => driverState as T | undefined,
    setState: <T = unknown>(s: T) => { driverState = s; },
  };

  // 3. Store driver state entry
  gs.driverStates.set(nodeId, {
    driver,
    ctx,
    currentRunId: undefined,
    pendingParallel: undefined,
    parallelCompleted: undefined,
  });

  // 4. Transition node to running
  const runResult = gs.stateMachine.markNodeRunning(nodeId, `driver:${nodeId}`);
  if (!runResult.ok) {
    deps.logger?.warn(
      { graphId: gs.graphId, nodeId, error: runResult.error, hint: "Driver node state transition to running failed", errorKind: "internal" },
      "Driver node state transition to running failed",
    );
  } else {
    deps.eventBus.emit("graph:node_updated", {
      graphId: gs.graphId,
      nodeId,
      status: "running" as const,
      timestamp: Date.now(),
    });
  }

  gs.runningCount++;

  // 5. Emit driver lifecycle: initialized
  deps.eventBus.emit("graph:driver_lifecycle", {
    graphId: gs.graphId,
    nodeId,
    typeId: driver.typeId,
    phase: "initialized",
  });

  // 6. Set up per-node timeout using driver estimate or node config
  const timeoutMs = node.timeoutMs ?? driver.defaultTimeoutMs;
  if (timeoutMs > 0) {
    const timer = setTimeout(() => {
      callbacks.handleDriverTimeout(gs, nodeId);
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
    gs.nodeTimers.set(nodeId, timer);
  }

  // 7. Runtime enforcement of onParallelTurnComplete
  const action = driver.initialize(ctx);
  if (action.action === "spawn_all" && !driver.onParallelTurnComplete) {
    callbacks.markNodeFailed(gs, nodeId, `Driver ${driver.typeId} returned spawn_all but does not implement onParallelTurnComplete`);
    return;
  }

  // 8. Execute the returned action
  callbacks.executeDriverAction(gs, nodeId, action);

  deps.logger?.debug(
    { graphId: gs.graphId, nodeId, typeId: driver.typeId },
    "Driver node started",
  );
}

/**
 * Handle regular (non-driver) sub-agent completion.
 */
export function handleSubAgentCompleted(
  state: CoordinatorSharedState,
  deps: Pick<GraphCoordinatorDeps, "subAgentRunner" | "eventBus" | "logger" | "sendToChannel" | "touchParentSession">,
  config: Pick<CoordinatorConfig, "maxResultLength">,
  gs: GraphRunState,
  event: { runId: string; success: boolean; tokensUsed?: number; cost?: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  callbacks: {
    spawnReadyNodes: (gs: GraphRunState) => void;
    handleGraphCompletion: (gs: GraphRunState) => void;
    handleBudgetExceeded: (gs: GraphRunState, reason: string) => void;
  },
): void {
  // Keep parent session lane alive during graph execution
  if (gs.callerSessionKey) {
    deps.touchParentSession?.(gs.callerSessionKey);
  }

  // 1. Look up nodeId from runIdToNode
  const nodeId = gs.runIdToNode.get(event.runId);
  if (!nodeId) return;

  // 2. Remove from runIdToNode
  gs.runIdToNode.delete(event.runId);

  // 3. Decrement running count
  gs.runningCount--;

  // 4. Clear per-node timer if exists
  const timer = gs.nodeTimers.get(nodeId);
  if (timer !== undefined) {
    clearTimeout(timer);
    gs.nodeTimers.delete(nodeId);
  }

  // 4b. Capture per-node cache data
  const cacheRead = event.cacheReadTokens ?? 0;
  const cacheWrite = event.cacheWriteTokens ?? 0;
  if (cacheRead > 0 || cacheWrite > 0) {
    gs.nodeCacheData.set(nodeId, { cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
  }

  // 5. Capture result immediately (capture before sweep)
  const run = deps.subAgentRunner.getRunStatus(event.runId);
  let output = run?.result?.response;

  // 5a. Resolve degenerate file-reference outputs
  if (gs.sharedDir && output) {
    output = resolveFileReferenceOutput(output, gs.sharedDir);
  }

  // 5b. Strip reasoning tags (<think>, <final>, etc.) before storing/injecting
  if (output) {
    output = sanitizeAssistantResponse(output);
  }

  gs.nodeOutputs.set(nodeId, output);

  // 5c. Auto-persist full output to shared folder for file-reference overflow
  if (gs.sharedDir && output) {
    try {
      writeFileSync(join(gs.sharedDir, `${nodeId}-output.md`), output, "utf8");
    } catch { /* best-effort, don't block graph progress */ }
  }

  // 6. Synchronous state machine update
  if (event.success) {
    const result = gs.stateMachine.markNodeCompleted(nodeId, output);
    if (!result.ok) {
      deps.logger?.warn(
        { graphId: gs.graphId, nodeId, error: result.error, hint: "Node may have been concurrently updated; harmless if graph reaches terminal state", errorKind: "internal" },
        "Graph node state transition to completed failed",
      );
    }
  } else if (detectPartialCompletion(nodeId, gs.sharedDir, output)) {
    // Partial completion recovery: sub-agent was killed but wrote output before death
    deps.logger?.info(
      { graphId: gs.graphId, nodeId, hint: "Sub-agent killed but partial output detected, treating as completed", errorKind: "internal" as const },
      "Graph node partial completion recovered",
    );
    const result = gs.stateMachine.markNodeCompleted(nodeId, output);
    if (!result.ok) {
      deps.logger?.warn(
        { graphId: gs.graphId, nodeId, error: result.error, hint: "Node may have been concurrently updated", errorKind: "internal" as const },
        "Graph node state transition to completed (partial) failed",
      );
    }
  } else {
    // Original failure path -- no partial completion detected
    const errorText = run?.error ?? "Unknown error";
    // Pass the failed run's sessionKey so retry spawns can reuse it
    // (see resolveGraphCacheRetention / reuseSessionKey — lets Anthropic cache
    // amortize across a retry instead of cold-starting on every attempt).
    const result = gs.stateMachine.markNodeFailed(nodeId, errorText, run?.sessionKey);
    if (!result.ok) {
      deps.logger?.warn(
        { graphId: gs.graphId, nodeId, error: result.error, hint: "Node may have been concurrently updated; harmless if graph reaches terminal state", errorKind: "internal" },
        "Graph node state transition to failed failed",
      );
    }

    // Handle retrying nodes -- schedule re-spawn with exponential backoff
    if (result.ok && result.value.retrying.length > 0) {
      for (const retryNodeId of result.value.retrying) {
        const retryNodeState = gs.stateMachine.getNodeState(retryNodeId);
        const attempt = retryNodeState?.retryAttempt ?? 1;
        const backoffMs = computeRetryBackoff(attempt);

        deps.logger?.debug(
          { graphId: gs.graphId, nodeId: retryNodeId, attempt, backoffMs },
          "Graph node scheduled for retry",
        );

        deps.eventBus.emit("graph:node_updated", {
          graphId: gs.graphId,
          nodeId: retryNodeId,
          status: "ready" as const,
          timestamp: Date.now(),
        });

        const retryTimer = setTimeout(() => {
          if (gs.stateMachine.isTerminal()) return;
          const currentState = gs.stateMachine.getNodeState(retryNodeId);
          if (!currentState || currentState.status !== "ready") return;
          gs.retryTimers.delete(retryNodeId);
          callbacks.spawnReadyNodes(gs);
        }, backoffMs);

        if (typeof retryTimer === "object" && "unref" in retryTimer) {
          retryTimer.unref();
        }

        gs.retryTimers.set(retryNodeId, retryTimer);
      }
    } else if (result.ok) {
      for (const skippedId of result.value.skipped) {
        if (!gs.skippedNodesEmitted.has(skippedId)) {
          gs.skippedNodesEmitted.add(skippedId);
          deps.eventBus.emit("graph:node_updated", {
            graphId: gs.graphId,
            nodeId: skippedId,
            status: "skipped" as const,
            timestamp: Date.now(),
          });
        }
      }
      if (result.value.newlyReady.length > 0) {
        queueMicrotask(() => callbacks.spawnReadyNodes(gs));
      }
    }
  }

  // 6.5. Budget accumulation
  gs.cumulativeTokens += event.tokensUsed ?? 0;
  gs.cumulativeCost += event.cost ?? 0;

  // 6.6. Budget check (BEFORE terminal check)
  const budget = gs.graph.graph.budget;
  if (budget && !gs.stateMachine.isTerminal()) {
    const tokenExceeded = budget.maxTokens !== undefined && gs.cumulativeTokens > budget.maxTokens;
    const costExceeded = budget.maxCost !== undefined && gs.cumulativeCost > budget.maxCost;
    if (tokenExceeded || costExceeded) {
      callbacks.handleBudgetExceeded(gs, tokenExceeded ? "tokens" : "cost");
      return;
    }
  }

  // 7. Emit graph:node_updated for completed/failed node
  // Use actual state machine status (not event.success) to reflect partial completion recovery
  const finalNodeState = gs.stateMachine.getNodeState(nodeId);
  const nodeCompleted = finalNodeState?.status === "completed";
  if (nodeCompleted || !finalNodeState || finalNodeState.status !== "ready") {
    deps.eventBus.emit("graph:node_updated", {
      graphId: gs.graphId,
      nodeId,
      status: nodeCompleted ? "completed" as const : "failed" as const,
      durationMs: finalNodeState?.startedAt ? Date.now() - finalNodeState.startedAt : undefined,
      error: nodeCompleted ? undefined : (run?.error ?? "Unknown error"),
      timestamp: Date.now(),
    });
  }

  // 8. Log at DEBUG level
  deps.logger?.debug(
    { graphId: gs.graphId, nodeId, success: nodeCompleted },
    nodeCompleted ? "Graph node completed" : "Graph node failed",
  );

  // 8.5. Deliver node-completion progress to channel
  if (gs.nodeProgress && gs.announceChannelType && gs.announceChannelId && !gs.stateMachine.isTerminal()) {
    const snap = gs.stateMachine.snapshot();
    let done = 0;
    for (const [, ns] of snap.nodes) {
      if (ns.status === "completed" || ns.status === "failed" || ns.status === "skipped") done++;
    }
    const total = gs.graph.graph.nodes.length;
    const label = gs.graph.graph.label;
    const status = nodeCompleted ? `\u2705 ${nodeId}` : `\u274C ${nodeId}`;
    const progressText = `${status} — ${done}/${total} nodes${label ? ` (${label})` : ""}`;
    deps.sendToChannel(gs.announceChannelType, gs.announceChannelId, progressText).catch((sendErr: unknown) => {
      deps.logger?.debug(
        { graphId: gs.graphId, nodeId, err: sendErr },
        "Node progress delivery failed",
      );
    });
  }

  // 9. Check terminal
  if (gs.stateMachine.isTerminal()) {
    callbacks.handleGraphCompletion(gs);
    return;
  }

  // 10. Spawn newly ready nodes (defer to prevent re-entrancy)
  queueMicrotask(() => callbacks.spawnReadyNodes(gs));
}

/**
 * Persist node artifacts to the shared directory.
 */
export function persistArtifacts(
  deps: Pick<GraphCoordinatorDeps, "logger">,
  gs: GraphRunState,
  nodeId: string,
  artifacts?: Array<{ filename: string; content: string }>,
): void {
  if (!artifacts) return;
  for (const a of artifacts) {
    const safeResult = tryCatch(() => safePath(gs.sharedDir, a.filename));
    if (!safeResult.ok) {
      deps.logger?.warn(
        { graphId: gs.graphId, nodeId, filename: a.filename, hint: "Artifact filename rejected by safePath", errorKind: "security" },
        "Artifact filename rejected",
      );
      continue;
    }
    writeFileSync(safeResult.value, a.content, "utf8");
  }
}
