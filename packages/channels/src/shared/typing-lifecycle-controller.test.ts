// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { TypingController } from "./typing-controller.js";
import { createTypingLifecycleController } from "./typing-lifecycle-controller.js";

/** Create a mock TypingController with vi.fn() stubs. */
function createMockController(overrides?: Partial<TypingController>): TypingController {
  let _isActive = overrides?.isActive ?? true;
  let _isSealed = overrides?.isSealed ?? false;

  return {
    start: vi.fn(),
    stop: vi.fn(() => {
      _isActive = false;
    }),
    refreshTtl: vi.fn(),
    get isActive() {
      return _isActive;
    },
    get startedAt() {
      return overrides?.startedAt ?? 1000;
    },
    get isSealed() {
      return _isSealed;
    },
  };
}

describe("createTypingLifecycleController", () => {
  const mockLogger = { warn: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // Dual idle signal tests
  // =========================================================================

  describe("dual idle -- both signals required", () => {
    it("markRunComplete() alone does NOT stop the controller", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.markRunComplete();

      expect(ctrl.stop).not.toHaveBeenCalled();
    });

    it("markDispatchIdle() after markRunComplete() stops the controller", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.markRunComplete();
      lifecycle.markDispatchIdle();

      expect(ctrl.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("dual idle -- reverse order", () => {
    it("markDispatchIdle() first, then markRunComplete() stops the controller", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.markDispatchIdle();
      expect(ctrl.stop).not.toHaveBeenCalled();

      lifecycle.markRunComplete();
      expect(ctrl.stop).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Grace timer tests
  // =========================================================================

  describe("grace timer", () => {
    it("fires after default graceMs (10s) when dispatch-idle never arrives", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.markRunComplete();

      // Advance just before grace expiry
      vi.advanceTimersByTime(9_999);
      expect(ctrl.stop).not.toHaveBeenCalled();

      // Cross the grace boundary
      vi.advanceTimersByTime(2);
      expect(ctrl.stop).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          graceMs: 10_000,
          hint: "Typing grace period expired -- force stopping",
          errorKind: "timeout",
        }),
        expect.any(String),
      );
    });

    it("is cleared when markDispatchIdle() arrives before grace expires", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.markRunComplete();

      // Dispatch idle arrives at 5s (before 10s grace)
      vi.advanceTimersByTime(5_000);
      lifecycle.markDispatchIdle();
      expect(ctrl.stop).toHaveBeenCalledTimes(1);

      // Advance past the original grace expiry -- stop should NOT be called again
      vi.advanceTimersByTime(10_000);
      expect(ctrl.stop).toHaveBeenCalledTimes(1);
    });

    it("respects custom graceMs", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { graceMs: 5_000, logger: mockLogger });

      lifecycle.markRunComplete();

      // Advance just before custom grace
      vi.advanceTimersByTime(4_999);
      expect(ctrl.stop).not.toHaveBeenCalled();

      // Cross the custom grace boundary
      vi.advanceTimersByTime(2);
      expect(ctrl.stop).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // dispose() tests
  // =========================================================================

  describe("dispose()", () => {
    it("clears grace timer and stops controller", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      // Start grace timer via markRunComplete
      lifecycle.markRunComplete();

      // Dispose before grace expires
      lifecycle.dispose();
      expect(ctrl.stop).toHaveBeenCalledTimes(1);

      // Advance past grace -- stop should NOT be called again (timer cleared)
      vi.advanceTimersByTime(15_000);
      expect(ctrl.stop).toHaveBeenCalledTimes(1);
    });

    it("stops active controller", () => {
      const ctrl = createMockController({ isActive: true });
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.dispose();

      expect(ctrl.stop).toHaveBeenCalledTimes(1);
    });

    it("is no-op when controller already inactive", () => {
      const ctrl = createMockController({ isActive: false });
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.dispose();

      expect(ctrl.stop).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("markRunComplete() skips grace timer when controller already inactive", () => {
      const ctrl = createMockController({ isActive: false });
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      lifecycle.markRunComplete();

      // No timers should be set
      expect(vi.getTimerCount()).toBe(0);
      expect(ctrl.stop).not.toHaveBeenCalled();
    });

    it("controller property exposes the wrapped controller", () => {
      const ctrl = createMockController();
      const lifecycle = createTypingLifecycleController(ctrl, { logger: mockLogger });

      expect(lifecycle.controller).toBe(ctrl);
    });
  });
});
