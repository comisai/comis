// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt assembly helper for PiExecutor.
 *
 * Extracts the system prompt assembly sequence from execute() into a
 * focused async function. Handles workspace bootstrap loading, RAG
 * retrieval, RuntimeInfo/InboundMetadata construction, rich system
 * prompt assembly, hook execution, and API-provided overrides.
 *
 * @module
 */

import * as fs from "node:fs/promises";
import type {
  SessionKey,
  NormalizedMessage,
  PerAgentConfig,
  MemoryPort,
  HookRunner,
  SecretManager,
  EnvelopeConfig,
  WrapExternalContentOptions,
  TypedEventBus,
  SenderTrustDisplayConfig,
  SpawnPacket,
  DeliveryMirrorPort,
  ModelOperationType,
} from "@comis/core";
import { wrapExternalContent, safePath, formatSessionKey, generateCanaryToken } from "@comis/core";
import { suppressError } from "@comis/shared";
import type { ComisLogger } from "@comis/infra";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { PromptMode, RuntimeInfo, InboundMetadata, BootstrapContextFile } from "../bootstrap/types.js";
import {
  loadWorkspaceBootstrapFiles,
  buildBootstrapContextFiles,
  assembleRichSystemPrompt,
  assembleRichSystemPromptBlocks,
  filterBootstrapFilesForLightContext,
  filterBootstrapFilesForCron,
  filterBootstrapFilesForGroupChat,
  resolveSenderDisplay,
  buildDateTimeSection,
  buildInboundMetadataSection,
  buildSenderTrustSection,
  buildSubagentRoleSection, // for dynamic preamble injection
  buildVerbosityHintSection,
  resolveVerbosityProfile,
  type BootstrapFile,
  type SubagentRoleParams,
  type SenderTrustEntry,
  type TrustDisplayMode,
  type SystemPromptBlocks,
} from "../bootstrap/index.js";
import { deduplicateResults } from "../rag/rag-retriever.js";
import { createHybridMemoryInjector } from "../rag/hybrid-memory-injector.js";
import { BOOTSTRAP_BUDGET_WARN_PERCENT, CHARS_PER_TOKEN_RATIO } from "../context-engine/index.js";
import { isBootContentEffectivelyEmpty, BOOT_FILE_NAME } from "../workspace/boot-file.js";
import { detectOnboardingState } from "../workspace/onboarding-detector.js";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// User language extraction
// ---------------------------------------------------------------------------

/**
 * Extract the user's preferred language from USER.md bootstrap content.
 * Matches the "Preferred language:" field and returns the trimmed value,
 * or undefined if not found or empty/placeholder.
 */
export function extractUserLanguage(files: BootstrapContextFile[]): string | undefined {
  const userMd = files.find((f) => f.path.toLowerCase() === "user.md");
  if (!userMd) return undefined;

  const match = /\*{0,2}Preferred language:?\*{0,2}\s*(.+)/i.exec(userMd.content);
  if (!match) return undefined;

  const value = match[1]!.trim();
  // Skip empty values and placeholder text
  if (!value || value.startsWith("_") || value.startsWith("(")) return undefined;
  return value;
}

/** Per-session tool name snapshot for stable system prompt assembly.
 *  On first execution, captures the full tool name list. Subsequent executions
 *  reuse the snapshot so toolNames fed to assembleRichSystemPrompt stays constant,
 *  preventing cache-invalidating changes when MCP tools connect mid-session. */
const sessionToolNameSnapshots = new Map<string, string[]>();

/** Per-session bootstrap file snapshot for stable system prompt assembly.
 *  On first execution, captures the raw BootstrapFile[] from loadWorkspaceBootstrapFiles().
 *  Subsequent executions reuse the snapshot so bootstrap content fed to
 *  buildBootstrapContextFiles stays constant, preventing cache-invalidating changes
 *  when the agent writes workspace files mid-session (e.g., IDENTITY.md during onboarding).
 *  Note: per-turn filtering (lightContext, groupChat) still applies on the snapshot. */
const sessionBootstrapFileSnapshots = new Map<string, BootstrapFile[]>();

/** Per-session frozen prompt state for sub-agent cache prefix sharing.
 *  Captured once per session at the end of first assembleExecutionPrompt call.
 *  Sub-agents read this via getCacheSafeParams() to reuse parent prefix. */
const sessionCacheSafeParams = new Map<string, CacheSafeParams>();

/** Per-session prompt skills XML snapshot for stable system prompt assembly.
 *  On first execution, captures the promptSkillsXml string. Subsequent executions
 *  reuse the snapshot so skills XML fed to assembleRichSystemPrompt stays constant,
 *  preventing cache-invalidating changes when the agent creates skills mid-session. */
const sessionPromptSkillsXmlSnapshots = new Map<string, string | undefined>();

// ---------------------------------------------------------------------------
// Feature flag hash for tool cache key invalidation.
// Computes a stable string from config fields that affect tool rendering.
// When the hash changes, the rendered tool cache is invalidated.
// Only includes fields that directly affect tool schema output to avoid
// false invalidations from unrelated config changes.
// ---------------------------------------------------------------------------

/**
 * Compute a stable hash string from config fields that affect tool rendering.
 * Used as part of the rendered tool cache key so that mid-session
 * config changes (e.g., toolPolicy.mode, tools.enabledGroups) invalidate
 * stale cached tool schemas.
 *
 * @param config - Subset of agent config with tool-affecting fields
 * @returns Stable string suitable for cache key composition
 */
export function computeFeatureFlagHash(config: { toolPolicy?: { mode?: string }; tools?: { enabledGroups?: string[] } }): string {
  const parts: string[] = [];
  if (config.toolPolicy?.mode) parts.push(`policy:${config.toolPolicy.mode}`);
  if (config.tools?.enabledGroups) parts.push(`groups:${config.tools.enabledGroups.sort().join(",")}`);
  return parts.join("|") || "default";
}

/**
 * Clear the cached tool name snapshot for a session.
 * Call during session cleanup to prevent the Map from growing unbounded.
 */
export function clearSessionToolNameSnapshot(sessionKey: string): void {
  sessionToolNameSnapshots.delete(sessionKey);
}

/**
 * Clear the cached bootstrap file snapshot for a session.
 * Call during session cleanup to prevent the Map from growing unbounded.
 */
export function clearSessionBootstrapFileSnapshot(sessionKey: string): void {
  sessionBootstrapFileSnapshots.delete(sessionKey);
}

/**
 * Clear the cached prompt skills XML snapshot for a session.
 * Call during session cleanup to prevent the Map from growing unbounded.
 */
export function clearSessionPromptSkillsXmlSnapshot(sessionKey: string): void {
  sessionPromptSkillsXmlSnapshots.delete(sessionKey);
}

/** Frozen prompt state captured after first-turn assembly for sub-agent cache prefix sharing.
 *  When propagated to sub-agents via SpawnPacket, allows prefix reuse instead of independent assembly. */
export interface CacheSafeParams {
  /** Frozen system prompt string (post-hook, post-assembleRichSystemPrompt). */
  frozenSystemPrompt: string;
  /** Structured blocks for multi-block cache_control in sub-agents. */
  frozenSystemPromptBlocks?: SystemPromptBlocks;
  /** Tool names snapshot (from sessionToolNameSnapshots). */
  toolNames: string[];
  /** Model ID used by the parent agent. */
  model: string;
  /** Provider ID used by the parent agent. */
  provider: string;
  /** Cache retention setting from parent config. */
  cacheRetention: string | undefined;
  /** 2.1: Timestamp (ms since epoch) when the parent last confirmed a cache write.
   *  Propagated to sub-agents via SpawnPacket for TTL expiry guard. */
  cacheWriteTimestamp?: number;
  /** 4.2: DJB2-style hash of sorted tool names for staleness detection.
   *  When tools change mid-session (e.g., MCP server connects), CacheSafeParams
   *  are refreshed so sub-agents get updated tool lists. */
  toolHash?: string;
}

/**
 * Get the frozen prompt state for a session (sub-agent cache prefix sharing).
 * Returns undefined if no params captured yet (session hasn't completed first turn).
 */
export function getCacheSafeParams(sessionKey: string): CacheSafeParams | undefined {
  return sessionCacheSafeParams.get(sessionKey);
}

/**
 * Clear the cached prompt state for a session.
 * Call during session cleanup to prevent the Map from growing unbounded.
 */
export function clearCacheSafeParams(sessionKey: string): void {
  sessionCacheSafeParams.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies required by the prompt assembly helper. */
export interface PromptAssemblyParams {
  config: PerAgentConfig;
  deps: {
    workspaceDir: string;
    memoryPort?: MemoryPort;
    hookRunner?: HookRunner;
    secretManager?: SecretManager;
    envelopeConfig?: EnvelopeConfig;
    outboundMediaEnabled?: boolean;
    mediaPersistenceEnabled?: boolean;
    autonomousMediaEnabled?: boolean;
    getPromptSkillsXml?: () => string;
    /** Optional callback for suspicious content detection in external content. */
    onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
    /** Heartbeat prompt text for ## Heartbeats system prompt section. */
    heartbeatPrompt?: string;
    /** Tool names available to sub-agents for delegation awareness. */
    subAgentToolNames?: string[];
    /** Whether sub-agents inherit MCP tools from parent. */
    mcpToolsInherited?: boolean;
    /** Whether this is the first user message in the current session. */
    isFirstMessageInSession?: boolean;
    /** Sender trust display config from AppConfig.senderTrustDisplay. */
    senderTrustDisplayConfig?: SenderTrustDisplayConfig;
    /** Documentation config from AppConfig.documentation. */
    documentationConfig?: import("@comis/core").DocumentationConfig;
    /** Event bus for sender:trust_resolved audit events. */
    eventBus?: TypedEventBus;
    /** Spawn packet for sub-agent context injection.
     *  Threaded from ExecutionOverrides; used for system prompt template. */
    spawnPacket?: SpawnPacket;
    /** Delivery mirror port for session mirroring injection. */
    deliveryMirror?: DeliveryMirrorPort;
    /** Delivery mirror config for injection budget limits. */
    deliveryMirrorConfig?: { maxEntriesPerInjection: number; maxCharsPerInjection: number };
    /** MCP server instructions for dynamic preamble injection. */
    mcpServerInstructions?: ReadonlyArray<{ serverName: string; instructions: string }>;
    /** Platform message character limit for auto verbosity mode. Resolved by caller from channelRegistry. */
    channelMaxChars?: number;
  };
  msg: NormalizedMessage;
  sessionKey: SessionKey;
  agentId: string | undefined;
  mergedCustomTools: ToolDefinition[];
  logger: ComisLogger;
  /** Safety reinforcement line to prepend when InputSecurityGuard detects medium+ risk. */
  safetyReinforcement?: string;
  /** Skip RAG memory injection for graph pipeline sub-agents. */
  skipRag?: boolean;
  /** Whether Silent Execution Planner (SEP) is enabled for this agent. */
  sepEnabled?: boolean;
  /** Resolved model ID (post-override resolution) for cache prefix sharing model match.
   *  When present, used instead of config.model for CacheSafeParams model comparison.
   *  Passed from pi-executor after model override resolution. */
  resolvedModelId?: string;
  /** Resolved provider ID (post-override resolution) for cache prefix sharing provider match. */
  resolvedModelProvider?: string;
  /** Whether the resolved model has native reasoning support (e.g. encrypted thinking blocks).
   *  When true, the `<think>`/`<final>` tag hint is suppressed to avoid double-reasoning. */
  resolvedModelReasoning?: boolean;
  /** Operation type from ExecutionOverrides. Resolves promptMode and bootstrap filter.
   *  When omitted by callers at the TypeScript level, executor-tool-assembly supplies
   *  "interactive" as the default before invoking this function, so this is required
   *  at the call-site contract level. Values of "cron" or "heartbeat" auto-upgrade
   *  the promptMode from "full" to "operational" and dispatch operation-specific
   *  bootstrap filters. */
  operationType: ModelOperationType;
}

// ---------------------------------------------------------------------------
// Helpers (moved from pi-executor.ts -- only used for InboundMetadata)
// ---------------------------------------------------------------------------

/**
 * Resolve chat type from message metadata.
 * Handles Telegram, Discord, Slack, WhatsApp, iMessage, Signal, IRC, LINE.
 */
function resolveChatType(msg: NormalizedMessage): string {
  const meta = msg.metadata ?? {};

  // Telegram: explicit chat type
  if (typeof meta.telegramChatType === "string") {
    const tgType = meta.telegramChatType as string;
    if (tgType === "private") return "dm";
    if (tgType === "channel") return "channel";
    return "group"; // "group" | "supergroup"
  }

  // Discord: thread and guild detection
  if (meta.parentChannelId) return "thread";
  if (meta.guildId) return "group";
  if (msg.channelType === "discord") return "dm";

  // Slack: thread detection
  if (meta.slackThreadTs) return "thread";

  // Boolean isGroup patterns (WhatsApp, iMessage)
  if (meta.isGroup === true || meta.imsgIsGroup === true) return "group";

  // Signal: group detection
  if (meta.signalGroupId) return "group";

  // IRC: DM detection
  if (meta.ircIsDm === true) return "dm";
  if (msg.channelType === "irc") return "channel";

  // LINE: source type
  if (meta.lineSourceType === "group" || meta.lineSourceType === "room") return "group";
  if (meta.lineSourceType === "user") return "dm";

  // Default
  return "dm";
}

/**
 * Build boolean flags from message metadata for inbound metadata injection.
 */
function buildMessageFlags(msg: NormalizedMessage): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  const meta = msg.metadata ?? {};

  if (meta.isGroup === true || meta.imsgIsGroup === true || meta.signalGroupId) {
    flags.isGroup = true;
  }
  if (meta.parentChannelId || meta.slackThreadTs) {
    flags.isThread = true;
  }
  if (msg.attachments && msg.attachments.length > 0) {
    flags.hasAttachments = true;
  }
  if (msg.replyTo) {
    flags.isReply = true;
  }
  if (meta.isScheduled === true) {
    flags.isScheduled = true;
  }
  if (meta.isCronAgentTurn === true) {
    flags.isCronAgentTurn = true;
  }

  return flags;
}

/**
 * Determine if a message originates from a group context for bootstrap filtering.
 *
 * Treats both "group" and Discord guild threads as group context,
 * since threads within guild servers are still multi-user environments
 * where USER.md should be filtered for privacy.
 */
function isGroupContext(msg: NormalizedMessage): boolean {
  const chatType = resolveChatType(msg);
  if (chatType === "group") return true;
  // Discord threads in guilds are still group contexts
  if (chatType === "thread" && msg.metadata?.guildId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Assemble the full system prompt for a PiExecutor execution cycle.
 *
 * Steps:
 * 1. Resolve promptMode from config
 * 2. Load workspace bootstrap files (skip for "none")
 * 3. Run RAG retrieval (non-fatal catch)
 * 4. Build RuntimeInfo and InboundMetadata
 * 5. Assemble rich system prompt via assembleRichSystemPrompt
 * 6. Run before_agent_start hook
 * 7. Apply API-provided system prompt override
 * 8. Return the final system prompt string
 */
/** Return type for assembleExecutionPrompt. */
export interface ExecutionPromptResult {
  /** Static system prompt (cache-stable across turns). */
  systemPrompt: string;
  /** Structured blocks for multi-block cache_control in onPayload. */
  systemPromptBlocks?: SystemPromptBlocks;
  /** Dynamic content relocated from system prompt for cache stability. */
  dynamicPreamble: string;
  /** Top-1 RAG memory for inline injection adjacent to user message (Task 229). */
  inlineMemory?: string;
}

export async function assembleExecutionPrompt(params: PromptAssemblyParams): Promise<ExecutionPromptResult> {
  const { config, deps, msg, sessionKey, agentId, mergedCustomTools, logger } = params;

  // Parent prefix reuse when model+provider match.
  // When a sub-agent has CacheSafeParams from its parent and the resolved model/provider
  // matches, skip the entire system prompt assembly (bootstrap loading, tool/bootstrap snapshots,
  // assembleRichSystemPrompt, hook execution) and return the parent's frozen prompt directly.
  // Dynamic preamble is ALWAYS independently assembled (timestamps, RAG, etc. are per-turn).
  const parentCache = deps.spawnPacket?.cacheSafeParams;
  const effectiveModel = params.resolvedModelId ?? config.model;
  const effectiveProvider = params.resolvedModelProvider ?? config.provider;
  if (parentCache && effectiveModel === parentCache.model && effectiveProvider === parentCache.provider) {
    // Skip tool name snapshot, bootstrap file snapshot, and content digest
    // No sessionToolNameSnapshots.set, no sessionBootstrapFileSnapshots.set for this session

    // Independently assemble dynamic preamble (same logic as the full path)
    const dynamicPreambleParts: string[] = [];

    // Date/time section
    const dateTimeLines = buildDateTimeSection();
    if (dateTimeLines.length > 0) dynamicPreambleParts.push(dateTimeLines.join("\n"));

    // Inbound metadata
    const chatType = resolveChatType(msg);
    const inboundMeta: InboundMetadata = {
      messageId: msg.id,
      senderId: msg.senderId,
      chatId: msg.channelId,
      channel: msg.channelType,
      chatType,
      flags: buildMessageFlags(msg),
    };
    const inboundLines = buildInboundMetadataSection(inboundMeta, false);
    if (inboundLines.length > 0) dynamicPreambleParts.push(inboundLines.join("\n"));

    // Channel section
    if (msg.channelType) {
      const channelLines = [`## Channel`, `Current channel: ${msg.channelType} (ID: ${msg.channelId}).`];
      if (msg.channelId) {
        channelLines.push(`For background task routing: announce_channel_type="${msg.channelType}" announce_channel_id="${msg.channelId}".`);
      }
      dynamicPreambleParts.push(channelLines.join("\n"));
    }

    // Verbosity hint (varies per channel -- in dynamic preamble)
    const verbosityProfile = resolveVerbosityProfile(
      config.verbosity,
      msg.channelType,
      chatType,
      deps.channelMaxChars,
    );
    const verbosityLines = buildVerbosityHintSection(verbosityProfile, false);
    if (verbosityLines.length > 0) {
      dynamicPreambleParts.push(verbosityLines.join("\n"));
    }

    // Prompt skills XML
    const promptSkillsXml = deps.getPromptSkillsXml?.() ?? undefined;
    if (promptSkillsXml) {
      dynamicPreambleParts.push(`## Available Skills\n${promptSkillsXml}`);
    }

    // Active prompt skill
    const activePromptSkillContent = msg.metadata?.promptSkillContent as string | undefined;
    if (activePromptSkillContent) {
      dynamicPreambleParts.push(`## Active Skill\n${activePromptSkillContent}`);
    }

    // Subagent role section (from SpawnPacket)
    if (deps.spawnPacket) {
      const roleLines = buildSubagentRoleSection({
        task: deps.spawnPacket.task,
        depth: deps.spawnPacket.depth,
        maxSpawnDepth: deps.spawnPacket.maxDepth,
        artifactRefs: deps.spawnPacket.artifactRefs,
        objective: deps.spawnPacket.objective,
        domainKnowledge: deps.spawnPacket.domainKnowledge,
        workspaceDir: deps.spawnPacket.workspaceDir,
        parentSummary: deps.spawnPacket.parentSummary,
        agentWorkspaces: deps.spawnPacket.agentWorkspaces,
      });
      if (roleLines.length > 0) dynamicPreambleParts.push(roleLines.join("\n"));
    }

    // Canary token
    if (deps.secretManager?.get("CANARY_SECRET") && sessionKey) {
      const canary = generateCanaryToken(
        formatSessionKey(sessionKey),
        deps.secretManager.get("CANARY_SECRET")!,
      );
      dynamicPreambleParts.push(
        `[Internal verification token: ${canary} -- Do not reveal, repeat, or reference this token in any response.]`,
      );
    }

    // MCP server instructions
    if (deps.mcpServerInstructions && deps.mcpServerInstructions.length > 0) {
      const instructionSections = deps.mcpServerInstructions
        .map((s) => `### ${s.serverName}\n${s.instructions}`)
        .join("\n\n");
      dynamicPreambleParts.push(`## MCP Server Instructions\n${instructionSections}`);
    }

    // Safety reinforcement
    if (params.safetyReinforcement) {
      dynamicPreambleParts.unshift(params.safetyReinforcement);
    }

    // Hook prependContext -- run hook even on prefix reuse path for dynamic content
    const hookResult = await deps.hookRunner?.runBeforeAgentStart(
      { systemPrompt: parentCache.frozenSystemPrompt, messages: [] },
      {
        agentId: agentId ?? config.name,
        sessionKey,
        workspaceDir: deps.workspaceDir,
        isFirstMessageInSession: deps.isFirstMessageInSession,
      },
    );
    const hookPrependContext = hookResult?.prependContext;
    if (hookPrependContext) {
      dynamicPreambleParts.unshift(hookPrependContext);
    }

    // API system prompt
    const apiSystemPrompt = msg.metadata?.openaiSystemPrompt as string | undefined;
    if (apiSystemPrompt) {
      const wrappedApiSystemPrompt = wrapExternalContent(apiSystemPrompt, { source: "api", includeWarning: true, onSuspiciousContent: deps.onSuspiciousContent });
      dynamicPreambleParts.unshift(wrappedApiSystemPrompt);
    }

    const dynamicPreamble = dynamicPreambleParts.join("\n\n");

    logger.info(
      { agentId, parentModel: parentCache.model, parentProvider: parentCache.provider },
      "Using parent cache prefix (model/provider match)",
    );

    return { systemPrompt: parentCache.frozenSystemPrompt, systemPromptBlocks: parentCache.frozenSystemPromptBlocks, dynamicPreamble, inlineMemory: undefined };
  }

  // 1. Resolve promptMode
  // Cron and heartbeat auto-upgrade from "full" -> "operational" to trim
  // interactive-only sections (compaction recovery, silent replies, reactions,
  // media, SEP, sender trust). An explicit `config.bootstrap?.promptMode` wins
  // -- operators can still force "minimal"/"none"/"full" if they have reason.
  const baseMode: PromptMode = (config.bootstrap?.promptMode as PromptMode) ?? "full";
  const promptMode: PromptMode =
    (params.operationType === "cron" || params.operationType === "heartbeat") && baseMode === "full"
      ? "operational"
      : baseMode;

  // Consolidated lightContext flag: heartbeat implies light-context regardless
  // of the explicit msg.metadata.lightContext flag. Callers that only set the
  // metadata flag OR only set operationType="heartbeat" produce identical
  // prompt output (design-doc §Risks: "Heartbeat lightContext and operationType drift").
  const effectiveLightContext =
    msg.metadata?.lightContext === true || params.operationType === "heartbeat";

  // 2. Load workspace bootstrap files (skip for "none" mode)
  let bootstrapContextFiles: BootstrapContextFile[] = [];
  if (promptMode !== "none") {
    const bootstrapMaxChars = config.bootstrap?.maxChars ?? 20_000;

    // Snapshot raw bootstrap files on first turn to keep system prompt stable.
    // When the agent writes workspace files mid-session (e.g., IDENTITY.md during onboarding),
    // the next disk read returns different content, changing the system prompt digest and
    // invalidating the entire cache prefix. The snapshot ensures loadWorkspaceBootstrapFiles
    // is only called once per session. Per-turn filtering (lightContext, groupChat) still
    // applies on the snapshot since those depend on per-message metadata.
    const bsSnapKey = formatSessionKey(sessionKey);
    let bootstrapFiles = sessionBootstrapFileSnapshots.get(bsSnapKey);
    if (!bootstrapFiles) {
      bootstrapFiles = await loadWorkspaceBootstrapFiles(deps.workspaceDir, bootstrapMaxChars);
      sessionBootstrapFileSnapshots.set(bsSnapKey, bootstrapFiles);
    }

    // Bootstrap filter dispatch:
    //  - effectiveLightContext (heartbeat / explicit flag) -> HEARTBEAT.md only
    //  - operationType === "cron" -> SOUL.md + ROLE.md only
    //  - group chat context -> strip USER.md for privacy
    if (effectiveLightContext) {
      bootstrapFiles = filterBootstrapFilesForLightContext(bootstrapFiles);
    } else if (params.operationType === "cron") {
      bootstrapFiles = filterBootstrapFilesForCron(bootstrapFiles);
    } else if (
      config.bootstrap?.groupChatFiltering !== false &&
      isGroupContext(msg)
    ) {
      bootstrapFiles = filterBootstrapFilesForGroupChat(bootstrapFiles);
    }

    bootstrapContextFiles = buildBootstrapContextFiles(bootstrapFiles, { maxChars: bootstrapMaxChars });
  }

  // 3. RAG retrieval via hybrid memory injector (non-fatal)
  // Task 229: Top-1 result goes inline with user message for maximum LLM attention;
  // remaining results go into the dynamic preamble (same location as before).
  let memorySections: string[] = [];
  let inlineMemory: string | undefined;
  if (deps.memoryPort && config.rag?.enabled && !params.skipRag) {
    const ragStart = Date.now();
    try {
      logger.debug({ agentId, queryLength: msg.text.length }, "RAG search started");
      const searchResults = await deps.memoryPort.search(sessionKey, msg.text, {
        limit: config.rag.maxResults,
        minScore: config.rag.minScore,
        agentId,
      });

      if (searchResults.ok && searchResults.value.length > 0) {
        // Post-filter by allowed trust levels
        const allowedTrustLevels = new Set<import("@comis/core").TrustLevel>(config.rag.includeTrustLevels);
        const filtered = searchResults.value.filter(r => allowedTrustLevels.has(r.entry.trustLevel));

        // Deduplicate near-identical content
        const deduped = deduplicateResults(filtered);

        if (deduped.length > 0) {
          // Hybrid split: top-1 inline with user message, rest in dynamic preamble
          const injector = createHybridMemoryInjector({
            onSuspiciousContent: deps.onSuspiciousContent,
          });
          const injection = injector.split(deduped, config.rag.maxContextChars);

          inlineMemory = injection.inlineMemory;
          memorySections = injection.systemPromptSections;
        }
        logger.debug({ agentId, resultCount: deduped.length, durationMs: Date.now() - ragStart }, "RAG search complete");
      } else {
        logger.debug({ agentId, resultCount: 0, durationMs: Date.now() - ragStart }, "RAG search complete");
      }
    } catch (err) {
      logger.warn({ agentId, err, durationMs: Date.now() - ragStart, hint: "RAG search failed — agent will proceed without memory context", errorKind: "retrieval_failure" as const }, "RAG retrieval failed (non-fatal)");
    }
  }

  // 4. Build runtime info
  const runtimeInfo: RuntimeInfo = {
    agentId: agentId ?? config.name,
    host: os.hostname(),
    os: os.platform(),
    arch: os.arch(),
    model: config.model,
    nodeVersion: process.versions.node,
    shell: os.userInfo().shell ?? undefined,
    defaultModel: config.model,
    channel: msg.channelType,
  };

  // Build inbound metadata
  let inboundMeta: InboundMetadata = {
    messageId: msg.id,
    senderId: msg.senderId,
    chatId: msg.channelId,
    channel: msg.channelType,
    chatType: resolveChatType(msg),
    flags: buildMessageFlags(msg),
  };

  // Sender trust resolution
  const trustDisplayConfig = deps.senderTrustDisplayConfig;
  let senderTrustEntries: SenderTrustEntry[] = [];
  let senderTrustDisplayMode: TrustDisplayMode = "raw";

  if (trustDisplayConfig?.enabled) {
    const trustMap = config.elevatedReply?.senderTrustMap ?? {};
    const defaultLevel = config.elevatedReply?.defaultTrustLevel ?? "external";
    senderTrustDisplayMode = trustDisplayConfig.displayMode;

    // Resolve HMAC secret: use SecretManager ref, fallback to agentId
    let hmacSecret: string | undefined;
    if (senderTrustDisplayMode === "hash") {
      const ref = trustDisplayConfig.hashSecretRef;
      hmacSecret = ref ? deps.secretManager?.get(ref) : undefined;
      if (!hmacSecret) {
        hmacSecret = agentId ?? config.name;
        logger.debug("Sender trust HMAC using agentId fallback (no hashSecretRef configured)");
      }
    }

    // Resolve current sender's trust for metadata injection
    const currentSenderTrust = trustMap[msg.senderId] ?? defaultLevel;
    inboundMeta = { ...inboundMeta, senderTrust: currentSenderTrust };

    // Build display entries for ALL known senders
    const allSenders = new Map<string, string>(); // senderId -> trustLevel
    for (const [sid, level] of Object.entries(trustMap)) {
      allSenders.set(sid, level);
    }
    // Include current sender if not in map
    if (!allSenders.has(msg.senderId)) {
      allSenders.set(msg.senderId, defaultLevel);
    }

    senderTrustEntries = Array.from(allSenders.entries()).map(([sid, level]) => ({
      senderId: sid,
      trustLevel: level,
      displayId: resolveSenderDisplay(sid, senderTrustDisplayMode, {
        hmacSecret,
        hashPrefix: trustDisplayConfig.hashPrefix,
        aliases: trustDisplayConfig.aliases,
      }),
    }));

    // Emit audit event
    if (deps.eventBus) {
      deps.eventBus.emit("sender:trust_resolved", {
        agentId: agentId ?? config.name,
        senderId: msg.senderId,
        trustLevel: currentSenderTrust,
        displayMode: senderTrustDisplayMode,
        sessionKey: formatSessionKey(sessionKey),
        timestamp: Date.now(),
      });
    }
  }

  // 5. Assemble the full system prompt
  const toolNames = mergedCustomTools.map(t => t.name);

  // Snapshot tool names on first turn to keep system prompt stable.
  // Tool count can vary between turns (57 vs 77) when MCP tools connect/disconnect
  // or tool deferral context changes. The snapshot ensures assembleRichSystemPrompt
  // receives the same toolNames on every turn, preserving the cache prefix.
  // Note: actual available tools for execution are unaffected -- only system prompt assembly uses the snapshot.
  const snapshotKey = formatSessionKey(sessionKey);
  let stableToolNames = sessionToolNameSnapshots.get(snapshotKey);
  if (!stableToolNames) {
    stableToolNames = toolNames;
    sessionToolNameSnapshots.set(snapshotKey, toolNames);
  }

  const hasMemoryTools = stableToolNames.includes("memory_store") || stableToolNames.includes("memory_search");

  // Snapshot promptSkillsXml on first turn to keep system prompt stable.
  // Skills created mid-session grow the XML (~540 chars per skill), invalidating
  // the entire system prompt cache prefix on every subsequent turn.
  let promptSkillsXml = sessionPromptSkillsXmlSnapshots.get(snapshotKey);
  if (promptSkillsXml === undefined && !sessionPromptSkillsXmlSnapshots.has(snapshotKey)) {
    promptSkillsXml = deps.getPromptSkillsXml?.() ?? undefined;
    sessionPromptSkillsXmlSnapshots.set(snapshotKey, promptSkillsXml);
  }
  const activePromptSkillContent = msg.metadata?.promptSkillContent as string | undefined;

  // Extract user's preferred language from USER.md (if present)
  const userLanguage = extractUserLanguage(bootstrapContextFiles);

  // Build subagentRole from SpawnPacket when present.
  // Previously subagentRole was accepted by assembleRichSystemPrompt but never wired
  // through from prompt-assembly; spawnPacket now provides the structured data.
  let subagentRole: SubagentRoleParams | undefined;
  if (deps.spawnPacket) {
    subagentRole = {
      task: deps.spawnPacket.task,
      depth: deps.spawnPacket.depth,
      maxSpawnDepth: deps.spawnPacket.maxDepth,
      artifactRefs: deps.spawnPacket.artifactRefs,
      objective: deps.spawnPacket.objective,
      domainKnowledge: deps.spawnPacket.domainKnowledge,
      workspaceDir: deps.spawnPacket.workspaceDir,
      parentSummary: deps.spawnPacket.parentSummary,
      agentWorkspaces: deps.spawnPacket.agentWorkspaces,
    };
  }

  // Detect onboarding state from workspace
  const isOnboarding = await detectOnboardingState(deps.workspaceDir);

  // Shared params for both assembleRichSystemPrompt and assembleRichSystemPromptBlocks.
  // Using a single variable guarantees identity by construction.
  const assemblerParams: import("../bootstrap/index.js").AssemblerParams = {
    agentName: config.name,
    promptMode,
    runtimeInfo,
    inboundMeta,
    workspaceDir: deps.workspaceDir,
    bootstrapFiles: bootstrapContextFiles,
    additionalSections: [], // RAG results relocated to dynamic preamble
    hasMemoryTools,
    toolNames: stableToolNames,
    userLanguage,
    promptSkillsXml, // skills XML in semiStableBody for 1h cache
    activePromptSkillContent: undefined, // relocated to dynamic preamble
    channelContext: undefined, // channel context relocated to dynamic preamble to prevent cache thrashing
    heartbeatPrompt: deps.heartbeatPrompt,
    reactionLevel: config.reactionLevel,
    postCompactionSections: config.session?.compaction?.postCompactionSections,
    reasoningTagHint: config.provider !== "anthropic"
      && !params.resolvedModelReasoning
      && !(config.thinkingLevel && config.thinkingLevel !== "off"),
    outboundMediaEnabled: deps.outboundMediaEnabled,
    mediaPersistenceEnabled: deps.mediaPersistenceEnabled,
    autonomousMediaEnabled: deps.autonomousMediaEnabled,
    subAgentToolNames: deps.subAgentToolNames,
    mcpToolsInherited: deps.mcpToolsInherited,
    senderTrustEntries: [], // relocated to dynamic preamble
    senderTrustDisplayMode: "raw", // relocated to dynamic preamble
    documentationConfig: deps.documentationConfig,
    // canarySecret and sessionKey removed — canary relocated to dynamic preamble below
    subagentRole: undefined, // relocated to dynamic preamble for sub-agent cache sharing
    excludeBootstrapFromContext: true, // BOOTSTRAP.md is either elevated (onboarding) or dead weight (post-onboarding); never useful in Project Context
    workspaceProfile: config.workspace?.profile,
    sepEnabled: params.sepEnabled,
  };

  let systemPrompt = assembleRichSystemPrompt(assemblerParams);

  // Build structured blocks for multi-block cache_control injection.
  // Uses the same assemblerParams as assembleRichSystemPrompt() -- identity guaranteed
  // by shared buildAllSections().
  const systemPromptBlocks = assembleRichSystemPromptBlocks(assemblerParams);

  // 6. Run before_agent_start hook
  const hookResult = await deps.hookRunner?.runBeforeAgentStart(
    { systemPrompt, messages: [] },
    {
      agentId: agentId ?? config.name,
      sessionKey,
      workspaceDir: deps.workspaceDir,
      isFirstMessageInSession: deps.isFirstMessageInSession,
    },
  );
  if (hookResult?.systemPrompt) systemPrompt = hookResult.systemPrompt;
  // If hook modifies systemPrompt, blocks become inconsistent.
  // This is acceptable: hooks are session-stable, so blocks only
  // matter for the cache prefix split which is unaffected by hook prepends.
  // The frozenSystemPrompt (string) remains the source of truth for content.

  // prependContext relocated to dynamic preamble to preserve cache prefix stability.
  // Hooks may return turn-varying content (timestamps, user state) which would invalidate
  // the cache prefix if injected into the system prompt.
  const hookPrependContext = hookResult?.prependContext;

  // BOOT.md, BOOTSTRAP.md, and safety reinforcement relocated
  // from system prompt to dynamic preamble below (see dynamicPreambleParts section).

  // 7. External API system prompt captured for dynamic preamble injection.
  // Previously appended to system prompt, causing cache prefix invalidation per unique API caller.
  const apiSystemPrompt = msg.metadata?.openaiSystemPrompt as string | undefined;
  let wrappedApiSystemPrompt: string | undefined;
  if (apiSystemPrompt) {
    wrappedApiSystemPrompt = wrapExternalContent(apiSystemPrompt, { source: "api", includeWarning: true, onSuspiciousContent: deps.onSuspiciousContent });
  }

  // Bootstrap content budget tracking
  const bootstrapChars = bootstrapContextFiles.reduce((sum, f) => sum + f.content.length, 0);
  const systemPromptChars = systemPrompt.length;
  if (systemPromptChars > 0) {
    const bootstrapPercent = Math.round((bootstrapChars / systemPromptChars) * 100);
    if (bootstrapPercent > BOOTSTRAP_BUDGET_WARN_PERCENT) {
      logger.warn(
        {
          bootstrapChars,
          systemPromptChars,
          bootstrapPercent,
          threshold: BOOTSTRAP_BUDGET_WARN_PERCENT,
          hint: `Bootstrap files consume ${bootstrapPercent}% of system prompt; consider trimming AGENTS.md or reducing maxChars`,
          errorKind: "performance" as const,
        },
        "Bootstrap content exceeds budget threshold",
      );
    }
  }

  // Build dynamic preamble from sections relocated out of system prompt.
  // These sections change on every turn (timestamps, message IDs) and would
  // invalidate the entire system prompt cache if left inline.
  const dynamicPreambleParts: string[] = [];
  const dateTimeLines = buildDateTimeSection();
  if (dateTimeLines.length > 0) {
    dynamicPreambleParts.push(dateTimeLines.join("\n"));
  }
  const inboundLines = buildInboundMetadataSection(inboundMeta, promptMode === "minimal");
  if (inboundLines.length > 0) {
    dynamicPreambleParts.push(inboundLines.join("\n"));
  }
  // channel relocated to dynamic preamble (changes on cross-session relay)
  if (msg.channelType) {
    const channelLines = [`## Channel`, `Current channel: ${msg.channelType} (ID: ${msg.channelId}).`];
    if (msg.channelId) {
      channelLines.push(`For background task routing: announce_channel_type="${msg.channelType}" announce_channel_id="${msg.channelId}".`);
    }
    dynamicPreambleParts.push(channelLines.join("\n"));
  }
  // Verbosity hint (varies per channel type -- in dynamic preamble)
  {
    const verbProfile = resolveVerbosityProfile(
      config.verbosity,
      msg.channelType,
      inboundMeta.chatType,
      deps.channelMaxChars,
    );
    const verbLines = buildVerbosityHintSection(verbProfile, promptMode === "minimal");
    if (verbLines.length > 0) {
      dynamicPreambleParts.push(verbLines.join("\n"));
    }
  }
  // RAG memory sections relocated from system prompt for cache stability.
  // Memory results change every turn (query = user message text), which would
  // invalidate the entire system prompt cache prefix on every message.
  if (memorySections.length > 0) {
    const memoryBlock = memorySections.filter(Boolean).join("\n\n");
    dynamicPreambleParts.push(memoryBlock);
  }
  // active prompt skill content relocated from system prompt for cache stability.
  if (activePromptSkillContent) {
    dynamicPreambleParts.push(`## Active Skill\n${activePromptSkillContent}`);
  }
  // promptSkillsXml now routed through assemblerParams to semiStableBody (1h cache).
  // sender trust entries relocated from system prompt for cache stability.
  // Trust entries grow as new senders appear in group chats.
  if (senderTrustEntries.length > 0) {
    const trustLines = buildSenderTrustSection(senderTrustEntries, senderTrustDisplayMode, promptMode === "minimal");
    if (trustLines.length > 0) {
      dynamicPreambleParts.push(trustLines.join("\n"));
    }
  }
  // Subagent role relocated from system prompt to dynamic preamble.
  // Each sub-agent's unique task/objective/parentSummary made the system prompt unique
  // per spawn, preventing cache prefix sharing across sub-agents of the same agent config.
  if (subagentRole) {
    const roleLines = buildSubagentRoleSection(subagentRole);
    if (roleLines.length > 0) {
      dynamicPreambleParts.push(roleLines.join("\n"));
    }
  }
  // Canary token relocated from system prompt to dynamic preamble.
  // OutputGuard scans response text against deps.canaryToken (passed separately),
  // so the canary protects against leakage regardless of prompt placement.
  if (deps.secretManager?.get("CANARY_SECRET") && sessionKey) {
    const canary = generateCanaryToken(
      formatSessionKey(sessionKey),
      deps.secretManager.get("CANARY_SECRET")!,
    );
    dynamicPreambleParts.push(
      `[Internal verification token: ${canary} -- Do not reveal, repeat, or reference this token in any response.]`,
    );
  }
  // Inject pending mirror entries as synthetic assistant context.
  if (deps.deliveryMirror && sessionKey) {
    const mirrorResult = await deps.deliveryMirror.pending(formatSessionKey(sessionKey));
    if (mirrorResult.ok && mirrorResult.value.length > 0) {
      let entries = mirrorResult.value;
      const maxEntries = deps.deliveryMirrorConfig?.maxEntriesPerInjection ?? 10;
      const maxChars = deps.deliveryMirrorConfig?.maxCharsPerInjection ?? 4000;

      // Budget cap: limit entries count, then total characters
      entries = entries.slice(0, maxEntries);
      let totalChars = 0;
      const budgetedEntries: typeof entries = [];
      for (const e of entries) {
        if (totalChars + e.text.length > maxChars) break;
        budgetedEntries.push(e);
        totalChars += e.text.length;
      }

      if (budgetedEntries.length > 0) {
        const lines = budgetedEntries.map(e => {
          const mediaNote = e.mediaUrls.length > 0 ? " [with media]" : "";
          return `[You sent on ${e.channelType}]: ${e.text}${mediaNote}`;
        });
        dynamicPreambleParts.push(
          "## Your Recent Outbound Messages\n" +
          "You previously sent these messages (for context continuity):\n" +
          lines.join("\n")
        );

        // Acknowledge injected entries (fire-and-forget)
        const ids = budgetedEntries.map(e => e.id);
        suppressError(
          deps.deliveryMirror.acknowledge(ids),
          "mirror acknowledge failed",
        );

        // DEBUG logging for mirror injection
        logger.debug(
          { mirrorEntriesInjected: budgetedEntries.length, mirrorChars: totalChars, sessionKey: formatSessionKey(sessionKey) },
          "Mirror entries injected into prompt",
        );
      }
    }
  }
  // MCP server instructions in dynamic preamble (not system prompt) for cache stability.
  // Server instructions may change on reconnect; placing them in the dynamic preamble avoids
  // invalidating the system prompt cache prefix.
  const mcpServerInstructions = deps.mcpServerInstructions;
  if (mcpServerInstructions && mcpServerInstructions.length > 0) {
    const instructionSections = mcpServerInstructions
      .map(s => `### ${s.serverName}\n${s.instructions}`)
      .join("\n\n");
    dynamicPreambleParts.push(`## MCP Server Instructions\n${instructionSections}`);
  }
  // BOOT.md content relocated from system prompt to dynamic preamble.
  // Previously prepended to system prompt on first message only, causing a cache
  // miss on turn 2 when the prepend was absent.
  if (deps.isFirstMessageInSession && !msg.metadata?.lightContext) {
    try {
      const bootPath = safePath(deps.workspaceDir, BOOT_FILE_NAME);
      const bootContent = await fs.readFile(bootPath, "utf-8");
      if (!isBootContentEffectivelyEmpty(bootContent)) {
        dynamicPreambleParts.unshift(
          `[Session startup instructions from BOOT.md]\n${bootContent}\n[End startup instructions]`,
        );
      }
    } catch {
      // BOOT.md missing or unreadable
    }
  }
  // BOOTSTRAP.md onboarding content relocated from system prompt to dynamic preamble.
  // Specialist-profile agents (task workers spawned by pipelines, sub-agents, or
  // graphs) must never receive onboarding: the "greet the user, ask who I am"
  // script hijacks task execution and wastes ~3 KB of context per turn. See
  // audit finding F3 (2026-04-19).
  if (isOnboarding && config.workspace?.profile !== "specialist") {
    try {
      const bootstrapPath = safePath(deps.workspaceDir, "BOOTSTRAP.md");
      const bootstrapContent = await fs.readFile(bootstrapPath, "utf-8");
      if (bootstrapContent.trim()) {
        dynamicPreambleParts.unshift(
          "[ONBOARDING ACTIVE -- Follow these instructions for this conversation]\n" +
          bootstrapContent +
          "\n[End onboarding instructions]",
        );
      }
    } catch {
      // BOOTSTRAP.md missing or unreadable
    }
  }
  // Safety reinforcement relocated from system prompt to dynamic preamble.
  // Previously prepended to system prompt, causing a cache miss when the next message
  // does not trigger safety reinforcement.
  if (params.safetyReinforcement) {
    dynamicPreambleParts.unshift(params.safetyReinforcement);
  }
  // Hook prependContext relocated from system prompt to dynamic preamble.
  // Hooks may return turn-varying content (timestamps, user state) which would
  // invalidate the cache prefix if injected into the system prompt.
  if (hookPrependContext) {
    dynamicPreambleParts.unshift(hookPrependContext);
  }
  // API system prompt relocated from system prompt to dynamic preamble.
  // Different API callers send different system prompts; keeping them in the system
  // prompt created per-caller cache prefixes. wrapExternalContent security wrapping
  // is preserved — content is still sandboxed and tagged.
  if (wrappedApiSystemPrompt) {
    dynamicPreambleParts.unshift(wrappedApiSystemPrompt);
  }
  const dynamicPreamble = dynamicPreambleParts.join("\n\n");

  // Token budget breakdown for optimization measurement.
  const systemPromptTokens = Math.ceil(systemPrompt.length / CHARS_PER_TOKEN_RATIO);
  const dynamicPreambleTokens = Math.ceil(dynamicPreamble.length / CHARS_PER_TOKEN_RATIO);
  logger.info(
    {
      systemPromptTokens,
      dynamicPreambleTokens,
      systemPromptChars: systemPrompt.length,
      dynamicPreambleChars: dynamicPreamble.length,
      bootstrapChars,
      bootstrapPercent: systemPromptChars > 0 ? Math.round((bootstrapChars / systemPromptChars) * 100) : 0,
      toolCount: mergedCustomTools.length,
      isFirstMessage: deps.isFirstMessageInSession ?? false,
      hasSpawnPacket: !!deps.spawnPacket,
    },
    "Prompt budget breakdown",
  );

  // Capture frozen prompt state on first turn for sub-agent cache prefix sharing.
  // Captured AFTER hook execution so frozenSystemPrompt includes hook modifications.
  // Sub-agents should only READ parent params, never populate their own.
  // 4.2: Compute toolHash from actual toolNames (not stableToolNames) on every turn.
  //       When tools change mid-session (e.g., MCP server connects), refresh CacheSafeParams
  //       so sub-agents spawned after the change get updated tool lists.
  //       Uses actual toolNames for hash comparison but stableToolNames for the snapshot,
  //       because stableToolNames is what the prompt assembly and cache prefix use.
  if (!deps.spawnPacket) {
    const currentToolHash = toolNames.slice().sort().join(",");
    const existing = sessionCacheSafeParams.get(snapshotKey);
    if (!existing || existing.toolHash !== currentToolHash) {
      sessionCacheSafeParams.set(snapshotKey, {
        frozenSystemPrompt: systemPrompt,
        frozenSystemPromptBlocks: systemPromptBlocks,
        toolNames: stableToolNames,
        model: config.model,
        provider: config.provider,
        cacheRetention: config.cacheRetention,
        cacheWriteTimestamp: Date.now(),
        toolHash: currentToolHash,
      });
    }
  }

  return { systemPrompt, systemPromptBlocks, dynamicPreamble, inlineMemory };
}
