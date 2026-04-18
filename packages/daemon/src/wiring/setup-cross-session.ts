/**
 * Cross-session messaging setup: cross-session sender and sub-agent runner.
 * Extracted from daemon.ts step 6.6.9 to isolate cross-session service
 * creation from the main wiring sequence. The three callback closures
 * (executeInSession, sendToChannel, executeSubAgent) are built internally
 * from injected dependencies (assembleToolsForAgent, getExecutor, adaptersByType).
 * @module
 */

import type { NormalizedMessage, SessionKey, SpawnPacket } from "@comis/core";
import type { AppContainer } from "@comis/core";
import { tryGetContext, runWithContext, formatSessionKey, safePath } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import { deliverToChannel, createTypingController } from "@comis/channels";
import type { DeliverToChannelOptions, TypingController } from "@comis/channels";
import { createStepCounter, createSpawnPacketBuilder, generateParentSummary, resolveWorkspaceDir, createResultCondenser, createNarrativeCaster, createLifecycleHooks, createEphemeralComisSessionManager, createComisSessionManager, getCacheSafeParams, resolveOperationModel, resolveProviderFamily } from "@comis/agent";
import { createCrossSessionSender } from "../cross-session-sender.js";
import { createSubAgentRunner } from "../sub-agent-runner.js";
import { createAnnouncementBatcher } from "../announcement-batcher.js";
import { createAnnouncementDeadLetterQueue } from "../announcement-dead-letter.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** All services produced by the cross-session messaging setup phase. */
export interface CrossSessionResult {
  /** Cross-session message sender for agent-to-agent communication. */
  crossSessionSender: ReturnType<typeof createCrossSessionSender>;
  /** Sub-agent task runner for delegated execution. */
  subAgentRunner: ReturnType<typeof createSubAgentRunner>;
  /** Channel message sender for graph completion announcements */
  sendToChannel: (channelType: string, channelId: string, text: string, options?: DeliverToChannelOptions) => Promise<boolean>;
  /** Parent session announcement for graph results */
  announceToParent: (callerAgentId: string, callerSessionKey: SessionKey, text: string, channelType: string, channelId: string) => Promise<void>;
  /** Dead-letter queue for failed announcement persistence. */
  deadLetterQueue?: ReturnType<typeof createAnnouncementDeadLetterQueue>;
  /** Announcement batcher for coalescing concurrent graph/sub-agent completions. */
  announcementBatcher: ReturnType<typeof createAnnouncementBatcher>;
}

// ---------------------------------------------------------------------------
// Depth-aware graph cache retention
// ---------------------------------------------------------------------------

/**
 * Resolve cache retention for a graph sub-agent.
 * Always returns "long" (1h TTL). Depth-aware "short" for root nodes was tried
 * but caused regressions: final pipeline nodes running 10-15 min after
 * root nodes got 0 cache reads because the shared prefix expired. The 1h write
 * premium ($2.25/MTok extra for Sonnet) is far cheaper than the cache misses it prevents.
 * @param _graphNodeDepth unused — kept for interface stability
 * @returns "long" always
 */
export function resolveGraphCacheRetention(_graphNodeDepth: number | undefined): "short" | "long" {
  return "long";
}

// ---------------------------------------------------------------------------
// Sub-agent tool denylist
// ---------------------------------------------------------------------------

/** Minimum step budget for sub-agent spawns — prevents boot sequence from consuming all steps. */
export const MIN_SUB_AGENT_STEPS = 30;

/** Tools denied to sub-agents -- management tools that trigger SIGUSR2 daemon restart. */
export const SUB_AGENT_TOOL_DENYLIST = new Set([
  "gateway",          // config.patch, gateway.restart, config.rollback, env.set -> SIGUSR2
  "channels_manage",  // channels.restart, config.patch -> SIGUSR2
  "agents_manage",    // agent create/delete -> config persistence -> SIGUSR2
  "models_manage",    // model config changes -> config persistence -> SIGUSR2
  "tokens_manage",    // token CRUD -> config persistence -> SIGUSR2
  "skills_manage",    // skill config changes -> config persistence -> potential SIGUSR2
  "sessions_manage",  // session purge is destructive
  "memory_manage",    // memory purge is destructive
  "heartbeat_manage", // heartbeat config -> config persistence -> potential SIGUSR2
]);

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create cross-session messaging services: cross-session sender (fire-and-forget,
 * wait, ping-pong modes) and sub-agent runner (async sub-agent spawning with
 * allowlist enforcement and auto-archive).
 * The three callback closures are built internally from the provided dependencies:
 * - executeInSession: constructs NormalizedMessage and invokes getExecutor
 * - sendToChannel: looks up adapter by type and sends message
 * - executeSubAgent: constructs NormalizedMessage and invokes getExecutor without platform tools
 * @param deps.sessionStore           - Session persistence store (full interface)
 * @param deps.container              - Bootstrap output (config, event bus, secret manager)
 * @param deps.assembleToolsForAgent  - Tool pipeline assembler
 * @param deps.getExecutor            - Per-agent executor resolver
 * @param deps.adaptersByType         - Channel adapter registry keyed by platform type
 */
export function setupCrossSession(deps: {
  sessionStore: {
    loadByFormattedKey(key: string): { messages: unknown[]; metadata: Record<string, unknown> } | undefined;
    save(key: SessionKey, messages: unknown[], metadata: Record<string, unknown>): void;
    delete(key: SessionKey): void;
  };
  container: AppContainer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("./setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentExecutor.execute has complex signature crossing package boundaries
  getExecutor: (agentId: string) => { execute: (...args: any[]) => Promise<any> };
  adaptersByType: Map<string, { sendMessage(channelId: string, text: string, options?: import("@comis/core").SendMessageOptions): Promise<import("@comis/shared").Result<string, Error>>; channelType: string; platformAction?(action: string, params: Record<string, unknown>): Promise<import("@comis/shared").Result<unknown, Error>> }>;
  /** Optional structured logger for cross-session subsystem. */
  logger?: ComisLogger;
  /** Optional memory adapter for persisting sub-agent completion summaries. */
  memoryAdapter?: {
    store(entry: Record<string, unknown>): Promise<{ ok: boolean }>;
  };
  /** Deferred gateway send callback (wired after setupGateway). */
  gatewaySend?: { ref?: (channelId: string, text: string) => boolean };
  /** Optional active run registry for aborting in-flight SDK sessions on kill. */
  activeRunRegistry?: {
    get(sessionKey: string): { abort(): Promise<void> } | undefined;
  };
  /** Delivery queue for crash-safe persistence */
  deliveryQueue?: import("@comis/core").DeliveryQueuePort;
}): CrossSessionResult {
  const { sessionStore, container, assembleToolsForAgent, getExecutor, adaptersByType } = deps;

  // Build the three callback closures from injected deps
  const executeInSession = async (
    agentId: string,
    sessionKey: SessionKey,
    text: string,
  ): Promise<{ response: string; tokensUsed: { total: number }; cost: { total: number } }> => {
    const msg: NormalizedMessage = {
      id: randomUUID(),
      channelId: sessionKey.channelId,
      channelType: "cross-session",
      senderId: "cross-session-relay",
      text,
      timestamp: Date.now(),
      attachments: [],
      metadata: { crossSession: true },
    };
    const tools = await assembleToolsForAgent(agentId);
    const result = await getExecutor(agentId).execute(msg, sessionKey, tools, undefined, agentId);
    return { response: result.response, tokensUsed: result.tokensUsed, cost: result.cost };
  };

  const sendToChannel = async (
    channelType: string,
    channelId: string,
    text: string,
    options?: DeliverToChannelOptions,
  ): Promise<boolean> => {
    deps.logger?.debug({
      channelType,
      channelId,
      textLength: text.length,
      hasOptions: !!options,
    }, "sendToChannel delivery attempt");

    // Gateway messages route through WebSocket push, not adapter lookup
    if (channelType === "gateway" && deps.gatewaySend?.ref) {
      try {
        const ok = deps.gatewaySend.ref(channelId, text);
        deps.logger?.debug({ channelType, channelId, success: ok, gateway: true }, "sendToChannel delivery outcome");
        return ok;
      } catch {
        deps.logger?.debug({ channelType, channelId, success: false, gateway: true }, "sendToChannel delivery outcome");
        return false;
      }
    }
    const adapter = adaptersByType.get(channelType);
    if (!adapter) {
      deps.logger?.debug({ channelType, channelId, success: false, gateway: false }, "sendToChannel delivery outcome: no adapter");
      return false;
    }
    // Delegate to deliverToChannel for format + chunk + retry + events
    const result = await deliverToChannel(adapter, channelId, text, options, deps.deliveryQueue
      ? { eventBus: container.eventBus, deliveryQueue: deps.deliveryQueue }
      : undefined);
    const success = result.ok && result.value.ok;
    deps.logger?.debug({ channelType, channelId, success, gateway: false }, "sendToChannel delivery outcome");
    if (!result.ok) return false;
    return result.value.ok;
  };

  const executeSubAgent = async (
    agentId: string,
    sessionKey: SessionKey,
    task: string,
    maxSteps?: number,
    callerAgentId?: string,
    graphOverrides?: { graphId?: string; nodeId?: string; reuseSessionKey?: string; graphNodeDepth?: number },
  ): Promise<{ response: string; tokensUsed: { total: number; cacheRead?: number; cacheWrite?: number }; cost: { total: number; cacheSaved?: number }; finishReason: string; stepsExecuted: number; toolCallHistory?: string[] }> => {
    deps.logger?.debug({
      agentId,
      callerAgentId,
      channelId: sessionKey.channelId,
      maxSteps,
      isGraphSpawn: !!graphOverrides?.graphId,
      isReuseSession: !!graphOverrides?.reuseSessionKey,
      graphNodeDepth: graphOverrides?.graphNodeDepth,
    }, "executeSubAgent invoked");

    // Read channelType from ALS DeliveryOrigin instead of hardcoding "gateway"
    const ctx = tryGetContext();
    const originChannelType = ctx?.deliveryOrigin?.channelType ?? ctx?.channelType ?? "gateway";

    const msg: NormalizedMessage = {
      id: randomUUID(),
      channelId: sessionKey.channelId,
      channelType: originChannelType,
      senderId: "parent-agent",
      text: task,
      timestamp: Date.now(),
      attachments: [],
      metadata: {},
    };

    // Fresh step counter per sub-agent spawn (isolated from parent/siblings).
    // Per-spawn maxSteps is capped at config default (cannot exceed).
    const configMaxSteps = container.config.security.agentToAgent.subAgentMaxSteps;
    // Floor prevents boot sequence from consuming all steps (see MIN_SUB_AGENT_STEPS)
    const effectiveMaxSteps = Math.max(
      MIN_SUB_AGENT_STEPS,
      maxSteps !== undefined ? Math.min(maxSteps, configMaxSteps) : configMaxSteps,
    );
    const freshStepCounter = createStepCounter(effectiveMaxSteps);

    // Read spawn packet fields from session metadata
    const formattedKey = formatSessionKey(sessionKey);
    const sessionData = sessionStore.loadByFormattedKey(formattedKey);
    const meta = sessionData?.metadata ?? {};

    // Detect reuse-session spawns for persistent multi-round drivers
    const isReuseSession = !!graphOverrides?.reuseSessionKey;

    // Per-spawn toolGroups override config default (can only narrow, never widen)
    const configToolGroups = container.config.security.agentToAgent.subAgentToolGroups;
    const spawnToolGroups = Array.isArray(meta.toolGroups) && (meta.toolGroups as string[]).length > 0
      ? meta.toolGroups as string[]
      : undefined;
    const effectiveToolGroups = spawnToolGroups ?? configToolGroups;

    // Read graphSharedDir from session metadata for shared pipeline folder access
    const graphSharedDir = typeof meta.graphSharedDir === "string" && meta.graphSharedDir.length > 0
      ? meta.graphSharedDir
      : undefined;

    deps.logger?.debug({
      formattedKey,
      graphSharedDir: graphSharedDir ?? "(none)",
      isReuseSession,
      metaKeys: Object.keys(meta),
    }, "graphSharedDir propagation for sub-agent tool assembly");

    // Read graphNodeDepth from session metadata for depth-aware cache retention
    const graphNodeDepth = typeof meta.graphNodeDepth === "number" ? meta.graphNodeDepth : undefined;

    // Read subAgentMcpTools config for MCP tool inheritance policy
    const mcpPolicy = container.config.security.agentToAgent.subAgentMcpTools;

    // WORKSPACE-INHERIT: When sub-agent has no dedicated config, inherit caller's
    // config/workspace instead of falling back to default agent. This ensures
    // sub-agents spawned by named agents (e.g., technical-analyst) operate
    // within the caller's workspace, not the default workspace.
    const effectiveAgentId = (agentId in container.config.agents)
      ? agentId
      : (callerAgentId && callerAgentId in container.config.agents ? callerAgentId : agentId);

    if (effectiveAgentId !== agentId) {
      deps.logger?.debug({
        subAgentId: agentId,
        effectiveAgentId,
        callerAgentId,
      }, "Sub-agent inheriting caller workspace (no dedicated config)");
    }

    let tools = await assembleToolsForAgent(effectiveAgentId, {
      includePlatformTools: true,
      toolGroups: effectiveToolGroups,
      includeMcpTools: mcpPolicy === "inherit",
      sharedPaths: graphSharedDir ? [graphSharedDir] : undefined,
    });

    // Intersect sub-agent tools with parent's resolved tool set.
    // Sub-agent tools = intersection(parent resolved tools, ceiling-filtered tools).
    // Prevents privilege escalation: sub-agent can never have a tool the parent doesn't have.
    if (callerAgentId) {
      const parentTools = await assembleToolsForAgent(callerAgentId);
      const parentToolNames = new Set(parentTools.map((t: { name: string }) => t.name));
      const ceilingCount = tools.length;
      const beforeFilter = tools;
      tools = tools.filter((t: { name: string }) => parentToolNames.has(t.name));

      const droppedTools = beforeFilter
        .filter((t: { name: string }) => !parentToolNames.has(t.name))
        .map((t: { name: string }) => t.name);

      deps.logger?.debug({
        parentAgentId: callerAgentId,
        parentToolCount: parentToolNames.size,
        ceilingToolCount: ceilingCount,
        effectiveToolCount: tools.length,
        droppedTools,
      }, "Sub-agent tool inheritance applied");

      if (tools.length === 0 && ceilingCount > 0) {
        deps.logger?.warn({
          parentAgentId: callerAgentId,
          parentToolCount: parentToolNames.size,
          ceilingToolCount: ceilingCount,
          hint: "All sub-agent tools dropped by parent intersection; sub-agent will have no tools. Check parent agent tool policy and subAgentToolGroups config",
          errorKind: "config",
        }, "Sub-agent tool inheritance: all tools dropped");
      }
    }

    // Re-apply target agent's builtinTools ceiling after parent intersection.
    // Defense-in-depth: even if assembleToolsForAgent resolved a different config
    // (via effectiveAgentId), the target agent's own restrictions always win.
    const targetAgentConfig = container.config.agents[agentId];
    if (targetAgentConfig?.skills?.builtinTools) {
      const bt = targetAgentConfig.skills.builtinTools;
      const beforeCeiling2 = tools.length;
      const ceiling2Dropped: string[] = [];
      tools = tools.filter((t: { name: string }) => {
        if (t.name === "exec" && !bt.exec) { ceiling2Dropped.push("exec"); return false; }
        if (t.name === "process" && !bt.process) { ceiling2Dropped.push("process"); return false; }
        if (t.name === "browser" && !bt.browser) { ceiling2Dropped.push("browser"); return false; }
        return true;
      });

      if (ceiling2Dropped.length > 0) {
        deps.logger?.debug({
          agentId,
          builtinTools: { exec: bt.exec, process: bt.process, browser: bt.browser },
          beforeCount: beforeCeiling2,
          effectiveToolCount: tools.length,
          droppedByCeiling2: ceiling2Dropped,
        }, "builtinTools ceiling defense-in-depth applied");
      }
    }

    // Remove management tools that could trigger SIGUSR2 daemon restart.
    // Applied unconditionally -- sub-agents can USE the system but not CONFIGURE it.
    const beforeDenylist = tools.length;
    const deniedTools: string[] = [];
    tools = tools.filter((t: { name: string }) => {
      if (SUB_AGENT_TOOL_DENYLIST.has(t.name)) {
        deniedTools.push(t.name);
        return false;
      }
      return true;
    });

    if (deniedTools.length > 0) {
      deps.logger?.debug({
        deniedTools,
        beforeCount: beforeDenylist,
        effectiveToolCount: tools.length,
      }, "Sub-agent tool denylist applied");
    }

    // Read graph tool superset from session metadata for cache prefix sharing
    const graphToolNames = Array.isArray(meta.graphToolNames) && (meta.graphToolNames as string[]).length > 0
      ? meta.graphToolNames as string[]
      : undefined;

    // When graph tool superset is active, sort tools deterministically by name
    // for byte-identical rendering across sibling graph nodes. Security filters above
    // (parent intersection, ceiling, denylist) still take precedence -- we only sort, never add.
    if (graphToolNames && graphToolNames.length > 0) {
      const currentToolNames = new Set(tools.map((t: { name: string }) => t.name));
      const missingNames = graphToolNames.filter(n => !currentToolNames.has(n));
      if (missingNames.length > 0) {
        deps.logger?.debug({
          missingToolCount: missingNames.length,
          missingTools: missingNames,
        }, "Graph superset has tools not in current set (filtered by security policy)");
      }
      // Sort deterministically by tool name for cache prefix byte-identity
      tools.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

      deps.logger?.debug({
        graphToolCount: graphToolNames.length,
        effectiveToolCount: tools.length,
        sorted: true,
      }, "Graph tool superset applied -- tools sorted for cache prefix sharing");
    }

    // Generate parent context summary when includeParentHistory is "summary"
    let parentSummary: string | undefined;
    if (meta.includeParentHistory === "summary" && meta.parentSessionKey) {
      const parentSession = sessionStore.loadByFormattedKey(meta.parentSessionKey as string);
      if (parentSession?.messages?.length) {
        try {
          // Resolve model/apiKey for summary generation
          // condensationModel removed -- use agent default model
          const subagentCtxConfig = container.config.security.agentToAgent.subagentContext;
          const agentConfig = container.config.agents[agentId] ?? container.config.agents["default"];
          const modelId = agentConfig?.model ?? "default";
          const providerId = agentConfig?.provider ?? "anthropic";

          // Resolve API key via secret manager: check providers.entries, then fallback to env convention
          const providerEntry = container.config.providers.entries[providerId];
          const apiKeyName = providerEntry?.apiKeyName || `${providerId.toUpperCase()}_API_KEY`;
          const apiKey = container.secretManager.get(apiKeyName) ?? "";

          if (apiKey) {
            parentSummary = await generateParentSummary({
              messages: parentSession.messages,
              model: { id: modelId, provider: providerId } as unknown,
              maxTokens: subagentCtxConfig?.parentSummaryMaxTokens ?? 1000,
              apiKey,
            });
          } else {
            deps.logger?.warn({
              hint: "Cannot generate parent summary: no API key resolved for provider",
              errorKind: "config",
              providerId,
            }, "Parent summary generation skipped: missing API key");
          }
        } catch (err) {
          deps.logger?.warn({
            err,
            hint: "Parent summary generation failed; proceeding without summary",
            errorKind: "upstream",
          }, "generateParentSummary failed for parent context");
        }
      }
    }

    // Build SpawnPacket from session metadata if spawn fields are present
    let spawnPacket: SpawnPacket | undefined;
    if (meta.taskDescription && !isReuseSession) {
      const spawnAgentConfig = container.config.agents[effectiveAgentId];
      const workspaceDir = spawnAgentConfig
        ? resolveWorkspaceDir(spawnAgentConfig, effectiveAgentId)
        : resolveWorkspaceDir(container.config.agents["default"] ?? {} as import("@comis/core").AgentConfig, effectiveAgentId);

      // Build agent workspace map for sub-agent cross-workspace awareness
      const agentWorkspaces: Record<string, string> = {};
      for (const [id, agentCfg] of Object.entries(container.config.agents)) {
        agentWorkspaces[id] = resolveWorkspaceDir(agentCfg, id);
      }

      const builder = createSpawnPacketBuilder({
        workspaceDir,
        currentDepth: ((meta.spawnDepth as number) ?? 1) - 1,
        maxSpawnDepth: (meta.maxSpawnDepth as number) ?? 3,
        agentWorkspaces,
      });

      spawnPacket = builder.build({
        task: meta.taskDescription as string,
        artifactRefs: (meta.artifactRefs as string[]) ?? [],
        objective: (meta.objective as string) ?? "",
        toolGroups: (meta.toolGroups as string[]) ?? [],
        includeParentHistory: ((meta.includeParentHistory as "none" | "summary") ?? "none"),
        domainKnowledge: (meta.domainKnowledge as string[]) ?? [],
      });

      if (parentSummary) {
        spawnPacket.parentSummary = parentSummary;
      }

      // Pass parent's discovery state to child agent
      const discoveredDeferredTools = meta.discoveredDeferredTools;
      if (Array.isArray(discoveredDeferredTools) && discoveredDeferredTools.length > 0) {
        spawnPacket.discoveredDeferredTools = discoveredDeferredTools as string[];
      }

      // Attach parent's CacheSafeParams for sub-agent cache prefix sharing.
      // ctx holds the parent's ALS context including its formatted session key.
      if (ctx?.sessionKey) {
        const parentCacheSafe = getCacheSafeParams(ctx.sessionKey);
        if (parentCacheSafe) {
          spawnPacket.cacheSafeParams = parentCacheSafe;
          deps.logger?.debug({
            callerAgentId: callerAgentId ?? "unknown",
            subAgentId: agentId,
            parentModel: parentCacheSafe.model,
            parentProvider: parentCacheSafe.provider,
          }, "Attached parent CacheSafeParams to SpawnPacket for prefix sharing");
        }
      }
    }

    // contextEngineOverrides removed -- compaction model resolved via operationModels chain

    // Read per-node model override from session metadata
    const modelOverride = typeof meta.modelOverride === "string" && meta.modelOverride.length > 0
      ? meta.modelOverride
      : undefined;

    // Resolve sub-agent model through 5-level priority chain
    const subAgentConfig = container.config.agents[effectiveAgentId]
      ?? container.config.agents["default"];
    const parentResolvedModel = tryGetContext()?.resolvedModel;
    const subagentResolution = subAgentConfig ? resolveOperationModel({
      operationType: "subagent",
      agentProvider: subAgentConfig.provider,
      agentModel: subAgentConfig.model,
      operationModels: subAgentConfig.operationModels ?? {},
      providerFamily: resolveProviderFamily(subAgentConfig.provider),
      invocationOverride: modelOverride,
      parentModel: parentResolvedModel,
      agentPromptTimeoutMs: subAgentConfig.promptTimeout?.promptTimeoutMs,
    }) : undefined;

    deps.logger?.debug(
      { agentId, model: subagentResolution?.model, source: subagentResolution?.source, operationType: "subagent", parentResolvedModel },
      "Subagent model resolved",
    );

    const isGraphSpawn = typeof graphSharedDir === "string" && graphSharedDir.length > 0;
    const GRAPH_PROMPT_TIMEOUT_MS = 600_000;

    // Base subagent retention is "short" (5m TTL).
    // Graph sub-agents with graphSharedDir get depth-aware retention:
    //   - Root nodes (depth=0): "short" -- complete in <3min, consumed by Wave 2 within 3-4min
    //   - Downstream nodes (depth >= 1): "long" -- may be consumed by further waves
    // Non-graph sub-agents always get "short".
    const subAgentCacheRetention = graphSharedDir
      ? resolveGraphCacheRetention(graphNodeDepth)
      : "short" as const;

    // R-11: Session adapter for sub-agents.
    // When subAgentSessionPersistence is true, sub-agents get disk-backed JSONL sessions
    // for debugging/auditing. Default (false): ephemeral in-memory, garbage-collected.
    const subAgentPersistence = container.config.security?.agentToAgent?.subAgentSessionPersistence ?? false;
    const spawnAgentConfigForSession = container.config.agents[effectiveAgentId];
    const sessionCwd = spawnAgentConfigForSession
      ? resolveWorkspaceDir(spawnAgentConfigForSession, effectiveAgentId)
      : resolveWorkspaceDir(container.config.agents["default"] ?? {} as import("@comis/core").AgentConfig, effectiveAgentId);

    let ephemeralSessionAdapter;
    if (isReuseSession || subAgentPersistence) {
      // Reuse sessions MUST be disk-backed so conversation survives between rounds.
      // Also applies when subAgentSessionPersistence is true (existing behavior).
      ephemeralSessionAdapter = createComisSessionManager({
        sessionBaseDir: safePath(sessionCwd, "sessions"),
        lockDir: safePath(sessionCwd, ".locks"),
        cwd: sessionCwd,
      });
    } else {
      // Ephemeral: in-memory only, no disk writes
      ephemeralSessionAdapter = createEphemeralComisSessionManager(sessionCwd);
    }

    // Wrap in runWithContext so sub-agent inherits parent's ALS context.
    // Pass spawnPacket in ExecutionOverrides for both code paths.
    // Use resolved model from resolveOperationModel instead of raw modelOverride.
    const executionOverrides = {
      stepCounter: freshStepCounter,
      spawnPacket,
      // contextEngineOverrides removed
      model: subagentResolution?.model ?? modelOverride,
      operationType: "subagent" as const,
      promptTimeout: (() => {
        const effectiveTimeoutMs = isGraphSpawn
          ? GRAPH_PROMPT_TIMEOUT_MS
          : subagentResolution?.timeoutMs;
        return effectiveTimeoutMs ? { promptTimeoutMs: effectiveTimeoutMs } : undefined;
      })(),
      // Reuse sessions need their own cache entries (skipCacheWrite will be false
      // because spawnPacket is undefined). Force "long" retention for multi-round persistence.
      // Graph sub-agents use depth-aware retention:
      // Root nodes (depth=0): "short" -- complete fast, consumed within 5m by Wave 2.
      // Downstream nodes (depth>=1): "long" -- may be consumed by later waves beyond 5m.
      // Model resolution's cacheRetention must NOT override graph-aware default.
      cacheRetention: isReuseSession
        ? "long" as const
        : (graphSharedDir
          ? resolveGraphCacheRetention(graphOverrides?.graphNodeDepth)
          : (subagentResolution?.cacheRetention ?? subAgentCacheRetention)),
      ephemeralSessionAdapter,
      skipRag: !!graphSharedDir,
      // Thread graphId/nodeId for cache write signal emission
      graphId: graphOverrides?.graphId,
      nodeId: graphOverrides?.nodeId,
    };
    const result = ctx
      ? await runWithContext(ctx, () =>
          getExecutor(effectiveAgentId).execute(
            msg, sessionKey, tools, undefined, agentId,
            undefined, undefined,
            executionOverrides,
          ),
        )
      : await getExecutor(effectiveAgentId).execute(
          msg, sessionKey, tools, undefined, agentId,
          undefined, undefined,
          executionOverrides,
        );
    deps.logger?.debug({
      agentId,
      callerAgentId,
      finishReason: result.finishReason,
      stepsExecuted: result.stepsExecuted,
      tokensTotal: result.tokensUsed?.total,
      costTotal: result.cost?.total,
      toolCallCount: result.toolCallHistory?.length ?? 0,
      responseLength: result.response?.length ?? 0,
    }, "executeSubAgent completed");

    return {
      response: result.response,
      tokensUsed: result.tokensUsed,
      cost: result.cost,
      finishReason: result.finishReason,
      stepsExecuted: result.stepsExecuted,
      toolCallHistory: result.toolCallHistory,
    };
  };

  // 6.6.9a. Cross-session sender — fire-and-forget, wait, or ping-pong messaging
  const crossSessionSender = createCrossSessionSender({
    sessionStore: {
      loadByFormattedKey: (key: string) => sessionStore.loadByFormattedKey(key),
      save: (key: SessionKey, messages: unknown[], metadata: Record<string, unknown>) =>
        sessionStore.save(key, messages, metadata),
    },
    executeInSession,
    sendToChannel,
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
  });

  // Announce to parent session by injecting [System Message] and executing parent agent.
  // Proxy typing emitted around announcement delivery (not spawn-time).
  const announceToParent = async (
    callerAgentId: string,
    callerSessionKey: SessionKey,
    text: string,
    channelType: string,
    channelId: string,
  ): Promise<void> => {
    deps.logger?.debug({
      callerAgentId,
      channelId: callerSessionKey.channelId,
      textLength: text.length,
      channelType,
      targetChannelId: channelId,
    }, "announceToParent invoked");

    // Emit proxy typing around announcement delivery (not spawn-time)
    const proxyId = `announce-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    container.eventBus.emit("typing:proxy_start", {
      runId: proxyId,
      channelType,
      channelId,
      parentSessionKey: typeof callerSessionKey === "string"
        ? callerSessionKey
        : `${callerSessionKey.channelId}:${callerSessionKey.userId}:${callerSessionKey.tenantId}`,
      agentId: callerAgentId,
      timestamp: Date.now(),
    });
    try {
      const result = await executeInSession(callerAgentId, callerSessionKey, text);
      // If the parent agent responds (not NO_REPLY), deliver to channel
      const trimmed = result.response.trim();
      const isNoReply = !trimmed || trimmed === "NO_REPLY" || trimmed.startsWith("NO_REPLY");
      deps.logger?.debug({
        callerAgentId,
        responseLength: trimmed.length,
        willDeliver: !isNoReply,
        isNoReply,
      }, "announceToParent execution result");
      if (!isNoReply) {
        // Extract thread context from ALS delivery origin so
        // announcements land in the correct Telegram topic / thread.
        const ctx = tryGetContext();
        const threadId = ctx?.deliveryOrigin?.threadId;
        await sendToChannel(channelType, channelId, trimmed, threadId ? { threadId } : undefined);
      }
    } finally {
      container.eventBus.emit("typing:proxy_stop", {
        runId: proxyId,
        channelType,
        channelId,
        reason: "completed" as const,
        durationMs: 0,
        timestamp: Date.now(),
      });
    }
  };

  // Create dead-letter queue for failed announcement persistence (before batcher, so batcher can reference it)
  const dlqBaseDir = resolve(container.config.dataDir || ".");
  const deadLetterFilePath = safePath(dlqBaseDir, "dead-letters.jsonl");
  const deadLetterQueue = createAnnouncementDeadLetterQueue({
    filePath: deadLetterFilePath,
    maxRetries: 5,
    retryIntervalMs: 60_000,
    maxAgeMs: 3_600_000,
    maxEntries: 100,
    eventBus: container.eventBus,
    logger: deps.logger?.child({ module: "dead-letter-queue" }),
  });

  // Create announcement batcher for coalescing near-simultaneous sub-agent completions
  const announcementBatcher = createAnnouncementBatcher({
    announceToParent,
    sendToChannel,  // fallback for announcement timeout
    logger: deps.logger?.child({ submodule: "announcement-batcher" }),
    deadLetterQueue,  // persist failed fallback items
  });

  // Resolve condensation model via 5-level priority chain.
  // condensationModel removed -- no invocationOverride for condensation.
  const subagentCtxConfigForCondenser = container.config.security?.agentToAgent?.subagentContext;
  const defaultAgentConfig = container.config.agents?.["default"];

  const condensationResolution = resolveOperationModel({
    operationType: "condensation",
    agentProvider: defaultAgentConfig?.provider ?? "anthropic",
    agentModel: defaultAgentConfig?.model ?? "default",
    operationModels: defaultAgentConfig?.operationModels ?? {},
    providerFamily: resolveProviderFamily(defaultAgentConfig?.provider ?? "anthropic"),
    agentPromptTimeoutMs: defaultAgentConfig?.promptTimeout?.promptTimeoutMs,
  });

  // Resolve API key from resolution.provider (enables cross-provider condensation)
  const condenserProviderEntry = container.config.providers?.entries?.[condensationResolution.provider];
  const condenserApiKeyName = condenserProviderEntry?.apiKeyName
    || `${condensationResolution.provider.toUpperCase()}_API_KEY`;
  const condenserApiKey = container.secretManager?.get(condenserApiKeyName) ?? "";

  deps.logger?.debug(
    { model: condensationResolution.model, source: condensationResolution.source, provider: condensationResolution.provider },
    "Condensation model resolved",
  );

  const resultCondenser = createResultCondenser({
    maxResultTokens: subagentCtxConfigForCondenser?.maxResultTokens ?? 4000,
    condensationStrategy: subagentCtxConfigForCondenser?.condensationStrategy ?? "auto",
    dataDir: container.config.dataDir || ".",
    logger: deps.logger
      ? { info: deps.logger.info.bind(deps.logger), warn: deps.logger.warn.bind(deps.logger), debug: deps.logger.debug.bind(deps.logger) }
      : { info: () => {}, warn: () => {}, debug: () => {} },
  });

  // Create NarrativeCaster for tagged result announcements
  const narrativeCaster = createNarrativeCaster({
    enabled: subagentCtxConfigForCondenser?.narrativeCasting ?? true,
    tagPrefix: subagentCtxConfigForCondenser?.resultTagPrefix ?? "Subagent Result",
  });

  // Create lifecycle hooks for spawn preparation and completion
  const lifecycleHooks = createLifecycleHooks({
    logger: deps.logger
      ? { info: deps.logger.info.bind(deps.logger), warn: deps.logger.warn.bind(deps.logger), debug: deps.logger.debug.bind(deps.logger) }
      : { info: () => {}, warn: () => {}, debug: () => {} },
    eventBus: container.eventBus,
  });

  // 6.6.9b. Sub-agent runner — async sub-agent spawning with allowlist + auto-archive
  const subAgentRunner = createSubAgentRunner({
    sessionStore: {
      save: (key: SessionKey, messages: unknown[], metadata: Record<string, unknown>) =>
        sessionStore.save(key, messages, metadata),
      delete: (key: SessionKey) => sessionStore.delete(key),
    },
    executeAgent: executeSubAgent,
    sendToChannel,
    announceToParent,
    eventBus: container.eventBus,
    config: container.config.security.agentToAgent,
    tenantId: container.config.tenantId,
    dataDir: container.config.dataDir || ".",
    logger: deps.logger?.child({ submodule: "sub-agent-runner" }),
    memoryAdapter: deps.memoryAdapter,
    batcher: announcementBatcher,
    activeRunRegistry: deps.activeRunRegistry,
    resultCondenser,
    condenserModel: condenserApiKey ? { id: condensationResolution.modelId, provider: condensationResolution.provider } as unknown : undefined,
    condenserApiKey: condenserApiKey || undefined,
    narrativeCaster,  // tagged result formatting
    lifecycleHooks,  // spawn preparation + completion hooks
    deadLetterQueue,  // announcement persistence on delivery failure
  });

  // ---------------------------------------------------------------------------
  // Proxy typing listener
  // ---------------------------------------------------------------------------

  /** Per-platform typing refresh intervals (matches inbound-pipeline.ts). */
  const PROXY_TYPING_REFRESH: Record<string, number> = {
    telegram: 4000,
    discord: 8000,
    whatsapp: 8000,
    signal: 4000,
    line: 15000,
    imessage: 4000,
  };

  const PROXY_TTL_MS = 300_000; // 5 min max (matches sub-agent watchdog)
  const PROXY_SWEEP_INTERVAL_MS = 60_000; // Sweep every 60s

  const proxyControllers = new Map<string, {
    controller: TypingController;
    startedAt: number;
  }>();

  // typing:proxy_start — create TypingController for parent channel
  container.eventBus.on("typing:proxy_start", (evt) => {
    // Skip duplicate proxy for same run
    if (proxyControllers.has(evt.runId)) return;

    // Skip channels without typing support
    const refreshMs = PROXY_TYPING_REFRESH[evt.channelType];
    if (!refreshMs) return;

    const adapter = adaptersByType.get(evt.channelType);
    if (!adapter?.platformAction) return;

    const boundPlatformAction = adapter.platformAction;
    const controller = createTypingController(
      { mode: "thinking", refreshMs, ttlMs: PROXY_TTL_MS },
      async (chatId: string) => {
        // Pass threadId for forum topic routing
        await boundPlatformAction("sendTyping", { chatId, ...(evt.threadId ? { threadId: evt.threadId } : {}) });
      },
      { warn: (obj: object, msg: string) => deps.logger?.warn(obj, msg) },
    );

    controller.start(evt.channelId);
    proxyControllers.set(evt.runId, {
      controller,
      startedAt: Date.now(),
    });

    deps.logger?.debug({
      runId: evt.runId,
      channelType: evt.channelType,
      channelId: evt.channelId,
      agentId: evt.agentId,
    }, "Proxy typing started for sub-agent run");
  });

  // typing:proxy_stop — stop and remove controller
  container.eventBus.on("typing:proxy_stop", (evt) => {
    const entry = proxyControllers.get(evt.runId);
    if (!entry) return;

    entry.controller.stop();
    proxyControllers.delete(evt.runId);

    deps.logger?.debug({
      runId: evt.runId,
      reason: evt.reason,
      durationMs: evt.durationMs,
    }, "Proxy typing stopped for sub-agent run");
  });

  // TTL sweep timer — clean up leaked entries
  const proxySweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [runId, entry] of proxyControllers) {
      if (now - entry.startedAt > PROXY_TTL_MS) {
        entry.controller.stop();
        proxyControllers.delete(runId);
        deps.logger?.debug({ runId, reason: "ttl_expired" }, "Proxy typing TTL expired");
      }
    }
  }, PROXY_SWEEP_INTERVAL_MS);
  proxySweepTimer.unref(); // Do not prevent process exit

  // Shutdown cleanup — stop all proxy controllers and clear sweep timer
  container.eventBus.on("system:shutdown", () => {
    clearInterval(proxySweepTimer);
    for (const [, entry] of proxyControllers) {
      entry.controller.stop();
    }
    proxyControllers.clear();
  });

  return { crossSessionSender, subAgentRunner, sendToChannel, announceToParent, deadLetterQueue, announcementBatcher };
}
