// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Auxiliary agent runtime schemas.
 *
 * Owns Routing, RAG, Bootstrap, Concurrency, Broadcast, ElevatedReply,
 * Tracing, SdkRetry, ContextGuard, ToolLifecycle, DeferredTools, and Sep
 * schemas — the auxiliary agent-configuration helpers that feed into the
 * top-level `AgentConfigSchema` (composed in `schema-agent-runtime.ts`).
 *
 * Imports only from external siblings (TrustLevelSchema from
 * `../../domain/memory-entry.js`) — no sibling-leaf imports inside the
 * `schema-agent/` subdirectory; the top-level `AgentConfigSchema` in
 * `schema-agent-runtime.ts` composes from this leaf.
 *
 * @module
 */
import { z } from "zod";
import { TrustLevelSchema } from "../../domain/memory-entry.js";

// ── Agent Configuration Schema ─────────────────────────────────────────

/**
 * Agent configuration schema.
 *
 * Defines agent identity, model selection, execution limits,
 * workspace paths, and per-agent feature configuration.
 */

/** Routing binding: maps channel/peer/guild patterns to a specific agent. */
export const RoutingBindingSchema = z.strictObject({
    /** Channel type to match (e.g. "telegram", "discord") */
    channelType: z.string().optional(),
    /** Channel identifier to match */
    channelId: z.string().optional(),
    /** Peer (user) identifier to match */
    peerId: z.string().optional(),
    /** Guild (server/group) identifier to match */
    guildId: z.string().optional(),
    /** Agent ID to route to when this binding matches */
    agentId: z.string().min(1),
  });

/** Routing configuration for multi-agent dispatch. */
export const RoutingConfigSchema = z.strictObject({
    /** Agent ID to use when no routing binding matches */
    defaultAgentId: z.string().min(1).default("default"),
    /** Ordered list of routing bindings (first match wins) */
    bindings: z.array(RoutingBindingSchema).default([]),
  });

/** RAG (Retrieval-Augmented Generation) configuration for automatic memory retrieval before LLM calls. */
export const RagConfigSchema = z.strictObject({
    /** Enable automatic memory retrieval before LLM calls */
    enabled: z.boolean().default(true),
    /** Maximum number of memory results to retrieve */
    maxResults: z.number().int().positive().default(5),
    /** Maximum characters of memory context to inject into system prompt */
    maxContextChars: z.number().int().positive().default(4000),
    /** Minimum RRF score threshold (0-1) to include a memory result */
    minScore: z.number().min(0).max(1).default(0.1),
    /** Trust levels to include in retrieval (external excluded by default for security) */
    includeTrustLevels: z.array(TrustLevelSchema).default(["system", "learned"]),
    /** Cross-encoder reranking (opt-in; default-OFF per the Phase-79 latency decision). */
    rerank: z
      .strictObject({
        /** Phase-79 DECISION: opt-in, not default-on (~777ms p95 @40 cands exceeds budget). */
        enabled: z.boolean().default(false),
        /** Candidate cap bounding worst-case rerank latency (~29ms/candidate). */
        maxCandidates: z.number().int().positive().default(40),
        /** Skip reranking when fewer than this many candidates are present. */
        minResults: z.number().int().nonnegative().default(1),
        /** Rerank wall-clock timeout (ms); on timeout fall back to fusion order (RANK-08). */
        timeoutMs: z.number().int().positive().default(800),
      })
      .default(() => ({ enabled: false, maxCandidates: 40, minResults: 1, timeoutMs: 800 })),
    /** Multiplicative scoring boosts applied to the reranked-or-fused score (RANK-05). */
    scoring: z
      .strictObject({
        /** Recency boost weight (applied now via createdAt). */
        recencyAlpha: z.number().min(0).max(1).default(0.2),
        /** Event-time proximity boost weight (Phase-81/TEMP-05; LIVE — applies when occurredAt is present, neutral when absent). */
        temporalAlpha: z.number().min(0).max(1).default(0.2),
        /** Proof-count boost weight (Phase-84 hook; neutral until proofCount exists). */
        proofAlpha: z.number().min(0).max(1).default(0.1),
        /** Trust-level boost weight + tie-break (RANK-06). */
        trustAlpha: z.number().min(0).max(1).default(0.1),
        /** Usefulness boost weight (Phase-93/FEED-03; the SINGLE canonical usefulness knob —
         *  the recall-utility feedback loop reads `rag.scoring.usefulnessAlpha`, NOT a knob on
         *  `rag.feedback`). Bounded small (same magnitude as trust/proof) so a proven-useful
         *  memory is boosted but CANNOT overturn trust-first ordering — Pitfall 5. Neutral
         *  (factor 1.0) whenever the per-memory usefulness signal is absent. */
        usefulnessAlpha: z.number().min(0).max(1).default(0.1),
      })
      .default(() => ({
        recencyAlpha: 0.2,
        temporalAlpha: 0.2,
        proofAlpha: 0.1,
        trustAlpha: 0.1,
        usefulnessAlpha: 0.1,
      })),
    /** Per-lane RRF weights for the FTS + vector fusion lanes (LANES-01). These REPLACE the
     *  weights hybridSearch.ts hardcoded (computeRRF 1.0/1.5) — they now live at the agent's
     *  fuse() seam so an operator can tune the fts-vs-vector balance. The DEFAULTS {fts:1.0,
     *  vector:1.5} are the PARITY GUARD: with defaults the recall ranking is byte-for-byte
     *  identical to v2.6 (the characterization test enforces it; T-95-01). Bounded `min(0)`
     *  so a negative weight (which could invert RRF ordering) is rejected at parse (T-95-02);
     *  the upper bound is left open like entityLane.weight (a large finite weight only
     *  re-orders). NB: a `temporal` sub-lane is added under `lanes` by Phase 95-02 — additive. */
    lanes: z
      .strictObject({
        /** FTS (BM25) lane weight. Default 1.0 — the parity value (hybrid-search.ts:310). */
        fts: z.strictObject({ weight: z.number().min(0).default(1.0) }).default(() => ({ weight: 1.0 })),
        /** Vector (KNN) lane weight. Default 1.5 — the parity value (hybrid-search.ts:311). */
        vector: z.strictObject({ weight: z.number().min(0).default(1.5) }).default(() => ({ weight: 1.5 })),
        /** Temporal-spread lane (LANES-02). Default-OFF; surfaces memories near the seed
         *  hits' `occurred_at` event times (the "what else happened around then" spread). With
         *  `enabled:false` the lane is never pushed → fuse() sees the same lanes as before this
         *  plan → recall output is byte-identical (the ENT-04 no-op reused; a wrong default
         *  ships dormant — no surprise ranking change on upgrade, T-95-07). `weight` is
         *  `min(0)` (no negative RRF term, T-95-08); `windowDays` is `int().positive()` (no
         *  zero/negative window). windowDays:7 surfaces neighbours within a week of the seeds. */
        temporal: z
          .strictObject({
            enabled: z.boolean().default(false),
            weight: z.number().min(0).default(1.0),
            windowDays: z.number().int().positive().default(7),
          })
          .default(() => ({ enabled: false, weight: 1.0, windowDays: 7 })),
        /** Causal one-hop recall lane (EXTRACT-03). Default-OFF; surfaces memories causally
         *  linked (cause↔effect) to the seeds via the additive memory_causal_edges table. With
         *  `enabled:false` the lane is never pushed → fuse() unchanged → recall byte-identical
         *  (the ENT-04 no-op reused; no surprise ranking change on upgrade, T-96-10). `weight` is
         *  `min(0)` (no negative RRF term, T-95-08). The exact temporal-lane sibling, minus the
         *  windowDays knob — a causal edge is a discrete one-hop link, not a time window. */
        causal: z
          .strictObject({
            enabled: z.boolean().default(false),
            weight: z.number().min(0).default(1.0),
          })
          .default(() => ({ enabled: false, weight: 1.0 })),
      })
      .default(() => ({
        fts: { weight: 1.0 },
        vector: { weight: 1.5 },
        temporal: { enabled: false, weight: 1.0, windowDays: 7 },
        causal: { enabled: false, weight: 1.0 },
      })),
    /** One-hop entity-associative lane (ENT-02). Default-OFF; the daemon enables it once
     *  the entity store is wired (Phase-83 Plan 05). Empty/disabled -> RRF unchanged (ENT-04). */
    entityLane: z
      .strictObject({
        /** Default-OFF; enabled by the daemon once the entity store is wired. */
        enabled: z.boolean().default(false),
        /** How many top search hits seed the self-join (design §4.4 seedCount). */
        seedCount: z.number().int().positive().default(5),
        /** Max shared-entity neighbour rows the lane returns (design §4.4 perEntityCap default 200). */
        perEntityCap: z.number().int().positive().default(200),
        /** RRF weight for the entity lane (parity with the other lanes). */
        weight: z.number().min(0).default(1.0),
      })
      .default(() => ({ enabled: false, seedCount: 5, perEntityCap: 200, weight: 1.0 })),
    /** Recall-utility feedback loop (FEED-04). Default-OFF; the daemon enables the write-back
     *  + the score factor only when on. Off => byte-identical to v2.6 (no read, no emit, no
     *  factor — the read-path in memory-recall.ts, the turn-end emit in
     *  executor-post-execution.ts, and the daemon write-back subscriber all gate on this flag). */
    feedback: z
      .strictObject({
        /** Default-OFF. The SINGLE master toggle. When on: turn-end attribution emits
         *  memory:recall_used, the daemon writes the usefulness signal, and recall folds the
         *  usefulnessFactor. The magnitude is rag.scoring.usefulnessAlpha (NOT duplicated here —
         *  one canonical knob, no drift). A `.strictObject` so a stray `usefulnessAlpha` here is
         *  REJECTED at parse, structurally enforcing the single-knob invariant. */
        enabled: z.boolean().default(false),
      })
      .default(() => ({ enabled: false })),
  });

export type RagConfig = z.infer<typeof RagConfigSchema>;

/** Bootstrap configuration for workspace file injection into system prompts. */
export const BootstrapConfigSchema = z.strictObject({
    /** Per-file character limit for workspace files injected into system prompt */
    maxChars: z.number().int().positive().default(20_000),
    /** System prompt verbosity mode: full (all sections), minimal (sub-agents), none (identity only) */
    promptMode: z.enum(["full", "minimal", "none"]).default("full"),
    /** When true, USER.md is excluded from bootstrap context in group chat sessions (privacy). Default: true. */
    groupChatFiltering: z.boolean().default(true),
  });

export type BootstrapConfig = z.infer<typeof BootstrapConfigSchema>;

/** Per-agent concurrency limits (maxConcurrentRuns controls session serialization). */
export const ConcurrencyConfigSchema = z.strictObject({
    /** Maximum concurrent agent runs for this agent (default: 4) */
    maxConcurrentRuns: z.number().int().positive().default(4),
    /** Maximum queued messages per session before overflow (default: 50) */
    maxQueuedPerSession: z.number().int().positive().default(50),
  });

export type ConcurrencyConfig = z.infer<typeof ConcurrencyConfigSchema>;

/** Target channel for a broadcast group delivery. */
export const BroadcastTargetSchema = z.strictObject({
    /** Channel type (e.g., "telegram", "discord", "slack") */
    channelType: z.string().min(1),
    /** Channel identifier within the platform */
    channelId: z.string().min(1),
    /** Chat/conversation identifier within the channel */
    chatId: z.string().min(1),
  });

/** Broadcast group for simultaneous multi-channel message delivery. */
export const BroadcastGroupSchema = z.strictObject({
    /** Unique group identifier (referenced in broadcast tool calls) */
    id: z.string().min(1),
    /** Human-readable group name */
    name: z.string().default(""),
    /** Channel targets for simultaneous delivery */
    targets: z.array(BroadcastTargetSchema).default([]),
    /** Whether this broadcast group is active */
    enabled: z.boolean().default(true),
  });

export type BroadcastTarget = z.infer<typeof BroadcastTargetSchema>;
export type BroadcastGroup = z.infer<typeof BroadcastGroupSchema>;

/** Elevated reply mode: routes messages to different models based on sender trust level. */
export const ElevatedReplyConfigSchema = z.strictObject({
  /** Enable trust-based model/prompt routing */
  enabled: z.boolean().default(false),
  /** Map of trust level name to model route name (from modelRoutes) */
  trustModelRoutes: z.record(z.string(), z.string()).default({}),
  /** Map of trust level name to system prompt section override text */
  trustPromptOverrides: z.record(z.string(), z.string()).default({}),
  /** Default trust level for unknown senders */
  defaultTrustLevel: z.string().default("external"),
  /** Per-sender trust level overrides (senderId -> trust level name) */
  senderTrustMap: z.record(z.string(), z.string()).default({}),
});

export type ElevatedReplyConfig = z.infer<typeof ElevatedReplyConfigSchema>;

/** Per-agent JSONL trace configuration (disabled by default). */
export const TracingConfigSchema = z.strictObject({
  /** Enable per-LLM-call JSONL trace files */
  enabled: z.boolean().default(false),
  /** Output directory for JSONL trace files. Supports ~ expansion. Default: ~/.comis/traces */
  outputDir: z.string().default("~/.comis/traces"),
});

export type TracingConfig = z.infer<typeof TracingConfigSchema>;

/** SDK retry configuration: controls exponential backoff for transient errors (429, 5xx).
 *  The SDK handles retry internally; this schema configures its behavior per-agent. */
export const SdkRetryConfigSchema = z.strictObject({
  /** Enable SDK-native retry with exponential backoff */
  enabled: z.boolean().default(true),
  /** Maximum number of retry attempts for transient errors (5 retries = 6 total attempts) */
  maxRetries: z.number().int().nonnegative().default(5),
  /** Base delay in milliseconds before first retry (4s base with exponential backoff: 4s, 8s, 16s, 32s, 60s capped) */
  baseDelayMs: z.number().int().positive().default(4000),
  /** Maximum delay cap in milliseconds between retries */
  maxDelayMs: z.number().int().positive().default(60000),
});

export type SdkRetryConfig = z.infer<typeof SdkRetryConfigSchema>;

/** Context window guard configuration: percent-based warn/block thresholds. */
export const ContextGuardConfigSchema = z.strictObject({
  /** Enable context window guard checks during execution */
  enabled: z.boolean().default(true),
  /** Warn when context usage reaches this percent (0-100). Default: 80. */
  warnPercent: z.number().min(0).max(100).default(80),
  /** Block (abort) execution when context usage reaches this percent (0-100). Default: 95. */
  blockPercent: z.number().min(0).max(100).default(95),
});

export type ContextGuardConfig = z.infer<typeof ContextGuardConfigSchema>;

/** Tool lifecycle management: per-turn usage tracking and automatic demotion of unused tools. */
export const ToolLifecycleConfigSchema = z.strictObject({
  /** Whether tool lifecycle management is enabled. When false, no usage tracking or demotion occurs. */
  enabled: z.boolean().default(true),
  /** Number of turns of non-use before a tool is demoted (schema-stripped). */
  demotionThreshold: z.number().int().positive().default(20),
});

export type ToolLifecycleConfig = z.infer<typeof ToolLifecycleConfigSchema>;

/** Deferred tools configuration: operator control over tool deferral behavior per-agent. */
export const DeferredToolsConfigSchema = z.strictObject({
  /** Deferral mode: "always" defers all non-core tools, "auto" uses rule+budget heuristics, "never" disables deferral. */
  mode: z.enum(["always", "auto", "never"]).default("auto"),
  /** Tool names that must never be deferred (force-loaded into active context). Glob patterns NOT supported -- exact names only. */
  neverDefer: z.array(z.string()).default([]),
  /** Tool names that must always be deferred (force-deferred regardless of rules). Glob patterns NOT supported -- exact names only. */
  alwaysDefer: z.array(z.string()).default([]),
});

export type DeferredToolsConfig = z.infer<typeof DeferredToolsConfigSchema>;

/** Silent Execution Planner (SEP) configuration: in-memory checklist system for multi-step task tracking. */
export const SepConfigSchema = z.strictObject({
  /** Enable/disable SEP. Default: true. */
  enabled: z.boolean().default(true),
  /** Minimum estimated steps to activate planning (below this threshold, overhead isn't worth it). */
  minSteps: z.number().int().min(2).max(10).default(3),
  /** Whether to inject a verification nudge when all steps complete. Default: true. */
  verificationNudge: z.boolean().default(true),
  /** Maximum plan steps to track (prevents runaway extraction on vague requests). */
  maxSteps: z.number().int().min(3).max(30).default(15),
  /** Whether to include progress in user-visible response. Default: false. */
  userVisibleProgress: z.boolean().default(false),
});

export type SepConfig = z.infer<typeof SepConfigSchema>;
