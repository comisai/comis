import { describe, it, expect, vi } from "vitest";
import type { SchedulerLogger } from "./shared-types.js";

describe("SchedulerLogger interface", () => {
  it("accepts a pino-compatible mock logger", () => {
    const logger: SchedulerLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    logger.child.mockReturnValue(logger);

    // Verify object-first overloads compile and execute
    logger.info({ key: "value" }, "info message");
    logger.info("plain info");
    logger.warn({ key: "value" }, "warn message");
    logger.error({ key: "value" }, "error message");
    logger.debug({ key: "value" }, "debug message");

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("child() returns SchedulerLogger (same interface, not a different type)", () => {
    const childLogger: SchedulerLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    };
    const parentLogger: SchedulerLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnValue(childLogger),
    };

    // child() must return SchedulerLogger, verified by type assignment
    const derived: SchedulerLogger = parentLogger.child({ module: "test" });
    derived.info({ nested: true }, "child logger works");

    expect(parentLogger.child).toHaveBeenCalledWith({ module: "test" });
    expect(childLogger.info).toHaveBeenCalledWith({ nested: true }, "child logger works");
  });
});
