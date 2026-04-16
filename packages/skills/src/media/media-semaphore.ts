/**
 * Global concurrency semaphore for limiting parallel media operations.
 *
 * Prevents resource exhaustion under concurrent voice message load by
 * queuing operations that exceed the concurrency limit. Uses p-queue
 * for FIFO ordering -- operations are never rejected.
 *
 * @module
 */

import PQueue from "p-queue";

/** Concurrency limiter for media processing operations. */
export interface MediaSemaphore {
  /**
   * Run an operation within the semaphore. Queues if at capacity (FIFO).
   * Returns the operation's result. Never rejects due to capacity --
   * only rejects if the operation itself throws.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;

  /** Total operations: currently running + waiting in queue. */
  pending(): number;

  /** Operations currently executing (not waiting). */
  active(): number;

  /** Wait until all queued operations complete. */
  onIdle(): Promise<void>;

  /** Pause processing. In-flight operations complete but no new ones start. */
  pause(): void;

  /** Resume processing after a pause. */
  resume(): void;

  /** Clear pending operations from the queue. Does not cancel in-flight. */
  clear(): void;
}

/**
 * Create a concurrency semaphore for media processing.
 *
 * @param concurrency - Maximum number of parallel operations (default: 3)
 * @returns A MediaSemaphore instance
 */
export function createMediaSemaphore(concurrency: number = 3): MediaSemaphore {
  const queue = new PQueue({ concurrency });

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      // p-queue's .add() returns Promise<T | void>; cast to Promise<T>
      // since our functions always return a value.
      return queue.add(fn) as Promise<T>;
    },

    pending(): number {
      // queue.pending = running tasks, queue.size = waiting tasks
      return queue.pending + queue.size;
    },

    active(): number {
      // queue.pending = currently executing count in p-queue
      return queue.pending;
    },

    onIdle(): Promise<void> {
      return queue.onIdle();
    },

    pause(): void {
      queue.pause();
    },

    resume(): void {
      queue.start();
    },

    clear(): void {
      queue.clear();
    },
  };
}
