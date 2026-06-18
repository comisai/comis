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
 * per-node token-budget breach. `pipeline:authored` (P1/TELEM-01) is the
 * authoring half of the same graph subsystem — a counts-only signal per
 * `pipeline` tool invocation. `graph:repaired` (P2/AUTHOR-01) and
 * `graph:synthesized_from_intent` (P2/AUTHOR-02) are the audit half — one
 * counts-only signal per conservative repair / intent-synthesis (the producers
 * the P1 `repaired` flag documented as deferred).
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

  /**
   * A transient sub-agent completion delivery failed and was retried (DELIVERY-02/03).
   * Counts/ids only — NEVER announcement text or the error string (AGENTS.md §2.7).
   * Mirrors subagent:budget_exceeded's counts/ids/typed-tag discipline.
   */
  "subagent:delivery_retried": {
    runId: string;
    channelType: string;
    /** 1-based retry attempt number. */
    attempt: number;
    /** Closed-union tag: a retry is always for a transient failure. */
    transient: true;
    timestamp: number;
  };

  /**
   * A sub-agent completion delivery was dead-lettered after exhausting retries
   * (transient) or immediately (permanent) (DELIVERY-02/03). Counts/ids only (§2.7) —
   * NEVER announcement text or the error string.
   */
  "subagent:delivery_deadlettered": {
    runId: string;
    channelType: string;
    /** Attempts made before dead-lettering (0 for an immediate permanent dead-letter). */
    attempt: number;
    /** Closed-union tag: was the underlying failure classified transient (retries exhausted) or permanent (immediate). */
    transient: boolean;
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

  /**
   * P1/TELEM-01: a `pipeline` tool invocation was authored — counts-only.
   * Emitted DAEMON-SIDE (the graph.define / graph.execute handlers, Plan 02)
   * where schema validity is determined (the buildGraphInput parse + validate)
   * and the resolved capabilityClass arrives. Mirrors the
   * memory:generation_quality triple (event -> health_signal row -> fleet
   * finding). NEVER a pipeline body, a type_config value, a node task/label, or
   * a secret (AGENTS.md §2.7) — closed enums + booleans only; every payload is
   * reconstructable from the bus alone.
   *
   * `repaired` is ALWAYS false at P1: the repair producer is Phase 174 /
   * AUTHOR-01 (the graph-helpers.ts fail-closed weak-model throw, UNWIRED here).
   * The field exists so the SAME event is unchanged when P2 lands.
   */
  "pipeline:authored": {
    /** The pipeline action authored (closed union — define | execute). */
    action: "define" | "execute";
    /** The calling model's resolved tier; "unknown" when the tier cannot be resolved (Pitfall 2 — record honestly, never silently drop). */
    capabilityClass: "frontier" | "mid" | "small" | "nano" | "unknown";
    /** Did the call parse + validate against the graph schema (buildGraphInput)? */
    schemaValid: boolean;
    /** P1: ALWAYS false (the repair producer is deferred to Phase 174 / AUTHOR-01). */
    repaired: boolean;
    agentId?: string;
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * AUTHOR-01 (v2.27 P2, Phase 174): a weak-model + schema-invalid pipeline graph
   * was conservatively REPAIRED to a canonical template (deterministic
   * template-match + fillDagTemplate). Emitted DAEMON-SIDE (the graph-helpers.ts
   * repair path, Plan 03) — the producer the P1 `pipeline:authored.repaired` flag
   * documented as deferred. Counts/ids/enums ONLY — NEVER the graph body, task
   * text, type_config value, or a secret (AGENTS.md §2.7). `pattern` is the matched
   * canonical template (closed enum); the repaired graph then flows through the
   * SAME governance as a hand-authored one. Every payload is reconstructable from
   * the bus alone.
   */
  "graph:repaired": {
    /** The matched canonical template (closed enum). */
    pattern: "research-fanout" | "debate" | "vote" | "map-reduce";
    /** Node count of the repaired graph. */
    nodeCount: number;
    /** Calling agent's resolved tier (server-side; "unknown" when unmapped — record honestly, never silently drop). */
    capabilityClass: "frontier" | "mid" | "small" | "nano" | "unknown";
    agentId?: string;
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * AUTHOR-02 (v2.27 P2, Phase 174): a graph was SYNTHESIZED from a one-line intent
   * via the `from_intent` action (deterministic canonical-template expansion).
   * Emitted DAEMON-SIDE (Plan 04). Counts/ids/enums ONLY — NEVER the intent text,
   * agent names, or task bodies (AGENTS.md §2.7); the intent text is the highest-risk
   * leak and is intentionally absent. The synthesized graph flows through the SAME
   * governance as a hand-authored one (it is never executed directly).
   */
  "graph:synthesized_from_intent": {
    /** The requested canonical pattern (closed enum). */
    pattern: "research-fanout" | "debate" | "vote" | "map-reduce";
    /** Node count of the synthesized graph. */
    nodeCount: number;
    agentId?: string;
    sessionKey?: string;
    timestamp: number;
  };
}
