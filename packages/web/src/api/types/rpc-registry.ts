/**
 * Typed RPC method registry.
 *
 * Maps every known RPC method name to its parameter and response types.
 * Using TypedRpcCall makes it a compile error to call a non-existent
 * method name, preventing phantom RPC calls.
 *
 * Methods are organized by category matching the backend handler modules.
 * Stub entries (params/response as Record<string, unknown> / unknown) are
 * placeholders for methods not yet fully typed -- they still provide
 * method name checking at compile time.
 */

import type { RpcClient } from "../rpc-client.js";
import type {
  AgentInfo,
  AgentDetail,
  AgentBilling,
  SubAgentRunDto,
  ChannelInfo,
  ChannelObsEntry,
  ChannelObsResponse,
  ChannelStaleResponse,
  DeliveryQueueStatus,
  PlatformCapabilities,
  SessionInfo,
  SessionMessage,
  SessionSearchResult,
  MemoryEntry,
  MemoryStats,
  DagConversation,
  DagTreeNode,
  EmbeddingCacheStats,
  GatewayStatus,
  ActivityEntry,
  DeliveryStats,
  DeliveryTrace,
  BillingTotal,
  BillingByProvider,
  BillingByAgent,
  BillingBySession,
  TokenUsagePoint,
  DiagnosticsEvent,
  PipelineSnapshot,
  DagCompactionSnapshot,
  HeartbeatAgentStateDto,
  PipelineNode,
  PipelineEdge,
  GraphSettings,
  SavedGraphSummary,
  SavedGraphDetail,
  GraphRunSummary,
  GraphRunDetail,
  MonitorNodeState,
  ConfigHistoryResponse,
  ConfigDiffResponse,
  ConfigRollbackResponse,
  ConfigGcResponse,
  McpServerListEntry,
  McpServerDetail,
  McpConnectParams,
  McpConnectResponse,
  SttTestResult,
  TtsTestResult,
  VisionTestResult,
  DocumentTestResult,
  VideoTestResult,
  LinkTestResult,
  MediaProvidersInfo,
} from "./index.js";

// ---------------------------------------------------------------------------
// RPC Method Map
// ---------------------------------------------------------------------------

/**
 * Complete mapping of RPC method names to their parameter and response types.
 *
 * - `params: void` means the method takes no parameters.
 * - `params: Record<string, unknown>` means parameters are not yet fully typed.
 * - `response: unknown` means the response is not yet fully typed.
 *
 * Adding a new RPC call? Add the entry here first -- TypedRpcCall will
 * enforce that only methods in this map can be called.
 */
export interface RpcMethodMap {
  // -------------------------------------------------------------------------
  // System
  // -------------------------------------------------------------------------
  "system.ping": { params: void; response: { status: string } };

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------
  "config.read": {
    params: { path?: string; section?: string } | void;
    response: { config: Record<string, unknown>; sections: string[] };
  };
  "config.schema": {
    params: void;
    response: { schema: Record<string, unknown>; sections: string[] };
  };
  "config.patch": {
    params: { section: string; key: string; value: unknown };
    response: { patched: boolean };
  };
  "config.apply": {
    params: { section: string; value: unknown };
    response: { applied: boolean };
  };
  "config.set": {
    params: { section: string; key: string; value: unknown };
    response: { set: boolean };
  };
  "config.history": {
    params: { limit?: number; section?: string };
    response: ConfigHistoryResponse;
  };
  "config.diff": {
    params: { sha?: string };
    response: ConfigDiffResponse;
  };
  "config.rollback": {
    params: { sha: string };
    response: ConfigRollbackResponse;
  };
  "config.gc": {
    params: { olderThan?: string };
    response: ConfigGcResponse;
  };

  // -------------------------------------------------------------------------
  // Gateway
  // -------------------------------------------------------------------------
  "gateway.status": { params: void; response: GatewayStatus };

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------
  "agents.list": {
    params: void;
    response: { agents: AgentInfo[] };
  };
  "agents.get": {
    params: { agentId: string };
    response: { agentId: string; config: Record<string, unknown>; suspended?: boolean };
  };
  "agents.create": {
    params: { agentId: string; config: Record<string, unknown> };
    response: { agentId: string };
  };
  "agents.update": {
    params: { agentId: string; config?: Record<string, unknown> } & Partial<AgentDetail>;
    response: { updated: boolean };
  };
  "agents.delete": {
    params: { agentId: string };
    response: { deleted: boolean };
  };
  "agents.suspend": {
    params: { agentId: string };
    response: { suspended: boolean };
  };
  "agents.resume": {
    params: { agentId: string };
    response: { resumed: boolean };
  };

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------
  "channels.list": {
    params: void;
    response: { channels: ChannelInfo[]; total: number };
  };
  "channels.get": {
    params: { channel_type: string };
    response: Record<string, unknown>;
  };
  "channels.enable": {
    params: { channel_type: string };
    response: { enabled: boolean };
  };
  "channels.disable": {
    params: { channel_type: string };
    response: { disabled: boolean };
  };
  "channels.restart": {
    params: { channel_type: string };
    response: { restarted: boolean };
  };
  "delivery.queue.status": {
    params: { channel_type?: string };
    response: DeliveryQueueStatus;
  };
  "channels.capabilities": {
    params: { channel_type: string };
    response: { channelType: string; features: PlatformCapabilities };
  };

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------
  "session.list": {
    params: { agentId?: string; channelType?: string; search?: string; kind?: string } | Record<string, unknown>;
    response: { sessions: Array<Record<string, unknown>>; total: number };
  };
  "session.history": {
    params: { session_key: string };
    response: { session: SessionInfo; messages: SessionMessage[] };
  };
  "session.search": {
    params: { query: string; limit?: number };
    response: SessionSearchResult[];
  };
  "session.status": {
    params: { session_key: string };
    response: SessionInfo;
  };
  "session.send": {
    params: { session_key?: string; agentId?: string; content: string; channelType?: string; channelId?: string; chatId?: string };
    response: { sessionKey?: string; response?: string };
  };
  "session.spawn": {
    params: { agentId: string; task: string; channelType?: string };
    response: { sessionKey: string };
  };
  "session.delete": {
    params: { session_key?: string; keys?: string[] };
    response: { deleted: number };
  };
  "session.reset": {
    params: { session_key?: string; keys?: string[] };
    response: { reset: number };
  };
  "session.export": {
    params: { session_key?: string; keys?: string[] };
    response: string;
  };
  "session.compact": {
    params: { session_key: string };
    response: { compacted: boolean };
  };

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------
  "memory.stats": {
    params: void;
    response: MemoryStats;
  };
  "memory.browse": {
    params: { offset?: number; limit?: number; type?: string; trust?: string; agentId?: string; from?: number; to?: number };
    response: { entries: MemoryEntry[]; total: number };
  };
  "memory.delete": {
    params: { id?: string; ids?: string[] };
    response: { deleted: number };
  };
  "memory.store": {
    params: { content: string; tags?: string[]; trustLevel?: string; provenance?: string; agentId?: string };
    response: { stored: boolean; id: string };
  };
  "memory.flush": {
    params: { tenant_id?: string; agent_id?: string } | void;
    response: { flushed: boolean; entriesRemoved: number; scope: { tenantId: string; agentId: string | null } };
  };
  "memory.export": {
    params: { ids?: string[] };
    response: string;
  };
  "memory.embeddingCache": {
    params: void;
    response: EmbeddingCacheStats;
  };

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------
  "obs.diagnostics": {
    params: { category?: string; sinceMs?: number; limit?: number };
    response: { events: DiagnosticsEvent[]; total: number };
  };
  "obs.billing.byProvider": {
    params: { sinceMs?: number };
    response: { providers: BillingByProvider[] };
  };
  "obs.billing.byAgent": {
    params: { agentId: string; sinceMs?: number };
    response: AgentBilling;
  };
  "obs.billing.bySession": {
    params: { sessionKey: string; sinceMs?: number };
    response: BillingBySession;
  };
  "obs.billing.total": {
    params: { sinceMs?: number };
    response: BillingTotal;
  };
  "obs.billing.usage24h": {
    params: void;
    response: TokenUsagePoint[];
  };
  "obs.channels.all": {
    params: void;
    response: ChannelObsResponse;
  };
  "obs.channels.stale": {
    params: void;
    response: ChannelStaleResponse;
  };
  "obs.channels.get": {
    params: { channelId: string };
    response: { channel: ChannelObsEntry | null };
  };
  "obs.delivery.recent": {
    params: { sinceMs?: number; limit?: number; channelType?: string };
    response: { entries: DeliveryTrace[] };
  };
  "obs.delivery.stats": {
    params: { sinceMs?: number };
    response: DeliveryStats;
  };
  "obs.context.pipeline": {
    params: { agentId?: string; sessionKey?: string; limit?: number };
    response: PipelineSnapshot[];
  };
  "obs.context.dag": {
    params: { agentId?: string; sessionKey?: string; limit?: number };
    response: DagCompactionSnapshot[];
  };
  "obs.reset": {
    params: void;
    response: { reset: boolean };
  };
  "obs.reset.table": {
    params: { table: string };
    response: { reset: boolean };
  };

  // -------------------------------------------------------------------------
  // Cache
  // -------------------------------------------------------------------------
  "agent.cacheStats": {
    params: void;
    response: { providers: Array<{ provider: string; model: string; callCount: number; totalCost: number; totalCacheSaved: number; cacheHitRate: number }>; totalCacheSaved: number };
  };

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------
  "models.list": {
    params: void;
    response: { models: Array<{ provider: string; model: string; available: boolean }> };
  };
  "models.test": {
    params: { provider: string };
    response: { success: boolean; message?: string; latencyMs?: number };
  };

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------
  "tokens.list": {
    params: void;
    response: { tokens: Array<{ id: string; label?: string; scopes: string[]; createdAt: number; expiresAt?: number }> };
  };
  "tokens.create": {
    params: { label?: string; scopes?: string[]; expiresIn?: number };
    response: { id: string; secret: string };
  };
  "tokens.revoke": {
    params: { id: string };
    response: { revoked: boolean };
  };
  "tokens.rotate": {
    params: { id: string };
    response: { id: string; secret: string; scopes: string[] };
  };

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------
  "admin.approval.pending": {
    params: void;
    response: { requests: Array<{ id: string; type: string; status: string; data: Record<string, unknown>; createdAt: number }>; total: number };
  };
  "admin.approval.resolve": {
    params: { requestId: string; decision: "approve" | "deny"; reason?: string };
    response: { resolved: boolean };
  };

  // -------------------------------------------------------------------------
  // Bulk Approvals
  // -------------------------------------------------------------------------
  "admin.approval.resolveAll": {
    params: { sessionKey?: string; approved: boolean; approvedBy?: string; reason?: string };
    response: { resolved: number; requestIds: string[] };
  };
  "admin.approval.clearDenialCache": {
    params: { sessionKey?: string };
    response: { cleared: boolean };
  };

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------
  "skills.list": {
    params: { agentId?: string };
    response: { skills: Array<{ name: string; description?: string; type: string; source?: string }> };
  };
  "skills.upload": {
    params: { agentId: string; name: string; content: string };
    response: { uploaded: boolean };
  };
  "skills.delete": {
    params: { agentId: string; name: string };
    response: { deleted: boolean };
  };
  "skills.import": {
    params: { agentId: string; path: string };
    response: { ok: boolean; name?: string; fileCount?: number };
  };

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------
  "mcp.list": {
    params: void;
    response: { servers: McpServerListEntry[]; total: number };
  };
  "mcp.status": {
    params: { name: string };
    response: McpServerDetail;
  };
  "mcp.connect": {
    params: McpConnectParams;
    response: McpConnectResponse;
  };
  "mcp.disconnect": {
    params: { name: string };
    response: { name: string; status: "disconnected" };
  };
  "mcp.reconnect": {
    params: { name: string };
    response: McpConnectResponse;
  };
  "mcp.test": {
    params: { name: string };
    response: { success: boolean; message?: string };
  };

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------
  "heartbeat.states": {
    params: Record<string, unknown>;
    response: { agents: HeartbeatAgentStateDto[] };
  };
  "heartbeat.trigger": {
    params: { agentId: string };
    response: { triggered: boolean };
  };
  "heartbeat.get": {
    params: { agentId: string };
    response: HeartbeatAgentStateDto;
  };
  "heartbeat.update": {
    params: { agentId: string; config: Record<string, unknown> };
    response: { updated: boolean };
  };

  // -------------------------------------------------------------------------
  // Cron / Scheduler
  // -------------------------------------------------------------------------
  "cron.list": {
    params: Record<string, unknown>;
    response: { jobs: Array<Record<string, unknown>> };
  };
  "cron.add": {
    params: Record<string, unknown>;
    response: { jobId: string };
  };
  "cron.update": {
    params: Record<string, unknown>;
    response: { updated: boolean };
  };
  "cron.remove": {
    params: { jobId: string; _agentId?: string };
    response: { removed: boolean };
  };
  "cron.status": {
    params: void;
    response: { running: boolean; jobCount: number };
  };
  "cron.runs": {
    params: { jobId?: string; limit?: number };
    response: { runs: Array<Record<string, unknown>> };
  };
  "cron.run": {
    params: { id: string };
    response: { triggered: boolean };
  };

  // -------------------------------------------------------------------------
  // Graph / Pipeline
  // -------------------------------------------------------------------------
  "graph.define": {
    params: { nodes: PipelineNode[]; edges?: PipelineEdge[]; settings?: Partial<GraphSettings> };
    response: Record<string, unknown>;
  };
  "graph.execute": {
    params: Record<string, unknown>;
    response: { graphId: string };
  };
  "graph.list": {
    params: { limit?: number };
    response: { graphs: SavedGraphSummary[] };
  };
  "graph.load": {
    params: { id: string };
    response: SavedGraphDetail;
  };
  "graph.save": {
    params: { label: string; nodes: PipelineNode[]; edges: PipelineEdge[]; settings: GraphSettings; id?: string };
    response: { id: string };
  };
  "graph.status": {
    params: Record<string, unknown>;
    response: { graphs: Array<{ graphId: string; status: string; nodes: MonitorNodeState[] }> };
  };
  "graph.cancel": {
    params: { graphId: string };
    response: { cancelled: boolean };
  };
  "graph.delete": {
    params: { id: string };
    response: { deleted: boolean };
  };
  "graph.runs": {
    params: { limit?: number };
    response: { runs: GraphRunSummary[] };
  };
  "graph.runDetail": {
    params: { graphId: string };
    response: GraphRunDetail;
  };
  "graph.deleteRun": {
    params: { graphId: string };
    response: { deleted: boolean };
  };

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------
  "message.send": {
    params: { channel_type: string; channel_id: string; text: string };
    response: { messageId: string; channelId: string };
  };
  "message.reply": {
    params: { channel_type: string; channel_id: string; text: string; message_id: string };
    response: { messageId: string; channelId: string };
  };
  "message.edit": {
    params: { channel_type: string; channel_id: string; message_id: string; text: string };
    response: { edited: boolean; channelId: string; messageId: string };
  };
  "message.delete": {
    params: { channel_type: string; channel_id: string; message_id: string };
    response: { deleted: boolean; channelId: string; messageId: string };
  };
  "message.fetch": {
    params: { channel_type: string; channel_id: string; limit?: number; before?: string };
    response: { messages: Array<Record<string, unknown>>; channelId: string };
  };
  "message.attach": {
    params: { channel_type: string; channel_id: string; attachment_url: string; attachment_type?: "image" | "file" | "audio" | "video"; mime_type?: string; file_name?: string; caption?: string };
    response: { messageId: string; channelId: string };
  };
  "message.react": {
    params: { channel_type: string; channel_id: string; message_id: string; emoji: string };
    response: { reacted: boolean; channelId: string; messageId: string; emoji: string };
  };

  // -------------------------------------------------------------------------
  // Platform Actions
  // -------------------------------------------------------------------------
  "discord.action": {
    params: { action: string; channel_id?: string; message_id?: string; [key: string]: unknown };
    response: unknown;
  };
  "telegram.action": {
    params: { action: string; chat_id?: string; message_id?: string; [key: string]: unknown };
    response: unknown;
  };
  "slack.action": {
    params: { action: string; channel_id?: string; message_id?: string; [key: string]: unknown };
    response: unknown;
  };
  "whatsapp.action": {
    params: { action: string; group_jid?: string; [key: string]: unknown };
    response: unknown;
  };

  // -------------------------------------------------------------------------
  // Media Test
  // -------------------------------------------------------------------------
  "media.test.stt": {
    params: { audio: string; mimeType: string; provider?: string; language?: string };
    response: SttTestResult;
  };
  "media.test.tts": {
    params: { text: string; provider?: string; voice?: string; format?: string };
    response: TtsTestResult;
  };
  "media.test.vision": {
    params: { image: string; mimeType: string; prompt?: string; provider?: string };
    response: VisionTestResult;
  };
  "media.test.document": {
    params: { file: string; mimeType: string; fileName?: string };
    response: DocumentTestResult;
  };
  "media.test.video": {
    params: { video: string; mimeType: string; prompt?: string; provider?: string };
    response: VideoTestResult;
  };
  "media.test.link": {
    params: { url: string };
    response: LinkTestResult;
  };
  "media.providers": {
    params: void;
    response: MediaProvidersInfo;
  };

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  "audio.transcribe": {
    params: { audio: string; format: string };
    response: { text: string };
  };

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------
  "context.search": {
    params: Record<string, unknown>;
    response: unknown;
  };
  "context.inspect": {
    params: { id: string };
    response: { type: string; summaryId?: string; content: string; depth?: number; kind?: string; tokenCount?: number; parentIds?: string[]; childIds?: string[]; sourceMessageCount?: number };
  };
  "context.recall": {
    params: Record<string, unknown>;
    response: unknown;
  };
  "context.expand": {
    params: Record<string, unknown>;
    response: unknown;
  };
  "context.conversations": {
    params: { limit?: number; offset?: number } | void;
    response: { conversations: DagConversation[]; total: number };
  };
  "context.tree": {
    params: { conversation_id: string };
    response: { conversationId: string; nodes: DagTreeNode[]; messageCount: number };
  };
  "context.searchByConversation": {
    params: { conversation_id: string; query: string; limit?: number };
    response: { results: Array<{ id: string; type: "message" | "summary"; content: string; rank?: number }> };
  };

  // -------------------------------------------------------------------------
  // Browser
  // -------------------------------------------------------------------------
  "browser.status": { params: void; response: Record<string, unknown> };
  "browser.start": { params: Record<string, unknown>; response: Record<string, unknown> };
  "browser.stop": { params: void; response: Record<string, unknown> };
  "browser.navigate": { params: { url: string }; response: Record<string, unknown> };
  "browser.snapshot": { params: void; response: Record<string, unknown> };
  "browser.screenshot": { params: void; response: Record<string, unknown> };
  "browser.pdf": { params: void; response: Record<string, unknown> };
  "browser.act": { params: Record<string, unknown>; response: Record<string, unknown> };
  "browser.tabs": { params: void; response: Record<string, unknown> };
  "browser.open": { params: { url: string }; response: Record<string, unknown> };
  "browser.focus": { params: { tabId: string }; response: Record<string, unknown> };
  "browser.close": { params: { tabId: string }; response: Record<string, unknown> };
  "browser.console": { params: void; response: Record<string, unknown> };

  // -------------------------------------------------------------------------
  // Subagent
  // -------------------------------------------------------------------------
  "subagent.list": {
    params: { recentMinutes?: number };
    response: { runs: SubAgentRunDto[]; total: number };
  };
  "subagent.kill": {
    params: { target: string };
    response: { killed: boolean };
  };
  "subagent.steer": {
    params: { graphId: string; nodeId: string; instruction: string };
    response: { steered: boolean };
  };

  // -------------------------------------------------------------------------
  // Daemon
  // -------------------------------------------------------------------------
  "daemon.setLogLevel": {
    params: { level: string; module?: string };
    response: { set: boolean };
  };

  // -------------------------------------------------------------------------
  // Workspace
  // -------------------------------------------------------------------------
  "workspace.status": {
    params: { agentId: string };
    response: Record<string, unknown>;
  };
  "workspace.readFile": {
    params: { agentId: string; path: string };
    response: { content: string };
  };
  "workspace.writeFile": {
    params: { agentId: string; path: string; content: string };
    response: { written: boolean };
  };
  "workspace.deleteFile": {
    params: { agentId: string; path: string };
    response: { deleted: boolean };
  };
  "workspace.listDir": {
    params: { agentId: string; path: string };
    response: { entries: Array<{ name: string; type: string; size?: number }> };
  };
  "workspace.resetFile": {
    params: { agentId: string; path: string };
    response: { reset: boolean };
  };
  "workspace.init": {
    params: { agentId: string };
    response: { initialized: boolean };
  };
  "workspace.git.status": {
    params: { agentId: string };
    response: Record<string, unknown>;
  };
  "workspace.git.log": {
    params: { agentId: string; limit?: number };
    response: { commits: Array<Record<string, unknown>> };
  };
  "workspace.git.diff": {
    params: { agentId: string; ref?: string };
    response: { diff: string };
  };
  "workspace.git.commit": {
    params: { agentId: string; message: string };
    response: { committed: boolean };
  };
  "workspace.git.checkout": {
    params: { agentId: string; ref: string };
    response: { checked: boolean };
  };
  "workspace.git.stash": {
    params: { agentId: string };
    response: { stashed: boolean };
  };
  "workspace.git.unstash": {
    params: { agentId: string };
    response: { unstashed: boolean };
  };
  "workspace.git.reset": {
    params: { agentId: string; ref?: string };
    response: { reset: boolean };
  };
}

// ---------------------------------------------------------------------------
// Helper Types
// ---------------------------------------------------------------------------

/** Union of all valid RPC method names. */
export type RpcMethod = keyof RpcMethodMap;

/** Extract the parameter type for a given RPC method. */
export type RpcParams<M extends RpcMethod> = RpcMethodMap[M]["params"];

/** Extract the response type for a given RPC method. */
export type RpcResponse<M extends RpcMethod> = RpcMethodMap[M]["response"];

/**
 * Type-safe RPC call signature.
 *
 * Methods with `params: void` can be called with no arguments.
 * All others require their params object.
 */
export type TypedRpcCall = <M extends RpcMethod>(
  method: M,
  ...args: RpcParams<M> extends void ? [] : [params: RpcParams<M>]
) => Promise<RpcResponse<M>>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a type-safe RPC call wrapper around an existing RpcClient.
 *
 * The wrapper enforces method name and parameter types at compile time
 * while delegating to the underlying untyped `rpcClient.call()` at runtime.
 *
 * @example
 * ```ts
 * const typedRpc = createTypedRpc(rpcClient);
 * const { agents } = await typedRpc("agents.list");
 * //     ^? AgentInfo[]  -- inferred from RpcMethodMap
 * ```
 */
export function createTypedRpc(rpc: RpcClient): TypedRpcCall {
  return ((method: string, params?: unknown) => rpc.call(method, params)) as TypedRpcCall;
}
