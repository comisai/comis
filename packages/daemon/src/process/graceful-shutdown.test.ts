// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGracefulShutdown, type ShutdownHandle } from "./graceful-shutdown.js";

describe("registerGracefulShutdown", () => {
  let handle: ShutdownHandle;
  const mockExit = vi.fn<(code: number) => void>();
  const logger = {
    info: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockExit.mockReset();
    logger.info.mockReset();
    logger.error.mockReset();
  });

  afterEach(() => {
    handle?.dispose();
    vi.useRealTimers();
  });

  it("executes ordered teardown: channels -> monitor -> onShutdown -> container", async () => {
    const order: string[] = [];

    const channels = {
      stopAll: vi.fn(async () => {
        order.push("channels");
      }),
    };
    const processMonitor = {
      start: vi.fn(),
      stop: vi.fn(() => {
        order.push("monitor");
      }),
      collect: vi.fn(),
    };
    const onShutdown = vi.fn(async () => {
      order.push("onShutdown");
    });
    const container = {
      shutdown: vi.fn(async () => {
        order.push("container");
      }),
    };

    handle = registerGracefulShutdown({
      channels,
      processMonitor,
      onShutdown,
      container,
      logger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    await handle.trigger("SIGTERM");

    expect(order).toEqual(["channels", "monitor", "onShutdown", "container"]);
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith({ signal: "SIGTERM" }, "Graceful shutdown initiated");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ shutdownDurationMs: expect.any(Number), signal: "SIGTERM" }),
      "Graceful shutdown complete",
    );
  });

  it("double-signal is ignored via shuttingDown guard", async () => {
    const channels = {
      stopAll: vi.fn(async () => {
        // Slow stop
        await new Promise<void>((r) => setTimeout(r, 100));
      }),
    };

    handle = registerGracefulShutdown({
      channels,
      logger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    // Trigger twice rapidly
    const first = handle.trigger("SIGTERM");
    const second = handle.trigger("SIGTERM");

    // Advance timers to let the slow stopAll resolve
    vi.advanceTimersByTime(200);

    await first;
    await second;

    // channels.stopAll should only be called once
    expect(channels.stopAll).toHaveBeenCalledTimes(1);
    expect(handle.isShuttingDown).toBe(true);
  });

  it("error during channels.stopAll does not prevent container shutdown", async () => {
    const channels = {
      stopAll: vi.fn(async () => {
        throw new Error("Channel stop failed");
      }),
    };
    const container = {
      shutdown: vi.fn(async () => {}),
    };

    handle = registerGracefulShutdown({
      channels,
      container,
      logger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    await handle.trigger("SIGTERM");

    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Error stopping channels, continuing shutdown",
    );
    expect(container.shutdown).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("hard timeout forces exit(1) if cleanup hangs", async () => {
    const container = {
      shutdown: vi.fn(
        () =>
          new Promise<void>(() => {
            // Never resolves
          }),
      ),
    };

    handle = registerGracefulShutdown({
      container,
      logger,
      exit: mockExit,
      timeoutMs: 2000,
    });

    // Don't await -- it will never resolve
    void handle.trigger("SIGTERM");

    // Advance past timeout
    vi.advanceTimersByTime(2500);

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 2000,
        shutdownDurationMs: expect.any(Number),
        hint: expect.any(String),
        errorKind: "timeout",
      }),
      "Shutdown timeout exceeded, forcing exit",
    );
  });

  it("works with minimal deps (no channels, no monitor, no container)", async () => {
    handle = registerGracefulShutdown({
      logger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    await handle.trigger("SIGINT");

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith({ signal: "SIGINT" }, "Graceful shutdown initiated");
  });

  it("exits with 1 when container.shutdown throws", async () => {
    const container = {
      shutdown: vi.fn(async () => {
        throw new Error("Container shutdown exploded");
      }),
    };

    handle = registerGracefulShutdown({
      container,
      logger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    await handle.trigger("SIGTERM");

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Error during shutdown",
    );
  });

  it("calls logger.flush before exit(0) on clean shutdown", async () => {
    const flushCb = vi.fn<(cb?: () => void) => void>().mockImplementation((cb) => {
      cb?.();
    });
    const flushLogger = {
      info: vi.fn(),
      error: vi.fn(),
      flush: flushCb,
    };

    handle = registerGracefulShutdown({
      logger: flushLogger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    await handle.trigger("SIGTERM");

    expect(flushCb).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
    // flush must be called BEFORE exit
    const flushOrder = flushCb.mock.invocationCallOrder[0]!;
    const exitOrder = mockExit.mock.invocationCallOrder[0]!;
    expect(flushOrder).toBeLessThan(exitOrder);
  });

  it("proceeds to exit even if flush does not call back (safety timeout)", async () => {
    const stuckFlush = vi.fn<(cb?: () => void) => void>(); // Never calls callback
    const stuckLogger = {
      info: vi.fn(),
      error: vi.fn(),
      flush: stuckFlush,
    };

    handle = registerGracefulShutdown({
      logger: stuckLogger,
      exit: mockExit,
      timeoutMs: 5000,
    });

    // Don't await -- the flush safety timeout will resolve it
    const shutdownPromise = handle.trigger("SIGTERM");

    // Advance past the 2-second flush safety timeout
    vi.advanceTimersByTime(2_500);

    await shutdownPromise;

    expect(stuckFlush).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("works when logger has no flush method", async () => {
    // Existing logger mock has no flush -- verifies backward compatibility
    handle = registerGracefulShutdown({
      logger, // no flush method
      exit: mockExit,
      timeoutMs: 5000,
    });

    await handle.trigger("SIGTERM");

    expect(mockExit).toHaveBeenCalledWith(0);
  });
});
