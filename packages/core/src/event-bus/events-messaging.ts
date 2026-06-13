// SPDX-License-Identifier: Apache-2.0
import type { NormalizedMessage } from "../domain/normalized-message.js";
import type { SessionKey } from "../domain/session-key.js";
import type { ScriptClass } from "../text/script-classes.js";
import type {
  SubAgentSpawnPreparedEvent,
  SubAgentSpawnRejectedEvent,
  SubAgentSpawnStartedEvent,
  SubAgentResultCondensedEvent,
  SubAgentLifecycleEndedEvent,
} from "../domain/subagent-context-types.js";

/**
 * MessagingEvents: Message lifecycle, session, compaction, context, response, and command events.
 *
 * Find events by prefix: message:*, session:*, compaction:*, context:*, response:*, command:*
 */
export interface MessagingEvents {
  /** Incoming message received from a channel adapter */
  "message:received": { message: NormalizedMessage; sessionKey: SessionKey };

  /** Outgoing message sent through a channel */
  "message:sent": { channelId: string; messageId: string; content: string };

  /** Streaming token delta from an agent response */
  "message:streaming": {
    channelId: string;
    messageId: string;
    delta: string;
    accumulated: string;
  };

  /** New conversation session created */
  "session:created": { sessionKey: SessionKey; timestamp: number };

  /** Session expired and was cleaned up */
  "session:expired": { sessionKey: SessionKey; reason: string };

  // -------------------------------------------------------------------------
  // Cross-session messaging and sub-agent lifecycle events
  // -------------------------------------------------------------------------

  /** Cross-session message sent */
  "session:cross_send": {
    fromSessionKey: string;
    toSessionKey: string;
    mode: "fire-and-forget" | "wait" | "ping-pong";
    timestamp: number;
  };

  /** Cross-session ping-pong turn completed */
  "session:ping_pong_turn": {
    fromSessionKey: string;
    toSessionKey: string;
    turnNumber: number;
    totalTurns: number;
    tokensUsed: number;
    timestamp: number;
  };

  /** Sub-agent spawned (async) */
  "session:sub_agent_spawned": {
    runId: string;
    parentSessionKey: string;
    agentId: string;
    task: string;
    timestamp: number;
  };

  /** Sub-agent completed */
  "session:sub_agent_completed": {
    runId: string;
    agentId: string;
    success: boolean;
    runtimeMs: number;
    tokensUsed: number;
    cost: number;
    timestamp: number;
    /** Cache read tokens for this run. */
    cacheReadTokens?: number;
    /** Cache write tokens for this run. */
    cacheWriteTokens?: number;
  };

  /** Sub-agent session auto-archived */
  "session:sub_agent_archived": {
    runId: string;
    sessionKey: string;
    ageMs: number;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Subagent context lifecycle events
  // -------------------------------------------------------------------------

  /** Spawn packet built and ready for execution */
  "session:sub_agent_spawn_prepared": SubAgentSpawnPreparedEvent;

  /** Spawn denied due to depth or children limit */
  "session:sub_agent_spawn_rejected": SubAgentSpawnRejectedEvent;

  /** Spawn queued: children limit reached, waiting for slot */
  "session:sub_agent_spawn_queued": {
    runId: string;
    parentSessionKey: string;
    agentId: string;
    task: string;
    queuePosition: number;
    activeChildren: number;
    maxChildren: number;
    timestamp: number;
  };

  /** Subagent execution has begun */
  "session:sub_agent_spawn_started": SubAgentSpawnStartedEvent;

  /** Result went through condensation pipeline */
  "session:sub_agent_result_condensed": SubAgentResultCondensedEvent;

  /** Subagent fully complete (any end reason) */
  "session:sub_agent_lifecycle_ended": SubAgentLifecycleEndedEvent;

  // -------------------------------------------------------------------------
  // Compaction and response filtering events
  // -------------------------------------------------------------------------

  /** Auto-compaction started (context window approaching capacity) */
  "compaction:started": {
    agentId: string;
    sessionKey: SessionKey;
    timestamp: number;
  };

  /** Proactive compaction advice: SDK's shouldCompact() returned true after a turn */
  "compaction:recommended": {
    agentId: string;
    sessionKey: SessionKey;
    contextPercent: number;
    contextTokens: number;
    contextWindow: number;
    timestamp: number;
  };

  /** Pre-compaction memory flush performed */
  "compaction:flush": {
    sessionKey: SessionKey;
    memoriesWritten: number;
    trigger: "soft" | "hard" | "manual";
    success: boolean;
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Context engine lifecycle events
  // -------------------------------------------------------------------------

  /** Observation masker applied: old tool results replaced with placeholders */
  "context:masked": {
    agentId: string;
    sessionKey: string;
    maskedCount: number;
    totalChars: number;
    persistedToDisk: boolean;
    timestamp: number;
  };

  /** LLM compaction triggered: conversation summarized */
  "context:compacted": {
    agentId: string;
    sessionKey: string;
    fallbackLevel: 1 | 2 | 3;
    attempts: number;
    originalMessages: number;
    keptMessages: number;
    timestamp: number;
  };

  /** C4/S4: emitted when the compaction layer routes based on capabilityClass (pipeline or LCD).
   *  strategy="eviction" means no LLM summarization was used (deterministic fallback).
   *  securityPinnedCount = number of messages excluded from eviction by S4 pinning. */
  "context:compaction_routed": {
    agentId: string;
    sessionKey: string;
    capabilityClass: "frontier" | "mid" | "small" | "nano";
    strategy: "llm" | "eviction" | "strong-summarizer" | "deterministic";
    layer: "pipeline" | "lcd";
    securityPinnedCount: number;
    timestamp: number;
  };

  /** Post-compaction rehydration: critical context re-injected */
  "context:rehydrated": {
    agentId: string;
    sessionKey: string;
    sectionsInjected: number;
    filesInjected: number;
    skillsInjected: number;
    overflowStripped: boolean;
    timestamp: number;
  };

  /** Context overflow detected during rehydration recovery */
  "context:overflow": {
    agentId: string;
    sessionKey: string;
    contextTokens: number;
    budgetTokens: number;
    recoveryAction: "strip_files" | "strip_skills" | "remove_position1" | "remove_rehydration" | "none";
    timestamp: number;
  };

  /** Dead content evictor removed superseded tool results */
  "context:evicted": {
    agentId: string;
    sessionKey: string;
    evictedCount: number;
    evictedChars: number;
    categories: Record<string, number>;
    timestamp: number;
  };

  /** RETR-02 (Phase 173): the tiered margin arbiter allocated the discretionary
   *  history pool across tiers by fused rank (relevance-first classes only —
   *  frontier/mid never run the arbiter, so this event never fires for them).
   *  CONTENT-FREE (AGENTS.md §2.2/§2.7; T-173-03-04): per-tier kept COUNTS
   *  (`perTierKept` — e.g. { history, ltm, kg }), the discretionary pool TOKENS
   *  (offered AND consumed) + the floor-token weight, a `relevanceFirst` BOOLEAN,
   *  the kept LTM/KG ids + a timestamp ONLY. NEVER message, memory, or query content
   *  (ids are opaque memory keys, §2.2-safe). The emitter reuses the entry-clock read
   *  (no new ambient clock). A counts-only internal-health signal (same class as
   *  context:compaction_routed) — NOT a turn-level trajectory step.
   *
   *  WR-03/WR-02 (Phase 173-05): the payload now distinguishes the pool OFFERED
   *  (`discretionaryPoolTokens`) from the pool CONSUMED (`poolTokensUsed`) and carries
   *  the unconditional `floorTokens` weight, so an operator diagnosing a small-model
   *  context-exhaustion can see whether the S4-pinned floors dwarfed the pool. It also
   *  carries the `keptLtmIds`/`keptKgIds` the arbiter computes — the cross-tier winners
   *  an operator needs to reconstruct WHICH candidates won (the §2.7 reconstructable-from-
   *  events bar; empty on the C2 history-only assembly path until Phase 174 flows LTM/KG). */
  "context:arbitrated": {
    agentId: string;
    sessionKey: string;
    /** Per-tier kept counts, e.g. { history, ltm, kg } — counts only, never content. */
    perTierKept: Record<string, number>;
    /** The discretionary pool OFFERED (budget.availableHistoryTokens) to the arbiter. */
    discretionaryPoolTokens: number;
    /** WR-03: the discretionary pool CONSUMED (non-floor tokens actually allocated) — always
     *  ≤ discretionaryPoolTokens. Offered-vs-consumed is the small-model-exhaustion signal. */
    poolTokensUsed: number;
    /** WR-03: the UNCONDITIONAL floor weight (T0 fresh-tail + S4-pinned, step-atomic) that
     *  rides ON TOP of the pool — surfaced so blown-past-pool pinned floors are visible. */
    floorTokens: number;
    /** WR-02: the kept LTM candidate ids (content-free memory keys; empty pre-Phase-174). */
    keptLtmIds: string[];
    /** WR-02: the kept KG candidate ids (content-free memory keys; empty pre-Phase-174). */
    keptKgIds: string[];
    /** Whether the relevance-first arbiter path ran (always true when this fires). */
    relevanceFirst: boolean;
    timestamp: number;
  };

  /** Re-read detector found duplicate tool calls in session */
  "context:reread": {
    agentId: string;
    sessionKey: string;
    rereadCount: number;
    rereadTools: string[];
    timestamp: number;
  };

  /** DAG compaction completed: summary hierarchy updated (DAG mode only) */
  "context:dag_compacted": {
    conversationId: string;
    agentId: string;
    sessionKey: string;
    leafSummariesCreated: number;
    condensedSummariesCreated: number;
    maxDepthReached: number;
    totalSummariesCreated: number;
    durationMs: number;
    timestamp: number;
  };

  /** An in-session expansion tool (ctx_search/ctx_inspect/ctx_expand) recovered
   *  compressed detail (O1). Identifiers + the tool + a recovered/hit count +
   *  durationMs ONLY — NEVER message or summary content (the lossless store;
   *  AGENTS.md §2.2/§2.7). Distinct from context:reread (the re-read-loop
   *  detector) — this is a deliberate zoom into the DAG. */
  "context:dag_expanded": {
    conversationId: string;
    agentId: string;
    sessionKey: string;
    /** Closed union — the three in-session expansion tools. */
    tool: "ctx_search" | "ctx_inspect" | "ctx_expand";
    /** Recovered messages (ctx_expand) / hits (ctx_search) / inspected items (ctx_inspect). */
    recoveredCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** LCD entered a DEGRADED path (R3 + R1, Phase 132). A robustness/integrity
   *  signal — NOT a normal completion. Mirrors `context:dag_compacted`'s
   *  identifiers + durationMs, but carries a CLOSED-union `reason` instead of
   *  counts. Payload is identifiers + a reason + durationMs ONLY — NEVER message
   *  or summary content (the lossless store; AGENTS.md §2.2/§2.8).
   *  - `fail_closed_rollover`: an ambiguous/malformed scope refused the ingest
   *    write (132-04, R3) rather than silently reattaching to a prior conversation.
   *  - `serialized_wait`: an ingest/compaction write waited on the per-conversation
   *    single-flight serializer (132-04, R3) — reserved for the bounded-wait signal.
   *  - `breaker_open` / `spend_cap`: the summarizer circuit breaker opened or a
   *    per-tenant summarizer spend ceiling was hit (132-05, R1) — reserved here so
   *    the union is closed from the start (no later open-string widening).
   *  - `live_store_divergence`: the WR-01 afterTurn ingest skipped because the
   *    live message array is SHORTER than the LCD store high-water mark
   *    (`lcd-ingest.ts` divergence branch) — Phase 160 I1.
   *  - `leaf_window_divergence`: a leaf compaction pass skipped because the chunk
   *    message ids did not resolve to a `context_items` ordinal window
   *    (`lcd-compaction-trigger.ts`) — Phase 160 I1.
   *  - `condense_window_divergence`: a condense pass skipped on an inverted
   *    ordinal window (`lcd-condense-trigger.ts`) — Phase 160 I1. */
  "context:dag_degraded": {
    conversationId: string;
    agentId: string;
    sessionKey: string;
    /** Closed union — never an open string (AGENTS.md §2.8). The three
     *  `*_divergence` members (Phase 160 I1) widen the union with closed
     *  literals (the sanctioned §2.8 extension) so the LCD-divergence WARN sites
     *  emit this event for `health_signal` persistence. */
    reason:
      | "fail_closed_rollover"
      | "serialized_wait"
      | "breaker_open"
      | "spend_cap"
      | "live_store_divergence"
      | "leaf_window_divergence"
      | "condense_window_divergence"
      /** Phase 164 (RR6): a fresh/disjoint live transcript was detected (JSONL
       *  re-based) and the ingest continued appending at the store's current max
       *  seq — NOT a degradation, a correct continuation. Distinct from
       *  `live_store_divergence` (the genuine-shrink fail-safe) so operators can
       *  tell "continued after restart" from "skipped due to corruption". */
      | "session_rebase";
    durationMs: number;
    timestamp: number;
  };

  /** Per-LLM-call context budget equation from the LCD pre-flight fit check
   *  (W2 obs-llm-troubleshooting). Emitted once per runPreflightFitCheck —
   *  verdict "fits" | "downshifted" (thinking governor fired) | "exhausted"
   *  (ContextExhaustionError thrown right after). Bridged to the trajectory as
   *  `context.budget` so obs.explain can reconstruct WHY a context_exhausted
   *  turn aborted without grepping daemon-log DEBUG lines. Payload is
   *  identifiers + token counts + closed unions only — NO message text. */
  "context:budget_computed": {
    agentId: string;
    sessionKey: string;
    /** The EFFECTIVE window the fit check ran against (post capability-class cap). */
    windowTokens: number;
    /** The model's declared contextWindow before any cap (== windowTokens when uncapped). */
    rawContextWindowTokens: number;
    /** What clamped the window (closed union — never an open string). The cap
     *  members are contextEngine.budget.* knob names; "served" (KNOB-02) means
     *  the Ollama-served num_ctx bound the window (knobs: OLLAMA_CONTEXT_LENGTH
     *  env / Modelfile PARAMETER num_ctx); "capabilityClass" (WR-01) means the
     *  executor-side class cap from the operator's
     *  providers.entries.<id>.capabilities.capabilityClass pin bound — the pin
     *  is the lever (the budget knobs are inert on that branch). */
    windowCapSource: "effectiveContextCapSmall" | "effectiveContextCapNano" | "served" | "capabilityClass" | "none";
    /** S: system prompt + tool schemas estimate. */
    systemTokens: number;
    /** Estimated fresh-tail tokens (latest user message + preamble + pending tool results). */
    freshTailTokens: number;
    /** Token sum of the history items kept by budget eviction. */
    budgetedHistoryTokens: number;
    /** Count of history items kept by budget eviction (0 = model sees no history). */
    keptCount: number;
    /** S + kept history + fresh tail — what is actually dispatched to the LLM. */
    assembledInputTokens: number;
    /** Output headroom reserved at the final effective thinking level. */
    outputHeadroom: number;
    /** Fit-check outcome (closed union — never an open string). */
    verdict: "fits" | "downshifted" | "exhausted";
  };

  /** A non-Latin search returned zero hits on a CLEANLY-executed lane (OBS-01,
   *  Phase 180). The milestone's marquee failure mode — "Hebrew finds nothing" —
   *  made fleet-visible instead of DEBUG-only (the prior `cjkZeroHit` DEBUG line
   *  in ctx-search-tool.ts). Bridged to the trajectory as
   *  `context.script_zero_hit` (the explain timeline) AND persisted as a
   *  `health_signal` row (the fleet path); both paths are required (OBS-01).
   *  Payload is a closed `ScriptClass` enum + a closed lane union + identifiers
   *  ONLY — NEVER the query text or any tokens (I8; §2.7 the lossless store).
   *  Fires only when the lane executed cleanly: a `safeAll`-swallowed FTS5 syntax
   *  error is NOT a zero-hit and must not emit (signal purity, ROADMAP criterion 4). */
  "context:script_zero_hit": {
    conversationId: string;
    agentId: string;
    sessionKey: string;
    /** Closed union — dominant script class of the query (non-latin by construction). */
    scriptClass: ScriptClass;
    /** Which lane returned zero: word FTS, trigram twins, or the bounded normalized scan floor. */
    lane: "word" | "tri" | "scan";
    timestamp: number;
  };

  /** A summary's dominant script diverged from its source chunk's (OBS-01, Phase
   *  180): a non-Latin source produced a Latin summary. VISIBILITY ONLY — never
   *  gated (I8; a mixed code-heavy chunk legitimately skews Latin via the 0.3
   *  dominance threshold in `dominantScript`, so this is a count an operator
   *  reviews, not an error to block). Bridged to the trajectory as
   *  `context.summary_language_mismatch` AND persisted as a `health_signal` row;
   *  both paths required (OBS-01). Payload is closed `ScriptClass` enums + a depth
   *  count + identifiers ONLY — NEVER the summary or source body (§2.7). */
  "context:summary_language_mismatch": {
    agentId: string;
    sessionKey: string;
    sourceScript: ScriptClass;
    summaryScript: ScriptClass;
    /** dag depth (0 = leaf, >0 = condense); -1 = pipeline compaction (no depth concept). */
    depth: number;
    timestamp: number;
  };

  /** Context engine mode switched between pipeline and dag (one-time import cost).
   *  Carries the switch DIRECTION + the one-time reconciliation cost. Emitted on
   *  an ACTUAL direction change (not on a brand-new DAG-default conversation) from
   *  the @comis/agent reconciliation seam. Payload is identifiers + counts +
   *  durations only — NO message text (mirrors context:dag_compacted). */
  "context:mode_switched": {
    /** Engine mode before the switch (closed union — never an open string). */
    from: "pipeline" | "dag";
    /** Engine mode after the switch (closed union — never an open string). */
    to: "pipeline" | "dag";
    conversationId: string;
    agentId: string;
    sessionKey: string;
    /** true = full reconciliation import (empty DAG); false = incremental/gap-only. */
    fullImport: boolean;
    /** Messages imported on this switch (the one-time cost). */
    importedCount: number;
    durationMs: number;
    timestamp: number;
  };

  /** DAG integrity check completed with health report */
  "context:integrity": {
    conversationId: string;
    agentId: string;
    sessionKey: string;
    issueCount: number;
    repairsApplied: number;
    errorsLogged: number;
    issueTypes: string[];
    durationMs: number;
    timestamp: number;
  };

  /** Context engine pipeline run complete with all metrics */
  "context:pipeline": {
    agentId: string;
    sessionKey: string;
    tokensLoaded: number;
    tokensEvicted: number;
    tokensMasked: number;
    tokensCompacted: number;
    thinkingBlocksRemoved: number;
    budgetUtilization: number;
    evictionCategories: Record<string, number>;
    rereadCount: number;
    rereadTools: string[];
    sessionDepth: number;
    sessionToolResults: number;
    cacheHitTokens: number;
    cacheWriteTokens: number;
    cacheMissTokens: number;
    cacheFenceIndex?: number;
    durationMs: number;
    layerCount: number;
    /** Per-layer timing and message counts. */
    layers: Array<{
      name: string;
      durationMs: number;
      messagesIn: number;
      messagesOut: number;
    }>;
    timestamp: number;
  };

  /** Supplementary cache metrics for a context pipeline run, emitted post-LLM.
   *  The pre-LLM context:pipeline event carries non-cache metrics immediately.
   *  This event patches cache data once the API response is available. */
  "context:pipeline:cache": {
    agentId: string;
    sessionKey: string;
    cacheHitTokens: number;
    cacheWriteTokens: number;
    cacheMissTokens: number;
    timestamp: number;
  };

  /** Response filtered from channel delivery */
  "response:filtered": {
    channelId: string;
    suppressedBy: "NO_REPLY" | "HEARTBEAT_OK" | "SILENT" | "empty";
    timestamp: number;
  };

  /** Execution aborted by user /stop command or programmatic abort */
  "execution:aborted": {
    sessionKey: SessionKey;
    reason: "user_stop" | "budget_exceeded" | "circuit_breaker" | "max_steps" | "context_exhausted" | "pipeline_timeout" | "loop_detected";
    agentId: string;
    timestamp: number;
  };

  /** Budget trajectory warning: approaching token budget exhaustion */
  "execution:budget_warning": {
    agentId: string;
    sessionKey: string;
    totalTokens: number;
    llmCallCount: number;
    projectedCallsLeft: number;
    timestamp: number;
  };

  /** Prompt execution timed out (wall-clock timeout exceeded).
   *  LAT-04 (177-03): all post-v2.20 fields are optional — old rows and
   *  legacy emitters stay valid. Content-free by construction: numbers,
   *  closed enums, and the pre-rendered config-KEY string only. */
  "execution:prompt_timeout": {
    agentId: string;
    sessionKey: string;
    timeoutMs: number;
    timestamp: number;
    /** Elapsed wall-clock ms at kill (clock.now() - retryStartMs). */
    durationMs?: number;
    /** Which limit fired: stall budget vs makespan ceiling. Absent = whole-turn (retry-path/pre-LAT-02 rows). */
    limit?: "stall" | "makespan";
    /** Binding resolution level (LAT-01). */
    source?: "operation_explicit" | "operation_default" | "agent_config" | "builtin_default" | "graph_constant";
    /** Pre-rendered config-key string (content-free — knob NAME + ids only, never values/bodies). */
    bindingKnob?: string;
    operationType?: string;
    stallBudgetMs?: number;
    makespanMs?: number;
  };

  /** Output escalation triggered: LLM hit max_tokens and retry is being attempted with higher output budget */
  "execution:output_escalated": {
    agentId: string;
    sessionKey: string;
    originalMaxTokens: number;
    escalatedMaxTokens: number;
    timestamp: number;
  };

  /** Signed-replay self-heal fired: provider rejected stored signed thinking /
   *  reasoning state on the latest assistant turn (Anthropic `cannot be
   *  modified`, Gemini `thought_signature mismatch`, OpenAI Responses
   *  `reasoning_item not found`, OpenAI Completions `reasoning_id expired`,
   *  Mistral `encrypted_content verification failed`, etc.). The runner in
   *  `executor-prompt-runner.ts` scrubbed signed thinking state from the
   *  in-memory message array and re-entered the model retry chain. `succeeded`
   *  reports whether the retry produced a non-empty response. */
  "execution:signed_replay_recovered": {
    agentId: string;
    sessionKey: string;
    blocksRemoved: number;
    thoughtSignaturesStripped: number;
    succeeded: boolean;
    timestamp: number;
  };

  /** GBNF-02 self-heal fired: the provider rejected the tool JSON Schema at
   *  grammar-compile/unmarshal time (llama.cpp "JSON schema conversion
   *  failed", Ollama Go-side tools unmarshal). The runner stripped
   *  pattern/format from the named session-held tool schemas and retried
   *  exactly once per session ('retried' false when nothing was strippable).
   *  Payload is content-free: tool + keyword NAMES only, never schema bodies
   *  (I7). 'succeeded' reports whether the retry produced a non-empty
   *  response. 'reason' discriminates the branch (175-REVIEW WR-05 — the two
   *  terminal branches were otherwise byte-identical and the obs verdict
   *  misdirected the operator): "stripped" = strip applied + one retry fired;
   *  "nothing_to_strip" = no pattern/format anywhere, futile retry skipped;
   *  "gate_closed" = the session's single strip-retry was already consumed
   *  earlier (a repair WAS attempted this session). */
  "execution:tool_schema_unsupported": {
    agentId: string;
    sessionKey: string;
    toolNames: string[];
    strippedKeywords: string[];
    retried: boolean;
    succeeded: boolean;
    reason: "stripped" | "nothing_to_strip" | "gate_closed";
    timestamp: number;
  };

  // -------------------------------------------------------------------------
  // Dead-letter queue events
  // -------------------------------------------------------------------------

  /** Failed announcement persisted to dead-letter queue */
  "announcement:dead_lettered": {
    runId: string;
    channelType: string;
    reason: string;
    timestamp: number;
  };

  /** Dead-letter entry successfully delivered on retry */
  "announcement:dead_letter_delivered": {
    runId: string;
    channelType: string;
    attemptCount: number;
    timestamp: number;
  };
}
