// SPDX-License-Identifier: Apache-2.0
/**
 * OrchestrationEvents: multi-agent graph orchestration lifecycle events
 * (graph:* + subagent:*).
 *
 * Extracted from AgentEvents (Phase 170-02) so the graph coordinator's
 * lifecycle surface lives as one cohesive domain group — mirroring how
 * TerminalEvents / MediaGenerationEvents are their own sub-interfaces folded
 * into EventMap. The graph engine emits a start signal, a per-node transition,
 * a terminal completion, a typed-driver lifecycle phase, and (BUDGET-03) a
 * per-node token-budget breach.
 *
 * Counts / ids / typed enums ONLY — NEVER task text, sub-agent output, or
 * response bodies. The breach event (`subagent:budget_exceeded`) carries the
 * two token numbers and the ids and nothing else (AGENTS.md §2.7); every
 * payload is reconstructable from the bus alone.
 */
import type { NodeStatus, GraphStatus } from "../domain/execution-graph.js";

export interface OrchestrationEvents {
  /** Graph execution started (coordinator began running a validated DAG) */
  "graph:started": {
    graphId: string;
    label?: string;
    nodeCount: number;
    timestamp: number;
  };

  /** Graph node transitioned to a new status (running, completed, failed, skipped) */
  "graph:node_updated": {
    graphId: string;
    nodeId: string;
    status: NodeStatus;
    previousStatus?: NodeStatus;
    durationMs?: number;
    error?: string;
    /** Per-node token spend for the completed node (BUDGET-03). */
    tokensUsed?: number;
    /** Per-node cost for the completed node (BUDGET-03). */
    cost?: number;
    timestamp: number;
  };

  /**
   * A graph node's sub-agent exceeded its per-node token budget (BUDGET-03).
   * Counts/ids only — NEVER task text or output (AGENTS.md §2.7). Mirrors the
   * memory:consolidated minimal-payload convention.
   */
  "subagent:budget_exceeded": {
    graphId: string;
    nodeId: string;
    agentId: string;
    /** The per-node cap that was breached. */
    tokenBudget: number;
    /** The node's actual run token spend. */
    tokensUsed: number;
    /**
     * IN-02: which resolution source produced the breached cap (D3 precedence) —
     * the node's own `tokenBudget`, the operator default
     * `security.agentToAgent.tokenBudget`, or the graph-budget inherit-share. A
     * closed-union enum tag (counts/ids-only, safe under §2.7) so an operator can
     * tell WHICH knob bound the node, not just THAT it was bounded.
     */
    capSource: "node" | "operator-default" | "inherit-share";
    timestamp: number;
  };

  /** Graph reached terminal state (completed, failed, or cancelled) */
  "graph:completed": {
    graphId: string;
    status: GraphStatus;
    durationMs: number;
    nodeCount: number;
    nodesCompleted: number;
    nodesFailed: number;
    nodesSkipped: number;
    cancelReason?: "timeout" | "budget" | "manual";
    timestamp: number;
    /** 3.3: Aggregate cache read tokens across all graph nodes. */
    graphCacheReadTokens?: number;
    /** 3.3: Aggregate cache write tokens across all graph nodes. */
    graphCacheWriteTokens?: number;
    /** 3.3: Cache effectiveness ratio (reads / (reads + writes)). */
    graphCacheEffectiveness?: number;
    /** 3.3: Per-node cache effectiveness breakdown. */
    nodeEffectiveness?: Record<string, number>;
    /**
     * IN-01: per-node token-spend breakdown (nodeId → tokens) for the run,
     * sourced from the coordinator's nodeTokenSpend map. Present only when at
     * least one node recorded spend — the production reader of nodeTokenSpend
     * (otherwise a dead write). Counts/ids-only (§2.7). Mirrors nodeEffectiveness.
     */
    nodeTokenSpend?: Record<string, number>;
  };

  /** Node type driver reached a lifecycle phase (initialized, progress, completed, failed, aborted) */
  "graph:driver_lifecycle": {
    graphId: string;
    nodeId: string;
    typeId: string;
    phase: "initialized" | "progress" | "completed" | "partial_complete" | "failed" | "aborted";
  };
}
