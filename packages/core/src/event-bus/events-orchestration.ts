// SPDX-License-Identifier: Apache-2.0
/**
 * OrchestrationEvents: multi-agent graph orchestration lifecycle events
 * (graph:* + subagent:*).
 *
 * Extracted from AgentEvents so the graph coordinator's
 * lifecycle surface lives as one cohesive domain group — mirroring how
 * TerminalEvents / MediaGenerationEvents are their own sub-interfaces folded
 * into EventMap. The graph engine emits a start signal, a per-node transition,
 * a terminal completion, a typed-driver lifecycle phase, and a
 * per-node token-budget breach. `pipeline:authored` is the
 * authoring half of the same graph subsystem — a counts-only signal per
 * `pipeline` tool invocation. `graph:repaired` and
 * `graph:synthesized_from_intent` are the audit half — one
 * counts-only signal per conservative repair / intent-synthesis.
 *
 * Counts / ids / typed enums ONLY — NEVER task text, sub-agent output, or
 * response bodies. The breach event (`subagent:budget_exceeded`) carries the
 * two token numbers and the ids and nothing else (AGENTS.md §2.7); every
 * payload is reconstructable from the bus alone. `subagent:steered`
 * is the in-flight-steer half of the same sub-agent
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

  /**
   * A graph DAG node was spawned. Bridged to
   * the trajectory (`graph.node_spawned`) so `comis explain`'s spawn-tree
   * reconstructs each node as a leaf — a graph node spawns in-process and never
   * crosses the socket chokepoint that emits `capability:audited`, so without this
   * the spawn-tree showed only the root. Content-free: graph/node ids + the child
   * agentId + the tree-stable rootRunId + the per-node token cap ONLY (counts/ids,
   * §2.7) — NEVER the node task or output.
   */
  "graph:node_spawned": {
    graphId: string;
    nodeId: string;
    /** The tree-stable graph root every node shares. */
    rootRunId: string;
    /** The node's CHILD agent (node.agentId ?? defaultAgentId). */
    agentId: string;
    /** The resolved per-node token cap, or null when unbounded. */
    tokenBudget: number | null;
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
    /** Per-node token spend for the completed node. */
    tokensUsed?: number;
    /** Per-node cost for the completed node. */
    cost?: number;
    timestamp: number;
  };

  /**
   * A graph node's sub-agent exceeded its per-node token budget.
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
     * Which resolution source produced the breached cap (in precedence order) —
     * the node's own `tokenBudget`, the operator default
     * `security.agentToAgent.tokenBudget`, or the graph-budget inherit-share. A
     * closed-union enum tag (counts/ids-only, safe under §2.7) so an operator can
     * tell WHICH knob bound the node, not just THAT it was bounded.
     */
    capSource: "node" | "operator-default" | "inherit-share";
    timestamp: number;
  };

  /**
   * The per-capability authorization decision
   * (allow + deny) for a gated call, emitted at the single chokepoint
   * (rpc-dispatch.ts in-process; setup-capability-endpoint.ts socket). SEPARATE
   * from `audit:event` (the durable audit trail) — this one bridges to the
   * trajectory (`capability.audited`) as the spawn-tree's per-node producer
   * (the spawn-tree fold groups these by leaseId, beside subagent:budget_exceeded).
   * One chokepoint emits BOTH. Content-free by construction:
   * ids/caps/tool-NAME/method/decision ONLY — NO args/body/param field, so a
   * careless emit cannot leak the tool.invoke args/a body/a secret. Asymmetry:
   * in-process has NO lease → leaseId/parentLeaseId/tool ABSENT, rootRunId
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
    /** The real lease id (socket). ABSENT in-process — never fabricated. */
    leaseId?: string;
    /** The parent lease id (socket, when present) — the spawn-tree parent edge. */
    parentLeaseId?: string;
  };

  /**
   * A running sub-agent was steered IN-FLIGHT —
   * a high-priority message injected at the child's next step boundary
   * (transcript + progress preserved) instead of a kill+respawn. Emitted
   * DAEMON-SIDE at the inject site (subagent-handlers.ts /
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
   * A transient sub-agent completion delivery failed and was retried.
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
   * (transient) or immediately (permanent). Counts/ids only (§2.7) —
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
    /** Aggregate cache read tokens across all graph nodes. */
    graphCacheReadTokens?: number;
    /** Aggregate cache write tokens across all graph nodes. */
    graphCacheWriteTokens?: number;
    /** Cache effectiveness ratio (reads / (reads + writes)). */
    graphCacheEffectiveness?: number;
    /** Per-node cache effectiveness breakdown. */
    nodeEffectiveness?: Record<string, number>;
    /**
     * Per-node token-spend breakdown (nodeId → tokens) for the run,
     * sourced from the coordinator's nodeTokenSpend map. Present only when at
     * least one node recorded spend — the production reader of nodeTokenSpend
     * (otherwise a dead write). Counts/ids-only (§2.7). Mirrors nodeEffectiveness.
     */
    nodeTokenSpend?: Record<string, number>;
    /**
     * Per-node CUMULATIVE corrected-$ cost ledger (nodeId → dollars)
     * for the run, sourced from the coordinator's nodeCost map (each node's
     * summed event.cost — the same corrected dollars feeding the graph-wide
     * total). The subtree rollup (computeSubtreeCost) derives a node + its
     * descendants from this. Present only when at least one node recorded cost.
     * Content-free (nodeId → number); the web-UI billing view consumes it.
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
   * A `pipeline` tool invocation was authored — counts-only.
   * Emitted DAEMON-SIDE (the graph.define / graph.execute handlers)
   * where schema validity is determined (the buildGraphInput parse + validate)
   * and the resolved capabilityClass arrives. Mirrors the
   * memory:generation_quality triple (event -> health_signal row -> fleet
   * finding). NEVER a pipeline body, a type_config value, a node task/label, or
   * a secret (AGENTS.md §2.7) — closed enums + booleans only; every payload is
   * reconstructable from the bus alone.
   *
   * `repaired` is ALWAYS false at this emit site: the conservative-repair
   * producer (the graph-helpers.ts repair path) signals via the dedicated
   * `graph:repaired` event instead of flipping this flag.
   */
  "pipeline:authored": {
    /** The pipeline action authored (closed union — define | execute). */
    action: "define" | "execute";
    /** The calling model's resolved tier; "unknown" when the tier cannot be resolved (record honestly, never silently drop). */
    capabilityClass: "frontier" | "mid" | "small" | "nano" | "unknown";
    /** Did the call parse + validate against the graph schema (buildGraphInput)? */
    schemaValid: boolean;
    /** ALWAYS false here — a conservative repair is signalled via `graph:repaired` instead. */
    repaired: boolean;
    agentId?: string;
    sessionKey?: string;
    timestamp: number;
  };

  /**
   * A weak-model + schema-invalid pipeline graph
   * was conservatively REPAIRED to a canonical template (deterministic
   * template-match + fillDagTemplate). Emitted DAEMON-SIDE (the graph-helpers.ts
   * repair path) — the dedicated repair signal beside the counts-only
   * `pipeline:authored`. Counts/ids/enums ONLY — NEVER the graph body, task
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
   * A graph was SYNTHESIZED from a one-line intent
   * via the `from_intent` action (deterministic canonical-template expansion).
   * Emitted DAEMON-SIDE. Counts/ids/enums ONLY — NEVER the intent text,
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
   * A durable run did NOT resume after a restart —
   * the boot/watchdog resume pass orphaned it (durable-resume-engine.ts orphan()).
   * Emitted DAEMON-SIDE; bridges to a content-free `health_signal` obs row
   * (obs-autonomy-rows.ts) so `comis fleet` surfaces an orphaned-run count.
   * Content-free by construction: the `reason` is a CLOSED enum —
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
   * A durable run resumed in-flight after a restart (the resume pass
   * rehydrated it from its checkpoint). Counts/ids only (§2.7) — the numeric
   * stepIndex is the resumed checkpoint position, never a body.
   */
  "durable:resumed": { rootRunId: string; stepIndex: number; timestamp: number };

  /**
   * A capability lease (or a whole spawn tree) was cooperatively
   * REVOKED (lease.revoke). Carries the revoked COUNT + the rootRunId (an id) +
   * timestamp ONLY — NEVER the lease bearer, selector, or any body.
   */
  "autonomy:revoked": { rootRunId: string; revoked: number; timestamp: number };

  /**
   * A spawn tree was HARD-killed (run.kill). DISTINCT from revoke —
   * kill flips durable status to 'revoked' INDISTINGUISHABLY from a cooperative
   * revoke in the table, so the separate EVENT is the only way to count killed
   * separately. Carries the killed COUNT + rootRunId + timestamp ONLY.
   */
  "autonomy:killed": { rootRunId: string; killed: number; timestamp: number };

  /**
   * A capability-DENIAL breaker tripped — N
   * consecutive floor-blocks aborted + killed the run tree (rpc-dispatch.ts, beside
   * the `execution:aborted{reason:"denial_breaker"}` emit). DISTINCT from both the
   * TOOL-failure breaker (`execution:aborted{reason:"circuit_breaker"}` → the
   * session-rollup `breakerTripCount` → `breakerTripTotal`) and from kill/revoke:
   * the denial-breaker abort is NEVER a session endReason and NEVER a
   * breakerTripCount, so this dedicated event is the ONLY fleet-ingestion path for
   * it — without it the trip is invisible to `comis fleet` (the aborted run lands
   * in durable status 'completed', so it shows
   * 0 in orphaned/revoked/killed/breakerTrips too). Carries the rootRunId (an id) +
   * timestamp ONLY — NEVER the engine's free-text deny reason (which stays on the
   * escalate/WARN at the source). Each trip is one event (the count is the row count).
   */
  "autonomy:denial_breaker_tripped": { rootRunId: string; timestamp: number };

  /**
   * A completed `orchestrate` run — the content-free per-run summary
   * every `comis explain` / `comis fleet` consumer reads. Emitted from the
   * `orchestrate` TOOL (agent-side, where the threaded eventBus reaches the live
   * per-session trajectory bridge), NOT a daemon graph handler — the per-session
   * recordEvent on the graph-handler deps is a permanent no-op. Timing is safe:
   * the bridge attaches at execute() START; this fires at run COMPLETION.
   *
   * Content-free by construction (AGENTS §2.7): ids + closed enums + counts +
   * token ESTIMATES + a bounded cap-mapped tool-NAME sequence only. `failureClass` is a CLOSED union — the free-text
   * failure reason (stderr tail, thrown message) is mapped to a member BEFORE the
   * emit and stays ONLY on the bounded tool-error surface (the runner's
   * STDERR_TAIL_MAX_CHARS tail), NEVER on the bus. The bus never carries the
   * stderr tail, the script body, or the tool params.
   *
   * Self-attributing: `rootRunId` + `sessionKey` ride the payload so a
   * daemon-shared-bus event lands on the right session's report (the
   * `capability:audited` precedent) — never inferred from ambient state. The
   * per-run child `leaseId` (absent only when no lease was minted) is the
   * unforgeable per-run correlator every downstream fold groups on.
   */
  "orchestrate:run_summary": {
    /** The runner's per-run id (`orch-<ts36>-<rand>`). */
    runId: string;
    /** The per-run child leaseId — the per-run correlator. Absent only if no lease was minted. */
    leaseId?: string;
    /** The tree-stable root the run's lease inherits — an attribution key (the bus fans out to every session bridge). */
    rootRunId: string;
    /** The owning session — an attribution key. Absent for a heartbeat/cron run with no session. */
    sessionKey?: string;
    /**
     * The owning TURN's trace correlator — distinct from `runId`/`rootRunId`
     * (the orchestrate-RUN ids). Carried so the learning ledger keys the
     * descriptor row on the turn trajectory. Content-free: a UUID correlator, the
     * same class as `rootRunId`/`sessionKey`. Absent outside a request scope.
     */
    traceId?: string;
    /** The script language (mirrors the orchestrate `language` param). */
    language: "ts" | "js" | "py";
    /** Wall-clock duration of the run (ms). */
    durationMs: number;
    /** The jailed child's process exit code (0 on success; the real code on a non-zero exit; a sentinel on kill/spawn-fail). */
    exitCode: number;
    /**
     * CLOSED enum — the run's degradation class, or ABSENT on a clean run. NOT
     * the engine's free text (a stderr tail / thrown message is mapped to a
     * member before emit and stays on the tool-error surface).
     */
    failureClass?: "timeout" | "stdout_cap" | "nonzero_exit" | "spawn_fail" | "lease_absent";
    /** Pre-bounce raw stdout byte length. */
    stdoutBytesRaw: number;
    /** POST-bounce stdout char count — the tokens that actually re-entered context (the SAVE-01 actual). */
    stdoutCharsReentered: number;
    /** Count of materialized ResultRef files the run produced. */
    resultRefCount: number;
    /** Total bytes of those materialized ResultRefs (the counterfactual input). */
    resultRefBytes: number;
    /** The labeled counterfactual token-savings ESTIMATE (materialized-bytes/4 − post-bounce/4). */
    estSavedTokens?: number;
    /** estSavedTokens / wouldBeTokens in [0,1]; absent/0 when nothing was materialized. */
    savedRatio?: number;
    /**
     * The run's bounded, content-free declared tool-NAME ORDERED call-site
     * sequence + counts from the pre-flight footprint — cap-mapped identifiers,
     * repeats = per-method counts, source-order, capped. Absent on a run with no
     * cap-mapped call sites. Like `capability:audited`'s `tool`, the NAMES are
     * safe; NEVER args/values/bodies.
     */
    toolSequence?: readonly string[];
    timestamp: number;
  };
}
