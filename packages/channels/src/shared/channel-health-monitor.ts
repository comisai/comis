/**
 * Channel Health Monitor: Polls registered channel adapters at configurable
 * intervals and classifies each into one of 8 health states.
 *
 * State machine priority (first match wins):
 *   unknown -> disconnected -> errored -> startup-grace -> stuck -> healthy/idle/stale
 *
 * Follows the createProcessMonitor() factory pattern: closure state,
 * setInterval + unref(), typed event bus emission.
 *
 * Note: recordRunStart/recordRunEnd are infrastructure-ready. They are fully
 * implemented but not wired to EventBus agent execution events in this plan.
 * activeRuns will be 0 in production until a follow-up phase wires them.
 *
 * @module
 */

import type { TypedEventBus, ChannelPort } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The 8 possible health states for a channel adapter.
 * Evaluated in priority order during each poll cycle.
 */
export type ChannelHealthState =
  | "healthy"
  | "idle"
  | "stale"
  | "stuck"
  | "startup-grace"
  | "disconnected"
  | "errored"
  | "unknown";

/**
 * Read-only health snapshot for a single channel adapter.
 * Returned by getHealth() and getHealthSummary().
 */
export interface ChannelHealthEntry {
  readonly channelType: string;
  readonly state: ChannelHealthState;
  readonly lastCheckedAt: number;
  readonly lastMessageAt: number | null;
  readonly error: string | null;
  readonly consecutiveFailures: number;
  readonly stateChangedAt: number;
  readonly activeRuns: number;
  readonly lastRunStartedAt: number | null;
  readonly adapterStartedAt: number;
  readonly connectionMode: "socket" | "polling" | "webhook";
  readonly restartAttempts: number;
  readonly busyStateInitialized: boolean;
}

/** Configuration for the channel health monitor. */
export interface ChannelHealthMonitorConfig {
  /** Poll interval in milliseconds (default: 60_000). */
  pollIntervalMs?: number;
  /** Age threshold for stale state in milliseconds (default: 1_800_000 = 30 min). */
  staleThresholdMs?: number;
  /** Age threshold for idle state in milliseconds (default: 600_000 = 10 min). */
  idleThresholdMs?: number;
  /** Consecutive getStatus() failures before unknown state (default: 3). */
  errorThreshold?: number;
  /** Duration threshold for stuck runs in milliseconds (default: 1_500_000 = 25 min). */
  stuckThresholdMs?: number;
  /** Startup grace period in milliseconds (default: 120_000 = 2 min). */
  startupGraceMs?: number;
  /** Whether to auto-restart adapters that enter stale state (default: false). */
  autoRestartOnStale?: boolean;
  /** Maximum restarts per hour per adapter (default: 10). */
  maxRestartsPerHour?: number;
  /** Cooldown between restarts in milliseconds (default: 600_000 = 10 min). */
  restartCooldownMs?: number;
  /** Typed event bus for health_changed and health_check emissions. */
  eventBus: TypedEventBus;
  /** Callback for auto-restart (injected by daemon wiring). */
  restartAdapter?: (channelType: string) => Promise<void>;
}

/** Channel health monitor interface. */
export interface ChannelHealthMonitor {
  /** Begin polling. Returns a stop function that clears the interval timer. */
  start(adapters: Map<string, ChannelPort>): () => void;
  /** Force an immediate poll cycle outside the interval timer. */
  checkNow(): void;
  /** Get a snapshot of all health entries. */
  getHealthSummary(): Map<string, ChannelHealthEntry>;
  /** Get the health entry for a specific channel type. */
  getHealth(channelType: string): ChannelHealthEntry | undefined;
  /** Dynamically register an adapter after start(). */
  addAdapter(channelType: string, adapter: ChannelPort): void;
  /** Dynamically remove an adapter. */
  removeAdapter(channelType: string): void;
  /** Record that an agent run started on this channel (infrastructure-ready). */
  recordRunStart(channelType: string): void;
  /** Record that an agent run ended on this channel (infrastructure-ready). */
  recordRunEnd(channelType: string): void;
}

// ---------------------------------------------------------------------------
// Internal mutable entry (extends ChannelHealthEntry with writability)
// ---------------------------------------------------------------------------

interface MutableHealthEntry {
  channelType: string;
  state: ChannelHealthState;
  lastCheckedAt: number;
  lastMessageAt: number | null;
  error: string | null;
  consecutiveFailures: number;
  stateChangedAt: number;
  activeRuns: number;
  lastRunStartedAt: number | null;
  adapterStartedAt: number;
  connectionMode: "socket" | "polling" | "webhook";
  restartAttempts: number;
  busyStateInitialized: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a channel health monitor that polls adapters and transitions
 * through 8 health states with event emission.
 */
export function createChannelHealthMonitor(
  config: ChannelHealthMonitorConfig,
): ChannelHealthMonitor {
  // Resolve defaults
  const pollIntervalMs = config.pollIntervalMs ?? 60_000;
  const staleThresholdMs = config.staleThresholdMs ?? 1_800_000;
  const idleThresholdMs = config.idleThresholdMs ?? 600_000;
  const errorThreshold = config.errorThreshold ?? 3;
  const stuckThresholdMs = config.stuckThresholdMs ?? 1_500_000;
  const startupGraceMs = config.startupGraceMs ?? 120_000;
  const autoRestartOnStale = config.autoRestartOnStale ?? false;
  const maxRestartsPerHour = config.maxRestartsPerHour ?? 10;
  const restartCooldownMs = config.restartCooldownMs ?? 600_000;
  const eventBus = config.eventBus;
  const restartAdapter = config.restartAdapter;

  // Closure state
  const entries = new Map<string, MutableHealthEntry>();
  const adapters = new Map<string, ChannelPort>();
  const restartTimestamps = new Map<string, number[]>();
  let timer: ReturnType<typeof setInterval> | undefined;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Stale exemption check: polling and webhook mode adapters are exempt
   * from stale detection (connectionMode-only, no platform name set).
   */
  function isStaleExempt(entry: { connectionMode: string }): boolean {
    return entry.connectionMode === "webhook" || entry.connectionMode === "polling";
  }

  /**
   * Evaluate activity level for a connected adapter without active runs.
   * Returns healthy, idle, or stale based on lastMessageAt age.
   */
  function evaluateActivity(entry: MutableHealthEntry): ChannelHealthState {
    if (!entry.lastMessageAt) return "healthy"; // no activity yet but connected
    const age = Date.now() - entry.lastMessageAt;
    if (isStaleExempt(entry)) {
      // Polling/webhook adapters skip stale, but still check idle
      return age > idleThresholdMs ? "idle" : "healthy";
    }
    if (age > staleThresholdMs) return "stale";
    if (age > idleThresholdMs) return "idle";
    return "healthy";
  }

  /**
   * Create a fresh mutable entry for a newly registered adapter.
   */
  function createEntry(channelType: string, adapter: ChannelPort): MutableHealthEntry {
    // Determine connectionMode from adapter getStatus() if available
    let connectionMode: "socket" | "polling" | "webhook" = "socket";
    try {
      const status = adapter.getStatus?.();
      if (status?.connectionMode) {
        connectionMode = status.connectionMode;
      }
    } catch {
      // getStatus() threw -- use default
    }

    const now = Date.now();
    return {
      channelType,
      state: "startup-grace",
      lastCheckedAt: now,
      lastMessageAt: null,
      error: null,
      consecutiveFailures: 0,
      stateChangedAt: now,
      activeRuns: 0,
      lastRunStartedAt: null,
      adapterStartedAt: now,
      connectionMode,
      restartAttempts: 0,
      busyStateInitialized: false,
    };
  }

  /**
   * Convert mutable entry to readonly ChannelHealthEntry snapshot.
   */
  function toSnapshot(entry: MutableHealthEntry): ChannelHealthEntry {
    return { ...entry };
  }

  /**
   * Check auto-restart throttle for a given adapter.
   * Returns true if restart is allowed.
   */
  function canRestart(channelType: string): boolean {
    const now = Date.now();
    const timestamps = restartTimestamps.get(channelType) ?? [];

    // Filter to last hour
    const oneHourAgo = now - 3_600_000;
    const recentTimestamps = timestamps.filter((t) => t > oneHourAgo);
    restartTimestamps.set(channelType, recentTimestamps);

    // Check max per hour
    if (recentTimestamps.length >= maxRestartsPerHour) {
      return false;
    }

    // Check cooldown
    if (recentTimestamps.length > 0) {
      const lastRestart = recentTimestamps[recentTimestamps.length - 1]!;
      if (now - lastRestart < restartCooldownMs) {
        return false;
      }
    }

    return true;
  }

  /**
   * Attempt auto-restart for a stale adapter (fire-and-forget).
   */
  function attemptAutoRestart(channelType: string): void {
    if (!autoRestartOnStale || !restartAdapter) return;
    if (!canRestart(channelType)) return;

    const timestamps = restartTimestamps.get(channelType) ?? [];
    timestamps.push(Date.now());
    restartTimestamps.set(channelType, timestamps);

    const entry = entries.get(channelType);
    if (entry) {
      entry.restartAttempts++;
    }

    // Fire and forget -- catch errors silently
    // eslint-disable-next-line no-restricted-syntax -- intentional fire-and-forget
    restartAdapter(channelType).catch(() => {
      // Restart failed -- tracked via restartAttempts
    });
  }

  // -------------------------------------------------------------------------
  // Core polling logic
  // -------------------------------------------------------------------------

  /**
   * Poll all registered adapters and evaluate health state transitions.
   */
  function pollAll(): void {
    for (const [channelType, adapter] of adapters) {
      const entry = entries.get(channelType);
      if (!entry) continue;

      const pollStart = Date.now();
      let status: ReturnType<NonNullable<ChannelPort["getStatus"]>> | undefined;

      try {
        status = adapter.getStatus?.();
      } catch {
        // getStatus() threw -- treat as undefined
      }

      let newState: ChannelHealthState;

      // Priority-ordered evaluation (first match wins)
      if (!status) {
        entry.consecutiveFailures++;
        if (entry.consecutiveFailures >= errorThreshold) {
          newState = "unknown";
        } else {
          newState = entry.state; // keep current state on transient failure
        }
      } else {
        entry.consecutiveFailures = 0; // reset on successful getStatus
        entry.lastMessageAt = status.lastMessageAt ?? entry.lastMessageAt;
        entry.error = status.error ?? null;

        if (!status.connected) {
          newState = "disconnected";
        } else if (status.error) {
          newState = "errored";
        } else if (Date.now() - entry.adapterStartedAt < startupGraceMs) {
          newState = "startup-grace";
        } else if (entry.activeRuns > 0) {
          // Busy state lifecycle guard
          const busyInitialized =
            entry.lastRunStartedAt != null &&
            entry.lastRunStartedAt >= entry.adapterStartedAt;
          entry.busyStateInitialized = busyInitialized;

          if (!busyInitialized) {
            // Inherited busy from previous lifecycle -- fall through to stale/idle
            newState = evaluateActivity(entry);
          } else if (
            entry.lastRunStartedAt != null &&
            Date.now() - entry.lastRunStartedAt > stuckThresholdMs
          ) {
            newState = "stuck";
          } else {
            newState = "healthy"; // busy but active
          }
        } else {
          newState = evaluateActivity(entry);
        }
      }

      entry.lastCheckedAt = Date.now();

      // Emit health_check for every poll
      eventBus.emit("channel:health_check", {
        channelType,
        state: newState,
        responseTimeMs: Date.now() - pollStart,
        timestamp: Date.now(),
      });

      // Emit health_changed only on state transitions
      if (entry.state !== newState) {
        const previous = entry.state;
        entry.state = newState;
        entry.stateChangedAt = Date.now();

        eventBus.emit("channel:health_changed", {
          channelType,
          previousState: previous,
          currentState: newState,
          connectionMode: entry.connectionMode,
          error: entry.error,
          lastMessageAt: entry.lastMessageAt,
          timestamp: Date.now(),
        });

        // Auto-restart on stale
        if (newState === "stale") {
          attemptAutoRestart(channelType);
        }

        // Reset restart throttle on recovery to healthy
        if (newState === "healthy") {
          restartTimestamps.delete(channelType);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function start(adapterMap: Map<string, ChannelPort>): () => void {
    // Store adapters and create initial entries
    for (const [channelType, adapter] of adapterMap) {
      adapters.set(channelType, adapter);
      entries.set(channelType, createEntry(channelType, adapter));
    }

    // Start periodic polling
    timer = setInterval(pollAll, pollIntervalMs);
    timer.unref();

    // Return stop function
    return () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }

  function checkNow(): void {
    pollAll();
  }

  function getHealthSummary(): Map<string, ChannelHealthEntry> {
    const summary = new Map<string, ChannelHealthEntry>();
    for (const [channelType, entry] of entries) {
      summary.set(channelType, toSnapshot(entry));
    }
    return summary;
  }

  function getHealth(channelType: string): ChannelHealthEntry | undefined {
    const entry = entries.get(channelType);
    return entry ? toSnapshot(entry) : undefined;
  }

  function addAdapter(channelType: string, adapter: ChannelPort): void {
    adapters.set(channelType, adapter);
    entries.set(channelType, createEntry(channelType, adapter));
  }

  function removeAdapter(channelType: string): void {
    adapters.delete(channelType);
    entries.delete(channelType);
    restartTimestamps.delete(channelType);
  }

  function recordRunStart(channelType: string): void {
    const entry = entries.get(channelType);
    if (!entry) return;
    entry.activeRuns++;
    entry.lastRunStartedAt = Date.now();
  }

  function recordRunEnd(channelType: string): void {
    const entry = entries.get(channelType);
    if (!entry) return;
    entry.activeRuns = Math.max(0, entry.activeRuns - 1);
  }

  return {
    start,
    checkNow,
    getHealthSummary,
    getHealth,
    addAdapter,
    removeAdapter,
    recordRunStart,
    recordRunEnd,
  };
}
