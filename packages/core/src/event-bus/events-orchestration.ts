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
 * payload is reconstructable from the bus alone. `subagent:steered`
 * (STEER-01, Phase 175) is the in-flight-steer half of the same sub-agent
 * lifecycle — a counts/ids/typed-enum-mode signal per real steer-inject (the
 * message body never crosses the bus).
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
   * AUDIT-01 / TREE (v2.29 Phase 215): the per-capability authorization decision
   * (allow + deny) for a gated call, emitted at the single chokepoint
   * (rpc-dispatch.ts in-process; setup-capability-endpoint.ts socket). SEPARATE
   * from `audit:event` (the durable AUDIT-02 trail) — this one bridges to the
   * trajectory (`capability.audited`) as the spawn-tree's per-node producer
   * (Plan 03's TREE fold groups these by leaseId, beside subagent:budget_exceeded).
   * One chokepoint emits BOTH. Content-free by construction (T-215-01):
   * ids/caps/tool-NAME/method/decision ONLY — NO args/body/param field, so a
   * careless emit cannot leak the tool.invoke args/a body/a secret. Asymmetry
   * (G1): in-process has NO lease → leaseId/parentLeaseId/tool ABSENT, rootRunId
   * is the synthetic `root-session-<key>`; the socket carries the full real tuple.
   * `decision` is a closed string-literal union (AGENTS §2.8).
   */
  "capability:audited": {
    timestamp: number;
    agentId: string;
    /** The required AgentCapability the method/tool maps to. */
    capability: string;
    /** The inner tool NAME (socket tool.invoke). Absent in-process / direct methods. */
    tool?: string;
    /** The dispatch method identifier (content-free — never a param value). */
    method: string;
    /** CLOSED union — the authorization outcome (§2.8). */
    decision: "allow" | "deny";
    /** ≈ the sessionKey/traceId. Absent when neither is available. */
    runId?: string;
    /** The tree-stable root (the real lease's rootRunId, or the synthetic in-process root). */
    rootRunId: string;
    /** The real lease id (socket). ABSENT in-process — never fabricated (G1). */
    leaseId?: string;
    /** The parent lease id (socket, when present) — the spawn-tree parent edge. */
    parentLeaseId?: string;
  };

  /**
   * STEER-01 (v2.27 P3, Phase 175): a running sub-agent was steered IN-FLIGHT —
   * a high-priority message injected at the child's next step boundary
   * (transcript + progress preserved) instead of today's kill+respawn. Emitted
   * DAEMON-SIDE at the inject site (Plan 02, subagent-handlers.ts /
   * sub-agent-runner.ts), gated behind `security.agentToAgent.steerInject`.
   * Counts/ids/typed-enum ONLY — NEVER the steer message body (AGENTS.md §2.7);
   * the message text is the highest-risk leak and is intentionally absent.
   * `mode` is the closed union naming which SDK primitive landed the inject
   * (`steer` when the child was streaming, `followup` when it was idle — the
   * channel-path streaming branch). Every payload is reconstructable from the
   * bus alone.
   */
  "subagent:steered": {
    /** The steered run id. */
    runId: string;
    /** The owning agent. */
    agentId: string;
    /** CLOSED union — which SDK primitive landed the inject (§2.8). */
    mode: "steer" | "followup";
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
    /**
     * COST-02: per-node CUMULATIVE corrected-$ cost ledger (nodeId → dollars)
     * for the run, sourced from the coordinator's nodeCost map (each node's
     * summed event.cost — the same corrected dollars feeding the graph-wide
     * total). The subtree rollup (computeSubtreeCost) derives a node + its
     * descendants from this. Present only when at least one node recorded cost.
     * Content-free (nodeId → number); the WEBUI-03 billing view consumes it.
     */
    nodeCost?: Record<string, number>;
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

  /**
   * FLEET-03 (v2.30 Phase 220): a durable run did NOT resume after a restart —
   * the boot/watchdog resume pass orphaned it (durable-resume-engine.ts orphan()).
   * Emitted DAEMON-SIDE; bridges to a content-free `health_signal` obs row
   * (obs-autonomy-rows.ts) so `comis fleet` surfaces an orphaned-run count.
   * Content-free by construction (T-220-01): the `reason` is a CLOSED enum —
   * the engine's free-text reason ("not resumable: status=…", "reread failed",
   * "invalid caps", "resume failed") is mapped to a member via the TOTAL
   * `orphanReasonToEnum` BEFORE the emit and stays ONLY on the WARN log / notify.
   * Mirrors `pipeline:authored`'s closed-enum-only discipline (§2.7).
   */
  "durable:orphaned": {
    rootRunId: string;
    /** CLOSED enum — NOT the engine's free text (durable-resume-engine.ts orphan reasons). */
    reason: "not_resumable" | "reread_failed" | "invalid_caps" | "resume_failed";
    timestamp: number;
  };

  /**
   * FLEET-03: a durable run resumed in-flight after a restart (the resume pass
   * rehydrated it from its checkpoint). Counts/ids only (§2.7) — the numeric
   * stepIndex is the resumed checkpoint position, never a body.
   */
  "durable:resumed": { rootRunId: string; stepIndex: number; timestamp: number };

  /**
   * FLEET-03: a capability lease (or a whole spawn tree) was cooperatively
   * REVOKED (lease.revoke). Carries the revoked COUNT + the rootRunId (an id) +
   * timestamp ONLY — NEVER the lease bearer, selector, or any body (T-220-02).
   */
  "autonomy:revoked": { rootRunId: string; revoked: number; timestamp: number };

  /**
   * FLEET-03: a spawn tree was HARD-killed (run.kill). DISTINCT from revoke —
   * kill flips durable status to 'revoked' INDISTINGUISHABLY from a cooperative
   * revoke in the table, so the separate EVENT is the only way to count killed
   * separately (RESEARCH OQ1). Carries the killed COUNT + rootRunId + timestamp ONLY.
   */
  "autonomy:killed": { rootRunId: string; killed: number; timestamp: number };

  /**
   * FLEET-02 (Phase 220-05): a Phase-217 capability-DENIAL breaker tripped — N
   * consecutive floor-blocks aborted + killed the run tree (rpc-dispatch.ts, beside
   * the `execution:aborted{reason:"denial_breaker"}` emit). DISTINCT from both the
   * TOOL-failure breaker (`execution:aborted{reason:"circuit_breaker"}` → the
   * session-rollup `breakerTripCount` → `breakerTripTotal`) and from kill/revoke:
   * the denial-breaker abort is NEVER a session endReason and NEVER a
   * breakerTripCount, so this dedicated event is the ONLY fleet-ingestion path for
   * it — without it the trip is invisible to `comis fleet` (the milestone-audit
   * FLEET-02 gap; the aborted run lands in durable status 'completed', so it shows
   * 0 in orphaned/revoked/killed/breakerTrips too). Carries the rootRunId (an id) +
   * timestamp ONLY — NEVER the engine's free-text deny reason (which stays on the
   * escalate/WARN at the source). Each trip is one event (the count is the row count).
   */
  "autonomy:denial_breaker_tripped": { rootRunId: string; timestamp: number };
}
