// SPDX-License-Identifier: Apache-2.0
/**
 * Graph-timeout floor (v2.19, OR/timeout fix).
 *
 * A weak model routinely sets the graph-level `timeoutMs` too low for the work
 * it just decomposed — observed live: a 6-node NVDA pipeline (4 analysts →
 * debate → head-trader) given a 10-minute graph timeout. The 4 analysts ran two
 * at a time (small/nano concurrency = 2) and, doing heavy MCP + web research on
 * a single local model, consumed the entire 10 minutes; the debate node was torn
 * down 12 s after spawn and the head-trader never ran. The graph "completed" with
 * no result.
 *
 * The fix is a deterministic floor: the graph timeout must be at least the DAG's
 * makespan upper bound — the time the critical path needs if every node runs to
 * its own timeout, accounting for concurrency waves at each dependency level.
 * `graph-coordinator` applies `max(requestedTimeoutMs, floor)` so the model can
 * decompose freely but cannot starve later phases.
 *
 * The estimate is intentionally an UPPER bound (it assumes a strict barrier
 * between dependency levels and that every node runs to its full timeout). Over-
 * estimating only makes the graph timeout more generous — nodes that finish early
 * still complete the graph early, because the timeout is a ceiling, not a target.
 *
 * @module
 */

/** Per-node timeout assumed when a node declares none (mirrors the 5-min node default). */
export const DEFAULT_NODE_TIMEOUT_MS = 300_000;

/** Hard cap so a pathological graph cannot demand a multi-hour timeout. */
export const MAX_GRAPH_TIMEOUT_FLOOR_MS = 7_200_000; // 2 hours

interface FloorNode {
  nodeId: string;
  dependsOn?: string[];
  timeoutMs?: number;
}

/**
 * Compute the minimum graph timeout (ms) needed for a DAG to complete, given a
 * concurrency ceiling. Pure: same input → same output.
 *
 * Algorithm: assign each node a topological LEVEL (longest dependency depth).
 * Levels execute sequentially (a level-N node waits on its level-(<N) deps). At
 * each level, `ceil(width / maxConcurrency)` waves run, each taking up to the
 * level's largest node timeout. The floor is the sum of per-level wall-times,
 * capped at MAX_GRAPH_TIMEOUT_FLOOR_MS.
 *
 * @param nodes           - Graph nodes (nodeId + optional dependsOn + optional timeoutMs).
 * @param maxConcurrency  - Max nodes run in parallel (small/nano → 2, frontier/mid → 4).
 * @param perNodeDefaultMs- Timeout assumed for nodes without an explicit one.
 */
export function computeGraphTimeoutFloorMs(
  nodes: readonly FloorNode[],
  maxConcurrency: number,
  perNodeDefaultMs: number = DEFAULT_NODE_TIMEOUT_MS,
): number {
  if (nodes.length === 0) return 0;
  const conc = Math.max(1, Math.floor(maxConcurrency) || 1);
  const byId = new Map<string, FloorNode>(nodes.map((n) => [n.nodeId, n]));

  // Longest-dependency-depth level per node (cycle-guarded — the schema validator
  // rejects cycles upstream, but never trust input here).
  const levelCache = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const cached = levelCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // break a cycle defensively
    visiting.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d) && d !== id);
    const lvl = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(levelOf));
    visiting.delete(id);
    levelCache.set(id, lvl);
    return lvl;
  };

  // Bucket nodes by level, then sum per-level wall-time (waves × max node timeout).
  const levelTimeouts = new Map<number, number[]>();
  for (const n of nodes) {
    const lvl = levelOf(n.nodeId);
    const ms = n.timeoutMs !== undefined && n.timeoutMs > 0 ? n.timeoutMs : perNodeDefaultMs;
    const bucket = levelTimeouts.get(lvl);
    if (bucket) bucket.push(ms);
    else levelTimeouts.set(lvl, [ms]);
  }

  let floor = 0;
  for (const timeouts of levelTimeouts.values()) {
    const waves = Math.ceil(timeouts.length / conc);
    floor += waves * Math.max(...timeouts);
  }
  return Math.min(floor, MAX_GRAPH_TIMEOUT_FLOOR_MS);
}
