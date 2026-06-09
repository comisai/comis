// SPDX-License-Identifier: Apache-2.0
/**
 * Pure types for the PiExecutor factory — extracted to a dedicated file so
 * closure-extracted helpers can `import type { PiExecutorDeps }` without
 * creating a cyclic import with `pi-executor.ts` (which itself imports
 * those helpers).
 *
 * @module
 */

import type {
  AuthStorage,
  ModelRegistry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  TypedEventBus,
  MemoryPort,
  MemoryEntityStore,
  MemoryTemporalStore,
  MemoryCausalStore,
  TripleStorePort,
  MemoryEmbeddingStore,
  MemoryUsefulnessStore,
  MemoryPinnedStore,
  TunedAlphaStore,
  UserRepresentationStore,
  RelationshipStore,
  RerankerPort,
  HookRunner,
  SecretManager,
  EnvelopeConfig,
  OutputGuardPort,
  InputValidationResult,
  InputSecurityGuard,
  InjectionRateLimiter,
  SenderTrustDisplayConfig,
  ToolCapabilityPort,
  ClockPort,
  EnvPort,
  TimerPort,
  ContextStorePort,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";

import type { BudgetGuard } from "../../budget/budget-guard.js";
import type { CostTracker } from "../../budget/cost-tracker.js";
import type { StepCounter } from "../step-counter.js";
import type { CircuitBreaker } from "../../safety/circuit-breaker.js";
import type { SummarizerSpendBreaker } from "../../safety/summarizer-spend-breaker.js";
import type { ProviderHealthMonitor } from "../../safety/provider-health-monitor.js";
import type { ComisSessionManager } from "../../session/comis-session-manager.js";
import type { AuthRotationAdapter } from "../../model/auth-rotation-adapter.js";
import type { OAuthTokenManager } from "../../model/oauth-token-manager.js";
import type { ActiveRunRegistry } from "../active-run-registry.js";
import type { GeminiCacheManager } from "../gemini-cache-manager.js";
import type { BackgroundTaskManager } from "../../background/index.js";

/** Dependencies required by the PiExecutor. */
export interface PiExecutorDeps {
  // Safety controls
  circuitBreaker: CircuitBreaker;
  /** Optional provider health monitor for cross-agent pre-check. */
  providerHealth?: ProviderHealthMonitor;
  /** Optional last-known-working model tracker for auth-failure fallback. */
  lastKnownModel?: import("../../model/last-known-model.js").LastKnownModelTracker;
  budgetGuard: BudgetGuard;
  costTracker: CostTracker;
  stepCounter: StepCounter;
  eventBus: TypedEventBus;
  logger: ComisLogger;
  /**
   * Optional ExecutionPlanPort holder. When provided, session-bootstrap
   * publishes the per-turn SEP ref into it (SEP-on) / clears it (SEP-off) so the
   * gateway/ACP plan bridge reads the live plan via the shared port. Absent in
   * non-ACP runtimes — existing callers are unaffected.
   */
  executionPlanHolder?: import("./execution-plan-holder.js").ExecutionPlanHolder;
  // Adapters
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
  providerAliases?: Map<string, string>;
  // Session management
  sessionAdapter: ComisSessionManager;
  // Workspace
  workspaceDir: string;
  /** Daemon data dir (COMIS_DATA_DIR / config.dataDir). Threaded to
   *  prompt-assembly via ToolAssemblyDeps so the recall-trace recorder resolves
   *  its containment base from the SAME source the memory.recall_trace reader
   *  uses. Absent ⇒ ~/.comis. */
  dataDir?: string;
  // Tools
  customTools: ToolDefinition[];
  /** Convert per-request AgentTool[] to ToolDefinition[] for SDK registration.
   * Injected by daemon wiring to avoid agent->skills circular dependency.
   * When provided, per-request `tools` parameter is converted and merged with customTools. */
  convertTools?: (tools: AgentTool[]) => ToolDefinition[];
  /** SDK agent directory for persistent settings file storage. */
  agentDir: string;
  // Optional
  memoryPort?: MemoryPort;
  /** Optional LCD context store (Phase 128 dag-mode write-path + assembly).
   *  TYPE-only from @comis/core — the agent never imports the memory package
   *  (the agent↛memory cut); the daemon injects the concrete createLcdStore.
   *  Absent ⇒ no afterTurn ingest + the dag branch falls through to the
   *  pipeline (never crashes, never no-ops). */
  contextStore?: ContextStorePort;
  /** R1 (132-05): the daemon-owned per-tenant summarizer spend+breaker. ONE
   *  instance constructed at the composition root (mirrors the embedding breaker,
   *  setup-memory.ts) and injected here so it bounds AGGREGATE per-tenant
   *  summarizer spend across all of a tenant's sessions/agents. Threaded into
   *  ContextEngineSetupDeps so `getSummarizerDeps` wraps the leaf seam with
   *  `gate(tenantId, inner)` → open-breaker / over-cap bypasses the LLM → the
   *  ladder floors to truncation-only. Absent ⇒ the raw seam (tests / non-daemon
   *  callers). */
  summarizerSpendBreaker?: SummarizerSpendBreaker;
  /** Optional cross-encoder reranker. Built in the daemon (setup-memory) only when an
   *  agent enables rerank; threaded into prompt-assembly's createMemoryRecall via
   *  ToolAssemblyDeps. Absent -> recall keeps fusion order. */
  reranker?: RerankerPort;
  /** Optional entity-associative store. Built in the daemon on the
   *  shared memory db handle; threaded into prompt-assembly's createMemoryRecall via
   *  ToolAssemblyDeps. Absent -> no entity lane (recall RRF unchanged). TYPE-only from
   *  @comis/core — the agent never imports the memory package (the agent↛memory cut). */
  entityStore?: MemoryEntityStore;
  /** Optional temporal-spread store. Built in the daemon on the shared memory db
   *  handle; threaded into prompt-assembly's createMemoryRecall via ToolAssemblyDeps. Absent or
   *  flag-off -> no temporal lane (recall RRF unchanged). TYPE-only from @comis/core — the agent
   *  never imports the memory package (the agent↛memory cut). */
  temporalStore?: MemoryTemporalStore;
  /** Optional causal store. Built in the daemon on the shared memory db handle;
   *  threaded into prompt-assembly's createMemoryRecall via ToolAssemblyDeps. Absent or flag-off
   *  -> no causal lane (recall RRF unchanged). TYPE-only from @comis/core — the agent never
   *  imports the memory package (the agent↛memory cut). */
  causalStore?: MemoryCausalStore;
  /** Optional triple store. Built in the daemon on the shared memory db handle;
   *  threaded into prompt-assembly's createMemoryRecall via ToolAssemblyDeps. Absent or flag-off
   *  -> no graph-spread lane (recall RRF unchanged). TYPE-only from @comis/core — the agent
   *  never imports the memory package (the agent↛memory cut). */
  tripleStore?: TripleStorePort;
  /** Optional embedding read store. Built in the daemon on the shared memory db handle;
   *  threaded into prompt-assembly's createMemoryRecall via ToolAssemblyDeps. Absent or flag-off
   *  -> no MMR diversity re-rank (recall order unchanged). TYPE-only from @comis/core — the agent
   *  never imports the memory package (the agent↛memory cut). */
  embeddingStore?: MemoryEmbeddingStore;
  /** Optional usefulness store. Built in the daemon on the shared memory db handle;
   *  threaded into prompt-assembly's createMemoryRecall via ToolAssemblyDeps. Absent or flag-off
   *  -> no usefulness read (recall scoring unchanged). TYPE-only from @comis/core — the agent
   *  never imports the memory package (the agent↛memory cut). */
  usefulnessStore?: MemoryUsefulnessStore;
  /** Optional pinned-memory store. The SAME `memoryAdapter` (SqliteMemoryAdapter) already
   *  passed as `memoryPort` — it implements both `MemoryPort` AND `MemoryPinnedStore`. Passed
   *  separately so prompt-assembly's createMemoryRecall Step-0 pinned-first lane gate
   *  (`cfg_pinned?.enabled === true && deps.pinnedStore !== undefined`) can fire at runtime.
   *  Without this forward the pinned lane is a silent no-op in every live agent response
   *  (the R6 blocker). DEFAULT-OFF BYTE-IDENTITY: with `rag.pinned.enabled=false` or absent,
   *  no pinnedStore query runs. TYPE-only from @comis/core (the agent↛memory cut). */
  pinnedStore?: MemoryPinnedStore;
  /** Optional learned-alpha store. Built in the daemon on the shared memory db handle;
   *  threaded into prompt-assembly's deterministic apply overlay (the gated buildScoringAlphas read)
   *  via ToolAssemblyDeps. Absent or flag-off -> no read, the static config.rag.scoring alphas pass
   *  unchanged (byte-identical recall). TYPE-only from @comis/core — the agent never imports the
   *  memory package (the agent↛memory cut). */
  tunedAlphaStore?: TunedAlphaStore;
  /** Optional per-user representation store. Built in the daemon on the shared memory db
   *  handle; threaded into prompt-assembly's LLM-free `<user_profile>` injection via ToolAssemblyDeps.
   *  Absent -> no profile read, no push, byte-identical prompt (the default-OFF cost gate). TYPE-only
   *  from @comis/core — the agent never imports the memory package (the agent↛memory cut). */
  userRepresentationStore?: UserRepresentationStore;
  /** Optional directional relationship store. Built in the daemon on the shared memory
   *  db handle; threaded into prompt-assembly's LLM-free `<channel_relationships>` injection via
   *  ToolAssemblyDeps. Absent -> no relationship read, no push, byte-identical prompt (the default-OFF
   *  + sign-off-gated cost gate). TYPE-only from @comis/core — the agent never imports the memory
   *  package (the agent↛memory cut). A missing forward here is a silent no-op even with the store wired
   *  in the daemon (the documented latent field-plumbing drop — Pitfall 6). */
  relationshipStore?: RelationshipStore;
  hookRunner?: HookRunner;
  // System prompt config
  outboundMediaEnabled?: boolean;
  mediaPersistenceEnabled?: boolean;
  autonomousMediaEnabled?: boolean;
  getPromptSkillsXml?: () => string;
  /** Tool names available to sub-agents, injected by daemon from TOOL_PROFILES + config. */
  subAgentToolNames?: string[];
  /** Whether sub-agents inherit MCP tools from parent (subAgentMcpTools: "inherit"). */
  mcpToolsInherited?: boolean;
  // Full prompt assembly
  secretManager?: SecretManager;
  envelopeConfig?: EnvelopeConfig;
  // Model fallback
  /** Fallback models in "provider:modelId" format, e.g. ["anthropic:claude-sonnet-4-20250514"] */
  fallbackModels?: string[];
  /** Optional auth rotation adapter for multi-key providers. */
  authRotation?: AuthRotationAdapter;
  /**
   * Optional OAuth token manager. When provided, the per-LLM-call
   * dispatch hook in execute() resolves the OAuth token via the resolver
   * chain (agent-config -> lastGood -> first available) and sets it into
   * authStorage's runtime override Map for pi-coding-agent's outbound LLM
   * call.
   *
   * Single hook per execute() — long-running execute()s
   * (>= 1 hour) may see token expire mid-loop; revisit if observed
   * in production.
   */
  oauthManager?: OAuthTokenManager;
  /** Active run registry for mid-execution steering. */
  activeRunRegistry?: ActiveRunRegistry;
  /** Daemon-level tracing defaults for rotation. */
  tracingDefaults?: { maxSize: string; maxFiles: number };
  /** OutputGuard for scanning and redacting critical secrets in LLM responses. */
  outputGuard?: OutputGuardPort;
  /** Canary token for detecting canary leakage in LLM responses. */
  canaryToken?: string;
  /** InputValidator for structural message checks. */
  inputValidator?: (text: string) => InputValidationResult;
  /** InputSecurityGuard for jailbreak detection with scoring. */
  inputGuard?: InputSecurityGuard;
  /** InjectionRateLimiter for progressive cooldown on repeated high-risk detections. */
  rateLimiter?: InjectionRateLimiter;
  /** Optional skill registry for SDK skill discovery integration.
   * Defined as a minimal interface to avoid agent->skills circular dependency.
   * When provided, SDK-discovered skills are filtered through Comis eligibility
   * and the registry is populated from SDK discovery results. */
  skillRegistry?: {
    getEligibleSkillNames(): Set<string>;
    initFromSdkSkills(sdkSkills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean }>): void;
    /**
     * Optional accessor for the populated trace.metadata snapshot.
     * Structural (not importing SkillSnapshot from @comis/skills) to avoid an
     * agent -> skills circular dependency.
     * Daemon wiring passes the full @comis/skills SkillRegistry which implements
     * this shape; tests can pass the legacy two-method mock (getSnapshot absent).
     */
    getSnapshot?(): {
      readonly skills: ReadonlyArray<{
        readonly name: string;
        readonly version?: number | string;
      }>;
    };
  };
  /** Fire-and-forget embedding enqueue callback. Injected by daemon wiring. */
  embeddingEnqueue?: (entryId: string, content: string) => void;
  /** Optional embedding port for semantic search in discover_tools. */
  embeddingPort?: import("@comis/core").EmbeddingPort;
  /**
   * Tool-capability port for the per-turn capability-index renderer.
   * Daemon wiring injects createNoOpCapabilityPort() from @comis/core
   * until the live adapter ships.
   */
  toolCapabilityPort: ToolCapabilityPort;
  /** Sender trust display config from AppConfig. */
  senderTrustDisplayConfig?: SenderTrustDisplayConfig;
  /** Documentation config from AppConfig. */
  documentationConfig?: import("@comis/core").DocumentationConfig;
  /** Tenant ID for conversation creation. */
  tenantId?: string;
  /** Delivery mirror port for session mirroring injection. */
  deliveryMirror?: import("@comis/core").DeliveryMirrorPort;
  /** Delivery mirror config for injection budget limits. */
  deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
  // Provider compatibility config
  /** When true, only content inside <final> blocks reaches users. Consumer: ThinkingTagFilter. */
  enforceFinalTag?: boolean;
  /** When true, enables fast/cheap model routing. Consumer: stream wrappers. */
  fastMode?: boolean;
  /** When true, OpenAI store: true is injected. Consumer: stream wrappers. */
  storeCompletions?: boolean;
  /** Provider capabilities resolved from config. Consumer: resolveProviderCapabilities(). */
  providerCapabilities?: import("@comis/core").ProviderCapabilities;
  /** Discovered Ollama served num_ctx from the boot-time capacity probe.
   *  undefined = not probed (non-Ollama provider or probe failed — falls back to configured). */
  servedContextWindow?: number;
  /** Optional Gemini CachedContent lifecycle manager for explicit cache reuse. */
  geminiCacheManager?: GeminiCacheManager;
  /** Resolve platform message character limit for a channel type.
   * Injected by daemon wiring via channelPlugins capabilities. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
  /** Background task manager for auto-promotion of long-running tools. */
  backgroundTaskManager?: BackgroundTaskManager;
  /** Max message.send/reply calls per execution (0 = unlimited, default: 3). */
  maxSendsPerExecution?: number;
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Environment-variable reads. Required for fault-injector and model-retry env reads. */
  env: EnvPort;
  /** Timer scheduling. Required by executor-prompt-runner (race timers) and prompt-timeout. */
  timers: TimerPort;
  /**
   * Optional trajectory writer configuration. When omitted
   * or `enabled: false`, the per-session trajectory recorder is a
   * no-op. Forwarded from AppConfig.diagnostics.trajectory by daemon
   * wiring; the `dir` override threads through to
   * `resolveTrajectoryFilePath` (else COMIS_TRAJECTORY_DIR env or
   * workspaceDir/cwd fallbacks apply).
   */
  trajectoryConfig?: {
    readonly enabled?: boolean;
    readonly dir?: string;
    readonly maxFileBytes?: number;
    readonly eventTypes?: ReadonlyArray<string>;
  };
  /**
   * Optional session-scoped trajectory recorder registry. When provided,
   * pi-executor delegates recorder lifecycle (lazy-create on first turn,
   * close on session destroy) to this registry instead of constructing
   * a fresh recorder per `execute()` call. The registry guarantees the
   * session-trajectory invariants: monotonic `seq` across all
   * turns, exactly one `session.started`/`session.ended` per session,
   * bridge subscription matches recorder lifetime.
   *
   * Wired in the daemon composition root via
   * `createSessionTrajectoryHandleRegistry()` from @comis/observability.
   * The daemon's shutdown chain MUST call `closeAll()` to drain open
   * recorders. When `undefined`, the per-turn fallback construction
   * path lights up — kept for tests + the pre-rrm-260519 lifecycle.
   */
  trajectoryRegistry?: import("@comis/observability").SessionTrajectoryHandleRegistry;
  /**
   * Cache-trace writer configuration. Forwarded from
   * AppConfig.diagnostics.cacheTrace by daemon wiring. When omitted or
   * `enabled: false`, the per-session cache-trace recorder is a no-op.
   * The `filePath` override threads through to
   * `resolveCacheTraceFilePath` (else the default
   * `~/.comis/logs/cache-trace.jsonl` applies).
   */
  cacheTraceConfig?: {
    readonly enabled?: boolean;
    readonly filePath?: string;
    /**
     * Per-file byte cap for cache-trace JSONL. Defaults to the runtime's
     * fallback constant (50 MB) when undefined.
     */
    readonly maxFileBytes?: number;
    readonly includeMessages?: boolean;
    readonly includePrompt?: boolean;
    readonly includeSystem?: boolean;
  };
  /**
   * Recall-trace writer configuration. Forwarded from
   * AppConfig.diagnostics.recallTrace by daemon wiring, EXACTLY mirroring the
   * cacheTraceConfig thread above. Threaded onward via ToolAssemblyDeps into
   * PromptAssemblyParams.deps.recallTraceConfig, where buildRecallTrace reads
   * the `enabled` gate. When omitted or `enabled: false`, buildRecallTrace
   * returns null and createMemoryRecall captures nothing (recall-trace is
   * OPT-IN, default-off). There is intentionally NO raw-content slot (unlike
   * cacheTrace's includeMessages/includeSystem): the recorder always
   * full-sanitizes before disk.
   */
  recallTraceConfig?: {
    readonly enabled?: boolean;
    readonly filePath?: string;
    readonly maxFileBytes?: number;
  };
  /**
   * ObservabilityStore for SystemPromptReport SQLite
   * persistence. Forwarded from daemon composition root through
   * SingleAgentDeps.obsStore. When undefined (persistence disabled),
   * the build+persist block in prompt-assembly.ts:920 is a no-op —
   * production traffic produces no reports without this dep.
   */
  observabilityStore?: import("@comis/observability").ObservabilityStoreLike;
}
