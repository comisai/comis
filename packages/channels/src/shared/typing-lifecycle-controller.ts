/**
 * Typing Lifecycle Controller: Dual idle signal wrapper around TypingController.
 *
 * The standard TypingController manages the platform-specific typing indicator
 * (start/stop/refresh). This lifecycle wrapper extends the typing window to
 * cover BOTH the execution phase AND the delivery phase.
 *
 * Problem: Without this wrapper, typing stops when the agent execution completes
 * (markRunComplete), but the message may still be in the delivery pipeline
 * (chunking, formatting, sending). This creates a jarring UX gap where the user
 * sees typing stop, then the message appears seconds later.
 *
 * Solution: Typing stops only when BOTH signals have fired:
 *  1. markRunComplete() -- execution finished
 *  2. markDispatchIdle() -- delivery pipeline drained
 *
 * A grace timer (default 10s) acts as a safety net: if dispatch-idle never
 * arrives after run-complete, typing is force-stopped to prevent indefinite
 * indicators.
 *
 * @module
 */

import type { TypingController } from "./typing-controller.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typing lifecycle controller returned by the factory. */
export interface TypingLifecycleController {
  /** The wrapped TypingController instance. */
  readonly controller: TypingController;
  /** Signal that agent execution has completed. */
  markRunComplete(): void;
  /** Signal that the delivery pipeline has drained. */
  markDispatchIdle(): void;
  /** Clean up: clear grace timer and stop controller if still active. */
  dispose(): void;
}

/** Options for createTypingLifecycleController. */
export interface TypingLifecycleOptions {
  /**
   * Grace period in ms after markRunComplete() before force-stopping typing.
   * Only applies when dispatch-idle has not yet arrived.
   * @default 10000
   */
  graceMs?: number;
  /** Logger with a warn method for grace expiry warnings. */
  logger?: { warn: (obj: object, msg: string) => void };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a typing lifecycle controller that wraps a TypingController and
 * keeps typing active through both execution and delivery phases.
 *
 * @param controller - The underlying TypingController to manage
 * @param options    - Grace period and logger configuration
 */
export function createTypingLifecycleController(
  controller: TypingController,
  options?: TypingLifecycleOptions,
): TypingLifecycleController {
  const graceMs = options?.graceMs ?? 10_000;
  const logger = options?.logger;

  let runComplete = false;
  let dispatchIdle = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Stop the controller if both idle signals have been received. */
  function maybeStop(): void {
    if (runComplete && dispatchIdle) {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      controller.stop();
    }
  }

  return {
    get controller(): TypingController {
      return controller;
    },

    markRunComplete(): void {
      runComplete = true;
      maybeStop();

      // If dispatch-idle hasn't arrived yet and the controller is still active,
      // start the grace timer as a safety net.
      if (!dispatchIdle && controller.isActive) {
        graceTimer = setTimeout(() => {
          if (controller.isActive) {
            logger?.warn(
              {
                graceMs,
                hint: "Typing grace period expired -- force stopping",
                errorKind: "timeout" as const,
              },
              "Typing grace timer expired",
            );
            controller.stop();
          }
        }, graceMs);
      }
    },

    markDispatchIdle(): void {
      dispatchIdle = true;
      maybeStop();
    },

    dispose(): void {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      if (controller.isActive) {
        controller.stop();
      }
    },
  };
}
