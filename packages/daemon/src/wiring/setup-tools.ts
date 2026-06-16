// SPDX-License-Identifier: Apache-2.0
/**
 * Tool assembly setup: assembleToolsForAgent and preprocessMessageText.
 * Isolates per-agent tool creation and message preprocessing from the
 * main wiring sequence.
 * @module
 */

import { isAbsolute, resolve } from "node:path";
import type { AppContainer, SkillsConfig, ApprovalGate, WrapExternalContentOptions, SessionKey, ToolCapabilityPort, McpServerEntry, TimerPort, ContextStorePort } from "@comis/core";
import { enterConfigMutationFence, leaveConfigMutationFence } from "../api/shared/persist-to-config.js";
import type { ComisLogger } from "@comis/infra";
import {
  SkillsConfigSchema,
  tryGetContext,
  parseFormattedSessionKey,
  safePath,
  formatSessionKey,
  systemNowMs,
} from "@comis/core";
import { sessionKeyToPath } from "@comis/agent";
import type { SessionTrackerRegistry, CapabilityClass } from "@comis/agent";
import { toolResultsDirFromSessionPath } from "./tool-results-dir.js";
// Workspace helpers live in @comis/core.
import {
  WORKSPACE_FILE_NAMES,
  DEFAULT_TEMPLATES,
  registerWorkspaceFilesInTracker,
} from "@comis/core";
import { stat as fsStat } from "node:fs/promises";
import type { PerAgentConfig } from "@comis/core";
import type { ImageGenerationPort } from "@comis/core";
// Skills-concern symbols staying on the `.` subpath (policy, pipeline, MCP
// bridge, credential injection, link understanding). These symbols live
// in packages/skills/src/skills/index.ts.
import {
  TOOL_PROFILES,
  TOOL_GROUPS,
  assembleToolPipeline,
  mcpToolsToAgentTools,
  extractServerToolFilters,
  type LinkRunner,
  type McpClientManager,
  type ToolSourceProfile,
  type PlatformToolProvider,
} from "@comis/skills";
import type { RpcCall } from "@comis/skills/platform-tools";

// Tool capability adapters + factories live on the `./tools` subpath.
// Exec / process / apply-patch tool factories, file-state tracker,
// media-persistence / image-sanitizer all live under
// packages/skills/src/tools/. Daemon imports them from the dedicated
// subpath to surface the architectural boundary in the type system.
import {
  createExecTool,
  createProcessTool,
  createProcessRegistry,
  createApplyPatchTool,
  createFileStateTracker,
  sanitizeImageForApi,
  createMediaPersistenceService,
  type SandboxProvider,
  type ExecSandboxConfig,
  type LazyPaths,
  type FileStateTracker,
  type ProcessRegistry,
  type MediaPersistenceService,
  type TerminalSessionRegistry,
} from "@comis/skills/tools";
// Terminal-driver (v2.11) wiring extracted to setup-terminal-tools.ts (file-size cap).
import { wireAgentTerminalTools, buildTerminalEgressDeps, deriveTerminalAttentionConfig } from "./setup-terminal-tools.js";
import { buildTerminalWakeDurability, type WakeDurabilityConfig } from "./terminal-durable-wiring.js";
// In-session expansion-loop (v2.12 Phase 131, E1/E2) dag-gated ctx_* wiring.
import { maybeWireContextTools } from "./setup-context-tools.js";
// Tool-audit DEBUG-line subscription extracted to setup-tool-audit.ts (file-size cap).
import { setupToolAuditLogging } from "./setup-tool-audit.js";

// Descriptor registry on the `./platform-tools` subpath. Replaces the
// prior inline 38-call enumeration of `createXTool(agentRpc, ...)`
// factories.
import {
  createPlatformToolRegistry,
  type PlatformToolBuildContext,
} from "@comis/skills/platform-tools";
// Broker activation seam types. Extracted to setup-broker-activation.ts to
// keep this file under 800 lines. BrokerContextDeps is re-exported here so
// existing imports of it from setup-tools.ts continue to resolve.
export type { BrokerContextDeps } from "./setup-broker-activation.js";
import { buildBrokerSpawnEnv, type BrokerContextDeps } from "./setup-broker-activation.js";


// ---------------------------------------------------------------------------
// Deps / Result types
// ---------------------------------------------------------------------------

/** Dependencies for tool assembly setup. */
export interface ToolsDeps {
  /** In-process RPC dispatcher. */
  rpcCall: RpcCall;
  /** Per-agent config map (container.config.agents). */
  agents: Record<string, PerAgentConfig>;
  /** WR-04 (Phase 174-04): resolve a provider's operator capabilityClass override (providers.entries.<id>.capabilities.capabilityClass) for ctx_expand's walk depth. */
  getProviderCapabilityClass?: (provider: string | undefined) => CapabilityClass | undefined;
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
  /**
   * Platform-managed secret names from container — exec.secretRefs refuses
   * these to prevent agents exfiltrating daemon credentials.
   */
  platformSecretNames: AppContainer["platformSecretNames"];
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
  /** Optional callback for suspicious content detection in external content */
  onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /**
   * MCP client manager for external MCP server tool integration. Always
   * defined — `setupMcp` constructs it unconditionally so runtime server
   * additions via `mcp.connect` RPC surface on the next inbound message
   * without requiring a daemon restart.
   */
  mcpClientManager: McpClientManager;
  /**
   * Fresh accessor for the current MCP server entries
   * (container.config.integrations.mcp.servers). Read PER CALL inside the
   * serverFiltersFn closure passed to mcpToolsToAgentTools so config:mutated
   * updates (in-memory swap) take effect on the next tool assembly
   * without a daemon restart — do NOT cache the result.
   */
  getMcpServerEntries: () => readonly McpServerEntry[];
  /**
   * Per-agent ToolCapabilityPort resolver. Populated by daemon.ts from the
   * AgentsResult.toolCapabilityPorts map (one adapter per agent constructed
   * inside setupSingleAgent). Used by exec / process tools to consult the
   * live install-detour mode + connected MCP servers + visible skills, and
   * to read operator-supplied cluster hints. The closure may throw or fall
   * back to the default agent's port for unknown agentIds -- daemon.ts
   * decides the contract.
   *
   * Consumed via the single mandated form `deps.getCapabilityPortForAgent(agentId)`
   * inside assembleToolsForAgent (mirrors the deps.<field> direct-access
   * convention used for nearby fields like deps.eventBus, deps.skillsLogger,
   * deps.linkRunner, deps.subprocessEnv).
   */
  getCapabilityPortForAgent: (agentId: string) => ToolCapabilityPort;
  /** Image generation provider (undefined when API key missing -- tool not registered). */
  imageGenProvider?: ImageGenerationPort;
  /** OS-level sandbox provider detected once at daemon startup. */
  sandboxProvider?: SandboxProvider;
  /** Background task manager for background_tasks tool registration. */
  backgroundTaskManager?: import("@comis/agent").BackgroundTaskManager;
  /** Per-session FileStateTracker pool. Required -- use createSessionTrackerRegistry(). */
  sessionTrackerRegistry: SessionTrackerRegistry<FileStateTracker>;
  /**
   * Optional. When present, the exec tool is wired with broker-only network
   * isolation + secure credential home + proxy env for the driven-CLI spawn.
   * Absent (undefined) → default open network, no proxy env, no regression.
   */
  brokerContext?: BrokerContextDeps;
  /** The daemon's injected `TimerPort` — threaded toward the terminal reaper (124-09 WR-01
   *  closure) so the idle-TTL/max-sessions sweep composes. Absent ⇒ no terminal reaper. */
  timers?: TimerPort;
  /** The concrete LCD `ContextStorePort` (`createLcdStore`) from setupMemory — injected so
   *  assembleToolsForAgent wires the dag-mode `ctx_*` tools (E1/E2); the agent sees only the
   *  core port TYPE (the agent-to-store cut). Absent ⇒ ctx_* not wired. */
  lcdStore?: ContextStorePort;
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
  /** Formatted-or-structural session key. When present, the assembled tools share the
   *  session's persistent FileStateTracker via sessionTrackerRegistry. Absent for
   *  heartbeat/startup/subagent paths that supply fileStateTracker directly. */
  sessionKey?: SessionKey;
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
  /**
   * Drain per-agent background-process registries on shutdown. Returned from
   * setupTools so the composition root (daemon.ts → setupShutdown) can
   * invoke teardown directly via ShutdownDeps.shutdownBackgroundProcesses
   * Replaces the previous eventBus.on("system:shutdown", ...) subscriber
   * that silently no-op'd in production.
   */
  shutdownBackgroundProcesses: () => Promise<void>;
  /** 124-09: the per-agent terminal registries map (closure-local) — the composition root
   *  wires the one-per-daemon wake-FSM against the SAME registries (owner-scoped active-check). */
  terminalRegistries: ReadonlyMap<string, TerminalSessionRegistry>;
  /** 124-09: resolve the per-agent terminal attention config (allow-entry autoAnswer/
   *  hintPatterns + caps); read per-wake so a config swap applies; undefined ⇒ escalate. */
  getTerminalAttentionConfig: (agentId: string) => ReturnType<typeof deriveTerminalAttentionConfig>;
  /** 165-07: the durable wake deps (journal store + checkLiveness + heartbeatMs/maxCostUsd)
   *  the composition root spreads into setupTerminalWake. */
  terminalDurability: ReturnType<typeof buildTerminalWakeDurability>;
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
    platformSecretNames,
    eventBus,
    skillsLogger,
    linkRunner,
    approvalGate,
    subprocessEnv,
    onSuspiciousContent,
    mcpClientManager,
    getMcpServerEntries,
    sandboxProvider,
    sessionTrackerRegistry,
  } = deps;

  /** Per-agent ProcessRegistry instances for background process lifecycle management. */
  const processRegistries = new Map<string, ProcessRegistry>();

  /** Per-agent TerminalSessionRegistry instances; closure-local, lazily built. */
  const terminalRegistries = new Map<string, TerminalSessionRegistry>();

  const terminalEgress = buildTerminalEgressDeps(skillsLogger, sandboxProvider); // built ONCE, injected per-agent

  /** Agents we've already logged the no-sandbox WARN for. Per-agent assembly
   * runs on every session/heartbeat/cron tick; without this guard the WARN
   * repeats on every LLM call even though the underlying state is fixed at
   * daemon startup (detectSandboxProvider runs once). */
  const warnedNoSandboxAgents = new Set<string>();

  /**
   * Platform-tool descriptor registry -- single source of truth for the 45
   * platform-tools. Constructed once at `setupTools` invocation (the set is
   * static at module-load time). Daemon's per-agent assembly filters the
   * registry by `conditional` predicates and invokes each surviving
   * descriptor's `build(ctx)` callback with a runtime context. This replaces
   * the prior 175-line `agentPlatformTools` closure that hand-enumerated
   * 38 `createXTool(agentRpc, ...)` factory calls. The exec / process /
   * apply-patch tools stay enumerated inline below — they are `./tools`
   * subpath (built-in non-platform).
   */
  const PLATFORM_TOOL_REGISTRY = createPlatformToolRegistry();

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

  /** Create an agent-scoped rpcCall that injects _agentId, _callerSessionKey, and _deliveryTarget into every call. (O3/WR-01 Phase-157 producer hook: inject resolved capabilityClass on graph.* params here — see graph-helpers.ts.) */
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
    const mcpTools = mcpClientManager.getTools();
    if (mcpTools.length === 0) return [];
    const agentMcpTools = mcpToolsToAgentTools(
      mcpTools,
      mcpClientManager.callTool.bind(mcpClientManager),
      toolSourceProfiles,
      skillsLogger,
      onSuspiciousContent,
      // Per-server tool filtering applied at the bridge. Read the
      // current entries FRESH per call (config:mutated swaps take effect on
      // the next assembly without a restart). Field extraction is delegated
      // to extractServerToolFilters so the literal filter-list field names
      // stay confined to the bridge file.
      (serverName: string) => {
        const entry = getMcpServerEntries().find((s) => s.name === serverName);
        return entry ? extractServerToolFilters(entry) : undefined;
      },
      // Emit the typed truncation telemetry event. The bridge stays
      // decoupled from the bus (narrow callback); the daemon — where eventBus is
      // in scope — stamps the timestamp and does the emit. Payload carries only
      // sizes + identifiers, never the truncated content.
      (e) => eventBus.emit("mcp:server:result_truncated", { ...e, timestamp: systemNowMs() }),
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
    // Tracker resolution priority:
    //   1. Explicit tracker (sub-agent spawn path -- isolates per spawn).
    //   2. sessionKey + registry (inbound-message path -- persists across turns).
    //   3. Ephemeral (heartbeat/cron/startup -- no session context).
    const fileStateTracker =
      options?.fileStateTracker
      ?? (options?.sessionKey
          ? sessionTrackerRegistry.get(formatSessionKey(options.sessionKey))
          : createFileStateTracker());

    // Pre-register the agent's own workspace template files in the tracker.
    // ensureWorkspace() runs at daemon startup (before any session tracker
    // exists), so files like IDENTITY.md/USER.md/ROLE.md are on disk but
    // unknown to the per-turn tracker. Without this, the agent's first
    // `write` to its own workspace hits [not_read] and wastes an LLM turn
    // pivoting to read->edit. Safety is preserved via the content-hash
    // staleness check in write-tool.ts (manual edits between registration
    // and write still surface as [stale_file]).
    // Only the agent's OWN workspace -- other-agent workspaces visible to
    // admin agents are covered by agents_manage's onAgentCreated callback.
    const ownWorkspaceDir = workspaceDirs.get(agentId) ?? defaultWorkspaceDir;
    await registerWorkspaceFilesInTracker(ownWorkspaceDir, fileStateTracker, skillsLogger);

    // Enrich sharedPaths for admin-trust agents: grant cross-workspace file access.
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

    // Use the agent's own skills config (SkillsConfigSchema defaults apply if not specified).
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

    // Create per-agent rpcCall that injects _agentId.
    const agentRpc = createAgentRpcCall(agentId);
    // Per-agent build context for the descriptor registry. The platform-tool
    // factory calls live in packages/skills/src/platform-tools/registry.ts.
    // The 4 truly-conditional tools (background_tasks, image_generate,
    // unified_context, browser) carry `conditional` predicates on the
    // registry side; daemon filters via .filter(d => !d.conditional ||
    // d.conditional(ctx)) BEFORE invoking d.build(ctx).
    //
    // The agents-manage callbacks (onMutationStart / onMutationEnd /
    // onAgentCreated) are NOT a conditional -- they're complex args passed
    // unconditionally via the build context.
    //
    // The exec/process/apply-patch tools remain enumerated inline below the
    // registry call (their per-call config involves the sandbox provider,
    // workspace dir, tool-results dir resolver, and capability port -- too
    // complex to fit the descriptor `build(ctx)` shape; they're `./tools`
    // subpath, not platform-tools, so they don't belong in the platform-tool
    // registry).
    const agentPlatformTools: PlatformToolProvider = () => {
      const ctx: PlatformToolBuildContext = {
        agentId,
        rpcCall: agentRpc,
        skillsLogger,
        approvalGate,
        eventBus,
        // Gates the resources/prompts descriptors. The manager dep is
        // already in scope (ToolsDeps.mcpClientManager); the registry's
        // conditional predicates register list_resources/read_resource/
        // list_prompts/get_prompt only when a connected server advertises the
        // matching capability without a per-server opt-out.
        mcpClientManager,
        onSuspiciousContent,
        imageGenProvider: deps.imageGenProvider,
        backgroundTaskManager: deps.backgroundTaskManager,
        toolCapabilityPort: deps.getCapabilityPortForAgent(agentId),
        contextEngineVersion: agentConfig?.contextEngine?.version ?? "pipeline",
        builtinToolsBrowserEnabled: skillsConfig.builtinTools.browser,
        // Opt-in gate for the memory_ask (dialectic) tool. `=== true` so an
        // absent/typo'd `dialectic` block is OFF (default-OFF byte-identity — the tool
        // is filtered out before build, no query-time-LLM surface registered).
        dialecticEnabled: agentConfig?.dialectic?.enabled === true,
        onConfigMutationStart: enterConfigMutationFence,
        onConfigMutationEnd: leaveConfigMutationFence,
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
              // Idempotency: skip when tracker already records this path at
              // the same mtime -- avoids redundant recordRead work when the
              // same admin session creates the same agent twice (e.g. create,
              // delete, re-create within one turn).
              const existing = fileStateTracker.getReadState(filePath);
              if (existing && existing.mtime === st.mtimeMs) continue;
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
        browserSanitizeImage: sanitizeImageForApi,
        browserPersistMedia: getOrCreateScreenshotPersistence(agentId),
        browserWorkspaceDir: workspaceDirs.get(agentId) ?? defaultWorkspaceDir,
      };

      // Registry-driven platform tools (45 descriptors; 4 conditional gates
      // filter out background_tasks, image_generate, unified_context, browser
      // when their predicate fails). Order is the descriptor declaration
      // order in registry.ts (alphabetical by category then by name).
      //
      // The double `.filter` is intentional: the first drops descriptors
      // whose `conditional` predicate fails; the second drops `undefined`
      // build-returns (a defensive guard -- in practice every descriptor
      // whose conditional passes returns a non-undefined AgentTool).
      type PlatformTool = ReturnType<PlatformToolProvider>[number];
      const tools: ReturnType<PlatformToolProvider> = PLATFORM_TOOL_REGISTRY
        .filter((d) => !d.conditional || d.conditional(ctx))
        .map((d) => d.build(ctx))
        .filter((t): t is PlatformTool => t !== undefined);

      // HOISTED (Phase 131) so BOTH the exec tool and the dag-gated ctx_* wiring (below) reuse
      // the ONE ALS-resolved session tool-results resolver.
      const agentWorkspaceDir = workspaceDirs.get(agentId) ?? defaultWorkspaceDir;
      const getToolResultsDir = (): string | undefined => {
        const alsCtx = tryGetContext();
        if (!alsCtx?.sessionKey) return undefined;
        const parsed = parseFormattedSessionKey(alsCtx.sessionKey);
        if (!parsed) return undefined;
        // FIX: derive the spill dir from the session DIR (sessionKeyToPath returns the .jsonl FILE path → ENOTDIR).
        return toolResultsDirFromSessionPath(sessionKeyToPath(parsed, safePath(agentWorkspaceDir, "sessions")));
      };

      // Build per-agent sandbox config from daemon provider + agent config
      const sandboxCfg: ExecSandboxConfig | undefined =
        skillsConfig.execSandbox.enabled === "always" && sandboxProvider
          ? {
              sandbox: sandboxProvider,
              sharedPaths: effectiveSharedPaths,
              readOnlyPaths,
              configReadOnlyPaths: [...skillsConfig.execSandbox.readOnlyAllowPaths, logsDir],
              warmVenvSeed: skillsConfig.execSandbox.warmVenvSeed,
              // Broker activation (undefined = open/legacy, no regression)
              network: deps.brokerContext
                ? { mode: "broker-only" as const, brokerSocketPath: deps.brokerContext.socketPath }
                : undefined,
              secureCredentialHome: deps.brokerContext ? true : undefined,
            }
          : undefined;

      if (!sandboxCfg && skillsConfig.execSandbox.enabled === "always") {
        if (warnedNoSandboxAgents.has(agentId)) {
          // Already warned for this agent at WARN level — drop to DEBUG so
          // every per-call assembly doesn't re-log the same fact.
          skillsLogger.debug(
            { agentId },
            "Exec tool running without OS sandbox (already warned at startup; per-call DEBUG)",
          );
        } else {
          skillsLogger.warn(
            { agentId, hint: "Sandbox enabled in config but no provider available -- exec tool will run without OS sandbox", errorKind: "config" as const },
            "Exec tool running without OS sandbox",
          );
          warnedNoSandboxAgents.add(agentId);
        }
      }

      // Exec tool -- always instantiated; builtinTools ceiling applied after profile filtering.
      // (agentWorkspaceDir + getToolResultsDir are HOISTED above — shared with the ctx_* wiring.)
      {
        const registry = getOrCreateRegistry(agentId);

        tools.push(createExecTool({
          workspacePath: agentWorkspaceDir,
          registry,
          secretManager,
          platformSecretNames,
          logger: skillsLogger,
          subprocessEnv,                                     // Filtered subprocess environment
          sandboxConfig: sandboxCfg,                         // Per-agent sandbox config
          eventBus,                                          // command:blocked + secret:accessed audit events
          getToolResultsDir,                                 // Session tool-results dir for output persistence
          // Live per-agent ToolCapabilityPort resolver populated by daemon.ts
          // from AgentsResult.toolCapabilityPorts map. Single mandated form
          // `deps.<field>(agentId)` mirrors the surrounding direct-deps-access
          // convention.
          toolCapabilityPort: deps.getCapabilityPortForAgent(agentId),
          approvalGate,                                      // Soft-stop override path
          // Broker proxy env — only present when brokerContext wired.
          // Issues the single-use token + builds the placeholder/CA/proxy env;
          // extracted to setup-broker-activation.ts (buildBrokerSpawnEnv).
          brokerSpawnEnv: buildBrokerSpawnEnv(deps.brokerContext, agentId),
        }));
      }

      // Process tool -- always instantiated; builtinTools ceiling applied after profile filtering
      {
        const registry = getOrCreateRegistry(agentId);
        tools.push(createProcessTool({
          registry,
          logger: skillsLogger,
          // Live per-agent ToolCapabilityPort resolver populated by daemon.ts
          // from AgentsResult.toolCapabilityPorts. Single mandated form
          // `deps.<field>(agentId)`.
          toolCapabilityPort: deps.getCapabilityPortForAgent(agentId),
        }));
      }

      // Apply patch tool -- always included, gated by tool policy
      tools.push(createApplyPatchTool(workspaceDirs.get(agentId) ?? defaultWorkspaceDir, effectiveSharedPaths, skillsLogger));

      // Terminal driver (v2.11): per-agent registry + nine never-export tools (165-07 durability
      // wired inside). wireAgentTerminalTools folds the base deps + operator config in one call.
      wireAgentTerminalTools(tools, terminalRegistries, agentId, { dataDir, skillsLogger, eventBus, sandboxProvider, approvalGate, ...terminalEgress, timers: deps.timers, agentWorkspaceDir: workspaceDirs.get(agentId) ?? defaultWorkspaceDir }, skillsConfig.terminal);

      // Context expansion tools (v2.12 Phase 131): dag-gated ctx_* wiring — gate + WR-04/WR-05 in maybeWireContextTools (file-size cap; see its doc).
      maybeWireContextTools(tools, deps.lcdStore, agentId, agentConfig, {
        skillsLogger, nowMs: systemNowMs, getToolResultsDir, eventBus,
        capabilityClassOverride: deps.getProviderCapabilityClass?.(agentConfig?.provider),
      });

      return tools;
    };

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
        // Also check TOOL_GROUPS (e.g., "web" -> ["web_fetch", "web_search", "browser"])
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

  // Tool audit event bus subscription — tools are a skills concern. Extracted to
  // setup-tool-audit.ts (file-size cap; the truncate + sanitize + DEBUG-line logic).
  setupToolAuditLogging(eventBus, skillsLogger);

  // Drain per-agent background-process registries on shutdown. Returned to the composition
  // root (daemon.ts → setupShutdown, ShutdownDeps.shutdownBackgroundProcesses) and invoked
  // directly — the prior eventBus.on("system:shutdown", ...) subscriber had zero production
  // emitters (a silent no-op); mcpClientManagerDisconnectAll is the sibling ShutdownDeps field.
  async function shutdownBackgroundProcesses(): Promise<void> {
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
  }

  // 165-07: the daemon-wide wake durability bundle spread into setupTerminalWake (built in the helper).
  const terminalDurability = buildTerminalWakeDurability({ dataDir, registries: terminalRegistries, nowMs: systemNowMs, config: agents[defaultAgentId]?.skills?.terminal as WakeDurabilityConfig | undefined });

  return {
    assembleToolsForAgent,
    preprocessMessageText,
    shutdownBackgroundProcesses,
    terminalRegistries,
    // 124-09: per-agent terminal attention config (allow-entry autoAnswer/hintPatterns + caps); read per-wake.
    getTerminalAttentionConfig: (agentId: string) =>
      deriveTerminalAttentionConfig((agents[agentId] ?? agents[defaultAgentId])?.skills?.terminal),
    // 165-07: the durable wake deps the composition root spreads into setupTerminalWake.
    terminalDurability,
  };
}
