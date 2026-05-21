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
import { createUnifiedMemoryTool } from "./tools/unified-memory-tool.js";
import { createUnifiedSessionTool } from "./tools/unified-session-tool.js";
import { createUnifiedContextTool } from "./tools/unified-context-tool.js";
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
import { createHeartbeatManageTool } from "./tools/heartbeat-manage-tool.js";
import { createNotifyTool } from "./tools/notify-tool.js";
import { createBackgroundTasksTool } from "./tools/background-tasks-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createMemorySearchTool } from "./tools/memory-search-tool.js";
import { createMemoryGetTool } from "./tools/memory-get-tool.js";
import { createMemoryStoreTool } from "./tools/memory-store-tool.js";
import { createMemoryManageTool } from "./tools/memory-manage-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionSearchTool } from "./tools/session-search-tool.js";
import { createCtxExpandTool } from "./tools/ctx-expand-tool.js";
import { createCtxInspectTool } from "./tools/ctx-inspect-tool.js";
import { createCtxRecallTool } from "./tools/ctx-recall-tool.js";
import { createCtxSearchTool } from "./tools/ctx-search-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";

// ===========================================================================
// Types
// ===========================================================================

/**
 * RPC call indirection — every platform tool dispatches through this.
 * Signature mirrors daemon's `createAgentRpcCall(agentId)` return shape and
 * the per-tool `RpcCall` type re-exported from `./tools/cron-tool.js`.
 */
export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

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
   * Optional callback for suspicious content detection. Forwarded by the
   * daemon (built once per process in `stages/agents-helpers.ts:buildAuditBundle`).
   * Currently consumed by the MCP bridge via `mcpToolsToAgentTools` and reserved
   * for future MCP-wrapping platform-tool descriptors.
   */
  readonly onSuspiciousContent?: WrapExternalContentOptions["onSuspiciousContent"];
  /** `image_generate` tool's conditional predicate signal (truthy when provider wired). */
  readonly imageGenProvider?: unknown;
  /** `background_tasks` tool's conditional predicate signal (truthy when manager wired). */
  readonly backgroundTaskManager?: unknown;
  /** Per-agent tool capability port (resolved via daemon's deps map). */
  readonly toolCapabilityPort?: unknown;
  /** `unified_context` tool's conditional predicate (`"dag"` enables). */
  readonly contextEngineVersion?: string;
  /** `browser` tool's conditional predicate. */
  readonly builtinToolsBrowserEnabled?: boolean;
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

    // ---- context ----
    {
      name: "ctx_expand",
      category: "context",
      build: (ctx) => createCtxExpandTool(ctx.rpcCall as never),
    },
    {
      name: "ctx_inspect",
      category: "context",
      build: (ctx) => createCtxInspectTool(ctx.rpcCall as never),
    },
    {
      name: "ctx_recall",
      category: "context",
      build: (ctx) => createCtxRecallTool(ctx.rpcCall as never),
    },
    {
      name: "ctx_search",
      category: "context",
      build: (ctx) => createCtxSearchTool(ctx.rpcCall as never),
    },
    {
      name: "unified_context",
      category: "context",
      conditional: (ctx) => ctx.contextEngineVersion === "dag",
      build: (ctx) => createUnifiedContextTool(ctx.rpcCall as never),
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
    {
      name: "unified_memory",
      category: "memory",
      build: (ctx) => createUnifiedMemoryTool(ctx.rpcCall as never, ctx.approvalGate as never),
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
    {
      name: "unified_session",
      category: "session",
      build: (ctx) => createUnifiedSessionTool(ctx.rpcCall as never),
    },
  ];
}
