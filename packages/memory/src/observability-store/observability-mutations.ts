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
import type { EventMap } from "@comis/core";
import { resolveModelPricing } from "@comis/core";
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
 * Map an `observability:cache_break` event to a content-free
 * `obs_diagnostics` row under `category:"cache_break"` (a DISTINCT
 * category, NOT "health_signal", so "rate by reason" is a clean
 * `GROUP BY json_extract(details,'$.reason')` over the existing
 * `idx_obs_diag_category` — NO new table). Mirrors the daemon's
 * `sandboxDowngradeRefusedEventToRow` row-builder mold.
 *
 * **est-$ is COMPUTED here.** The event carries NO
 * dollar field, so the rewrite premium is reconstructed as
 * `tokenDrop × max(0, cacheWrite - cacheRead)`: a catalog-priced
 * model yields a non-zero estimate; an unknown model yields 0 (ZERO_COST.cacheRead
 * === 0 — honest best-effort, never a fabricated cost). The companion
 * `pricing_state` column on `obs_token_usage` surfaces the unknown so
 * an operator sees coverage.
 *
 * **Content-free (the load-bearing constraint).** The event's `toolsAdded`/
 * `toolsRemoved`/`toolsSchemaChanged` are tool-NAME arrays (already MCP-sanitized to
 * bare `'mcp'` at the emit, but STILL names) — they are NEVER stored. They are
 * reduced to a `changedDimsDigest` carrying only the COUNTS of changed dimensions
 * (the SHAPE of the change) plus the numeric `systemCharDelta`, so no tool name or
 * system/query text crosses into a persisted row.
 */
export function cacheBreakEventToRow(
  payload: EventMap["observability:cache_break"],
): DiagnosticRow {
  // est-$: the event has no $ field, so compute the re-write cost from the catalog. The model may
  // be absent (`model?`) — fall back to "" so resolveModelPricing returns ZERO_COST (→ 0).
  const pricing = resolveModelPricing(payload.provider, payload.model ?? "");
  // The cost of a break is RE-WRITING the dropped prefix, not the read saving forgone: those bytes
  // must be paid at the cacheWrite rate where they would have been paid at cacheRead. The waste is
  // therefore the DELTA. Pricing the drop at the read rate alone understated it by (write/read - 1)
  // -- ~19x on Opus-class pricing -- so a live $30.64 cache incident surfaced as $0.46 of waste in
  // `comis explain` while the on-disk cache-break records, which already use the delta, totalled
  // $8.74 for the same events. Same number, two lenses, and the smaller one was the operator-facing
  // surface. An unknown model still yields 0 (ZERO_COST), and the delta is clamped at 0 so a catalog
  // whose cacheWrite is below cacheRead can never produce a negative cost.
  const deltaRate = Math.max(0, pricing.cacheWrite - pricing.cacheRead);
  const estCostUsd = payload.tokenDrop * deltaRate;

  return {
    timestamp: payload.timestamp,
    category: "cache_break",
    severity: "warning",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    message: "observability:cache_break",
    details: JSON.stringify({
      reason: payload.reason,
      prevCacheRead: payload.previousCacheRead,
      curCacheRead: payload.currentCacheRead,
      delta: payload.tokenDrop,
      // I3: COUNTS only — never the tool-name arrays. The shape of the change,
      // not its contents.
      changedDimsDigest: {
        added: payload.toolsAdded?.length ?? 0,
        removed: payload.toolsRemoved?.length ?? 0,
        schemaChanged: payload.toolsSchemaChanged?.length ?? 0,
        systemCharDelta: payload.systemCharDelta ?? 0,
      },
      estCostUsd,
    }),
    traceId: undefined,
  };
}

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
  // DROPPED (dead); the 5 cost-correctness columns + the
  // tool_tag column were added at the tail (27 cols / 27 placeholders / 27 args).
  const insertTokenUsageStmt = db.prepare(`
    INSERT INTO obs_token_usage (
      timestamp, trace_id, agent_id, channel_id, session_key,
      provider, model, prompt_tokens, completion_tokens, total_tokens,
      cache_read_tokens, cache_write_tokens, cost_input, cost_output, cost_total,
      cost_cache_read, cost_cache_write, cache_saved, latency_ms,
      warmup_turn, cache_eligible, cost_correction, pending_cache_investment_usd, pricing_state,
      cache_write_5m_tokens, cache_write_1h_tokens,
      tool_tag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDeliveryStmt = db.prepare(`
    INSERT INTO obs_delivery (
      timestamp, trace_id, tenant_id, agent_id, conversation_ref, destination_endpoint,
      channel_type, channel_id, session_key,
      status, latency_ms, error_message, message_preview,
      failure_stage, error_kind, tool_calls, llm_calls, tokens_total, cost_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      // Cost-correctness columns (in the same order as the column list).
      // SQLite has no boolean — the two flags coerce to 0/1; nulls when absent.
      entry.warmupTurn === undefined ? null : entry.warmupTurn ? 1 : 0,
      entry.cacheEligible === undefined ? null : entry.cacheEligible ? 1 : 0,
      entry.costCorrection ?? null,
      entry.pendingCacheInvestmentUsd ?? null,
      entry.pricingState ?? null,
      entry.cacheWrite5mTokens ?? null,
      entry.cacheWrite1hTokens ?? null,
      // The JSON-stringified DISTINCT tool array (content-free names);
      // NULL when the turn fired no tool. Already de-duped at the emit.
      entry.toolTag === undefined ? null : JSON.stringify(entry.toolTag),
    );
  }

  function insertDelivery(entry: DeliveryRow): void {
    insertDeliveryStmt.run(
      entry.timestamp,
      entry.traceId,
      entry.tenantId,
      entry.agentId,
      entry.conversationRef,
      JSON.stringify(entry.destinationEndpoint),
      entry.channelType,
      entry.channelId,
      entry.sessionKey ?? "",
      entry.status,
      entry.latencyMs,
      entry.errorMessage ?? "",
      entry.messagePreview ?? "",
      entry.failureStage ?? null,
      entry.errorKind ?? null,
      entry.toolCalls ?? null,
      entry.llmCalls ?? null,
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
      entry.channelId,
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
