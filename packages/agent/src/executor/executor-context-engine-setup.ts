// SPDX-License-Identifier: Apache-2.0
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
import type { ComisLogger } from "@comis/infra";
import { createContextEngine, type ContextEngine } from "../context-engine/index.js";
import type { TokenAnchor } from "../context-engine/types.js";
import { CHARS_PER_TOKEN_RATIO } from "../context-engine/constants.js";
import type { DiscoveryTracker } from "./discovery-tracker.js";
import type { ExecutionOverrides } from "./types.js";
import { resolveOperationModel, resolveProviderFamily } from "../model/operation-model-resolver.js";
import {
  getBreakpointIndex,
  getBreakpointIndexMapSize,
  getSessionLatches,
} from "./executor-session-state.js";
import {
  shouldDropSignedFields,
  shouldDropSignedFieldsForToolSet,
  type DriftCheck,
} from "./replay-drift-detector.js";
import type { ErrorKind } from "@comis/infra";
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
  authStorage: import("@mariozechner/pi-coding-agent").AuthStorage;
  modelRegistry: import("@mariozechner/pi-coding-agent").ModelRegistry;
  getPromptSkillsXml?: () => string;
  contextStore?: import("@comis/memory").ContextStore;
  db?: unknown;
}

/** Parameters for context engine creation. */
export interface ContextEngineSetupParams {
  config: PerAgentConfig;
  deps: ContextEngineSetupDeps;
  formattedKey: string;
  sessionKey: string;
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
  /** Getter for current token anchor */
  getTokenAnchor: () => TokenAnchor | null;
  /** Callback to reset token anchor */
  onAnchorReset: () => void;
  /** Current discovery tracker (if active) */
  currentDiscoveryTracker?: DiscoveryTracker;
  /** 260428-k8d: returns the active tool name set for the next API call.
   *  Same closure passed to PiEventBridgeDeps.getActiveToolNames so bridge +
   *  detector see a consistent view per execute() turn. Optional — when
   *  unwired (e.g., unit tests), the toolset-drift dimension is disabled. */
  getActiveToolNames?: () => ReadonlySet<string>;
  /** 260428-k8d: returns the bridge's signedThinkingToolSnapshot store.
   *  Lazy getter because the bridge is created after `setupContextEngine` in
   *  the executor; the closure reads `bridge.getThinkingBlockStores().toolSnapshot`
   *  on demand. Optional — when unwired, the toolset-drift dimension is disabled. */
  getToolSnapshotStore?: () => ReadonlyMap<string, ReadonlySet<string>>;
}

/** Result of context engine setup. */
export interface ContextEngineSetupResult {
  /** The created context engine instance */
  contextEngine: ContextEngine;
  /** Getter for accumulated transformContext duration in ms */
  getContextEngineDurationMs: () => number;
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
    config, deps, formattedKey, msg, sm, session, executionOverrides,
    cacheBreakDetector,
    contextEngineRef,
    getCachedSystemTokensEstimate, getTokenAnchor, onAnchorReset,
    currentDiscoveryTracker,
    getActiveToolNames,
    getToolSnapshotStore,
  } = params;

  const agentId = deps.agentId;

  // contextEngineOverrides removed from ExecutionOverrides -- compaction model resolved via operationModels chain
  const contextEngineConfig = config.contextEngine ?? ContextEngineConfigSchema.parse({});

  // --- Replay drift memo (Fix #2) -----------------------------------------
  // Memoized per-execute() so all pipeline runs in a single execute() see a
  // consistent decision (cleaner + scrubber must agree). The closure reads
  // the latest model identity each time (handles cycleModel mid-execute).
  //
  // 260428-k8d: extended to OR-combine the existing identity/idle drift with
  // the new tool-set-changed dimension. Combined `drop` flag drives the
  // signature-replay-scrubber (which gates only on `drop`); the existing
  // closed `reason` union stays untouched — when only toolset drift fires
  // we leave `reason` undefined and surface the toolset reason via a single
  // INFO log emitted at the call site (gated behind `toolDriftLogged`).
  let toolDriftLogged = false;
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
      });

      // 260428-k8d: tool-set drift (Anthropic invalidates signed thinking
      // signatures when the request's tools array differs from the one
      // present at signature-mint time — discover_tools mid-conversation
      // is the common trigger). Defensive: must never throw past this
      // boundary, so wrap the call in its own try/catch.
      let toolSetDrift: ReturnType<typeof shouldDropSignedFieldsForToolSet> = {
        shouldDrop: false,
        mismatchedResponseIds: [],
        reason: "no_drift",
      };
      if (getActiveToolNames && getToolSnapshotStore) {
        try {
          toolSetDrift = shouldDropSignedFieldsForToolSet({
            currentActiveTools: getActiveToolNames(),
            snapshots: getToolSnapshotStore(),
          });
        } catch {
          toolSetDrift = {
            shouldDrop: false,
            mismatchedResponseIds: [],
            reason: "no_drift",
          };
        }
      }

      // ONE INFO log per execute() when tool-set drift triggers. The flag
      // gate prevents duplicates across re-entry; memoization further
      // ensures `computeDriftIfNeeded` only runs the body once per turn.
      if (toolSetDrift.shouldDrop && !toolDriftLogged && getActiveToolNames && getToolSnapshotStore) {
        toolDriftLogged = true;
        deps.logger.info(
          {
            module: "agent.context-engine.replay-drift",
            reason: toolSetDrift.reason,
            mismatchedResponseIds: toolSetDrift.mismatchedResponseIds,
            currentToolCount: getActiveToolNames().size,
            snapshotCount: getToolSnapshotStore().size,
          },
          "Replay drift detected: active tool set changed since signature mint",
        );
      }

      // Combine: drop wins on either dimension. Preserve existing reason
      // when set; the scrubber (signature-replay-scrubber.ts:67-72) gates
      // only on `drift.drop`, and the existing DriftCheck.reason union is
      // closed — so we surface the toolset reason via the dedicated INFO
      // log above rather than expanding the type union.
      memoizedDrift = {
        drop: existingDrift.drop || toolSetDrift.shouldDrop,
        reason: existingDrift.reason,
        detail: existingDrift.detail,
      };
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

  const contextEngine = createContextEngine(contextEngineConfig, {
    logger: deps.logger,
    eventBus: deps.eventBus,
    agentId,
    sessionKey: formattedKey,
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
    // G-09: Notify cache break detector when observation masking modifies content
    onContentModified: () => cacheBreakDetector.notifyContentModification(formattedKey),
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
    // Replay drift mode getter (Fix #2): activates the
    // signature-replay-scrubber pipeline layer when drift is detected.
    getReplayDriftMode: () => computeDriftIfNeeded(),

    // LLM compaction deps
    getCompactionDeps: () => ({
      logger: deps.logger,
      getSessionManager: () => sm,
      // Serialize discovered tool names for compaction metadata
      getDiscoveredTools: () => currentDiscoveryTracker?.serialize() ?? [],
      getModel: () => {
        const model = session.agent.state.model;
        return {
          id: model?.id,
          provider: model?.provider ?? config.provider,
          contextWindow: model?.contextWindow ?? 128_000,
          reasoning: model?.reasoning ?? false,
        };
      },
      getApiKey: async () => {
        return (await deps.authStorage.getApiKey(config.provider)) ?? "";
      },
      // Resolve compaction model via 5-level priority chain
      // contextEngineOverrides removed -- invocationOverride path eliminated
      //   Path 1: operationModels.compaction (operator config) -> explicit_config (Level 2)
      //   Path 2: family default (Level 4) or agent primary (Level 5)
      ...(() => {
        const compactionResolution = resolveOperationModel({
          operationType: "compaction",
          agentProvider: config.provider,
          agentModel: config.model,
          operationModels: config.operationModels ?? {},
          providerFamily: resolveProviderFamily(config.provider),
          agentPromptTimeoutMs: config.promptTimeout?.promptTimeoutMs,
        });

        // Only set overrideModel when resolver picked a non-primary model
        // (preserves existing behavior: when no override, llm-compaction uses getModel/getApiKey)
        if (compactionResolution.source !== "agent_primary") {
          try {
            const compactionModel = deps.modelRegistry.find(
              compactionResolution.provider,
              compactionResolution.modelId,
            );
            if (compactionModel) {
              return {
                overrideModel: {
                  model: compactionModel,
                  getApiKey: async () =>
                    (await deps.authStorage.getApiKey(compactionResolution.provider)) ?? "",
                },
              };
            }
          } catch {
            // Model not in registry -- fall through to session model
          }
        }
        return {};
      })(),
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
          timestamp: Date.now(),
        });
      },
      onOverflow: (stats: { contextChars: number; budgetChars: number; recoveryAction: "strip_files" | "strip_skills" | "remove_position1" | "remove_rehydration" | "none" }) => {
        deps.eventBus?.emit("context:overflow", {
          agentId: agentId ?? config.name,
          sessionKey: formattedKey,
          contextTokens: Math.ceil(stats.contextChars / CHARS_PER_TOKEN_RATIO),
          budgetTokens: Math.ceil(stats.budgetChars / CHARS_PER_TOKEN_RATIO),
          recoveryAction: stats.recoveryAction,
          timestamp: Date.now(),
        });
      },
    }),

    // DAG mode deps (only when version === "dag")
    ...(contextEngineConfig.version === "dag" && deps.contextStore ? {
      contextStore: deps.contextStore,
      db: deps.db,
      conversationId: (sm as unknown as Record<string, string>).__dagConversationId ?? "",
      estimateTokens: (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN_RATIO),
    } : {}),
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
  };
}
