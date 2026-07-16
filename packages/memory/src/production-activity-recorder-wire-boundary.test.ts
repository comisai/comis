// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { preflightActivityRecordingWireValue } from "./production-activity-recorder-wire-boundary.js";

describe("production activity recorder wire boundary", () => {
  it("bounds wire graphs without invoking accessors or proxy traps", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });
    const accessorResult = preflightActivityRecordingWireValue(accessor, 1_024);
    expect(accessorResult.ok).toBe(false);
    expect(getterCalls).toBe(0);

    let proxyReads = 0;
    const proxy = new Proxy({}, {
      ownKeys() {
        proxyReads += 1;
        return [];
      },
    });
    const proxyResult = preflightActivityRecordingWireValue(proxy, 1_024);
    expect(proxyResult.ok).toBe(false);
    expect(proxyReads).toBe(0);
  });

  it("rejects cycles and byte overflow while accepting a bounded cloneable frame", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const cyclic = preflightActivityRecordingWireValue(cycle, 1_024);
    expect(!cyclic.ok && cyclic.error.reason).toBe("payload_invalid");

    const oversized = preflightActivityRecordingWireValue({ value: "x".repeat(2_048) }, 128);
    expect(!oversized.ok && oversized.error.reason).toBe("payload_too_large");

    const bounded = preflightActivityRecordingWireValue({ value: [1, true, null, "safe"] }, 1_024);
    expect(bounded.ok && bounded.value > 0).toBe(true);
  });

  it("stops at fixed graph limits before traversing a hostile wide tail", () => {
    let tailReads = 0;
    const input: Record<string, unknown> = {};
    for (let index = 0; index < 300; index++) input[`field_${index}`] = index;
    Object.defineProperty(input, "tail", {
      enumerable: true,
      get() {
        tailReads += 1;
        return "must-not-run";
      },
    });

    const result = preflightActivityRecordingWireValue(input, 1_024 * 1_024);
    expect(result.ok).toBe(false);
    expect(tailReads).toBe(0);
  });
});
