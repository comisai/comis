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
import { formatSessionKey, safePath, systemNowDate, type SessionKey } from "@comis/core";
import type { ComisLogger, FileLockPort } from "@comis/core";
import { suppressError, type Result } from "@comis/shared";
import { mkdir, unlink, rm, rmdir } from "node:fs/promises";
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
  /**
   * Per-session filesystem mutex. Injected by daemon composition
   * (setup-agents.ts wires a single `createFileLock()` from `@comis/core`,
   * relocated from `@comis/scheduler` in Phase 35 Plan 35-04 D-01 #1).
   * Phase 32 commit 12 (ORCH-EXT-15) moved this from a module-level direct
   * proper-lockfile import inside session-write-lock.ts to a deps field so
   * agent's production source no longer reaches into scheduler or the
   * proper-lockfile package directly.
   */
  fileLock: FileLockPort;
  /**
   * Optional logger. When provided, structured-cause logging fires before
   * withSessionLock collapses the FileLockPort's discriminated error union
   * to the legacy 'locked' | 'error' string (WR-07). Without it, operator
   * triage cannot distinguish 'ELOCKED after N retries' from 'EACCES on
   * the lock directory'. The public Result API is unchanged either way.
   */
  logger?: ComisLogger;
}

/**
 * Session metadata written as a companion file alongside the JSONL.
 * The SDK controls the JSONL format, so enrichment data (traceId, runId, session_end)
 * is stored in `_session-metadata.json` next to the `.jsonl` file.
 *
 * `traceId` and `runId` are deliberately distinct identifiers:
 * - `traceId` is the request-scope AsyncLocalStorage value set by
 *   `runWithContext` at the channel boundary (channels/.../execution-execute.ts).
 *   The Pino tracing mixin (infra/.../log-fields.ts) injects it into every
 *   daemon log line, so an operator can grep daemon.log for this exact value
 *   to find every log entry produced while handling this turn.
 * - `runId` is the executor-scope UUID minted per `executor.execute()` call
 *   in pi-executor.ts. It keys cost-tracker / token_usage rows in the
 *   observability store.
 *
 * They are 1:1 in the steady-state interactive path (one inbound message →
 * one execution), but heartbeat and sub-agent paths can fan out a single
 * trace into multiple executions.
 */
export interface SessionMetadata {
  /** Request-scope trace ID from runWithContext; matches traceId in daemon.log. */
  traceId?: string;
  /** Executor-scope run ID; keys cost-tracker / token_usage rows. */
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

  /**
   * Resolve the absolute JSONL session file path for a session key.
   *
   * Thin synchronous wrapper around `sessionKeyToPath(sessionKey, deps.sessionBaseDir)`
   * that exposes the path resolver to the wire-edge diagnostic in pi-event-bridge.
   * Pure delegation -- no I/O, no logging, no side effects. Path composition is
   * delegated to `sessionKeyToPath`, which uses `safePath` for traversal-safe
   * resolution.
   */
  getSessionPath(sessionKey: SessionKey): string;
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

      return withSessionLock(deps.fileLock, deps.lockDir, sessionKeyStr, async () => {
        // Ensure the directory tree exists for new sessions
        await mkdir(dirname(sessionPath), { recursive: true });

        // SdkSessionManager.open() handles both cases:
        // - Existing file: loads entries from disk, sets flushed=true
        // - New file: creates in-memory header with flushed=false, defers
        //   file write until first assistant message (SDK's _persist guard)
        const sm = SdkSessionManager.open(sessionPath, dirname(sessionPath));

        try {
          const result = await fn(sm);
          return result;
        } finally {
          // ALWAYS sanitize, even on throw — the SDK flushes entries to the
          // JSONL file before / during fn execution, so a mid-execution
          // exception can leave unredacted tool parameters (env_value, etc.)
          // on disk. Running in finally ensures the next reader of the file
          // (getSessionStats, replay, sessions.inspect RPC) sees the
          // redacted form even on the error path. Sanitization runs while
          // we still hold the write lock.
          sanitizeSessionSecrets(sessionPath);
        }
      }, {
        retries: 10,
        retryMinTimeout: 1000,
        logger: deps.logger,
        sessionKey: sessionKeyStr,
      });
    },

    async destroySession(sessionKey: SessionKey): Promise<void> {
      const sessionPath = sessionKeyToPath(sessionKey, deps.sessionBaseDir);
      const sessionKeyStr = formatSessionKey(sessionKey);

      await withSessionLock(deps.fileLock, deps.lockDir, sessionKeyStr, async () => {
        try { await unlink(sessionPath); } catch { /* ENOENT ok */ }
        const sessionDir = dirname(sessionPath);
        const toolResultsDir = safePath(sessionDir, "tool-results");
        await suppressError(
          rm(toolResultsDir, { recursive: true, force: true }),
          "tool-results dir may not exist",
        );
        try { await rmdir(sessionDir); } catch { /* non-empty or already gone */ }
      }, {
        retries: 10,
        retryMinTimeout: 500,
        logger: deps.logger,
        sessionKey: sessionKeyStr,
      });
    },

    getSessionPath(sessionKey: SessionKey): string {
      // wire-edge diagnostic: pure delegation to sessionKeyToPath
      // (which uses safePath internally). No I/O, no logging.
      return sessionKeyToPath(sessionKey, deps.sessionBaseDir);
    },

    writeSessionMetadata(sessionKey: SessionKey, metadata: SessionMetadata): void {
      const sessionPath = sessionKeyToPath(sessionKey, deps.sessionBaseDir);
      // Defensive: sessionKeyToPath has always returned paths ending in
      // ".jsonl" at HEAD. If that invariant ever regresses (e.g., a future
      // refactor switches the suffix or returns a directory), the
      // `replace(/\.jsonl$/, ...)` below would be a no-op and
      // metadataPath would equal sessionPath -- the subsequent
      // writeFileSync would clobber the JSONL transcript with a JSON
      // metadata object. Refuse to write rather than risk data loss.
      if (!sessionPath.endsWith(".jsonl")) {
        return;
      }
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
          lastUpdated: systemNowDate().toISOString(),
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
          createdAt = Date.parse(header.timestamp);
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
              // Count tool_use content blocks within assistant messages.
              // The content array is typed `unknown`, so individual blocks
              // can legitimately be null, undefined, or a primitive (string
              // content blocks exist in some pi-coding-agent versions).
              // Guard with object check before reading `.type` to prevent
              // a TypeError that would be swallowed by the outer catch
              // (turning a parse hiccup into a silent "no session" result).
              if (Array.isArray(msg.message.content)) {
                for (const block of msg.message.content) {
                  if (
                    block !== null &&
                    typeof block === "object" &&
                    (block as { type?: string }).type === "tool_use"
                  ) {
                    toolCalls++;
                  }
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
