import { describe, it, expect, vi } from "vitest";
import { suppressError } from "./suppress-error.js";

describe("suppressError()", () => {
  it("does not throw when promise rejects", () => {
    expect(() => {
      suppressError(Promise.reject(new Error("test")), "cleanup");
    }).not.toThrow();
  });

  it("logs the error reason at debug level when no logger provided", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    suppressError(Promise.reject(new Error("test error")), "cleanup task");

    // Wait for the microtask queue to flush
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(debugSpy).toHaveBeenCalledWith("Suppressed error (cleanup task): test error");
    expect(debugSpy).toHaveBeenCalledTimes(1);

    debugSpy.mockRestore();
  });

  it("uses custom logger when provided", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const customLogger = vi.fn();

    suppressError(Promise.reject(new Error("custom error")), "custom task", customLogger);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(customLogger).toHaveBeenCalledTimes(1);
    expect(customLogger).toHaveBeenCalledWith("Suppressed error (custom task): custom error");
    // console.debug should NOT be called when custom logger is provided
    expect(debugSpy).not.toHaveBeenCalled();

    debugSpy.mockRestore();
  });

  it("passes formatted error message string to custom logger", async () => {
    const customLogger = vi.fn();

    suppressError(Promise.reject(new Error("something broke")), "retry cleanup", customLogger);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(customLogger).toHaveBeenCalledWith("Suppressed error (retry cleanup): something broke");
  });

  it("handles non-Error rejection with custom logger", async () => {
    const customLogger = vi.fn();

    suppressError(Promise.reject("plain string rejection"), "string reject", customLogger);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(customLogger).toHaveBeenCalledWith("Suppressed error (string reject): plain string rejection");
  });

  it("does not cause unhandled rejection", async () => {
    const unhandledHandler = vi.fn();
    process.on("unhandledRejection", unhandledHandler);

    suppressError(Promise.reject(new Error("should be caught")), "test");

    // Wait enough for unhandledRejection to fire if it were going to
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(unhandledHandler).not.toHaveBeenCalled();

    process.removeListener("unhandledRejection", unhandledHandler);
  });
});
