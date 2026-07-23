// SPDX-License-Identifier: Apache-2.0
/**
 * Graph-execution wiring for cross-session sub-agent spawns.
 *
 * Builds sub-agent execution with depth-aware cache retention and step-budget floors.
 *
 * @module
 */
import type { AgentCapability, NormalizedMessage, SessionKey, SpawnPacket, AppContainer, AgentConfig, FileLockPort, ConversationLocator, SessionStorePort, WorkspacePolicySnapshot } from "@comis/core";
import { ConversationRefSchema, ConversationScopeSchema, tryGetContext, runWithContext, formatSessionKey, safePath, systemNowMs, resolveWorkspaceDir, SUB_AGENT_TOOL_DENYLIST } from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import {
  createStepCounter,
  createSpawnPacketBuilder,
  generateParentSummary,
  createEphemeralComisSessionManager,
  createComisSessionManager,
  getCacheSafeParams,
  resolveOperationModel,
  resolveProviderFamily,
  type ExecutionResult,
} from "@comis/agent";
import { randomUUID } from "node:crypto";
import type { GitExec } from "@comis/skills/tools";
import type { WorktreeRegistry } from "../setup-worktree-sweep.js";
import { resolveGraphCacheRetention } from "./graph-cache-retention.js";
import { maybePrepareWorktreeForSpawn } from "./worktree-spawn-run.js";
export { resolveGraphCacheRetention } from "./graph-cache-retention.js";
/** Minimum step budget for sub-agent spawns — prevents boot sequence from consuming all steps. */
export const MIN_SUB_AGENT_STEPS = 30;

// ---------------------------------------------------------------------------
// executeSubAgent builder
// ---------------------------------------------------------------------------

/**
 * Closure-captured deps for the executeSubAgent callback.
 */
export interface ExecuteSubAgentDeps {
  container: AppContainer;
  sessionStore: Pick<SessionStorePort, "load" | "loadByRef">;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires complex type parameters from pi-ai SDK
  assembleToolsForAgent: (agentId: string, options?: import("../setup-tools.js").AssembleToolsOptions) => Promise<any[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentExecutor.execute has complex signature crossing package boundaries
  getExecutor: (agentId: string) => { execute: (...args: any[]) => Promise<any> };
  fileLock: FileLockPort;
  logger?: ComisLogger;
  /**
   * The lifecycle GitExec the composition root binds (the real
   * execFile-backed `createExecGit` adapted to `{ stdout, exitCode }`). Present
   * ⇒ a child whose session metadata carries `worktree:true` runs in an isolated
   * git worktree. **Absent ⇒ the worktree request is honestly ignored** (no git
   * seam to create one) — a content-free WARN surfaces the skip rather than a
   * silent no-op. Paired with {@link worktreeRegistry}; the daemon wires BOTH.
   */
  worktreeGitExec?: GitExec;
  /** The shared registry the boot/periodic orphan sweep reads. Paired with {@link worktreeGitExec}. */
  worktreeRegistry?: WorktreeRegistry;
}

/**
 * The executeSubAgent callback signature accepted by createSubAgentRunner.
 */
export type ExecuteSubAgentFn = (
  agentId: string,
  sessionKey: SessionKey,
  conversation: ConversationLocator,
  task: string,
  maxSteps?: number,
  callerAgentId?: string,
  graphOverrides?: {
    graphId?: string;
    nodeId?: string;
    reuseConversation?: ConversationLocator;
    graphNodeDepth?: number;
    workspacePolicySnapshot?: WorkspacePolicySnapshot;
  },
  /** Per-spawn token budget — rides executionOverrides into the child's
   *  BudgetGuard per-execution cap. Absent ⇒ no per-execution cap. */
  tokenBudget?: number,
  autonomyContext?: {
    rootRunId: string;
    parentLeaseId?: string;
    parentCaps: readonly AgentCapability[];
    onAssemblyAuthority(authority: {
      rootRunId: string;
      leaseId: string;
      caps: readonly AgentCapability[];
    }): void;
  },
) => Promise<Pick<ExecutionResult, "response" | "tokensUsed" | "cost" | "finishReason" | "stepsExecuted" | "toolCallHistory" | "terminalErrorKind">>;
/**
 * Build the executeSubAgent callback wired into createSubAgentRunner. The
 * closure captures the daemon container + session store + tool assembler +
 * executor resolver, plus FileLockPort for the ephemeral session adapter.
 *
 * Covers spawn-packet construction, sub-agent tool intersection (parent →
 * ceiling → denylist), graph tool sorting, parent context summarization,
 * sub-agent model resolution, cache retention selection, ephemeral vs
 * persistent session adapter, and runWithContext propagation.
 */
export function buildExecuteSubAgent(deps: ExecuteSubAgentDeps): ExecuteSubAgentFn {
  const { container, sessionStore, assembleToolsForAgent, getExecutor } = deps;

  return async (
    agentId,
    sessionKey,
    conversation,
    task,
    maxSteps,
    callerAgentId,
    graphOverrides,
    tokenBudget,
    autonomyContext,
  ) => {
    deps.logger?.debug({
      agentId,
      callerAgentId,
      channelId: sessionKey.channelId,
      maxSteps,
      isGraphSpawn: !!graphOverrides?.graphId,
      isReuseSession: !!graphOverrides?.reuseConversation,
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
      timestamp: systemNowMs(),
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
    const loadedSession = sessionStore.load(conversation.conversationScope);
    if (!loadedSession.ok) throw loadedSession.error;
    const sessionData = loadedSession.value;
    const meta = sessionData?.metadata ?? {};

    // Detect reuse-session spawns for persistent multi-round drivers
    const isReuseSession = !!graphOverrides?.reuseConversation;

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
    // Leaf nodes (no downstream dependents) use "short" cache retention.
    const isLeafNode = meta.isLeafNode === true;

    // Read subAgentMcpTools config for MCP tool inheritance policy
    const mcpPolicy = container.config.security.agentToAgent.subAgentMcpTools;

    // WORKSPACE-INHERIT: When sub-agent has no dedicated config, inherit caller's
    // config/workspace instead of falling back to default agent.
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

    // The child's base jailed workspace (the agent's shared workspace dir).
    const baseAgentConfig = container.config.agents[effectiveAgentId];
    const baseWorkspaceDir = baseAgentConfig
      ? resolveWorkspaceDir(baseAgentConfig, effectiveAgentId, container.config.dataDir || undefined)
      : resolveWorkspaceDir(container.config.agents["default"] ?? {} as AgentConfig, effectiveAgentId, container.config.dataDir || undefined);

    // When the child session metadata requests a worktree (persisted by the
    // runner from session.spawn's request.worktree), run the child in an ISOLATED
    // git worktree under its base workspace (off HEAD, auto-clean-if-unchanged). The
    // decision + WARN-on-unwired-seam live in maybePrepareWorktreeForSpawn (size cap);
    // createWorktree throws on git failure — the try/finally below fails the spawn LOUD.
    const worktreeHandle = await maybePrepareWorktreeForSpawn({
      wantsWorktree: meta.worktree === true,
      runId: typeof meta.runId === "string" ? meta.runId : undefined,
      baseWorkspaceDir,
      agentId: effectiveAgentId,
      seam: {
        ...(deps.worktreeGitExec ? { worktreeGitExec: deps.worktreeGitExec } : {}),
        ...(deps.worktreeRegistry ? { worktreeRegistry: deps.worktreeRegistry } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      },
    });
    // The run's effective working tree: the worktree when created, else the shared base.
    const effectiveWorkspaceDir = worktreeHandle?.dir ?? baseWorkspaceDir;

    let tools = await assembleToolsForAgent(effectiveAgentId, {
      includePlatformTools: true,
      toolGroups: effectiveToolGroups,
      includeMcpTools: mcpPolicy === "inherit",
      sharedPaths: graphSharedDir ? [graphSharedDir] : undefined,
      sessionKey,
      ...(ctx?.deliveryOrigin !== undefined
        ? { requesterOrigin: ctx.deliveryOrigin }
        : {}),
      ...(autonomyContext !== undefined
        ? {
            autonomyParent: {
              rootRunId: autonomyContext.rootRunId,
              ...(autonomyContext.parentLeaseId !== undefined
                ? { leaseId: autonomyContext.parentLeaseId }
                : {}),
              caps: autonomyContext.parentCaps,
            },
            onAutonomyAssembly: autonomyContext.onAssemblyAuthority,
          }
        : {}),
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
          hint: "All sub-agent tools dropped by parent intersection; sub-agent will have no tools.",
          errorKind: "config" as const,
        }, "Sub-agent tool inheritance: all tools dropped");
      }
    }

    // Re-apply target agent's builtinTools ceiling after parent intersection.
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
    // for byte-identical rendering across sibling graph nodes.
    if (graphToolNames && graphToolNames.length > 0) {
      const currentToolNames = new Set(tools.map((t: { name: string }) => t.name));
      const missingNames = graphToolNames.filter(n => !currentToolNames.has(n));
      if (missingNames.length > 0) {
        deps.logger?.debug({
          missingToolCount: missingNames.length,
          missingTools: missingNames,
        }, "Graph superset has tools not in current set (filtered by security policy)");
      }
      tools.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

      deps.logger?.debug({
        graphToolCount: graphToolNames.length,
        effectiveToolCount: tools.length,
        sorted: true,
      }, "Graph tool superset applied -- tools sorted for cache prefix sharing");
    }

    // Generate parent context summary when includeParentHistory is "summary"
    let parentSummary: string | undefined;
    if (meta.includeParentHistory === "summary" && meta.parentConversationRef && meta.parentConversationScope) {
      const parentScope = ConversationScopeSchema.safeParse(meta.parentConversationScope);
      const parentRef = ConversationRefSchema.safeParse(meta.parentConversationRef);
      const parentLoaded = parentScope.success && parentRef.success
        ? sessionStore.loadByRef(
            { tenantId: parentScope.data.tenantId, agentId: parentScope.data.agentId },
            parentRef.data,
          )
        : undefined;
      const parentSession = parentLoaded?.ok ? parentLoaded.value : undefined;
      if (parentSession?.messages.length) {
        try {
          const subagentCtxConfig = container.config.security.agentToAgent.subagentContext;
          const agentConfig = container.config.agents[agentId] ?? container.config.agents["default"];
          const modelId = agentConfig?.model ?? "default";
          const providerId = agentConfig?.provider ?? "anthropic";
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
              errorKind: "config" as const,
              providerId,
            }, "Parent summary generation skipped: missing API key");
          }
        } catch (err) {
          deps.logger?.warn({
            err,
            hint: "Parent summary generation failed; proceeding without summary",
            errorKind: "dependency" as const,
          }, "generateParentSummary failed for parent context");
        }
      }
    }

    // Build SpawnPacket from session metadata if spawn fields are present
    let spawnPacket: SpawnPacket | undefined;
    if (meta.taskDescription && !isReuseSession) {
      // The spawn packet's workspace path is the run's actual working tree
      // (the worktree when present), so the child's prompt names the right dir.
      const workspaceDir = effectiveWorkspaceDir;

      const agentWorkspaces: Record<string, string> = {};
      for (const [id, agentCfg] of Object.entries(container.config.agents)) {
        agentWorkspaces[id] = resolveWorkspaceDir(agentCfg, id, container.config.dataDir || undefined);
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
        ...(typeof meta.language === "string" ? { language: meta.language } : {}),
      });

      if (parentSummary) {
        spawnPacket.parentSummary = parentSummary;
      }

      const discoveredDeferredTools = meta.discoveredDeferredTools;
      if (Array.isArray(discoveredDeferredTools) && discoveredDeferredTools.length > 0) {
        spawnPacket.discoveredDeferredTools = discoveredDeferredTools as string[];
      }

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

    // Base subagent retention "short" (5m TTL); graph sub-agents get depth-aware.
    const subAgentCacheRetention = graphSharedDir
      ? resolveGraphCacheRetention(graphNodeDepth, isLeafNode)
      : "short" as const;

    // Session adapter for sub-agents.
    const subAgentPersistence = container.config.security?.agentToAgent?.subAgentSessionPersistence ?? false;
    const spawnAgentConfigForSession = container.config.agents[effectiveAgentId];
    const sessionCwd = spawnAgentConfigForSession
      ? resolveWorkspaceDir(spawnAgentConfigForSession, effectiveAgentId, container.config.dataDir || undefined)
      : resolveWorkspaceDir(container.config.agents["default"] ?? {} as AgentConfig, effectiveAgentId, container.config.dataDir || undefined);

    let ephemeralSessionAdapter;
    if (isReuseSession || subAgentPersistence) {
      // Reuse sessions MUST be disk-backed so conversation survives between rounds.
      ephemeralSessionAdapter = createComisSessionManager({
        sessionBaseDir: safePath(sessionCwd, "sessions"),
        lockDir: safePath(sessionCwd, ".locks"),
        cwd: sessionCwd,
        fileLock: deps.fileLock,
        // Resolved daemon data dir — the session-index writer otherwise
        // falls back to the REAL ~/.comis (260611 live-fire; same fix as
        // setup-agents-runtime's primary session adapter).
        dataDir: container.config.dataDir || undefined,
      });
    } else {
      ephemeralSessionAdapter = createEphemeralComisSessionManager(sessionCwd);
    }

    // Wrap in runWithContext so sub-agent inherits parent's ALS context.
    const executionOverrides = {
      stepCounter: freshStepCounter,
      spawnPacket,
      model: subagentResolution?.model ?? modelOverride,
      operationType: "subagent" as const,
      promptTimeout: (() => {
        if (isGraphSpawn) {
          // The graph constant is NOT operator-tunable — labeled so
          // hints render honest prose instead of a fake agents.* knob.
          return { promptTimeoutMs: GRAPH_PROMPT_TIMEOUT_MS, source: "graph_constant" as const };
        }
        // Falsy-guard semantics preserved: a 0/undefined subagent resolution
        // still yields undefined (no override materialized).
        return subagentResolution?.timeoutMs
          ? { promptTimeoutMs: subagentResolution.timeoutMs, source: subagentResolution.timeoutSource }
          : undefined;
      })(),
      cacheRetention: isReuseSession
        ? "long" as const
        : (graphSharedDir
          ? resolveGraphCacheRetention(graphOverrides?.graphNodeDepth, isLeafNode)
          : (subagentResolution?.cacheRetention ?? subAgentCacheRetention)),
      ephemeralSessionAdapter,
      skipRag: !!graphSharedDir,
      graphId: graphOverrides?.graphId,
      nodeId: graphOverrides?.nodeId,
      // Thread effective tool groups so pi-event-bridge can enrich
      // "Tool X not found" errors with delegation routing hints.
      activeToolGroups: effectiveToolGroups,
      // A per-spawn token budget becomes the child's per-execution
      // cap (pi-executor feeds it to budgetGuard.resetExecution). Omitted when
      // absent so the no-budget path stays byte-identical to today.
      ...(tokenBudget !== undefined && { tokenBudget }),
      ...(graphOverrides?.workspacePolicySnapshot !== undefined && {
        workspacePolicySnapshot: graphOverrides.workspacePolicySnapshot,
      }),
      // When a worktree was created, the child's file-tool jail cwd IS the
      // worktree (the SDK session cwd + resource-loader / context-engine root), so
      // exec/read/write/edit resolve inside it. Omitted when no worktree ⇒ the
      // executor uses its construction-bound deps.workspaceDir (byte-identical).
      ...(worktreeHandle ? { workspaceDir: effectiveWorkspaceDir } : {}),
    };
    let result;
    try {
      result = ctx
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
    } finally {
      // On the child's terminal settle (success OR throw), auto-clean the
      // worktree if-unchanged — a pristine worktree is removed, a dirty/ahead one
      // is PRESERVED so the agent's work survives (the boot sweep retries it). A
      // cleanup error must NOT mask the run's own outcome, so it is swallowed with
      // a content-free WARN (the worktree is left for the sweep, never lost).
      if (worktreeHandle) {
        try {
          await worktreeHandle.cleanup();
        } catch (cleanupErr) {
          deps.logger?.warn(
            {
              err: cleanupErr,
              hint: "worktree clean-if-unchanged failed on terminal settle; the worktree is left for the boot orphan-sweep to reclaim",
              errorKind: "internal" as const,
            },
            "Worktree cleanup failed; left for the orphan sweep",
          );
        }
      }
    }
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
      ...(result.terminalErrorKind === undefined
        ? {}
        : { terminalErrorKind: result.terminalErrorKind }),
    };
  };
}
