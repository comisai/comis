/**
 * Pure graph validation engine for the pipeline builder.
 *
 * Validates a directed acyclic graph (DAG) of pipeline nodes and edges,
 * returning structured results with node IDs for canvas highlighting.
 * All functions are pure -- no side effects, no imports beyond types.
 */

import type {
  PipelineNode,
  PipelineEdge,
  ValidationResult,
  ValidationMessage,
} from "../api/types/index.js";

/**
 * Validate a pipeline graph for structural correctness and best practices.
 *
 * Error rules (make graph invalid):
 *  1. Empty graph (no nodes)
 *  2. More than 20 nodes
 *  3. Duplicate node IDs
 *  4. Node without task (empty/whitespace)
 *  5. Self-dependency
 *  6. Missing dependency reference
 *  7. Cycle detected (via Kahn's algorithm)
 *
 * Warning rules (graph still valid):
 *  8. Node without agentId
 *  9. Barrier mode with 0 or 1 dependency
 * 10. Disconnected node (no edges, graph >1 node)
 *
 * Type validation rules:
 * 11. Type requires config (error) -- node has typeId but no typeConfig
 * 12. Config requires type (error) -- node has typeConfig but no typeId
 * 13. Expensive retry warning -- retries > 0 on debate/vote/map-reduce/collaborate nodes (warning)
 * 14. Approval-gate retry warning -- retries > 0 on approval-gate nodes (warning)
 * 15. Non-default contextMode with no dependencies (warning)
 *
 * @param nodes - Pipeline nodes to validate
 * @param edges - Pipeline edges to validate
 * @returns Structured validation result with errors, warnings, and nodeIds
 */
export function validateGraph(
  nodes: ReadonlyArray<PipelineNode>,
  edges: ReadonlyArray<PipelineEdge>,
): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];

  // Rule 1: Empty graph
  if (nodes.length === 0) {
    errors.push({
      severity: "error",
      message: "Graph must have at least 1 node",
    });
    return { valid: false, errors, warnings };
  }

  // Rule 2: More than 20 nodes
  if (nodes.length > 20) {
    errors.push({
      severity: "error",
      message: `Graph exceeds maximum of 20 nodes (current: ${nodes.length})`,
    });
  }

  // Build ID set for fast lookup
  const nodeIdSet = new Set<string>();
  const seenIds = new Set<string>();

  // Rule 3: Duplicate node IDs
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      errors.push({
        severity: "error",
        message: `Duplicate node ID "${node.id}"`,
        nodeIds: [node.id],
      });
    } else {
      seenIds.add(node.id);
    }
    nodeIdSet.add(node.id);
  }

  for (const node of nodes) {
    // Rule 4: Node without task
    if (!node.task || node.task.trim().length === 0) {
      errors.push({
        severity: "error",
        message: `Node "${node.id}" has no task defined`,
        nodeIds: [node.id],
      });
    }

    // Rule 5: Self-dependency
    for (const dep of node.dependsOn) {
      if (dep === node.id) {
        errors.push({
          severity: "error",
          message: `Node "${node.id}" has a self-dependency`,
          nodeIds: [node.id],
        });
      }
    }

    // Rule 6: Missing dependency reference
    for (const dep of node.dependsOn) {
      if (dep !== node.id && !nodeIdSet.has(dep)) {
        errors.push({
          severity: "error",
          message: `Node "${node.id}" depends on missing node "${dep}"`,
          nodeIds: [node.id],
        });
      }
    }
  }

  // Rule 7: Cycle detection via Kahn's algorithm
  // Build adjacency list from edges
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
  }

  for (const edge of edges) {
    const targets = adjList.get(edge.source);
    if (targets) {
      targets.push(edge.target);
    }
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  // Also incorporate dependsOn relationships not captured by edges
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (nodeIdSet.has(dep)) {
        // dep -> node (dependency points from dep to this node)
        const targets = adjList.get(dep);
        if (targets && !targets.includes(node.id)) {
          targets.push(node.id);
          inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        }
      }
    }
  }

  // Kahn's: process nodes with in-degree 0
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let consumed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    consumed++;
    const neighbors = adjList.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          queue.push(neighbor);
        }
      }
    }
  }

  if (consumed < nodeIdSet.size) {
    // Remaining nodes are in cycles
    const cycleNodes: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg > 0) {
        cycleNodes.push(id);
      }
    }
    errors.push({
      severity: "error",
      message: `Cycle detected involving nodes: ${cycleNodes.join(", ")}`,
      nodeIds: cycleNodes,
    });
  }

  // --- Warning rules ---

  // Build connected sets for disconnected detection
  const connectedNodes = new Set<string>();
  for (const edge of edges) {
    connectedNodes.add(edge.source);
    connectedNodes.add(edge.target);
  }
  // Also count dependsOn references as connections
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (nodeIdSet.has(dep)) {
        connectedNodes.add(node.id);
        connectedNodes.add(dep);
      }
    }
  }

  for (const node of nodes) {
    // Rule 8: Node without agentId (skip for typed nodes that specify agents in typeConfig)
    if (!node.agentId) {
      const tc = node.typeConfig as Record<string, unknown> | undefined;
      const hasTypeAgent =
        typeof tc?.agent === "string" && tc.agent !== "" ||
        Array.isArray(tc?.agents) && (tc.agents as string[]).length > 0 ||
        Array.isArray(tc?.voters) && (tc.voters as string[]).length > 0 ||
        Array.isArray(tc?.reviewers) && (tc.reviewers as string[]).length > 0 ||
        Array.isArray(tc?.mappers) && (tc.mappers as unknown[]).length > 0;
      if (!hasTypeAgent) {
        warnings.push({
          severity: "warning",
          message: `Node "${node.id}" has no agent assigned`,
          nodeIds: [node.id],
        });
      }
    }

    // Rule 9: Barrier mode with 0 or 1 dependency
    if (node.barrierMode && node.dependsOn.length <= 1) {
      warnings.push({
        severity: "warning",
        message: `Node "${node.id}" has barrier mode "${node.barrierMode}" but only ${node.dependsOn.length} dependency`,
        nodeIds: [node.id],
      });
    }

    // Rule 10: Disconnected node (no edges, graph > 1 node)
    if (nodes.length > 1 && !connectedNodes.has(node.id)) {
      warnings.push({
        severity: "warning",
        message: `Node "${node.id}" is disconnected from the graph`,
        nodeIds: [node.id],
      });
    }

    // Rule 11: Type requires config
    if (node.typeId && !node.typeConfig) {
      errors.push({
        severity: "error",
        message: `Node "${node.id}" has typeId "${node.typeId}" but no typeConfig`,
        nodeIds: [node.id],
      });
    }

    // Rule 12: Config requires type
    if (!node.typeId && node.typeConfig) {
      errors.push({
        severity: "error",
        message: `Node "${node.id}" has typeConfig but no typeId`,
        nodeIds: [node.id],
      });
    }

    // Rule 13: Expensive retry warning on multi-agent typed nodes
    if (node.typeId && (node.retries ?? 0) > 0 &&
        ["debate", "vote", "map-reduce", "collaborate"].includes(node.typeId)) {
      warnings.push({
        severity: "warning",
        message: `Node "${node.id}" has retries on a "${node.typeId}" node -- retrying multi-agent execution is expensive`,
        nodeIds: [node.id],
      });
    }

    // Rule 14: Approval-gate retry warning
    if (node.typeId === "approval-gate" && (node.retries ?? 0) > 0) {
      warnings.push({
        severity: "warning",
        message: `Node "${node.id}" has retries on an approval-gate -- retrying will re-prompt the user`,
        nodeIds: [node.id],
      });
    }

    // Rule 15: Non-default contextMode with no dependencies
    if (node.contextMode && node.contextMode !== "full" && node.dependsOn.length === 0) {
      warnings.push({
        severity: "warning",
        message: `Node "${node.id}" has contextMode "${node.contextMode}" but no dependencies to receive context from`,
        nodeIds: [node.id],
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
