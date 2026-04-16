/**
 * Command Queue: Lane-aware FIFO queue with per-session serialization.
 *
 * Prevents race conditions from concurrent agent executions for the same
 * session by routing messages through per-session lanes (PQueue concurrency=1).
 * A global gate (PQueue with configurable concurrency) limits total parallel
 * agent runs across all sessions.
 *
 * Supports three queue modes per channel type:
 * - **followup**: Each message enqueued as separate task (default)
 * - **collect**: Accumulate rapid messages, coalesce into single follow-up turn
 * - **steer**: Abort current execution, restart with combined context
 *
 * Lifecycle: idle session lanes are garbage collected after a configurable
 * timeout to prevent memory leaks.
 */

import PQueue from "p-queue";
import { ok, err, type Result } from "@comis/shared";
import type {
  NormalizedMessage,
  SessionKey,
  TypedEventBus,
  QueueConfig,
  PerChannelQueueConfig,
} from "@comis/core";
import type { ComisLogger } from "@comis/infra";
import type { PriorityScheduler } from "./priority-scheduler.js";
import { formatSessionKey } from "@comis/core";

import type { SessionLane } from "./lane.js";
import { applyOverflowPolicy } from "./overflow.js";
import { coalesceMessages } from "./coalescer.js";

/**
 * Dependencies required by createCommandQueue.
 */
export interface CommandQueueDeps {
  readonly eventBus: TypedEventBus;
  readonly config: QueueConfig;
  /** Optional priority scheduler for multi-lane gate replacement. When provided, tasks are routed through lanes instead of the global gate. */
  readonly priorityScheduler?: PriorityScheduler;
  /** Optional structured logger for queue lifecycle tracing. */
  readonly logger?: ComisLogger;
}

/**
 * Queue statistics for observability.
 */
export interface QueueStats {
  /** Number of session lanes currently in the map */
  activeLanes: number;
  /** Total messages waiting across all lanes */
  totalPending: number;
  /** Number of lanes currently executing a handler */
  totalExecuting: number;
}

/**
 * CommandQueue interface for enqueuing messages and managing queue lifecycle.
 */
export interface CommandQueue {
  /**
   * Enqueue a message for processing.
   *
   * The handler will be called when it is this message's turn to execute
   * in the session lane, gated by global concurrency. Returns when the
   * message has been fully processed.
   */
  enqueue(
    sessionKey: SessionKey,
    message: NormalizedMessage,
    channelType: string,
    handler: (messages: NormalizedMessage[]) => Promise<void>,
    priorityLane?: string,
  ): Promise<Result<void, Error>>;

  /** Get current queue depth for a session (waiting + in-progress) */
  getQueueDepth(sessionKey: SessionKey): number;

  /** Check if a session is currently executing a handler */
  isProcessing(sessionKey: SessionKey): boolean;

  /** Wait for all pending work in a session to complete */
  drain(sessionKey: SessionKey): Promise<void>;

  /** Wait for all sessions to complete */
  drainAll(): Promise<void>;

  /** Get queue statistics */
  getStats(): QueueStats;

  /**
   * Refresh the lastActivityMs timestamp on an existing lane, preventing
   * idle cleanup from reaping it. No-op if the lane does not exist (already
   * reaped or never created). Used by graph coordinator to keep the parent
   * session alive during long-running graph executions.
   *
   * @param sessionKey - Already-formatted session key string (not a SessionKey object)
   */
  touchLane(sessionKey: string): void;

  /** Stop the cleanup timer, clear all lanes, wait for active work */
  shutdown(): Promise<void>;
}

/**
 * Create a lane-aware command queue with per-session serialization.
 *
 * Each session key gets an independent PQueue (concurrency=1) that
 * serializes execution. All lane queues route through a global gate
 * (PQueue with maxConcurrentSessions concurrency) that caps the total
 * number of parallel agent runs.
 *
 * @param deps - Event bus and queue configuration
 * @returns CommandQueue instance
 */
export function createCommandQueue(deps: CommandQueueDeps): CommandQueue {
  const { eventBus, config, logger } = deps;

  const lanes = new Map<string, SessionLane>();
  const globalGate = new PQueue({ concurrency: config.maxConcurrentSessions });

  /** Debounce timers keyed by session key (collect mode). */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let isShutdown = false;

  /** Get or create a session lane for the given key. */
  function getOrCreateLane(key: string): SessionLane {
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        queue: new PQueue({ concurrency: 1 }),
        pendingMessages: [],
        isExecuting: false,
        lastActivityMs: Date.now(),
      };
      lanes.set(key, lane);
      logger?.debug({ sessionKey: key }, "Session lane created");
    }
    lane.lastActivityMs = Date.now();
    return lane;
  }

  /** Resolve the per-channel queue configuration, falling back to defaults. */
  function resolveChannelConfig(channelType: string): PerChannelQueueConfig {
    const override = config.perChannel[channelType];
    if (override) {
      return override;
    }
    return {
      mode: config.defaultMode,
      overflow: config.defaultOverflow,
      debounceMs: config.defaultDebounceMs,
    };
  }

  /** Process collected pending messages: coalesce and enqueue as a single task. */
  function processCollectedMessages(
    key: string,
    lane: SessionLane,
    sessionKey: SessionKey,
    channelType: string,
    handler: (messages: NormalizedMessage[]) => Promise<void>,
    priorityLane?: string,
  ): void {
    if (lane.pendingMessages.length === 0) return;

    const collected = [...lane.pendingMessages];
    lane.pendingMessages = [];

    const coalesced = coalesceMessages(collected);

    // Emit coalesced event
    eventBus.emit("queue:coalesced", {
      sessionKey,
      channelType,
      messageCount: collected.length,
      timestamp: Date.now(),
    });

    // Enqueue a single task with the coalesced message
    void executeLaneTask(
      lane, sessionKey, channelType, priorityLane, Date.now(), [coalesced], handler,
      () => processCollectedMessages(key, lane, sessionKey, channelType, handler, priorityLane),
    );
  }

  /** Start the periodic cleanup sweep for idle lanes. */
  function startCleanupSweep(): void {
    const sweepIntervalMs = Math.min(config.cleanupIdleMs, 60_000);
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, lane] of lanes) {
        if (
          !lane.isExecuting &&
          lane.queue.size === 0 &&
          lane.queue.pending === 0 &&
          lane.pendingMessages.length === 0 &&
          now - lane.lastActivityMs > config.cleanupIdleMs
        ) {
          lanes.delete(key);
          logger?.debug({ sessionKey: key }, "Idle lane cleaned up");
        }
      }
    }, sweepIntervalMs);

    // Don't keep the process alive just for cleanup
    cleanupTimer.unref();
  }

  // Start the cleanup sweep immediately
  startCleanupSweep();

  /** Route a task through the PriorityScheduler (if provided) or the globalGate. */
  function runThroughGate(laneName: string | undefined, task: () => Promise<void>): Promise<void> {
    if (deps.priorityScheduler) {
      return deps.priorityScheduler.enqueue(laneName ?? "normal", task);
    }
    return globalGate.add(task) as Promise<void>;
  }

  /**
   * Execute a handler within a lane, gated by global concurrency.
   * Manages lane lifecycle (isExecuting, abortController, lastActivity)
   * and emits queue:dequeued event.
   */
  function executeLaneTask(
    lane: SessionLane,
    sessionKey: SessionKey,
    channelType: string,
    priorityLane: string | undefined,
    enqueuedAt: number,
    messages: NormalizedMessage[],
    handler: (messages: NormalizedMessage[]) => Promise<void>,
    onComplete?: () => void,
  ): Promise<void> {
    return lane.queue.add(() =>
      runThroughGate(priorityLane, async () => {
        const dequeuedAt = Date.now();
        eventBus.emit("queue:dequeued", {
          sessionKey,
          channelType,
          waitTimeMs: dequeuedAt - enqueuedAt,
          timestamp: dequeuedAt,
        });
        lane.isExecuting = true;
        lane.abortController = new AbortController();
        try {
          await handler(messages);
        } finally {
          lane.isExecuting = false;
          delete lane.abortController;
          lane.lastActivityMs = Date.now();
          onComplete?.();
        }
      }),
    ) as Promise<void>;
  }

  return {
    async enqueue(
      sessionKey: SessionKey,
      message: NormalizedMessage,
      channelType: string,
      handler: (messages: NormalizedMessage[]) => Promise<void>,
      priorityLane?: string,
    ): Promise<Result<void, Error>> {
      if (isShutdown) {
        return err(new Error("Command queue is shut down"));
      }

      try {
        const key = formatSessionKey(sessionKey);
        const lane = getOrCreateLane(key);
        const channelConfig = resolveChannelConfig(channelType);
        const enqueuedAt = Date.now();

        // Emit enqueued event
        eventBus.emit("queue:enqueued", {
          sessionKey,
          channelType,
          queueDepth: lane.queue.size + lane.queue.pending + 1,
          mode: channelConfig.mode,
          timestamp: enqueuedAt,
        });

        const mode = channelConfig.mode;

        logger?.debug({ channelType, mode: channelConfig.mode, queueDepth: lane.queue.size + lane.queue.pending + 1 }, "Message enqueued");

        // ---------------------------------------------------------------
        // followup mode: Each message gets its own execution (default)
        // ---------------------------------------------------------------
        if (mode === "followup") {
          await executeLaneTask(lane, sessionKey, channelType, priorityLane, enqueuedAt, [message], handler);
          return ok(undefined);
        }

        // ---------------------------------------------------------------
        // collect mode: Accumulate messages, coalesce after execution ends
        // ---------------------------------------------------------------
        if (mode === "collect") {
          if (lane.isExecuting) {
            // Lane is busy — accumulate message in pending list
            lane.pendingMessages.push(message);

            // Apply overflow policy
            const overflowResult = applyOverflowPolicy(
              lane.pendingMessages,
              channelConfig.overflow,
              eventBus,
              sessionKey,
              channelType,
            );
            lane.pendingMessages = overflowResult.messages;

            // If debounceMs > 0, reset debounce timer. The timer will
            // process collected messages after the debounce period if the
            // current execution has already finished by then.
            if (channelConfig.debounceMs > 0) {
              const existingTimer = debounceTimers.get(key);
              if (existingTimer !== undefined) {
                clearTimeout(existingTimer);
              }
              debounceTimers.set(
                key,
                setTimeout(() => {
                  debounceTimers.delete(key);
                  // Only process if execution has finished by debounce time
                  if (!lane.isExecuting) {
                    processCollectedMessages(key, lane, sessionKey, channelType, handler, priorityLane);
                  }
                  // Otherwise, processCollectedMessages will be called in the
                  // finally block of the currently executing handler.
                }, channelConfig.debounceMs),
              );
            }

            return ok(undefined);
          }

          // Lane is idle — process immediately (no debounce for first message)
          await executeLaneTask(
            lane, sessionKey, channelType, priorityLane, enqueuedAt, [message], handler,
            () => processCollectedMessages(key, lane, sessionKey, channelType, handler, priorityLane),
          );
          return ok(undefined);
        }

        // ---------------------------------------------------------------
        // steer mode: Abort current execution, restart with combined context
        // ---------------------------------------------------------------
        if (mode === "steer") {
          if (lane.isExecuting) {
            // Accumulate message
            lane.pendingMessages.push(message);

            // Apply overflow policy
            const overflowResult = applyOverflowPolicy(
              lane.pendingMessages,
              channelConfig.overflow,
              eventBus,
              sessionKey,
              channelType,
            );
            lane.pendingMessages = overflowResult.messages;

            // Abort the current execution
            lane.abortController?.abort();

            // Clear any existing debounce timer
            const existingTimer = debounceTimers.get(key);
            if (existingTimer !== undefined) {
              clearTimeout(existingTimer);
              debounceTimers.delete(key);
            }

            // Steer re-execution after abort -- unique logic, not extractable to
            // executeLaneTask (coalesces pending messages inside the gate callback).
            void lane.queue.add(() =>
              runThroughGate(priorityLane, async () => {
                if (lane.pendingMessages.length === 0) return;
                const collected = [...lane.pendingMessages];
                lane.pendingMessages = [];
                const coalesced = coalesceMessages(collected);
                eventBus.emit("queue:coalesced", {
                  sessionKey, channelType,
                  messageCount: collected.length, timestamp: Date.now(),
                });
                lane.isExecuting = true;
                lane.abortController = new AbortController();
                try {
                  await handler([coalesced]);
                } finally {
                  lane.isExecuting = false;
                  delete lane.abortController;
                  lane.lastActivityMs = Date.now();
                }
              }),
            );
            return ok(undefined);
          }

          // Lane is idle — process immediately (like followup)
          await executeLaneTask(lane, sessionKey, channelType, priorityLane, enqueuedAt, [message], handler);
          return ok(undefined);
        }

        // Unknown mode — treat as followup for safety
        await executeLaneTask(lane, sessionKey, channelType, priorityLane, enqueuedAt, [message], handler);
        return ok(undefined);
      } catch (error: unknown) {
        const wrapped =
          error instanceof Error ? error : new Error(String(error));
        return err(wrapped);
      }
    },

    getQueueDepth(sessionKey: SessionKey): number {
      const key = formatSessionKey(sessionKey);
      const lane = lanes.get(key);
      if (!lane) return 0;
      return lane.queue.size + lane.queue.pending;
    },

    isProcessing(sessionKey: SessionKey): boolean {
      const key = formatSessionKey(sessionKey);
      const lane = lanes.get(key);
      if (!lane) return false;
      return lane.isExecuting;
    },

    async drain(sessionKey: SessionKey): Promise<void> {
      const key = formatSessionKey(sessionKey);
      const lane = lanes.get(key);
      if (!lane) return;
      await lane.queue.onIdle();
    },

    async drainAll(): Promise<void> {
      const drainPromises: Promise<void>[] = [];
      for (const lane of lanes.values()) {
        drainPromises.push(lane.queue.onIdle());
      }
      await Promise.all(drainPromises);
      await globalGate.onIdle();
    },

    touchLane(sessionKey: string): void {
      const lane = lanes.get(sessionKey);
      if (lane) {
        lane.lastActivityMs = Date.now();
      }
    },

    getStats(): QueueStats {
      let totalPending = 0;
      let totalExecuting = 0;
      for (const lane of lanes.values()) {
        totalPending += lane.queue.size + lane.queue.pending;
        if (lane.isExecuting) totalExecuting++;
      }
      return {
        activeLanes: lanes.size,
        totalPending,
        totalExecuting,
      };
    },

    async shutdown(): Promise<void> {
      logger?.debug({ activeLanes: lanes.size }, "Command queue shutting down");
      isShutdown = true;

      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();

      if (cleanupTimer !== undefined) { clearInterval(cleanupTimer); cleanupTimer = undefined; }

      for (const lane of lanes.values()) lane.queue.pause();
      globalGate.pause();

      if (deps.priorityScheduler) await deps.priorityScheduler.shutdown();

      // Signal abort to all active lanes so in-flight LLM executions can
      // terminate early rather than blocking shutdown indefinitely.
      for (const lane of lanes.values()) {
        if (lane.isExecuting && lane.abortController) {
          lane.abortController.abort();
        }
      }

      // Wait for active lanes with a bounded timeout -- don't block shutdown
      // indefinitely if an execution ignores the abort signal.
      const activePromises: Promise<void>[] = [];
      for (const lane of lanes.values()) {
        if (lane.isExecuting) activePromises.push(lane.queue.onIdle());
      }
      if (activePromises.length > 0) {
        await Promise.race([
          Promise.all(activePromises),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }

      for (const lane of lanes.values()) { lane.queue.clear(); lane.pendingMessages = []; }
      globalGate.clear();
      lanes.clear();
    },
  };
}
