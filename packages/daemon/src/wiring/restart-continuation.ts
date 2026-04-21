// SPDX-License-Identifier: Apache-2.0
/**
 * Restart continuation: capture active sessions on shutdown, replay on startup.
 * When the daemon shuts down via SIGUSR2 (config-change restart), recently-active
 * sessions are written to a JSON file. On startup, synthetic inbound messages are
 * injected for each record so the LLM auto-resumes in-progress conversations.
 * @module
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import type { ComisLogger } from "@comis/infra";
import type { McpConnection } from "@comis/skills";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single session to resume after daemon restart. */
export interface ContinuationRecord {
  agentId: string;
  channelType: string;
  channelId: string;
  userId: string;
  peerId?: string;
  guildId?: string;
  threadId?: string;
  tenantId: string;
  timestamp: number;
}

/** In-memory tracker for recently-active sessions. */
export interface RestartContinuationTracker {
  /** Upsert a session record (called after each successful inbound message). */
  track(record: ContinuationRecord): void;
  /** Check if a session has been active since the tracker was created. */
  isTracked(record: Pick<ContinuationRecord, "channelType" | "channelId" | "userId" | "peerId">): boolean;
  /** Write recent records to disk. Returns the count written. */
  capture(filePath: string, recentWindowMs: number): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory tracker that stores the most recent activity per session.
 * On shutdown, `capture()` writes records within the recent window to a JSON file.
 */
export function createRestartContinuationTracker(): RestartContinuationTracker {
  const records = new Map<string, ContinuationRecord>();

  function makeKey(r: ContinuationRecord): string {
    return `${r.channelType}:${r.channelId}:${r.userId}:${r.peerId ?? ""}`;
  }

  return {
    track(record) {
      records.set(makeKey(record), { ...record, timestamp: Date.now() });
    },

    isTracked(record) {
      return records.has(makeKey(record as ContinuationRecord));
    },

    capture(filePath, recentWindowMs) {
      const now = Date.now();
      const recent = Array.from(records.values()).filter(
        (r) => now - r.timestamp < recentWindowMs,
      );
      if (recent.length === 0) return 0;
      writeFileSync(filePath, JSON.stringify(recent, null, 2), "utf-8");
      return recent.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Load + consume
// ---------------------------------------------------------------------------

/**
 * Load continuation records from disk, filter stale entries, delete the file.
 * @param filePath - Path to the continuation JSON file.
 * @param staleTtlMs - Maximum age in ms before a record is considered stale (default 5 min).
 * @param logger - Logger for warnings on parse errors.
 * @returns Non-stale continuation records (empty array if file missing or corrupt).
 */
export function loadContinuations(
  filePath: string,
  staleTtlMs: number,
  logger: ComisLogger,
): ContinuationRecord[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: ContinuationRecord[] = JSON.parse(raw);
    unlinkSync(filePath);
    const now = Date.now();
    const valid = parsed.filter((r) => now - r.timestamp < staleTtlMs);
    const discarded = parsed.length - valid.length;
    if (discarded > 0) {
      logger.debug(
        { discarded, total: parsed.length },
        "Discarded stale continuation records",
      );
    }
    return valid;
  } catch (err) {
    logger.warn(
      {
        err,
        filePath,
        hint: "Continuation file may be corrupted; skipping replay",
        errorKind: "internal" as const,
      },
      "Failed to load continuation records",
    );
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore cleanup failure */
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// MCP status line
// ---------------------------------------------------------------------------

const MCP_ERROR_TRUNCATE = 120;
const MCP_MAX_NAMES = 5;

/**
 * Build a one-line `[MCP Status]` summary for the synthetic restart message.
 *
 * Returns `undefined` when every connection is healthy so the happy path stays
 * quiet. The agent LLM reads this line and self-corrects instead of claiming
 * success for servers that never completed handshake after a config-change
 * restart.
 *
 * Only `status === "error"` connections are reported. Transient states
 * (`reconnecting`, `disconnected`) are already handled by the manager's
 * reconnect loop and would spam the agent on normal network hiccups.
 *
 * @param connections - All known MCP connections (typically from `McpClientManager.getAllConnections()`).
 * @returns A formatted status line, or `undefined` when no connections are errored.
 */
export function buildMcpStatusLine(connections: readonly McpConnection[]): string | undefined {
  const failed = connections.filter((c) => c.status === "error");
  if (failed.length === 0) return undefined;

  const shown = failed.slice(0, MCP_MAX_NAMES).map((c) => {
    const raw = (c.error ?? "").trim();
    const msg = raw.length === 0 ? "unknown error" : raw;
    const truncated = msg.length > MCP_ERROR_TRUNCATE ? `${msg.slice(0, MCP_ERROR_TRUNCATE)}…` : msg;
    return `${c.name} (${truncated})`;
  });
  const overflow = failed.length - shown.length;
  const suffix = overflow > 0 ? `, +${overflow} more` : "";
  return `[MCP Status] ${failed.length} server(s) failed to connect: ${shown.join(", ")}${suffix}`;
}
