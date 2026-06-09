// SPDX-License-Identifier: Apache-2.0
/**
 * Type contracts for the tool assembly pipeline (executor-tool-assembly.ts).
 *
 * Extracted from executor-tool-assembly.ts to keep that module under the
 * 800-line production-file cap (test/architecture/file-size.test.ts). Pure
 * type declarations — no runtime code. The defining module re-exports these
 * so existing `from "./executor-tool-assembly.js"` type imports keep working.
 *
 * @module
 */

import type {
  SettingsManager,
  DefaultResourceLoader,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  SessionKey,
  NormalizedMessage,
  PerAgentConfig,
  TypedEventBus,
  MemoryPort,
  HookRunner,
  SecretManager,
  EnvelopeConfig,
  SenderTrustDisplayConfig,
  ToolCapabilityPort,
  ComisLogger,
  EmbeddingPort,
} from "@comis/core";
import type { ExcludeDeferralResult } from "./tool-deferral.js";
import type { ModelProfile, CapabilityClass } from "./model-profile.js";
import type { CapabilityIndexRenderResult } from "./capability-index-context.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import type { ExecutionPromptResult } from "./prompt-assembly.js";
import type { ExecutionOverrides } from "./types.js";

/** Subset of PiExecutorDeps used by the tool assembly pipeline. */
// @optional-field-count: documented Subset of PiExecutorDeps — inherits the parent bag's
// cluster structure (media/skill/prompt/delivery/memory lanes); cannot be tightened
// independently of PiExecutorDeps (daemon wiring passes the same field references
// through). Future refactor: hold for the parent's cluster-split, then redrive this subset.
export interface ToolAssemblyDeps {
  customTools: ToolDefinition[];
  convertTools?: (tools: AgentTool[]) => ToolDefinition[];
  workspaceDir: string;
  agentDir: string;
  logger: ComisLogger;
  eventBus: TypedEventBus;
  memoryPort?: MemoryPort;
  /** Optional cross-encoder reranker, threaded into prompt-assembly's createMemoryRecall. */
  reranker?: import("@comis/core").RerankerPort;
  /** Optional entity-associative store, threaded into prompt-assembly's
   *  createMemoryRecall. TYPE-only from @comis/core (the agent↛memory build cut). */
  entityStore?: import("@comis/core").MemoryEntityStore;
  /** Optional temporal-spread store, threaded into prompt-assembly's
   *  createMemoryRecall (the 4th temporal lane). TYPE-only from @comis/core (the agent↛memory cut). */
  temporalStore?: import("@comis/core").MemoryTemporalStore;
  /** Optional causal store, threaded into prompt-assembly's createMemoryRecall
   *  (the 5th causal lane). TYPE-only from @comis/core (the agent↛memory build cut). */
  causalStore?: import("@comis/core").MemoryCausalStore;
  /** Optional triple store, threaded into prompt-assembly's createMemoryRecall
   *  (the 6th graph-spread lane). TYPE-only from @comis/core (the agent↛memory build cut). */
  tripleStore?: import("@comis/core").TripleStorePort;
  /** Optional embedding read store, threaded into prompt-assembly's createMemoryRecall
   *  (the MMR diversity re-rank's scoped embedding read). TYPE-only from @comis/core (the
   *  agent↛memory build cut). */
  embeddingStore?: import("@comis/core").MemoryEmbeddingStore;
  /** Optional usefulness store, threaded into prompt-assembly's createMemoryRecall.
   *  TYPE-only from @comis/core (the agent↛memory build cut). */
  usefulnessStore?: import("@comis/core").MemoryUsefulnessStore;
  /** Optional pinned-memory store. Forwarded into prompt-assembly's createMemoryRecall
   *  Step-0 pinned-first lane (the `deps.pinnedStore !== undefined` half of the gate).
   *  A missing forward here is a silent no-op: pinned memories never appear in
   *  agent recall even when the store is wired in the daemon and `rag.pinned.enabled`
   *  is true (the R6 blocker). TYPE-only from @comis/core (the agent↛memory build cut). */
  pinnedStore?: import("@comis/core").MemoryPinnedStore;
  /** Optional learned-alpha store, threaded into prompt-assembly's deterministic
   *  apply overlay (the gated buildScoringAlphas read on the recall scoring arg). Absent /
   *  off / no-row -> no read, the static config.rag.scoring alphas pass unchanged (byte-identical
   *  recall). A missing forward of the daemon construction + the createPiExecutor forward leaves
   *  the overlay a silent no-op (the field-plumbing hazard). TYPE-only from
   *  @comis/core (the agent↛memory build cut). */
  tunedAlphaStore?: import("@comis/core").TunedAlphaStore;
  /** Optional per-user representation store, threaded into prompt-assembly's LLM-free
   *  `<user_profile>` standing-block injection (a deterministic scoped read + pure formatter, NO
   *  model call). Absent -> no read, no push, byte-identical prompt. TYPE-only from @comis/core
   *  (the agent↛memory build cut). A missing forward here leaves the profile injection a silent
   *  no-op even when the store is wired in the daemon (the documented latent field-plumbing drop —
   *  Pitfall 1). */
  userRepresentationStore?: import("@comis/core").UserRepresentationStore;
  /** Optional directional relationship store. Forwarded into
   *  prompt-assembly's LLM-free `<channel_relationships>` standing-block injection (a deterministic
   *  channel-scoped read + pure formatter, NO model call). Absent -> no read, no push, byte-identical
   *  prompt. TYPE-only from @comis/core (the agent↛memory build cut). A missing forward here leaves the
   *  relationship injection a silent no-op even when the store is wired in the daemon (Pitfall 6). */
  relationshipStore?: import("@comis/core").RelationshipStore;
  /** Timer port for the rerank wall-clock deadline (createMemoryRecall). */
  timers?: import("@comis/core").TimerPort;
  hookRunner?: HookRunner;
  secretManager?: SecretManager;
  envelopeConfig?: EnvelopeConfig;
  outboundMediaEnabled?: boolean;
  mediaPersistenceEnabled?: boolean;
  autonomousMediaEnabled?: boolean;
  getPromptSkillsXml?: () => string;
  subAgentToolNames?: string[];
  mcpToolsInherited?: boolean;
  senderTrustDisplayConfig?: SenderTrustDisplayConfig;
  documentationConfig?: import("@comis/core").DocumentationConfig;
  deliveryMirror?: import("@comis/core").DeliveryMirrorPort;
  deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
  embeddingPort?: EmbeddingPort;
  /**
   * Tool-capability port for the per-turn capability-index renderer.
   * Daemon wiring injects createNoOpCapabilityPort() from @comis/core; the
   * live adapter is swapped in elsewhere. The no-op is a real production
   * code path — NOT a transitional shim.
   */
  toolCapabilityPort: ToolCapabilityPort;
  skillRegistry?: {
    getEligibleSkillNames(): Set<string>;
    initFromSdkSkills(sdkSkills: Array<{ name: string; description: string; filePath: string; baseDir: string; source: string; disableModelInvocation: boolean }>): void;
  };
  /** Resolve platform message character limit for a channel type. */
  getChannelMaxChars?: (channelType: string) => number | undefined;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /**
   * ObservabilityStore for SystemPromptReport SQLite persistence.
   * Forwarded from PiExecutorDeps via frozenDeps spread in
   * pi-executor.ts. Threaded through to prompt-assembly.ts deps for
   * the build+persist hook.
   */
  observabilityStore?: import("@comis/observability").ObservabilityStoreLike;
  /**
   * Set of tool names registered in the prompt but filtered out by
   * policy (toolPolicy.deny / capability gate). The
   * SystemPromptReport's tools.entries[].callable reflects this.
   */
  policyFilteredToolNames?: ReadonlySet<string>;
  /**
   * Run-scoped identifier (per pi-mono turn). Becomes the report's
   * `runId` field for cross-correlation with trajectory events.
   */
  runId?: string;
  /** Tenant ID for multi-tenant deployments. */
  tenantId?: string;
  /** Daemon data dir (COMIS_DATA_DIR / config.dataDir). Forwarded to
   *  prompt-assembly so the recall-trace recorder resolves its containment base
   *  from the SAME source the memory.recall_trace reader uses. */
  dataDir?: string;
  /** Recall-trace writer configuration. Forwarded from
   *  PiExecutorDeps.recallTraceConfig (sourced from AppConfig.diagnostics.recallTrace
   *  by daemon wiring) into PromptAssemblyParams.deps.recallTraceConfig, where
   *  buildRecallTrace reads the `enabled` gate. Mirrors the dataDir thread above.
   *  When omitted or `enabled: false`, the recorder is null (default-off, opt-in). */
  recallTraceConfig?: {
    readonly enabled?: boolean;
    readonly filePath?: string;
    readonly maxFileBytes?: number;
  };
}

/** Result of the tool assembly pipeline. */
export interface ToolAssemblyResult {
  /** Final processed tools ready for session creation. */
  mergedCustomTools: ToolDefinition[];
  /** Tool deferral result with active, deferred, and discover tool. */
  deferralResult: ExcludeDeferralResult;
  /** Formatted deferred tools context for dynamic preamble injection. */
  deferredContext: string;
  /**
   * Per-turn capability-index render result.
   * `text` is concatenated into the dynamic preamble; the count fields feed
   * the Pino debug log emitted in `executor-prompt-runner.ts`.
   * When the port returns gate-disabled or all counts are zero, the renderer
   * returns the EMPTY sentinel and `text === ""` filters out via
   * `[...].filter(Boolean)` in the runner.
   */
  capabilityIndexResult: CapabilityIndexRenderResult;
  /** Session-scoped guide delivery tracking set. */
  deliveredGuides: Set<string>;
  /** Capability class from ModelProfile (resolved once per execution in pi-executor). */
  capabilityClass: CapabilityClass;
  /** Discovery tracker for deferred tool discovery state. */
  discoveryTracker: DiscoveryTracker;
  /** Mutable ref for compaction deps to serialize discovered tools. */
  currentDiscoveryTracker: DiscoveryTracker;
  /** Tool names demoted by lifecycle management (optional). */
  lifecycleDemotedNames?: Set<string>;
  /** SDK SettingsManager (file-based or in-memory). */
  settingsManager: ReturnType<typeof SettingsManager.create>;
  /** Whether SettingsManager uses persistent file storage. */
  persistentSettings: boolean;
  /** Resource loader options for DefaultResourceLoader construction. */
  resourceLoaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0];
  /** Assembled execution prompt (system prompt, dynamic preamble, inline memory). */
  promptResult: ExecutionPromptResult;
  /** Estimated system token count (system prompt + tool definition overhead). */
  cachedSystemTokensEstimate: number;
  /** I1 / WR-01: estimated WHOLE fresh-tail preamble token count (the entire
   *  `dynamicPreamble` + `inlineMemory` blob envelope-wrapper prepends into the
   *  latest user message — skills XML, MCP instructions, deferred-tools context,
   *  date/channel lines, recalled memory, …, NOT just recall) — a SEPARATE budget
   *  subtrahend, never folded into the system estimate above. The whole preamble is
   *  counted on purpose (it rides the unconditionally-shipped fresh tail and is
   *  reserved nowhere else); see token-budget.ts WR-01. */
  cachedFreshTailPreambleTokens: number;
}

/** Parameters for the assembleTools function. */
export interface ToolAssemblyParams {
  config: PerAgentConfig;
  deps: ToolAssemblyDeps;
  sessionKey: SessionKey;
  msg: NormalizedMessage;
  tools?: AgentTool[];
  executionOverrides?: ExecutionOverrides;
  isFirstMessageInSession: boolean;
  /** Session manager instance for session context and messages. */
  sm: {
    buildSessionContext(): { messages: unknown[] };
    getSessionDir(): string;
  };
  formattedKeyForGuides: string;
  deliveredGuides: Set<string>;
  resolvedModel?: { id: string; provider: string; contextWindow?: number; reasoning?: boolean };
  modelCompat?: { supportsTools?: boolean; toolSchemaProfile?: "default" | "xai"; toolCallArgumentsEncoding?: "json" | "html-entities"; nativeWebSearchTool?: boolean };
  /** ModelProfile resolved once per execution in pi-executor. Used to thread capabilityClass to consumers. */
  modelProfile?: ModelProfile;
  agentId?: string;
  safetyReinforcement?: string;
  _directives?: { thinkingLevel?: string; compact?: unknown };
}
