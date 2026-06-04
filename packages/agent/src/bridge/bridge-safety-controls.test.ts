// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the loop-detected safety control (FIX #2a).
 *
 * Mirrors checkStepLimit / emitStepLimitAbort: checkLoopLimit consults a
 * loop-state reporter and returns a loop_detected abort descriptor; emitLoopAbort
 * emits execution:aborted {reason:"loop_detected"} + a WARN with errorKind
 * "resource" and an actionable hint.
 */
import { describe, it, expect, vi } from "vitest";
import type { SessionKey, TypedEventBus, ComisLogger } from "@comis/core";

import { checkLoopLimit, emitLoopAbort } from "./bridge-safety-controls.js";

const testSessionKey = "agent-a:discord:chan-1" as unknown as SessionKey;

function makeLogger(): ComisLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as ComisLogger;
}

function makeEventBus(): TypedEventBus {
  return { emit: vi.fn() } as unknown as TypedEventBus;
}

describe("checkLoopLimit", () => {
  it("returns a loop_detected abort when the detector reports a loop and not already aborted", () => {
    const result = checkLoopLimit({ shouldBreakLoop: () => true }, false);
    expect(result.shouldAbort).toBe(true);
    expect(result.finishReason).toBe("loop_detected");
    expect(result.eventReason).toBe("loop_detected");
  });

  it("does not abort when the detector reports no loop", () => {
    const result = checkLoopLimit({ shouldBreakLoop: () => false }, false);
    expect(result.shouldAbort).toBe(false);
  });

  it("does not double-abort when the run is already aborted", () => {
    const result = checkLoopLimit({ shouldBreakLoop: () => true }, true);
    expect(result.shouldAbort).toBe(false);
  });
});

describe("emitLoopAbort", () => {
  it("emits execution:aborted with reason loop_detected", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    emitLoopAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger });
    expect(eventBus.emit).toHaveBeenCalledWith(
      "execution:aborted",
      expect.objectContaining({ reason: "loop_detected", agentId: "agent-a" }),
    );
  });

  it("logs a WARN with errorKind resource and an actionable hint", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    emitLoopAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "resource", hint: expect.any(String) }),
      expect.any(String),
    );
  });

  it("invokes the optional onAbort hook before emitting", () => {
    const eventBus = makeEventBus();
    const logger = makeLogger();
    const onAbort = vi.fn();
    emitLoopAbort({ eventBus, sessionKey: testSessionKey, agentId: "agent-a", logger, onAbort });
    expect(onAbort).toHaveBeenCalledOnce();
  });
});
