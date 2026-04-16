/**
 * Typing Controller: Interval-based typing indicator management.
 *
 * Sends platform-specific typing indicators at a configurable refresh
 * interval. Platform typing indicators expire (Telegram 5s, Discord 10s,
 * WhatsApp ~10s), so the controller refreshes them periodically to keep
 * the "is typing..." visible to the user.
 *
 * The controller is platform-agnostic — the actual typing API call is
 * injected as a `sendTyping` callback. The channel manager decides
 * *when* to call start/stop based on the TypingMode semantics
 * (instant vs thinking vs message). The controller only distinguishes
 * between `'never'` (do nothing) and any other mode (send at interval).
 *
 * ## Resilience mechanisms
 *
 * 1. **Sealed state**: Once stop() is called, the controller cannot be
 *    restarted. This prevents flickering indicators.
 *
 * 2. **Circuit breaker**: After `circuitBreakerThreshold` consecutive
 *    sendTyping failures (default 3), the controller permanently stops.
 *    Counter resets on any successful send.
 *
 * 3. **Tick serialization**: Only one sendTyping call can be in-flight
 *    at a time. If the previous tick hasn't resolved, the next tick is
 *    skipped. Prevents overlapping async calls.
 *
 * 4. **TTL (Time-to-Live)**: Typing indicators auto-stop after
 *    `ttlMs` milliseconds (default 60,000). Prevents indefinite
 *    typing if agent execution hangs.
 *
 * 5. **refreshTtl()**: Resets the TTL timer on content signals (e.g.,
 *    text deltas from the model). Active generation keeps the indicator
 *    alive beyond the initial TTL window.
 *
 * Typing failures are non-fatal: errors from `sendTyping` are caught
 * and logged but never propagated to the caller.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Controls when typing indicators are activated by the channel manager. */
export type TypingMode = "never" | "instant" | "thinking" | "message";

/** Configuration for the typing controller. */
export interface TypingControllerConfig {
  /** Typing mode — the controller only uses this to check for 'never'. */
  mode: TypingMode;
  /**
   * Refresh interval in milliseconds.
   *
   * Platform-specific defaults (resolved by the caller):
   *  - Telegram: 4000 ms (typing expires after 5s)
   *  - Discord:  8000 ms (typing expires after 10s)
   *  - WhatsApp: 8000 ms (typing expires after ~10s)
   *  - Slack:    N/A (typing not supported — use mode 'never')
   *
   * @default 6000
   */
  refreshMs: number;
  /**
   * Consecutive sendTyping failures before the circuit breaker trips
   * and permanently stops the controller.
   *
   * @default 3
   */
  circuitBreakerThreshold?: number;
  /**
   * Maximum typing indicator duration in ms before auto-stop.
   * The TTL resets on each refreshTtl() call (triggered by content signals).
   *
   * @default 60000
   */
  ttlMs?: number;
}

/** Typing indicator controller returned by the factory. */
export interface TypingController {
  /** Begin sending typing indicators immediately, then at refreshMs interval. */
  start(chatId: string): void;
  /** Clear interval, mark as inactive, and seal the controller. */
  stop(): void;
  /**
   * Reset the TTL timer. Call on content signals (text deltas) to keep
   * the indicator alive during active generation.
   * No-op if the controller is sealed or not active.
   */
  refreshTtl(): void;
  /** Whether typing is currently being sent. */
  readonly isActive: boolean;
  /**
   * Timestamp (ms since epoch) when start() was called.
   * Returns 0 if the controller is not active.
   * Useful for duration calculation in events.
   */
  readonly startedAt: number;
  /** Whether the controller is permanently sealed (cannot be restarted). */
  readonly isSealed: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a typing controller that sends platform typing indicators at a
 * configurable refresh interval.
 *
 * @param config     - Typing mode, refresh interval, circuit breaker threshold, and TTL
 * @param sendTyping - Platform-injected callback that sends a single typing indicator
 * @param logger     - Optional logger for non-fatal error reporting
 */
export function createTypingController(
  config: TypingControllerConfig,
  sendTyping: (chatId: string) => Promise<void>,
  logger?: { warn: (obj: object, msg: string) => void },
): TypingController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let active = false;
  let _startedAt = 0;

  // Resilience state
  let sealed = false;
  let consecutiveFailures = 0;
  let tickInFlight = false;
  let ttlTimer: ReturnType<typeof setTimeout> | null = null;
  const threshold = config.circuitBreakerThreshold ?? 3;

  /** Fire-and-forget typing send with tick serialization and circuit breaker. */
  function doSendTyping(chatId: string): void {
    if (consecutiveFailures >= threshold || tickInFlight) return;

    tickInFlight = true;
    sendTyping(chatId)
      .then(() => {
        consecutiveFailures = 0;
      })
      .catch((err: unknown) => {
        consecutiveFailures++;
        if (consecutiveFailures >= threshold) {
          logger?.warn(
            { chatId, consecutiveFailures, hint: "Typing circuit breaker tripped -- stopping indicator", errorKind: "platform" as const },
            "Typing circuit breaker tripped",
          );
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
          active = false;
          sealed = true;
          if (ttlTimer !== null) {
            clearTimeout(ttlTimer);
            ttlTimer = null;
          }
        } else {
          logger?.warn(
            { err, chatId, hint: "Typing indicator delivery failed; non-blocking", errorKind: "platform" as const },
            "Typing indicator send failed",
          );
        }
      })
      .finally(() => {
        tickInFlight = false;
      });
  }

  /** Arm or reset the TTL timer. */
  function resetTtl(): void {
    if (ttlTimer !== null) {
      clearTimeout(ttlTimer);
    }
    ttlTimer = setTimeout(() => {
      if (active) {
        logger?.warn(
          { hint: "Typing TTL expired -- auto-stopping", errorKind: "timeout" as const },
          "Typing TTL expired",
        );
        active = false;
        sealed = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }
    }, config.ttlMs ?? 60_000);
  }

  return {
    start(chatId: string): void {
      // Mode 'never' is a no-op; also skip if already active or sealed.
      if (config.mode === "never" || active || sealed) return;

      active = true;
      _startedAt = Date.now();

      // Send immediately so the user sees "typing" without waiting for
      // the first interval tick.
      doSendTyping(chatId);

      // Refresh at interval to keep the indicator alive.
      timer = setInterval(() => {
        doSendTyping(chatId);
      }, config.refreshMs);

      // Arm the TTL timer.
      resetTtl();
    },

    stop(): void {
      active = false;
      sealed = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (ttlTimer !== null) {
        clearTimeout(ttlTimer);
        ttlTimer = null;
      }
    },

    refreshTtl(): void {
      if (!active || sealed) return;
      resetTtl();
    },

    get isActive(): boolean {
      return active;
    },

    get startedAt(): number {
      return _startedAt;
    },

    get isSealed(): boolean {
      return sealed;
    },
  };
}
