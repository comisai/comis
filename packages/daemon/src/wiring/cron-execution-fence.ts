// SPDX-License-Identifier: Apache-2.0
/** Per-occurrence ordering fence for irreversible cron side effects. */

export type CronIrreversiblePhase =
  | "heartbeat_dispatch"
  | "platform_delivery"
  | "continuation";

export interface CronExecutionFence {
  /** Atomically enter a phase only while cancellation has not closed the fence. */
  enter(phase: CronIrreversiblePhase): boolean;
  /** Settle the exact active phase. A pending cancellation closes the fence here. */
  leave(phase: CronIrreversiblePhase): boolean;
  isClosed(): boolean;
  dispose(): void;
}

export function createCronExecutionFence(signal: AbortSignal): CronExecutionFence {
  let activePhase: CronIrreversiblePhase | undefined;
  let cancellationRequested = signal.aborted;
  let closed = signal.aborted;

  const closeFromCancellation = (): void => {
    cancellationRequested = true;
    if (activePhase === undefined) closed = true;
  };
  if (!signal.aborted) {
    signal.addEventListener("abort", closeFromCancellation, { once: true });
  }

  return {
    enter(phase) {
      if (closed || cancellationRequested || activePhase !== undefined) return false;
      activePhase = phase;
      return true;
    },
    leave(phase) {
      if (activePhase !== phase) return false;
      activePhase = undefined;
      if (cancellationRequested) closed = true;
      return true;
    },
    isClosed() {
      return closed;
    },
    dispose() {
      signal.removeEventListener("abort", closeFromCancellation);
    },
  };
}
