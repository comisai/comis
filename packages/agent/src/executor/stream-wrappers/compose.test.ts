import { describe, it, expect, vi, beforeEach } from "vitest";
import { composeStreamWrappers } from "./compose.js";
import type { StreamFnWrapper } from "./types.js";
import { createMockLogger, createMockStreamFn, makeContext } from "./__test-helpers.js";

describe("composeStreamWrappers", () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it("returns base unchanged when wrappers array is empty", () => {
    const base = createMockStreamFn();
    const composed = composeStreamWrappers([], base, logger);

    expect(composed).toBe(base);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("applies wrappers in correct order (outermost first)", () => {
    const callOrder: string[] = [];

    const wrapperA: StreamFnWrapper = function wrapperA(next) {
      return (model, context, options) => {
        callOrder.push("A-before");
        const result = next(model, context, options);
        callOrder.push("A-after");
        return result;
      };
    };

    const wrapperB: StreamFnWrapper = function wrapperB(next) {
      return (model, context, options) => {
        callOrder.push("B-before");
        const result = next(model, context, options);
        callOrder.push("B-after");
        return result;
      };
    };

    const base = vi.fn().mockImplementation(() => {
      callOrder.push("base");
      return "stream-result";
    });

    const composed = composeStreamWrappers([wrapperA, wrapperB], base, logger);

    const model = {} as any;
    const context = makeContext([]);
    composed(model, context);

    // A is outermost, B is innermost
    expect(callOrder).toEqual(["A-before", "B-before", "base", "B-after", "A-after"]);
  });

  it("logs single DEBUG summary for all wrappers composed", () => {
    const base = createMockStreamFn();

    const w1: StreamFnWrapper = function firstWrapper(next) { return next; };
    const w2: StreamFnWrapper = function secondWrapper(next) { return next; };

    composeStreamWrappers([w1, w2], base, logger);

    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      { wrapperCount: 2, wrapperNames: ["firstWrapper", "secondWrapper"] },
      "Stream wrappers composed",
    );
  });

  it("logs 'anonymous' for unnamed wrappers", () => {
    const base = createMockStreamFn();
    // Use array element to avoid V8 name inference from variable binding
    const wrappers: StreamFnWrapper[] = [(next) => next];
    Object.defineProperty(wrappers[0], "name", { value: "" });

    composeStreamWrappers(wrappers, base, logger);

    expect(logger.debug).toHaveBeenCalledWith(
      { wrapperCount: 1, wrapperNames: ["anonymous"] },
      "Stream wrappers composed",
    );
  });
});

