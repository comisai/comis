// SPDX-License-Identifier: Apache-2.0
/**
 * Coverage for `createDenialBreaker`.
 *
 * The breaker is a PURE per-`rootRunId` consecutive-floor-block counter (no
 * ClockPort, no throws, no side effects beyond its own content-free trip log):
 *   - `recordDenial(rootRunId)` increments and returns `{ tripped, consecutive }`,
 *     tripping EXACTLY on the crossing of `denialBreakerN` (`===`, never `>=` —
 *     the same trip-once discipline as `tool-retry-breaker.ts`, so a later deny
 *     does not re-trip),
 *   - `recordAllow(rootRunId)` resets the counter (a real allowed step happened),
 *   - `evict(rootRunId)` drops the counter (run-end/evict/kill — the
 *     per-root cleanup discipline so the map cannot grow unbounded).
 *
 * The chokepoint is the SOLE driver: it calls recordDenial ONLY on a
 * `CapabilityDeniedError` floor-block, recordAllow on the allow branch, and
 * evict at run termination — so the breaker holds no untrusted input and counts
 * only genuine floor-blocks.
 */
import { describe, expect, it } from "vitest";

import { createDenialBreaker } from "./denial-breaker.js";
import { createMockLogger } from "../../../../test/support/mock-logger.js";

describe("createDenialBreaker", () => {
  it("counts consecutive denials and trips on the EXACT crossing of denialBreakerN", () => {
    const breaker = createDenialBreaker({ denialBreakerN: 3, logger: createMockLogger() });

    expect(breaker.recordDenial("root-A")).toEqual({ tripped: false, consecutive: 1 });
    expect(breaker.recordDenial("root-A")).toEqual({ tripped: false, consecutive: 2 });
    expect(breaker.recordDenial("root-A")).toEqual({ tripped: true, consecutive: 3 });
  });

  it("trips ONCE at the crossing — a later denial does not re-trip", () => {
    const breaker = createDenialBreaker({ denialBreakerN: 3, logger: createMockLogger() });

    breaker.recordDenial("root-A"); // 1
    breaker.recordDenial("root-A"); // 2
    expect(breaker.recordDenial("root-A").tripped).toBe(true); // 3 — the crossing

    // The 4th deny must NOT re-trip (trip fires once at ===, never on every later deny).
    expect(breaker.recordDenial("root-A").tripped).toBe(false);
    // …and a 5th stays false too.
    expect(breaker.recordDenial("root-A").tripped).toBe(false);
  });

  it("keeps counters independent per rootRunId (root-B does not trip from root-A's denials)", () => {
    const breaker = createDenialBreaker({ denialBreakerN: 3, logger: createMockLogger() });

    breaker.recordDenial("root-A"); // A:1
    breaker.recordDenial("root-A"); // A:2
    expect(breaker.recordDenial("root-B")).toEqual({ tripped: false, consecutive: 1 }); // B:1
    expect(breaker.recordDenial("root-A")).toEqual({ tripped: true, consecutive: 3 }); // A:3 trips
    // root-B is still at 1 — untouched by root-A crossing its threshold.
    expect(breaker.recordDenial("root-B")).toEqual({ tripped: false, consecutive: 2 });
  });

  it("resets the consecutive counter on an allowed gated call (recordAllow)", () => {
    const breaker = createDenialBreaker({ denialBreakerN: 3, logger: createMockLogger() });

    breaker.recordDenial("root-A"); // 1
    breaker.recordDenial("root-A"); // 2
    breaker.recordAllow("root-A"); // a real step happened → reset

    // The next denial starts fresh at 1, not 3.
    expect(breaker.recordDenial("root-A")).toEqual({ tripped: false, consecutive: 1 });
  });

  it("evicts a root's counter so a subsequent denial starts fresh", () => {
    const breaker = createDenialBreaker({ denialBreakerN: 3, logger: createMockLogger() });

    breaker.recordDenial("root-A"); // 1
    breaker.recordDenial("root-A"); // 2
    breaker.evict("root-A"); // run end / kill — drop the counter

    expect(breaker.recordDenial("root-A")).toEqual({ tripped: false, consecutive: 1 });
  });

  it("trips on the FIRST denial when denialBreakerN is 1 (boundary)", () => {
    const breaker = createDenialBreaker({ denialBreakerN: 1, logger: createMockLogger() });

    expect(breaker.recordDenial("root-A")).toEqual({ tripped: true, consecutive: 1 });
    // …and the 2nd deny does not re-trip.
    expect(breaker.recordDenial("root-A").tripped).toBe(false);
  });

  it("logs a content-free WARN on trip (errorKind + hint + count, NO message body)", () => {
    const logger = createMockLogger();
    const breaker = createDenialBreaker({ denialBreakerN: 2, logger });

    breaker.recordDenial("root-A"); // 1 — no trip, no WARN
    expect(logger.warn).not.toHaveBeenCalled();

    breaker.recordDenial("root-A"); // 2 — trips → exactly one WARN
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const [payload] = (logger.warn as unknown as { mock: { calls: [Record<string, unknown>, string][] } }).mock.calls[0]!;
    // Diagnosable: carries the closed-union errorKind, an operator hint, and the count.
    expect(payload.errorKind).toBe("validation");
    expect(typeof payload.hint).toBe("string");
    expect(payload.consecutive).toBe(2);
    // Content-free: NO message-body field of any common name leaks the denied action.
    for (const bodyField of ["body", "message", "content", "text", "args", "params", "payload"]) {
      expect(payload[bodyField]).toBeUndefined();
    }
  });
});
