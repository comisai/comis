import type { NormalizedMessage } from "../domain/normalized-message.js";
import type { SessionKey } from "../domain/session-key.js";
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
    reason: "user_stop" | "budget_exceeded" | "circuit_breaker" | "max_steps" | "context_exhausted" | "pipeline_timeout";
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

  /** Prompt execution timed out (wall-clock timeout exceeded) */
  "execution:prompt_timeout": {
    agentId: string;
    sessionKey: string;
    timeoutMs: number;
    timestamp: number;
  };

  /** Output escalation triggered: LLM hit max_tokens and retry is being attempted with higher output budget */
  "execution:output_escalated": {
    agentId: string;
    sessionKey: string;
    originalMaxTokens: number;
    escalatedMaxTokens: number;
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
