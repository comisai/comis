// SPDX-License-Identifier: Apache-2.0
/**
 * Platform tool descriptor registry.
 *
 * Single source of truth for the platform-tool set. Daemon's
 * `setup-tools.ts` consumes this registry via
 * `REGISTRY.filter(...).map(d => d.build(ctx))` instead of enumerating
 * 38+ factory calls inline.
 *
 * Each descriptor exports:
 *   - `name`: opaque identifier matching the snapshot baseline. NOTE: the
 *     descriptor `name` is a registry-side label following the parity-test
 *     contract; it is NOT required to equal the underlying `AgentTool.name`.
 *     The actual tool `.name` may differ — e.g. the `image` descriptor
 *     builds an AgentTool whose `.name` is `image_analyze`. The parity-test
 *     list is the contract.
 *   - `category`: documentation taxonomy (memory, session, agent, messaging, etc.)
 *   - `build(ctx)`: invokes the per-tool factory with runtime context.
 *     Returns `AgentTool` for unconditional descriptors, or `AgentTool | undefined`
 *     when a conditional predicate is also defined.
 *   - `conditional?(ctx)`: optional gate; descriptors whose predicate returns
 *     false are filtered out before `build` is invoked.
 *
 * Architecture: this file is the public surface of the `./platform-tools`
 * subpath. Factory imports are local-relative (`./tools/*.js`); helper
 * imports are local-relative (`./tool-helpers.js`). `ComisLogger` is
 * imported from `@comis/core` (NOT `@comis/infra`) — skills enforce zero
 * infra imports.
 *
 * @module
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ComisLogger, WrapExternalContentOptions } from "@comis/core";

// Import every platform-tool factory function. Local relative paths because
// the factory files live under `./tools/`.
import { createCronTool } from "./tools/cron-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createDiscordActionTool } from "./tools/discord-action-tool.js";
import { createTelegramActionTool } from "./tools/telegram-action-tool.js";
import { createSlackActionTool } from "./tools/slack-action-tool.js";
import { createWhatsAppActionTool } from "./tools/whatsapp-action-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createPipelineTool } from "./tools/pipeline-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createTTSTool } from "./tools/tts-tool.js";
import { createTranscribeAudioTool } from "./tools/transcribe-audio-tool.js";
import { createDescribeVideoTool } from "./tools/describe-video-tool.js";
import { createExtractDocumentTool } from "./tools/extract-document-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createAgentsManageTool } from "./tools/agents-manage-tool.js";
import { createObsQueryTool } from "./tools/obs-query-tool.js";
import { createSessionsManageTool } from "./tools/sessions-manage-tool.js";
import { createModelsManageTool } from "./tools/models-manage-tool.js";
import { createProvidersManageTool } from "./tools/providers-manage-tool.js";
import { createTokensManageTool } from "./tools/tokens-manage-tool.js";
import { createChannelsManageTool } from "./tools/channels-manage-tool.js";
import { createSkillsManageTool } from "./tools/skills-manage-tool.js";
import { createMcpManageTool } from "./tools/mcp-manage-tool.js";
import { createMcpLoginTool } from "./tools/mcp-login-tool.js";
import { createHeartbeatManageTool } from "./tools/heartbeat-manage-tool.js";
import { createNotifyTool } from "./tools/notify-tool.js";
import { createBackgroundTasksTool } from "./tools/background-tasks-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createVideoStatusTool } from "./tools/video-status-tool.js";
import { createMemorySearchTool } from "./tools/memory-search-tool.js";
import { createMemoryGetTool } from "./tools/memory-get-tool.js";
import { createMemoryStoreTool } from "./tools/memory-store-tool.js";
import { createMemoryManageTool } from "./tools/memory-manage-tool.js";
import { createMemoryAskTool } from "./tools/memory-ask-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionSearchTool } from "./tools/session-search-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createListResourcesTool, createReadResourceTool } from "./tools/mcp-resources-tool.js";
import { createListPromptsTool, createGetPromptTool } from "./tools/mcp-prompts-tool.js";

// Side-effect import: registers `suppressActivity:true` metadata for the
// platform tools that have no activity-label spec. Importing the tool factory
// modules above already triggers each activity-label-spec tool's co-located
// `registerActivityLabelSpec` call; this completes the other side of the
// coverage contract so every emitted name is classified before any registry walk.
import "./tools/suppressed-tools-metadata.js";

// Capability-gate helpers + manager type for the resources/prompts descriptor
// conditionals. Imported from the mcp-client barrel (the public surface of
// that integration subtree).
import {
  serverAdvertisesResources,
  serverAdvertisesPrompts,
  type McpClientManager,
} from "../skills/integrations/mcp-client/index.js";

// ===========================================================================
// Types
// ===========================================================================

/**
 * RPC call indirection — every platform tool dispatches through this.
 * Signature mirrors daemon's `createAgentRpcCall(agentId)` return shape and
 * the per-tool `RpcCall` type re-exported from `./tools/cron-tool.js`.
 */
export type RpcCall = (
  method: string,
  params: Record<string, unknown>,
  metadata?: { outwardOperationId?: string },
) => Promise<unknown>;

/**
 * Runtime context passed to each descriptor's `build` callback. Daemon
 * constructs this once per per-agent assemble call from its `ToolsDeps`
 * surface (see `packages/daemon/src/wiring/setup-tools.ts`).
 *
 * Fields with `unknown` types reflect the deliberate decoupling between
 * the registry's public surface and the daemon's internal port types;
 * each descriptor's `build` callback casts to the concrete factory-expected
 * type via `as never`. A future refactor could tighten these via generics.
 */
export interface PlatformToolBuildContext {
  readonly agentId: string;
  readonly rpcCall: RpcCall;
  readonly skillsLogger: ComisLogger;
  /** Optional — present only when the daemon has wired an approval gate. */
  readonly approvalGate?: unknown;
  /** Typed event bus reference (unused by most descriptors; held for future use). */
  readonly eventBus?: unknown;
  /**
   * MCP client manager. Gates the resources/prompts descriptors
   * (list_resources/read_resource/list_prompts/get_prompt) — each descriptor's
   * `conditional` predicate registers the tool iff this manager is present AND
   * any connected server advertises the matching capability (resources/prompts)
   * without a per-server enableResources/enablePrompts:false opt-out. Optional
   * so non-MCP build contexts (parity-test stub, agents without MCP wired)
   * simply skip the 4 descriptors.
   */
  readonly mcpClientManager?: McpClientManager;
  /**
   * Optional callback for suspicious content detection. Forwarded by the
   * daemon (built once per process inside `bootAgents` in `daemon.ts`,
   * from the audit-aggregator constructed there; the former
   * `buildAuditBundle` helper has been inlined directly into the stage
   * body). Currently consumed by the MCP bridge via `mcpToolsToAgentTools`
   * and reserved for future MCP-wrapping platform-tool descriptors.
   */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /** `image_generate` tool's conditional predicate signal (truthy when provider wired). */
  readonly imageGenProvider?: unknown;
  /** `video_generate` tool's conditional predicate signal (truthy when provider wired; the daemon sets it at boot). */
  readonly videoGenProvider?: unknown;
  /** `video_status` tool's conditional predicate signal:
   *  truthy when the async stack — store + poller — is wired, gated on the SAME
   *  condition `videoGenProvider` uses so video_status activates exactly when
   *  video_generate does. */
  readonly videoStatusEnabled?: unknown;
  /** `background_tasks` tool's conditional predicate signal (truthy when manager wired). */
  readonly backgroundTaskManager?: unknown;
  /** Per-agent tool capability port (resolved via daemon's deps map). */
  readonly toolCapabilityPort?: unknown;
  /** Per-agent context-engine version signal (`"pipeline"` | `"dag"`). Set by
   *  setup-tools but currently unconsumed — its only reader, the `unified_context`
   *  conditional, has been removed. Retained as a harmless optional so the
   *  daemon's BuildContext literal stays valid; a future governed LCD expansion
   *  surface may re-read it. */
  readonly contextEngineVersion?: string;
  /** `browser` tool's conditional predicate. */
  readonly builtinToolsBrowserEnabled?: boolean;
  /** `memory_ask` (the dialectic) tool's conditional predicate. Fed from
   *  `agentConfig.dialectic.enabled === true` at setup-tools; default-OFF (absent ⇒ the
   *  tool is filtered out before build — the query-time-LLM cost gate). */
  readonly dialecticEnabled?: boolean;
  /** agents-manage callbacks — passed unconditionally via build context. */
  readonly onConfigMutationStart?: () => void;
  readonly onConfigMutationEnd?: () => void;
  readonly onAgentCreated?: (info: { agentId: string; workspaceDir?: string }) => Promise<void> | void;
  /** Browser-tool extras — daemon constructs sanitizer/persistence/workspace lazily. */
  readonly browserSanitizeImage?: unknown;
  readonly browserPersistMedia?: unknown;
  readonly browserWorkspaceDir?: string;
}

export interface PlatformToolDescriptor {
  readonly name: string;
  readonly category: string;
  /**
   * Construct the `AgentTool` for this descriptor. Returns `undefined` only
   * when a `conditional` predicate is also defined and the predicate fails
   * inside `build` (callers should filter on `conditional` before invoking
   * `build`, so `undefined` is a defensive secondary signal).
   *
   * The return type uses the default `AgentTool` instantiation (TSchema)
   * rather than parameterizing per-descriptor — descriptors are stored in
   * a homogeneous array, and downstream consumers (daemon's tool pipeline,
   * the parity test) only need `name`, `parameters`, and `execute`.
   */
  readonly build: (ctx: PlatformToolBuildContext) => AgentTool | undefined;
  readonly conditional?: (ctx: PlatformToolBuildContext) => boolean;
}

// ===========================================================================
// Capability-gate walks
// ===========================================================================

/**
 * True when ANY connected server advertises resources support (per-server
 * `enableResources:false` opt-out honored via the threaded connection field).
 * Drives the `conditional` predicate for list_resources / read_resource.
 */
function anyServerAdvertisesResources(manager: McpClientManager): boolean {
  return manager
    .getAllConnections()
    .some((c) => c.status === "connected" && serverAdvertisesResources(c.capabilities, c.enableResources));
}

/**
 * True when ANY connected server advertises prompts support (per-server
 * `enablePrompts:false` opt-out honored). Drives list_prompts / get_prompt.
 */
function anyServerAdvertisesPrompts(manager: McpClientManager): boolean {
  return manager
    .getAllConnections()
    .some((c) => c.status === "connected" && serverAdvertisesPrompts(c.capabilities, c.enablePrompts));
}

// ===========================================================================
// Registry
// ===========================================================================

/**
 * Returns the full set of platform-tool descriptors. The set is static at
 * module load time; the `build` callbacks inject runtime context per agent.
 *
 * Order: alphabetical by category, then alphabetical by name within category.
 * Order does not affect correctness — the parity test sorts before comparing —
 * but the deterministic order keeps the snapshot diff readable.
 */
export function createPlatformToolRegistry(): readonly PlatformToolDescriptor[] {
  return [
    // ---- agent (admin / management) ----
    {
      name: "agents_manage",
      category: "agent",
      build: (ctx) =>
        createAgentsManageTool(
          ctx.rpcCall as never,
          ctx.skillsLogger,
          ctx.approvalGate as never,
          {
            onMutationStart: ctx.onConfigMutationStart,
            onMutationEnd: ctx.onConfigMutationEnd,
            onAgentCreated: ctx.onAgentCreated,
          },
        ),
    },
    {
      name: "pipeline",
      category: "agent",
      build: (ctx) =>
        createPipelineTool(ctx.rpcCall as never, ctx.skillsLogger, ctx.approvalGate as never),
    },
    {
      name: "subagents",
      category: "agent",
      build: (ctx) => createSubagentsTool(ctx.rpcCall as never, ctx.skillsLogger),
    },

    // ---- background ----
    {
      name: "background_tasks",
      category: "background",
      conditional: (ctx) => ctx.backgroundTaskManager !== undefined,
      // `build` always constructs the AgentTool (schema is static, doesn't
      // depend on the manager). Daemon filters on `conditional` BEFORE invoking
      // `build`, so the missing-manager case never reaches execute(). The
      // parity-test snapshot calls `build` unconditionally to capture the
      // schema regardless of the gate state.
      build: (ctx) =>
        createBackgroundTasksTool({
          manager: ctx.backgroundTaskManager as never,
          agentId: ctx.agentId,
        }),
    },

    // ---- browser ----
    {
      name: "browser",
      category: "browser",
      conditional: (ctx) => ctx.builtinToolsBrowserEnabled === true,
      build: (ctx) =>
        createBrowserTool({
          rpcCall: ctx.rpcCall as never,
          sanitizeImage: ctx.browserSanitizeImage as never,
          persistMedia: ctx.browserPersistMedia as never,
          workspaceDir: ctx.browserWorkspaceDir ?? "",
        }),
    },

    // ---- gateway / observability ----
    {
      name: "gateway",
      category: "gateway",
      build: (ctx) => createGatewayTool(ctx.rpcCall as never, ctx.skillsLogger),
    },
    {
      name: "obs_query",
      category: "observability",
      build: (ctx) => createObsQueryTool(ctx.rpcCall as never),
    },

    // ---- heartbeat ----
    {
      name: "heartbeat_manage",
      category: "heartbeat",
      build: (ctx) => createHeartbeatManageTool(ctx.rpcCall as never),
    },

    // ---- mcp ----
    {
      name: "mcp_manage",
      category: "mcp",
      build: (ctx) => createMcpManageTool(ctx.rpcCall as never, ctx.approvalGate as never),
    },
    {
      name: "mcp_login",
      category: "mcp",
      build: (ctx) => createMcpLoginTool(ctx.rpcCall as never),
    },
    // Capability-gated resources/prompts utility tools.
    // GLOBAL (server parameter) — exactly 4 descriptors regardless of how many
    // MCP servers are connected. Each `conditional` re-evaluates per agent
    // assemble, so the tools register on the first turn AFTER the relevant
    // server connects (no daemon restart) and honor per-server opt-outs.
    {
      name: "get_prompt",
      category: "mcp",
      conditional: (ctx) => ctx.mcpClientManager !== undefined && anyServerAdvertisesPrompts(ctx.mcpClientManager),
      build: (ctx) => createGetPromptTool(ctx.mcpClientManager as McpClientManager),
    },
    {
      name: "list_prompts",
      category: "mcp",
      conditional: (ctx) => ctx.mcpClientManager !== undefined && anyServerAdvertisesPrompts(ctx.mcpClientManager),
      build: (ctx) => createListPromptsTool(ctx.mcpClientManager as McpClientManager),
    },
    {
      name: "list_resources",
      category: "mcp",
      conditional: (ctx) => ctx.mcpClientManager !== undefined && anyServerAdvertisesResources(ctx.mcpClientManager),
      build: (ctx) => createListResourcesTool(ctx.mcpClientManager as McpClientManager),
    },
    {
      name: "read_resource",
      category: "mcp",
      conditional: (ctx) => ctx.mcpClientManager !== undefined && anyServerAdvertisesResources(ctx.mcpClientManager),
      build: (ctx) => createReadResourceTool(ctx.mcpClientManager as McpClientManager),
    },

    // ---- media ----
    {
      name: "describe_video",
      category: "media",
      build: (ctx) => createDescribeVideoTool(ctx.rpcCall as never),
    },
    {
      name: "extract_document",
      category: "media",
      build: (ctx) => createExtractDocumentTool(ctx.rpcCall as never),
    },
    {
      name: "image",
      category: "media",
      build: (ctx) => createImageTool(ctx.rpcCall as never),
    },
    {
      name: "image_generate",
      category: "media",
      conditional: (ctx) => ctx.imageGenProvider !== undefined,
      build: (ctx) => createImageGenerateTool(ctx.rpcCall as never),
    },
    {
      name: "video_generate",
      category: "media",
      conditional: (ctx) => ctx.videoGenProvider !== undefined,
      // Thread the boot-selected videoGenProvider so the tool
      // description is built at registration from the ACTIVE backend's
      // capability matrix (the conditional above guarantees it is present).
      build: (ctx) =>
        createVideoGenerateTool(ctx.rpcCall as never, ctx.videoGenProvider as never),
    },
    {
      name: "video_status",
      category: "media",
      conditional: (ctx) => ctx.videoStatusEnabled !== undefined,
      build: (ctx) => createVideoStatusTool(ctx.rpcCall as never),
    },
    {
      name: "transcribe_audio",
      category: "media",
      build: (ctx) => createTranscribeAudioTool(ctx.rpcCall as never),
    },
    {
      name: "tts",
      category: "media",
      build: (ctx) => createTTSTool(ctx.rpcCall as never),
    },

    // ---- memory ----
    {
      // The dialectic: a grounded, cited NL answer over
      // the agent's LLM-free recall pipeline. The ONE query-time LLM surface, OPT-IN
      // and default-OFF. The `conditional` gate registers it ONLY when the per-agent
      // `dialectic.enabled` knob is true (fed to `ctx.dialecticEnabled` at setup-tools);
      // an absent/off knob ⇒ the daemon filters it out BEFORE build (the cost gate, the
      // default-OFF byte-identity). `build` always constructs the tool (the schema is
      // static — the parity snapshot captures it regardless of the gate), exactly like
      // `browser` / `background_tasks`.
      name: "memory_ask",
      category: "memory",
      conditional: (ctx) => ctx.dialecticEnabled === true,
      build: (ctx) => createMemoryAskTool(ctx.rpcCall as never),
    },
    {
      name: "memory_get",
      category: "memory",
      build: (ctx) => createMemoryGetTool(ctx.rpcCall as never),
    },
    {
      name: "memory_manage",
      category: "memory",
      build: (ctx) => createMemoryManageTool(ctx.rpcCall as never, ctx.approvalGate as never),
    },
    {
      name: "memory_search",
      category: "memory",
      build: (ctx) => createMemorySearchTool(ctx.rpcCall as never),
    },
    {
      name: "memory_store",
      category: "memory",
      build: (ctx) => createMemoryStoreTool(ctx.rpcCall as never),
    },

    // ---- messaging ----
    {
      name: "discord_action",
      category: "messaging",
      build: (ctx) => createDiscordActionTool(ctx.rpcCall as never, ctx.skillsLogger),
    },
    {
      name: "message",
      category: "messaging",
      build: (ctx) => createMessageTool(ctx.rpcCall as never),
    },
    {
      name: "notify",
      category: "messaging",
      build: (ctx) => createNotifyTool(ctx.rpcCall as never),
    },
    {
      name: "slack_action",
      category: "messaging",
      build: (ctx) => createSlackActionTool(ctx.rpcCall as never),
    },
    {
      name: "telegram_action",
      category: "messaging",
      build: (ctx) => createTelegramActionTool(ctx.rpcCall as never),
    },
    {
      name: "whatsapp_action",
      category: "messaging",
      build: (ctx) => createWhatsAppActionTool(ctx.rpcCall as never),
    },

    // ---- platform admin ----
    {
      name: "channels_manage",
      category: "platform-admin",
      build: (ctx) => createChannelsManageTool(ctx.rpcCall as never, ctx.approvalGate as never),
    },
    {
      name: "models_manage",
      category: "platform-admin",
      build: (ctx) => createModelsManageTool(ctx.rpcCall as never),
    },
    {
      name: "providers_manage",
      category: "platform-admin",
      build: (ctx) =>
        createProvidersManageTool(
          ctx.rpcCall as never,
          ctx.approvalGate as never,
          {
            onMutationStart: ctx.onConfigMutationStart,
            onMutationEnd: ctx.onConfigMutationEnd,
          },
        ),
    },
    {
      name: "skills_manage",
      category: "platform-admin",
      build: (ctx) => createSkillsManageTool(ctx.rpcCall as never, ctx.approvalGate as never),
    },
    {
      name: "tokens_manage",
      category: "platform-admin",
      build: (ctx) => createTokensManageTool(ctx.rpcCall as never, ctx.approvalGate as never),
    },

    // ---- scheduling ----
    {
      name: "cron",
      category: "scheduling",
      build: (ctx) => createCronTool(ctx.rpcCall as never),
    },

    // ---- session ----
    {
      name: "session_search",
      category: "session",
      build: (ctx) => createSessionSearchTool(ctx.rpcCall as never),
    },
    {
      name: "session_status",
      category: "session",
      build: (ctx) => createSessionStatusTool(ctx.rpcCall as never),
    },
    {
      name: "sessions_history",
      category: "session",
      build: (ctx) => createSessionsHistoryTool(ctx.rpcCall as never),
    },
    {
      name: "sessions_list",
      category: "session",
      build: (ctx) => createSessionsListTool(ctx.rpcCall as never),
    },
    {
      name: "sessions_manage",
      category: "session",
      build: (ctx) => createSessionsManageTool(ctx.rpcCall as never, ctx.approvalGate as never),
    },
    {
      name: "sessions_send",
      category: "session",
      build: (ctx) => createSessionsSendTool(ctx.rpcCall as never),
    },
    {
      name: "sessions_spawn",
      category: "session",
      build: (ctx) => createSessionsSpawnTool(ctx.rpcCall as never),
    },
  ];
}
