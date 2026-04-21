// SPDX-License-Identifier: Apache-2.0
/**
 * Comis Session Manager: Unified session wrapper delegating to SDK SessionManager.
 *
 * Absorbs the lifecycle management into a single
 * interface. Each `withSession` call acquires a per-session write lock,
 * creates or opens the session file via the SDK's SessionManager, executes
 * the callback, sanitizes secrets, and releases the lock.
 *
 * Key design decisions:
 * - `SdkSessionManager.open(explicitPath)` handles both new and existing files:
 *   existing files are loaded directly; non-existent files get an in-memory
 *   header with deferred persistence (SDK writes on first assistant message).
 * - Per-session write lock via `withSessionLock()` wraps the entire execution.
 *
 * @module
 */

import { SessionManager as SdkSessionManager } from "@mariozechner/pi-coding-agent";
import { formatSessionKey, safePath, type SessionKey } from "@comis/core";
import { suppressError, type Result } from "@comis/shared";
import { mkdir, unlink, rm } from "node:fs/promises";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionKeyToPath } from "./session-key-mapper.js";
import { withSessionLock } from "./session-write-lock.js";
import { sanitizeSessionSecrets } from "./sanitize-session-secrets.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Dependencies for the Comis session manager. */
export interface ComisSessionManagerDeps {
  /** Per-agent sessions directory (e.g., ~/.comis/agents/{agentId}/sessions/) */
  sessionBaseDir: string;
  /** Lock files directory (e.g., ~/.comis/agents/{agentId}/.locks/) */
  lockDir: string;
  /** Workspace directory for SessionManager (stored in session header cwd field) */
  cwd: string;
}

/**
 * Session metadata written as a companion file alongside the JSONL.
 * The SDK controls the JSONL format, so enrichment data (traceId, runId, session_end)
 * is stored in `_session-metadata.json` next to the `.jsonl` file.
 */
export interface SessionMetadata {
  /** Trace ID for cross-correlating with daemon logs */
  traceId?: string;
  /** Execution run ID */
  runId?: string;
  /** Session end marker with completion details */
  sessionEnd?: {
    type: "session_end";
    timestamp: string;
    endReason: "success" | "error" | "timeout" | "budget_exceeded" | "budget_exhausted" | "circuit_open" | "provider_degraded";
    durationMs: number;
    totalTokens: number;
  };
}

/** Session stats returned by getSessionStats(). */
export interface SessionStats {
  messageCount: number;
  createdAt?: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: number;
  /** Per-role message counts for enriched /status display. */
  userMessages?: number;
  assistantMessages?: number;
  /** Count of tool call content blocks within assistant messages. */
  toolCalls?: number;
  /** Count of tool result messages. */
  toolResults?: number;
}

/** Comis session manager for create/open/lock lifecycle management. */
export interface ComisSessionManager {
  /**
   * Execute a callback within a locked session context.
   *
   * Acquires a per-session write lock, opens or creates the session file,
   * and passes the SDK SessionManager to the callback. Concurrent calls on
   * the same sessionKey are serialized. Different sessions do not block each other.
   *
   * SDK SessionManager.open() reads pre-existing JSONL session files at the
   * mapped path, ensuring backward compatibility with sessions created by
   * previous session files.
   *
   * @param sessionKey - Comis session key identifying the conversation
   * @param fn - Callback that receives the SDK SessionManager and returns a result
   * @returns ok(result) on success, err("locked") if lock exhausted, err("error") on failure
   */
  withSession<T>(
    sessionKey: SessionKey,
    fn: (sm: SdkSessionManager) => Promise<T>,
  ): Promise<Result<T, "locked" | "error">>;

  /**
   * Destroy a JSONL session file, forcing the next withSession to create a fresh one.
   * Used by /new and /reset commands for pi-executor agents.
   */
  destroySession(sessionKey: SessionKey): Promise<void>;

  /**
   * Read session stats from an existing JSONL session file without acquiring a write lock.
   * Used by /status command for pi-executor agents.
   * Returns undefined if the session file does not exist.
   */
  getSessionStats(sessionKey: SessionKey): SessionStats | undefined;

  /**
   * Write session metadata to a companion JSON file.
   *
   * Writes `_session-metadata.json` alongside the JSONL file with traceId,
   * runId, and session_end marker. The SDK controls the JSONL format, so
   * enrichment data is stored in this companion file instead.
   *
   * Fire-and-forget -- metadata write failure must not affect execution.
   */
  writeSessionMetadata(sessionKey: SessionKey, metadata: SessionMetadata): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ComisSessionManager that manages session lifecycle with write locks.
 *
 * @param deps - Session manager dependencies (directories, workspace path)
 * @returns ComisSessionManager instance
 */
export function createComisSessionManager(deps: ComisSessionManagerDeps): ComisSessionManager {
  return {
    async withSession<T>(
      sessionKey: SessionKey,
      fn: (sm: SdkSessionManager) => Promise<T>,
    ): Promise<Result<T, "locked" | "error">> {
      const sessionPath = sessionKeyToPath(sessionKey, deps.sessionBaseDir);
      const sessionKeyStr = formatSessionKey(sessionKey);

      return withSessionLock(deps.lockDir, sessionKeyStr, async () => {
        // Ensure the directory tree exists for new sessions
        await mkdir(dirname(sessionPath), { recursive: true });

        // SdkSessionManager.open() handles both cases:
        // - Existing file: loads entries from disk, sets flushed=true
        // - New file: creates in-memory header with flushed=false, defers
        //   file write until first assistant message (SDK's _persist guard)
        const sm = SdkSessionManager.open(sessionPath, dirname(sessionPath));

        const result = await fn(sm);

        // Post-execution: redact sensitive tool parameters (e.g., env_value)
        // from the JSONL file while we still hold the write lock.
        sanitizeSessionSecrets(sessionPath);

        return result;
      }, { retries: 10, retryMinTimeout: 1000 });
    },

    async destroySession(sessionKey: SessionKey): Promise<void> {
      const sessionPath = sessionKeyToPath(sessionKey, deps.sessionBaseDir);
      try {
        await unlink(sessionPath);
      } catch {
        // File may not exist -- that's fine (already destroyed or never created)
      }

      // Clean up offloaded tool results
      const toolResultsDir = safePath(dirname(sessionPath), "tool-results");
      await suppressError(rm(toolResultsDir, { recursive: true, force: true }), "tool-results dir may not exist");
    },

    writeSessionMetadata(sessionKey: SessionKey, metadata: SessionMetadata): void {
      const sessionPath = sessionKeyToPath(sessionKey, deps.sessionBaseDir);
      const metadataPath = sessionPath.replace(/\.jsonl$/, "_session-metadata.json");
      try {
        // Merge with existing metadata if present (accumulates across executions)
        let existing: Record<string, unknown> = {};
        if (existsSync(metadataPath)) {
          try {
            const raw = readFileSync(metadataPath, "utf-8"); // eslint-disable-line security/detect-non-literal-fs-filename
            existing = JSON.parse(raw) as Record<string, unknown>;
          } catch { /* corrupt file -- overwrite */ }
        }
        const merged = {
          ...existing,
          ...(metadata.traceId && { traceId: metadata.traceId }),
          ...(metadata.runId && { runId: metadata.runId }),
          ...(metadata.sessionEnd && { sessionEnd: metadata.sessionEnd }),
          lastUpdated: new Date().toISOString(),
        };
        writeFileSync(metadataPath, JSON.stringify(merged, null, 2) + "\n");
      } catch {
        // Fire-and-forget: metadata write failure must not affect execution
      }
    },

    getSessionStats(sessionKey: SessionKey): SessionStats | undefined {
      const sessionPath = sessionKeyToPath(sessionKey, deps.sessionBaseDir);
      if (!existsSync(sessionPath)) return undefined;

      try {
        const sm = SdkSessionManager.open(sessionPath, dirname(sessionPath));
        const entries = sm.getEntries();
        const header = sm.getHeader();

        let userMessages = 0;
        let assistantMessages = 0;
        let toolCalls = 0;
        let toolResults = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheReadTokens = 0;
        let totalCacheWriteTokens = 0;
        let totalCost = 0;
        let createdAt: number | undefined;

        // Extract creation time from session header
        if (header?.timestamp) {
          createdAt = new Date(header.timestamp).getTime();
        }

        for (const entry of entries) {
          if (entry.type === "message") {
            const msg = entry as {
              type: "message";
              message?: {
                role?: string;
                content?: unknown;
                usage?: {
                  input?: number;
                  output?: number;
                  cacheRead?: number;
                  cacheWrite?: number;
                  totalTokens?: number;
                  cost?: { total?: number };
                };
              };
            };
            if (msg.message?.role === "user") userMessages++;
            if (msg.message?.role === "assistant") {
              assistantMessages++;
              const usage = msg.message.usage;
              if (usage) {
                totalInputTokens += usage.input ?? 0;
                totalOutputTokens += usage.output ?? 0;
                totalCacheReadTokens += usage.cacheRead ?? 0;
                totalCacheWriteTokens += usage.cacheWrite ?? 0;
                const cost = usage.cost;
                if (cost) {
                  totalCost += cost.total ?? 0;
                }
              }
              // Count tool_use content blocks within assistant messages
              if (Array.isArray(msg.message.content)) {
                for (const block of msg.message.content as Array<{ type?: string }>) {
                  if (block.type === "tool_use") toolCalls++;
                }
              }
            }
            // Count tool result messages (role === "tool")
            if (msg.message?.role === "tool") toolResults++;
          }
        }

        return {
          messageCount: userMessages + assistantMessages,
          createdAt,
          tokens: {
            input: totalInputTokens,
            output: totalOutputTokens,
            cacheRead: totalCacheReadTokens,
            cacheWrite: totalCacheWriteTokens,
            total: totalInputTokens + totalOutputTokens + totalCacheReadTokens + totalCacheWriteTokens,
          },
          cost: totalCost,
          userMessages,
          assistantMessages,
          toolCalls,
          toolResults,
        };
      } catch {
        return undefined;
      }
    },
  };
}
