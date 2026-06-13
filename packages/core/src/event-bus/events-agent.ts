// SPDX-License-Identifier: Apache-2.0
/**
 * AgentEvents: Skill, tool, model, audit, observability (token/latency), and graph lifecycle events.
 *
 * Find events by prefix: skill:*, tool:*, model:*, audit:*, observability:*, graph:*
 */
import type { NodeStatus, GraphStatus } from "../domain/execution-graph.js";
import type { ErrorKind } from "../logging/log-fields.js";
import type { ScriptClass } from "../text/script-classes.js";
import type { GenerationPass } from "../text/generation-quality.js";

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
    /** Action-discriminator for action-keyed tools (e.g. mcp_manage action="set").
     *  Drives typed activity labels. Sanitised/derived at the emit site (§16.1). */
    action?: string;
    /** Sanitised tool params for activity rendering. MUST be redacted via
     *  redactValue() at the emit site before emit (§10.1) — the type carries
     *  no redaction guarantee; the emit-site redaction + CI grep gate enforce it. */
    params?: Record<string, unknown>;
  };

  /** Tool invocation completed (builtin, platform, or skill-based) */
  // @optional-field-count: tool:executed carries failure-classification provenance (P1/D1);
  //   the new fields are conditional on the failure branch — see AGENT_NATIVE_OBSERVABILITY_DESIGN §5 D1.
  "tool:executed": {
    toolName: string;
    durationMs: number;
    success: boolean;
    timestamp: number;
    /** Correlates start↔end for a stable activityId (§16.11). */
    toolCallId: string;
    userId?: string;
    traceId?: string;
    agentId?: string;
    sessionKey?: string;
    /** Sanitised tool params for activity rendering. MUST be redacted via
     *  redactValue() at the emit site before emit (§10.1). */
    params?: Record<string, unknown>;
    /** Truncated error message when success=false (max 1500 chars). */
    errorMessage?: string;
    /** Error classification (closed ErrorKind union). "timeout" for
     *  abort signal, "internal" for other failures. */
    errorKind?: ErrorKind;
    /** Human-readable activity label for exec commands. */
    description?: string;
    /** Whether the tool result was truncated by per-tool maxChars or per-turn budget. */
    truncated?: boolean;
    /** Original character count before truncation. Only present when truncated=true. */
    fullChars?: number;
    /** Character count after truncation. Only present when truncated=true. */
    returnedChars?: number;
    /** Which of the 4 sources classified this failure (P1/D1). */
    classifiedFailureBy?: "sdk_iserror" | "exit_code" | "failure_detector" | "mcp_classifier";
    /** False ONLY when the SDK/transport itself errored; true for content/exit/detector failures. */
    transportOk?: boolean;
    /** HTTP status for web tools (result.status). */
    httpStatus?: number;
    /** The detector rule that matched (P2/D2). */
    matchedRule?: string;
    /** The token that matched, e.g. a status code (P2/D2). */
    matchedToken?: string;
    /** Size in bytes of the full serialized result (D4) — never the body. */
    resultBytes?: number;
    /** 12-hex digest of the full result payload (D4) — never the body. */
    resultDigest?: string;
  };

  /** Tools filtered out by policy before execution (debugging/audit) */
  "tool:policy_filtered": {
    profile: string;
    agentId?: string;
    /** Per-entry `toolCallId` is optional — activity renders a policy-block
     *  only when the filtered tool is correlatable to a call. */
    filtered: Array<{ toolName: string; reason: string; toolCallId?: string }>;
    timestamp: number;
  };

  /**
   * Circuit breaker opened for a tool (tool-level total OR error-pattern
   * threshold crossed). D3 — fired by the bridge exactly at the counter
   * crossing (`recordResult` returns the verdict; the breaker stays
   * emitter-free). Phase 153's `obs.explain` renders a breakerTimeline from
   * these; the payload carries the breaker's already-normalized `errorTag`
   * (extractErrorTag — first-80-char normalized), NEVER raw error text (§2.7).
   */
  "tool:breaker_opened": {
    toolName: string;
    consecutiveFailures: number;
    /** Normalized error tag (extractErrorTag) — never raw body. */
    errorTag: string;
    /** "tool_failure_threshold" | "error_pattern" */
    reason: string;
    /** Count of tools executed so far this execution (monotonic seq for the breakerTimeline). */
    seq: number;
    timestamp: number;
  };

  /**
   * Circuit breaker reset for a tool (a success that recovered a non-zero
   * failure counter). D3. Lifecycle `reset()` does NOT emit this (A2).
   */
  "tool:breaker_reset": {
    toolName: string;
    /** "success" */
    reason: string;
    seq: number;
    timestamp: number;
  };

  /**
   * Tool result offloaded to disk (exceeded the inline threshold or the hard
   * cap). D7 — emitted by the executor's microcompaction offload callback
   * (the guard stays emitter-free, T-151-07). Phase 153's `obs.explain`
   * renders `IncidentReport.offloads[]` from these. The payload carries a
   * count (`originalChars`) and a WORKSPACE-RELATIVE pointer — never the
   * offloaded result body and never the absolute host path (§2.7 / T-151-05/06).
   */
  "tool:result_offloaded": {
    toolName: string;
    toolCallId: string;
    /** Character count of the original (pre-offload) result. */
    originalChars: number;
    /** Workspace-relative path (sessionDir-relative): `tool-results/<toolCallId>.json`. Phase 153 drill-down target. */
    diskPathRel: string;
    timestamp: number;
  };

  /**
   * Capability layer -- install detour detected by exec/process tool.
   * Emission lives in the skills package; this is the type-only declaration.
   *
   * Privacy invariants:
   * - NO raw command text, shell fragments, URLs, VCS specs, local paths,
   *   registry credentials, stdout, or stderr.
   * - `commandDigest` is a stable, non-reversible hash (SHA-256).
   * - `packages[].normalizedName` is a registry-safe identifier only.
   */
  "tool:install_detour_detected": {
    readonly agentId?: string;
    readonly sessionKey?: string;
    readonly traceId?: string;
    readonly packageManager: "pip" | "npm" | "pnpm" | "yarn";
    /** Stable, non-reversible hash of normalized command shape. NEVER raw command. */
    readonly commandDigest: string;
    readonly packages: ReadonlyArray<{
      readonly normalizedName: string;
      readonly ecosystem: "python" | "node";
    }>;
    readonly overlaps: ReadonlyArray<{
      readonly packageName: string;
      readonly sourceType: "mcp" | "skill";
      readonly sourceName: string;
      readonly reason:
        | "direct-server-name"
        | "mcp-operator-alias"
        | "skill-comis-alias"
        | "skill-operator-alias";
    }>;
    readonly mode: "observe" | "advise" | "soft-stop";
    readonly action:
      | "observed"
      | "hinted"
      | "soft_stopped"
      | "override_requested"
      | "overridden"
      | "override_denied";
    readonly timestamp: number;
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
    /** Provider-specific response ID for log correlation. undefined when provider doesn't supply it. */
    responseId?: string;
    /** Per-TTL cache creation breakdown. undefined until upstream pi-mono surfaces it. */
    cacheCreation?: {
      shortTtl: number;
      longTtl: number;
    };
    /**
     * Cost-correction breadcrumb. When the pi-ai SDK underprices 1h
     * cache writes at the 5m rate, the bridge surfaces the correction
     * here as a forensics aid for operators querying token_usage
     * events. `delta` is signed (`corrected - sdkRaw`), `sdkRaw` is the
     * SDK-reported total before correction, `corrected` is the
     * post-correction total ultimately recorded by the costTracker. The
     * field is OMITTED when delta === 0 — the absence is the "no
     * correction was needed" signal, not a zero delta.
     */
    costCorrection?: {
      delta: number;
      sdkRaw: number;
      corrected: number;
    };
    /**
     * Warmup-turn flag. True when this turn wrote cache tokens without
     * reading any (`cacheReadTokens === 0 && cacheWriteTokens > 0`) —
     * the first cache-write turn of a session. Reporting
     * `cacheSavedUsd: -X, cacheSavingsRate: -91%` on this turn is
     * misleading because the "loss" is a deferred investment, not a
     * regression. Consumers should filter `warmupTurn === true` out of
     * cost-regression dashboards. Always populated.
     */
    warmupTurn: boolean;
    /**
     * Positive-signed counterpart to `savedVsUncached` for warmup turns.
     * On `warmupTurn === true && savedVsUncached < 0`, this is
     * `-savedVsUncached` (the deferred investment that subsequent
     * cached reads will recoup). Zero otherwise. Always populated so
     * consumers can sum without conditional schema checks.
     */
    pendingCacheInvestmentUsd: number;
    /** SDK per-turn stop signal (e.g. "stop"|"length"|"tool_use"|"refusal").
     *  Current at the per-turn emit (m.lastStopReason captured at :1231 same case). D8. */
    stopReason?: string;
    /** Execution-level finish disposition (e.g. "stop"|"loop_detected"|"budget_exceeded").
     *  Best-effort at the per-turn emit — m.finishReason settles LATER than turn_end
     *  (set at :1005/:1018/:1625/:1672/:2113); treat as init-default "stop" until Phase 152
     *  flight-recorder surfaces effectiveFinishReason. D8. */
    finishReason?: string;
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

  /** Model failover: attempt to switch from one model to another.
   *  Turn-scoping ids (agentId/sessionKey/traceId) are optional — emit sites
   *  populate them so activity can attribute the event to a turn (§16.9). */
  "model:fallback_attempt": {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    error: string;
    attemptNumber: number;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Model failover: all candidates exhausted */
  "model:fallback_exhausted": {
    provider: string;
    model: string;
    totalAttempts: number;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Last-known-working model fallback: attempt to use a recently successful model */
  "model:lkw_fallback_attempt": {
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
  };

  /** Auth profile entered cooldown after failure */
  "model:auth_cooldown": {
    keyName: string;
    provider: string;
    cooldownMs: number;
    failureCount: number;
    timestamp: number;
    agentId?: string;
    sessionKey?: string;
    traceId?: string;
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

  /**
   * Critic isolation: canary token detected in the critic's verdict output
   * (prompt-extraction attempt). 100% capture per AI-SPEC §7 (S2, Phase 154).
   */
  "critic.isolation.canary_leak": {
    timestamp: number;
    agentId: string;
    sessionKey?: string;
    traceId?: string;
    /** First 10 chars of the canary token (never the full HMAC — enough to correlate, not leak). */
    canaryPrefix: string;
  };

  /**
   * Critic isolation: implied tool call detected in the critic's verdict
   * (scope-widening attempt). 100% capture per AI-SPEC §7 (S2, Phase 154).
   */
  "critic.isolation.implied_tool_call": {
    timestamp: number;
    agentId: string;
    sessionKey?: string;
    traceId?: string;
    /** Which regex pattern triggered (e.g., "call write_file"). Sanitized — no user content. */
    pattern: string;
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

  /**
   * Memory consolidation completed (periodic clustering of near-duplicate raw
   * memories into observations). MINIMAL payload by design: the recall
   * observability events own the rich observability surface (recall trace,
   * per-cluster diagnostics). Counts only — NEVER memory content or tags
   * (AGENTS.md §2.7).
   */
  "memory:consolidated": {
    agentId: string;
    /** Homogeneous sub-clusters that passed the trust/external gate and were processed. */
    clustersProcessed: number;
    /** New observation rows created (excludes dedup-hit clusters). */
    observationsCreated: number;
    /** Clusters skipped because an equivalent observation already existed. */
    dedupHits: number;
    /** Observations grown by folding new corroborating sources into them. */
    foldsApplied: number;
    durationMs: number;
    timestamp: number;
  };

  /**
   * Hybrid memory recall completed for one turn. MINIMAL payload by design —
   * counts/booleans/ids ONLY, NEVER the query text, memory bodies, or entity
   * names (AGENTS.md §2.7). The per-recall ranking detail lives in the opt-in
   * `diagnostics.recallTrace` JSONL artifact, not on the bus. Drives the
   * in-process recall counters (lane-usage + hit-rate).
   *
   * Emit site: `createMemoryRecall` in
   * `packages/agent/src/rag/memory-recall.ts`, at the single one-per-recall
   * site after fuse/rerank/score.
   */
  "memory:recalled": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    /** Count of retrieval lanes that fired (fts / vector / entity). */
    lanes: number;
    /** Candidate count from the FTS5 lane. */
    ftsCandidates: number;
    /** Candidate count from the vector lane. */
    vectorCandidates: number;
    /** Candidate count from the entity-associative lane. */
    entityCandidates: number;
    /** Size of the final ranked set returned to the prompt (0 ⇒ no hit). */
    finalCount: number;
    /** Whether the cross-encoder reranker was available for this recall. */
    rerankerAvailable: boolean;
    durationMs: number;
    timestamp: number;
  };

  /**
   * Cross-encoder rerank stage completed for one recall. MINIMAL payload by
   * design — counts/booleans ONLY, NEVER memory bodies or query text
   * (AGENTS.md §2.7). The `fellBack` / `timedOut` flags make the
   * graceful-degradation paths (reranker err / budget exceeded → fusion order)
   * queryable; they feed the rerank-fallback-rate counter.
   *
   * Emit site: `createMemoryRecall` in
   * `packages/agent/src/rag/memory-recall.ts`, alongside `memory:recalled`
   * whenever a rerank stage ran.
   */
  "memory:reranked": {
    agentId: string;
    traceId: string;
    /** Candidates handed to the reranker. */
    candidateCount: number;
    /** Memories surviving into the final ranked set. */
    hitCount: number;
    /** Whether the cross-encoder reranker was available. */
    rerankerAvailable: boolean;
    /** True when the reranker exceeded its budget and the fusion order was used. */
    timedOut: boolean;
    /** True when the reranker returned err and the fusion order was used. */
    fellBack: boolean;
    durationMs: number;
    timestamp: number;
  };

  /**
   * Entity resolve-and-link pass completed during a memory-review run.
   * MINIMAL payload by design — counts ONLY, NEVER entity names or memory
   * bodies (AGENTS.md §2.7). `newEntities` is the subset of `entityCount` that
   * created a fresh entity row (the rest reused an existing one).
   *
   * Emit site: the `resolveAndLink` loop in `runMemoryReview`
   * (`packages/agent/src/memory/memory-review-job.ts`).
   */
  "memory:entities_linked": {
    agentId: string;
    /** Total entities resolved + linked in this pass. */
    entityCount: number;
    /** Entities that created a NEW entity row (subset of entityCount). */
    newEntities: number;
    durationMs: number;
    timestamp: number;
  };

  /**
   * Recall-usage attribution complete for one turn. MINIMAL payload —
   * counts + memory IDS only, NEVER memory content, the agent response, or the
   * query (AGENTS.md §2.7, matching the whole memory:* family). The overlap
   * heuristic (recall-attribution.ts) reads memory content in-process at the
   * turn-end site and discards it; only the resulting ids cross the bus.
   *
   * Emit site: `postExecution` in
   * `packages/agent/src/executor/executor-post-execution.ts`,
   * flag-gated on `rag.feedback.enabled` (default OFF → no emit). The daemon
   * subscriber (setup-memory-usefulness-wiring.ts) writes the signal through the
   * `MemoryUsefulnessStore.recordUsage` port.
   */
  "memory:recall_used": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    /** Opaque memory uuids attributed as USED this turn — ids only, never bodies. */
    usedIds: string[];
    /** Opaque memory uuids recalled but NOT used — ids only. */
    ignoredIds: string[];
    /** == usedIds.length (parity with the counts-only family). */
    usedCount: number;
    /** == ignoredIds.length. */
    ignoredCount: number;
    /**
     * Optional query-INTENT bucket — the deterministic classifyIntent
     * result for the recall that produced these ids. When present the daemon
     * write-back records the per-intent bucket; when OMITTED it records the GLOBAL
     * bucket (byte-identical to the prior behaviour). A closed-union string (factual|temporal|
     * preference|enumeration), NOT memory content — ids/counts/intent ONLY ever
     * cross the bus (AGENTS.md §2.7), never bodies/query/response.
     */
    intent?: string;
    timestamp: number;
  };

  /**
   * GENQ-01: a memory-generation pass produced output whose quality diverged from
   * its source — the generalization of `context:summary_language_mismatch` to the
   * consolidation / reasoning / user-representation passes (the F-ML1 regression
   * class: a weak local model silently translating non-Latin source memories into
   * a Latin output). VISIBILITY ONLY — never gated (I8; a mixed code-heavy source
   * legitimately skews Latin via `dominantScript`'s 0.3 threshold, so this is a
   * count an operator reviews, not an error to block). Emitted ONLY when an issue
   * is detected (`languageMismatch || emptyOutput || formatViolation`); a clean
   * pass emits nothing. Bridged to the trajectory as `memory.generation_quality`
   * AND persisted as a `health_signal` row. Payload is the closed `GenerationPass`
   * + closed `ScriptClass` enums + booleans + ids ONLY — NEVER the source or the
   * generated body (§2.7); the classifier reads the text locally and nothing leaks.
   */
  "memory:generation_quality": {
    agentId: string;
    /** Cron-job passes have no session — optional, mirrors the memory:* family. */
    sessionKey?: string;
    /** Which generation pass produced the output (closed union). */
    pass: GenerationPass;
    /** Dominant script of the generation source/input. */
    sourceScript: ScriptClass;
    /** Dominant script of the generated output. */
    outputScript: ScriptClass;
    /** Non-Latin source whose output came back Latin (the translate-when-preserve regression). */
    languageMismatch: boolean;
    /** The generation produced empty / whitespace-only output. */
    emptyOutput: boolean;
    /** The output failed to parse into the pass's expected structured form. */
    formatViolation: boolean;
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

  // ---------------------------------------------------------------------------
  // Phase 172 (DIST-01..04): LCD→LTM distillation observability events.
  // Content-free: ids/counts/reasons only — NEVER summary or memory text
  // (T-130-09 + §2.7 logging matrix). Both events are emitted by the
  // distillation runner in lcd-distillation-runner.ts.
  // ---------------------------------------------------------------------------

  /**
   * Emitted when the distillation runner skips writing to LTM.
   * `reason` encodes the gate that fired: "fallback_marker" |
   * "subagent_session" | "depth_below_min" | "weak_model_no_override" |
   * "near_duplicate" | "validation" (from validateMemoryWrite).
   * Content-free: ids, agentId, sessionKey, reason, optional score/depth only.
   */
  "memory:distillation_skipped": {
    reason: string;
    summaryId?: string;
    agentId?: string;
    sessionKey?: string;
    score?: number;
    depth?: number;
    minDepth?: number;
    capabilityClass?: string;
    timestamp?: number;
  };

  /**
   * Emitted when the distillation runner successfully writes an episodic
   * memory + provenance row to LTM. Content-free: ids/counts/depth only.
   */
  "memory:distillation_complete": {
    summaryId: string;
    memoryId: string;
    depth: number;
    agentId?: string;
    sessionKey?: string;
    timestamp?: number;
  };

  // ---------------------------------------------------------------------
  // Trajectory observability events (prompt:* / session:* / memory:injected
  // / tool:timeout) moved to events-trajectory.ts (`TrajectoryEvents`) for
  // the file-size cap; they are composed into `EventMap` (events.ts) there.
  // Subscribed via @comis/observability/trajectory/event-bus-bridge.ts.
  // ---------------------------------------------------------------------
}
