// SPDX-License-Identifier: Apache-2.0
// @allow-throw: the degrade-observability wrapper RE-THROWS the gate's
// caught SummarizerDegradeError (after emitting a content-free WARN + dag_degraded)
// so the leaf/condense ladder's existing catch floors to truncation-only — the
// throw is a boundary re-raise that preserves the ladder contract, not control flow.
/**
 * Context engine creation and wiring for PiExecutor.
 *
 * Extracted from pi-executor.ts execute() to isolate context engine
 * configuration merging, createContextEngine() dep wiring, breakpoint
 * index seeding, and transformContext duration tracking into a focused
 * module.
 *
 * Consumers:
 * - pi-executor.ts: calls setupContextEngine() during execute()
 *
 * @module
 */

import {
  ContextEngineConfigSchema,
  safePath,
  type PerAgentConfig,
} from "@comis/core";
import type { ComisLogger } from "@comis/core";
import { createContextEngine, type ContextEngine } from "../context-engine/index.js";
import type { TokenAnchor } from "../context-engine/types.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
// The leaf-summarizer deps the afterTurn trigger consumes. The
// production `summarize` seam wraps the SDK generateSummary; the model + key are
// resolved via the SAME getCompactionDeps chain (no duplicate resolveProviderApiKey).
import {
  buildLeafSummarizeFn,
  wrapSummarizerWithFailover,
  type LeafSummarizerDeps,
  type CompactionModelSnapshot,
} from "../context-engine/lcd-leaf-summarizer.js";
import {
  isSummarizerDegradeError,
  type SummarizerSpendBreaker,
} from "../safety/summarizer-spend-breaker.js";
import type { LeafSummarizer } from "../context-engine/lcd-leaf-summarizer.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import { resolveScaffoldDefaults } from "./scaffold-defaults.js";
import { scoreRelevance } from "../rag/relevance-scorer.js";
import type { ExecutionOverrides } from "./types.js";
import { resolveOperationModel, resolveProviderFamily } from "../model/operation-model-resolver.js";
import type { OAuthTokenManager } from "../model/oauth-token-manager.js";
import { resolveProviderApiKey } from "../model/resolve-provider-api-key.js";
import {
  getBreakpointIndex,
  getBreakpointIndexMapSize,
  getSessionLatches,
} from "./executor-session-state.js";
import { shouldDropSignedFields, type DriftCheck } from "./replay-drift-detector.js";
import type { ErrorKind } from "@comis/core";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of PiExecutorDeps used by context engine setup. */
export interface ContextEngineSetupDeps {
  logger: ComisLogger;
  eventBus: import("@comis/core").TypedEventBus;
  agentId?: string;
  workspaceDir: string;
  authStorage: import("@earendil-works/pi-coding-agent").AuthStorage;
  modelRegistry: import("@earendil-works/pi-coding-agent").ModelRegistry;
  getPromptSkillsXml?: () => string;
  /**
   * Optional OAuth token manager. When provided, compaction LLM
   * calls route through resolveProviderApiKey for OAuth-eligible providers,
   * with fallthrough to authStorage for non-OAuth providers.
   */
  oauthManager?: OAuthTokenManager;
  /** Wall-clock + monotonic time reads. */
  clock: import("@comis/core").ClockPort;
  /** Optional LCD context store (dag-mode assembly). Threaded into
   *  createContextEngine's deps alongside `conversationId: formattedKey` so the
   *  dag branch returns the LCD assembler (reads what the afterTurn ingest
   *  writes). TYPE-only core port (the agent↛memory cut); absent ⇒ the dag
   *  branch falls through to the pipeline. */
  contextStore?: import("@comis/core").ContextStorePort;
  /** The daemon-owned per-tenant summarizer spend+breaker. When
   *  present, `getSummarizerDeps` wraps the leaf summarizer seam with
   *  `gate(tenantId, inner)` so an open breaker / over-cap tenant BYPASSES the LLM
   *  → the leaf/condense ladder floors to truncation-only (no turn failure).
   *  ONE daemon-owned instance (per-tenant aggregate across sessions/agents);
   *  absent ⇒ the raw seam (non-daemon callers / tests). */
  summarizerSpendBreaker?: SummarizerSpendBreaker;
  /** The boot-probe served window PAIRED with the
   *  `providers.entries` key it was probed from (= PiExecutorDeps.
   *  servedContextWindow, auto-present on the frozenDeps this subset is built
   *  from). Consumed by `resolveCompactionModelChain` to provider-gate the
   *  served bound for a compaction OVERRIDE model (`servedContextWindow.
   *  providerKey === compactionResolution.provider` — compared in config-key
   *  space); the PRIMARY summarizer's served bound instead reuses the executor
   *  reconcile's already-gated `windowProvenance.served`. Absent ⇒ no served
   *  truth (non-Ollama provider or probe off/failed) — configured windows
   *  govern. */
  servedContextWindow?: { providerKey: string; window: number };
}

/** Parameters for context engine creation. */
export interface ContextEngineSetupParams {
  config: PerAgentConfig;
  deps: ContextEngineSetupDeps;
  formattedKey: string;
  sessionKey: string;
  /** The tenant for the dag assembler's LCD read scope (the SAME
   *  source executor-post-execution uses for the ingest scope:
   *  `deps.tenantId ?? sessionKey.tenantId`). Threaded onto ContextEngineDeps so
   *  the assembler builds an agent + tenant scoped read. */
  tenantId: string;
  /** The turn's agentId — the positional execute() arg
   *  (`agentId ?? "default"`, the SAME `effectiveAgentId` expression
   *  executor-post-execution uses for the LCD ingest scope), supplied by the
   *  caller and NOT read from deps. On the executeAgent path the turn agentId is
   *  set on the ALS RequestContext, never onto frozenDeps, so `deps.agentId` is
   *  undefined and the assembler would fail closed (recall 0 history). Threading
   *  it here makes the dag READ scope == the ingest WRITE scope so the assembler
   *  builds a non-undefined readScope. `deps.agentId` stays the fallback for
   *  non-executeAgent callers. */
  agentId: string | undefined;
  msg: { channelType?: string; channelId?: string };
  sm: unknown;  // SessionManager -- typed as unknown to avoid SDK type export
  session: { agent: { state: { model: { reasoning?: boolean; contextWindow?: number; maxTokens?: number; id?: string; provider?: string; api?: string } | undefined } }; abortCompaction(): void };
  resolvedModel: unknown;
  executionOverrides?: ExecutionOverrides;
  /** Cache break detector from stream setup */
  cacheBreakDetector: { notifyContentModification(key: string): void };
  /** Mutable ref holder for context engine (from stream setup) */
  contextEngineRef: { current?: ContextEngine };
  /** Getter for cached system tokens estimate */
  getCachedSystemTokensEstimate: () => number;
  /** Getter for the cached WHOLE fresh-tail preamble token estimate (a
   *  SEPARATE budget subtrahend — the entire dynamicPreamble + inlineMemory blob, NOT
   *  just recall; never folded into the system-tokens estimate). See token-budget.ts. */
  getCachedFreshTailPreambleTokens: () => number;
  /** Getter for current token anchor */
  getTokenAnchor: () => TokenAnchor | null;
  /** Callback to reset token anchor */
  onAnchorReset: () => void;
  /** Current discovery tracker (if active) */
  currentDiscoveryTracker?: DiscoveryTracker;
  /** The resolved ModelProfile for the current turn.
   *  Absent ⇒ lcd-assembler applies the fail-closed nano cap + WARN.
   *  Pass params.modelProfile (already in scope at the pi-executor call site). */
  modelProfile?: import("./model-profile.js").ModelProfile;
  /** Served/capability window provenance built at the
   *  pi-executor reconcile — threaded onto ContextEngineDeps so the
   *  lcd-assembler's computeTokenBudgetForProfile reports the TRUE configured
   *  window when the served window binds. Absent ⇒ raw reporting. */
  windowProvenance?: import("../context-engine/types.js").WindowProvenance;
  /** Security-pin markers sourced from pi-executor's deps.canaryToken.
   *  Threaded into ContextEngineDeps so the dag eviction never drops security context. */
  securityPinMarkers?: import("../context-engine/security-context-pinner.js").SecurityPinMarkers;
  /** Callback invoked when assembled input tokens are measured. */
  onAssembledInputTokens?: (tokens: number) => void;
  /** Callback invoked when the effective window is known. */
  onEffectiveWindow?: (windowTokens: number) => void;
  /** Callback invoked when thinking-effort governor down-shifts thinkingLevel. */
  onThinkingDownshifted?: (level: string) => void;
  /** Getter returning the current thinking level for this dispatch. */
  getThinkingLevel?: () => string | undefined;
}

/** Result of context engine setup. */
export interface ContextEngineSetupResult {
  /** The created context engine instance */
  contextEngine: ContextEngine;
  /** Getter for accumulated transformContext duration in ms */
  getContextEngineDurationMs: () => number;
  /** Per-execute signature-replay scrub counters. `signatureScrubs`
   *  bumps once per non-empty scrubber emission; `signatureScrubsToolCallsAffected`
   *  accumulates the toolCallsAffected field across emissions. Surfaced to
   *  executor-post-execution.ts so the bookend "Execution complete" INFO log
   *  carries the per-execute total instead of the per-event INFO emissions. */
  getSignatureScrubCounters: () => {
    signatureScrubs: number;
    signatureScrubsToolCallsAffected: number;
  };
  /** The leaf-summarizer deps getter the afterTurn trigger
   *  consumes. Threaded into PostExecutionParams.deps.getSummarizerDeps at the
   *  pi-executor call site so the leaf pass fires live over threshold. Resolves
   *  the model fresh per call (honors mid-session model cycling) UNLESS a
   *  `modelSnapshot` is supplied — in which case the chain uses it verbatim
   *  instead of reading `session.agent.state.model`. The DEFERRED compaction
   *  path passes a snapshot captured BEFORE `session.dispose()` so a detached pass
   *  never re-reads a torn-down session. */
  getSummarizerDeps: (modelSnapshot?: CompactionModelSnapshot) => LeafSummarizerDeps;
}

// ---------------------------------------------------------------------------
// Summarizer degrade observability
// ---------------------------------------------------------------------------

/** Identifiers + sinks the degrade observability wrapper needs (content-free). */
interface DegradeObservabilityCtx {
  eventBus: import("@comis/core").TypedEventBus;
  logger: ComisLogger;
  clock: import("@comis/core").ClockPort;
  conversationId: string;
  agentId: string;
  sessionKey: string;
}

/**
 * Wrap a GATED {@link LeafSummarizer} so a spend/breaker DEGRADE
 * bypass is OBSERVABLE at the wiring boundary (the breaker module itself is
 * content-free + log-free by design — observability lives where the `ComisLogger`
 * + `eventBus` are injected). On a {@link SummarizerDegradeError} we emit a
 * content-free WARN (`errorKind` `dependency` for breaker_open, `resource` for
 * spend_cap) + the `context:dag_degraded` event (reason `breaker_open`/`spend_cap`),
 * then RE-THROW so the leaf/condense ladder floors to truncation-only.
 * Any non-degrade throw (an inner LLM failure the gate already recorded) and every
 * success pass straight through untouched. NEVER logs summary/message content —
 * ids / reason / durationMs only (AGENTS.md §2.2).
 */
function wrapSummarizerWithDegradeObservability(
  gated: LeafSummarizer,
  ctx: DegradeObservabilityCtx,
): LeafSummarizer {
  return async (messages, opts): Promise<string> => {
    const start = ctx.clock.now();
    try {
      return await gated(messages, opts);
    } catch (err) {
      if (isSummarizerDegradeError(err)) {
        const reason = err.degradeReason; // closed union: "breaker_open" | "spend_cap"
        const errorKind: ErrorKind = reason === "spend_cap" ? "resource" : "dependency";
        ctx.logger.warn(
          {
            step: "lcd-summarizer-degrade",
            reason,
            errorKind,
            durationMs: Math.max(0, ctx.clock.now() - start),
            hint:
              reason === "spend_cap"
                ? "per-tenant summarizer token cap reached; compaction degraded to truncation-only — raise contextEngine.summarizerSpend or wait for the rolling window to drain"
                : "summarizer circuit breaker open after repeated failures; compaction degraded to truncation-only — investigate the compaction model/provider",
          },
          "lcd summarizer degraded to truncation-only",
        );
        ctx.eventBus.emit("context:dag_degraded", {
          conversationId: ctx.conversationId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          reason,
          durationMs: Math.max(0, ctx.clock.now() - start),
          timestamp: ctx.clock.now(),
        });
      }
      throw err; // floor: the ladder catches this and degrades to Level-3.
    }
  };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Create and wire the context engine for a single execution.
 *
 * Handles:
 * - Config merging with executionOverrides (subagent compaction model)
 * - createContextEngine() call with full dependency wiring
 * - Compaction dep creation (including operation model resolution)
 * - Rehydration dep creation (AGENTS.md reading, file entries)
 * - DAG mode setup
 * - Breakpoint index seeding from session map
 * - transformContext duration tracking wrapper installation
 *
 * @param params - All required state for context engine creation
 * @returns The context engine and duration tracking getter
 */
export function setupContextEngine(params: ContextEngineSetupParams): ContextEngineSetupResult {
  const {
    config, deps, formattedKey, tenantId, msg, sm, session, executionOverrides,
    cacheBreakDetector,
    contextEngineRef,
    getCachedSystemTokensEstimate, getCachedFreshTailPreambleTokens, getTokenAnchor, onAnchorReset,
    currentDiscoveryTracker,
    modelProfile,
    windowProvenance,
  } = params;

  // Prefer the caller-supplied turn agentId (the positional
  // execute() arg threaded as params.agentId) over deps.agentId — on the
  // executeAgent path deps.agentId (= frozenDeps.agentId) is undefined, so this
  // is what makes the dag read scope == the ingest write scope (the assembler no
  // longer fails closed). deps.agentId remains the fallback for callers that set
  // it directly. This `agentId` flows into the createContextEngine deps (the LCD
  // read scope) and the getSummarizerDeps wiring below.
  const agentId = params.agentId ?? deps.agentId;

  // ExecutionOverrides carries no per-execution context-engine override -- the
  // compaction model is resolved via the operationModels chain below.
  const contextEngineConfig = config.contextEngine ?? ContextEngineConfigSchema.parse({});

  // Resolve the relevance-first policy ONCE (the capability +
  // supportsPromptCache gate; explicit > capability-default > off) and thread it to the
  // dag assembler, which CONSUMES the boolean (it does NOT recompute the gate). Resolved
  // here (mirrors prompt-assembly.ts's recall-side resolution) only when modelProfile is
  // present; absent ⇒ undefined ⇒ the assembler takes the verbatim recency path (frontier/
  // mid byte-identical).
  const relevanceFirst = modelProfile
    ? resolveScaffoldDefaults(modelProfile, config).relevanceFirst
    : undefined;

  // --- Replay drift memo ---------------------------------------------------
  // Memoized per-execute() so all pipeline runs in a single execute() see a
  // consistent decision (cleaner + scrubber must agree). The closure reads
  // the latest model identity each time (handles cycleModel mid-execute).
  // Returns the identity/idle drift only — tool-defs drift is covered by the
  // unconditional latest-message-preserving scrub in signature-replay-scrubber.
  let memoizedDrift: DriftCheck | undefined;
  const computeDriftIfNeeded = (): DriftCheck | undefined => {
    if (memoizedDrift !== undefined) return memoizedDrift;
    try {
      const model = session.agent.state.model;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SessionManager interop
      const fileEntries = ((sm as any)?.fileEntries ?? []) as ReadonlyArray<unknown>;
      const idleMs = contextEngineConfig.replayDriftIdleMs ?? 30 * 60_000;
      // Derive currentApi from model.api when present; otherwise fall back to
      // the provider family (resolveProviderFamily strips -bedrock / -vertex).
      const currentApi = model?.api ?? resolveProviderFamily(config.provider);
      const existingDrift = shouldDropSignedFields({
        // Cast: shouldDropSignedFields tolerates malformed entries internally.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileEntries: fileEntries as any,
        currentModel: {
          id: model?.id,
          provider: model?.provider ?? config.provider,
          api: currentApi,
        },
        idleMs,
        now: deps.clock.now(),
      });

      memoizedDrift = existingDrift;
      return memoizedDrift;
    } catch (err) {
      deps.logger.warn(
        {
          err,
          hint: "Replay drift detection failed; defaulting to no scrub",
          errorKind: "internal" as ErrorKind,
        },
        "Replay drift detection failed",
      );
      memoizedDrift = { drop: false };
      return memoizedDrift;
    }
  };

  // Per-execute counters for the signature-replay scrubber. Live
  // for the lifetime of this setupContextEngine() call (one per execute()),
  // so no reset is needed — the closure goes out of scope at execute end and
  // a fresh setup creates fresh zeroed counters for the next execute.
  let signatureScrubs = 0;
  let signatureScrubsToolCallsAffected = 0;

  // Shared compaction-model resolution (getModel / getApiKey / overrideModel) —
  // the SINGLE source for both the pipeline `getCompactionDeps` (Layer 8) and the
  // leaf `getSummarizerDeps`. Both compaction surfaces resolve the
  // SAME 5-level operation-model chain + route getApiKey through resolveProviderApiKey
  // (no duplicate resolver). Returns the
  // getters + the optional override model+key.
  const resolveCompactionModelChain = (
    // When present, the chain uses this CAPTURED model snapshot verbatim
    // instead of reading `session.agent.state.model`. The deferred compaction
    // path captures it at the afterTurn boundary (before session.dispose()) so a
    // detached pass — which resolves the chain when it RUNS, possibly post-dispose
    // — never touches a torn-down session. Absent ⇒ the live per-call read (honors
    // mid-session model cycling for the inline path).
    modelSnapshot?: CompactionModelSnapshot,
  ): {
    getModel: () => CompactionModelSnapshot;
    getRealModel: () => unknown;
    getApiKey: () => Promise<string>;
    overrideModel?: { model: unknown; getApiKey: () => Promise<string>; servedWindow?: number };
    primaryServedWindow?: number;
  } => ({
    getModel: () => {
      if (modelSnapshot !== undefined) return modelSnapshot;
      const model = session.agent.state.model;
      return {
        id: model?.id,
        provider: model?.provider ?? config.provider,
        contextWindow: model?.contextWindow ?? 128_000,
        reasoning: model?.reasoning ?? false,
      };
    },
    // The REAL pi-ai Model<any> for the PRIMARY leaf/condense summarizer path
    // (generateSummary needs a real Model, not the 4-field snapshot getModel
    // returns). It is the executor-resolved model (pi-executor.ts resolvedModel),
    // threaded in as params.resolvedModel. Captured at setup time (a closure over
    // the setup-time value, resolved BEFORE session.dispose()), so the
    // DEFERRED pass — which runs post-dispose — still returns a real Model
    // without reading session.agent.state. Kept `unknown` end-to-end; the single
    // sanctioned `as any` cast lives at the generateSummary call site.
    getRealModel: () => params.resolvedModel,
    // Route compaction's primary getApiKey through the shared dispatch helper so
    // OAuth-eligible providers refresh through OAuthTokenManager + setRuntimeApiKey
    // on every call. Non-OAuth providers fall through to authStorage unchanged.
    getApiKey: async () =>
      resolveProviderApiKey(config.provider, {
        authStorage: deps.authStorage,
        oauthManager: deps.oauthManager,
        agentConfig: config,
      }),
    // The served window binding the PRIMARY (getRealModel) summarizer.
    // windowProvenance.served is the boot-probe pair ALREADY provider-gated by
    // the executor reconcile (`servedContextWindow.providerKey ===
    // resolvedProviderKey` in pi-executor), so it binds exactly the model
    // params.resolvedModel holds. A plain setup-time number — dispose-safe on
    // the deferred path. Absent ⇒ no served truth (byte-identical).
    ...(windowProvenance?.served !== undefined && {
      primaryServedWindow: windowProvenance.served,
    }),
    // Resolve compaction model via the 5-level priority chain; only set
    // overrideModel when the resolver picked a non-primary model.
    ...(() => {
      const compactionResolution = resolveOperationModel({
        operationType: "compaction",
        agentProvider: config.provider,
        agentModel: config.model,
        operationModels: config.operationModels ?? {},
        providerFamily: resolveProviderFamily(config.provider),
        agentPromptTimeoutMs: config.promptTimeout?.promptTimeoutMs,
      });
      if (compactionResolution.source !== "agent_primary") {
        try {
          const compactionModel = deps.modelRegistry.find(
            compactionResolution.provider,
            compactionResolution.modelId,
          );
          if (compactionModel) {
            // Gate the boot-probe served pair for THIS override in
            // CONFIG space — the pair's providerKey and the operation-model
            // resolution's provider are both `providers.entries` keys (never
            // compare model.provider, which the registry alias fallback
            // can rename). A cross-provider override gets NO served bound.
            const overrideServedWindow =
              deps.servedContextWindow !== undefined &&
              deps.servedContextWindow.providerKey === compactionResolution.provider
                ? deps.servedContextWindow.window
                : undefined;
            return {
              overrideModel: {
                model: compactionModel,
                getApiKey: async () =>
                  resolveProviderApiKey(compactionResolution.provider, {
                    authStorage: deps.authStorage,
                    oauthManager: deps.oauthManager,
                    agentConfig: config,
                  }),
                ...(overrideServedWindow !== undefined && {
                  servedWindow: overrideServedWindow,
                }),
              },
            };
          }
        } catch {
          // Model not in registry -- fall through to session model
        }
      }
      return {};
    })(),
  });

  // The leaf-summarizer deps getter: the shared model chain + the
  // production summarizer seam (buildLeafSummarizeFn wraps the SDK generateSummary,
  // gated by the spend breaker below) + the injected logger. The
  // afterTurn trigger (executor-post-execution.ts → runLeafPassAfterTurn) calls
  // this; when wired the leaf pass fires live over threshold. Resolved fresh per
  // call so model cycling mid-session is honored (same as getCompactionDeps).
  //
  // A `modelSnapshot` (when supplied by the DEFERRED compaction path)
  // flows into the chain so BOTH `getModel` AND the `buildLeafSummarizeFn`-internal
  // model read use the captured value — a deferred pass resolving this AFTER
  // `session.dispose()` then never reads `session.agent.state`.
  const getSummarizerDeps = (modelSnapshot?: CompactionModelSnapshot): LeafSummarizerDeps => {
    const chain = resolveCompactionModelChain(modelSnapshot);
    const inner = buildLeafSummarizeFn(chain);
    // Wrap the primary summarizer with the ordered failover list before the
    // spend-breaker. The failover list tries each provider in sequence; only when ALL
    // providers are exhausted does it throw — at which point the outer breaker records
    // exactly ONE failure (throw-last, not throw-per-provider). Empty list
    // (default) = zero behavioral change for existing deployments.
    const fallbackProviders = contextEngineConfig.compaction?.summarizerFallbackProviders ?? [];
    const fallbackSummarizers = fallbackProviders.map((providerModel: string) => {
      // Each entry is "provider:modelId". Build a LeafSummarizer using the same
      // model resolution pattern as strongerSummarizerModel (resolveCompactionModelChain
      // with an override), falling back to the primary chain for unknown providers.
      // All fallback entries resolve via the existing registry lookup;
      // if the model is not found in the registry, the fallback silently uses the
      // primary chain (the outer failover wrapper will still catch any resulting error).
      const [provider, modelId] = providerModel.split(":", 2) as [string, string];
      try {
        const fallbackModel = deps.modelRegistry?.find(provider, modelId ?? "");
        if (fallbackModel) {
          return buildLeafSummarizeFn({
            getRealModel: () => fallbackModel,
            getApiKey: async () =>
              resolveProviderApiKey(provider, {
                authStorage: deps.authStorage,
                oauthManager: deps.oauthManager,
                agentConfig: config,
              }),
            overrideModel: undefined,
          });
        }
      } catch {
        // Model not in registry — fall through to primary chain for this slot
      }
      // Fallback: use the primary chain (provider lookup failed or registry absent)
      return buildLeafSummarizeFn(chain);
    });
    const innerWithFailover = wrapSummarizerWithFailover(inner, fallbackSummarizers, deps.logger);
    // Wrap the leaf summarizer seam with the daemon-owned per-tenant
    // spend+breaker gate keyed on the LIVE tenantId (the SAME tenant the afterTurn
    // ingest scope uses). On open-breaker / over-cap the gate THROWS the degrade
    // signal → the leaf/condense ladder catches it (lcd-leaf-summarizer tryLevel)
    // → deterministic Level-3 floor → truncation-only assembly → the
    // fallback marker fires on the resulting fallback:true summary. NO retry of
    // the inner LLM (retrying a spend-gated call would defeat the gate). The
    // same getter feeds BOTH the
    // leaf and the condense pass, so condense degrades identically. Absent breaker
    // ⇒ the raw seam (non-daemon callers / tests).
    const summarize = deps.summarizerSpendBreaker
      ? wrapSummarizerWithDegradeObservability(
          deps.summarizerSpendBreaker.gate(tenantId, innerWithFailover),
          { eventBus: deps.eventBus, logger: deps.logger, clock: deps.clock,
            conversationId: formattedKey, agentId: agentId ?? "default", sessionKey: formattedKey },
        )
      : innerWithFailover;
    return {
      logger: deps.logger,
      summarize,
      getModel: chain.getModel,
      // The REAL primary Model<any> (params.resolvedModel) buildLeafSummarizeFn
      // hands generateSummary — not the 4-field snapshot getModel returns.
      getRealModel: chain.getRealModel,
      getApiKey: chain.getApiKey,
      // overrideModel carries its own provider-gated servedWindow;
      // primaryServedWindow binds the getRealModel candidate. Both feed
      // resolveSummarizerWindowTokens' candidate-bound served selection.
      overrideModel: chain.overrideModel,
      primaryServedWindow: chain.primaryServedWindow,
    };
  };

  const contextEngine = createContextEngine(contextEngineConfig, {
    logger: deps.logger,
    eventBus: deps.eventBus,
    agentId,
    sessionKey: formattedKey,
    // The dag assembler builds an agent + tenant scoped LCD read
    // from agentId + tenantId + conversationId.
    tenantId,
    getModel: () => {
      // Lazy model getter handles model cycling mid-session
      const model = session.agent.state.model;
      return {
        reasoning: model?.reasoning ?? false,
        contextWindow: model?.contextWindow ?? 128_000,
        maxTokens: model?.maxTokens ?? 8192,
        id: model?.id,
        provider: model?.provider,
        // model.api is optional pi-ai metadata. Cast for the optional access
        // since the structural type does not require it.
        api: (model as { api?: string } | undefined)?.api,
      };
    },
    channelType: msg.channelType,
    getSessionManager: () => sm,  // Persistent write-back for observation masker
    objective: executionOverrides?.spawnPacket?.objective, // Objective reinforcement
    getSystemTokensEstimate: getCachedSystemTokensEstimate,
    getFreshTailPreambleTokensEstimate: getCachedFreshTailPreambleTokens,
    // Notify cache break detector when observation masking modifies content
    onContentModified: () => cacheBreakDetector.notifyContentModification(formattedKey),
    // Accumulate signature-replay scrub counts per-execute. Only
    // counts emissions that actually scrubbed something (zero-touch turns
    // are filtered out — they're not a "scrub" in the post-incident-visibility
    // sense). Sums toolCallsAffected so the bookend "Execution complete" log
    // carries the post-incident-visibility metric.
    onSignatureReplayScrubbed: (stats) => {
      if (stats.scrubbedAssistantMessages > 0) {
        signatureScrubs++;
        signatureScrubsToolCallsAffected += stats.toolCallsAffected;
      }
    },
    // Provide API-grounded token anchor to context engine pipeline
    getTokenAnchor,
    // Reset anchor when compaction replaces the message array
    onAnchorReset,
    // Dynamic keepTurns override for idle-based thinking clear
    getThinkingKeepTurnsOverride: () => {
      const latches = getSessionLatches(formattedKey);
      if (latches?.idleThinkingClear.get()) return 0; // Strip all thinking when idle
      // When replay drift fires, also clamp keepTurns=0 so the cleaner agrees
      // with the new signature-replay-scrubber. Defense in depth: the scrubber
      // drops everything beyond the cache fence, but a future refactor that
      // narrows the scrubber's scope must not leave the cleaner inconsistent.
      const drift = computeDriftIfNeeded();
      if (drift?.drop) return 0;
      return undefined; // Use default keepTurns
    },
    // LLM compaction deps (Layer 8). The getModel / getApiKey / overrideModel
    // resolution is shared with the leaf getSummarizerDeps via
    // resolveCompactionModelChain() above — one source for both compaction
    // surfaces (the 5-level operation-model chain + the shared resolveProviderApiKey
    // dispatch; no duplicate resolver). The override is set only when the
    // resolver picked a non-primary compaction model; absent ⇒ llm-compaction
    // uses getModel/getApiKey.
    getCompactionDeps: () => ({
      logger: deps.logger,
      getSessionManager: () => sm,
      // Serialize discovered tool names for compaction metadata
      getDiscoveredTools: () => currentDiscoveryTracker?.serialize() ?? [],
      ...resolveCompactionModelChain(),
    }),

    // Rehydration deps
    getRehydrationDeps: () => ({
      logger: deps.logger,
      getAgentsMdContent: () => {
        // Read AGENTS.md from workspace dir synchronously.
        // Only called after compaction (rare event), so disk read is acceptable.
        try {
          const agentsPath = safePath(deps.workspaceDir, "AGENTS.md");
          return readFileSync(agentsPath, "utf-8"); // eslint-disable-line security/detect-non-literal-fs-filename
        } catch {
          return "";
        }
      },
      postCompactionSections: config.session?.compaction?.postCompactionSections ?? ["Session Startup", "Red Lines"],
      getRecentFiles: () => {
        // Extract recently-accessed files from session file entries.
        // Look for file_read tool calls in the last N messages.
        try {
          /* eslint-disable @typescript-eslint/no-explicit-any */
          const fileEntries = (sm as any).fileEntries;
          if (!Array.isArray(fileEntries)) return [];
          const filePaths: string[] = [];
          const seen = new Set<string>();
          // Walk backwards to find most recent file_read results
          for (let i = fileEntries.length - 1; i >= 0 && filePaths.length < 5; i--) {
            const entry = fileEntries[i]; // eslint-disable-line security/detect-object-injection
            if (entry?.type !== "message") continue;
            const entryMsg = entry.message;
            if (!entryMsg || entryMsg.role !== "toolResult" || entryMsg.toolName !== "file_read") continue;
            const toolCallId = entryMsg.toolCallId;
            if (!toolCallId || seen.has(toolCallId)) continue;
            seen.add(toolCallId);
            // Find the tool_use that initiated this file_read
            for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
              const prev = fileEntries[j]; // eslint-disable-line security/detect-object-injection
              if (prev?.type !== "message") continue;
              const prevMsg = prev.message;
              if (prevMsg?.role === "assistant" && Array.isArray(prevMsg.content)) {
                for (const block of prevMsg.content) {
                  if (block.type === "tool_use" && block.toolCallId === toolCallId && block.input?.path) {
                    filePaths.push(block.input.path);
                  }
                }
              }
            }
          }
          /* eslint-enable @typescript-eslint/no-explicit-any */
          return filePaths;
        } catch {
          return [];
        }
      },
      readFile: async (filePath: string) => {
        try {
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(filePath, "utf-8");
          return content;
        } catch {
          return "";
        }
      },
      getActiveState: () => ({
        channelType: msg.channelType,
        channelId: msg.channelId,
        agentId: agentId ?? config.name,
      }),
      // Pass prompt skills XML getter for post-compact skill restoration.
      // This is the "documentationConfig" resolution path -- skillRegistry.getSnapshot().prompt
      // internally resolves guide names through documentation config.
      getPromptSkillsXml: deps.getPromptSkillsXml,
      // Report rehydration stats including skillsInjected count
      onRehydrated: (stats: { sectionsInjected: number; filesInjected: number; skillsInjected: number; overflowStripped: boolean }) => {
        deps.eventBus?.emit("context:rehydrated", {
          agentId: agentId ?? config.name,
          sessionKey: formattedKey,
          sectionsInjected: stats.sectionsInjected,
          filesInjected: stats.filesInjected,
          skillsInjected: stats.skillsInjected,
          overflowStripped: stats.overflowStripped,
          timestamp: deps.clock.now(),
        });
      },
      onOverflow: (stats: { contextChars: number; budgetChars: number; recoveryAction: "strip_files" | "strip_skills" | "remove_position1" | "remove_rehydration" | "none" }) => {
        deps.eventBus?.emit("context:overflow", {
          agentId: agentId ?? config.name,
          sessionKey: formattedKey,
          contextTokens: Math.ceil(stats.contextChars / CHARS_PER_TOKEN_RATIO), // flat-by-design: aggregate stats logging
          budgetTokens: Math.ceil(stats.budgetChars / CHARS_PER_TOKEN_RATIO), // flat-by-design: aggregate stats logging
          recoveryAction: stats.recoveryAction,
          timestamp: deps.clock.now(),
        });
      },
    }),
    // dag-mode: thread the injected LCD store + the conversation id
    // (= formattedKey) so context-engine's `dag` branch returns the LCD
    // assembler, which reconstructs history from what the afterTurn ingest
    // wrote. Absent ⇒ the branch WARN-falls-through to the pipeline.
    contextStore: deps.contextStore,
    conversationId: formattedKey,
    // The dag assembler stamps assembly duration + synthesized-tool-result
    // timestamps via this injected clock (production never calls Date.now()).
    clock: deps.clock,
    // The resolved ModelProfile for budget-aware eviction cap.
    // Absent ⇒ lcd-assembler applies the fail-closed nano cap + WARN.
    modelProfile,
    // Served-window provenance for the budget's rawContextWindowTokens.
    windowProvenance,
    // The resolved relevance-first policy + the shared scorer for
    // the margin arbiter. relevanceFirst undefined/false ⇒ the assembler takes the verbatim
    // recency path (frontier/mid byte-identical).
    relevanceFirst,
    // The injected shared relevance scorer. Its live
    // caller is the within-history middle-band relevance pass (rankMiddleBandByRelevance,
    // injected as marginArbitrate's middleBandRanker in lcd-arbiter-seam), which calls it over the
    // FTS-the-band lane to re-rank the evictable middle band cache-safely. It is injected here
    // (executor/ may import rag/) so the context-engine never imports rag/ (the import cut). The
    // cross-tier LTM/KG lanes remain EMPTY on the assembly path, so the scorer's live use is
    // the middle-band pass, not the cross-session tiers.
    relevanceScorer: scoreRelevance,
    // Security-pin markers so the dag eviction never drops security context.
    securityPinMarkers: params.securityPinMarkers,
    onAssembledInputTokens: params.onAssembledInputTokens,
    onEffectiveWindow: params.onEffectiveWindow,
    onThinkingDownshifted: params.onThinkingDownshifted,
    getThinkingLevel: params.getThinkingLevel,
    // Thread the operator-configurable floor so the schema field
    // contextEngine.budget.minVisibleOutputTokens has live runtime effect.
    // Absent ⇒ pre-flight uses the compile-time constant (768) — byte-identical.
    minVisibleOutputTokens: contextEngineConfig.budget?.minVisibleOutputTokens,
  });

  // Wire context engine to the mutable holder so requestBodyInjector
  // callback can feed breakpoint indices back (declared before wrappers array).
  contextEngineRef.current = contextEngine;

  // Seed from persisted breakpoint index (survives across execute() calls)
  const persistedBreakpointIdx = getBreakpointIndex(formattedKey);
  if (persistedBreakpointIdx !== undefined) {
    contextEngine.lastBreakpointIndex = persistedBreakpointIdx;
  }
  deps.logger.debug(
    { formattedKey, persistedBreakpointIdx: persistedBreakpointIdx ?? -1, mapSize: getBreakpointIndexMapSize() },
    "Breakpoint index seeded from session map",
  );

  // Wrap transformContext with duration tracking for execution breakdown
  let contextEngineDurationMs = 0;
  const rawTransformContext = contextEngine.transformContext;
  const timedTransformContext: typeof rawTransformContext = (messages) => {
    const ceStart = performance.now();
    const result = rawTransformContext(messages);
    contextEngineDurationMs += Math.round(performance.now() - ceStart);
    return result;
  };
  contextEngine.transformContext = timedTransformContext;

  return {
    contextEngine,
    getContextEngineDurationMs: () => contextEngineDurationMs,
    // Expose per-execute signature-replay scrub counters so the
    // bookend "Execution complete" INFO log can roll them up.
    getSignatureScrubCounters: () => ({
      signatureScrubs,
      signatureScrubsToolCallsAffected,
    }),
    // Expose the leaf-summarizer deps getter so pi-executor can
    // thread it into postExecution's deps.getSummarizerDeps — wiring the
    // afterTurn leaf pass live.
    getSummarizerDeps,
  };
}
