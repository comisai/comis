// SPDX-License-Identifier: Apache-2.0
/**
 * Per-node token-budget accounting for the graph coordinator (BUDGET-02/03).
 *
 * Two concerns, extracted from graph-node-lifecycle to keep that file within the
 * 800-line cap and to give the budget logic a cohesive, directly-testable home:
 *
 * - {@link resolveNodeBudget} — the effective per-node cap (node.tokenBudget wins;
 *   else the operator default; else the graph-budget inherit-share). D3.
 * - {@link applyNodeBudgetBreach} — records per-node spend, and when the node's run
 *   exceeded its cap, fails the node TERMINALLY (D2, bypassing retry), emits the
 *   counts/ids-only `subagent:budget_exceeded` event (M3: attributed to the node's
 *   CHILD agent), and WARNs with an operator-actionable hint. It NEVER aborts the
 *   whole graph — the cumulative abort (graph-completion.handleBudgetExceeded) is a
 *   separate, later line that runs node-first (D5).
 *
 * The no-budget path is byte-identical to today: `resolveNodeBudget` returns
 * undefined, so `applyNodeBudgetBreach` records spend and takes no breach branch.
 * @module
 */

import { systemNowMs, type TypedEventBus } from "@comis/core";
import type { FailureResult } from "./graph-state-machine.js";
import type { GraphRunState } from "./graph-coordinator-state.js";

/**
 * P0-A-OBS: the agent-layer `finishReason` values that mean a run aborted on its
 * TOKEN budget via a BudgetGuard PRE-CHECK — the next LLM call was rejected before
 * the overage, so the recorded spend is <= the per-node cap. These drive a per-node
 * budget breach even when `spend <= nodeBudget` (the post-hoc `spend > cap` gate
 * would otherwise miss them). Dollar-budget aborts (`spend_exceeded`) are a per-root
 * signal owned by `handleBudgetExceeded`, NOT a per-node token breach — excluded here.
 */
const NODE_BUDGET_ABORT_REASONS: ReadonlySet<string> = new Set(["budget_exceeded", "budget_exhausted"]);

/**
 * Resolve the effective per-node token budget for a node.
 * Precedence (D3):
 *  1. `node.tokenBudget` (the graph author's explicit per-node cap) wins.
 *  2. else the operator default `security.agentToAgent.tokenBudget`
 *     (`subAgentTokenBudget`, when not null).
 *  3. else the inherit-share `floor(graphBudget.maxTokens / total node count)`
 *     ONLY when a graph budget is set. WR-01: clamped to >= 1 — when maxTokens
 *     < nodeCount the raw floor is 0, which would brick the node (checkBudget
 *     breaches on the first call; applyNodeBudgetBreach terminal-fails it). A
 *     clamp to 1 yields a tight-but-usable cap, never a silent all-nodes-brick.
 *  4. else `undefined` — unbounded (byte-identical to today).
 */
export function resolveNodeBudget(
  gs: GraphRunState,
  nodeId: string,
  subAgentTokenBudget: number | null,
): number | undefined {
  return resolveNodeBudgetWithSource(gs, nodeId, subAgentTokenBudget).budget;
}

/**
 * IN-02: which resolution source produced a node's effective per-node cap (D3).
 * A closed union mirrored onto the `subagent:budget_exceeded` event payload so a
 * breach names WHICH knob bound the node.
 */
export type NodeBudgetSource = "node" | "operator-default" | "inherit-share";

/**
 * Resolve the effective per-node budget AND the source that produced it (D3).
 * Single source of truth for the precedence; {@link resolveNodeBudget} returns
 * just the number, {@link applyNodeBudgetBreach} also reports `source` so the
 * breach event/WARN name the exact resolution knob (IN-02). `source` is
 * `undefined` only when `budget` is `undefined` (the unbounded path).
 */
export function resolveNodeBudgetWithSource(
  gs: GraphRunState,
  nodeId: string,
  subAgentTokenBudget: number | null,
): { budget: number | undefined; source: NodeBudgetSource | undefined } {
  const node = gs.graph.graph.nodes.find((n) => n.nodeId === nodeId);
  if (node?.tokenBudget !== undefined) return { budget: node.tokenBudget, source: "node" };
  if (subAgentTokenBudget !== null) return { budget: subAgentTokenBudget, source: "operator-default" };
  const graphMax = gs.graph.graph.budget?.maxTokens;
  const total = gs.graph.graph.nodes.length;
  // WR-01: Math.max(1, …) — never round the share down to a 0 cap that bricks
  // every node when the graph budget is smaller than the node count.
  if (graphMax !== undefined && total > 0) {
    return { budget: Math.max(1, Math.floor(graphMax / total)), source: "inherit-share" };
  }
  return { budget: undefined, source: undefined }; // unbounded — byte-identical to today
}

/** Outcome of the per-node breach check. */
export interface NodeBudgetBreachResult {
  /** True when the node exceeded its per-node cap and was failed terminally. */
  breached: boolean;
  /** The terminal-fail FailureResult (cascade skip/newlyReady) — present on breach. */
  failResult?: FailureResult;
}

/**
 * Record per-node spend and, on breach, fail the node terminally + emit the event.
 *
 * Called BEFORE the ordinary step-6 state transition in handleSubAgentCompleted:
 * a breaching SUCCESSFUL run must end `failed`, not `completed`, so the caller
 * skips its `markNodeCompleted` when this returns `breached: true`.
 *
 * Node-first (D5): this is the per-node line; the caller's cumulative graph-budget
 * abort runs AFTER it. This function never aborts the whole graph.
 */
export function applyNodeBudgetBreach(
  deps: {
    eventBus: TypedEventBus;
    logger?: { warn(obj: Record<string, unknown>, msg: string): void };
    defaultAgentId: string;
  },
  config: { subAgentTokenBudget: number | null },
  gs: GraphRunState,
  nodeId: string,
  spend: number,
  priorSessionKey?: string,
  finishReason?: string,
): NodeBudgetBreachResult {
  // BUDGET-03: always record per-node spend (present even when no budget resolves).
  gs.nodeTokenSpend.set(nodeId, spend);

  // IN-02: resolve the cap AND the knob that produced it so the breach names it.
  const { budget: nodeBudget, source: capSource } = resolveNodeBudgetWithSource(gs, nodeId, config.subAgentTokenBudget);
  // P0-A-OBS (orchestration-excellence): a per-node-budget-bounded node aborts on
  // its budget TWO ways — (1) POST-HOC, the graph sees spend > nodeBudget; (2)
  // PRE-CHECK, the agent's BudgetGuard rejected the NEXT LLM call BEFORE the
  // overage (so spend <= nodeBudget) and the run ended with a budget finishReason.
  // BOTH are per-node breaches and must terminal-fail the node + emit
  // subagent:budget_exceeded — pre-fix the pre-check path was invisible (no event,
  // empty node error, tokensUsed 0). A budget finishReason with NO per-node cap is
  // a per-ROOT abort owned by handleBudgetExceeded, NOT a per-node breach.
  const postHocOverage = nodeBudget !== undefined && spend > nodeBudget;
  const preCheckAbort = NODE_BUDGET_ABORT_REASONS.has(finishReason ?? "");
  if (nodeBudget === undefined || capSource === undefined || (!postHocOverage && !preCheckAbort) || gs.stateMachine.isTerminal()) {
    return { breached: false };
  }

  // Terminal-fail the node (D2): a retry would only re-burn the budget. ORCH-OBS:
  // name the cap SOURCE in the error too — the node error is the only surface
  // graph.status + the IncidentReport failure list see (the WARN/event ride other
  // paths), so an operator drilling a failed node learns WHICH knob bound it. The
  // pre-check path names the finishReason so the abort cause is unambiguous.
  const breachDetail = postHocOverage
    ? `${spend} > ${nodeBudget}`
    : `pre-check aborted at ${spend}/${nodeBudget}; finishReason: ${finishReason}`;
  const failRes = gs.stateMachine.markNodeFailed(
    nodeId,
    `Node token budget exceeded (${breachDetail}; cap source: ${capSource})`,
    priorSessionKey,
    { terminal: true },
  );
  if (!failRes.ok) {
    deps.logger?.warn(
      { graphId: gs.graphId, nodeId, error: failRes.error, hint: "Node may have been concurrently updated", errorKind: "internal" as const },
      "Budget-fail node transition failed",
    );
  }

  // M3: attribute the breach to the node's CHILD agent (node.agentId ?? default),
  // NOT gs.callerAgentId (the parent) — mirrors the spawnNode attribution.
  const node = gs.graph.graph.nodes.find((n) => n.nodeId === nodeId);
  deps.eventBus.emit("subagent:budget_exceeded", {
    graphId: gs.graphId,
    nodeId,
    agentId: node?.agentId ?? deps.defaultAgentId,
    tokenBudget: nodeBudget,
    tokensUsed: spend,
    capSource, // IN-02: which knob bound the node (node / operator-default / inherit-share)
    timestamp: systemNowMs(),
  });
  // IN-02: name the exact knob in the hint so the operator knows WHICH lever to pull.
  const capHintBySource: Record<NodeBudgetSource, string> = {
    "node": "the node's own `tokenBudget`",
    "operator-default": "the operator default `security.agentToAgent.tokenBudget`",
    "inherit-share": "the graph-budget inherit-share (`budget.maxTokens` ÷ node count)",
  };
  deps.logger?.warn(
    {
      graphId: gs.graphId,
      nodeId,
      tokenBudget: nodeBudget,
      tokensUsed: spend,
      capSource,
      hint: `Per-node token budget exceeded; node failed per on_failure. Cap came from ${capHintBySource[capSource]} — raise that, or the graph budget.`,
      errorKind: "resource" as const,
    },
    "Sub-agent per-node token budget exceeded",
  );

  return { breached: true, failResult: failRes.ok ? failRes.value : undefined };
}

/**
 * Emit `graph:node_updated{status:skipped}` for each newly-skipped node (deduped
 * via gs.skippedNodesEmitted) and queue a spawn pass when nodes became ready.
 * Shared by the ordinary-failure cascade and the per-node budget-breach cascade in
 * handleSubAgentCompleted — both consume a state-machine FailureResult identically.
 */
export function emitSkipsAndSpawnReady(
  deps: { eventBus: TypedEventBus },
  gs: GraphRunState,
  failResult: Pick<FailureResult, "skipped" | "newlyReady">,
  spawnReadyNodes: (gs: GraphRunState) => void,
): void {
  for (const skippedId of failResult.skipped) {
    if (!gs.skippedNodesEmitted.has(skippedId)) {
      gs.skippedNodesEmitted.add(skippedId);
      deps.eventBus.emit("graph:node_updated", {
        graphId: gs.graphId,
        nodeId: skippedId,
        status: "skipped" as const,
        timestamp: systemNowMs(),
      });
    }
  }
  if (failResult.newlyReady.length > 0) {
    queueMicrotask(() => spawnReadyNodes(gs));
  }
}
