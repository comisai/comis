/**
 * Tool assembly setup: assembleToolsForAgent and preprocessMessageText.
 * Extracted from daemon.ts steps 6.6.8.5 (tool pipeline assembly) to isolate
 * per-agent tool creation and message preprocessing from the main wiring
 * sequence.
 * @module
 */

import { isAbsolute, resolve } from "node:path";
import type { AppContainer, SkillsConfig, ApprovalGate, CredentialMappingPort, WrapExternalContentOptions } from "@comis/core";
import { enterConfigMutationFence, leaveConfigMutationFence } from "../rpc/persist-to-config.js";
import type { ComisLogger } from "@comis/infra";
import { SkillsConfigSchema, sanitizeLogString, tryGetContext, parseFormattedSessionKey, safePath } from "@comis/core";
import { sessionKeyToPath, WORKSPACE_FILE_NAMES, DEFAULT_TEMPLATES } from "@comis/agent";
import { stat as fsStat } from "node:fs/promises";
import type { PerAgentConfig } from "@comis/core";
import type { ImageGenerationPort } from "@comis/core";
import type { SandboxProvider, ExecSandboxConfig, LazyPaths, FileStateTracker } from "@comis/skills";
import {
  assembleToolPipeline,
  createFileStateTracker,
  createCronTool,
  createUnifiedMemoryTool,
  createUnifiedSessionTool,
  createUnifiedContextTool,
  createAgentsListTool,
  createMessageTool,
  createDiscordActionTool,
  createTelegramActionTool,
  createSlackActionTool,
  createWhatsAppActionTool,
  createSessionsSendTool,
  createSessionsSpawnTool,
  createSubagentsTool,
  createPipelineTool,
  createImageTool,
  createTTSTool,
  createTranscribeAudioTool,
  createDescribeVideoTool,
  createExtractDocumentTool,
  createGatewayTool,
  createBrowserTool,
  createAgentsManageTool,
  createObsQueryTool,
  createSessionsManageTool,
  createModelsManageTool,
  createTokensManageTool,
  createChannelsManageTool,
  createSkillsManageTool,
  createMcpManageTool,
  createHeartbeatManageTool,
  createNotifyTool,
  createImageGenerateTool,
  createBackgroundTasksTool,
  createExecTool,
  createProcessTool,
  createProcessRegistry,
  createApplyPatchTool,
  sanitizeImageForApi,
  createMediaPersistenceService,
  createCredentialInjector,
  mcpToolsToAgentTools,
  TOOL_PROFILES,
  TOOL_GROUPS,
  type ProcessRegistry,
  type MediaPersistenceService,
  type PlatformToolProvider,
  type RpcCall,
  type LinkRunner,
  type CredentialInjector,
  type McpClientManager,
  type ToolSourceProfile,
} from "@comis/skills";

// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for tool assembly setup. */
export interface ToolsDeps {
  /** In-process RPC dispatcher. */
  rpcCall: RpcCall;
  /** Per-agent config map (container.config.agents). */
  agents: Record<string, PerAgentConfig>;
  /** Default agent ID from routing config. */
  defaultAgentId: string;
  /** Per-agent workspace directory paths. */
  workspaceDirs: Map<string, string>;
  /** Default agent workspace directory path. */
  defaultWorkspaceDir: string;
  /** Base directory for resolving relative skill discovery paths (typically ~/.comis). */
  dataDir: string;
  /** Secret manager from container. */
  secretManager: AppContainer["secretManager"];
  /** Typed event bus from container. */
  eventBus: AppContainer["eventBus"];
  /** Module-bound logger for skills subsystem. */
  skillsLogger: ComisLogger;
  /** Link understanding pipeline runner. */
  linkRunner: LinkRunner;
  /** Approval gate for privileged tool actions (create/delete agents). */
  approvalGate?: ApprovalGate;
  /** Filtered environment for subprocess spawning. */
  subprocessEnv?: Record<string, string>;
  /** Optional credential mapping store for per-agent credential injection */
  credentialMappingStore?: CredentialMappingPort;
  /** Optional callback for suspicious content detection in external content */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /** Optional MCP client manager for external MCP server tool integration. */
  mcpClientManager?: McpClientManager;
  /** Image generation provider (undefined when API key missing -- tool not registered). */
  imageGenProvider?: ImageGenerationPort;
  /** OS-level sandbox provider detected once at daemon startup. */
  sandboxProvider?: SandboxProvider;
  /** Background task manager for background_tasks tool registration. */
  backgroundTaskManager?: import("@comis/agent").BackgroundTaskManager;
}

/** Options for assembleToolsForAgent controlling platform tool selection. */
export interface AssembleToolsOptions {
  /** Include platform tools (default: true). */
  includePlatformTools?: boolean;
  /** Filter to specific tool groups -- uses TOOL_PROFILES from tool-policy.ts.
   *  When specified with includePlatformTools: true, only platform tools matching
   *  the named profiles are included. builtinTools config is always applied as a
   *  hard ceiling after profile filtering -- if builtinTools.exec is false, exec
   *  is excluded regardless of what the profile says. */
  toolGroups?: string[];
  /** Include MCP tools from connected servers (default: true).
   *  MCP tools bypass TOOL_PROFILES filtering since their names are dynamic. */
  includeMcpTools?: boolean;
  /** Shared read+write paths for graph pipeline nodes */
  sharedPaths?: string[];
  /** Per-invocation FileStateTracker for file safety guards. Created automatically if not provided. */
  fileStateTracker?: FileStateTracker;
}

/** All services produced by the tools setup phase. */
export interface ToolsResult {
  /** Assemble the full tool pipeline for a specific agent. */
  assembleToolsForAgent: (
    agentId: string,
    options?: AssembleToolsOptions,
  ) => Promise<Awaited<ReturnType<typeof assembleToolPipeline>>>;
  /** Preprocess message text through the link understanding pipeline. */
  preprocessMessageText: (text: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Setup function
// ---------------------------------------------------------------------------

/**
 * Create per-agent tool assembly and message preprocessing closures.
 * Synchronous -- just creates closures over the injected dependencies.
 * rpcCall is passed as a dep (not imported directly) because
 * assembleToolsForAgent creates tools that call rpcCall, and rpcCall's
 * gateway path calls assembleToolsForAgent -- this circular dependency
 * is broken by callback injection.
 * @param deps - Tool assembly dependencies
 */
export function setupTools(deps: ToolsDeps): ToolsResult {
  const {
    rpcCall,
    agents,
    defaultAgentId,
    workspaceDirs,
    defaultWorkspaceDir,
    dataDir,
    secretManager,
    eventBus,
    skillsLogger,
    linkRunner,
    approvalGate,
    subprocessEnv,
    credentialMappingStore,
    onSuspiciousContent,
    mcpClientManager,
    sandboxProvider,
  } = deps;

  /** Per-agent ProcessRegistry instances for background process lifecycle management. */
  const processRegistries = new Map<string, ProcessRegistry>();

  function getOrCreateRegistry(agentId: string): ProcessRegistry {
    let registry = processRegistries.get(agentId);
    if (!registry) {
      registry = createProcessRegistry();
      processRegistries.set(agentId, registry);
    }
    return registry;
  }

  /** Per-agent MediaPersistenceService for browser screenshot persistence. */
  const screenshotPersistenceServices = new Map<string, MediaPersistenceService>();

  function getOrCreateScreenshotPersistence(agentId: string): MediaPersistenceService {
    let svc = screenshotPersistenceServices.get(agentId);
    if (!svc) {
      const wsDir = workspaceDirs.get(agentId) ?? defaultWorkspaceDir;
      svc = createMediaPersistenceService({
        workspaceDir: wsDir,
        logger: skillsLogger,
      });
      screenshotPersistenceServices.set(agentId, svc);
    }
    return svc;
  }

  /** Create an agent-scoped rpcCall that injects _agentId, _callerSessionKey, and _deliveryTarget into every call. */
  function createAgentRpcCall(agentId: string): RpcCall {
    return async (method, params) => {
      const ctx = tryGetContext();
      // Build delivery target from context for cron job routing
      let deliveryTarget: { channelId: string; userId: string; tenantId: string; channelType?: string } | undefined;
      if (ctx?.sessionKey) {
        const parsed = parseFormattedSessionKey(ctx.sessionKey);
        if (parsed) {
          deliveryTarget = {
            channelId: parsed.channelId,
            userId: parsed.userId,
            tenantId: parsed.tenantId,
            channelType: ctx.channelType,
          };
        }
      }
      // Extract caller channel metadata from DeliveryOrigin
      const origin = ctx?.deliveryOrigin;
      return rpcCall(method, {
        ...params,
        _agentId: agentId,
        ...(ctx?.sessionKey && { _callerSessionKey: ctx.sessionKey }),
        ...(deliveryTarget && { _deliveryTarget: deliveryTarget }),
        ...(origin && { _callerChannelType: origin.channelType }),
        ...(origin && { _callerChannelId: origin.channelId }),
      });
    };
  }

  /** Create MCP tools from connected servers (extracted to bypass profile filtering). */
  function getMcpTools(toolSourceProfiles?: Record<string, Partial<ToolSourceProfile>>): ReturnType<PlatformToolProvider> {
    if (!mcpClientManager) return [];
    const mcpTools = mcpClientManager.getTools();
    if (mcpTools.length === 0) return [];
    const agentMcpTools = mcpToolsToAgentTools(
      mcpTools,
      mcpClientManager.callTool.bind(mcpClientManager),
      toolSourceProfiles,
      skillsLogger,
    );
    return agentMcpTools;
  }

  /** Assemble tools for a specific agent using its own skills config. */
  async function assembleToolsForAgent(
    agentId: string,
    options?: AssembleToolsOptions,
  ): Promise<Awaited<ReturnType<typeof assembleToolPipeline>>> {
    const includePlatform = options?.includePlatformTools ?? true;
    const toolGroups = options?.toolGroups;
    const sharedPaths = options?.sharedPaths;
    const fileStateTracker = options?.fileStateTracker ?? createFileStateTracker();

    // Enrich sharedPaths for admin-trust agents: grant cross-workspace file access (Quick 165)
    // Default agent (orchestrator) and supervisor-profile agents can access other agent workspaces.
    // Lazy callback for admin agents so hot-added workspaces are visible without re-assembling tools.
    const isDefaultAgent = agentId === defaultAgentId;
    const isSupervisor = (agents[agentId] ?? agents[defaultAgentId])?.skills?.toolPolicy?.profile === "supervisor";
    const effectiveSharedPaths: LazyPaths = (isDefaultAgent || isSupervisor)
      ? () => {
          const paths = [...(sharedPaths ?? [])];
          for (const [id, dir] of workspaceDirs) {
            if (id !== agentId && !paths.includes(dir)) {
              paths.push(dir);
            }
          }
          return paths;
        }
      : [...(sharedPaths ?? [])]; // Non-admin: static empty array (no change)

    const agentConfig = agents[agentId] ?? agents[defaultAgentId];

    // Use the agent's own skills config (SkillsConfigSchema defaults apply if not specified)
    const skillsConfig: SkillsConfig = agentConfig?.skills ?? SkillsConfigSchema.parse({});

    // Resolve relative discoveryPaths against dataDir so ./skills -> ~/.comis/skills
    const agentWorkspaceSkillsDir = safePath(
      workspaceDirs.get(agentId) ?? defaultWorkspaceDir,
      "skills",
    );
    const readOnlyPaths = skillsConfig.discoveryPaths.map((p: string) =>
      isAbsolute(p) ? p : resolve(dataDir, p),
    );
    if (!readOnlyPaths.includes(agentWorkspaceSkillsDir)) {
      readOnlyPaths.unshift(agentWorkspaceSkillsDir);
    }

    // Default read-only access to daemon logs directory for troubleshooting
    const logsDir = resolve(dataDir, "logs");
    if (!readOnlyPaths.includes(logsDir)) {
      readOnlyPaths.push(logsDir);
    }

    // Create per-agent rpcCall that injects _agentId
    const agentRpc = createAgentRpcCall(agentId);
    const agentPlatformTools: PlatformToolProvider = () => {
      const tools: ReturnType<PlatformToolProvider> = [
        createCronTool(agentRpc),
        createUnifiedMemoryTool(agentRpc, approvalGate),
        createUnifiedSessionTool(agentRpc),
        createAgentsListTool(agentRpc),
        createMessageTool(agentRpc),
        createDiscordActionTool(agentRpc, skillsLogger),
        createTelegramActionTool(agentRpc),
        createSlackActionTool(agentRpc),
        createWhatsAppActionTool(agentRpc),
        createSessionsSendTool(agentRpc),
        createSessionsSpawnTool(agentRpc),
        createSubagentsTool(agentRpc, skillsLogger),
        createPipelineTool(agentRpc, skillsLogger, approvalGate),
        createImageTool(agentRpc),
        createTTSTool(agentRpc),
        createTranscribeAudioTool(agentRpc),
        createDescribeVideoTool(agentRpc),
        createExtractDocumentTool(agentRpc),
        createGatewayTool(agentRpc),
        createAgentsManageTool(agentRpc, approvalGate, {
          onMutationStart: enterConfigMutationFence,
          onMutationEnd: leaveConfigMutationFence,
          // After agents.create seeds the new workspace's template files
          // (IDENTITY.md, ROLE.md, etc.) via ensureWorkspace, register those
          // seeded paths in THIS session's tracker so the caller LLM can
          // overwrite them via `write` without hitting the [not_read] gate.
          // Each file path is absolute; the seeded content is deterministic
          // (DEFAULT_TEMPLATES[name]), so we register the known mtime + content.
          onAgentCreated: async ({ workspaceDir }) => {
            if (!workspaceDir) return;
            for (const name of WORKSPACE_FILE_NAMES) {
              const filePath = safePath(workspaceDir, name);
              try {
                const st = await fsStat(filePath);
                fileStateTracker.recordRead(
                  filePath,
                  st.mtimeMs,
                  0,
                  undefined,
                  Buffer.from(DEFAULT_TEMPLATES[name], "utf-8"),
                );
              } catch {
                /* file absent or stat failed -- skip registration */
              }
            }
          },
        }),
        createObsQueryTool(agentRpc),
        createSessionsManageTool(agentRpc, approvalGate),
        createModelsManageTool(agentRpc),
        createTokensManageTool(agentRpc, approvalGate),
        createChannelsManageTool(agentRpc, approvalGate),
        createSkillsManageTool(agentRpc, approvalGate),
        createMcpManageTool(agentRpc, approvalGate),
        createHeartbeatManageTool(agentRpc),
        createNotifyTool(agentRpc),
      ];

      // Background tasks tool -- always registered (any user can check their tasks)
      if (deps.backgroundTaskManager) {
        tools.push(createBackgroundTasksTool({ manager: deps.backgroundTaskManager, agentId }));
      }

      // Image generation tool only when provider available (API key present)
      if (deps.imageGenProvider) {
        tools.push(createImageGenerateTool(agentRpc));
      }

      // Conditional: DAG context tools
      const ceVersion = agentConfig?.contextEngine?.version ?? "pipeline";
      if (ceVersion === "dag") {
        tools.push(createUnifiedContextTool(agentRpc));
      }

      // Browser tool is conditional on builtinTools.browser config toggle
      if (skillsConfig.builtinTools.browser) {
        tools.push(createBrowserTool({
          rpcCall: agentRpc,
          sanitizeImage: sanitizeImageForApi,
          persistMedia: getOrCreateScreenshotPersistence(agentId),
          workspaceDir: workspaceDirs.get(agentId) ?? defaultWorkspaceDir,
        }));
      }

      // Build per-agent sandbox config from daemon provider + agent config
      const sandboxCfg: ExecSandboxConfig | undefined =
        skillsConfig.execSandbox.enabled === "always" && sandboxProvider
          ? {
              sandbox: sandboxProvider,
              sharedPaths: effectiveSharedPaths,
              readOnlyPaths,
              configReadOnlyPaths: [...skillsConfig.execSandbox.readOnlyAllowPaths, logsDir],
            }
          : undefined;

      if (!sandboxCfg && skillsConfig.execSandbox.enabled === "always") {
        skillsLogger.warn(
          { agentId, hint: "Sandbox enabled in config but no provider available -- exec tool will run without OS sandbox", errorKind: "config" },
          "Exec tool running without OS sandbox",
        );
      }

      // Exec tool -- always instantiated; builtinTools ceiling applied after profile filtering
      {
        const registry = getOrCreateRegistry(agentId);
        const agentWorkspaceDir = workspaceDirs.get(agentId) ?? defaultWorkspaceDir;

        // Getter for session tool-results dir, resolved at call time via ALS context.
        // Matches session path pattern from comis-session-manager + microcompaction-guard.
        const getToolResultsDir = (): string | undefined => {
          const ctx = tryGetContext();
          if (!ctx?.sessionKey) return undefined;
          const parsed = parseFormattedSessionKey(ctx.sessionKey);
          if (!parsed) return undefined;
          const sessionBaseDir = safePath(agentWorkspaceDir, "sessions");
          const sessionDir = sessionKeyToPath(parsed, sessionBaseDir);
          return safePath(sessionDir, "tool-results");
        };

        tools.push(createExecTool(
          agentWorkspaceDir,
          registry,
          skillsLogger,
          subprocessEnv,  // Filtered subprocess environment
          sandboxCfg,  // Per-agent sandbox config
          eventBus,  // command:blocked audit events
          getToolResultsDir,  // Session tool-results dir for output persistence
        ));
      }

      // Process tool -- always instantiated; builtinTools ceiling applied after profile filtering
      {
        const registry = getOrCreateRegistry(agentId);
        tools.push(createProcessTool(registry, skillsLogger));
      }

      // Apply patch tool -- always included, gated by tool policy
      tools.push(createApplyPatchTool(workspaceDirs.get(agentId) ?? defaultWorkspaceDir, effectiveSharedPaths, skillsLogger));

      return tools;
    };

    // Credential injection -- create injector from credential mappings
    let credentialInjector: CredentialInjector | undefined;
    if (credentialMappingStore) {
      const mappingsResult = credentialMappingStore.listAll();
      if (mappingsResult.ok && mappingsResult.value.length > 0) {
        credentialInjector = createCredentialInjector({
          secretManager,
          mappings: mappingsResult.value,
          eventBus,
          agentId,
        });
      }
    }

    // Determine platform tool provider based on options
    let platformToolProvider: PlatformToolProvider | undefined;
    if (!includePlatform) {
      platformToolProvider = undefined;
    } else if (toolGroups && toolGroups.length > 0 && !toolGroups.includes("full")) {
      // Build allowed tool name set from all requested profiles AND groups
      const allowedNames = new Set<string>();
      for (const group of toolGroups) {
        const profileTools = TOOL_PROFILES[group];
        if (profileTools) {
          for (const t of profileTools) allowedNames.add(t);
        }
        // Also check TOOL_GROUPS (e.g., "context_expand" -> ["ctx_expand", "ctx_inspect"])
        const groupKey = group.startsWith("group:") ? group : `group:${group}`;
        const groupTools = TOOL_GROUPS[groupKey];
        if (groupTools) {
          for (const t of groupTools) allowedNames.add(t);
        }
      }
      platformToolProvider = () => agentPlatformTools().filter(t => allowedNames.has(t.name));
    } else {
      // No toolGroups or "full" in toolGroups -- return all platform tools unfiltered
      platformToolProvider = agentPlatformTools;
    }

    // Apply builtinTools config as hard ceiling -- removes tools the agent explicitly disables.
    // This runs AFTER profile filtering so builtinTools always wins regardless of profile content.
    if (platformToolProvider) {
      const profileFilteredProvider = platformToolProvider;
      platformToolProvider = () => {
        const tools = profileFilteredProvider();
        // DEBUG logging for ceiling filter decisions
        skillsLogger.debug({
          agentId,
          builtinTools: {
            exec: skillsConfig.builtinTools.exec,
            process: skillsConfig.builtinTools.process,
            browser: skillsConfig.builtinTools.browser,
          },
          toolCountBeforeCeiling: tools.length,
        }, "builtinTools ceiling filter applied");
        return tools.filter(t => {
          if (t.name === "exec" && !skillsConfig.builtinTools.exec) return false;
          if (t.name === "process" && !skillsConfig.builtinTools.process) return false;
          if (t.name === "browser" && !skillsConfig.builtinTools.browser) return false;
          return true;
        });
      };
    }

    // Resolve per-agent source gate config -> toolSourceProfiles overrides.
    // Resolved before MCP tool closure so MCP tools also receive the overrides.
    const sourceGate = agentConfig?.sourceGate;
    let toolSourceProfiles: Record<string, Partial<ToolSourceProfile>> | undefined;
    if (sourceGate) {
      toolSourceProfiles = {
        web_fetch: {
          ...(sourceGate.maxResponseBytes !== undefined && { maxResponseBytes: sourceGate.maxResponseBytes }),
          ...(sourceGate.stripHiddenHtml !== undefined && { stripHidden: sourceGate.stripHiddenHtml }),
        },
      };
    }

    // Append MCP tools after profile filtering (MCP names are dynamic, can't be in TOOL_PROFILES)
    const includeMcp = options?.includeMcpTools ?? true;
    if (includeMcp && platformToolProvider) {
      const basePlatformProvider = platformToolProvider;
      platformToolProvider = () => {
        const baseTools = basePlatformProvider();
        const mcpTools = getMcpTools(toolSourceProfiles);
        if (mcpTools.length > 0) {
          skillsLogger.debug(
            { agentId, mcpToolCount: mcpTools.length },
            "MCP tools added to agent tool set",
          );
        }
        return [...baseTools, ...mcpTools];
      };
    }

    return assembleToolPipeline({
      config: skillsConfig,
      workspacePath: workspaceDirs.get(agentId) ?? defaultWorkspaceDir,
      secretManager,
      platformTools: platformToolProvider,
      // PiEventBridge emits tool:executed from SDK event stream -- no wrapWithAudit needed
      eventBus: undefined,
      logger: skillsLogger,
      agentId,
      credentialInjector,
      onSuspiciousContent,
      readOnlyPaths,
      toolSourceProfiles,
      sharedPaths: effectiveSharedPaths,
      fileStateTracker,
    });
  }

  /**
   * Preprocess message text through the link understanding pipeline.
   * Detects URLs, fetches content (SSRF-safe), and enriches text with external context.
   * Returns original text unchanged if link understanding is disabled or no URLs found.
   */
  async function preprocessMessageText(text: string): Promise<string> {
    const result = await linkRunner.processMessage(text);
    if (result.linksProcessed > 0) {
      skillsLogger.info(
        { linksProcessed: result.linksProcessed, errors: result.errors.length },
        "Link understanding processed",
      );
    }
    return result.enrichedText;
  }

  // Tool audit event bus subscription — tools are a skills concern
  function truncateParams(params: Record<string, unknown>, maxLen = 1500): { text: string; truncated: boolean } {
    const raw = JSON.stringify(params);
    const sanitized = sanitizeLogString(raw);
    const truncated = sanitized.length > maxLen;
    return { text: truncated ? sanitized.slice(0, maxLen) + "..." : sanitized, truncated };
  }

  eventBus.on("tool:executed", (event) => {
    const paramResult = event.params ? truncateParams(event.params) : undefined;
    // Include params preview (1000 chars) in the message string for formatted log output visibility
    const paramsPreview = paramResult
      ? ` — ${paramResult.text.length > 1000 ? paramResult.text.slice(0, 1000) + "…" : paramResult.text}`
      : "";
    skillsLogger.debug({
      toolName: event.toolName,
      durationMs: Math.round(event.durationMs),
      success: event.success,
      userId: event.userId,
      agentId: event.agentId,
      sessionKey: event.sessionKey,
      ...(event.description && { description: event.description }),
      ...(paramResult && { params: paramResult.text }),
      ...(paramResult?.truncated && { paramsTruncated: true }),
    }, `Tool audit: ${event.toolName}${event.description ? ` (${event.description})` : ""} ${event.success ? "succeeded" : "failed"} (${Math.round(event.durationMs)}ms)${paramsPreview}`);
  });

  // Cleanup all background processes on system shutdown
  eventBus.on("system:shutdown", async () => {
    let totalKilled = 0;
    for (const [agentId, registry] of processRegistries) {
      const cleanedCount = await registry.cleanup();
      if (cleanedCount > 0) {
        skillsLogger.info({ agentId, cleanedCount }, "Background processes cleaned up on shutdown");
      }
      totalKilled += cleanedCount;
    }
    if (totalKilled > 0) {
      skillsLogger.info({ totalKilled }, "All background processes cleaned up");
    }
    processRegistries.clear();

    // Disconnect MCP servers on shutdown
    if (mcpClientManager) {
      await mcpClientManager.disconnectAll();
      skillsLogger.info("MCP servers disconnected on shutdown");
    }
  });

  return { assembleToolsForAgent, preprocessMessageText };
}
