// SPDX-License-Identifier: Apache-2.0
/**
 * AgentEvents: Skill, tool, audit, security, memory, and observability
 * (token/latency/spend) events.
 *
 * Find events by prefix: skill:*, tool:*, audit:*, observability:*, security:*,
 * memory:*. Model-failover (model:*) + provider-health (provider:*) live in
 * ModelEvents (events-model.ts). Graph orchestration (graph:* / subagent:*)
 * lives in OrchestrationEvents (events-orchestration.ts).
 */
import type { ErrorKind } from "../logging/log-fields.js";
import type { ScriptClass } from "../text/script-classes.js";
import type { GenerationPass } from "../text/generation-quality.js";
import type { AuditKind } from "../security/audit.js";

/**
 * The closed scope enum that rides the
 * `observability:spend_*` wire (mirrors how {@link AuditKind} rides
 * `audit:event`). The daemon-wide spend accumulator (`@comis/agent`
 * `budget/spend-accumulator.ts`) and the abort wiring import it so the scope of a
 * warn/exceed is a closed-union LABEL, never a free string. Per-(tenant,agent),
 * per-tenant, and daemon-global are the three ceilings.
 */
export type SpendScopeKind = "agent" | "tenant" | "global";

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
     *  Drives typed activity labels. Sanitised/derived at the emit site. */
    action?: string;
    /** Sanitised tool params for activity rendering. MUST be redacted via
     *  redactValue() at the emit site before emit — the type carries
     *  no redaction guarantee; the emit-site redaction + CI grep gate enforce it. */
    params?: Record<string, unknown>;
  };

  /** Tool invocation completed (builtin, platform, or skill-based) */
  // @optional-field-count: tool:executed carries failure-classification provenance;
  //   the optional fields are conditional on the failure branch.
  "tool:executed": {
    toolName: string;
    durationMs: number;
    success: boolean;
    timestamp: number;
    /** Correlates start↔end for a stable activityId. */
    toolCallId: string;
    userId?: string;
    traceId?: string;
    agentId?: string;
    sessionKey?: string;
    /** Sanitised tool params for activity rendering. MUST be redacted via
     *  redactValue() at the emit site before emit. */
    params?: Record<string, unknown>;
    /** On FAILURE only: the bounded+redacted argument shape (redactValue then
     *  sanitizeToolArgs — secrets/PII/paths masked, each value capped, large
     *  values → "[N chars]"). Forwarded to the tool.result trajectory record
     *  and explain's failures[] so "what did the failed call attempt?" is
     *  answerable in one `comis explain` — no raw conversation-store dive.
     *  Omitted on success (the input is only load-bearing on a failure). */
    argsPreview?: Record<string, unknown>;
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
    /** Which of the 4 sources classified this failure. */
    classifiedFailureBy?: "sdk_iserror" | "exit_code" | "failure_detector" | "mcp_classifier" | "runtime_guard";
    /** False ONLY when the SDK/transport itself errored; true for content/exit/detector failures. */
    transportOk?: boolean;
    /** Explicit terminal task grade reported by an opt-in `{ graded: true, outcome }`
     * tool result. Content-free; later explicit grades replace earlier ones. */
    selfGradedOutcome?: "success" | "failure";
    /** HTTP status for web tools (result.status). */
    httpStatus?: number;
    /** The detector rule that matched. */
    matchedRule?: string;
    /** The token that matched, e.g. a status code. */
    matchedToken?: string;
    /** Size in bytes of the full serialized result — never the body. */
    resultBytes?: number;
    /** 12-hex digest of the full result payload — never the body. */
    resultDigest?: string;
    /** CONTENT-FREE grounding summary for web_search /
     *  web_fetch — the number of results returned (1 for a single fetch). Lets a
     *  "grounded in fetched results" predicate be verified from the trajectory
     *  without a DEBUG daemon-log grep. Never titles/snippets/bodies. */
    resultCount?: number;
    /** The source HOSTS the web result came from (e.g. ["example.com"]) —
     *  hosts ONLY, never full URLs with paths/queries, never bodies. */
    domains?: string[];
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
   * threshold crossed). Fired by the bridge exactly at the counter
   * crossing (`recordResult` returns the verdict; the breaker stays
   * emitter-free). `obs.explain` renders a breakerTimeline from
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
   * failure counter). Lifecycle `reset()` does NOT emit this.
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
   * cap). Emitted by the executor's microcompaction offload callback
   * (the guard stays emitter-free). `obs.explain`
   * renders `IncidentReport.offloads[]` from these. The payload carries a
   * count (`originalChars`) and a WORKSPACE-RELATIVE pointer — never the
   * offloaded result body and never the absolute host path (§2.7).
   */
  "tool:result_offloaded": {
    toolName: string;
    toolCallId: string;
    /** Character count of the original (pre-offload) result. */
    originalChars: number;
    /** Workspace-relative path (sessionDir-relative): `tool-results/<toolCallId>.json`. `obs.explain` drill-down target. */
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
    /** Event family — the closed {@link AuditKind} union rides the wire to the audit sink (which derives kind from actionType only as a fallback). Optional on the wire; all 6 in-repo emit sites set it. */
    kind?: AuditKind;
    /** Risk class — loosely typed here; AuditEventSchema's closed read|mutate|destructive is the source of truth. Event-family strings ("security"/"write"/"neutral") belong on `kind`, never here. */
    classification?: string;
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
     * Cost-correction breadcrumb (forensics aid). Set when the pi-ai SDK underprices 1h
     * cache writes at the 5m rate: `delta` = signed `corrected - sdkRaw`, `sdkRaw` = the
     * SDK total before correction, `corrected` = the post-correction total recorded. OMITTED
     * when delta === 0 (absence is the "no correction needed" signal, not a zero delta).
     */
    costCorrection?: {
      delta: number;
      sdkRaw: number;
      corrected: number;
    };
    /**
     * Warmup-turn flag — true when this turn wrote cache tokens without reading any
     * (`cacheReadTokens === 0 && cacheWriteTokens > 0`, the first cache-write turn). A
     * negative `cacheSavedUsd` here is a deferred investment, not a regression — consumers
     * filter `warmupTurn === true` out of cost-regression dashboards. Always populated.
     */
    warmupTurn: boolean;
    /**
     * Positive-signed counterpart to `savedVsUncached` for warmup turns: on
     * `warmupTurn === true && savedVsUncached < 0` this is `-savedVsUncached` (the deferred
     * investment subsequent cached reads recoup); zero otherwise. Always populated.
     */
    pendingCacheInvestmentUsd: number;
    /** SDK per-turn stop signal (e.g. "stop"|"length"|"tool_use"|"refusal").
     *  Current at the per-turn emit (m.lastStopReason is captured in the same executor case). */
    stopReason?: string;
    /** Execution-level finish disposition (e.g. "stop"|"loop_detected"|"budget_exceeded").
     *  Best-effort at the per-turn emit — m.finishReason settles LATER than turn_end,
     *  so treat this as the init-default "stop"; the flight-recorder's
     *  effectiveFinishReason is the settled value. */
    finishReason?: string;
    /**
     * The DISTINCT tool names that fired during this turn (content-free
     * ids only — never args/output). OMITTED when no tool fired (absence = the
     * byte-identical no-tool payload, not an empty array). Persisted on the
     * `tool_tag` column. The per-tool token/$ attribution a consumer derives from
     * this is best-effort/labeled: an even split across these tools that
     * conserves the turn total — exact per-tool accounting is out of scope.
     */
    toolTag?: string[];
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

  /** Spend approaching a ceiling (fired at
   *  `warnAtFraction`, default 0.8, BEFORE the kill-switch trips). Content-free
   *  (§2.7): dollar amounts as NUMBERS, scope as the closed {@link SpendScopeKind}
   *  enum, ids only — NEVER a message/prompt/query body. */
  "observability:spend_warning": {
    timestamp: number;
    agentId: string;
    sessionKey: string;
    scope: SpendScopeKind;
    spentUsd: number;
    capUsd: number;
    fraction: number;
  };

  /** A spend ceiling was exceeded — the dollars
   *  kill-switch tripped for this scope. Content-free (§2.7): `estUsd` is the
   *  reservation that breached; amounts are NUMBERS, scope is a closed enum, ids
   *  only — NEVER a message/prompt/query body. */
  "observability:spend_exceeded": {
    timestamp: number;
    agentId: string;
    sessionKey: string;
    scope: SpendScopeKind;
    spentUsd: number;
    capUsd: number;
    estUsd: number;
  };

  /** A remote model burned tokens with UNKNOWN pricing
   *  (fail-loud, not fail-open — unpriced spend must surface, never silently read as $0). Content-free (§2.7):
   *  provider/model are config ids/enums (a model id is a config value, NOT user
   *  content) + turn ids — NEVER a message/prompt/query body. */
  "observability:spend_unpriceable": {
    timestamp: number;
    agentId: string;
    sessionKey: string;
    provider: string;
    model: string;
  };

  // Model-failover (model:*) + provider-health (provider:*) events moved to
  // events-model.ts (`ModelEvents`) for the file-size cap; composed into
  // `EventMap` (events.ts) there, byte-identical shapes.

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
   * An outbound URL was BLOCKED by
   * the SSRF guard (`validateUrl`). A forensics signal so `comis security audit-log`
   * records an agent/injected-instruction attempt to reach a cloud-metadata IP /
   * RFC1918 / loopback / non-http target — without this event such blocks would be
   * SILENT (no audit row), unlike the destructive-command floor (`command:blocked`).
   * CONTENT-FREE BY CONSTRUCTION: `origin` is the URL's `origin` (scheme+host+port)
   * ONLY — `new URL().origin` strips the path, query, fragment AND userinfo, so no
   * secret-bearing query string or embedded `user:pass@` credential can ride it.
   * `reason` is a closed enum. Emitted daemon-side from the registered SSRF block
   * hook (setSsrfBlockHook); subscribed by wireAuditSink → the `ssrf_blocked` row.
   */
  "security:ssrf_blocked": {
    timestamp: number;
    /** The blocked URL's origin (scheme+host+port) — never path/query/fragment/userinfo. */
    origin: string;
    /** Why it was blocked (closed enum: a non-http protocol, the metadata IP, or a blocked IP range). */
    reason: "protocol" | "cloud_metadata" | "private" | "loopback" | "linkLocal" | "uniqueLocal" | "unspecified" | "reserved";
    agentId?: string;
    traceId?: string;
  };

  /**
   * Critic isolation: canary token detected in the critic's verdict output
   * (prompt-extraction attempt). Every detection emits — 100% capture.
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
   * (scope-widening attempt). Every detection emits — 100% capture.
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

  /**
   * Fail-closed sub-agent spawn refusal: the child's resolved sandbox posture
   * was LESS confined than its spawner's on ≥1 dimension. Fires
   * at the spawn chokepoint BEFORE any run/session is created.
   *
   * §2.7: enum-tuple payload ONLY — both postures as closed-union
   * LABELS + the violated dimension labels + the two agent ids + a timestamp.
   * NEVER the underlying paths/hosts/uid-numbers/credential values that would
   * leak the operator's sandbox topology. Pino auto-redaction is a net, not a
   * license.
   */
  "security:sandbox_downgrade_refused": {
    timestamp: number;
    /** the spawner's agent id (an id, not a secret) */
    parentAgentId: string;
    /** the prospective child's agent id (an id, not a secret) */
    childAgentId: string;
    /** the dimension(s) on which the child was LESS confined — enum labels, never values */
    violatedDimensions: ("exec" | "filesystem" | "network" | "uid")[];
    /** spawner posture as enum tuples — labels only; NO paths/hosts/credential values (§2.7) */
    parentPosture: {
      exec: "always" | "never";
      filesystem?: "workspace" | "listed-paths" | "home" | "full";
      network?: "none" | "listed-hosts" | "full";
      uid?: "dedicated" | "daemon";
    };
    /** child posture as enum tuples — labels only; NO paths/hosts/credential values (§2.7) */
    childPosture: {
      exec: "always" | "never";
      filesystem?: "workspace" | "listed-paths" | "home" | "full";
      network?: "none" | "listed-hosts" | "full";
      uid?: "dedicated" | "daemon";
    };
  };

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
   * Hybrid memory recall completed for one turn. MINIMAL payload — counts/booleans/ids
   * ONLY, NEVER query text, memory bodies, or entity names (§2.7); the per-recall ranking
   * detail lives in the opt-in `diagnostics.recallTrace` artifact. Drives the in-process
   * recall counters. Emit site: `createMemoryRecall` (memory-recall.ts), one-per-recall
   * after fuse/rerank/score.
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
    /**
     * Count of final-set memories scoped to a DIFFERENT user than the current
     * conversation (`entry.userId !== sessionKey.userId`). `> 0` means agent-scoped
     * recall injected another sender's memory into THIS turn — the cross-sender/privacy
     * signal a recall or privacy audit needs from the ALWAYS-ON event, so "was
     * cross-sender data injected into this turn's context?" is answerable without the
     * opt-in `diagnostics.recallTrace` artifact having been pre-enabled. A COUNT only —
     * never the user-ids or memory bodies (§2.7); the per-row detail stays in the trace.
     */
    crossUserCount: number;
    /**
     * Count of DISTINCT authors (`source.who`) among the final ranked set — a breadth
     * signal (several senders' memories fused into one turn). A COUNT only (§2.7).
     */
    distinctSources: number;
    /** Whether the cross-encoder reranker was available for this recall. */
    rerankerAvailable: boolean;
    durationMs: number;
    timestamp: number;
  };

  /**
   * A recall retrieval lane (or the whole lane split) FAILED and recall
   * degraded rather than silently vanishing. MINIMAL payload — a closed scope
   * tag + the closed ErrorKind string ONLY, never query text or error bodies
   * (§2.7). `scope:"vector_lane"` = the vector lane returned empty while FTS
   * still served (e.g. a vec-table/embedder dimension drift); `scope:"lanes"`
   * = the whole searchLanes call failed and the turn ran with NO recall.
   * Bridged to the trajectory and persisted as a `health_signal` obs row so a
   * recurring recall failure is a system finding, not a log-grep discovery
   * (observed live: hours of per-turn failures with zero system signal).
   * Emit site: `createMemoryRecall` (memory-recall.ts), via the same
   * deferred-emit path as `memory:recalled`.
   */
  "memory:recall_degraded": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    /** Which layer degraded: one lane ("vector_lane") or the whole split ("lanes"). */
    scope: "vector_lane" | "lanes";
    /** The closed LogFields.ErrorKind string from the failing layer. */
    errorKind: string;
    timestamp: number;
  };

  /**
   * A cached-prefix message MUTATED across turns (Anthropic prompt-cache
   * collapse) on THRESHOLD+ calls within a recent window — a wasted-cache-write
   * signal. MINIMAL payload — the divergent index + a windowed mutation count +
   * the closed mutation-class label ONLY, NEVER message text (§2.7). Emitted
   * alongside the "Unstable prefix detected" WARN so the churn surfaces as a
   * `comis system-health` `cache_prefix_churn` health signal instead of being visible
   * only as a daemon.log WARN. `mutationClass` is the classifier's label
   * (structural-shift / datetime-preamble / thinking-cleared / …).
   */
  "agent:prefix_unstable": {
    agentId?: string;
    sessionKey: string;
    /** Index of the first cached-region message that diverged from the prior turn. */
    firstDivergentIndex: number;
    /** Windowed count of cached-region mutations that crossed the WARN threshold. */
    cacheRegionMutations: number;
    /** Closed classifier label for what changed (no message text). */
    mutationClass: string;
    timestamp: number;
  };

  /**
   * Cross-encoder rerank stage completed for one recall. MINIMAL payload —
   * counts/booleans ONLY, NEVER memory bodies or query text (§2.7). The `fellBack` /
   * `timedOut` flags make the graceful-degradation paths queryable (rerank-fallback-rate
   * counter). Emit site: `createMemoryRecall` (memory-recall.ts), alongside
   * `memory:recalled` when a rerank stage ran.
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
   * Recall-usage attribution complete for one turn. MINIMAL payload — counts + memory
   * IDS only, NEVER memory content, the agent response, or the query (§2.7, the whole
   * memory:* family). The overlap heuristic (recall-attribution.ts) reads memory content
   * in-process and discards it; only the ids cross the bus. Emit site: `postExecution`
   * (executor-post-execution.ts), flag-gated on `rag.feedback.enabled` (default OFF). The
   * daemon subscriber (setup-memory-usefulness-wiring.ts) writes via `recordUsage`.
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
     * Optional query-INTENT bucket (the deterministic classifyIntent result). Present →
     * the daemon write-back records the per-intent bucket; omitted → the GLOBAL bucket
     * (byte-identical). A closed-union string (factual|temporal|preference|enumeration),
     * NOT memory content — ids/counts/intent ONLY cross the bus (§2.7), never bodies/query.
     */
    intent?: string;
    timestamp: number;
  };

  /**
   * A finished trajectory's resolved net task-outcome. Emitted daemon-side after
   * `OutcomeSignalPort.resolve`, `learningOutcome.enabled`-gated (default OFF), bridged for `comis explain`. Counts/ids/closed-enums ONLY — no bodies/free text (§2.7); adding one is a compile error.
   */
  "learning:outcome_observed": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    trajectoryId: string;
    outcome: "success" | "failure" | "corrected" | "unknown";
    source: "tool" | "pipeline" | "correction" | "judge" | "reaction" | "explicit";
    confidence: number;
    timestamp: number;
  };

  /**
   * The lifecycle sweep demoted (`learning:memory_demoted`) /
   * SOFT-evicted (`learning:memory_evicted`, set `evicted_at`, never DELETE) N memories
   * this run. Emitted DAEMON-SIDE (the lifecycle store has no bus) from the real sweep
   * report `demoted`/`evicted` counts. Counts ONLY — never an id-list or body (§2.7).
   * Bridged for `comis explain`.
   */
  "learning:memory_demoted": { agentId: string; count: number; timestamp: number };
  "learning:memory_evicted": { agentId: string; count: number; timestamp: number };
  /**
   * The once-per-run lifecycle/forget sweep SUMMARY — the parity
   * event for the forget half of learning (reflection has `reflect:funnel`; the forget sweep had
   * only the per-category demoted/evicted counts above, invisible to `cron.runs`/system/`explain`).
   * Carries the run breakdown so `cron.runs jobName "Memory lifecycle"` answers "what did the sweep
   * do" (scanned/evicted/demoted) in one call instead of a `db.mjs` `evicted_at` poll, and the system
   * lens rolls a `memory_lifecycle` finding. Counts ONLY — never an id-list/body (§2.7).
   */
  "learning:lifecycle_swept": {
    agentId: string;
    scanned: number;
    promoted: number;
    demoted: number;
    evicted: number;
    timestamp: number;
  };
  /**
   * N memories accrued a CORROBORATED failure (failure_count++) this
   * resolve — the eviction-causation PRECURSOR. Eviction needs `failure_count >= failureEvictionFloor`,
   * and without this event the accrual would be invisible (only the DB column changing over time + a
   * DEBUG line), leaving "why did/didn't this memory evict" with no event trail. This event makes the
   * corroborated-failure accrual diagnosable from `comis explain`
   * (bridged) so the path toward eviction is reconstructable. Count ONLY — never a memory id-list/body
   * (§2.7); the accrual is already corroboration-gated (≥2 independent sessions).
   */
  "learning:memory_failure_attributed": { agentId: string; count: number; timestamp: number };

  /**
   * A memory-generation pass produced output whose quality diverged from its
   * source (the failure class where a weak local model silently translates non-Latin source
   * memories into Latin output; the generalization of `context:summary_language_mismatch`
   * to the consolidation/reasoning/user-representation passes). VISIBILITY ONLY, never
   * gated. Emitted only on an issue (`languageMismatch || emptyOutput ||
   * formatViolation`). Bridged to `memory.generation_quality` + persisted as a
   * `health_signal`. Closed `GenerationPass` + `ScriptClass` enums + booleans + ids ONLY
   * — NEVER the source or generated body (§2.7); the classifier reads text locally.
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

  // LCD→LTM distillation observability events. Content-free:
  // ids/counts/reasons only — NEVER summary/memory text (§2.7). Emitted by
  // the distillation runner (lcd-distillation-runner.ts).

  /**
   * Distillation runner SKIPPED writing to LTM. `reason` is the gate that fired
   * ("fallback_marker" | "subagent_session" | "depth_below_min" | "weak_model_no_override"
   * | "near_duplicate" | "validation"). Content-free: ids/reason/optional score/depth only.
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
