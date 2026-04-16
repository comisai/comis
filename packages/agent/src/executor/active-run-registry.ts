/**
 * ActiveRunRegistry: Tracks running PiExecutor sessions by session key,
 * exposing SDK AgentSession steer/followUp/abort/streaming/compacting
 * handles to external consumers (e.g., channel manager).
 *
 * Purpose: The channel manager needs to know when a session is actively
 * executing and whether the SDK session can accept mid-stream steering.
 * This registry bridges the executor (which owns the AgentSession) and
 * the inbound pipeline (which decides how to route incoming messages).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Handle exposing steering capabilities of an active SDK AgentSession. */
export interface RunHandle {
  /** Inject a steering message into the active SDK session (mid-stream interrupt). */
  steer(text: string): Promise<void>;
  /** Queue a follow-up message for after the current run completes. */
  followUp(text: string): Promise<void>;
  /** Abort the current execution. */
  abort(): Promise<void>;
  /** Whether the SDK session is currently streaming an LLM response. */
  isStreaming(): boolean;
  /** Whether the SDK session is currently running auto-compaction. */
  isCompacting(): boolean;
}

/** Registry tracking active PiExecutor runs by formatted session key. */
export interface ActiveRunRegistry {
  /** Register an active run. Returns false if session is already registered. */
  register(sessionKey: string, handle: RunHandle): boolean;
  /** Deregister an active run. No-op if not registered. */
  deregister(sessionKey: string): void;
  /** Get the RunHandle for an active session, or undefined if not running. */
  get(sessionKey: string): RunHandle | undefined;
  /** Check if a session has an active run. */
  has(sessionKey: string): boolean;
  /** Number of active runs. */
  readonly size: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ActiveRunRegistry backed by an in-memory Map.
 *
 * - `register()` returns false if the key already exists (guards against
 *   concurrent execution for the same session -- the JSONL session adapter
 *   also guards this, but belt-and-suspenders).
 * - `deregister()` deletes the key silently (no error if missing).
 */
export function createActiveRunRegistry(): ActiveRunRegistry {
  const runs = new Map<string, RunHandle>();

  return {
    register(sessionKey: string, handle: RunHandle): boolean {
      if (runs.has(sessionKey)) {
        return false;
      }
      runs.set(sessionKey, handle);
      return true;
    },

    deregister(sessionKey: string): void {
      runs.delete(sessionKey);
    },

    get(sessionKey: string): RunHandle | undefined {
      return runs.get(sessionKey);
    },

    has(sessionKey: string): boolean {
      return runs.has(sessionKey);
    },

    get size(): number {
      return runs.size;
    },
  };
}
