// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore public types + internal snake_case row types + row-mapper
 * instances + camelCase row-shape converters.
 *
 * Pure declarations (no DB binding) so that the leaf modules can import
 * without creating a cycle through the barrel.
 *
 * @module
 */

import {
  TokenUsageDbRowSchema,
  DeliveryDbRowSchema,
  DiagnosticDbRowSchema,
  ChannelSnapshotDbRowSchema,
  ProviderAggDbRowSchema,
  AgentAggDbRowSchema,
  SessionAggDbRowSchema,
  HourlyBucketDbRowSchema,
  DeliveryStatsDbRowSchema,
} from "../row-schemas.js";
import { createRowMapper } from "../row-mapper.js";

// ---------------------------------------------------------------------------
// Row mappers (typed row parsing via createRowMapper)
//
// Module-level mappers, prepared once. Each mapper wraps a Zod schema and
// returns Result<TRow[]|TRow|undefined, MapperError> from raw better-sqlite3
// .all()/.get() output. On validation failure the store DEGRADES SILENTLY
// (empty array / undefined / zero-stats), preserving the existing return-shape
// contract: observability metrics are non-fatal — MapperError means "broken DB".
// ---------------------------------------------------------------------------

export const tokenUsageMapper = createRowMapper(TokenUsageDbRowSchema);
export const deliveryMapper = createRowMapper(DeliveryDbRowSchema);
export const diagnosticMapper = createRowMapper(DiagnosticDbRowSchema);
export const channelSnapshotMapper = createRowMapper(ChannelSnapshotDbRowSchema);
export const providerAggMapper = createRowMapper(ProviderAggDbRowSchema);
export const agentAggMapper = createRowMapper(AgentAggDbRowSchema);
export const sessionAggMapper = createRowMapper(SessionAggDbRowSchema);
export const hourlyBucketMapper = createRowMapper(HourlyBucketDbRowSchema);
export const deliveryStatsMapper = createRowMapper(DeliveryStatsDbRowSchema);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A token usage row (insert or query result). */
export interface TokenUsageRow {
  id?: number;
  timestamp: number;
  traceId: string;
  agentId: string;
  channelId?: string;
  executionId?: string;
  sessionKey?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costInput: number;
  costOutput: number;
  costTotal: number;
  costCacheRead: number;
  costCacheWrite: number;
  cacheSaved: number;
  latencyMs: number;
  /** Cache retention strategy for this call (workaround until explicit caching lands). */
  cacheRetention?: string | null;
}

/** A delivery row (insert or query result). */
export interface DeliveryRow {
  id?: number;
  timestamp: number;
  traceId: string;
  agentId: string;
  channelType: string;
  channelId: string;
  sessionKey?: string;
  status: string;
  latencyMs: number;
  errorMessage?: string;
  messagePreview?: string;
  toolCalls?: number;
  llmCalls?: number;
  tokensTotal?: number;
  costTotal?: number;
}

/** A diagnostic row (insert or query result). */
export interface DiagnosticRow {
  id?: number;
  timestamp: number;
  category: string;
  severity: string;
  agentId?: string;
  sessionKey?: string;
  message: string;
  details?: string;
  traceId?: string;
}

/** A channel snapshot row (insert or query result). */
export interface ChannelSnapshotRow {
  id?: number;
  timestamp: number;
  channelType: string;
  channelId?: string;
  status: string;
  messagesSent?: number;
  messagesReceived?: number;
  uptimeMs?: number;
}

/** Aggregation by provider and model. */
export interface ProviderAggregation {
  provider: string;
  model: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Aggregation by agent. */
export interface AgentAggregation {
  agentId: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Aggregation for a specific session. */
export interface SessionAggregation {
  sessionKey: string;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Hourly time bucket aggregation. */
export interface HourlyBucket {
  hour: number;
  totalCost: number;
  totalTokens: number;
  callCount: number;
  totalCacheSaved: number;
}

/** Delivery status breakdown statistics. */
export interface DeliveryStats {
  total: number;
  success: number;
  error: number;
  timeout: number;
  filtered: number;
  avgLatencyMs: number;
}

/** Valid observability table names (short form). */
export type ObsTableName = "token_usage" | "delivery" | "diagnostics" | "channels";

/** Result from resetAll() or prune(). */
export interface ResetResult {
  tokenUsage: number;
  delivery: number;
  diagnostics: number;
  channels: number;
}

/** Alias for ResetResult (same shape). */
export type PruneResult = ResetResult;

/** Query parameters for token usage queries. */
export interface TokenUsageQueryParams {
  sinceMs?: number;
  agentId?: string;
  provider?: string;
  sessionKey?: string;
  limit?: number;
}

/** Query parameters for delivery queries. */
export interface DeliveryQueryParams {
  sinceMs?: number;
  channelType?: string;
  status?: string;
  limit?: number;
}

/** Query parameters for diagnostic queries. */
export interface DiagnosticQueryParams {
  sinceMs?: number;
  category?: string;
  severity?: string;
  limit?: number;
}

/** The ObservabilityStore interface. */
export interface ObservabilityStore {
  // Token usage
  insertTokenUsage(entry: TokenUsageRow): void;
  queryTokenUsage(params?: TokenUsageQueryParams): TokenUsageRow[];
  aggregateByProvider(sinceMs?: number): ProviderAggregation[];
  aggregateByAgent(sinceMs?: number): AgentAggregation[];
  aggregateBySession(sessionKey: string, sinceMs?: number): SessionAggregation;
  aggregateHourly(sinceMs?: number): HourlyBucket[];

  // Delivery
  insertDelivery(entry: DeliveryRow): void;
  queryDelivery(params?: DeliveryQueryParams): DeliveryRow[];
  deliveryStats(sinceMs?: number): DeliveryStats;

  // Diagnostics
  insertDiagnostic(entry: DiagnosticRow): void;
  queryDiagnostics(params?: DiagnosticQueryParams): DiagnosticRow[];

  // Channel snapshots
  insertChannelSnapshot(entry: ChannelSnapshotRow): void;
  latestChannelSnapshots(): ChannelSnapshotRow[];

  // Maintenance
  prune(retentionDays: number): PruneResult;
  resetAll(): ResetResult;
  resetTable(table: ObsTableName): number;
}

// ---------------------------------------------------------------------------
// snake_case row types (internal: what SQLite returns)
// ---------------------------------------------------------------------------

export interface TokenUsageDbRow {
  id: number;
  timestamp: number;
  trace_id: string;
  agent_id: string;
  channel_id: string;
  execution_id: string;
  session_key: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_total: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cache_saved: number;
  latency_ms: number;
  cache_retention: string | null;
}

export interface DeliveryDbRow {
  id: number;
  timestamp: number;
  trace_id: string;
  agent_id: string;
  channel_type: string;
  channel_id: string;
  session_key: string;
  status: string;
  latency_ms: number;
  error_message: string;
  message_preview: string;
  tool_calls: number;
  llm_calls: number;
  tokens_total: number;
  cost_total: number;
}

export interface DiagnosticDbRow {
  id: number;
  timestamp: number;
  category: string;
  severity: string;
  agent_id: string;
  session_key: string;
  message: string;
  details: string;
  trace_id: string;
}

export interface ChannelSnapshotDbRow {
  id: number;
  timestamp: number;
  channel_type: string;
  channel_id: string;
  status: string;
  messages_sent: number;
  messages_received: number;
  uptime_ms: number;
}

// Aggregate row shapes (ProviderAggDbRow, AgentAggDbRow, SessionAggDbRow,
// HourlyBucketDbRow, DeliveryStatsDbRow) are defined as z.infer<> via the
// schemas in row-schemas.ts. The four DbRow interfaces above remain required
// as `xxxFromRow` parameter types.

// ---------------------------------------------------------------------------
// Row mapping helpers (snake_case DB rows -> camelCase domain rows)
// ---------------------------------------------------------------------------

export function tokenUsageFromRow(row: TokenUsageDbRow): TokenUsageRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    traceId: row.trace_id,
    agentId: row.agent_id,
    channelId: row.channel_id,
    executionId: row.execution_id,
    sessionKey: row.session_key,
    provider: row.provider,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    costInput: row.cost_input,
    costOutput: row.cost_output,
    costTotal: row.cost_total,
    costCacheRead: row.cost_cache_read,
    costCacheWrite: row.cost_cache_write,
    cacheSaved: row.cache_saved,
    latencyMs: row.latency_ms,
    cacheRetention: row.cache_retention,
  };
}

export function deliveryFromRow(row: DeliveryDbRow): DeliveryRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    traceId: row.trace_id,
    agentId: row.agent_id,
    channelType: row.channel_type,
    channelId: row.channel_id,
    sessionKey: row.session_key,
    status: row.status,
    latencyMs: row.latency_ms,
    errorMessage: row.error_message,
    messagePreview: row.message_preview,
    toolCalls: row.tool_calls,
    llmCalls: row.llm_calls,
    tokensTotal: row.tokens_total,
    costTotal: row.cost_total,
  };
}

export function diagnosticFromRow(row: DiagnosticDbRow): DiagnosticRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    category: row.category,
    severity: row.severity,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    message: row.message,
    details: row.details,
    traceId: row.trace_id,
  };
}

export function snapshotFromRow(row: ChannelSnapshotDbRow): ChannelSnapshotRow {
  return {
    id: row.id,
    timestamp: row.timestamp,
    channelType: row.channel_type,
    channelId: row.channel_id,
    status: row.status,
    messagesSent: row.messages_sent,
    messagesReceived: row.messages_received,
    uptimeMs: row.uptime_ms,
  };
}

// ---------------------------------------------------------------------------
// Table name mapping
// ---------------------------------------------------------------------------

export const TABLE_MAP: Record<ObsTableName, string> = {
  token_usage: "obs_token_usage",
  delivery: "obs_delivery",
  diagnostics: "obs_diagnostics",
  channels: "obs_channel_snapshots",
};
