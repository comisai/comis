// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { createMockLogger } from "../../../../test/support/mock-logger.js";
import { createTypingController } from "./typing-controller.js";
import type { TypingControllerConfig } from "./typing-controller.js";

describe("createTypingController", () => {
  let sendTyping: Mock<(chatId: string) => Promise<void>>;
  let logger: ReturnType<typeof createMockLogger>;

  const defaultConfig: TypingControllerConfig = {
    mode: "thinking",
    refreshMs: 100,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    sendTyping = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    logger = createMockLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends typing immediately on start", () => {
    const ctrl = createTypingController(defaultConfig, sendTyping);

    ctrl.start("chat1");

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(sendTyping).toHaveBeenCalledWith("chat1");
  });

  it("refreshes at interval", async () => {
    const ctrl = createTypingController(
      { mode: "thinking", refreshMs: 100 },
      sendTyping,
    );

    ctrl.start("chat1");
    // Initial call
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // Advance 100ms — one refresh tick
    await vi.advanceTimersByTimeAsync(100);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    // Advance another 100ms — another refresh tick
    await vi.advanceTimersByTimeAsync(100);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    ctrl.stop();
  });

  it("stop clears interval — no additional calls after stop", async () => {
    const ctrl = createTypingController(
      { mode: "thinking", refreshMs: 100 },
      sendTyping,
    );

    ctrl.start("chat1");
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // Advance 50ms, then stop
    await vi.advanceTimersByTimeAsync(50);
    ctrl.stop();

    // Advance 200ms more — no further calls
    await vi.advanceTimersByTimeAsync(200);
    expect(sendTyping).toHaveBeenCalledTimes(1);
  });

  it("mode 'never' is a no-op", () => {
    const ctrl = createTypingController(
      { mode: "never", refreshMs: 100 },
      sendTyping,
    );

    ctrl.start("chat1");

    expect(sendTyping).not.toHaveBeenCalled();
    expect(ctrl.isActive).toBe(false);
  });

  it("isActive reflects state", () => {
    const ctrl = createTypingController(defaultConfig, sendTyping);

    expect(ctrl.isActive).toBe(false);

    ctrl.start("chat1");
    expect(ctrl.isActive).toBe(true);

    ctrl.stop();
    expect(ctrl.isActive).toBe(false);
  });

  it("startedAt is set on start", () => {
    const ctrl = createTypingController(defaultConfig, sendTyping);

    // Before start: 0
    expect(ctrl.startedAt).toBe(0);

    const now = Date.now();
    ctrl.start("chat1");

    // After start: close to Date.now()
    expect(ctrl.startedAt).toBeGreaterThanOrEqual(now);
    expect(ctrl.startedAt).toBeLessThanOrEqual(now + 10);

    const savedStartedAt = ctrl.startedAt;

    ctrl.stop();
    // After stop: retains the value from when it started
    expect(ctrl.startedAt).toBe(savedStartedAt);
  });

  it("double start is idempotent — no duplicate intervals", async () => {
    const ctrl = createTypingController(
      { mode: "thinking", refreshMs: 100 },
      sendTyping,
    );

    ctrl.start("chat1");
    ctrl.start("chat1");

    // Only 1 initial call (not 2)
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // Advance 100ms — only 1 refresh call (not 2)
    await vi.advanceTimersByTimeAsync(100);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    ctrl.stop();
  });

  it("typing error is caught and logged", async () => {
    const error = new Error("Network failure");
    sendTyping.mockRejectedValueOnce(error);

    const ctrl = createTypingController(defaultConfig, sendTyping, logger);

    ctrl.start("chat1");

    // Let the rejected promise flush through microtasks
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: error, chatId: "chat1" }),
      "Typing indicator send failed",
    );

    ctrl.stop();
  });

  it("typing error does not stop interval — subsequent calls still fire", async () => {
    const error = new Error("Network failure");
    sendTyping
      .mockRejectedValueOnce(error) // first call fails
      .mockResolvedValue(undefined); // subsequent calls succeed

    const ctrl = createTypingController(
      { mode: "thinking", refreshMs: 100 },
      sendTyping,
      logger,
    );

    ctrl.start("chat1");

    // Flush the rejected promise
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledTimes(1);

    // Advance past one interval — second call should fire despite first failing
    await vi.advanceTimersByTimeAsync(100);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    ctrl.stop();
  });

  it("stop is safe to call when not started", () => {
    const ctrl = createTypingController(defaultConfig, sendTyping);

    // Should not throw
    expect(() => ctrl.stop()).not.toThrow();
  });

  // =========================================================================
  // Sealed state tests
  // =========================================================================

  describe("sealed state", () => {
    it("stop() seals the controller — start() after stop() is a no-op", async () => {
      const ctrl = createTypingController(defaultConfig, sendTyping, logger);

      ctrl.start("chat1");
      expect(sendTyping).toHaveBeenCalledTimes(1);
      expect(ctrl.isActive).toBe(true);
      expect(ctrl.isSealed).toBe(false);

      ctrl.stop();
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);

      // Attempt to restart — should be a no-op
      ctrl.start("chat1");
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);
      // No additional sendTyping calls beyond the initial one
      expect(sendTyping).toHaveBeenCalledTimes(1);
    });

    it("sealed controller cannot be restarted", () => {
      const ctrl = createTypingController(defaultConfig, sendTyping);

      ctrl.start("chat1");
      ctrl.stop();
      expect(ctrl.isSealed).toBe(true);

      // Attempt to restart
      ctrl.start("chat1");
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);
    });

    it("isSealed is false before stop", () => {
      const ctrl = createTypingController(defaultConfig, sendTyping);

      expect(ctrl.isSealed).toBe(false);

      ctrl.start("chat1");
      expect(ctrl.isSealed).toBe(false);
    });
  });

  // =========================================================================
  // Circuit breaker tests
  // =========================================================================

  describe("circuit breaker", () => {
    it("trips after 3 consecutive failures (default threshold)", async () => {
      sendTyping.mockRejectedValue(new Error("Network failure"));

      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");

      // 1st failure (initial call)
      await vi.advanceTimersByTimeAsync(0);
      expect(ctrl.isActive).toBe(true);

      // 2nd failure (1st tick)
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isActive).toBe(true);

      // 3rd failure (2nd tick) — should trip the circuit breaker
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);

      // Verify WARN log with circuit breaker trip message
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "chat1",
          consecutiveFailures: 3,
          hint: "Typing circuit breaker tripped -- stopping indicator",
          errorKind: "platform",
        }),
        "Typing circuit breaker tripped",
      );

      // No more calls after trip
      const callsAfterTrip = sendTyping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(sendTyping.mock.calls.length).toBe(callsAfterTrip);
    });

    it("resets failure counter on success", async () => {
      sendTyping
        .mockRejectedValueOnce(new Error("fail 1"))  // 1st call fails
        .mockResolvedValueOnce(undefined)              // 2nd call succeeds (resets counter)
        .mockRejectedValueOnce(new Error("fail 2"))  // 3rd call fails (counter = 1, not 2)
        .mockRejectedValueOnce(new Error("fail 3"))  // 4th call fails (counter = 2, not 3)
        .mockResolvedValue(undefined);

      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");

      // 1st failure
      await vi.advanceTimersByTimeAsync(0);
      expect(ctrl.isActive).toBe(true);

      // 2nd call succeeds — resets counter
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isActive).toBe(true);

      // 3rd call fails — counter = 1 (not 2)
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isActive).toBe(true);

      // 4th call fails — counter = 2 (still below threshold 3)
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isActive).toBe(true);

      ctrl.stop();
    });

    it("respects custom threshold via config", async () => {
      sendTyping.mockRejectedValue(new Error("fail"));

      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, circuitBreakerThreshold: 5 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      // Initial call = failure 1

      // Failures 2, 3, 4 via ticks — still below threshold 5
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(ctrl.isActive).toBe(true);

      // Failure 5 (4th tick) — should trip at threshold 5
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);
    });
  });

  // =========================================================================
  // Tick serialization tests
  // =========================================================================

  describe("tick serialization", () => {
    it("does not send overlapping ticks", async () => {
      // Return a never-resolving promise for the first call
      sendTyping.mockReturnValueOnce(new Promise(() => {}));

      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      // Initial call: sendTyping called once (returns never-resolving promise)
      expect(sendTyping).toHaveBeenCalledTimes(1);

      // Advance past the refresh interval — tick should be skipped because
      // the previous call is still in-flight (tickInFlight = true)
      await vi.advanceTimersByTimeAsync(100);
      expect(sendTyping).toHaveBeenCalledTimes(1); // Still just 1 call

      // Advance more — still skipped
      await vi.advanceTimersByTimeAsync(100);
      expect(sendTyping).toHaveBeenCalledTimes(1);

      ctrl.stop();
    });
  });

  // =========================================================================
  // TTL tests
  // =========================================================================

  describe("TTL (time-to-live)", () => {
    it("auto-stops after TTL expires (custom ttlMs)", async () => {
      // Uses ttlMs=500 (< INTERNAL_TTL_REFRESH_MS=30_000) so the TTL
      // expiry wins the race against the internal liveness timer. This
      // keeps coverage of the TTL-expiry WARN branch.
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, ttlMs: 500 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      expect(ctrl.isActive).toBe(true);

      // Advance to just before TTL
      await vi.advanceTimersByTimeAsync(499);
      expect(ctrl.isActive).toBe(true);

      // Cross the TTL boundary
      await vi.advanceTimersByTimeAsync(2);
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);

      // Verify WARN log
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          hint: "Typing TTL expired -- auto-stopping",
          errorKind: "timeout",
        }),
        "Typing TTL expired",
      );
    });

    it("respects custom TTL via config", async () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, ttlMs: 10000 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      expect(ctrl.isActive).toBe(true);

      // Advance to just before custom TTL
      await vi.advanceTimersByTimeAsync(9999);
      expect(ctrl.isActive).toBe(true);

      // Cross the custom TTL boundary
      await vi.advanceTimersByTimeAsync(2);
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);
    });

    it("TTL clears interval — no calls after expiry", async () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, ttlMs: 500 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");

      // Advance past TTL
      await vi.advanceTimersByTimeAsync(501);
      expect(ctrl.isActive).toBe(false);

      const callsAtExpiry = sendTyping.mock.calls.length;

      // Advance much more — no further calls
      await vi.advanceTimersByTimeAsync(1000);
      expect(sendTyping.mock.calls.length).toBe(callsAtExpiry);
    });
  });

  // =========================================================================
  // Internal TTL refresh timer (liveness watchdog)
  // =========================================================================

  describe("internal TTL refresh timer (liveness watchdog)", () => {
    it("keeps controller alive past ttlMs with no external signals (default config)", async () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 4000 }, // default ttlMs = 60_000
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      expect(ctrl.isActive).toBe(true);

      // Advance past default ttlMs (60_000) — must remain active because the
      // internal 30s timer refreshes the TTL.
      await vi.advanceTimersByTimeAsync(60_001);
      expect(ctrl.isActive).toBe(true);
      expect(ctrl.isSealed).toBe(false);

      // Advance another full ttlMs window — still alive.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ctrl.isActive).toBe(true);

      // No TTL-expired WARN should have fired.
      const ttlWarnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Typing TTL expired");
      expect(ttlWarnCalls).toHaveLength(0);

      ctrl.stop();
    });

    it("stop() clears the internal refresh timer — no dangling interval", async () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 4000 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      await vi.advanceTimersByTimeAsync(50_000);
      const callsAtStop = sendTyping.mock.calls.length;

      ctrl.stop();
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);

      // Advance far beyond the 30s internal interval — no new calls, no warns.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sendTyping.mock.calls.length).toBe(callsAtStop);

      const ttlWarnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] === "Typing TTL expired");
      expect(ttlWarnCalls).toHaveLength(0);
    });

    it("circuit-breaker trip clears the internal refresh timer", async () => {
      sendTyping.mockRejectedValue(new Error("Network failure"));
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      // 3 failures trip the breaker.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      expect(ctrl.isSealed).toBe(true);

      const callsAtTrip = sendTyping.mock.calls.length;
      const warnsAtTrip = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;

      // Advance past the 30s internal interval — must not revive anything.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sendTyping.mock.calls.length).toBe(callsAtTrip);
      expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(warnsAtTrip);
    });
  });

  // =========================================================================
  // refreshTtl tests
  // =========================================================================

  describe("refreshTtl", () => {
    it("refreshTtl() extends TTL deadline", async () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, ttlMs: 5000 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      expect(ctrl.isActive).toBe(true);

      // Advance 4000ms (close to TTL)
      await vi.advanceTimersByTimeAsync(4000);
      expect(ctrl.isActive).toBe(true);

      // Reset TTL — new deadline is now +5000ms from here
      ctrl.refreshTtl();

      // Advance another 4000ms (total 8000ms) — should still be active
      // because TTL was reset at 4000ms, so expires at 9000ms
      await vi.advanceTimersByTimeAsync(4000);
      expect(ctrl.isActive).toBe(true);

      // Advance to 9001ms total — should now be expired
      await vi.advanceTimersByTimeAsync(1001);
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(true);
    });

    it("refreshTtl() is no-op when sealed", () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, ttlMs: 5000 },
        sendTyping,
        logger,
      );

      ctrl.start("chat1");
      ctrl.stop();
      expect(ctrl.isSealed).toBe(true);

      // Should not throw or change state
      expect(() => ctrl.refreshTtl()).not.toThrow();
      expect(ctrl.isSealed).toBe(true);
      expect(ctrl.isActive).toBe(false);
    });

    it("refreshTtl() is no-op when not active", () => {
      const ctrl = createTypingController(
        { mode: "thinking", refreshMs: 100, ttlMs: 5000 },
        sendTyping,
        logger,
      );

      // Not started — should not throw
      expect(() => ctrl.refreshTtl()).not.toThrow();
      expect(ctrl.isActive).toBe(false);
      expect(ctrl.isSealed).toBe(false);
    });
  });
});
