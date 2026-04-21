// SPDX-License-Identifier: Apache-2.0
/**
 * SessionTrackerRegistry: per-session FileStateTracker pool.
 *
 * Replaces the per-turn `createFileStateTracker()` fallback in setup-tools.ts
 * with a per-session tracker, keyed by formatted session key. This lets the
 * LLM's file read state persist across turns instead of resetting every
 * inbound message -- which in turn removes the [not_read] bootstrap trap
 * that fires when the LLM writes to a file it "knows" from a prior turn's
 * read or the system-prompt-seeded workspace templates.
 *
 * Lifecycle: registry holds a strong Map<formattedKey, FileStateTracker>.
 * Entries are added lazily on first `get()` and removed on `release()`.
 * Daemon wires `session:expired` -> `release(formatSessionKey(sessionKey))`
 * alongside the existing `clearSessionState()` cleanup path.
 *
 * Sub-agent safety: sub-agent code paths supply an explicit tracker via
 * `AssembleToolsOptions.fileStateTracker` (typically a fresh one per
 * spawn) and DO NOT pass a sessionKey. Those paths never touch the
 * registry -- parent isolation is preserved.
 *
 * Dependency direction: this module is intentionally skills-free. The real
 * `FileStateTracker` factory lives in `@comis/skills`, but the agent package
 * does not depend on skills. The registry is constructed with a factory
 * callback (`createTracker`) supplied by the composition root, which passes
 * `createFileStateTracker` from `@comis/skills`. Structural typing keeps the
 * tracker contract narrow -- any object implementing `recordRead` satisfies
 * the shape; the real `FileStateTracker` conforms structurally.
 *
 * @module
 */

/**
 * Structural subset of FileStateTracker from `@comis/skills`.
 *
 * The registry itself only needs to hold references -- it never calls methods
 * on the tracker -- so a permissive minimal shape is sufficient. Callers
 * receive the full tracker returned by the injected factory.
 */
export interface FileStateTrackerLike {
  recordRead(
    path: string,
    mtime: number,
    offset?: number,
    limit?: number,
    contentSample?: Buffer,
  ): void;
}

/** Factory callback that produces a new tracker instance per session key. */
export type CreateFileStateTrackerFn<T extends FileStateTrackerLike = FileStateTrackerLike> = () => T;

/** Per-session FileStateTracker pool. */
export interface SessionTrackerRegistry<T extends FileStateTrackerLike = FileStateTrackerLike> {
  /** Lazy-create on first access; return existing instance on subsequent calls. */
  get(sessionKey: string): T;
  /** Remove entry for sessionKey. No-op if absent. */
  release(sessionKey: string): void;
  /** Number of live entries. */
  size(): number;
}

/**
 * Create a session tracker registry.
 *
 * @param createTracker - Factory returning a fresh tracker per session.
 *   Typically `createFileStateTracker` from `@comis/skills`, wired in the
 *   daemon composition root.
 */
export function createSessionTrackerRegistry<T extends FileStateTrackerLike = FileStateTrackerLike>(
  createTracker: CreateFileStateTrackerFn<T>,
): SessionTrackerRegistry<T> {
  const trackers = new Map<string, T>();
  return {
    get(sessionKey: string): T {
      let t = trackers.get(sessionKey);
      if (!t) {
        t = createTracker();
        trackers.set(sessionKey, t);
      }
      return t;
    },
    release(sessionKey: string): void {
      trackers.delete(sessionKey);
    },
    size(): number {
      return trackers.size;
    },
  };
}
