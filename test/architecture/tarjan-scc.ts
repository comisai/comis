// SPDX-License-Identifier: Apache-2.0
/**
 * Pure data-structure helper: Tarjan's strongly-connected-components algorithm.
 *
 * Used by `no-cycles.test.ts` (cross-package cycle detection over the parsed
 * tsconfig.json `references` graph + package.json @comis/* dependencies graph).
 * Tarjan classic 1972 — verified line-by-line against the canonical paper to
 * avoid an off-by-one in `lowLinks` (see CRITICAL note in `strongConnect`).
 *
 * Zero dependencies. ~30 lines (excluding JSDoc).
 *
 * @module
 */

/**
 * Compute strongly-connected components of a directed graph.
 *
 * @param nodes Set of all node identifiers.
 * @param edges Adjacency map: node → set of out-neighbours.
 * @returns Array of SCCs; each SCC is a non-empty array of node identifiers.
 *          Single-node SCCs (no self-loop) are included; cycle-bearing SCCs
 *          are those with `length > 1` OR a self-loop edge `n → n`.
 */
export function findStronglyConnectedComponents<T>(
  nodes: ReadonlySet<T>,
  edges: ReadonlyMap<T, ReadonlySet<T>>,
): T[][] {
  const indices = new Map<T, number>();
  const lowLinks = new Map<T, number>();
  const onStack = new Set<T>();
  const stack: T[] = [];
  const sccs: T[][] = [];
  let idx = 0;

  function strongConnect(v: T): void {
    indices.set(v, idx);
    lowLinks.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? new Set<T>()) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowLinks.set(v, Math.min(lowLinks.get(v)!, lowLinks.get(w)!));
      } else if (onStack.has(w)) {
        // CRITICAL: indices.get(w), NOT lowLinks.get(w) — using lowLinks here
        // is a classic off-by-one that breaks SCC correctness on back-edges.
        lowLinks.set(v, Math.min(lowLinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowLinks.get(v) === indices.get(v)) {
      const scc: T[] = [];
      let w: T;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const v of nodes) {
    if (!indices.has(v)) strongConnect(v);
  }
  return sccs;
}

/**
 * Filter SCCs to only those representing cycles.
 *
 * An SCC is a cycle if it contains more than one node, OR if a single-node
 * SCC has a self-loop (`n → n` in the edges map).
 */
export function findCycles<T>(
  nodes: ReadonlySet<T>,
  edges: ReadonlyMap<T, ReadonlySet<T>>,
): T[][] {
  const sccs = findStronglyConnectedComponents(nodes, edges);
  return sccs.filter((scc) => {
    if (scc.length > 1) return true;
    // Single-node SCC: cycle iff self-loop.
    const n = scc[0]!;
    return edges.get(n)?.has(n) ?? false;
  });
}
