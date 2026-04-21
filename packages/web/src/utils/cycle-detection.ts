// SPDX-License-Identifier: Apache-2.0
/**
 * Cycle detection for directed graphs.
 *
 * Provides a pure function to check whether adding a proposed edge
 * would create a cycle in the graph. Used by the graph builder to
 * validate edge connections before committing them.
 */

/** Minimal edge shape for cycle detection (source -> target) */
export interface EdgeLike {
  readonly source: string;
  readonly target: string;
}

/**
 * Check whether adding an edge from `newSource` to `newTarget` would
 * create a cycle in the directed graph defined by `existingEdges`.
 *
 * Algorithm: Build adjacency list from existing edges plus the proposed
 * edge, then check if `newSource` is reachable from `newTarget` via DFS.
 * A self-loop (newSource === newTarget) is detected immediately.
 *
 * @param existingEdges - Current edges in the graph
 * @param newSource - Source node ID of the proposed edge
 * @param newTarget - Target node ID of the proposed edge
 * @returns true if adding the edge would create a cycle
 */
export function wouldCreateCycle(
  existingEdges: ReadonlyArray<EdgeLike>,
  newSource: string,
  newTarget: string,
): boolean {
  // Self-loop is always a cycle
  if (newSource === newTarget) return true;

  // Build adjacency list including the proposed edge
  const adj = new Map<string, string[]>();

  for (const edge of existingEdges) {
    let targets = adj.get(edge.source);
    if (!targets) {
      targets = [];
      adj.set(edge.source, targets);
    }
    targets.push(edge.target);
  }

  // Add proposed edge
  let targets = adj.get(newSource);
  if (!targets) {
    targets = [];
    adj.set(newSource, targets);
  }
  targets.push(newTarget);

  // DFS from newTarget to see if we can reach newSource
  const visited = new Set<string>();
  const stack = [newTarget];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === newSource) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const neighbors = adj.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          stack.push(neighbor);
        }
      }
    }
  }

  return false;
}
