// SPDX-License-Identifier: Apache-2.0
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
import {
  err,
  fromPromise,
  ok,
  type Result,
} from "@comis/shared";
import type {
  NormalizedMessage,
  SessionKey,
  TypedEventBus,
  QueueConfig,
  PerChannelQueueConfig,
} from "@comis/core";
import type { InboundMessageProvenancePlan } from "@comis/agent";
import type { ComisLogger } from "@comis/core";
import {
  formatSessionKey,
  systemNowMs,
  systemSetTimeout,
  systemClearTimeout,
  systemSetInterval,
  systemClearInterval,
  tryGetContext,
} from "@comis/core";

import type {
  QueueMessageHandler,
  QueuedMessageEntry,
  SessionLane,
} from "./lane.js";
import { applyOverflowPolicyToQueueEntries } from "./overflow.js";
import {
  createSourceTerminalScope,
  type SourceTerminalScope,
} from "../source-message-terminal.js";
import {
  captureQueueAsyncScope,
  coalesceQueuedEntries,
  createQueueLaneIdentity,
  releaseQueueEntryResources,
  type QueueDiscardReason,
} from "./queue-entry-lifecycle.js";
import { createQueueObservability } from "./queue-observability.js";

interface ScheduledQueueTask {
  readonly controller: AbortController;
  started: boolean;
  entry?: QueuedMessageEntry;
  settled: Promise<void>;
}

/**
 * Dependencies required by createCommandQueue.
 */
export interface CommandQueueDeps {
  readonly eventBus: TypedEventBus;
  readonly config: QueueConfig;
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
    handler: QueueMessageHandler,
    sourceTerminalScope?: SourceTerminalScope,
    releaseResources?: () => void,
    inboundProvenancePlan?: InboundMessageProvenancePlan,
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
  const scheduledTasks = new Set<ScheduledQueueTask>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let isShutdown = false;
  let shutdownPromise: Promise<void> | undefined;
  const {
    emitQueueEvent,
    logQueueEventFailure,
    containBackgroundExecution,
  } = createQueueObservability(eventBus, logger);

  function emitRejectedEntries(
    entries: readonly QueuedMessageEntry[],
    reason: "queue_dropped" | "queue_rejected" | "queue_aborted",
    outcome: "error" | "aborted" = "error",
  ): void {
    const timestamp = systemNowMs();
    for (const entry of entries) {
      entry.sourceTerminalScope.publish(outcome, reason, timestamp);
      releaseEntryResources(entry, reason === "queue_dropped" ? "overflow" : "shutdown");
    }
  }

  function releaseEntryResources(
    entry: QueuedMessageEntry,
    reason: QueueDiscardReason,
  ): void {
    releaseQueueEntryResources(entry, reason, logger);
  }

  function emitDroppedEntries(
    before: readonly QueuedMessageEntry[],
    after: readonly QueuedMessageEntry[],
    policy: PerChannelQueueConfig["overflow"]["policy"],
  ): void {
    const retainedOwnership = new Set(after.map((entry) => entry.ownership));
    const removed = before.filter(
      (entry) => !retainedOwnership.has(entry.ownership),
    );
    if (policy === "summarize") {
      for (const entry of removed) releaseEntryResources(entry, "overflow");
      return;
    }
    emitRejectedEntries(removed, "queue_dropped");
  }

  /** Get or create a session lane for the given key. */
  function getOrCreateLane(key: string, baseSessionKey: string): SessionLane {
    let lane = lanes.get(key);
    if (!lane) {
      const sessionQueue = [...lanes.values()].find(
        (candidate) => candidate.baseSessionKey === baseSessionKey,
      )?.queue ?? new PQueue({ concurrency: 1 });
      lane = {
        baseSessionKey,
        queue: sessionQueue,
        pendingEntries: [],
        logicalDepth: 0,
        isExecuting: false,
        lastActivityMs: systemNowMs(),
      };
      lanes.set(key, lane);
      logger?.debug({ sessionKey: baseSessionKey }, "Session lane created");
    }
    lane.lastActivityMs = systemNowMs();
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
  ): void {
    if (lane.pendingEntries.length === 0) return;

    if (isShutdown) {
      const discardedCount = lane.pendingEntries.reduce(
        (count, entry) => count + entry.logicalCount,
        0,
      );
      const rejected = lane.pendingEntries;
      lane.pendingEntries = [];
      lane.logicalDepth = Math.max(0, lane.logicalDepth - discardedCount);
      emitRejectedEntries(rejected, "queue_rejected");
      return;
    }

    const collected = [...lane.pendingEntries];
    lane.pendingEntries = [];

    const coalescedEntry = coalesceQueuedEntries(
      collected,
      releaseEntryResources,
    );

    coalescedEntry.runInAsyncScope(() => {
      emitQueueEvent("queue:coalesced", {
        sessionKey: coalescedEntry.sessionKey,
        channelType: coalescedEntry.channelType,
        messageCount: collected.length,
        timestamp: systemNowMs(),
      }, coalescedEntry.channelType);

      // Enqueue a single task with the coalesced message. Register the
      // Result conversion inside the retained entry's captured async scope so
      // its error log keeps the same request identity as execution.
      void containBackgroundExecution(
        executeLaneTask(
          lane,
          coalescedEntry,
          () => processCollectedMessages(key, lane),
        ),
        "collect",
        coalescedEntry.channelType,
      );
    });
  }

  /** Start the periodic cleanup sweep for idle lanes. */
  function startCleanupSweep(): void {
    const sweepIntervalMs = Math.min(config.cleanupIdleMs, 60_000);
    cleanupTimer = systemSetInterval(() => {
      const now = systemNowMs();
      for (const [key, lane] of lanes) {
        if (
          !lane.isExecuting &&
          lane.queue.size === 0 &&
          lane.queue.pending === 0 &&
          lane.pendingEntries.length === 0 &&
          now - lane.lastActivityMs > config.cleanupIdleMs
        ) {
          lanes.delete(key);
          logger?.debug(
            { sessionKey: lane.baseSessionKey },
            "Idle lane cleaned up",
          );
        }
      }
    }, sweepIntervalMs);

    // Don't keep the process alive just for cleanup
    cleanupTimer.unref();
  }

  // Start the cleanup sweep immediately
  startCleanupSweep();

  function scheduleLaneTask(
    lane: SessionLane,
    task: (scheduled: ScheduledQueueTask) => Promise<void>,
    entry?: QueuedMessageEntry,
  ): Promise<void> {
    const scheduled: ScheduledQueueTask = {
      controller: new AbortController(),
      started: false,
      ...(entry === undefined ? {} : { entry }),
      settled: Promise.resolve(),
    };
    scheduledTasks.add(scheduled);
    const promise = lane.queue.add(
      () => task(scheduled),
      { signal: scheduled.controller.signal },
    ) as Promise<void>;
    scheduled.settled = fromPromise(promise).then(() => {
      scheduledTasks.delete(scheduled);
    });
    return promise;
  }

  /** Route a task through the globalGate. */
  function runThroughGate(
    task: () => Promise<void>,
    scheduled: ScheduledQueueTask,
  ): Promise<void> {
    return globalGate.add(
      () => {
        scheduled.started = true;
        return task();
      },
      { signal: scheduled.controller.signal },
    ) as Promise<void>;
  }

  function runEntryThroughGate(
    lane: SessionLane,
    entry: QueuedMessageEntry,
    scheduled: ScheduledQueueTask,
    onComplete?: () => void,
  ): Promise<void> {
    return runThroughGate(() =>
      entry.runInAsyncScope(async () => {
        const dequeuedAt = systemNowMs();
        const waitTimeMs = Math.max(0, dequeuedAt - entry.enqueuedAt);
        emitQueueEvent("queue:dequeued", {
          sessionKey: entry.sessionKey,
          channelType: entry.channelType,
          waitTimeMs,
          timestamp: dequeuedAt,
        }, entry.channelType);
        logger?.info(
          {
            step: "queue-dequeue",
            channelType: entry.channelType,
            waitTimeMs,
          },
          "Message dequeued",
        );
        lane.isExecuting = true;
        lane.abortController = new AbortController();
        lane.activeEntry = entry;
        entry.ownership.executionStarted = true;
        try {
          await entry.handler([entry.message], {
            signal: lane.abortController.signal,
            receivedAt: entry.receivedAt,
            sourceTerminalScope: entry.sourceTerminalScope,
            inboundProvenancePlans: entry.inboundProvenancePlans,
          });
        } finally {
          lane.isExecuting = false;
          delete lane.abortController;
          if (lane.activeEntry === entry) delete lane.activeEntry;
          lane.logicalDepth = Math.max(
            0,
            lane.logicalDepth - entry.logicalCount,
          );
          lane.lastActivityMs = systemNowMs();
          onComplete?.();
        }
      }),
      scheduled,
    );
  }

  /**
   * Execute a handler within a lane, gated by global concurrency.
   * Manages lane lifecycle (isExecuting, abortController, lastActivity)
   * and emits queue:dequeued event.
   */
  function executeLaneTask(
    lane: SessionLane,
    entry: QueuedMessageEntry,
    onComplete?: () => void,
  ): Promise<void> {
    return scheduleLaneTask(
      lane,
      (scheduled) => runEntryThroughGate(
        lane,
        entry,
        scheduled,
        onComplete,
      ),
      entry,
    );
  }

  async function performShutdown(): Promise<void> {
    logger?.debug({ activeLanes: lanes.size }, "Command queue shutting down");
    isShutdown = true;

    for (const timer of debounceTimers.values()) systemClearTimeout(timer);
    debounceTimers.clear();

    if (cleanupTimer !== undefined) {
      systemClearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }

    for (const lane of lanes.values()) lane.queue.pause();
    globalGate.pause();

    // Publish ownership outcomes before cancellation settles any enqueue call.
    // Every outer boundary shares the same scope, so its fallback publish is a
    // no-op instead of a second terminal event.
    const notStarted = [...scheduledTasks].filter(
      (scheduled) => !scheduled.started,
    );
    emitRejectedEntries(
      notStarted.flatMap((scheduled) =>
        scheduled.entry === undefined ? [] : [scheduled.entry]),
      "queue_rejected",
    );
    for (const lane of lanes.values()) {
      emitRejectedEntries(lane.pendingEntries, "queue_rejected");
      lane.pendingEntries = [];
      if (lane.activeEntry !== undefined) {
        emitRejectedEntries([lane.activeEntry], "queue_aborted", "aborted");
      }
      lane.abortController?.abort();
    }

    for (const scheduled of notStarted) {
      scheduled.controller.abort(
        new Error("Command queue shut down before message execution started"),
      );
    }
    await Promise.all(notStarted.map((scheduled) => scheduled.settled));

    // Wait for active lanes with a bounded timeout. Their canonical aborted
    // terminal has already been published, so late completion cannot reclassify
    // the physical source.
    const activePromises: Promise<void>[] = [];
    for (const lane of lanes.values()) {
      if (lane.isExecuting) activePromises.push(lane.queue.onIdle());
    }
    if (activePromises.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(activePromises),
        new Promise<void>((resolve) => {
          timeout = systemSetTimeout(resolve, 3_000);
        }),
      ]);
      if (timeout !== undefined) systemClearTimeout(timeout);
    }

    for (const lane of lanes.values()) {
      lane.queue.clear();
      lane.pendingEntries = [];
      lane.logicalDepth = 0;
    }
    globalGate.clear();
    lanes.clear();
  }

  return {
    async enqueue(
      sessionKey: SessionKey,
      message: NormalizedMessage,
      channelType: string,
      handler: QueueMessageHandler,
      sourceTerminalScope?: SourceTerminalScope,
      releaseResources?: () => void,
      inboundProvenancePlan?: InboundMessageProvenancePlan,
    ): Promise<Result<void, Error>> {
      if (isShutdown) {
        return err(new Error("Command queue is shut down"));
      }

      try {
        const context = tryGetContext();
        const { baseSessionKey, laneKey: key } = createQueueLaneIdentity(
          sessionKey,
          channelType,
          context,
        );
        const lane = getOrCreateLane(key, baseSessionKey);
        const channelConfig = resolveChannelConfig(channelType);
        const enqueuedAt = systemNowMs();
        const contextStartedAt = context?.startedAt;
        const receivedAt =
          contextStartedAt !== undefined &&
          Number.isSafeInteger(contextStartedAt) &&
          contextStartedAt > 0
            ? Math.min(contextStartedAt, enqueuedAt)
            : enqueuedAt;
        const entry: QueuedMessageEntry = {
          message,
          inboundProvenancePlans: inboundProvenancePlan === undefined
            ? []
            : [inboundProvenancePlan],
          sessionKey,
          channelType,
          enqueuedAt,
          receivedAt,
          logicalCount: 1,
          handler,
          runInAsyncScope: captureQueueAsyncScope(),
          ownership: {
            executionStarted: false,
            resourcesReleased: false,
            ...(releaseResources === undefined ? {} : { releaseResources }),
          },
          sourceTerminalScope: sourceTerminalScope ?? createSourceTerminalScope(
            { eventBus, ...(logger === undefined ? {} : { logger }) },
            message,
            channelType,
          ),
        };
        lane.logicalDepth++;

        // Emit enqueued event
        emitQueueEvent("queue:enqueued", {
          sessionKey,
          channelType,
          queueDepth: lane.logicalDepth,
          mode: channelConfig.mode,
          timestamp: enqueuedAt,
        }, channelType);

        const mode = channelConfig.mode;

        logger?.info(
          {
            step: "queue-enqueue",
            channelType,
            mode: channelConfig.mode,
            queueDepth: lane.logicalDepth,
          },
          "Message enqueued",
        );

        // ---------------------------------------------------------------
        // followup mode: Each message gets its own execution (default)
        // ---------------------------------------------------------------
        if (mode === "followup") {
          await executeLaneTask(lane, entry);
          return ok(undefined);
        }

        // ---------------------------------------------------------------
        // collect mode: Accumulate messages, coalesce after execution ends
        // ---------------------------------------------------------------
        if (mode === "collect") {
          if (lane.isExecuting) {
            // Lane is busy — accumulate message in pending list
            lane.pendingEntries.push(entry);

            // Apply overflow policy
            const pendingBeforeOverflow = [...lane.pendingEntries];
            const overflowResult = applyOverflowPolicyToQueueEntries(
              lane.pendingEntries,
              channelConfig.overflow,
              eventBus,
              sessionKey,
              channelType,
              (error) => logQueueEventFailure(
                "queue:overflow",
                error,
                channelType,
              ),
            );
            lane.pendingEntries = overflowResult.entries;
            emitDroppedEntries(
              pendingBeforeOverflow,
              overflowResult.entries,
              channelConfig.overflow.policy,
            );
            lane.logicalDepth = Math.max(
              0,
              lane.logicalDepth - overflowResult.dropped,
            );

            // If debounceMs > 0, reset debounce timer. The timer will
            // process collected messages after the debounce period if the
            // current execution has already finished by then.
            if (channelConfig.debounceMs > 0) {
              const existingTimer = debounceTimers.get(key);
              if (existingTimer !== undefined) {
                systemClearTimeout(existingTimer);
              }
              debounceTimers.set(
                key,
                systemSetTimeout(() => {
                  debounceTimers.delete(key);
                  // Only process if execution has finished by debounce time
                  if (!lane.isExecuting) {
                    processCollectedMessages(key, lane);
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
            lane,
            entry,
            () => processCollectedMessages(key, lane),
          );
          return ok(undefined);
        }

        // ---------------------------------------------------------------
        // steer mode: Abort current execution, restart with combined context
        // ---------------------------------------------------------------
        if (mode === "steer") {
          if (lane.isExecuting) {
            // Accumulate message
            lane.pendingEntries.push(entry);

            // Apply overflow policy
            const pendingBeforeOverflow = [...lane.pendingEntries];
            const overflowResult = applyOverflowPolicyToQueueEntries(
              lane.pendingEntries,
              channelConfig.overflow,
              eventBus,
              sessionKey,
              channelType,
              (error) => logQueueEventFailure(
                "queue:overflow",
                error,
                channelType,
              ),
            );
            lane.pendingEntries = overflowResult.entries;
            emitDroppedEntries(
              pendingBeforeOverflow,
              overflowResult.entries,
              channelConfig.overflow.policy,
            );
            lane.logicalDepth = Math.max(
              0,
              lane.logicalDepth - overflowResult.dropped,
            );

            // Abort the current execution
            lane.abortController?.abort();

            // Clear any existing debounce timer
            const existingTimer = debounceTimers.get(key);
            if (existingTimer !== undefined) {
              systemClearTimeout(existingTimer);
              debounceTimers.delete(key);
            }

            // Steer re-execution after abort -- unique logic, not extractable to
            // executeLaneTask (coalesces pending messages inside the gate callback).
            const steerTask = scheduleLaneTask(lane, async (scheduled) => {
              if (lane.pendingEntries.length === 0) return;
              const collected = [...lane.pendingEntries];
              lane.pendingEntries = [];
              const coalescedEntry = coalesceQueuedEntries(
                collected,
                releaseEntryResources,
              );
              scheduled.entry = coalescedEntry;
              await coalescedEntry.runInAsyncScope(async () => {
                emitQueueEvent("queue:coalesced", {
                  sessionKey: coalescedEntry.sessionKey,
                  channelType: coalescedEntry.channelType,
                  messageCount: collected.length,
                  timestamp: systemNowMs(),
                }, coalescedEntry.channelType);
                await containBackgroundExecution(
                  runEntryThroughGate(
                    lane,
                    coalescedEntry,
                    scheduled,
                  ),
                  "steer",
                  coalescedEntry.channelType,
                );
              });
            });
            // The retained-entry execution converts its rejection to Result.
            // This outer conversion contains only unexpected scheduler faults.
            void fromPromise(steerTask);
            return ok(undefined);
          }

          // Lane is idle — process immediately (like followup)
          await executeLaneTask(lane, entry);
          return ok(undefined);
        }

        // Unknown mode — treat as followup for safety
        await executeLaneTask(lane, entry);
        return ok(undefined);
      } catch (error: unknown) {
        const wrapped =
          error instanceof Error ? error : new Error(String(error));
        return err(wrapped);
      }
    },

    getQueueDepth(sessionKey: SessionKey): number {
      const key = formatSessionKey(sessionKey);
      return [...lanes.values()].reduce(
        (depth, lane) => lane.baseSessionKey === key
          ? depth + lane.logicalDepth
          : depth,
        0,
      );
    },

    isProcessing(sessionKey: SessionKey): boolean {
      const key = formatSessionKey(sessionKey);
      return [...lanes.values()].some(
        (lane) => lane.baseSessionKey === key && lane.isExecuting,
      );
    },

    async drain(sessionKey: SessionKey): Promise<void> {
      const key = formatSessionKey(sessionKey);
      await Promise.all([...lanes.values()]
        .filter((lane) => lane.baseSessionKey === key)
        .map((lane) => lane.queue.onIdle()));
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
      const now = systemNowMs();
      for (const lane of lanes.values()) {
        if (lane.baseSessionKey === sessionKey) lane.lastActivityMs = now;
      }
    },

    getStats(): QueueStats {
      let totalPending = 0;
      let totalExecuting = 0;
      for (const lane of lanes.values()) {
        totalPending += lane.logicalDepth;
        if (lane.isExecuting) totalExecuting++;
      }
      return {
        activeLanes: lanes.size,
        totalPending,
        totalExecuting,
      };
    },

    shutdown(): Promise<void> {
      if (shutdownPromise !== undefined) return shutdownPromise;
      shutdownPromise = performShutdown();
      return shutdownPromise;
    },
  };
}
