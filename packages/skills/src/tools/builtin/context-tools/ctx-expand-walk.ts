// SPDX-License-Identifier: Apache-2.0
/**
 * `ctxExpandWalk` — DEPTH-02 bounded in-process multi-hop walk over a compressed
 * region of THIS conversation. The single-hop `ctx_expand` recovered ONE leaf
 * summary's messages; this BFS descends the summary-parent (T2) hierarchy
 * (condensed → child summaries → leaf summaries → messages) and, when a
 * knowledge-graph lane is injected, fuses bounded KG (T4) hops — returning a
 * RANKED CITED evidence bundle bounded by depth, token, and node-visit caps.
 *
 * Architecture cuts (mirrors context-tools-shared.ts:5-22):
 *   - agent↛memory: imports ONLY `@comis/core` port TYPES + `@comis/shared`
 *     (`Result`) — NEVER `@comis/memory`. The concrete LCD store arrives as the
 *     core `ContextStorePort` TYPE (the daemon injects it).
 *   - The walk is READ-ONLY (getSummaryChildren / getSummaryMessages / getMessages
 *     only — no append/upsert). The tool runs it INSIDE
 *     `store.runOnConversation` (the single-flight serializer) so a deferred
 *     compaction write cannot rewrite the DAG mid-walk (Pitfall 5).
 *   - R4 scope-inheritance: EVERY edge read passes the per-call `scope` the
 *     caller derived from `requireCtxScope()` — an out-of-scope summary/message
 *     is unreachable by construction (WR-02). The scope is NEVER a wiring closure.
 *
 * T2-only floor (the live default): `spreadLane` is OPTIONAL. When it is absent,
 * returns an empty lane, OR errors, the walk SUCCEEDS T2-only — the KG is NEVER a
 * precondition (the design's §15 degradation; `spreadLane` is a skeleton
 * returning [] in production today, and no TripleStorePort is threaded into the
 * tool deps). A failing lane is non-fatal — logged content-free, the walk
 * continues T2-only (mirrors recall-graph-spread-lane.ts:72-85).
 *
 * NO sub-agent, NO grant lifecycle — EXPF-01 (frontier sub-agent escalation) is
 * explicitly DEFERRED. This walk is in-process and deterministic.
 *
 * @module
 */

import type {
  ContextStorePort,
  ContextStoreScope,
  LcdMessage,
  MemorySearchResult,
} from "@comis/core";
import type { Result } from "@comis/shared";

import { estimateTokens, renderMessageText, type ToolLogger } from "./context-tools-shared.js";

/**
 * The four capability tiers (a LOCAL structural union; `CapabilityClass` lives in
 * `@comis/agent` which the skills package does not depend on — the depth table is
 * the shared idea, the type is re-declared here to keep the agent↛skills cut).
 */
export type WalkCapabilityClass = "frontier" | "mid" | "small" | "nano";

/** Caps that bound the multi-hop walk (no unbounded traversal on a pathological DAG). */
export interface WalkCaps {
  /** Max BFS hop depth from the seed (tier-gated: nano1/small2/mid3/frontier4). */
  readonly maxDepth: number;
  /** Max accumulated bundle token estimate (chars/4) — the same cap as `maxExpandTokens`. */
  readonly maxTokens: number;
  /** Max number of summary nodes visited (a sane bound, e.g. 64). */
  readonly maxNodes: number;
}

/** Optional T4 (KG) lane + a content-free logger for the non-fatal lane-error WARN. */
export interface WalkOpts {
  /**
   * Optional bounded KG spread lane (the `TripleStorePort.spreadLane` shape).
   * Absent / empty / errored ⇒ the walk is T2-only (the live default floor).
   */
  readonly spreadLane?: (
    seedSubjects: string[],
    maxDepth: number,
    fanOut: number,
    cap: number,
  ) => Promise<Result<MemorySearchResult[], Error>>;
  /** Optional structural logger for the content-free non-fatal lane WARN. */
  readonly logger?: ToolLogger;
}

/** One cited evidence item in the ranked bundle (cite = refId + kind). */
export interface WalkItem {
  /** `lcd_summaries.summaryId` (kind="summary") OR `lcd_messages.id` (kind="message"). */
  readonly refId: string;
  readonly kind: "summary" | "message";
  /** The recovered text (UNTRUSTED — the caller scrubs + taint-wraps before re-entry). */
  readonly text: string;
  /** BFS depth at which this item was recovered (the rank key — shallow first). */
  readonly depth: number;
}

/** The ranked cited bundle the walk returns. */
export interface WalkBundle {
  /** Ranked cited items (deterministic order — depth asc, then refId asc). */
  readonly items: WalkItem[];
  /** The deepest BFS hop actually reached. */
  readonly depthReached: number;
  /** The number of summary nodes visited (bounded by maxNodes). */
  readonly nodesVisited: number;
  /** Count of drifted/missing ids skipped (never thrown — coverage is partial). */
  readonly unrecoverable: number;
  /** True when any cap (depth / token / node) stopped the walk before exhaustion. */
  readonly capped: boolean;
}

/** Per-tier multi-hop depth cap. Pure map: nano1 / small2 / mid3 / frontier4. */
export function depthForTier(capabilityClass: WalkCapabilityClass): number {
  switch (capabilityClass) {
    case "nano":
      return 1;
    case "small":
      return 2;
    case "mid":
      return 3;
    case "frontier":
      return 4;
    default: {
      // Exhaustive closed-union check (AGENTS.md §2.8). Unreachable.
      const _exhaustive: never = capabilityClass;
      return _exhaustive;
    }
  }
}

/** One BFS frontier node: a summaryId to expand at a given hop depth. */
interface QueueNode {
  readonly summaryId: string;
  readonly depth: number;
}

/**
 * Bounded multi-hop BFS over the summary-parent (T2) hierarchy (+ optional T4 KG
 * lane), seeded by `seedSummaryId`. Read-only; every edge read passes `scope`.
 *
 * @param store           The injected core `ContextStorePort` TYPE (read-only here).
 * @param scope           The per-call R4 read scope (from `requireCtxScope()`).
 * @param seedSummaryId   The summaryId to zoom into (from ctx_search / ctx_inspect).
 * @param caps            depth / token / node-visit caps (depth is tier-gated).
 * @param opts            Optional T4 spreadLane + logger (T2-only when absent).
 * @returns a ranked cited evidence bundle bounded by the caps.
 */
export async function ctxExpandWalk(
  store: ContextStorePort,
  scope: ContextStoreScope,
  seedSummaryId: string,
  caps: WalkCaps,
  opts?: WalkOpts,
): Promise<WalkBundle> {
  const queue: QueueNode[] = [{ summaryId: seedSummaryId, depth: 0 }];
  const visited = new Set<string>();
  const items: WalkItem[] = [];
  let tokenEstimate = 0;
  let depthReached = 0;
  let nodesVisited = 0;
  let unrecoverable = 0;
  let capped = false;

  // Lazy id→message map — built once on the first leaf encountered (the
  // single-summary tool's id-keyed re-join, kept O(referenced) by deferring it).
  let messageById: Map<string, LcdMessage> | undefined;
  const getMessageMap = (): Map<string, LcdMessage> => {
    if (messageById === undefined) {
      messageById = new Map<string, LcdMessage>(store.getMessages(scope).map((r) => [r.id, r]));
    }
    return messageById;
  };

  // --- T2 BFS over the summary-parent hierarchy. ---
  while (queue.length > 0) {
    if (nodesVisited >= caps.maxNodes) {
      capped = true;
      break;
    }
    const node = queue.shift();
    if (node === undefined) break;
    if (visited.has(node.summaryId)) continue; // cycle / back-edge guard
    visited.add(node.summaryId);
    nodesVisited++;
    if (node.depth > depthReached) depthReached = node.depth;

    // A condensed summary has children; a leaf summary covers messages. Read both
    // edges R4-scoped — a drifted id simply yields [] (never throws).
    const children = store.getSummaryChildren(scope, node.summaryId);
    const messageIds = store.getSummaryMessages(scope, node.summaryId);

    // Leaf detail: re-join covered ids → render text → add as cited message items,
    // stopping at the token cap. A missing id is counted unrecoverable, not thrown.
    if (messageIds.length > 0) {
      const byId = getMessageMap();
      for (const id of messageIds) {
        const row = byId.get(id);
        if (row === undefined) {
          unrecoverable++;
          continue;
        }
        const text = renderMessageText(row);
        const cost = estimateTokens(text);
        if (tokenEstimate + cost > caps.maxTokens && items.length > 0) {
          capped = true;
          break;
        }
        items.push({ refId: id, kind: "message", text, depth: node.depth });
        tokenEstimate += cost;
      }
      if (capped) break;
    }

    // Descend into child summaries while within the depth + node caps. A child at
    // the depth frontier is NOT enqueued (depthReached records the frontier, capped).
    if (children.length > 0) {
      if (node.depth >= caps.maxDepth) {
        capped = true;
      } else {
        for (const child of children) {
          if (visited.has(child.summaryId)) continue;
          if (nodesVisited + queue.length >= caps.maxNodes) {
            capped = true;
            break;
          }
          queue.push({ summaryId: child.summaryId, depth: node.depth + 1 });
          // A condensed child also carries its own summary text as a cited item
          // (the "ranked cited" surface includes the summary nodes traversed).
          if (tokenEstimate + estimateTokens(child.content) <= caps.maxTokens) {
            items.push({
              refId: child.summaryId,
              kind: "summary",
              text: child.content,
              depth: node.depth + 1,
            });
            tokenEstimate += estimateTokens(child.content);
          }
        }
      }
    }
  }

  // --- Optional T4 (KG) lane — non-fatal, empty-lane no-op (T2-only floor). ---
  if (opts?.spreadLane !== undefined && tokenEstimate < caps.maxTokens) {
    await fuseSpreadLane(items, opts, caps, seedSummaryId, () => tokenEstimate, (n) => {
      tokenEstimate = n;
    });
  }

  // Deterministic rank: depth asc (shallowest, closest-to-seed first), then refId
  // asc — same input ⇒ same order (no agent-rag scorer; skills↛agent-rag).
  items.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0));

  return { items, depthReached, nodesVisited, unrecoverable, capped };
}

/**
 * Fuse the optional KG (T4) lane into the bundle. Mirrors recall-graph-spread-lane.ts:
 * an err is NON-FATAL (content-free WARN, return) and an empty lane is a no-op —
 * the T2 bundle is left intact in both cases (the T2-only floor).
 */
async function fuseSpreadLane(
  items: WalkItem[],
  opts: WalkOpts,
  caps: WalkCaps,
  seedSummaryId: string,
  getTokens: () => number,
  setTokens: (n: number) => void,
): Promise<void> {
  const spreadLane = opts.spreadLane;
  if (spreadLane === undefined) return;
  // The seed subject for the bounded KG walk (depth/fanOut/cap bounded by the caps).
  const laneRes = await spreadLane([seedSummaryId], caps.maxDepth, 8, caps.maxNodes);
  if (!laneRes.ok) {
    // NON-FATAL: the KG lane failed; rank WITHOUT it (T2-only). Content-free.
    opts.logger?.warn(
      {
        toolName: "ctx_expand",
        errorKind: "dependency" as const,
        hint: "graph-spread (T4) lane failed; multi-hop walk used summary edges only",
        step: "ctx_expand_walk",
      },
      "ctx_expand T4 lane fallback (non-fatal)",
    );
    return;
  }
  // Empty lane → no-op (the T2-only floor: KG absent / default-off).
  if (laneRes.value.length === 0) return;
  let tokenEstimate = getTokens();
  for (const hit of laneRes.value) {
    const text = hit.entry.content;
    const cost = estimateTokens(text);
    if (tokenEstimate + cost > caps.maxTokens) break;
    items.push({ refId: hit.entry.id, kind: "summary", text, depth: caps.maxDepth });
    tokenEstimate += cost;
  }
  setTokens(tokenEstimate);
}
