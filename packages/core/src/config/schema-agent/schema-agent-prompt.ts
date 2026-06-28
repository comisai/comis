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
    /** Minimum BASE relevance score (pre-boost) for memory injection.
     *  Boosts cannot resurrect a memory whose base score is below this threshold.
     *  Gates on ScoreBreakdown.base (the un-boosted cosine/RRF score), applied AFTER
     *  scoreWithBreakdown() and BEFORE the trust-filter (T-153-poison mitigation).
     *  Default=0 means no floor — all memories pass, preserving exact prior behavior.
     *  S6: a weaker ModelProfile cannot lower this below the operator-set value. */
    baseFloor: z.number().min(0).max(1).default(0).describe(
      "Minimum BASE relevance score (pre-boost) for memory injection. " +
      "Boosts cannot resurrect a memory whose base score is below this threshold. " +
      "Frozen: a weaker ModelProfile cannot lower this below the operator-set value (S6).",
    ),
    /** Trust levels to include in retrieval (external excluded by default for security) */
    includeTrustLevels: z.array(TrustLevelSchema).default(["system", "learned"]),
    /** Cross-encoder reranking. Opt-out posture: default-ON as a
     *  $0-at-recall capability. The daemon resolves the EFFECTIVE rerank via the RAW
     *  pre-Zod signal (`rawAgentRerankEnabled` → resolveEffectiveRerank): an UNSET config
     *  auto-ons only when the model is locally present (zero-download posture),
     *  so this schema default is the bare-parse value, NOT a forced download. */
    rerank: z
      .strictObject({
        /** Opt-out posture: default-ON. The daemon's effective-rerank
         *  precedence (raw-signal + model-present) still governs the auto-on/download path. */
        enabled: z.boolean().default(true),
        /** Candidate cap bounding worst-case rerank latency (~29ms/candidate). */
        maxCandidates: z.number().int().positive().default(40),
        /** Skip reranking when fewer than this many candidates are present. */
        minResults: z.number().int().nonnegative().default(1),
        /** Rerank wall-clock timeout (ms); on timeout fall back to fusion order. */
        timeoutMs: z.number().int().positive().default(800),
      })
      .default(() => ({ enabled: true, maxCandidates: 40, minResults: 1, timeoutMs: 800 })),
    /** Multiplicative scoring boosts applied to the reranked-or-fused score. */
    scoring: z
      .strictObject({
        /** Recency boost weight (applied now via createdAt). */
        recencyAlpha: z.number().min(0).max(1).default(0.2),
        /** Event-time proximity boost weight (LIVE — applies when occurredAt is present, neutral when absent). */
        temporalAlpha: z.number().min(0).max(1).default(0.2),
        /** Proof-count boost weight (hook; neutral until proofCount exists). */
        proofAlpha: z.number().min(0).max(1).default(0.1),
        /** Trust-level boost weight + tie-break. */
        trustAlpha: z.number().min(0).max(1).default(0.1),
        /** Usefulness boost weight (the SINGLE canonical usefulness knob —
         *  the recall-utility feedback loop reads `rag.scoring.usefulnessAlpha`, NOT a knob on
         *  `rag.feedback`). Bounded small (same magnitude as trust/proof) so a proven-useful
         *  memory is boosted but CANNOT overturn trust-first ordering — Pitfall 5. Neutral
         *  (factor 1.0) whenever the per-memory usefulness signal is absent. */
        usefulnessAlpha: z.number().min(0).max(1).default(0.1),
        /** FadeMem decay boost weight (the SINGLE canonical decay knob —
         *  the recall-side gate `rag.forget` carries only the on/off toggle, NOT a magnitude).
         *  Bounded small (same magnitude as trust/proof/usefulness) so a stale memory's decay
         *  RANKS but CANNOT overturn trust-first ordering — Pitfall 2. The factor only ever
         *  demotes (∈ [0.5,1], wrapped by this alpha), and is neutral (factor 1.0) at
         *  event-age 0 (the neutral-in-time byte-identity point), regardless of the
         *  `rag.forget` toggle (which defaults ON), OR when forget is explicitly disabled. */
        forgetAlpha: z.number().min(0).max(1).default(0.1),
      })
      .default(() => ({
        recencyAlpha: 0.2,
        temporalAlpha: 0.2,
        proofAlpha: 0.1,
        trustAlpha: 0.1,
        usefulnessAlpha: 0.1,
        forgetAlpha: 0.1,
      })),
    /** Per-lane RRF weights for the FTS + vector fusion lanes. These REPLACE the
     *  weights hybridSearch.ts hardcoded (computeRRF 1.0/1.5) — they now live at the agent's
     *  fuse() seam so an operator can tune the fts-vs-vector balance. The DEFAULTS {fts:1.0,
     *  vector:1.5} are the PARITY GUARD: with defaults the recall ranking is byte-for-byte
     *  identical to the prior hardcoded behaviour (the characterization test enforces it). Bounded `min(0)`
     *  so a negative weight (which could invert RRF ordering) is rejected at parse;
     *  the upper bound is left open like entityLane.weight (a large finite weight only
     *  re-orders). NB: a `temporal` sub-lane is added under `lanes` — additive. */
    lanes: z
      .strictObject({
        /** FTS (BM25) lane weight. Default 1.0 — the parity value (hybrid-search.ts:310). */
        fts: z.strictObject({ weight: z.number().min(0).default(1.0) }).default(() => ({ weight: 1.0 })),
        /** Vector (KNN) lane weight. Default 1.5 — the parity value (hybrid-search.ts:311). */
        vector: z.strictObject({ weight: z.number().min(0).default(1.5) }).default(() => ({ weight: 1.5 })),
        /** Temporal-spread lane. Opt-out posture: default-ON;
         *  surfaces memories near the seed hits' `occurred_at` event times (the "what else
         *  happened around then" spread). $0 at recall — an additive on-device fusion lane that
         *  is neutral when no occurred_at seed exists (the no-seed gate). `weight` is `min(0)`
         *  (no negative RRF term); `windowDays` is `int().positive()` (no zero/negative
         *  window). windowDays:7 surfaces neighbours within a week of the seeds. */
        temporal: z
          .strictObject({
            enabled: z.boolean().default(true),
            weight: z.number().min(0).default(1.0),
            windowDays: z.number().int().positive().default(7),
          })
          .default(() => ({ enabled: true, weight: 1.0, windowDays: 7 })),
        /** Causal one-hop recall lane. Opt-out posture:
         *  default-ON; surfaces memories causally linked (cause↔effect) to the seeds via the
         *  additive memory_causal_edges table. $0 at recall — neutral when no causal edges exist
         *  (the empty-lane no-op). `weight` is `min(0)` (no negative RRF term). The exact
         *  temporal-lane sibling, minus the windowDays knob — a causal edge is a discrete one-hop
         *  link, not a time window. */
        causal: z
          .strictObject({
            enabled: z.boolean().default(true),
            weight: z.number().min(0).default(1.0),
          })
          .default(() => ({ enabled: true, weight: 1.0 })),
        /** Graph-spread recall lane. Opt-out posture:
         *  default-ON; surfaces memories STRUCTURALLY connected to the seeds via a bounded
         *  recursive-CTE walk over the trust-first triple store's OWN current-truth
         *  `subject → object` edges (`t_valid_end IS NULL`), depth- + fan-out-capped so it stays
         *  O(bounded) on-device, LLM-free. $0 at recall — neutral when the triple store has no
         *  connected edges (the empty-lane no-op). `weight` is `min(0)` (no negative RRF
         *  term). `maxDepth` (the hop cap, default 2 — the "bounded 2-hop weighted spread")
         *  and `fanOut` (the per-node expansion cap, default 8 — a hub can't blow the
         *  recursive frontier) are `int().positive()` (no zero/negative bound). The
         *  triple/causal/temporal-lane sibling, plus the two walk caps. */
        graphSpread: z
          .strictObject({
            enabled: z.boolean().default(true),
            weight: z.number().min(0).default(1.0),
            maxDepth: z.number().int().positive().default(2),
            fanOut: z.number().int().positive().default(8),
          })
          .default(() => ({ enabled: true, weight: 1.0, maxDepth: 2, fanOut: 8 })),
      })
      .default(() => ({
        fts: { weight: 1.0 },
        vector: { weight: 1.5 },
        temporal: { enabled: true, weight: 1.0, windowDays: 7 },
        causal: { enabled: true, weight: 1.0 },
        graphSpread: { enabled: true, weight: 1.0, maxDepth: 2, fanOut: 8 },
      })),
    /** One-hop entity-associative lane. Opt-out posture:
     *  default-ON. $0 at recall — neutral when no shared-entity neighbours exist (empty/
     *  disabled -> RRF unchanged). The daemon builds the entity store unconditionally. */
    entityLane: z
      .strictObject({
        /** Opt-out posture: default-ON. */
        enabled: z.boolean().default(true),
        /** How many top search hits seed the self-join (design §4.4 seedCount). */
        seedCount: z.number().int().positive().default(5),
        /** Max shared-entity neighbour rows the lane returns (design §4.4 perEntityCap default 200). */
        perEntityCap: z.number().int().positive().default(200),
        /** RRF weight for the entity lane (parity with the other lanes). */
        weight: z.number().min(0).default(1.0),
      })
      .default(() => ({ enabled: true, seedCount: 5, perEntityCap: 200, weight: 1.0 })),
    /** Recall-utility feedback loop. Opt-out posture: default-ON.
     *  $0 at recall (the usefulness read + write-back are on-device, no API budget). When on:
     *  turn-end attribution emits memory:recall_used, the daemon writes the usefulness signal,
     *  and recall folds the usefulnessFactor (neutral 1.0 whenever no signal exists yet). */
    feedback: z
      .strictObject({
        /** Opt-out posture: default-ON. The SINGLE master toggle. When on:
         *  turn-end attribution emits memory:recall_used, the daemon writes the usefulness signal,
         *  and recall folds the usefulnessFactor. The magnitude is rag.scoring.usefulnessAlpha
         *  (NOT duplicated here — one canonical knob, no drift). A `.strictObject` so a stray
         *  `usefulnessAlpha` here is REJECTED at parse, structurally enforcing the single-knob
         *  invariant. */
        enabled: z.boolean().default(true),
      })
      .default(() => ({ enabled: true })),
    /** MMR diversity re-rank. Opt-out posture: default-ON. $0 at
     *  recall — an on-device embedding read + greedy re-rank (no API budget). λ=1.0 = pure
     *  relevance = byte-identical to the post-rerank order (the neutral guarantee);
     *  the default λ=0.7 trades a small relevance margin for diversity. λ bounded [0,1]
     *  (an out-of-range λ would invert the rel/diversity balance — rejected at parse). The daemon
     *  constructs the embedding store unconditionally. */
    mmr: z
      .strictObject({
        enabled: z.boolean().default(true),
        lambda: z.number().min(0).max(1).default(0.7),
      })
      .default(() => ({ enabled: true, lambda: 0.7 })),
    /** FadeMem per-type decay. Opt-out posture:
     *  default-ON; the recall-side gate for the 6th 0.5-centered scoring multiplicand
     *  `0.5 + 0.5·exp(−λ·Δt^β)`. $0 at recall — a pure closed-form decay over event age (no API
     *  budget). OFF ⇒ forgetFactor forced to EXACTLY 1.0 in score.ts. The neutral-importance
     *  byte-identity holds even when ON: at event-age 0 the factor is exactly 1.0, so a
     *  legacy/neutral fresh row never silently shifts. The magnitude is the single canonical
     *  `rag.scoring.forgetAlpha` (NOT duplicated here — one knob, no drift). A `.strictObject` so
     *  a stray field (e.g. a smuggled `forgetAlpha`) is REJECTED at parse, structurally enforcing
     *  the single-knob invariant. */
    forget: z.strictObject({ enabled: z.boolean().default(true) }).default(() => ({ enabled: true })),
    /** Pinned-memory injection knobs. Default-OFF (new surface; opt-in).
     *  enabled=true activates the pinned-first recall lane.
     *  maxPinnedInjection caps the bounded set (default 5 entries).
     *  At ~100 chars/entry × 5 = ~500 chars of the 4000-char maxContextChars budget (12.5%). */
    pinned: z
      .strictObject({
        enabled: z.boolean().default(false),
        maxPinnedInjection: z.number().int().positive().default(5),
      })
      .default(() => ({ enabled: false, maxPinnedInjection: 5 })),
    /** LLM-free query understanding. Opt-out posture: all
     *  default-ON. $0 at recall — each toggle is an additive DETERMINISTIC, LLM-FREE capability
     *  over the existing recall path (NO LLM call on the recall hot path — binding constraint #1).
     *  `intentReweight` multiplies the existing lane weights by a pure intent classifier;
     *  `synonyms` expands the FTS query terms via a bounded static map; `temporalParse` parses NL
     *  time expressions into an occurred_at range filter. */
    queryUnderstanding: z
      .strictObject({
        intentReweight: z.boolean().default(true),
        synonyms: z.boolean().default(true),
        temporalParse: z.boolean().default(true),
      })
      .default(() => ({ intentReweight: true, synonyms: true, temporalParse: true })),
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

/**
 * GoalAnchor configuration: tail-injects the current execution objective +
 * uncompleted steps into the system prompt. Gated on scaffoldLevel==="max"
 * (small + nano models only) in the prompt assembly layer (Plan 02).
 *
 * Default enabled=false ensures frontier/mid receive no injection until
 * explicitly configured (behavior-neutral for all existing agents).
 * Output is bounded by maxChars (default 500) to cap tail injection size.
 */
export const GoalAnchorConfigSchema = z.strictObject({
  /** Enable GoalAnchor tail injection. Default: false (opt-in). */
  enabled: z.boolean().default(false),
  /**
   * Maximum characters for the injected GoalAnchor block.
   * Bounded [100, 2000] to prevent starvation (< 100) or context waste (> 2000).
   * Default: 500 (~5–10 steps at ~50 chars/step).
   */
  maxChars: z.number().int().min(100).max(2000).default(500),
});

export type GoalAnchorConfig = z.infer<typeof GoalAnchorConfigSchema>;

/**
 * Pre-delivery verification critic configuration (R4, Phase 154).
 *
 * The critic scores a completion-claiming response against the GoalAnchor
 * checklist and returns verified / not-verified / skipped. Gated on
 * scaffoldLevel==="max" (small + nano models only) when enabled.
 *
 * Default enabled=false ensures the critic does not fire until explicitly
 * configured by the operator. Behavior-neutral for all existing agents.
 */
export const VerificationConfigSchema = z.strictObject({
  /** Enable pre-delivery verification critic. Default: false (opt-in; meaningful only for scaffoldLevel=max). */
  enabled: z.boolean().default(false),
  /**
   * Minimum response length in characters before the critic is invoked.
   * Prevents firing on clarifying questions, short acks, and non-claim replies.
   * Bounded [50, 2000]. Default: 200.
   */
  minResponseChars: z.number().int().min(50).max(2000).default(200),
});

export type VerificationConfig = z.infer<typeof VerificationConfigSchema>;

/**
 * Honesty guardrail configuration (R4/S2, Phase 154).
 *
 * Bounds critic retry redirects and enforces an honest unmet-list when
 * the redirect budget is exhausted. Prevents the executor from looping
 * indefinitely while still requiring the agent to deliver a qualified
 * response when it cannot satisfy all requirements.
 */
export const HonestyConfigSchema = z.strictObject({
  /**
   * Maximum critic retry redirects before delivering an honest unmet-list.
   * After this many not-verified verdicts, the executor delivers an honest
   * unmet-list instead of an unqualified "done". Default: 2.
   */
  maxCriticRetries: z.number().int().min(0).max(5).default(2),
});

export type HonestyConfig = z.infer<typeof HonestyConfigSchema>;
