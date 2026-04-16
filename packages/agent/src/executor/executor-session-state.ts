/**
 * Session-scoped state management for PiExecutor.
 *
 * Extracted from pi-executor.ts to isolate module-level Map state into
 * a focused module with getter/setter/clear functions. All session-scoped
 * Maps that previously lived in pi-executor.ts are centralized here.
 *
 * Consumers:
 * - pi-executor.ts: reads/writes state during execution
 * - session-snapshot-cleanup.ts: clears state on session expiry
 * - session-latch.test.ts: accesses latches for test assertions
 *
 * @module
 */

import type { CacheRetention } from "@mariozechner/pi-ai";
import { createSessionLatch } from "./session-latch.js";
import type { SessionLatch } from "./session-latch.js";
import { createCacheBreakDetector } from "./cache-break-detection.js";

// ---------------------------------------------------------------------------
// Design 4.1: Bounded session Maps with LRU eviction + TTL
// ---------------------------------------------------------------------------

/** Maximum number of entries per session state map before LRU eviction. */
export const SESSION_STATE_MAX = 100;

/** TTL in ms -- entries inactive for longer are evicted on next access/set. */
export const SESSION_STATE_TTL_MS = 3_600_000; // 1 hour

interface BoundedMapEntry<V> {
  value: V;
  lastAccess: number;
}

/**
 * Create a Map-like object with automatic LRU eviction and TTL-based expiry.
 * Entries inactive for >ttlMs are evicted on the next set() call.
 * When capacity is exceeded, the least-recently-accessed entry is evicted.
 *
 * @param maxEntries - Maximum entries (default: SESSION_STATE_MAX = 100)
 * @param ttlMs - TTL in ms (default: SESSION_STATE_TTL_MS = 1 hour)
 */
export function createBoundedSessionMap<V>(
  maxEntries = SESSION_STATE_MAX,
  ttlMs = SESSION_STATE_TTL_MS,
) {
  const map = new Map<string, BoundedMapEntry<V>>();

  function evictStale(): void {
    const now = Date.now();
    for (const [key, entry] of map) {
      if (now - entry.lastAccess > ttlMs) map.delete(key);
    }
    // If still over capacity, evict oldest (first key = LRU in insertion order)
    while (map.size > maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
      else break;
    }
  }

  return {
    get(key: string): V | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      // Move to most-recently-used: delete then re-insert
      map.delete(key);
      entry.lastAccess = Date.now();
      map.set(key, entry);
      return entry.value;
    },
    set(key: string, value: V): void {
      // If key exists, delete first to update insertion order
      if (map.has(key)) {
        map.delete(key);
      }
      map.set(key, { value, lastAccess: Date.now() });
      // Evict stale and over-capacity entries after insertion
      evictStale();
    },
    delete(key: string): boolean {
      return map.delete(key);
    },
    has(key: string): boolean {
      return map.has(key);
    },
    get size(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Session-scoped JIT guide delivery tracking
// ---------------------------------------------------------------------------

/**
 * Per-session Set of tool names that have already received their JIT guide.
 * Keyed by formatted session key. Cleared when isFirstMessageInSession is true.
 * Follows the same pattern as sessionPromptDigests in prompt-assembly.ts.
 */
const sessionDeliveredGuides = createBoundedSessionMap<Set<string>>();

/** Get delivered guides Set for a session. */
export function getDeliveredGuides(sessionKey: string): Set<string> | undefined {
  return sessionDeliveredGuides.get(sessionKey);
}

/** Set delivered guides Set for a session. */
export function setDeliveredGuides(sessionKey: string, value: Set<string>): void {
  sessionDeliveredGuides.set(sessionKey, value);
}

/**
 * Clear delivered guides for a session. Exported for session cleanup
 * (co-located with session cleanup pattern).
 */
export function clearSessionDeliveredGuides(sessionKey: string): void {
  sessionDeliveredGuides.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Session-scoped tool schema snapshot
// ---------------------------------------------------------------------------

// Per-session tool schema snapshot.
// Snapshots tool shapes (name, description, parameters) on first turn to keep the
// tools array in the Anthropic API payload stable across turns. Only execute()
// functions are resolved live per-turn (MCP tools need live callTool references).

// ToolShape intentionally captures ONLY name/description/parameters -- not execute().
// This means wrappers that only replace execute() (JIT guides,
// sideEffects processing) are orthogonal to schema stability: they change
// runtime behavior but not the serialized tool schema sent to the API.

export interface ToolShape {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown> | undefined;
}

/** Map<sessionKey, ToolShape[]> -- snapshotted on first turn, reused on subsequent turns. */
const sessionToolSchemaSnapshots = createBoundedSessionMap<ToolShape[]>();

/** Map<sessionKey, toolCompositionHash> -- tracks tool names that were active when the tool schema snapshot was taken. */
const sessionToolSchemaSnapshotHashes = createBoundedSessionMap<string>();

/** Get the tool schema snapshot for a session. */
export function getToolSchemaSnapshots(sessionKey: string): ToolShape[] | undefined {
  return sessionToolSchemaSnapshots.get(sessionKey);
}

/** Set the tool schema snapshot for a session. */
export function setToolSchemaSnapshots(sessionKey: string, value: ToolShape[]): void {
  sessionToolSchemaSnapshots.set(sessionKey, value);
}

/** Delete the tool schema snapshot for a session (used on composition change). */
export function deleteToolSchemaSnapshots(sessionKey: string): void {
  sessionToolSchemaSnapshots.delete(sessionKey);
}

/** Clear the tool schema snapshot for a session (e.g., on session reset/compaction).
 *  Exported for session cleanup following the same pattern as clearSessionDeliveredGuides
 *  and clearSessionToolNameSnapshot (prompt-assembly.ts).
 *
 *  NOTE: As of this implementation, none of the clearSession* functions
 *  (clearSessionDeliveredGuides, clearSessionToolNameSnapshot)
 *  have production call sites in the daemon -- they are exported for test cleanup
 *  (beforeEach) and future session eviction wiring. The sessionToolSchemaSnapshots Map
 *  is bounded by active session count (one entry per unique agent:channel:chat key),
 *  and each entry is small (~2-5KB for typical tool sets). This is acceptable for the
 *  current deployment scale. When a session eviction path is added to the daemon,
 *  clearSessionToolSchemaSnapshot should be called alongside the other clearSession* functions. */
export function clearSessionToolSchemaSnapshot(sessionKey: string): void {
  sessionToolSchemaSnapshots.delete(sessionKey);
}

/** Get the tool schema snapshot hash for a session. */
export function getToolSchemaSnapshotHash(sessionKey: string): string | undefined {
  return sessionToolSchemaSnapshotHashes.get(sessionKey);
}

/** Set the tool schema snapshot hash for a session. */
export function setToolSchemaSnapshotHash(sessionKey: string, value: string): void {
  sessionToolSchemaSnapshotHashes.set(sessionKey, value);
}

/** Clear the tool schema snapshot hash for a session. */
export function clearSessionToolSchemaSnapshotHash(sessionKey: string): void {
  sessionToolSchemaSnapshotHashes.delete(sessionKey);
}

/** Compute a deterministic hash of tool names for tool composition change detection. */
export function computeToolCompositionHash(toolNames: string[]): string {
  return toolNames.slice().sort().join(",");
}

// ---------------------------------------------------------------------------
// Session-scoped cache breakpoint persistence
// ---------------------------------------------------------------------------

/** Per-session lastBreakpointIndex persistence.
 *  Stores the highest cache breakpoint index from the previous execution
 *  so the next execute() call can seed the context engine's cacheFenceIndex.
 *  Cleared on session expiry (clearSessionBreakpointIndex). */
const sessionBreakpointIndex = createBoundedSessionMap<number>();

/** Get persisted breakpoint index for a session. */
export function getBreakpointIndex(sessionKey: string): number | undefined {
  return sessionBreakpointIndex.get(sessionKey);
}

/** Set persisted breakpoint index for a session. */
export function setBreakpointIndex(sessionKey: string, value: number): void {
  sessionBreakpointIndex.set(sessionKey, value);
}

/** Delete persisted breakpoint index for a session. */
export function deleteBreakpointIndex(sessionKey: string): void {
  sessionBreakpointIndex.delete(sessionKey);
}

/** Get the size of the breakpoint index map (for logging). */
export function getBreakpointIndexMapSize(): number {
  return sessionBreakpointIndex.size;
}

/** Clear persisted breakpoint index for a session. Exported for session cleanup
 *  (co-located with clearSessionDeliveredGuides, clearSessionToolSchemaSnapshot). */
export function clearSessionBreakpointIndex(sessionKey: string): void {
  sessionBreakpointIndex.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Per-session eviction cooldown state
// ---------------------------------------------------------------------------

/** Eviction cooldown state -- tracks turns remaining after server-side eviction. */
export interface EvictionCooldownState {
  turnsRemaining: number;
  evictedAt: number;  // Date.now() of eviction detection
}

const sessionEvictionCooldown = createBoundedSessionMap<EvictionCooldownState>();

/** Get eviction cooldown state for a session. */
export function getEvictionCooldown(sessionKey: string): EvictionCooldownState | undefined {
  return sessionEvictionCooldown.get(sessionKey);
}

/** Set eviction cooldown (called on server eviction detection). */
export function setEvictionCooldown(sessionKey: string, turnsRemaining: number): void {
  sessionEvictionCooldown.set(sessionKey, { turnsRemaining, evictedAt: Date.now() });
}

/** Decrement eviction cooldown by 1 turn. Deletes entry when reaching 0. */
export function decrementEvictionCooldown(sessionKey: string): void {
  const state = sessionEvictionCooldown.get(sessionKey);
  if (!state) return;
  if (state.turnsRemaining <= 1) {
    sessionEvictionCooldown.delete(sessionKey);
  } else {
    sessionEvictionCooldown.set(sessionKey, { ...state, turnsRemaining: state.turnsRemaining - 1 });
  }
}

/** Clear eviction cooldown for a session. */
export function clearSessionEvictionCooldown(sessionKey: string): void {
  sessionEvictionCooldown.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Per-session cumulative cache savings tracking
// ---------------------------------------------------------------------------

/** Cumulative cache savings state per session. */
export interface SessionCacheSavingsState {
  cumulativeSavingsUsd: number;
  turnCount: number;
}

const sessionCacheSavings = createBoundedSessionMap<SessionCacheSavingsState>();

/** Get cumulative cache savings for a session. */
export function getCacheSavings(sessionKey: string): SessionCacheSavingsState | undefined {
  return sessionCacheSavings.get(sessionKey);
}

/** Record a turn's cache savings (called each turn_end). */
export function recordCacheSavings(sessionKey: string, savedUsd: number): void {
  const existing = sessionCacheSavings.get(sessionKey);
  if (existing) {
    sessionCacheSavings.set(sessionKey, {
      cumulativeSavingsUsd: existing.cumulativeSavingsUsd + savedUsd,
      turnCount: existing.turnCount + 1,
    });
  } else {
    sessionCacheSavings.set(sessionKey, {
      cumulativeSavingsUsd: savedUsd,
      turnCount: 1,
    });
  }
}

/** Clear cumulative cache savings for a session. */
export function clearSessionCacheSavings(sessionKey: string): void {
  sessionCacheSavings.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// Session-scoped cache warm state
// ---------------------------------------------------------------------------

/** Session-scoped cache warm state. Tracks whether adaptive retention
 *  has escalated during any prior execute() call for this session key.
 *  When true, subsequent execute() calls start with config retention (long)
 *  instead of cold-start (short), preventing TTL downgrade on the first API call. */
const sessionCacheWarm = createBoundedSessionMap<boolean>();

/** Get session cache warm state. */
export function getCacheWarm(sessionKey: string): boolean | undefined {
  return sessionCacheWarm.get(sessionKey);
}

/** Set session cache warm state. */
export function setCacheWarm(sessionKey: string, value: boolean): void {
  sessionCacheWarm.set(sessionKey, value);
}

/** Clear session cache warm state. Exported for session cleanup
 *  (co-located with clearSessionBreakpointIndex, clearSessionDeliveredGuides). */
export function clearSessionCacheWarm(sessionKey: string): void {
  sessionCacheWarm.delete(sessionKey);
}

// ---------------------------------------------------------------------------
// SESS-LATCH: Per-session latch container for cache stability
// ---------------------------------------------------------------------------

/** SESS-LATCH: Per-session latch container for cache stability. */
export interface SessionLatches {
  betaHeader: SessionLatch<string>;
  retention: SessionLatch<CacheRetention>;
  deferLoading: SessionLatch<boolean>;
  idleThinkingClear: SessionLatch<boolean>; // Idle-based thinking clear
}

/** SESS-LATCH: Session-scoped latches keyed by formatted session key. */
const sessionLatches = createBoundedSessionMap<SessionLatches>();

/** SESS-LATCH: Get or create latches for a session. */
export function getOrCreateSessionLatches(sessionKey: string): SessionLatches {
  let latches = sessionLatches.get(sessionKey);
  if (!latches) {
    latches = {
      betaHeader: createSessionLatch<string>(),
      retention: createSessionLatch<CacheRetention>(),
      deferLoading: createSessionLatch<boolean>(),
      idleThinkingClear: createSessionLatch<boolean>(),
    };
    sessionLatches.set(sessionKey, latches);
  }
  return latches;
}

/** SESS-LATCH: Get latches for a session without creating (used by thinking override). */
export function getSessionLatches(sessionKey: string): SessionLatches | undefined {
  return sessionLatches.get(sessionKey);
}

/** SESS-LATCH: Clear all latches for a session (called on session reset). */
export function clearSessionLatches(sessionKey: string): void {
  const latches = sessionLatches.get(sessionKey);
  if (latches) {
    latches.betaHeader.reset();
    latches.retention.reset();
    latches.deferLoading.reset();
    latches.idleThinkingClear.reset();
    sessionLatches.delete(sessionKey);
  }
}

/** SESS-LATCH: Exported for test access following _prefix convention. */
export { clearSessionLatches as _clearSessionLatchesForTest };
export { getOrCreateSessionLatches as _getOrCreateSessionLatchesForTest };

// ---------------------------------------------------------------------------
// Module-level singleton for cache break detection
// ---------------------------------------------------------------------------

let cacheBreakDetectorInstance: ReturnType<typeof createCacheBreakDetector> | undefined;

/** Lazily create or return the singleton cache break detector. */
export function getCacheBreakDetector(logger: { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void }): ReturnType<typeof createCacheBreakDetector> {
  if (!cacheBreakDetectorInstance) {
    cacheBreakDetectorInstance = createCacheBreakDetector(logger);
  }
  return cacheBreakDetectorInstance;
}
