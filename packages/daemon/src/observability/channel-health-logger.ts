/**
 * Channel health observability: structured logging subscriber for health
 * state transition and health check events.
 * Subscribes to channel:health_changed and channel:health_check events
 * and logs with canonical fields per the project logging rules.
 * Logging levels follow the boundary-event convention:
 * - WARN for problematic state transitions: disconnected, errored, stale,
 *   stuck, unknown. WARN events include hint and errorKind as required.
 * - INFO for recovery/normal transitions: healthy, startup-grace, idle.
 * - DEBUG for per-poll health checks (N times per poll cycle, not boundary).
 * Channel Health Monitoring.
 * @module
 */

import type { TypedEventBus } from "@comis/core";
import type { ComisLogger } from "@comis/infra";

export interface ChannelHealthLoggerDeps {
  eventBus: TypedEventBus;
  logger: ComisLogger;
}

/** States considered problematic -- logged at WARN with hint + errorKind. */
const PROBLEMATIC_STATES = new Set(["disconnected", "errored", "stale", "stuck", "unknown"]);

/** Actionable hints per problematic state. */
const HINT_MAP: Record<string, string> = {
  disconnected: "Check adapter credentials and network connectivity",
  errored: "Adapter reports error. Check adapter logs for root cause",
  stale: "No activity detected beyond stale threshold. Adapter may be silently disconnected",
  stuck: "Active run exceeded stuck threshold. Check for hung agent execution",
  unknown: "getStatus() unavailable or failing. Adapter may not implement health reporting",
};

/** Error classification per problematic state. */
const ERROR_KIND_MAP: Record<string, string> = {
  disconnected: "connection",
  errored: "adapter",
  stale: "timeout",
  stuck: "timeout",
  unknown: "internal",
};

const MODULE = "channel-health";

/**
 * Subscribe to channel health events and log with canonical fields.
 * @param deps.eventBus - TypedEventBus to subscribe to
 * @param deps.logger - Pino logger instance (module field set per-call)
 */
export function setupChannelHealthLogging(deps: ChannelHealthLoggerDeps): void {
  const { eventBus, logger } = deps;

  // State transitions -- WARN for problematic, INFO for recovery/normal
  eventBus.on("channel:health_changed", (event) => {
    const { channelType, previousState, currentState, connectionMode, error, lastMessageAt } = event;

    if (PROBLEMATIC_STATES.has(currentState)) {
      // Build hint: for "errored", append the error message if available
      const baseHint = HINT_MAP[currentState] ?? "Check adapter health";
      const hint = currentState === "errored" && error
        ? `${baseHint}: ${error}`
        : baseHint;

      logger.warn(
        {
          channelType,
          previousState,
          currentState,
          connectionMode,
          err: error ? { message: error } : undefined,
          lastMessageAt,
          hint,
          errorKind: ERROR_KIND_MAP[currentState] ?? "internal",
          module: MODULE,
        },
        "Channel health degraded: %s -> %s",
        previousState,
        currentState,
      );
    } else {
      // Recovery or normal transitions (e.g., startup-grace -> healthy, idle -> healthy)
      logger.info(
        {
          channelType,
          previousState,
          currentState,
          connectionMode,
          module: MODULE,
        },
        "Channel health changed: %s -> %s",
        previousState,
        currentState,
      );
    }
  });

  // Per-poll health checks -- DEBUG level (N times per poll cycle)
  eventBus.on("channel:health_check", (event) => {
    logger.debug(
      {
        channelType: event.channelType,
        state: event.state,
        responseTimeMs: event.responseTimeMs,
        module: MODULE,
      },
      "Health check: %s = %s",
      event.channelType,
      event.state,
    );
  });
}
