/**
 * Session compaction service.
 *
 * Summarizes old conversations into episodic memories and extracts facts
 * into semantic memories, keeping working memory bounded while preserving
 * important information.
 *
 * The summarizer is pluggable -- the actual LLM call will be wired in
 * Phase 3 (Agent). This module defines the interface and orchestrates
 * the compaction workflow.
 *
 * Workflow:
 * 1. Find sessions idle for longer than minIdleMs
 * 2. For each stale session:
 *    a. Call summarizer(messages) -> { summary, facts }
 *    b. Store summary as episodic memory
 *    c. Store each fact as semantic memory
 *    d. Archive original messages with retention period
 *    e. Delete the session
 * 3. Return compaction statistics
 */

import type Database from "better-sqlite3";
import type { HookRunner, SessionKey } from "@comis/core";
import type { SessionStore } from "./session-store.js";
import type { SqliteMemoryAdapter } from "./sqlite-memory-adapter.js";

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Pluggable summarizer function. Takes conversation messages and returns
 * a summary string plus extracted facts. The actual LLM call is wired
 * in Phase 3 (Agent).
 */
export type Summarizer = (messages: unknown[]) => Promise<{ summary: string; facts: string[] }>;

/**
 * Options controlling compaction behavior.
 */
export interface CompactionOptions {
  /** Minimum idle time (ms) before a session is eligible for compaction. Default: 4 hours. */
  minIdleMs: number;
  /** How long archived messages are retained (ms). Default: 7 days. */
  archiveRetentionMs: number;
  /** Optional tenant scope -- only compact sessions for this tenant. */
  tenantId?: string;
}

/**
 * Statistics returned after a compaction run.
 */
export interface CompactionResult {
  /** Number of sessions compacted. */
  sessionsCompacted: number;
  /** Number of episodic memories created (one per session). */
  episodicCreated: number;
  /** Total number of semantic (fact) memories created. */
  factsExtracted: number;
  /** Session keys that were compacted. */
  compactedKeys: string[];
}

/**
 * CompactionService manages the lifecycle of stale session compaction.
 */
export interface CompactionService {
  /**
   * Run compaction on eligible sessions.
   * Only sessions idle for longer than `minIdleMs` are compacted.
   */
  compact(options?: Partial<CompactionOptions>): Promise<CompactionResult>;

  /**
   * Purge archives whose retention period has expired.
   * @returns Number of archive rows deleted.
   */
  purgeArchives(): number;
}

// ── Default Options ────────────────────────────────────────────────────

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_OPTIONS: CompactionOptions = {
  minIdleMs: FOUR_HOURS_MS,
  archiveRetentionMs: SEVEN_DAYS_MS,
};

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Create a compaction service bound to the given database, session store,
 * memory adapter, and summarizer function.
 *
 * @param db - An open better-sqlite3 Database with initialized schema (including archives table)
 * @param sessionStore - SessionStore for listing/deleting sessions
 * @param adapter - SqliteMemoryAdapter for storing episodic/semantic memories
 * @param summarizer - Pluggable function to summarize messages and extract facts
 * @param hookRunner - Optional hook runner for lifecycle hooks (no-op when absent)
 * @param agentId - Optional agent identifier for hook context
 */
export function createCompactionService(
  db: Database.Database,
  sessionStore: SessionStore,
  adapter: SqliteMemoryAdapter,
  summarizer: Summarizer,
  hookRunner?: HookRunner,
  agentId?: string,
): CompactionService {
  // Prepared statements for archive operations
  const insertArchiveStmt = db.prepare(
    "INSERT INTO archives (session_key, messages, archived_at, expires_at) VALUES (?, ?, ?, ?)",
  );

  const purgeStmt = db.prepare("DELETE FROM archives WHERE expires_at < ?");

  return {
    async compact(options?: Partial<CompactionOptions>): Promise<CompactionResult> {
      const opts: CompactionOptions = { ...DEFAULT_OPTIONS, ...options };
      const now = Date.now();
      const cutoff = now - opts.minIdleMs;

      // List sessions, optionally scoped by tenant
      const sessions = sessionStore.list(opts.tenantId);

      const result: CompactionResult = {
        sessionsCompacted: 0,
        episodicCreated: 0,
        factsExtracted: 0,
        compactedKeys: [],
      };

      for (const entry of sessions) {
        // Skip sessions that are still active (updated recently)
        if (entry.updatedAt > cutoff) {
          continue;
        }

        // Load the full session to get messages
        // We need to parse the session key back into a SessionKey object.
        // Session keys are formatted as "tenantId:userId:channelId[:peer:peerId][:guild:guildId]"
        const parts = parseSessionKeyString(entry.sessionKey);
        if (!parts) continue;

        const sessionData = sessionStore.load(parts);
        if (!sessionData || sessionData.messages.length === 0) {
          continue;
        }

        // Run before_compaction hook -- may cancel this compaction cycle
        // Hook errors are caught internally by the runner (catchErrors: true)
        const compactionHookResult = await hookRunner?.runBeforeCompaction(
          {
            sessionKey: parts as SessionKey,
            messageCount: sessionData.messages.length,
            estimatedTokens: undefined,
          },
          { agentId: agentId ?? "default" },
        );
        if (compactionHookResult?.cancel) {
          continue;
        }

        const compactionStartMs = Date.now();

        // Call the pluggable summarizer
        const { summary, facts } = await summarizer(sessionData.messages);

        // Store summary as episodic memory
        const episodicId = crypto.randomUUID();
        await adapter.storeWithType(
          {
            id: episodicId,
            tenantId: parts.tenantId,
            agentId: "default",
            userId: parts.userId,
            content: summary,
            trustLevel: "learned",
            source: {
              who: "compaction",
              channel: parts.channelId,
              sessionKey: entry.sessionKey,
            },
            tags: ["compaction", "episodic"],
            createdAt: now,
          },
          "episodic",
        );
        result.episodicCreated++;

        // Store each extracted fact as semantic memory
        for (const fact of facts) {
          const factId = crypto.randomUUID();
          await adapter.storeWithType(
            {
              id: factId,
              tenantId: parts.tenantId,
              agentId: "default",
              userId: parts.userId,
              content: fact,
              trustLevel: "learned",
              source: {
                who: "compaction",
                channel: parts.channelId,
                sessionKey: entry.sessionKey,
              },
              tags: ["compaction", "fact"],
              createdAt: now,
            },
            "semantic",
          );
          result.factsExtracted++;
        }

        // Archive original messages before deletion
        const archiveExpiresAt = now + opts.archiveRetentionMs;
        insertArchiveStmt.run(
          entry.sessionKey,
          JSON.stringify(sessionData.messages),
          now,
          archiveExpiresAt,
        );

        // Delete the session
        sessionStore.delete(parts);

        result.sessionsCompacted++;
        result.compactedKeys.push(entry.sessionKey);

        // Run after_compaction hook -- observability for compaction stats
        // Hook errors are caught internally by the runner (catchErrors: true)
        await hookRunner?.runAfterCompaction(
          {
            sessionKey: parts as SessionKey,
            removedCount: sessionData.messages.length,
            retainedCount: 0,
            durationMs: Date.now() - compactionStartMs,
          },
          { agentId: agentId ?? "default" },
        );
      }

      return result;
    },

    purgeArchives(): number {
      const now = Date.now();
      const info = purgeStmt.run(now);
      return info.changes;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Parse a formatted session key string back into a SessionKey-compatible object.
 * Format: "tenantId:userId:channelId[:peer:peerId][:guild:guildId]"
 */
function parseSessionKeyString(
  key: string,
): {
  tenantId: string;
  userId: string;
  channelId: string;
  peerId?: string;
  guildId?: string;
} | null {
  // Extract peer and guild suffixes first
  let remaining = key;
  let peerId: string | undefined;
  let guildId: string | undefined;

  const guildMatch = remaining.match(/:guild:([^:]+)$/);
  if (guildMatch) {
    guildId = guildMatch[1];
    remaining = remaining.slice(0, -guildMatch[0].length);
  }

  const peerMatch = remaining.match(/:peer:([^:]+)$/);
  if (peerMatch) {
    peerId = peerMatch[1];
    remaining = remaining.slice(0, -peerMatch[0].length);
  }

  // The remaining should be "tenantId:userId:channelId"
  const parts = remaining.split(":");
  if (parts.length < 3) return null;

  return {
    tenantId: parts[0]!,
    userId: parts[1]!,
    channelId: parts.slice(2).join(":"),
    ...(peerId !== undefined ? { peerId } : {}),
    ...(guildId !== undefined ? { guildId } : {}),
  };
}
