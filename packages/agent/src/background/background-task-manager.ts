// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { hardTimeoutHint } from "./hard-timeout-hint.js";
import { ok, err, fromPromise, tryCatch, type Result } from "@comis/shared";
import {
  BackgroundTaskOriginSchema,
  conversationScopeToSessionKey,
  emitObservationalEventSafely,
  formatSessionKey,
  sanitizeLogString,
  type TypedEventBus,
  type ClockPort,
  type TimerHandle,
  type TimerPort,
  type ErrorKind,
  type BackgroundTaskFailureCode,
} from "@comis/core";
import {
  persistTaskAtomically,
  recoverTasks,
  removeTaskFile,
  type AtomicTaskPersistenceOps,
  type TaskRecoveryOps,
} from "./background-task-persistence.js";
import { createBackgroundTaskRecoveryController } from "./background-task-recovery-controller.js";
import type {
  BackgroundTask,
  BackgroundContinuationOutbox,
  BackgroundTaskOrigin,
  BackgroundSessionState,
  BackgroundTaskNotificationPolicy,
  BackgroundFinalizedResult,
  BackgroundRecoveryIncidentInput,
  BackgroundRecoveryRecorderDisposition,
  BackgroundRecoveryRecorderFailure,
} from "./background-task-types.js";
import {
  BackgroundContinuationOutboxSchema,
  BackgroundFinalizedResultSchema,
  isClosedBackgroundTask,
} from "./background-task-types.js";

/** Notification callback fired when background task completes or fails. */
export type NotifyFn = (opts: {
  agentId: string;
  message: string;
  priority: "normal";
  origin: "background_task";
}) => Promise<unknown>;

export interface BackgroundTaskManagerOpts {
  dataDir: string;
  eventBus: TypedEventBus;
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  /** Wall-clock + monotonic time reads. */
  clock: ClockPort;
  /** Timer scheduling. Hard-timeout setTimeout uses .unref(). */
  timers: TimerPort;
  maxPerAgent?: number | ((agentId: string) => number);
  maxTotal?: number;
  /** Agent whose configured maxTotal supplies the shared daemon-wide cap. */
  maxTotalConfigAgentId?: string;
  maxBackgroundDurationMs?: number | ((agentId: string) => number);
  persistenceOps?: AtomicTaskPersistenceOps;
  recoveryOps?: TaskRecoveryOps;
}

export interface BackgroundTaskManager {
  promote(
    toolName: string,
    promise: Promise<unknown>,
    ac: AbortController,
    origin: BackgroundTaskOrigin,
    notificationPolicy?: BackgroundTaskNotificationPolicy,
    /** Ids-only correlation to the originating tool call + turn — lets the
     *  terminal event close the right activity card (see BackgroundTask). */
    correlation?: { toolCallId?: string; sessionKey?: string; traceId?: string },
  ): Result<string, Error>;
  complete(taskId: string, result: unknown): Result<void, Error>;
  fail(taskId: string, error: unknown, errorKind?: ErrorKind): Result<void, Error>;
  cancel(taskId: string): Result<void, Error>;
  getTask(taskId: string): BackgroundTask | undefined;
  waitForTask(
    taskId: string,
    onWaiting?: () => void,
    waitHeartbeatMs?: number,
  ): Promise<Result<BackgroundTask, Error>>;
  getTasks(agentId: string): BackgroundTask[];
  getAllTasks(): BackgroundTask[];
  recoverOnStartup(
    recordIncident: (
      input: BackgroundRecoveryIncidentInput,
    ) => Result<
      BackgroundRecoveryRecorderDisposition,
      BackgroundRecoveryRecorderFailure
    >,
  ): void;
  cleanup(maxAgeMs?: number): void;
  commitDispatchState(
    taskId: string,
    next: BackgroundSessionState,
    expected?: readonly BackgroundSessionState[],
  ): Result<boolean, Error>;
  acknowledgeLiveConsumption(taskId: string): Result<boolean, Error>;
  persistContinuationOutbox(
    taskId: string,
    outbox: BackgroundContinuationOutbox,
    expected?: readonly BackgroundSessionState[],
  ): Result<void, Error>;
  persistCleanupPendingOutbox(
    taskId: string,
    outbox: BackgroundContinuationOutbox,
    expected?: readonly BackgroundSessionState[],
  ): Result<void, Error>;
  persistFinalizedResult(
    taskId: string,
    result: BackgroundFinalizedResult,
    expected?: readonly BackgroundSessionState[],
  ): Result<void, Error>;
  recordRecoveryIncident(taskId: string): void;
  scheduleDispatchRetry(taskId: string): void;
  scheduleStateRetry(
    taskId: string,
    next: BackgroundSessionState,
    expected: readonly BackgroundSessionState[],
  ): void;
}

const MAX_RESULT_CHARS = 102_400; // 100KB
const SKILL_IMPORT_INCOMPLETE_PREFIX = "Skill import is incomplete:";
const MCP_CONNECT_MISSING_PARAM_PREFIX = '[missing_param] mcp_manage(action="connect")';
const MCP_SECRET_REFERENCE_MISSING_PREFIX = '[invalid_value] enabled MCP server "';

function classifyBackgroundTaskFailure(
  toolName: string,
  error: unknown,
): BackgroundTaskFailureCode | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (toolName === "skills_manage" && message.startsWith(SKILL_IMPORT_INCOMPLETE_PREFIX)) {
    return "skill_import_incomplete";
  }
  if (
    toolName === "mcp_manage"
    && message.startsWith(MCP_CONNECT_MISSING_PARAM_PREFIX)
    && message.includes("command or url")
  ) {
    return "mcp_connection_details_missing";
  }
  if (
    toolName === "mcp_manage"
    && message.startsWith(MCP_SECRET_REFERENCE_MISSING_PREFIX)
    && message.includes(" references ")
    && message.includes(" which is not in the secrets store")
  ) {
    return "mcp_secret_reference_missing";
  }
  return undefined;
}

function projectBackgroundCompletionResult(
  serializedResult: string | undefined,
): {
  resultOutcome?: "success" | "degraded";
  persistence?: "persisted" | "runtime_only" | "skipped";
  errorKind?: ErrorKind;
  failureCode?: Extract<BackgroundTaskFailureCode, "mutation_not_persisted">;
} {
  if (serializedResult === undefined) return {};
  const parsed = tryCatch(() => JSON.parse(serializedResult) as unknown);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object") return {};
  const details = (parsed.value as Record<string, unknown>).details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return {};
  const persistence = (details as Record<string, unknown>).persistence;
  if (persistence === "persisted") {
    return { resultOutcome: "success", persistence };
  }
  if (persistence === "runtime_only" || persistence === "skipped") {
    return {
      resultOutcome: "degraded",
      persistence,
      errorKind: "config",
      failureCode: "mutation_not_persisted",
    };
  }
  return {};
}

export function createBackgroundTaskManager(opts: BackgroundTaskManagerOpts): BackgroundTaskManager {
  const {
    dataDir,
    eventBus,
    logger,
    clock,
    timers,
    maxPerAgent = 5,
    maxTotal = 20,
    maxTotalConfigAgentId = "<routing.defaultAgentId>",
    maxBackgroundDurationMs = 300_000,
    persistenceOps,
    recoveryOps,
  } = opts;

  const tasks = new Map<string, BackgroundTask>();
  const terminalSignals = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const dispatchRetryTimers = new Map<string, TimerHandle>();
  const dispatchRetryDeferrals = new Map<string, number>();
  const terminalRetryTimers = new Map<string, TimerHandle>();
  const stateRetryTimers = new Map<string, TimerHandle>();
  const perAgentCount = new Map<string, number>();
  let totalCount = 0;
  const recoveryController = createBackgroundTaskRecoveryController({
    eventBus,
    logger,
    clock,
    timers,
    dataDir,
    ...(persistenceOps !== undefined ? { persistenceOps } : {}),
  });
  const resolveMaxPerAgent = typeof maxPerAgent === "function"
    ? maxPerAgent
    : () => maxPerAgent;
  const resolveMaxBackgroundDurationMs = typeof maxBackgroundDurationMs === "function"
    ? maxBackgroundDurationMs
    : () => maxBackgroundDurationMs;

  function clearDispatchRetry(taskId: string): void {
    dispatchRetryTimers.get(taskId)?.cancel();
    dispatchRetryTimers.delete(taskId);
    dispatchRetryDeferrals.delete(taskId);
  }

  function reportPersistenceOutcome(
    task: BackgroundTask,
    outcome: import("./background-task-persistence.js").AtomicTaskPersistenceOutcome,
  ): void {
    if (outcome.kind === "committed") return;
    if (outcome.kind === "committed_without_fsync") {
      logger.debug(
        {
          taskId: task.id,
          toolName: task.toolName,
        },
        "Background task state committed without fsync under Node Permission Model",
      );
      return;
    }
    logger.warn(
      {
        taskId: task.id,
        toolName: task.toolName,
        hint: "Check protected background-task storage durability before restarting the daemon",
        errorKind: "resource" as const,
      },
      "Background task state committed without confirmed directory durability",
    );
  }

  function incrementCounters(task: BackgroundTask): void {
    if (task._ownsCounterSlot) return;
    const agentId = task.origin.turnScope.conversation.agentId;
    perAgentCount.set(agentId, (perAgentCount.get(agentId) ?? 0) + 1);
    totalCount++;
    task._ownsCounterSlot = true;
  }

  function decrementCounters(task: BackgroundTask): void {
    if (!task._ownsCounterSlot) return;
    const agentId = task.origin.turnScope.conversation.agentId;
    const current = perAgentCount.get(agentId) ?? 1;
    perAgentCount.set(agentId, Math.max(0, current - 1));
    totalCount = Math.max(0, totalCount - 1);
    task._ownsCounterSlot = false;
  }

  function truncateResult(value: unknown): string {
    try {
      const json = JSON.stringify(value);
      return json.length > MAX_RESULT_CHARS ? json.slice(0, MAX_RESULT_CHARS) : json;
    } catch {
      return String(value).slice(0, MAX_RESULT_CHARS);
    }
  }

  function scheduleTerminalRetry(taskId: string): void {
    if (terminalRetryTimers.has(taskId)) return;
    const handle = timers.setTimeout(() => {
      terminalRetryTimers.delete(taskId);
      const task = tasks.get(taskId);
      const pending = task?._pendingTerminal;
      if (!task || !pending || task.status !== "running") return;
      if (pending.status === "completed") {
        manager.complete(taskId, pending.result ?? "");
      } else if (pending.status === "failed") {
        manager.fail(taskId, pending.error ?? "Background task failed");
      } else {
        manager.cancel(taskId);
      }
    }, 1_000);
    handle.unref();
    terminalRetryTimers.set(taskId, handle);
  }

  function commitTerminal(
    task: BackgroundTask,
    terminal: NonNullable<BackgroundTask["_pendingTerminal"]>,
  ): Result<void, Error> {
    const candidate: BackgroundTask = {
      ...task,
      status: terminal.status,
      completedAt: terminal.completedAt,
      ...(terminal.result === undefined ? {} : { result: terminal.result }),
      ...(terminal.error === undefined ? {} : { error: terminal.error }),
      ...(terminal.errorKind === undefined ? {} : { errorKind: terminal.errorKind }),
      ...(terminal.failureCode === undefined ? {} : { failureCode: terminal.failureCode }),
    };
    const persisted = persistTaskAtomically(dataDir, candidate, persistenceOps);
    if (!persisted.ok) {
      task._pendingTerminal = terminal;
      scheduleTerminalRetry(task.id);
      logger.warn(
        {
          taskId: task.id,
          toolName: task.toolName,
          hint: "Repair protected background-task storage; terminal state persistence will retry",
          errorKind: "resource" as const,
        },
        "Background task terminal state persistence failed",
      );
      return persisted;
    }
    task.status = terminal.status;
    task.completedAt = terminal.completedAt;
    if (terminal.result !== undefined) task.result = terminal.result;
    if (terminal.error !== undefined) task.error = terminal.error;
    if (terminal.errorKind !== undefined) task.errorKind = terminal.errorKind;
    if (terminal.failureCode !== undefined) task.failureCode = terminal.failureCode;
    task._pendingTerminal = undefined;
    terminalRetryTimers.get(task.id)?.cancel();
    terminalRetryTimers.delete(task.id);
    terminalSignals.get(task.id)?.resolve();
    task._hardTimeoutTimer?.cancel();
    decrementCounters(task);
    if (isClosedBackgroundTask(task)) clearDispatchRetry(task.id);
    recoveryController.resolveTask(task);
    reportPersistenceOutcome(task, persisted.value);
    return ok(undefined);
  }

  function buildRecoveryIncident(task: BackgroundTask): Result<BackgroundRecoveryIncidentInput, Error> {
    const projected = conversationScopeToSessionKey(task.origin.turnScope.conversation);
    if (!projected.ok) return err(new Error(projected.error.message));
    return ok({
      agentId: task.origin.turnScope.conversation.agentId,
      taskId: task.id,
      toolName: task.toolName,
      sessionKey: formatSessionKey(projected.value),
      projectedSessionKey: projected.value,
      traceId: task.origin.traceId ?? null,
      timestamp: clock.now(),
      reason: "recovery_retry_required",
    });
  }

  const manager: BackgroundTaskManager = {
    promote(toolName, promise, ac, origin, notificationPolicy, correlation) {
      const parsedOrigin = BackgroundTaskOriginSchema.safeParse(origin);
      if (!parsedOrigin.success) {
        return err(new Error("BackgroundTaskOrigin requires valid structured turn authority"));
      }
      const acceptedOrigin = parsedOrigin.data;
      const agentId = acceptedOrigin.turnScope.conversation.agentId;
      const agentCurrent = perAgentCount.get(agentId) ?? 0;
      const agentLimit = resolveMaxPerAgent(agentId);
      if (agentCurrent >= agentLimit) {
        return err(new Error(
          `[background_capacity] Background task capacity reached: ` +
          `agents.${agentId}.backgroundTasks.maxPerAgent=${agentLimit}; active=${agentCurrent}. ` +
          "Wait for a running background task to finish before retrying.",
        ));
      }
      if (totalCount >= maxTotal) {
        return err(new Error(
          `[background_capacity] Background task capacity reached: ` +
          `agents.${maxTotalConfigAgentId}.backgroundTasks.maxTotal=${maxTotal}; active=${totalCount}. ` +
          "Wait for a running background task to finish before retrying.",
        ));
      }

      const taskId = randomUUID();
      const task: BackgroundTask = {
        id: taskId,
        toolName,
        status: "running",
        startedAt: clock.now(),
        origin: acceptedOrigin,
        notificationPolicy: notificationPolicy ?? "deferred",
        ...(correlation?.toolCallId !== undefined ? { toolCallId: correlation.toolCallId } : {}),
        ...(correlation?.sessionKey !== undefined ? { sessionKey: correlation.sessionKey } : {}),
        ...(correlation?.traceId !== undefined ? { traceId: correlation.traceId } : {}),
        dispatchState: "pending",
        continuationExecutionId: taskId,
        dispatchAttempts: 0,
        _promise: promise,
        _abortController: ac,
      };

      const persisted = persistTaskAtomically(dataDir, task, persistenceOps);
      if (!persisted.ok) {
        const errorCode =
          "code" in persisted.error && typeof persisted.error.code === "string"
            ? persisted.error.code
            : undefined;
        logger.warn(
          {
            toolName,
            agentId,
            ...(errorCode !== undefined ? { errorCode } : {}),
            errorMessage: sanitizeLogString(persisted.error.message).slice(0, 1500),
            hint: "Repair protected background-task storage before promoting the tool execution",
            errorKind: "resource" as const,
          },
          "Background task admission persistence failed",
        );
        return persisted;
      }
      reportPersistenceOutcome(task, persisted.value);

      let resolveTerminal = (): void => undefined;
      const terminalPromise = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      let terminalResolved = false;
      terminalSignals.set(taskId, {
        promise: terminalPromise,
        resolve: () => {
          if (terminalResolved) return;
          terminalResolved = true;
          resolveTerminal();
        },
      });

      const hardLimitMs = resolveMaxBackgroundDurationMs(agentId);
      const timer = timers.setTimeout(() => {
        if (task.status === "running") {
          ac.abort();
          // A bare "Hard timeout exceeded" named neither the knob, the value, nor the tool, so a
          // reader had nothing to change. Name all three, per the same discipline the stall hint
          // beside it already follows.
          manager.fail(
            taskId,
            new Error(hardTimeoutHint({ toolName, agentId, limitMs: hardLimitMs })),
            "timeout",
          );
        }
      }, hardLimitMs);
      timer.unref();
      task._hardTimeoutTimer = timer;

      tasks.set(taskId, task);
      incrementCounters(task);

      emitObservationalEventSafely({ eventBus, logger }, "background_task:promoted", {
        agentId,
        taskId,
        toolName,
        timestamp: clock.now(),
      });

      return ok(taskId);
    },

    complete(taskId, result) {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return ok(undefined);
      if (task._pendingTerminal !== undefined && task._pendingTerminal.status !== "completed") {
        return err(new Error(`Task ${taskId} has a pending ${task._pendingTerminal.status} terminal state`));
      }
      const terminal = task._pendingTerminal?.status === "completed"
        ? task._pendingTerminal
        : {
            status: "completed" as const,
            completedAt: clock.now(),
            result: truncateResult(result),
          };
      const committed = commitTerminal(task, terminal);
      if (!committed.ok) return committed;
      const durationMs = terminal.completedAt - task.startedAt;
      const completionProjection = projectBackgroundCompletionResult(terminal.result);
      emitObservationalEventSafely({ eventBus, logger }, "background_task:completed", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId,
        toolName: task.toolName,
        durationMs,
        origin: task.origin,
        timestamp: clock.now(),
        ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
        ...(task.sessionKey !== undefined ? { sessionKey: task.sessionKey } : {}),
        ...(task.traceId !== undefined ? { traceId: task.traceId } : {}),
        ...completionProjection,
      });
      return ok(undefined);
    },

    fail(taskId, error, errorKind = "dependency") {
      const task = tasks.get(taskId);
      if (!task || task.status !== "running") return ok(undefined);
      if (task._pendingTerminal !== undefined && task._pendingTerminal.status !== "failed") {
        return err(new Error(`Task ${taskId} has a pending ${task._pendingTerminal.status} terminal state`));
      }
      const terminal = task._pendingTerminal?.status === "failed"
        ? task._pendingTerminal
        : {
            status: "failed" as const,
            completedAt: clock.now(),
            error: error instanceof Error ? error.message : String(error),
            errorKind,
            failureCode: classifyBackgroundTaskFailure(task.toolName, error),
          };
      const committed = commitTerminal(task, terminal);
      if (!committed.ok) return committed;
      const durationMs = terminal.completedAt - task.startedAt;
      emitObservationalEventSafely({ eventBus, logger }, "background_task:failed", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId,
        toolName: task.toolName,
        error: terminal.error ?? "Background task failed",
        errorKind: terminal.errorKind ?? errorKind,
        ...(terminal.failureCode !== undefined ? { failureCode: terminal.failureCode } : {}),
        durationMs,
        origin: task.origin,
        timestamp: clock.now(),
        ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
        ...(task.sessionKey !== undefined ? { sessionKey: task.sessionKey } : {}),
        ...(task.traceId !== undefined ? { traceId: task.traceId } : {}),
      });
      return ok(undefined);
    },

    cancel(taskId) {
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Task not found: ${taskId}`));
      if (task.status !== "running") return err(new Error(`Task ${taskId} is not running (status: ${task.status})`));
      if (task._pendingTerminal !== undefined && task._pendingTerminal.status !== "cancelled") {
        return err(new Error(`Task ${taskId} has a pending ${task._pendingTerminal.status} terminal state`));
      }

      const terminal = task._pendingTerminal?.status === "cancelled"
        ? task._pendingTerminal
        : { status: "cancelled" as const, completedAt: clock.now() };
      const committed = commitTerminal(task, terminal);
      if (!committed.ok) return committed;
      task._abortController?.abort();

      emitObservationalEventSafely({ eventBus, logger }, "background_task:cancelled", {
        agentId: task.origin.turnScope.conversation.agentId,
        taskId,
        toolName: task.toolName,
        timestamp: clock.now(),
      });

      return ok(undefined);
    },

    getTask(taskId) {
      return tasks.get(taskId);
    },

    async waitForTask(taskId, onWaiting, waitHeartbeatMs = 60_000) {
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      if (task.status !== "running") return ok(task);
      if (!task._promise) {
        return err(new Error(`Background task ${taskId} has no live execution to await`));
      }

      let waitHeartbeat: TimerHandle | undefined;
      if (onWaiting) {
        waitHeartbeat = timers.setInterval(() => {
          const progress = tryCatch(onWaiting);
          if (!progress.ok) {
            waitHeartbeat?.cancel();
            logger.warn(
              {
                taskId,
                toolName: task.toolName,
                hint: "Inspect the background_tasks progress callback; the underlying task continues",
                errorKind: "internal" as const,
              },
              "Background task wait heartbeat failed",
            );
          }
        }, waitHeartbeatMs);
        waitHeartbeat.unref();
      }

      const providerSettlement = fromPromise(task._promise);
      const terminalSignal = terminalSignals.get(taskId);
      const settled = terminalSignal
        ? await Promise.race([
            providerSettlement.then((result) => ({ kind: "provider" as const, result })),
            terminalSignal.promise.then(() => ({ kind: "terminal" as const })),
          ])
        : { kind: "provider" as const, result: await providerSettlement };
      waitHeartbeat?.cancel();
      const current = tasks.get(taskId);
      if (!current) return err(new Error(`Background task not found after waiting: ${taskId}`));
      if (current.status !== "running") return ok(current);

      if (settled.kind === "terminal") return ok(current);
      const terminalized = settled.result.ok
        ? manager.complete(taskId, settled.result.value)
        : manager.fail(taskId, settled.result.error);
      if (!terminalized.ok && terminalSignal !== undefined) {
        await terminalSignal.promise;
      }
      const terminal = tasks.get(taskId);
      return terminal
        ? ok(terminal)
        : err(new Error(`Background task not found after completion: ${taskId}`));
    },

    getTasks(agentId) {
      return [...tasks.values()].filter((t) => t.origin.turnScope.conversation.agentId === agentId);
    },

    getAllTasks() {
      return [...tasks.values()];
    },

    recoverOnStartup(recordIncident) {
      recoveryController.setRecorder(recordIncident);
      const recovered = recoverTasks(dataDir, recoveryOps);
      let count = 0;
      let dispatchPreserved = 0;
      for (const persisted of recovered.tasks) {
        if (tasks.has(persisted.id)) continue;
        const task: BackgroundTask = persisted as BackgroundTask;
        task.continuationExecutionId = persisted.continuationExecutionId;
        if (persisted.status === "running") {
          const terminal = {
            ...persisted,
            status: "failed" as const,
            error: "Daemon restarted while task was running",
            errorKind: "internal" as const,
            completedAt: clock.now(),
          };
          const committed = persistTaskAtomically(dataDir, terminal, persistenceOps);
          if (!committed.ok) {
            task._pendingTerminal = {
              status: "failed",
              completedAt: terminal.completedAt,
              error: terminal.error,
              errorKind: terminal.errorKind,
            };
            tasks.set(task.id, task);
            scheduleTerminalRetry(task.id);
            recoveryController.recordTask(task);
            logger.warn(
              {
                taskId: task.id,
                toolName: task.toolName,
                hint: "Repair protected background-task storage; startup recovery remains pending",
                errorKind: "resource" as const,
              },
              "Background task startup terminalization failed",
            );
            continue;
          }
          Object.assign(task, terminal);
          reportPersistenceOutcome(task, committed.value);
          recoveryController.resolveTask(task);
        }
        tasks.set(task.id, task);

        if (isClosedBackgroundTask(task)) {
          recoveryController.resolveTask(task);
          dispatchPreserved++;
          continue;
        }
        if (task.status === "completed") {
          count++;
          const completionProjection = projectBackgroundCompletionResult(task.result);
          emitObservationalEventSafely({ eventBus, logger }, "background_task:completed", {
            agentId: task.origin.turnScope.conversation.agentId,
            taskId: task.id,
            toolName: task.toolName,
            durationMs: (task.completedAt ?? clock.now()) - task.startedAt,
            origin: task.origin,
            timestamp: clock.now(),
            ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
            ...(task.sessionKey !== undefined ? { sessionKey: task.sessionKey } : {}),
            ...(task.traceId !== undefined ? { traceId: task.traceId } : {}),
            ...completionProjection,
          });
        } else if (task.status === "failed") {
          count++;
          emitObservationalEventSafely({ eventBus, logger }, "background_task:failed", {
            agentId: task.origin.turnScope.conversation.agentId,
            taskId: task.id,
            toolName: task.toolName,
            error: task.error ?? "Background task failed",
            errorKind: task.errorKind ?? "dependency",
            durationMs: (task.completedAt ?? clock.now()) - task.startedAt,
            origin: task.origin,
            timestamp: clock.now(),
            ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
            ...(task.sessionKey !== undefined ? { sessionKey: task.sessionKey } : {}),
            ...(task.traceId !== undefined ? { traceId: task.traceId } : {}),
            ...(task.failureCode !== undefined ? { failureCode: task.failureCode } : {}),
          });
        }
      }
      if (count > 0) {
        logger.info({ count }, "Recovered background tasks marked as failed");
      }
      if (dispatchPreserved > 0) {
        logger.info(
          { count: dispatchPreserved },
          "Recovered tasks with preserved dispatch state (no re-emit)",
        );
      }
      recoveryController.reportScanFailures(
        recovered.failures,
        recovered.tasks.map((task) => task.id),
        () => manager.recoverOnStartup(recordIncident),
      );
    },

    recordRecoveryIncident(taskId) {
      const task = tasks.get(taskId);
      if (task) recoveryController.recordTask(task);
    },

    commitDispatchState(taskId, next, expected) {
      const task = tasks.get(taskId);
      if (!task) return ok(false);
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) return ok(false);
      const dispatchAttempts = next === "execution_claimed"
        ? task.dispatchAttempts + 1
        : task.dispatchAttempts;
      const candidate = { ...task, dispatchState: next, dispatchAttempts };
      const persisted = persistTaskAtomically(dataDir, candidate, persistenceOps);
      if (!persisted.ok) return persisted;
      task.dispatchState = next;
      task.dispatchAttempts = dispatchAttempts;
      if (isClosedBackgroundTask(task)) clearDispatchRetry(taskId);
      reportPersistenceOutcome(task, persisted.value);
      recoveryController.resolveTask(task);
      return ok(true);
    },

    acknowledgeLiveConsumption(taskId) {
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      const incident = buildRecoveryIncident(task);
      if (!incident.ok) return incident;
      const committed = manager.commitDispatchState(taskId, "consumed_live", ["pending"]);
      if (!committed.ok || !committed.value) return committed;
      emitObservationalEventSafely({ eventBus, logger }, "background_task:notified", {
        agentId: incident.value.agentId,
        taskId,
        toolName: incident.value.toolName,
        sessionKey: incident.value.sessionKey,
        notified: false,
        reason: "live_turn_consumed",
        traceId: task.origin.traceId,
        timestamp: clock.now(),
        trajectoryRecorded: false,
      });
      return ok(true);
    },

    persistContinuationOutbox(taskId, outbox, expected) {
      const parsed = BackgroundContinuationOutboxSchema.safeParse(outbox);
      if (!parsed.success) return err(new Error("Background continuation outbox validation failed"));
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) {
        return err(new Error(`Background task ${taskId} cannot persist an outbox from ${current}`));
      }
      const candidate = {
        ...task,
        continuationOutbox: parsed.data,
        dispatchState: "ready_to_deliver" as const,
      };
      const persisted = persistTaskAtomically(dataDir, candidate, persistenceOps);
      if (!persisted.ok) return persisted;
      task.continuationOutbox = parsed.data;
      task.dispatchState = "ready_to_deliver";
      reportPersistenceOutcome(task, persisted.value);
      return ok(undefined);
    },

    persistCleanupPendingOutbox(taskId, outbox, expected) {
      const parsed = BackgroundContinuationOutboxSchema.safeParse(outbox);
      if (!parsed.success) return err(new Error("Background continuation outbox validation failed"));
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) {
        return err(new Error(`Background task ${taskId} cannot persist cleanup authority from ${current}`));
      }
      const candidate = {
        ...task,
        continuationOutbox: parsed.data,
        dispatchState: "cleanup_pending" as const,
      };
      const persisted = persistTaskAtomically(dataDir, candidate, persistenceOps);
      if (!persisted.ok) return persisted;
      task.continuationOutbox = parsed.data;
      task.dispatchState = "cleanup_pending";
      reportPersistenceOutcome(task, persisted.value);
      return ok(undefined);
    },

    persistFinalizedResult(taskId, result, expected) {
      const parsed = BackgroundFinalizedResultSchema.safeParse(result);
      if (!parsed.success) return err(new Error("Background finalized result validation failed"));
      const task = tasks.get(taskId);
      if (!task) return err(new Error(`Background task not found: ${taskId}`));
      const current = task.dispatchState ?? "pending";
      if (expected && !expected.includes(current)) {
        return err(new Error(`Background task ${taskId} cannot persist a finalized result from ${current}`));
      }
      if (task.finalizedResult !== undefined) {
        return JSON.stringify(task.finalizedResult) === JSON.stringify(parsed.data)
          ? ok(undefined)
          : err(new Error(`Background task ${taskId} already has a different finalized result`));
      }
      const candidate = { ...task, finalizedResult: parsed.data };
      const persisted = persistTaskAtomically(dataDir, candidate, persistenceOps);
      if (!persisted.ok) {
        task._pendingFinalizedResult = parsed.data;
        return persisted;
      }
      task.finalizedResult = parsed.data;
      task._pendingFinalizedResult = undefined;
      reportPersistenceOutcome(task, persisted.value);
      return ok(undefined);
    },

    scheduleDispatchRetry(taskId) {
      const task = tasks.get(taskId);
      if (
        !task
        || (
          task.dispatchState !== "pending"
          && task.dispatchState !== "execution_claimed"
          && task.dispatchState !== "cleanup_pending"
          && task.dispatchState !== "ready_to_deliver"
          && task.dispatchState !== "pre_send"
          && task.dispatchState !== "executing"
          && task.dispatchState !== "delivering"
        )
        || dispatchRetryTimers.has(taskId)
      ) return;
      const deferrals = dispatchRetryDeferrals.get(taskId) ?? 0;
      const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(deferrals, 6)));
      dispatchRetryDeferrals.set(taskId, deferrals + 1);
      const retry = timers.setTimeout(() => {
        dispatchRetryTimers.delete(taskId);
        const current = tasks.get(taskId);
        if (
          !current
          || (
            current.dispatchState !== "pending"
            && current.dispatchState !== "execution_claimed"
            && current.dispatchState !== "cleanup_pending"
            && current.dispatchState !== "ready_to_deliver"
            && current.dispatchState !== "pre_send"
            && current.dispatchState !== "executing"
            && current.dispatchState !== "delivering"
          )
        ) return;
        const event = current.status === "completed"
          ? "background_task:completed" as const
          : current.status === "failed"
            ? "background_task:failed" as const
            : undefined;
        if (event === undefined) return;
        const common = {
          agentId: current.origin.turnScope.conversation.agentId,
          taskId: current.id,
          toolName: current.toolName,
          durationMs: (current.completedAt ?? clock.now()) - current.startedAt,
          origin: current.origin,
          timestamp: clock.now(),
          ...(current.toolCallId !== undefined ? { toolCallId: current.toolCallId } : {}),
          ...(current.sessionKey !== undefined ? { sessionKey: current.sessionKey } : {}),
          ...(current.traceId !== undefined ? { traceId: current.traceId } : {}),
          // This is a DISPATCH redrive of an already-terminal task, not a new
          // terminal transition. Marked so occurrence-counting consumers (the
          // trajectory bridge) record the failure ONCE — the unmarked re-emit
          // wrote one line per backoff tick (live: 55 records for 4 tasks).
          dispatchRedelivery: true,
        };
        if (event === "background_task:completed") {
          emitObservationalEventSafely({ eventBus, logger }, event, {
            ...common,
            ...projectBackgroundCompletionResult(current.result),
          });
        } else {
          emitObservationalEventSafely({ eventBus, logger }, event, {
            ...common,
            error: current.error ?? "Background task failed",
            errorKind: current.errorKind ?? "dependency",
            ...(current.failureCode !== undefined ? { failureCode: current.failureCode } : {}),
          });
        }
      }, delayMs);
      retry.unref();
      dispatchRetryTimers.set(taskId, retry);
    },

    scheduleStateRetry(taskId, next, expected) {
      if (stateRetryTimers.has(taskId)) return;
      const retry = timers.setTimeout(() => {
        stateRetryTimers.delete(taskId);
        const committed = manager.commitDispatchState(taskId, next, expected);
        if (!committed.ok) {
          manager.scheduleStateRetry(taskId, next, expected);
          return;
        }
        if (!committed.value) return;
        const task = tasks.get(taskId);
        if (
          task === undefined
          || (
            next !== "delivered"
            && next !== "parked_permanent"
            && next !== "parked_uncertain"
            && next !== "consumed_live"
          )
        ) return;
        const incident = buildRecoveryIncident(task);
        if (!incident.ok) return;
        emitObservationalEventSafely({ eventBus, logger }, "background_task:notified", {
          agentId: incident.value.agentId,
          taskId,
          toolName: task.toolName,
          sessionKey: incident.value.sessionKey,
          notified: next === "delivered" && task.notificationPolicy !== "silent",
          reason: next === "delivered"
            ? task.notificationPolicy === "silent"
              ? "silent_consumed"
              : task.continuationOutbox?.kind === "fallback"
                ? "fallback_accepted"
                : "continuation_accepted"
            : next === "consumed_live"
              ? "live_turn_consumed"
              : next === "parked_permanent"
                ? "permanent_parked"
                : "uncertain_parked",
          traceId: incident.value.traceId,
          timestamp: clock.now(),
          trajectoryRecorded: false,
        });
      }, 1_000);
      retry.unref();
      stateRetryTimers.set(taskId, retry);
    },

    cleanup(maxAgeMs = 86_400_000) {
      const cutoff = clock.now() - maxAgeMs;
      for (const [taskId, task] of tasks) {
        if (isClosedBackgroundTask(task) && (task.completedAt ?? task.startedAt) < cutoff) {
          tasks.delete(taskId);
          terminalSignals.delete(taskId);
          clearDispatchRetry(taskId);
          terminalRetryTimers.get(taskId)?.cancel();
          terminalRetryTimers.delete(taskId);
          stateRetryTimers.get(taskId)?.cancel();
          stateRetryTimers.delete(taskId);
          removeTaskFile(dataDir, task.origin.turnScope.conversation.agentId, taskId);
        }
      }
    },
  };

  return manager;
}
