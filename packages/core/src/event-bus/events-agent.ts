// SPDX-License-Identifier: Apache-2.0
/**
 * AgentEvents: Skill, tool, model, audit, observability (token/latency), and graph lifecycle events.
 *
 * Find events by prefix: skill:*, tool:*, model:*, audit:*, observability:*, graph:*
 */
import type { NodeStatus, GraphStatus } from "../domain/execution-graph.js";

export interface AgentEvents {
  /** Skill loaded from disk and validated */
  "skill:loaded": { skillName: string; source: string; timestamp: number };

  /** Skill executed in sandbox */
  "skill:executed": { skillName: string; durationMs: number; success: boolean; timestamp: number };

  /** Skill rejected during scan (security violations) */
  "skill:rejected": { skillName: string; reason: string; violations: string[]; timestamp: number };

  /** Prompt skill body loaded and sanitized */
  "skill:prompt_loaded": {
    skillName: string;
    source: string;
    bodyLength: number;
    timestamp: number;
  };

  /** Prompt skill invoked (injected into system prompt) */
  "skill:prompt_invoked": {
    skillName: string;
    invokedBy: "user" | "model";
    args: string;
    timestamp: number;
  };

  /** Skill registry reset (init() cleared caches and re-discovered) */
  "skill:registry_reset": {
    clearedMetadata: number;
    clearedPromptCache: number;
    timestamp: number;
  };

  /** Skills reloaded after file watcher detected changes */
  "skills:reloaded": {
    agentId: string;
    skillCount: number;
    timestamp: number;
  };

  /** Skill created via skills_manage create action */
  "skill:created": {
    skillName: string;
    scope: "local" | "shared";
    agentId: string;
    timestamp: number;
  };

  /** Skill updated via skills_manage update action */
  "skill:updated": {
    skillName: string;
    scope: "local" | "shared";
    agentId: string;
    timestamp: number;
  };

  /** Skill operation failed at runtime — distinct from skill:rejected which is security scan */
  "skill:failed": {
    skillName: string;
    error: string;
    phase: "create" | "update" | "load" | "scan";
    agentId?: string;
    timestamp: number;
  };

  /** Tool invocation started (builtin, platform, or skill-based) */
  "tool:started": {
    toolName: string;
    toolCallId: string;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
    /** Human-readable activity label for exec commands. */
    description?: string;
  };

  /** Tool invocation completed (builtin, platform, or skill-based) */
  "tool:executed": {
    toolName: string;
    durationMs: number;
    success: boolean;
    timestamp: number;
    userId?: string;
    traceId?: string;
    agentId?: string;
    sessionKey?: string;
    params?: Record<string, unknown>;
    /** Truncated error message when success=false (max 1500 chars). */
    errorMessage?: string;
    /** Error classification: "timeout" for abort signal, "internal" for other failures. */
    errorKind?: string;
    /** Human-readable activity label for exec commands. */
    description?: string;
    /** Whether the tool result was truncated by per-tool maxChars or per-turn budget. */
    truncated?: boolean;
    /** Original character count before truncation. Only present when truncated=true. */
    fullChars?: number;
    /** Character count after truncation. Only present when truncated=true. */
    returnedChars?: number;
  };

  /** Tools filtered out by policy before execution (debugging/audit) */
  "tool:policy_filtered": {
    profile: string;
    agentId?: string;
    filtered: Array<{ toolName: string; reason: string }>;
    timestamp: number;
  };

  /** Audit log event for compliance and security monitoring */
  "audit:event": {
    timestamp: number;
    agentId: string;
    tenantId: string;
    actionType: string;
    classification: string;
    outcome: "success" | "failure" | "denied";
    metadata?: Record<string, unknown>;
  };

  /** Token usage recorded for an LLM call */
  "observability:token_usage": {
    timestamp: number;
    traceId: string;
    agentId: string;
    channelId: string;
    executionId: string;
    provider: string;
    model: string;
    tokens: { prompt: number; completion: number; total: number };
    cost: {
      input: number;
      output: number;
      cacheRead: number;     // from SDK usage.cost.cacheRead
      cacheWrite: number;    // from SDK usage.cost.cacheWrite
      total: number;
    };
    latencyMs: number;
    /** Tokens read from provider cache (e.g., Anthropic prompt caching). 0 if not applicable. */
    cacheReadTokens: number;
    /** Tokens written to provider cache. 0 if not applicable. */
    cacheWriteTokens: number;
    /** Session key for per-session aggregation. Forwarded from execution context. */
    sessionKey: string;
    /** Net $ saved vs if all cached tokens were charged at regular input rate.
     *  Positive = caching saved money; negative = cache write investment exceeds read savings.
     *  0 when provider doesn't support caching, zero cache activity, or unknown model pricing. */
    savedVsUncached: number;
    /** Whether this provider supports prompt caching. */
    cacheEligible: boolean;
    /** Provider-specific response ID for log correlation (R-04). undefined when provider doesn't supply it. */
    responseId?: string;
    /** Per-TTL cache creation breakdown (R-08 pre-work). undefined until upstream pi-mono surfaces it. */
    cacheCreation?: {
      shortTtl: number;
      longTtl: number;
    };
  };

  /** Cache break detected: prompt cache invalidation with attribution.
   *  Emitted when cacheRead tokens drop significantly between consecutive LLM calls. */
  "observability:cache_break": {
    provider: string;
    reason: string;
    tokenDrop: number;
    tokenDropRelative: number;
    previousCacheRead: number;
    currentCacheRead: number;
    callCount: number;
    changes: {
      systemChanged: boolean;
      toolsChanged: boolean;
      metadataChanged: boolean;
      modelChanged: boolean;
      retentionChanged: boolean;
      addedTools: string[];
      removedTools: string[];
      changedSchemaTools: string[];
      headersChanged: boolean;
      extraBodyChanged: boolean;
    };
    toolsChanged: string[];
    ttlCategory: string | undefined;
    agentId: string;
    sessionKey: string;
    timestamp: number;
    /** Tools added since previous turn. */
    toolsAdded?: string[];
    /** Tools removed since previous turn. */
    toolsRemoved?: string[];
    /** Tools whose schema changed since previous turn. */
    toolsSchemaChanged?: string[];
    /** Character count delta in system prompt (current - previous). */
    systemCharDelta?: number;
    /** Model ID that triggered the break. */
    model?: string;
    /** Effort/thinking value at time of break. */
    effortValue?: string;
  };

  /** Latency recorded for an operation */
  "observability:latency": {
    operation: "llm_call" | "tool_execution" | "memory_search";
    durationMs: number;
    timestamp: number;
    metadata?: Record<string, unknown>;
  };

  /** Model failover: attempt to switch from one model to another */
  "model:fallback_attempt": {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    error: string;
    attemptNumber: number;
    timestamp: number;
  };

  /** Model failover: all candidates exhausted */
  "model:fallback_exhausted": {
    provider: string;
    model: string;
    totalAttempts: number;
    timestamp: number;
  };

  /** Last-known-working model fallback: attempt to use a recently successful model */
  "model:lkw_fallback_attempt": {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    timestamp: number;
  };

  /** Last-known-working model fallback: LKW model succeeded */
  "model:lkw_fallback_succeeded": {
    provider: string;
    model: string;
    timestamp: number;
  };

  /** Auth profile entered cooldown after failure */
  "model:auth_cooldown": {
    keyName: string;
    provider: string;
    cooldownMs: number;
    failureCount: number;
    timestamp: number;
  };

  /** Model catalog loaded from pi-ai static registry */
  "model:catalog_loaded": {
    providerCount: number;
    modelCount: number;
    timestamp: number;
  };

  /** Prompt injection attempt detected in user input or external content */
  "security:injection_detected": {
    timestamp: number;
    source: "user_input" | "tool_output" | "external_content" | "memory_write" | "workspace_file";
    patterns: string[];
    riskLevel: "low" | "medium" | "high";
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Injection rate limit exceeded for a session */
  "security:injection_rate_exceeded": {
    timestamp: number;
    sessionKey: string;
    count: number;
    threshold: number;
    action: "warn" | "reinforce" | "terminate";
  };

  /** Sender trust level resolved for display (audit trail) */
  "sender:trust_resolved": {
    agentId: string;
    senderId: string;
    trustLevel: string;
    displayMode: string;
    sessionKey: string;
    timestamp: number;
  };

  /** Memory write blocked or downgraded due to suspicious content */
  "security:memory_tainted": {
    timestamp: number;
    agentId: string;
    originalTrustLevel: string;
    adjustedTrustLevel: string;
    patterns: string[];
    blocked: boolean;
  };

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
  };

  /** Node type driver reached a lifecycle phase (initialized, progress, completed, failed, aborted) */
  "graph:driver_lifecycle": {
    graphId: string;
    nodeId: string;
    typeId: string;
    phase: "initialized" | "progress" | "completed" | "partial_complete" | "failed" | "aborted";
  };

  /** Provider declared degraded based on cross-agent failure aggregation */
  "provider:degraded": { provider: string; failingAgents: number; timestamp: number };

  /** Provider recovered after successful call during degraded state */
  "provider:recovered": { provider: string; timestamp: number };

  /** SEP extracted a plan from the LLM's first response */
  "sep:plan_extracted": {
    agentId: string;
    sessionKey: string;
    stepCount: number;
    timestamp: number;
  };

  /** SEP plan completed (all steps resolved). Observability-only post-L4 —
   *  the legacy enforcement nudge was replaced by the post-batch
   *  continuation handler. */
  "sep:plan_completed": {
    agentId: string;
    sessionKey: string;
    stepsPlanned: number;
    stepsCompleted: number;
    stepsSkipped: number;
    durationMs: number;
    timestamp: number;
  };

  /** Exec command blocked by validation pipeline */
  "command:blocked": {
    agentId: string;
    /** First 200 chars of command (defense-in-depth for logs) */
    commandPrefix: string;
    reason: string;
    /** Which validation step blocked it */
    blocker: "sanitize" | "substitution" | "pipe" | "denylist" | "path" | "redirect" | "env"
      | "ifs" | "zsh" | "brace" | "proc" | "desync";
    timestamp: number;
  };

  /** Memory review completed (periodic session history extraction) */
  "memory:review_completed": {
    agentId: string;
    sessionsReviewed: number;
    memoriesExtracted: number;
    duplicatesSkipped: number;
    durationMs: number;
    timestamp: number;
  };

  /** First graph subagent LLM turn confirmed a cache prefix write.
   *  Graph coordinator uses this as spawn gate for remaining nodes. */
  "cache:graph_prefix_written": {
    graphId: string;
    nodeId: string;
    cacheWriteTokens: number;
    timestamp: number;
  };
}
