import { ok, err, type Result } from "@comis/shared";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Node Status
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a single graph node.
 *
 * Transitions:
 *   pending -> ready -> running -> completed
 *                  \          \-> failed
 *                   \----------\-> skipped
 */
export const NodeStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
]);

export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// ---------------------------------------------------------------------------
// Graph Status
// ---------------------------------------------------------------------------

/**
 * Overall execution status of the graph.
 */
export const GraphStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type GraphStatus = z.infer<typeof GraphStatusSchema>;

// ---------------------------------------------------------------------------
// Node Type ID
// ---------------------------------------------------------------------------

/** Built-in node type identifiers for extensible graph execution. */
export const NodeTypeIdSchema = z.enum([
  "agent",
  "debate",
  "vote",
  "refine",
  "collaborate",
  "approval-gate",
  "map-reduce",
]);

export type NodeTypeId = z.infer<typeof NodeTypeIdSchema>;

// ---------------------------------------------------------------------------
// Graph Node
// ---------------------------------------------------------------------------

/**
 * A single node in an execution graph DAG.
 *
 * Each node represents a sub-agent task with optional dependency
 * constraints, per-node timeouts, optional per-node retry with
 * exponential backoff, barrier modes for fan-in nodes, and optional
 * context verbosity mode controlling upstream output injection.
 * When `typeId` and `typeConfig` are set, the node delegates to a
 * built-in driver instead of direct single-agent execution.
 * Upstream node outputs are referenced directly via
 * `{{nodeId.result}}` templates in task text, resolved from the
 * `dependsOn` array.
 */
export const GraphNodeSchema = z.strictObject({
  /** Unique identifier within the graph */
  nodeId: z.string().min(1),
  /** Task description for the sub-agent */
  task: z.string().min(1),
  /** Which agent executes this node (defaults to caller's agent) */
  agentId: z.string().min(1).optional(),
  /** Model override for this node */
  model: z.string().optional(),
  /** Node IDs that must complete before this node can run */
  dependsOn: z.array(z.string()).default([]),
  /** Per-node timeout in milliseconds. When omitted, typed nodes use driver.defaultTimeoutMs; regular nodes rely on maxSteps / graph-level timeout. */
  timeoutMs: z.number().int().positive().optional(),
  /** Maximum agentic steps for the sub-agent */
  maxSteps: z.number().int().positive().optional(),
  /** Barrier mode for fan-in nodes: all (default), majority (>50%), best-effort (any completed) */
  barrierMode: z.enum(["all", "majority", "best-effort"]).default("all"),
  /** Number of automatic retries on failure (0-3, default 1) */
  retries: z.number().int().min(0).max(3).default(1),
  /** Context verbosity mode: full (default), summary (500 chars + shared dir ref), refs (file path refs), none (skip upstream outputs) */
  contextMode: z.enum(["full", "summary", "refs", "none"]).default("full"),
  /** MCP server names whose tools should be pre-discovered for this node's sub-agent. Resolves against the graph tool superset at spawn time. */
  mcpServers: z.array(z.string()).default([]),
  /** Node type identifier -- if set, this node uses a built-in driver instead of direct agent execution */
  typeId: NodeTypeIdSchema.optional(),
  /** Type-specific configuration -- validated against the driver's configSchema at the RPC layer */
  typeConfig: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (n) => (n.typeId === undefined) === (n.typeConfig === undefined),
  "typeId and typeConfig must both be present or both absent. Omit both for a regular single-agent node.",
);

export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ---------------------------------------------------------------------------
// Node Execution State
// ---------------------------------------------------------------------------

/**
 * Runtime state of a single graph node during execution.
 *
 * Tracks lifecycle status, sub-agent run linkage, output/error text,
 * and timing information for observability.
 */
export const NodeExecutionStateSchema = z.strictObject({
  /** Node identifier (matches GraphNode.nodeId) */
  nodeId: z.string().min(1),
  /** Current lifecycle status */
  status: NodeStatusSchema,
  /** Sub-agent run ID, set when running */
  runId: z.string().optional(),
  /** Result text, set when completed */
  output: z.string().optional(),
  /** Error text, set when failed */
  error: z.string().optional(),
  /** Epoch ms when execution started */
  startedAt: z.number().optional(),
  /** Epoch ms when execution finished */
  completedAt: z.number().optional(),
  /** Current retry attempt number (0 = first run, 1 = first retry, etc.) */
  retryAttempt: z.number().int().nonnegative().optional(),
  /** Number of retries still available */
  retriesRemaining: z.number().int().nonnegative().optional(),
});

export type NodeExecutionState = z.infer<typeof NodeExecutionStateSchema>;

// ---------------------------------------------------------------------------
// Graph Budget
// ---------------------------------------------------------------------------

export const GraphBudgetSchema = z.strictObject({
  /** Maximum total tokens across all nodes */
  maxTokens: z.number().int().positive().optional(),
  /** Maximum total cost across all nodes */
  maxCost: z.number().positive().optional(),
});

export type GraphBudget = z.infer<typeof GraphBudgetSchema>;

// ---------------------------------------------------------------------------
// Execution Graph
// ---------------------------------------------------------------------------

/**
 * A DAG of sub-agent tasks with dependency constraints.
 *
 * The graph is validated at creation time: all node IDs must be unique,
 * all dependsOn references must point to existing nodes, and the graph
 * must be acyclic.
 */
export const ExecutionGraphSchema = z.strictObject({
  /** DAG nodes (1..20) */
  nodes: z.array(GraphNodeSchema).min(1).max(20),
  /** Human-readable graph label */
  label: z.string().optional(),
  /** Failure strategy: fail-fast stops on first failure, continue runs remaining */
  onFailure: z.enum(["fail-fast", "continue"]).default("fail-fast"),
  /** Graph-level timeout in milliseconds (default: 1 500 000 — 25 minutes) */
  timeoutMs: z.number().int().positive().default(1_500_000),
  /** Resource limits for the graph execution */
  budget: GraphBudgetSchema.optional(),
});

export type ExecutionGraph = z.infer<typeof ExecutionGraphSchema>;

// ---------------------------------------------------------------------------
// Validated Graph
// ---------------------------------------------------------------------------

/**
 * An execution graph that has passed DAG validation, paired with
 * its topologically sorted execution order.
 */
export interface ValidatedGraph {
  graph: ExecutionGraph;
  executionOrder: string[];
}

// ---------------------------------------------------------------------------
// Graph Validation Error
// ---------------------------------------------------------------------------

/**
 * Structured error for graph validation failures.
 *
 * Includes the kind of validation failure and the nodes involved,
 * enabling actionable error messages for the calling LLM.
 */
export class GraphValidationError extends Error {
  readonly kind: "cycle" | "missing_dependency" | "duplicate_node_id" | "self_dependency";
  readonly nodes: string[];

  constructor(
    kind: GraphValidationError["kind"],
    nodes: string[],
    message: string,
  ) {
    super(message);
    this.name = "GraphValidationError";
    this.kind = kind;
    this.nodes = nodes;
  }
}

// ---------------------------------------------------------------------------
// Parse Function
// ---------------------------------------------------------------------------

/**
 * Parse unknown input into an ExecutionGraph, returning Result<T, ZodError>.
 *
 * Does NOT perform DAG validation (cycle detection, dependency resolution).
 * Use {@link validateAndSortGraph} for full structural validation.
 */
export function parseExecutionGraph(raw: unknown): Result<ExecutionGraph, z.ZodError> {
  const result = ExecutionGraphSchema.safeParse(raw);
  if (result.success) {
    return ok(result.data);
  }
  return err(result.error);
}

// ---------------------------------------------------------------------------
// Topological Sort (Kahn's Algorithm)
// ---------------------------------------------------------------------------

/**
 * Topologically sort graph nodes using Kahn's algorithm.
 *
 * Validates structural constraints (unique IDs, no self-deps, all refs exist)
 * and detects cycles via BFS. Returns the execution order or a descriptive
 * {@link GraphValidationError}.
 *
 * Pure synchronous function -- no side effects, no async.
 */
export function topologicalSort(nodes: GraphNode[]): Result<string[], GraphValidationError> {
  // 1. Validate no duplicate nodeIds
  const idSet = new Set<string>();
  for (const node of nodes) {
    if (idSet.has(node.nodeId)) {
      return err(
        new GraphValidationError(
          "duplicate_node_id",
          [node.nodeId],
          `Duplicate node ID: "${node.nodeId}"`,
        ),
      );
    }
    idSet.add(node.nodeId);
  }

  // 2. Validate no self-dependencies
  for (const node of nodes) {
    if (node.dependsOn.includes(node.nodeId)) {
      return err(
        new GraphValidationError(
          "self_dependency",
          [node.nodeId],
          `Node "${node.nodeId}" depends on itself`,
        ),
      );
    }
  }

  // 3. Validate all dependsOn references exist
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!idSet.has(dep)) {
        return err(
          new GraphValidationError(
            "missing_dependency",
            [node.nodeId, dep],
            `Node "${node.nodeId}" depends on non-existent node "${dep}"`,
          ),
        );
      }
    }
  }

  // 4. Build adjacency list and in-degree map
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacency.set(node.nodeId, []);
    inDegree.set(node.nodeId, 0);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      adjacency.get(dep)!.push(node.nodeId);
      inDegree.set(node.nodeId, inDegree.get(node.nodeId)! + 1);
    }
  }

  // 5. BFS from nodes with in-degree 0
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // 6. Cycle detection -- trace one cycle via DFS for descriptive error
  if (sorted.length < nodes.length) {
    const visited = new Set(sorted);
    const unvisited = nodes.filter((n) => !visited.has(n.nodeId));

    // Build a dependency lookup for unvisited nodes
    const depMap = new Map<string, string[]>();
    for (const node of unvisited) {
      depMap.set(
        node.nodeId,
        node.dependsOn.filter((d) => !visited.has(d)),
      );
    }

    // DFS to trace one cycle
    const cyclePath = traceCycle(unvisited[0].nodeId, depMap);
    return err(
      new GraphValidationError(
        "cycle",
        cyclePath,
        `Cycle detected: ${cyclePath.join(" -> ")}`,
      ),
    );
  }

  // 7. Return topological order
  return ok(sorted);
}

/**
 * Trace a single cycle from a starting node using DFS.
 * Assumes the starting node participates in a cycle.
 */
function traceCycle(
  start: string,
  depMap: Map<string, string[]>,
): string[] {
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visitedInDfs = new Set<string>();

  function dfs(nodeId: string): string[] | null {
    stack.push(nodeId);
    onStack.add(nodeId);
    visitedInDfs.add(nodeId);

    for (const dep of depMap.get(nodeId) ?? []) {
      if (onStack.has(dep)) {
        // Found cycle -- extract it
        const cycleStart = stack.indexOf(dep);
        const cycle = stack.slice(cycleStart);
        cycle.push(dep); // close the cycle
        return cycle;
      }
      if (!visitedInDfs.has(dep)) {
        const result = dfs(dep);
        if (result) return result;
      }
    }

    stack.pop();
    onStack.delete(nodeId);
    return null;
  }

  const cycle = dfs(start);
  // Fallback: should not happen if start is in a cycle
  return cycle ?? [start];
}

// ---------------------------------------------------------------------------
// Validate and Sort
// ---------------------------------------------------------------------------

/**
 * Validate an execution graph and return it with its topological execution order.
 *
 * Combines Zod schema validation (already done by caller) with DAG structural
 * validation (cycle detection, dependency resolution).
 */
export function validateAndSortGraph(
  graph: ExecutionGraph,
): Result<ValidatedGraph, GraphValidationError> {
  const sortResult = topologicalSort(graph.nodes);
  if (!sortResult.ok) {
    return err(sortResult.error);
  }
  return ok({ graph, executionOrder: sortResult.value });
}
