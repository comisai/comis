// SPDX-License-Identifier: Apache-2.0
import type { ComisLogger, ErrorKind, EventMap, TypedEventBus } from "@comis/core";
import {
  ERROR_KINDS,
  emitObservationalEventSafely,
  sanitizeLogString,
} from "@comis/core";
import { fromPromise, tryCatch } from "@comis/shared";

export type QueueLifecycleEvent =
  | "queue:enqueued"
  | "queue:dequeued"
  | "queue:coalesced"
  | "queue:overflow";

export interface QueueObservability {
  emitQueueEvent<K extends QueueLifecycleEvent>(
    event: K,
    payload: EventMap[K],
    channelType: string,
  ): void;
  logQueueEventFailure(
    event: QueueLifecycleEvent,
    error: Error,
    channelType: string,
  ): void;
  containBackgroundExecution(
    promise: Promise<unknown>,
    mode: "followup" | "collect" | "steer",
    channelType: string,
  ): Promise<void>;
}

/** Isolate lifecycle observers and background failures from queue progress. */
export function createQueueObservability(
  eventBus: TypedEventBus,
  logger?: ComisLogger,
): QueueObservability {
  const boundedError = (error: Error): string => sanitizeLogString(
    error.message.slice(0, 1_500),
  );
  const classifyExecutionError = (error: Error): ErrorKind => {
    const classified = tryCatch(() => {
      if (!("errorKind" in error)) return "internal" as const;
      const candidate = (error as { errorKind?: unknown }).errorKind;
      return typeof candidate === "string"
        ? ERROR_KINDS.find((kind) => kind === candidate) ?? "internal"
        : "internal";
    });
    return classified.ok ? classified.value : "internal";
  };

  function logQueueEventFailure(
    queueEvent: QueueLifecycleEvent,
    _error: Error,
    channelType: string,
  ): void {
    if (!logger) return;
    void tryCatch(() => logger.warn({
      step: "queue-event",
      queueEvent,
      channelType,
      errorKind: "internal" as const,
      hint: "Fix the throwing queue lifecycle listener; command processing continued without that observer.",
    }, "Queue lifecycle event listener failed"));
  }

  function emitQueueEvent<K extends QueueLifecycleEvent>(
    event: K,
    payload: EventMap[K],
    _channelType: string,
  ): void {
    emitObservationalEventSafely({ eventBus, logger }, event, payload);
  }

  async function containBackgroundExecution(
    promise: Promise<unknown>,
    mode: "followup" | "collect" | "steer",
    channelType: string,
  ): Promise<void> {
    const settled = await fromPromise(promise);
    if (settled.ok || !logger) return;
    void tryCatch(() => logger.error({
      step: "queue-execute",
      channelType,
      mode,
      err: boundedError(settled.error),
      errorKind: classifyExecutionError(settled.error),
      hint: "Inspect the execution failure and retry the affected message; the command queue continued processing later work.",
    }, "Command queue background execution failed"));
  }

  return { emitQueueEvent, logQueueEventFailure, containBackgroundExecution };
}
