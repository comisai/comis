// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "./bus.js";
import { emitObservationalEventSafely } from "./observational-emission.js";

describe("emitObservationalEventSafely", () => {
  it("reaches later listeners and logs bounded content-free sync and async failure summaries", async () => {
    const eventBus = new TypedEventBus();
    const laterObserver = vi.fn();
    const warn = vi.fn();
    eventBus.on("system:error", () => {
      throw new Error("private sync subscriber content");
    });
    eventBus.on("system:error", async () => {
      throw new Error("private async subscriber content");
    });
    eventBus.on("system:error", laterObserver);

    emitObservationalEventSafely(
      { eventBus, logger: { warn } },
      "system:error",
      { error: new Error("authoritative error"), source: "unit-test" },
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(laterObserver).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "system:error",
        subscriberFailurePhase: "sync",
        subscriberFailureCount: 1,
        firstListenerIndex: 0,
        errorKind: "internal",
        hint: expect.any(String),
      }),
      "Observational event subscriber failed",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriberFailurePhase: "async",
        subscriberFailureCount: 1,
        firstListenerIndex: 1,
      }),
      "Observational event subscriber failed",
    );
    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).not.toContain("private sync subscriber content");
    expect(logs).not.toContain("private async subscriber content");
  });

  it("contains a broken fan-out implementation and a broken warning logger", () => {
    const eventBus = {
      emitSafely: vi.fn(() => {
        throw new Error("private fan-out failure");
      }),
    };
    const warn = vi.fn(() => {
      throw new Error("logger unavailable");
    });

    expect(() => emitObservationalEventSafely(
      { eventBus: eventBus as never, logger: { warn } },
      "system:error",
      { error: new Error("primary"), source: "unit-test" },
    )).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private fan-out failure");
  });

  it("contains a warning getter that throws before invocation", () => {
    const eventBus = new TypedEventBus();
    eventBus.on("system:error", () => {
      throw new Error("private subscriber content");
    });
    const logger = Object.defineProperty({}, "warn", {
      get: () => {
        throw new Error("warning getter failed");
      },
    });

    expect(() => emitObservationalEventSafely(
      { eventBus, logger: logger as never },
      "system:error",
      { error: new Error("primary"), source: "unit-test" },
    )).not.toThrow();
  });

  it("observes and contains a rejecting warning thenable without an unhandled rejection", async () => {
    const eventBus = new TypedEventBus();
    eventBus.on("system:error", () => {
      throw new Error("private subscriber content");
    });
    let thenObserved = false;
    const warn = vi.fn(() => ({
      then: (_resolve: (value: unknown) => void, reject: (error: Error) => void) => {
        thenObserved = true;
        reject(new Error("warning sink rejected"));
      },
    })) as never;

    expect(() => emitObservationalEventSafely(
      { eventBus, logger: { warn } },
      "system:error",
      { error: new Error("primary"), source: "unit-test" },
    )).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(thenObserved).toBe(true);
  });
});
