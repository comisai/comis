// SPDX-License-Identifier: Apache-2.0
/**
 * Graceful Shutdown: Signal handler with ordered teardown and timeout.
 * Registers SIGTERM and SIGINT handlers that perform cleanup in
 * dependency-reverse order:
 *   1. Stop channels (no new messages)
 *   2. Stop process monitor (no new metrics)
 *   3. Run custom onShutdown callback (flush state)
 *   4. Shutdown container (config watcher, event bus)
 * A shuttingDown guard prevents double-signal re-entrancy.
 * A hard timeout forces process.exit(1) if cleanup hangs.
 * @module
 */

import type { ProcessMonitor } from "./process-monitor.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ShutdownDeps {
  /** Channel manager or object with stopAll(). */
  channels?: { stopAll(): Promise<void> };
  /** Process monitor to stop. */
  processMonitor?: ProcessMonitor;
  /** Optional custom shutdown callback (e.g., flush state). */
  onShutdown?: () => Promise<void>;
  /** Container with shutdown method. */
  container?: { shutdown(): Promise<void> };
  /** Logger for shutdown progress messages. */
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    flush?: (cb?: () => void) => void;
  };
  /** Hard timeout in milliseconds (default: 30_000). Must be < systemd TimeoutStopSec. */
  timeoutMs?: number;
  /** Override process.exit for testability. */
  exit?: (code: number) => void;
}

export interface ShutdownHandle {
  /** Whether shutdown has been initiated. */
  readonly isShuttingDown: boolean;
  /** Trigger shutdown programmatically (for testing). */
  trigger(signal: string): Promise<void>;
  /** Remove signal listeners (for testing cleanup). */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Register SIGTERM and SIGINT handlers with ordered teardown.
 * Returns a handle for testing (trigger, dispose).
 */
export function registerGracefulShutdown(deps: ShutdownDeps): ShutdownHandle {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // double-signal guard
    shuttingDown = true;

    deps.logger.info({ signal }, "Graceful shutdown initiated");
    const shutdownStartMs = Date.now();

    // Hard timeout: force exit if cleanup hangs
    const timer = setTimeout(() => {
      deps.logger.error({
        timeoutMs,
        shutdownDurationMs: Date.now() - shutdownStartMs,
        hint: "Increase daemon.shutdownTimeoutMs or investigate hung component",
        errorKind: "timeout" as const,
      }, "Shutdown timeout exceeded, forcing exit");
      exit(1);
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref(); // don't keep process alive for the timer
    }

    try {
      // 1. Stop accepting new messages
      if (deps.channels) {
        try {
          await deps.channels.stopAll();
        } catch (channelErr) {
          deps.logger.error({ err: channelErr }, "Error stopping channels, continuing shutdown");
        }
      }

      // 2. Stop process monitor
      if (deps.processMonitor) {
        deps.processMonitor.stop();
      }

      // 3. Run custom onShutdown callback
      if (deps.onShutdown) {
        await deps.onShutdown();
      }

      // 4. Shutdown container (config watcher, event bus)
      if (deps.container) {
        await deps.container.shutdown();
      }
    } catch (error) {
      deps.logger.error({ err: error }, "Error during shutdown");
      clearTimeout(timer);
      exit(1);
      return;
    }

    deps.logger.info({ shutdownDurationMs: Date.now() - shutdownStartMs, signal }, "Graceful shutdown complete");

    // Defense-in-depth flush before exit.
    // The pino transport system auto-flushes on process.exit(),
    // but explicit flush ensures the final log line is written.
    if (typeof deps.logger.flush === "function") {
      await new Promise<void>((resolve) => {
        deps.logger.flush!(() => resolve());
        // Safety timeout: don't hang forever waiting for flush
        setTimeout(resolve, 2_000).unref();
      });
    }

    clearTimeout(timer);
    // Exit code encodes intent for the supervisor.
    // - SIGUSR2 is the "restart me" signal from config.patch / gateway.restart
    //   flows. Must exit non-zero so systemd's Restart=on-failure triggers a
    //   restart. Docker's unless-stopped and pm2's default auto-restart treat
    //   any non-explicit exit as a crash and restart too — so 42 works across
    //   all three supervisors.
    // - SIGTERM/SIGINT are "operator asked me to stop" — exit 0 is correct.
    const isRestartSignal = signal === "SIGUSR2";
    try {
      exit(isRestartSignal ? 42 : 0);
    } catch {
      // Test harness overrides exit() to throw — this is intentional.
      // Swallowing prevents a spurious "Unhandled promise rejection" ERROR log.
    }
  }

  // Register signal handlers
  const sigterm = (): void => {
    void shutdown("SIGTERM");
  };
  const sigint = (): void => {
    void shutdown("SIGINT");
  };

  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);

  // Safety net: log unexpected exits that bypass graceful shutdown
  process.on("exit", (code) => {
    if (!shuttingDown) {
      deps.logger.info({ exitCode: code, hint: "Process exited without graceful shutdown" }, "Daemon process exiting unexpectedly");
    }
  });

  return {
    get isShuttingDown(): boolean {
      return shuttingDown;
    },
    trigger: shutdown,
    dispose(): void {
      process.off("SIGTERM", sigterm);
      process.off("SIGINT", sigint);
    },
  };
}
