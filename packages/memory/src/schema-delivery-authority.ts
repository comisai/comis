// SPDX-License-Identifier: Apache-2.0
// @allow-throw: delivery schema preflight rejects authority-incomplete databases before boot; initSchema is consumed at the daemon boundary.
import type Database from "better-sqlite3";
import { requireTableInfoRows } from "./schema-introspection.js";

const REQUIRED_DELIVERY_COLUMNS = {
  delivery_queue: [
    "id", "text", "channel_type", "channel_id", "tenant_id", "agent_id",
    "conversation_ref", "destination_endpoint", "options_json", "origin",
    "status", "attempt_count", "max_attempts", "created_at", "scheduled_at",
    "expire_at", "last_attempt_at", "next_retry_at", "last_error", "trace_id",
  ],
  delivery_mirror: [
    "id", "tenant_id", "agent_id", "conversation_ref", "destination_endpoint",
    "text", "media_urls", "channel_type", "channel_id", "origin",
    "idempotency_key", "status", "created_at", "acknowledged_at",
  ],
  obs_delivery: [
    "id", "timestamp", "trace_id", "tenant_id", "agent_id", "conversation_ref",
    "destination_endpoint", "channel_type", "channel_id", "session_key", "status",
    "latency_ms", "error_message", "message_preview", "tool_calls", "llm_calls",
    "tokens_total", "cost_total",
  ],
} as const;

/** Reject delivery tables that cannot represent the exact persisted authority contract. */
export function preflightDeliveryAuthorityTables(db: Database.Database): void {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_DELIVERY_COLUMNS)) {
    const exists = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) !== undefined;
    if (!exists) continue;

    const columns = new Set(
      requireTableInfoRows(db.prepare(`PRAGMA table_info(${table})`).all(), table)
        .map((row) => row.name),
    );
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `${table} database schema is incompatible: missing ${missing.join(", ")}. Back up the database, then recreate it with the current Comis schema.`,
      );
    }
  }
}
