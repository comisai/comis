// SPDX-License-Identifier: Apache-2.0
/**
 * ObservabilityStore mutation helpers (WRITES).
 *
 * Each `bind*` function creates the prepared statements its methods need
 * (closure-captured) and returns the partial handle slice.
 *
 * @module
 */

import type Database from "better-sqlite3";
import type {
  ObservabilityStore,
  TokenUsageRow,
  DeliveryRow,
  DiagnosticRow,
  ChannelSnapshotRow,
  SystemPromptReportRow,
} from "./observability-store-types.js";

/** Shape of the subset of ObservabilityStore implemented by this module. */
export type ObservabilityMutations = Pick<
  ObservabilityStore,
  | "insertTokenUsage"
  | "insertDelivery"
  | "insertDiagnostic"
  | "insertChannelSnapshot"
  | "insertSystemPromptReport"
>;

/**
 * Prepare mutation statements and return the write-side slice of the
 * ObservabilityStore handle.
 *
 * @param db - An open better-sqlite3 Database instance with the
 *             observability schema initialized.
 */
export function bindMutations(db: Database.Database): ObservabilityMutations {
  // --- Prepared statements (fixed SQL, prepared once) ---

  // The column list + placeholders + .run() args MUST stay in lockstep with the
  // obs_token_usage schema (schema.ts ensureObsTokenColumns). cache_retention was
  // DROPPED (dead); the 5 PERSIST-02 cost-correctness columns were added at the tail.
  const insertTokenUsageStmt = db.prepare(`
    INSERT INTO obs_token_usage (
      timestamp, trace_id, agent_id, channel_id, session_key,
      provider, model, prompt_tokens, completion_tokens, total_tokens,
      cache_read_tokens, cache_write_tokens, cost_input, cost_output, cost_total,
      cost_cache_read, cost_cache_write, cache_saved, latency_ms,
      warmup_turn, cache_eligible, cost_correction, pending_cache_investment_usd, pricing_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDeliveryStmt = db.prepare(`
    INSERT INTO obs_delivery (
      timestamp, trace_id, agent_id, channel_type, channel_id, session_key,
      status, latency_ms, error_message, message_preview,
      tool_calls, llm_calls, tokens_total, cost_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDiagnosticStmt = db.prepare(`
    INSERT INTO obs_diagnostics (
      timestamp, category, severity, agent_id, session_key, message, details, trace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSnapshotStmt = db.prepare(`
    INSERT INTO obs_channel_snapshots (
      timestamp, channel_type, channel_id, status, messages_sent, messages_received, uptime_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // INSERT OR REPLACE so re-running the same (agent_id, session_id,
  // run_id, generated_at) tuple (e.g., retry path) updates the row in
  // place. The composite PK ensures a unique slot.
  const insertSystemPromptReportStmt = db.prepare(`
    INSERT OR REPLACE INTO system_prompt_reports (
      agent_id, tenant_id, session_id, run_id, generated_at,
      provider, model, system_chars, system_sha256, report_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // --- Bound methods ---

  function insertTokenUsage(entry: TokenUsageRow): void {
    insertTokenUsageStmt.run(
      entry.timestamp,
      entry.traceId,
      entry.agentId,
      entry.channelId ?? "",
      entry.sessionKey ?? "",
      entry.provider,
      entry.model,
      entry.promptTokens,
      entry.completionTokens,
      entry.totalTokens,
      entry.cacheReadTokens ?? 0,
      entry.cacheWriteTokens ?? 0,
      entry.costInput,
      entry.costOutput,
      entry.costTotal,
      entry.costCacheRead ?? 0,
      entry.costCacheWrite ?? 0,
      entry.cacheSaved ?? 0,
      entry.latencyMs,
      // PERSIST-02 cost-correctness columns (in the same order as the column list).
      // SQLite has no boolean — the two flags coerce to 0/1; nulls when absent.
      entry.warmupTurn === undefined ? null : entry.warmupTurn ? 1 : 0,
      entry.cacheEligible === undefined ? null : entry.cacheEligible ? 1 : 0,
      entry.costCorrection ?? null,
      entry.pendingCacheInvestmentUsd ?? null,
      entry.pricingState ?? null,
    );
  }

  function insertDelivery(entry: DeliveryRow): void {
    insertDeliveryStmt.run(
      entry.timestamp,
      entry.traceId,
      entry.agentId,
      entry.channelType,
      entry.channelId,
      entry.sessionKey ?? "",
      entry.status,
      entry.latencyMs,
      entry.errorMessage ?? "",
      entry.messagePreview ?? "",
      entry.toolCalls ?? 0,
      entry.llmCalls ?? 0,
      entry.tokensTotal ?? 0,
      entry.costTotal ?? 0,
    );
  }

  function insertDiagnostic(entry: DiagnosticRow): void {
    insertDiagnosticStmt.run(
      entry.timestamp,
      entry.category,
      entry.severity,
      entry.agentId ?? "",
      entry.sessionKey ?? "",
      entry.message,
      entry.details ?? "",
      entry.traceId ?? "",
    );
  }

  function insertChannelSnapshot(entry: ChannelSnapshotRow): void {
    insertSnapshotStmt.run(
      entry.timestamp,
      entry.channelType,
      entry.channelId ?? "",
      entry.status,
      entry.messagesSent ?? 0,
      entry.messagesReceived ?? 0,
      entry.uptimeMs ?? 0,
    );
  }

  function insertSystemPromptReport(entry: SystemPromptReportRow): void {
    insertSystemPromptReportStmt.run(
      entry.agentId,
      entry.tenantId,
      entry.sessionId,
      entry.runId,
      entry.generatedAt,
      entry.provider,
      entry.model,
      entry.systemChars,
      entry.systemSha256,
      entry.reportJson,
    );
  }

  return {
    insertTokenUsage,
    insertDelivery,
    insertDiagnostic,
    insertChannelSnapshot,
    insertSystemPromptReport,
  };
}
