// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore snake_case DB row interfaces (what SQLite returns) + the
 * camelCase row-mapping helpers (`*FromRow`).
 *
 * Extracted from `observability-store-types.ts` to keep that file under the
 * 500-line per-subdirectory cap. The canonical names are unchanged and are
 * re-exported from `observability-store-types.ts`, so consumers (queries /
 * mutations / the barrel) keep importing them from there — no import churn.
 *
 * Pure declarations + pure functions (no DB binding) so the leaf modules import
 * without a cycle through the barrel. The domain (camelCase) row types are
 * imported type-only from `observability-store-types.ts`.
 *
 * @module
 */

import type {
  TokenUsageRow,
  DeliveryRow,
  DiagnosticRow,
  ChannelSnapshotRow,
  SystemPromptReportRow,
} from "./observability-store-types.js";

// ---------------------------------------------------------------------------
// snake_case row types (internal: what SQLite returns)
// ---------------------------------------------------------------------------

export interface TokenUsageDbRow {
  id: number;
  timestamp: number;
  trace_id: string;
  agent_id: string;
  channel_id: string;
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
  // PERSIST-02 columns (nullable — pre-migration rows / omitted inserts are NULL).
  warmup_turn: number | null;
  cache_eligible: number | null;
  cost_correction: number | null;
  pending_cache_investment_usd: number | null;
  pricing_state: string | null;
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

/** snake_case DB row matching SystemPromptReportDbRowSchema. */
export interface SystemPromptReportDbRow {
  agent_id: string;
  tenant_id: string | null;
  session_id: string;
  run_id: string | null;
  generated_at: number;
  provider: string | null;
  model: string | null;
  system_chars: number;
  system_sha256: string;
  report_json: string;
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
    // PERSIST-02: INTEGER 0/1 ↔ boolean for the two flags (NULL → undefined);
    // REAL/TEXT passthroughs (NULL → undefined) for the rest.
    warmupTurn: row.warmup_turn === null ? undefined : row.warmup_turn === 1,
    cacheEligible: row.cache_eligible === null ? undefined : row.cache_eligible === 1,
    costCorrection: row.cost_correction === null ? undefined : row.cost_correction,
    pendingCacheInvestmentUsd:
      row.pending_cache_investment_usd === null ? undefined : row.pending_cache_investment_usd,
    pricingState:
      row.pricing_state === null ? undefined : (row.pricing_state as "priced" | "free" | "unknown"),
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

export function systemPromptReportFromRow(row: SystemPromptReportDbRow): SystemPromptReportRow {
  return {
    agentId: row.agent_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    runId: row.run_id,
    generatedAt: row.generated_at,
    provider: row.provider,
    model: row.model,
    systemChars: row.system_chars,
    systemSha256: row.system_sha256,
    reportJson: row.report_json,
  };
}
