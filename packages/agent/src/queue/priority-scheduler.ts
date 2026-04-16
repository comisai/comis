/**
 * Priority Scheduler: Multi-lane queue scheduling with per-lane concurrency.
 *
 * Replaces the single global PQueue gate with named priority lanes, each
 * backed by its own PQueue with independent concurrency limits. This allows
 * DMs, group mentions, and background tasks to have different scheduling
 * priorities without starving any lane.
 *
 * Since each lane has its own PQueue running independently, starvation is
 * prevented by design -- as long as each lane has concurrency > 0, its tasks
 * will execute. The aging promotion mechanism is observability-only: it emits
 * events when tasks wait longer than the configured threshold, but does not
 * actually move tasks between lanes (PQueue does not support mid-flight
 * task migration).
 *
 * @module
 */

import PQueue from "p-queue";
import type { TypedEventBus, PriorityLaneConfig } from "@comis/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PrioritySchedulerDeps {
  readonly lanes: PriorityLaneConfig[];
  readonly eventBus: TypedEventBus;
}

export interface LaneStats {
  pending: number;
  executing: number;
  concurrency: number;
  priority: number;
}

export interface PriorityScheduler {
  /** Enqueue a task to a named priority lane */
  enqueue(lane: string, task: () => Promise<void>): Promise<void>;
  /** Get stats for all lanes */
  getStats(): Record<string, LaneStats>;
  /** Get total concurrency across all lanes */
  getTotalConcurrency(): number;
  /** Pause all lanes */
  pause(): void;
  /** Resume all lanes */
  resume(): void;
  /** Drain all lanes (wait for all tasks to complete) */
  drainAll(): Promise<void>;
  /** Shutdown: pause, drain active, clear */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal lane wrapper
// ---------------------------------------------------------------------------

interface LaneEntry {
  queue: PQueue;
  config: PriorityLaneConfig;
  /** Enqueue timestamps for aging detection (oldest first). */
  enqueueTimes: number[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a multi-lane priority scheduler.
 *
 * Each configured lane gets its own PQueue with independent concurrency.
 * Tasks are routed to lanes by name; unknown lane names fall back to the
 * lowest-priority lane.
 *
 * An aging sweep timer runs periodically and emits `priority:aged_promotion`
 * events for monitoring when tasks have waited longer than the configured
 * agingPromotionMs threshold.
 *
 * @param deps - Lane configuration and event bus
 * @returns PriorityScheduler instance
 */
export function createPriorityScheduler(deps: PrioritySchedulerDeps): PriorityScheduler {
  const { eventBus } = deps;

  // Sort lanes by priority descending (highest first)
  const sortedConfigs = [...deps.lanes].sort((a, b) => b.priority - a.priority);

  // Build lane map
  const laneMap = new Map<string, LaneEntry>();
  let lowestLane: LaneEntry | undefined;

  for (const config of sortedConfigs) {
    const entry: LaneEntry = {
      queue: new PQueue({ concurrency: config.concurrency }),
      config,
      enqueueTimes: [],
    };
    laneMap.set(config.name, entry);
    // Track lowest-priority lane (last in sorted order)
    lowestLane = entry;
  }

  // If no lanes configured, create a default "normal" lane
  if (laneMap.size === 0) {
    const defaultConfig: PriorityLaneConfig = {
      name: "normal",
      concurrency: 5,
      priority: 0,
      agingPromotionMs: 0,
    };
    const entry: LaneEntry = {
      queue: new PQueue({ concurrency: 5 }),
      config: defaultConfig,
      enqueueTimes: [],
    };
    laneMap.set("normal", entry);
    lowestLane = entry;
  }

  let isShutdown = false;

  // -------------------------------------------------------------------------
  // Aging sweep timer (observability only)
  // -------------------------------------------------------------------------

  /**
   * Determine the lane name one priority level above a given lane.
   * Returns the lane name with the next higher priority, or the same
   * lane name if already highest.
   */
  function getHigherLaneName(currentLaneName: string): string {
    const currentIdx = sortedConfigs.findIndex((c) => c.name === currentLaneName);
    if (currentIdx <= 0) return sortedConfigs[0]?.name ?? currentLaneName;
    return sortedConfigs[currentIdx - 1]!.name;
  }

  const AGING_SWEEP_INTERVAL_MS = 5_000;
  let agingSweepTimer: ReturnType<typeof setInterval> | undefined;

  function startAgingSweep(): void {
    agingSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [laneName, entry] of laneMap) {
        if (entry.config.agingPromotionMs <= 0) continue;
        // Check oldest enqueue times
        for (const enqueueTime of entry.enqueueTimes) {
          const waitTimeMs = now - enqueueTime;
          if (waitTimeMs >= entry.config.agingPromotionMs) {
            eventBus.emit("priority:aged_promotion", {
              sessionKey: laneName,
              fromLane: laneName,
              toLane: getHigherLaneName(laneName),
              waitTimeMs,
              timestamp: now,
            });
          }
        }
      }
    }, AGING_SWEEP_INTERVAL_MS);

    // Don't keep the process alive just for aging sweep
    agingSweepTimer.unref();
  }

  startAgingSweep();

  // -------------------------------------------------------------------------
  // PriorityScheduler implementation
  // -------------------------------------------------------------------------

  return {
    async enqueue(laneName: string, task: () => Promise<void>): Promise<void> {
      if (isShutdown) {
        throw new Error("Priority scheduler is shut down");
      }

      // Resolve lane (fall back to lowest-priority lane)
      let lane = laneMap.get(laneName);
      if (!lane) {
        lane = lowestLane!;
      }

      const enqueuedAt = Date.now();
      lane.enqueueTimes.push(enqueuedAt);

      await lane.queue.add(async () => {
        // Remove enqueue timestamp (task is now executing)
        const idx = lane!.enqueueTimes.indexOf(enqueuedAt);
        if (idx !== -1) {
          lane!.enqueueTimes.splice(idx, 1);
        }
        await task();
      });
    },

    getStats(): Record<string, LaneStats> {
      const stats: Record<string, LaneStats> = {};
      for (const [name, entry] of laneMap) {
        stats[name] = {
          pending: entry.queue.size,
          executing: entry.queue.pending,
          concurrency: entry.config.concurrency,
          priority: entry.config.priority,
        };
      }
      return stats;
    },

    getTotalConcurrency(): number {
      let total = 0;
      for (const entry of laneMap.values()) {
        total += entry.config.concurrency;
      }
      return total;
    },

    pause(): void {
      for (const entry of laneMap.values()) {
        entry.queue.pause();
      }
    },

    resume(): void {
      for (const entry of laneMap.values()) {
        entry.queue.start();
      }
    },

    async drainAll(): Promise<void> {
      const promises: Promise<void>[] = [];
      for (const entry of laneMap.values()) {
        promises.push(entry.queue.onIdle());
      }
      await Promise.all(promises);
    },

    async shutdown(): Promise<void> {
      isShutdown = true;

      // Stop aging sweep
      if (agingSweepTimer !== undefined) {
        clearInterval(agingSweepTimer);
        agingSweepTimer = undefined;
      }

      // Pause all lanes
      for (const entry of laneMap.values()) {
        entry.queue.pause();
      }

      // Wait for active tasks to finish
      const activePromises: Promise<void>[] = [];
      for (const entry of laneMap.values()) {
        if (entry.queue.pending > 0) {
          activePromises.push(entry.queue.onIdle());
        }
      }
      await Promise.all(activePromises);

      // Clear all lanes
      for (const entry of laneMap.values()) {
        entry.queue.clear();
        entry.enqueueTimes.length = 0;
      }
    },
  };
}
