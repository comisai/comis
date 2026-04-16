/**
 * Pi-mono adapter wrappers for sub-agent ephemeral sessions (R-11).
 *
 * Provides `createEphemeralComisSessionManager()` — a zero-persistence
 * ComisSessionManager whose `withSession` uses `SessionManager.inMemory()`
 * from the SDK. No write lock, no sanitization, no metadata writes.
 *
 * Used by the sub-agent spawn path so child executions never write JSONL
 * files to disk. Session state is garbage-collected when the sub-agent
 * finishes.
 *
 * @module
 */

import { SessionManager as SdkSessionManager } from "@mariozechner/pi-coding-agent";
import { ok, err } from "@comis/shared";
import type { ComisSessionManager } from "../session/comis-session-manager.js";

/**
 * Create an ephemeral ComisSessionManager for sub-agent sessions.
 *
 * The returned adapter:
 * - `withSession`: Creates `SdkSessionManager.inMemory(cwd)`, passes it to the
 *   callback, returns the result wrapped in `ok()`. No write lock (no file
 *   contention), no `sanitizeSessionSecrets` (no file to sanitize).
 * - `destroySession`: No-op (nothing to destroy for in-memory sessions).
 * - `getSessionStats`: Returns `undefined` (ephemeral sessions have no persistent stats).
 * - `writeSessionMetadata`: No-op (no companion file for in-memory sessions).
 *
 * @param cwd - Working directory for the ephemeral session
 * @returns ComisSessionManager with in-memory SDK session backend
 */
export function createEphemeralComisSessionManager(cwd: string): ComisSessionManager {
  return {
    async withSession(_sessionKey, fn) {
      try {
        const sm = SdkSessionManager.inMemory(cwd);
        const result = await fn(sm);
        return ok(result);
      } catch {
        return err("error" as const);
      }
    },

    async destroySession() {
      // No-op: in-memory sessions have nothing to destroy
    },

    getSessionStats() {
      // Ephemeral sessions have no persistent stats
      return undefined;
    },

    writeSessionMetadata() {
      // No-op: no companion file for in-memory sessions
    },
  };
}
